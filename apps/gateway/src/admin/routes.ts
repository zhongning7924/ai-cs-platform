/**
 * 管理后台 API（最小闭环）：提示词人设 + 模型生成参数 + 智能层健康聚合。
 *
 * 全部挂在 adminGuard 之后——这些是「运营配置」，不是匿名可读的公开信息。
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import { AdminConfigStore, validateConfig } from './config.js';

/** Python 智能层地址，用于聚合健康信息。 */
function pyUrl(): string {
  return (process.env.AGENT_PY_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
}

export function mountAdminRoutes(
  app: Express,
  store: AdminConfigStore,
  guard: RequestHandler,
): void {
  app.get('/api/admin/config', guard, (_req: Request, res: Response) => {
    const cfg = store.read();
    res.json({
      persona: cfg.persona,
      model: cfg.model,
      updatedAt: cfg.updatedAt,
      // 返回默认值口径，方便前端表单回显「空 = 用部署默认」
      defaults: {
        persona: '（未设置，使用内置默认人设）',
      },
    });
  });

  app.put('/api/admin/config', guard, (req: Request, res: Response) => {
    const result = validateConfig(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    store.write(result.value);
    res.json({ ok: true, updatedAt: result.value.updatedAt });
  });

  app.get('/api/admin/health', guard, async (_req: Request, res: Response) => {
    // 聚合智能层健康，后台一屏看清「模型是什么 / 知识库有没有 / 哪些坐席在岗」。
    // 智能层不可用时只降级，不报错——后台页仍然能开，只是看不到这些字段。
    try {
      const r = await fetch(`${pyUrl()}/health`);
      if (r.ok) {
        res.json({ backend: 'py', ...(await r.json()) });
        return;
      }
    } catch {
      /* 降级到下面 */
    }
    res.json({ backend: 'py', status: 'unreachable', error: 'Python 智能层未启动' });
  });
}
