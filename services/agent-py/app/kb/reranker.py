"""Reranker：硅基流动 BAAI/bge-reranker-v2-m3。

重排不是标准 OpenAI 接口，走原生 HTTP。失败由调用方降级为向量序，不阻断主链路。
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("kb.reranker")


class Reranker:
    def __init__(self, api_key: str, base_url: str, model: str = "BAAI/bge-reranker-v2-m3") -> None:
        self.model = model
        self._url = f"{base_url.rstrip('/')}/rerank"
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def rerank(self, query: str, documents: list[str], top_n: int | None = None) -> list[tuple[int, float]]:
        """返回 [(原始下标, 相关性分)]，按分数降序。"""
        if not documents:
            return []

        payload = {
            "model": self.model,
            "query": query,
            "documents": documents,
            "top_n": top_n or len(documents),
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self._url, json=payload, headers=self._headers)
            if resp.status_code >= 400:
                raise RuntimeError(f"rerank {resp.status_code}: {resp.text[:200]}")
            data = resp.json()

        rows = data.get("results") or data.get("data") or []
        scored = [(int(r["index"]), float(r["relevance_score"])) for r in rows if "index" in r]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored
