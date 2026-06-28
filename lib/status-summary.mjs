import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

import { getGuardConfig, getPublicGuardConfig } from "./config.mjs";
import { summarizeAuditPrompt } from "./prompt-loader.mjs";

export async function buildStatusSummary(config = getGuardConfig()) {
  const [prompt, audit, cache] = await Promise.all([summarizeAuditPrompt(config), summarizeAuditLog(config.auditLogFile), summarizeHashFile(config.segmentCacheFile)]);
  return {
    config: getPublicGuardConfig(config),
    prompt,
    audit,
    cache,
  };
}

async function summarizeAuditLog(filePath, timezone) {
  const file = await describeFile(filePath);
  if (!file.exists) return { file: filePath, exists: false, entries: 0, invalid_lines: 0, latest: null, totals: withDisplayTimestamps(emptyAuditTotals(), timezone) };
  const totals = emptyAuditTotals();
  let entries = 0;
  let invalidLines = 0;
  let latest = null;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      if (error instanceof Error) {
        invalidLines += 1;
        continue;
      }
      throw error;
    }
    entries += 1;
    updateAuditTotals(totals, entry);
    latest = withDisplayTimestamps(toSafeAuditEntry(entry), timezone);
  }
  totals.average_duration_ms = entries > 0 ? totals.duration_ms / entries : 0;
  return { file: filePath, exists: true, size_bytes: file.size_bytes, entries, invalid_lines: invalidLines, latest, totals: withDisplayTimestamps(totals, timezone) };
}

async function summarizeHashFile(filePath) {
  const file = await describeFile(filePath);
  if (!file.exists) return { file: filePath, exists: false, entries: 0 };
  let entries = 0;
  let invalidLines = 0;
  for await (const line of readLines(filePath)) {
    if (!line.trim()) continue;
    if (/^[a-f0-9]{64}$/.test(line.trim())) entries += 1;
    else invalidLines += 1;
  }
  return { file: filePath, exists: true, size_bytes: file.size_bytes, entries, invalid_lines: invalidLines };
}

async function describeFile(filePath) {
  try {
    const info = await stat(filePath);
    return { exists: true, size_bytes: info.size };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, size_bytes: 0 };
    throw error;
  }
}

async function* readLines(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

function emptyAuditTotals() {
  return { flagged: 0, blocked: 0, cache_hits: 0, reviewed_body_chars: 0, reviewed_body_utf8_bytes: 0, target_body_chars: 0, target_body_utf8_bytes: 0, moderation_request_body_utf8_bytes: 0, reviewed_segments: 0, total_segments: 0, baseline_segments: 0, uncached_segments: 0, cached_segments: 0, cache_write_segments: 0, duration_ms: 0, average_duration_ms: 0, max_duration_ms: 0, first_timestamp: null, latest_timestamp: null, token_usage: emptyTokenUsageTotals() };
}

function updateAuditTotals(totals, entry) {
  const timestamp = readString(entry.timestamp);
  if (timestamp && !totals.first_timestamp) totals.first_timestamp = timestamp;
  if (timestamp) totals.latest_timestamp = timestamp;
  if (entry.flagged === true) totals.flagged += 1;
  if (entry.blocked === true) totals.blocked += 1;
  if (entry.cache_hit === true) totals.cache_hits += 1;
  totals.reviewed_body_chars += readNumber(entry.reviewed_body_chars);
  totals.reviewed_body_utf8_bytes += readNumber(entry.reviewed_body_utf8_bytes);
  totals.target_body_chars += readNumber(entry.target_body_chars);
  totals.target_body_utf8_bytes += readNumber(entry.target_body_utf8_bytes);
  totals.moderation_request_body_utf8_bytes += readNumber(entry.moderation_request_body_utf8_bytes);
  totals.reviewed_segments += readNumber(entry.reviewed_segments);
  totals.total_segments += readNumber(entry.total_segments);
  totals.baseline_segments += readNumber(entry.baseline_segments);
  totals.uncached_segments += readNumber(entry.uncached_segments);
  totals.cached_segments += readNumber(entry.cached_segments);
  totals.cache_write_segments += readNumber(entry.cache_write_segments);
  totals.duration_ms += readNumber(entry.duration_ms);
  totals.max_duration_ms = Math.max(totals.max_duration_ms, readNumber(entry.duration_ms));
  updateTokenUsageTotals(totals.token_usage, entry.token_usage);
}

function toSafeAuditEntry(entry) {
  return {
    timestamp: readString(entry.timestamp),
    started_at: readString(entry.started_at),
    completed_at: readString(entry.completed_at),
    boundary: readString(entry.boundary),
    target_endpoint_kind: readString(entry.target_endpoint_kind),
    target_host: readString(entry.target_host),
    target_path: readString(entry.target_path),
    target_model: readString(entry.target_model),
    target_stream: entry.target_stream === true,
    provider: readString(entry.provider),
    model: readString(entry.model),
    http_status: readNullableNumber(entry.http_status),
    flagged: entry.flagged === true,
    blocked: entry.blocked === true,
    cache_hit: entry.cache_hit === true,
    reviewed_body_chars: readNumber(entry.reviewed_body_chars),
    reviewed_body_utf8_bytes: readNumber(entry.reviewed_body_utf8_bytes),
    target_body_chars: readNullableNumber(entry.target_body_chars),
    target_body_utf8_bytes: readNullableNumber(entry.target_body_utf8_bytes),
    moderation_request_body_utf8_bytes: readNullableNumber(entry.moderation_request_body_utf8_bytes),
    audit_prompt_chars: readNullableNumber(entry.audit_prompt_chars),
    audit_prompt_lines: readNullableNumber(entry.audit_prompt_lines),
    audit_prompt_sha256_prefix: readString(entry.audit_prompt_sha256_prefix),
    reviewed_segments: readNullableNumber(entry.reviewed_segments),
    total_segments: readNullableNumber(entry.total_segments),
    baseline_segments: readNullableNumber(entry.baseline_segments),
    uncached_segments: readNullableNumber(entry.uncached_segments),
    cached_segments: readNullableNumber(entry.cached_segments),
    cache_write_segments: readNullableNumber(entry.cache_write_segments),
    duration_ms: readNullableNumber(entry.duration_ms),
    token_usage: toSafeTokenUsage(entry.token_usage),
    reason_present: typeof entry.reason === "string" && entry.reason.length > 0,
    reason_length: typeof entry.reason === "string" ? entry.reason.length : 0,
    error_present: typeof entry.error === "string" && entry.error.length > 0,
    attempts_count: readNumber(entry.attempts_count) || (Array.isArray(entry.attempts) ? entry.attempts.length : 0),
  };
}

function emptyTokenUsageTotals() {
  return { exact_entries: 0, unavailable_entries: 0, skipped_entries: 0, input_tokens: 0, output_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, unavailable_reasons: {} };
}

function updateTokenUsageTotals(totals, tokenUsage) {
  if (!isPlainObject(tokenUsage)) {
    addUnavailableTokenUsage(totals, "missing token_usage metadata");
    return;
  }
  if (tokenUsage.exact === true && tokenUsage.source === "provider_response.usage") {
    totals.exact_entries += 1;
    totals.input_tokens += readNumber(tokenUsage.input_tokens);
    totals.output_tokens += readNumber(tokenUsage.output_tokens);
    totals.prompt_tokens += readNumber(tokenUsage.prompt_tokens);
    totals.completion_tokens += readNumber(tokenUsage.completion_tokens);
    totals.total_tokens += readNumber(tokenUsage.total_tokens);
    totals.cached_tokens += readNumber(tokenUsage.cached_tokens);
    totals.reasoning_tokens += readNumber(tokenUsage.reasoning_tokens);
    return;
  }
  const reason = readString(tokenUsage.unavailable_reason) || "exact provider usage unavailable";
  if (reason.startsWith("review skipped")) totals.skipped_entries += 1;
  else addUnavailableTokenUsage(totals, reason);
}

function addUnavailableTokenUsage(totals, reason) {
  totals.unavailable_entries += 1;
  totals.unavailable_reasons[reason] = (totals.unavailable_reasons[reason] ?? 0) + 1;
}

function toSafeTokenUsage(tokenUsage) {
  if (!isPlainObject(tokenUsage)) return { source: "unavailable", exact: false, unavailable_reason: "missing token_usage metadata" };
  return { source: readString(tokenUsage.source), exact: tokenUsage.exact === true, unavailable_reason: readString(tokenUsage.unavailable_reason), input_tokens: readNullableNumber(tokenUsage.input_tokens), output_tokens: readNullableNumber(tokenUsage.output_tokens), prompt_tokens: readNullableNumber(tokenUsage.prompt_tokens), completion_tokens: readNullableNumber(tokenUsage.completion_tokens), total_tokens: readNullableNumber(tokenUsage.total_tokens), cached_tokens: readNullableNumber(tokenUsage.cached_tokens), reasoning_tokens: readNullableNumber(tokenUsage.reasoning_tokens) };
}

function withDisplayTimestamps(value, timezone) {
  return {
    ...value,
    timestamp_display: formatTimestamp(value.timestamp, timezone),
    started_at_display: formatTimestamp(value.started_at, timezone),
    completed_at_display: formatTimestamp(value.completed_at, timezone),
    first_timestamp_display: formatTimestamp(value.first_timestamp, timezone),
    latest_timestamp_display: formatTimestamp(value.latest_timestamp, timezone),
  };
}

function formatTimestamp(value, timezone) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date).replace(" ", "T");
  } catch (error) {
    if (error instanceof Error) return new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date).replace(" ", "T");
    throw error;
  }
}

function readString(value) {
  return typeof value === "string" ? value : null;
}

function readNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function readNullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
