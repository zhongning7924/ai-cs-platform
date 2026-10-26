"""记忆层：滑窗对话 + 待确认动作。

生产环境换成 Redis 只需实现同一个 AgentMemory 协议，runtime 不用动。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol

from .types import ChatTurn, PendingConfirm

CONFIRM_TTL_SECONDS = 600.0


class AgentMemory(Protocol):
    def window(self, session_id: str, limit: int) -> list[ChatTurn]: ...
    def append(self, session_id: str, turn: ChatTurn) -> None: ...
    def pending_confirm(self, session_id: str) -> PendingConfirm | None: ...
    def set_pending_confirm(self, session_id: str, pending: PendingConfirm | None) -> None: ...


@dataclass
class InMemoryMemory:
    """进程内记忆。多实例部署时会丢，但 MVP/单实例够用。"""

    _turns: dict[str, list[ChatTurn]] = field(default_factory=dict)
    _pending: dict[str, tuple[PendingConfirm, float]] = field(default_factory=dict)

    def window(self, session_id: str, limit: int) -> list[ChatTurn]:
        return self._turns.get(session_id, [])[-limit:]

    def append(self, session_id: str, turn: ChatTurn) -> None:
        self._turns.setdefault(session_id, []).append(turn)

    def pending_confirm(self, session_id: str) -> PendingConfirm | None:
        hit = self._pending.get(session_id)
        if not hit:
            return None
        pending, stored_at = hit
        if time.time() - stored_at > CONFIRM_TTL_SECONDS:
            # 过期作废：用户隔了很久才回"确认"，不该执行旧动作
            self._pending.pop(session_id, None)
            return None
        return pending

    def set_pending_confirm(self, session_id: str, pending: PendingConfirm | None) -> None:
        if pending is None:
            self._pending.pop(session_id, None)
        else:
            self._pending[session_id] = (pending, time.time())
