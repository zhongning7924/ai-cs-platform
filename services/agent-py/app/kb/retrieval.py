"""检索编排：向量 + BM25 混合召回 → RRF 融合 → 重排。

这是把智能层放 Python 后第一个真正的能力增量：
  - 纯向量召回对「型号、编号、专有名词」这类字面精确匹配很弱，BM25 正好补上；
  - RRF（Reciprocal Rank Fusion）不需要两路分数同量纲，比加权求和稳；
  - 重排只作用在融合后的小候选集上，成本不变、精度更高。

生产规模提醒：BM25 语料现在靠 scroll 全量拉进内存（TTL 缓存）。
知识库上万条后应改为 Qdrant 的 sparse vector（服务端 BM25）。
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field

from .embedder import Embedder
from .reranker import Reranker
from .store import Hit, VectorStore

log = logging.getLogger("kb.retrieval")

STOPWORDS = set("的了是在和与及或对就都也很又吗呢吧啊把被给让向从到于之其这那个有")
_PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)

try:  # 有 jieba 就用，没有就退化为字符二元组——保证零安装也能跑
    import jieba

    jieba.setLogLevel(60)
    HAS_JIEBA = True
except ImportError:  # pragma: no cover
    HAS_JIEBA = False


def tokenize(text: str) -> list[str]:
    if HAS_JIEBA:
        return [t for t in jieba.lcut(text) if t.strip() and t not in STOPWORDS]
    return _bigrams(text)


def _bigrams(text: str) -> list[str]:
    """无分词器时的兜底：中文按字切二元组，英文数字按词保留。

    "云朵沙发" → ["云朵", "朵沙", "沙发"]，字面匹配能力足够 BM25 用。
    """
    cleaned = _PUNCT.sub(" ", text).strip()
    out: list[str] = []
    for part in cleaned.split(" "):
        if not part:
            continue
        if part.isascii():
            out.append(part.lower())
        elif len(part) < 2:
            out.append(part)
        else:
            out.extend(part[i : i + 2] for i in range(len(part) - 1))
    return out


class SimpleBM25:
    """BM25 实现（Okapi 变体），约 25 行，零第三方依赖。

    公式：score = Σ idf(t) · f·(k1+1) / (f + k1·(1 − b + b·dl/avgdl))
    装不装 rank-bm25 结果等价，这里自己写是为了少一个部署依赖。
    """

    def __init__(self, corpus: list[list[str]], k1: float = 1.5, b: float = 0.75) -> None:
        self._k1 = k1
        self._b = b
        self._n = len(corpus)
        self._doc_len = [len(d) for d in corpus]
        self._avgdl = (sum(self._doc_len) / self._n) if self._n else 0.0
        self._tf = [Counter(d) for d in corpus]
        self._df: Counter[str] = Counter()
        for doc in corpus:
            self._df.update(set(doc))

    def get_scores(self, query: list[str]) -> list[float]:
        scores: list[float] = []
        for i, tf in enumerate(self._tf):
            total = 0.0
            for term in set(query):
                freq = tf.get(term, 0)
                if not freq:
                    continue
                df = self._df.get(term, 0)
                idf = math.log(1 + (self._n - df + 0.5) / (df + 0.5))
                denom = freq + self._k1 * (
                    1 - self._b + self._b * self._doc_len[i] / (self._avgdl or 1.0)
                )
                total += idf * freq * (self._k1 + 1) / denom
            scores.append(total)
        return scores


@dataclass
class RetrievedChunk:
    id: str
    text: str
    title: str
    uri: str | None = None
    heading_path: str | None = None
    page: int | None = None
    vector_score: float = 0.0
    bm25_score: float = 0.0
    rrf_score: float = 0.0
    rerank_score: float | None = None

    @property
    def best_score(self) -> float:
        """对外展示的可信度：有重排分用重排分，否则用向量分。"""
        return self.rerank_score if self.rerank_score is not None else self.vector_score

    @property
    def source_label(self) -> str:
        return f"{self.title} > {self.heading_path}" if self.heading_path else self.title


@dataclass
class RetrieveResult:
    hits: list[RetrievedChunk]
    reranked: bool = False
    degraded: bool = False
    hybrid: bool = False
    latency_ms: int = 0
    recall: dict[str, int] = field(default_factory=dict)


class _Bm25Index:
    """内存 BM25 索引 + TTL 刷新。"""

    def __init__(self, hits: list[Hit]) -> None:
        self.ids = [h.id for h in hits]
        self.texts = [str(h.payload.get("text", "")) for h in hits]
        self.payloads = [h.payload for h in hits]
        self.bm25 = SimpleBM25([tokenize(t) for t in self.texts])
        self.built_at = time.time()

    def top(self, query: str, k: int) -> list[tuple[int, float]]:
        scores = self.bm25.get_scores(tokenize(query))
        ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
        return [(i, float(s)) for i, s in ranked[:k] if s > 0]


class Retriever:
    def __init__(
        self,
        embedder: Embedder,
        store: VectorStore,
        reranker: Reranker | None,
        *,
        collection: str,
        namespace: str = "personal",
        candidate_k: int = 20,
        min_vector_score: float = 0.35,
        min_rerank_score: float = 0.25,
        hybrid_enabled: bool = True,
        bm25_ttl_seconds: int = 300,
        rrf_k: int = 60,
    ) -> None:
        self._embedder = embedder
        self._store = store
        self._reranker = reranker
        self.collection = collection
        self.namespace = namespace
        self.candidate_k = candidate_k
        self.min_vector_score = min_vector_score
        self.min_rerank_score = min_rerank_score
        self.hybrid_enabled = hybrid_enabled
        self.bm25_ttl_seconds = bm25_ttl_seconds
        self.rrf_k = rrf_k
        self._index: _Bm25Index | None = None

    async def retrieve(
        self, query: str, top_k: int = 3, with_rerank: bool = True
    ) -> RetrieveResult:
        started = time.time()
        pool = max(self.candidate_k, top_k)

        [vector] = await self._embedder.embed([query])
        vec_hits = self._store.search(self.collection, vector, pool, self.namespace)
        vec_hits = [h for h in vec_hits if h.score >= self.min_vector_score]

        index = self._index if self.hybrid_enabled else None
        bm_hits: list[tuple[int, float]] = []
        if self.hybrid_enabled:
            index = await self._ensure_index()
            bm_hits = index.top(query, pool) if index else []

        merged = self._fuse(vec_hits, index, bm_hits, pool)

        reranked = False
        degraded = False
        if with_rerank and self._reranker and len(merged) > 1:
            try:
                scores = await self._reranker.rerank(
                    query, [c.text for c in merged], top_n=max(top_k, len(merged) // 2)
                )
                by_index = dict(scores)
                for i, chunk in enumerate(merged):
                    chunk.rerank_score = by_index.get(i)
                merged = [c for c in merged if (c.rerank_score or 0) >= self.min_rerank_score]
                merged.sort(key=lambda c: c.rerank_score or 0, reverse=True)
                reranked = True
            except Exception as err:  # noqa: BLE001 - 重排失败不阻断，降级为融合序
                log.warning("重排失败，降级为融合排序：%s", err)
                degraded = True

        return RetrieveResult(
            hits=merged[:top_k],
            reranked=reranked,
            degraded=degraded,
            hybrid=bool(bm_hits),
            latency_ms=int((time.time() - started) * 1000),
            recall={"vector": len(vec_hits), "bm25": len(bm_hits), "fused": len(merged)},
        )

    def _fuse(
        self,
        vec_hits: list[Hit],
        index: _Bm25Index | None,
        bm_hits: list[tuple[int, float]],
        pool: int,
    ) -> list[RetrievedChunk]:
        """RRF 融合：score = Σ 1/(k + rank)，rank 从 1 起。"""
        buckets: dict[str, RetrievedChunk] = {}
        contributions: dict[str, float] = {}

        for rank, hit in enumerate(vec_hits, start=1):
            chunk = self._to_chunk(hit)
            chunk.vector_score = hit.score
            buckets[chunk.id] = chunk
            contributions[chunk.id] = contributions.get(chunk.id, 0.0) + self._rrf(rank)

        if index is not None:
            for rank, (pos, score) in enumerate(bm_hits, start=1):
                hit_id = index.ids[pos]
                if hit_id in buckets:
                    buckets[hit_id].bm25_score = score
                else:
                    payload = index.payloads[pos]
                    chunk = RetrievedChunk(
                        id=hit_id,
                        text=str(payload.get("text", "")),
                        title=str(payload.get("title", "")),
                        uri=payload.get("uri"),
                        heading_path=payload.get("headingPath"),
                        page=payload.get("page"),
                        bm25_score=score,
                    )
                    buckets[hit_id] = chunk
                contributions[hit_id] = contributions.get(hit_id, 0.0) + self._rrf(rank)

        for cid, chunk in buckets.items():
            chunk.rrf_score = contributions[cid]

        fused = sorted(buckets.values(), key=lambda c: c.rrf_score, reverse=True)
        return fused[:pool]

    def _rrf(self, rank: int) -> float:
        return 1.0 / (self.rrf_k + rank)

    @staticmethod
    def _to_chunk(hit: Hit) -> RetrievedChunk:
        p = hit.payload
        page = p.get("page")
        return RetrievedChunk(
            id=hit.id,
            text=str(p.get("text", "")),
            title=str(p.get("title", "")),
            uri=p.get("uri"),
            heading_path=p.get("headingPath"),
            page=int(page) if isinstance(page, int) else None,
        )

    async def _ensure_index(self) -> _Bm25Index | None:
        now = time.time()
        if self._index and now - self._index.built_at < self.bm25_ttl_seconds:
            return self._index
        try:
            hits = await asyncio.to_thread(
                self._store.scroll_texts, self.collection, self.namespace
            )
            self._index = _Bm25Index(hits)
            log.info("BM25 索引已重建：%s 条（namespace=%s）", len(hits), self.namespace)
            return self._index
        except Exception as err:  # noqa: BLE001 - 词表建不起来就退回纯向量，不阻断
            log.warning("BM25 索引构建失败，本次走纯向量：%s", err)
            return None

    def invalidate(self) -> None:
        """知识库写入后调用，强制下次重建词表。"""
        self._index = None
