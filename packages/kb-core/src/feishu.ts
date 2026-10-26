/**
 * 飞书知识库连接器（SourceProvider 模式，对应 ADR-005）。
 *
 * 企业知识库的文档源与本地文件源走同一条 ingest 管道：
 *   飞书 API（raw_content ≈ markdown）→ chunker → bge-m3 → Qdrant
 *
 * 准备工作（管理员操作，一次性）：
 *   1. https://open.feishu.cn/app 创建「企业自建应用」；
 *   2. 开通权限：`wiki:wiki:readonly`（知识库读）+ `docx:document:readonly`（文档读）；
 *   3. 应用发布版本后，把知识库所在空间「添加」进应用的可用范围；
 *   4. .env 填 FEISHU_APP_ID / FEISHU_APP_SECRET。
 *
 * 仅支持新版文档（docx 类型）；旧版 doc / 表格 / 思维笔记会跳过并提示。
 */

const DEFAULT_BASE = 'https://open.feishu.cn';

export interface FeishuOptions {
  appId?: string;
  appSecret?: string;
  /** 私有化飞书域名可覆盖（如 https://open.xxx.cn） */
  baseUrl?: string;
}

export interface FeishuSpace {
  spaceId: string;
  name: string;
}

export interface FeishuDoc {
  /** 知识库节点 token（用于生成回链 uri） */
  nodeToken: string;
  /** 文档 token（docx API 入参） */
  objToken: string;
  title: string;
  objType: string;
}

interface FeishuResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export class FeishuSource {
  private readonly appId?: string;
  private readonly appSecret?: string;
  private readonly baseUrl: string;
  private token: string | null = null;
  private tokenExpireAt = 0;

  constructor(options: FeishuOptions = {}) {
    this.appId = options.appId ?? process.env.FEISHU_APP_ID;
    this.appSecret = options.appSecret ?? process.env.FEISHU_APP_SECRET;
    this.baseUrl = (options.baseUrl ?? process.env.FEISHU_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  get configured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new Error(
        '缺少 FEISHU_APP_ID / FEISHU_APP_SECRET。到 https://open.feishu.cn/app 创建企业自建应用，' +
          '开通 wiki:wiki:readonly 与 docx:document:readonly 权限后填入 .env（见 .env.example）',
      );
    }
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as FeishuResponse<T>;
    if (json.code !== 0) {
      if (json.code === 99991663 || json.code === 99991661) {
        // token 过期/无效：清缓存，下次调用重新获取
        this.token = null;
      }
      throw new Error(`飞书 API ${path} 失败 code=${json.code}: ${json.msg}`);
    }
    return json.data;
  }

  private async ensureToken(): Promise<string> {
    this.assertConfigured();
    if (this.token && Date.now() < this.tokenExpireAt - 60_000) return this.token;

    const res = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number };
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error(`飞书获取 tenant_access_token 失败 code=${json.code}: ${json.msg}（检查 app_id/app_secret 与应用可用范围）`);
    }
    this.token = json.tenant_access_token;
    this.tokenExpireAt = Date.now() + (json.expire ?? 7200) * 1000;
    return this.token;
  }

  /** 列出应用可见的知识空间（用于交互式挑选 space_id） */
  async listSpaces(): Promise<FeishuSpace[]> {
    const spaces: FeishuSpace[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ page_size: '50' });
      if (pageToken) qs.set('page_token', pageToken);
      const data = await this.request<{ items?: Array<{ space_id: string; name: string }>; has_more?: boolean; page_token?: string }>(
        `/open-apis/wiki/v2/spaces?${qs}`,
      );
      for (const item of data.items ?? []) spaces.push({ spaceId: item.space_id, name: item.name });
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return spaces;
  }

  /** 递归遍历知识空间全部节点（含子节点），产出可入库的 docx 文档 */
  async *walkSpace(spaceId: string): AsyncGenerator<FeishuDoc> {
    const stack: Array<{ parentNodeToken?: string }> = [{}];
    while (stack.length) {
      const { parentNodeToken } = stack.shift()!;
      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({ space_id: spaceId, page_size: '50' });
        if (parentNodeToken) qs.set('parent_node_token', parentNodeToken);
        if (pageToken) qs.set('page_token', pageToken);
        const data = await this.request<{
          items?: Array<{ node_token: string; obj_token: string; obj_type: string; title: string; has_child?: boolean }>;
          has_more?: boolean;
          page_token?: string;
        }>(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${qs}`);

        for (const item of data.items ?? []) {
          if (item.has_child) stack.push({ parentNodeToken: item.node_token });
          if (item.obj_type === 'docx') {
            yield { nodeToken: item.node_token, objToken: item.obj_token, title: item.title, objType: item.obj_type };
          }
        }
        pageToken = data.has_more ? data.page_token : undefined;
      } while (pageToken);
    }
  }

  /** 拉取文档正文（raw_content 返回近似 markdown 的纯文本） */
  async getDocRawContent(objToken: string): Promise<string> {
    const data = await this.request<{ content: string }>(
      `/open-apis/docx/v1/documents/${encodeURIComponent(objToken)}/raw_content`,
    );
    return data.content ?? '';
  }

  /** 知识库节点回链（引用卡片可点击跳回原文） */
  docUri(nodeToken: string): string {
    return `https://www.feishu.cn/wiki/${nodeToken}`;
  }
}
