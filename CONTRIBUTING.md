# Contributing

欢迎 Issue 和 PR。

## 提交前

```bash
npm run typecheck   # TS 类型检查
npm test            # TS 测试（node:test）
python -m pytest services/agent-py/tests -q   # Python 测试
```

CI 会跑同样三步，本地通过再提交最省事。

## 约定

- **架构改动先开 Issue**。本仓库用 ADR（`docs/adr/`）记录决策，重要改动请先讨论再动手；新增决策以 `docs/adr/00XX-<slug>.md` 追加，不改旧 ADR。
- **测试与实现同 PR**。修 bug 必须带回归用例；新功能至少覆盖状态机/校验分支。
- **中文注释与文档**。代码注释、ADR、README 均使用简体中文，保持一致。
- 提交信息用祈使句，如 `fix: 差评面板展开后提交按钮被挤出可视区`。

## 开发环境

- Node >= 20（CI 用 22）
- Python 3.11（`services/agent-py/requirements.txt`，无需虚拟环境强制）
- 本地模型密钥见 `.env.example`，全部可免费起步（Qdrant Cloud / SiliconFlow 免费档）
