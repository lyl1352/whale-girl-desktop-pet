# 鲸鱼娘桌面宠 · 守护脚本
#
# 作用：保证桌宠一直在。
#   - 登录时由启动文件夹的 .cmd 拉起（也可被 WMI 创建，从而脱离 DSH 进程树）
#   - 之后每 20 秒检查一次；发现桌宠进程不在就把它拉起来
#
# 【重要】互斥量必须用 try/catch 包住：
# 上一个守护被强杀（Stop-Process -Force）时，全局互斥量会进入"被遗弃"
# （abandoned）状态，此时 .NET 的 WaitOne 会**抛 AbandonedMutexException**
# 而不是返回 true。不接这个异常的话，新守护会一启动就异常退出 —— 表现就是
# "守护被杀过一次之后，桌宠再也起不来了"。

$exe = 'C:\Users\PC\whale-pet-desktop\electron\electron.exe'
$app = 'C:\Users\PC\whale-pet-desktop'
$log = 'C:\Users\PC\.whale-pet-desktop\watchdog.log'

function Write-Log($msg) {
  try {
    $dir = Split-Path $log -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  [pid=$PID] $msg" | Add-Content -Path $log -Encoding UTF8
  } catch { }
}

function Get-Pet {
  Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exe }
}

Write-Log 'watchdog process started'

# 单实例：全局互斥锁（若上一个被强杀，则接管）
$mutex = New-Object System.Threading.Mutex($false, 'Global\WhalePetWatchdog')
$got = $false
try {
  $got = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  Write-Log 'previous watchdog was killed (abandoned mutex) -> taking over'
  $got = $true
} catch {
  Write-Log ("mutex check failed, taking over anyway: " + $_.Exception.Message)
  $got = $true
}
if (-not $got) {
  Write-Log 'another watchdog is running -> exit'
  exit
}

Write-Log 'watchdog running'

# 轮询间隔：头几轮密一点，之后放慢
$interval = 15
while ($true) {
  try {
    if (-not (Get-Pet)) {
      Start-Process -FilePath $exe -ArgumentList "`"$app`"" -WindowStyle Hidden
      Write-Log 'pet not running -> started'
    }
  } catch {
    Write-Log ("start failed: " + $_.Exception.Message)
  }
  Start-Sleep -Seconds $interval
  if ($interval -lt 20) { $interval = 20 }
}
