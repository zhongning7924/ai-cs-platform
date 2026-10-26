"""路由分诊规划器：在既有的 Planner 缝上加一层「谁在说话」的判定。

为什么不需要改循环：`AgentPlanner` 是 Protocol，`PlannerDecision` 只有两种。
路由完全可以包在规划器内部——它把 ctx 收窄（换掉 tools、挂上坐席指令）后
委托给真正的 LLM 规划器，返回的还是同一种决策。

三层判定，从便宜到贵：
  1. 规则：触发词 + 单号正则打分，明确命中就直接定，零模型调用、零额外延迟；
  2. 沿用：本轮没有任何信号，但同一会话上一轮有坐席 → 沿用（避免多轮里跳来跳去）；
  3. 模型：规则并列或完全无信号时，调一次 7B 做分类，超时/报错就退回最高分或兜底。

按这个顺序，绝大多数请求（问价格、问退款、给单号）的额外开销是 0。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import replace
from typing import Any

from .subagents import ActiveAgent, SubAgent
from .types import (
    AgentPlanner,
    PlannerContext,
    PlannerDecision,
    RunMeta,
    ToolCallDecision,
)

log = logging.getLogger("agent.router")

_CLASSIFY_PROMPT = """你是客服分诊器。判断用户这句话该由哪个坐席处理，只输出 JSON，不要解释。

坐席：
{agents}

用户问题：{question}

输出格式：{{"agent":"坐席名"}}"""


def _agent_catalog(agents: list[SubAgent]) -> str:
    """坐席目录。必须把 general 也列出来——否则模型只能在业务坐席里硬选一个，
    「你好」会被判成技术支持，用户一开口就被问「什么型号」。
    """
    return "\n".join(f"- {a.name}｜{a.title}：{a.description}" for a in agents)


class RouterPlanner:
    """把「分诊」做成规划器的装饰器，而不是新的一层循环。"""

    name = "router"

    def __init__(
        self,
        *,
        delegate: AgentPlanner,
        agents: list[SubAgent],
        client: Any | None = None,
        model: str = "",
        min_score: float = 1.0,
        classify_timeout: float = 4.0,
        carry_over: bool = True,
        session_cap: int = 2000,
    ) -> None:
        if not agents:
            raise ValueError("RouterPlanner 至少需要一个坐席")
        self._delegate = delegate
        self._agents = agents
        self._by_name = {a.name: a for a in agents}
        self._general = self._by_name.get("general") or agents[-1]
        self._client = client
        self._model = model
        self._min_score = min_score
        self._timeout = classify_timeout
        self._carry = carry_over
        self._cap = session_cap
        # session_id -> 坐席名。只用于「沿用」，丢了也只是退化为模型分诊
        self._last: dict[str, str] = {}

    # ---------- 对外 ----------

    async def next(self, ctx: PlannerContext) -> PlannerDecision:
        active = await self._route(ctx)
        self._report(ctx.meta, active)

        decision = await self._delegate.next(self._scope(ctx, active))

        # 把白名单随决策一起交出去，由 runtime 在执行侧再做一次校验。
        # 只在「看得到」这一层过滤是不够的——模型可能幻觉出一个清单外的工具名。
        allowed = active.agent.tool_set()
        if allowed is not None and isinstance(decision, ToolCallDecision):
            decision.allowed_tools = allowed
        return decision

    def current(self, session_id: str) -> str | None:
        """该会话上一次路由到的坐席。给 runtime 补确认/取消轮的归因用。"""
        return self._last.get(session_id)

    def describe(self) -> list[dict]:
        return [
            {
                "name": a.name,
                "title": a.title,
                "description": a.description,
                "tools": list(a.tools) or ["*"],
                "triggers": list(a.triggers),
                "priority": a.priority,
            }
            for a in self._agents
        ]

    # ---------- 判定 ----------

    async def _route(self, ctx: PlannerContext) -> ActiveAgent:
        active = await self._decide(ctx)
        # 路由结果同时是「下一轮的沿用依据」，所以在这里落记忆而不是在 next 里——
        # 单测/巡检直接调 _route 时行为也一致
        self._remember(ctx.session_id, active.agent.name)
        return active

    async def _decide(self, ctx: PlannerContext) -> ActiveAgent:
        ranked = self._score(ctx.question)
        top = ranked[0] if ranked else None

        # ① 规则明确：达到阈值且没有并列
        if (
            top is not None
            and top.score >= self._min_score
            and (len(ranked) == 1 or top.score > ranked[1].score)
        ):
            return top

        # ② 完全没信号，但同一会话上一轮有坐席 → 沿用。
        #    「那什么时候到」这种追问不带任何关键词，靠这一步接住。
        if top is None and self._carry:
            prev = self._last.get(ctx.session_id)
            if prev and prev in self._by_name:
                return ActiveAgent(self._by_name[prev], 0.0, [], "carry")

        # ③ 规则并列 / 无信号 → 请模型裁决
        picked = await self._classify(ctx.question)
        if picked is not None:
            return picked

        # ④ 模型不可用：有分数就用最高分，没有就兜底
        if top is not None:
            return top
        return ActiveAgent(self._general, 0.0, [], "fallback")

    def _score(self, question: str) -> list[ActiveAgent]:
        ranked: list[ActiveAgent] = []
        for agent in self._agents:
            if not agent.triggers and not agent.patterns:
                continue  # 兜底坐席不参与打分
            matched = _match_triggers(question, agent.triggers)
            score = float(len(matched))
            for pattern in agent.patterns:
                hit = re.search(pattern, question, re.I)
                if hit:
                    matched.append(hit.group(0))
                    score += 2.0  # 单号是强信号：给了单号基本就是要查这笔
            if score > 0:
                ranked.append(ActiveAgent(agent, score, matched, "rule"))
        ranked.sort(key=lambda a: (-a.score, -a.agent.priority))
        return ranked

    async def _classify(self, question: str) -> ActiveAgent | None:
        if self._client is None or not self._model:
            return None
        prompt = _CLASSIFY_PROMPT.format(
            agents=_agent_catalog(self._agents), question=question
        )
        try:
            resp = await asyncio.wait_for(
                self._client.chat.completions.create(
                    model=self._model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=32,
                ),
                timeout=self._timeout,
            )
        except Exception as err:  # noqa: BLE001 - 分诊失败不能拖垮主链路
            log.warning("分诊模型不可用，退回规则/兜底：%s", err)
            return None

        text = (resp.choices[0].message.content or "") if resp.choices else ""
        name = _parse_agent_name(text, self._by_name)
        if name is None:
            log.warning("分诊输出无法解析：%r", text[:80])
            return None
        return ActiveAgent(self._by_name[name], 0.0, [], "llm")

    # ---------- 编排 ----------

    def _scope(self, ctx: PlannerContext, active: ActiveAgent) -> PlannerContext:
        allowed = active.agent.tool_set()
        tools = ctx.tools if allowed is None else [t for t in ctx.tools if t.name in allowed]
        return replace(ctx, tools=tools, agent=active)

    def _remember(self, session_id: str, name: str) -> None:
        # 兜底坐席不参与「沿用」：上一轮是「你好」，不代表这一轮也该模糊处理。
        # 记住它只会让后续真正的业务问题掉进通用坐席，白白浪费一次分诊。
        if name == self._general.name:
            self._last.pop(session_id, None)
            return
        self._last[session_id] = name
        if len(self._last) > self._cap:
            # 粗略淘汰：dict 保持插入顺序，丢掉最老的一批
            for key in list(self._last)[: self._cap // 4]:
                self._last.pop(key, None)

    @staticmethod
    def _report(meta: RunMeta | None, active: ActiveAgent) -> None:
        if meta is None:
            return
        if meta.agent is None:
            meta.agent = active.agent.name
            meta.route = active.source
        elif meta.agent != active.agent.name:
            meta.handoffs.append(f"{meta.agent}→{active.agent.name}")
            meta.agent = active.agent.name
            meta.route = active.source


def _match_triggers(question: str, triggers: tuple[str, ...]) -> list[str]:
    """长词优先、命中即遮盖。

    「我要退款」里既有「退款」也有「要退」，不遮盖的话一句话能拿 2 分，
    把阈值校准全带偏。遮盖后一个语义点只算一次。
    """
    work = question
    matched: list[str] = []
    for trigger in sorted(triggers, key=len, reverse=True):
        if trigger in work:
            matched.append(trigger)
            work = work.replace(trigger, "\x00" * len(trigger))
    return matched


def _parse_agent_name(text: str, known: dict[str, SubAgent]) -> str | None:
    """小模型可能输出 ```json 包裹、带解释、或只写名字。三种都兼容。"""
    match = re.search(r"\{[^{}]*\}", text)
    if match:
        try:
            data = json.loads(match.group(0))
            name = str(data.get("agent", "")).strip()
            if name in known:
                return name
        except json.JSONDecodeError:
            pass
    for name in known:
        if re.search(rf"\b{re.escape(name)}\b", text, re.I):
            return name
    return None
