/**
 * @cs/protocol — 统一消息协议（对应手册 ADR-002）
 *
 * 定位：跨渠道、跨端、跨团队协作的唯一契约。
 * 原则：新渠道只做协议适配，坐席工作台与数据层零改动。
 * 约束：本包保持零运行时依赖，纯类型 + 纯函数，gateway / widget / 后续 console 共用。
 */

export type ChannelType =
  | 'web'
  | 'app'
  | 'wechat_mp'
  | 'wechat_mini'
  | 'wecom'
  | 'douyin'
  | 'email'
  | 'api';

export type MessageType = 'text' | 'image' | 'card';

export type CardType =
  | 'faq'
  | 'product'
  | 'order'
  | 'logistics'
  | 'survey'
  | 'kb_ref'
  | 'confirm'
  | 'ticket';

export type Role = 'user' | 'bot' | 'system' | 'agent';

export interface CardField {
  label: string;
  value: string;
}

export interface CardAction {
  label: string;
  value: string;
}

export interface CardPayload {
  type: CardType;
  title?: string;
  summary?: string;
  fields?: CardField[];
  source?: string;
  confidence?: number;
  actions?: CardAction[];
}

export interface UnifiedMessage {
  id: string;
  sessionId: string;
  role: Role;
  type: MessageType;
  content: string;
  card?: CardPayload;
  channel: ChannelType;
  ts: number;
  traceId?: string;
}

export interface ChatRequest {
  sessionId?: string;
  message: string;
  channel?: ChannelType;
}

/** SSE 事件定义（对应手册 ADR-003：机器人流式输出走 SSE；ADR-0006：智能体增加 tool 事件） */
export type SseEvent =
  | { event: 'meta'; data: { sessionId: string; traceId: string; ts: number } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool'; data: { name: string; status: 'start' | 'done'; summary?: string } }
  | { event: 'card'; data: { card: CardPayload } }
  | {
      event: 'done';
      data: {
        firstTokenMs: number;
        matched: boolean;
        confidence: number;
        messageId: string;
        /** 智能体元数据（ADR-0006）：规划器、工具调用链、是否降级 */
        planner?: string;
        toolCalls?: string[];
        degraded?: boolean;
      };
    }
  | { event: 'error'; data: { code: string; message: string } };

export const SSE_EVENT_NAMES = ['meta', 'delta', 'tool', 'card', 'done', 'error'] as const;

let seq = 0;

export function createId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36).padStart(3, '0')}`;
}

export function createUnifiedMessage(input: {
  sessionId: string;
  role: Role;
  content: string;
  channel?: ChannelType;
  type?: MessageType;
  card?: CardPayload;
  traceId?: string;
}): UnifiedMessage {
  return {
    id: createId('msg'),
    sessionId: input.sessionId,
    role: input.role,
    type: input.type ?? 'text',
    content: input.content,
    card: input.card,
    channel: input.channel ?? 'web',
    ts: Date.now(),
    traceId: input.traceId,
  };
}

/** 序列化一条 SSE 帧（event + data，双换行结尾） */
export function formatSseFrame(event: SseEvent['event'], data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 解析一条 SSE 帧（按 \n\n 切分后的单帧文本） */
export function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}
