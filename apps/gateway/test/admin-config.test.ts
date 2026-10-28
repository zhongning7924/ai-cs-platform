import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AdminConfigStore, validateConfig } from '../src/admin/config.js';

test('validateConfig：拒绝非法输入', () => {
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig('x').ok, false);
  assert.equal(validateConfig({ persona: 123 }).ok, false);

  const badTemp = validateConfig({ model: { model: 'm', temperature: 3, maxTokens: 1024 } });
  assert.equal(badTemp.ok, false);

  const badTokens = validateConfig({ model: { model: 'm', temperature: 0.3, maxTokens: 10 } });
  assert.equal(badTokens.ok, false);

  const noModel = validateConfig({ model: { temperature: 0.3, maxTokens: 1024 } });
  assert.equal(noModel.ok, false);
});

test('validateConfig：接受合法输入并归一化', () => {
  const r = validateConfig({ persona: '  你是某某品牌客服  ', model: { model: ' Qwen/7B ', temperature: 0.5, maxTokens: 2048 } });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.persona, '你是某某品牌客服');
    assert.equal(r.value.model?.model, 'Qwen/7B');
    assert.equal(r.value.model?.temperature, 0.5);
    assert.equal(r.value.model?.maxTokens, 2048);
    assert.ok(r.value.updatedAt > 0);
  }

  // model 传 null 表示清空覆盖
  const reset = validateConfig({ persona: '', model: null });
  assert.equal(reset.ok, true);
  if (reset.ok) assert.equal(reset.value.model, null);
});

test('AdminConfigStore：读写与运行时覆盖', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-admin-'));
  try {
    const store = new AdminConfigStore(dir);

    // 初始为空
    const empty = store.read();
    assert.equal(empty.persona, '');
    assert.equal(empty.model, null);

    // 写入并读回
    store.write({ persona: '你是售后客服', model: { model: 'Qwen/7B', temperature: 0.4, maxTokens: 512 }, updatedAt: 1 });
    const cfg = store.read();
    assert.equal(cfg.persona, '你是售后客服');
    assert.equal(cfg.model?.model, 'Qwen/7B');

    // 运行时覆盖：persona 空时不透传；有值时透传
    const ov = store.runtimeOverrides();
    assert.equal(ov.persona, '你是售后客服');
    assert.equal(ov.model, 'Qwen/7B');
    assert.equal(ov.temperature, 0.4);
    assert.equal(ov.maxTokens, 512);

    // 清空后不再透传 persona/model
    store.write({ persona: '', model: null, updatedAt: 2 });
    const ov2 = store.runtimeOverrides();
    assert.equal(ov2.persona, undefined);
    assert.equal(ov2.model, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AdminConfigStore：坏 JSON 回退默认，不抛异常', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-admin-'));
  try {
    const store = new AdminConfigStore(dir);
    // 写坏 JSON 到文件
    writeFileSync(path.join(dir, 'admin-config.json'), '{bad json', 'utf-8');
    const cfg = store.read();
    assert.equal(cfg.persona, '');
    assert.equal(cfg.model, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AdminConfigStore：目录不存在时自动创建', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'cs-admin-')), 'nested', 'sub');
  const store = new AdminConfigStore(dir);
  assert.equal(existsSync(dir), true);
  store.write({ persona: 'x', model: null, updatedAt: 0 });
  assert.equal(existsSync(path.join(dir, 'admin-config.json')), true);
  rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
});
