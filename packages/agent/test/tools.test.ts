import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolRegistry } from '../src/tools.js';
import type { Tool } from '../src/types.js';

function makeTool(name: string, risk: 'low' | 'high' = 'low'): Tool {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    risk,
    execute: async () => ({ observation: `${name} ok` }),
  };
}

describe('ToolRegistry', () => {
  it('register / get / specs（specs 不暴露 execute）', () => {
    const reg = new ToolRegistry().register(makeTool('a'), makeTool('b', 'high'));
    assert.equal(reg.get('a')?.name, 'a');
    assert.equal(reg.get('b')?.risk, 'high');
    assert.equal(reg.get('c'), undefined);
    const specs = reg.specs();
    assert.equal(specs.length, 2);
    assert.ok(!('execute' in specs[0]));
  });

  it('重复注册抛错', () => {
    const reg = new ToolRegistry().register(makeTool('a'));
    assert.throws(() => reg.register(makeTool('a')), /重复注册/);
  });

  it('toOpenAiTools 输出 Function Calling 兼容结构', () => {
    const tools = new ToolRegistry().register(makeTool('kb_search')).toOpenAiTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].function.name, 'kb_search');
    assert.equal(tools[0].function.parameters.type, 'object');
  });
});
