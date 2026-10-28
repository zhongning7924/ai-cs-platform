"""提示词 persona 覆盖与护栏硬规则的测试。

后台可维护的「人设 persona」与「护栏硬规则」是两段独立文本：
persona 可被覆盖（品牌/语气），护栏永远追加在最后——否则后台一次配置
错误就能让模型开始编数据、把工具调用写成文字发给客户。
"""

from __future__ import annotations

from app.agent.planner_llm import DEFAULT_PERSONA, GUARDRAILS, LlmPlanner
from app.agent.types import PlannerContext, PlannerOverrides


def _ctx(persona: str | None = None, model: str | None = None) -> PlannerContext:
    return PlannerContext(
        session_id="s",
        question="沙发多少钱",
        history=[],
        tools=[],
        observations=[],
        step=0,
        overrides=PlannerOverrides(persona=persona, model=model),
    )


def test_default_persona_used_when_no_override() -> None:
    planner = LlmPlanner(base_url="http://x", api_key="k", model="m")
    msg = planner._system_message(_ctx())
    assert DEFAULT_PERSONA in msg
    assert GUARDRAILS in msg


def test_persona_override_takes_effect_but_guardrails_remain() -> None:
    planner = LlmPlanner(base_url="http://x", api_key="k", model="m")
    custom = "你是云朵家居售后客服，主营沙发"
    msg = planner._system_message(_ctx(persona=custom))
    # 人设被覆盖
    assert custom in msg
    assert DEFAULT_PERSONA not in msg
    # 护栏永远追加，且在人设之后
    assert GUARDRAILS in msg
    assert msg.index(custom) < msg.index(GUARDRAILS)


def test_empty_persona_falls_back_to_default() -> None:
    planner = LlmPlanner(base_url="http://x", api_key="k", model="m")
    msg = planner._system_message(_ctx(persona="   "))
    assert DEFAULT_PERSONA in msg
    assert GUARDRAILS in msg
