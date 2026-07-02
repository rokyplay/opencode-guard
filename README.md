# OpenCode Safety Filter

Global OpenCode plugin that transparently safety-checks outbound OpenAI-style provider requests before they are sent upstream.

It does not require changing the selected model or provider. Keep using `openai/gpt-5.5` or any other OpenAI-provider model normally.

## Install

```bash
./install.sh
```

Then restart OpenCode. Local plugins in `~/.config/opencode/plugins/` are automatically loaded at startup.

Code changes still require restarting OpenCode so the plugin module is reloaded. Runtime filter settings below are read on every intercepted request, so env/config changes are hot after the process environment is updated.

The historical environment variable prefix remains `OPENCODE_GUARD_*` for compatibility with existing installs.

## Hot Controls

The plugin can stay installed and loaded. Runtime state is read from `./state` on every intercepted request, so day-to-day enable/disable and backend switching do not require moving files or restarting OpenCode.
If both `./state` and `./enabled` are missing or unreadable, the filter stays disabled instead of enabling itself.

PowerShell helpers:

```powershell
./enable.ps1
./disable.ps1
./backend.ps1 2
```

State file format:

```text
enabled=1
backend=2
timezone=Asia/Shanghai
```

Backend IDs:

| ID | Review order |
| --- | --- |
| `1` | `zen,openai,zen-fallbacks` |
| `2` | `openai,zen,zen-fallbacks` |
| `3` | `openai` |
| `4` | `zen` |
| `5` | `custom,openai,zen` |

Environment variables still take priority over `./state`: `OPENCODE_GUARD_ENABLED`, `OPENCODE_GUARD_BACKENDS`, `OPENCODE_GUARD_REVIEW_ORDER`, and `OPENCODE_GUARD_TIMEZONE`.

## Behavior

- Patches `globalThis.fetch` inside the OpenCode process when the plugin loads.
- Reviews outbound OpenAI-like model calls to `/chat/completions` or `/responses`.
- Does not intercept moderation backend calls.
- Does not require `guard-gateway` or any special provider.
- Does not modify OpenCode model or provider selection.

Default target detection reviews requests to `api.openai.com` or model IDs matching `gpt-*`, `o*`, or `codex*`. Set `OPENCODE_GUARD_TRANSPARENT_ALL_MODELS=1` only if you explicitly want every chat/responses model request reviewed.

## Review Backends

- Default review order: `zen,openai,zen-fallbacks`
- Zen default model: `deepseek-v4-flash-free`
- Zen retries: 3 attempts, 1000 ms delay
- Timeout: 60000 ms

Fast default for OpenCode Zen:

```bash
export OPENCODEZEN_API_KEY="your-opencode-zen-key"
```

OpenCode Zen exposes free limited-time chat models such as `deepseek-v4-flash-free`, `mimo-v2.5-free`, `north-mini-code-free`, `nemotron-3-ultra-free`, and `big-pickle` at `https://opencode.ai/zen/v1/chat/completions`. The default guard settings use `deepseek-v4-flash-free` through that endpoint.

Generic SDK-style review backend:

```bash
export OPENCODE_GUARD_BACKENDS="custom,zen,openai"
export OPENCODE_GUARD_REVIEW_API_KEY="your-review-api-key"
export OPENCODE_GUARD_REVIEW_BASE_URL="https://example.com/v1"
export OPENCODE_GUARD_REVIEW_FORMAT="openai-chat"
export OPENCODE_GUARD_REVIEW_MODEL="audit-model"
```

Supported `OPENCODE_GUARD_REVIEW_FORMAT` values:

| Format | Derived path from `OPENCODE_GUARD_REVIEW_BASE_URL` | Request style | Decision parse |
| --- | --- | --- | --- |
| `openai-chat` | `/chat/completions` | OpenAI-compatible `messages` | `choices[0].message.content` JSON |
| `openai-responses` | `/responses` | OpenAI Responses-style `instructions` + `input` | `output_text` JSON |
| `anthropic-messages` | `/messages` | Anthropic Messages-style `system` + `messages` | `content[].text` JSON |
| `openai-moderation` | `/moderations` | OpenAI moderation-style `input` | `results[0].flagged` |

If your provider needs a full URL instead of base URL + derived path, set `OPENCODE_GUARD_REVIEW_ENDPOINT`. It overrides the derived endpoint.

DeepSeek official API example:

```bash
export OPENCODE_GUARD_BACKENDS="custom,zen,openai"
export OPENCODE_GUARD_REVIEW_API_KEY="$DEEPSEEK_API_KEY"
export OPENCODE_GUARD_REVIEW_BASE_URL="https://api.deepseek.com"
export OPENCODE_GUARD_REVIEW_FORMAT="openai-chat"
export OPENCODE_GUARD_REVIEW_MODEL="deepseek-v4-flash"
```

OpenCode Zen through the generic backend:

```bash
export OPENCODE_GUARD_BACKENDS="custom,openai"
export OPENCODE_GUARD_REVIEW_API_KEY="$OPENCODEZEN_API_KEY"
export OPENCODE_GUARD_REVIEW_BASE_URL="https://opencode.ai/zen/v1"
export OPENCODE_GUARD_REVIEW_FORMAT="openai-chat"
export OPENCODE_GUARD_REVIEW_MODEL="deepseek-v4-flash-free"
```

OpenAI moderation fallback:

```bash
export OPENAI_MODERATION_API_KEY="your-openai-key"
export OPENCODE_GUARD_BACKENDS="openai"
export OPENCODE_GUARD_OPENAI_MODERATION_MODEL="omni-moderation-latest"
```

Messages-compatible gateways are supported through `anthropic-messages`, but this guard still never sends `max_tokens` or similar output-limit fields. Direct APIs that require those fields will reject the request unless the provider supplies defaults.

Overrides:

```bash
export OPENCODE_GUARD_BACKENDS="zen,openai,zen-fallbacks"
export OPENCODE_GUARD_ZEN_RETRIES=3
export OPENCODE_GUARD_RETRY_DELAY_MS=1000
export OPENCODE_GUARD_REVIEW_TIMEOUT_MS=60000
```

Review API calls never set `max_tokens`, `maxTokens`, `max_output_tokens`, `maxOutputTokens`, or `max_completion_tokens` as request fields.

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
~/.sisyphus/opencode-safety-filter/moderation-interceptor-v1-segments.sha256
```

The key includes policy version, prompt SHA-256, and each canonical outbound segment. There is no TTL, so cache survives restarts and later sessions.

The interceptor reviews only the newest uncached actionable segment, such as the latest `user` message or Responses API `input`. Existing system, tool, assistant, and older user history is treated as baseline context and cached as segments after the newest actionable segment passes. This avoids re-sending the entire OpenCode history to the moderation backend when first enabling the interceptor or on later turns.

Audit log:

```text
~/.sisyphus/opencode-safety-filter/interceptor-calls.jsonl
```

Logs store safe structured metadata only: start/end timestamps, duration, target endpoint type, target model, body chars/bytes, reviewed chars/bytes, moderation request bytes, prompt file metadata and SHA-256 prefix, provider/model, HTTP status, attempt counts, segment/cache counts, flags, sanitized reasons/errors, cache hash, exact tokenizer counts for the serialized moderation request/response bodies, and exact provider `usage` numbers when present.

Token accounting records exact sent/received token counts with `js-tiktoken`. Configure encodings with `OPENCODE_GUARD_OPENAI_MODERATION_TOKEN_ENCODING`, `OPENCODE_GUARD_ZEN_TOKEN_ENCODING`, and `OPENCODE_GUARD_REVIEW_TOKEN_ENCODING`; defaults are `o200k_base`.

Logs do not store raw request bodies, prompts, Authorization headers, raw backend error bodies, raw attempt strings, cookies, tokens, API keys, or response bodies.

Safe status summary:

```bash
./status
```

The status command prints allowlisted metadata only: config health, audit/cache paths, entry counts, timestamps, durations, chars/bytes, segment/cache counts, exact sent/received token totals, exact provider token usage totals when present, provider/model names, flags, and whether API keys are set. It does not print raw prompts, request bodies, Authorization headers, cookies, tokens, API keys, raw reasons, raw errors, or raw attempt strings.

Audit logs keep raw timestamps in UTC. Status output also includes display timestamps using the system timezone by default, or `timezone=` in `./state` / `OPENCODE_GUARD_TIMEZONE` when set.

Use `--json` for machine-readable output:

```bash
./status --json
```

## Validation

```bash
node --test test/fetch-interceptor.test.mjs test/prompt-config.test.mjs
node --check lib/config.mjs
node --check lib/fetch-interceptor.mjs
node --check lib/status-summary.mjs
node --check lib/status-cli.mjs
```
