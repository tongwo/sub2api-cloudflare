// relay.js — 上游供应商协议适配层（Sub2API-CF v2）
// 支持 platform: openai | anthropic | gemini | grok | antigravity
// 支持 type:     api_key | oauth
//   - api_key:   credentials = { api_key }
//   - oauth:     credentials = { access_token, refresh_token?, expires_at?, client_id? }
// cookie 类型由导入层拒绝，这里不实现。
//
// 目标：把统一的 OpenAI 格式请求，转成各家上游格式；把各家上游响应（含 SSE）转回 OpenAI 格式。

export const DEFAULT_BASE = {
  openai:     "https://api.openai.com/v1",
  anthropic:  "https://api.anthropic.com",
  gemini:     "https://generativelanguage.googleapis.com",
  grok:       "https://api.x.ai/v1",
  antigravity:"https://api.anthropic.com", // antigravity 复用 Anthropic 协议（Claude 侧）
};

// OAuth 刷新端点（已核实）
export const OAUTH_TOKEN_URL = {
  openai:   "https://auth.openai.com/oauth/token",
  gemini:   "https://oauth2.googleapis.com/token",
  grok:     "https://auth.x.ai/oauth2/token",
  // anthropic/antigravity OAuth 走 sessionKey（cookie），本实现不支持
};

const SUPPORTED_PLATFORMS = Object.keys(DEFAULT_BASE);

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
function safeCred(acct) {
  return safeJson(acct.credentials, {});
}

// 取当前可用的访问令牌：
// - api_key 类型：返回 { kind:"apikey", token }
// - oauth 类型：返回 { kind:"oauth", token, refresh_token, expires_at, client_id }
function credentialFor(acct) {
  const c = safeJson(acct.credentials, {});
  // 兼容旧顶层 api_key 字段
  if (!c.api_key && acct.api_key) c.api_key = acct.api_key;
  if (acct.type === "oauth") {
    return {
      kind: "oauth",
      token: c.access_token || "",
      refresh_token: c.refresh_token || "",
      expires_at: c.expires_at || 0,
      client_id: c.client_id || "",
    };
  }
  // 默认按 api_key
  return { kind: "apikey", token: c.api_key || "" };
}

// 把 system 消息从 messages 中拆出来（Anthropic / Gemini 需要单独字段）
function splitSystem(messages = []) {
  let system = "";
  const rest = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n" : "") + (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else {
      rest.push(m);
    }
  }
  return { system, rest };
}

function mapFinish(reason) {
  const m = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls" };
  return m[reason] || "stop";
}

// 主入口：构建访问上游所需的 {url, headers, body, isStream, translator, provider}
// 返回的对象带 `credential` 信息，供 index.js 决定是否刷新。
export function buildUpstream(acct, body) {
  const map = safeJson(acct.model_map, {});
  const model = map[body.model] || body.model;
  const isStream = !!body.stream;
  // 兼容旧字段 provider 与新字段 platform
  const platform = acct.platform || acct.provider;
  const base = (acct.base_url && acct.base_url.trim()) || DEFAULT_BASE[platform];
  const cred = credentialFor({ ...acct, platform });

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }

  // ---------- OpenAI 兼容（openai / grok / antigravity 走 OpenAI 协议） ----------
  if (platform === "openai" || platform === "grok") {
    const out = { ...body, model, stream: isStream };
    if (isStream) {
      out.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }
    const headers = { "content-type": "application/json", authorization: `Bearer ${cred.token}` };
    if (platform === "grok" && cred.kind === "oauth") {
      // Grok OAuth 需要区分头，保持 Bearer 即可
    }
    return {
      provider: platform,
      isStream,
      credential: cred,
      url: `${base}/chat/completions`,
      headers,
      body: JSON.stringify(out),
      translateResponse: (j) => j,
      translator: openaiPassTranslator,
    };
  }

  // ---------- Anthropic / Antigravity（Claude 协议） ----------
  if (platform === "anthropic" || platform === "antigravity") {
    const { system, rest } = splitSystem(body.messages || []);
    const payload = {
      model,
      max_tokens: body.max_tokens ?? 1024,
      stream: isStream,
      messages: rest,
      ...(system ? { system } : {}),
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
      ...(body.top_p != null ? { top_p: body.top_p } : {}),
      ...(body.stop ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    };
    const headers = {
      "content-type": "application/json",
      "x-api-key": cred.token,
      "anthropic-version": "2023-06-01",
    };
    return {
      provider: platform,
      isStream,
      credential: cred,
      url: `${base}/v1/messages`,
      headers,
      body: JSON.stringify(payload),
      translateResponse: (j) => anthropicToOpenAI(j, model),
      translator: anthropicTranslator,
    };
  }

  // ---------- Gemini ----------
  if (platform === "gemini") {
    const payload = openAIToGemini(body, model);
    const q = isStream ? "?alt=sse" : "";
    const headers = { "content-type": "application/json" };
    if (cred.kind === "oauth") headers.authorization = `Bearer ${cred.token}`;
    else headers["x-goog-api-key"] = cred.token;
    return {
      provider: "gemini",
      isStream,
      credential: cred,
      url: `${base}/v1beta/models/${model}:streamGenerateContent${q}`,
      headers,
      body: JSON.stringify(payload),
      translateResponse: (j) => geminiToOpenAI(j, model),
      translator: geminiTranslator,
    };
  }

  throw new Error(`unsupported platform: ${platform}`);
}

// 判断 oauth credential 是否需在发送前刷新（提前 5 分钟窗口）
export function needsOAuthRefresh(cred) {
  if (cred.kind !== "oauth") return false;
  if (!cred.refresh_token) return false;
  if (!cred.expires_at) return false;
  const now = Date.now();
  const window = 5 * 60 * 1000;
  return cred.expires_at - now < window;
}

// 同步刷新 OAuth token（返回新的 credentials 子集）
export async function refreshOAuth(platform, cred, env) {
  const url = OAUTH_TOKEN_URL[platform];
  if (!url) throw new Error(`no oauth endpoint for platform: ${platform}`);
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", cred.refresh_token);
  if (cred.client_id) params.set("client_id", cred.client_id);
  // Gemini 需要 client_secret；从 secret 读取（可选）
  if (platform === "gemini" && env && env.GEMINI_OAUTH_CLIENT_SECRET) {
    params.set("client_secret", env.GEMINI_OAUTH_CLIENT_SECRET);
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`oauth refresh failed (${resp.status}): ${txt.slice(0, 200)}`);
  }
  const j = await resp.json();
  const expires_at = j.expires_in ? Date.now() + j.expires_in * 1000 : cred.expires_at;
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || cred.refresh_token,
    expires_at,
  };
}

// ---------- OpenAI 格式 -> 各家 ----------

function openAIToGemini(body) {
  const { system, rest } = splitSystem(body.messages || []);
  const contents = rest.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));
  const generationConfig = {};
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.max_tokens != null) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.top_p != null) generationConfig.topP = body.top_p;
  const payload = { contents };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
  return payload;
}

// ---------- 各家 -> OpenAI 格式（非流式） ----------

export function anthropicToOpenAI(j, model) {
  const content = (j.content || []).map((c) => c.text || "").join("");
  const usage = j.usage || {};
  return {
    id: "chatcmpl-" + (j.id || Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: mapFinish(j.stop_reason),
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

export function geminiToOpenAI(j, model) {
  const parts = j.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  const u = j.usageMetadata || {};
  return {
    id: "chatcmpl-g" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: u.promptTokenCount || 0,
      completion_tokens: u.candidatesTokenCount || 0,
      total_tokens: (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0),
    },
  };
}

// ---------- 流式转换器（SSE -> OpenAI SSE） ----------

export const openaiPassTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return null; }
    if (j && j.usage) state.usage = j.usage;
    return [j];
  },
  flush() { return []; },
};

const anthropicTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return []; }
    const type = state.event || j.type;
    const out = [];
    if (type === "message_start") {
      state.inputTokens = j.message?.usage?.input_tokens || 0;
      state.usage = { prompt_tokens: state.inputTokens, completion_tokens: 0 };
      out.push({
        id: "chatcmpl-" + (j.message?.id || Date.now()),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    } else if (type === "content_block_delta") {
      const text = j.delta?.text;
      if (text) out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    } else if (type === "message_delta") {
      state.stopReason = j.delta?.stop_reason;
      if (j.usage?.output_tokens != null) {
        state.outputTokens = j.usage.output_tokens;
        state.usage = { prompt_tokens: state.inputTokens || 0, completion_tokens: state.outputTokens };
      }
    } else if (type === "message_stop") {
      out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: mapFinish(state.stopReason) }] });
    }
    return out;
  },
  flush() { return []; },
};

const geminiTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return []; }
    const parts = j.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("");
    const out = [];
    if (!state.started) {
      state.started = true;
      out.push({
        id: "chatcmpl-g" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    }
    if (text) out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    if (j.usageMetadata) {
      state.usage = {
        prompt_tokens: j.usageMetadata.promptTokenCount || 0,
        completion_tokens: j.usageMetadata.candidatesTokenCount || 0,
        total_tokens: (j.usageMetadata.promptTokenCount || 0) + (j.usageMetadata.candidatesTokenCount || 0),
      };
    }
    return out;
  },
  flush(state) {
    const u = state.usage || {};
    return [{
      id: "x",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: u.prompt_tokens || 0,
        completion_tokens: u.completion_tokens || 0,
        total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      },
    }];
  },
};

// 把上游的 SSE 流，按 translator 转成 OpenAI SSE 流。
export function makeOpenAIStream(upstreamBody, translator, state, onDone) {
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";

  function consume(controller, isFinal) {
    if (!buf) return;
    const lines = buf.split("\n");
    if (!isFinal) buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("event:")) { state.event = line.slice(6).trim(); continue; }
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const chunks = translator.onData(data, state) || [];
        for (const c of chunks) {
          if (c == null) continue;
          controller.enqueue(encoder.encode("data: " + JSON.stringify(c) + "\n\n"));
        }
      }
    }
  }

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        consume(controller, true);
        const tail = translator.flush ? (translator.flush(state) || []) : [];
        for (const c of tail) controller.enqueue(encoder.encode("data: " + JSON.stringify(c) + "\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (onDone) await onDone(state);
        controller.close();
        return;
      }
      buf += decoder.decode(value, { stream: true });
      consume(controller, false);
    },
  });
}
