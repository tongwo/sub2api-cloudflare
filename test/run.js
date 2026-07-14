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
  await db
    .prepare(
      "INSERT INTO accounts (provider,name,api_key,base_url,model_map,weight,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(acct.provider, acct.name, acct.api_key, acct.base_url || "", JSON.stringify(acct.model_map || {}), acct.weight || 1, 1, Date.now())
    .run();
}
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
      new Request("https://x/admin/accounts", { method: "POST", headers: H, body: JSON.stringify({ name: "acc", provider: "openai", api_key: "sk-x" }) }),
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
}

// ============================================================
//  入口
// ============================================================
async function main() {
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
    process.exit(1);
  }
  console.log("\x1b[32m全部通过 ✅\x1b[0m");
}

main();
