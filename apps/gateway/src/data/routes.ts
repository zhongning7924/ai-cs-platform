/**
 * 数据面 HTTP 接口（ADR-0009）：评价写入、样本导出、效果看板。
 *
 * 设计原则：**反馈必须挂在一条真实存在的 traceId 上**。
 * 没有这条校验，前端一个 typo 就能在生产库里堆满孤儿评价，
 * 而且这些脏数据会静默污染好评率——比直接报错危险得多。
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import { datasetFileName, toJsonl, toSamples } from './dataset.js';
import {
  FEEDBACK_REASONS,
  REASON_LABELS,
  type FeedbackReason,
  type Rating,
  type TraceStore,
} from './store.js';

const MAX_REASONS = 4;

function isRating(v: unknown): v is Rating {
  return v === 'up' || v === 'down';
}

function isReason(v: unknown): v is FeedbackReason {
  return typeof v === 'string' && (FEEDBACK_REASONS as string[]).includes(v);
}

/**
 * @param admin 管理面中间件，只套在「导出 / 看板 / 对话记录」上。
 *   评价提交（POST /api/feedback）和选项字典是终端用户用的，不能套——
 *   套了挂件就点不了评价。
 */
export function mountDataRoutes(
  app: Express,
  store: TraceStore,
  admin: RequestHandler = (_req, _res, next) => next(),
): void {
  /** 反馈选项字典：前端文案与后端枚举同源，避免两边各写一份然后漂移。 */
  app.get('/api/feedback/options', (_req: Request, res: Response) => {
    res.json({
      reasons: FEEDBACK_REASONS.map((r) => ({ value: r, label: REASON_LABELS[r] })),
    });
  });

  app.post('/api/feedback', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      traceId?: unknown;
      rating?: unknown;
      reasons?: unknown;
      comment?: unknown;
      correctedAnswer?: unknown;
      channel?: unknown;
    };

    const traceId = typeof body.traceId === 'string' ? body.traceId.trim() : '';
    if (!traceId) {
      res.status(400).json({ error: 'traceId_required' });
      return;
    }
    const view = store.find(traceId);
    if (!view) {
      res.status(404).json({ error: 'trace_not_found', traceId });
      return;
    }
    if (!isRating(body.rating)) {
      res.status(400).json({ error: 'rating_invalid', allowed: ['up', 'down'] });
      return;
    }

    const rawReasons = Array.isArray(body.reasons) ? body.reasons : [];
    const reasons = rawReasons.filter(isReason);
    if (reasons.length !== rawReasons.length) {
      res.status(400).json({
        error: 'reason_invalid',
        allowed: FEEDBACK_REASONS,
      });
      return;
    }
    if (body.rating === 'down' && reasons.length === 0) {
      // 差评必须有原因：这个字段的唯一用途就是聚合，收一条没原因的差评等于收了个噪声
      res.status(400).json({ error: 'reason_required', allowed: FEEDBACK_REASONS });
      return;
    }
    if (reasons.length > MAX_REASONS) {
      res.status(400).json({ error: 'too_many_reasons', max: MAX_REASONS });
      return;
    }

    const feedback = store.appendFeedback({
      traceId,
      rating: body.rating,
      reasons,
      comment: typeof body.comment === 'string' ? body.comment : undefined,
      // 只有差评才收「正确答案」：好评时用户写的通常是"谢谢"，不是标注
      correctedAnswer:
        body.rating === 'down' && typeof body.correctedAnswer === 'string'
          ? body.correctedAnswer
          : undefined,
      channel: typeof body.channel === 'string' ? body.channel : undefined,
    });

    res.json({
      ok: true,
      traceId,
      feedbackId: feedback.id,
      rating: feedback.rating,
      reasons: feedback.reasons,
      corrected: Boolean(feedback.correctedAnswer),
    });
  });

  /** 最近对话（含评价状态）。给运营/研发看真实流量长什么样。 */
  app.get('/api/traces', admin, (req: Request, res: Response) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const ratingParam = String(req.query.rating ?? '');
    const rating = ratingParam === 'up' || ratingParam === 'down' || ratingParam === 'none'
      ? ratingParam
      : undefined;
    const items = store.recent(limit, { rating }).map((v) => ({
      traceId: v.turn.traceId,
      sessionId: v.turn.sessionId,
      ts: v.turn.ts,
      channel: v.turn.channel,
      question: v.turn.question,
      answer: v.turn.answer,
      cardType: v.turn.cardType,
      planner: v.turn.planner,
      agent: v.turn.agent,
      skill: v.turn.skill,
      route: v.turn.route,
      toolCalls: v.turn.toolCalls,
      degraded: v.turn.degraded,
      firstTokenMs: v.turn.firstTokenMs,
      totalMs: v.turn.totalMs,
      feedback: v.feedback
        ? {
            rating: v.feedback.rating,
            reasons: v.feedback.reasons,
            comment: v.feedback.comment,
            correctedAnswer: v.feedback.correctedAnswer,
            ts: v.feedback.ts,
            count: v.feedbackCount,
          }
        : null,
    }));
    res.json({ count: items.length, items });
  });

  /** 效果看板：好评率、差评原因分布、按坐席拆。 */
  app.get('/api/stats/feedback', admin, (_req: Request, res: Response) => {
    res.json(store.stats());
  });

  /**
   * 导出评测集。默认只导「有标注」的样本——理由见 dataset.ts 顶部第 1 条。
   * ?include=all 才带上未标注的，用于分析问题分布。
   */
  app.get('/api/dataset/export', admin, (req: Request, res: Response) => {
    const includeAll = String(req.query.include ?? 'labeled') === 'all';
    const samples = toSamples(store.all(), { includeUnlabeled: includeAll });
    const body = toJsonl(samples);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${datasetFileName(includeAll ? 'feedback-dataset-all' : 'feedback-dataset')}"`,
    );
    res.setHeader('X-Sample-Count', String(samples.length));
    res.send(body);
  });
}
