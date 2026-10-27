param([Parameter(ValueFromRemainingArguments=$true)][string[]]$MigrationArguments)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskCandidates = @((Join-Path $taskRoot '.runtime/node.exe'))
$taskInstalledNode = Get-Command node -ErrorAction SilentlyContinue
if ($taskInstalledNode) { $taskCandidates += $taskInstalledNode.Source }
$taskCandidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$taskNode = $null
foreach ($taskCandidate in $taskCandidates) {
  if ((Test-Path -LiteralPath $taskCandidate) -and ([version](& $taskCandidate -p 'process.versions.node') -ge [version]'24.0.0')) { $taskNode = $taskCandidate; break }
}
if (-not $taskNode) { throw '请安装 Node.js 24，或使用包含运行环境的书间发布包。' }
if (Test-Path -LiteralPath (Join-Path $taskRoot '.distribution.json')) {
  & $taskNode (Join-Path $PSScriptRoot 'prepare-runtime.mjs')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$taskEntry = Join-Path $taskRoot 'apps/server/dist/migrate.js'
if (-not (Test-Path -LiteralPath $taskEntry)) { throw '缺少编译后的迁移工具。源码目录请先运行 pnpm build，发布包请重新完整解压。' }
Write-Host '迁移前请关闭正在使用源 SQLite 工作区的书间；工具会拒绝在线迁移。' -ForegroundColor DarkGreen
& $taskNode $taskEntry @MigrationArguments
exit $LASTEXITCODE
