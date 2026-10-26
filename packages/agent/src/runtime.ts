import type {
  AgentEvent,
  AgentMemory,
  AgentPlanner,
  PlannerContext,
  PlannerDecision,
  RunMeta,
  ToolContext,
  ToolObservation,
  ToolResult,
} from './types.js';
import type { ToolRegistry } from './tools.js';

export interface AgentRuntimeOptions {
  planner: AgentPlanner;
  /** LLM 失败时的降级规划器（通常是 RulePlanner） */
  fallbackPlanner?: AgentPlanner;
  registry: ToolRegistry;
  memory: AgentMemory;
  /** 单轮最大循环步数（防止工具死循环） */
  maxSteps?: number;
  /** 喂给规划器的历史窗口条数 */
  historyWindow?: number;
  /** 非流式回复的打字机分片大小（字符） */
  streamChunkSize?: number;
  logger?: (msg: string) => void;
}

const CONFIRM_YES = /^(确认|确定|是的?|好(的)?|可以|执行|同意|ok|confirm|yes|y)[\s!！。，,.]*$/i;
const CONFIRM_NO = /^(取消|不了|不用|算了|否|不|cancel|no|n)[\s!！。，,.]*$/i;

/** 极简异步队列：规划器/工具侧 push，消费侧 drain——让 AsyncGenerator 能实时吐事件 */
class EventQueue {
  private q: AgentEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(e: AgentEvent): void {
    if (this.closed) return;
    this.q.push(e);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (this.q.length) {
        yield this.q.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/**
 * AgentRuntime（ADR-0006）：把「规划 → 行动 → 观察 → 再规划」跑成事件流。
 * 宿主（网关）只做两件事：构造时注册 planner/tools/memory，消费 AgentEvent 映射到传输层。
 */
export class AgentRuntime {
  constructor(private opts: AgentRuntimeOptions) {}

  /** 运行一轮对话。幂等安全：任何内部异常都以兜底文案收尾，绝不抛给调用方半截流 */
  run(
    question: string,
    ctx: { sessionId: string; namespace?: string; signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const queue = new EventQueue();
    void this.execute(question, ctx, queue)
      .catch((err) => {
        this.log(`run 异常: ${errMessage(err)}`);
        queue.push({
          type: 'delta',
          text: '抱歉，刚才处理出现了点问题，请稍后重试，或输入「转人工」找人工客服。',
        });
      })
      .finally(() => queue.close());
    return queue.drain();
  }

  private log(msg: string): void {
    this.opts.logger?.(msg);
  }

  private async execute(
    question: string,
    ctx: { sessionId: string; namespace?: string; signal?: AbortSignal },
    queue: EventQueue,
  ): Promise<void> {
    const { sessionId } = ctx;
    const memory = this.opts.memory;
    const maxSteps = this.opts.maxSteps ?? 4;
    const meta: RunMeta = {
      steps: 0,
      toolCalls: [],
      planner: this.opts.planner.name,
      degraded: false,
    };

    /* ---- 护栏④：有待确认的高风险操作时，先裁决确认/取消 ---- */
    const pending = memory.pendingConfirm(sessionId);
    if (pending) {
      if (CONFIRM_YES.test(question.trim())) {
        memory.setPendingConfirm(sessionId, null);
        const tool = this.opts.registry.get(pending.toolName);
        if (!tool) {
          await this.finishText('该操作已失效，请重新描述您的需求。', question, memory, sessionId, meta, queue);
          return;
        }
        queue.push({ type: 'tool', name: tool.name, status: 'start', summary: pending.summary });
        let result: ToolResult;
        try {
          result = await tool.execute(pending.args, this.toolCtx(ctx));
        } catch (err) {
          result = { observation: `工具执行失败：${errMessage(err)}` };
        }
        queue.push({ type: 'tool', name: tool.name, status: 'done' });
        if (result.card) queue.push({ type: 'card', card: result.card });
        meta.steps = 1;
        meta.toolCalls.push(tool.name);
        memory.append(sessionId, { role: 'user', content: question });
        memory.append(sessionId, {
          role: 'assistant',
          content: `已执行 ${tool.name}：${result.observation.slice(0, 160)}`,
        });
        queue.push({ type: 'end', meta });
        return;
      }
      if (CONFIRM_NO.test(question.trim())) {
        memory.setPendingConfirm(sessionId, null);
        await this.finishText('好的，已取消该操作。还有其他可以帮您？', question, memory, sessionId, meta, queue);
        return;
      }
      // 用户没接确认话术 → 过期作废，正常处理新问题
      memory.setPendingConfirm(sessionId, null);
    }

    /* ---- 主循环：规划 → 行动 → 观察 ---- */
    const observations: ToolObservation[] = [];
    let planner = this.opts.planner;

    for (let step = 0; step < maxSteps; step++) {
      meta.steps = step + 1;
      let decision: PlannerDecision;
      try {
        decision = await planner.next(this.plannerCtx(question, ctx, observations, step, queue));
      } catch (err) {
        if (planner === this.opts.planner && this.opts.fallbackPlanner) {
          meta.degraded = true;
          meta.planner = this.opts.fallbackPlanner.name;
          this.log(`规划器降级（${this.opts.planner.name} → ${this.opts.fallbackPlanner.name}）: ${errMessage(err)}`);
          planner = this.opts.fallbackPlanner;
          step -= 1; // 用降级规划器重跑当前步
          continue;
        }
        throw err;
      }

      /* 回复：流结束本轮 */
      if (decision.type === 'reply') {
        let text = decision.text.trim();
        if (!text && observations.length) {
          text = observations[observations.length - 1].text.slice(0, 200);
        }
        if (text && !decision.streamed) {
          await this.typewriter(text, queue);
        }
        if (!text) {
          text = '抱歉，我暂时没有生成有效回答，请换个问法，或输入「转人工」。';
          await this.typewriter(text, queue);
        }
        memory.append(sessionId, { role: 'user', content: question });
        memory.append(sessionId, { role: 'assistant', content: text });
        queue.push({ type: 'end', meta });
        return;
      }

      /* 工具调用 */
      const tool = this.opts.registry.get(decision.toolName);
      if (!tool) {
        const names = this.opts.registry.specs().map((t) => t.name).join(', ') || '无';
        observations.push({
          toolName: decision.toolName,
          text: `工具 ${decision.toolName} 不存在。可用工具：${names}`,
        });
        continue;
      }

      const summary = this.describe(tool.name, decision.args);
      if (tool.risk === 'high') {
        // 护栏④：暂挂 + 确认卡片，绝不静默执行
        memory.setPendingConfirm(sessionId, {
          callId: decision.callId,
          toolName: tool.name,
          args: decision.args,
          summary,
          createdAt: Date.now(),
        });
        queue.push({
          type: 'delta',
          text: `该操作需要您确认后才会执行：\n`,
        });
        queue.push({
          type: 'card',
          card: {
            type: 'confirm',
            title: `确认执行：${tool.name === 'create_ticket' ? '创建工单' : tool.name}`,
            summary,
            actions: [
              { label: '回复「确认」执行', value: '确认' },
              { label: '回复「取消」放弃', value: '取消' },
            ],
          },
        });
        memory.append(sessionId, { role: 'user', content: question });
        memory.append(sessionId, { role: 'assistant', content: `（等待用户确认操作：${summary}）` });
        queue.push({ type: 'end', meta });
        return;
      }

      queue.push({ type: 'tool', name: tool.name, status: 'start', summary });
      let result: ToolResult;
      try {
        result = await tool.execute(decision.args, this.toolCtx(ctx));
      } catch (err) {
        result = { observation: `工具执行失败：${errMessage(err)}` };
      }
      queue.push({ type: 'tool', name: tool.name, status: 'done' });
      if (result.card) queue.push({ type: 'card', card: result.card });
      observations.push({ toolName: tool.name, text: result.observation });
      memory.append(sessionId, {
        role: 'tool',
        content: result.observation.slice(0, 300),
        toolName: tool.name,
      });
      meta.toolCalls.push(tool.name);
      // 继续下一步：规划器基于观察决定最终回复或再调工具
    }

    /* 步数用尽：把最后的观察摘给用户，不再循环 */
    const last = observations[observations.length - 1];
    const text = last?.text.trim() || '抱歉，这个问题我还需要更多信息。您可以补充细节，或输入「转人工」。';
    await this.typewriter(text.slice(0, 220), queue);
    memory.append(sessionId, { role: 'user', content: question });
    memory.append(sessionId, { role: 'assistant', content: text.slice(0, 220) });
    queue.push({ type: 'end', meta });
  }

  private plannerCtx(
    question: string,
    ctx: { sessionId: string; signal?: AbortSignal },
    observations: ToolObservation[],
    step: number,
    queue: EventQueue,
  ): PlannerContext {
    return {
      sessionId: ctx.sessionId,
      question,
      history: this.opts.memory.window(ctx.sessionId, this.opts.historyWindow ?? 12),
      tools: this.opts.registry.specs(),
      observations,
      step,
      onDelta: (text) => queue.push({ type: 'delta', text }),
      signal: ctx.signal,
    };
  }

  private toolCtx(ctx: { sessionId: string; namespace?: string; signal?: AbortSignal }): ToolContext {
    return {
      sessionId: ctx.sessionId,
      namespace: ctx.namespace ?? 'personal',
      signal: ctx.signal,
    };
  }

  private describe(toolName: string, args: Record<string, unknown>): string {
    const brief = Object.entries(args)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${String(v).slice(0, 24)}`)
      .join(' ');
    return `${toolName}(${brief})`;
  }

  /** 非流式回复的打字机效果（RulePlanner / 兜底路径） */
  private async typewriter(text: string, queue: EventQueue): Promise<void> {
    const size = this.opts.streamChunkSize ?? 48;
    for (let i = 0; i < text.length; i += size) {
      queue.push({ type: 'delta', text: text.slice(i, i + size) });
      await delay(15);
    }
  }

  private async finishText(
    text: string,
    question: string,
    memory: AgentMemory,
    sessionId: string,
    meta: RunMeta,
    queue: EventQueue,
  ): Promise<void> {
    await this.typewriter(text, queue);
    memory.append(sessionId, { role: 'user', content: question });
    memory.append(sessionId, { role: 'assistant', content: text });
    queue.push({ type: 'end', meta });
  }
}
