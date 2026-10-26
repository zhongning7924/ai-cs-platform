/**
 * 从对话记录生成评测样本（ADR-0009）。
 *
 * 这是闭环的最后一段，也是最容易被做假的一段。三条硬规矩：
 *
 * 1. **没标注的样本不参与打分。**
 *    把「模型自己答的」当期望答案再考模型，分数必然接近满分——这是自欺欺人。
 *    unlabeled 只用来做分布统计（问题类型占比、工具调用率、降级率），不进评测集。
 *
 * 2. **用户认可的答案只算半信样本（weight 0.5）。**
 *    👍 只证明"没出错"，不证明"最优"；用户没义务替你挑毛病。
 *    真正的高价值样本是「👎 + 写出正确答案」，那才是人类标注。
 *
 * 3. **能自动抽的事实必须零假阳。**
 *    只抽「数字 + 单位 / 单号 / 日期」这类机器不会看错的实体。
 *    不去猜「已签收」这种业务状态词——猜错一次，整套指标就没人信了。
 */

import type { TraceView } from './store.js';

export type SampleLabel = 'human_corrected' | 'human_rejected' | 'bot_accepted' | 'unlabeled';

export interface EvalSample {
  id: string;
  /** 评测输入 */
  message: string;
  group: string;
  intent: string;
  /** 期望调用的工具；null 表示「不该调任何工具」；undefined 表示未标注 */
  expect_tool?: string | null;
  expect_card?: string | null;
  /** 必须出现的事实（零假阳抽取） */
  must_contain: string[];
  label: SampleLabel;
  /** 参与统计的权重：人工标注 1.0，自举样本 0.5 */
  weight: number;
  traceId: string;
  note?: string;
  meta: {
    ts: number;
    agent?: string;
    skill?: string;
    route?: string;
    toolCalls: string[];
    cardType?: string;
    degraded: boolean;
  };
}

const FACT_PATTERNS: RegExp[] = [
  /(?:CS|SF|JD)\d{4,}/g, // 单号
  /\d{4}-\d{2}-\d{2}/g, // 日期
  /\d+(?:\.\d+)?\s*(?:个工作日|元|块|折|天|小时|分钟|个|件|台|人)/g, // 数量 + 单位
];

/** 抽取可机械核验的事实。同一文本里重复出现只留一个。 */
export function extractFacts(text: string): string[] {
  const found = new Set<string>();
  for (const re of FACT_PATTERNS) {
    for (const m of text.matchAll(re)) {
      found.add(m[0].replace(/\s+/g, ' ').trim());
    }
  }
  return [...found].slice(0, 8);
}

function labeled(view: TraceView): SampleLabel {
  const fb = view.feedback;
  if (!fb) return 'unlabeled';
  if (fb.rating === 'up') return 'bot_accepted';
  return fb.correctedAnswer ? 'human_corrected' : 'human_rejected';
}

const WEIGHTS: Record<SampleLabel, number> = {
  human_corrected: 1,
  human_rejected: 1,
  bot_accepted: 0.5,
  unlabeled: 0,
};

/** 单条对话 → 评测样本。 */
export function toSample(view: TraceView): EvalSample {
  const { turn, feedback } = view;
  const label = labeled(view);
  const weight = WEIGHTS[label];

  // 参考答案：人工修正 > 用户认可的原答案。👎 且没写正确答案时，我们只知道「错了」，
  // 不知道「对的是什么」——这种样本只能验工具选择，验不了文案。
  const reference =
    label === 'human_corrected'
      ? (feedback?.correctedAnswer ?? '')
      : label === 'bot_accepted'
        ? turn.answer
        : '';

  const sample: EvalSample = {
    id: `fb_${turn.traceId}`,
    message: turn.question,
    group: 'feedback',
    intent: label === 'human_corrected' || label === 'human_rejected' ? '回归' : '抽样',
    must_contain: extractFacts(reference),
    label,
    weight,
    traceId: turn.traceId,
    meta: {
      ts: turn.ts,
      agent: turn.agent,
      skill: turn.skill,
      route: turn.route,
      toolCalls: turn.toolCalls,
      cardType: turn.cardType,
      degraded: turn.degraded,
    },
  };

  // 期望工具只在「信号明确」时给，宁可留空也不要制造假标签：
  //   ① 用户认可 + 确实调了工具 → 认为这次调用是对的
  //   ② 用户认可 + 没调工具 + 不是闲聊场景 → 认为不该调
  // 差评样本一律不推导期望工具：差评恰恰说明这次调用有问题，
  // 拿它当答案是反着学。
  if (label === 'bot_accepted') {
    if (turn.toolCalls.length > 0) {
      sample.expect_tool = turn.toolCalls[0];
    } else if (turn.cardType !== 'confirm') {
      sample.expect_tool = null;
    }
    if (turn.cardType) sample.expect_card = turn.cardType;
  }

  if (label === 'human_rejected') {
    const reasons = feedback?.reasons ?? [];
    sample.note = reasons.join(',');
    if (reasons.includes('missing_tool')) {
      // 用户说「该做没做」：如果这轮真没调工具，那期望工具就是缺的那个（未知），
      // 只能标记待标注；如果调了还被告状，说明调错了，同样待标注。
      sample.note = `${sample.note}|needs_annotation`;
    }
  }

  if (label === 'human_corrected') {
    sample.note = (feedback?.reasons ?? []).join(',') || undefined;
  }

  return sample;
}

export function toSamples(
  views: TraceView[],
  options: { includeUnlabeled?: boolean } = {},
): EvalSample[] {
  const samples = views.map(toSample);
  return options.includeUnlabeled ? samples : samples.filter((s) => s.label !== 'unlabeled');
}

export function toJsonl(samples: EvalSample[]): string {
  return samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : '');
}

/** 导出文件名带日期，方便归档和比对两次导出之间多了什么。 */
export function datasetFileName(prefix = 'feedback-dataset'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.jsonl`;
}
