/**
 * 微信公众号 / 服务号渠道适配器（明文模式，最小闭环）。
 *
 * 两条协议都实现：
 *   1. GET  /wechat  —— 服务器地址验证（signature/timestamp/nonce/echostr）
 *   2. POST /wechat  —— 消息接收（文本消息）→ 被动回复即时回执 + 异步客服消息回推
 *
 * 关键约束：微信要求被动回复在 5 秒内返回，而 LLM + 工具调用通常要 3~8 秒。
 * 所以这里先回一个"已收到"（毫秒级，永不超时），真正的答案走异步路径：
 * 调智能体拿完整回复 → 用客服消息接口（48 小时内可发）推回给用户。
 *
 * openid 直接作为 session_id，与网页挂件的会话复用同一套智能体链路——
 * 用户在公众号里的多轮咨询能接上上下文，也能进同一份转人工工单。
 */

import { createHash } from 'node:crypto';
import { text } from 'express';
import type { Express, Request, Response } from 'express';

export interface WechatDeps {
  /** 拿完整回复。签名 (sessionId, message, channel) => 完整文本。 */
  answer: (sessionId: string, message: string, channel: string) => Promise<string>;
  /** 可选日志。 */
  log?: (msg: string) => void;
}

interface WechatConfig {
  token: string;
  appId: string;
  secret: string;
}

function config(): WechatConfig {
  return {
    token: process.env.WECHAT_TOKEN?.trim() ?? '',
    appId: process.env.WECHAT_APPID?.trim() ?? '',
    secret: process.env.WECHAT_SECRET?.trim() ?? '',
  };
}

export function wechatConfigured(): boolean {
  const c = config();
  return Boolean(c.token && c.appId && c.secret);
}

/** 微信服务器地址验证：sha1(sort(token, timestamp, nonce).join('')) === signature */
export function verifySignature(token: string, timestamp: string, nonce: string, signature: string): boolean {
  const raw = [token, timestamp, nonce].sort().join('');
  const hash = createHash('sha1').update(raw, 'utf-8').digest('hex');
  return hash === signature.toLowerCase();
}

/** 从 XML 里取一个标签的 CDATA 内容（公众号消息结构固定，不必引 XML 库）。 */
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

export interface WechatTextMessage {
  toUser: string;
  fromUser: string;
  content: string;
}

export function parseTextMessage(xml: string): WechatTextMessage | null {
  const msgType = extractTag(xml, 'MsgType');
  if (msgType !== 'text') return null;
  const fromUser = extractTag(xml, 'FromUserName');
  const toUser = extractTag(xml, 'ToUserName');
  const content = extractTag(xml, 'Content');
  if (!fromUser || !content) return null;
  return { toUser, fromUser, content };
}

/** 被动回复文本（XML）。toUser/fromUser 与接收时对调。 */
export function buildTextReplyXml(toUser: string, fromUser: string, text: string): string {
  const now = Math.floor(Date.now() / 1000);
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${toUser}]]></ToUserName>` +
    `<FromUserName><![CDATA[${fromUser}]]></FromUserName>` +
    `<CreateTime>${now}</CreateTime>` +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${text}]]></Content>` +
    '</xml>'
  );
}

/* ---------------- access_token 缓存 ---------------- */

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(appId: string, secret: string): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }
  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
  const r = await fetch(url);
  const data = (await r.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
  if (!data.access_token) {
    throw new Error(`获取 access_token 失败: ${data.errmsg ?? '未知错误'}`);
  }
  const expiresAt = now + (data.expires_in ?? 7200) * 1000;
  tokenCache = { token: data.access_token, expiresAt };
  return data.access_token;
}

/** 客服消息接口：主动推一条文本给用户（48 小时内有效，异步兜底用）。 */
export async function sendCustomerMessage(accessToken: string, toUser: string, text: string): Promise<void> {
  const r = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser: toUser, msgtype: 'text', text: { content: text } }),
    },
  );
  const data = (await r.json()) as { errcode?: number; errmsg?: string };
  if (data.errcode !== 0) {
    throw new Error(`客服消息发送失败: ${data.errcode} ${data.errmsg}`);
  }
}

/* ---------------- 路由挂载 ---------------- */

export function mountWechatRoutes(app: Express, deps: WechatDeps): void {
  const log = deps.log ?? ((m: string) => console.log(`[gateway] ${m}`));

  // 服务器地址验证
  app.get('/wechat', (req: Request, res: Response) => {
    const { token } = config();
    const { signature, timestamp, nonce, echostr } = req.query as Record<string, string>;
    if (!token) {
      res.status(500).send('未配置 WECHAT_TOKEN');
      return;
    }
    if (!signature || !timestamp || !nonce || !verifySignature(token, timestamp, nonce, signature)) {
      res.status(403).send('signature 校验失败');
      return;
    }
    res.send(echostr ?? '');
  });

  // 消息接收（微信发 XML，用 text 解析；json() 全局中间件对 text/xml 不消费，二者不冲突）
  app.post('/wechat', text({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
    const { appId, secret } = config();
    if (!wechatConfigured()) {
      res.status(500).send('未完整配置公众号（WECHAT_TOKEN / WECHAT_APPID / WECHAT_SECRET）');
      return;
    }

    // ① 收到消息先回即时回执（毫秒级），微信 5 秒超时红线永远不碰
    const xml = (req.body ?? '').toString();
    const msg = parseTextMessage(xml);
    if (msg) {
      res.type('application/xml').send(buildTextReplyXml(msg.fromUser, msg.toUser, '已收到，正在为您查询，请稍候…'));
    } else {
      // 非文本消息：回空串（success 语义），避免微信 5 秒后重试刷屏
      res.send('success');
    }

    // ② 异步拿答案，走客服消息接口回推（不阻塞被动回复）
    if (msg) {
      void (async () => {
        try {
          const answer = await deps.answer(msg.fromUser, msg.content, 'wechat_mp');
          if (!answer) return;
          const at = await getAccessToken(appId, secret);
          await sendCustomerMessage(at, msg.fromUser, answer);
        } catch (err) {
          log(`公众号异步回复失败: ${(err as Error).message}`);
        }
      })();
    }
  });
}
