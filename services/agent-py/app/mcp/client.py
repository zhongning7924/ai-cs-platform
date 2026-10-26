"""MCP 客户端：JSON-RPC 2.0 over stdio。

刻意不引官方 `mcp` SDK：stdio 传输本质就是「一行一个 JSON-RPC 消息」，
自己实现约 160 行即可，私有化交付时少一棵传递依赖树。
协议版本锁定 2024-11-05（目前服务端支持面最广的基线）；
握手失败直接抛错，由上层决定是否跳过该 server——绝不静默半可用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from collections import deque
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("mcp.client")

PROTOCOL_VERSION = "2024-11-05"
CLIENT_INFO = {"name": "cs-agent-py", "version": "0.1.0"}


class McpError(RuntimeError):
    """MCP 协议层错误（握手失败、工具报错、进程退出）。"""


@dataclass
class McpServerConfig:
    """一个 MCP server 的启动参数（对齐 mcp.json 的 stdio 配置形状）。"""

    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    cwd: str | None = None
    timeout: float = 20.0


class McpStdioClient:
    """最小可用的 MCP stdio 客户端：initialize → tools/list → tools/call。"""

    def __init__(self, config: McpServerConfig) -> None:
        self.config = config
        self.server_info: dict[str, Any] = {}
        self.capabilities: dict[str, Any] = {}

        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._next_id = 0
        self._reader: asyncio.Task[None] | None = None
        self._stderr_drain: asyncio.Task[None] | None = None
        self._stderr_tail: deque[str] = deque(maxlen=20)

    # ---------------------------------------------------------------- 生命周期

    async def start(self) -> "McpStdioClient":
        command = sys.executable if self.config.command in ("python", "python3") else self.config.command
        env = {**os.environ, **self.config.env}

        try:
            self._proc = await asyncio.create_subprocess_exec(
                command,
                *self.config.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=self.config.cwd,
            )
        except FileNotFoundError as err:
            raise McpError(f"启动失败：找不到命令 {command}") from err

        self._reader = asyncio.create_task(self._read_loop(), name=f"mcp-read-{self.config.name}")
        self._stderr_drain = asyncio.create_task(
            self._drain_stderr(), name=f"mcp-err-{self.config.name}"
        )

        try:
            result = await self.request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": CLIENT_INFO,
                },
            )
        except Exception:
            await self.close()
            raise

        self.server_info = result.get("serverInfo") or {}
        self.capabilities = result.get("capabilities") or {}
        await self.notify("notifications/initialized")
        log.info(
            "MCP server 就绪: %s（%s %s）",
            self.config.name,
            self.server_info.get("name", "unknown"),
            self.server_info.get("version", ""),
        )
        return self

    async def close(self) -> None:
        for task in (self._reader, self._stderr_drain):
            if task is not None and not task.done():
                task.cancel()

        proc, self._proc = self._proc, None
        if proc is None:
            return

        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        except Exception:  # noqa: BLE001 - 关流失败不影响收尾
            pass

        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()

    # ---------------------------------------------------------------- 协议调用

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise McpError(f"MCP server {self.config.name} 未启动")

        self._next_id += 1
        request_id = self._next_id
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params

        try:
            proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            await proc.stdin.drain()
            return await asyncio.wait_for(future, timeout=self.config.timeout)
        except asyncio.TimeoutError as err:
            raise McpError(f"{method} 超时（>{self.config.timeout}s）{self._stderr_hint()}") from err
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise McpError(f"MCP server {self.config.name} 未启动")
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await proc.stdin.drain()

    async def list_tools(self) -> list[dict[str, Any]]:
        result = await self.request("tools/list")
        tools = result.get("tools")
        return [t for t in tools if isinstance(t, dict) and t.get("name")] if tools else []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self.request("tools/call", {"name": name, "arguments": arguments or {}})

    # ---------------------------------------------------------------- 内部循环

    async def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except json.JSONDecodeError:
                    log.warning("MCP %s 输出非 JSON，已忽略: %s", self.config.name, text[:200])
                    continue
                self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            log.warning("MCP %s 读循环异常: %s", self.config.name, err)
        finally:
            self._fail_pending(
                McpError(f"MCP server {self.config.name} 连接已断开{self._stderr_hint()}")
            )

    def _dispatch(self, message: dict[str, Any]) -> None:
        # 服务端主动请求（sampling/roots 等）当前不支持，按 JSON-RPC 规范回 method not found
        if "method" in message and "id" in message:
            log.warning("MCP %s 发起未支持的服务端请求: %s", self.config.name, message.get("method"))
            return

        request_id = message.get("id")
        if request_id is None:
            return  # 通知，无需响应

        try:
            key: Any = int(request_id)
        except (TypeError, ValueError):
            key = request_id
        future = self._pending.get(key)
        if future is None or future.done():
            return

        if "error" in message:
            error = message["error"] or {}
            future.set_exception(
                McpError(f"{error.get('message', 'unknown error')}（code={error.get('code')}）")
            )
        else:
            result = message.get("result")
            future.set_result(result if isinstance(result, dict) else {"value": result})

    def _fail_pending(self, error: Exception) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    self._stderr_tail.append(text)
                    log.debug("MCP %s stderr: %s", self.config.name, text)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            pass

    def _stderr_hint(self) -> str:
        if not self._stderr_tail:
            return ""
        return "；stderr: " + " | ".join(list(self._stderr_tail)[-3:])
