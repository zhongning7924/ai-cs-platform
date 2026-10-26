/**
 * .env 加载副作用模块（先于任何读 process.env 的模块执行）。
 * 用法：`import './env.js';`（side-effect import）。
 * 关键：ESM 中 index.ts 的 import 会先于其模块体执行，
 * 若在 index.ts 里才调用 loadDotEnv，agent.ts 顶层的初始化就读不到 .env。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '@cs/kb-core';

// apps/gateway/src 上三级 = 仓库根；密钥占位见 .env.example
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

loadDotEnv(REPO_ROOT);
