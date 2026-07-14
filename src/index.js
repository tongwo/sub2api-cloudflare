// index.js — Sub2API-CF 网关入口（纯 Cloudflare Worker + D1）
import { buildUpstream, makeOpenAIStream, openaiPassTranslator, DEFAULT_BASE } from "./relay.js";
import { ADMIN_HTML } from "./admin.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, service: "sub2api-cf", ts: Date.now() });
    }

    // 裸域名跳转到管理后台，避免直接打开只看到 health 的 JSON
    if (path === "/") {
      const u = new URL(request.url);
      u.pathname = "/admin";
      return Response.redirect(u.toString(), 302);
    }

    // 管理后台页面
    if (path === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // 管理 API
    if (path.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    // OpenAI 兼容中继
    if (path === "/v1/chat/completions" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }

    return json({ error: "not found", path }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------- 中继核心 ----------

async function handleChat(request, env, ctx) {
  const db = env.DB;

  // 1) 鉴权
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: "missing authorization header" }, 401);
  const userKey = m[1].trim();

  const keyRow = await db
    .prepare("SELECT * FROM user_keys WHERE key = ? AND enabled = 1")
    .bind(userKey)
    .first();
  if (!keyRow) return json({ error: "invalid api key" }, 401);

  // 2) 额度
  if (keyRow.quota_tokens != null && keyRow.used_tokens >= keyRow.quota_tokens) {
    return json({ error: "quota exceeded", used: keyRow.used_tokens, quota: keyRow.quota_tokens }, 429);
  }

  // 3) 解析请求体
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body.model) return json({ error: "model is required" }, 400);

  // 4) 选上游账号：least-recently-used（enabled 中 last_used 最小者）
  const acct = await db
    .prepare("SELECT * FROM accounts WHERE enabled = 1 ORDER BY last_used ASC LIMIT 1")
    .first();
  if (!acct) return json({ error: "no available upstream account" }, 503);

  // 标记使用时间（异步，不阻塞响应）
  ctx.waitUntil(
    db.prepare("UPDATE accounts SET last_used = ? WHERE id = ?").bind(Date.now(), acct.id).run()
  );

  // 5) 构建并发送上游请求
  let upstream;
  try {
    upstream = buildUpstream(acct, body);
  } catch (e) {
    return json({ error: "build upstream failed", detail: String(e) }, 400);
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: upstream.body,
    });
  } catch (e) {
    return json({ error: "upstream unreachable", detail: String(e) }, 502);
  }

  const model = (safeJson(acct.model_map, {})[body.model]) || body.model;

  // 6a) 非流式：转响应体
  if (!upstream.isStream) {
    const text = await upstreamResp.text();
    let out = text;
    if (upstream.translateResponse) {
      try { out = JSON.stringify(upstream.translateResponse(JSON.parse(text))); } catch {}
    }
    const usage = tryUsage(out);
    if (usage) ctx.waitUntil(logUsage(env, keyRow, acct, model, usage));
    return new Response(out, {
      status: upstreamResp.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 6b) 流式：转 SSE
  // 先确认上游状态：非 2xx 直接透传错误体，避免把错误 JSON 当 SSE 解析成空响应
  if (upstreamResp.status !== 200) {
    const errText = await upstreamResp.text();
    return new Response(errText, {
      status: upstreamResp.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const state = { model, provider: upstream.provider, usage: null };
  const translator = upstream.translator || openaiPassTranslator;
  const stream = makeOpenAIStream(upstreamResp.body, translator, state, async (st) => {
    if (st.usage) await logUsage(env, keyRow, acct, model, st.usage);
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function tryUsage(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    if (j && j.usage) return j.usage;
  } catch {}
  return null;
}

// ---------- 用量落库 ----------

async function logUsage(env, keyRow, acct, model, usage) {
  if (!usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const db = env.DB;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO usage_logs (user_key_id, account_id, model, prompt_tokens, completion_tokens, created_at) VALUES (?,?,?,?,?,?)"
      ).bind(keyRow.id, acct.id, model, pt, ct, Date.now()),
      db.prepare("UPDATE user_keys SET used_tokens = used_tokens + ? WHERE id = ?").bind(pt + ct, keyRow.id),
      db.prepare("UPDATE accounts SET usage_tokens = usage_tokens + ? WHERE id = ?").bind(pt + ct, acct.id),
    ]);
  } catch (e) {
    console.warn("logUsage failed:", String(e));
  }
}

// ---------- 管理 API ----------

async function handleAdmin(request, env, url) {
  const token = request.headers.get("x-admin-token") || url.searchParams.get("token");
  if (token !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);

  const db = env.DB;
  const parts = url.pathname.split("/").filter(Boolean); // ["admin","accounts", ":id"]
  const resource = parts[1];
  const id = parts[2];

  if (resource === "accounts") {
    if (request.method === "GET") {
      const rows = await db
        .prepare("SELECT id,name,provider,base_url,model_map,weight,enabled,usage_tokens,last_used,created_at FROM accounts ORDER BY id DESC")
        .all();
      return json(rows.results);
    }
    if (request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.name || !b.provider || !b.api_key) {
        return json({ error: "name, provider, api_key are required" }, 400);
      }
      const base = (b.base_url && b.base_url.trim()) || DEFAULT_BASE[b.provider];
      if (!base) return json({ error: "unknown provider: " + b.provider }, 400);
      await db
        .prepare(
          "INSERT INTO accounts (provider,name,api_key,base_url,model_map,weight,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)"
        )
        .bind(b.provider, b.name, b.api_key, base, JSON.stringify(b.model_map || {}), b.weight || 1, 1, Date.now())
        .run();
      return json({ ok: true });
    }
    if (request.method === "DELETE" && id) {
      await db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  if (resource === "keys") {
    if (request.method === "GET") {
      const rows = await db
        .prepare("SELECT id,key,label,quota_tokens,used_tokens,enabled,created_at FROM user_keys ORDER BY id DESC")
        .all();
      return json(rows.results);
    }
    if (request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
      await db
        .prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at) VALUES (?,?,?,?,?,?)")
        .bind(key, b.label || "", b.quota_tokens ?? null, 0, 1, Date.now())
        .run();
      return json({ ok: true, key });
    }
    if (request.method === "DELETE" && id) {
      await db.prepare("DELETE FROM user_keys WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  if (resource === "stats") {
    const tot = await db
      .prepare("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS total_tokens, COUNT(*) AS calls FROM usage_logs")
      .first();
    const keys = await db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE enabled=1").first();
    const accts = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE enabled=1").first();
    return json({ ...tot, active_keys: keys.n, active_accounts: accts.n });
  }

  return json({ error: "unknown admin resource: " + resource }, 404);
}
