# ADR-0007：MCP 与 Skills —— 用「缝」而不是「改内核」扩展能力

- 状态：已采纳
- 日期：2026-10-26
- 关联：ADR-0006（智能体架构 / 四个扩展缝）

## 背景

竞品能力矩阵里，「Agent / FunctionCall / MCP / Skills / 不同模型组合」通常打包宣传。
我们已有 Agent 循环与 FunctionCall，但工具只能靠宿主写死注册（`tools/builtin.py`），
每加一个外部系统就要改代码、重发布。

需要解决两件事：

1. **工具来源可插拔**：让智能体能接任意 MCP server，不改 runtime。
2. **领域知识可插拔**：让同一套工具在不同业务场景下表现出不同「专业技能」，
   而不是把所有规则堆进一条系统提示。

## 决策

### 1. MCP：手写 stdio 客户端 + 工具适配器

- 不引官方 `mcp` SDK。MCP 的 stdio 传输就是「一行一条 JSON-RPC 2.0」，
  自实现约 160 行（`app/mcp/client.py`），私有化交付少一棵传递依赖树。
- 协议版本锁 `2024-11-05`，握手失败**显式报错并跳过该 server**，不静默半可用。
- `app/mcp/adapter.py` 把远端 `tools/list` 的 `inputSchema` 转成内核的 `JsonSchema`，
  注册进现有 `ToolRegistry`。`runtime.py` / `planner_llm.py` 一行不改。
- 风险映射：MCP 的 `annotations.destructiveHint=true` → `risk="high"`，
  自动复用已有的「高风险动作先要用户确认」护栏。
- 工具重名时加 server 名前缀（`<server>_<tool>`），否则保持原名（模型侧更短）。

### 2. Skills：触发式上下文增强，不做权限隔离

- 技能 = `triggers` + `instructions` + `tools` 偏好（`app/skills/`）。
- 命中在 `AgentRuntime._loop` 里做一次，随 `PlannerContext.skill` 传给规划器；
  规划器把技能指令拼进系统提示，并把技能偏好的工具排到列表前面。
- **不禁止调用其它工具**。规则通道的教训：一旦按意图硬拦，动作类诉求会被误伤
  （「我要建工单」被 FAQ 直接答掉）。技能只加约束，不删能力。

## 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 用官方 `mcp` SDK | 依赖树大，私有化体积敏感；stdio 协议本身很薄 |
| MCP 只支持 HTTP/SSE 传输 | 主流本地 server 都是 stdio；HTTP 版可后续在 client 内加分支 |
| 技能 = 工具白名单（硬隔离） | 直接复刻规则通道的误伤问题；用户诉求跨技能时会被锁死 |
| 技能 = 独立子智能体 | MVP 过度设计；多一层规划开销，7B 模型收益不明显 |

## 后果

**收益**
- 接新外部系统只需在 `MCP_SERVERS` 加一条 JSON，零代码、零重发布。
- 领域规则从「一条长系统提示」拆成可独立演进的文件，加技能不改内核。
- 技能与 MCP 都复用现有四个缝，架构没有分叉。

**代价**
- MCP server 是独立进程：多一个进程要管（超时、僵尸进程、stderr 污染）。
  已在 client 里做 stderr 隔离、terminate/kill 兜底、单 server 失败不拖垮整体。
- 技能匹配是子串覆盖度，不做语义匹配：触发词写窄会漏，写宽会误触。
  当前 4 个技能用 `min_hits` + 长度加权控制；后续可换 embedding 匹配。
- 技能指令会占用系统提示 token；技能多了要做按需加载（当前 4 个可接受）。

## 验证

- 单测：`tests/test_mcp.py`（真起子进程，握手/列表/调用/坏 server 容错）、
  `tests/test_skills.py`（四个技能命中 + 问候不命中 + 空注册表）。
- 真机：`logistics_track` / `coupon_status` 两个 MCP 工具被 7B 模型正确选中；
  `我要退款，沙发有异味` 命中 `refund` 技能并先查知识库。
