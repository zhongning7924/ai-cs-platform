/**
 * 极简 .env 加载器（零依赖，Node >= 21.7 原生 process.loadEnvFile）。
 *
 * 约定：密钥只写在仓库根的 .env（已被 .gitignore 忽略），模板见 .env.example。
 * 从 startDir 逐级向上查找，找到第一个 .env 为止；已存在的环境变量不被覆盖，
 * 因此 CI / export 优先级始终高于 .env 文件。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return candidate;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** kb 链路必需的环境变量清单与获取指引 */
export const KB_ENV_ITEMS: Array<{ key: string; label: string; url: string }> = [
  {
    key: 'QDRANT_URL',
    label: 'Qdrant 集群地址',
    url: 'https://cloud.qdrant.io （免费开集群，无需信用卡 → 复制 Endpoint）',
  },
  {
    key: 'QDRANT_API_KEY',
    label: 'Qdrant API Key',
    url: 'https://cloud.qdrant.io （集群页 → API Keys）',
  },
  {
    key: 'SILICONFLOW_API_KEY',
    label: '硅基流动 API Key',
    url: 'https://cloud.siliconflow.cn/account/ak （免费档 bge-m3 可用）',
  },
];

export function missingKbEnv(): string[] {
  return KB_ENV_ITEMS.filter((item) => !process.env[item.key]).map((item) => item.key);
}

export function printEnvGuide(missing: string[]): void {
  console.error('\n✗ 缺少环境变量：' + missing.join(', '));
  console.error('\n三步补齐：');
  console.error('  1. cp .env.example .env');
  KB_ENV_ITEMS.filter((i) => missing.includes(i.key)).forEach((item, i) => {
    console.error(`  2.${i + 1} ${item.key}（${item.label}）：${item.url}`);
  });
  console.error('  3. 在 .env 中填入后重跑本命令\n');
}
