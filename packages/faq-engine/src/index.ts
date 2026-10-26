import { FAQ_ITEMS, FALLBACK_ANSWER, TRANSFER_TO_HUMAN_ANSWER, type FaqItem } from './faq-data.js';

export interface MatchResult {
  faq: FaqItem;
  score: number;
}

export interface MatchOptions {
  threshold?: number;
}

/** 中文停用字（单字，出现在 bigram 中不计入相似度时由权重自然削弱，这里仅用于极端短查询） */
const STOP_CHARS = new Set(['的', '了', '吗', '呢', '啊', '呀', '我', '你', '您', '是', '有', '想', '要']);

/** 分词：英文数字整词 + 中文二元组（bigram），零依赖、可解释 */
export function tokenize(text: string): string[] {
  const t = text.toLowerCase().trim();
  const tokens: string[] = [];
  const words = t.match(/[a-z0-9]+/g) ?? [];
  tokens.push(...words);
  const cn = t.replace(/[^一-龥]/g, '');
  if (cn.length === 1) {
    tokens.push(cn);
  } else {
    for (let i = 0; i < cn.length - 1; i += 1) {
      const bigram = cn.slice(i, i + 2);
      if (bigram.split('').some((c) => STOP_CHARS.has(c))) continue;
      tokens.push(bigram);
    }
  }
  return tokens;
}

/**
 * 评分：关键词命中（高权重）+ 中文 bigram 重叠（低权重），归一化到 0-1。
 * 经验标定：分数 >= 0.45 视为可自动应答，否则走兜底 / 转人工。
 */
export function scoreFaq(question: string, faq: FaqItem): number {
  const qTokens = new Set(tokenize(question));
  let score = 0;
  for (const kw of faq.keywords) {
    if (question.includes(kw)) score += 2;
    else if (qTokens.has(kw)) score += 1.5;
  }
  const faqTokens = tokenize(`${faq.question} ${faq.keywords.join(' ')}`);
  let overlap = 0;
  for (const tk of faqTokens) {
    if (qTokens.has(tk)) overlap += 1;
  }
  score += overlap * 0.3;
  return Math.min(1, score / 4);
}

/** 知识库匹配：返回最佳命中，低于阈值返回 null（由上层走兜底话术） */
export function matchFaq(question: string, options: MatchOptions = {}): MatchResult | null {
  const { threshold = 0.45 } = options;
  let best: MatchResult | null = null;
  for (const faq of FAQ_ITEMS) {
    const score = scoreFaq(question, faq);
    if (!best || score > best.score) best = { faq, score };
  }
  if (!best || best.score < threshold) return null;
  return best;
}

/** 转人工意图识别（规则通道优先于 FAQ 匹配） */
const TRANSFER_PATTERN = /人工|找人|投诉|举报|骂|差评/;

export function isTransferRequest(question: string): boolean {
  return TRANSFER_PATTERN.test(question);
}

export { FAQ_ITEMS, FALLBACK_ANSWER, TRANSFER_TO_HUMAN_ANSWER };
export type { FaqItem };
