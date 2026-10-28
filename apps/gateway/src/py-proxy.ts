/**
 * Python 智能层透传（ADR-0006 双实现期）：
 * AGENT_BACKEND=py 时，网关不再跑 TS 的 AgentRuntime，而是把请求转到
 * services/agent-py，逐帧原样转发 SSE——不做二次序列化，帧格式两边完全一致。
 *
 * 这样做的价值：同一套浏览器挂件、同一份会话记录，可以在两种实现间对跑评测。
 */

import { parseSseFrame, type CardPayload } from '@cs/protocol';
import type { Response } from 'express';

export interface PythonProxyResult {
  text: string;
  card?: CardPayload;
  planner: string;
  toolCalls: string[];
  degraded: boolean;
  firstTokenMs: number;
  /** 路由分诊维度（ADR-0008）。落盘要用：没有这三个字段，
   *  数据资产里就分不清「谁答的、凭什么分的、用了什么技能」，只看得到一段文本。 */
  agent?: string;
  skill?: string;
  route?: string;
}

export interface PythonProxyInput {
  url: string;
  sessionId: string;
  message: string;
  channel: string;
  traceId: string;
  res: Response;
  t0: number;
  /** 运行时覆盖（后台热改，无需重启）。见 AdminConfigStore.runtimeOverrides。 */
  persona?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 把 Python 服务的 SSE 帧逐帧转发给浏览器，同时旁路累计文本用于会话落库。
 *
 * 约定：只有"连不上/握手失败"才抛异常（此时还没写出任何帧，调用方可安全降级到本地实现）；
 * 流中途出错则内部消化为 error 帧，不抛。
 */
export async function proxyToPython(input: PythonProxyInput): Promise<PythonProxyResult> {
  const { url, sessionId, message, channel, traceId, res, t0, persona, model, temperature, maxTokens } =
    input;

  const upstream = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message,
      channel,
      traceId,
      persona,
      model,
      temperature,
      maxTokens,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error(`python agent ${upstream.status} ${upstream.statusText}`);
  }

  const result: PythonProxyResult = {
    text: '',
    planner: 'python',
    toolCalls: [],
    degraded: false,
    firstTokenMs: 0,
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        // 原样转发：字节级保留 Python 侧的输出
        res.write(`${frame}\n\n`);
        collect(frame, result, t0);
        cut = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    // 流中途断开：已转发的帧无法撤回，补一条 error 帧让前端体面收尾
    console.warn(`[gateway] python 流中断: ${(err as Error).message}`);
    res.write(
      `event: error\ndata: ${JSON.stringify({
        code: 'python_stream_broken',
        message: (err as Error).message,
      })}\n\n`,
    );
  } finally {
    reader.releaseLock?.();
  }

  return result;
}

function collect(frame: string, result: PythonProxyResult, t0: number): void {
  const parsed = parseSseFrame(frame);
  if (!parsed) return;

  if (parsed.event === 'delta') {
    const text = String((parsed.data as { text?: string }).text ?? '');
    if (!result.firstTokenMs) result.firstTokenMs = Date.now() - t0;
    result.text += text;
    return;
  }
  if (parsed.event === 'card') {
    result.card = (parsed.data as { card: CardPayload }).card;
    return;
  }
  if (parsed.event === 'done') {
    const data = parsed.data as {
      planner?: string;
      toolCalls?: string[];
      degraded?: boolean;
      agent?: string;
      skill?: string;
      route?: string;
    };
    result.planner = data.planner ?? 'python';
    result.toolCalls = data.toolCalls ?? [];
    result.degraded = Boolean(data.degraded);
    result.agent = data.agent;
    result.skill = data.skill;
    result.route = data.route;
  }
}

/**
 * 无响应流的「要完整答案」版：调 Python 智能层，把 delta 累积成一段完整文本。
 * 供公众号异步客服消息、后台试答等「不需要逐字下发」的场景复用。
 * 连不上 / 流中断都返回空串（调用方自行决定兜底），不抛异常。
 */
export async function askPython(
  message: string,
  sessionId: string,
  channel: string,
  overrides: { persona?: string; model?: string; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const url = (process.env.AGENT_PY_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
  try {
    const upstream = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message, channel, ...overrides }),
    });
    if (!upstream.ok || !upstream.body) return '';

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const parsed = parseSseFrame(frame);
        if (parsed?.event === 'delta') {
          text += String((parsed.data as { text?: string }).text ?? '');
        }
        cut = buffer.indexOf('\n\n');
      }
    }
    return text.trim();
  } catch (err) {
    console.warn(`[gateway] askPython 失败: ${(err as Error).message}`);
    return '';
  }
}
