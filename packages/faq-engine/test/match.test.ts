import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransferRequest, matchFaq, scoreFaq, tokenize } from '../src/index.js';

test('tokenize 输出中文二元组', () => {
  const tokens = tokenize('发货时间');
  assert.ok(tokens.includes('发货'));
  assert.ok(tokens.includes('货时'));
});

test('tokenize 过滤停用字 bigram', () => {
  const tokens = tokenize('我的订单');
  assert.ok(!tokens.includes('我的'));
});

test('精确问题命中对应 FAQ', () => {
  const result = matchFaq('什么时候发货');
  assert.ok(result);
  assert.equal(result.faq.id, 'faq-shipping-time');
  assert.ok(result.score >= 0.45);
});

test('口语化长问题仍能命中', () => {
  const result = matchFaq('我下单三天了怎么还没发货啊');
  assert.ok(result);
  assert.equal(result.faq.id, 'faq-shipping-time');
});

test('物流问题命中并携带卡片', () => {
  const result = matchFaq('帮我查一下快递到哪了');
  assert.ok(result);
  assert.equal(result.faq.id, 'faq-logistics');
  assert.equal(result.faq.card?.type, 'logistics');
});

test('无关问题低于阈值返回 null', () => {
  assert.equal(matchFaq('今天天气怎么样'), null);
});

test('转人工意图优先于 FAQ', () => {
  assert.equal(isTransferRequest('我要找人工客服'), true);
  assert.equal(isTransferRequest('这件商品我要投诉'), true);
  assert.equal(isTransferRequest('客服工作时间是几点'), false);
});

test('评分在 0-1 之间', () => {
  for (const q of ['退货', '你好', '优惠券怎么用', 'asdf']) {
    const score = scoreFaq(q, { id: 'x', question: '退货政策', answer: '', keywords: ['退货'], category: '售后' });
    assert.ok(score >= 0 && score <= 1, `score out of range for ${q}: ${score}`);
  }
});
