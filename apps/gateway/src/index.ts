import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAQ_ITEMS } from '@cs/faq-engine';
import {
  createId,
  formatSseFrame,
  type ChatRequest,
} from '@cs/protocol';
import { appendMessage, getOrCreateSession, sessionStats } from './session.js';
import { generateReply, streamText } from './bot.js';
import { agentMode, agentRuntime } from './agent.js';
import { proxyToPython } from './py-proxy.js';
import type { CardPayload } from '@cs/protocol';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 8787);

/** 简易请求日志（P2 替换为结构化日志 + Langfuse 链路） */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[gateway] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`,
    );
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ...sessionStats() });
});

app.get('/api/faqs', (_req, res) => {
  res.json({ count: FAQ_ITEMS.length, items: FAQ_ITEMS });
});

/**
 * 统一对话入口（ADR-002 / ADR-003）：
 * POST /api/chat { sessionId?, message, channel? }
 * -> SSE 流：meta -> delta* -> card? -> done
 */
app.post('/api/chat', async (req, res) => {
  const body = req.body as Partial<ChatRequest>;
  const question = (body.message ?? '').toString().trim();
  if (!question) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const session = getOrCreateSession(body.sessionId, body.channel);
  appendMessage(session, {
    sessionId: session.id,
    role: 'user',
    content: question,
    channel: session.channel,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const traceId = createId('trace');
  const t0 = Date.now();
  res.write(formatSseFrame('meta', { sessionId: session.id, traceId, ts: t0 }));

  const messageId = createId('msg');
  let firstTokenMs = 0;
  let fullText = '';

  /**
   * 双路处理（ADR-0006）：
   *   护栏① 规则通道：转人工 / FAQ 高分命中 → 直达（口径可控，零 LLM 成本）；
   *   智能体通道：未命中或 FAQ 低分命中 → AgentRuntime 循环（低分硬答是事故，
   *   放行给智能体——它可通过工具拿到更准的事实）。
   * 两条路的 SSE 事件序列完全一致：meta → delta* → [tool*] → card? → done。
   */
  const FAQ_DIRECT_MIN_SCORE = Number(process.env.FAQ_DIRECT_MIN_SCORE ?? 0.8);
  /**
   * FAQ 直达只处理「纯知识类」问题。带工具信号的一律交给智能体：
   * 订单/运单号、动作诉求（工单/投诉/退款）、个人数据查询（我的优惠券）。
   * 否则 FAQ 会把「我要建工单」「我有哪些优惠券」直接答掉，
   * MCP / Skills 永远没机会被调用——这是线上会出事的那种"答得对但没做事"。
   */
  const TOOL_INTENT =
    /(?:CS|SF|JD)\d{4,}|工单|投诉|退款|退货|换货|物流|运单|轨迹|订单|优惠券|查一下|查询|帮我查/;
  const faqGuard = (process.env.FAQ_TOOL_GUARD ?? 'true').toLowerCase() !== 'false';
  const rule = generateReply(question);
  const ruleDirect =
    (!faqGuard || !TOOL_INTENT.test(question)) &&
    rule.matched &&
    (rule.intent === 'transfer_human' || rule.confidence >= FAQ_DIRECT_MIN_SCORE);
  if (ruleDirect) {
    try {
      for await (const chunk of streamText(rule.text)) {
        if (firstTokenMs === 0) firstTokenMs = Date.now() - t0;
        fullText += chunk;
        res.write(formatSseFrame('delta', { text: chunk }));
      }
      if (rule.card) {
        res.write(formatSseFrame('card', { card: rule.card }));
      }
      appendMessage(session, {
        sessionId: session.id,
        role: 'bot',
        content: fullText,
        channel: session.channel,
        card: rule.card,
        traceId,
      });
      res.write(
        formatSseFrame('done', {
          firstTokenMs,
          matched: true,
          confidence: rule.confidence,
          messageId,
          planner: 'rule',
          toolCalls: [],
          degraded: false,
        }),
      );
      res.end();
    } catch (err) {
      res.write(
        formatSseFrame('error', {
          code: 'bot_stream_failed',
          message: (err as Error).message,
        }),
      );
      res.end();
    }
    return;
  }

  /**
   * 智能体通道后端选择（ADR-0006 双实现期）：
   *   AGENT_BACKEND=py → 转 Python 智能层，帧原样透传；连不上时自动降级本地 TS 实现，
   *   保证"引入第二语言"不会成为新的可用性风险。
   */
  const backend = (process.env.AGENT_BACKEND ?? 'ts').toLowerCase();
  const pyUrl = process.env.AGENT_PY_URL ?? 'http://127.0.0.1:8788';
  if (backend === 'py') {
    try {
      const py = await proxyToPython({
        url: pyUrl,
        sessionId: session.id,
        message: question,
        channel: session.channel,
        traceId,
        res,
        t0,
      });
      appendMessage(session, {
        sessionId: session.id,
        role: 'bot',
        content: py.text || '（已发起操作确认）',
        channel: session.channel,
        card: py.card,
        traceId,
      });
      res.end();
      return;
    } catch (err) {
      console.warn(
        `[gateway] Python 智能层不可用，本次降级本地 TS 实现: ${(err as Error).message}`,
      );
    }
  }

  /* ---- 智能体通道（本地 TS 实现） ---- */
  try {
    let replyCard: CardPayload | undefined;
    let meta = { planner: 'unknown', toolCalls: [] as string[], degraded: false };

    for await (const ev of agentRuntime.run(question, { sessionId: session.id })) {
      switch (ev.type) {
        case 'delta':
          if (firstTokenMs === 0) firstTokenMs = Date.now() - t0;
          fullText += ev.text;
          res.write(formatSseFrame('delta', { text: ev.text }));
          break;
        case 'tool':
          res.write(
            formatSseFrame('tool', {
              name: ev.name,
              status: ev.status,
              ...(ev.summary ? { summary: ev.summary } : {}),
            }),
          );
          break;
        case 'card':
          replyCard = ev.card;
          res.write(formatSseFrame('card', { card: ev.card }));
          break;
        case 'end':
          meta = { planner: ev.meta.planner, toolCalls: ev.meta.toolCalls, degraded: ev.meta.degraded };
          break;
      }
    }

    appendMessage(session, {
      sessionId: session.id,
      role: 'bot',
      content: fullText || '（已发起操作确认）',
      channel: session.channel,
      card: replyCard,
      traceId,
    });
    res.write(
      formatSseFrame('done', {
        firstTokenMs,
        matched: fullText.trim().length > 0 || Boolean(replyCard),
        confidence: meta.degraded ? 0.5 : meta.toolCalls.length ? 0.9 : 0.7,
        messageId,
        planner: meta.planner,
        toolCalls: meta.toolCalls,
        degraded: meta.degraded,
      }),
    );
    res.end();
  } catch (err) {
    res.write(
      formatSseFrame('error', {
        code: 'agent_run_failed',
        message: (err as Error).message,
      }),
    );
    res.end();
  }
});

/**
 * 生产模式静态服务：挂件构建产物（P3 私有化"单源部署"形态预演）。
 * 开发模式由 Vite dev server + proxy 提供页面，不走这里。
 */
const widgetDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web-widget/dist',
);
if (existsSync(widgetDist)) {
  app.use(express.static(widgetDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(widgetDist, 'index.html'));
  });
  console.log(`[gateway] serving widget dist from ${widgetDist}`);
}

app.listen(PORT, () => {
  const mode = agentMode();
  console.log(`[gateway] listening on http://localhost:${PORT}`);
  console.log(`[gateway] 智能体: planner=${mode.planner} tools=[${mode.tools.join(', ')}]`);
  console.log(`[gateway] try: curl -N -X POST http://localhost:${PORT}/api/chat -H 'content-type: application/json' -d '{"message":"什么时候发货"}'`);
});
