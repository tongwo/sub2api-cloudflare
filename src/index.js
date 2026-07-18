// index.js — Sub2API-CF 网关入口（Cloudflare Workers + D1，v2）
import {
  buildUpstream, makeOpenAIStream, openaiPassTranslator,
  DEFAULT_BASE, OAUTH_TOKEN_URL, needsOAuthRefresh, refreshOAuth,
} from "./relay.js";
import { ADMIN_HTML } from "./admin.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, service: "sub2api-cf", v: 2, ts: Date.now() });
    }
    if (path === "/") {
      const u = new URL(request.url);
      u.pathname = "/admin";
      return Response.redirect(u.toString(), 302);
    }
    if (path === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }
    if (path === "/v1/chat/completions" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }
    return json({ error: "not found", path }, 404);
  },

  // Cron：定期刷新即将过期的 OAuth token
  async scheduled(event, env, ctx) {
    if (event.cron) {
      ctx.waitUntil(refreshDueOAuth(env));
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
function now() { return Date.now(); }

// ---------- 中继核心 ----------

async function handleChat(request, env, ctx) {
  const db = env.DB;

  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: "missing authorization header" }, 401);
  const userKey = m[1].trim();

  const keyRow = await db
    .prepare("SELECT * FROM user_keys WHERE key = ? AND enabled = 1")
    .bind(userKey)
    .first();
  if (!keyRow) return json({ error: "invalid api key" }, 401);

  if (keyRow.quota_tokens != null && keyRow.used_tokens >= keyRow.quota_tokens) {
    return json({ error: "quota exceeded", used: keyRow.used_tokens, quota: keyRow.quota_tokens }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body.model) return json({ error: "model is required" }, 400);

  // 选账号：Sub2API 风格调度
  const acct = await selectAccount(db);
  if (!acct) return json({ error: "no available upstream account" }, 503);

  ctx.waitUntil(
    db.prepare("UPDATE accounts_v2 SET last_used_at = ? WHERE id = ?").bind(now(), acct.id).run()
  );

  // OAuth 即将过期 -> 提前刷新
  const upstream = buildUpstream(acct, body);
  if (needsOAuthRefresh(upstream.credential)) {
    try {
      const updated = await refreshOAuth(acct.platform, upstream.credential, env);
      const merged = { ...safeJson(acct.credentials, {}), ...updated };
      await db
        .prepare("UPDATE accounts_v2 SET credentials = ?, status = 'active', error_message = NULL WHERE id = ?")
        .bind(JSON.stringify(merged), acct.id)
        .run();
      // 用新 token 重建上游
      const freshAcct = { ...acct, credentials: JSON.stringify(merged) };
      const fresh = buildUpstream(freshAcct, body);
      return await relayToUpstream(fresh, freshAcct, body, keyRow, env, ctx);
    } catch (e) {
      // 刷新失败：标记账号错误，但允许本次尝试（可能 token 仍有效）
      await db
        .prepare("UPDATE accounts_v2 SET status = 'error', error_message = ? WHERE id = ?")
        .bind(String(e).slice(0, 500), acct.id)
        .run();
    }
  }
  return await relayToUpstream(upstream, acct, body, keyRow, env, ctx);
}

// Sub2API 风格调度：schedulable=1 & status='active' & 无限速/过载/临时封禁窗口
async function selectAccount(db) {
  const t = now();
  return db
    .prepare(`SELECT * FROM accounts_v2
      WHERE schedulable = 1 AND status = 'active'
        AND (rate_limit_reset_at IS NULL OR rate_limit_reset_at < ?)
        AND (overload_until IS NULL OR overload_until < ?)
        AND (temp_unschedulable_until IS NULL OR temp_unschedulable_until < ?)
      ORDER BY priority ASC, last_used_at ASC LIMIT 1`)
    .bind(t, t, t)
    .first();
}

async function relayToUpstream(upstream, acct, body, keyRow, env, ctx) {
  const model = (safeJson(acct.model_map, {})[body.model]) || body.model;
  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: upstream.body,
    });
  } catch (e) {
    await markAccountError(env, acct.id, "upstream unreachable: " + String(e));
    return json({ error: "upstream unreachable", detail: String(e) }, 502);
  }

  // 限速/过载信号 -> 标记窗口
  if (upstreamResp.status === 429) {
    const reset = now() + 60 * 1000;
    await env.DB.prepare("UPDATE accounts_v2 SET rate_limited_at = ?, rate_limit_reset_at = ? WHERE id = ?")
      .bind(now(), reset, acct.id).run();
  } else if (upstreamResp.status === 529) {
    const reset = now() + 5 * 60 * 1000;
    await env.DB.prepare("UPDATE accounts_v2 SET overload_until = ? WHERE id = ?").bind(reset, acct.id).run();
  }

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
      ).bind(keyRow.id, acct.id, model, pt, ct, now()),
      db.prepare("UPDATE user_keys SET used_tokens = used_tokens + ? WHERE id = ?").bind(pt + ct, keyRow.id),
      db.prepare("UPDATE accounts_v2 SET usage_tokens = usage_tokens + ? WHERE id = ?").bind(pt + ct, acct.id),
    ]);
  } catch (e) {
    console.warn("logUsage failed:", String(e));
  }
}

async function markAccountError(env, id, msg) {
  try {
    await env.DB.prepare("UPDATE accounts_v2 SET status='error', error_message=? WHERE id=?")
      .bind(String(msg).slice(0, 500), id).run();
  } catch {}
}

// ---------- OAuth 定时刷新 ----------

async function refreshDueOAuth(env) {
  const t = now();
  const due = await env.DB
    .prepare(`SELECT * FROM accounts_v2
      WHERE type='oauth' AND status != 'disabled'
        AND json_extract(credentials,'$.refresh_token') IS NOT NULL
        AND json_extract(credentials,'$.expires_at') IS NOT NULL
        AND CAST(json_extract(credentials,'$.expires_at') AS INTEGER) - ? < 300000`)
    .bind(t)
    .all();
  for (const acct of due.results || []) {
    const cred = safeJson(acct.credentials, {});
    try {
      const updated = await refreshOAuth(acct.platform, {
        refresh_token: cred.refresh_token, client_id: cred.client_id || "",
      }, env);
      const merged = { ...cred, ...updated };
      await env.DB
        .prepare("UPDATE accounts_v2 SET credentials=?, status='active', error_message=NULL WHERE id=?")
        .bind(JSON.stringify(merged), acct.id).run();
    } catch (e) {
      await env.DB.prepare("UPDATE accounts_v2 SET status='error', error_message=? WHERE id=?")
        .bind(String(e).slice(0, 500), acct.id).run();
    }
  }
}

// ---------- 管理 API ----------

async function handleAdmin(request, env, url) {
  const token = request.headers.get("x-admin-token") || url.searchParams.get("token");
  if (token !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);

  const db = env.DB;
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];
  const id = parts[2];

  if (resource === "accounts") {
    if (request.method === "GET") {
      const rows = await db
        .prepare("SELECT id,name,platform,type,base_url,model_map,priority,concurrency,status,schedulable,usage_tokens,error_message,last_used_at,created_at FROM accounts_v2 ORDER BY id DESC")
        .all();
      return json(rows.results);
    }
    // 单账号创建（排除 import 子路径）
    if (request.method === "POST" && parts[2] !== "import") {
      const b = await request.json().catch(() => ({}));
      const res = await createAccount(db, normalizeAccountInput(b));
      if (res.error) return json({ error: res.error }, 400);
      return json({ ok: true, id: res.id });
    }
    if (request.method === "DELETE" && id) {
      await db.prepare("DELETE FROM accounts_v2 WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  // 双格式批量导入：支持 [{...}] 数组，或 Sub2API Codex 风格 {content,contents,...}
  if (resource === "accounts" && parts[2] === "import" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const result = await importAccounts(db, b);
    return json(result, result.failed > 0 && result.created === 0 ? 207 : 200);
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
        .bind(key, b.label || "", b.quota_tokens ?? null, 0, 1, now())
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
    const accts = await db.prepare("SELECT COUNT(*) AS n FROM accounts_v2 WHERE status='active'").first();
    return json({ ...tot, active_keys: keys.n, active_accounts: accts.n });
  }

  return json({ error: "unknown admin resource: " + resource }, 404);
}

// ---------- 账号输入规范化 ----------

const PLATFORM_ALIASES = {
  openai: "openai", gpt: "openai",
  anthropic: "anthropic", claude: "anthropic", antigravity: "antigravity",
  gemini: "gemini", google: "gemini",
  grok: "grok", xai: "grok",
};
const TYPE_SET = new Set(["api_key", "oauth", "cookie"]);

function normalizeAccountInput(b) {
  const platform = PLATFORM_ALIASES[(b.platform || "").toLowerCase()];
  const type = (b.type || (b.credentials?.api_key ? "api_key" : "api_key")).toLowerCase();
  if (!platform) return { error: "unknown platform: " + b.platform };
  if (!TYPE_SET.has(type)) return { error: "unknown type: " + type };
  if (type === "cookie") return { error: "cookie/sessionKey 凭证不被支持（规避平台限制风险）" };

  let credentials = b.credentials;
  if (!credentials) {
    if (type === "api_key") credentials = { api_key: b.api_key };
    else if (type === "oauth") credentials = { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: b.expires_at, client_id: b.client_id };
  }
  credentials = credentials || {};
  if (type === "api_key" && !credentials.api_key) return { error: "api_key required" };
  if (type === "oauth" && !credentials.access_token && !credentials.refresh_token) return { error: "oauth requires access_token or refresh_token" };

  // 统一 expires_at 为毫秒：Sub2API 导出用 unix 秒，本系统内部用毫秒
  let expires_at = b.expires_at ?? credentials.expires_at ?? null;
  if (expires_at != null) {
    expires_at = Number(expires_at);
    if (!Number.isNaN(expires_at) && expires_at < 1e12) expires_at = expires_at * 1000; // 秒 -> 毫秒
    // 同步回 credentials，保证刷新逻辑读取一致
    if (credentials.expires_at != null) credentials.expires_at = expires_at;
  }

  // notes 存入 extra，便于回看
  const extra = { ...(b.extra || {}) };
  if (b.notes) extra.notes = b.notes;

  return {
    error: null,
    name: b.name || `${platform}-${type}`,
    platform, type,
    credentials,
    extra,
    base_url: (b.base_url && b.base_url.trim()) || DEFAULT_BASE[platform] || null,
    model_map: b.model_map || {},
    priority: b.priority ?? 50,
    concurrency: b.concurrency ?? 3,
    expires_at,
    auto_pause_on_expired: b.auto_pause_on_expired != null ? (b.auto_pause_on_expired ? 1 : 0) : 1,
    weight: b.weight || 1,
  };
}

async function createAccount(db, norm) {
  if (norm.error) return { error: norm.error };
  await db
    .prepare(`INSERT INTO accounts_v2
      (name,platform,type,credentials,extra,model_map,base_url,priority,concurrency,status,schedulable,expires_at,auto_pause_on_expired,usage_tokens,error_message,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      norm.name, norm.platform, norm.type,
      JSON.stringify(norm.credentials), JSON.stringify(norm.extra),
      JSON.stringify(norm.model_map), norm.base_url, norm.priority, norm.concurrency,
      "active", 1, norm.expires_at, norm.auto_pause_on_expired, 0, null, now()
    )
    .run();
  const row = await db.prepare("SELECT last_insert_rowid() AS id").first();
  return { id: row.id };
}

// ---------- 双格式导入 ----------

async function importAccounts(db, body) {
  let entries = [];

  // 格式D：Sub2API 备份导出 { version, exported_at, accounts:[...] }
  if (body && Array.isArray(body.accounts)) {
    for (let i = 0; i < body.accounts.length; i++) {
      const norm = normalizeAccountInput(body.accounts[i]);
      if (norm.error) entries.push({ index: i, action: "failed", message: norm.error });
      else entries.push({ index: i, action: "import", account: norm });
    }
  }
  // 格式A：Sub2API Codex 风格 { content | contents, name, ... }
  else if (body && (body.content || Array.isArray(body.contents))) {
    const list = [];
    if (body.content) list.push(body.content);
    if (Array.isArray(body.contents)) list.push(...body.contents);
    for (let i = 0; i < list.length; i++) {
      const parsed = parseCodexContent(list[i], body, i);
      if (parsed.error) {
        entries.push({ index: i, action: "failed", message: parsed.error });
      } else {
        entries.push({ index: i, action: "import", account: parsed.account });
      }
    }
  }
  // 格式B：简化数组 [{ name, platform, type, credentials, ... }]
  else if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i++) {
      const norm = normalizeAccountInput(body[i]);
      if (norm.error) entries.push({ index: i, action: "failed", message: norm.error });
      else entries.push({ index: i, action: "import", account: norm });
    }
  }
  // 格式C：单对象（也当数组处理）
  else if (body && body.platform) {
    const norm = normalizeAccountInput(body);
    if (norm.error) entries.push({ index: 0, action: "failed", message: norm.error });
    else entries.push({ index: 0, action: "import", account: norm });
  } else {
    return { total: 0, created: 0, updated: 0, skipped: 0, failed: 0,
      items: [], errors: [{ message: "无法识别的导入格式：需为数组、单对象或 {content,contents,...}" }] };
  }

  const result = { total: entries.length, created: 0, updated: 0, skipped: 0, failed: 0, items: [], warnings: [], errors: [] };
  const seen = new Set();

  for (const e of entries) {
    if (e.action === "failed") {
      result.failed++;
      result.items.push({ index: e.index, action: "failed", message: e.message });
      result.errors.push({ index: e.index, message: e.message });
      continue;
    }
    const acc = e.account;
    // 去重：platform+type+name+api_key/access_token 指纹
    const fp = fingerprint(acc);
    if (seen.has(fp)) { result.skipped++; result.items.push({ index: e.index, action: "skipped", name: acc.name }); continue; }
    seen.add(fp);

    // 已存在同名同平台 -> 更新
    const exist = await db
      .prepare("SELECT id FROM accounts_v2 WHERE platform=? AND type=? AND name=? LIMIT 1")
      .bind(acc.platform, acc.type, acc.name).first();
    if (exist) {
      await db
        .prepare(`UPDATE accounts_v2 SET credentials=?, extra=?, model_map=?, base_url=?, priority=?, concurrency=?, expires_at=?, status='active', error_message=NULL WHERE id=?`)
        .bind(JSON.stringify(acc.credentials), JSON.stringify(acc.extra), JSON.stringify(acc.model_map), acc.base_url, acc.priority, acc.concurrency, acc.expires_at, exist.id)
        .run();
      result.updated++;
      result.items.push({ index: e.index, action: "updated", account_id: exist.id, name: acc.name });
    } else {
      const r = await createAccount(db, acc);
      if (r.error) {
        result.failed++;
        result.items.push({ index: e.index, action: "failed", message: r.error });
        result.errors.push({ index: e.index, message: r.error });
      } else {
        result.created++;
        result.items.push({ index: e.index, action: "created", account_id: r.id, name: acc.name });
      }
    }
  }
  return result;
}

// 解析 Sub2API Codex auths 风格字符串（eyJ... 的 base64url JSON，内含 oauth 凭证）
function parseCodexContent(content, meta, idx) {
  try {
    let s = content.trim();
    // 兼容带Bearer前缀
    s = s.replace(/^Bearer\s+/i, "");
    // 尝试 base64url 解码（可能是 JWT-like 或纯 JSON）
    let jsonStr = s;
    try { jsonStr = decodeB64Url(s.split(".").pop() || s); } catch {}
    let obj;
    try { obj = JSON.parse(jsonStr); } catch { obj = null; }
    if (!obj) {
      // 也许 content 本身就是 JSON
      try { obj = JSON.parse(s); } catch { return { error: "无法解析 content 为凭证 JSON" }; }
    }
    const platform = meta.platform ? PLATFORM_ALIASES[(meta.platform).toLowerCase()] : "openai";
    if (!platform) return { error: "import 需要合法的 platform" };
    const credentials = {};
    if (obj.access_token) credentials.access_token = obj.access_token;
    if (obj.refresh_token) credentials.refresh_token = obj.refresh_token;
    if (obj.expires_at) credentials.expires_at = obj.expires_at;
    if (obj.expires_in && !obj.expires_at) credentials.expires_at = now() + obj.expires_in * 1000;
    if (obj.client_id) credentials.client_id = obj.client_id;
    if (!credentials.access_token && !credentials.refresh_token) {
      return { error: "content 中未找到 access_token / refresh_token" };
    }
    return {
      account: {
        name: (meta.name ? `${meta.name}#${idx + 1}` : `codex-${idx + 1}`),
        platform, type: "oauth", credentials,
        extra: meta.extra || {},
        base_url: DEFAULT_BASE[platform] || null,
        model_map: meta.model_map || {},
        priority: meta.priority ?? 50,
        concurrency: meta.concurrency ?? 3,
        expires_at: meta.expires_at || credentials.expires_at || null,
        auto_pause_on_expired: meta.auto_pause_on_expired ?? 1,
        weight: 1,
      },
    };
  } catch (e) {
    return { error: "parse error: " + String(e) };
  }
}

function decodeB64Url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return atob(s + pad);
}

function fingerprint(acc) {
  const c = acc.credentials || {};
  const key = c.api_key || c.access_token || c.refresh_token || JSON.stringify(c);
  return `${acc.platform}|${acc.type}|${acc.name}|${key}`;
}
