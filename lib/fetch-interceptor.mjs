import { stableStringify } from "./json-util.mjs";
import { reviewOutboundSegments } from "./reviewer.mjs";
import { getGuardConfig } from "./config.mjs";

const INSTALL_KEY = Symbol.for("opencode.moderation.fetchInterceptor");

export function installOpenCodeModerationFetchInterceptor(options = {}) {
  const target = options.target ?? globalThis;
  if (target[INSTALL_KEY]) return target[INSTALL_KEY].uninstall;
  const originalFetch = target.fetch.bind(target);
  const state = {
    uninstall: () => {
      target.fetch = originalFetch;
      delete target[INSTALL_KEY];
    },
  };
  target[INSTALL_KEY] = state;
  target.fetch = async (input, init) => {
    let request;
    try {
      request = new Request(input, init);
    } catch (error) {
      if (error instanceof Error) return await originalFetch(input, init);
      throw error;
    }
    const config = getGuardConfig();
    if (!config.enabled) return await originalFetch(request);
    const decision = await classifyRequest(request.clone(), config);
    if (!decision.review) return await originalFetch(request);
    const review = await reviewOutboundSegments(buildReviewSegments(decision.body), config, decision.context);
    if (!review.flagged) return await originalFetch(rebuildRequest(request, decision.bodyText));
    return buildBlockedResponse(decision.body, review.reason, decision.endpointKind);
  };
  return state.uninstall;
}

async function classifyRequest(request, config) {
  if (request.method !== "POST") return { review: false };
  const url = new URL(request.url);
  if (isModerationUrl(url, config)) return { review: false };
  const endpointKind = getEndpointKind(url, config);
  if (endpointKind === "other") return { review: false };
  const parsed = await parseJsonBody(request);
  if (!parsed || !isTargetOpenAIRequest(url, parsed.body, config)) return { review: false };
  return { review: true, body: parsed.body, bodyText: parsed.bodyText, endpointKind, context: buildReviewContext(url, parsed.body, endpointKind) };
}

async function parseJsonBody(request) {
  try {
    const text = await request.clone().text();
    if (!text.trim()) return undefined;
    return { body: JSON.parse(text), bodyText: text };
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

function rebuildRequest(request, bodyText) {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    signal: request.signal,
    credentials: request.credentials,
    mode: request.mode,
    cache: request.cache,
  });
}

function getEndpointKind(url, config) {
  if (url.pathname.endsWith(config.chatCompletionsPathSuffix)) return "chat-completions";
  if (url.pathname.endsWith(config.responsesPathSuffix)) return "responses";
  return "other";
}

function isModerationUrl(url, config) {
  return url.pathname.endsWith(config.moderationPathSuffix) || matchesConfiguredEndpoint(url, config.zenChatEndpoint) || matchesConfiguredEndpoint(url, config.openaiModerationEndpoint);
}

function matchesConfiguredEndpoint(url, endpoint) {
  try {
    const configured = new URL(endpoint);
    return url.origin === configured.origin && url.pathname === configured.pathname;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function isTargetOpenAIRequest(url, body, config) {
  if (config.transparentAllModels) return true;
  if (url.hostname === config.openAIProviderHost) return true;
  const model = typeof body.model === "string" ? body.model : "";
  return config.targetModelPattern.test(model);
}

function buildReviewContext(url, body, endpointKind) {
  const bodyText = JSON.stringify(body);
  return {
    target_body_chars: bodyText.length,
    target_body_utf8_bytes: Buffer.byteLength(bodyText, "utf8"),
    target_endpoint_kind: endpointKind,
    target_host: url.host,
    target_model: typeof body.model === "string" ? body.model : null,
    target_path: url.pathname,
    target_stream: body.stream === true,
  };
}

function buildBlockedResponse(body, reason, endpointKind) {
  const model = typeof body.model === "string" ? body.model : "unknown";
  const message = `[OpenCode moderation guard]\nThe outbound OpenAI provider request was blocked before it was sent upstream.\nReason: ${reason || "The request was flagged by the moderation guard."}`;
  if (endpointKind === "responses") {
    if (body.stream === true) return buildBlockedResponsesApiStream(model, message);
    return buildBlockedResponsesApi(model, message);
  }
  if (body.stream === true) return buildBlockedStream(model, message);
  return buildBlockedChatCompletion(model, message);
}

function buildReviewSegments(body) {
  const segments = [];
  if (Array.isArray(body.messages)) {
    body.messages.forEach((message, index) => {
      const role = typeof message.role === "string" ? message.role : "unknown";
      segments.push({ label: `message:${index}:${role}`, text: stableStringify(message), actionable: role === "user" });
    });
  }
  if (typeof body.instructions === "string") segments.push({ label: "instructions", text: body.instructions, actionable: false });
  if (typeof body.input === "string") segments.push({ label: "input", text: body.input, actionable: true });
  if (Array.isArray(body.input)) {
    body.input.forEach((item, index) => {
      segments.push({ label: `input:${index}`, text: stableStringify(item), actionable: true });
    });
  }
  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, index) => {
      segments.push({ label: `tool:${index}`, text: stableStringify(tool), actionable: false });
    });
  }
  if (Array.isArray(body.functions)) {
    body.functions.forEach((tool, index) => {
      segments.push({ label: `function:${index}`, text: stableStringify(tool), actionable: false });
    });
  }
  if (segments.length > 0) return segments;
  return [{ label: "request", text: stableStringify(body), actionable: true }];
}

function buildBlockedChatCompletion(model, message) {
  return jsonResponse({ id: `chatcmpl-guard-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: message }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
}

function buildBlockedResponsesApi(model, message) {
  return jsonResponse({ id: `resp_guard_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output: [{ id: `msg_guard_${Date.now()}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message, annotations: [] }] }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
}

function buildBlockedResponsesApiStream(model, message) {
  const now = Math.floor(Date.now() / 1000);
  const responseId = `resp_guard_${Date.now()}`;
  const itemId = `msg_guard_${Date.now()}`;
  const messageItem = { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message, annotations: [] }] };
  const completedResponse = {
    id: responseId,
    object: "response",
    created_at: now,
    status: "completed",
    model,
    output: [messageItem],
    incomplete_details: null,
    service_tier: null,
    usage: { input_tokens: 0, input_tokens_details: { cached_tokens: null }, output_tokens: 0, output_tokens_details: { reasoning_tokens: null }, total_tokens: 0 },
  };
  return eventStreamResponse([
    { type: "response.created", sequence_number: 0, response: { ...completedResponse, status: "in_progress", output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } },
    { type: "response.output_text.delta", sequence_number: 2, item_id: itemId, output_index: 0, content_index: 0, delta: message, logprobs: null },
    { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: messageItem },
    { type: "response.completed", sequence_number: 4, response: completedResponse },
  ]);
}

function buildBlockedStream(model, message) {
  const body = `data: ${JSON.stringify({ id: `chatcmpl-guard-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: message }, finish_reason: null }] })}

data: ${JSON.stringify({ id: `chatcmpl-guard-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}

data: [DONE]

`;
  return eventStreamRawResponse(body);
}

function eventStreamResponse(events) {
  return eventStreamRawResponse(events.map((event) => `data: ${JSON.stringify(event)}

`).join("") + "data: [DONE]\n\n");
}

function eventStreamRawResponse(body) {
  const encoder = new TextEncoder();
  return new Response(encoder.encode(body), { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}
