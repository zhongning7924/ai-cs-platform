"""组装层：把配置、知识库、工具、技能、MCP、规划器拼成一个 AgentRuntime。

这是宿主（服务）唯一需要改的文件——加工具、加技能、接 MCP server 都在这里。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from openai import AsyncOpenAI

from .agent.memory import InMemoryMemory
from .agent.planner_llm import LlmPlanner
from .agent.planner_router import RouterPlanner
from .agent.planner_rule import RulePlanner
from .agent.registry import ToolRegistry
from .agent.runtime import AgentRuntime
from .agent.subagents import SubAgent, builtin_agents
from .agent.types import AgentPlanner
from .config import Settings, get_settings
from .kb.embedder import Embedder
from .kb.reranker import Reranker
from .kb.retrieval import Retriever
from .kb.store import VectorStore
from .mcp.adapter import McpManager, parse_server_configs
from .skills.builtin import builtin_skills
from .skills.registry import SkillRegistry
from .tools.builtin import CreateTicketTool, KbSearchTool, QueryOrderTool

log = logging.getLogger("assembly")


@dataclass
class Service:
    """服务的完整装配结果：runtime 之外，技能 / MCP / 坐席需要暴露给管理接口。"""

    runtime: AgentRuntime
    skills: SkillRegistry
    mcp: McpManager
    agents: list[SubAgent] = field(default_factory=list)
    router: RouterPlanner | None = None


def build_kb(settings: Settings) -> tuple[Retriever | None, str | None]:
    """知识库可选装配：密钥不全就返回 None，kb_search 工具随之不注册。"""
    if not settings.kb_ready:
        log.warning("kb_search 未注册（缺 QDRANT_URL / EMBEDDING_API_KEY）")
        return None, None

    store = VectorStore(settings.qdrant_url, settings.qdrant_api_key)
    store.ensure_collection(settings.collection, settings.embedding_dimensions)

    client = AsyncOpenAI(
        base_url=settings.effective_embedding_url,
        api_key=settings.effective_embedding_key,
    )
    embedder = Embedder(client, settings.embedding_model, settings.embedding_dimensions)
    reranker = Reranker(
        settings.effective_rerank_key, settings.effective_rerank_url, settings.reranker_model
    )

    retriever = Retriever(
        embedder,
        store,
        reranker,
        collection=settings.collection,
        namespace=settings.kb_namespace,
        candidate_k=settings.kb_candidate_k,
        min_vector_score=settings.kb_min_vector_score,
        min_rerank_score=settings.kb_min_rerank_score,
        hybrid_enabled=settings.kb_hybrid_enabled,
        bm25_ttl_seconds=settings.kb_bm25_ttl_seconds,
        rrf_k=settings.kb_rrf_k,
    )
    return retriever, settings.collection


def build_service(settings: Settings | None = None) -> Service:
    settings = settings or get_settings()
    registry = ToolRegistry()

    retriever, collection = build_kb(settings)
    if retriever is not None:
        registry.register(KbSearchTool(retriever))
        log.info("kb_search 已注册: collection=%s namespace=%s", collection, settings.kb_namespace)

    registry.register(QueryOrderTool(), CreateTicketTool())

    # 技能：只做上下文增强。关掉也能跑，只是少一层领域指令
    skills = SkillRegistry(builtin_skills() if settings.skills_enabled else [])
    if len(skills):
        log.info("技能已加载 %d 个: %s", len(skills), ", ".join(s.name for s in skills.all()))
    else:
        log.info("技能未启用（SKILLS_ENABLED=false）")

    api_key = settings.effective_llm_key
    agents: list[SubAgent] = []
    router: RouterPlanner | None = None
    if api_key:
        client = AsyncOpenAI(
            base_url=settings.llm_base_url, api_key=api_key, timeout=60.0
        )
        planner: AgentPlanner = LlmPlanner(
            base_url=settings.llm_base_url,
            api_key=api_key,
            model=settings.llm_model,
            temperature=settings.llm_temperature,
            max_tokens=settings.llm_max_tokens,
            client=client,
        )
        fallback: RulePlanner | None = RulePlanner()

        if settings.agent_routing_enabled:
            # 坐席列表只影响「谁来说 + 能用哪些工具」，不新增一层循环
            agents = builtin_agents()
            router = RouterPlanner(
                delegate=planner,
                agents=agents,
                client=client,
                model=settings.router_model or settings.llm_model,
                min_score=settings.router_min_score,
                classify_timeout=settings.router_timeout_seconds,
                carry_over=settings.router_carry_over,
            )
            planner = router
            log.info(
                "规划器 = router（%d 个坐席: %s）+ llm（%s），异常时自动降级 rule",
                len(agents),
                ", ".join(a.name for a in agents),
                settings.llm_model,
            )
        else:
            log.info(
                "规划器 = llm（%s @ %s），路由分诊未启用，异常时自动降级 rule",
                settings.llm_model,
                settings.llm_base_url,
            )
    else:
        planner = RulePlanner()
        fallback = None
        log.info("规划器 = rule（未配置 LLM_API_KEY / SILICONFLOW_API_KEY）")

    runtime = AgentRuntime(
        planner=planner,
        fallback_planner=fallback,
        registry=registry,
        memory=InMemoryMemory(),
        skills=skills,
        max_steps=settings.agent_max_steps,
        history_window=settings.agent_history_window,
        stream_chunk_size=settings.agent_stream_chunk_size,
        logger=lambda msg: log.info("[agent] %s", msg),
        agent_resolver=router.current if router is not None else None,
    )

    mcp_configs = parse_server_configs(
        settings.mcp_servers,
        demo=settings.mcp_demo_server,
        timeout=settings.mcp_timeout_seconds,
    )
    mcp = McpManager(registry, mcp_configs, enabled=settings.mcp_enabled)
    if settings.mcp_enabled and mcp_configs:
        log.info(
            "MCP 待接入 %d 个 server: %s", len(mcp_configs), ", ".join(c.name for c in mcp_configs)
        )

    return Service(runtime=runtime, skills=skills, mcp=mcp, agents=agents, router=router)


def build_runtime(settings: Settings | None = None) -> AgentRuntime:
    """向后兼容入口：只要 runtime 的调用方（测试）不必关心 MCP 生命周期。"""
    return build_service(settings).runtime
