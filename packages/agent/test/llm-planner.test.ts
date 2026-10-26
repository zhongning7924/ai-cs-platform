import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmPlanner } from '../src/planner-llm.js';
import type { PlannerContext } from '../src/types.js';

/** 构造伪 SSE 响应（模拟 OpenAI 兼容端点的流式输出） */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function baseCtx(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    sessionId: 's1',
    question: '查一下订单',
    history: [],
    tools: [],
    observations: [],
    step: 0,
    ...overrides,
  };
}

describe('LlmPlanner（伪 SSE 流）', () => {
  it('content 增量实时转发，最终聚合为 reply(streamed)', async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"您"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const planner = new LlmPlanner({
      baseUrl: 'https://fake/v1',
      apiKey: 'k',
      model: 'test',
      fetchImpl,
    });
    const decision = await planner.next(baseCtx({ onDelta: (t) => deltas.push(t) }));

    assert.deepEqual(deltas, ['您', '好']);
    assert.equal(decision.type, 'reply');
    if (decision.type === 'reply') {
      assert.equal(decision.text, '您好');
      assert.equal(decision.streamed, true);
    }
  });

  it('tool_calls 增量聚合为一次 tool_call 决策，JSON 参数容错', async () => {
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a1","function":{"name":"kb_sea"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"rch","arguments":"{\\"query\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"退货\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const planner = new LlmPlanner({
      baseUrl: 'https://fake/v1',
      apiKey: 'k',
      model: 'test',
      fetchImpl,
    });
    const decision = await planner.next(baseCtx());

    assert.equal(decision.type, 'tool_call');
    if (decision.type === 'tool_call') {
      assert.equal(decision.toolName, 'kb_search');
      assert.deepEqual(decision.args, { query: '退货' });
    }
  });

  it('泄漏标记清洗：</tool_call> 与开头噪声不出现在下发流里', async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"}\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"</tool_call>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"周五不能发布。"}}]}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const planner = new LlmPlanner({
      baseUrl: 'https://fake/v1',
      apiKey: 'k',
      model: 'test',
      fetchImpl,
    });
    const decision = await planner.next(baseCtx({ onDelta: (t) => deltas.push(t) }));

    const streamed = deltas.join('');
    assert.equal(streamed, '周五不能发布。');
    assert.equal(decision.type, 'reply');
    if (decision.type === 'reply') assert.equal(decision.text, '周五不能发布。');
  });

  it('HTTP 非 2xx 抛错（触发 Runtime 降级链）', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"rate limited"}', { status: 429 })) as unknown as typeof fetch;
    const planner = new LlmPlanner({
      baseUrl: 'https://fake/v1',
      apiKey: 'k',
      model: 'test',
      fetchImpl,
    });
    await assert.rejects(planner.next(baseCtx()), /429/);
  });
});
