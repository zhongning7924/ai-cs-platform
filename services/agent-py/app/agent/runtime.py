"""AgentRuntime（ADR-0006 的 Python 实现）：把「规划 → 行动 → 观察 → 再规划」跑成事件流。

与 TS 版本行为对齐，宿主（FastAPI 网关或 Node 网关）只做两件事：
  1. 构造时注册 planner / tools / memory；
  2. 消费 AgentEvent 映射到传输层（SSE 帧）。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import TYPE_CHECKING, AsyncIterator, Callable

from ..schemas import CardAction, CardPayload
from .memory import AgentMemory, InMemoryMemory
from .registry import ToolRegistry
from .sanitize import user_safe_echo
from .types import (
    AgentEvent,
    AgentPlanner,
    CardEvent,
    ChatTurn,
    DeltaEvent,
    EndEvent,
    PendingConfirm,
    PlannerContext,
    PlannerOverrides,
    ReplyDecision,
    RunMeta,
    ToolCallDecision,
    ToolContext,
    ToolEvent,
    ToolObservation,
    ToolResult,
)

if TYPE_CHECKING:
    from ..skills.registry import SkillRegistry
    from ..skills.types import ActiveSkill

log = logging.getLogger("agent.runtime")

CONFIRM_YES = re.compile(r"^(确认|确定|是的?|好(的)?|可以|执行|同意|ok|confirm|yes|y)[\s!！。，,.]*$", re.I)
CONFIRM_NO = re.compile(r"^(取消|不了|不用|算了|否|不|cancel|no|n)[\s!！。，,.]*$", re.I)


class EventQueue:
    """极简异步队列：规划器/工具侧 push，消费侧 drain——让 AsyncGenerator 能实时吐事件。"""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[AgentEvent | None] = asyncio.Queue()
        self._closed = False

    def push(self, event: AgentEvent) -> None:
        if self._closed:
            return
        self._queue.put_nowait(event)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.put_nowait(None)

    async def drain(self) -> AsyncIterator[AgentEvent]:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            yield item


class AgentRuntime:
    def __init__(
        self,
        *,
        planner: AgentPlanner,
        registry: ToolRegistry,
        memory: AgentMemory | None = None,
        fallback_planner: AgentPlanner | None = None,
        skills: "SkillRegistry | None" = None,
        max_steps: int = 4,
        history_window: int = 12,
        stream_chunk_size: int = 48,
        logger: Callable[[str], None] | None = None,
        agent_resolver: Callable[[str], str | None] | None = None,
    ) -> None:
        self._planner = planner
        self._fallback = fallback_planner
        self._registry = registry
        self._memory = memory or InMemoryMemory()
        self._skills = skills
        self._max_steps = max_steps
        self._history_window = history_window
        self._chunk_size = stream_chunk_size
        self._logger = logger
        # 确认/取消轮不经过规划器，坐席归因从这里补，否则 done 帧会丢 agent
        self._agent_of = agent_resolver

    def log(self, message: str) -> None:
        if self._logger:
            self._logger(message)

    async def run(
        self,
        question: str,
        *,
        session_id: str,
        namespace: str = "personal",
        overrides: PlannerOverrides | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """运行一轮对话。任何内部异常都以兜底文案收尾，绝不把半截流抛给调用方。"""
        queue = EventQueue()
        task = asyncio.create_task(self._execute(question, session_id, namespace, overrides, queue))
        try:
            async for event in queue.drain():
                yield event
        finally:
            if not task.done():
                task.cancel()

    async def _execute(
        self,
        question: str,
        session_id: str,
        namespace: str,
        overrides: PlannerOverrides | None,
        queue: EventQueue,
    ) -> None:
        try:
            await self._loop(question, session_id, namespace, overrides, queue)
        except Exception as err:  # noqa: BLE001 - 兜底是设计意图
            log.exception("agent 执行失败，改为兜底回复")
            await self._typewriter(
                "抱歉，刚才处理出现了点问题，请稍后重试，或输入「转人工」找人工客服。",
                queue,
            )
        finally:
            queue.close()

    async def _loop(
        self,
        question: str,
        session_id: str,
        namespace: str,
        overrides: PlannerOverrides | None,
        queue: EventQueue,
    ) -> None:
        memory = self._memory
        meta = RunMeta(steps=0, tool_calls=[], planner=self._planner.name, degraded=False)

        # 护栏④：有待确认的高风险操作时，先裁决确认/取消
        pending = memory.pending_confirm(session_id)
        if pending:
            # 这一轮不走规划器，但归因不能缺——补上最后服务过的坐席
            if self._agent_of is not None:
                meta.agent = meta.agent or self._agent_of(session_id)
                meta.route = meta.route or "confirm"
            answer = question.strip()
            if CONFIRM_YES.match(answer):
                memory.set_pending_confirm(session_id, None)
                await self._execute_confirmed(pending, question, session_id, namespace, meta, queue)
                return
            if CONFIRM_NO.match(answer):
                memory.set_pending_confirm(session_id, None)
                await self._finish(
                    "好的，已取消该操作。还有其他可以帮您？", question, session_id, meta, queue
                )
                return
            # 用户没接确认话术 → 过期作废，正常处理新问题
            memory.set_pending_confirm(session_id, None)

        observations: list[ToolObservation] = []
        planner = self._planner

        # 技能命中：只算一次，整轮复用（多步工具调用共享同一份领域指令）
        active: "ActiveSkill | None" = (
            self._skills.match(question) if self._skills is not None else None
        )
        if active is not None:
            meta.skill = active.skill.name
            self.log(
                f"技能激活：{active.skill.name}（{active.skill.title}，"
                f"触发词 {', '.join(active.matched)}）"
            )

        step = 0
        while step < self._max_steps:
            meta.steps = step + 1
            try:
                decision = await planner.next(
                    self._planner_ctx(
                        question, session_id, observations, step, queue, active, meta, overrides
                    )
                )
            except Exception as err:  # noqa: BLE001
                if planner is self._planner and self._fallback is not None:
                    meta.degraded = True
                    meta.planner = self._fallback.name
                    self.log(f"规划器降级（{self._planner.name} → {self._fallback.name}）: {err}")
                    planner = self._fallback
                    continue  # 用降级规划器重跑当前步
                raise

            # 护栏⑤：坐席工具白名单。规划器把白名单随决策带出来，这里在执行侧再校验一次。
            # 只靠「规划器看不见」是不够的——模型可能吐出一个清单外的工具名。
            if isinstance(decision, ToolCallDecision) and decision.allowed_tools is not None:
                if decision.tool_name not in decision.allowed_tools:
                    allowed_names = [
                        n for n in self._registry.names() if n in decision.allowed_tools
                    ]
                    self.log(
                        f"越权调用被拦：{decision.tool_name} 不在 {meta.agent or '当前坐席'} 白名单内"
                    )
                    observations.append(
                        ToolObservation(
                            tool_name=decision.tool_name,
                            text=(
                                f"工具 {decision.tool_name} 不在当前坐席权限内，无法调用。"
                                f"本坐席可用：{'、'.join(allowed_names) or '无'}。"
                                f"请改用可用工具，或说明该诉求由对应团队跟进。"
                            ),
                        )
                    )
                    step += 1
                    continue

            if isinstance(decision, ReplyDecision):
                text = decision.text.strip()
                if not text and observations:
                    text = user_safe_echo(observations[-1].text)
                if text and not decision.streamed:
                    await self._typewriter(text, queue)
                if not text:
                    text = "抱歉，我暂时没有生成有效回答，请换个问法，或输入「转人工」。"
                    await self._typewriter(text, queue)
                memory.append(session_id, ChatTurn(role="user", content=question))
                memory.append(session_id, ChatTurn(role="assistant", content=text))
                queue.push(EndEvent(meta))
                return

            tool = self._registry.get(decision.tool_name)
            if tool is None:
                names = ", ".join(t.name for t in self._registry.specs()) or "无"
                observations.append(
                    ToolObservation(
                        tool_name=decision.tool_name,
                        text=f"工具 {decision.tool_name} 不存在。可用工具：{names}",
                    )
                )
                step += 1
                continue

            summary = self._describe(decision.tool_name, decision.args)

            # 护栏④：高风险动作绝不静默执行，挂起并要用户确认
            if tool.spec.risk == "high":
                memory.set_pending_confirm(
                    session_id,
                    PendingConfirm(
                        call_id=decision.call_id,
                        tool_name=decision.tool_name,
                        args=decision.args,
                        summary=summary,
                        created_at=time.time(),
                    ),
                )
                queue.push(DeltaEvent(text="该操作需要您确认后才会执行：\n"))
                queue.push(
                    CardEvent(
                        card=CardPayload(
                            type="confirm",
                            title=(
                                "确认执行：创建工单"
                                if decision.tool_name == "create_ticket"
                                else f"确认执行：{decision.tool_name}"
                            ),
                            summary=summary,
                            actions=[
                                CardAction(label="回复「确认」执行", value="确认"),
                                CardAction(label="回复「取消」放弃", value="取消"),
                            ],
                        )
                    )
                )
                memory.append(session_id, ChatTurn(role="user", content=question))
                memory.append(
                    session_id,
                    ChatTurn(role="assistant", content=f"（等待用户确认操作：{summary}）"),
                )
                queue.push(EndEvent(meta))
                return

            queue.push(ToolEvent(name=decision.tool_name, status="start", summary=summary))
            try:
                result: ToolResult = await tool.execute(
                    decision.args, ToolContext(session_id=session_id, namespace=namespace)
                )
            except Exception as err:  # noqa: BLE001 - 工具失败不阻断循环，把错误当成观察
                log.exception("工具 %s 执行失败", decision.tool_name)
                result = ToolResult(observation=f"工具执行失败：{err}")

            queue.push(ToolEvent(name=decision.tool_name, status="done"))
            if result.card:
                queue.push(CardEvent(card=result.card))
            observations.append(ToolObservation(tool_name=decision.tool_name, text=result.observation))
            memory.append(
                session_id,
                ChatTurn(
                    role="tool",
                    content=result.observation[:300],
                    tool_name=decision.tool_name,
                ),
            )
            meta.tool_calls.append(decision.tool_name)
            step += 1

        # 步数用尽：把最后的观察摘给用户，不再循环。观察里可能夹着写给模型的指令，
        # 必须摘干净再出——否则用户会看到「请如实告知用户…」这种内部提醒。
        last = observations[-1] if observations else None
        text = (
            user_safe_echo(last.text, 220)
            if last
            else "抱歉，这个问题我还需要更多信息。您可以补充细节，或输入「转人工」。"
        )
        if not text:
            text = "抱歉，这个问题我还需要更多信息。您可以补充细节，或输入「转人工」。"
        await self._typewriter(text, queue)
        memory.append(session_id, ChatTurn(role="user", content=question))
        memory.append(session_id, ChatTurn(role="assistant", content=text))
        queue.push(EndEvent(meta))

    async def _execute_confirmed(
        self,
        pending: PendingConfirm,
        question: str,
        session_id: str,
        namespace: str,
        meta: RunMeta,
        queue: EventQueue,
    ) -> None:
        tool = self._registry.get(pending.tool_name)
        if tool is None:
            await self._finish("该操作已失效，请重新描述您的需求。", question, session_id, meta, queue)
            return

        queue.push(ToolEvent(name=tool.spec.name, status="start", summary=pending.summary))
        try:
            result = await tool.execute(
                pending.args, ToolContext(session_id=session_id, namespace=namespace)
            )
        except Exception as err:  # noqa: BLE001
            result = ToolResult(observation=f"工具执行失败：{err}")

        queue.push(ToolEvent(name=tool.spec.name, status="done"))
        if result.card:
            queue.push(CardEvent(card=result.card))

        meta.steps = 1
        meta.tool_calls.append(tool.spec.name)
        self._memory.append(session_id, ChatTurn(role="user", content=question))
        self._memory.append(
            session_id,
            ChatTurn(role="assistant", content=f"已执行 {tool.spec.name}：{result.observation[:160]}"),
        )
        queue.push(EndEvent(meta))

    def _planner_ctx(
        self,
        question: str,
        session_id: str,
        observations: list[ToolObservation],
        step: int,
        queue: EventQueue,
        active: "ActiveSkill | None" = None,
        meta: RunMeta | None = None,
        overrides: PlannerOverrides | None = None,
    ) -> PlannerContext:
        specs = self._registry.specs()
        if active is not None and active.skill.tools:
            # 技能偏好的工具排前面：7B 模型对「列表顺序」的敏感度比想象中高
            order = {name: i for i, name in enumerate(active.skill.tools)}
            specs.sort(key=lambda s: order.get(s.name, len(order)))

        return PlannerContext(
            session_id=session_id,
            question=question,
            history=self._memory.window(session_id, self._history_window),
            tools=specs,
            observations=observations,
            step=step,
            skill=active,
            overrides=overrides,
            meta=meta,
            on_delta=lambda text: queue.push(DeltaEvent(text=text)),
        )

    @staticmethod
    def _describe(tool_name: str, args: dict) -> str:
        brief = " ".join(
            f"{k}={str(v)[:24]}" for k, v in list(args.items())[:2]
        )
        return f"{tool_name}({brief})"

    async def _typewriter(self, text: str, queue: EventQueue) -> None:
        """非流式回复的打字机效果（规则规划器 / 兜底路径）。"""
        for i in range(0, len(text), self._chunk_size):
            queue.push(DeltaEvent(text=text[i : i + self._chunk_size]))
            await asyncio.sleep(0.015)

    async def _finish(
        self, text: str, question: str, session_id: str, meta: RunMeta, queue: EventQueue
    ) -> None:
        await self._typewriter(text, queue)
        self._memory.append(session_id, ChatTurn(role="user", content=question))
        self._memory.append(session_id, ChatTurn(role="assistant", content=text))
        queue.push(EndEvent(meta))
