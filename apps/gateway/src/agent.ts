/**
 * gateway 智能体组装层（ADR-0006）：
 * 注册三个演示工具（kb_search / query_order / create_ticket），
 * 按 .env 组装 LLM 规划器（缺 key 自动用 Rule 规划器），导出运行时单例。
 *
 * 注意：本模块顶层即读取 process.env，必须先加载 .env（import './env.js' 保证时序）。
 */
import './env.js';
import { FALLBACK_ANSWER } from '@cs/faq-engine';
import {
  KnowledgeBase,
  QdrantStore,
  SiliconFlowEmbedder,
  SiliconFlowReranker,
} from '@cs/kb-core';
import {
  AgentRuntime,
  InMemoryMemory,
  LlmPlanner,
  RulePlanner,
  ToolRegistry,
  type Tool,
} from '@cs/agent';

/* ------------------------------------------------------------------ */
/* 工具 1：kb_search —— 复用 kb-core（密钥未配置时整个工具不注册）       */
/* ------------------------------------------------------------------ */

let kbInstance: KnowledgeBase | null | undefined;
let kbDisabledUntil = 0;

function getKb(): KnowledgeBase | null {
  if (kbInstance !== undefined) return kbInstance;
  kbInstance = null;
  const { QDRANT_URL, QDRANT_API_KEY, SILICONFLOW_API_KEY } = process.env;
  if (!QDRANT_URL || !QDRANT_API_KEY || !SILICONFLOW_API_KEY) {
    console.log('[agent] kb_search 工具未注册（.env 缺少 QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY）');
    return null;
  }
  try {
    kbInstance = new KnowledgeBase({
      embedder: new SiliconFlowEmbedder(),
      store: new QdrantStore(),
      reranker: new SiliconFlowReranker(),
      namespace: process.env.KB_ANSWER_NAMESPACE ?? 'personal',
    });
    console.log(`[agent] kb_search 已注册: collection=${kbInstance.collection} namespace=${kbInstance.namespace}`);
  } catch (err) {
    console.warn(`[agent] KB 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return kbInstance;
}

function buildKbSearchTool(): Tool | null {
  if (!getKb()) return null;
  return {
    name: 'kb_search',
    description:
      '在企业知识库中检索原文片段，适用于所有知识类问题：售后政策、交付/发布规范、内部流程、' +
      '资料内容等（"能不能、怎么、是否可以"类问题都属于此类）。' +
      '注意：查询订单请用 query_order，不要用本工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题，尽量精炼，如"周五发布窗口"' },
      },
      required: ['query'],
    },
    risk: 'low',
    execute: async (args) => {
      const kb = getKb();
      if (!kb) return { observation: '知识库暂不可用。' };
      if (Date.now() < kbDisabledUntil) {
        return { observation: '知识库暂时不可用（刚刚查询失败），请如实告知用户稍后再试。' };
      }
      const query = String(args.query ?? '').trim();
      if (!query) return { observation: '缺少检索关键词。' };

      try {
        const result = await kb.retrieve(query, {
          topK: 3,
          minVectorScore: Number(process.env.KB_MIN_VECTOR_SCORE ?? 0.35),
          minRerankScore: Number(process.env.KB_MIN_RERANK_SCORE ?? 0.25),
        });
        const top = result.hits[0];
        if (!top) {
          return { observation: '知识库中未找到相关内容。请如实告知用户暂无相关资料。' };
        }
        const lines = result.hits.slice(0, 2).map((h) => {
          const src = h.chunk.source;
          const where = src.headingPath ? `${src.title} > ${src.headingPath}` : src.title;
          return `[${where}]\n${h.chunk.text}`;
        });
        const score = top.rerankScore ?? top.score;
        return {
          observation: lines.join('\n---\n'),
          card: {
            type: 'kb_ref',
            title: top.chunk.source.title,
            summary: top.chunk.source.headingPath ?? undefined,
            source: top.chunk.source.uri ?? top.chunk.source.title,
            confidence: Number(score.toFixed(2)),
          },
        };
      } catch (err) {
        kbDisabledUntil = Date.now() + 60_000;
        console.warn(
          `[agent] kb_search 失败，熔断 60s: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { observation: '知识库查询失败。请如实告知用户稍后再试，不要编造答案。' };
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 工具 2：query_order —— mock 订单（P2 换真实订单中台 API）             */
/* ------------------------------------------------------------------ */

const MOCK_ORDERS: Record<
  string,
  { product: string; status: string; courier: string; trackingNo: string; updatedAt: string }
> = {
  CS1001: {
    product: '云朵沙发 三人位（米白）',
    status: '已发货 · 运输中',
    courier: '顺丰速运',
    trackingNo: 'SF1380000123',
    updatedAt: '2026-10-24 18:20',
  },
  CS1002: {
    product: '原木茶几 1.2m',
    status: '已签收',
    courier: '京东物流',
    trackingNo: 'JD7300112234',
    updatedAt: '2026-10-22 11:05',
  },
};

const queryOrderTool: Tool = {
  name: 'query_order',
  description:
    '按订单号查询订单状态与物流。仅当用户明确要求查订单、给出订单号或问物流时才调用；' +
    '知识类、政策类问题禁止调用本工具。',
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '订单号，如 CS1001（必须是 CS 开头的编号，不是问题原文）' },
    },
    required: ['orderId'],
  },
  risk: 'low',
  execute: async (args) => {
    const orderId = String(args.orderId ?? '').trim().toUpperCase();
    const order = MOCK_ORDERS[orderId];
    if (!order) {
      return {
        observation: `订单 ${orderId || '(空)'} 不存在。请让用户核对订单号（示例：CS1001）。`,
      };
    }
    return {
      observation: `订单 ${orderId}：商品 ${order.product}；状态 ${order.status}；${order.courier} ${order.trackingNo}；更新于 ${order.updatedAt}。`,
      card: {
        type: 'order',
        title: `订单 ${orderId}`,
        fields: [
          { label: '商品', value: order.product },
          { label: '状态', value: order.status },
          { label: '物流', value: `${order.courier} ${order.trackingNo}` },
          { label: '更新时间', value: order.updatedAt },
        ],
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 工具 3：create_ticket —— 高风险演示：触发人工确认护栏（ADR-0006 ④）   */
/* ------------------------------------------------------------------ */

const createTicketTool: Tool = {
  name: 'create_ticket',
  description:
    '为用户创建人工跟进工单（投诉、复杂售后、人工处理诉求）。属于高风险操作：' +
    '调用后需要用户明确确认才会真正执行。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '工单标题，概括用户诉求' },
      detail: { type: 'string', description: '补充细节（可选）' },
    },
    required: ['title'],
  },
  risk: 'high',
  execute: async (args) => {
    const title = String(args.title ?? '未命名工单');
    const detail = args.detail ? String(args.detail) : '';
    const ticketId = `TK${Date.now().toString().slice(-6)}`;
    return {
      observation: `工单已创建：编号 ${ticketId}，标题「${title}」${detail ? `，备注：${detail}` : ''}。人工客服将在 30 分钟内联系用户。`,
      card: {
        type: 'ticket',
        title: `工单 ${ticketId}`,
        summary: '已提交，人工客服将跟进处理',
        fields: [
          { label: '标题', value: title },
          { label: '状态', value: '待人工处理' },
          { label: '响应时效', value: '30 分钟内联系' },
        ],
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 组装：规划器（LLM ⇄ Rule 降级）+ 注册表 + 运行时                     */
/* ------------------------------------------------------------------ */

function buildLlmPlanner(): LlmPlanner | null {
  const apiKey = process.env.LLM_API_KEY || process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    console.log('[agent] 规划器 = rule（未配置 LLM_API_KEY / SILICONFLOW_API_KEY）');
    return null;
  }
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.siliconflow.cn/v1';
  const model = process.env.LLM_MODEL || 'Qwen/Qwen2.5-7B-Instruct';
  console.log(`[agent] 规划器 = llm（${model} @ ${baseUrl}），异常时自动降级 rule`);
  return new LlmPlanner({ baseUrl, apiKey, model });
}

const registry = new ToolRegistry();
const kbTool = buildKbSearchTool();
if (kbTool) registry.register(kbTool);
registry.register(queryOrderTool, createTicketTool);

const llmPlanner = buildLlmPlanner();
const rulePlanner = new RulePlanner({ fallbackText: FALLBACK_ANSWER });

export const agentRuntime = new AgentRuntime({
  planner: llmPlanner ?? rulePlanner,
  fallbackPlanner: llmPlanner ? rulePlanner : undefined,
  registry,
  memory: new InMemoryMemory(),
  maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 4),
  logger: (msg) => console.log(`[agent] ${msg}`),
});

export function agentMode(): { planner: string; tools: string[] } {
  return {
    planner: llmPlanner ? (process.env.LLM_MODEL || 'Qwen/Qwen2.5-7B-Instruct') : 'rule',
    tools: registry.specs().map((t) => `${t.name}${t.risk === 'high' ? '(需确认)' : ''}`),
  };
}
