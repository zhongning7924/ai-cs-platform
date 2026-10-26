# 调研：业界免费知识库托管方案（2026-10-25）

> 结论先行：**个人/开发用的知识库可以做到 $0，但免费层一律不能碰客户生产数据**。
> 针对本项目（中国团队、API 驱动、现有远程盒子 3.6G 跑不动重栈），最优组合：
> **Qdrant Cloud 免费层（向量库）+ 硅基流动 bge-m3（免费 embedding，国内直连）+ kb-api 留在现有远程盒子**。
> 如果想要一台"真·免费服务器"跑全套，唯一答案是 Oracle Cloud Always Free（ARM 4C/24G/200G，永久免费）。

## 一、托管向量库 / 数据库免费层（2026-10 核价）

| 服务 | 免费额度 | 容量估算 | 主要坑 |
|---|---|---|---|
| **Qdrant Cloud** | 1 节点 0.5vCPU / 1GB RAM / 4GB 磁盘，**永久免费、always-on** | ~几十万 chunk | 无 HA；规模上限低 |
| **Supabase（PG+pgvector）** | 500MB 数据库 + 1GB 文件存储 + 5GB 出口 | 1536 维约 5–8 万向量 | **7 天不活跃自动暂停**（演示前必须检查恢复）；无自动备份；共享 CPU 建 HNSW 慢 |
| Neon（serverless PG） | 1GB/项目 + 100 CU-小时/月 | ~10 万向量 | 闲置自动休眠、冷启动 |
| Zilliz Cloud（Milvus） | 5GB 存储、~1M 768 维向量、5 collections、2.5M vCU/月 | 大 | 条款以官网实时为准 |
| Pinecone Starter | 2GB、2M 写/1M 读单位/月 | ~10 万向量 | 专有协议，厂商锁定 |
| Cloudflare Vectorize | 5M 存储维度/月（1536 维 ≈ 3250 条）+ 30M 查询维度 | 很小 | 只适配 Workers 生态；国内访问一般 |
| MongoDB Atlas | 512MB | 小 | 无备份 |
| Weaviate Cloud | 14 天沙箱（10 万对象） | — | 试用性质，非永久 |
| Upstash Vector | 1GB、1 万次/天、≤1536 维 | 中 | 限速；维度上限 |

**选型结论**：要"永久免费 + 不暂停 +  always-on"→ **Qdrant Cloud 免费层**；已在 PG 生态、能接受 7 天暂停坑 → Supabase。两者都支持定期导出（快照/pg_dump），备份责任在自己。

## 二、免费 Embedding / 推理 API（中国可达性优先）

| 服务 | 免费内容 | 中国可达性 | 备注 |
|---|---|---|---|
| **硅基流动 SiliconFlow** | **bge-m3、bge-reranker-v2-m3、bge-large-zh 全免费**（无总量额度，限速见模型广场） | 国内直连、延迟低 | OpenAI 兼容 API；需实名；注意别选带 `Pro/` 前缀的收费版。**个人 KB 首选** |
| Cloudflare Workers AI | 10,000 Neurons/天；bge-m3 ≈ 1,075 neurons/百万 token → **每天约 930 万 token 免费**；全量重建约 1600 neurons（日额 15%） | api.cloudflare.com 可达，延迟看网络 | embeddings 限速 3000 rpm；实测与硅基流动 bge-m3 效果接近（同一模型） |
| 模力方舟（Gitee AI, moark.com） | bge-m3、bge-reranker-v2-m3、Qwen3-Embedding 系列全免费（平台明示长期政策） | 国内 | Gitee 账号即可，模型名不带前缀 |
| ModelScope API-Inference | Qwen 系列每天约 2000 次免费调用 | 国内 | 偏对话推理；embedding 额度以官网为准 |
| 阿里云百炼 / DashScope | 新用户免费额度 | 国内 | 量小，适合试用 |

**结论**：embedding 不用自己跑模型——硅基流动或模力方舟的免费 bge-m3/rerank 即可，省掉远程盒子 0.4–1.8G 内存。Cloudflare 作海外备选。

## 三、真·免费服务器（整机）

| 服务 | 配置 | 期限 | 门槛与坑 |
|---|---|---|---|
| **Oracle Cloud Always Free** | ARM 4 OCPU / **24GB RAM** / 200GB 盘 / 10TB 月流量；另 2 台 AMD 1C1G | **永久** | 需实体 Visa/MC 卡（国内招行/工行/中行/浦发可，$1 预授权退回）；注册必须**关代理 + 国内 IP + 国内账单地址**三者一致；home region 不可改，Phoenix/Mumbai/Jakarta 抢 ARM 成功率高，东京/首尔/新加坡常无容量；CPU 长期 <10% 可能被回收 |
| Google Cloud | f1-micro 永久免费 | 永久 | 仅 us 区域、1GB 内存，弱 |
| AWS / Azure | 12 个月试用 | 非永久 | 到期转付费 |
| Hugging Face Spaces | 免费 CPU 2vCPU / 16GB | 长期 | **运行期存储临时，重启丢数据**——不能当知识库主存储 |
| **ModelScope 创空间** | 免费 CPU **2vCPU / 16GB** | 长期 | 国内直连（阿里云 PAI-EAS）；实例休眠后访问即激活；代码持久但运行期数据不持久，需外接 DB（正好配上面的 Qdrant/Supabase） |
| Koyeb | 1 个免费 web service（nano） | 长期 | 需绑卡，默认进付费计划需手动降级 |
| Render / Railway / Fly.io | 免费层已取消或改试用金 | — | 不建议 |

**结论**：唯一"永久免费的真服务器"是 **Oracle Always Free**（24GB 内存足够原生跑 kb-api + PG + bge-m3，甚至源码构建 RAGFlow）。代价是注册门槛和 ARM 架构兼容问题（RAGFlow 无 ARM 官方镜像）。如果不想折腾注册，**ModelScope 创空间 2C16G** 是中国可达的次优选（配外接免费 DB）。

## 四、成品免费知识库产品（零开发，不可 API 化）

| 产品 | 免费内容 | 局限 |
|---|---|---|
| 腾讯 ima.copilot | 免费个人知识库，微信生态直达 | 数据在平台侧、无 API |
| Google NotebookLM | 免费（100 个源） | 无 API、国内访问需网络条件 |
| Coze 扣子 | 免费，知识库 + 发布 API | 国内可达，但受平台规则约束 |
| Cherry Studio + 硅基流动 bge-m3 | 本地个人 KB，全免费 | 本地工具，非服务 |

## 五、针对本项目的三个推荐组合

### 组合 A：零成本 API 化（推荐，现在就能用）
- 向量库：**Qdrant Cloud 免费层**（or Supabase，接受暂停坑）
- Embedding/Rerank：**硅基流动 bge-m3 + bge-reranker-v2-m3**（免费、国内直连）
- kb-api：现有远程盒子（~0.2G，端口 8012）
- 成本：**$0**；不动新服务器；kb-core 的 Repository 接口直接对接 Qdrant HTTP API
- 适用：个人知识库 + POC + demo

### 组合 B：真免费服务器全套自托管（想彻底摆脱 3.6G 小盒子时）
- Oracle Always Free ARM 4C/24G/200G
- 原生部署：kb-api + PostgreSQL/pgvector + bge-m3 本地推理（甚至够 RAGFlow 源码构建）
- 成本：$0（注册门槛见上）；注意 ARM 镜像兼容与账号保活
- 适用：要把整套（含未来 PG/RAGFlow）搬出腾讯云小盒子

### 组合 C：零开发马上用（临时/个人）
- ima.copilot 或 NotebookLM 或 Coze
- 成本 $0，但无 API、数据在平台侧，与项目架构脱节

## 六、红线与使用纪律

1. **免费层不存客户数据**：数据出境、无 SLA、可能暂停/回收——只用于个人 KB 与 POC；客户生产仍走 ADR-003 私有化部署。
2. **备份靠自己**：免费层普遍无自动备份（Supabase/Neon/MongoDB 均如此），定期导出（pg_dump / 厂商快照）。
3. **Supabase 7 天暂停坑**：演示/面试前一天检查项目状态并恢复。
4. **Oracle 注册三一致**：国内 IP（关代理、手机热点）+ 国内实体卡 + 国内账单地址；region 选定不可改，优先 Phoenix/Mumbai/Jakarta 抢 ARM。
5. **硅基流动选型细节**：模型 ID 用 `BAAI/bge-m3`（免费），不要用 `Pro/BAAI/bge-m3`（收费）；免费模型限速固定，不随付费等级提升。
6. **免费额度会变**：本文数据 2026-10-25 核价，落地前复查官方定价页。

## 参考来源

- Supabase Pricing / Database Size 官方文档（2026-10 核价）
- Cloudflare Workers AI 免费额度与 Vectorize 定价（aifree.dev / 官方定价页，2026-08 更新）
- Qdrant / Pinecone / Zilliz / Weaviate / Upstash 免费层对比（devshot.co、dracon.uk、kenodo.com，2026-04~08 核价）
- Oracle Always Free 资格与注册指南（aicreditmart.com、youmind、baifan.blog，2026-04 更新）
- 硅基流动免费模型清单（getmodelkey.com、jidan.si，2026-08 快照）
- ModelScope 创空间资源规格官方文档（2vCPU/16GB 免费 CPU）
