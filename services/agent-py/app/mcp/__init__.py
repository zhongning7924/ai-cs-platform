"""MCP 接入层：协议客户端 + 工具适配器。"""

from .adapter import McpManager, McpTool, parse_server_configs
from .client import McpError, McpServerConfig, McpStdioClient

__all__ = [
    "McpError",
    "McpManager",
    "McpServerConfig",
    "McpStdioClient",
    "McpTool",
    "parse_server_configs",
]
