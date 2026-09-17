/**
 * 鲸鱼娘桌面宠 · Electron 主进程（原版直跑版）
 *
 * 思路：不改写原版行为，而是给原版浏览器半侧（vendor/dsh-whale-girl-pet.client.js）
 * 提供一个最小 DSH 宿主——本机 HTTP 服务器 + 槽位/设置/状态接口——然后把窗口铺满
 * 整个工作区、整页透明。这样原版的 fixed 定位、拖拽、屏幕漫游都天然作用于整块桌面，
 * 视觉与行为跟网页版逐字一致。
 *
 * 鼠标穿透：整窗默认穿透，只在光标落进「宠物/按钮/气泡」的矩形时才临时恢复可点。
 */
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, shell, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const petServer = require('./pet-server.js')
const petApi = require('./pet-api.js')
const usageSource = require('./usage-source.js')

const ASSETS = path.join(__dirname, 'assets')
const CONF_DIR = path.join(os.homedir(), '.whale-pet-desktop')
const CONF = path.join(CONF_DIR, 'config.json')
const HOTKEY = 'CommandOrControl+Alt+W'

let win = null
let tray = null
let server = null
let apiCtl = null
let menuOpen = false
let interactive = false
let petRects = []
let rectTimer = null
let saveTimer = null

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function readConfig() {
  try {
    const raw = fs.readFileSync(CONF, 'utf8').replace(/^\uFEFF/, '')
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}
function writeConfig(patch) {
  try {
    fs.mkdirSync(CONF_DIR, { recursive: true })
    fs.writeFileSync(CONF, JSON.stringify(Object.assign({}, readConfig(), patch), null, 2), 'utf8')
  } catch { /* ignore */ }
}

/** 给原版的设置对象：默认值 + 用户覆盖（键名与契约 Config 一致）。 */
function getSettings() {
  const cfg = readConfig()
  const out = Object.assign({}, petApi.SETTING_DEFAULTS)
  for (const k of Object.keys(petApi.SETTING_DEFAULTS)) {
    if (cfg[k] !== undefined) out[k] = cfg[k]
  }
  // 兼容早期字段名
  if (!out.city && cfg.weatherCity) out.city = cfg.weatherCity
  return out
}
function setSettings(patch) {
  writeConfig(patch)
}

// ---------------------------------------------------------------------------
// 鼠标穿透：只在宠物/按钮/气泡的矩形上可点
// ---------------------------------------------------------------------------
function syncInteractive() {
  if (!win || win.isDestroyed()) return
  // screen.getCursorScreenPoint() 与 win.getBounds() 都是 DIP，不要做缩放换算
  const b = win.getBounds()
  const p = screen.getCursorScreenPoint()
  const x = p.x - b.x
  const y = p.y - b.y
  const inside = petRects.some((r) => {
    const l = r.length >= 5 ? r[1] : r[0]
    const t = r.length >= 5 ? r[2] : r[1]
    const rr = r.length >= 5 ? r[3] : r[2]
    const bb = r.length >= 5 ? r[4] : r[3]
    return x >= l - 2 && x <= rr + 2 && y >= t - 2 && y <= bb + 2
  })
  if (inside === interactive) return
  interactive = inside
  win.setIgnoreMouseEvents(!inside, { forward: true })
}

// ---------------------------------------------------------------------------
// 漫游模式：全屏 or 小窗
//
// 背景：窗口铺满整屏 + 置顶时，一旦变可交互，Chromium 会判定 DSH 窗口被完全遮挡
// 并停止绘制它（用户看到"DSH 暂停"）。给 DSH 加 --disable-features=
// CalculateNativeWinOcclusion 就能关掉这个检测，从而恢复全屏漫游。
//
// 所以：检测运行中的 DSH 有没有带这个参数 —— 带了就全屏漫游，没带就退回小窗。
// 没带时会定期复查（你重启 DSH 之后桌宠会自己切回全屏，不用手动改）。
// ---------------------------------------------------------------------------
let fullscreenRoam = false
let roamTimer = null
let dshRect = null   // DSH 主窗口（DIP），从 DSH 自己的状态文件读

/** 运行中的 DSH 有没有带 --disable-features=CalculateNativeWinOcclusion。 */
function dshOcclusionFlag() {
  try {
    const out = require('node:child_process').execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name='DSH Desktop.exe'\" | Where-Object { $_.CommandLine -notlike '*--type=*' })[0].CommandLine"],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    return /CalculateNativeWinOcclusion/i.test(String(out))
  } catch {
    return false
  }
}

/**
 * DSH 主窗口位置。
 * 直接用 DSH 自己写的 main-window-state.json（纯文件读取，不用 PowerShell 取窗口矩形），
 * 单位是 DIP，和 win.setBounds() 同一套坐标。
 */
function dshWindowState() {
  try {
    const p = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'DSH Desktop', 'main-window-state.json',
    )
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const b = j && j.bounds
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.width)) return null
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  } catch {
    return null
  }
}

function applyWindowBounds() {
  if (!win || win.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  let W, H, x, y
  let how

  if (fullscreenRoam) {
    W = wa.width; H = wa.height; x = wa.x; y = wa.y
    how = '全屏'
  } else if (dshRect) {
    // 尽量铺满，但保证**不完全覆盖** DSH 窗口：Chromium 只在窗口被完全遮挡时
    // 才停止绘制它。于是把左边缘（或上边缘）推到 DSH 左边缘（上边缘）之后一点。
    const GAP = 16
    const byLeft = { x: dshRect.x + GAP, y: wa.y, W: wa.x + wa.width - (dshRect.x + GAP), H: wa.height }
    const byTop = { x: wa.x, y: dshRect.y + GAP, W: wa.width, H: wa.y + wa.height - (dshRect.y + GAP) }
    const pick = (byLeft.W * byLeft.H) >= (byTop.W * byTop.H) ? byLeft : byTop
    W = Math.max(360, pick.W); H = Math.max(280, pick.H); x = pick.x; y = pick.y
    how = '避让 DSH 的最大区域'
  } else {
    W = Math.min(960, Math.max(480, Math.floor(wa.width * 0.55)))
    H = Math.min(720, Math.max(420, Math.floor(wa.height * 0.66)))
    x = wa.x + wa.width - W - 16
    y = wa.y + wa.height - H - 16
    how = '保守小窗'
  }

  const b = win.getBounds()
  if (b.width === W && b.height === H && b.x === x && b.y === y) return
  win.setBounds({ x, y, width: W, height: H })
  console.log('[whale-pet] window -> ' + W + 'x' + H + ' @(' + x + ',' + y + ')  (' + how + ')')
}

function syncRoamMode() {
  const forcedSafe = readConfig().roamFullscreen === false
  dshRect = dshWindowState()
  fullscreenRoam = !forcedSafe && dshOcclusionFlag()
  applyWindowBounds()
  buildTrayMenu()

  // 还没拿到「全屏」许可就一直复查：从快捷方式重启 DSH 之后会自动扩到全屏
  if (!fullscreenRoam && !roamTimer) {
    roamTimer = setInterval(() => {
      dshRect = dshWindowState()
      if (dshOcclusionFlag() && readConfig().roamFullscreen !== false) {
        fullscreenRoam = true
        applyWindowBounds()
        buildTrayMenu()
        clearInterval(roamTimer); roamTimer = null
      }
    }, 60000)
  }
}

// ---------------------------------------------------------------------------
// 全屏游戏自动隐藏
//
// 置顶浮窗会盖在全屏游戏上，所以检测到"有程序铺满整个显示器"时把她藏起来。
//
// 判定用前台窗口矩形 vs 它所在显示器的矩形：完全覆盖 = 全屏。
// 这样无边框全屏（窗口矩形正好等于显示器，多数现代游戏都是这种）也能认出来；
// 而"最大化的窗口"只覆盖工作区、盖不住任务栏，不会误判。
//
// 走 koffi（纯 N-API 的 FFI）直接调 user32，微秒级、不启进程、不写脚本，
// 不会触发杀软那套"隐藏 PowerShell"启发式。koffi 没装就优雅降级（不自动隐藏）。
// ---------------------------------------------------------------------------
const FULLSCREEN_POLL_MS = 2000
let fullscreenTimer = null
let fullscreenHidden = false
let fsProbe
let fsProbeTried = false
let lastFsDescribe = ''

/** 只初始化一次（koffi 的 struct 注册是全局的，重复注册会抛 Duplicate type name）。 */
function getFsProbe() {
  if (!fsProbeTried) {
    fsProbeTried = true
    fsProbe = initFullscreenProbe()
  }
  return fsProbe
}

function initFullscreenProbe() {
  let koffi
  try {
    koffi = require('koffi')
  } catch {
    console.log('[whale-pet] 没装 koffi，全屏自动隐藏不可用（npm install 后可用）')
    return null
  }
  try {
    // 注意：结构体里引用另一个结构体要用**变量**，写名字会报 Unknown type name
    const RECT = koffi.struct('WhalePetRect', {
      left: 'long', top: 'long', right: 'long', bottom: 'long',
    })
    const MONITORINFO = koffi.struct('WhalePetMonitorInfo', {
      cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32',
    })
    const user32 = koffi.load('user32.dll')
    const GetForegroundWindow = user32.func('void* GetForegroundWindow()')
    const IsWindowVisible = user32.func('bool IsWindowVisible(void* h)')
    // 函数签名里必须写**注册时用的名字**（WhalePetRect / WhalePetMonitorInfo）
    const GetWindowRect = user32.func('bool GetWindowRect(void* h, _Out_ WhalePetRect* r)')
    const MonitorFromWindow = user32.func('void* MonitorFromWindow(void* h, uint32 flags)')
    const GetMonitorInfoW = user32.func('bool GetMonitorInfoW(void* mon, _Inout_ WhalePetMonitorInfo* mi)')
    const miSize = koffi.sizeof(MONITORINFO)

    const own = new Set()
    const collectOwn = () => {
      own.clear()
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          const h = w.getNativeWindowHandle()
          own.add(h.readBigUInt64LE ? h.readBigUInt64LE(0).toString() : String(h.readUInt32LE(0)))
        } catch { /* ignore */ }
      }
    }

    return {
      isForegroundFullscreen() {
        const h = GetForegroundWindow()
        if (!h) return false
        if (!IsWindowVisible(h)) return false
        collectOwn()
        if (own.has(String(h))) return false          // 别把自己判成全屏
        const r = {}
        if (!GetWindowRect(h, r)) return false
        const mon = MonitorFromWindow(h, 2)           // MONITOR_DEFAULTTONEAREST
        if (!mon) return false
        const mi = { cbSize: miSize }
        if (!GetMonitorInfoW(mon, mi)) return false
        const m = mi.rcMonitor
        return r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
      },
      /** 诊断用：把最近一次探测的原始数据描述出来 */
      describe() {
        const h = GetForegroundWindow()
        if (!h) return 'no foreground'
        const r = {}
        GetWindowRect(h, r)
        const mon = MonitorFromWindow(h, 2)
        const mi = { cbSize: miSize }
        GetMonitorInfoW(mon, mi)
        const m = mi.rcMonitor
        collectOwn()
        return `hwnd=${h} own=${own.has(String(h))} visible=${IsWindowVisible(h)}`
          + ` rect=${r.left},${r.top}-${r.right},${r.bottom} mon=${m.left},${m.top}-${m.right},${m.bottom}`
      },
    }
  } catch (e) {
    console.log('[whale-pet] 全屏探测初始化失败: ' + (e && e.message))
    return null
  }
}

function autoHideEnabled() {
  return readConfig().autoHideFullscreen !== false   // 默认开
}

function applyFullscreenState(full) {
  if (!win || win.isDestroyed()) return
  if (full && !fullscreenHidden) {
    fullscreenHidden = true
    win.hide()
    console.log('[whale-pet] 检测到全屏程序 -> 隐藏桌宠')
  } else if (!full && fullscreenHidden) {
    fullscreenHidden = false
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    console.log('[whale-pet] 全屏结束 -> 显示桌宠')
  }
}

function startFullscreenWatch() {
  if (fullscreenTimer) return
  fsProbe = getFsProbe()
  if (!fsProbe) return
  fullscreenTimer = setInterval(() => {
    try {
      const full = autoHideEnabled() && fsProbe.isForegroundFullscreen()
      if (process.env.PET_DEV) {
        const d = fsProbe.describe ? fsProbe.describe() : ''
        if (d !== lastFsDescribe) { lastFsDescribe = d; console.log('[whale-pet] fs: ' + d) }
      }
      applyFullscreenState(full)
    } catch (e) {
      if (process.env.PET_DEV) console.log('[whale-pet] fs poll error: ' + (e && e.message))
    }
  }, FULLSCREEN_POLL_MS)
}

// ---------------------------------------------------------------------------
// 开机自启
//
// ⚠️ 历史教训：最早这里是「启动文件夹放一个 .cmd → 用 powershell.exe
//    -ExecutionPolicy Bypass -WindowStyle Hidden 拉起 watchdog.ps1」。
//    这套组合是杀软启发式里最经典的恶意特征（启动项 + 隐藏 PowerShell），
//    实测被火绒直接删掉了开机项，而且守护进程每次启动都被按掉。
//
// 现在改成用 Electron 自带的 shell.writeShortcutLink 生成一个 .lnk，
// 直接指向 electron.exe —— 启动链上完全没有 PowerShell。
// 崩溃自愈交给 DSH 端那个启动插件（DSH 启动时拉起 + 每分钟确认），
// watchdog.ps1 仅保留在仓库里供手动使用。
// ---------------------------------------------------------------------------
const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
)
const STARTUP_LNK = path.join(STARTUP_DIR, '鲸鱼娘桌面宠.lnk')
const LEGACY_STARTUP_CMD = path.join(STARTUP_DIR, '鲸鱼娘桌面宠.cmd')

function autostartOn() {
  try { return fs.existsSync(STARTUP_LNK) } catch { return false }
}
function setAutostart(on) {
  try {
    fs.mkdirSync(STARTUP_DIR, { recursive: true })
    if (on) {
      const ok = shell.writeShortcutLink(STARTUP_LNK, 'create', {
        target: process.execPath,                  // electron.exe
        args: '"' + __dirname + '"',
        cwd: __dirname,
        description: '鲸鱼娘桌面宠',
      })
      if (!ok) throw new Error('writeShortcutLink 返回 false')
    } else {
      fs.rmSync(STARTUP_LNK, { force: true })
    }
    // 老版本留下的 .cmd 一并清掉
    try { fs.rmSync(LEGACY_STARTUP_CMD, { force: true }) } catch { /* ignore */ }
    console.log('[whale-pet] autostart=' + on)
  } catch (e) {
    console.log('[whale-pet] autostart failed: ' + (e && e.message))
  }
  buildTrayMenu()
}

// ---------------------------------------------------------------------------
// 充值：打开充值页 → 盯「实充金额」→ 真的到账了才让她吃零食
//
// 判据用 topped_up_balance（实充部分），**不是** total_balance：
//   total 会被赠送额度刷新影响，会误判成充值；
//   topped 只在真充钱时增加，用量消耗与赠送刷新都不影响它。
// 检测到增加后再复读一次确认（避免接口抖动误报），确认后才播动画。
//
// 动画本身不用改原版：原版「投喂」按钮的行为正是「吃小鱼干」，
// 程序化点一下即可；外壳额外画一个气泡说明到账金额。
// ---------------------------------------------------------------------------
const TOPUP_WATCH_MS = 15 * 60 * 1000   // 最多盯 15 分钟
const TOPUP_POLL_MS = 10 * 1000         // 每 10 秒查一次
// 菜单里的「DeepSeek 官网」入口。
// 注：之前这里指向 http://127.0.0.1:43120（DSH 桌面端自己的 GUI 服务），
// 那个服务带"浏览器信任围栏"，普通浏览器打开一律 403，所以改成官网。
const DEEPSEEK_SITE = 'https://www.deepseek.com'
let topUpTimer = null

function stopTopUpWatch() {
  if (topUpTimer) { clearInterval(topUpTimer); topUpTimer = null }
}

/**
 * @param {number} [offsetForTest] 仅调试用：把基准压低这么多，用来在真实链路上验证检测
 */
async function startTopUp(offsetForTest) {
  stopTopUpWatch()
  let base
  try {
    base = await petApi.fetchBalanceTotal()
  } catch (e) {
    console.log('[whale-pet] topup: 拿不到基准余额（' + ((e && e.message) || e) + '）')
    return
  }
  const baseline = base.topped - (offsetForTest || 0)
  console.log('[whale-pet] topup watch start, topped=' + base.topped + ' baseline=' + baseline
    + ' total=' + base.total)
  const started = Date.now()
  let confirming = false
  topUpTimer = setInterval(async () => {
    if (Date.now() - started > TOPUP_WATCH_MS) {
      stopTopUpWatch()
      console.log('[whale-pet] topup watch timeout')
      return
    }
    if (confirming) return
    let now
    try {
      now = await petApi.fetchBalanceTotal()
    } catch {
      return // 网络抖动：不算数，下一轮再试
    }
    if (!(now.topped > baseline + 0.009)) return

    // 检测到实充增加 —— 复读一次确认，防止接口抖动误报
    confirming = true
    try {
      await new Promise((r) => setTimeout(r, 2500))
      const again = await petApi.fetchBalanceTotal()
      if (!(again.topped > baseline + 0.009)) {
        console.log('[whale-pet] topup: 复读未确认，忽略（' + again.topped + ' vs ' + baseline + '）')
        confirming = false
        return
      }
      const delta = Math.round((again.topped - baseline) * 100) / 100
      stopTopUpWatch()
      console.log('[whale-pet] topup confirmed +' + delta
        + '（实充 ' + again.topped + '，总额 ' + again.total + '）')
      if (win && !win.isDestroyed()) win.webContents.send('recharge', { delta, total: again.total })
    } catch {
      confirming = false
    }
  }, TOPUP_POLL_MS)
}

/** 菜单入口：打开充值页，再开始盯。 */
function openTopUpPage() {
  shell.openExternal('https://platform.deepseek.com/top_up')
  startTopUp()
}

// ---------------------------------------------------------------------------
// 托盘 / 右键菜单 / 快捷键
// ---------------------------------------------------------------------------
/** 托盘菜单与「桌宠右键菜单」共用同一份模板。 */
function menuTemplate() {
  return [
    { label: '🐋 鲸鱼娘桌面宠', enabled: false },
    { type: 'separator' },
    { label: '桌宠设置…（天气城市等）', click: () => openSettingsWindow() },
    { label: '💰 充值 DeepSeek…（到账她会吃零食）', click: () => openTopUpPage() },
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!win) return
        if (win.isVisible()) win.hide()
        else { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver') }
      },
    },
    { type: 'separator' },
    {
      label: fullscreenRoam
        ? '漫游范围：全屏（DSH 已关闭遮挡检测）'
        : '漫游范围：小窗（DSH 未带 --disable-features=CalculateNativeWinOcclusion）',
      type: 'checkbox',
      checked: fullscreenRoam,
      click: () => {
        writeConfig({ roamFullscreen: fullscreenRoam ? false : true })
        syncRoamMode()
        applyWindowBounds()
        buildTrayMenu()
      },
    },
    { label: '鼠标穿透开关（' + HOTKEY.replace('CommandOrControl', 'Ctrl') + '）', click: () => toggleClickThrough() },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: autostartOn(), click: () => setAutostart(!autostartOn()) },
    {
      label: '全屏游戏时自动隐藏',
      type: 'checkbox',
      checked: autoHideEnabled(),
      enabled: !!getFsProbe(),
      click: () => {
        writeConfig({ autoHideFullscreen: !autoHideEnabled() })
        if (getFsProbe() && !fullscreenTimer) startFullscreenWatch()
        buildTrayMenu()
      },
    },
    { label: '🌐 DeepSeek 官网', click: () => shell.openExternal(DEEPSEEK_SITE) },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]
}

function buildTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
}

/** 在桌宠身上右键弹出的菜单（设置面板的主要入口之一）。 */
function showPetMenu() {
  if (!win || win.isDestroyed()) return
  const menu = Menu.buildFromTemplate(menuTemplate())
  try {
    menu.popup({ window: win })
  } catch {
    try { menu.popup({}) } catch { /* ignore */ }
  }
}

let forceThrough = false
function toggleClickThrough() {
  forceThrough = !forceThrough
  interactive = false
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(forceThrough, { forward: true })
}

function setupTray() {
  const iconPath = path.join(ASSETS, 'tray.png')
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('鲸鱼娘桌面宠')
  buildTrayMenu()
  tray.on('click', () => {
    if (!win) return
    if (win.isVisible()) win.hide()
    else { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver') }
  })
  console.log('[whale-pet] tray ready')
}

function setupShortcut() {
  const ok = globalShortcut.register(HOTKEY, () => toggleClickThrough())
  console.log('[whale-pet] hotkey registered=' + ok)
}

// ---------------------------------------------------------------------------
// 设置窗：原版设置面板挂在 settings.section 槽位，桌面版用独立窗口承载它
// ---------------------------------------------------------------------------
let settingsWin = null
function openSettingsWindow() {
  if (!server) return
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show(); settingsWin.focus(); return
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 380,
    minHeight: 420,
    title: '桌宠设置',
    backgroundColor: '#f6f9ff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  settingsWin.loadURL(server.origin + '/?view=settings')
  // 不用 ready-to-show（实测不可靠，窗口会一直藏着）
  settingsWin.webContents.once('did-finish-load', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return
    if (settingsWin.isMinimized()) settingsWin.restore()
    // 页面 <title> 会覆盖窗口标题，这里改回来
    settingsWin.setTitle('桌宠设置')
    settingsWin.show()
    settingsWin.focus()
  })
  settingsWin.on('closed', () => { settingsWin = null })
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow(origin) {
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 960,
    height: 720,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 点它不抢焦点（WS_EX_NOACTIVATE），否则 DSH 会失焦
    focusable: false,
    show: false,
    title: '鲸鱼娘桌面宠',
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 尺寸按配置拼进 URL 传给渲染进程（原版把 size 读进闭包，外壳靠 config prop 覆盖它）
  {
    const s = Number(readConfig().size)
    const q = Number.isFinite(s) && s > 0 ? '?size=' + Math.round(s) : ''
    win.loadURL(origin + '/' + q)
  }
  win.once('ready-to-show', () => { win.showInactive(); applyWindowBounds() })
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('hint', 'ready')
  })
  // 默认整窗穿透，等渲染进程报来宠物矩形后按需恢复可点
  win.setIgnoreMouseEvents(true, { forward: true })
  return win
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
ipcMain.on('pet:rects', (_e, boxes) => {
  if (Array.isArray(boxes)) petRects = boxes
})

// 配置读写（preload 里早就暴露了 setConfig / getConfig，但主进程一直没接 —— 调用会报
// "No handler registered"。补上，尺寸等设置要靠它落盘。）
ipcMain.handle('config', () => readConfig())
ipcMain.handle('setConfig', (_e, patch) => {
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) writeConfig(patch)
  return readConfig()
})

ipcMain.on('pet:contextmenu', () => {
  console.log('[whale-pet] contextmenu received')
  showPetMenu()
})

// 桌宠右键菜单（窗口内自绘）用到的状态与动作
ipcMain.handle('pet:state', () => ({
  fullscreenRoam,
  autostart: autostartOn(),
  forceThrough,
  clickThrough: readConfig().clickThrough === true,
  working: !!(apiCtl && apiCtl.watcher && apiCtl.watcher.isBusy()),
}))

ipcMain.on('pet:action', (_e, name) => {
  switch (name) {
    case 'settings': openSettingsWindow(); break
    case 'topup': openTopUpPage(); break
    case 'roam':
      writeConfig({ roamFullscreen: !fullscreenRoam })
      syncRoamMode()
      applyWindowBounds()
      buildTrayMenu()
      break
    case 'clickthrough': toggleClickThrough(); break
    case 'autostart': setAutostart(!autostartOn()); break
    case 'web': shell.openExternal(DEEPSEEK_SITE); break
    case 'quit': app.quit(); break
    default: break
  }
})

// 单实例：重复启动（守护重复拉起 / 用户重复双击）时直接退出，避免多个桌宠
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  }
})

app.whenReady().then(async () => {
  apiCtl = petApi.createApi({
    usage: (opts) => usageSource.getUsage(opts),
    todayTotals: () => usageSource.getTodayTotals(),
    activity: () => usageSource.lastActivity(),
    tailEvents: () => usageSource.getTailEvents(),
    summary: () => usageSource.getLastTurn(),
    getSettings,
    setSettings,
  })

  server = await petServer.start({
    root: __dirname,
    api: (req, res, url) => {
      // 开发调试钩子：默认关闭，只在 PET_DEV=1 时启用
      // （eval 能在页面里执行任意 JS，公开版本不能默认开着）
      if (process.env.PET_DEV) {
        // 调试：把充值基准压低 offset，走**完全真实的检测链路**（读接口 → 比对 → 复读确认 → 播动画）
        if (url.pathname === '/api/whale-pet/topup-watch-test') {
          const off = Number(url.searchParams.get('offset') || 1)
          startTopUp(off)
          const body = Buffer.from(JSON.stringify({ ok: true, offset: off }), 'utf8')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
          res.end(body)
          return true
        }
        // 调试：直接模拟一次到账事件（跳过检测，只测动画链路）
        if (url.pathname === '/api/whale-pet/simulate-recharge') {
          const delta = Number(url.searchParams.get('delta') || 50)
          if (win && !win.isDestroyed()) win.webContents.send('recharge', { delta, total: 100 + delta })
          const body = Buffer.from(JSON.stringify({ ok: true, delta }), 'utf8')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
          res.end(body)
          return true
        }
        // 调试：手动注入一条 mood（用来验证待机链/漫游，不用等真实回合结束）
        if (url.pathname === '/api/whale-pet/inject-mood') {
          const mood = url.searchParams.get('mood') === 'working' ? 'working' : 'idle'
          petApi.pushItem({ type: 'mood', mood })
          const body = Buffer.from(JSON.stringify({ ok: true, mood }), 'utf8')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
          res.end(body)
          return true
        }
        // 把渲染进程报来的「可交互矩形」吐出来，便于定位按钮
        if (url.pathname === '/api/whale-pet/rects') {
          const body = Buffer.from(JSON.stringify({ rects: petRects, interactive, forceThrough }), 'utf8')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
          res.end(body)
          return true
        }
        // 打开设置窗（等价于托盘菜单那项）
        if (url.pathname === '/api/whale-pet/open-settings') {
          openSettingsWindow()
          const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
          res.end(body)
          return true
        }
        // 在页面里执行一段 JS 并回传结果
        if (url.pathname === '/api/whale-pet/eval' && req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', async () => {
            let out
            try {
              out = { ok: true, result: await win.webContents.executeJavaScript(body, true) }
            } catch (e) {
              out = { ok: false, error: String((e && e.message) || e) }
            }
            const buf = Buffer.from(JSON.stringify(out), 'utf8')
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buf.length) })
            res.end(buf)
          })
          return true
        }
      }
      apiCtl.handle(req, res, url).then((handled) => {
        // handle 是 async：它自己会写响应；返回 false 说明这个路径它不认识
        if (handled) return
        const body = Buffer.from('no such api', 'utf8')
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length) })
        res.end(body)
      }).catch((e) => {
        const body = Buffer.from(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), 'utf8')
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
        res.end(body)
      })
      return true
    },
  })
  console.log('[whale-pet] host server ' + server.origin)
  // 端口写固定文件：外面（脚本/调试）不用再去猜 stdout
  try {
    fs.mkdirSync(CONF_DIR, { recursive: true })
    fs.writeFileSync(path.join(CONF_DIR, 'origin.txt'), server.origin, 'utf8')
  } catch { /* ignore */ }

  createWindow(server.origin)
  if (process.env.PET_OPEN_SETTINGS) setTimeout(() => openSettingsWindow(), 1500)
  setupTray()
  setupShortcut()
  syncRoamMode()
  startFullscreenWatch()
  rectTimer = setInterval(syncInteractive, 60)

  // 调试用：创建 ~/.whale-pet-desktop/snap-request 即截图一次（透明浮窗系统截图抓不到）
  setInterval(() => {
    const req = path.join(CONF_DIR, 'snap-request')
    if (!fs.existsSync(req)) return
    fs.rmSync(req, { force: true })
    if (win && !win.isDestroyed()) {
      win.webContents.capturePage()
        .then((img) => fs.writeFileSync(path.join(CONF_DIR, 'snapshot-now.png'), img.toPNG()))
        .catch(() => {})
    }
  }, 400)

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(server.origin) })
})

app.on('will-quit', () => {
  clearInterval(rectTimer)
  if (roamTimer) { clearInterval(roamTimer); roamTimer = null }
  globalShortcut.unregisterAll()
  // 主动注销托盘图标：不然退出后通知区域会留下"幽灵图标"
  try { if (tray) { tray.destroy(); tray = null } } catch { /* ignore */ }
  try { server && server.server.close() } catch { /* ignore */ }
})
app.on('window-all-closed', () => app.quit())
