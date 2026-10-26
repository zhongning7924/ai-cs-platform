import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, splitSections } from '../src/chunker.js';

test('按标题切分并保留标题路径', () => {
  const md = [
    '# 退货政策',
    '七天无理由退货，需保持商品完好。',
    '## 生鲜类',
    '生鲜不支持七天无理由，签收后 24 小时内可申请。',
  ].join('\n');

  const sections = splitSections(md);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].headingPath, '退货政策');
  assert.equal(sections[1].headingPath, '退货政策 > 生鲜类');
  assert.match(sections[1].text, /24 小时内/);
});

test('长文本切片不超过上限，且相邻块有重叠', () => {
  const sentence = '客户在签收后七天内可以申请无理由退货。';
  const md = `# 政策\n${sentence.repeat(120)}`;

  const chunks = chunkText(md, { maxChars: 200, overlapChars: 40, minChars: 20 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 200, `切片超长: ${chunk.text.length}`);
  }

  // 重叠检验：前一块结尾若干字应出现在后一块开头
  const first = chunks[0].text;
  const second = chunks[1].text;
  const tail = first.slice(-12);
  assert.ok(second.includes(tail.slice(-6)), '相邻切片未保留上下文重叠');
});

test('无标点长文本按上限硬切，不丢字', () => {
  const raw = '啊'.repeat(900);
  const chunks = chunkText(`# 长文\n${raw}`, { maxChars: 300, overlapChars: 0, minChars: 10 });
  const total = chunks.reduce((sum, c) => sum + c.text.length, 0);
  assert.equal(total, 900);
});

test('过短的尾块并入上一块', () => {
  const md = ['# 标题', '第一段内容比较长，需要单独成块处理。'.repeat(6), '尾巴'].join('\n');
  const chunks = chunkText(md, { maxChars: 120, overlapChars: 0, minChars: 40 });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[chunks.length - 1].text.length >= 40);
});
