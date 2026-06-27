import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { getGuardConfig } from "./config.mjs";

export async function loadAuditPrompt(config = getGuardConfig()) {
  const [text, info] = await Promise.all([readFile(config.auditPromptFile, "utf8"), stat(config.auditPromptFile)]);
  return { text, metadata: buildPromptMetadata(config.auditPromptFile, text, info) };
}

export async function summarizeAuditPrompt(config = getGuardConfig()) {
  try {
    return { ...(await loadAuditPrompt(config)).metadata, preview: { enabled: false, reason: "raw prompt preview disabled by default" } };
  } catch (error) {
    if (isMissingFile(error)) return { file: config.auditPromptFile, exists: false, readable: false, preview: { enabled: false, reason: "prompt file missing" } };
    return { file: config.auditPromptFile, exists: true, readable: false, error: "unreadable prompt file", preview: { enabled: false, reason: "prompt file unreadable" } };
  }
}

function buildPromptMetadata(filePath, text, info) {
  const sha256 = createHash("sha256").update(text).digest("hex");
  return { file: filePath, exists: true, readable: true, chars: text.length, lines: countLines(text), sha256, sha256_prefix: sha256.slice(0, 12), updated_at: info.mtime.toISOString() };
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function isMissingFile(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
