/**
 * 文档解析器：把二进制/富文本格式统一抽成纯文本，交给下游 chunker。
 *
 * 设计原则（ADR-003/004）：
 * - MVP 内置轻量解析（文本型 PDF / docx），零原生依赖；
 * - 扫描件、复杂表格 PDF 不在此解决 —— P2 挂 MinerU sidecar（专业解析重器）；
 * - 动态 import：不用 PDF/docx 时完全不加载 pdf.js 与 mammoth，CLI 启动零开销。
 */

export interface ExtractResult {
  text: string;
  /** 解析器标识，用于 CLI 日志（如 unpdf(3p) / mammoth / utf8） */
  via: string;
}

/** 文本型 PDF → 纯文本（跨页合并，页间空行分隔） */
export async function extractPdf(buffer: Buffer): Promise<ExtractResult> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join('\n\n') : text)
    .replace(/\u0000/g, '')
    .trim();
  if (!merged) {
    throw new Error(
      'PDF 未提取到文本层——大概率是扫描件/纯图片 PDF，MVP 不支持（等待 P2 MinerU 解析器），请先转文字版',
    );
  }
  return { text: merged, via: `unpdf(${totalPages}p)` };
}

/** docx → 近 markdown：标题层级转 #，供 chunker 生成 headingPath 引用链 */
export async function extractDocx(buffer: Buffer): Promise<ExtractResult> {
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const md = htmlToMarkdownish(html);
  if (!md.trim()) throw new Error('docx 未提取到文本');
  return { text: md, via: 'mammoth' };
}

/** mammoth 输出的受限 HTML → 近 markdown（只保留标题/列表/段落结构） */
function htmlToMarkdownish(html: string): string {
  const HEADING_MAP: Array<[RegExp, string]> = [
    [/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '#'],
    [/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '##'],
    [/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '###'],
    [/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '####'],
    [/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '#####'],
    [/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '######'],
  ];

  let out = html;
  for (const [re, hashes] of HEADING_MAP) {
    out = out.replace(re, (_m, inner: string) => `\n\n${hashes} ${stripTags(inner)}\n\n`);
  }
  return out
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<(p|div|br|table|tr|ul|ol)[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|table|tr|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
