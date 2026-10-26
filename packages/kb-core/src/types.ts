/**
 * kb-core 的四个可替换契约。
 *
 * 设计要点：Embedder / VectorStore / Reranker 三者互不知道对方实现，
 * 换 Qdrant -> pgvector、换 bge-m3 -> Qwen3-Embedding，只换实现不改编排。
 * 这是 ADR-003「检索内核自研、存储与模型可替换」的落点。
 */

/** 切片的统一形态：payload 里带完整定位信息，回答才能挂引用链 */
export interface Chunk {
  /** 全局唯一，Qdrant point id（uuid v4 字符串） */
  id: string;
  /** 文档稳定标识，重建索引时按此删除旧点 */
  documentId: string;
  /** 知识库命名空间（个人库 personal / 客户租户 id），检索隔离用 */
  namespace: string;
  /** 切片正文 */
  text: string;
  /** 原始位置：文件名、页码/行号、字符偏移，用于引用回溯 */
  source: {
    title: string;
    uri?: string;
    page?: number;
    offset?: number;
    headingPath?: string;
  };
  /** 入库时间戳（ms） */
  createdAt: number;
}

/** 命中结果 = 切片 + 两路分数（向量分 / 重排分），便于排查效果 */
export interface RetrievedChunk {
  chunk: Chunk;
  /** 向量检索分数（Cosine，0~1 区间近似） */
  score: number;
  /** 重排分数；未启用或降级时为 undefined */
  rerankScore?: number;
}

export interface Embedder {
  /** 模型指纹，参与 collection 命名；换模型必须换 collection */
  readonly modelId: string;
  /** 向量维度，必须与 collection 的 size 严格一致 */
  readonly dimensions: number;
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
}

export interface Reranker {
  readonly modelId: string;
  /** 返回按相关性降序的 [原始下标, 分数] */
  rerank(
    query: string,
    documents: string[],
    opts?: { topN?: number; signal?: AbortSignal },
  ): Promise<Array<{ index: number; score: number }>>;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  /** Qdrant payload：Chunk 的扁平化投影（text 也存一份，检索后免二次查库） */
  payload: Record<string, unknown>;
}

export interface ScoredPoint {
  id: string;
  score: number;
  payload: Record<string, unknown> | null;
}

export interface VectorStore {
  /** 幂等：不存在则建；已存在且维度不符则抛错（绝不静默写坏数据） */
  ensureCollection(name: string, dimensions: number): Promise<void>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(
    collection: string,
    vector: number[],
    options: { topK: number; namespace?: string },
  ): Promise<ScoredPoint[]>;
  /** 按文档重建：先删后写，避免切片改版后残留脏点 */
  deleteByDocument(collection: string, documentId: string): Promise<void>;
  count(collection: string): Promise<number>;
}
