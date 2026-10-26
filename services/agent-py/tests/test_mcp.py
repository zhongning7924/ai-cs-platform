"""MCP 闭环测试：真起子进程，走完整 initialize → tools/list → tools/call。

这里不用 mock：MCP 的价值就在「进程间协议真的通了」，
mock 掉子进程等于把最该验证的部分跳过。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from app.agent.registry import ToolRegistry
from app.mcp.adapter import McpManager, parse_server_configs
from app.mcp.client import McpServerConfig, McpStdioClient

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEMO = SERVICE_ROOT / "mcp_servers" / "demo_server.py"


def demo_config() -> McpServerConfig:
    return McpServerConfig(name="demo", command=sys.executable, args=[str(DEMO)], timeout=15.0)


def test_handshake_and_list_tools() -> None:
    async def run() -> None:
        client = await McpStdioClient(demo_config()).start()
        try:
            assert client.server_info.get("name") == "cs-demo-mcp"
            tools = await client.list_tools()
            names = {t["name"] for t in tools}
            assert names == {"logistics_track", "coupon_status"}
        finally:
            await client.close()

    asyncio.run(run())


def test_call_tool_returns_trace() -> None:
    async def run() -> None:
        client = await McpStdioClient(demo_config()).start()
        try:
            result = await client.call_tool("logistics_track", {"trackingNo": "SF1380000123"})
            text = result["content"][0]["text"]
            assert "SF1380000123" in text
            assert "派送中" in text
            assert result["isError"] is False
        finally:
            await client.close()

    asyncio.run(run())


def test_unknown_tool_is_error_not_crash() -> None:
    async def run() -> None:
        client = await McpStdioClient(demo_config()).start()
        try:
            result = await client.call_tool("nope", {})
            assert result["isError"] is True
            assert "未知工具" in result["content"][0]["text"]
        finally:
            await client.close()

    asyncio.run(run())


def test_manager_registers_tools_into_registry() -> None:
    async def run() -> None:
        registry = ToolRegistry()
        manager = McpManager(registry, [demo_config()])
        status = await manager.start()
        try:
            assert not status["errors"], status["errors"]
            assert "logistics_track" in registry.names()
            assert "coupon_status" in registry.names()

            tool = registry.get("logistics_track")
            assert tool is not None
            assert tool.spec.risk == "low"
            assert tool.spec.parameters.required == ["trackingNo"]

            result = await tool.execute({"trackingNo": "JD7300112234"}, ctx=None)  # type: ignore[arg-type]
            assert "已签收" in result.observation
        finally:
            await manager.close()

    asyncio.run(run())


def test_manager_survives_broken_server() -> None:
    async def run() -> None:
        registry = ToolRegistry()
        broken = McpServerConfig(name="broken", command="/nonexistent/binary", args=[], timeout=3.0)
        manager = McpManager(registry, [broken, demo_config()])
        status = await manager.start()
        try:
            # 坏 server 只记录错误，好 server 照常注册
            assert any(e["server"] == "broken" for e in status["errors"])
            assert "logistics_track" in registry.names()
        finally:
            await manager.close()

    asyncio.run(run())


def test_parse_configs_includes_demo_by_default() -> None:
    configs = parse_server_configs("", demo=True, timeout=5.0, service_root=SERVICE_ROOT)
    assert [c.name for c in configs] == ["demo"]


def test_parse_configs_reads_json_array() -> None:
    raw = '[{"name":"fs","command":"npx","args":["-y","server-filesystem","/tmp"]}]'
    configs = parse_server_configs(raw, demo=False, timeout=5.0, service_root=SERVICE_ROOT)
    assert len(configs) == 1
    assert configs[0].name == "fs"
    assert configs[0].command == "npx"
    assert configs[0].args == ["-y", "server-filesystem", "/tmp"]


def test_parse_configs_tolerates_bad_json() -> None:
    configs = parse_server_configs("{not json", demo=False, timeout=5.0, service_root=SERVICE_ROOT)
    assert configs == []
