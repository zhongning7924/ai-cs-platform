# ADR-003 知识引擎（通用知识库）技术选型

- 状态：已接受（Accepted）
- 日期：2026-10-25
- 关联：ADR-001（规则+意图双通道，合规生命线）、ADR-002（统一消息协议 @cs/protocol）
- 背景任务：构建通用知识库（底座级复用），并接入本地常用资料；先完成技术选型

## 1. 上下文与驱动因素

**业务目标**：一份知识库基础设施同时服务两个场景——① 客服机器人检索（多租户隔离）；② 个人/团队本地常用资料入库。知识库是底座复利资产（知识模板、切片策略、评测集随客户交付持续增值）。

**硬约束（本机环境实测）**：
- 开发机为 Intel Mac（x86_64，macOS 26.2），**未安装 Docker、未安装 PostgreSQL**
- Node 22.12 与 Python 3.13 可用；无 GPU，embedding 只能 CPU 推理
- 团队 3.5 人，主力为 FED 背景（TS 全栈闭环优先）

**合规红线**：所有回答必须可溯源到 chunk → document（对齐 ADR-001 合规生命线）；引入组件协议必须允许商用二开。

## 2. 候选方案对比（2026-10 调研）

| 方案 | 本地零 Docker 可跑 | 解析深度 | 中文检索 | 引用溯源 | API 集成 | 协议风险 |
|---|---|---|---|---|---|---|
| RAGFlow（~75k+ stars，v0.24+） | 否（需 Docker，x86 镜像，16GB+ RAM） | 强（DeepDoc：版面/表格/OCR） | 强 | 强 | 强（REST/Python/JS/MCP） | 低（Apache-2.0） |
| FastGPT（v4.17，活跃） | 否（需 Docker） | 中（依赖三方解析） | 强（中文切分口碑） | 强 | 强 | 中（Apache-2.0 + 附加条款：多租户 SaaS 需书面授权、不得移除控制台 LOGO） |
| MaxKB | 否（需 Docker） | 中（LangChain 封装） | 中 | 中 | 中 | 中 |
| QAnything（网易有道） | 否（需 Docker） | 中（自有 OCR） | 中 | 中 | 中 | 中（架构封闭，模型固定） |
| Dify 知识库 | 否（需 Docker） | 中（Unstructured 基础解析） | 中 | 中 | 强 | 低（Apache-2.0） |
| **自研 kb-core（本 ADR 决策）** | **是（纯 Node，SQLite 文件级）** | 中→强（MVP 内置轻解析 + P2 挂 MinerU） | 强（bge-m3 + 关键词混合） | 强（chunk 定位） | 强（自有协议） | 无（零三方服务依赖） |

**关键事实**：所有"一键部署"开源产品都依赖 Docker，在本机直接卡死；且 x86 镜像在 Intel Mac 上亦无法原生运行。RAGFlow 解析能力断崖领先但是重栈（MySQL/Redis/MinIO/ES/Infinity），适合作为生产环境重核而非开发期依赖。

## 3. 决策：分层组装，接口可插拔

> 原则延续手册取研判定：**通用能力取社区，场景资产自研发**。检索内核、切片模板、评测集是资产，必须自研可拥有；解析重器（MinerU/RAGFlow DeepDoc）该借就借——借引擎，不借架构。

### 3.1 分层选型

| 层 | 选型 | 说明 |
|---|---|---|
| 检索内核 | **自研 `packages/kb-core`（TypeScript）** | 摄取管线、切片模板、混合检索、引用溯源、命名空间隔离；资产自有 |
| 向量库 | **SQLite + sqlite-vec（本地/MVP）→ PostgreSQL + pgvector（生产）** | 同一 Repository 接口切换；本机零安装，生产单栈不引 ES/Milvus |
| Embedding | **bge-m3（ONNX INT8）默认；bge-small-zh-v1.5 演示档；GPU 环境升 Qwen3-Embedding-4B** | bge-m3：MIT、1024 维、稠密+稀疏+colbert 三路、CPU INT8 质量保持好（实测 CPU 首选）；Qwen3-4B：Apache-2.0、32k、可变维，中文基准更高但 decoder 架构 CPU 慢 5–15 倍且 uint8 量化有区分度塌陷问题，仅 GPU 环境使用 |
| Rerank | bge-reranker-v2-m3（P2 引入） | 粗排向量 + 精排 cross-encoder |
| 文档解析 | MVP 内置：md/txt/html/docx(mammoth)/pdf(pdf-parse)；**P2 挂 MinerU Python sidecar** | 复杂版式/扫描件/表格走 MinerU；MVP 不碰重解析 |
| 外部引擎 | **KbProvider 接口**：RAGFlow / FastGPT / Dify 按需挂载 | 客户场景以复杂文档为主时，私有化部署 RAGFlow 经接口接入，网关/bot 层无感 |
| 评测 | 脚本化 hit@k 先行 → LLM 进场后上 RAGAS | 评测集与基准分先于调优建立（手册纪律） |

### 3.2 为什么不自带整机产品

1. 本机无 Docker——整机产品连本地演示都跑不通，违背"先跑通再扩展"；
2. 底座积累目标——整机产品把检索内核锁在黑盒，资产变不成自己的；
3. FED 闭环——TS 内核 + 自研管理 UI，一个人能从头写到尾；
4. 协议附加条款——FastGPT 多租户 SaaS 需授权、LOGO 不可去，与我们私有化交付形态需法务评估，不作为默认依赖。

### 3.3 数据模型

```
namespace（租户/用途：personal、tenant-demo…）
└── dataset（知识库）
    └── document（来源：本地文件 / URL / 手工录入）
        └── chunk（正文 + 定位：file/page/offset + embedding）
```

回答引用链：answer → chunk → document 来源，满足合规红线。

## 4. 本地资料接入方案

- 接入方式：watch 目录（chokidar）+ 手动上传 + URL 抓取（P2）
- 默认目录约定：`~/kb-sources/`（待用户确认实际常用资料目录；建议先放脱敏副本）
- 支持格式（MVP）：.md / .txt / .html / .docx / .pdf
- 命名空间隔离：`personal`（本地常用资料）与各客服租户知识库物理隔离、检索时不串库

## 5. 落地计划（对齐手册 P2，约 4 周）

| 周 | 动作 | 验收标准 |
|---|---|---|
| W1 | kb-core MVP：sqlite-vec + bge-small-zh 跑通 ingest→search；灌入本地目录脱敏副本 | 10 份本地文档入库，5 条查询 hit@3 ≥ 80% |
| W2 | 切片模板 + 命名空间 + 引用溯源；网关 `POST /api/kb/search` 接入 bot.ts；挂件引用卡片 | 回答带可点击引用；personal 与租户库不串 |
| W3 | 升级 bge-m3 ONNX；混合检索（向量+关键词）；评测集 200 条 + 基准分 | 基准分报告产出，作为售前弹药 |
| W4 | KbProvider 接口 + RAGFlow 对接验证（远程 Linux/Docker 环境）；console 知识库管理页 | 接口可平换外部引擎；管理页可上传/删除/重建索引 |

## 6. 风险与备选

| 风险 | 应对 |
|---|---|
| 自研内核进度不及预期 | W1 即设检查点；超期则降级为 MaxKB/FastGPT 整机 + 接口包裹，保交付 |
| 复杂文档解析成为主场景 | MinerU sidecar（W3 前）→ RAGFlow 引擎（W4）两级升级路径已预留 |
| embedding 选型漂移 | 索引记录模型版本号，支持全量重建；bge-m3 ↔ Qwen3-4B 可平换 |
| SQLite 并发写入瓶颈 | MVP 单机可接受；生产切 PG+pgvector，接口不变 |
| 本地资料含敏感信息 | 入库默认脱敏副本目录；namespace 级权限；不进 git |

## 8. 远程部署约束与分工（2026-10-25 巡检补充）

**远程机器实况**（aiclub.hk.cn / 43.142.39.49，只读巡检）：4 核 / 3.6 GB 内存 / **无 Swap** / **未装 Docker** / **未装 PostgreSQL**；12 个生产服务常驻占用 1.6 GB，可用约 2.0 GB；CPU load 0.14（极闲）、磁盘余 44 GB。瓶颈只有内存，且无 swap 意味着超售直接触发 OOM。

**部署决策**：
- **远程不装 Docker**。RAGFlow 全栈（官方最低 16 GB）差 8 倍、FastGPT/MaxKB 等 Docker 栈（4–8 GB）超限，均不可行；Docker daemon 本身在这台无 swap 机器上也是 OOM 风险源，且会危及现有 12 个生产服务（含 IAM）。远程沿用既有 house style：原生进程 + systemd + 127.0.0.1 + nginx 收口。
- **远程服务**：`kb-api`（FastAPI/uvicorn，系统已全局可用）监听 `127.0.0.1:8012`，nginx 经 `/kb/api/` 路由收口到 `https://aiclub.hk.cn`（需登记 ROUTES.md 并走 aiclub-router 流程）。数据存 SQLite（零服务，~50MB 级）。
- **Embedding 分级**：bge-small-zh（~0.4 G）常驻起步；bge-m3 ONNX INT8（~1.8 G）做懒加载可选档（按需加载、空闲卸载）；Qwen3-Embedding-4B 在 CPU 上 8 GB+，本远程不部署。
- **LLM API 走服务器**：生成请求经现有 `llm-proxy`（127.0.0.1:8000）或直连模型 API，不在 kb-api 内耦合。
- **本机（开发）**：gateway + widget 不变，bot.ts 的知识检索调用远程 `https://aiclub.hk.cn/kb/api/search`（token 鉴权），本机零依赖。
- **PG 与 RAGFlow 延后**：PostgreSQL/pgvector 待远程加 swap 或换大内存机器再评估；RAGFlow 仅在客户侧 x86 Docker 环境部署，不经本远程。
- **安全建议（待用户确认后实施）**：可加 2 GB swap 文件作 OOM 保险（磁盘余 44 GB，风险低）。

## 7. 参考

- RAGFlow 官方仓库与文档（Apache-2.0，v0.24–0.27，2026）
- FastGPT 官方开源协议说明（Apache-2.0 + 两项附加条件）
- 2026 私有化知识库选型横评（科技新知 / CSDN / 掘金多源交叉验证）
- Embedding 横评：Qwen3-Embedding vs BGE-M3（CMTEB/繁中 CPU 实测）
- MinerU（开源文档解析）、RAGAS（RAG 评测框架）
