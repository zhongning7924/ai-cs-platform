/**
 * 转人工触发判定（ADR-0011）。
 *
 * 刻意只用规则，不上模型判断「该不该转人工」：
 *   · 转人工是兜底路径，必须 100% 可预测——模型抽风时正是最需要它稳定的时刻
 *   · 用户说「转人工」就必须转，不能被模型劝回去继续聊
 *   · 规则误判的代价是「多转一次」，模型误判的代价是「该转没转，客户炸了」
 */

import { isTransferRequest } from '@cs/faq-engine';
import type { HandoffReason } from './types.js';

/**
 * 敏感升级：这些话继续让 AI 答，风险大于收益。
 * 注意和 isTransferRequest 的分工——那边是「用户想找个人」，这里是
 * 「用户开始施压」，后者往往不会说「转人工」三个字。
 */
const SENSITIVE_PATTERN =
  /12315|消协|曝光|起诉|律师函|报警|欺诈|骗子|骗人|赔偿|赔钱|退款不到账|退款没到|要个说法|找你们领导/;

/**
 * 智能体自己承认没答好的信号。
 * 与 planner 的兜底文案一一对应——改了那边的话术，这里必须同步，
 * 所以两处都放在同一个仓库、同一个 review 视野里。
 */
const FAILURE_MARKERS = [
  '还需要确认一下',
  '暂时没有生成有效回答',
  '我还需要更多信息',
  '暂无相关资料',
  '刚才处理出现了点问题',
];

/**
 * 进消息就先判：命中就不该再花一次 LLM 调用，也不该让用户等模型把话说完。
 *
 * 顺序上**敏感在前**：用户说「不解决我就打 12315 投诉」时两条都命中，
 * 但它是升级场景，不是普通转接。标成「用户主动要求」会让主管漏掉最该看的那单。
 */
export function detectImmediate(question: string): HandoffReason | null {
  if (SENSITIVE_PATTERN.test(question)) return 'sensitive';
  if (isTransferRequest(question)) return 'user_request';
  return null;
}

/**
 * 答完之后再判：这条回答是不是「看起来答了、其实没解决」。
 *
 * degraded 是后端自报的降级标记，比文案匹配可靠，优先信它。
 * 文案匹配是补充——有些兜底不走 degraded 分支。
 */
export function looksUnresolved(answer: string | undefined, degraded: boolean): boolean {
  if (degraded) return true;
  if (!answer || !answer.trim()) return true;
  return FAILURE_MARKERS.some((marker) => answer.includes(marker));
}
