/**
 * Qdrant REST 客户端（零 SDK 依赖，只用 fetch）。
 *
 * 为什么不用官方 SDK：kb-core 要在 Node / Bun / 边缘运行时都能跑，
 * Qdrant 的 REST 契约极稳（Cloud 与自建完全一致），手写 200 行比引依赖更可控。
 *
 * 兼容两类部署：
 * - Qdrant Cloud（https://xxx.cloud.qdrant.io，api-key 鉴权）
 * - 自建（http://127.0.0.1:6333，无鉴权）—— 换 URL 即可，同一份代码
 */

import type { ScoredPoint, VectorPoint, VectorStore } from './types.js';

export interface QdrantOptions {
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 单次 upsert 点数，过大容易触发请求体限制 */
  upsertBatchSize?: number;
}

interface QdrantResponse<T> {
  result: T;
  status: string;
  time?: number;
}

export class QdrantStore implements VectorStore {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly upsertBatchSize: number;

  constructor(options: QdrantOptions = {}) {
    const url = options.url ?? process.env.QDRANT_URL;
    if (!url) {
      throw new Error(
        '[kb-core] 缺少 QDRANT_URL。到 https://cloud.qdrant.io 免费开通（无需信用卡），' +
          '集群地址形如 https://xxxx.aws.cloud.qdrant.io',
      );
    }
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env.QDRANT_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.upsertBatchSize = options.upsertBatchSize ?? 100;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`[kb-core] Qdrant ${init.method} ${path} 返回 ${res.status}: ${text.slice(0, 400)}`);
    }
    if (!text) return undefined as T;
    return (JSON.parse(text) as QdrantResponse<T>).result;
  }

  /** 读取 collection 的向量维度；不存在返回 null */
  async getDimensions(collection: string): Promise<number | null> {
    try {
      const result = await this.request<{
        config: { params: { vectors?: { size?: number } | Record<string, { size?: number }> } };
      }>(`/collections/${encodeURIComponent(collection)}`);

      const vectors = result.config?.params?.vectors;
      if (!vectors) return null;
      if (typeof (vectors as { size?: number }).size === 'number') {
        return (vectors as { size: number }).size;
      }
      const named = Object.values(vectors as Record<string, { size?: number }>);
      return named[0]?.size ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('404')) return null;
      throw err;
    }
  }

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    const existing = await this.getDimensions(name);

    if (existing === null) {
      await this.request(`/collections/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: {
          vectors: {
            size: dimensions,
            distance: 'Cosine',
          },
          // 免费层磁盘 4G > 内存 1G：向量落盘能多存 3~4 倍，代价是查询略慢。
          // 个人库先放内存（默认），实测瓶颈再打开。
          // on_disk_payload: true,
        },
      });
    } else if (existing !== dimensions) {
      throw new Error(
        `[kb-core] collection "${name}" 维度为 ${existing}，当前模型输出 ${dimensions} 维。` +
          `换 embedding 模型必须换 collection 名（推荐命名含模型指纹，如 kb_bge_m3_1024），` +
          `并全量重建索引——混写会让所有检索结果失真。`,
      );
    }

    // payload 索引：Qdrant 的过滤删除（deleteByDocument）与 namespace 过滤
    // 都要求字段有 keyword 索引，否则返回 400。创建是幂等的，已存在则无操作。
    await this.ensurePayloadIndex(name, 'documentId');
    await this.ensurePayloadIndex(name, 'namespace');
  }

  /** 给字段建 keyword 索引（幂等：索引已存在时 Qdrant 返回成功） */
  private async ensurePayloadIndex(collection: string, field: string): Promise<void> {
    try {
      await this.request(`/collections/${encodeURIComponent(collection)}/index`, {
        method: 'PUT',
        body: { field_name: field, field_schema: 'keyword' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 已存在同名字段索引时不视为错误；其余照常抛出
      if (!message.includes('already exists')) throw err;
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += this.upsertBatchSize) {
      const batch = points.slice(i, i + this.upsertBatchSize);
      await this.request(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        method: 'PUT',
        body: { points: batch },
      });
    }
  }

  async search(
    collection: string,
    vector: number[],
    options: { topK: number; namespace?: string },
  ): Promise<ScoredPoint[]> {
    const body: Record<string, unknown> = {
      vector,
      limit: options.topK,
      with_payload: true,
      with_vector: false,
    };

    if (options.namespace) {
      // 命名空间硬隔离：个人库与客户租户库同 collection 也不串数据
      body.filter = { must: [{ key: 'namespace', match: { value: options.namespace } }] };
    }

    const result = await this.request<Array<{ id: string; score: number; payload: Record<string, unknown> | null }>>(
      `/collections/${encodeURIComponent(collection)}/points/search`,
      { method: 'POST', body },
    );

    return result.map((p) => ({ id: String(p.id), score: p.score, payload: p.payload }));
  }

  async deleteByDocument(collection: string, documentId: string): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: { filter: { must: [{ key: 'documentId', match: { value: documentId } }] } },
    });
  }

  async count(collection: string): Promise<number> {
    const result = await this.request<{ count: number }>(
      `/collections/${encodeURIComponent(collection)}/points/count`,
      { method: 'POST', body: { exact: true } },
    );
    return result.count;
  }

  /** 探活 + 解决 Qdrant Cloud 免费层 7 天不活动挂起的问题（见 README 的 keepalive） */
  async ping(): Promise<boolean> {
    await this.request<boolean>('/collections');
    return true;
  }
}
