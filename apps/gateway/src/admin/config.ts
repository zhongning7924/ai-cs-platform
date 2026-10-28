/**
 * 管理配置（后台可维护的运行时参数）——提示词人设 + 模型生成参数。
 *
 * 设计取舍：
 * - persona 与 model/temperature/maxTokens 走「运行时透传」，改完立即生效，无需重启；
 * - base_url / api_key 属部署级安全边界，不在后台暴露（改错了会打到别人的模型端点）。
 *
 * 落盘 var/data/admin-config.json，与反馈/工单共用 DATA_DIR。单文件 JSON，
 * 足够单机部署；多实例前再换数据库（见 deploy/README.md 扩容须知）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ModelConfig {
  /** 模型名（OpenAI 兼容的 model id，如 Qwen/Qwen2.5-7B-Instruct） */
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface AdminConfig {
  /** 客服人设：品牌、语气、业务范围。空 = 用代码里的默认人设。
   *  护栏硬规则（防幻觉/防泄漏）由智能层永远追加，不受这里影响。 */
  persona: string;
  /** 模型生成参数覆盖。null = 用部署默认（.env）。 */
  model: ModelConfig | null;
  updatedAt: number;
}

export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  persona: '',
  model: null,
  updatedAt: 0,
};

const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const MAX_TOKENS_MIN = 64;
const MAX_TOKENS_MAX = 4096;
const MODEL_MAX_LEN = 200;
const PERSONA_MAX_LEN = 2000;

export class AdminConfigStore {
  private readonly file: string;

  constructor(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'admin-config.json');
  }

  read(): AdminConfig {
    try {
      const raw = readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdminConfig>;
      return {
        persona: typeof parsed.persona === 'string' ? parsed.persona : '',
        model: parsed.model ?? null,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
    } catch {
      return { ...DEFAULT_ADMIN_CONFIG };
    }
  }

  write(next: AdminConfig): void {
    writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  }

  /** 会话对话时要透传给 Python 智能层的运行时覆盖。 */
  runtimeOverrides(): { persona?: string; model?: string; temperature?: number; maxTokens?: number } {
    const cfg = this.read();
    const out: { persona?: string; model?: string; temperature?: number; maxTokens?: number } = {};
    if (cfg.persona.trim()) out.persona = cfg.persona.trim();
    if (cfg.model) {
      out.model = cfg.model.model;
      out.temperature = cfg.model.temperature;
      out.maxTokens = cfg.model.maxTokens;
    }
    return out;
  }
}

/** 校验并归一化一份 PUT 进来的配置。返回 { ok: true, value } 或 { ok: false, error }。 */
export function validateConfig(input: unknown): { ok: true; value: AdminConfig } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const body = input as Record<string, unknown>;

  let persona = '';
  if (body.persona !== undefined) {
    if (typeof body.persona !== 'string') return { ok: false, error: 'persona 必须是字符串' };
    persona = body.persona.trim();
    if (persona.length > PERSONA_MAX_LEN) {
      return { ok: false, error: `persona 超长（上限 ${PERSONA_MAX_LEN} 字符）` };
    }
  }

  let model: ModelConfig | null = null;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'object' || body.model === null) {
      return { ok: false, error: 'model 必须是对象或 null' };
    }
    const m = body.model as Record<string, unknown>;
    if (typeof m.model !== 'string' || !m.model.trim()) {
      return { ok: false, error: 'model.model 不能为空' };
    }
    if (m.model.length > MODEL_MAX_LEN) {
      return { ok: false, error: `模型名超长（上限 ${MODEL_MAX_LEN} 字符）` };
    }
    const temperature = typeof m.temperature === 'number' ? m.temperature : NaN;
    if (!Number.isFinite(temperature) || temperature < TEMPERATURE_MIN || temperature > TEMPERATURE_MAX) {
      return { ok: false, error: `temperature 需在 ${TEMPERATURE_MIN}~${TEMPERATURE_MAX} 之间` };
    }
    const maxTokens = typeof m.maxTokens === 'number' ? m.maxTokens : NaN;
    if (!Number.isInteger(maxTokens) || maxTokens < MAX_TOKENS_MIN || maxTokens > MAX_TOKENS_MAX) {
      return { ok: false, error: `maxTokens 需为 ${MAX_TOKENS_MIN}~${MAX_TOKENS_MAX} 的整数` };
    }
    model = { model: m.model.trim(), temperature, maxTokens };
  }

  return {
    ok: true,
    value: { persona, model, updatedAt: Date.now() },
  };
}
