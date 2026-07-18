// test/run.js
// Sub2API-CF 端到端测试 harness。
// 用 node:sqlite 模拟 D1、用 mock fetch 模拟上游，直接调用真实的 src/index.js handler，
// 跑通「鉴权 → LRU 选账号 → 上游协议适配 → 流式转换 → 用量落库 → 额度 → 管理 API」全链路。
import worker from "../src/index.js";
import {
  buildUpstream,
  openaiPassTranslator,
  anthropicToOpenAI,
  geminiToOpenAI,
} from "../src/relay.js";
import { makeD1 } from "./d1.js";
import { installFetchMock } from "./mock-fetch.js";

// ---------- 极简测试框架 ----------
let pass = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    failures.push(msg);
    throw new Error(msg);
  }
}
function eq(a, b, msg) {
  assert(a === b, `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`);
}
function includes(hay, needle, msg) {
  assert(hay && hay.includes(needle), `${msg} (应含 ${JSON.stringify(needle)})`);
}
async function test(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32m✓\x1b[0m", name);
  } catch (e) {
    console.log("  \x1b[31m✗\x1b[0m", name, "\x1b[31m->\x1b[0m", e.message);
  }
}

// ---------- 测试工具 ----------
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => {
      pending.push(p);
      return p;
    },
    async drain() {
      for (const p of pending) {
        try {
          await p;
        } catch (e) {
          console.log("    (waitUntil error:", e.message, ")");
        }
      }
      pending.length = 0;
    },
  };
}
async function readBody(res) {
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    return out;
  }
  return await res.text();
}
function parseSSE(text) {
  const events = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      events.push({ done: true });
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events;
}
function setup() {
  const db = makeD1();
  db.migrate();
  const env = { DB: db, ADMIN_TOKEN: "test-admin-token" };
  const ctx = makeCtx();
  return { db, env, ctx };
}
async function seedAccount(db, acct) {
  // 兼容新旧字段：新 v2 表优先
  const existsV2 = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_v2'").first();
  if (existsV2) {
    const norm = {
      name: acct.name,
      platform: acct.provider || acct.platform,
      type: acct.type || "api_key",
      credentials: acct.credentials || { api_key: acct.api_key },
      base_url: acct.base_url || DEFAULT_BASE[(acct.provider || acct.platform)],
      model_map: acct.model_map || {},
      priority: acct.priority ?? 50,
    };
    await db
      .prepare(`INSERT INTO accounts_v2
        (name,platform,type,credentials,extra,model_map,base_url,priority,concurrency,status,schedulable,expires_at,auto_pause_on_expired,usage_tokens,error_message,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(norm.name, norm.platform, norm.type, JSON.stringify(norm.credentials), "{}",
        JSON.stringify(norm.model_map), norm.base_url, norm.priority, 3, "active", 1,
        acct.expires_at || null, 1, 0, null, Date.now())
      .run();
    return;
  }
  await db
    .prepare(
      "INSERT INTO accounts (provider,name,api_key,base_url,model_map,weight,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(acct.provider, acct.name, acct.api_key, acct.base_url || "", JSON.stringify(acct.model_map || {}), acct.weight || 1, 1, Date.now())
    .run();
}

// 直接插入 v2 账号（测试调度窗口用）
async function seedAccountV2(db, acct) {
  await db
    .prepare(`INSERT INTO accounts_v2
      (name,platform,type,credentials,extra,model_map,base_url,priority,concurrency,status,schedulable,rate_limit_reset_at,overload_until,temp_unschedulable_until,expires_at,auto_pause_on_expired,usage_tokens,error_message,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(acct.name, acct.platform, acct.type || "api_key",
      JSON.stringify(acct.credentials || { api_key: "k" }), "{}",
      JSON.stringify(acct.model_map || {}), acct.base_url || DEFAULT_BASE[acct.platform],
      acct.priority ?? 50, acct.concurrency ?? 3, acct.status ?? "active",
      acct.schedulable ?? 1, acct.rate_limit_reset_at || null, acct.overload_until || null,
      acct.temp_unschedulable_until || null, acct.expires_at || null, acct.auto_pause_on_expired ?? 1, 0, null, Date.now())
    .run();
}

import { DEFAULT_BASE } from "../src/relay.js";
async function seedKey(db, quota = null) {
  const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
  await db
    .prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at) VALUES (?,?,?,?,?,?)")
    .bind(key, "k", quota, 0, 1, Date.now())
    .run();
  return key;
}

// ============================================================
//  UNIT TESTS —— relay.js 协议适配层
// ============================================================
async function unitTests() {
  console.log("\n\x1b[1m[Unit] relay.js 协议适配\x1b[0m");

  await test("buildUpstream: openai 非流式", () => {
    const up = buildUpstream(
      { provider: "openai", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gpt-4o" }
    );
    eq(up.url, "https://api.openai.com/v1/chat/completions", "openai url");
    eq(up.headers.authorization, "Bearer k", "openai auth");
    eq(JSON.parse(up.body).stream, false, "openai stream=false");
  });

  await test("buildUpstream: openai 流式自动注入 stream_options.include_usage", () => {
    const up = buildUpstream(
      { provider: "openai", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gpt-4o", stream: true }
    );
    eq(up.isStream, true, "openai isStream");
    const b = JSON.parse(up.body);
    eq(b.stream, true, "openai body.stream=true");
    eq(b.stream_options.include_usage, true, "自动注入 include_usage");
  });

  await test("buildUpstream: openai 流式不覆盖客户端已有 stream_options", () => {
    const up = buildUpstream(
      { provider: "openai", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gpt-4o", stream: true, stream_options: { include_usage: false, other: 1 } }
    );
    const b = JSON.parse(up.body);
    eq(b.stream_options.include_usage, true, "仍强制 include_usage=true");
    eq(b.stream_options.other, 1, "保留客户端其它 stream_options");
  });

  await test("buildUpstream: anthropic 拆分 system 消息", () => {
    const up = buildUpstream(
      { provider: "anthropic", api_key: "k", base_url: "", model_map: "{}" },
      {
        model: "claude-3",
        max_tokens: 100,
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
      }
    );
    eq(up.url, "https://api.anthropic.com/v1/messages", "anthropic url");
    eq(up.headers["x-api-key"], "k", "anthropic x-api-key");
    eq(up.headers["anthropic-version"], "2023-06-01", "anthropic-version");
    const b = JSON.parse(up.body);
    eq(b.system, "be nice", "system 字段");
    eq(b.messages.length, 1, "user 消息保留");
    eq(b.messages[0].role, "user", "user role");
    eq(b.max_tokens, 100, "max_tokens 透传");
  });

  await test("buildUpstream: gemini 流式 url 带 alt=sse", () => {
    const up = buildUpstream(
      { provider: "gemini", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gemini-1.5", messages: [{ role: "user", content: "hi" }], stream: true }
    );
    includes(up.url, "/v1beta/models/gemini-1.5:streamGenerateContent?alt=sse", "gemini 流式 url");
  });

  await test("anthropicToOpenAI: 非流式转换", () => {
    const o = anthropicToOpenAI(
      { content: [{ text: "hi" }], usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: "end_turn" },
      "claude"
    );
    eq(o.choices[0].message.content, "hi", "内容");
    eq(o.usage.prompt_tokens, 2, "prompt_tokens");
    eq(o.usage.completion_tokens, 1, "completion_tokens");
    eq(o.choices[0].finish_reason, "stop", "finish_reason");
  });

  await test("geminiToOpenAI: 非流式转换", () => {
    const o = geminiToOpenAI(
      { candidates: [{ content: { parts: [{ text: "yo" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } },
      "gem"
    );
    eq(o.choices[0].message.content, "yo", "内容");
    eq(o.usage.prompt_tokens, 1, "prompt_tokens");
    eq(o.usage.completion_tokens, 2, "completion_tokens");
  });

  await test("openaiPassTranslator: 透传并捕获 usage", () => {
    const state = { usage: null };
    const chunks = openaiPassTranslator.onData(
      JSON.stringify({ choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      state
    );
    eq(state.usage.prompt_tokens, 1, "捕获 prompt_tokens");
    eq(chunks[0].usage.prompt_tokens, 1, "chunk 带 usage");
  });
}

// ============================================================
//  INTEGRATION TESTS —— 直接调用真实 handler
// ============================================================
async function integrationTests(mock) {
  console.log("\n\x1b[1m[Integration] index.js 全链路\x1b[0m");

  await test("GET /health 返回 ok", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/health"), env, ctx);
    const j = await r.json();
    eq(j.ok, true, "health.ok");
    eq(j.service, "sub2api-cf", "service 名");
  });

  await test("裸域名 / 302 跳转到 /admin", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/"), env, ctx);
    eq(r.status, 302, "status 302");
    eq(new URL(r.headers.get("location")).pathname, "/admin", "Location 指向 /admin");
  });

  await test("/admin 返回后台 HTML", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/admin"), env, ctx);
    eq(r.status, 200, "status 200");
    const t = await r.text();
    assert(t.includes("管理后台"), "含后台标题");
    assert(t.includes('id="token"'), "含令牌输入框");
  });

  await test("无 key 调用 /v1/chat/completions -> 401", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 401, "status 401");
  });

  await test("管理 API 无 token -> 401，有 token -> 200", async () => {
    const { env, ctx } = setup();
    const noTok = await worker.fetch(new Request("https://x/admin/stats"), env, ctx);
    eq(noTok.status, 401, "无 token 401");
    const withTok = await worker.fetch(
      new Request("https://x/admin/stats", { headers: { "x-admin-token": "test-admin-token" } }),
      env,
      ctx
    );
    eq(withTok.status, 200, "有 token 200");
    const j = await withTok.json();
    assert("total_tokens" in j && "active_accounts" in j, "stats 字段齐全");
  });

  await test("管理 API 建账号/建 key (真实 D1 写)", async () => {
    const { env, ctx } = setup();
    const H = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
    const a = await worker.fetch(
      new Request("https://x/admin/accounts", { method: "POST", headers: H, body: JSON.stringify({ name: "acc", platform: "openai", type: "api_key", credentials: { api_key: "sk-x" } }) }),
      env,
      ctx
    );
    eq(a.status, 200, "建账号 200");
    const k = await worker.fetch(
      new Request("https://x/admin/keys", { method: "POST", headers: H, body: JSON.stringify({ label: "k1", quota_tokens: 500 }) }),
      env,
      ctx
    );
    const kj = await k.json();
    eq(k.status, 200, "建 key 200");
    assert(kj.key.startsWith("sk-"), "返回 sk- 前缀 key");
    const list = await worker.fetch(new Request("https://x/admin/keys", { headers: H }), env, ctx);
    const rows = await list.json();
    eq(rows.length, 1, "库里恰好 1 个 key");
  });

  await test("OpenAI 非流式：响应 + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容正确");
    eq(j.usage.total_tokens, 8, "usage 正确");
    await ctx.drain();
    const log = await db.prepare("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS t FROM usage_logs").first();
    eq(log.t, 8, "用量落库 8 token");
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "key 已扣额度");
  });

  await test("OpenAI 流式：SSE 转换 + 末尾 [DONE] + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    eq(r.headers.get("content-type").includes("text/event-stream"), true, "SSE content-type");
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const contents = evs.filter((e) => e.choices && e.choices[0].delta.content).map((e) => e.choices[0].delta.content);
    eq(contents.join(""), "Hello world", "流式内容拼接");
    assert(evs.some((e) => e.done), "以 [DONE] 结尾");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "流式用量落库 8 token");
  });

  await test("Anthropic 流式：转成 OpenAI SSE", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "anthropic", name: "an", api_key: "sk-anthropic", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const contents = evs.filter((e) => e.choices && e.choices[0].delta.content).map((e) => e.choices[0].delta.content);
    eq(contents.join(""), "Hello world", "anthropic 内容拼接");
    const last = evs.filter((e) => e.choices && e.choices[0].finish_reason).pop();
    eq(last.choices[0].finish_reason, "stop", "finish_reason=stop");
    await ctx.drain();
  });

  await test("Gemini 流式：转成 OpenAI SSE", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "gemini", name: "gm", api_key: "sk-gemini", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-1.5", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const contents = evs.filter((e) => e.choices && e.choices[0].delta.content).map((e) => e.choices[0].delta.content);
    eq(contents.join(""), "Hello world", "gemini 内容拼接");
    await ctx.drain();
  });

  await test("额度耗尽 -> 429", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db, 0); // 额度 0
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 429, "status 429");
  });

  await test("Anthropic 非流式：JSON 转换 + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "anthropic", name: "an", api_key: "sk-anthropic", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容");
    eq(j.usage.total_tokens, 8, "usage");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("Gemini 非流式：JSON 转换 + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "gemini", name: "gm", api_key: "sk-gemini", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-1.5", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容");
    eq(j.usage.total_tokens, 8, "usage");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("流式上游报错：坏 key -> 401 透传（不静默空响应）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-bad-key", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    eq(r.status, 401, "流式坏 key 也返回 401");
    const j = await r.json();
    assert(j.error, "透传上游错误体");
  });

  await test("非流式上游报错：坏 key -> 401 透传", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-bad-key", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 401, "非流式坏 key 401");
    const j = await r.json();
    assert(j.error, "透传上游错误体");
  });

  await test("全部账号禁用 -> 503", async () => {
    const { db, env, ctx } = setup();
    await db
      .prepare("INSERT INTO accounts (provider,name,api_key,base_url,model_map,weight,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind("openai", "off", "sk-x", "", "{}", 1, 0, Date.now())
      .run();
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 503, "无可用账号 503");
  });

  await test("模型映射：请求 gpt-4 转发为 gpt-4o", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "", model_map: { "gpt-4": "gpt-4o" } });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    await r.json();
    const call = mock.calls.find((c) => c.host === "api.openai.com");
    eq(call.body.model, "gpt-4o", "上游收到映射后的模型名");
  });

  await test("LRU 轮询：两个账号交替被选中", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "A", api_key: "sk-A", base_url: "" });
    await seedAccount(db, { provider: "openai", name: "B", api_key: "sk-B", base_url: "" });
    const key = await seedKey(db);
    const openaiCalls = () =>
      mock.calls.filter((c) => c.host === "api.openai.com").map((c) => c.headers.authorization);
    const chat = async () => {
      mock.calls.length = 0;
      const r = await worker.fetch(
        new Request("https://x/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
        ctx
      );
      await r.json();
      await ctx.drain();
      return openaiCalls()[0];
    };
    const first = await chat();
    const second = await chat();
    const third = await chat();
    assert(first && second && first !== second, "前两次选中不同账号");
    eq(first, third, "第三次回到第一个账号（LRU 循环）");
  });

  // ---------- 新增：导入 / 调度 / OAuth / cookie 拒绝 ----------

  await test("双格式导入：简化数组批量建账号", async () => {
    const { db, env, ctx } = setup();
    const H = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", {
        method: "POST", headers: H,
        body: JSON.stringify([
          { name: "oa1", platform: "openai", type: "api_key", credentials: { api_key: "sk-arr-1" } },
          { name: "gm1", platform: "gemini", type: "api_key", credentials: { api_key: "key-g" } },
        ]),
      }),
      env, ctx
    );
    const j = await r.json();
    eq(j.total, 2, "total=2");
    eq(j.created, 2, "created=2");
    const list = await worker.fetch(new Request("https://x/admin/accounts", { headers: H }), env, ctx);
    const rows = await list.json();
    eq(rows.length, 2, "库里 2 个账号");
  });

  await test("导入去重：同名同平台重复导入 -> skipped/updated", async () => {
    const { db, env, ctx } = setup();
    const H = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
    const one = { name: "dup", platform: "openai", type: "api_key", credentials: { api_key: "sk-dup" } };
    await worker.fetch(new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify([one]) }), env, ctx);
    const r2 = await worker.fetch(new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify([one]) }), env, ctx);
    const j2 = await r2.json();
    eq(j2.updated + j2.skipped, 1, "第二次重复被 skipped 或 updated");
  });

  await test("cookie/sessionKey 类型导入被拒绝", async () => {
    const { db, env, ctx } = setup();
    const H = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", {
        method: "POST", headers: H,
        body: JSON.stringify([{ name: "ck", platform: "anthropic", type: "cookie", credentials: { session_key: "xxx" } }]),
      }),
      env, ctx
    );
    const j = await r.json();
    eq(j.failed, 1, "failed=1");
    assert(j.errors[0].message.includes("cookie"), "错误提示含 cookie");
  });

  await test("Sub2API 调度：rate_limit_reset_at 未来的账号被跳过", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "blocked", platform: "openai", credentials: { api_key: "sk-x" }, rate_limit_reset_at: Date.now() + 60000 });
    await seedAccountV2(db, { name: "ok", platform: "openai", credentials: { api_key: "sk-y" } });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const auths = mock.calls.filter((c) => c.host === "api.openai.com").map((c) => c.headers.authorization);
    eq(auths[0], "Bearer sk-y", "选中未限速的账号");
  });

  await test("Sub2API 调度：priority 小的优先", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "low", platform: "openai", credentials: { api_key: "sk-low" }, priority: 80 });
    await seedAccountV2(db, { name: "high", platform: "openai", credentials: { api_key: "sk-high" }, priority: 10 });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const auths = mock.calls.filter((c) => c.host === "api.openai.com").map((c) => c.headers.authorization);
    eq(auths[0], "Bearer sk-high", "priority 小的先选");
  });

  await test("OAuth 账号：即将过期时自动刷新（mock fetch 命中 refresh 端点）", async () => {
    // 装一个能识别 refresh 端点的 fetch mock
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(typeof url === "string" ? url : url.toString());
      if (u.host === "auth.openai.com" && u.pathname.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return orig(url, opts);
    };
    const { db, env, ctx } = setup();
    await seedAccountV2(db, {
      name: "oa-oauth", platform: "openai", type: "oauth",
      credentials: { access_token: "old-at", refresh_token: "old-rt", expires_at: Date.now() - 1000 },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const row = await db.prepare("SELECT credentials FROM accounts_v2 WHERE name=?").bind("oa-oauth").first();
    const cred = JSON.parse(row.credentials);
    eq(cred.access_token, "new-at", "OAuth token 已刷新");
    globalThis.fetch = orig;
  });

  await test("Grok 平台：OAuth 走 OpenAI 兼容协议", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "grok1", platform: "grok", type: "api_key", credentials: { api_key: "sk-grok" } });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-3", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const grokCalls = mock.calls.filter((c) => c.host === "api.x.ai");
    eq(grokCalls.length, 1, "请求发到 api.x.ai");
    eq(grokCalls[0].headers.authorization, "Bearer sk-grok", "带 Bearer key");
  });

  await test("真实 Sub2API 备份导出格式 {accounts:[...],expires_at秒} 可导入", async () => {
    const { db, env, ctx } = setup();
    const H = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
    // 复刻 Sub2API ExportData 真实结构（外层 accounts、unix 秒 expires_at）
    const exportPayload = {
      version: 1,
      exported_at: "2026-07-18T08:14:00Z",
      accounts: [
        { name: "real-oa", notes: "备份", platform: "openai", type: "api_key",
          credentials: { api_key: "sk-real-1" }, concurrency: 3, priority: 50,
          rate_multiplier: 1.0, expires_at: 1999999999, auto_pause_on_expired: true },
        { name: "real-oauth", notes: "oauth备份", platform: "openai", type: "oauth",
          credentials: { access_token: "at", refresh_token: "rt", expires_at: 1999999999 },
          concurrency: 5, priority: 20 },
      ],
    };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify(exportPayload) }),
      env, ctx
    );
    const j = await r.json();
    eq(j.total, 2, "total=2");
    eq(j.created, 2, "created=2");
    const row = await db.prepare("SELECT credentials, extra, priority FROM accounts_v2 WHERE name=?").bind("real-oa").first();
    const cred = JSON.parse(row.credentials);
    eq(cred.api_key, "sk-real-1", "api_key 正确导入");
    eq(row.priority, 50, "priority 导入");
    // 验证 expires_at 秒已被转成毫秒
    const oauthRow = await db.prepare("SELECT credentials FROM accounts_v2 WHERE name=?").bind("real-oauth").first();
    const ocred = JSON.parse(oauthRow.credentials);
    eq(ocred.expires_at, 1999999999000, "expires_at 秒->毫秒转换");
  });
}

// ============================================================
//  入口
// ============================================================
export async function runTests() {
  console.log("\x1b[1mSub2API-CF 测试\x1b[0m");
  const mock = installFetchMock();
  try {
    await unitTests();
    await integrationTests(mock);
  } finally {
    mock.restore();
  }
  console.log("\n\x1b[1m结果:\x1b[0m", pass, "通过,", failures.length, "失败");
  if (failures.length) {
    console.log("\x1b[31m失败项:\x1b[0m");
    failures.forEach((f) => console.log("  -", f));
    return false;
  }
  console.log("\x1b[32m全部通过 ✅\x1b[0m");
  return true;
}

// 直接运行：node --experimental-sqlite test/run.js
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((ok) => process.exit(ok ? 0 : 1));
}
