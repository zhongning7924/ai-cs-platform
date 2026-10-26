#!/usr/bin/env node
/**
 * kb-cli —— 个人知识库命令行工具（密钥全部读 .env，注册后填入即可）。
 *
 *   npm run kb -- stats                      查看库状态
 *   npm run kb -- ingest                     扫描 ~/kb-sources 全量入库
 *   npm run kb -- ingest ~/docs/xx.md        入库单个文件或目录
 *   npm run kb -- search "七天无理由"         检索
 *   npm run kb -- remove refund.md           按路径删除
 *   npm run kb -- remove a1b2c3d4e5f6        按 docId 删除
 *   npm run kb -- keepalive                  探活（防 Qdrant 免费层 7 天挂起）
 *
 * 支持格式：.md / .markdown / .txt / .pdf（有文本层）/ .docx；扫描件 PDF 等待 P2 MinerU 解析器。
 * 企业文档源：npm run kb -- feishu（飞书知识库，见 src/feishu.ts 头注释）。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KnowledgeBase,
  QdrantStore,
  SiliconFlowEmbedder,
  SiliconFlowReranker,
  FeishuSource,
  extractDocx,
  extractPdf,
  loadDotEnv,
  missingKbEnv,
  printEnvGuide,
  type KbDocument,
} from '../src/index.js';

const SUPPORTED_EXT = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
const MAX_TEXT_BYTES = 1.5 * 1024 * 1024;
const MAX_BINARY_BYTES = 12 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.workbuddy', '.obsidian']);

/** 文档 id = 绝对路径 sha1 前 12 位：同文件重跑覆盖，移动后视为新文档 */
function docIdFor(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

/** 仓库根（含 packages/ 的 package.json 目录）：npm workspace 会把 cwd 切到包内，相对路径必须锚回仓库根 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'packages'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** 展开 ~，相对路径优先按当前 cwd、其次按仓库根解析 */
function resolveTarget(target: string): string {
  const expanded = target.replace(/^~(?=$|\/|\\)/, os.homedir());
  const abs = path.resolve(expanded);
  if (path.isAbsolute(expanded) || existsSync(abs)) return abs;
  const rooted = path.join(repoRoot(), expanded);
  return existsSync(rooted) ? rooted : abs;
}

function parseArgs(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        flags.set(arg.slice(2), argv[i + 1] ?? '');
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function listFiles(target: string): string[] {
  const abs = resolveTarget(target);
  if (!statSync(abs, { throwIfNoEntry: false })) {
    throw new Error(`路径不存在: ${target}（cwd=${process.cwd()}）`);
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const limit = TEXT_EXT.has(path.extname(entry.name).toLowerCase()) ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
      if (statSync(full).size > limit) {
        console.warn(`  ! 跳过超大文件（>${Math.round(limit / 1024 / 1024)}MB，请先拆分）: ${full}`);
        continue;
      }
      files.push(full);
    }
  };

  if (statSync(abs).isFile()) {
    if (!SUPPORTED_EXT.has(path.extname(abs).toLowerCase())) {
      throw new Error(`暂不支持该格式（支持 md/markdown/txt/pdf/docx）: ${abs}`);
    }
    files.push(abs);
  } else {
    walk(abs);
  }
  return files.sort();
}

function preview(text: string, len = 52): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > len ? `${flat.slice(0, len)}…` : flat;
}

/** 按扩展名抽取正文：二进制格式走解析器（动态 import，不用不加载），文本格式直接 utf8 */
async function extractFileText(file: string): Promise<{ text: string; via: string }> {
  const ext = path.extname(file).toLowerCase();
  const buffer = readFileSync(file);
  if (ext === '.pdf') return extractPdf(buffer);
  if (ext === '.docx') return extractDocx(buffer);
  return { text: buffer.toString('utf8'), via: 'utf8' };
}

function main(): void {
  loadDotEnv();
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? '';

  if (!command || command === 'help') {
    console.log(
      [
        '',
        'kb-cli —— 个人知识库命令行',
        '',
        '  ingest [path]            入库（默认 ~/kb-sources；md/txt/pdf/docx）',
        '  search <query> [--top 5] 检索',
        '  stats                    库状态',
        '  remove <docId|path>      删除文档',
        '  feishu                   列出应用可见的飞书知识空间',
        '  feishu <space_id> [--ns company]  入库飞书知识库（docx 文档）',
        '  keepalive                探活（防 Qdrant 免费层挂起）',
        '',
        '密钥配置：cp .env.example .env 后填写（注册入口见 .env.example 注释）',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  // —— 除 help 外都需要完整密钥 ——
  const missing = missingKbEnv();
  if (missing.length) {
    printEnvGuide(missing);
    process.exit(2);
  }

  const namespace = flags.get('ns') ?? process.env.KB_NAMESPACE ?? 'personal';
  const store = new QdrantStore();
  const kb = new KnowledgeBase({
    embedder: new SiliconFlowEmbedder(),
    store,
    reranker: new SiliconFlowReranker(),
    namespace,
  });

  switch (command) {
    case 'stats': {
      kb
        .stats()
        .then((s) =>
          console.log(
            `\ncollection=${s.collection}\nnamespace=${s.namespace}（${namespace}）\n向量维度=${s.dimensions}\n已入库块数=${s.points}\n`,
          ),
        )
        .catch(fail);
      break;
    }

    case 'keepalive': {
      store
        .ping()
        .then(() => console.log('✓ Qdrant 探活成功，免费层挂起计时已重置'))
        .catch(fail);
      break;
    }

    case 'ingest': {
      const target = positional[1] ?? path.join(os.homedir(), 'kb-sources');
      let files: string[];
      try {
        files = listFiles(target);
      } catch (err) {
        console.error(`✗ ${(err as Error).message}`);
        if (target.endsWith('kb-sources')) {
          console.error(`  默认资料目录不存在：mkdir -p ${target} 后放入 md/txt 文件，或指定路径：npm run kb -- ingest ~/你的目录`);
        }
        process.exit(1);
      }

      if (!files.length) {
        console.log(`✗ 未找到可入库文件（支持 md/markdown/txt/pdf/docx）：${target}`);
        process.exit(1);
      }

      console.log(`\n准备入库 ${files.length} 个文件 → collection=${kb.collection} namespace=${namespace}\n`);
      void (async () => {
        let totalChunks = 0;
        const started = Date.now();
        for (const file of files) {
          const documentId = docIdFor(file);
          const { text, via } = await extractFileText(file);
          const doc: KbDocument = {
            id: documentId,
            title: path.basename(file, path.extname(file)),
            text,
            uri: `file://${file}`,
          };
          const [result] = await kb.ingest([doc]);
          totalChunks += result.chunks;
          console.log(
            `  ✓ ${documentId}  ${String(result.chunks).padStart(3)} 块  ${path.relative(os.homedir(), file) || file}  ${result.durationMs}ms  [${via}]`,
          );
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`\n完成：${files.length} 个文件 / ${totalChunks} 块 / ${secs}s\n`);
      })().catch(fail);
      break;
    }

    case 'search': {
      const query = positional.slice(1).join(' ').trim();
      if (!query) {
        console.error('✗ 用法：npm run kb -- search "要检索的问题"');
        process.exit(1);
      }
      const top = Number(flags.get('top') ?? 5);
      void (async () => {
        const result = await kb.retrieve(query, { topK: top });
        console.log(`\nQ: ${query}  [${result.degraded ? '重排降级' : result.reranked ? '已重排' : '纯向量'}, ${result.latencyMs}ms]\n`);
        result.hits.forEach((hit, i) => {
          const rerank = hit.rerankScore === undefined ? '  -   ' : hit.rerankScore.toFixed(3);
          console.log(`  ${i + 1}. vec=${hit.score.toFixed(3)} rerank=${rerank}  ${hit.chunk.source.title}`);
          console.log(`     ${preview(hit.chunk.text)}`);
          if (hit.chunk.source.uri) console.log(`     来源: ${hit.chunk.source.uri}`);
          if (hit.chunk.source.headingPath) console.log(`     章节: ${hit.chunk.source.headingPath}`);
        });
        if (!result.hits.length) console.log('  （无命中）');
        console.log('');
      })().catch(fail);
      break;
    }

    case 'remove': {
      const target = positional[1];
      if (!target) {
        console.error('✗ 用法：npm run kb -- remove <docId 或 文件路径>');
        process.exit(1);
      }
      const documentId = /^[0-9a-f]{12}$/.test(target) ? target : docIdFor(resolveTarget(target));
      void (async () => {
        await store.deleteByDocument(kb.collection, documentId);
        console.log(`✓ 已删除 ${documentId}`);
      })().catch(fail);
      break;
    }

    case 'feishu': {
      const feishu = new FeishuSource();
      if (!feishu.configured) {
        console.error('✗ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET（注册入口与权限说明见 .env.example 注释）');
        process.exit(2);
      }

      const spaceId = positional[1];
      if (!spaceId) {
        // 无参数：列出可见知识空间，辅助挑选 space_id
        void feishu.listSpaces().then((spaces) => {
          if (!spaces.length) {
            console.log('\n应用可见的知识空间为空：检查应用「可用范围」是否包含知识库成员，以及 wiki:wiki:readonly 权限\n');
            return;
          }
          console.log('\n应用可见的飞书知识空间：\n');
          for (const s of spaces) console.log(`  ${s.spaceId}  ${s.name}`);
          console.log('\n入库：npm run kb -- feishu <space_id> [--ns company]\n');
        }).catch(fail);
        break;
      }

      console.log(`\n拉取飞书知识空间 ${spaceId} → namespace=${namespace}\n`);
      void (async () => {
        let count = 0;
        let totalChunks = 0;
        let skipped = 0;
        const started = Date.now();
        for await (const fdoc of feishu.walkSpace(spaceId)) {
          const content = await feishu.getDocRawContent(fdoc.objToken).catch((err: unknown) => {
            console.warn(`  ! 跳过「${fdoc.title}」: ${(err as Error).message}`);
            return '';
          });
          if (!content.trim()) {
            skipped += 1;
            continue;
          }
          // docId 绑定 node_token：重复执行幂等覆盖，文档改名/移动不产生重复
          const documentId = createHash('sha1').update(`feishu:${fdoc.nodeToken}`).digest('hex').slice(0, 12);
          const [result] = await kb.ingest([
            { id: documentId, title: fdoc.title, text: content, uri: feishu.docUri(fdoc.nodeToken) },
          ]);
          totalChunks += result.chunks;
          count += 1;
          console.log(`  ✓ ${documentId}  ${String(result.chunks).padStart(3)} 块  ${fdoc.title}  ${result.durationMs}ms`);
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`\n完成：${count} 篇文档 / ${totalChunks} 块（跳过 ${skipped} 篇空文档/无权限）/ ${secs}s\n`);
      })().catch(fail);
      break;
    }

    default:
      console.error(`✗ 未知命令: ${command}（可用：ingest / search / stats / remove / keepalive / help）`);
      process.exit(1);
  }
}

function fail(err: unknown): never {
  console.error(`\n✗ 失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

main();
