import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class HttpStatusError extends Error {
  name = "HttpStatusError";

  constructor(statusCode) {
    super(`HTTP ${statusCode}`);
    this.statusCode = statusCode;
  }
}

export class JsonParseError extends Error {
  name = "JsonParseError";

  constructor() {
    super("invalid JSON response");
  }
}

export class TimeoutError extends Error {
  name = "TimeoutError";

  constructor() {
    super("request timed out");
  }
}

export function describeError(error) {
  if (error instanceof TimeoutError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}

export function requestJson(options) {
  const bodyText = JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyText),
        },
        timeout: options.timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new HttpStatusError(statusCode));
            return;
          }
          try {
            resolve({ statusCode, payload: JSON.parse(text) });
          } catch (error) {
            if (error instanceof Error) {
              reject(new JsonParseError());
              return;
            }
            reject(error);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new TimeoutError());
    });
    request.on("error", reject);
    request.end(bodyText);
  });
}

export function proxyJsonToResponse(options) {
  const bodyText = JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyText),
        },
      },
      (upstream) => {
        options.response.writeHead(upstream.statusCode ?? 502, sanitizeHeaders(upstream.headers));
        upstream.on("data", (chunk) => options.response.write(chunk));
        upstream.on("end", () => {
          options.response.end();
          resolve();
        });
      },
    );
    request.on("error", reject);
    request.end(bodyText);
  });
}

function sanitizeHeaders(headers) {
  const output = { ...headers };
  delete output["content-length"];
  delete output["transfer-encoding"];
  delete output.connection;
  return output;
}
