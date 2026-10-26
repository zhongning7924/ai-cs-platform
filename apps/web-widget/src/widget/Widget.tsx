import { useCallback, useEffect, useRef, useState } from 'react';
import { createId, type UnifiedMessage } from '@cs/protocol';
import { pollHandoff, streamChat, type HandoffState } from './api';
import { CardView } from './cards';
import { FeedbackBar } from './feedback';
import { ChatIcon, CloseIcon, HeadsetIcon, SendIcon } from './icons';

/**
 * 挂件本地的消息视图：在协议消息上加两个仅前端有意义的字段。
 * 不往 UnifiedMessage 里塞，是因为「是否还在生成」属于渲染状态，
 * 不属于跨端契约——协议一旦混入 UI 状态，服务端就得跟着维护它。
 */
type ChatItem = UnifiedMessage & {
  pending?: boolean;
};

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
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  /** 当前是否挂在人工上（排队/接待中）。null = 纯 AI 模式。 */
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  /** 已消费到的人工消息序号，用于增量拉取 */
  const handoffSeqRef = useRef(0);
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
          pending: true,
        },
      ]);
      setInput('');
      setStreaming(true);
      setToolStatus(null);

      let acc = '';
      try {
        await streamChat(sessionId, content, {
          onMeta: (data) => {
            setSessionId(data.sessionId);
            // traceId 是反馈的锚点：这一轮只有拿到它才能被评价，
            // 所以从 meta 帧起就绑到消息上，而不是等 done。
            setMessages((prev) =>
              prev.map((m) => (m.id === botId ? { ...m, traceId: data.traceId } : m)),
            );
          },
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
          onHandoff: (data) => {
            setHandoff(data);
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
        /**
         * 转人工那一轮服务端只回 handoff 帧、没有正文，会留下一个空气泡。
         * 这里顺手收掉——但**必须保留有卡片的**：建工单确认卡就常常没有正文。
         */
        setMessages((prev) =>
          prev
            .filter((m) => !(m.id === botId && !m.content && !m.card))
            .map((m) => (m.id === botId ? { ...m, pending: false } : m)),
        );
      }
    },
    [sessionId, streaming],
  );

  /**
   * 人工阶段轮询（ADR-0011）。
   *
   * 停止条件不是「等太久了」而是「工单关闭」——坐席可能十分钟才回一句，
   * 用户不该因为等待时间长就静默地收不到消息。
   */
  useEffect(() => {
    if (!sessionId || !handoff) return;

    let stopped = false;

    const tick = async () => {
      try {
        const res = await pollHandoff(sessionId, handoffSeqRef.current);
        if (stopped) return;

        if (res.messages.length) {
          handoffSeqRef.current = res.seq;
          setMessages((prev) => {
            const known = new Set(prev.map((m) => m.id));
            const added: ChatItem[] = [];
            for (const msg of res.messages) {
              // 用「工单号 + 序号」做 id，重复拉取天然幂等
              const id = `ho_${handoff.ticketId}_${msg.seq}`;
              if (known.has(id)) continue;
              added.push({
                id,
                sessionId,
                role: msg.role === 'agent' ? 'agent' : 'system',
                type: 'text',
                content: msg.role === 'agent' ? msg.text : `— ${msg.text} —`,
                channel: 'web',
                ts: msg.ts,
              });
            }
            return added.length ? [...prev, ...added] : prev;
          });
        }

        if (!res.handoff) {
          // 工单已关闭：提示一次就回 AI，不能留在"人工中"的假状态
          stopped = true;
          setHandoff(null);
          setMessages((prev) => [
            ...prev,
            {
              id: createId('msg'),
              sessionId,
              role: 'system',
              type: 'text',
              content: '人工客服已结束本次会话，有需要可以继续问我。',
              channel: 'web',
              ts: Date.now(),
            },
          ]);
          return;
        }

        // 值没变必须返回原对象：每 1.5s 一个新引用会让本 effect 反复重启
        setHandoff((prev) =>
          prev &&
          prev.status === res.handoff!.status &&
          prev.position === res.handoff!.position &&
          prev.agentName === res.handoff!.agentName
            ? prev
            : res.handoff,
        );
      } catch {
        // 网络抖一下很常见，不打扰用户，下一轮自愈
      }
    };

    void tick();
    const timer = setInterval(tick, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sessionId, handoff]);

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
                  {handoff
                    ? handoff.status === 'queued'
                      ? '正在转人工…'
                      : `人工接待中 · ${handoff.agentName ?? '客服'}`
                    : streaming
                      ? '正在输入…'
                      : '在线 · 平均 3 秒响应'}
                </span>
              </div>
            </div>
            {handoff ? null : (
              <button
                type="button"
                className="cs-panel__transfer"
                disabled={streaming}
                onClick={() => send('转人工')}
              >
                转人工
              </button>
            )}
          </header>

          {handoff ? (
            <div className={`cs-ho cs-ho--${handoff.status}`} role="status">
              <span className="cs-ho__dot" aria-hidden="true" />
              <span className="cs-ho__text">
                {handoff.status === 'queued'
                  ? `正在为你转接人工客服 · 当前排队第 ${handoff.position} 位`
                  : `客服 ${handoff.agentName ?? ''} 已接入，可以直接说`}
              </span>
            </div>
          ) : null}

          <div className="cs-panel__list" ref={listRef}>
            {messages.map((m) => (
              <div key={m.id} className={`cs-msg cs-msg--${m.role}`}>
                {m.role === 'bot' || m.role === 'agent' ? <span className="cs-msg__avatar"><HeadsetIcon size={16} /></span> : null}
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
                  {m.role === 'bot' && m.traceId && !m.pending ? (
                    <FeedbackBar traceId={m.traceId} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {handoff ? null : (
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
          )}

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
              placeholder={
                handoff ? '人工接待中，直接说话即可' : '请输入问题，Enter 发送'
              }
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
