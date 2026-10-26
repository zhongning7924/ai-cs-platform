# 私有化部署

单机单商户：一台机器服务一家客户。客户运维只需要会 `docker compose`。

## 交付流程

客户内网通常不能拉镜像，所以是「在有网机器上构建，打包搬进去」。

```bash
# ① 构建（有网机器，仓库根执行）
docker compose -f deploy/docker-compose.yml build --pull

# ② 打包成一个文件搬进内网
docker save -o cs-private.tar \
  cs-gateway:latest cs-agent:latest qdrant/qdrant:v1.12.4

# ③ 客户内网
docker load -i cs-private.tar
cp deploy/.env.private.example deploy/.env   # 按现场情况填

# ④ 启动（--no-build：现场没有构建环境，也不会去拉基础镜像）
cd deploy && docker compose up -d --no-build
```

## 现场必填的四项

只改 `deploy/.env`，不需要动代码：

| 变量 | 不填的后果 |
|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 规划器降级成规则模板，回复是关键词拼的 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `kb_search` 不注册，知识库完全不检索 |
| `ADMIN_TOKEN` | 管理面只允许容器内本机访问，导出/看板全部 403 |
| `WIDGET_ORIGINS` | 不校验来源，端点可被同行当免费 API 爬知识库 |

`EMBEDDING_DIMENSIONS` 必须和模型对得上。填错的表现不是报错，是建集合成功但召回全空——排查成本很高，`docker logs cs-agent` 里能看到维度声明。

`WIDGET_ORIGINS` 里要**同时写上商户站点和网关自身的地址**。网关自己也提供演示页（`http://<host>:8787/`），它发请求时的 Origin 就是网关自己，不在白名单里会被 403。

## 验证清单

启动后按顺序跑，任一步失败就别往下走：

```bash
# 1. 两个服务都活着
curl -s localhost:8787/health
docker compose ps          # gateway / agent 都应是 healthy

# 2. 智能层装配正确（看 planner 是不是 llm 而不是 rule）
docker compose logs agent | grep "规划器"
#    期望：规划器 = router（4 个坐席: ...）+ llm（你的模型），异常时自动降级 rule

# 2.5 坐席台能打开（转人工要用）
curl -s -o /dev/null -w "%{http_code}\n" localhost:8787/console      # 期望 200

# 3. 知识库真的挂上了
docker compose logs agent | grep "kb_search 已注册"
#    如果看到 "kb_search 未注册（缺 QDRANT_URL / EMBEDDING_API_KEY）"，回去查 embedding 配置

# 4. 管理面鉴权生效（不带 token 必须 401）
curl -s -o /dev/null -w "%{http_code}\n" localhost:8787/api/dataset/export

# 5. 来源白名单生效（不带 Origin 必须 403）
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8787/api/chat \
  -H 'content-type: application/json' -d '{"message":"你好"}'

# 6. 正常链路（带 Origin + token）
curl -N -X POST localhost:8787/api/chat \
  -H 'content-type: application/json' \
  -H 'Origin: https://shop.example.com' \
  -d '{"message":"你好"}'

curl -s -H "X-Admin-Token: $ADMIN_TOKEN" localhost:8787/api/stats/feedback
```

## 知识库首次入库

入库是离线 CLI，不在容器里跑（要读客户的文档目录）：

```bash
# 在能访问 Qdrant 的机器上，仓库根执行
QDRANT_URL=http://qdrant-host:6333 \
EMBEDDING_BASE_URL=http://tei.internal:8080/v1 \
EMBEDDING_API_KEY=sk-xxx \
npm run kb -- ingest samples/kb-sources
```

`KB_NAMESPACE` 要和 agent 容器里的一致，否则写进去也检索不到。

## 扩容前必须换掉的四处

现在这套是**单实例**设计，以下四处都在进程内存里。直接加实例会出现「同一用户换台机器就失忆」「A 机器接了单 B 机器还在排队」，不是性能问题而是正确性问题：

1. `apps/gateway/src/session.ts` 的会话 Map → Redis
2. `apps/gateway/src/guard.ts` 的限流计数 → Redis（否则限流按实例各算各的）
3. `apps/gateway/src/handoff/store.ts` 的工单 Map → 共享存储（否则两个实例的队列互相看不见）
4. `services/agent-py` 的 BM25 词表与 `InMemoryMemory` → 共享存储或每实例独立重建

数据面（`var/data/*.jsonl`）也只在单机安全：NFS 上 `appendFileSync` 不保证原子。

## 已知限制

- **业务工具是 mock**：`query_order` / `create_ticket` 用的是内存假数据。接客户真实中台前，只能演示不能接单。
- **转人工是抢单制**：没有自动分配、坐席在线状态、排队超时兜底。坐席全离线时用户只能一直等，见 ADR-0011 已知限制。
- **没有账号体系**：管理面只有一个共享 token，不区分操作人。单商户够用，多人运维时审计追不到人。
- **备份**：`app-data` 卷里是对话、评价与工单，需要客户自己纳入备份策略。
