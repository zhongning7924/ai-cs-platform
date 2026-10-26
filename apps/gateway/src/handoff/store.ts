/**
 * 工单存储（ADR-0011）：内存状态机 + append-only JSONL。
 *
 * 为什么又是事件溯源：和 ADR-0009 的反馈库同一个理由——
 *   ① 工单的每一次状态变化都是审计证据（谁在什么时候接了、谁关的、关了多久）
 *   ② 追加写不需要锁，单机不会写坏
 *   ③ 重启后能重放恢复，用户不会因为运维重启就"排队排丢了"
 *
 * 和反馈库的差别：这里的读路径要参与实时判断（这条会话现在是不是人工模式），
 * 所以必须重建内存 Map，不能每次读文件。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createId } from '@cs/protocol';
import { redact } from '../data/redact.js';
import type {
  ContextTurn,
  HandoffMessage,
  HandoffReason,
  HandoffTicket,
  Resolution,
  TicketStatus,
} from './types.js';

const FILE = 'handoff.jsonl';

/** 单工单消息上限。真实客服会话不会超过这个数，超了多半是脚本在刷。 */
const MAX_MESSAGES = 200;

/** 重放后保留的工单数上限，防止 JSONL 长跑把内存吃光。 */
const MAX_TICKETS = 500;

type EventRecord =
  | { kind: 'ticket'; ts: number; ticket: HandoffTicket }
  | { kind: 'message'; ts: number; ticketId: string; message: HandoffMessage }
  | {
      kind: 'status';
      ts: number;
      ticketId: string;
      status: TicketStatus;
      agentName?: string;
      resolution?: Resolution;
    };

export interface CreateInput {
  sessionId: string;
  channel: string;
  reason: HandoffReason;
  triggerText: string;
  /** AI 阶段的问答对，按时间正序 */
  context: ContextTurn[];
}

export class HandoffStore {
  private readonly tickets = new Map<string, HandoffTicket>();
  private readonly file: string;
  private readonly enabled: boolean;

  constructor(dir: string, options: { enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? true;
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, FILE);
    this.load();
  }

  create(input: CreateInput): HandoffTicket {
    const now = Date.now();
    const ticket: HandoffTicket = {
      id: createId('ho'),
      sessionId: input.sessionId,
      channel: input.channel,
      status: 'queued',
      reason: input.reason,
      triggerText: redact(input.triggerText),
      createdAt: now,
      // 只带最近 6 轮：坐席需要的是"他刚才问了什么"，不是完整聊天记录
      context: input.context.slice(-6).map((t) => ({
        question: redact(t.question),
        answer: redact(t.answer),
        ts: t.ts,
      })),
      messages: [],
      seq: 0,
    };
    this.tickets.set(ticket.id, ticket);
    this.persist({ kind: 'ticket', ts: now, ticket });
    return ticket;
  }

  get(id: string): HandoffTicket | null {
    return this.tickets.get(id) ?? null;
  }

  /** 这条会话当前是否挂在人工上（queued 或 active）。转人工模式的唯一判据。 */
  openBySession(sessionId: string): HandoffTicket | null {
    let found: HandoffTicket | null = null;
    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId !== sessionId || ticket.status === 'closed') continue;
      if (!found || ticket.createdAt > found.createdAt) found = ticket;
    }
    return found;
  }

  /** 排队位置（1 起）。不在队列里返回 0。 */
  position(id: string): number {
    const idx = this.queue().findIndex((t) => t.id === id);
    return idx < 0 ? 0 : idx + 1;
  }

  queue(): HandoffTicket[] {
    return [...this.tickets.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  active(): HandoffTicket[] {
    return [...this.tickets.values()]
      .filter((t) => t.status === 'active')
      .sort((a, b) => (a.claimedAt ?? a.createdAt) - (b.claimedAt ?? b.createdAt));
  }

  claim(id: string, agentName: string): HandoffTicket | null {
    const ticket = this.tickets.get(id);
    // 只允许 queued -> active。并发抢单时第二个人的 claim 会拿到 null，
    // 前端提示"已被他人接入"，不会出现两个坐席同时说话的灵异现象。
    if (!ticket || ticket.status !== 'queued') return null;

    ticket.status = 'active';
    ticket.agentName = agentName;
    ticket.claimedAt = Date.now();
    this.persist({
      kind: 'status',
      ts: ticket.claimedAt,
      ticketId: ticket.id,
      status: 'active',
      agentName,
    });
    this.appendSystem(ticket, `${agentName} 已接入`);
    return ticket;
  }

  addUserMessage(id: string, text: string): HandoffMessage | null {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.status === 'closed') return null;
    return this.append(ticket, 'user', text);
  }

  addAgentMessage(id: string, text: string, author?: string): HandoffMessage | null {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.status !== 'active') return null;
    return this.append(ticket, 'agent', text, author ?? ticket.agentName);
  }

  close(id: string, resolution: Resolution): HandoffTicket | null {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.status === 'closed') return null;

    ticket.status = 'closed';
    ticket.closedAt = Date.now();
    ticket.resolution = resolution;
    this.persist({
      kind: 'status',
      ts: ticket.closedAt,
      ticketId: ticket.id,
      status: 'closed',
      resolution,
    });
    this.appendSystem(ticket, '本次人工会话已结束');
    return ticket;
  }

  /**
   * 用户端增量拉取：只给坐席和系统消息。
   * 用户自己说的话前端本来就有，再回传一遍只会导致重复气泡。
   */
  agentMessagesSince(id: string, afterSeq: number): HandoffMessage[] {
    const ticket = this.tickets.get(id);
    if (!ticket) return [];
    return ticket.messages.filter((m) => m.seq > afterSeq && m.role !== 'user');
  }

  stats(): {
    queued: number;
    active: number;
    closed: number;
    avgWaitMs: number | null;
    avgHandleMs: number | null;
    handoffRate: number | null;
  } {
    const all = [...this.tickets.values()];
    const closed = all.filter((t) => t.status === 'closed');
    const claimed = all.filter((t) => t.claimedAt);

    const wait =
      claimed.length === 0
        ? null
        : Math.round(
            claimed.reduce((sum, t) => sum + (t.claimedAt! - t.createdAt), 0) / claimed.length,
          );
    const handle =
      closed.length === 0
        ? null
        : Math.round(
            closed.reduce(
              (sum, t) => sum + ((t.closedAt ?? t.createdAt) - (t.claimedAt ?? t.createdAt)),
              0,
            ) / closed.length,
          );

    return {
      queued: all.filter((t) => t.status === 'queued').length,
      active: all.filter((t) => t.status === 'active').length,
      closed: closed.length,
      avgWaitMs: wait,
      avgHandleMs: handle,
      // 转人工率要拿总对话数做分母，那个数在 traceStore 里，路由层再算
      handoffRate: null,
    };
  }

  private append(
    ticket: HandoffTicket,
    role: HandoffMessage['role'],
    text: string,
    author?: string,
  ): HandoffMessage {
    ticket.seq += 1;
    const message: HandoffMessage = {
      seq: ticket.seq,
      role,
      text: redact(text),
      ...(author ? { author } : {}),
      ts: Date.now(),
    };
    ticket.messages.push(message);
    if (ticket.messages.length > MAX_MESSAGES) {
      ticket.messages.splice(0, ticket.messages.length - MAX_MESSAGES);
    }
    this.persist({ kind: 'message', ts: message.ts, ticketId: ticket.id, message });
    return message;
  }

  private appendSystem(ticket: HandoffTicket, text: string): void {
    this.append(ticket, 'system', text);
  }

  private persist(record: EventRecord): void {
    if (!this.enabled) return;
    try {
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      // 落盘失败不能让坐席的回复发不出去——内存态已经更新，功能可用
      console.warn(`[handoff] 工单落盘失败: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;

    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: EventRecord;
      try {
        record = JSON.parse(line) as EventRecord;
      } catch {
        // 单行损坏（断电写一半）不该让整个工单系统起不来
        continue;
      }

      if (record.kind === 'ticket') {
        this.tickets.set(record.ticket.id, record.ticket);
      } else if (record.kind === 'message') {
        const ticket = this.tickets.get(record.ticketId);
        if (!ticket) continue;
        ticket.messages.push(record.message);
        ticket.seq = Math.max(ticket.seq, record.message.seq);
      } else if (record.kind === 'status') {
        const ticket = this.tickets.get(record.ticketId);
        if (!ticket) continue;
        ticket.status = record.status;
        if (record.agentName) ticket.agentName = record.agentName;
        if (record.resolution) ticket.resolution = record.resolution;
        if (record.status === 'active') ticket.claimedAt = record.ts;
        if (record.status === 'closed') ticket.closedAt = record.ts;
      }
    }

    // 只留最近的 N 单，且丢掉 24 小时前已关闭的
    if (this.tickets.size > MAX_TICKETS) {
      const sorted = [...this.tickets.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const t of sorted.slice(0, this.tickets.size - MAX_TICKETS)) {
        this.tickets.delete(t.id);
      }
    }
  }
}
