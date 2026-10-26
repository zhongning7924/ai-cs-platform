import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { detectImmediate, looksUnresolved } from '../src/handoff/detect.js';
import { HandoffStore } from '../src/handoff/store.js';
import { mountHandoffRoutes } from '../src/handoff/routes.js';
import { adminGuard } from '../src/guard.js';

const TOKEN = 'test-admin-token';

function tempStore(): { store: HandoffStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-handoff-'));
  return { store: new HandoffStore(dir), dir };
}

async function withServer<T>(
  store: HandoffStore,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  mountHandoffRoutes(app, store, adminGuard(TOKEN));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/* ---------------- 触发判定 ---------------- */

test('detectImmediate：用户要求转人工', () => {
  assert.equal(detectImmediate('转人工'), 'user_request');
  assert.equal(detectImmediate('给我找个人'), 'user_request');
  assert.equal(detectImmediate('我要投诉'), 'user_request');
});

test('detectImmediate：用户没说"转人工"但已经在施压', () => {
  assert.equal(detectImmediate('再不解决我就打12315'), 'sensitive');
  assert.equal(detectImmediate('我要起诉你们'), 'sensitive');
  assert.equal(detectImmediate('这是欺诈'), 'sensitive');
});

test('detectImmediate：同时命中时按升级场景归类，不落成普通转接', () => {
  // 「投诉」会命中转人工正则，「12315」命中敏感正则——后者才是真正要看的人
  assert.equal(detectImmediate('再不解决我就去打12315投诉你们'), 'sensitive');
});

test('detectImmediate：普通问题不该转人工', () => {
  assert.equal(detectImmediate('三人位多少钱'), null);
  assert.equal(detectImmediate('CS1002 到哪了'), null);
  assert.equal(detectImmediate('你好'), null);
});

test('looksUnresolved：降级与兜底话术判为没解决', () => {
  assert.equal(looksUnresolved('随便什么', true), true);
  assert.equal(looksUnresolved('这个问题我还需要确认一下', false), true);
  assert.equal(looksUnresolved('暂无相关资料', false), true);
  assert.equal(looksUnresolved('', false), true);
});

test('looksUnresolved：正常带事实的回答不转', () => {
  assert.equal(looksUnresolved('云朵沙发三人位 2999 元，现货', false), false);
  assert.equal(looksUnresolved('订单 CS1002 已发货，预计明天到达', false), false);
});

/* ---------------- 状态机 ---------------- */

test('store：建单后进入排队，位次按先来后到', () => {
  const { store } = tempStore();
  const a = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });
  const b = store.create({ sessionId: 's2', channel: 'web', reason: 'sensitive', triggerText: '我要起诉', context: [] });

  assert.equal(a.status, 'queued');
  assert.equal(store.position(a.id), 1);
  assert.equal(store.position(b.id), 2);
  assert.deepEqual(store.queue().map((t) => t.id), [a.id, b.id]);
});

test('store：接入后离开队列，重复接入失败', () => {
  const { store } = tempStore();
  const t = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });

  const claimed = store.claim(t.id, '小美');
  assert.equal(claimed?.status, 'active');
  assert.equal(claimed?.agentName, '小美');
  assert.equal(store.position(t.id), 0);
  assert.equal(store.queue().length, 0);
  assert.equal(store.active().length, 1);

  // 第二个坐席抢同一单：必须失败，否则两个客服会同时说话
  assert.equal(store.claim(t.id, '小刚'), null);
});

test('store：未接入不能回复；接入后双向消息都有序号', () => {
  const { store } = tempStore();
  const t = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });

  assert.equal(store.addAgentMessage(t.id, '您好'), null);

  store.claim(t.id, '小美');
  const user = store.addUserMessage(t.id, '我的订单还没到');
  const agent = store.addAgentMessage(t.id, '我查一下，稍等');

  // seq 1 是 claim 写入的「小美 已接入」系统消息
  assert.equal(user?.seq, 2);
  assert.equal(agent?.seq, 3);
  assert.equal(agent?.role, 'agent');
  assert.equal(agent?.author, '小美');
});

test('store：关闭后会话回到 AI（openBySession 不再命中）', () => {
  const { store } = tempStore();
  const t = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });
  store.claim(t.id, '小美');

  assert.equal(store.openBySession('s1')?.id, t.id);

  const closed = store.close(t.id, 'resolved');
  assert.equal(closed?.status, 'closed');
  assert.equal(closed?.resolution, 'resolved');
  assert.equal(store.openBySession('s1'), null);
});

test('store：用户端只拉到坐席与系统消息，不回传用户自己的话', () => {
  const { store } = tempStore();
  const t = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });
  store.claim(t.id, '小美');
  store.addUserMessage(t.id, '我要退货');
  store.addAgentMessage(t.id, '可以，我帮你发起');

  const msgs = store.agentMessagesSince(t.id, 0);
  assert.equal(msgs.every((m) => m.role !== 'user'), true);
  assert.deepEqual(msgs.map((m) => m.text).slice(-1), ['可以，我帮你发起']);
});

test('store：重启后重放恢复排队与接待状态', () => {
  const { store, dir } = tempStore();
  const a = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });
  const b = store.create({ sessionId: 's2', channel: 'web', reason: 'sensitive', triggerText: '起诉', context: [] });
  store.claim(b.id, '小美');
  store.addAgentMessage(b.id, '我在');

  const reopened = new HandoffStore(dir);
  assert.equal(reopened.queue().map((t) => t.id).includes(a.id), true);
  assert.equal(reopened.get(b.id)?.status, 'active');
  assert.equal(reopened.get(b.id)?.agentName, '小美');
  assert.equal(reopened.get(b.id)?.messages.at(-1)?.text, '我在');
});

test('store：落盘前脱敏，手机号不留原值', () => {
  const { store, dir } = tempStore();
  const t = store.create({
    sessionId: 's1',
    channel: 'web',
    reason: 'user_request',
    triggerText: '我手机 13800138000 你们怎么还没人管',
    context: [],
  });
  store.claim(t.id, '小美');
  store.addUserMessage(t.id, '再打一遍 13800138000');

  const raw = readFileSync(path.join(dir, 'handoff.jsonl'), 'utf8');
  assert.equal(raw.includes('13800138000'), false);
});

/* ---------------- HTTP 闭环 ---------------- */

test('HTTP：未带 token 访问队列 401', async () => {
  const { store } = tempStore();
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/handoff/queue`);
    assert.equal(res.status, 401);
  });
});

test('HTTP：先接入才能回复，未接入 409', async () => {
  const { store } = tempStore();
  const t = store.create({ sessionId: 's1', channel: 'web', reason: 'user_request', triggerText: '转人工', context: [] });

  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/handoff/${t.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ text: '在的' }),
    });
    assert.equal(res.status, 409);
  });
});

test('HTTP：完整闭环 排队→接入→回复→用户拉到→关闭→回 AI', async () => {
  const { store } = tempStore();
  const t = store.create({
    sessionId: 'sess_demo',
    channel: 'web',
    reason: 'user_request',
    triggerText: '转人工',
    context: [{ question: '沙发多少钱', answer: '2999', ts: Date.now() }],
  });
  store.addUserMessage(t.id, '我要问退货');

  await withServer(store, async (base) => {
    const auth = { 'content-type': 'application/json', 'x-admin-token': TOKEN };

    // 1. 队列里能看到，且带转接上下文
    const q = await (await fetch(`${base}/api/handoff/queue`, { headers: auth })).json();
    assert.equal(q.count, 1);
    assert.equal(q.items[0].reasonLabel, '用户主动要求');
    assert.equal(q.items[0].preview, '我要问退货');

    // 2. 用户侧排队位次是真实的
    const poll1 = await (await fetch(`${base}/api/chat/poll?sessionId=sess_demo&afterSeq=0`)).json();
    assert.equal(poll1.handoff.status, 'queued');
    assert.equal(poll1.handoff.position, 1);

    // 3. 坐席接入
    const claim = await fetch(`${base}/api/handoff/${t.id}/claim`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentName: '小美' }),
    });
    assert.equal(claim.status, 200);

    // 4. 回复
    const reply = await fetch(`${base}/api/handoff/${t.id}/reply`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '可以退，我帮您发起' }),
    });
    assert.equal(reply.status, 200);

    // 5. 用户端增量拉到人工消息
    const poll2 = await (await fetch(`${base}/api/chat/poll?sessionId=sess_demo&afterSeq=0`)).json();
    assert.equal(poll2.handoff.status, 'active');
    assert.equal(poll2.handoff.agentName, '小美');
    const texts = poll2.messages.map((m: { text: string }) => m.text);
    assert.equal(texts.includes('可以退，我帮您发起'), true);

    // 6. 关闭 → 用户端 handoff 变 null，前端据此回到 AI
    const closed = await fetch(`${base}/api/handoff/${t.id}/close`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ resolution: 'resolved' }),
    });
    assert.equal(closed.status, 200);

    const poll3 = await (await fetch(`${base}/api/chat/poll?sessionId=sess_demo&afterSeq=0`)).json();
    assert.equal(poll3.handoff, null);
  });
});

test('HTTP：详情接口返回交接上下文，坐席三秒能看懂前情', async () => {
  const { store } = tempStore();
  const t = store.create({
    sessionId: 'sess_ctx',
    channel: 'web',
    reason: 'low_confidence',
    triggerText: '这个型号能配我的客厅吗',
    context: [{ question: '云朵沙发多大', answer: '三人位 2.1 米', ts: Date.now() }],
  });

  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/handoff/${t.id}`, {
      headers: { 'x-admin-token': TOKEN },
    });
    const body = (await res.json()) as {
      ticket: { context: Array<{ question: string; answer: string }> };
      reasonLabel: string;
    };
    assert.equal(body.ticket.context.length, 1);
    assert.equal(body.ticket.context[0].answer, '三人位 2.1 米');
    assert.equal(body.reasonLabel, '智能体兜不住');
  });
});
