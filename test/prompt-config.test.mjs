import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeServer, createModerationServer, listen } from "./helpers.mjs";

test("audit prompt file is read for each Zen review", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-guard-prompt-file-test-"));
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
  const logDir = await mkdtemp(join(tmpdir(), "opencode-guard-prompt-cache-test-"));
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
  const logDir = await mkdtemp(join(tmpdir(), "opencode-guard-status-test-"));
  const promptFile = join(logDir, "prompt.txt");
  await writeFile(promptFile, "SECRET_PROMPT token should not be printed", { mode: 0o600 });
  await writeFile(join(logDir, "interceptor-calls.jsonl"), `${JSON.stringify({ timestamp: "2026-06-27T00:00:00.000Z", boundary: "transparent-fetch-interceptor", provider: "openai-moderation", model: "omni-moderation-latest", endpoint: "https://api.openai.com/v1/moderations?api_key=sk-query-secret", http_status: 200, flagged: true, blocked: true, reason: "SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body", error: "token should not be printed", attempts: ["Authorization Bearer sk-attempt-secret"], cache_hit: false, reviewed_body_chars: 123, reviewed_segments: 1, total_segments: 2, baseline_segments: 1, duration_ms: 45 })}\n`, { mode: 0o600 });
  await writeFile(join(logDir, "moderation-interceptor-v1-segments.sha256"), `${"a".repeat(64)}\n`, { mode: 0o600 });

  const { getGuardConfig } = await import(`../lib/config.mjs?status-config-${Date.now()}`);
  const { buildStatusSummary } = await import(`../lib/status-summary.mjs?status-summary-${Date.now()}`);
  const config = getGuardConfig({ OPENCODE_GUARD_LOG_DIR: logDir, OPENCODE_GUARD_AUDIT_PROMPT_FILE: promptFile, OPENCODEZEN_API_KEY: "sk-zen-secret", OPENAI_MODERATION_API_KEY: "sk-openai-secret", OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT: "https://api.openai.com/v1/moderations?api_key=sk-query-secret", OPENCODE_GUARD_ZEN_CHAT_ENDPOINT: "https://opencode.ai/zen/v1/chat/completions?token=secret" });
  const summary = await buildStatusSummary(config);
  const output = JSON.stringify(summary);

  assert.equal(summary.config.zen_api_key_set, true);
  assert.equal(summary.config.openai_moderation_api_key_set, true);
  assert.equal(summary.audit.entries, 1);
  assert.equal(summary.prompt.exists, true);
  assert.equal(summary.prompt.readable, true);
  assert.equal(summary.prompt.preview.enabled, false);
  assert.equal(summary.audit.latest.reason_present, true);
  assert.equal(summary.audit.latest.attempts_count, 1);
  assert.equal(summary.audit.latest.token_usage.source, "unavailable");
  assert.equal(summary.audit.totals.token_usage.unavailable_entries, 1);
  assert.equal(summary.cache.entries, 1);
  assert.doesNotMatch(output, /SECRET_PROMPT|Authorization|Bearer|Cookie|raw request body|sk-zen-secret|sk-openai-secret|sk-query-secret|sk-attempt-secret|token should not be printed/);
});
