#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="${HOME}/.config/opencode/plugins"
plugin_file="${plugin_dir}/safety-filter.js"
legacy_plugin_file="${plugin_dir}/moderation-guard.js"

mkdir -p "${plugin_dir}"
cat > "${plugin_file}" <<EOF
import { installOpenCodeModerationFetchInterceptor } from "${script_dir}/lib/fetch-interceptor.mjs";

installOpenCodeModerationFetchInterceptor();

export const SafetyFilter = async () => ({});
EOF
chmod 0644 "${plugin_file}"
if [ -f "${legacy_plugin_file}" ]; then
  rm -f "${legacy_plugin_file}"
fi

printf 'Installed OpenCode Safety Filter to %s\n' "${plugin_file}"
printf 'Restart OpenCode. No model/provider config change is required.\n'
