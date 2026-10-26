"""最小 MCP server（纯标准库），用来验证「MCP → ToolRegistry → LLM」闭环。

它模拟的是**企业外部系统**：第三方物流轨迹 + 优惠券中心。
与内置的 kb_search / query_order 是两套完全独立的工具来源——
证明「加工具不用改内核」不是纸面说法。

协议：JSON-RPC 2.0 over stdio，一行一条消息；stdout 只允许出现协议消息，
日志一律走 stderr（否则会污染帧流）。
"""

from __future__ import annotations

import json
import sys
from typing import Any

SERVER_INFO = {"name": "cs-demo-mcp", "version": "0.1.0"}
PROTOCOL_VERSION = "2024-11-05"

TRACKS: dict[str, list[tuple[str, str]]] = {
    "SF1380000123": [
        ("2026-10-22 09:12", "已揽收 · 杭州余杭仓"),
        ("2026-10-23 18:40", "运输中 · 杭州 → 上海"),
        ("2026-10-24 08:05", "派送中 · 上海浦东新区"),
    ],
    "JD7300112234": [
        ("2026-10-20 14:30", "已出库 · 苏州分拨中心"),
        ("2026-10-21 11:05", "已签收 · 本人签收"),
    ],
}

COUPONS: dict[str, list[dict[str, Any]]] = {
    "default": [
        {"code": "NEW50", "title": "新人立减 50 元", "threshold": "满 299 可用", "expires": "2026-11-30"},
        {"code": "FREESHIP", "title": "免运费券", "threshold": "无门槛", "expires": "2026-12-31"},
    ]
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "logistics_track",
        "description": (
            "查询第三方物流轨迹（顺丰 / 京东运单号）。当用户给出快递单号、"
            "或想知道包裹到了哪个节点时调用。只接受运单号，不要传订单号。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "trackingNo": {
                    "type": "string",
                    "description": "快递运单号，如 SF1380000123 或 JD7300112234",
                }
            },
            "required": ["trackingNo"],
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "coupon_status",
        "description": "查询用户名下可用的优惠券（券码、门槛、有效期）。用户问优惠券、满减、折扣时调用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "userId": {"type": "string", "description": "用户 id（可选，缺省按当前会话用户）"}
            },
        },
        "annotations": {"readOnlyHint": True},
    },
]


def _text(value: str, *, is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": value}], "isError": is_error}


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "logistics_track":
        tracking_no = str(arguments.get("trackingNo", "")).strip().upper()
        nodes = TRACKS.get(tracking_no)
        if not nodes:
            return _text(
                f"未查到运单 {tracking_no or '(空)'} 的轨迹。请让用户核对运单号（示例：SF1380000123）。"
            )
        lines = [f"{ts}  {desc}" for ts, desc in nodes]
        return _text(f"运单 {tracking_no} 共 {len(nodes)} 个节点：\n" + "\n".join(lines))

    if name == "coupon_status":
        user_id = str(arguments.get("userId") or "default")
        coupons = COUPONS.get(user_id) or COUPONS["default"]
        lines = [
            f"{c['code']}｜{c['title']}｜{c['threshold']}｜有效期至 {c['expires']}" for c in coupons
        ]
        return _text(f"用户 {user_id} 可用优惠券 {len(coupons)} 张：\n" + "\n".join(lines))

    return _text(f"未知工具：{name}", is_error=True)


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")

    # 通知不需要响应
    if method and method.startswith("notifications/"):
        return None

    if method == "initialize":
        result: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = message.get("params") or {}
        result = call_tool(str(params.get("name", "")), params.get("arguments") or {})
    elif method == "ping":
        result = {}
    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    if request_id is None:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            print(f"[demo-mcp] 非法 JSON: {raw[:120]}", file=sys.stderr, flush=True)
            continue

        response = handle(message)
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
