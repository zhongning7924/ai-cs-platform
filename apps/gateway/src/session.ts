import { createId, type ChannelType, type MessageType, type UnifiedMessage } from '@cs/protocol';

export interface Session {
  id: string;
  channel: ChannelType;
  history: UnifiedMessage[];
  createdAt: number;
  lastActiveAt: number;
}

const MAX_HISTORY = 100;
const SESSION_TTL_MS = 30 * 60 * 1000;

/** P1 内存会话存储；P2 替换为 Redis（多实例部署必需） */
const sessions = new Map<string, Session>();

export function getOrCreateSession(sessionId?: string, channel: ChannelType = 'web'): Session {
  const now = Date.now();
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastActiveAt = now;
      return existing;
    }
  }
  const session: Session = {
    id: sessionId ?? createId('sess'),
    channel,
    history: [],
    createdAt: now,
    lastActiveAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function appendMessage(
  session: Session,
  input: Omit<UnifiedMessage, 'id' | 'ts' | 'type'> & { type?: MessageType },
): UnifiedMessage {
  const message: UnifiedMessage = {
    ...input,
    type: input.type ?? 'text',
    id: createId('msg'),
    ts: Date.now(),
  };
  session.history.push(message);
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
  }
  session.lastActiveAt = Date.now();
  return message;
}

export function sessionStats(): { sessions: number; messages: number } {
  let messages = 0;
  for (const s of sessions.values()) messages += s.history.length;
  return { sessions: sessions.size, messages };
}

/** 过期会话清理（每 10 分钟） */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();
