# ADR-0006：最小客服智能体架构（可扩展）

- 状态：Accepted
- 日期：2026-10-25
- 关联：ADR-001（双通道）、ADR-002（统一协议）、ADR-004（向量存储与 Embedding）

## 1. 背景

P1 上线的是"工作流机器人"：`bot.ts` 里写死的决策链（转人工 → FAQ → KB → 兜底）。
业界所说的"客服智能体"，判定标准是**控制权转移**：LLM 在运行时自主决定先查什么、调什么、怎么答，而不是开发者用 if/else 预定义每一步。

需求：用最小代价把系统升级为真智能体，同时保证三点——

1. 没配 LLM 时系统照常工作（降级不瘫痪）；
2. 高风险操作（建工单、退款类）必须有护栏；
3. 未来换模型 / 换记忆 / 加工具 / 上多智能体，都不需要改核心循环。

## 2. 决策

采用 **Bounded Agent（受约束的智能体）** 形态，核心是四个可替换接口 + 一个事件循环：

```
护栏① 规则通道（转人工/FAQ 直达，口径可控）
   └─ 未命中 → AgentRuntime 循环（≤ AGENT_MAX_STEPS 步）
        ① Planner   决策层：LLM 规划器（OpenAI 兼容流式 + tool_calls）⇄ Rule 规划器（降级）
        ② ToolRegistry 行动层：工具带 risk 等级，register 一次即接入
        ③ Memory    记忆层：会话窗口（InMemory，可换 Redis/PG）
        ④ 护栏      高风险工具 → 暂挂 pendingConfirm → 用户「确认/取消」→ 才执行
   事件流（delta / tool / card / end）→ SSE → 挂件
```

关键设计：

| 决策 | 内容 | 理由 |
|---|---|---|
| 事件循环而非一次性问答 | Planner 每步返回 `reply` 或 `tool_call`，工具观察结果回灌下一步 | 这是智能体与聊天机器人的分界；也是 Function Calling 的标准形态 |
| LLM→Rule 降级链 | LLM 异常时整轮切换 RulePlanner（规则通道语义不变） | 没配 key / 网络故障 / 模型 5xx，系统都不瘫 |
| FAQ 规则通道前置 | 转人工、FAQ 命中不进智能体 | 合规口径 100% 可控、零 LLM 成本、P99 延迟稳定 |
| 风险等级 + 确认护栏 | `risk:'high'` 的工具先出确认卡片，用户确认后才执行 | 客服终局是受约束的智能体，不是全自动 |
| 观察即事实 | 工具返回文本是唯一事实来源，要求 LLM 不得编造 | 幻觉抑制的最简实现（ADR-001 合规红线的延伸） |
| 事件队列 | Runtime 内部 AsyncQueue，对外统一 `AsyncGenerator<AgentEvent>` | SSE / WebSocket / 内部调用都能消费，传输层无关 |

## 3. 扩展缝（加东西不改核心）

- **加一个工具**：`registry.register({ name, description, parameters, risk, execute })`，一行注册，协议自动把它变成 OpenAI tools 给规划器；
- **换规划器**：实现 `AgentPlanner.next(ctx)`（如 Dify/LangGraph 多智能体编排器），构造时传入即可；
- **换记忆**：实现 `AgentMemory`（Redis / PG），接口只有 window/append/pendingConfirm 三件事；
- **换 LLM**：`LLM_BASE_URL/LLM_MODEL` 环境变量，任何 OpenAI 兼容端点（硅基流动 / new-api / llm-proxy）；
- **加传输通道**：消费 `AgentEvent` 流即可（SSE 之外，WebSocket/企微回调同理）。

## 4. 后果

- 正面：单智能体（P3 目标）就此成立；工具与模型可并行演进；评测集可以按「工具选择正确率」扩维度。
- 代价：`/api/chat` 出现两种响应路径（规则直达 vs 智能体循环），排障要看 planner 元数据（done 事件带 `planner/toolCalls/degraded`）。
- 未决：多轮记忆跨进程持久化（P4）、工具执行审计日志（P4）、多智能体编排接入点（已留 Planner 接口）。

## 5. 默认配置

- 规划模型：`Qwen/Qwen2.5-7B-Instruct`（硅基流动免费档，非 `Pro/` 前缀）；
- 降级回复：faq-engine 的 `FALLBACK_ANSWER`；
- 步数上限：`AGENT_MAX_STEPS=4`；确认有效期 10 分钟。
