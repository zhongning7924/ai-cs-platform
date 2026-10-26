import { parseSseFrame, type CardPayload, type SseEvent } from '@cs/protocol';

export interface HandoffState {
  ticketId: string;
  status: 'queued' | 'active' | 'closed';
  position: number;
  agentName: string | null;
  reason?: string;
  reasonLabel?: string;
  waitingSec?: number;
}

export interface StreamHandlers {
  onMeta?: (data: { sessionId: string; traceId: string; ts: number }) => void;
  onDelta?: (data: { text: string }) => void;
  onTool?: (data: { name: string; status: 'start' | 'done'; summary?: string }) => void;
  onCard?: (data: { card: CardPayload }) => void;
  onHandoff?: (data: HandoffState) => void;
  onDone?: (data: {
    firstTokenMs: number;
    matched: boolean;
    confidence: number;
    planner?: string;
    toolCalls?: string[];
    degraded?: boolean;
  }) => void;
  onError?: (data: { code: string; message: string }) => void;
}

/**
 * SSE 流式对话客户端（ADR-003）。
 * 说明：EventSource 只支持 GET，带请求体的流式对话用 fetch + ReadableStream 手工解帧。
 */
export async function streamChat(
  sessionId: string | undefined,
  message: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, channel: 'web' as const }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`chat request failed: HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');

      const parsed = parseSseFrame(frame);
      if (!parsed) continue;
      const { event, data } = parsed as SseEvent;
      switch (event) {
        case 'meta':
          handlers.onMeta?.(data);
          break;
        case 'delta':
          handlers.onDelta?.(data);
          break;
        case 'tool':
          handlers.onTool?.(data as { name: string; status: 'start' | 'done'; summary?: string });
          break;
        case 'card':
          handlers.onCard?.(data);
          break;
        case 'handoff':
          handlers.onHandoff?.(data as HandoffState);
          break;
        case 'done':
          handlers.onDone?.(data);
          break;
        case 'error':
          handlers.onError?.(data);
          break;
      }
    }
  }
}

/* ---------------- 反馈采集（ADR-0009） ---------------- */

export type FeedbackRating = 'up' | 'down';

export interface FeedbackReasonOption {
  value: string;
  label: string;
}

/**
 * 差评原因由后端给，不在前端硬编码：
 * 原因枚举是数据集的聚合维度，两端各写一份迟早漂移，
 * 漂移的结果是前端提交了后端不认识的值——整条反馈白丢。
 */
let optionsCache: Promise<FeedbackReasonOption[]> | null = null;

export function fetchFeedbackOptions(): Promise<FeedbackReasonOption[]> {
  if (!optionsCache) {
    optionsCache = fetch('/api/feedback/options')
      .then((r) => (r.ok ? (r.json() as Promise<{ reasons: FeedbackReasonOption[] }>) : { reasons: [] }))
      .then((d) => d.reasons)
      .catch(() => []);
  }
  return optionsCache;
}

export interface FeedbackInput {
  traceId: string;
  rating: FeedbackRating;
  reasons?: string[];
  comment?: string;
  correctedAnswer?: string;
}

export async function sendFeedback(input: FeedbackInput): Promise<void> {
  const resp = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, channel: 'web' }),
  });
  if (resp.ok) return;

  // 把后端的错误码翻译成人话：404 说明这轮对话没落到库里（多半是网关重启前的老会话），
  // 这种不该让用户看到技术细节，也不该重试。
  const body = (await resp.json().catch(() => ({}))) as { error?: string };
  if (body.error === 'trace_not_found') {
    throw new Error('这轮对话已过期，反馈没有记录下来');
  }
  throw new Error(`提交失败（${resp.status}）`);
}

/* ---------------- 转人工轮询（ADR-0011） ---------------- */

export interface HandoffPollMessage {
  seq: number;
  role: 'agent' | 'system';
  text: string;
  author?: string;
  ts: number;
}

export interface HandoffPollResult {
  handoff: HandoffState | null;
  messages: HandoffPollMessage[];
  seq: number;
}

/**
 * 拉取人工回复。
 *
 * 为什么不复用 SSE 长连接：坐席的回复可能在 30 秒后、也可能在 5 分钟后，
 * 让浏览器为一个不确定的时刻挂一条连接，弱网下必然断，断了就得重连重放。
 * 轮询 1.5s 一次、带 afterSeq 增量拉，断线自愈且实现只有十几行——单商户
 * 的并发量根本不值得为它上 WebSocket。
 */
export async function pollHandoff(
  sessionId: string,
  afterSeq: number,
): Promise<HandoffPollResult> {
  const resp = await fetch(
    `/api/chat/poll?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${afterSeq}`,
  );
  if (!resp.ok) throw new Error(`poll failed: HTTP ${resp.status}`);
  return (await resp.json()) as HandoffPollResult;
}
