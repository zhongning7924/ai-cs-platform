/**
 * 离线编排测试：用确定性假向量 + 内存向量库，验证 ingest/retrieve/降级/隔离，
 * 不依赖 Qdrant 与硅基流动的任何网络调用（CI 可跑）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeBase, buildCollectionName } from '../src/kb.js';
import type {
  Embedder,
  Reranker,
  ScoredPoint,
  VectorPoint,
  VectorStore,
} from '../src/types.js';

/** 字符 bigram 哈希到固定维度：字面越近，cosine 越高 */
class FakeEmbedder implements Embedder {
  readonly modelId = 'fake-tiny';
  readonly dimensions = 64;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(this.dimensions).fill(0);
      const clean = text.replace(/\s+/g, '');
      for (let i = 0; i < clean.length - 1; i += 1) {
        const bigram = clean.slice(i, i + 2);
        let h = 0;
        for (const ch of bigram) h = (h * 31 + ch.charCodeAt(0)) % 100_003;
        vec[h % this.dimensions] += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

class MemoryStore implements VectorStore {
  readonly points = new Map<string, VectorPoint & { collection: string }>();
  readonly collections = new Map<string, number>();

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    const existing = this.collections.get(name);
    if (existing !== undefined && existing !== dimensions) {
      throw new Error(`维度不符: ${existing} vs ${dimensions}`);
    }
    this.collections.set(name, dimensions);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    for (const p of points) this.points.set(p.id, { ...p, collection });
  }

  async search(
    collection: string,
    vector: number[],
    options: { topK: number; namespace?: string },
  ): Promise<ScoredPoint[]> {
    const scored: ScoredPoint[] = [];
    for (const p of this.points.values()) {
      if (p.collection !== collection) continue;
      if (options.namespace && p.payload.namespace !== options.namespace) continue;
      scored.push({ id: p.id, score: cosine(vector, p.vector), payload: p.payload });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }

  async deleteByDocument(collection: string, documentId: string): Promise<void> {
    for (const [id, p] of this.points) {
      if (p.collection === collection && p.payload.documentId === documentId) this.points.delete(id);
    }
  }

  async count(collection: string): Promise<number> {
    return [...this.points.values()].filter((p) => p.collection === collection).length;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const DOCS = [
  {
    id: 'doc-refund',
    title: '退货政策',
    text: '# 退货政策\n七天无理由退货，需保持商品完好，吊牌未剪。\n# 运费\n退货运费由买家承担，质量问题除外。',
  },
  {
    id: 'doc-ship',
    title: '发货说明',
    text: '# 发货时间\n现货商品在付款后 48 小时内发出。\n# 物流查询\n发货后可在订单详情页查看物流单号。',
  },
];

test('ingest 切片入库并可统计', async () => {
  const store = new MemoryStore();
  const kb = new KnowledgeBase({ embedder: new FakeEmbedder(), store, namespace: 'personal' });

  const results = await kb.ingest(DOCS);
  assert.equal(results.length, 2);
  assert.ok(results[0].chunks > 0);

  const stats = await kb.stats();
  assert.equal(stats.points, results.reduce((s, r) => s + r.chunks, 0));
  assert.equal(stats.collection, 'kb_fake_tiny_64');
});

test('retrieve 命中正确文档', async () => {
  const kb = new KnowledgeBase({ embedder: new FakeEmbedder(), store: new MemoryStore() });
  await kb.ingest(DOCS);

  const refund = await kb.retrieve('七天无理由退货');
  assert.equal(refund.reranked, false);
  assert.equal(refund.hits[0].chunk.documentId, 'doc-refund');

  const ship = await kb.retrieve('多久发货');
  assert.equal(ship.hits[0].chunk.documentId, 'doc-ship');
});

test('重排成功后按重排分排序', async () => {
  const reranker: Reranker = {
    modelId: 'fake-reranker',
    async rerank(_query, documents, opts) {
      // 故意反转：让最后一条排第一
      return documents
        .map((_, i) => ({ index: i, score: i / documents.length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts?.topN ?? documents.length);
    },
  };

  const kb = new KnowledgeBase({ embedder: new FakeEmbedder(), store: new MemoryStore(), reranker });
  await kb.ingest(DOCS);

  const result = await kb.retrieve('退货', { topK: 2 });
  assert.equal(result.reranked, true);
  assert.equal(result.degraded, false);
  assert.ok(result.hits[0].rerankScore !== undefined);
  assert.ok(result.hits[0].rerankScore! >= result.hits[1].rerankScore!);
});

test('重排抛错时降级为向量排序，不阻断检索', async () => {
  const brokenReranker: Reranker = {
    modelId: 'broken',
    async rerank() {
      throw new Error('429 rate limited');
    },
  };

  const kb = new KnowledgeBase({
    embedder: new FakeEmbedder(),
    store: new MemoryStore(),
    reranker: brokenReranker,
  });
  await kb.ingest(DOCS);

  const result = await kb.retrieve('退货政策');
  assert.equal(result.degraded, true);
  assert.equal(result.reranked, false);
  assert.equal(result.hits[0].chunk.documentId, 'doc-refund');
});

test('minVectorScore 过滤掉不相关命中', async () => {
  const kb = new KnowledgeBase({ embedder: new FakeEmbedder(), store: new MemoryStore() });
  await kb.ingest(DOCS);

  const result = await kb.retrieve('完全无关的天气问题', { minVectorScore: 0.9 });
  assert.equal(result.hits.length, 0);
});

test('namespace 隔离：个人库检索不到租户库', async () => {
  const store = new MemoryStore();
  const personal = new KnowledgeBase({ embedder: new FakeEmbedder(), store, namespace: 'personal' });
  const tenant = new KnowledgeBase({ embedder: new FakeEmbedder(), store, namespace: 'tenant-a' });

  await personal.ingest([DOCS[0]]);
  await tenant.ingest([DOCS[1]]);

  const p = await personal.retrieve('发货');
  assert.ok(p.hits.every((h) => h.chunk.namespace === 'personal'));
  assert.equal(p.hits.some((h) => h.chunk.documentId === 'doc-ship'), false);
});

test('同一文档重入不产生重复切片', async () => {
  const kb = new KnowledgeBase({ embedder: new FakeEmbedder(), store: new MemoryStore() });
  await kb.ingest([DOCS[0]]);
  const first = (await kb.stats()).points;
  await kb.ingest([DOCS[0]]);
  assert.equal((await kb.stats()).points, first);
});

test('collection 命名带模型指纹与维度', () => {
  assert.equal(buildCollectionName({ modelId: 'BAAI/bge-m3', dimensions: 1024 }), 'kb_baai_bge_m3_1024');
});
