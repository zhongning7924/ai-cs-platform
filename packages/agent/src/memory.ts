import type { AgentMemory, ChatTurn, PendingConfirm } from './types.js';

const MAX_TURNS_PER_SESSION = 200;
const CONFIRM_TTL_MS = 10 * 60 * 1000;

/** MVP 记忆：进程内 Map。接口不变即可换 Redis / PG（扩展缝 ③） */
export class InMemoryMemory implements AgentMemory {
  private turns = new Map<string, ChatTurn[]>();
  private confirms = new Map<string, PendingConfirm>();

  window(sessionId: string, limit: number): ChatTurn[] {
    const list = this.turns.get(sessionId) ?? [];
    return list.slice(-limit);
  }

  append(sessionId: string, turn: Omit<ChatTurn, 'ts'>): void {
    const list = this.turns.get(sessionId) ?? [];
    list.push({ ...turn, ts: Date.now() });
    if (list.length > MAX_TURNS_PER_SESSION) {
      list.splice(0, list.length - MAX_TURNS_PER_SESSION);
    }
    this.turns.set(sessionId, list);
  }

  pendingConfirm(sessionId: string): PendingConfirm | null {
    const p = this.confirms.get(sessionId);
    if (!p) return null;
    if (Date.now() - p.createdAt > CONFIRM_TTL_MS) {
      this.confirms.delete(sessionId);
      return null;
    }
    return p;
  }

  setPendingConfirm(sessionId: string, pending: PendingConfirm | null): void {
    if (pending) this.confirms.set(sessionId, pending);
    else this.confirms.delete(sessionId);
  }
}
