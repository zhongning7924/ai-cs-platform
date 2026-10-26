/**
 * 落盘前脱敏（ADR-0009）。
 *
 * 为什么脱敏放在「写入」而不是「导出」：
 *   反馈数据迟早要离开这台机器——做标注、跑评测、给外包看样本。
 *   一旦联系方式进了 jsonl，后面每一步都得记得再脱一次，而漏点是必然的。
 *   所以在唯一写入入口做一次，下游全是干净数据。
 *
 * 只脱「人」的信息，不脱「业务」信息：
 *   订单号 / 运单号是回放查证的主键，抹掉之后这条样本就没法验证对错了，
 *   属于必须保留的字段（它们本身也不指向自然人，脱敏优先级低）。
 *
 * 顺序有讲究：长格式先跑（身份证 18 位 → 银行卡 16~19 位 → 手机 11 位 → 邮箱）。
 * 长的先打码后，短的规则就匹配不到被打掉的数字，不会互相破坏。
 */

interface Rule {
  name: string;
  re: RegExp;
  /** 所有规则统一三参：match + 两个捕获组。统一签名省得在类型上玩花活。 */
  mask: (match: string, a: string, b: string) => string;
}

const RULES: Rule[] = [
  {
    // 身份证：保留前 6 位（地区）和后 4 位（校验位），中间全遮
    name: 'id_card',
    re: /(?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)/g,
    mask: (_m, a, b) => `${a}********${b}`,
  },
  {
    name: 'bank_card',
    re: /(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g,
    mask: (_m, a, b) => `${a} **** **** ${b}`,
  },
  {
    // 手机号：保留前 3 后 4，够人工核对、不够直接拨打
    name: 'phone',
    re: /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g,
    mask: (_m, a, b) => `${a}****${b}`,
  },
  {
    name: 'email',
    re: /([\w.+-]{1,64})@([\w-]+(?:\.[\w-]+)+)/g,
    mask: (_m, _user, domain) => `***@${domain}`,
  },
];

/** 脱敏一条文本。多次调用是幂等的（已打码的部分不会再被匹配）。 */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (m: string, a: string, b: string) => rule.mask(m, a, b));
  }
  return out;
}
