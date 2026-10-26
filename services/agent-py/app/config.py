"""配置：与 Node 侧共用同一份 .env，变量名保持一致，避免双份配置漂移。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# app/config.py -> app -> agent-py -> services -> 仓库根
REPO_ROOT = Path(__file__).resolve().parents[3]
SERVICE_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(SERVICE_ROOT / ".env", REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # 服务
    port: int = 8788
    log_level: str = "info"

    # 向量库
    qdrant_url: str = ""
    qdrant_api_key: str = ""

    # —— 模型端点：LLM / embedding / rerank 三套独立配置 ——
    #
    # 私有化部署的常态是「三者不在同一家」：embedding 跑在内网 TEI，
    # rerank 挂在集团 AI 平台，LLM 走统一网关。共用一个 base_url 会直接卡死交付。
    # 各自留空则回退到 SILICONFLOW_*，现有云上部署零改动。
    siliconflow_api_key: str = ""
    siliconflow_base_url: str = "https://api.siliconflow.cn/v1"

    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_model: str = "BAAI/bge-m3"
    embedding_dimensions: int = 1024

    rerank_base_url: str = ""
    rerank_api_key: str = ""
    reranker_model: str = "BAAI/bge-reranker-v2-m3"

    # 知识库检索
    kb_collection: str = ""
    kb_namespace: str = "personal"
    kb_min_vector_score: float = 0.35
    kb_min_rerank_score: float = 0.25
    kb_candidate_k: int = 20
    # 混合检索：向量 + BM25，RRF 融合。知识库变更后靠 TTL 重建词表
    kb_hybrid_enabled: bool = True
    kb_bm25_ttl_seconds: int = 300
    kb_rrf_k: int = 60

    # 规划器
    llm_base_url: str = "https://api.siliconflow.cn/v1"
    llm_api_key: str = ""
    llm_model: str = "Qwen/Qwen2.5-7B-Instruct"
    llm_temperature: float = 0.3
    llm_max_tokens: int = 1024

    # 智能体
    agent_max_steps: int = 4
    agent_history_window: int = 12
    agent_stream_chunk_size: int = 48

    # 路由分诊（多坐席）。关掉则退回单坐席：所有工具可见、无白名单
    agent_routing_enabled: bool = True
    # 规则路由的分数下限：命中几个触发词就有几分，单号正则每个 +2
    router_min_score: float = 1.0
    # 分诊模型：留空复用 llm_model。分类是短任务，可以换更小更快的模型
    router_model: str = ""
    router_timeout_seconds: float = 4.0
    # 本轮无信号时沿用上一轮坐席（多轮追问靠它接住）
    router_carry_over: bool = True

    # 技能：命中后注入领域指令（不限制工具权限）
    skills_enabled: bool = True

    # MCP（stdio）：JSON 数组，与 mcp.json 的 mcpServers 条目同构
    # 例：[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]
    mcp_enabled: bool = True
    mcp_servers: str = ""
    mcp_demo_server: bool = True  # 自动挂内置演示 server，闭环开箱可跑；生产置 false
    mcp_timeout_seconds: float = 20.0

    @property
    def effective_llm_key(self) -> str:
        """LLM key 缺省时复用硅基流动的 key（同一个账号）。"""
        return self.llm_api_key or self.siliconflow_api_key

    @property
    def effective_embedding_url(self) -> str:
        return self.embedding_base_url or self.siliconflow_base_url

    @property
    def effective_embedding_key(self) -> str:
        return self.embedding_api_key or self.siliconflow_api_key

    @property
    def effective_rerank_url(self) -> str:
        # rerank 通常和 embedding 同源（同一台 TEI 就同时提供两者），所以先继承 embedding
        return self.rerank_base_url or self.effective_embedding_url

    @property
    def effective_rerank_key(self) -> str:
        return self.rerank_api_key or self.effective_embedding_key

    @property
    def collection(self) -> str:
        if self.kb_collection:
            return self.kb_collection
        # 与 TS 侧 buildCollectionName 完全一致：kb_<slug>_<dim>
        slug = "".join(ch if ch.isalnum() else "_" for ch in self.embedding_model.lower())
        slug = "_".join(part for part in slug.split("_") if part)
        return f"kb_{slug}_{self.embedding_dimensions}"

    @property
    def kb_ready(self) -> bool:
        # 自建 Qdrant 可以不带 key，所以只要求 URL + embedding key。
        # LLM 和 rerank 都可以缺：检索仍能走向量序，只是没有重排。
        return bool(self.qdrant_url and self.effective_embedding_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
