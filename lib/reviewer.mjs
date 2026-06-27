import { writeGatewayAudit } from "./audit.mjs";
import { buildSegmentCacheKey, hasAllowedSegment, writeAllowedSegments } from "./cache.mjs";
import { getGuardConfig, summarizeEndpoint } from "./config.mjs";
import { describeError, requestJson } from "./http-util.mjs";
import { assertNoForbiddenTokenLimitFields } from "./json-util.mjs";
import { loadAuditPrompt } from "./prompt-loader.mjs";

export async function reviewOutboundSegments(segments, config = getGuardConfig(), context = {}) {
  const startedAt = Date.now();
  if (!config.enabled) return { flagged: false, reason: "", reviewedSegments: 0 };
  let reviewText = "";
  let selected = [];
  let uncached = [];
  let auditPromptMetadata = null;
  try {
    const auditPrompt = await loadAuditPrompt(config);
    auditPromptMetadata = auditPrompt.metadata;
    uncached = [];
    for (const segment of segments) {
      const cacheKey = buildSegmentCacheKey(segment.text, auditPrompt.metadata.sha256, config);
      if (!(await hasAllowedSegment(cacheKey, config))) uncached.push({ ...segment, cacheKey });
    }
    if (uncached.length === 0) {
      await writeGatewayAudit(buildAuditEntry(startedAt, "", { provider: "segment-cache", model: "sha256-allow", flagged: false, blocked: false, cache_hit: true, cache_key: null, reviewed_segments: 0, total_segments: segments.length, baseline_segments: 0, uncached_segments: 0, cached_segments: segments.length, cache_write_segments: 0, token_usage: buildUnavailableTokenUsage("review skipped because all segments were cached") }, auditPromptMetadata, context), config);
      return { flagged: false, reason: "", reviewedSegments: 0 };
    }
    selected = selectSegmentsForReview(uncached);
    reviewText = selected.map(formatSegmentForReview).join("\n\n---\n\n");
    const decision = await runReviewBackends(reviewText, auditPrompt.text, config);
    const cacheWriteSegments = decision.flagged ? 0 : uncached.length;
    if (!decision.flagged) await writeAllowedSegments(uncached.map((segment) => segment.cacheKey), config);
    await writeGatewayAudit(buildAuditEntry(startedAt, reviewText, { ...decision, blocked: decision.flagged, cache_hit: false, cache_key: null, reviewed_segments: selected.length, total_segments: segments.length, baseline_segments: uncached.length - selected.length, uncached_segments: uncached.length, cached_segments: segments.length - uncached.length, cache_write_segments: cacheWriteSegments }, auditPromptMetadata, context), config);
    return { flagged: decision.flagged, reason: decision.flagged ? "The request was flagged by the moderation guard." : "", reviewedSegments: selected.length };
  } catch (error) {
    await writeGatewayAudit(buildAuditEntry(startedAt, reviewText, { provider: "none", model: "none", flagged: true, blocked: true, reason: "moderation-failed", error: describeError(error), cache_hit: false, cache_key: null, reviewed_segments: selected.length, total_segments: segments.length, baseline_segments: uncached.length - selected.length, uncached_segments: uncached.length, cached_segments: Math.max(segments.length - uncached.length, 0), cache_write_segments: 0, token_usage: buildUnavailableTokenUsage("moderation backend failed before exact usage was returned") }, auditPromptMetadata, context), config);
    return { flagged: true, reason: "Moderation check failed.", reviewedSegments: selected.length };
  }
}

export async function reviewOutboundRequest(reviewText, config = getGuardConfig()) {
  return await reviewOutboundSegments([{ label: "request", text: reviewText }], config);
}

async function runReviewBackends(reviewText, auditPromptText, config) {
  const errors = [];
  for (const backend of config.reviewOrder) {
    if (backend === "custom") {
      if (!config.customReviewApiKey) {
        errors.push(`custom-review/${config.customReviewFormat}: OPENCODE_GUARD_REVIEW_API_KEY is not set`);
        continue;
      }
      if (!config.customReviewModel) {
        errors.push(`custom-review/${config.customReviewFormat}: OPENCODE_GUARD_REVIEW_MODEL is not set`);
        continue;
      }
      try {
        return await reviewWithCustom(config.customReviewApiKey, reviewText, auditPromptText, errors, config);
      } catch (error) {
        errors.push(`custom-review/${config.customReviewFormat}/${config.customReviewModel}: ${describeError(error)}`);
      }
      continue;
    }
    if (backend === "zen") {
      if (!config.zenApiKey) {
        errors.push(`opencode-zen/${config.zenModel}: OPENCODEZEN_API_KEY is not set`);
        continue;
      }
      try {
        return await reviewWithZenRetries(config.zenApiKey, reviewText, auditPromptText, config.zenModel, errors, config);
      } catch (error) {
        errors.push(`opencode-zen/${config.zenModel}: ${describeError(error)}`);
      }
      continue;
    }
    if (backend === "openai") {
      if (!config.openaiModerationApiKey) {
        errors.push(`openai-moderation/${config.openaiModerationModel}: OPENAI_MODERATION_API_KEY is not set`);
        continue;
      }
      try {
        return await reviewWithOpenAI(config.openaiModerationApiKey, reviewText, errors, config);
      } catch (error) {
        errors.push(`openai-moderation/${config.openaiModerationModel}: ${describeError(error)}`);
      }
      continue;
    }
    if (backend === "zen-fallbacks" && config.zenApiKey) {
      for (const model of config.zenFallbackModels) {
        try {
        return await reviewWithZenRetries(config.zenApiKey, reviewText, auditPromptText, model, errors, config);
        } catch (error) {
          errors.push(`opencode-zen/${model}: ${describeError(error)}`);
        }
      }
    }
  }
  if (errors.length === 0) throw new Error("no moderation backend API key is set");
  throw new Error(`all moderation backends failed: ${errors.join("; ")}`);
}

async function reviewWithZenRetries(apiKey, reviewText, auditPromptText, model, previousAttempts, config) {
  let lastError;
  for (let attempt = 1; attempt <= config.zenRetries; attempt += 1) {
    try {
      return await reviewWithZen(apiKey, reviewText, auditPromptText, model, previousAttempts, config);
    } catch (error) {
      lastError = error;
      previousAttempts.push(`opencode-zen/${model}#${attempt}: ${describeError(error)}`);
      if (attempt < config.zenRetries) await sleep(config.retryDelayMs);
    }
  }
  throw lastError ?? new Error("Zen review failed");
}

async function reviewWithZen(apiKey, reviewText, auditPromptText, model, previousAttempts, config) {
  const body = { model, messages: [{ role: "system", content: auditPromptText }, { role: "user", content: wrapOutboundRequest(reviewText) }], temperature: 0, response_format: { type: "json_object" } };
  assertNoForbiddenTokenLimitFields(body);
  const endpoint = config.zenChatEndpoint;
  const response = await requestJson({ url: endpoint, apiKey, body, timeoutMs: config.reviewTimeoutMs });
  const decision = parseDecision(response.payload.choices?.[0]?.message?.content);
  if (!decision) throw new Error("Zen review returned invalid JSON");
  return { ...decision, provider: "opencode-zen", model, endpoint, http_status: response.statusCode, attempts: [...previousAttempts, `opencode-zen/${model}: ok`], moderation_request_body_utf8_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"), token_usage: buildProviderTokenUsage(response.payload.usage) };
}

async function reviewWithOpenAI(apiKey, reviewText, previousAttempts, config) {
  const model = config.openaiModerationModel;
  const endpoint = config.openaiModerationEndpoint;
  const body = { model, input: reviewText };
  assertNoForbiddenTokenLimitFields(body);
  const response = await requestJson({ url: endpoint, apiKey, body, timeoutMs: config.reviewTimeoutMs });
  const result = Array.isArray(response.payload.results) ? response.payload.results[0] : undefined;
  if (!result || typeof result.flagged !== "boolean") throw new Error("OpenAI moderation returned invalid JSON");
  const categories = Object.entries(result.categories ?? {}).filter(([, flagged]) => flagged === true).map(([category]) => category);
  return { flagged: result.flagged, reason: result.flagged ? categories.join(", ") || "OpenAI moderation flagged" : "", provider: "openai-moderation", model, endpoint, http_status: response.statusCode, attempts: [...previousAttempts, `openai-moderation/${model}: ok`], moderation_request_body_utf8_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"), token_usage: buildProviderTokenUsage(response.payload.usage) };
}

async function reviewWithCustom(apiKey, reviewText, auditPromptText, previousAttempts, config) {
  const format = config.customReviewFormat;
  const model = config.customReviewModel;
  const endpoint = buildCustomReviewEndpoint(config);
  const body = buildCustomReviewBody(format, model, reviewText, auditPromptText);
  assertNoForbiddenTokenLimitFields(body);
  const response = await requestJson({ url: endpoint, apiKey, body, timeoutMs: config.reviewTimeoutMs });
  const decision = parseCustomDecision(format, response.payload);
  if (!decision) throw new Error(`custom review returned invalid ${format} decision`);
  return { ...decision, provider: `custom-${format}`, model, endpoint, http_status: response.statusCode, attempts: [...previousAttempts, `custom-review/${format}/${model}: ok`], moderation_request_body_utf8_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"), token_usage: buildProviderTokenUsage(response.payload.usage) };
}

function buildCustomReviewEndpoint(config) {
  if (config.customReviewEndpoint) return config.customReviewEndpoint;
  if (!config.customReviewBaseUrl) throw new Error("OPENCODE_GUARD_REVIEW_BASE_URL is not set");
  const path = customFormatPath(config.customReviewFormat);
  return `${config.customReviewBaseUrl.replace(/\/+$/, "")}${path}`;
}

function customFormatPath(format) {
  if (format === "openai-chat") return "/chat/completions";
  if (format === "openai-responses") return "/responses";
  if (format === "anthropic-messages") return "/messages";
  if (format === "openai-moderation") return "/moderations";
  throw new Error(`unsupported custom review format: ${format}`);
}

function buildCustomReviewBody(format, model, reviewText, auditPromptText) {
  if (format === "openai-chat") return { model, messages: [{ role: "system", content: auditPromptText }, { role: "user", content: wrapOutboundRequest(reviewText) }], temperature: 0 };
  if (format === "openai-responses") return { model, instructions: auditPromptText, input: wrapOutboundRequest(reviewText) };
  if (format === "anthropic-messages") return { model, system: auditPromptText, messages: [{ role: "user", content: wrapOutboundRequest(reviewText) }] };
  if (format === "openai-moderation") return { model, input: reviewText };
  throw new Error(`unsupported custom review format: ${format}`);
}

function parseCustomDecision(format, payload) {
  if (format === "openai-chat") return parseDecision(payload.choices?.[0]?.message?.content);
  if (format === "openai-responses") return parseDecision(extractResponsesText(payload));
  if (format === "anthropic-messages") return parseDecision(extractMessagesText(payload));
  if (format === "openai-moderation") return parseModerationDecision(payload);
  return undefined;
}

function parseModerationDecision(payload) {
  const result = Array.isArray(payload.results) ? payload.results[0] : undefined;
  if (!result || typeof result.flagged !== "boolean") return undefined;
  const categories = Object.entries(result.categories ?? {}).filter(([, flagged]) => flagged === true).map(([category]) => category);
  return { flagged: result.flagged, reason: result.flagged ? categories.join(", ") || "moderation flagged" : "" };
}

function extractResponsesText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return undefined;
  return payload.output.flatMap((item) => Array.isArray(item.content) ? item.content : []).map((content) => typeof content.text === "string" ? content.text : "").join("\n");
}

function extractMessagesText(payload) {
  if (!Array.isArray(payload.content)) return undefined;
  return payload.content.map((content) => typeof content.text === "string" ? content.text : "").join("\n");
}

function buildAuditEntry(startedAt, reviewText, result, auditPromptMetadata, context) {
  const completedAt = Date.now();
  return { timestamp: new Date(completedAt).toISOString(), started_at: new Date(startedAt).toISOString(), completed_at: new Date(completedAt).toISOString(), boundary: "transparent-fetch-interceptor", target_endpoint_kind: readString(context.target_endpoint_kind), target_host: readString(context.target_host), target_path: readString(context.target_path), target_model: readString(context.target_model), target_stream: context.target_stream === true, target_body_chars: readNullableNumber(context.target_body_chars), target_body_utf8_bytes: readNullableNumber(context.target_body_utf8_bytes), reviewed_body_chars: reviewText.length, reviewed_body_utf8_bytes: Buffer.byteLength(reviewText, "utf8"), audit_prompt_file: auditPromptMetadata?.file ?? null, audit_prompt_chars: readNullableNumber(auditPromptMetadata?.chars), audit_prompt_lines: readNullableNumber(auditPromptMetadata?.lines), audit_prompt_sha256_prefix: auditPromptMetadata?.sha256_prefix ?? null, moderation_request_body_utf8_bytes: readNullableNumber(result.moderation_request_body_utf8_bytes), reviewed_segments: result.reviewed_segments ?? null, total_segments: result.total_segments ?? null, baseline_segments: result.baseline_segments ?? null, uncached_segments: result.uncached_segments ?? null, cached_segments: result.cached_segments ?? null, cache_write_segments: result.cache_write_segments ?? null, duration_ms: completedAt - startedAt, provider: result.provider, model: result.model, endpoint: result.endpoint ? summarizeEndpoint(result.endpoint) : null, http_status: result.http_status ?? null, flagged: result.flagged, blocked: result.blocked, reason: sanitizeReason(result.reason, result.flagged), error: sanitizeError(result.error), attempts_count: Array.isArray(result.attempts) ? result.attempts.length : 0, cache_hit: result.cache_hit, cache_key: result.cache_key, token_usage: result.token_usage ?? buildUnavailableTokenUsage("provider response did not include usage") };
}

function buildProviderTokenUsage(usage) {
  const providerUsage = sanitizeUsageNumbers(usage);
  if (!providerUsage) return buildUnavailableTokenUsage("provider response did not include usage");
  return { source: "provider_response.usage", exact: true, input_tokens: readUsageNumber(providerUsage, "input_tokens"), output_tokens: readUsageNumber(providerUsage, "output_tokens"), prompt_tokens: readUsageNumber(providerUsage, "prompt_tokens"), completion_tokens: readUsageNumber(providerUsage, "completion_tokens"), total_tokens: readUsageNumber(providerUsage, "total_tokens"), cached_tokens: findUsageNumber(providerUsage, "cached_tokens"), reasoning_tokens: findUsageNumber(providerUsage, "reasoning_tokens"), provider_usage: providerUsage };
}

function buildUnavailableTokenUsage(reason) {
  return { source: "unavailable", exact: false, unavailable_reason: reason, input_tokens: null, output_tokens: null, prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: null, reasoning_tokens: null, provider_usage: null };
}

function sanitizeUsageNumbers(value) {
  if (Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const children = value.map(sanitizeUsageNumbers).filter((child) => child !== undefined);
    return children.length > 0 ? children : undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const sanitized = sanitizeUsageNumbers(child);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function readUsageNumber(usage, key) {
  return Number.isFinite(usage?.[key]) ? usage[key] : null;
}

function findUsageNumber(value, key) {
  if (Number.isFinite(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsageNumber(item, key);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (Number.isFinite(value[key])) return value[key];
  for (const child of Object.values(value)) {
    const found = findUsageNumber(child, key);
    if (found !== null) return found;
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function readString(value) {
  return typeof value === "string" ? value : null;
}

function readNullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeReason(reason, flagged) {
  if (reason === "moderation-failed") return reason;
  return flagged === true ? "flagged" : "not-flagged";
}

function sanitizeError(error) {
  if (typeof error !== "string" || error.length === 0) return null;
  const httpStatus = error.match(/HTTP\s+(\d+)/i);
  if (httpStatus) return `HTTP ${httpStatus[1]}`;
  if (/timed out/i.test(error)) return "request timed out";
  if (/invalid JSON/i.test(error)) return "invalid JSON response";
  if (/API_KEY is not set/i.test(error)) return "API key is not set";
  if (/all moderation backends failed/i.test(error)) return "all moderation backends failed";
  return "moderation backend error";
}

function selectSegmentsForReview(uncached) {
  const actionable = uncached.filter((segment) => segment.actionable === true);
  if (actionable.length > 0) return [actionable.at(-1)];
  return [uncached.at(-1)];
}

function formatSegmentForReview(segment) {
  return `<segment label="${segment.label.replaceAll('"', "'")}">\n${segment.text}\n</segment>`;
}

function parseDecision(content) {
  if (typeof content !== "string") return undefined;
  const match = content.match(/\{[\s\S]*\}/);
  const payload = JSON.parse(match ? match[0] : content);
  return typeof payload.flagged === "boolean" ? { flagged: payload.flagged, reason: typeof payload.reason === "string" ? payload.reason : "" } : undefined;
}

function wrapOutboundRequest(reviewText) {
  return `请审核以下完整出站请求体。\n<outbound_request>\n${reviewText}\n</outbound_request>\n只输出 JSON。`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
