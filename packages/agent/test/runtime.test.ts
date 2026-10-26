import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { InMemoryMemory } from '../src/memory.js';
import { ToolRegistry } from '../src/tools.js';
import type { AgentEvent, AgentPlanner, PlannerContext, PlannerDecision, Tool } from '../src/types.js';

/** 假规划器：按脚本逐步吐决策 */
function scriptedPlanner(script: (ctx: PlannerContext) => PlannerDecision): AgentPlanner {
  return { name: 'scripted', next: (ctx) => script(ctx) };
}

function makeEchoTool(): Tool {
  return {
    name: 'echo',
    description: '回声工具',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    risk: 'low',
    execute: async (args) => ({ observation: `观察: ${String(args.query)}` }),
  };
}

function makeRiskyTool(): Tool {
  return {
    name: 'create_ticket',
    description: '建工单（高风险）',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    risk: 'high',
    execute: async (args) => ({
      observation: `工单已创建：${String(args.title)}`,
      card: { type: 'ticket', title: `工单 ${String(args.title)}` },
    }),
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('AgentRuntime', () => {
  it('工具循环：tool_call → 观察 → reply，事件顺序正确', async () => {
    const planner = scriptedPlanner((ctx) => {
      if (ctx.step === 0) {
        return { type: 'tool_call', callId: 'c1', toolName: 'echo', args: { query: '你好' } };
      }
      // 第 1 步应看到观察结果
      assert.equal(ctx.observations.length, 1);
      assert.equal(ctx.observations[0].text, '观察: 你好');
      return { type: 'reply', text: '已收到你的问候' };
    });
    const memory = new InMemoryMemory();
    const rt = new AgentRuntime({
      planner,
      registry: new ToolRegistry().register(makeEchoTool()),
      memory,
      maxSteps: 4,
      streamChunkSize: 1000,
    });

    const events = await collect(rt.run('你好', { sessionId: 's1' }));
    const types = events.map((e) => e.type);
    // reply 未标记 streamed → runtime 打字机补 delta
    assert.deepEqual(types, ['tool', 'tool', 'delta', 'end']);
    assert.ok(events[0].type === 'tool' && events[0].status === 'start');
    assert.ok(events[1].type === 'tool' && events[1].status === 'done');

    // 记忆里应有 user + assistant 两条
    const turns = memory.window('s1', 10);
    assert.equal(turns.filter((t) => t.role === 'user').length, 1);
    assert.equal(turns.filter((t) => t.role === 'assistant').length, 1);
    assert.equal(turns.filter((t) => t.role === 'tool').length, 1);
  });

  it('护栏：高风险工具先确认；「确认」后执行，卡片下发', async () => {
    const planner = scriptedPlanner(() => ({
      type: 'tool_call',
      callId: 'c9',
      toolName: 'create_ticket',
      args: { title: '沙发异味' },
    }));
    const memory = new InMemoryMemory();
    const rt = new AgentRuntime({
      planner,
      registry: new ToolRegistry().register(makeRiskyTool()),
      memory,
      streamChunkSize: 1000,
    });

    // 第一轮：只确认，不执行
    const first = await collect(rt.run('帮我建工单', { sessionId: 's2' }));
    const firstCards = first.filter((e): e is Extract<AgentEvent, { type: 'card' }> => e.type === 'card');
    assert.ok(firstCards.some((e) => e.card.type === 'confirm'), '应有确认卡片');
    assert.ok(memory.pendingConfirm('s2'), '应存在待确认操作');
    // 没有任何 ticket 卡片（未执行）
    assert.ok(!firstCards.some((e) => e.card.type === 'ticket'));

    // 第二轮：用户「确认」→ 执行
    const second = await collect(rt.run('确认', { sessionId: 's2' }));
    const ticketCard = second.find(
      (e): e is Extract<AgentEvent, { type: 'card' }> => e.type === 'card' && e.card.type === 'ticket',
    );
    assert.ok(ticketCard, '确认后应下发 ticket 卡片');
    assert.equal(memory.pendingConfirm('s2'), null, '确认后应清除暂挂');
  });

  it('护栏：「取消」不执行并清除暂挂', async () => {
    const planner = scriptedPlanner(() => ({
      type: 'tool_call',
      callId: 'c9',
      toolName: 'create_ticket',
      args: { title: 'x' },
    }));
    const memory = new InMemoryMemory();
    const rt = new AgentRuntime({
      planner,
      registry: new ToolRegistry().register(makeRiskyTool()),
      memory,
      streamChunkSize: 1000,
    });
    await collect(rt.run('建工单', { sessionId: 's3' }));
    const second = await collect(rt.run('取消', { sessionId: 's3' }));
    assert.ok(!second.some((e) => e.type === 'card'));
    assert.equal(memory.pendingConfirm('s3'), null);
  });

  it('不存在的工具：观察报错后规划器仍可收尾', async () => {
    const planner = scriptedPlanner((ctx) => {
      if (ctx.step === 0) return { type: 'tool_call', callId: 'cx', toolName: 'ghost', args: {} };
      assert.match(ctx.observations[0].text, /不存在/);
      return { type: 'reply', text: '抱歉没有这个能力' };
    });
    const rt = new AgentRuntime({
      planner,
      registry: new ToolRegistry().register(makeEchoTool()),
      memory: new InMemoryMemory(),
      streamChunkSize: 1000,
    });
    const events = await collect(rt.run('试试', { sessionId: 's4' }));
    assert.equal(events[events.length - 1].type, 'end');
  });

  it('LLM 失败降级到 fallback 规划器', async () => {
    const badPlanner: AgentPlanner = {
      name: 'llm',
      next: () => {
        throw new Error('模拟 LLM 宕机');
      },
    };
    const fallback = scriptedPlanner(() => ({ type: 'reply', text: '规则兜底回复' }));
    const rt = new AgentRuntime({
      planner: badPlanner,
      fallbackPlanner: fallback,
      registry: new ToolRegistry(),
      memory: new InMemoryMemory(),
      streamChunkSize: 1000,
    });
    const events = await collect(rt.run('在吗', { sessionId: 's5' }));
    const end = events.find((e): e is Extract<AgentEvent, { type: 'end' }> => e.type === 'end');
    assert.ok(end);
    assert.equal(end.meta.degraded, true);
    assert.equal(end.meta.planner, 'scripted');
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    assert.equal(text, '规则兜底回复');
  });

  it('步数上限：规划器一直要工具也不会死循环', async () => {
    const planner = scriptedPlanner(() => ({
      type: 'tool_call',
      callId: 'cx',
      toolName: 'echo',
      args: { query: 'x' },
    }));
    const rt = new AgentRuntime({
      planner,
      registry: new ToolRegistry().register(makeEchoTool()),
      memory: new InMemoryMemory(),
      maxSteps: 3,
      streamChunkSize: 1000,
    });
    const events = await collect(rt.run('循环', { sessionId: 's6' }));
    const end = events.find((e): e is Extract<AgentEvent, { type: 'end' }> => e.type === 'end');
    assert.ok(end);
    assert.equal(end.meta.steps, 3);
  });
});
