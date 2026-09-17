/**
 * 鲸鱼娘桌面宠 · DSH 启动器
 *
 * 作用：DSH 一起来就把桌宠拉起来，之后每分钟确认一次，保证它常驻。
 * 这样"打开 DSH，桌宠就在"，而且 DSH 重启之后它会跟着回来。
 *
 * 桌宠自己有单实例锁，所以重复启动是安全的（第二个会立刻退出）。
 *
 * ⚠️ 有一个例外必须尊重：桌宠检测到全屏游戏时会**主动退出**（省内存），
 *    退出前往 ~/.whale-pet-desktop/game-running.json 写一个标记，里面是
 *    那个游戏进程的 PID。这里每次要拉她之前先看这个标记：游戏还活着就别拉，
 *    免得"刚退出去 60 秒又被拉回来"。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'whale-pet-launcher'
export const inject = []

const APP_DIR = 'C:\\Users\\PC\\whale-pet-desktop'
const EXE = join(APP_DIR, 'electron', 'electron.exe')
const LOG_DIR = join(homedir(), '.whale-pet-desktop')
const LOG = join(LOG_DIR, 'launcher.log')
const GAME_MARK = join(LOG_DIR, 'game-running.json')
const MAX_SUPPRESS_MS = 6 * 60 * 60 * 1000   // 兜底：超过 6 小时不再抑制（防 PID 复用卡死）

function log(msg) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch { /* ignore */ }
}

/** 游戏还在跑吗？是的话别拉桌宠。 */
function gameStillRunning() {
  let mark
  try {
    mark = JSON.parse(readFileSync(GAME_MARK, 'utf8'))
  } catch {
    return false   // 没有标记 / 读不了 —— 正常拉起
  }
  if (!mark || !mark.pid) {
    try { rmSync(GAME_MARK, { force: true }) } catch { /* ignore */ }
    return false
  }
  if (Date.now() - (mark.at || 0) > MAX_SUPPRESS_MS) {
    log('game mark expired -> clear')
    try { rmSync(GAME_MARK, { force: true }) } catch { /* ignore */ }
    return false
  }
  // signal 0 只探活，不发信号
  try {
    process.kill(mark.pid, 0)
    return true
  } catch {
    log('game pid ' + mark.pid + ' gone -> clear mark')
    try { rmSync(GAME_MARK, { force: true }) } catch { /* ignore */ }
    return false
  }
}

function launch() {
  try {
    if (!existsSync(EXE)) return
    if (gameStillRunning()) return   // 全屏游戏期间：她该歇着
    const child = spawn(EXE, [APP_DIR], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* 拉不起来也不该影响 DSH */ }
}

export function apply(ctx) {
  launch()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(launch, 60000)
      return () => clearInterval(timer)
    }, 'whale-pet-launcher: keep desktop pet alive')
  } else {
    setInterval(launch, 60000)
  }
}
