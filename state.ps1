param([string]$Enabled, [string]$Backend)
$path = Join-Path $PSScriptRoot "state"
$state = @{}
if (Test-Path -LiteralPath $path) {
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^\s*([^#=][^=]*)=(.*)$') { $state[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim() }
  }
}
if ($Enabled) { $state['enabled'] = $Enabled }
if ($Backend) { $state['backend'] = $Backend }
if (-not $state.ContainsKey('enabled')) { $state['enabled'] = '0' }
if (-not $state.ContainsKey('backend')) { $state['backend'] = '1' }
$lines = @("enabled=$($state['enabled'])", "backend=$($state['backend'])")
foreach ($key in ($state.Keys | Sort-Object)) {
  if ($key -ne 'enabled' -and $key -ne 'backend') { $lines += "$key=$($state[$key])" }
}
Set-Content -LiteralPath $path -Value ($lines -join "`n") -NoNewline
"opencode-safety-filter state enabled=$($state['enabled']) backend=$($state['backend'])"
