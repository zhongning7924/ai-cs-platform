import type { AgentPlanner, PlannerContext, PlannerDecision } from './types.js';

export interface RulePlannerOptions {
  /** 无工具可用时的最终回复（通常传 faq-engine 的 FALLBACK_ANSWER） */
  fallbackText: string;
}

/**
 * 规则规划器（扩展缝 ① 的降级实现）：
 * - 第 0 步：有低风险工具就调用第一个（网关注册顺序决定：kb_search 优先）；
 * - 第 1 步：把观察摘录作答（抽取式，不生成）。
 * 没有任何魔法，也永远不会失败——这是"没配 LLM 系统照常跑"的保证。
 */
export class RulePlanner implements AgentPlanner {
  readonly name = 'rule';

  constructor(private opts: RulePlannerOptions) {}

  next(ctx: PlannerContext): PlannerDecision {
    if (ctx.step === 0) {
      const tool = ctx.tools.find((t) => t.risk === 'low');
      if (tool) {
        const callId = `rule_${Math.random().toString(36).slice(2, 8)}`;
        return {
          type: 'tool_call',
          callId,
          toolName: tool.name,
          args: { query: ctx.question },
        };
      }
      return { type: 'reply', text: this.opts.fallbackText };
    }
    const last = ctx.observations[ctx.observations.length - 1];
    return { type: 'reply', text: last?.text.trim() || this.opts.fallbackText };
  }
}
