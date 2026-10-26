"""对话级评测：TS 实现 vs Python 实现，同一份用例、同一把尺子。

评测维度（能自动判分的先自动化，判不了的留给人工）：
  1. 工具选择正确率 —— 该调的调了没，不该调的别乱调
  2. 关键事实命中 —— 回答里有没有出现必须出现的事实词
  3. 护栏生效 —— 高风险操作有没有被拦下要确认
  4. 首字延迟 —— 体验红线

用法：
    python eval/run_eval.py                          # 两边都跑
    python eval/run_eval.py --only py                # 只跑 Python
    python eval/run_eval.py --cases order,kb         # 只跑指定分组
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass, field

import httpx

DEFAULT_TS = "http://127.0.0.1:8787"
DEFAULT_PY = "http://127.0.0.1:8788"


@dataclass
class Case:
    id: str
    message: str
    group: str
    intent: str
    expect_tool: str | None = None  # 期望调用的工具；None 表示不该调任何工具
    expect_card: str | None = None  # 期望出现的卡片类型（如 confirm）
    must_contain: list[str] = field(default_factory=list)  # 回答里必须出现的事实词


CASES: list[Case] = [
    Case("order-1", "CS1002 到哪了", "order", "催单", expect_tool="query_order", must_contain=["已签收"]),
    Case("order-2", "帮我查一下订单 CS1001", "order", "催单", expect_tool="query_order", must_contain=["运输中"]),
    Case("order-3", "订单 CS9999 什么时候到", "order", "催单", expect_tool="query_order"),
    Case("kb-1", "周五能发布吗", "kb", "咨询", expect_tool="kb_search", must_contain=["发布"]),
    Case("kb-2", "退货流程是什么", "kb", "咨询", expect_tool="kb_search"),
    Case("kb-3", "发票怎么开", "kb", "咨询", expect_tool="kb_search"),
    Case("ticket-1", "我要投诉，沙发有异味，帮我建个工单", "ticket", "投诉", expect_card="confirm"),
    Case("ticket-2", "这个问题你们得派人上门处理", "ticket", "售后", expect_card="confirm"),
    Case("chat-1", "你好", "chat", "闲聊", expect_tool=None),
    Case("chat-2", "谢谢你的帮助", "chat", "闲聊", expect_tool=None),
]


@dataclass
class CaseResult:
    case: Case
    text: str
    tool_calls: list[str]
    cards: list[str]
    first_token_ms: int
    planner: str
    degraded: bool
    error: str | None = None

    @property
    def tool_ok(self) -> bool:
        if self.case.expect_tool is None:
            return not self.tool_calls
        return self.case.expect_tool in self.tool_calls

    @property
    def card_ok(self) -> bool | None:
        if self.case.expect_card is None:
            return None
        return self.case.expect_card in self.cards

    @property
    def fact_hit(self) -> float:
        if not self.case.must_contain:
            return 1.0
        hits = sum(1 for w in self.case.must_contain if w in self.text)
        return hits / len(self.case.must_contain)

    @property
    def score(self) -> float:
        """工具 0.6 + 事实 0.4；有卡片期望时卡片占 0.6。"""
        if self.error:
            return 0.0
        if self.case.expect_card:
            return (1.0 if self.card_ok else 0.0) * 0.6 + self.fact_hit * 0.4
        return (1.0 if self.tool_ok else 0.0) * 0.6 + self.fact_hit * 0.4


async def call_agent(base: str, message: str, timeout: float = 90.0) -> CaseResult | None:
    """打一次 /api/chat，解析 SSE 成一个 CaseResult。"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{base}/api/chat",
                json={"message": message},
                headers={"content-type": "application/json"},
            ) as resp:
                if resp.status_code >= 400:
                    return None
                text = ""
                tools: list[str] = []
                cards: list[str] = []
                first_ms = 0
                planner = "?"
                degraded = False
                buffer = ""
                started = time.time()

                async for chunk in resp.aiter_text():
                    buffer += chunk
                    while "\n\n" in buffer:
                        frame, buffer = buffer.split("\n\n", 1)
                        event, data = _parse(frame)
                        if event == "delta":
                            if not first_ms:
                                first_ms = int((time.time() - started) * 1000)
                            text += str(data.get("text", ""))
                        elif event == "tool" and data.get("status") == "start":
                            tools.append(str(data.get("name", "")))
                        elif event == "card":
                            card = data.get("card") or {}
                            if card.get("type"):
                                cards.append(str(card["type"]))
                        elif event == "done":
                            planner = str(data.get("planner", "?"))
                            degraded = bool(data.get("degraded"))
                            tools = list(dict.fromkeys(list(data.get("toolCalls") or []) + tools))
                        elif event == "error":
                            return None

                return CaseResult(
                    case=Case("", message, "", ""),  # 稍后填充
                    text=text,
                    tool_calls=tools,
                    cards=cards,
                    first_token_ms=first_ms,
                    planner=planner,
                    degraded=degraded,
                )
    except Exception:
        return None


def _parse(frame: str) -> tuple[str, dict]:
    event, data_lines = "message", []
    for line in frame.split("\n"):
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if not data_lines:
        return event, {}
    try:
        return event, json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        return event, {}


async def run_backend(base: str, cases: list[Case]) -> dict[str, CaseResult | None]:
    print(f"  连接 {base} ...", flush=True)
    out: dict[str, CaseResult | None] = {}
    for case in cases:
        raw = await call_agent(base, case.message)
        if raw is not None:
            raw.case = case
        out[case.id] = raw
    return out


def render(name: str, results: dict[str, CaseResult | None]) -> float:
    print(f"\n{'=' * 68}\n{name}\n{'=' * 68}")
    print(f"{'用例':<12}{'意图':<6}{'工具':<16}{'卡片':<10}{'事实':<6}{'首字':<8}分")
    print("-" * 68)

    total = 0.0
    for case in CASES:
        r = results.get(case.id)
        if r is None:
            print(f"{case.id:<12}{case.intent:<6}{'—':<16}{'—':<10}{'—':<6}{'—':<8}0.00 (未连通)")
            continue
        tools = ",".join(r.tool_calls) or "-"
        cards = ",".join(r.cards) or "-"
        mark = "✓" if r.tool_ok else "✗"
        if case.expect_card:
            mark = "✓" if r.card_ok else "✗"
        print(
            f"{case.id:<12}{case.intent:<6}{tools:<16}{cards:<10}"
            f"{r.fact_hit:<6.0%}{r.first_token_ms:<8}{r.score:.2f} {mark}"
        )
        total += r.score

    avg = total / max(1, len(CASES))
    print("-" * 68)
    print(f"总分 {total:.2f} / {len(CASES)}   均分 {avg:.2%}")
    return avg


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ts", default=DEFAULT_TS)
    parser.add_argument("--py", default=DEFAULT_PY)
    parser.add_argument("--only", choices=["ts", "py"], default=None)
    parser.add_argument("--cases", default="", help="按分组过滤，逗号分隔，如 order,kb")
    args = parser.parse_args()

    cases = CASES
    if args.cases:
        groups = {g.strip() for g in args.cases.split(",")}
        cases = [c for c in CASES if c.group in groups]

    scores: dict[str, float] = {}
    if args.only in (None, "ts"):
        scores["TS 实现 (Node 网关)"] = render(
            f"TS 实现 — {args.ts}", await run_backend(args.ts, cases)
        )
    if args.only in (None, "py"):
        scores["Python 实现 (FastAPI 智能层)"] = render(
            f"Python 实现 — {args.py}", await run_backend(args.py, cases)
        )

    if len(scores) == 2:
        print(f"\n{'=' * 68}\n对比\n{'=' * 68}")
        for name, s in scores.items():
            print(f"  {name:<32} {s:.2%}")
        gap = scores["Python 实现 (FastAPI 智能层)"] - scores["TS 实现 (Node 网关)"]
        verdict = "Python 更优" if gap > 0.02 else ("TS 更优" if gap < -0.02 else "基本一致")
        print(f"\n  结论：{verdict}（差值 {gap:+.2%}）")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
