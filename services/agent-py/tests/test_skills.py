"""技能匹配的单元测试：只锁「触发词 → 技能」这条最容易被改坏的路。"""

from __future__ import annotations

from app.skills.builtin import builtin_skills
from app.skills.registry import SkillRegistry, normalize


def make_registry() -> SkillRegistry:
    return SkillRegistry(builtin_skills())


def test_refund_matches() -> None:
    active = make_registry().match("我要退款，沙发有异味")
    assert active is not None
    assert active.skill.name == "refund"
    assert "退款" in active.matched and "异味" in active.matched


def test_logistics_matches() -> None:
    active = make_registry().match("CS1002 到哪了")
    assert active is not None
    assert active.skill.name == "logistics"


def test_complaint_wins_over_policy() -> None:
    active = make_registry().match("你们这个服务太差了，我要投诉")
    assert active is not None
    assert active.skill.name == "complaint"
    assert active.score > 0


def test_policy_matches() -> None:
    active = make_registry().match("发票怎么开")
    assert active is not None
    assert active.skill.name == "policy"


def test_greeting_matches_nothing() -> None:
    assert make_registry().match("你好") is None
    assert make_registry().match("") is None
    assert make_registry().match("   ") is None


def test_empty_registry_is_safe() -> None:
    assert SkillRegistry([]).match("我要退款") is None


def test_prompt_block_contains_instructions_and_tools() -> None:
    active = make_registry().match("我要退款")
    assert active is not None
    block = active.prompt_block()
    assert "退换货处理" in block
    assert "kb_search" in block
    # 技能不锁死工具：明确允许调用其它工具
    assert "仍可按需调用" in block


def test_normalize_strips_whitespace_and_lowercases() -> None:
    assert normalize("  Refund   Policy ") == "refundpolicy"
