param([switch]$Production)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskNodeCandidates = @((Join-Path $taskRoot '.runtime/node.exe'))
$taskInstalledNode = Get-Command node -ErrorAction SilentlyContinue
if ($taskInstalledNode) { $taskNodeCandidates += $taskInstalledNode.Source }
$taskNodeCandidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$taskNodePath = $null
foreach ($taskCandidate in $taskNodeCandidates) {
  if (-not (Test-Path -LiteralPath $taskCandidate)) { continue }
  $taskVersion = & $taskCandidate -p 'process.versions.node'
  if ([version]$taskVersion -ge [version]'24.0.0') { $taskNodePath = $taskCandidate; break }
}
if (-not $taskNodePath) { throw '请安装 Node.js 24 LTS 后重试：https://nodejs.org/' }
$env:PATH = (Split-Path -Parent $taskNodePath) + [IO.Path]::PathSeparator + $env:PATH
if ($Production -and (Test-Path -LiteralPath (Join-Path $taskRoot '.distribution.json'))) {
  foreach ($taskRequired in @('apps/server/dist/main.js', 'apps/server/dist/postgres-worker.js', 'apps/server/dist/migrate.js', 'apps/web/dist/index.html', 'scripts/prepare-runtime.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $taskRequired))) { throw '发布包文件不完整，请重新完整解压到一个新目录。' }
  }
  & $taskNodePath (Join-Path $PSScriptRoot 'prepare-runtime.mjs')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $taskRuntimePort = if ($env:PORT) { $env:PORT } else { '4318' }
  Write-Host ('书间已准备好。启动后打开 http://127.0.0.1:' + $taskRuntimePort + '；按 Ctrl+C 停止。') -ForegroundColor DarkGreen
  & $taskNodePath (Join-Path $taskRoot 'apps/server/dist/main.js')
  exit $LASTEXITCODE
}
$script:taskPnpmPath = $null
function Require-Pnpm {
  if ($script:taskPnpmPath) { return }
  $taskPnpmCandidates = @(
    (Join-Path $taskRoot '.runtime/pnpm.cmd'),
    (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd')
  )
  $taskInstalledPnpm = Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue
  if ($taskInstalledPnpm) { $taskPnpmCandidates += $taskInstalledPnpm.Source }
  foreach ($taskPnpmCandidate in ($taskPnpmCandidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $taskPnpmCandidate -PathType Leaf)) { continue }
    $taskPnpmVersion = & $taskPnpmCandidate --version 2>$null | Select-Object -Last 1
    if ($LASTEXITCODE -eq 0 -and "$taskPnpmVersion" -match '^11\.\d+\.\d+') {
      $script:taskPnpmPath = $taskPnpmCandidate
      # Build scripts also invoke pnpm; the child processes need the same command.
      $env:PATH = (Split-Path -Parent $taskPnpmCandidate) + [IO.Path]::PathSeparator + $env:PATH
      return
    }
  }
  throw '需要安装依赖或重新构建，但没有找到 pnpm 11。请安装 pnpm 11，或使用附带运行环境的 Windows 便携包。'
}
Write-Host '书间 · 正在检查本地依赖' -ForegroundColor DarkGreen
$taskDependencyPaths = @('apps/server/node_modules/fastify/package.json', 'apps/server/node_modules/pg/package.json')
if (-not $Production) { $taskDependencyPaths += @('apps/server/node_modules/tsx/dist/cli.mjs', 'apps/web/node_modules/vite/bin/vite.js') }
$taskDependenciesReady = $true
foreach ($taskDependencyPath in $taskDependencyPaths) {
  if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $taskDependencyPath))) { $taskDependenciesReady = $false }
}
if (-not $taskDependenciesReady) {
  Require-Pnpm
  & $taskPnpmPath install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请查看上方错误。' }
}
if ($Production) {
  $taskServerBuild = Join-Path $taskRoot 'apps/server/dist/main.js'
  $taskPostgresBuild = Join-Path $taskRoot 'apps/server/dist/postgres-worker.js'
  $taskMigrationBuild = Join-Path $taskRoot 'apps/server/dist/migrate.js'
  $taskWebBuild = Join-Path $taskRoot 'apps/web/dist/index.html'
  $taskRebuild = (-not (Test-Path -LiteralPath $taskServerBuild)) -or (-not (Test-Path -LiteralPath $taskWebBuild)) -or (-not (Test-Path -LiteralPath $taskPostgresBuild)) -or (-not (Test-Path -LiteralPath $taskMigrationBuild))
  if (-not $taskRebuild) {
    $taskBuildTime = (Get-Item -LiteralPath $taskServerBuild).LastWriteTimeUtc
    $taskSourceDirs = @('apps/server/src', 'apps/web/src', 'packages/contracts/src')
    foreach ($taskSourceDir in $taskSourceDirs) {
      if (Get-ChildItem -LiteralPath (Join-Path $taskRoot $taskSourceDir) -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $taskBuildTime } | Select-Object -First 1) { $taskRebuild = $true; break }
    }
    foreach ($taskConfig in @('pnpm-lock.yaml', 'package.json', 'apps/web/package.json', 'apps/server/package.json', 'apps/web/vite.config.ts', 'apps/server/tsup.config.ts')) {
      if ((Get-Item -LiteralPath (Join-Path $taskRoot $taskConfig)).LastWriteTimeUtc -gt $taskBuildTime) { $taskRebuild = $true }
    }
  }
  if ($taskRebuild) {
    Require-Pnpm
    Write-Host '正在构建书间，首次启动需要稍候。' -ForegroundColor DarkGreen
    & $taskPnpmPath install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '依赖校验失败。' }
    & $taskPnpmPath build
    if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上方错误。' }
  }
  $taskRuntimePort = if ($env:PORT) { $env:PORT } else { '4318' }
  Write-Host ('启动后打开 http://127.0.0.1:' + $taskRuntimePort + '；按 Ctrl+C 停止。') -ForegroundColor DarkGreen
  & $taskNodePath $taskServerBuild
} else {
  Write-Host '启动后打开 http://127.0.0.1:5173；按 Ctrl+C 停止。' -ForegroundColor DarkGreen
  & $taskNodePath (Join-Path $PSScriptRoot 'dev.mjs')
}
exit $LASTEXITCODE
