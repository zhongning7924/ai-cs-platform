"""契约层：与 packages/protocol/src/index.ts 一一对应。

字段名在传输层保持 camelCase（浏览器挂件按这个解析），
Python 内部用 snake_case，靠 alias 双向转换。改契约时两边必须同改。
"""

import json
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

ChannelType = Literal["web", "app", "wechat_mp", "wechat_mini", "wecom", "douyin", "email", "api"]
CardType = Literal[
    "faq", "product", "order", "logistics", "survey", "kb_ref", "confirm", "ticket"
]


class Wire(BaseModel):
    """传输模型基类：内部 snake_case，外部 camelCase。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def wire(self) -> dict:
        """序列化成浏览器认识的形状：丢掉 None（对齐 JSON.stringify 行为）。"""
        return self.model_dump(by_alias=True, exclude_none=True)


class CardField(Wire):
    label: str
    value: str


class CardAction(Wire):
    label: str
    value: str


class CardPayload(Wire):
    type: CardType
    title: str | None = None
    summary: str | None = None
    fields: list[CardField] | None = None
    source: str | None = None
    confidence: float | None = None
    actions: list[CardAction] | None = None


class ChatRequest(Wire):
    session_id: str | None = None
    message: str
    channel: ChannelType = "web"
    # 后台可配置的客服人设（品牌/语气）。空则用默认人设；护栏硬规则不受其影响
    persona: str | None = None
    # 模型运行时覆盖（后台可热改，无需重启）。base_url/api_key 属部署级，不在此覆盖
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    # 网关透传的链路 id，用于跨语言排查
    trace_id: str | None = Field(default=None, alias="traceId")


class ChatResponseDone(Wire):
    first_token_ms: int = 0
    matched: bool = False
    confidence: float = 0.0
    message_id: str = ""
    planner: str = "unknown"
    tool_calls: list[str] = Field(default_factory=list)
    degraded: bool = False
    skill: str | None = None
    # 路由分诊：坐席、判定来源（rule/carry/llm/fallback）、中途换人记录
    agent: str | None = None
    route: str | None = None
    handoffs: list[str] = Field(default_factory=list)


def sse_frame(event: str, data: dict | BaseModel) -> str:
    """序列化一条 SSE 帧。

    必须与 TS 的 formatSseFrame 字节级等价：
      event: <name>\\ndata: <compact-json>\\n\\n
    """
    payload = data.wire() if isinstance(data, BaseModel) else data
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
    return f"event: {event}\ndata: {body}\n\n"


def now_ms() -> int:
    return int(time.time() * 1000)


_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
_seq = 0


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    out: list[str] = []
    while n:
        n, r = divmod(n, 36)
        out.append(_DIGITS[r])
    return "".join(reversed(out))


def create_id(prefix: str, width: int = 3) -> str:
    """对齐 TS 侧 createId：前缀_36 进制毫秒 + 定宽 36 进制序号。"""
    global _seq
    _seq += 1
    return f"{prefix}_{_base36(now_ms())}{_base36(_seq).zfill(width)}"
