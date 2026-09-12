<#
  关闭 / 恢复 DSH 网页界面里的那个桌宠（dsh-whale-girl-pet 插件注册到 shell.overlay 的浮动层），
  同时**保留**它附带的两个费用 pill 和设置页里的「桌宠配置」一节。

  原理：插件在 lib/client.js 的 apply() 里往四个槽位注册：
      shell.overlay                          ← 网页版桌宠（要关的就是这个）
      settings.section                       ← 设置页一节（保留）
      conversation.composer.dock             ← 会话费用 pill（保留）
      conversation.chat.assistant-actions    ← 本轮费用 pill（保留）
  槽位名改成永远不会被声明的 'shell.overlay.__disabled__'，这一处注册就自然不生效，
  其余三处原样不动 —— 只改一个词，语法安全，随时可还原。

  ⚠️ 插件重装或升级会覆盖这个改动，需要重新跑一次本脚本。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/web-pet-toggle.ps1 -Off
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/web-pet-toggle.ps1 -On
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/web-pet-toggle.ps1 -Status
#>
param(
  [switch]$Off,
  [switch]$On,
  [switch]$Status,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$target = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\dsh-whale-girl-pet\lib\client.js"
$OLD = "ctx.slots.inject('shell.overlay',"
$NEW = "ctx.slots.inject('shell.overlay.__disabled__',"

if (-not (Test-Path $target)) {
  Write-Host "找不到插件文件：$target"
  Write-Host "（插件可能没装，或 profile 名不对）"
  exit 1
}

function Get-Text { param($p) [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }

function Write-Text { param($p, $t)
  # 写临时文件再替换：pnpm 的 node_modules 是硬链，就地写会改到 store 里的原件
  $tmp = "$p.tmp"
  [System.IO.File]::WriteAllText($tmp, $t, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item $tmp $p -Force
}

$txt = Get-Text $target
$disabled = $txt.Contains($NEW)

if ($Status -or (-not $Off -and -not $On)) {
  $pillMark = "ctx.slots.inject('conversation.composer.dock'"
  $state = if ($disabled) { '已关闭' } else { '开着' }
  $pill = if ($txt.Contains($pillMark)) { '在' } else { '不在' }
  Write-Host "网页版桌宠：$state"
  Write-Host "费用 pill  : $pill"
  Write-Host "文件：$target"
  exit 0
}

if ($Off) {
  if ($disabled) { Write-Host '已经是关闭状态，无需改动'; exit 0 }
  $n = ([regex]::Matches($txt, [regex]::Escape($OLD))).Count
  if ($n -ne 1) { Write-Host "预期目标代码出现 1 次，实际 $n 次 —— 插件结构可能变了，未改动"; exit 1 }
  Copy-Item $target "$target.orig" -Force
  Write-Text $target $txt.Replace($OLD, $NEW)
  Write-Host '网页版桌宠已关闭（费用 pill 保留）'
  Write-Host '重启 DSH 生效。还原用 -On'
  exit 0
}

if ($On) {
  $orig = "$target.orig"
  if (Test-Path $orig) {
    Copy-Item $orig $target -Force
    Write-Host '已从备份还原原文件'
  } elseif ($disabled) {
    Write-Text $target $txt.Replace($NEW, $OLD)
    Write-Host '已还原（把槽位名改回去）'
  } else {
    Write-Host '本来就是开着的，无需改动'
    exit 0
  }
  Write-Host '重启 DSH 生效。'
}
