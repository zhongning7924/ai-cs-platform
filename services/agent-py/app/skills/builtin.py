"""内置技能：客服场景的四条主链路。

技能文本要写成「可执行步骤」而不是「角色描述」——7B 模型对步骤的遵循度
明显高于对形容词的遵循度。工具名必须与 ToolRegistry 里注册的一致，
写错不会报错，只会静默失效，所以这里保持与 builtin.py / MCP 工具同名。
"""

from __future__ import annotations

from .types import Skill

REFUND = Skill(
    name="refund",
    title="退换货处理",
    description="退货、退款、换货、质量问题、破损补寄",
    triggers=(
        "退货",
        "退款",
        "换货",
        "七天无理由",
        "无理由退",
        "异味",
        "破损",
        "质量问题",
        "坏了",
        "少发",
        "漏发",
        "补寄",
        "退差价",
    ),
    tools=("kb_search", "query_order", "create_ticket"),
    priority=2,
    instructions="""按以下顺序处理退换货诉求：
1. 先调 kb_search 查退换货政策（关键词：七天无理由 / 质量问题 / 退换货流程），依据政策回答，不要凭印象；
2. 用户给了订单号（CS 开头）就调 query_order 核实商品与状态；
3. 先判断诉求类型：异味、破损、坏损、漏发属于「质量问题」，按质量问题售后处理，**不受七天无理由的"商品完好"限制**，不要用无理由条款去否定用户；单纯不喜欢、不合适、买错了才走七天无理由；
4. 用户明确要求退货、退款、补寄，或确认要建工单 → 调 create_ticket 建售后工单（高风险，会先向用户确认）；
5. 回答必须给出明确条件与时效，不要说"可能""大概"；不确定的条款要如实说需要人工核实。""",
)

LOGISTICS = Skill(
    name="logistics",
    title="订单物流",
    description="订单状态、快递轨迹、发货时效、签收异常",
    triggers=(
        "物流",
        "快递",
        "发货",
        "到哪",
        "签收",
        "运单",
        "单号",
        "什么时候到",
        "还没收到",
        "延迟",
        "派送",
        "轨迹",
        "查订单",
        "订单状态",
        "我的订单",
    ),
    tools=("query_order", "logistics_track", "kb_search"),
    instructions="""按以下规则处理物流查询：
1. 用户给的是订单号（CS 开头）→ 调 query_order 查订单状态与承运信息；
2. 用户给的是快递运单号（SF / JD 开头），或明确要"轨迹/到哪个节点"→ 调 logistics_track；
3. 用户没给任何单号 → 先礼貌询问订单号或运单号，禁止猜测或编造；
4. 回答里带上最新节点 + 预计到达时间；查不到就如实说明并建议转人工。""",
)

COMPLAINT = Skill(
    name="complaint",
    title="投诉升级",
    description="投诉、强烈不满、要求维权或曝光",
    triggers=(
        "投诉",
        "举报",
        "12315",
        "曝光",
        "态度差",
        "太差",
        "气死",
        "不满意",
        "差评",
        "维权",
        "消协",
    ),
    tools=("kb_search", "create_ticket"),
    priority=3,
    instructions="""这是投诉升级场景，先处理情绪再处理问题：
1. 第一句先致歉并复述用户的具体问题，不要辩解、不要甩锅；
2. 调 kb_search 查相关售后承诺，作为处理依据；
3. 必须调 create_ticket 建投诉工单（高风险，会先向用户确认），标题写清诉求与商品；
4. 告知人工客服 30 分钟内联系；不要承诺具体赔偿金额，也不要说"一定能退"。""",
)

POLICY = Skill(
    name="policy",
    title="政策咨询",
    description="发票、优惠券、保修、流程与规则类咨询",
    triggers=(
        "发票",
        "开票",
        "优惠券",
        "保修",
        "质保",
        "资质",
        "流程",
        "规定",
        "政策",
        "条款",
        "售后承诺",
    ),
    tools=("kb_search", "coupon_status"),
    priority=1,
    instructions="""这是政策/规则咨询场景：
1. 问政策、流程、条款、发票、保修 → 必须调 kb_search 检索原文，回答要能对应到具体条款；
2. 只要用户问「我有哪些优惠券 / 我的券 / 券码 / 满减额度」→ **必须先调 coupon_status**，禁止凭印象编造券码、门槛或有效期；没有观察到结果就如实说"暂时查不到"；
3. 检索不到就如实说"暂无相关资料"，建议转人工，禁止编造政策；
4. 不要承诺知识库里没有的时效、金额或例外。""",
)


def builtin_skills() -> list[Skill]:
    return [REFUND, LOGISTICS, COMPLAINT, POLICY]
