import type { CardPayload } from '@cs/protocol';

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
  category: '售前' | '售中' | '售后';
  card?: CardPayload;
}

/**
 * MVP 种子知识库：电商通用 FAQ（P1 冷启动用，P2 替换为知识库引擎 + 行业模板）
 * 注意：卡片中的数据为演示用模拟数据，P2 对接真实业务 API 后移除。
 */
export const FAQ_ITEMS: FaqItem[] = [
  {
    id: 'faq-shipping-time',
    question: '什么时候发货',
    answer: '下单后 48 小时内发货（节假日顺延），预售商品以商品页标注的发货时间为准。',
    keywords: ['发货', '什么时候', '多久', '发出'],
    category: '售中',
  },
  {
    id: 'faq-shipping-fee',
    question: '运费怎么算',
    answer: '单笔订单满 99 元包邮，未满收取 8 元运费；新疆、西藏等偏远地区运费另计，以下单页显示为准。',
    keywords: ['运费', '邮费', '包邮'],
    category: '售前',
  },
  {
    id: 'faq-return-policy',
    question: '退货政策',
    answer: '支持 7 天无理由退货，商品需保持完好、配件齐全且不影响二次销售；定制类商品不支持无理由退货。',
    keywords: ['退货', '退掉', '无理由', '退款'],
    category: '售后',
  },
  {
    id: 'faq-exchange',
    question: '换货怎么操作',
    answer: '签收后 15 天内可申请换货，尺码 / 颜色问题可免费更换一次，请在"我的订单"中提交换货申请。',
    keywords: ['换货', '更换', '换一件'],
    category: '售后',
  },
  {
    id: 'faq-logistics',
    question: '查一下我的物流',
    answer: '为您查到以下物流信息，包裹正在运输途中，请留意查收。',
    keywords: ['物流', '快递', '到哪', '到哪里', '包裹', '发货了吗'],
    category: '售中',
    card: {
      type: 'logistics',
      title: '物流跟踪',
      fields: [
        { label: '运单号', value: 'SF1234567890' },
        { label: '当前节点', value: '深圳分拨中心已发出' },
        { label: '预计送达', value: '10 月 26 日' },
      ],
      source: '模拟数据 · P2 对接快递 API',
    },
  },
  {
    id: 'faq-change-address',
    question: '修改收货地址',
    answer: '订单未发货前可在"我的订单 - 修改地址"中自行修改；已发货的订单请联系快递公司或转人工协助。',
    keywords: ['地址', '改地址', '收货'],
    category: '售中',
  },
  {
    id: 'faq-coupon',
    question: '优惠券怎么用',
    answer: '优惠券需在有效期内使用，单笔订单限用一张，不可与部分秒杀活动叠加；结算页会自动匹配最优券。',
    keywords: ['优惠券', '券', '满减', '优惠'],
    category: '售前',
  },
  {
    id: 'faq-invoice',
    question: '开发票',
    answer: '支持电子普通发票与增值税专用发票。下单时填写抬头，确认收货后 24 小时内开具，可在"我的 - 发票中心"下载。',
    keywords: ['发票', '报销', '抬头'],
    category: '售后',
  },
  {
    id: 'faq-warranty',
    question: '保修政策',
    answer: '全场商品享一年质保，非人为损坏免费维修；人为损坏可付费维修，运费由责任方承担。',
    keywords: ['保修', '质保', '坏了', '维修', '售后'],
    category: '售后',
  },
  {
    id: 'faq-payment',
    question: '支持哪些支付方式',
    answer: '支持微信支付、支付宝、银行卡与花呗分期；分期免息活动以结算页展示为准。',
    keywords: ['支付', '付款', '怎么付', '花呗', '分期'],
    category: '售前',
  },
  {
    id: 'faq-points',
    question: '会员积分规则',
    answer: '实付金额每 1 元累计 1 积分，100 积分抵 1 元，积分可在结算页直接勾选使用。',
    keywords: ['积分', '会员'],
    category: '售前',
  },
  {
    id: 'faq-restock',
    question: '缺货什么时候补货',
    answer: '热销商品每周三补货，可点击商品页"到货通知"，到货后第一时间短信提醒您。',
    keywords: ['缺货', '补货', '没货', '到货'],
    category: '售前',
  },
  {
    id: 'faq-service-hours',
    question: '客服工作时间',
    answer: '人工客服在线时间 9:00-21:00，其他时段可留言，次日 10:00 前回复。',
    keywords: ['工作时间', '上班', '在线时间', '几点'],
    category: '售后',
  },
  {
    id: 'faq-product-recommend',
    question: '推荐一款适合小户型的沙发',
    answer: '为您推荐这款云朵三人位沙发，科技布材质易打理，适合 20 平米以内的客厅。',
    keywords: ['推荐', '沙发', '小户型', '客厅'],
    category: '售前',
    card: {
      type: 'product',
      title: '云朵三人位沙发',
      summary: '小户型友好 · 现货速发',
      fields: [
        { label: '价格', value: '¥2,999' },
        { label: '尺寸', value: '198 × 88 × 85 cm' },
        { label: '材质', value: '科技布 + 松木框架' },
        { label: '库存', value: '现货 · 深圳仓' },
      ],
      actions: [
        { label: '问这款', value: '这款沙发什么材质' },
        { label: '查物流', value: '查一下我的物流' },
      ],
      source: '模拟数据 · P2 对接商品中心',
    },
  },
  {
    id: 'faq-price-protection',
    question: '价保怎么申请',
    answer: '支持 7 天价保，活动降价后可申请退还差价，路径：我的订单 - 申请价保。',
    keywords: ['价保', '降价', '差价'],
    category: '售后',
  },
];

/** 兜底话术：知识库未命中时使用（P1 模拟 LLM 长尾应答，P2 替换为真实 LLM） */
export const FALLBACK_ANSWER =
  '这个问题我还需要确认一下，已为您记录并转接人工客服跟进，请稍候。您也可以补充更具体的订单号或商品名称，方便我们快速处理。';

/** 转人工话术 */
export const TRANSFER_TO_HUMAN_ANSWER =
  '正在为您转接人工客服，当前排队 1 位，预计等待 30 秒。转接前请简单补充一下问题，方便坐席提前准备。';
