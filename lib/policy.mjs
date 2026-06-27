import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_POLICY_VERSION = "moderation-interceptor-v1";

export const DEFAULT_AUDIT_PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "audit-prompt.txt");
