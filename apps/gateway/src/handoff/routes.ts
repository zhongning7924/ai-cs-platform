/**
 * 转人工 HTTP 接口（ADR-0011）。
 *
 * 分两组，鉴权要求完全不同：
 *   · 用户侧 /api/chat/poll —— 挂件每 1.5s 拉一次，不加限流（不花 LLM，成本为零）。
 *     防越权靠 sessionId 本身不可猜（sess_ + 时间戳 + 随机后缀）。
 *   · 坐席侧 /api/handoff/* —— 必须过 adminGuard。这里能看到客户原话和订单号。
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import type { HandoffStore } from './store.js';
import { REASON_LABELS, RESOLUTION_LABELS, type Resolution } from './types.js';

const MAX_REPLY_LENGTH = 2000;
const RESOLUTIONS: Resolution[] = ['resolved', 'unresolved', 'abandoned'];

function isResolution(v: unknown): v is Resolution {
  return typeof v === 'string' && (RESOLUTIONS as string[]).includes(v);
}

export function mountHandoffRoutes(
  app: Express,
  store: HandoffStore,
  admin: RequestHandler,
): void {
  /**
   * 用户端增量拉取。
   * 带 status 而不只是 messages：用户需要知道"还在排队第 2 位"，而不只是等待。
   */
  app.get('/api/chat/poll', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const afterSeq = Number(req.query.afterSeq ?? 0) || 0;

    if (!sessionId) {
      res.status(400).json({ error: 'session_id_required' });
      return;
    }

    const ticket = store.openBySession(sessionId);
    if (!ticket) {
      // handoff=null 是正常状态（没挂人工），不是错误。前端据此停止轮询。
      res.json({ sessionId, handoff: null, messages: [], seq: afterSeq });
      return;
    }

    const isQueued = ticket.status === 'queued';
    res.json({
      sessionId,
      handoff: {
        ticketId: ticket.id,
        status: ticket.status,
        position: isQueued ? store.position(ticket.id) : 0,
        agentName: ticket.agentName ?? null,
        reason: ticket.reason,
        reasonLabel: REASON_LABELS[ticket.reason],
        waitingSec: Math.max(0, Math.round((Date.now() - ticket.createdAt) / 1000)),
      },
      messages: store.agentMessagesSince(ticket.id, afterSeq),
      seq: ticket.seq,
    });
  });

  /** 坐席首屏：排队 + 进行中。必须在 /:id 之前注册，否则 "queue" 会被当成工单号。 */
  app.get('/api/handoff/queue', admin, (_req: Request, res: Response) => {
    const items = [...store.queue(), ...store.active()].map((t) => {
      const lastUser = [...t.messages].reverse().find((m) => m.role === 'user');
      return {
        id: t.id,
        sessionId: t.sessionId,
        status: t.status,
        reason: t.reason,
        reasonLabel: REASON_LABELS[t.reason],
        triggerText: t.triggerText,
        agentName: t.agentName ?? null,
        createdAt: t.createdAt,
        // 排队用「到现在」，进行中用「到接入那一刻」，两个数含义不同不能混
        waitingSec: Math.max(
          0,
          Math.round(((t.claimedAt ?? Date.now()) - t.createdAt) / 1000),
        ),
        preview: lastUser?.text ?? '',
        messageCount: t.messages.length,
      };
    });

    res.json({ count: items.length, items, stats: store.stats() });
  });

  app.get('/api/handoff/:id', admin, (req: Request, res: Response) => {
    const ticket = store.get(String(req.params.id));
    if (!ticket) {
      res.status(404).json({ error: 'ticket_not_found' });
      return;
    }
    res.json({
      ticket,
      reasonLabel: REASON_LABELS[ticket.reason],
      ...(ticket.resolution ? { resolutionLabel: RESOLUTION_LABELS[ticket.resolution] } : {}),
    });
  });

  app.post('/api/handoff/:id/claim', admin, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { agentName?: unknown };
    const agentName =
      String(body.agentName ?? '').trim() || (process.env.AGENT_DISPLAY_NAME ?? '客服');

    const existing = store.get(id);
    if (!existing) {
      res.status(404).json({ error: 'ticket_not_found' });
      return;
    }
    if (existing.status === 'active') {
      res.status(409).json({
        error: 'already_claimed',
        agentName: existing.agentName,
        message: `已被 ${existing.agentName ?? '其他坐席'} 接入`,
      });
      return;
    }
    if (existing.status === 'closed') {
      res.status(409).json({ error: 'ticket_closed', message: '工单已结束' });
      return;
    }

    const ticket = store.claim(id, agentName);
    if (!ticket) {
      res.status(409).json({ error: 'claim_failed' });
      return;
    }
    res.json({ ok: true, ticket });
  });

  app.post('/api/handoff/:id/reply', admin, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { text?: unknown; agentName?: unknown };
    const text = String(body.text ?? '').trim();

    if (!text) {
      res.status(400).json({ error: 'text_required' });
      return;
    }
    if (text.length > MAX_REPLY_LENGTH) {
      res.status(400).json({ error: 'text_too_long', max: MAX_REPLY_LENGTH });
      return;
    }

    const ticket = store.get(id);
    if (!ticket) {
      res.status(404).json({ error: 'ticket_not_found' });
      return;
    }
    if (ticket.status !== 'active') {
      // 没接入就回复，消息会挂在一个没人认领的工单上——必须挡住
      res.status(409).json({
        error: 'ticket_not_active',
        status: ticket.status,
        message: '请先接入会话再回复',
      });
      return;
    }

    const message = store.addAgentMessage(
      id,
      text,
      String(body.agentName ?? '').trim() || ticket.agentName,
    );
    if (!message) {
      res.status(409).json({ error: 'reply_failed' });
      return;
    }
    res.json({ ok: true, message });
  });

  app.post('/api/handoff/:id/close', admin, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { resolution?: unknown };
    const resolution = isResolution(body.resolution) ? body.resolution : 'resolved';

    const existing = store.get(id);
    if (!existing) {
      res.status(404).json({ error: 'ticket_not_found' });
      return;
    }

    const ticket = store.close(id, resolution);
    if (!ticket) {
      res.status(409).json({ error: 'ticket_already_closed' });
      return;
    }
    // 关闭后这条会话自动回到 AI 模式：openBySession 只认未关闭的工单
    res.json({ ok: true, ticket });
  });
}
