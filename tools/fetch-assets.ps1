<#
  下载桌宠的动画资源（50 个透明 WebM）到 <仓库>/assets/。

  为什么不随仓库分发：这些素材来自 dsh-whale-girl-pet（MIT），直接从 npm 拉更干净，
  仓库也不用背着 26MB 二进制。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/fetch-assets.ps1
    powershell ... -File tools/fetch-assets.ps1 -Version 0.3.1
#>
param(
  [string]$Version = '0.3.1',
  [string]$Registry = 'https://registry.npmjs.org'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $root 'assets'
New-Item -ItemType Directory -Force $dest | Out-Null

$pkg = 'dsh-whale-girl-pet'
$url = "$Registry/$pkg/-/$pkg-$Version.tgz"
$tgz = Join-Path $env:TEMP "$pkg-$Version.tgz"
$tmp = Join-Path $env:TEMP "$pkg-$Version-extract"

Write-Host "下载 $url"
Invoke-WebRequest -Uri $url -OutFile $tgz

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force $tmp | Out-Null
# Windows 10+ 自带 bsdtar，能直接解 tar.gz
tar -xzf $tgz -C $tmp

$thumb = Join-Path $tmp 'package\assets\thumb'
$preview = Join-Path $tmp 'package\assets\preview'
if (-not (Test-Path $thumb)) { throw "解压后没找到 assets/thumb —— 包结构变了？" }

Copy-Item (Join-Path $thumb '*.webm') $dest -Force
if (Test-Path $preview) { Copy-Item (Join-Path $preview '*') $dest -Force }

Remove-Item $tgz -Force
Remove-Item $tmp -Recurse -Force

$n = (Get-ChildItem $dest -Filter *.webm).Count
Write-Host "完成：$n 个动画已放入 $dest"
if ($n -lt 40) { Write-Warning "动画数量偏少（$n），请检查包版本" }
