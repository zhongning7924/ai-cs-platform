"""子 Agent（坐席）：路由分诊的配置面。

与 Skill 的分工，一句话说清：

    Skill    = 话题增强。命中只补一段领域指令，工具权限不动。
    SubAgent = 身份隔离。决定「谁在说话」＋「能用哪些工具」。

为什么要两套？因为 7B 模型在一个系统提示里塞两套业务口径时会串味：
拿促销话术回答退换货，或拿售后赔付政策回答「能不能便宜点」。
Skill 解决不了这个问题——它只加约束，不删工具。真正让口径不串的，
是工具白名单（售前不该有 create_ticket）加职责边界（越界要说转接）。

两者叠加使用：SubAgent 划边界，Skill 补细节。一个 SubAgent 生效，
同时最多一个 Skill 生效。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SubAgent:
    name: str
    title: str
    description: str
    # 规则路由信号：命中的词越多分越高。中文不做分词，直接子串匹配——
    # 客服提问短且口语化，子串比分词稳，也不会把「退款」切成「退」「款」。
    triggers: tuple[str, ...] = ()
    # 强信号正则（订单号 / 运单号），命中直接加分，不看触发词
    patterns: tuple[str, ...] = ()
    # 工具白名单。空元组 = 不限制（只给兜底坐席用）
    tools: tuple[str, ...] = ()
    instructions: str = ""
    # 同分时的裁决顺序，大者优先
    priority: int = 0

    def tool_set(self) -> frozenset[str] | None:
        """返回白名单集合；None 表示不限制。"""
        return frozenset(self.tools) if self.tools else None


@dataclass
class ActiveAgent:
    """一次路由的结果，随 PlannerContext 流进规划器，也写进 RunMeta 供线上归因。"""

    agent: SubAgent
    score: float = 0.0
    matched: list[str] = field(default_factory=list)
    # rule / carry / llm / fallback / off —— 线上看到 route 就能判断分诊质量
    source: str = "rule"

    def prompt_block(self) -> str:
        names = "、".join(self.agent.tools) if self.agent.tools else "全部已注册工具"
        return (
            f"\n\n【当前坐席】{self.agent.title}（{self.agent.name}）\n"
            f"{self.agent.instructions.strip()}\n"
            f"本坐席可调用工具：{names}。白名单之外的工具对你不可见，"
            f"遇到不属于本坐席职责的诉求，说明由对应团队跟进，不要硬答。"
        )

    def to_wire(self) -> dict:
        return {
            "name": self.agent.name,
            "title": self.agent.title,
            "score": round(self.score, 2),
            "source": self.source,
            "matched": self.matched,
            "tools": list(self.agent.tools),
        }


PRESALE = SubAgent(
    name="presale",
    title="售前坐席",
    description="产品参数、价格活动、库存与选型",
    triggers=(
        "多少钱",
        "价格",
        "报价",
        "优惠",
        "活动",
        "折扣",
        "便宜",
        "降价",
        "参数",
        "尺寸",
        "规格",
        "材质",
        "颜色",
        "型号",
        "有货",
        "现货",
        "库存",
        "推荐",
        "哪个好",
        "对比",
        "区别",
        "适合",
        "优惠券",
        "满减",
        "包邮",
        "能便宜",
    ),
    tools=("kb_search", "coupon_status"),
    priority=1,
    instructions="""职责边界：只回答产品参数、价格、活动、库存与选型。
1. 回答前**必须调 kb_search 检索产品手册**（query 用用户原问题）：价格、规格、库存、颜色、配送，
   一个都不能凭印象答；
2. 问价格、优惠、满减、包邮 → 在 kb_search 之后再调 coupon_status 查可用券；
3. 检索为空或查询失败 → 如实说明暂时查不到并建议转人工，此时不得给出任何价格数字；
4. 不承诺退换、赔付、时效——这些不属于售前；用户提到退货/退款/破损，说明由售后跟进；
5. 参数不确定就如实说需要确认，不要用"大概""应该是"。""",
)

AFTERSALE = SubAgent(
    name="aftersale",
    title="售后坐席",
    description="退换货、订单物流、投诉工单、发票赔付",
    triggers=(
        "退货",
        "退款",
        "换货",
        "退了",
        "要退",
        "维修",
        "返修",
        "保修",
        "质保",
        "破损",
        "异味",
        "坏了",
        "少发",
        "漏发",
        "补寄",
        "投诉",
        "工单",
        "赔付",
        "赔偿",
        "发票",
        "开票",
        "售后",
        "质量问题",
        "不满意",
        "差评",
        "举报",
        "维权",
        "物流",
        "快递",
        "运单",
        "到哪",
        "签收",
        "轨迹",
        "发货",
        "订单",
        "派送",
        "还没收到",
    ),
    patterns=(r"CS\d{3,}", r"(?:SF|JD|YT|ZTO|STO)\d{8,}"),
    tools=("kb_search", "query_order", "create_ticket", "logistics_track"),
    priority=2,
    instructions="""职责边界：处理退换货、订单物流、投诉与工单。
1. 给了订单号（CS 开头）→ 调 query_order；给了运单号（SF/JD 开头）或问轨迹 → 调 logistics_track；
2. 退换货先调 kb_search 查政策原文，再判断诉求：异味/破损/坏损/漏发属于「质量问题」，
   不受七天无理由的"商品完好"限制，不要用无理由条款否定用户；
3. 用户明确要求退货、退款、补寄、投诉，或确认要建工单 → 调 create_ticket（高风险，会先确认）；
4. 不报促销价、不谈选型——那是售前；不承诺具体赔偿金额；
5. 回答必须给明确条件与时效，不要说"可能""大概"。""",
)

TECH = SubAgent(
    name="tech",
    title="技术支持坐席",
    description="安装配置、报错排查、使用指导",
    triggers=(
        "报错",
        "错误",
        "故障",
        "装不上",
        "安装",
        "连不上",
        "连不上",
        "不会用",
        "怎么设置",
        "设置",
        "闪退",
        "卡顿",
        "打不开",
        "激活",
        "配网",
        "说明书",
        "驱动",
        "登录不上",
        "无法",
        "没反应",
        "怎么用",
    ),
    tools=("kb_search", "create_ticket"),
    priority=1,
    instructions="""职责边界：安装、配置、报错排查、使用指导。
1. 先确认两件事：产品型号 + 具体现象（报什么错 / 哪一步卡住）；缺信息就先问，不要猜；
2. 调 kb_search 查该型号的说明书与故障处理条目，按检索到的步骤给分步排查；
3. 三步以内还解决不了 → 调 create_ticket 建技术支持工单（高风险，会先确认）；
4. 不判断退换货责任，不承诺赔付；需要退换时说明转售后处理。""",
)

GENERAL = SubAgent(
    name="general",
    title="通用坐席",
    description="寒暄、无法归类的诉求（兜底）",
    triggers=(),
    tools=(),  # 不限制：兜底时宁可给全量工具，也不要把用户卡死
    priority=0,
    instructions="""职责边界：兜底坐席，处理寒暄与暂时无法归类的诉求。
1. 寒暄就简短回应，不要长篇自我介绍；
2. 从用户话里识别真实意图，能判断就办；判断不了就用一句话确认需求，不要连续追问；
3. 涉及订单、物流、优惠券、金额等具体数据，必须先调工具取证，禁止凭印象回答。""",
)


def builtin_agents() -> list[SubAgent]:
    return [PRESALE, AFTERSALE, TECH, GENERAL]
