import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { extractFacts, toSample, toSamples } from '../src/data/dataset.js';
import { redact } from '../src/data/redact.js';
import { createTraceStore, type TraceStore } from '../src/data/store.js';

const dirs: string[] = [];

function tempStore(): TraceStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-fb-'));
  dirs.push(dir);
  return createTraceStore(dir);
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('redact', () => {
  it('手机号保留前 3 后 4，中间打码', () => {
    assert.equal(redact('我的手机 13812345678'), '我的手机 138****5678');
  });

  it('身份证 18 位只留地区码和校验位', () => {
    assert.equal(redact('身份证 110101199003078888'), '身份证 110101********8888');
  });

  it('邮箱只留域名', () => {
    assert.equal(redact('发到 zhangsan@example.com'), '发到 ***@example.com');
  });

  it('业务单号必须保留——它是回放查证的主键', () => {
    const text = '订单 CS1002 显示运输中';
    assert.equal(redact(text), text);
  });

  it('幂等：重复脱敏不会二次破坏', () => {
    const once = redact('13812345678');
    assert.equal(redact(once), once);
  });

  it('身份证不会被手机号规则切碎', () => {
    // 110101 1990030 78888：如果先跑手机号规则，中间会被打成 199****8888
    assert.equal(redact('110101199003078888'), '110101********8888');
  });
});

describe('TraceStore', () => {
  it('写入后可读回，文本完成脱敏', () => {
    const store = tempStore();
    store.appendTurn({
      traceId: 'trace_1',
      sessionId: 'sess_1',
      channel: 'web',
      question: '我手机 13812345678，订单 CS1002 到哪了',
      answer: '在运输中，预计 3 天到',
      planner: 'router',
      agent: 'aftersale',
      toolCalls: ['query_order'],
      degraded: false,
      firstTokenMs: 420,
      totalMs: 2100,
    });

    const view = store.find('trace_1');
    assert.ok(view);
    assert.match(view.turn.question, /138\*\*\*\*5678/);
    assert.match(view.turn.question, /CS1002/);
    assert.equal(view.turn.agent, 'aftersale');
    assert.equal(view.feedbackCount, 0);
  });

  it('评价是追加的：后写覆盖先写，次数累加', () => {
    const store = tempStore();
    store.appendTurn({
      traceId: 'trace_2',
      sessionId: 'sess_1',
      channel: 'web',
      question: '沙发有异味',
      answer: '建议通风',
      planner: 'router',
      toolCalls: [],
      degraded: false,
      firstTokenMs: 300,
      totalMs: 1500,
    });

    store.appendFeedback({ traceId: 'trace_2', rating: 'down', reasons: ['too_vague'] });
    store.appendFeedback({ traceId: 'trace_2', rating: 'up', reasons: [] });

    const view = store.find('trace_2');
    assert.ok(view);
    assert.equal(view.feedback?.rating, 'up');
    assert.equal(view.feedbackCount, 2, '改主意这件事本身要能看到');
  });

  it('坏行不影响其余数据读取', () => {
    const store = tempStore();
    store.appendTurn({
      traceId: 'trace_3',
      sessionId: 'sess_1',
      channel: 'web',
      question: '你好',
      answer: '您好',
      planner: 'rule',
      toolCalls: [],
      degraded: false,
      firstTokenMs: 10,
      totalMs: 20,
    });
    appendFileSync(store.filePath, '{"kind":"turn","traceId":"trace_broken"\n', 'utf8');

    assert.equal(store.all().length, 1);
  });

  it('孤立的评价（找不到对应对话）被忽略，不污染统计', () => {
    const store = tempStore();
    store.appendFeedback({ traceId: 'trace_ghost', rating: 'down', reasons: ['slow'] });
    assert.equal(store.stats().down, 0);
  });

  it('好评率分母是「有过反馈的轮次」，沉默用户不算满意', () => {
    const store = tempStore();
    for (let i = 0; i < 3; i += 1) {
      store.appendTurn({
        traceId: `trace_${i}`,
        sessionId: 'sess_1',
        channel: 'web',
        question: `问题 ${i}`,
        answer: `回答 ${i}`,
        planner: 'router',
        agent: i === 0 ? 'presale' : 'aftersale',
        toolCalls: [],
        degraded: false,
        firstTokenMs: 100,
        totalMs: 200,
      });
    }
    store.appendFeedback({ traceId: 'trace_0', rating: 'up', reasons: [] });
    store.appendFeedback({
      traceId: 'trace_1',
      rating: 'down',
      reasons: ['wrong_fact', 'missing_tool'],
    });

    const stats = store.stats();
    assert.equal(stats.turns, 3);
    assert.equal(stats.rated, 2);
    assert.equal(stats.satisfaction, 0.5);
    assert.equal(stats.byAgent.length, 2);
    assert.equal(stats.reasons[0].reason, 'wrong_fact');
  });
});

describe('dataset', () => {
  function seed(store: TraceStore, traceId: string, answer: string, toolCalls: string[] = []) {
    store.appendTurn({
      traceId,
      sessionId: 'sess_1',
      channel: 'web',
      question: '三人位多少钱',
      answer,
      planner: 'router',
      agent: 'presale',
      toolCalls,
      degraded: false,
      firstTokenMs: 300,
      totalMs: 1200,
    });
  }

  it('抽取事实只认机器不会看错的实体', () => {
    assert.deepEqual(extractFacts('三人位 2999 元，5 天发货，单号 CS1002'), [
      'CS1002',
      '2999 元',
      '5 天',
    ]);
    // 业务状态词不猜：猜错一次整套指标就没人信了
    assert.deepEqual(extractFacts('已经签收，请在 3 天内申请售后'), ['3 天']);
  });

  it('👎 + 正确答案 = 权重 1 的人工标注样本', () => {
    const store = tempStore();
    seed(store, 'trace_a', '大概两千多');
    store.appendFeedback({
      traceId: 'trace_a',
      rating: 'down',
      reasons: ['wrong_fact'],
      correctedAnswer: '三人位 2999 元',
    });

    const view = store.find('trace_a');
    assert.ok(view);
    const sample = toSample(view);
    assert.equal(sample.label, 'human_corrected');
    assert.equal(sample.weight, 1);
    assert.deepEqual(sample.must_contain, ['2999 元']);
    // 差评不推导期望工具：这次调用有问题，拿它当答案是反着学
    assert.equal(sample.expect_tool, undefined);
  });

  it('👍 只算半信样本，但可以推出期望工具', () => {
    const store = tempStore();
    seed(store, 'trace_b', '三人位 2999 元', ['kb_search']);
    store.appendFeedback({ traceId: 'trace_b', rating: 'up', reasons: [] });

    const view = store.find('trace_b');
    assert.ok(view);
    const sample = toSample(view);
    assert.equal(sample.label, 'bot_accepted');
    assert.equal(sample.weight, 0.5);
    assert.equal(sample.expect_tool, 'kb_search');
  });

  it('未标注样本默认不导出——拿模型自己的答案考模型是自欺欺人', () => {
    const store = tempStore();
    seed(store, 'trace_c', '三人位 2999 元');

    assert.equal(toSamples(store.all()).length, 0);
    assert.equal(toSamples(store.all(), { includeUnlabeled: true }).length, 1);
  });
});
