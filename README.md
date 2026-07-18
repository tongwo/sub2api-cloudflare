# Sub2API-CF · Cloudflare 原生版 (v2)

> 这是 [sub2api](https://github.com/Wei-Shaw/sub2api)（AI API 中转站）的 **Cloudflare 原生分支 / 移植版**。
> 原版依赖 Go 后端 + PostgreSQL + Redis；本分支把核心能力**重写到 Cloudflare Workers + D1** 上，零成本跑在边缘网络，无需任何 VPS。

一个**纯跑在 Cloudflare 上**的 AI API 中转站，对标 sub2api 的核心能力：

- 支持 **5 个平台**：`openai` / `anthropic`(Claude) / `gemini` / `grok`(xAI) / `antigravity`
- 支持 **api_key** 与 **oauth** 两种凭证类型（**cookie/sessionKey 类型明确不支持**，规避平台限制风险）
- **Sub2API 风格批量导入**：简化数组 或 Codex 风格 `content` 双格式
- **多账号调度**：priority + schedulable + 限速/过载时间窗（对齐 Sub2API 调度策略）
- **OAuth 自动刷新**：Cron 每 10 分钟刷新临近过期的 token
- **API Key 分发** 给下游（Claude Code / Cursor / OpenCode / 任意 OpenAI 客户端）
- **令牌级用量统计** 与额度上限
- **零成本**：仅 Cloudflare Workers + D1（免费额度足够个人/小团队）

---

## 架构

```
下游客户端 (Claude Code / Cursor / OpenCode …)
   │  Authorization: Bearer sk-xxxx
   ▼
Cloudflare Worker  (sub2api-cf)
   ├─ 鉴权 user_keys 表 (D1)
   ├─ 选上游账号 (Sub2API 风格调度: priority + 限速/过载窗)
   ├─ OAuth 过期前自动刷新 (refreshOAuth)
   ├─ 协议转换 (OpenAI ⇄ Anthropic / Gemini；Grok/Antigravity 走 OpenAI 协议)
   ├─ 流式 SSE 转发
   └─ 用量落库 (D1 usage_logs)
   │
   ▼  fetch 上游
OpenAI / Anthropic / Gemini / xAI API
```

## 部署（5 步）

需要 Node.js ≥ 18 与一个 Cloudflare 账号。

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 建 D1 数据库，把输出的 id 填进 wrangler.toml 的 database_id
npx wrangler d1 create sub2api-cf

# 4. 建表（远程）
npx wrangler d1 migrations apply sub2api-cf --remote

# 5. 设置管理令牌（强随机串），并部署
npx wrangler secret put ADMIN_TOKEN
#   在弹出的编辑器里输入：openssl rand -hex 32  的结果
npx wrangler deploy
```

部署完得到 `https://<你的子域>.workers.dev`（或 wrangler.toml 里配置的自定义域名）。

> 可选：Gemini OAuth 刷新需要 client_secret，用 `wrangler secret put GEMINI_OAUTH_CLIENT_SECRET` 设置。

---

## 导入账号（核心能力）

### 格式 A：简化数组（推荐）

```bash
curl -X POST https://<你的地址>/admin/accounts/import \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "content-type: application/json" -d '[
  {"name":"账号1","platform":"openai","type":"api_key",
   "credentials":{"api_key":"sk-xxx"}},
  {"name":"账号2","platform":"gemini","type":"oauth",
   "credentials":{"access_token":"...","refresh_token":"...","expires_at":1735689600000}}
]'
```

字段说明：

| 字段 | 说明 |
|---|---|
| `name` | 账号显示名（同名同平台重复导入会更新） |
| `platform` | `openai` / `anthropic` / `gemini` / `grok` / `antigravity` |
| `type` | `api_key` 或 `oauth`（`cookie` 会被拒绝） |
| `credentials` | `api_key` 类型：`{api_key}`；`oauth` 类型：`{access_token, refresh_token?, expires_at?, client_id?}` |
| `base_url` | 可选，留空用官方默认；第三方兼容网关填它的 base |
| `model_map` | 可选，`{"对外名":"上游真实名"}` |
| `priority` | 可选，越小越优先（默认 50） |
| `concurrency` | 可选，最大并发（默认 3） |

返回 `{total, created, updated, skipped, failed, items, errors}`，与 Sub2API 导入返回结构一致。

### 格式 B：Sub2API Codex 风格

```bash
curl -X POST https://<你的地址>/admin/accounts/import \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "content-type: application/json" -d '{
  "content":"eyJhY2Nlc3NfdG9rZW4iOiAiLi4uIn0",
  "contents":["eyJ..."],
  "name":"批量",
  "platform":"openai"
}'
```

- `content` / `contents` 为 base64url(JSON) 形式的 OAuth 凭证串，自动解析出 `access_token` / `refresh_token` / `expires_at`。
- 每个 `content` 导入为一个 oauth 账号。

> 去重规则：相同 `platform + type + name + 凭证指纹` 不会重复建。

---

## 使用

### 1. 打开管理后台
浏览器访问 `https://<你的地址>/admin?token=<ADMIN_TOKEN>`，或直接打开 `/admin` 后在页面里粘贴令牌。

- **批量导入账号**：选中平台，粘贴上面任一种格式的 JSON，点"导入"。
- **生成用户 Key**：填备注与额度，得到 `sk-xxxx`。这个 Key 就是下游客户端用的。

### 2. 在客户端里接入
任意支持 OpenAI 格式的工具，把 API Base 指向你的 Worker 地址、API Key 填生成的 `sk-xxxx`：

```bash
curl https://<你的地址>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

Claude Code / OpenCode 等若要接 Anthropic 原生，可在后台加一个 `anthropic` 平台账号（type=oauth 或 api_key），网关自动把 OpenAI 请求翻译成 `/v1/messages`。

### 3. 查看用量
后台"概览"显示累计 tokens、调用次数、可用 Key / 账号数。

---

## 支持的供应商与模型映射

| 平台 | 默认 Base | 协议 | 凭证类型 |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | OpenAI 兼容 | api_key / oauth |
| `anthropic` | `https://api.anthropic.com` | Anthropic Messages | api_key / oauth |
| `gemini` | `https://generativelanguage.googleapis.com` | Gemini v1beta | api_key / oauth |
| `grok` | `https://api.x.ai/v1` | OpenAI 兼容 | api_key / oauth |
| `antigravity` | `https://api.anthropic.com` | Anthropic Messages | api_key / oauth |

模型别名：在账号的 `model_map` 写 `{"对外名":"上游真实名"}`，例如 `claude-3-5-sonnet` → `claude-3-5-sonnet-20241022`。

---

## OAuth 刷新

- 调度选中 oauth 账号时，若 `expires_at` 距现在 < 5 分钟，自动用 `refresh_token` 换取新 `access_token` 并写回 D1。
- Cron Trigger `*/10 * * * *` 会批量刷新所有临近过期的 oauth 账号。
- 刷新端点：`openai`→`auth.openai.com/oauth/token`，`gemini`→`oauth2.googleapis.com/token`，`grok`→`auth.x.ai/oauth2/token`。

---

## 本地测试

```bash
npm test
# 等价于：node --experimental-sqlite test/run.js
```

覆盖 relay 协议适配、导入（双格式/去重/cookie拒绝）、Sub2API 调度（priority/限速窗）、OAuth 刷新、Grok 平台等 81 项断言，任一失败会非零退出。

---

## 已知边界（MVP）

- 功能聚焦"中转 + 分发 + 导入 + 用量"，未实现原版 Sub2API 的：支付系统、可视化调度策略编辑、OAuth 登录导入 UI、代理绑定、并发精确控制。
- **不支持 `cookie` / `sessionKey` 类型账号**（规避平台限制/会话重放风险，导入会被拒绝）。
- 单 Worker 的 CPU / 响应时长有上限（免费版约 10s CPU），超大模型长对话建议开 Workers Paid 提额。
- 不要把管理令牌和 Key 写进客户端日志；Key 泄露 ≈ 上游账号暴露。

## License

MIT
