import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeServer, createModerationServer, listen } from "./helpers.mjs";

test("transparent interceptor reviews OpenAI provider requests without model rerouting", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-interceptor-test-"));
  const moderationState = { mode: "allow", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "1";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENCODE_GUARD_TRANSPARENT_ALL_MODELS = "0";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?${Date.now()}`);
  const upstreamState = { calls: 0, requests: [] };
  const target = {
    fetch: async (request) => {
      upstreamState.calls += 1;
      upstreamState.requests.push({ url: request.url, body: JSON.parse(await request.clone().text()) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "upstream ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const body = { model: "gpt-5.5", messages: [{ role: "system", content: "rules" }, { role: "user", content: "debug my own service" }], tools: [{ type: "function", function: { name: "read_file" } }] };
    const allowResponse = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await allowResponse.json()).choices[0].message.content, "upstream ok");
    assert.equal(moderationState.calls, 1);
    assert.equal(upstreamState.calls, 1);
    assert.doesNotMatch(moderationState.bodies[0].input, /message:0:system/);
    assert.match(moderationState.bodies[0].input, /<segment label="message:1:user">/);
    assert.doesNotMatch(moderationState.bodies[0].input, /tool:0/);
    assert.equal(upstreamState.requests[0].body.model, "gpt-5.5");

    const longerBody = { ...body, messages: [...body.messages, { role: "assistant", content: "previous answer" }, { role: "user", content: "new follow up" }] };
    const incrementalResponse = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(longerBody) });
    assert.equal((await incrementalResponse.json()).choices[0].message.content, "upstream ok");
    assert.equal(moderationState.calls, 2);
    assert.equal(upstreamState.calls, 2);
    assert.doesNotMatch(moderationState.bodies[1].input, /message:0:system/);
    assert.doesNotMatch(moderationState.bodies[1].input, /message:2:assistant/);
    assert.match(moderationState.bodies[1].input, /message:3:user/);
    const cacheLines = (await readFile(join(logDir, "moderation-interceptor-v1-segments.sha256"), "utf8")).trim().split("\n");
    assert.equal(cacheLines.length, 5);
    const auditLines = (await readFile(join(logDir, "interceptor-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(auditLines[0].reviewed_segments, 1);
    assert.equal(auditLines[0].baseline_segments, 2);
    assert.equal(auditLines[0].target_endpoint_kind, "chat-completions");
    assert.equal(auditLines[0].target_model, "gpt-5.5");
    assert.equal(typeof auditLines[0].started_at, "string");
    assert.equal(typeof auditLines[0].completed_at, "string");
    assert.equal(auditLines[0].token_usage.source, "tokenizer+provider_usage");
    assert.equal(auditLines[0].token_usage.exact, true);
    assert.equal(auditLines[0].token_usage.tokenizer, "js-tiktoken");
    assert.equal(auditLines[0].token_usage.encoding, "o200k_base");
    assert.equal(Number.isInteger(auditLines[0].token_usage.request_tokens), true);
    assert.equal(Number.isInteger(auditLines[0].token_usage.response_tokens), true);
    assert.equal(auditLines[0].token_usage.input_tokens, 31);
    assert.equal(auditLines[0].token_usage.total_tokens, 31);
    assert.equal(auditLines[1].reviewed_segments, 1);
    assert.equal(auditLines[1].baseline_segments, 1);

    moderationState.mode = "fail";
    const cachedResponse = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(longerBody) });
    assert.equal((await cachedResponse.json()).choices[0].message.content, "upstream ok");
    assert.equal(moderationState.calls, 2);
    assert.equal(upstreamState.calls, 3);

    moderationState.mode = "block";
    const blockResponse = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, messages: [{ role: "user", content: "steal someone else's credentials" }] }) });
    assert.match((await blockResponse.json()).choices[0].message.content, /blocked before it was sent upstream/);
    assert.equal(moderationState.calls, 3);
    assert.equal(upstreamState.calls, 3);

    const otherProviderResponse = await target.fetch("https://api.deepseek.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hello" }] }) });
    assert.equal((await otherProviderResponse.json()).choices[0].message.content, "upstream ok");
    assert.equal(moderationState.calls, 3);
    assert.equal(upstreamState.calls, 4);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("blocked streaming Responses API requests use Responses SSE events", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-responses-stream-test-"));
  const moderationState = { mode: "block", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "0";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENCODE_GUARD_TRANSPARENT_ALL_MODELS = "0";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?responses-stream-${Date.now()}`);
  const upstreamState = { calls: 0 };
  const target = {
    fetch: async () => {
      upstreamState.calls += 1;
      return new Response("upstream should not run", { status: 200 });
    },
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const response = await target.fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "blocked responses stream" }) });
    const streamText = await response.text();
    const events = streamText.split("\n\n").filter((chunk) => chunk.startsWith("data: {")).map((chunk) => JSON.parse(chunk.slice(6)));

    assert.equal(upstreamState.calls, 0);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.deepEqual(events.map((event) => event.type), ["response.created", "response.output_item.added", "response.output_text.delta", "response.output_item.done", "response.completed"]);
    assert.match(events[2].delta, /blocked before it was sent upstream/);
    assert.equal(events[2].item_id, events[3].item.id);
    assert.equal(events[3].item.id, events[4].response.output[0].id);
    assert.doesNotMatch(streamText, /chat.completion.chunk/);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("first enable reviews only latest actionable segment when history cache is empty", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-interceptor-first-enable-"));
  const moderationState = { mode: "allow", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "1";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENCODE_GUARD_TRANSPARENT_ALL_MODELS = "0";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?first-enable-${Date.now()}`);
  const target = {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "upstream ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "old user turn one" },
        { role: "assistant", content: "old answer one" },
        { role: "user", content: "old user turn two" },
        { role: "assistant", content: "old answer two" },
        { role: "user", content: "current user turn" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    };
    const response = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await response.json()).choices[0].message.content, "upstream ok");
    assert.equal(moderationState.calls, 1);
    assert.doesNotMatch(moderationState.bodies[0].input, /old user turn one/);
    assert.doesNotMatch(moderationState.bodies[0].input, /old user turn two/);
    assert.match(moderationState.bodies[0].input, /current user turn/);
    const auditLines = (await readFile(join(logDir, "interceptor-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(auditLines[0].reviewed_segments, 1);
    assert.equal(auditLines[0].baseline_segments, 6);
    const cacheLines = (await readFile(join(logDir, "moderation-interceptor-v1-segments.sha256"), "utf8")).trim().split("\n");
    assert.equal(cacheLines.length, 7);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("runtime config is read for every intercepted request", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-interceptor-hot-config-"));
  const firstState = { mode: "allow", calls: 0, bodies: [] };
  const secondState = { mode: "allow", calls: 0, bodies: [] };
  const firstModeration = await listen(createModerationServer(firstState));
  const secondModeration = await listen(createModerationServer(secondState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "1";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENCODE_GUARD_TRANSPARENT_ALL_MODELS = "0";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${firstModeration.url}/v1/moderations`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?hot-config-${Date.now()}`);
  const target = {
    fetch: async (request) => new Response(JSON.stringify({ choices: [{ message: { content: `upstream ${request.url}` } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const firstBody = { model: "gpt-5.5", messages: [{ role: "user", content: "first hot config turn" }] };
    const secondBody = { model: "gpt-5.5", messages: [{ role: "user", content: "second hot config turn" }] };
    await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(firstBody) });
    assert.equal(firstState.calls, 1);
    assert.equal(secondState.calls, 0);

    process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${secondModeration.url}/v1/moderations`;
    await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(secondBody) });
    assert.equal(firstState.calls, 1);
    assert.equal(secondState.calls, 1);
  } finally {
    uninstall();
    await closeServer(firstModeration.server);
    await closeServer(secondModeration.server);
  }
});

test("moderation backend failures are fail-closed without leaking backend bodies", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-fail-closed-test-"));
  const moderationState = { mode: "secret-fail", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "0";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations?api_key=sk-query-secret`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?fail-closed-${Date.now()}`);
  const upstreamState = { calls: 0 };
  const target = {
    fetch: async () => {
      upstreamState.calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "upstream should not run" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const response = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "trigger moderation failure" }] }) });
    const payload = await response.json();
    const auditOutput = await readFile(join(logDir, "interceptor-calls.jsonl"), "utf8");
    const responseOutput = JSON.stringify(payload);

    assert.equal(upstreamState.calls, 0);
    assert.match(responseOutput, /Moderation check failed:/);
    const auditEntry = JSON.parse(auditOutput.trim());
    assert.equal(auditEntry.endpoint, null);
    assert.equal(auditEntry.attempts[0].backend, "openai-moderation");
    assert.equal(auditEntry.attempts[0].model, "omni-moderation-latest");
    assert.equal(auditEntry.attempts[0].status, "failed");
    assert.equal(auditEntry.attempts[0].http_status, 500);
    assert.equal(auditEntry.attempts[0].error_kind, "HTTP 500");
    assert.equal(auditEntry.attempts[0].token_usage.exact, true);
    assert.equal(Number.isInteger(auditEntry.attempts[0].token_usage.request_tokens), true);
    assert.equal(Number.isInteger(auditEntry.attempts[0].token_usage.response_tokens), true);
    assert.match(auditOutput, /SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body token should not be printed/);
    assert.match(responseOutput, /SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body token should not be printed/);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("HTTP 401 moderation failures identify the failed backend without leaking backend bodies", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-401-test-"));
  const moderationState = { mode: "unauthorized", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "0";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations?api_key=sk-query-secret`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?unauthorized-${Date.now()}`);
  const target = { fetch: async () => new Response("upstream should not run", { status: 200 }) };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const response = await target.fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", input: "trigger 401" }) });
    const responseOutput = JSON.stringify(await response.json());
    const auditOutput = await readFile(join(logDir, "interceptor-calls.jsonl"), "utf8");
    const auditEntry = JSON.parse(auditOutput.trim());

    assert.match(responseOutput, /Moderation check failed:/);
    assert.match(auditEntry.reason, /openai-moderation\/omni-moderation-latest failed HTTP 401/);
    assert.match(auditEntry.error, /openai-moderation\/omni-moderation-latest failed HTTP 401/);
    assert.equal(auditEntry.attempts[0].backend, "openai-moderation");
    assert.equal(auditEntry.attempts[0].model, "omni-moderation-latest");
    assert.equal(auditEntry.attempts[0].status, "failed");
    assert.equal(auditEntry.attempts[0].http_status, 401);
    assert.equal(auditEntry.attempts[0].error_kind, "HTTP 401");
    assert.equal(auditEntry.attempts[0].token_usage.exact, true);
    assert.equal(Number.isInteger(auditEntry.attempts[0].token_usage.request_tokens), true);
    assert.equal(Number.isInteger(auditEntry.attempts[0].token_usage.response_tokens), true);
    assert.match(auditOutput, /SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body token should not be printed/);
    assert.match(responseOutput, /SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body token should not be printed/);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("invalid JSON moderation responses are rejected without uncaught exceptions", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-invalid-json-test-"));
  const moderationState = { mode: "invalid-json", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "openai";
  process.env.OPENCODE_GUARD_CACHE = "0";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENAI_MODERATION_API_KEY = "mock-openai";
  process.env.OPENCODE_GUARD_OPENAI_MODERATION_ENDPOINT = `${moderation.url}/v1/moderations`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?invalid-json-${Date.now()}`);
  const target = {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "upstream should not run" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const response = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "trigger invalid json" }] }) });
    const responseOutput = JSON.stringify(await response.json());
    const auditOutput = await readFile(join(logDir, "interceptor-calls.jsonl"), "utf8");

    assert.match(responseOutput, /Moderation check failed:/);
    assert.match(auditOutput, /invalid JSON response/);
    assert.match(auditOutput, /SECRET_PROMPT invalid json token should not be printed/);
    assert.match(responseOutput, /SECRET_PROMPT/);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});

test("flagged Zen reasons are not echoed to blocked responses", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "opencode-safety-filter-zen-reason-test-"));
  const moderationState = { mode: "zen-block-secret", calls: 0, bodies: [] };
  const moderation = await listen(createModerationServer(moderationState));
  process.env.OPENCODE_GUARD_LOG_DIR = logDir;
  process.env.OPENCODE_GUARD_BACKENDS = "zen";
  process.env.OPENCODE_GUARD_CACHE = "0";
  process.env.OPENCODE_GUARD_ENABLED = "1";
  process.env.OPENCODEZEN_API_KEY = "mock-zen";
  process.env.OPENCODE_GUARD_ZEN_CHAT_ENDPOINT = `${moderation.url}/zen/v1/chat/completions`;

  const { installOpenCodeModerationFetchInterceptor } = await import(`../lib/fetch-interceptor.mjs?zen-secret-reason-${Date.now()}`);
  const target = {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "upstream should not run" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  };
  const uninstall = installOpenCodeModerationFetchInterceptor({ target });

  try {
    const response = await target.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "trigger zen block" }] }) });
    const responseOutput = JSON.stringify(await response.json());
    const auditOutput = await readFile(join(logDir, "interceptor-calls.jsonl"), "utf8");

    assert.match(responseOutput, /SECRET_PROMPT Authorization Bearer Cookie raw request body token should not be printed/);
    const auditEntry = JSON.parse(auditOutput.trim());
    assert.match(auditEntry.reason, /SECRET_PROMPT Authorization Bearer Cookie raw request body token should not be printed/);
    assert.match(auditEntry.reason_detail, /SECRET_PROMPT Authorization Bearer Cookie raw request body token should not be printed/);
    assert.equal(auditEntry.attempts.at(-1).backend, "opencode-zen");
    assert.equal(auditEntry.attempts.at(-1).status, "ok");
    assert.match(auditOutput, /SECRET_PROMPT Authorization Bearer Cookie raw request body token should not be printed/);
    assert.match(responseOutput, /SECRET_PROMPT/);
  } finally {
    uninstall();
    await closeServer(moderation.server);
  }
});
