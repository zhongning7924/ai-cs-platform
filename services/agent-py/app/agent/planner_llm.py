"""LLM 规划器：一步 = 一次 OpenAI 兼容 chat/completions（流式）。

用官方 openai SDK 而不是手写 HTTP——这正是把智能层放 Python 的理由之一：
tool_calls 分片聚合、流式解析、超时重试都由成熟库兜住，我们只写业务规则。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

from openai import AsyncOpenAI

from .types import (
    PlannerContext,
    PlannerDecision,
    ReplyDecision,
    ToolCallDecision,
)

log = logging.getLogger("agent.planner")

DEFAULT_AGENT_SYSTEM_PROMPT = """你是企业智能客服坐席。用简体中文回答，口语化、简洁、分点。
工具选择规则（严格执行）：
1. 知识类问题——政策、流程、规范、内部资料、"能不能/怎么/是否可以"类问题 → 必须先调 kb_search（query 传精炼后的问题）；禁止调 query_order；
2. 仅当用户明确要求查询订单、给出订单号或问物流时 → 调 query_order（orderId 传订单号，如 CS1001）；禁止把普通问题当订单号；
3. 用户明确要求投诉、人工处理、创建工单、报修、反馈问题待解决 → 必须调 create_ticket（title 概括诉求，detail 补充细节）；
4. 打招呼、闲聊等无需事实依据的问题 → 不调任何工具，直接回答。
示例（严格模仿）：
- 用户"我要建个售后工单，沙发有异味" → 调 create_ticket(title="售后工单：沙发有异味")
- 用户"CS1002 到哪了" → 调 query_order(orderId="CS1002")
- 用户"周五能发布吗" → 调 kb_search(query="周五发布窗口")
- 用户"你好" → 直接回复问候，不调工具
回答规则：
5. 工具返回的观察结果是唯一事实来源：回答必须与观察一致；观察为空或未找到时，如实告知并建议换问法或转人工，禁止编造；
6. 涉及具体业务数据（订单状态、物流轨迹、优惠券、工单号、商品价格、金额）时，**必须先调用对应工具取得观察再回答**；没有观察结果就直接回答，等同于编造；
7. 最终回答控制在 150 字以内，必要时分点；
8. 禁止把工具调用写成文字（例如「调 create_ticket(...)」「query_order(orderId=...)」）——要调用工具必须使用 function calling，否则直接用自然语言回答；
9. 禁止向用户旁白工具调用过程（例如「调用 coupon_status 获取您的优惠券信息」）——需要数据就直接调用，拿到结果后只讲结果；
10. 禁止只回一句「我查一下 / 让我确认一下 / 稍等」就结束本轮——要么真的调用工具取证，要么直接给出结论。
    用户看不到你的内部动作，一句空承诺等于这一轮什么都没做。"""

_TAIL_TEMPLATE = "\n当前可用工具：{tools}。只能调用这里列出的工具。"


class StreamCleaner:
    """清洗小模型在 tools 模式下泄漏的内部标记（</tool_call>、<|im_end|> 等）。

    策略与 TS 侧一致：累积原始输出 → 剔除标记 → 只增量下发"清洗投影"，已发部分不回退。
    """

    _PATTERNS = (
        re.compile(r"</?tool_call>"),
        re.compile(r"<\|[a-z_]*\|>"),
        re.compile(r"^\s*\}\s*"),
    )

    def __init__(self) -> None:
        self._raw = ""
        self._sent = 0

    @classmethod
    def clean(cls, raw: str) -> str:
        out = raw
        for pattern in cls._PATTERNS:
            out = pattern.sub("", out)
        return out

    def push(self, chunk: str, on_delta: Callable[[str], None] | None = None) -> None:
        self._raw += chunk
        cleaned = self.clean(self._raw)
        if len(cleaned) > self._sent and on_delta:
            on_delta(cleaned[self._sent :])
            self._sent = len(cleaned)

    def text(self) -> str:
        return self.clean(self._raw).strip()


_CALL_PREFIX = re.compile(r"^(?:调用?|call|tool)\s*")
_KWARG = re.compile(r"(\w+)\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^,)]+))")


def _parse_leaked_call(text: str, tool_names: set[str]) -> tuple[str, dict[str, Any]] | None:
    """识别「把工具调用写成文字」的整段回复，例如：
    调 create_ticket(title="退款：沙发有异味")
    query_order(orderId="CS1002")
    """
    cleaned = text.strip().strip("`").strip()
    if "(" not in cleaned or ")" not in cleaned:
        return None
    head = _CALL_PREFIX.sub("", cleaned)
    match = re.match(r"^([A-Za-z_]\w*)\s*\((.*)\)\s*$", head, re.S)
    if not match:
        return None
    name, raw_args = match.group(1), match.group(2)
    if name not in tool_names:
        return None

    args: dict[str, Any] = {}
    for item in _KWARG.finditer(raw_args):
        value = item.group(3)
        if value is None:
            value = item.group(4) if item.group(4) is not None else (item.group(5) or "")
        args[item.group(1)] = value.strip()
    return name, args


class LeakGuard:
    """拦「工具调用写成文字」：只在前缀可能构成泄漏时短暂缓冲，正常正文零延迟下发。

    背景：7B 模型在技能指令的强引导下，会以两种方式泄漏工具调用：
      1. 整段就是调用：`调 create_ticket(title="...")` —— 动作没执行，用户看到一行代码；
      2. 先旁白再调用：`调用 coupon_status 获取您的优惠券信息。` —— 动作执行了，但用户看到内部过程。
    两种都要拦；正常正文（如「调查显示…」）不能被误伤。
    """

    HOLD_LIMIT = 18
    NARRATION_LIMIT = 48
    JUNK_CHUNKS = {"}", "]", "```", "```json", "```python"}

    _NARRATION_PREFIX = re.compile(r"^(?:调用?|使用|通过)(?:\s|$)")
    _NARRATION = re.compile(
        r"^(?:调用?|使用|通过)\s*[A-Za-z_]\w*(?:\s*工具)?\s*(?:\([^)]*\))?[^\n]{0,40}?[。\n]"
    )

    def __init__(self, tool_names: set[str], on_delta: Callable[[str], None] | None) -> None:
        self._tool_names = tool_names
        self._on_delta = on_delta
        self._buf = ""
        self._state: str = "hold"  # hold | stream | suppress

    def feed(self, chunk: str) -> None:
        if self._state == "stream":
            self._emit(chunk)
            return
        self._buf += chunk
        if self._state == "suppress":
            return

        head = self._buf.lstrip()
        if not head:
            return

        # ① 整段就是函数调用 → 后面的内容全部丢弃，交给调用方转成真实工具调用
        if self._looks_like_call(head):
            self._state = "suppress"
            return

        # ② 旁白行（有明确句末）→ 丢掉这一句，其余照常下发
        narration = self._NARRATION.match(head)
        if narration:
            rest = self._strip_junk(head[narration.end() :])
            self._buf = ""
            self._state = "stream"
            if rest:
                self._emit(rest)
            return

        # ③ 可能还在旁白中（如「调用」刚出来）→ 再等等
        if self._could_be_narration(head) and len(head) < self.NARRATION_LIMIT:
            return

        # ④ 明确不是调用 → 立即下发
        if not self._could_be_call(head) or len(head) >= self.HOLD_LIMIT:
            self._state = "stream"
            self._emit(self._buf)
            self._buf = ""

    def finish(self) -> None:
        if self._state == "hold" and self._buf:
            self._state = "stream"
            self._emit(self._buf)
            self._buf = ""

    @property
    def leaked(self) -> bool:
        return self._state == "suppress"

    def _could_be_call(self, head: str) -> bool:
        if _CALL_PREFIX.match(head) or head.startswith("{"):
            return True
        return any(name.startswith(head) for name in self._tool_names if len(head) >= 2)

    def _could_be_narration(self, head: str) -> bool:
        match = self._NARRATION_PREFIX.match(head)
        if not match:
            return False
        rest = head[match.end() :].lstrip()
        return not rest or bool(re.match(r"^[A-Za-z_]", rest))

    def _looks_like_call(self, head: str) -> bool:
        if re.match(r"^\s*(?:调用?|call|tool)\s*[A-Za-z_]\w*\s*\(", head):
            return True
        return any(re.match(rf"^\s*{re.escape(name)}\s*\(", head) for name in self._tool_names)

    @staticmethod
    def _strip_junk(text: str) -> str:
        return re.sub(r"^[\s}\]\)]+", "", text)

    def _emit(self, text: str) -> None:
        if not text or text.strip() in self.JUNK_CHUNKS:
            return
        if self._on_delta:
            self._on_delta(text)


class LlmPlanner:
    """决策层：把 PlannerContext 翻译成一次模型调用，把流翻译成一个决策。"""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        temperature: float = 0.3,
        max_tokens: int = 1024,
        system_prompt: str | None = None,
        client: AsyncOpenAI | None = None,
    ) -> None:
        self.name = f"llm:{model}"
        self._model = model
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._system_prompt = system_prompt or DEFAULT_AGENT_SYSTEM_PROMPT
        self._client = client or AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=60.0)

    def _system_message(self, ctx: PlannerContext) -> str:
        """系统提示 = 通用规则 + 坐席边界 + 技能指令 + 当前工具清单。

        顺序有讲究：坐席在最前（它决定身份和工具白名单），技能在后
        （它只在本坐席的职责范围内补细节）。反过来会让 7B 先看到技能细节、
        忽略坐席边界，退化成「谁都能答」。
        """
        parts = [self._system_prompt]
        if ctx.agent is not None:
            parts.append(ctx.agent.prompt_block())
        if ctx.skill is not None:
            parts.append(ctx.skill.prompt_block())
        if ctx.tools:
            parts.append(_TAIL_TEMPLATE.format(tools="、".join(t.name for t in ctx.tools)))
        return "".join(parts)

    def _messages(self, ctx: PlannerContext) -> list[dict[str, Any]]:
        """组装消息。

        刻意不回灌 OpenAI 的 role="tool"：那要求前一条 assistant 带 tool_calls、
        且每条 tool 消息带 tool_call_id，任何一处缺失硅基流动就返回 400
        （"Field required"）。把观察当作 user 消息喂回去，协议面最小、最稳，
        对 7B 模型也更友好。
        """
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self._system_message(ctx)}
        ]

        # 本轮已有 observations 时，history 里的 tool 轮是同一批内容，跳过以免重复
        skip_tool_turns = bool(ctx.observations)

        for turn in ctx.history:
            if turn.role == "tool":
                if skip_tool_turns:
                    continue
                messages.append(
                    {"role": "user", "content": f"[工具 {turn.tool_name or 'tool'} 返回]\n{turn.content}"}
                )
                continue
            if not turn.content.strip():
                continue  # 空 content 的 assistant 消息会被服务端拒
            messages.append({"role": turn.role, "content": turn.content})

        messages.append({"role": "user", "content": ctx.question})

        if ctx.observations:
            joined = "\n\n".join(f"[工具 {o.tool_name} 返回]\n{o.text}" for o in ctx.observations)
            messages.append({"role": "user", "content": joined})

        return messages

    async def next(self, ctx: PlannerContext) -> PlannerDecision:
        messages = self._messages(ctx)
        tools = [t.openai_tool() for t in ctx.tools]

        stream = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            tools=tools or None,
            temperature=self._temperature,
            max_tokens=self._max_tokens,
            stream=True,
        )

        cleaner = StreamCleaner()
        on_delta = ctx.on_delta
        tool_names = {t.name for t in ctx.tools}
        guard = LeakGuard(tool_names, on_delta)
        # index -> 累积中的函数调用
        partials: dict[int, dict[str, Any]] = {}

        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            if delta.content:
                cleaner.push(delta.content, guard.feed)

            for piece in delta.tool_calls or []:
                slot = partials.setdefault(
                    piece.index or 0, {"id": "", "name": "", "args": ""}
                )
                if piece.id:
                    slot["id"] = piece.id
                if piece.function:
                    if piece.function.name:
                        slot["name"] = piece.function.name
                    if piece.function.arguments:
                        slot["args"] += piece.function.arguments

        guard.finish()

        if partials:
            call = next(iter(partials.values()))
            args = _safe_json(call["args"])
            return ToolCallDecision(
                call_id=call["id"] or call["name"],
                tool_name=call["name"],
                args=args,
            )

        text = cleaner.text()
        if guard.leaked:
            leaked = _parse_leaked_call(text, tool_names)
            if leaked is not None:
                name, args = leaked
                log.warning("模型把工具调用写成了文字，已纠正为真实调用: %s(%s)", name, args)
                return ToolCallDecision(call_id=f"leak_{name}", tool_name=name, args=args)
            log.warning("疑似工具调用泄漏但无法解析，按空回复处理: %s", text[:120])
            return ReplyDecision(text="", streamed=False)

        return ReplyDecision(text=text, streamed=True)


def _safe_json(raw: str) -> dict[str, Any]:
    """小模型的 JSON 常常残缺（截断、多出引号），尽最大努力解析，失败返回空 dict。"""
    raw = raw.strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass
    # 补右括号重试：截断时常见 {"title":"xxx
    for suffix in ("}", '"}', "}}"):
        try:
            parsed = json.loads(raw + suffix)
            if isinstance(parsed, dict):
                log.warning("工具参数 JSON 残缺，已修复：%s", raw)
                return parsed
        except json.JSONDecodeError:
            continue
    log.warning("工具参数无法解析，按空参数处理：%s", raw)
    return {}
