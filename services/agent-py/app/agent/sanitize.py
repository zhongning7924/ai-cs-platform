"""观察结果转用户话术。

工具返回的 observation 是「写给模型看的」——里面混着指令，
例如「知识库查询失败。请如实告知用户稍后再试，不要编造答案。」
这句话喂给模型是对的，但降级路径（规则规划器 / 步数用尽）会把
observation 直接当回复输出，用户就会看到一句写给 AI 的提醒。

这里做一件很小的事：把指令行摘掉，只留事实。摘干净了返回空串，
调用方自己决定兜底话术。
"""

from __future__ import annotations

import re

# 以这些词命中的行视为「对模型说的话」，不对用户展示
_INSTRUCTION_MARKERS = re.compile(
    r"请如实告知|不要编造|请让用户|禁止|务必|请先调|需要先调|请改用|不要用"
)


def user_safe_echo(text: str, limit: int = 200) -> str:
    """摘掉指令行后的观察文本，供降级路径直接展示。"""
    lines = [line for line in text.splitlines() if not _INSTRUCTION_MARKERS.search(line)]
    return "\n".join(lines).strip()[:limit]
