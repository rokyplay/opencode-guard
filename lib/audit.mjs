import { appendFile, mkdir } from "node:fs/promises";

import { getGuardConfig } from "./config.mjs";
import { describeError } from "./http-util.mjs";

export async function writeGatewayAudit(entry, config = getGuardConfig()) {
  if (entry.cache_hit && !config.auditCacheHits) return;
  try {
    await mkdir(config.logDir, { recursive: true, mode: 0o700 });
    await appendFile(getAuditLogFile(config), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[opencode-safety-filter] failed to write audit log: ${describeError(error)}`);
  }
}

export function getAuditLogFile(config = getGuardConfig()) {
  return config.auditLogFile;
}
