import { getEncoding } from "js-tiktoken";

const ENCODINGS = new Map();

export function buildExactTokenUsage({ encodingName, requestBodyText, responseBodyText, providerUsage }) {
  const requestTokens = countTokens(requestBodyText, encodingName);
  const responseTokens = countTokens(responseBodyText, encodingName);
  const provider = sanitizeUsageNumbers(providerUsage);
  return {
    source: provider ? "tokenizer+provider_usage" : "tokenizer",
    exact: true,
    tokenizer: "js-tiktoken",
    encoding: encodingName,
    request_tokens: requestTokens,
    response_tokens: responseTokens,
    total_tokens: provider ? readUsageNumber(provider, "total_tokens") ?? requestTokens + responseTokens : requestTokens + responseTokens,
    input_tokens: provider ? readUsageNumber(provider, "input_tokens") ?? readUsageNumber(provider, "prompt_tokens") ?? requestTokens : requestTokens,
    output_tokens: provider ? readUsageNumber(provider, "output_tokens") ?? readUsageNumber(provider, "completion_tokens") ?? responseTokens : responseTokens,
    prompt_tokens: provider ? readUsageNumber(provider, "prompt_tokens") : null,
    completion_tokens: provider ? readUsageNumber(provider, "completion_tokens") : null,
    cached_tokens: provider ? findUsageNumber(provider, "cached_tokens") : null,
    reasoning_tokens: provider ? findUsageNumber(provider, "reasoning_tokens") : null,
    provider_usage: provider,
  };
}

export function sumExactTokenUsage(usages, encodingName) {
  return usages.reduce((total, usage) => ({
    source: "tokenizer-sum",
    exact: true,
    tokenizer: "js-tiktoken",
    encoding: total.encoding || usage?.encoding || encodingName,
    request_tokens: total.request_tokens + readNumber(usage?.request_tokens),
    response_tokens: total.response_tokens + readNumber(usage?.response_tokens),
    total_tokens: total.total_tokens + readNumber(usage?.total_tokens),
    input_tokens: total.input_tokens + readNumber(usage?.input_tokens),
    output_tokens: total.output_tokens + readNumber(usage?.output_tokens),
    prompt_tokens: total.prompt_tokens + readNumber(usage?.prompt_tokens),
    completion_tokens: total.completion_tokens + readNumber(usage?.completion_tokens),
    cached_tokens: total.cached_tokens + readNumber(usage?.cached_tokens),
    reasoning_tokens: total.reasoning_tokens + readNumber(usage?.reasoning_tokens),
    provider_usage: null,
  }), zeroExactTokenUsage(encodingName));
}

export function zeroExactTokenUsage(encodingName) {
  return buildExactTokenUsage({ encodingName, requestBodyText: "", responseBodyText: "", providerUsage: null });
}

function countTokens(text, encodingName) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return getCachedEncoding(encodingName).encode(text).length;
}

function getCachedEncoding(encodingName) {
  if (!ENCODINGS.has(encodingName)) ENCODINGS.set(encodingName, getEncoding(encodingName));
  return ENCODINGS.get(encodingName);
}

function sanitizeUsageNumbers(value) {
  if (Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const children = value.map(sanitizeUsageNumbers).filter((child) => child !== undefined);
    return children.length > 0 ? children : undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const sanitized = sanitizeUsageNumbers(child);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function readUsageNumber(usage, key) {
  return Number.isFinite(usage?.[key]) ? usage[key] : null;
}

function findUsageNumber(value, key) {
  if (Number.isFinite(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsageNumber(item, key);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (Number.isFinite(value[key])) return value[key];
  for (const child of Object.values(value)) {
    const found = findUsageNumber(child, key);
    if (found !== null) return found;
  }
  return null;
}

function readNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
