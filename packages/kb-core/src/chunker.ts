/**
 * 中文友好切片器（零依赖）。
 *
 * 为什么不直接按固定字符数切：中文语义单元短，硬切会把一句话劈成两半，
 * 向量就会「半句向量」，检索分数虚高但答非所问。
 * 策略：标题切大块 -> 段落切中块 -> 超长按句末标点切小块 -> 相邻块留 overlap。
 */

export interface ChunkOptions {
  /** 目标切片长度（字符），中文建议 300~500 */
  maxChars?: number;
  /** 相邻切片重叠长度，防止答案正好落在切口 */
  overlapChars?: number;
  /** 低于此长度不再单独成块，向前合并 */
  minChars?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  maxChars: 420,
  overlapChars: 60,
  minChars: 80,
};

/** 句末标点：中英文都覆盖，保留标点在切点之前 */
const SENTENCE_END = /[。！？；\n]|[.!?;]\s/g;

interface RawSection {
  headingPath?: string;
  text: string;
  /** 该 section 首字符在原文中的偏移 */
  offset: number;
}

/** 按 markdown 标题切分，同时维护标题路径（一级 > 二级 > 三级） */
export function splitSections(markdown: string): RawSection[] {
  const lines = markdown.split('\n');
  const sections: RawSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let cursor = 0;

  const flush = (endOffset: number) => {
    const text = buffer.join('\n').trim();
    if (text) {
      const headingPath = stack.map((s) => s.title).join(' > ') || undefined;
      sections.push({ headingPath, text, offset: bufferStart });
    }
    buffer = [];
    void endOffset;
  };

  for (const line of lines) {
    const lineStart = cursor;
    cursor += line.length + 1;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush(lineStart);
      const level = heading[1].length;
      const title = heading[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      bufferStart = cursor;
      continue;
    }

    if (!buffer.length) bufferStart = lineStart;
    buffer.push(line);
  }
  flush(cursor);

  return sections;
}

/** 在句末标点处切分长段落 */
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length);
    if (hardEnd === text.length) {
      pieces.push(text.slice(start));
      break;
    }

    // 在窗口内找最后一个句末标点
    const window = text.slice(start, hardEnd);
    let cut = -1;
    SENTENCE_END.lastIndex = 0;
    for (let m = SENTENCE_END.exec(window); m; m = SENTENCE_END.exec(window)) {
      cut = m.index + m[0].length;
    }

    const end = cut > maxChars * 0.4 ? start + cut : hardEnd;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

export interface TextChunk {
  text: string;
  headingPath?: string;
  offset: number;
}

/** 主入口：markdown -> 切片数组（不含 id / namespace，由上层补） */
export function chunkText(markdown: string, options: ChunkOptions = {}): TextChunk[] {
  const { maxChars, overlapChars, minChars } = { ...DEFAULTS, ...options };
  const sections = splitSections(markdown);
  const out: TextChunk[] = [];

  for (const section of sections) {
    const pieces = splitLongText(section.text, maxChars);
    let cursor = 0;

    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      const isLast = i === pieces.length - 1;

      // 尾块过短则并入上一块，避免"半句话切片"
      if (isLast && piece.length < minChars && out.length && out[out.length - 1].headingPath === section.headingPath) {
        const prev = out[out.length - 1];
        prev.text = `${prev.text}\n${piece.trim()}`;
        break;
      }

      out.push({
        text: piece.trim(),
        headingPath: section.headingPath,
        offset: section.offset + cursor,
      });
      cursor += piece.length;

      // 回退 overlap：下一块从当前位置往前咬一口
      if (!isLast && overlapChars > 0) {
        cursor = Math.max(0, cursor - overlapChars);
      }
    }
  }

  return out.filter((c) => c.text.length > 0);
}
