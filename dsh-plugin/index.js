/**
 * 鲸鱼娘桌面宠 · DSH 启动器
 *
 * 作用：DSH 一起来就把桌宠拉起来，之后每分钟确认一次，保证它常驻。
 * 这样"打开 DSH，桌宠就在"，而且 DSH 重启之后它会跟着回来。
 *
 * 桌宠自己有单实例锁，所以重复启动是安全的（第二个会立刻退出）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'whale-pet-launcher'
export const inject = []

const APP_DIR = 'C:\\Users\\PC\\whale-pet-desktop'
const EXE = join(APP_DIR, 'electron', 'electron.exe')
const LOG_DIR = join(homedir(), '.whale-pet-desktop')
const LOG = join(LOG_DIR, 'launcher.log')

function log(msg) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch { /* ignore */ }
}

function launch() {
  try {
    if (!existsSync(EXE)) return
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
