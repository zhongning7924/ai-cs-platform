# ai-cs-platform

AI 智能客服平台 Monorepo —— 对应《AI 智能客服底座建设与快速部署实战手册》**第五章 P1 阶段（最小闭环）**的可运行骨架。

## 这个仓库是什么

不是演示玩具，而是按手册五层架构切分的工程起点：**社区已有的取社区（React/Vite/Express），场景核心的自研发（挂件、统一协议、机器人规则通道）**。当前范围 = P1 最小闭环：**网页渠道 + FAQ 场景**，全链路可跑：挂件 → 网关 → 机器人引擎 → SSE 流式回显。

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
│   │       └── session.ts #   会话管理（P1 内存版，P2 换 Redis）
│   ├── web-widget/        # @cs/web-widget L1 网页挂件（React + Shadow DOM）
│   │   ├── index.html     #   演示宿主页（模拟商家页面）
│   │   └── src/widget/    #   mount(Shadow DOM) / api(SSE) / cards / Widget(tool 状态条)
│   └── console/           # @cs/console   L4 管理后台（P2 占位，见其 README）
├── docs/adr/              # 架构决策记录（0001-0006）
├── docs/research/         # 选型调研
├── samples/kb-sources/    # 知识库示例文档
├── tsconfig.base.json
└── package.json          # npm workspaces
```

### 架构映射（手册五层 ↔ 代码）

| 手册层 | 模块 | 落地方式 | 状态 |
| --- | --- | --- | --- |
| L1 渠道层 | apps/web-widget | 自研（挂件是 FED 门面） | P1 已实现 |
| L2 接入网关层 | apps/gateway | 自研核心（会话/路由）+ Express | P1 已实现 |
| L3 规则通道 | packages/faq-engine | 自研（口径可控，高分直达） | P1 已实现 |
| L3 智能体 | packages/agent + gateway/agent.ts | 自研核心（Planner/Tool/Memory/护栏）+ LLM 租用 | P3 已实现（ADR-0006） |
| L3 知识库引擎 | packages/kb-core（Qdrant + 硅基流动） | 混合：存储与模型租用，检索内核自研 | 已实现（在线） |
| L3 LLM 网关 | LLM_BASE_URL 可指 new-api / llm-proxy | 取社区 | 智能体直连可用，P2 换 new-api 收口 |
| L3 人机协同 | 高风险工具确认护栏 + Chatwoot（P2） | 混合 | P1 桩（create_ticket 演示） |
| L4 企业部署层 | apps/console + deploy | 自研（商业命脉） | P2 |
| L5 数据层 | gateway 内存会话 → P2 PostgreSQL/Redis | 自研模型 + 取社区存储 | P1 内存版 |

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

### 测试与类型检查

```bash
npm test        # faq-engine 评测集（node:test）
npm run typecheck
```

## P1 已实现的关键设计（对应手册 ADR）

- **ADR-001 规则 + LLM 混合**：当前只落地"规则通道"（FAQ 匹配 + 转人工 + 兜底），`bot.ts` 中标注了 LLM 接入点——把 `streamText` 换成 new-api/Dify 流式转发即可，SSE 协议不变；
- **ADR-002 统一消息协议**：`@cs/protocol` 是跨端唯一契约，挂件与网关不各自定义消息格式；
- **ADR-003 SSE 优先**：`/api/chat` 用 POST + SSE（fetch + ReadableStream 手工解帧，EventSource 不支持带 body 的请求）。

## P2 路线（对齐手册 5.3）

1. LLM 接入：new-api 网关 + Dify 编排，替换兜底话术为真实长尾应答；
2. 评测集扩充至 200 条标注，建立 POC 基准分（解决率 / 首字延迟 / Top-5 召回）；
3. 坐席工作台：引入 Chatwoot 二开或自研，打通转人工；
4. 渠道扩展：微信生态适配器（验证"新渠道 ≤3 人日"验收标准）；
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
