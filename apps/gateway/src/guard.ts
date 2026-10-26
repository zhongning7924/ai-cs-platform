/**
 * 入口防护（ADR-0010）。
 *
 * 这里刻意**不做账号体系**：私有化是单商户单实例，一台机器一家客户，
 * 租户隔离由物理边界保证，加用户/角色/租户只会让交付变重。
 *
 * 但有三件跟「多租户」无关的事必须做：
 *
 *   1. adminGuard —— 管理面（导出 / 看板 / 对话记录）导的是客户隐私，
 *      不能一个匿名 GET 就能拉走。一个共享 token 足够，不需要账号。
 *   2. originGuard —— 挂件防盗链。商户官网是公网，端点暴露后同行可以
 *      直接当免费 API 爬空商品/价格知识库，或把挂件嵌到自己站上白用。
 *   3. rateLimit —— 不是为了防刷钱（key 是客户自己的），而是防单实例被
 *      一个脚本打满，导致全站客服同时挂掉。那是交付事故，不是账单问题。
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const LOOPBACK_PREFIXES = ['127.', '::1', '::ffff:127.'];

function isLoopback(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  return LOOPBACK_PREFIXES.some((p) => ip === p || ip.startsWith(p));
}

/** 定长比较，避免用 token 长度当侧信道。长度不同直接 false（长度本身不是秘密）。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 管理面鉴权。
 *
 * 未配置 ADMIN_TOKEN 时不直接放开——那等于默认不设防，交付到客户内网会被
 * 安全审计打回。改成「只允许本机」，本地开发照常能用，一上服务器就必须配。
 */
export function adminGuard(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      if (isLoopback(req)) {
        next();
        return;
      }
      res.status(403).json({
        error: 'admin_token_unset',
        message: '管理面未配置 ADMIN_TOKEN，仅允许本机访问。私有化部署请设置 ADMIN_TOKEN。',
      });
      return;
    }

    // 允许 header 或 query：query 是为了 curl / 巡检脚本方便，日志里记得别打印 URL
    const provided = String(req.header('x-admin-token') ?? req.query.token ?? '');
    if (provided && safeEqual(provided, token)) {
      next();
      return;
    }
    res.status(401).json({
      error: 'admin_unauthorized',
      message: '需要有效的 X-Admin-Token（或 ?token=）',
    });
  };
}

/** "https://a.com, https://b.com" -> ['https://a.com', ...] */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * 挂件来源校验（防盗链）。
 *
 * 空列表 = 不校验（本地开发）。一旦配置，就必须带 Origin 或 Referer——
 * 浏览器对 POST 一定会带 Origin，所以正常挂件不受影响；
 * 而 curl / 脚本直接打接口会被挡在门外。
 */
export function originGuard(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (allowed.length === 0) {
      next();
      return;
    }

    const declared =
      originOf(req.header('origin')) ?? originOf(req.header('referer'));

    if (!declared) {
      res.status(403).json({
        error: 'origin_required',
        message: '已启用来源白名单（WIDGET_ORIGINS），请求需带 Origin 或 Referer',
      });
      return;
    }
    if (allowed.includes('*') || allowed.includes(declared)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'origin_denied',
      origin: declared,
      message: `来源 ${declared} 不在 WIDGET_ORIGINS 白名单内`,
    });
  };
}

/**
 * 进程内滑动窗口限流（按 IP）。
 *
 * 单实例场景够用。多实例要换 Redis——但现在就是单实例，先不引依赖。
 * limit <= 0 视为关闭（压测/联调时要能关）。
 */
export function createRateLimiter(limitPerMinute: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (limitPerMinute <= 0) {
      next();
      return;
    }

    const t = now();

    // 每分钟清一次过期 key。私有化是长跑服务，不清就是慢性内存泄漏。
    if (t - lastSweep > 60_000) {
      lastSweep = t;
      for (const [key, times] of hits) {
        const alive = times.filter((x) => t - x < 60_000);
        if (alive.length === 0) hits.delete(key);
        else hits.set(key, alive);
      }
    }

    const key = req.ip ?? 'unknown';
    const windowStart = t - 60_000;
    const recent = (hits.get(key) ?? []).filter((x) => x > windowStart);

    if (recent.length >= limitPerMinute) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({
        error: 'rate_limited',
        message: `每分钟最多 ${limitPerMinute} 次请求，请稍后再试`,
      });
      return;
    }

    recent.push(t);
    hits.set(key, recent);
    next();
  };
}
