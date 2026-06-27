const FORBIDDEN_TOKEN_LIMIT_FIELDS = new Set([
  "max_tokens",
  "maxTokens",
  "max_output_tokens",
  "maxOutputTokens",
  "max_completion_tokens",
]);

export function parseJson(text) {
  return JSON.parse(text);
}

export function stableStringify(value) {
  return JSON.stringify(toStableValue(value));
}

export function stripForbiddenTokenLimitFields(value) {
  if (Array.isArray(value)) return value.map((item) => stripForbiddenTokenLimitFields(item));
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_TOKEN_LIMIT_FIELDS.has(key)) output[key] = stripForbiddenTokenLimitFields(child);
  }
  return output;
}

export function assertNoForbiddenTokenLimitFields(value) {
  const field = findForbiddenTokenLimitField(value);
  if (field) throw new Error(`forbidden API token limit field present: ${field}`);
}

function findForbiddenTokenLimitField(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const field = findForbiddenTokenLimitField(item);
      if (field) return field;
    }
    return "";
  }
  if (!isPlainObject(value)) return "";
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_TOKEN_LIMIT_FIELDS.has(key)) return key;
    const field = findForbiddenTokenLimitField(child);
    if (field) return field;
  }
  return "";
}

function toStableValue(value) {
  if (Array.isArray(value)) return value.map((item) => toStableValue(item));
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = toStableValue(value[key]);
  return output;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
