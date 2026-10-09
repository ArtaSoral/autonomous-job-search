param([ValidateSet('dev','start','build','test','typecheck','worker','db:migrate','install')][string]$Task='dev')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $portableNode=Get-ChildItem -LiteralPath (Join-Path $projectRoot 'data/tools') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
  if (-not $portableNode) { throw 'Install Node.js 24 LTS, then run this script again.' }
  $env:PATH="$($portableNode.FullName);$env:PATH"
}
$env:NEXT_TELEMETRY_DISABLED='1'
if ($Task -eq 'install') { & npm.cmd ci } else { & npm.cmd run $Task }
exit $LASTEXITCODE
