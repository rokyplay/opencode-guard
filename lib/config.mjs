import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_AUDIT_PROMPT_FILE, REVIEW_POLICY_VERSION } from "./policy.mjs";

export const GUARD_CONFIG_DEFAULTS = Object.freeze({
  auditLogFileName: "interceptor-calls.jsonl",
  auditPromptFile: DEFAULT_AUDIT_PROMPT_FILE,
  chatCompletionsPathSuffix: "/chat/completions",
  customReviewBaseUrl: "",
  customReviewFormat: "openai-chat",
  customReviewModel: "",
  logDir: join(homedir(), ".sisyphus", "opencode-guard"),
  moderationPathSuffix: "/moderations",
  openaiModerationEndpoint: "https://api.openai.com/v1/moderations",
  openaiModerationModel: "omni-moderation-latest",
  openAIProviderHost: "api.openai.com",
  responsesPathSuffix: "/responses",
  retryDelayMs: 1_000,
  reviewOrder: Object.freeze(["zen", "openai", "zen-fallbacks"]),
  reviewTimeoutMs: 60_000,
  targetModelPattern: "^(openai\\/)?(gpt-|o[0-9]|codex)",
  zenChatEndpoint: "https://opencode.ai/zen/v1/chat/completions",
  zenFallbackModels: Object.freeze(["mimo-v2.5-free", "big-pickle", "north-mini-code-free", "nemotron-3-ultra-free"]),
  zenModel: "deepseek-v4-flash-free",
  zenRetries: 3,
});

export function getGuardConfig(env = process.env) {
  const logDir = readString(env.OPENCODE_GUARD_LOG_DIR, GUARD_CONFIG_DEFAULTS.logDir);
  const zenModel = readString(env.OPENCODE_GUARD_ZEN_MODEL, GUARD_CONFIG_DEFAULTS.zenModel);
  const customReviewBaseUrl = readString(env.OPENCODE_GUARD_REVIEW_BASE_URL, GUARD_CONFIG_DEFAULTS.customReviewBaseUrl);
  const customReviewEndpoint = readString(env.OPENCODE_GUARD_REVIEW_ENDPOINT, "");
  const reviewOrder = readReviewOrder(env.OPENCODE_GUARD_BACKENDS || env.OPENCODE_GUARD_REVIEW_ORDER, customReviewBaseUrl || customReviewEndpoint ? ["custom", ...GUARD_CONFIG_DEFAULTS.reviewOrder] : GUARD_CONFIG_DEFAULTS.reviewOrder);
  return {
    auditCacheHits: env.OPENCODE_GUARD_AUDIT_CACHE_HITS === "1",
    auditLogFile: join(logDir, GUARD_CONFIG_DEFAULTS.auditLogFileName),
    auditPromptFile: readString(env.OPENCODE_GUARD_AUDIT_PROMPT_FILE, GUARD_CONFIG_DEFAULTS.auditPromptFile),
    cacheEnabled: env.OPENCODE_GUARD_CACHE !== "0",
    chatCompletionsPathSuffix: readString(env.OPENCODE_GUARD_CHAT_COMPLETIONS_PATH_SUFFIX, GUARD_CONFIG_DEFAULTS.chatCompletionsPathSuffix),
    customReviewApiKey: env.OPENCODE_GUARD_REVIEW_API_KEY || "",
    customReviewBaseUrl,
    customReviewEndpoint,
    customReviewFormat: readString(env.OPENCODE_GUARD_REVIEW_FORMAT, GUARD_CONFIG_DEFAULTS.customReviewFormat),
    customReviewModel: readString(env.OPENCODE_GUARD_REVIEW_MODEL, GUARD_CONFIG_DEFAULTS.customReviewModel),
    enabled: env.OPENCODE_GUARD_ENABLED !== "0",
    logDir,
    moderationPathSuffix: readString(env.OPENCODE_GUARD_MODERATION_PATH_SUFFIX, GUARD_CONFIG_DEFAULTS.moderationPathSuffix),
    openaiModerationApiKey: env.OPENAI_MODERATION_API_KEY || "",
    openaiModerationEndpoint: readString(env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT, GUARD_CONFIG_DEFAULTS.openaiModerationEndpoint),
    openaiModerationModel: readString(env.OPENCODE_GUARD_OPENAI_MODERATION_MODEL, GUARD_CONFIG_DEFAULTS.openaiModerationModel),
    openAIProviderHost: readString(env.OPENCODE_GUARD_OPENAI_PROVIDER_HOST, GUARD_CONFIG_DEFAULTS.openAIProviderHost),
    responsesPathSuffix: readString(env.OPENCODE_GUARD_RESPONSES_PATH_SUFFIX, GUARD_CONFIG_DEFAULTS.responsesPathSuffix),
    retryDelayMs: readNonNegativeInteger(env.OPENCODE_GUARD_RETRY_DELAY_MS, GUARD_CONFIG_DEFAULTS.retryDelayMs),
    reviewOrder,
    reviewTimeoutMs: readNonNegativeInteger(env.OPENCODE_GUARD_REVIEW_TIMEOUT_MS, GUARD_CONFIG_DEFAULTS.reviewTimeoutMs),
    reviewPolicyVersion: REVIEW_POLICY_VERSION,
    segmentCacheFile: join(logDir, `${REVIEW_POLICY_VERSION}-segments.sha256`),
    targetModelPattern: readRegex(env.OPENCODE_GUARD_TARGET_MODEL_PATTERN, GUARD_CONFIG_DEFAULTS.targetModelPattern),
    targetModelPatternText: readString(env.OPENCODE_GUARD_TARGET_MODEL_PATTERN, GUARD_CONFIG_DEFAULTS.targetModelPattern),
    transparentAllModels: env.OPENCODE_GUARD_TRANSPARENT_ALL_MODELS === "1",
    zenApiKey: env.OPENCODEZEN_API_KEY || env["OPENCODEZEN-API-KEY"] || "",
    zenChatEndpoint: readString(env.OPENCODE_GUARD_ZEN_CHAT_ENDPOINT, GUARD_CONFIG_DEFAULTS.zenChatEndpoint),
    zenFallbackModels: readFallbackZenModels(env.OPENCODE_GUARD_ZEN_FALLBACK_MODELS, zenModel),
    zenModel,
    zenRetries: readPositiveInteger(env.OPENCODE_GUARD_ZEN_RETRIES, GUARD_CONFIG_DEFAULTS.zenRetries),
  };
}

export function getPublicGuardConfig(config = getGuardConfig()) {
  return {
    audit_cache_hits: config.auditCacheHits,
    audit_log_file: config.auditLogFile,
    audit_prompt_file: config.auditPromptFile,
    cache_enabled: config.cacheEnabled,
    chat_completions_path_suffix: config.chatCompletionsPathSuffix,
    custom_review_api_key_set: config.customReviewApiKey.length > 0,
    custom_review_base_url: summarizeEndpoint(config.customReviewBaseUrl),
    custom_review_endpoint: config.customReviewEndpoint ? summarizeEndpoint(config.customReviewEndpoint) : "derived-from-base-url",
    custom_review_format: config.customReviewFormat,
    custom_review_model: config.customReviewModel,
    enabled: config.enabled,
    log_dir: config.logDir,
    moderation_path_suffix: config.moderationPathSuffix,
    openai_moderation_api_key_set: config.openaiModerationApiKey.length > 0,
    openai_moderation_endpoint: summarizeEndpoint(config.openaiModerationEndpoint),
    openai_moderation_model: config.openaiModerationModel,
    openai_provider_host: config.openAIProviderHost,
    responses_path_suffix: config.responsesPathSuffix,
    retry_delay_ms: config.retryDelayMs,
    review_order: config.reviewOrder.join(","),
    review_timeout_ms: config.reviewTimeoutMs,
    segment_cache_file: config.segmentCacheFile,
    target_model_pattern: config.targetModelPatternText,
    transparent_all_models: config.transparentAllModels,
    zen_api_key_set: config.zenApiKey.length > 0,
    zen_chat_endpoint: summarizeEndpoint(config.zenChatEndpoint),
    zen_fallback_models: config.zenFallbackModels.join(","),
    zen_model: config.zenModel,
    zen_retries: config.zenRetries,
  };
}

function readString(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readCsv(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) return [...fallback];
  const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function readReviewOrder(value, fallback) {
  return readCsv(value, fallback).map((backend) => (backend === "chat" ? "custom" : backend));
}

function readFallbackZenModels(value, zenModel) {
  return unique([...readCsv(value, []), ...GUARD_CONFIG_DEFAULTS.zenFallbackModels]).filter((model) => model !== zenModel);
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRegex(value, fallback) {
  const source = readString(value, fallback);
  try {
    return new RegExp(source, "i");
  } catch (error) {
    if (error instanceof Error) return new RegExp(fallback, "i");
    throw error;
  }
}

export function summarizeEndpoint(value) {
  if (!value) return "disabled";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (error) {
    if (error instanceof Error) return "invalid-url";
    throw error;
  }
}

function unique(items) {
  return [...new Set(items)];
}
