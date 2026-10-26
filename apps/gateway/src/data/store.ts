/**
 * 对话数据面：事件溯源式 JSONL 存储（ADR-0009）。
 *
 * 为什么是 append-only 而不是「改一行」：
 *   1. 并发安全。追加写（O_APPEND）天然原子，不用文件锁；改写要「读全量 → 改 → 重写」，
 *      两个请求撞上就丢数据。
 *   2. 可回放。用户先点👎、后改成👍，两条都在，能看到"改主意"这件事本身；
 *      原地覆盖就把这个信号抹了。
 *   3. 故障可诊断。写入失败只会丢最后一行，不会毁掉整个文件。
 *
 * 代价是读取要折叠（同一 traceId 后写的覆盖先写的）。MVP 全量读 + mtime 缓存，
 * 文件到十万行再换 SQLite/ClickHouse——注意换的时候折叠规则要一起搬。
 *
 * 单一写入点：只有 Node 网关写这个文件。Python 智能层不写，
 * 所以两个后端（AGENT_BACKEND=ts|py）产出的数据形状完全一致，可以混在一起分析。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createId } from '@cs/protocol';
import { redact } from './redact.js';

/** 差评原因：固定枚举，否则导出的数据集没法按原因聚合、没法做回归筛选。 */
export type FeedbackReason =
  | 'wrong_fact' // 事实/价格/时效说错了
  | 'missing_tool' // 该查的没查、该办的没办
  | 'wrong_action' // 办了不该办的事 / 操作结果不对
  | 'too_vague' // 答非所问、太笼统
  | 'format' // 表述混乱、看不懂
  | 'slow'; // 太慢

export const FEEDBACK_REASONS: FeedbackReason[] = [
  'wrong_fact',
  'missing_tool',
  'wrong_action',
  'too_vague',
  'format',
  'slow',
];

/**
 * 必须说清楚的一件事：「other」不进枚举。
 * 开放式的"其他"会变成垃圾桶，90% 的差评都选它，聚合就没意义了。
 * 写不清楚原因本身就是产品问题——让用户用补充说明说，而不是给个逃跑按钮。
 */
export const REASON_LABELS: Record<FeedbackReason, string> = {
  wrong_fact: '事实说错了',
  missing_tool: '该查/该办却没做',
  wrong_action: '操作结果不对',
  too_vague: '答非所问',
  format: '表达看不懂',
  slow: '响应太慢',
};

export type Rating = 'up' | 'down';

/** 一轮对话的事实记录。同一 traceId 只写一次。 */
export interface TurnRecord {
  kind: 'turn';
  traceId: string;
  sessionId: string;
  ts: number;
  channel: string;
  question: string;
  answer: string;
  cardType?: string;
  planner: string;
  /** 路由分诊维度：谁答的、凭什么分的、命中了什么技能 */
  agent?: string;
  skill?: string;
  route?: string;
  toolCalls: string[];
  degraded: boolean;
  firstTokenMs: number;
  totalMs: number;
}

/** 一次用户评价。同一 traceId 可写多次（改主意），读时取最后一条。 */
export interface FeedbackRecord {
  kind: 'feedback';
  id: string;
  traceId: string;
  ts: number;
  rating: Rating;
  reasons: FeedbackReason[];
  comment?: string;
  /** 用户写出「正确答案应该是……」，这是最贵的数据，直接进回归集 */
  correctedAnswer?: string;
  channel: string;
}

export type StoredRecord = TurnRecord | FeedbackRecord;

export interface TraceView {
  turn: TurnRecord;
  /** 当前生效的评价（最后一次写入） */
  feedback?: FeedbackRecord;
  /** 该轮被评价过几次——大于 1 说明用户改过主意，值得单独看一眼 */
  feedbackCount: number;
}

export interface FeedbackStats {
  turns: number;
  rated: number;
  up: number;
  down: number;
  /** 好评率，分母是「有过反馈的轮次」——沉默用户不算满意 */
  satisfaction: number;
  ratedRate: number;
  corrected: number;
  degraded: number;
  reasons: Array<{ reason: FeedbackReason; label: string; count: number }>;
  byAgent: Array<{
    agent: string;
    turns: number;
    rated: number;
    up: number;
    down: number;
    satisfaction: number;
  }>;
}

const FEEDBACK_FILE = 'feedback.jsonl';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function trim(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const s = value.trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class TraceStore {
  private readonly file: string;
  private cache: { mtimeMs: number; size: number; views: Map<string, TraceView> } | null = null;

  constructor(dir: string) {
    ensureDir(dir);
    this.file = path.join(dir, FEEDBACK_FILE);
  }

  get filePath(): string {
    return this.file;
  }

  /** 记录一轮对话。文本字段在此脱敏——这是全仓唯一写入口。 */
  appendTurn(input: Omit<TurnRecord, 'kind' | 'ts' | 'question' | 'answer'> & {
    ts?: number;
    question: string;
    answer: string;
  }): TurnRecord {
    const record: TurnRecord = {
      kind: 'turn',
      ts: input.ts ?? Date.now(),
      traceId: input.traceId,
      sessionId: input.sessionId,
      channel: input.channel,
      question: redact(trim(input.question, 2000) ?? ''),
      answer: redact(trim(input.answer, 4000) ?? ''),
      cardType: input.cardType,
      planner: input.planner,
      agent: input.agent,
      skill: input.skill,
      route: input.route,
      toolCalls: input.toolCalls,
      degraded: input.degraded,
      firstTokenMs: input.firstTokenMs,
      totalMs: input.totalMs,
    };
    this.append(record);
    return record;
  }

  /** 记录一次评价。traceId 必须已存在（调用方先校验，避免脏数据）。 */
  appendFeedback(input: {
    traceId: string;
    rating: Rating;
    reasons: FeedbackReason[];
    comment?: string;
    correctedAnswer?: string;
    channel?: string;
    ts?: number;
  }): FeedbackRecord {
    const record: FeedbackRecord = {
      kind: 'feedback',
      id: createId('fb'),
      traceId: input.traceId,
      ts: input.ts ?? Date.now(),
      rating: input.rating,
      reasons: input.reasons,
      comment: trim(input.comment ? redact(input.comment) : undefined, 500),
      correctedAnswer: trim(
        input.correctedAnswer ? redact(input.correctedAnswer) : undefined,
        2000,
      ),
      channel: input.channel ?? 'web',
    };
    this.append(record);
    return record;
  }

  private append(record: StoredRecord): void {
    // 单行写一条：Node 对 <4KB 的 appendFileSync 在本地文件系统上是原子的，
    // 单进程也保证了同进程内不交错。多实例部署时改 SQLite 或对象存储，别指望 NFS。
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    this.cache = null;
  }

  /** 读全量并折叠。按 traceId 归并，后写的记录覆盖先写的。 */
  private load(): Map<string, TraceView> {
    if (!existsSync(this.file)) {
      this.cache = { mtimeMs: 0, size: 0, views: new Map() };
      return this.cache.views;
    }
    const stat = statSync(this.file);
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.views;
    }

    const views = new Map<string, TraceView>();
    const raw = readFileSync(this.file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: StoredRecord;
      try {
        record = JSON.parse(line) as StoredRecord;
      } catch {
        // 半行 / 坏行不该拖垮整个读取——跳过它，其余数据仍然可用
        continue;
      }
      if (record.kind === 'turn') {
        const prev = views.get(record.traceId);
        views.set(record.traceId, {
          turn: record,
          feedback: prev?.feedback,
          feedbackCount: prev?.feedbackCount ?? 0,
        });
      } else if (record.kind === 'feedback') {
        const prev = views.get(record.traceId);
        if (!prev) continue; // 孤立的评价（turn 丢了）不参与折叠
        views.set(record.traceId, {
          ...prev,
          feedback: record,
          feedbackCount: prev.feedbackCount + 1,
        });
      }
    }

    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, views };
    return views;
  }

  find(traceId: string): TraceView | undefined {
    return this.load().get(traceId);
  }

  /** 最近的轮次，按时间倒序。 */
  recent(limit = 20, filter?: { rating?: Rating | 'none' }): TraceView[] {
    const all = [...this.load().values()];
    const filtered = filter?.rating
      ? all.filter((v) =>
          filter.rating === 'none' ? !v.feedback : v.feedback?.rating === filter.rating,
        )
      : all;
    return filtered.sort((a, b) => b.turn.ts - a.turn.ts).slice(0, Math.max(1, limit));
  }

  all(): TraceView[] {
    return [...this.load().values()].sort((a, b) => a.turn.ts - b.turn.ts);
  }

  stats(): FeedbackStats {
    const views = this.all();
    const rated = views.filter((v) => v.feedback);
    const up = rated.filter((v) => v.feedback?.rating === 'up').length;
    const down = rated.length - up;

    const reasonCount = new Map<FeedbackReason, number>();
    for (const v of rated) {
      if (v.feedback?.rating !== 'down') continue;
      for (const r of v.feedback.reasons) {
        reasonCount.set(r, (reasonCount.get(r) ?? 0) + 1);
      }
    }

    const byAgent = new Map<string, { turns: number; up: number; down: number }>();
    for (const v of views) {
      const key = v.turn.agent ?? v.turn.planner ?? 'unknown';
      const bucket = byAgent.get(key) ?? { turns: 0, up: 0, down: 0 };
      bucket.turns += 1;
      if (v.feedback?.rating === 'up') bucket.up += 1;
      if (v.feedback?.rating === 'down') bucket.down += 1;
      byAgent.set(key, bucket);
    }

    return {
      turns: views.length,
      rated: rated.length,
      up,
      down,
      satisfaction: rated.length ? up / rated.length : 0,
      ratedRate: views.length ? rated.length / views.length : 0,
      corrected: rated.filter((v) => v.feedback?.correctedAnswer).length,
      degraded: views.filter((v) => v.turn.degraded).length,
      reasons: [...reasonCount.entries()]
        .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason], count }))
        .sort((a, b) => b.count - a.count),
      byAgent: [...byAgent.entries()]
        .map(([agent, b]) => ({
          agent,
          ...b,
          rated: b.up + b.down,
          satisfaction: b.up + b.down ? b.up / (b.up + b.down) : 0,
        }))
        .sort((a, b) => b.turns - a.turns),
    };
  }
}

export function createTraceStore(dir: string): TraceStore {
  return new TraceStore(dir);
}
