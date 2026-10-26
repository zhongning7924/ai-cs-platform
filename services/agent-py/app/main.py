"""Python 智能层服务入口。

对外只有 /api/chat 一个契约，SSE 帧格式与 Node 网关字节级一致，
所以浏览器挂件不需要知道后端是 Python 还是 Node。
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse

from .agent.runtime import AgentRuntime
from .agent.types import CardEvent, DeltaEvent, EndEvent, ToolEvent
from .assembly import build_service
from .config import get_settings
from .schemas import ChatRequest, ChatResponseDone, create_id, sse_frame

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s"
)
log = logging.getLogger("cs-agent-py")

settings = get_settings()
service = build_service(settings)
runtime: AgentRuntime = service.runtime


@asynccontextmanager
async def lifespan(_: FastAPI):
    mcp_summary = await service.mcp.start()
    log.info(
        "cs-agent-py 已启动: http://localhost:%s | planner=%s | agents=%s | skills=%s | tools=%s | mcp=%s",
        settings.port,
        runtime._planner.name,
        ", ".join(a.name for a in service.agents) or "单坐席",
        ", ".join(s.name for s in service.skills.all()) or "无",
        ", ".join(sorted(runtime._registry.names())),
        ", ".join(t["name"] for t in mcp_summary["tools"]) or "无",
    )
    for err in mcp_summary["errors"]:
        log.warning("MCP server %s 未接入: %s", err["server"], err["error"])
    try:
        yield
    finally:
        await service.mcp.close()


app = FastAPI(title="AI 智能客服 · Python 智能层", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "cs-agent-py",
        "collection": settings.collection,
        "namespace": settings.kb_namespace,
        "kb_ready": settings.kb_ready,
        "hybrid": settings.kb_hybrid_enabled,
        "planner": runtime._planner.name,
        "agents": [a.name for a in service.agents],
        "tools": sorted(runtime._registry.names()),
        "skills": [s.name for s in service.skills.all()],
        "mcp": service.mcp.status()["tools"],
    }


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    question = (req.message or "").strip()
    session_id = req.session_id or create_id("sess")
    trace_id = req.trace_id or create_id("trace")
    message_id = create_id("msg")
    started = time.time()

    async def stream():
        yield sse_frame(
            "meta",
            {"sessionId": session_id, "traceId": trace_id, "ts": int(started * 1000)},
        )

        first_ms = 0
        full_text = ""
        reply_card = None
        meta = ChatResponseDone(message_id=message_id, planner=runtime._planner.name)

        async for event in runtime.run(
            question, session_id=session_id, namespace=settings.kb_namespace
        ):
            if isinstance(event, DeltaEvent):
                if not first_ms:
                    first_ms = int((time.time() - started) * 1000)
                full_text += event.text
                yield sse_frame("delta", {"text": event.text})
            elif isinstance(event, ToolEvent):
                payload = {"name": event.name, "status": event.status}
                if event.summary:
                    payload["summary"] = event.summary
                yield sse_frame("tool", payload)
            elif isinstance(event, CardEvent):
                reply_card = event.card
                yield sse_frame("card", {"card": event.card.wire()})
            elif isinstance(event, EndEvent):
                meta.planner = event.meta.planner
                meta.tool_calls = event.meta.tool_calls
                meta.degraded = event.meta.degraded
                meta.skill = event.meta.skill
                meta.agent = event.meta.agent
                meta.route = event.meta.route or None
                meta.handoffs = event.meta.handoffs

        meta.first_token_ms = first_ms
        meta.matched = bool(full_text.strip()) or reply_card is not None
        meta.confidence = 0.5 if meta.degraded else (0.9 if meta.tool_calls else 0.7)
        yield sse_frame("done", meta)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Session-Id": session_id,
            "X-Trace-Id": trace_id,
        },
    )


@app.get("/api/tools")
async def list_tools() -> JSONResponse:
    """已注册工具清单。用于和 Node 侧对账：两边应该完全一致。"""
    specs = [
        {
            "name": s.name,
            "risk": s.risk,
            "required": s.parameters.required,
            "properties": list(s.parameters.properties.keys()),
        }
        for s in runtime._registry.specs()
    ]
    return JSONResponse({"count": len(specs), "items": specs})


@app.get("/api/skills")
async def list_skills() -> JSONResponse:
    """已加载技能清单。命中逻辑在 SkillRegistry.match，这里只做可见性。"""
    items = service.skills.describe()
    return JSONResponse({"count": len(items), "items": items})


@app.get("/api/mcp")
async def list_mcp() -> JSONResponse:
    """MCP 接入状态：server、发现到的工具、失败原因。"""
    return JSONResponse(service.mcp.status())


@app.get("/api/agents")
async def list_agents() -> JSONResponse:
    """坐席清单与各自的白名单。用于核对「谁能在什么权限下说话」。"""
    items = service.router.describe() if service.router else []
    return JSONResponse({"count": len(items), "items": items})
