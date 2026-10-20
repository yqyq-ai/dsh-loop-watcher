# 重跑 dsh-loop-watcher 的全部回归验证（合并版）。
#
# 检测核心直接从插件的 client.js 里抽出来跑 —— 验证的就是插件里真在跑的那份代码。
# 被测对象：合并后的 dsh-loop-watcher（本目录的上一级）
#
# 五段：
#   1) 抽出检测核心（extract-core.mjs）
#   2) 判据回归（对真实会话数据，含正负样本）
#   3) 运行期逻辑回归（snapshot 提取 / 整条链路 / 交接指令 / 打断计数）
#   4) 计数徽章运行时回归（真实执行 client.js + 替身 React 渲染组件）
#   5) 交接功能回归（框架/菜单项/接手指令/预填时序/helper）
#
# ⚠️ 本文件含中文，必须保持 UTF-8 **带 BOM**（PowerShell 5.1 否则按 GBK 误读）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File 验证\verify.ps1
#   （或双击 跑验证.cmd）

$ErrorActionPreference = 'Stop'

# Node 解析顺序：① PATH 里的 node ② 常见安装位置 ③ DSH 自带运行时里的 node。
# **不写死某台机器的绝对路径** —— 那是开源时的常见硬伤（作者机器能跑，别人全跑不了）。
# 第 ③ 条很重要：只装 DSH 而不单独装 Node 的用户很常见，DSH 会把 node 放在
# `~/.dsh/dsh-runtimes/*/dependencies/node/bin/` 下，那里通常不在 PATH 里。
$node = $null
$candidate = Get-Command node -ErrorAction SilentlyContinue
if ($candidate) {
  $node = $candidate.Source
} else {
  $fallbacks = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe"
  )
  foreach ($path in $fallbacks) {
    if ($path -and (Test-Path -LiteralPath $path)) { $node = $path; break }
  }
  # DSH 自带运行时（按目录名排序取最新一个）
  if (-not $node) {
    $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
    if (Test-Path -LiteralPath $runtimes) {
      $found = Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'dependencies\node\bin\node.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
      if ($found) { $node = $found }
    }
  }
}
if (-not $node) {
  Write-Host '找不到 Node.js。请先安装 Node 22+（https://nodejs.org），或把它加进 PATH。'
  exit 1
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# 仓库根目录**就是插件本体**（有 package.json），验证目录是它的子目录。
$plugin = Split-Path -Parent $here
$client = Join-Path $plugin 'lib\client.js'
$core = Join-Path $here '校准\core-from-client.mjs'

if (-not (Test-Path -LiteralPath $client)) { Write-Host "找不到插件：$client"; exit 1 }

# 统计各段实际输出的断言条数（每段的 check() 打一条 `  ok  ` 或 `✓`）。
# 为什么要统计：五段不共用计数器，README 里写「共 N 条」时如果只抄第 5 段的
# `通过 N 项`，就会把别的段整个漏掉（这是真实发生过的错误）。
$assertCount = @{}
function Invoke-Stage {
  param([string]$Stage, [scriptblock]$Run)
  $out = & $Run 2>&1
  $out | ForEach-Object { Write-Host $_ }
  $script:assertCount[$Stage] = (@($out) | Where-Object { "$_" -match '^\s*(ok|\u2713)\s' }).Count
}

Write-Host "使用 Node: $node"
Write-Host '=== 1/5 从插件里抽出检测核心 ==='
& $node (Join-Path $here 'extract-core.mjs') $client $core
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '=== 2/5 判据回归（对真实会话数据，含正负样本） ==='
Invoke-Stage -Stage '2' -Run { & $node (Join-Path $here 'verify-detect.mjs') --core $core }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '=== 3/5 运行期逻辑回归（snapshot 提取 / 整条链路 / 交接指令 / 打断计数） ==='
Invoke-Stage -Stage '3' -Run { & $node (Join-Path $here 'verify-runtime.mjs') --core $core }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '=== 4/5 计数徽章运行时回归（真实执行 client.js + 替身 React 渲染组件） ==='
Invoke-Stage -Stage '4' -Run { & $node (Join-Path $here 'verify-badge.mjs') $client }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '=== 5/5 交接功能回归（框架 / 菜单项 / 接手指令 / 预填时序 / 隐形 helper） ==='
Invoke-Stage -Stage '5' -Run { & $node (Join-Path $here '验证-handover.mjs') $client }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
$total = 0
foreach ($k in '2','3','4','5') {
  if ($assertCount.ContainsKey($k)) {
    $n = $assertCount[$k]
    Write-Host ("第 {0} 段：{1} 条断言" -f $k, $n)
    $total += $n
  }
}
Write-Host ("合计：{0} 条断言" -f $total)
Write-Host ''
Write-Host '全部验证通过。'
