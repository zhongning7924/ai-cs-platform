"""工具调用泄漏的防护测试。

7B 模型会把 function call 写成普通文本（`调 create_ticket(...)`）。
这类回复既没执行动作，又会把一行"代码"推到用户眼前，属于必须兜住的失败模式。
"""

from __future__ import annotations

from app.agent.planner_llm import LeakGuard, _parse_leaked_call

TOOLS = {"create_ticket", "query_order", "kb_search"}


def test_parse_leaked_call_with_chinese_verb() -> None:
    parsed = _parse_leaked_call('调 create_ticket(title="退款：沙发有异味")', TOOLS)
    assert parsed == ("create_ticket", {"title": "退款：沙发有异味"})


def test_parse_leaked_call_plain_syntax() -> None:
    parsed = _parse_leaked_call('query_order(orderId="CS1002")', TOOLS)
    assert parsed == ("query_order", {"orderId": "CS1002"})


def test_parse_leaked_call_single_quotes_and_bare_value() -> None:
    parsed = _parse_leaked_call("kb_search(query='七天无理由', topK=3)", TOOLS)
    assert parsed == ("kb_search", {"query": "七天无理由", "topK": "3"})


def test_parse_rejects_unknown_tool() -> None:
    assert _parse_leaked_call('rm_rf(path="/")', TOOLS) is None


def test_parse_rejects_normal_prose() -> None:
    assert _parse_leaked_call("您好，已经为您查询到订单状态。", TOOLS) is None


def test_guard_suppresses_leaked_call() -> None:
    emitted: list[str] = []
    guard = LeakGuard(TOOLS, emitted.append)
    for chunk in ["调 ", "create", "_ticket(", 'title="x")']:
        guard.feed(chunk)
    guard.finish()

    assert guard.leaked is True
    assert emitted == []


def test_guard_streams_normal_text_immediately() -> None:
    emitted: list[str] = []
    guard = LeakGuard(TOOLS, emitted.append)
    guard.feed("您好，")
    guard.feed("已为您查询到订单状态。")
    guard.finish()

    assert guard.leaked is False
    assert "".join(emitted) == "您好，已为您查询到订单状态。"


def test_guard_releases_text_that_only_looks_like_call_prefix() -> None:
    """以「调」开头的正常句子（调查显示…）不能一直被扣着。"""
    emitted: list[str] = []
    guard = LeakGuard(TOOLS, emitted.append)
    guard.feed("调查显示大多数用户偏好次日达，")
    guard.finish()

    assert guard.leaked is False
    assert "调查显示" in "".join(emitted)


def test_guard_drops_narration_line_and_brace_fragment() -> None:
    """「调用 xxx 获取…」这种旁白要丢掉，但后面的正文必须照常下发。"""
    emitted: list[str] = []
    guard = LeakGuard(TOOLS, emitted.append)
    for chunk in ["调用 ", "coupon", "_status", " 获取您的优惠券信息", "。", "\n}", "\n您有两张优惠券可用。"]:
        guard.feed(chunk)
    guard.finish()

    text = "".join(emitted)
    assert guard.leaked is False
    assert "调用" not in text
    assert "}" not in text
    assert text.strip() == "您有两张优惠券可用。"


def test_guard_keeps_normal_sentence_starting_with_shiyong() -> None:
    """「使用方法如下」不是旁白，不能被误删。"""
    emitted: list[str] = []
    guard = LeakGuard(TOOLS, emitted.append)
    guard.feed("使用方法如下：")
    guard.finish()

    assert "".join(emitted) == "使用方法如下："


def test_guard_holds_incomplete_narration_until_period() -> None:
    emitted: list[str] = []
    guard = LeakGuard(TOOLS, emitted.append)
    guard.feed("调用 query_order 查询")
    assert emitted == []  # 还没出现句末，先扣着
    guard.feed("订单状态。已经发货了。")
    guard.finish()

    text = "".join(emitted)
    assert "调用 query_order" not in text
    assert "已经发货了。" in text
