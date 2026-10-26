"""工具注册表：宿主唯一需要往内核里塞东西的地方。"""

from __future__ import annotations

from .types import Tool, ToolSpec


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, *tools: Tool) -> None:
        for tool in tools:
            self._tools[tool.spec.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def specs(self) -> list[ToolSpec]:
        return [t.spec for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def openai_tools(self) -> list[dict]:
        return [t.spec.openai_tool() for t in self._tools.values()]
