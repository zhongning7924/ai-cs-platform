import { useCallback, useEffect, useRef, useState } from 'react';
import { createId, type UnifiedMessage } from '@cs/protocol';
import { streamChat } from './api';
import { CardView } from './cards';
import { ChatIcon, CloseIcon, HeadsetIcon, SendIcon } from './icons';

const QUICK_REPLIES = [
  '什么时候发货？',
  '帮我查订单 CS1001',
  '周五下午能不能发布上线',
  '帮我建个售后工单，沙发有异味',
  '转人工',
];

const WELCOME =
  '您好，我是店铺智能客服小智。我可以查订单、检索知识库、帮你建工单（会先跟你确认），发货退换货也可以直接问。';

/** 工具名 → 人类可读动作（未知工具直接显示名字） */
const TOOL_LABELS: Record<string, string> = {
  kb_search: '检索知识库',
  query_order: '查询订单',
  create_ticket: '创建工单',
};

export function Widget({ title = '智能客服小智' }: { title?: string }) {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([
      {
        id: createId('msg'),
        sessionId: 'local',
        role: 'bot',
        type: 'text',
        content: WELCOME,
        channel: 'web',
        ts: Date.now(),
      },
    ]);
  }, []);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open]);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || streaming) return;

      const pendingSession = sessionId ?? 'pending';
      const userMsg: UnifiedMessage = {
        id: createId('msg'),
        sessionId: pendingSession,
        role: 'user',
        type: 'text',
        content,
        channel: 'web',
        ts: Date.now(),
      };
      const botId = createId('msg');
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: botId,
          sessionId: pendingSession,
          role: 'bot',
          type: 'text',
          content: '',
          channel: 'web',
          ts: Date.now(),
        },
      ]);
      setInput('');
      setStreaming(true);
      setToolStatus(null);

      let acc = '';
      try {
        await streamChat(sessionId, content, {
          onMeta: (data) => setSessionId(data.sessionId),
          onTool: (data) => {
            if (data.status === 'start') {
              const label = TOOL_LABELS[data.name] ?? data.name;
              setToolStatus(`正在${label}…`);
            } else {
              setToolStatus(null);
            }
          },
          onDelta: (data) => {
            acc += data.text;
            setMessages((prev) =>
              prev.map((m) => (m.id === botId ? { ...m, content: acc } : m)),
            );
          },
          onCard: (data) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === botId ? { ...m, card: data.card } : m)),
            );
          },
        });
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botId
              ? { ...m, content: acc || `网络异常：${(err as Error).message}，请稍后重试。` }
              : m,
          ),
        );
      } finally {
        setStreaming(false);
        setToolStatus(null);
      }
    },
    [sessionId, streaming],
  );

  return (
    <div className="cs-root">
      <button
        type="button"
        className="cs-launcher"
        aria-label={open ? '收起客服窗口' : '打开在线客服'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {open ? (
        <section className="cs-panel" role="dialog" aria-label="智能客服对话窗口">
          <header className="cs-panel__header">
            <div className="cs-agent">
              <span className="cs-agent__avatar">
                <HeadsetIcon />
              </span>
              <div className="cs-agent__meta">
                <span className="cs-agent__name">{title}</span>
                <span className="cs-agent__status">
                  {streaming ? '正在输入…' : '在线 · 平均 3 秒响应'}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="cs-panel__transfer"
              disabled={streaming}
              onClick={() => send('转人工')}
            >
              转人工
            </button>
          </header>

          <div className="cs-panel__list" ref={listRef}>
            {messages.map((m) => (
              <div key={m.id} className={`cs-msg cs-msg--${m.role}`}>
                {m.role === 'bot' ? <span className="cs-msg__avatar"><HeadsetIcon size={16} /></span> : null}
                <div className="cs-msg__body">
                  {m.content ? <div className="cs-msg__text">{m.content}</div> : null}
                  {streaming && m.role === 'bot' && m.content === '' ? (
                    toolStatus ? (
                      <div
                        className="cs-msg__text"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          color: '#2563eb',
                          background: 'rgba(37,99,235,0.08)',
                          border: '1px solid rgba(37,99,235,0.25)',
                          borderRadius: 999,
                          padding: '3px 10px',
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: '#2563eb',
                            animation: 'cs-blink 1s infinite',
                          }}
                        />
                        {toolStatus}
                      </div>
                    ) : (
                      <div className="cs-msg__text cs-typing">
                        <span className="cs-dot" />
                        <span className="cs-dot" />
                        <span className="cs-dot" />
                      </div>
                    )
                  ) : null}
                  {streaming && m.role === 'bot' && m.content !== '' ? (
                    <span className="cs-cursor" aria-hidden="true" />
                  ) : null}
                  {m.card ? <CardView card={m.card} /> : null}
                </div>
              </div>
            ))}
          </div>

          <div className="cs-quick">
            {QUICK_REPLIES.map((q) => (
              <button
                key={q}
                type="button"
                className="cs-quick__item"
                disabled={streaming}
                onClick={() => send(q)}
              >
                {q}
              </button>
            ))}
          </div>

          <footer className="cs-panel__input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="请输入问题，Enter 发送"
              disabled={streaming}
              aria-label="对话输入框"
            />
            <button
              type="button"
              className="cs-panel__send"
              disabled={streaming || input.trim() === ''}
              onClick={() => void send(input)}
              aria-label="发送"
            >
              <SendIcon />
            </button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
