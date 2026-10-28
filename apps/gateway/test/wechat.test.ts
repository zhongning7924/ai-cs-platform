import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import {
  buildTextReplyXml,
  mountWechatRoutes,
  parseTextMessage,
  verifySignature,
  type WechatTextMessage,
} from '../src/wechat.js';

const sha1 = (s: string) => createHash('sha1').update(s, 'utf-8').digest('hex');

test('verifySignature：排序拼接后 sha1 与微信一致', () => {
  const token = 'abc';
  const timestamp = '1700000000';
  const nonce = '123456';
  // 字典序排序："123456" < "1700000000" < "abc"
  const sig = sha1('1234561700000000abc');
  assert.equal(verifySignature(token, timestamp, nonce, sig), true);
  assert.equal(verifySignature(token, timestamp, nonce, 'deadbeef'), false);
  // 微信签名大小写不敏感
  assert.equal(verifySignature(token, timestamp, nonce, sig.toUpperCase()), true);
});

test('parseTextMessage：正确解析文本消息、拒绝非文本', () => {
  const xml =
    '<xml><ToUserName><![CDATA[gh_test]]></ToUserName>' +
    '<FromUserName><![CDATA[openid_1]]></FromUserName>' +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[沙发多少钱]]></Content><MsgId>1</MsgId></xml>';
  const msg = parseTextMessage(xml) as WechatTextMessage;
  assert.equal(msg.fromUser, 'openid_1');
  assert.equal(msg.toUser, 'gh_test');
  assert.equal(msg.content, '沙发多少钱');

  const event =
    '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>';
  assert.equal(parseTextMessage(event), null);
});

test('buildTextReplyXml：收发双方对调、内容入 CDATA', () => {
  const xml = buildTextReplyXml('openid_1', 'gh_test', '已收到');
  assert.match(xml, /<ToUserName><!\[CDATA\[openid_1\]\]><\/ToUserName>/);
  assert.match(xml, /<FromUserName><!\[CDATA\[gh_test\]\]><\/FromUserName>/);
  assert.match(xml, /<Content><!\[CDATA\[已收到\]\]><\/Content>/);
});

test('GET /wechat：签名通过返回 echostr，失败 403，未配置 500', async () => {
  const prev = process.env.WECHAT_TOKEN;
  const app = express();
  mountWechatRoutes(app, { answer: async () => '' });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    // 未配置 token → 500
    delete process.env.WECHAT_TOKEN;
    let r = await fetch(`http://127.0.0.1:${port}/wechat?signature=x&timestamp=1&nonce=2&echostr=hi`);
    assert.equal(r.status, 500);

    // 配了 token，签名正确 → 回 echostr
    process.env.WECHAT_TOKEN = 'mytoken';
    const ts = '1', nonce = '2';
    const sig = sha1(['mytoken', ts, nonce].sort().join(''));
    r = await fetch(
      `http://127.0.0.1:${port}/wechat?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=hello123`,
    );
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello123');

    // 签名错误 → 403
    r = await fetch(
      `http://127.0.0.1:${port}/wechat?signature=bad&timestamp=${ts}&nonce=${nonce}&echostr=x`,
    );
    assert.equal(r.status, 403);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.WECHAT_TOKEN;
    else process.env.WECHAT_TOKEN = prev;
  }
});

test('POST /wechat：回即时回执并异步调 answer（不触达微信 API）', async () => {
  const prev = { t: process.env.WECHAT_TOKEN, a: process.env.WECHAT_APPID, s: process.env.WECHAT_SECRET };
  process.env.WECHAT_TOKEN = 't';
  process.env.WECHAT_APPID = 'wx_test';
  process.env.WECHAT_SECRET = 'secret';

  const app = express();
  const calls: string[] = [];
  mountWechatRoutes(app, {
    answer: async (sessionId, message) => {
      calls.push(`${sessionId}:${message}`);
      return ''; // 空回复 → 异步链路在此终止，不请求微信 access_token
    },
  });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const xml =
      '<xml><ToUserName><![CDATA[gh_test]]></ToUserName>' +
      '<FromUserName><![CDATA[openid_1]]></FromUserName>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[沙发多少钱]]></Content></xml>';
    const r = await fetch(`http://127.0.0.1:${port}/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: xml,
    });
    const reply = await r.text();
    assert.match(reply, /已收到/);
    assert.match(reply, /<ToUserName><!\[CDATA\[openid_1\]\]>/);
    // 异步回调已带 openid 作为 sessionId
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(calls, ['openid_1:沙发多少钱']);
  } finally {
    server.close();
    if (prev.t === undefined) delete process.env.WECHAT_TOKEN; else process.env.WECHAT_TOKEN = prev.t;
    if (prev.a === undefined) delete process.env.WECHAT_APPID; else process.env.WECHAT_APPID = prev.a;
    if (prev.s === undefined) delete process.env.WECHAT_SECRET; else process.env.WECHAT_SECRET = prev.s;
  }
});
