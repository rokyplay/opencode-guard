import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";

import { getGuardConfig } from "./config.mjs";

const allowCachePromises = new Map();

export function getCacheDir(config = getGuardConfig()) {
  return config.logDir;
}

export function getAllowCacheFile(config = getGuardConfig()) {
  return config.segmentCacheFile;
}

export function buildSegmentCacheKey(segmentText, auditPromptSha256, config = getGuardConfig()) {
  return createHash("sha256").update(config.reviewPolicyVersion).update("\0").update(auditPromptSha256).update("\0").update(segmentText).digest("hex");
}

export async function hasAllowedSegment(cacheKey, config = getGuardConfig()) {
  if (!config.cacheEnabled) return false;
  const cache = await loadAllowCache(getAllowCacheFile(config));
  return cache.has(cacheKey);
}

export async function writeAllowedSegments(cacheKeys, config = getGuardConfig()) {
  if (!config.cacheEnabled) return;
  const cacheFile = getAllowCacheFile(config);
  const cache = await loadAllowCache(cacheFile);
  const missing = cacheKeys.filter((cacheKey) => !cache.has(cacheKey));
  if (missing.length === 0) return;
  await mkdir(getCacheDir(config), { recursive: true, mode: 0o700 });
  await appendFile(cacheFile, `${missing.join("\n")}\n`, { mode: 0o600 });
  for (const cacheKey of missing) cache.add(cacheKey);
}

async function loadAllowCache(cacheFile) {
  if (!allowCachePromises.has(cacheFile)) allowCachePromises.set(cacheFile, loadAllowCacheFromDisk(cacheFile));
  return await allowCachePromises.get(cacheFile);
}

async function loadAllowCacheFromDisk(cacheFile) {
  const cache = new Set();
  let content;
  try {
    content = await readFile(cacheFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return cache;
    throw error;
  }
  for (const line of content.split("\n")) {
    const hash = line.trim();
    if (/^[a-f0-9]{64}$/.test(hash)) cache.add(hash);
  }
  return cache;
}
