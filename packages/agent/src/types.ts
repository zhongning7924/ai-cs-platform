/**
 * @cs/agent — 智能体核心契约（ADR-0006）
 *
 * 四个扩展缝：Planner（决策）/ Tool（行动）/ Memory（记忆）/ Guardrail（risk + 确认流）。
 * 本包只定义契约与循环，不绑定任何具体 LLM、知识库、订单系统——那些是宿主的注册项。
 */

import type { CardPayload } from '@cs/protocol';

/* ---------------- 工具（行动层） ---------------- */

/** 工具风险等级：high 触发人工确认护栏 */
export type ToolRisk = 'low' | 'high';

/** OpenAI Function Calling 兼容的参数 schema（JSON Schema 子集） */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

/** 工具声明（注册即进入规划器的工具清单） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: ToolRisk;
}

export interface ToolContext {
  sessionId: string;
  /** 知识库 / 业务命名空间（租户隔离用） */
  namespace: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** 喂回规划器的观察文本——这是 LLM 的唯一事实来源 */
  observation: string;
  /** 可选：直接渲染给用户的卡片（kb_ref / order / ticket …） */
  card?: CardPayload;
}

export interface Tool extends ToolSpec {
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/* ---------------- 规划器（决策层） ---------------- */

export interface ToolObservation {
  toolName: string;
  text: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolName?: string;
  ts: number;
}

export interface PlannerContext {
  sessionId: string;
  /** 本轮用户输入 */
  question: string;
  /** 本轮之前的对话窗口 */
  history: ChatTurn[];
  /** 可用工具清单（声明，不含执行体） */
  tools: ToolSpec[];
  /** 本轮已产生的工具观察 */
  observations: ToolObservation[];
  /** 第几步（0 起） */
  step: number;
  /** 流式回复回调；规划器若边生成边回调，应在 reply 决策上标记 streamed */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export type PlannerDecision =
  | { type: 'reply'; text: string; streamed?: boolean }
  | { type: 'tool_call'; callId: string; toolName: string; args: Record<string, unknown> };

/** 决策层唯一接口。换 Dify/LangGraph 多智能体编排 = 换一个实现 */
export interface AgentPlanner {
  readonly name: string;
  next(ctx: PlannerContext): Promise<PlannerDecision> | PlannerDecision;
}

/* ---------------- 记忆（记忆层） ---------------- */

export interface PendingConfirm {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: number;
}

export interface AgentMemory {
  /** 取最近 limit 轮（跨 user/assistant/tool） */
  window(sessionId: string, limit: number): ChatTurn[];
  append(sessionId: string, turn: Omit<ChatTurn, 'ts'>): void;
  pendingConfirm(sessionId: string): PendingConfirm | null;
  setPendingConfirm(sessionId: string, pending: PendingConfirm | null): void;
}

/* ---------------- 运行期事件（传输层无关） ---------------- */

export interface RunMeta {
  steps: number;
  toolCalls: string[];
  planner: string;
  /** LLM 失败降级到规则规划器 */
  degraded: boolean;
}

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; status: 'start' | 'done'; summary?: string }
  | { type: 'card'; card: CardPayload }
  | { type: 'end'; meta: RunMeta };
