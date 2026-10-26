"""内置工具：对应 TS 侧 apps/gateway/src/agent.ts 注册的三个工具。

工具是纯业务代码，与内核通过 ToolSpec + ToolResult 解耦：
接真实订单中台/工单系统时只改这里，runtime 一行不动。
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ..kb.retrieval import Retriever
from ..schemas import CardField, CardPayload
from ..agent.types import JsonSchema, ToolContext, ToolResult, ToolSpec

log = logging.getLogger("tools")

FALLBACK_OBSERVATION = "知识库查询失败。请如实告知用户稍后再试，不要编造答案。"


class KbSearchTool:
    """企业知识库检索。密钥没配好时整个工具不注册，而不是注册了再报错。"""

    def __init__(self, retriever: Retriever) -> None:
        self.retriever = retriever
        self.spec = ToolSpec(
            name="kb_search",
            description=(
                "在企业知识库中检索原文片段，适用于所有知识类问题：产品参数与价格、库存与配送、"
                "售后政策、退换货规则、发货时效、发票、优惠券、内部流程等"
                "（\"多少钱、能不能、怎么、是否可以\"类问题都属于此类）。"
                "注意：查询某个具体订单请用 query_order，不要用本工具。"
            ),
            parameters=JsonSchema(
                properties={
                    "query": {
                        "type": "string",
                        "description": "检索关键词或问题，尽量精炼，如\"七天无理由退货\"",
                    }
                },
                required=["query"],
            ),
            risk="low",
        )

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = str(args.get("query", "")).strip()
        if not query:
            return ToolResult(observation="缺少检索关键词。")

        try:
            result = await self.retriever.retrieve(query, top_k=3)
        except Exception as err:  # noqa: BLE001
            log.warning("kb_search 失败：%s", err)
            return ToolResult(observation=FALLBACK_OBSERVATION)

        if not result.hits:
            return ToolResult(
                observation="知识库中未找到相关内容。请如实告知用户暂无相关资料，不要编造。"
            )

        top = result.hits[0]
        lines = [f"[{c.source_label}]\n{c.text}" for c in result.hits[:2]]
        tail = "（混合召回+重排）" if result.hybrid and result.reranked else ""
        return ToolResult(
            observation="\n---\n".join(lines) + tail,
            card=CardPayload(
                type="kb_ref",
                title=top.title,
                summary=top.heading_path,
                source=top.uri or top.title,
                confidence=round(top.best_score, 2),
            ),
        )


class QueryOrderTool:
    """订单查询。当前是 mock，换真实中台时只改 _fetch。"""

    spec = ToolSpec(
        name="query_order",
        description=(
            "按订单号查询订单状态与物流。仅当用户明确要求查订单、给出订单号或问物流时才调用；"
            "知识类、政策类问题禁止调用本工具。"
        ),
        parameters=JsonSchema(
            properties={
                "orderId": {
                    "type": "string",
                    "description": "订单号，如 CS1001（必须是 CS 开头的编号，不是问题原文）",
                }
            },
            required=["orderId"],
        ),
        risk="low",
    )

    MOCK_ORDERS: dict[str, dict[str, str]] = {
        "CS1001": {
            "product": "云朵沙发 三人位（米白）",
            "status": "已发货 · 运输中",
            "courier": "顺丰速运",
            "trackingNo": "SF1380000123",
            "updatedAt": "2026-10-24 18:20",
        },
        "CS1002": {
            "product": "原木茶几 1.2m",
            "status": "已签收",
            "courier": "京东物流",
            "trackingNo": "JD7300112234",
            "updatedAt": "2026-10-22 11:05",
        },
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        order_id = str(args.get("orderId", "")).strip().upper()
        order = self.MOCK_ORDERS.get(order_id)
        if not order:
            return ToolResult(
                observation=f"订单 {order_id or '(空)'} 不存在。请让用户核对订单号（示例：CS1001）。"
            )

        return ToolResult(
            observation=(
                f"订单 {order_id}：商品 {order['product']}；状态 {order['status']}；"
                f"{order['courier']} {order['trackingNo']}；更新于 {order['updatedAt']}。"
            ),
            card=CardPayload(
                type="order",
                title=f"订单 {order_id}",
                fields=[
                    CardField(label="商品", value=order["product"]),
                    CardField(label="状态", value=order["status"]),
                    CardField(label="物流", value=f"{order['courier']} {order['trackingNo']}"),
                    CardField(label="更新时间", value=order["updatedAt"]),
                ],
            ),
        )


class CreateTicketTool:
    """创建工单。risk=high：runtime 会拦下来要用户确认，绝不静默执行。"""

    spec = ToolSpec(
        name="create_ticket",
        description=(
            "为用户创建人工跟进工单（投诉、退款退货争议、破损补寄、人工处理诉求）。"
            "属于高风险操作：调用后需要用户明确确认才会真正执行。"
        ),
        parameters=JsonSchema(
            properties={
                "title": {"type": "string", "description": "工单标题，概括用户诉求"},
                "detail": {"type": "string", "description": "补充细节（可选）"},
            },
            required=["title"],
        ),
        risk="high",
    )

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        title = str(args.get("title") or "未命名工单")
        detail = str(args.get("detail") or "")
        ticket_id = f"TK{int(time.time()) % 1_000_000:06d}"

        return ToolResult(
            observation=(
                f"工单已创建：编号 {ticket_id}，标题「{title}」"
                f"{'，备注：' + detail if detail else ''}。人工客服将在 30 分钟内联系用户。"
            ),
            card=CardPayload(
                type="ticket",
                title=f"工单 {ticket_id}",
                summary="已提交，人工客服将跟进处理",
                fields=[
                    CardField(label="标题", value=title),
                    CardField(label="状态", value="待人工处理"),
                    CardField(label="响应时效", value="30 分钟内联系"),
                ],
            ),
        )
