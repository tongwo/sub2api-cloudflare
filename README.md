# Sub2API-CF · Cloudflare 原生版

> 这是 [sub2api](https://github.com/Wei-Shaw/sub2api)（AI API 中转站）的 **Cloudflare 原生分支 / 移植版**。
> 原版依赖 Go 后端 + PostgreSQL + Redis；本分支把核心能力**重写到 Cloudflare Workers + D1** 上，零成本跑在边缘网络，无需任何 VPS。

一个**纯跑在 Cloudflare 上**的 AI API 中转站精简版，对标 sub2api 的核心能力：

- 把 Claude / OpenAI / Gemini 等上游订阅账号，统一收口成 **OpenAI 兼容** 的 `/v1/chat/completions` 接口
- **多账号负载均衡**（least-recently-used 轮询）
- **API Key 分发**给下游（Claude Code / Cursor / OpenCode / 任意 OpenAI 客户端）
- **Token 级用量记录**与额度上限
- **零成本**：只用到 Cloudflare Workers + D1（免费额度足够个人/小团队）

> 对应原项目里"跑不了 Workers"的部分（PostgreSQL + Redis），在这里分别用 **D1（SQLite）** 和 **D1 的 last_used 字段**（代替 Redis 计数器）替代。Worker 本身相当于边缘服务器，能出网访问上游 API、支持 SSE 流式转发。

---

## 架构

```
下游客户端 (Claude Code / Cursor / OpenCode …)
   │  Authorization: Bearer sk-xxxx
   ▼
Cloudflare Worker  (sub2api-cf)
   ├─ 鉴权 user_keys 表 (D1)
   ├─ 选 upstream 账号 (D1, least-recently-used)
   ├─ 协议转换 (OpenAI ⇄ Anthropic / Gemini)
   ├─ 流式 SSE 转发
   └─ 用量落库 (D1 usage_logs)
   │
   ▼  fetch 上游
OpenAI / Anthropic / Gemini API
```

## 目录

```
sub2api-cf/
├── wrangler.toml          # Workers 配置（含 D1 绑定 + 自定义域名）
├── migrations/
│   └── 0001_init.sql      # D1 建表
├── src/
│   ├── index.js            # 网关入口：鉴权 / 负载均衡 / 用量 / 管理 API
│   ├── relay.js            # 上游协议适配（OpenAI / Anthropic / Gemini）
│   └── admin.js           # 管理后台 HTML（Worker 直接 serve）
├── test/
│   ├── d1.js               # 用 node:sqlite 模拟 D1 的本地替身
│   ├── mock-fetch.js       # 模拟 OpenAI / Anthropic / Gemini 上游
│   └── run.js              # 端到端测试（unit + integration）
├── package.json
└── README.md
```

## 部署（5 步）

需要 Node.js ≥ 18 与一个 Cloudflare 账号。

```bash
# 1. 安装 wrangler
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 建 D1 数据库，把输出的 id 填进 wrangler.toml 的 database_id
npx wrangler d1 create sub2api-cf

# 4. 建表（远程）
npx wrangler d1 migrations apply sub2api-cf --remote
#   本地调试可用：npx wrangler d1 migrations apply sub2api-cf --local

# 5. 设置管理令牌（随便一段强随机串），并部署
npx wrangler secret put ADMIN_TOKEN
#   在弹出的编辑器里输入：openssl rand -hex 32  的结果
npx wrangler deploy
```

部署完会得到一个 `https://sub2api-cf.<你的子域>.workers.dev`。

## 本地测试（无需 Cloudflare）

测试用 Node 内置 `node:sqlite` 模拟 D1、用 mock 拦截上游，直接调用真实的 `src/index.js` handler，跑通「鉴权 → LRU 选账号 → 协议转换 → 流式转发 → 用量落库 → 额度 → 管理 API」全链路（含 OpenAI / Anthropic / Gemini 三种流式转换）。

```bash
npm test
# 等价于：node --experimental-sqlite test/run.js
```

需要 Node.js ≥ 22（`node:sqlite` 实验特性）。覆盖 7 个 unit 断言 + 10 个 integration 断言，任一失败会非零退出。

## 使用

### 1. 打开管理后台
浏览器访问 `https://<你的地址>/admin?token=<ADMIN_TOKEN>`，或直接打开 `/admin` 后在页面里粘贴令牌。

- **添加上游账号**：选供应商（OpenAI/Anthropic/Gemini）、填名称和 API Key。Base URL 留空用官方默认；若用第三方兼容网关（如各种中转），填它的 base。
- **生成用户 Key**：填备注与可选额度，点生成，得到 `sk-xxxx`。这个 Key 就是下游客户端用的。

### 2. 在客户端里接入
任意支持 OpenAI 格式的工具，把 API Base 指向你的 Worker 地址、API Key 填生成的 `sk-xxxx` 即可：

```bash
# 直接用 curl 测一把
curl https://<你的地址>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

Claude Code / OpenCode 等若要接 Anthropic 原生，也可在后台加一个 `anthropic` 供应商账号，再把模型名映射过去——网关会自动把 OpenAI 请求翻译成 Anthropic 格式转发。

### 3. 查看用量
后台"概览"区显示累计 tokens、调用次数、可用 Key / 账号数。

## 支持的供应商与模型映射

| 供应商 | 默认 Base | 说明 |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | 也兼容一切 OpenAI 格式网关（填自定义 base 即可） |
| `anthropic` | `https://api.anthropic.com` | 请求自动从 OpenAI 格式翻译为 `/v1/messages` |
| `gemini` | `https://generativelanguage.googleapis.com` | 翻译为 Gemini `v1beta` 接口 |

模型别名：在账号的 `model_map` 里写 `{"对外名":"上游真实名"}`，例如把 `claude-3-5-sonnet` 映射到上游实际的 `claude-3-5-sonnet-20241022`。

## 已知边界（MVP）

- 功能聚焦"中转 + 分发 + 用量"，**未实现**原版 sub2api 的：支付系统、可视化调度策略、OAuth 登录导入、并发精细控制、iframe 外部集成。
- 流式用量统计依赖上游在末个 chunk 回传 `usage`（OpenAI 需客户端带 `stream_options.include_usage=true`；Anthropic/Gemini 由网关从事件里抓取）。
- 单 Worker 的 CPU / 响应时长有上限（免费版约 10s CPU），超大模型长对话建议开 Workers Paid 提额。
- 不要把管理令牌和 Key 写进客户端日志；Key 泄露≈上游账号暴露。

## License
MIT
