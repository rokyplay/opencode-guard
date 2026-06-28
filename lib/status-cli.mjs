#!/usr/bin/env node
import { buildStatusSummary } from "./status-summary.mjs";

try {
  const summary = await buildStatusSummary();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(formatStatus(summary));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`status failed: ${message}\n`);
  process.exitCode = 1;
}

function formatStatus(summary) {
  return [
    "OpenCode Guard Status",
    "=====================",
    "",
    "Config",
    `  enabled: ${yesNo(summary.config.enabled)}`,
    `  cache: ${yesNo(summary.config.cache_enabled)}`,
    `  audit cache hits: ${yesNo(summary.config.audit_cache_hits)}`,
    `  review order: ${summary.config.review_order}`,
    `  display timezone: ${summary.config.display_timezone}`,
    `  target: ${summary.config.openai_provider_host} ${summary.config.chat_completions_path_suffix}, ${summary.config.responses_path_suffix}`,
    "",
    "Prompt",
    `  file: ${summary.prompt.file}`,
    `  readable: ${yesNo(summary.prompt.readable)}`,
    `  size: ${valueOrDash(summary.prompt.chars)} chars, ${valueOrDash(summary.prompt.lines)} lines`,
    `  sha256: ${summary.prompt.sha256_prefix ? `${summary.prompt.sha256_prefix}...` : "-"}`,
    `  updated: ${valueOrDash(summary.prompt.updated_at)}`,
    `  preview: ${summary.prompt.preview?.enabled ? "enabled" : `disabled (${summary.prompt.preview?.reason ?? "raw prompt hidden"})`}`,
    "",
    "Moderation",
    `  custom review: ${summary.config.custom_review_format} ${summary.config.custom_review_model || "-"} (key set: ${yesNo(summary.config.custom_review_api_key_set)})`,
    `  custom route: base=${summary.config.custom_review_base_url}, endpoint=${summary.config.custom_review_endpoint}`,
    `  zen model: ${summary.config.zen_model} (key set: ${yesNo(summary.config.zen_api_key_set)})`,
    `  openai moderation: ${summary.config.openai_moderation_model} (key set: ${yesNo(summary.config.openai_moderation_api_key_set)})`,
    `  timeout/retry: ${summary.config.review_timeout_ms} ms, ${summary.config.zen_retries} zen retries`,
    "",
    "Audit",
    `  file: ${summary.audit.file}`,
    `  entries: ${summary.audit.entries} (${summary.audit.invalid_lines} invalid)` ,
    `  flagged/blocked/cache hits: ${summary.audit.totals.flagged}/${summary.audit.totals.blocked}/${summary.audit.totals.cache_hits}`,
    `  time window: ${valueOrDash(summary.audit.totals.first_timestamp_display)} (${valueOrDash(summary.audit.totals.first_timestamp)} UTC) -> ${valueOrDash(summary.audit.totals.latest_timestamp_display)} (${valueOrDash(summary.audit.totals.latest_timestamp)} UTC)`,
    `  duration total/avg/max: ${summary.audit.totals.duration_ms} / ${formatNumber(summary.audit.totals.average_duration_ms)} / ${summary.audit.totals.max_duration_ms} ms`,
    `  reviewed chars/bytes: ${summary.audit.totals.reviewed_body_chars}/${summary.audit.totals.reviewed_body_utf8_bytes}`,
    `  target body chars/bytes: ${summary.audit.totals.target_body_chars}/${summary.audit.totals.target_body_utf8_bytes}`,
    `  moderation request bytes: ${summary.audit.totals.moderation_request_body_utf8_bytes}`,
    `  segments reviewed/total/baseline: ${summary.audit.totals.reviewed_segments}/${summary.audit.totals.total_segments}/${summary.audit.totals.baseline_segments}`,
    `  cache cached/uncached/written: ${summary.audit.totals.cached_segments}/${summary.audit.totals.uncached_segments}/${summary.audit.totals.cache_write_segments}`,
    `  exact token usage: ${formatTokenTotals(summary.audit.totals.token_usage)}`,
    `  token availability: exact=${summary.audit.totals.token_usage.exact_entries}, unavailable=${summary.audit.totals.token_usage.unavailable_entries}, skipped=${summary.audit.totals.token_usage.skipped_entries}; estimates=disabled`,
    `  latest: ${formatLatest(summary.audit.latest)}`,
    `  latest reason: ${formatLatestReason(summary.audit.latest)}`,
    `  latest attempts: ${formatAttempts(summary.audit.latest?.attempts)}`,
    "",
    "Cache",
    `  file: ${summary.cache.file}`,
    `  entries: ${summary.cache.entries}${summary.cache.invalid_lines === undefined ? "" : ` (${summary.cache.invalid_lines} invalid)`}`,
    "",
  ].join("\n");
}

function formatLatestReason(latest) {
  if (!latest) return "-";
  const pieces = [latest.reason, latest.reason_detail, latest.error].filter((value) => typeof value === "string" && value.length > 0);
  return pieces.length > 0 ? pieces.join("; ") : "-";
}

function formatAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return "-";
  return attempts.map((attempt) => `${attempt.backend}/${attempt.model}${attempt.attempt ? `#${attempt.attempt}` : ""}:${attempt.status}${attempt.http_status ? ` HTTP ${attempt.http_status}` : ""}${attempt.error ? ` ${attempt.error}` : ""}`).join(" | ");
}

function formatLatest(latest) {
  if (!latest) return "-";
  const tokens = latest.token_usage?.exact ? ` tokens_total=${valueOrDash(latest.token_usage.total_tokens)}` : ` tokens=${latest.token_usage?.source ?? "unavailable"}`;
  const timestamp = latest.timestamp_display ? `${latest.timestamp_display} (${latest.timestamp ?? "-"} UTC)` : (latest.timestamp ?? "-");
  return `${timestamp} ${latest.provider ?? "-"}/${latest.model ?? "-"} target=${latest.target_model ?? "-"} reviewed=${latest.reviewed_body_chars} chars segments=${latest.reviewed_segments ?? "-"}${tokens}`;
}

function formatTokenTotals(tokenUsage) {
  if (!tokenUsage) return "unavailable";
  if (tokenUsage.exact_entries === 0) return "unavailable (no exact provider usage entries)";
  return `input=${tokenUsage.input_tokens}, output=${tokenUsage.output_tokens}, prompt=${tokenUsage.prompt_tokens}, completion=${tokenUsage.completion_tokens}, total=${tokenUsage.total_tokens}, cached=${tokenUsage.cached_tokens}, reasoning=${tokenUsage.reasoning_tokens}`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function valueOrDash(value) {
  return value ?? "-";
}
