/**
 * 转人工的领域类型（ADR-0011）。
 *
 * 这里的核心取舍：**工单是唯一事实来源**，会话上不再单独存一个 mode 字段。
 * 两份状态一旦不同步，就会出现「界面显示已接入、后端还在调模型」这类
 * 最难复现的 bug。需要判断当前是不是人工模式，永远去问工单。
 */

export type HandoffReason = 'user_request' | 'sensitive' | 'low_confidence';
export type TicketStatus = 'queued' | 'active' | 'closed';
export type Resolution = 'resolved' | 'unresolved' | 'abandoned';

export const REASON_LABELS: Record<HandoffReason, string> = {
  user_request: '用户主动要求',
  sensitive: '敏感/升级场景',
  low_confidence: '智能体兜不住',
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  resolved: '已解决',
  unresolved: '未解决',
  abandoned: '用户离开',
};

export interface HandoffMessage {
  seq: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  /** 坐席名，仅 role=agent 时有 */
  author?: string;
  ts: number;
}

/** 交接给坐席的 AI 阶段上下文。只留问答对，不留工具调用细节——坐席看不懂也不需要。 */
export interface ContextTurn {
  question: string;
  answer: string;
  ts: number;
}

export interface HandoffTicket {
  id: string;
  sessionId: string;
  channel: string;
  status: TicketStatus;
  reason: HandoffReason;
  /** 触发这次转人工的那句话，坐席第一眼要看的就是它 */
  triggerText: string;
  agentName?: string;
  createdAt: number;
  claimedAt?: number;
  closedAt?: number;
  resolution?: Resolution;
  context: ContextTurn[];
  messages: HandoffMessage[];
  /** 最后一条消息的序号，用户端靠它做增量拉取 */
  seq: number;
}
