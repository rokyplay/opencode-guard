import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class HttpStatusError extends Error {
  name = "HttpStatusError";

  constructor(statusCode, bodyText, requestBodyText) {
    super(`HTTP ${statusCode}${bodyText ? `: ${bodyText.slice(0, 1000)}` : ""}`);
    this.statusCode = statusCode;
    this.bodyText = bodyText;
    this.responseBodyText = bodyText;
    this.requestBodyText = requestBodyText;
  }
}

export class JsonParseError extends Error {
  name = "JsonParseError";

  constructor(bodyText, requestBodyText) {
    super(`invalid JSON response${bodyText ? `: ${bodyText.slice(0, 1000)}` : ""}`);
    this.bodyText = bodyText;
    this.responseBodyText = bodyText;
    this.requestBodyText = requestBodyText;
  }
}

export class TimeoutError extends Error {
  name = "TimeoutError";

  constructor(requestBodyText) {
    super("request timed out");
    this.requestBodyText = requestBodyText;
    this.responseBodyText = "";
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
            reject(new HttpStatusError(statusCode, text, bodyText));
            return;
          }
          try {
            resolve({ statusCode, payload: JSON.parse(text), requestBodyText: bodyText, responseBodyText: text });
          } catch (error) {
            if (error instanceof Error) {
              reject(new JsonParseError(text, bodyText));
              return;
            }
            reject(error);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new TimeoutError(bodyText));
    });
    request.on("error", (error) => {
      if (error instanceof Error && !Object.hasOwn(error, "requestBodyText")) error.requestBodyText = bodyText;
      reject(error);
    });
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
