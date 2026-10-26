"""路由分诊的测试：锁三件事——分得对、分得便宜、越权拦得住。

不测「模型分得准不准」（那要靠评测集），只测「规则/沿用/兜底三条路走得通」
和「白名单不是装饰品」。
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.agent.planner_router import RouterPlanner, _match_triggers
from app.agent.registry import ToolRegistry
from app.agent.runtime import AgentRuntime
from app.agent.subagents import builtin_agents
from app.agent.types import (
    JsonSchema,
    PlannerContext,
    ReplyDecision,
    ToolCallDecision,
    ToolObservation,
    ToolResult,
    ToolSpec,
)

SPECS = [
    ToolSpec(name=n, description="", parameters=JsonSchema())
    for n in ("kb_search", "query_order", "create_ticket", "coupon_status", "logistics_track")
]


def make_ctx(question: str, session_id: str = "s1") -> PlannerContext:
    return PlannerContext(
        session_id=session_id,
        question=question,
        history=[],
        tools=list(SPECS),
        observations=[],
        step=0,
    )


class Recorder:
    """记录委托时看到的 ctx，用来验证「可见性」是否真的收窄了。"""

    name = "recorder"

    def __init__(self) -> None:
        self.ctxs: list[PlannerContext] = []

    async def next(self, ctx: PlannerContext):
        self.ctxs.append(ctx)
        return ReplyDecision(text="ok", streamed=True)


def make_router(delegate: Any = None, **kwargs: Any) -> tuple[RouterPlanner, Recorder]:
    rec = delegate or Recorder()
    return RouterPlanner(delegate=rec, agents=builtin_agents(), **kwargs), rec


# ---------- 规则 ----------


def test_rule_routes_each_domain() -> None:
    router, _ = make_router()
    cases = {
        "这个沙发多少钱": "presale",
        "我有哪些优惠券可以用": "presale",
        "我要退款，沙发有异味": "aftersale",
        "我要投诉，帮我建个工单": "aftersale",
        "装不上，一直报错 E3": "tech",
    }
    for question, expected in cases.items():
        ranked = router._score(question)
        assert ranked and ranked[0].agent.name == expected, question


def test_tracking_number_is_strong_signal() -> None:
    router, _ = make_router()
    ranked = router._score("帮我查下运单 SF1380000123 的物流轨迹")
    assert ranked[0].agent.name == "aftersale"
    assert "SF1380000123" in ranked[0].matched


def test_trigger_overlap_counted_once() -> None:
    """「我要退款」同时含「退款」和「要退」，不能算两分——否则阈值校准全偏。"""
    assert _match_triggers("我要退款", ("退款", "要退")) == ["退款"]


def test_rule_beats_llm_for_clear_cases() -> None:
    """规则明确时不该调分诊模型——这是「零额外延迟」的关键。"""
    class Boom:
        class chat:  # noqa: N801
            class completions:  # noqa: N801
                @staticmethod
                async def create(**_: Any) -> Any:
                    raise AssertionError("规则明确时不该调用分诊模型")

    router, _ = make_router(client=Boom(), model="fake")
    active = asyncio.run(router._route(make_ctx("我要退款，沙发有异味")))
    assert active.agent.name == "aftersale"
    assert active.source == "rule"


# ---------- 沿用 / 模型 / 兜底 ----------


def test_carry_over_on_follow_up() -> None:
    """追问不带关键词时，沿用上一轮坐席，而不是掉回兜底。"""
    router, _ = make_router()
    asyncio.run(router._route(make_ctx("我要退款", "sess_a")))
    active = asyncio.run(router._route(make_ctx("那什么时候能到", "sess_a")))
    assert active.agent.name == "aftersale"
    assert active.source == "carry"


def test_general_is_never_carried() -> None:
    """上一轮是「你好」，不代表这一轮也该模糊处理——兜底坐席不进沿用记忆。"""
    router, _ = make_router()
    asyncio.run(router._route(make_ctx("你好", "sess_g")))
    active = asyncio.run(router._route(make_ctx("那三人位呢", "sess_g")))
    assert active.source != "carry"


def test_no_signal_falls_back_to_general() -> None:
    router, _ = make_router()
    active = asyncio.run(router._route(make_ctx("你好")))
    assert active.agent.name == "general"
    assert active.source == "fallback"


def test_ambiguous_goes_to_classifier() -> None:
    """售后 + 售前各命中一词，属于真模糊，交给模型裁决。"""
    fake = FakeClient('{"agent":"aftersale"}')
    router, _ = make_router(client=fake, model="fake")
    active = asyncio.run(router._route(make_ctx("我要退款顺便问下优惠券")))
    assert active.agent.name == "aftersale"
    assert active.source == "llm"
    assert fake.chat.completions.calls == 1


def test_classifier_failure_degrades_to_top_score() -> None:
    router, _ = make_router(client=FakeClient("", error=RuntimeError("upstream 502")), model="fake")
    active = asyncio.run(router._route(make_ctx("我要退款顺便问下优惠券")))
    assert active.agent.name in {"aftersale", "presale"}
    assert active.source == "rule"


def test_classifier_can_pick_general() -> None:
    """分诊目录必须含 general，否则「你好」会被硬塞进某个业务坐席。"""
    router, _ = make_router(client=FakeClient('{"agent":"general"}'), model="fake")
    active = asyncio.run(router._route(make_ctx("你好")))
    assert active.agent.name == "general"
    assert active.source == "llm"


# ---------- 降级话术 ----------


def test_sanitize_strips_model_instructions() -> None:
    from app.agent.sanitize import user_safe_echo

    assert user_safe_echo("知识库查询失败。请如实告知用户稍后再试，不要编造答案。") == ""
    assert "CS1002" in user_safe_echo("订单 CS1002：商品 云朵沙发；状态 已签收。")


def test_rule_planner_never_echoes_instructions() -> None:
    """降级路径最容易把「请如实告知用户」直接念给用户，这条锁住它。"""
    from app.agent.planner_rule import RulePlanner

    ctx = PlannerContext(
        session_id="s1",
        question="这个沙发多少钱",
        history=[],
        tools=list(SPECS),
        observations=[
            ToolObservation(
                tool_name="kb_search",
                text="知识库查询失败。请如实告知用户稍后再试，不要编造答案。",
            )
        ],
        step=1,
    )
    decision = asyncio.run(RulePlanner().next(ctx))
    assert "请如实告知" not in decision.text
    assert decision.text


# ---------- 隔离 ----------


def test_scope_hides_tools_outside_whitelist() -> None:
    router, rec = make_router()
    asyncio.run(router.next(make_ctx("这个沙发多少钱")))  # presale：只有 kb_search + coupon_status
    visible = {t.name for t in rec.ctxs[0].tools}
    assert visible == {"kb_search", "coupon_status"}
    assert "create_ticket" not in visible


def test_decision_carries_whitelist_for_runtime() -> None:
    """规划器必须把白名单随决策交出去，否则执行侧无从校验。"""
    class Calling(Recorder):
        async def next(self, ctx: PlannerContext):
            self.ctxs.append(ctx)
            return ToolCallDecision(call_id="c1", tool_name="kb_search", args={})

    router, rec = make_router(delegate=Calling())
    decision = asyncio.run(router.next(make_ctx("这个沙发多少钱")))
    assert isinstance(decision, ToolCallDecision)
    assert decision.allowed_tools == frozenset({"kb_search", "coupon_status"})


def test_general_agent_has_no_whitelist() -> None:
    """兜底坐席不限工具：分不清的时候宁可给全量，也不要把用户卡死。"""
    router, rec = make_router()
    decision = asyncio.run(router.next(make_ctx("你好")))
    assert not isinstance(decision, ToolCallDecision)
    assert len(rec.ctxs[0].tools) == len(SPECS)


# ---------- 执行侧护栏 ----------


class FakeTool:
    def __init__(self, name: str, executed: list[str]) -> None:
        self.spec = ToolSpec(name=name, description="", parameters=JsonSchema())
        self._executed = executed

    async def execute(self, args: dict, ctx: Any) -> ToolResult:
        self._executed.append(self.spec.name)
        return ToolResult(observation="已执行")


class ScriptedPlanner:
    """第一步越权调用，第二步收尾——用来验证 runtime 的拦截是否生效。"""

    name = "scripted"

    def __init__(self, allowed: frozenset[str]) -> None:
        self.ctxs: list[PlannerContext] = []
        self._allowed = allowed

    async def next(self, ctx: PlannerContext):
        self.ctxs.append(ctx)
        if not ctx.observations:
            return ToolCallDecision(
                call_id="c1",
                tool_name="create_ticket",
                args={"title": "越权"},
                allowed_tools=self._allowed,
            )
        return ReplyDecision(text="该操作不属于当前坐席。", streamed=False)


def test_runtime_blocks_out_of_scope_tool() -> None:
    executed: list[str] = []
    registry = ToolRegistry()
    registry.register(FakeTool("kb_search", executed), FakeTool("create_ticket", executed))
    planner = ScriptedPlanner(frozenset({"kb_search"}))

    runtime = AgentRuntime(planner=planner, registry=registry, max_steps=3)

    async def run() -> None:
        async for _ in runtime.run("我要建工单", session_id="sess_guard"):
            pass

    asyncio.run(run())

    assert executed == [], "越权工具不能真的被执行"
    assert "不在当前坐席权限内" in planner.ctxs[1].observations[0].text


class FakeClient:
    """最小可用的 OpenAI 客户端替身，只实现分诊用到的那一条路径。"""

    def __init__(self, content: str, error: Exception | None = None) -> None:
        self.chat = _FakeChat(content, error)


class _FakeChat:
    def __init__(self, content: str, error: Exception | None) -> None:
        self.completions = _FakeCompletions(content, error)


class _FakeCompletions:
    def __init__(self, content: str, error: Exception | None) -> None:
        self._content = content
        self._error = error
        self.calls = 0

    async def create(self, **_: Any) -> Any:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return _FakeResponse(self._content)


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content
