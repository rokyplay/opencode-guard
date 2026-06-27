# OpenCode Transparent Moderation Interceptor

Global OpenCode plugin that transparently intercepts OpenAI provider HTTP requests before they are sent upstream.

It does not require changing the selected model or provider. Keep using `openai/gpt-5.5` or any other OpenAI-provider model normally.

## Install

```bash
./install.sh
```

Then restart OpenCode. Local plugins in `~/.config/opencode/plugins/` are automatically loaded at startup.

Code changes still require restarting OpenCode so the plugin module is reloaded. Runtime guard settings below are read on every intercepted request, so env/config changes are hot after the process environment is updated.

## Behavior

- Patches `globalThis.fetch` inside the OpenCode process when the plugin loads.
- Reviews outbound OpenAI-like model calls to `/chat/completions` or `/responses`.
- Does not intercept moderation backend calls.
- Does not require `guard-gateway` or any special provider.
- Does not modify OpenCode model or provider selection.

Default target detection reviews requests to `api.openai.com` or model IDs matching `gpt-*`, `o*`, or `codex*`. Set `OPENCODE_GUARD_TRANSPARENT_ALL_MODELS=1` only if you explicitly want every chat/responses model request reviewed.

## Moderation Backends

- Default order: `zen,openai,zen-fallbacks`
- Zen default model: `deepseek-v4-flash-free`
- Zen retries: 3 attempts, 1000 ms delay
- Timeout: 60000 ms

Overrides:

```bash
export OPENCODE_GUARD_BACKENDS="zen,openai,zen-fallbacks"
export OPENCODE_GUARD_ZEN_RETRIES=3
export OPENCODE_GUARD_RETRY_DELAY_MS=1000
export OPENCODE_GUARD_REVIEW_TIMEOUT_MS=60000
```

Moderation API calls never set `max_tokens`, `maxTokens`, `max_output_tokens`, `maxOutputTokens`, or `max_completion_tokens` as request fields.

All runtime configuration is centralized in `lib/config.mjs`. The interceptor, reviewer, cache, audit logger, status command, endpoint suffixes, target host, and target model pattern consume that module instead of owning scattered defaults.

## Audit Prompt

The default audit prompt is loaded from:

```text
./audit-prompt.txt
```

This default prompt is English to keep moderation requests compact. A Chinese reference copy is kept at `./audit-prompt.zh.txt`.

Override the prompt file without editing code:

```bash
export OPENCODE_GUARD_AUDIT_PROMPT_FILE=/path/to/audit-prompt.txt
```

The prompt file is read on every reviewed request. Segment cache keys include the prompt SHA-256, so editing the prompt causes affected segments to be reviewed again.

## Cache And Logs

Allowed segment verdicts are cached by exact SHA-256 marker line at:

```text
~/.sisyphus/opencode-guard/moderation-interceptor-v1-segments.sha256
```

The key includes policy version, prompt SHA-256, and each canonical outbound segment. There is no TTL, so cache survives restarts and later sessions.

The interceptor reviews only the newest uncached actionable segment, such as the latest `user` message or Responses API `input`. Existing system, tool, assistant, and older user history is treated as baseline context and cached as segments after the newest actionable segment passes. This avoids re-sending the entire OpenCode history to the moderation backend when first enabling the interceptor or on later turns.

Audit log:

```text
~/.sisyphus/opencode-guard/interceptor-calls.jsonl
```

Logs store safe structured metadata only: start/end timestamps, duration, target endpoint type, target model, body chars/bytes, reviewed chars/bytes, moderation request bytes, prompt file metadata and SHA-256 prefix, provider/model, HTTP status, attempt counts, segment/cache counts, flags, sanitized reasons/errors, cache hash, and exact provider `usage` numbers when the backend returns them.

Token accounting never uses estimates. If the provider response omits `usage`, the log records token usage as `unavailable` with a reason instead of deriving tokens from characters.

Logs do not store raw request bodies, prompts, Authorization headers, raw backend error bodies, raw attempt strings, cookies, tokens, API keys, or response bodies.

Safe status summary:

```bash
./status
```

The status command prints allowlisted metadata only: config health, audit/cache paths, entry counts, timestamps, durations, chars/bytes, segment/cache counts, exact provider token usage totals when available, provider/model names, flags, and whether API keys are set. It does not print raw prompts, request bodies, Authorization headers, cookies, tokens, API keys, raw reasons, raw errors, raw attempt strings, or token estimates.

Use `--json` for machine-readable output:

```bash
./status --json
```

## Validation

```bash
node --test test/fetch-interceptor.test.mjs test/prompt-config.test.mjs
node --check lib/config.mjs
node --check lib/status-summary.mjs
```
