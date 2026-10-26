# ADR-004：知识库存储与 Embedding 托管选型（Qdrant Cloud Free + 硅基流动）

- 状态：Accepted
- 日期：2026-10-25
- 关联：ADR-003（知识库分层组装）、ADR-001（合规与可用性红线）

## 1. 背景与约束

W1 需要一条"零本机依赖、$0、当天可跑"的知识库链路，用于个人常用资料入库。
硬约束来自三轮实测：

| 约束 | 实测值 | 影响 |
|---|---|---|
| 本机 | Intel Mac，**无 Docker / 无 PostgreSQL** | 排除 RAGFlow / FastGPT / Dify / MaxKB 全部 Docker 整机方案 |
| 远程盒子 | 3.6GB 内存，已用 1.6GB，**无 swap** | 只能容纳 ≈0.6GB 级原生进程，跑不了 4GB+ 的向量库+模型 |
| 预算 | $0 | 排除 Qdrant Cloud 付费层、Pinecone 付费层 |

结论：**存储和模型都外租，检索内核自己写**。

## 2. 决策

| 层 | 选型 | 角色 |
|---|---|---|
| 向量库 | **Qdrant Cloud Free**（0.5 vCPU / 1GB RAM / 4GB disk） | 只存向量与 payload，不做生成 |
| Embedding | **硅基流动 `BAAI/bge-m3`**（1024 维，免费档） | 文本 → 向量 |
| Reranker | **硅基流动 `BAAI/bge-reranker-v2-m3`**（免费档） | 召回候选精排 |
| 编排层 | **`packages/kb-core`（自研，TS，零运行时依赖）** | 切片、命名空间隔离、阈值、降级 |

二者天然互补：Qdrant 是 model-agnostic 的纯向量存储（官方明确 BYO embedding），
硅基流动只负责把文本变成 float 数组，**接口就是 1024 维数组**，不存在协议冲突。

## 3. 三个硬契约

1. **维度锁**：bge-m3 = 1024。collection `size` 必须等于模型输出维度；`ensureCollection()` 在维度不符时抛错，不静默写入。
2. **距离函数 Cosine**：Qdrant 在写入时自动归一化，客户端不做手动 normalize；若改用 Dot 必须自行归一化。
3. **collection 命名带模型指纹**：`kb_<model-slug>_<dim>`（如 `kb_baai_bge_m3_1024`）。换模型 = 换 collection + 全量重灌，永不原地改。

## 4. 事实更正（重要）

上一轮调研稿称 Qdrant 免费层 "always-on、没有暂停坑"，**该结论有误**。官方 FAQ（2026-10 核对）实际规则：

- 单节点 0.5 vCPU / 1GB RAM / 4GB disk，**无需信用卡、永久免费**；
- **7 天无活动会挂起（suspend）**；
- **挂起后 4 周未恢复会被删除**；
- 挂起不丢数据，可在控制台或 API 恢复。

处置：`npm run kb:keepalive` 打一次 `/collections` 探活即可重置计时，进 cron 每 3 天一次。
这个"坑"比 Supabase 的 7 天暂停更容易规避（Supabase 暂停后需手动恢复且无备份）。

## 5. 容量核算（1024 维）

单块成本 = 向量 4KB（1024×4B）+ HNSW 索引 ≈1KB + payload ≈0.3KB ≈ **5.3KB**

| 口径 | 数值 |
|---|---|
| 1GB 可存 | ≈19 万块；保守按 **10–15 万**规划 |
| 折合字数 | ≈5000 万字（450 字/块） |
| 对照 | 100 页 PDF ≈110 块；1000 份文档 ≈11 万块 |

修正上一轮"几十万 chunk"的乐观说法——1024 维比 768 维更占空间，实际应按 10–20 万规划。

## 6. 失败与限流策略

| 场景 | 处理 |
|---|---|
| 429 / 5xx | 400ms × 2^n + 抖动重试 3 次；仍失败**抛错，不静默丢数据** |
| 批量入库 | `batchSize=32`，串行分批，避免撞免费档 RPM |
| Reranker 挂掉 | 降级为向量序，`degraded=true`，主链路不 500 |
| 模型 ID 误用 `Pro/` | 构造时直接拒绝（收费版） |
| 维度不符 | 立即抛错并提示重建索引 |

## 7. 后果

**收益**：$0 起步；不进本机也不占远程盒子内存；换存储（pgvector）或换模型（自建 bge-m3）只换一个类，编排层零改动。

**代价 / 风险**：
1. Qdrant Cloud 节点在海外，国内检索 RTT 约 100–200ms（可接受，非实时链路）；
2. 免费层无 SLA、无备份，**客户数据禁止入库**（仅 personal / POC）；
3. 依赖第三方 embedding API 意味着断网即不可检索——P3 私有化交付时必须换自建 bge-m3，接口已预留；
4. 7 天挂起规则必须靠 cron 兜底，忘记配 = 某天检索全挂。

## 8. 验收

```bash
npm test -w @cs/kb-core        # 20 条离线测试（含降级、隔离、幂等）
npm run kb:smoke               # 真连：3 篇种子文档 + 3 个问题，打印分数与延迟
```

冒烟通过标准：3 个 query 的 Top1 分别命中退货、物流、发票三篇文档；
rerank 分数与向量分数同向；`stats().points` 与切片数一致。
