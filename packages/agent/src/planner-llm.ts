import type { AgentPlanner, PlannerContext, PlannerDecision, ToolSpec } from './types.js';

export interface LlmPlannerOptions {
  /** OpenAI 兼容端点，如 https://api.siliconflow.cn/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_AGENT_SYSTEM_PROMPT = `你是企业智能客服坐席。用简体中文回答，口语化、简洁、分点。
工具选择规则（严格执行）：
1. 知识类问题——政策、流程、规范、内部资料、"能不能/怎么/是否可以"类问题 → 必须先调 kb_search（query 传精炼后的问题）；禁止调 query_order；
2. 仅当用户明确要求查询订单、给出订单号或问物流时 → 调 query_order（orderId 传订单号，如 CS1001）；禁止把普通问题当订单号；
3. 用户明确要求投诉、人工处理、创建工单、报修、反馈问题待解决 → 必须调 create_ticket（title 概括诉求，detail 补充细节）；
4. 打招呼、闲聊等无需事实依据的问题 → 不调任何工具，直接回答。
示例（严格模仿）：
- 用户"我要建个售后工单，沙发有异味" → 调 create_ticket(title="售后工单：沙发有异味")
- 用户"CS1002 到哪了" → 调 query_order(orderId="CS1002")
- 用户"周五能发布吗" → 调 kb_search(query="周五发布窗口")
- 用户"你好" → 直接回复问候，不调工具
回答规则：
5. 工具返回的观察结果是唯一事实来源：回答必须与观察一致；观察为空或未找到时，如实告知并建议换问法或转人工，禁止编造；
6. 最终回答控制在 150 字以内，必要时分点。`;

interface OpenAiDelta {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * 流式清洗器：小参数模型在 tools 模式下常泄漏内部标记（</tool_call>、<|im_end|> 等）。
 * 策略：累积原始输出 → 剔除标记 → 只增量下发"清洗投影"，已发部分不回退。
 * 仅作用于 content 流，不影响 tool_calls 聚合。
 */
class StreamCleaner {
  private raw = '';
  private sent = 0;

  private static clean(raw: string): string {
    return raw
      .replace(/<\/?tool_call>/g, '')
      .replace(/<\|[a-z_]*\|>/g, '')
      .replace(/^\s*\}\s*/, '');
  }

  push(chunk: string, onDelta?: (t: string) => void): void {
    this.raw += chunk;
    const clean = StreamCleaner.clean(this.raw);
    if (clean.length > this.sent) {
      onDelta?.(clean.slice(this.sent));
      this.sent = clean.length;
    }
  }

  text(): string {
    return StreamCleaner.clean(this.raw).trim();
  }
}

/**
 * LLM 规划器：一步 = 一次 OpenAI 兼容 chat/completions（流式）。
 * content 增量实时转发 onDelta；tool_calls 增量聚合成一次决策。
 * 观察（observations）以 user 消息回灌——兼容所有 OpenAI 系端点，不依赖严格 tool 消息配对。
 */
export class LlmPlanner implements AgentPlanner {
  readonly name = 'llm';

  constructor(private opts: LlmPlannerOptions) {}

  async next(ctx: PlannerContext): Promise<PlannerDecision> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: this.buildMessages(ctx),
      stream: true,
      max_tokens: this.opts.maxTokens ?? 512,
      temperature: this.opts.temperature ?? 0.3,
    };
    if (ctx.tools.length) {
      body.tools = toOpenAiTools(ctx.tools);
      body.tool_choice = 'auto';
    }

    const res = await doFetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
    }

    let content = '';
    let toolName = '';
    let toolArgs = '';
    const cleaner = new StreamCleaner();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json: { choices?: Array<{ delta?: OpenAiDelta }> };
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          cleaner.push(delta.content, ctx.onDelta);
        }
        const tc = delta.tool_calls?.[0];
        if (tc?.function?.name) toolName += tc.function.name;
        if (tc?.function?.arguments) toolArgs += tc.function.arguments;
      }
    }

    if (toolName) {
      let args: Record<string, unknown> = {};
      if (toolArgs) {
        try {
          args = JSON.parse(toolArgs) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
      return { type: 'tool_call', callId, toolName, args };
    }

    const finalText = cleaner.text();
    return { type: 'reply', text: finalText, streamed: finalText.length > 0 };
  }

  private buildMessages(ctx: PlannerContext): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: this.opts.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT },
    ];
    for (const turn of ctx.history) {
      if (turn.role === 'tool' || turn.role === 'system') continue;
      messages.push({ role: turn.role, content: turn.content });
    }
    if (ctx.observations.length) {
      const obs = ctx.observations
        .map((o) => `[工具 ${o.toolName} 观察结果]\n${o.text}`)
        .join('\n---\n');
      messages.push({
        role: 'user',
        content: `（系统提示：以下是本轮工具观察结果，是唯一事实来源，请基于其回答，不得编造）\n${obs}`,
      });
    }
    messages.push({ role: 'user', content: ctx.question });
    return messages;
  }
}

/** ToolSpec[] → OpenAI tools（供注册表与规划器复用） */
export function toOpenAiTools(specs: ToolSpec[]) {
  return specs.map((s) => ({
    type: 'function' as const,
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}
