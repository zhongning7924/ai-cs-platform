# ai-cs-platform

开源 AI 客服系统，单仓库前后端俱全：网页挂件、接入网关、规则 FAQ 通道、多坐席智能体（TS + Python 双语言分层）、RAG 知识库、转人工坐席台、反馈闭环、公众号渠道、可视化管理后台、私有化 Docker 交付。

## 已实现的能力

- **双引擎对话**：高分 FAQ 直达（零 LLM 成本）+ 有限步智能体循环（流式 SSE），规则引擎兜底降级
- **多坐席路由分诊**：售前 / 售后 / 技术 / 通用四个子坐席，触发词 → 上下文 → LLM 三层判定，工具白名单双道校验（ADR-0008）
- **RAG 知识库**：Qdrant 向量 + BM25 混合召回，RRF 融合 + bge-reranker 重排；文档改动零代码，入库 CLI 一条命令
- **MCP + Skills**：手写 JSON-RPC 2.0 over stdio 接入外部工具服务器；技能 = 触发词 + 注入指令 + 工具偏好
- **转人工**：敏感诉求 / 用户要求 / 低置信三类触发，坐席台接单回复，人工期间不消耗模型（ADR-0011）
- **反馈闭环**：挂件 👍/👎 → 落盘脱敏 → 看板统计 → 导出 jsonl 回灌评测（ADR-0009）
- **公众号渠道**：微信公众号 / 服务号明文模式接入，`openid` 直连会话，5 秒被动回复约束下先回执再异步客服消息推送（ADR-0012）
- **可视化管理后台**：`/admin` 单文件零构建，机器人人设与模型参数热改实时生效，无需重启（ADR-0012）
- **私有化交付**：`deploy/` 一套 docker-compose，LLM / Embedding / Rerank 三端点独立配置，管理面 token + 来源白名单 + 限流（ADR-0010）

> 架构起点是《AI 智能客服底座建设与快速部署实战手册》第五章，在此基础上已大幅超出原书范围。分层思想保留：**社区已有的取社区（React/Express/Qdrant），场景核心的自研发（协议、检索、智能体、坐席台）**。

## 目录结构与模块划分

```
ai-cs-platform/
├── packages/
│   ├── protocol/          # @cs/protocol  统一消息协议（ADR-002，零依赖纯类型）
│   │   └── src/index.ts   #   UnifiedMessage / CardPayload / SSE 事件 / 编解码
│   ├── faq-engine/        # @cs/faq-engine 机器人规则通道（ADR-001 规则侧）
│   │   ├── src/faq-data.ts #   种子 FAQ 知识库（电商通用 15 条，含演示卡片）
│   │   ├── src/index.ts    #   tokenize / scoreFaq / matchFaq / 转人工识别
│   │   └── test/           #   node:test 评测集（"评测集先行"纪律的最小落地）
│   ├── agent/             # @cs/agent     智能体核心（ADR-0006）
│   │   └── src/            #   Planner(LLM⇄Rule) / ToolRegistry / Memory / AgentRuntime
│   └── kb-core/           # @cs/kb-core   知识库内核：Qdrant + 硅基流动 bge-m3（ADR-003/004）
├── apps/
│   ├── gateway/           # @cs/gateway   L2 接入网关 + BFF
│   │   └── src/
│   │       ├── index.ts   #   POST /api/chat（SSE 流式，双路：规则直达/智能体循环）
│   │       ├── agent.ts   #   智能体组装：注册 kb_search / query_order / create_ticket
│   │       ├── env.ts     #   .env 加载副作用模块（ESM 时序保证）
│   │       ├── bot.ts     #   规则通道（转人工/FAQ 直达）+ 流式吐字
│   │       ├── session.ts #   会话管理（内存版，扩容前换 Redis）
│   │       ├── py-proxy.ts#   Python 智能层透传（AGENT_BACKEND=py）
│   │       ├── guard.ts   #   管理面 token / 来源白名单 / 限流（ADR-0010）
│   │       ├── wechat.ts  #   公众号明文模式：签名验证 / 被动回复 / 客服消息（ADR-0012）
│   │       ├── admin/     #   管理后台：人设与模型参数存储 / 校验 / 运行时覆盖（ADR-0012）
│   │       ├── data/      #   反馈闭环：脱敏 / 事件溯源存储 / 数据集导出（ADR-0009）
│   │       └── handoff/   #   转人工：状态机 / 触发判定 / 坐席接口（ADR-0011）
│   │   └── public/
│   │       ├── console.html  # 坐席工作台（单文件零构建）
│   │       └── admin.html    # 管理后台（单文件零构建，人设/模型/状态/咨询记录）
│   ├── web-widget/        # @cs/web-widget L1 网页挂件（React + Shadow DOM）
│   │   ├── index.html     #   演示宿主页（模拟商家页面）
│   │   └── src/widget/    #   mount(Shadow DOM) / api(SSE+轮询) / cards / feedback
│   └── console/           # @cs/console   管理后台（占位）
├── services/agent-py/     # Python 智能层（FastAPI :8788，ADR-0007 前后语言分层）
│   └── app/
│       ├── agent/         #   事件循环 / LLM 规划器 / 路由分诊 / 子坐席
│       ├── kb/            #   向量库直连 / BM25 / RRF / 重排
│       ├── mcp/           #   MCP 客户端（JSON-RPC over stdio）
│       ├── skills/        #   技能注册表
│       └── tools/         #   内置工具（kb_search / query_order / create_ticket）
├── deploy/                # 私有化交付：Dockerfile / docker-compose / 交付手册（ADR-0010）
├── docs/adr/              # 架构决策记录（0001-0012）
├── docs/research/         # 选型调研
├── samples/kb-sources/    # 知识库示例文档
├── tsconfig.base.json
└── package.json          # npm workspaces
```

### 分层架构 ↔ 代码

| 层 | 模块 | 落地方式 | 状态 |
| --- | --- | --- | --- |
| L1 渠道层 | apps/web-widget | 自研（React + Shadow DOM 挂件） | 已实现 |
| L1 渠道层 | gateway/wechat.ts | 公众号 / 服务号明文模式接入 | 已实现（ADR-0012） |
| 运营面 | gateway/admin + admin.html | 人设与模型参数可视化热改 | 已实现（ADR-0012） |
| L2 接入网关层 | apps/gateway | 自研核心（会话/路由/防护/转人工）+ Express | 已实现 |
| L3 规则通道 | packages/faq-engine | 自研（高分直达，零 LLM 成本） | 已实现 |
| L3 智能体 | packages/agent（TS）+ services/agent-py（Python） | 双实现同协议，`AGENT_BACKEND` 切换 | Python 为准，已实现 |
| L3 知识库引擎 | packages/kb-core + agent-py/kb | Qdrant 存储 + 混合检索自研 | 已实现 |
| L3 LLM 网关 | LLM_BASE_URL / EMBEDDING_BASE_URL / RERANK_BASE_URL | 任一 OpenAI 兼容端点，三者可不同源 | 已实现 |
| 人机协同 | gateway/handoff + 坐席台 | 自研最小闭环，可换 Chatwoot | 已实现（ADR-0011） |
| 企业部署层 | deploy/ | docker-compose 单机交付 | 已实现（ADR-0010） |
| 数据层 | 内存会话 + JSONL 事件溯源 | 扩容前换 Redis / SQLite | MVP |

## 快速开始

```bash
# 环境要求：Node >= 20
npm install

# 一键启动（gateway :8787 + widget :5173，并发）
npm run dev
```

启动后访问 <http://localhost:5173> 查看演示宿主页，点击右下角挂件图标开始对话。

### 知识库（可选，$0 起步）

向量库与 Embedding 均有免费档，密钥注册后填入 `.env`（模板 `.env.example`），网关检测到密钥后自动启用 KB 兜底通道：

```bash
cp .env.example .env                          # 填 QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY
npm run kb -- ingest ./samples/kb-sources     # 示例资料验证链路
npm run kb -- ingest                          # 入库 ~/kb-sources 下你自己的 md/txt
npm run kb -- search "退货政策"                # 检索验证
```

详见 [packages/kb-core/README.md](packages/kb-core/README.md) 与 [ADR-004](docs/adr/0004-vector-store-and-embedding.md)。

### 单独验证网关（不依赖前端）

```bash
# 健康检查
curl http://localhost:8787/health

# SSE 流式对话（-N 关闭缓冲，可见逐字输出）
curl -N -X POST http://localhost:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"什么时候发货"}'
```

返回的 SSE 事件序列：`meta`（sessionId/traceId）→ 多个 `delta`（文本分片）→ 可选 `tool`（工具执行状态）→ 可选 `card`（结构化卡片）→ `done`（首字延迟 / planner / toolCalls / 是否降级）。

### 智能体（ADR-0006）

对话双路：**转人工意图 + FAQ 高分命中走规则直达**（口径可控、零 LLM 成本）；其余进入 **AgentRuntime 循环**——LLM 规划器（默认硅基流动 Qwen2.5-7B-Instruct，任何 OpenAI 兼容端点可换）自主决定调用工具或直接回答，LLM 异常自动降级 Rule 规划器。

内置演示工具（`gateway/agent.ts`）：`kb_search`（知识库检索）、`query_order`（订单 mock）、`create_ticket`（高风险，需用户「确认」才执行——护栏④）。

**扩展只需一行**：`registry.register({ name, description, parameters, risk, execute })`，规划器自动看到新工具。详见 [ADR-0006](docs/adr/0006-agent-architecture.md)。

### 反馈闭环（ADR-0009）

每条机器回复下面都有「有帮助 / 没解决」。点「没解决」要选原因（可选填正确答案），
点「有帮助」一键完成。所有对话与评价落到 `var/data/feedback.jsonl`（追加写、落盘即脱敏）。

```bash
# 效果看板：好评率、差评原因分布、按坐席拆
curl -s http://localhost:8787/api/stats/feedback | python3 -m json.tool

# 最近对话（含评价状态）：rating=up|down|none
curl -s 'http://localhost:8787/api/traces?limit=5&rating=down'

# 导出评测集（默认只导有标注的；?include=all 带上未标注）
curl -sJO 'http://localhost:8787/api/dataset/export'

# 用线上数据回灌评测
cd services/agent-py && python3 eval/run_eval.py --dataset ../../feedback-dataset-*.jsonl --only py
```

样本分级与权重（不这么分，指标就是假的）：

| 来源 | label | weight | 说明 |
|---|---|---|---|
| 👎 + 写了正确答案 | `human_corrected` | 1.0 | 金样本，既是负例又是正例 |
| 👎 没写正确答案 | `human_rejected` | 1.0 | 只知道错了，只能验工具/动作 |
| 👍 | `bot_accepted` | 0.5 | 自举样本，用户没义务挑毛病 |
| 无反馈 | `unlabeled` | 0 | 只做分布统计，**不进评测** |

详见 [ADR-0009](docs/adr/0009-feedback-loop.md)。

### 转人工（ADR-0011）

满足任一条件自动建单，坐席在 `/console` 接单：

| 触发 | 判据 |
|---|---|
| `sensitive` | 12315 / 起诉 / 曝光 / 赔偿 / 退款没到 等升级表述（**优先判定**） |
| `user_request` | 人工 / 真人 / 找人 / 投诉 / 举报 / 差评 |
| `low_confidence` | 后端降级，或回答命中兜底话术 |

人工期间消息**不再经过模型**，原样进工单；坐席结束后同一条会话自动回到 AI。转接前 6 轮问答会一并交给坐席，客户不用重复描述。

```bash
# 坐席台（单文件、零构建，客户运维不需要 Node 工具链）
open http://localhost:8787/console

# 队列：排队 + 接待中，含转接原因、等待时长、最后一句
curl -s http://localhost:8787/api/handoff/queue | python3 -m json.tool

# 用户端增量拉取人工回复（挂件每 1.5s 拉一次）
curl -s 'http://localhost:8787/api/chat/poll?sessionId=sess_x&afterSeq=0'
```

工单落 `var/data/handoff.jsonl`（事件溯源，重启重放，落盘即脱敏）。配置了 `ADMIN_TOKEN` 后坐席接口全部需要它。
详见 [ADR-0011](docs/adr/0011-human-handoff.md)。

### 公众号渠道（ADR-0012）

接入微信公众号 / 服务号（明文模式），用户发的消息由同一个智能体应答。`openid` 直接当会话 ID，跨渠道与网页挂件共用同一套人设、知识与转人工逻辑。

```bash
# 1. 配三件套（缺任一个 /wechat 返回 500 提示）
#    WECHAT_TOKEN / WECHAT_APPID / WECHAT_SECRET
# 2. 公众号后台「设置与开发 → 基本配置」填：
#    服务器地址：https://你的域名/wechat   Token：填 WECHAT_TOKEN
#    消息加解密方式选「明文模式」
```

微信被动回复有 5 秒超时：本系统先回「已收到」即时回执，答案走客服消息接口异步推送（48 小时内有效），不丢消息也不超时。

### 管理后台（ADR-0012）

`/admin` 单文件零构建，改完即时生效、无需重启：

```bash
open http://localhost:8787/admin
# 配置了 ADMIN_TOKEN 后需在页面顶部填入 token（或用 ?token=）
```

可改的项（改动逐请求透传 Python 智能层，实时生效）：

| 配置项 | 说明 |
|---|---|
| 客服人设 persona | 覆盖默认人设；**护栏规则永远追加、不可覆盖**（防幻觉/防泄漏） |
| 模型 model | 规划器模型名，可热切换 |
| temperature | 0~2 |
| maxTokens | 64~4096 |

`base_url` / `api_key` 仍走部署级环境变量，不会从页面泄露到越权修改。详见 [ADR-0012](docs/adr/0012-wechat-and-admin.md)。

### 测试与类型检查

```bash
npm test        # faq-engine / kb-core / agent / gateway 数据面（node:test）
npm run typecheck
```

## P1 已实现的关键设计（对应手册 ADR）

- **ADR-001 规则 + LLM 混合**：当前只落地"规则通道"（FAQ 匹配 + 转人工 + 兜底），`bot.ts` 中标注了 LLM 接入点——把 `streamText` 换成 new-api/Dify 流式转发即可，SSE 协议不变；
- **ADR-002 统一消息协议**：`@cs/protocol` 是跨端唯一契约，挂件与网关不各自定义消息格式；
- **ADR-003 SSE 优先**：`/api/chat` 用 POST + SSE（fetch + ReadableStream 手工解帧，EventSource 不支持带 body 的请求）。

## P2 路线（对齐手册 5.3）

1. LLM 接入：new-api 网关 + Dify 编排，替换兜底话术为真实长尾应答；
2. 评测集扩充至 200 条标注，建立 POC 基准分（解决率 / 首字延迟 / Top-5 召回）；
3. 坐席台增强：自动分配、坐席在线状态、排队超时兜底（当前是抢单制，见 ADR-0011 已知限制）；
4. ~~渠道扩展：微信生态适配器~~ ✅ 已落地（公众号 / 服务号明文模式，ADR-0012）；下一步可扩展企业微信 / 抖音 / 飞书；
5. 挂件 SDK 化：vite lib 构建 IIFE bundle + `window.CSWidget.mount()`；
6. 会话存储迁 Redis，私有化一键部署包（docker-compose）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 网关端口 |
| `MOCK_STREAM_DELAY_MS` | `24` | 规则通道模拟流式吐字间隔；设为 `0` 关闭延迟（测试用） |
| `LLM_BASE_URL` | `https://api.siliconflow.cn/v1` | 智能体规划器端点（任何 OpenAI 兼容服务） |
| `LLM_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | 规划模型 |
| `LLM_API_KEY` | 复用 `SILICONFLOW_API_KEY` | 规划器密钥 |
| `AGENT_MAX_STEPS` | `4` | 单轮最大「规划→行动」循环步数 |
| `FAQ_DIRECT_MIN_SCORE` | `0.8` | FAQ 直达分数下限，低分命中放行给智能体 |
| `DATA_DIR` | `var/data` | 对话与反馈落盘目录（JSONL）；容器部署时挂卷 |
| `WECHAT_TOKEN` | 空 | 公众号服务器 Token（配齐三件套才启用 `/wechat`） |
| `WECHAT_APPID` | 空 | 公众号 AppID |
| `WECHAT_SECRET` | 空 | 公众号 AppSecret（换取 access_token 推客服消息） |

管理后台（`/admin`）的人设 / 模型参数不走 `.env`，改在页面里实时保存到 `var/data/admin-config.json`。
