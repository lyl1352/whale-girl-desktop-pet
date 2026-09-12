<#
  下载 Electron 运行时到 <仓库>/electron/。

  默认走 npmmirror 国内镜像（GitHub Releases 在国内经常连不上）。
  想换成官方源就把 -Mirror 换成 https://github.com/electron/electron/releases/download/。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/fetch-electron.ps1
    powershell ... -File tools/fetch-electron.ps1 -Version v43.3.0
#>
param(
  [string]$Version = 'v43.3.0',
  [string]$Mirror  = 'https://registry.npmmirror.com/-/binary/electron'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$zip  = Join-Path $root 'electron.zip'
$dest = Join-Path $root 'electron'

$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'ia32' }
$url  = "$Mirror/$Version/electron-$Version-win32-$arch.zip"

Write-Host "下载 $url"
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $zip

Write-Host "解压到 $dest"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force $dest | Out-Null
# Windows 10+ 自带 bsdtar，能直接解 zip
tar -xf $zip -C $dest

Remove-Item $zip -Force
if (Test-Path (Join-Path $dest 'electron.exe')) {
  Write-Host "完成：$dest\electron.exe"
} else {
  Write-Error '解压后没找到 electron.exe'
}
