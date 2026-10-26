import {
  FAQ_ITEMS,
  FALLBACK_ANSWER,
  TRANSFER_TO_HUMAN_ANSWER,
  isTransferRequest,
  matchFaq,
} from '@cs/faq-engine';
import type { CardPayload } from '@cs/protocol';

export interface BotReply {
  text: string;
  card?: CardPayload;
  matched: boolean;
  confidence: number;
  intent: string;
}

/**
 * 规则通道（护栏①，ADR-0006）：转人工意图 + FAQ 命中直达，口径 100% 可控。
 * 未命中返回 matched=false，由网关交给 AgentRuntime（智能体通道）。
 * KB 语义检索已从"固定步骤"升级为智能体工具 kb_search（见 ./agent.ts）。
 */
export function generateReply(question: string): BotReply {
  if (isTransferRequest(question)) {
    return {
      text: TRANSFER_TO_HUMAN_ANSWER,
      matched: true,
      confidence: 1,
      intent: 'transfer_human',
    };
  }
  const hit = matchFaq(question);
  if (hit) {
    return {
      text: hit.faq.answer,
      card: hit.faq.card,
      matched: true,
      confidence: Number(hit.score.toFixed(2)),
      intent: hit.faq.id,
    };
  }
  return { text: FALLBACK_ANSWER, matched: false, confidence: 0, intent: 'fallback' };
}

/**
 * 模拟 LLM 流式吐字（规则通道路径用；智能体通道的流式来自真实规划器）。
 * 通过 MOCK_STREAM_DELAY_MS 环境变量可调（设为 0 可加速测试）。
 */
export async function* streamText(
  text: string,
  options: { chunkSize?: number; delayMs?: number } = {},
): AsyncGenerator<string> {
  const chunkSize = options.chunkSize ?? 4;
  const delayMs =
    options.delayMs ?? Number(process.env.MOCK_STREAM_DELAY_MS ?? 24);
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export { FAQ_ITEMS };
