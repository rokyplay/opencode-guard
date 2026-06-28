import assert from "node:assert/strict";
import { createServer } from "node:http";

export function createModerationServer(state) {
  return createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    for (const field of ["max_tokens", "maxTokens", "max_output_tokens", "maxOutputTokens", "max_completion_tokens"]) assert.equal(Object.hasOwn(body, field), false);
    state.calls += 1;
    state.bodies.push(body);
    if (Array.isArray(state.requests)) state.requests.push({ url: request.url });
    if (state.mode === "fail") {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "mock failure" }));
      return;
    }
    if (state.mode === "secret-fail") {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body token should not be printed");
      return;
    }
    if (state.mode === "unauthorized") {
      response.writeHead(401, { "Content-Type": "text/plain" });
      response.end("SECRET_PROMPT Authorization Bearer sk-test Cookie session=abc raw request body token should not be printed");
      return;
    }
    if (state.mode === "invalid-json") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("SECRET_PROMPT invalid json token should not be printed");
      return;
    }
    if (state.mode === "zen-allow") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ flagged: false, reason: "" }) } }], usage: { prompt_tokens: 101, completion_tokens: 7, total_tokens: 108, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } } }));
      return;
    }
    if (state.mode === "zen-block-secret") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ flagged: true, reason: "SECRET_PROMPT Authorization Bearer Cookie raw request body token should not be printed" }) } }], usage: { prompt_tokens: 13, completion_tokens: 3, total_tokens: 16 } }));
      return;
    }
    if (state.mode === "custom-openai-chat") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ flagged: false, reason: "" }) } }], usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 } }));
      return;
    }
    if (state.mode === "custom-openai-responses") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({ flagged: false, reason: "" }), usage: { input_tokens: 22, output_tokens: 5, total_tokens: 27 } }));
      return;
    }
    if (state.mode === "custom-anthropic-messages") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ flagged: false, reason: "" }) }], usage: { input_tokens: 23, output_tokens: 6 } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ results: [{ flagged: state.mode === "block", categories: { violence: state.mode === "block" } }], usage: { input_tokens: 31, total_tokens: 31 } }));
  });
}

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
