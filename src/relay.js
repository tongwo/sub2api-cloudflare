// relay.js — 上游供应商协议适配层
// 目标：把统一的 OpenAI 格式请求，转成各家上游格式；
//        把各家上游响应（含 SSE 流式）转回 OpenAI 格式。

export const DEFAULT_BASE = {
  openai:   "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini:   "https://generativelanguage.googleapis.com",
};

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
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

// 把账号 + 用户请求，构建成访问上游所需的 {url, headers, body, ...}
// 返回字段：
//   provider      上游类型
//   isStream      是否流式
//   translateResponse(json) -> json   （非流式响应转换，可选）
//   translator     （流式转换对象，见下方 makeOpenAIStream 用的 translator）
export function buildUpstream(acct, body) {
  const map = safeJson(acct.model_map, {});
  const model = map[body.model] || body.model;
  const isStream = !!body.stream;
  const base = (acct.base_url && acct.base_url.trim()) || DEFAULT_BASE[acct.provider];

  if (acct.provider === "openai") {
    return {
      provider: "openai",
      isStream,
      url: `${base}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${acct.api_key}`,
      },
      body: JSON.stringify({ ...body, model, stream: isStream }),
    };
  }

  if (acct.provider === "anthropic") {
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
    return {
      provider: "anthropic",
      isStream,
      url: `${base}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": acct.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      translateResponse: (j) => anthropicToOpenAI(j, model),
      translator: anthropicTranslator,
    };
  }

  if (acct.provider === "gemini") {
    const payload = openAIToGemini(body, model);
    const q = isStream ? "?alt=sse" : "";
    return {
      provider: "gemini",
      isStream,
      url: `${base}/v1beta/models/${model}:streamGenerateContent${q}`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": acct.api_key,
      },
      body: JSON.stringify(payload),
      translateResponse: (j) => geminiToOpenAI(j, model),
      translator: geminiTranslator,
    };
  }

  throw new Error(`unsupported provider: ${acct.provider}`);
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

function anthropicToOpenAI(j, model) {
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

function geminiToOpenAI(j, model) {
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
// 每个 translator 暴露 onData(data, state) 与可选的 flush(state)，
// 返回要下发的 OpenAI chunk 数组（已是对象，由调用方序列化）。
// state 在整次流式过程中共享，用于累积 usage。

export const openaiPassTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return null; }
    if (j && j.usage) state.usage = j.usage;
    return [j]; // 原样透传 OpenAI 的 data 行
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
// onDone(state) 在流结束时异步调用（用于落库用量）。
export function makeOpenAIStream(upstreamBody, translator, state, onDone) {
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";

  function processChunk(controller, text) {
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop();
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
        if (buf.trim()) processChunk(controller, buf);
        const tail = translator.flush ? (translator.flush(state) || []) : [];
        for (const c of tail) controller.enqueue(encoder.encode("data: " + JSON.stringify(c) + "\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (onDone) await onDone(state);
        controller.close();
        return;
      }
      processChunk(controller, decoder.decode(value, { stream: true }));
    },
  });
}
