"""向量库：Qdrant Cloud / 自建，走 REST。

刻意不依赖 qdrant-client：少一个重依赖（省掉 grpc 那一坨），
私有化交付时少几百 MB，也避免客户端版本与服务端不匹配的经典坑。
将来要上 sparse vector（服务端 BM25）再引入官方客户端即可。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Sequence

import httpx

log = logging.getLogger("kb.store")


@dataclass
class Hit:
    id: str
    score: float
    payload: dict[str, Any]


def _namespace_filter(namespace: str) -> dict:
    return {"must": [{"key": "namespace", "match": {"value": namespace}}]}


class VectorStore:
    def __init__(self, url: str, api_key: str, *, timeout: float = 30.0) -> None:
        self._base = url.rstrip("/")
        self._timeout = timeout
        self._headers = {"Content-Type": "application/json"}
        # 自建 Qdrant 通常不开鉴权。空 key 还硬塞 header，部分版本会直接 401，
        # 于是「本地容器跑得好好的」在交付现场变成启动失败。有 key 才发。
        if api_key:
            self._headers["api-key"] = api_key

    def _url(self, path: str) -> str:
        return f"{self._base}/collections/{path}"

    def ensure_collection(self, name: str, dimensions: int) -> None:
        """幂等建集合 + keyword 索引（过滤删除与命名空间隔离都依赖索引）。"""
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.get(self._url(name), headers=self._headers)
            if resp.status_code == 404:
                created = client.put(
                    self._url(name),
                    headers=self._headers,
                    json={"vectors": {"size": dimensions, "distance": "Cosine"}},
                )
                if created.status_code >= 400:
                    raise RuntimeError(
                        f"创建 collection 失败 {created.status_code}: {created.text[:200]}"
                    )
                log.info("已创建 collection: %s (dim=%s)", name, dimensions)

            for field in ("documentId", "namespace"):
                idx = client.put(
                    self._url(f"{name}/index"),
                    headers=self._headers,
                    json={"field_name": field, "field_schema": "keyword"},
                )
                # 索引已存在时 Qdrant 返回 409，可忽略
                if idx.status_code >= 400 and idx.status_code != 409:
                    log.debug("索引 %s 创建返回 %s（可能已存在）", field, idx.status_code)

    def search(self, name: str, vector: Sequence[float], top_k: int, namespace: str) -> list[Hit]:
        body = {
            "vector": list(vector),
            "limit": top_k,
            "filter": _namespace_filter(namespace),
            "with_payload": True,
        }
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.post(
                self._url(f"{name}/points/search"), headers=self._headers, json=body
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"检索失败 {resp.status_code}: {resp.text[:200]}")
            rows = resp.json().get("result", [])

        return [
            Hit(
                id=str(r.get("id", "")),
                score=float(r.get("score", 0.0)),
                payload=r.get("payload") or {},
            )
            for r in rows
        ]

    def upsert(self, name: str, points: list[tuple[str, list[float], dict[str, Any]]]) -> None:
        body = {
            "points": [
                {"id": pid, "vector": vec, "payload": payload} for pid, vec, payload in points
            ]
        }
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.put(
                self._url(f"{name}/points?wait=true"), headers=self._headers, json=body
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"写入失败 {resp.status_code}: {resp.text[:200]}")

    def delete_by_document(self, name: str, document_id: str) -> None:
        body = {"filter": {"must": [{"key": "documentId", "match": {"value": document_id}}]}}
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.post(
                self._url(f"{name}/points/delete?wait=true"), headers=self._headers, json=body
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"删除失败 {resp.status_code}: {resp.text[:200]}")

    def scroll_texts(self, name: str, namespace: str, limit: int = 2000) -> list[Hit]:
        """全量拉取语料，供本地 BM25 建索引。

        权宜之计：万条以上应改用服务端 sparse vector，别把全库拉进内存。
        """
        body = {"filter": _namespace_filter(namespace), "limit": limit, "with_payload": True}
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.post(
                self._url(f"{name}/points/scroll"), headers=self._headers, json=body
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"scroll 失败 {resp.status_code}: {resp.text[:200]}")
            data = resp.json().get("result", {})

        points = data.get("points", [])
        return [
            Hit(id=str(p.get("id", "")), score=0.0, payload=p.get("payload") or {})
            for p in points
            if isinstance(p.get("payload"), dict) and p["payload"].get("text")
        ]

    def count(self, name: str) -> int:
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.post(
                self._url(f"{name}/points/count"), headers=self._headers, json={"exact": True}
            )
            if resp.status_code >= 400:
                return 0
            return int(resp.json().get("result", {}).get("count", 0))
