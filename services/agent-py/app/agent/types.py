"""智能体契约（对标 packages/agent/src/types.ts，ADR-0006）。

四个扩展缝：Planner（决策）/ Tool（行动）/ Memory（记忆）/ Guardrail（护栏）。
本模块只定义契约，不绑定任何具体 LLM、知识库、订单系统——那些是宿主的注册项。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

from ..schemas import CardPayload

if TYPE_CHECKING:
    from ..skills.types import ActiveSkill
    from .subagents import ActiveAgent

ToolRisk = Literal["low", "high"]
ToolStatus = Literal["start", "done"]


@dataclass
class JsonSchema:
    """OpenAI Function Calling 兼容的参数 schema。"""

    type: str = "object"
    properties: dict[str, dict[str, Any]] = field(default_factory=dict)
    required: list[str] = field(default_factory=list)


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: JsonSchema
    risk: ToolRisk = "low"

    def openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": self.parameters.type,
                    "properties": self.parameters.properties,
                    **({"required": self.parameters.required} if self.parameters.required else {}),
                },
            },
        }


@dataclass
class ToolContext:
    session_id: str
    namespace: str = "personal"


@dataclass
class ToolResult:
    """工具产出。observation 是喂回规划器的唯一事实来源。"""

    observation: str
    card: CardPayload | None = None


class Tool(Protocol):
    spec: ToolSpec

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult: ...


@dataclass
class ChatTurn:
    role: Literal["user", "assistant", "tool", "system"]
    content: str
    tool_name: str | None = None
    ts: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass
class ToolObservation:
    tool_name: str
    text: str


@dataclass
class PendingConfirm:
    call_id: str
    tool_name: str
    args: dict[str, Any]
    summary: str
    created_at: float


@dataclass
class PlannerOverrides:
    """后台可热改的运行时覆盖（无需重启，逐请求透传）。

    - persona：客服人设（品牌/语气/业务范围）。空用默认；护栏硬规则永远追加，不可覆盖。
    - model / temperature / max_tokens：LLM 生成参数。都是 create() 的调用参数，
      改它们不需要重连 client。base_url / api_key 属部署级安全边界，不在这里覆盖。
    """

    persona: str | None = None
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass
class ReplyDecision:
    text: str
    streamed: bool = False


@dataclass
class ToolCallDecision:
    call_id: str
    tool_name: str
    args: dict[str, Any]
    # 规划器声明的工具白名单。None = 不限制（单坐席模式）。
    # 由 RouterPlanner 填写，runtime 在执行前校验：只在「可见性」这层过滤不够，
    # 模型可能吐出一个清单外的工具名。
    allowed_tools: frozenset[str] | None = None


PlannerDecision = ReplyDecision | ToolCallDecision


@dataclass
class PlannerContext:
    session_id: str
    question: str
    history: list[ChatTurn]
    tools: list[ToolSpec]
    observations: list[ToolObservation]
    step: int
    # 命中的技能（上下文增强，不限制工具权限）
    skill: "ActiveSkill | None" = None
    # 路由到的坐席（身份隔离，限定工具白名单）
    agent: "ActiveAgent | None" = None
    # 运行时覆盖（后台可热改，无需重启）。见 PlannerOverrides 字段注释
    overrides: "PlannerOverrides | None" = None
    # 上报通道：规划器可写 agent / route / handoffs 等归因字段，runtime 原样带出
    meta: "RunMeta | None" = None
    on_delta: Any = None  # Callable[[str], None] | None


class AgentPlanner(Protocol):
    name: str

    async def next(self, ctx: PlannerContext) -> PlannerDecision: ...


@dataclass
class RunMeta:
    steps: int = 0
    tool_calls: list[str] = field(default_factory=list)
    planner: str = "unknown"
    degraded: bool = False
    skill: str | None = None
    # 路由分诊的结果：哪个坐席、怎么定的、中途有没有换人
    agent: str | None = None
    route: str = ""
    handoffs: list[str] = field(default_factory=list)


@dataclass
class DeltaEvent:
    text: str


@dataclass
class ToolEvent:
    name: str
    status: ToolStatus
    summary: str | None = None


@dataclass
class CardEvent:
    card: CardPayload


@dataclass
class EndEvent:
    meta: RunMeta


AgentEvent = DeltaEvent | ToolEvent | CardEvent | EndEvent
