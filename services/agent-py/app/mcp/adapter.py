"""MCP 工具适配器：把远端 MCP 工具翻译成内核的 Tool 契约。

这是「扩展缝 ②」的落点：runtime / planner 完全不知道工具来自 MCP，
它们只看到 ToolRegistry 里多了一条 ToolSpec。加一个 MCP server 等于加一批工具。
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..agent.registry import ToolRegistry
from ..agent.types import JsonSchema, ToolContext, ToolResult, ToolSpec
from .client import McpServerConfig, McpStdioClient

log = logging.getLogger("mcp.adapter")

SERVICE_ROOT = Path(__file__).resolve().parents[2]
DEMO_SERVER = SERVICE_ROOT / "mcp_servers" / "demo_server.py"

# OpenAI Function Calling 只认这几种子 schema 字段，多余的（$schema、$id）会干扰小模型
_ALLOWED_PROP_KEYS = ("type", "description", "enum", "items", "default")


def _to_json_schema(raw: dict[str, Any]) -> JsonSchema:
    properties: dict[str, dict[str, Any]] = {}
    for key, value in (raw.get("properties") or {}).items():
        if not isinstance(value, dict):
            continue
        cleaned = {k: v for k, v in value.items() if k in _ALLOWED_PROP_KEYS}
        if not cleaned.get("type"):
            cleaned["type"] = "string"
        properties[str(key)] = cleaned

    required = raw.get("required")
    return JsonSchema(
        type=str(raw.get("type") or "object"),
        properties=properties,
        required=[str(r) for r in required] if isinstance(required, list) else [],
    )


@dataclass
class McpTool:
    """一个远端 MCP 工具在本地的投影。"""

    spec: ToolSpec
    client: McpStdioClient
    remote_name: str
    server: str

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        try:
            result = await self.client.call_tool(self.remote_name, args)
        except Exception as err:  # noqa: BLE001 - 网络/进程错误转成观察，不打断对话
            log.warning("MCP 工具 %s/%s 调用失败: %s", self.server, self.remote_name, err)
            return ToolResult(
                observation=f"外部工具 {self.server}/{self.remote_name} 调用失败：{err}。"
                "请如实告知用户该查询暂不可用，不要编造结果。"
            )

        texts = [
            str(item.get("text"))
            for item in (result.get("content") or [])
            if isinstance(item, dict) and item.get("type") == "text" and item.get("text")
        ]
        text = "\n".join(texts).strip() or "（工具已执行，无文本返回）"
        if result.get("isError"):
            text = f"外部工具返回错误：{text}"
        return ToolResult(observation=text[:1200])


@dataclass
class McpManager:
    """管理 MCP server 生命周期，并把发现的工具注册进 ToolRegistry。"""

    registry: ToolRegistry
    configs: list[McpServerConfig] = field(default_factory=list)
    enabled: bool = True

    _clients: list[McpStdioClient] = field(default_factory=list, init=False)
    _tools: list[McpTool] = field(default_factory=list, init=False)
    _errors: list[dict[str, str]] = field(default_factory=list, init=False)
    _started: bool = field(default=False, init=False)

    async def start(self) -> dict[str, Any]:
        if not self.enabled or self._started:
            return self.status()
        self._started = True

        for config in self.configs:
            try:
                client = await McpStdioClient(config).start()
                remote_tools = await client.list_tools()
            except Exception as err:  # noqa: BLE001 - 单个 server 失败不能拖垮服务
                log.warning("MCP server %s 启动失败，已跳过: %s", config.name, err)
                self._errors.append({"server": config.name, "error": str(err)})
                continue

            registered = 0
            for remote in remote_tools:
                tool = self._build_tool(client, config.name, remote)
                if tool is None:
                    continue
                # 与内置工具重名时加 server 前缀，保持模型侧名字尽量短
                if self.registry.get(tool.spec.name) is not None:
                    tool.spec.name = f"{config.name}_{remote['name']}"
                if self.registry.get(tool.spec.name) is not None:
                    log.warning("MCP 工具 %s 与已有工具重名，已跳过", tool.spec.name)
                    continue
                self.registry.register(tool)
                self._tools.append(tool)
                registered += 1

            self._clients.append(client)
            log.info(
                "MCP server %s 已接入：注册 %d 个工具（%s）",
                config.name,
                registered,
                ", ".join(t.spec.name for t in self._tools[-registered:]) or "无",
            )

        return self.status()

    def _build_tool(
        self, client: McpStdioClient, server: str, remote: dict[str, Any]
    ) -> McpTool | None:
        name = str(remote.get("name") or "").strip()
        if not name:
            return None

        annotations = remote.get("annotations") or {}
        # MCP 的 destructiveHint 直接映射到我们的高风险护栏：会先要用户确认
        risk = "high" if annotations.get("destructiveHint") else "low"
        description = str(remote.get("description") or f"外部 MCP 工具 {server}/{name}")
        schema = remote.get("inputSchema") if isinstance(remote.get("inputSchema"), dict) else {}

        return McpTool(
            spec=ToolSpec(
                name=name,
                description=f"[外部系统 {server}] {description}",
                parameters=_to_json_schema(schema),
                risk=risk,
            ),
            client=client,
            remote_name=name,
            server=server,
        )

    async def close(self) -> None:
        for client in self._clients:
            try:
                await client.close()
            except Exception as err:  # noqa: BLE001
                log.debug("关闭 MCP client 失败: %s", err)
        self._clients.clear()
        self._started = False

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "servers": [
                {
                    "name": c.config.name,
                    "command": c.config.command,
                    "args": c.config.args,
                    "serverInfo": c.server_info,
                    "tools": [t.remote_name for t in self._tools if t.client is c],
                }
                for c in self._clients
            ],
            "tools": [
                {"name": t.spec.name, "remote": t.remote_name, "server": t.server, "risk": t.spec.risk}
                for t in self._tools
            ],
            "errors": self._errors,
        }

    @property
    def tool_names(self) -> list[str]:
        return [t.spec.name for t in self._tools]


def parse_server_configs(
    raw: str,
    *,
    demo: bool = True,
    timeout: float = 20.0,
    service_root: Path | None = None,
) -> list[McpServerConfig]:
    """解析 MCP_SERVERS（JSON 数组），并按需挂上内置演示 server。

    支持两种写法：
      [{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]
      单个对象也可以（自动包成数组）。
    """
    configs: list[McpServerConfig] = []

    if raw.strip():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as err:
            log.error("MCP_SERVERS 不是合法 JSON，已忽略: %s", err)
            data = []
        if isinstance(data, dict):
            data = [data]
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict) or not item.get("command"):
                    log.warning("MCP_SERVERS 条目缺少 command，已跳过: %s", item)
                    continue
                args = item.get("args") or []
                env = item.get("env") or {}
                configs.append(
                    McpServerConfig(
                        name=str(item.get("name") or f"mcp{len(configs) + 1}"),
                        command=str(item["command"]),
                        args=[str(a) for a in args] if isinstance(args, list) else [],
                        env={str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {},
                        cwd=str(item["cwd"]) if item.get("cwd") else None,
                        timeout=float(item.get("timeout") or timeout),
                    )
                )

    if demo and not any(c.name == "demo" for c in configs):
        root = service_root or SERVICE_ROOT
        if (root / "mcp_servers" / "demo_server.py").exists():
            configs.append(
                McpServerConfig(
                    name="demo",
                    command=sys.executable,
                    args=[str(root / "mcp_servers" / "demo_server.py")],
                    timeout=timeout,
                )
            )

    return configs
