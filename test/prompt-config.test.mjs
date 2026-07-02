import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeServer, createModerationServer, listen } from "./helpers.mjs";

test("missing enabled controls keep guard disabled by default", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-missing-controls-test-"));
  const { getGuardConfig } = await import(`../lib/config.mjs?missing-controls-config-${Date.now()}`);

  const config = getGuardConfig({
    OPENCODE_GUARD_ENABLED_FILE: join(logDir, "missing-enabled"),
    OPENCODE_GUARD_STATE_FILE: join(logDir, "missing-state"),
  });
  assert.equal(config.enabled, false);
});

test("enabled toggle file controls guard when env override is absent", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-toggle-test-"));
  const enabledFile = join(logDir, "enabled");
  const stateFile = join(logDir, "missing-state");
  const { getGuardConfig } = await import(`../lib/config.mjs?toggle-config-1782615196022`);

  await writeFile(enabledFile, "0", { mode: 0o600 });
  assert.equal(getGuardConfig({ OPENCODE_GUARD_ENABLED_FILE: enabledFile, OPENCODE_GUARD_STATE_FILE: stateFile }).enabled, false);
  assert.equal(getGuardConfig({ OPENCODE_GUARD_ENABLED_FILE: enabledFile, OPENCODE_GUARD_STATE_FILE: stateFile, OPENCODE_GUARD_ENABLED: "1" }).enabled, true);

  await writeFile(enabledFile, "1", { mode: 0o600 });
  assert.equal(getGuardConfig({ OPENCODE_GUARD_ENABLED_FILE: enabledFile, OPENCODE_GUARD_STATE_FILE: stateFile }).enabled, true);
  assert.equal(getGuardConfig({ OPENCODE_GUARD_ENABLED_FILE: enabledFile, OPENCODE_GUARD_STATE_FILE: stateFile, OPENCODE_GUARD_ENABLED: "0" }).enabled, false);
});

test("state file controls enabled and backend order", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-state-test-"));
  const stateFile = join(logDir, "state");
  const { getGuardConfig } = await import(`../lib/config.mjs?state-config-1782616262907`);

  await writeFile(stateFile, "enabled=1\nbackend=2", { mode: 0o600 });
  let config = getGuardConfig({ OPENCODE_GUARD_STATE_FILE: stateFile, OPENCODE_GUARD_ENABLED_FILE: join(logDir, "missing-enabled") });
  assert.equal(config.enabled, true);
  assert.equal(config.backendId, "2");
  assert.deepEqual(config.reviewOrder, ["openai", "zen", "zen-fallbacks"]);

  await writeFile(stateFile, "enabled=0\nbackends=zen", { mode: 0o600 });
  config = getGuardConfig({ OPENCODE_GUARD_STATE_FILE: stateFile, OPENCODE_GUARD_ENABLED_FILE: join(logDir, "missing-enabled") });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.reviewOrder, ["zen"]);

  config = getGuardConfig({ OPENCODE_GUARD_STATE_FILE: stateFile, OPENCODE_GUARD_BACKENDS: "openai" });
  assert.deepEqual(config.reviewOrder, ["openai"]);
});

test("state file can override display timezone", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-timezone-test-"));
  const stateFile = join(logDir, "state");
  const { getGuardConfig } = await import(`../lib/config.mjs?timezone-config-1782646954225`);

  await writeFile(stateFile, "enabled=1\nbackend=2\ntimezone=Asia/Shanghai", { mode: 0o600 });
  assert.equal(getGuardConfig({ OPENCODE_GUARD_STATE_FILE: stateFile }).displayTimezone, "Asia/Shanghai");
  assert.equal(getGuardConfig({ OPENCODE_GUARD_STATE_FILE: stateFile, OPENCODE_GUARD_TIMEZONE: "UTC" }).displayTimezone, "UTC");
});

test("custom review backend derives endpoint paths from base URL and format", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-custom-backend-test-"));
  const { getGuardConfig } = await import(`../lib/config.mjs?custom-backend-config-${Date.now()}`);
  const { reviewOutboundRequest } = await import(`../lib/reviewer.mjs?custom-backend-reviewer-${Date.now()}`);
  const cases = [
    { format: "openai-chat", mode: "custom-openai-chat", path: "/v1/chat/completions" },
    { format: "openai-responses", mode: "custom-openai-responses", path: "/v1/responses" },
    { format: "anthropic-messages", mode: "custom-anthropic-messages", path: "/v1/messages" },
  ];
  for (const item of cases) {
    const state = { mode: item.mode, calls: 0, bodies: [], requests: [] };
    const moderation = await listen(createModerationServer(state));
    try {
      const config = getGuardConfig({ OPENCODE_GUARD_LOG_DIR: logDir, OPENCODE_GUARD_BACKENDS: "custom", OPENCODE_GUARD_REVIEW_API_KEY: "mock-custom", OPENCODE_GUARD_REVIEW_BASE_URL: `${moderation.url}/v1`, OPENCODE_GUARD_REVIEW_FORMAT: item.format, OPENCODE_GUARD_REVIEW_MODEL: "audit-model", OPENCODE_GUARD_CACHE: "0", OPENCODE_GUARD_ENABLED: "1" });
      const decision = await reviewOutboundRequest("safe custom backend text", config);
      assert.equal(decision.flagged, false);
      assert.equal(state.calls, 1);
      assert.equal(new URL(state.requests[0].url, moderation.url).pathname, item.path);
      assert.equal(state.bodies[0].model, "audit-model");
    } finally {
      await closeServer(moderation.server);
    }
  }
});

test("audit prompt file is read for each Zen review", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-prompt-file-test-"));
  const promptFile = join(logDir, "prompt.txt");
  const promptText = "CUSTOM_AUDIT_PROMPT: decide with JSON only.";
  await writeFile(promptFile, promptText, { mode: 0o600 });
  const moderationState = { mode: "zen-allow", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_AUDIT_PROMPT_FILE = promptFile;
  process.env.OPENCODE_GUARD_BACKENDS = "zen";
  process.env.OPENCODE_GUARD_CACHE = "0";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENCODEZEN_API_KEY = "mock-zen";
  process.env.OPENCODE_GUARD_ZEN_CHAT_ENDPOINT = `${moderation.url}/zen/v1/chat/completions`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?prompt-file-${Date.now()}`);
  const target = {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "upstream ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const response = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "use custom prompt" }] }) });
    assert.equal((await response.json()).choices[0].message.content, "upstream ok");
    assert.equal(moderationState.calls, 1);
    assert.equal(moderationState.bodies[0].messages[0].content, promptText);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("audit prompt changes invalidate segment cache", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-prompt-cache-test-"));
  const promptFile = join(logDir, "prompt.txt");
  const moderationState = { mode: "allow", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_AUDIT_PROMPT_FILE = promptFile;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "1";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations`;
  await writeFile(promptFile, "PROMPT_VERSION_ONE", { mode: 0o600 });

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?prompt-cache-${Date.now()}`);
  const target = {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "upstream ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const body = { model: "gpt-5.5", messages: [{ role: "user", content: "same cached segment" }] };
    await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await writeFile(promptFile, "PROMPT_VERSION_TWO", { mode: 0o600 });
    await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(moderationState.calls, 2);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("status summary exposes prompt metadata without prompt contents", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-status-test-"));
  const promptFile = join(logDir, "prompt.txt");
  await writeFile(promptFile, "SECRET_PROMPT token should not be printed", { mode: 0o600 });
  await writeFile(join(logDir, "interceptor-calls.jsonl"), `${JSON.stringify({ timestamp: "2026-06-27T00:00:00.000Z", boundary: "transparent-fetch-interceptor", provider: "openai-moderation", model: "omni-moderation-latest", endpoint: "https://api.openai.com/v1/moderations?api_key=sk-query-secret", http_status: 200, flagged: true, blocked: true, reason: "flagged", reason_detail: "violence", error: "token should not be printed", attempts: [{ backend: "openai-moderation", model: "omni-moderation-latest", status: "failed", http_status: 401, error: "Authorization Bearer sk-attempt-secret", token_usage: { source: "tokenizer", exact: true, tokenizer: "js-tiktoken", encoding: "o200k_base", request_tokens: 11, response_tokens: 7, input_tokens: 11, output_tokens: 7, prompt_tokens: null, completion_tokens: null, total_tokens: 18, cached_tokens: null, reasoning_tokens: null, provider_usage: null } }], cache_hit: false, reviewed_body_chars: 123, reviewed_segments: 1, total_segments: 2, baseline_segments: 1, duration_ms: 45, token_usage: { source: "tokenizer", exact: true, tokenizer: "js-tiktoken", encoding: "o200k_base", request_tokens: 11, response_tokens: 7, input_tokens: 11, output_tokens: 7, prompt_tokens: null, completion_tokens: null, total_tokens: 18, cached_tokens: null, reasoning_tokens: null, provider_usage: null } })}\n`, { mode: 0o600 });
  await writeFile(join(logDir, "moderation-interceptor-v1-segments.sha256"), `${"a".repeat(64)}\n`, { mode: 0o600 });

  const { getGuardConfig } = await import(`../lib/config.mjs?status-config-${Date.now()}`);
  const { buildStatusSummary } = await import(`../lib/status-summary.mjs?status-summary-${Date.now()}`);
  const config = getGuardConfig({ OPENCODE_GUARD_LOG_DIR: logDir, OPENCODE_GUARD_AUDIT_PROMPT_FILE: promptFile, OPENCODEZEN_API_KEY: "sk-zen-secret", OPENAI_MODERATION_API_KEY: "sk-openai-secret", OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT: "https://api.openai.com/v1/moderations?api_key=sk-query-secret", OPENCODE_GUARD_ZEN_CHAT_ENDPOINT: "https://opencode.ai/zen/v1/chat/completions?token=secret", OPENCODE_GUARD_TIMEZONE: "Asia/Shanghai" });
  const summary = await buildStatusSummary(config);
  const output = JSON.stringify(summary);

  assert.equal(summary.config.display_timezone, "Asia/Shanghai");
  assert.equal(summary.audit.latest.timestamp_display, "2026-06-27T08:00:00");
  assert.equal(summary.audit.totals.first_timestamp_display, "2026-06-27T08:00:00");
  assert.equal(summary.config.zen_api_key_set, true);
  assert.equal(summary.config.openai_moderation_api_key_set, true);
  assert.equal(summary.audit.entries, 1);
  assert.equal(summary.prompt.exists, true);
  assert.equal(summary.prompt.readable, true);
  assert.equal(summary.prompt.preview.enabled, false);
  assert.equal(summary.audit.latest.reason_present, true);
  assert.equal(summary.audit.latest.reason, "flagged");
  assert.equal(summary.audit.latest.reason_detail, "violence");
  assert.deepEqual(summary.audit.latest.attempts, [{ backend: "openai-moderation", model: "omni-moderation-latest", attempt: null, status: "failed", http_status: 401, error: "Authorization Bearer sk-attempt-secret", error_kind: null, token_usage: { source: "tokenizer", exact: true, tokenizer: "js-tiktoken", encoding: "o200k_base", request_tokens: 11, response_tokens: 7, input_tokens: 11, output_tokens: 7, prompt_tokens: null, completion_tokens: null, total_tokens: 18, cached_tokens: null, reasoning_tokens: null, provider_usage_present: false } }]);
  assert.equal(summary.audit.latest.attempts_count, 1);
  assert.equal(summary.audit.latest.token_usage.source, "tokenizer");
  assert.equal(summary.audit.latest.token_usage.request_tokens, 11);
  assert.equal(summary.audit.latest.token_usage.response_tokens, 7);
  assert.equal(summary.audit.totals.token_usage.request_tokens, 11);
  assert.equal(summary.audit.totals.token_usage.response_tokens, 7);
  assert.equal(summary.audit.totals.token_usage.exact_entries, 1);
  assert.equal(summary.cache.entries, 1);
  assert.match(output, /Authorization Bearer sk-attempt-secret/);
  assert.doesNotMatch(output, /sk-zen-secret|sk-openai-secret|sk-query-secret/);
});
