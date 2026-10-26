import type { Tool, ToolSpec } from './types.js';

/** 行动层注册表：register 一次，规划器自动看到（扩展缝 ②） */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(...tools: Tool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) {
        throw new Error(`[agent] 工具重复注册: ${t.name}`);
      }
      this.tools.set(t.name, t);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map(({ execute: _execute, ...spec }) => spec);
  }

  /** OpenAI Function Calling 格式：Qwen / DeepSeek / GLM / new-api 均兼容 */
  toOpenAiTools() {
    return this.specs().map((s) => ({
      type: 'function' as const,
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters,
      },
    }));
  }
}
