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
import { appendMessage, getOrCreateSession, sessionStats, type Session } from './session.js';
import { generateReply, streamText } from './bot.js';
import { agentMode, agentRuntime } from './agent.js';
import { proxyToPython } from './py-proxy.js';
import { createTraceStore } from './data/store.js';
import { mountDataRoutes } from './data/routes.js';
import { adminGuard, createRateLimiter, originGuard, parseOrigins } from './guard.js';
import { HandoffStore } from './handoff/store.js';
import { mountHandoffRoutes } from './handoff/routes.js';
import { detectImmediate, looksUnresolved } from './handoff/detect.js';
import type { ContextTurn, HandoffReason, HandoffTicket } from './handoff/types.js';
import type { CardPayload } from '@cs/protocol';
import type { Response } from 'express';

const app = express();
app.use(express.json());

/**
 * 反代后要拿到真实 IP（限流和日志都依赖它）。
 * 只有确实在 nginx/网关后面才开，否则 X-Forwarded-For 可被伪造绕过限流。
 */
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

const PORT = Number(process.env.PORT ?? 8787);

/** 管理面 token。不配则管理面只允许本机访问（见 guard.ts 的取舍说明）。 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || undefined;
/** 挂件来源白名单，逗号分隔；留空不校验（本地开发）。 */
const WIDGET_ORIGINS = parseOrigins(process.env.WIDGET_ORIGINS);
/** 每 IP 每分钟对话次数上限；0 = 关闭。 */
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30);
const rateLimit = createRateLimiter(RATE_LIMIT_PER_MINUTE);

/**
 * 数据面（ADR-0009）：对话与反馈落盘。
 * 默认写仓库根的 var/data/feedback.jsonl，DATA_DIR 可覆盖（容器里挂卷）。
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../var/data');
const traceStore = createTraceStore(DATA_DIR);

/**
 * 落盘是旁路，不是主链路：磁盘满 / 权限错不能把用户正在等的回复搞挂。
 * 这里吞掉异常只打日志——但**不吞 silently**，否则数据静默缺失比报错更难查。
 * TRACE_STORE_ENABLED=false 时整体关掉采集（对评价接口本身没有影响，
 * 只是这一轮不会被记录、也就无处可挂评价）。
 */
const RECORD_ENABLED = (process.env.TRACE_STORE_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * 工单库（ADR-0011）。和对话记录共用 DATA_DIR，但**不共用开关语义**：
 * TRACE_STORE_ENABLED 是「要不要采集数据」，关掉不该让人工客服不可用。
 * 所以工单始终落盘——它是业务功能，不是分析素材。
 */
const handoffStore = new HandoffStore(DATA_DIR);

function safeRecord(fn: () => void): void {
  if (!RECORD_ENABLED) return;
  try {
    fn();
  } catch (err) {
    console.warn(`[gateway] 数据落盘失败: ${(err as Error).message}`);
  }
}

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

/** 反馈 / 对话记录 / 评测集导出（ADR-0009）。必须挂在静态 catch-all 之前。 */
mountDataRoutes(app, traceStore, adminGuard(ADMIN_TOKEN));

/** 转人工接口（ADR-0011）。同样必须在静态 catch-all 之前。 */
mountHandoffRoutes(app, handoffStore, adminGuard(ADMIN_TOKEN));

/**
 * 把会话历史折成交接上下文。
 *
 * 只给坐席「问了什么 / 答了什么」，不给工具调用和服务端噪声——
 * 坐席要的是三秒看懂客户刚才在纠结什么，不是调试日志。
 */
function recentContext(session: Session): ContextTurn[] {
  const turns: ContextTurn[] = [];
  let pending: { question: string; ts: number } | null = null;

  for (const m of session.history) {
    if (m.role === 'user') {
      pending = { question: m.content, ts: m.ts };
    } else if (m.role === 'bot' && pending) {
      turns.push({ question: pending.question, answer: m.content, ts: pending.ts });
      pending = null;
    }
  }
  return turns.slice(-6);
}

function handoffFrame(ticket: HandoffTicket) {
  return {
    ticketId: ticket.id,
    status: ticket.status,
    position: handoffStore.position(ticket.id),
    agentName: ticket.agentName ?? null,
    reason: ticket.reason,
  };
}

function openHandoff(
  session: Session,
  reason: HandoffReason,
  triggerText: string,
): HandoffTicket {
  return handoffStore.create({
    sessionId: session.id,
    channel: session.channel,
    reason,
    triggerText,
    context: recentContext(session),
  });
}

/**
 * 答完之后兜底：这条回答没解决问题，就建单转人工。
 * 返回 ticket 仅用于记录，调用方据此把 planner 标成 handoff。
 */
function escalateIfUnresolved(
  res: Response,
  session: Session,
  question: string,
  answer: string | undefined,
  degraded: boolean,
): HandoffTicket | null {
  if (!looksUnresolved(answer, degraded)) return null;

  const ticket = openHandoff(session, 'low_confidence', question);
  const position = handoffStore.position(ticket.id);
  res.write(
    formatSseFrame('delta', {
      text: `\n\n这个问题我转给人工客服接着处理，当前排队第 ${position} 位。`,
    }),
  );
  res.write(formatSseFrame('handoff', handoffFrame(ticket)));
  return ticket;
}

/**
 * 对外唯一的高成本入口，两层防护都挂这里：
 * 来源白名单挡「别人拿我的挂件当免费 API」，限流挡「一个脚本打满全站」。
 */
app.use('/api/chat', originGuard(WIDGET_ORIGINS), rateLimit);

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
   * 转人工判定顺序（ADR-0011）：⓪ 已在人工 → ① 本轮要转人工 → ② FAQ 直达 → ③ 智能体。
   *
   * ⓪ 必须排在最前面：人工接管期间如果还让模型回一句「我帮您查一下」，
   * 坐席和机器人会同时在对话框里说话，用户会以为系统坏了。
   */
  const openTicket = handoffStore.openBySession(session.id);
  if (openTicket) {
    // 人工阶段的消息原样进工单，一个字都不能被模型改写
    handoffStore.addUserMessage(openTicket.id, question);
    res.write(formatSseFrame('handoff', handoffFrame(openTicket)));
    res.write(
      formatSseFrame('done', {
        firstTokenMs: 0,
        matched: true,
        confidence: 1,
        messageId,
        planner: 'human',
        toolCalls: [],
        degraded: false,
      }),
    );
    res.end();
    return;
  }

  const immediate = detectImmediate(question);
  if (immediate) {
    /*
      建单在回答之前完成，不是先答再转——「正在为您转接」这句话必须
      在工单已经存在之后才说得出真实排队位次，否则又是一句假话。
    */
    const ticket = openHandoff(session, immediate, question);
    const position = handoffStore.position(ticket.id);
    const text =
      immediate === 'user_request'
        ? `已为你转接人工客服，当前排队第 ${position} 位。接入后客服能看到我们刚才的对话，不用重复描述。`
        : `这件事我帮你转给人工客服跟进，当前排队第 ${position} 位，请稍候。`;

    for await (const chunk of streamText(text)) {
      if (firstTokenMs === 0) firstTokenMs = Date.now() - t0;
      fullText += chunk;
      res.write(formatSseFrame('delta', { text: chunk }));
    }
    res.write(formatSseFrame('handoff', handoffFrame(ticket)));

    appendMessage(session, {
      sessionId: session.id,
      role: 'bot',
      content: fullText,
      channel: session.channel,
      traceId,
    });
    safeRecord(() =>
      traceStore.appendTurn({
        traceId,
        sessionId: session.id,
        channel: session.channel,
        question,
        answer: fullText,
        planner: 'handoff',
        agent: 'human_handoff',
        route: `handoff:${immediate}`,
        toolCalls: [],
        degraded: false,
        firstTokenMs,
        totalMs: Date.now() - t0,
      }),
    );
    res.write(
      formatSseFrame('done', {
        firstTokenMs,
        matched: true,
        confidence: 1,
        messageId,
        planner: 'handoff',
        toolCalls: [],
        degraded: false,
      }),
    );
    res.end();
    return;
  }

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
      /**
       * 直通通道也要落盘。这点很容易漏：FAQ 直达不经过智能体，
       * 如果只记录智能体链路，数据资产里就只有"难问题"，
       * 好评率会莫名其妙偏低，而且看不出 FAQ 口径本身有没有问题。
       */
      safeRecord(() =>
        traceStore.appendTurn({
          traceId,
          sessionId: session.id,
          channel: session.channel,
          question,
          answer: fullText,
          cardType: rule.card?.type,
          planner: 'rule',
          agent: rule.intent === 'transfer_human' ? 'human_handoff' : 'faq_direct',
          route: 'faq_direct',
          toolCalls: [],
          degraded: false,
          firstTokenMs,
          totalMs: Date.now() - t0,
        }),
      );
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
      // 降级 / 「查不到」类回答不能就这么结束——没有出口的问题必须有人接
      const escalated = escalateIfUnresolved(res, session, question, py.text, py.degraded);

      appendMessage(session, {
        sessionId: session.id,
        role: 'bot',
        content: py.text || '（已发起操作确认）',
        channel: session.channel,
        card: py.card,
        traceId,
      });
      safeRecord(() =>
        traceStore.appendTurn({
          traceId,
          sessionId: session.id,
          channel: session.channel,
          question,
          answer: py.text || '（已发起操作确认）',
          cardType: py.card?.type,
          planner: escalated ? 'handoff' : py.planner,
          agent: escalated ? 'human_handoff' : py.agent,
          skill: py.skill,
          route: escalated ? 'handoff:low_confidence' : py.route,
          toolCalls: py.toolCalls,
          degraded: py.degraded,
          firstTokenMs: py.firstTokenMs,
          totalMs: Date.now() - t0,
        }),
      );
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

    const escalated = escalateIfUnresolved(res, session, question, fullText, meta.degraded);

    appendMessage(session, {
      sessionId: session.id,
      role: 'bot',
      content: fullText || '（已发起操作确认）',
      channel: session.channel,
      card: replyCard,
      traceId,
    });
    safeRecord(() =>
      traceStore.appendTurn({
        traceId,
        sessionId: session.id,
        channel: session.channel,
        question,
        answer: fullText || '（已发起操作确认）',
        cardType: replyCard?.type,
        planner: escalated ? 'handoff' : meta.planner,
        route: escalated ? 'handoff:low_confidence' : 'agent',
        toolCalls: meta.toolCalls,
        degraded: meta.degraded,
        firstTokenMs,
        totalMs: Date.now() - t0,
      }),
    );
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
 * 坐席工作台：单文件、零构建。
 * 客户运维不需要 Node 工具链，打开 /console 就能接单。
 * 必须注册在静态 catch-all 之前，否则会被挂件页面吃掉。
 */
const consolePage = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/console.html',
);
app.get('/console', (_req, res) => {
  if (!existsSync(consolePage)) {
    res.status(404).send('console.html 未找到');
    return;
  }
  res.sendFile(consolePage);
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
