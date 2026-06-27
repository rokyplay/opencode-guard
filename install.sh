#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="${HOME}/.config/opencode/plugins"

mkdir -p "${plugin_dir}"
cat > "${plugin_dir}/moderation-guard.js" <<EOF
import { installOpenCodeModerationFetchInterceptor } from "${script_dir}/lib/fetch-interceptor.mjs";

installOpenCodeModerationFetchInterceptor();

export const ModerationGuard = async () => ({});
EOF
chmod 0644 "${plugin_dir}/moderation-guard.js"

printf 'Installed OpenCode transparent moderation interceptor to %s\n' "${plugin_dir}/moderation-guard.js"
printf 'Restart OpenCode. No model/provider config change is required.\n'
