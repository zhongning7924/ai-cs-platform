/**
 * 硅基流动（SiliconFlow）Embedding + Rerank 客户端。
 *
 * 选它的理由（ADR-004）：OpenAI 兼容协议、国内直连、BAAI/bge-m3 与
 * bge-reranker-v2-m3 免费档可用，把 0.4~1.8G 的模型内存从远程盒子上省掉。
 *
 * 三个必须防的坑，都写在这里：
 * 1. 模型 ID 的 `Pro/` 前缀是收费版，误用会直接扣费 —— 构造时拦截；
 * 2. 免费档有 RPM/TPM 限制，批量入库必须限批 + 429 退避，否则一半数据静默丢弃；
 * 3. bge-m3 固定 1024 维，返回维度与声明的 dimensions 不符时立即报错，
 *    绝不让脏向量写进 collection（维度错配是向量库最难排查的故障）。
 */

import type { Embedder, Reranker } from './types.js';

const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';

export const BGE_M3_MODEL = 'BAAI/bge-m3';
export const BGE_M3_DIMENSIONS = 1024;
export const BGE_RERANKER_MODEL = 'BAAI/bge-reranker-v2-m3';

export interface SiliconFlowOptions {
  apiKey?: string;
  baseUrl?: string;
  /** 每批条数；免费档建议 <= 32 */
  batchSize?: number;
  /** 请求超时（ms） */
  timeoutMs?: number;
  /** 失败重试次数（仅对 429/5xx/网络错误） */
  maxRetries?: number;
}

interface PostOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
}

function resolveApiKey(explicit?: string): string {
  // EMBEDDING_* 优先：私有化时 embedding 常在内网自建网关，与 LLM 的 key 不同一家
  const key = explicit ?? process.env.EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY;
  if (!key) {
    throw new Error(
      '[kb-core] 缺少 EMBEDDING_API_KEY（或 SILICONFLOW_API_KEY）。' +
        '硅基流动用户到 https://cloud.siliconflow.cn/account/ak 领免费 key；' +
        '私有化部署填自建 embedding 网关的 key。',
    );
  }
  return key;
}

/** Pro/ 前缀是付费模型；免费档只用 BAAI/ 开头 */
export function assertFreeModel(model: string): void {
  if (/^Pro\//i.test(model)) {
    throw new Error(
      `[kb-core] 模型 "${model}" 带 Pro/ 前缀，属于收费版，免费额度不覆盖。请使用 "${model.replace(/^Pro\//i, '')}"。`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson<T>(url: string, body: unknown, opts: PostOptions): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) return (await res.json()) as T;

      const detail = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new Error(`[kb-core] ${url} 返回 ${res.status}: ${detail.slice(0, 300)}`);
      if (!retryable) throw lastError;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // 外部主动取消，不再重试
      if (opts.signal?.aborted) throw new Error(`[kb-core] 请求已取消: ${e.message}`);
      // 带上底层错误码（如 ECONNRESET / ETIMEDOUT），网络问题一眼可辨
      const cause = (e as Error & { cause?: { code?: string } }).cause;
      const detail = cause?.code ? `${e.message} [${cause.code}]` : e.message;
      lastError = new Error(
        detail.includes('fetch failed')
          ? `[kb-core] 网络请求失败（${cause?.code ?? 'fetch failed'}）——本机代理/TUN 可能拦截了 api.siliconflow.cn，请在代理软件将其设为直连 DIRECT`
          : detail,
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    if (attempt < opts.maxRetries) {
      // 指数退避 + 抖动，避免同一时刻重试撞限流
      await sleep(400 * 2 ** attempt + Math.random() * 200);
    }
  }

  throw lastError ?? new Error('[kb-core] 未知请求失败');
}

export class SiliconFlowEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly opts: PostOptions;
  private readonly apiKey: string;

  constructor(
    options: SiliconFlowOptions & { model?: string; dimensions?: number } = {},
  ) {
    this.modelId = options.model ?? BGE_M3_MODEL;
    this.dimensions = options.dimensions ?? BGE_M3_DIMENSIONS;

    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = (
      options.baseUrl ??
      process.env.EMBEDDING_BASE_URL ??
      process.env.SILICONFLOW_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');

    // 「Pro/ 是收费模型」是硅基流动免费档的规则。自建网关没有这个概念，
    // 无条件套用会把客户自己部署的 Pro/xxx 直接判死，所以只在硅基流动域名下检查。
    if (/siliconflow/i.test(this.baseUrl)) assertFreeModel(this.modelId);

    this.batchSize = options.batchSize ?? 32;
    this.opts = {
      apiKey: this.apiKey,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 3,
    };
  }

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (!texts.length) return [];
    const vectors: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await postJson<{
        data: Array<{ index: number; embedding: number[] }>;
      }>(
        `${this.baseUrl}/embeddings`,
        {
          model: this.modelId,
          input: batch,
          // 显式声明 float，避免部分网关默认返回 base64
          encoding_format: 'float',
        },
        { ...this.opts, signal: opts.signal },
      );

      // 服务端不保证返回顺序，按 index 归位
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) {
        if (item.embedding.length !== this.dimensions) {
          throw new Error(
            `[kb-core] 向量维度不符：模型 ${this.modelId} 返回 ${item.embedding.length} 维，` +
              `期望 ${this.dimensions} 维。collection 的 size 必须与模型一致，否则必须重建索引。`,
          );
        }
        vectors.push(item.embedding);
      }
    }

    if (vectors.length !== texts.length) {
      throw new Error(`[kb-core] 向量条数不符：输入 ${texts.length}，返回 ${vectors.length}`);
    }
    return vectors;
  }
}

export class SiliconFlowReranker implements Reranker {
  readonly modelId: string;

  private readonly baseUrl: string;
  private readonly opts: PostOptions;

  constructor(options: SiliconFlowOptions & { model?: string } = {}) {
    this.modelId = options.model ?? BGE_RERANKER_MODEL;

    this.baseUrl = (
      options.baseUrl ??
      process.env.RERANK_BASE_URL ??
      process.env.EMBEDDING_BASE_URL ??
      process.env.SILICONFLOW_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');

    if (/siliconflow/i.test(this.baseUrl)) assertFreeModel(this.modelId);

    this.opts = {
      apiKey: resolveApiKey(options.apiKey ?? process.env.RERANK_API_KEY),
      timeoutMs: options.timeoutMs ?? 20_000,
      maxRetries: options.maxRetries ?? 2,
    };
  }

  async rerank(
    query: string,
    documents: string[],
    opts: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<Array<{ index: number; score: number }>> {
    if (!documents.length) return [];

    const res = await postJson<{
      results: Array<{ index: number; relevance_score: number }>;
    }>(
      `${this.baseUrl}/rerank`,
      {
        model: this.modelId,
        query,
        documents,
        top_n: Math.min(opts.topN ?? documents.length, documents.length),
        return_documents: false,
      },
      { ...this.opts, signal: opts.signal },
    );

    return res.results
      .map((r) => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => b.score - a.score);
  }
}
