"""Embedding：硅基流动 BAAI/bge-m3（1024 维），与 TS 侧同一模型、同一维度。

换模型时 collection 名会自动分家（见 config.collection），不会写坏旧索引。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Sequence

from openai import AsyncOpenAI

log = logging.getLogger("kb.embedder")

BATCH = 32
MAX_RETRY = 3


class Embedder:
    def __init__(
        self,
        client: AsyncOpenAI,
        model: str = "BAAI/bge-m3",
        dimensions: int = 1024,
    ) -> None:
        self.model = model
        self.dimensions = dimensions
        self._client = client

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """批量向量化。空列表直接返回，避免打无意义的请求。"""
        inputs = [t if t.strip() else " " for t in texts]
        if not inputs:
            return []

        out: list[list[float]] = []
        for start in range(0, len(inputs), BATCH):
            batch = inputs[start : start + BATCH]
            out.extend(await self._embed_batch(batch))
        return out

    async def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        delay = 1.0
        for attempt in range(1, MAX_RETRY + 1):
            try:
                resp = await self._client.embeddings.create(model=self.model, input=batch)
                rows = sorted(resp.data, key=lambda d: d.index)
                vectors = [list(map(float, r.embedding)) for r in rows]
                if len(vectors) != len(batch):
                    raise RuntimeError(f"embedding 数量不匹配：期望 {len(batch)}，实际 {len(vectors)}")
                return vectors
            except Exception as err:  # noqa: BLE001 - 429/5xx 都要退避
                if attempt == MAX_RETRY:
                    raise
                log.warning("embedding 失败（第 %s 次），%.1fs 后重试：%s", attempt, delay, err)
                await asyncio.sleep(delay)
                delay *= 2
        raise RuntimeError("unreachable")
