import { parseSseFrame, type CardPayload, type SseEvent } from '@cs/protocol';

export interface StreamHandlers {
  onMeta?: (data: { sessionId: string; traceId: string; ts: number }) => void;
  onDelta?: (data: { text: string }) => void;
  onTool?: (data: { name: string; status: 'start' | 'done'; summary?: string }) => void;
  onCard?: (data: { card: CardPayload }) => void;
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
