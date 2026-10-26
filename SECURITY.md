# Security Policy

## 支持范围

仅最新 main 分支获得安全修复。

## 报告漏洞

**请不要在公开 Issue 中描述可被利用的漏洞。**

通过 GitHub 私密漏洞报告（Security 标签页 → Report a vulnerability）提交，或邮件联系仓库所有者。

包含以下信息有助于更快定位：

- 受影响的模块（gateway / agent-py / web-widget / kb-core）
- 复现步骤或 PoC
- 影响评估（数据泄露 / 拒绝服务 / 越权）

## 已知设计边界（不视为漏洞，但欢迎讨论）

- 单实例架构：会话、工单、限流计数在进程内存中，见 `deploy/README.md` 扩容前须知
- 管理面使用单一共享 token（`ADMIN_TOKEN`），不区分操作人
- 反馈数据集导出接口（`/api/dataset/export`）包含脱敏后的全量对话，必须配置 `ADMIN_TOKEN` 或限制来源后才能暴露到非本机网络
