/**
 * 知识库编排层：文档 -> 切片 -> 向量 -> 存储 -> 检索 -> 重排。
 *
 * 这一层是「自研内核」的部分，也是底座资产：切片模板、命名空间隔离、
 * 阈值策略、重排降级规则都在这里，不写在任何第三方产品里。
 */

import { randomUUID } from 'node:crypto';
import { chunkText, type ChunkOptions } from './chunker.js';
import type { Chunk, Embedder, Reranker, RetrievedChunk, VectorStore } from './types.js';

export interface KbDocument {
  /** 稳定 id（建议用文件路径 hash 或业务主键），重建时按此覆盖 */
  id: string;
  /** 文档标题，用于引用展示 */
  title: string;
  /** markdown / 纯文本正文 */
  text: string;
  /** 溯源地址：本地路径、URL 或 oss:// 前缀 */
  uri?: string;
  /** 起始页码（PDF 拆页入库时用） */
  page?: number;
  /** 业务附加字段（分类、作者、生效日期），原样进 payload，可做过滤 */
  metadata?: Record<string, string | number | boolean>;
}

export interface KnowledgeBaseOptions {
  embedder: Embedder;
  store: VectorStore;
  /** 可选：不传则纯向量检索 */
  reranker?: Reranker;
  /** 默认由模型指纹推导，例如 kb_bge_m3_1024 */
  collection?: string;
  /** 默认 personal；客户租户用 tenant id，物理隔离靠它 */
  namespace?: string;
  chunk?: ChunkOptions;
  /** 向量召回候选数（重排前的池子） */
  candidateK?: number;
}

export interface IngestResult {
  documentId: string;
  chunks: number;
  chars: number;
  durationMs: number;
}

export interface RetrieveOptions {
  topK?: number;
  /** 向量分下限，低于此值直接丢（防止"最不相关的一条"也被当成答案） */
  minVectorScore?: number;
  /** 重排分下限，仅启用重排时生效 */
  minRerankScore?: number;
  signal?: AbortSignal;
}

export interface RetrieveResult {
  hits: RetrievedChunk[];
  /** 是否走了重排；降级时 reranked=false 且 degraded=true */
  reranked: boolean;
  degraded: boolean;
  latencyMs: number;
}

/** 模型指纹进 collection 名：换模型/换维度天然分家，不会写坏旧索引 */
export function buildCollectionName(embedder: Pick<Embedder, 'modelId' | 'dimensions'>): string {
  const slug = embedder.modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `kb_${slug}_${embedder.dimensions}`;
}

/** Chunk -> Qdrant payload（扁平，可过滤字段都提到顶层） */
function toPayload(chunk: Chunk): Record<string, unknown> {
  return {
    documentId: chunk.documentId,
    namespace: chunk.namespace,
    text: chunk.text,
    title: chunk.source.title,
    uri: chunk.source.uri,
    page: chunk.source.page,
    offset: chunk.source.offset,
    headingPath: chunk.source.headingPath,
    createdAt: chunk.createdAt,
  };
}

function fromPayload(id: string, payload: Record<string, unknown> | null): Chunk | null {
  if (!payload || typeof payload.text !== 'string') return null;
  return {
    id,
    documentId: String(payload.documentId ?? ''),
    namespace: String(payload.namespace ?? ''),
    text: payload.text,
    source: {
      title: String(payload.title ?? ''),
      uri: payload.uri === undefined ? undefined : String(payload.uri),
      page: typeof payload.page === 'number' ? payload.page : undefined,
      offset: typeof payload.offset === 'number' ? payload.offset : undefined,
      headingPath: payload.headingPath === undefined ? undefined : String(payload.headingPath),
    },
    createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : 0,
  };
}

export class KnowledgeBase {
  readonly collection: string;
  readonly namespace: string;

  private readonly embedder: Embedder;
  private readonly store: VectorStore;
  private readonly reranker?: Reranker;
  private readonly chunkOptions: ChunkOptions;
  private readonly candidateK: number;
  private ready?: Promise<void>;

  constructor(options: KnowledgeBaseOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.reranker = options.reranker;
    this.collection = options.collection ?? buildCollectionName(options.embedder);
    this.namespace = options.namespace ?? 'personal';
    this.chunkOptions = options.chunk ?? {};
    this.candidateK = options.candidateK ?? 20;
  }

  /** 首次操作前建 collection，只做一次 */
  private init(): Promise<void> {
    this.ready ??= this.store.ensureCollection(this.collection, this.embedder.dimensions);
    return this.ready;
  }

  async ingest(documents: KbDocument[]): Promise<IngestResult[]> {
    await this.init();
    const results: IngestResult[] = [];

    for (const doc of documents) {
      const started = Date.now();
      const pieces = chunkText(doc.text, this.chunkOptions);
      if (!pieces.length) {
        results.push({ documentId: doc.id, chunks: 0, chars: 0, durationMs: Date.now() - started });
        continue;
      }

      const now = Date.now();
      const chunks: Chunk[] = pieces.map((piece) => ({
        id: randomUUID(),
        documentId: doc.id,
        namespace: this.namespace,
        // 标题必须拼进正文：markdown 按标题切段后，正文里只有「- 价格：2999 元」，
        // 主语（云朵沙发 三人位）留在了 headingPath 里。不拼回去，任何带型号的提问
        // 都检索不到自己的片段——「三人位多少钱」会 0 命中。
        text: piece.headingPath ? `${piece.headingPath}\n${piece.text}` : piece.text,
        source: {
          title: doc.title,
          uri: doc.uri,
          page: doc.page,
          offset: piece.offset,
          headingPath: piece.headingPath,
        },
        createdAt: now,
      }));

      const vectors = await this.embedder.embed(chunks.map((c) => c.text));

      // 先删后写：同一文档重入不会留下旧切片（切片策略调整后尤其重要）
      await this.store.deleteByDocument(this.collection, doc.id);
      await this.store.upsert(
        this.collection,
        chunks.map((chunk, i) => ({ id: chunk.id, vector: vectors[i], payload: toPayload(chunk) })),
      );

      results.push({
        documentId: doc.id,
        chunks: chunks.length,
        chars: doc.text.length,
        durationMs: Date.now() - started,
      });
    }

    return results;
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrieveResult> {
    const started = Date.now();
    const topK = options.topK ?? 5;
    const minVectorScore = options.minVectorScore ?? 0;
    const minRerankScore = options.minRerankScore ?? 0;

    await this.init();

    const [queryVector] = await this.embedder.embed([query], { signal: options.signal });
    const candidates = await this.store.search(this.collection, queryVector, {
      topK: Math.max(this.candidateK, topK),
      namespace: this.namespace,
    });

    const scored = candidates
      .map((point) => {
        const chunk = fromPayload(point.id, point.payload);
        return chunk ? { chunk, score: point.score } : null;
      })
      .filter((x): x is RetrievedChunk => x !== null)
      .filter((x) => x.score >= minVectorScore);

    // 重排失败不阻断主链路：降级为向量序，日志可查（ADR-001 可用性红线）
    if (this.reranker && scored.length > 1) {
      try {
        const reranked = await this.reranker.rerank(
          query,
          scored.map((x) => x.chunk.text),
          { topN: scored.length, signal: options.signal },
        );

        const merged = reranked
          .map(({ index, score }) => ({ ...scored[index], rerankScore: score }))
          .filter((x) => x.rerankScore >= minRerankScore);

        return {
          hits: merged.slice(0, topK),
          reranked: true,
          degraded: false,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        console.warn(
          `[kb-core] 重排失败，降级为向量排序：${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          hits: scored.slice(0, topK),
          reranked: false,
          degraded: true,
          latencyMs: Date.now() - started,
        };
      }
    }

    return {
      hits: scored.slice(0, topK),
      reranked: false,
      degraded: false,
      latencyMs: Date.now() - started,
    };
  }

  async stats(): Promise<{ collection: string; namespace: string; points: number; dimensions: number }> {
    await this.init();
    return {
      collection: this.collection,
      namespace: this.namespace,
      points: await this.store.count(this.collection),
      dimensions: this.embedder.dimensions,
    };
  }
}
