"""规则规划器（扩展缝 ① 的降级实现）。

行为与 TS 侧 RulePlanner 对齐：
- 第 0 步：有低风险工具就调用第一个（注册顺序决定，kb_search 优先）；
- 第 1 步：把观察摘录作答（抽取式，不生成）。
它永远不会失败——这是"没配 LLM 系统照常跑"的保证。
"""

from __future__ import annotations

import random
import string

from .types import PlannerContext, PlannerDecision, ReplyDecision, ToolCallDecision

DEFAULT_FALLBACK = "抱歉，这个问题我暂时答不了。您可以换个问法，或输入「转人工」找人工客服。"


class RulePlanner:
    name = "rule"

    def __init__(self, fallback_text: str = DEFAULT_FALLBACK) -> None:
        self._fallback = fallback_text

    async def next(self, ctx: PlannerContext) -> PlannerDecision:
        if ctx.step == 0:
            tool = next((t for t in ctx.tools if t.risk == "low"), None)
            if tool:
                suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
                return ToolCallDecision(
                    call_id=f"rule_{suffix}", tool_name=tool.name, args={"query": ctx.question}
                )
            return ReplyDecision(text=self._fallback)

        last = ctx.observations[-1] if ctx.observations else None
        return ReplyDecision(text=(last.text.strip() if last else "") or self._fallback)
