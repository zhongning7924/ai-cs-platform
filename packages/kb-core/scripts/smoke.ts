/**
 * 端到端冒烟：真连 Qdrant Cloud + 硅基流动，验证「embed -> upsert -> search -> rerank」。
 *
 *   npm run smoke -w @cs/kb-core              # 灌 3 篇种子文档并检索 3 个问题
 *   npm run smoke -w @cs/kb-core -- --clean   # 跑完删除本次写入的 smoke 数据
 *   npm run keepalive -w @cs/kb-core          # 只打一次探活（配合 cron 防免费层挂起）
 *
 * 需要的环境变量（缺任意一个会打印清单并以退出码 2 结束，不会半跑）：
 *   QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY
 */

import {
  KnowledgeBase,
  QdrantStore,
  SiliconFlowEmbedder,
  SiliconFlowReranker,
  BGE_M3_DIMENSIONS,
  BGE_M3_MODEL,
  BGE_RERANKER_MODEL,
} from '../src/index.js';

const NAMESPACE = 'smoke';
const flags = new Set(process.argv.slice(2));

const SEED = [
  {
    id: 'smoke-refund',
    title: '退货与退款政策',
    text: [
      '# 退货与退款政策',
      '## 七天无理由',
      '客户签收后七天内可申请无理由退货，商品需保持完好、吊牌未剪、不影响二次销售。',
      '## 退款时效',
      '仓库验收通过后 1 到 3 个工作日原路退回；银行卡支付最长 7 个工作日到账。',
      '## 运费承担',
      '无理由退货运费由买家承担；质量问题导致的退货由商家承担往返运费。',
    ].join('\n'),
  },
  {
    id: 'smoke-shipping',
    title: '发货与物流说明',
    text: [
      '# 发货与物流说明',
      '## 发货时效',
      '现货商品在付款后 48 小时内发出；预售商品按商品页标注时间发货。',
      '## 物流查询',
      '发货后可在订单详情页查看物流单号，或直接询问客服查询最新轨迹。',
      '## 偏远地区',
      '新疆、西藏、内蒙古部分地区不包邮，下单时会提示补差价。',
    ].join('\n'),
  },
  {
    id: 'smoke-invoice',
    title: '发票开具规则',
    text: [
      '# 发票开具规则',
      '## 支持类型',
      '支持开具电子普通发票与增值税专用发票，专票需提供公司名称、税号与开户信息。',
      '## 开具时间',
      '订单完成后 24 小时内开出电子发票，可在订单详情页下载。',
    ].join('\n'),
  },
];

const QUERIES = ['买了三天还能退吗', '什么时候能收到货', '能开专票吗'];

function requireEnv(): Record<string, string> {
  const needed = ['QDRANT_URL', 'QDRANT_API_KEY', 'SILICONFLOW_API_KEY'];
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('\n✗ 缺少环境变量：' + missing.join(', '));
    console.error('\n获取方式：');
    console.error('  QDRANT_URL / QDRANT_API_KEY  → https://cloud.qdrant.io 免费集群（无需信用卡），集群页复制 URL 与 API Key');
    console.error('  SILICONFLOW_API_KEY          → https://cloud.siliconflow.cn/account/ak 新建密钥');
    console.error('\n然后：');
    console.error('  export QDRANT_URL="https://xxxx.aws.cloud.qdrant.io"');
    console.error('  export QDRANT_API_KEY="..."');
    console.error('  export SILICONFLOW_API_KEY="sk-..."');
    console.error('  npm run smoke -w @cs/kb-core\n');
    process.exit(2);
  }
  return {
    QDRANT_URL: process.env.QDRANT_URL!,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY!,
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY!,
  };
}

function ms(n: number): string {
  return `${n}ms`;
}

function preview(text: string, len = 46): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > len ? `${flat.slice(0, len)}…` : flat;
}

async function main(): Promise<void> {
  requireEnv();
  const store = new QdrantStore();

  if (flags.has('--keepalive')) {
    const started = Date.now();
    await store.ping();
    console.log(`✓ Qdrant 探活成功（${ms(Date.now() - started)}），免费层挂起计时已重置`);
    return;
  }

  const embedder = new SiliconFlowEmbedder();
  const reranker = new SiliconFlowReranker();
  const kb = new KnowledgeBase({ embedder, store, reranker, namespace: NAMESPACE });

  console.log('\n=== 配置 ===');
  console.log(`embedding : ${BGE_M3_MODEL} (${BGE_M3_DIMENSIONS} 维)`);
  console.log(`reranker  : ${BGE_RERANKER_MODEL}`);
  console.log(`collection: ${kb.collection}`);
  console.log(`namespace : ${NAMESPACE}`);

  console.log('\n=== 1. 入库（切片 -> 向量 -> upsert）===');
  const ingestStart = Date.now();
  const results = await kb.ingest(SEED);
  for (const r of results) {
    console.log(`  ${r.documentId.padEnd(16)} ${String(r.chunks).padStart(2)} 块 / ${String(r.chars).padStart(4)} 字  ${ms(r.durationMs)}`);
  }
  console.log(`  合计 ${ms(Date.now() - ingestStart)}`);

  console.log('\n=== 2. 检索（向量召回 20 -> 重排 -> Top3）===');
  for (const query of QUERIES) {
    const result = await kb.retrieve(query, { topK: 3 });
    const tag = result.degraded ? '降级' : result.reranked ? '已重排' : '纯向量';
    console.log(`\n  Q: ${query}  [${tag}, ${ms(result.latencyMs)}]`);
    result.hits.forEach((hit, i) => {
      const rerank = hit.rerankScore === undefined ? '-' : hit.rerankScore.toFixed(3);
      console.log(
        `    ${i + 1}. vec=${hit.score.toFixed(3)} rerank=${rerank}  ${hit.chunk.source.title}  ${preview(hit.chunk.text)}`,
      );
    });
    if (!result.hits.length) console.log('    （无命中，检查 minVectorScore 阈值）');
  }

  const stats = await kb.stats();
  console.log('\n=== 3. 存储用量 ===');
  // 单点成本 = 向量(4B/维) + HNSW 索引(粗估 1KB) + payload(粗估 0.3KB)
  const bytesPerPoint = stats.dimensions * 4 + 1024 + 300;
  const capacityWan = (1024 * 1024 * 1024) / bytesPerPoint / 10_000;
  console.log(`  collection=${stats.collection}  维度=${stats.dimensions}  点数=${stats.points}`);
  console.log(
    `  单点约 ${(bytesPerPoint / 1024).toFixed(1)}KB → 1GB 免费层约 ${capacityWan.toFixed(0)} 万块（按 450 字/块约 ${(capacityWan * 450).toFixed(0)} 万字）`,
  );

  if (flags.has('--clean')) {
    for (const doc of SEED) await store.deleteByDocument(kb.collection, doc.id);
    console.log('\n✓ 已清理本次写入的 smoke 数据');
  } else {
    console.log('\n提示：加 --clean 可删除本次写入的 smoke 数据（namespace=smoke 与 personal 隔离，不影响正式库）');
  }
  console.log('');
}

main().catch((err) => {
  console.error('\n✗ 冒烟失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
