import type { CardPayload } from '@cs/protocol';

const CARD_LABELS: Record<CardPayload['type'], string> = {
  faq: '知识卡片',
  product: '商品卡片',
  order: '订单卡片',
  logistics: '物流卡片',
  survey: '问卷卡片',
  kb_ref: '知识库引用',
  confirm: '操作确认',
  ticket: '工单卡片',
};

/** 消息卡片渲染：按卡片类型分发，新类型插件化注册（手册 2.4 难点 2） */
export function CardView({ card }: { card: CardPayload }) {
  return (
    <div className="cs-card">
      <div className="cs-card__head">
        <span className="cs-card__tag">{CARD_LABELS[card.type]}</span>
        {card.title ? <span className="cs-card__title">{card.title}</span> : null}
      </div>
      {card.summary ? <div className="cs-card__summary">{card.summary}</div> : null}
      {card.fields?.length ? (
        <dl className="cs-card__fields">
          {card.fields.map((f) => (
            <div className="cs-card__field" key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {card.actions?.length ? (
        <div className="cs-card__actions">
          {card.actions.map((a) => (
            <span className="cs-card__action" key={a.label}>
              {a.label}
            </span>
          ))}
        </div>
      ) : null}
      {card.source ? <div className="cs-card__source">来源：{card.source}</div> : null}
    </div>
  );
}
