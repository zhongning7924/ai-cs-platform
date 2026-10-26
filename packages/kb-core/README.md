# @cs/kb-core — 知识库内核（Qdrant + 硅基流动 bge-m3）

ADR-003 / ADR-004 的落地实现：**存储与模型都租，检索内核自己写**。
Qdrant 存向量不管生成，硅基流动生成向量不管存储，两者通过 1024 维 float 数组对接——
这就是「能一起用」的全部含义。

```
文档 ──chunker──> 切片 ──bge-m3(硅基流动)──> 1024维向量 ──upsert──> Qdrant
                                                                      │
用户问题 ──bge-m3──> 1024维向量 ──search top20─────────────────────────┘
                                      │
                               bge-reranker-v2-m3 精排 ──> top3 + 引用链
```

## 快速开始（3 分钟）

```bash
# 1. 免费开一个 Qdrant 集群：https://cloud.qdrant.io（无需信用卡）
#    创建后复制 Cluster URL 与 API Key
export QDRANT_URL="https://xxxx.aws.cloud.qdrant.io"
export QDRANT_API_KEY="..."

# 2. 硅基流动领免费 key：https://cloud.siliconflow.cn/account/ak
export SILICONFLOW_API_KEY="sk-..."

# 3. 跑端到端冒烟（会真的写 3 篇文档、检索 3 个问题）
npm run smoke -w @cs/kb-core

# 4. 只做探活，防免费层挂起（建议进 cron）
npm run keepalive -w @cs/kb-core
```

## CLI：把你的资料灌进知识库

密钥统一写在**仓库根 `.env`**（模板 `.env.example`，已被 git 忽略），注册后填入即可：

```bash
cp .env.example .env    # 填入 QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY
```

命令（根目录执行，`npm run kb` 即 kb-cli）：

```bash
# 0. 先用示例资料验证链路（samples/kb-sources/ 下有 3 篇演示文档）
npm run kb -- ingest ./samples/kb-sources

# 1. 入库你的资料：默认扫描 ~/kb-sources，也可指定目录或单个文件
#    支持 .md / .markdown / .txt / .pdf（有文本层，unpdf）/ .docx（mammoth，保留标题层级）
mkdir -p ~/kb-sources          # 把常用资料放进来（建议放脱敏副本）
npm run kb -- ingest           # 全量入库；重跑同一文件会覆盖旧切片，不会重复

# 2. 检索
npm run kb -- search "报销超过一千怎么办"
npm run kb -- search "退货" --top 3

# 3. 状态 / 删除 / 探活
npm run kb -- stats
npm run kb -- remove 售后政策示例.md      # 按路径（也支持 12 位 docId）
npm run kb -- keepalive                  # cron 每 3 天一次，防挂起
```

规则：

- 文档 id = 文件绝对路径的 sha1 前 12 位 → **同一文件重复 ingest 幂等覆盖**；
- 支持格式：`.md / .markdown / .txt / .pdf（文本层）/ .docx`；扫描件 PDF 等待 P2 MinerU；

### 飞书知识库（企业文档源）

```bash
# 一次性准备：open.feishu.cn/app 建企业自建应用 → 开通 wiki:wiki:readonly +
# docx:document:readonly → 发布版本 → 知识库成员加入应用可用范围 → .env 填 key
npm run kb -- feishu                    # 列出应用可见的知识空间
npm run kb -- feishu <space_id> --ns company   # 整库拉取入库（docx 类型）
```

- 正文走 `raw_content` API（近似 markdown），与本地文件共用同一条 ingest 管道；
- docId 绑定 `node_token` → **重复执行幂等覆盖**，文档改名/移动不产生重复；
- 每篇文档带 `https://www.feishu.cn/wiki/{node_token}` 回链，引用卡片可点击跳回原文；
- 旧版 doc / 表格 / 思维笔记自动跳过；企业库建议独立 namespace（`--ns company`）与个人库隔离。

钉钉文档：开放 API 对文档正文读取覆盖有限，落地路线见 `docs/adr/0005-source-connectors.md`。
- 入库后**网关自动可用**：FAQ 未命中时 `bot.ts` 会检索 `KB_ANSWER_NAMESPACE`（默认 `personal`）并以 `kb_ref` 引用卡片回答，密钥未配置则整条通道静默关闭，不影响原有功能。

离线自检（不联网、不需要 key）：

```bash
npm test -w @cs/kb-core        # 20 条：切片 / 编排 / 重排降级 / 命名空间隔离 / 幂等
npm run typecheck -w @cs/kb-core
```

## 三个硬契约（违反就会静默出错）

| 契约 | 值 | 违反后果 |
|---|---|---|
| 向量维度 | bge-m3 = **1024**，collection 的 `size` 必须一致 | 写入被拒或检索全乱；`ensureCollection` 会直接报错拦截 |
| 距离函数 | **Cosine**（Qdrant 存储时自动归一化，无需手动 normalize） | 用 Dot 且未归一化 → 分数不可比 |
| collection 命名 | `kb_<model>_<dim>`，由 `buildCollectionName()` 生成 | 换模型写进旧 collection → 旧数据永久失真 |

换 embedding 模型（例如升级 Qwen3-Embedding-4B，2560 维）= **新建 collection + 全量重灌**，不能原地改。
命名带模型指纹就是为了让这件事变成"换个名字"而不是"考古"。

## 免费层的真实限制（重要）

Qdrant Cloud Free 实测规格（2026-10 官方 FAQ 核对）：

- 单节点 **0.5 vCPU / 1GB RAM / 4GB 磁盘**，无需信用卡，**永久免费**；
- **7 天无活动会挂起（suspend），挂起后 4 周未恢复会被删除**；
- 挂起不丢数据，可在控制台或 API 恢复——但别赌，**加 keepalive 定时任务**。

用系统 cron 每 3 天打一次探活即可（服务器或本机都行）：

```cron
0 9 */3 * * cd /path/to/ai-cs-platform && /usr/bin/env node --import tsx packages/kb-core/scripts/smoke.ts --keepalive >> /tmp/kb-keepalive.log 2>&1
```

容量账（1024 维、450 字/块、含 HNSW 索引与 payload 粗估）：

| 项 | 估算 |
|---|---|
| 单块 | ≈ 4KB 向量 + 1KB 索引 + 0.3KB payload ≈ **5.3KB** |
| 1GB 可存 | **约 19 万块**（保守按 10–15 万规划） |
| 折合字数 | 约 **5000 万字** |
| 参考 | 100 页 PDF ≈ 5 万字 ≈ 110 块；1000 份文档 ≈ 11 万块 |

个人知识库完全够用；**客户生产不要用免费层**（数据出境、无 SLA、会挂起）。

## 限流与失败处理

- **入库必须限批**：默认 `batchSize=32`，免费档再高容易 429；
- **429/5xx 自动退避重试**：400ms × 2^n + 抖动，默认 3 次；仍失败抛错，**不静默丢数据**；
- **重排失败降级**：reranker 挂掉时自动退回向量排序并置 `degraded=true`，主链路不 500；
- **模型 ID 防呆**：`Pro/` 前缀是收费版，构造函数直接拒绝（`assertFreeModel`）。

## 迁移路径（不改编排代码）

| 现在 | 生产替换 | 改动点 |
|---|---|---|
| Qdrant Cloud | 自建 Qdrant / pgvector | 实现 `VectorStore` 接口，换一个类 |
| 硅基流动 bge-m3 | 自建 bge-m3（ONNX/GPU） | 实现 `Embedder` 接口 |
| 硅基流动 reranker | 自建 bge-reranker-v2-m3 | 实现 `Reranker` 接口 |

`KnowledgeBase` 编排层（切片策略、命名空间隔离、阈值、降级）不需要动一行——
这是「检索内核自研」换来的可替换性。

## 对外接口

```ts
import { KnowledgeBase, QdrantStore, SiliconFlowEmbedder, SiliconFlowReranker } from '@cs/kb-core';

const kb = new KnowledgeBase({
  embedder: new SiliconFlowEmbedder(),
  store: new QdrantStore(),
  reranker: new SiliconFlowReranker(),
  namespace: 'personal',           // 客户租户换成 tenant id，物理隔离
});

await kb.ingest([{ id: 'doc-1', title: '退货政策', text: markdown, uri: 'file:///...' }]);

const { hits, reranked, degraded, latencyMs } = await kb.retrieve('七天无理由怎么算', {
  topK: 5,
  minRerankScore: 0.2,             // 低于阈值宁可拒答，也别让模型编
});
```

`hits[].chunk.source` 带 `title / uri / page / offset / headingPath`，
可直接渲染成回答里的引用角标——这是 ADR-001 的合规红线。
