/**
 * 桌面版宿主端 API：严格按原版 lib/index.js 的接口契约实现，让原版 client.js 原样可用。
 *
 * 关键契约（来自对原版源码的分析）：
 *  - /api/whale-pet/state 是**破坏性读取**（取走即清），否则每 800ms 重复播同一条通知
 *  - items 只有三种：mood(working|idle) / activity(name) / done(ok,title,message)
 *  - 设置是**增量 patch**（{ops:[{op:'set',path:[...],value}]}），不是整体覆盖
 *  - /pet/thumb/<名>.webm 必须支持 HEAD 且未知名字 404
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions')

/** 设置项默认值：与契约里的 Config schema 一致。 */
const SETTING_DEFAULTS = {
  pomodoro: true,
  pomodoroMinutes: 25,
  lateNight: true,
  chatter: true,
  longTaskMinutes: 10,
  city: '',
  size: 260,
  position: 'bottom-right',
  roam: true,
  buttonSide: 'left',
  dashboardHistory: true,
  dashboardWindowDays: 7,
}

// ---------------------------------------------------------------------------
// 状态队列（破坏性读取）
// ---------------------------------------------------------------------------
const queue = []
let seq = 0
const QUEUE_MAX = 60

function pushItem(item) {
  seq += 1
  queue.push(Object.assign({ id: 'wp-' + seq, at: Date.now() }, item))
  while (queue.length > QUEUE_MAX) queue.shift()
}

function takeItems() {
  const items = queue.splice(0, queue.length)
  return items
}

// ---------------------------------------------------------------------------
// 会话事件 -> mood / activity / done
//
// 关键：**不要用「多久没活动」来猜收工**——模型思考、长工具调用期间会话文件不写，
// 那样会在活还没干完时就宣布"任务完成"。DSH 自己会往事件流里写真实回合边界
// `turn/start` / `turn/end`，用它才准。
// ---------------------------------------------------------------------------
function createWatcher(deps) {
  let lastFile = null   // 当前跟随的会话文件；换了就重置水位
  let lastSeq = null
  let busy = false
  let busySince = 0
  let lastAct = null
  let timer = null

  function goBusy() {
    // 收到 turn/start 才算真的开工
    if (busy) return
    busy = true
    busySince = Date.now()
    pushItem({ type: 'mood', mood: 'working' })
  }

  function goIdle() {
    if (!busy) return
    busy = false
    pushItem({ type: 'mood', mood: 'idle' })
    const busyMs = Date.now() - busySince
    deps.summary().then((s) => {
      // 用时取本轮真实起点（turn/start），拿不到就用忙碌时长兜底
      const dur = s && s.startedAt ? Date.now() - s.startedAt : busyMs
      const lines = ['用时 ' + fmtDur(dur)]
      if (s) {
        lines.push('消耗 ' + fmtTokens(s.tokens.total) + ' tokens')
        lines.push('花费 ≈¥' + Number(s.costCny).toFixed(2))
      }
      pushItem({ type: 'done', ok: true, title: '任务完成啦！', message: lines.join('\n') })
    }).catch(() => {
      pushItem({ type: 'done', ok: true, title: '任务完成啦！', message: '用时 ' + fmtDur(busyMs) })
    })
  }

  function setActivity(name) {
    const v = name || ''
    if (v === lastAct) return
    lastAct = v
    pushItem({ type: 'activity', name: v })
  }

  async function poll() {
    let snap
    try { snap = await deps.tailEvents() } catch { return }
    if (!snap || typeof snap.file !== 'string' || !Array.isArray(snap.events)) return
    // 事件按 seq 排序（seq 是会话内单调递增的，跨会话不可比）
    const evs = snap.events.filter((e) => e && typeof e.seq === 'number').sort((a, b) => a.seq - b.seq)

    const switched = snap.file !== lastFile
    if (switched || lastSeq === null) {
      // 换会话了（或首次挂载）：水位必须**跟着会话重置**。
      // 否则新会话的 seq 比旧水位小，事件会被整批当成"已处理"丢掉 —— 表现就是
      // "切到别的对话，桌宠完全没反应"。
      lastFile = snap.file
      lastSeq = evs.length ? evs[evs.length - 1].seq : null
      lastAct = null
      // 按新会话尾部状态同步 mood，但**不发通知**（切过去不该弹"任务完成"）
      let inTurn = false
      for (const ev of evs) {
        if (ev.type === 'turn/start') inTurn = true
        else if (ev.type === 'turn/end') inTurn = false
      }
      const was = busy
      busy = inTurn
      busySince = Date.now()
      if (inTurn && !was) pushItem({ type: 'mood', mood: 'working' })
      else if (!inTurn && was) pushItem({ type: 'mood', mood: 'idle' })
      if (switched) console.log('[whale-pet] followed session -> ' + snap.file)
      return
    }
    if (evs.length === 0) return

    for (const ev of evs) {
      if (ev.seq <= lastSeq) continue
      lastSeq = ev.seq
      if (ev.type === 'turn/start') goBusy()
      else if (ev.type === 'turn/end') goIdle()
      else if (ev.type === 'tool/call' && ev.data && ev.data.name) setActivity(String(ev.data.name))
      else if (ev.type === 'tool/result' || ev.type === 'assistant/message') setActivity('')
    }
  }

  function start() {
    timer = setInterval(() => { poll().catch(() => {}) }, 800)
    poll().catch(() => {})
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { start, stop, isBusy: () => busy }
}

const fmtDur = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return s + '秒'
  return Math.floor(s / 60) + '分' + (s % 60) + '秒'
}
const fmtTokens = (n) => {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

// ---------------------------------------------------------------------------
// 天气（wttr.in j1 JSON -> 明日预报）
// ---------------------------------------------------------------------------
const WWO = {
  113: ['☀️', '晴'], 116: ['⛅', '多云'], 119: ['☁️', '阴'], 122: ['☁️', '阴'],
  143: ['🌫️', '薄雾'], 176: ['🌦️', '局部有雨'], 179: ['🌨️', '局部有雪'], 182: ['🌨️', '局部雨夹雪'],
  185: ['🌧️', '局部冻雨'], 200: ['⛈️', '雷阵雨'], 227: ['🌨️', '风吹雪'], 230: ['❄️', '暴风雪'],
  248: ['🌫️', '雾'], 260: ['🌫️', '冻雾'], 263: ['🌦️', '零星小雨'], 266: ['🌦️', '小雨'],
  281: ['🌧️', '冻雨'], 284: ['🌧️', '强冻雨'], 293: ['🌦️', '零星小雨'], 296: ['🌧️', '小雨'],
  299: ['🌧️', '中雨'], 302: ['🌧️', '中雨'], 305: ['🌧️', '大雨'], 308: ['🌧️', '大雨'],
  311: ['🌧️', '冻雨'], 314: ['🌧️', '冻雨'], 317: ['🌨️', '雨夹雪'], 320: ['🌨️', '雨夹雪'],
  323: ['🌨️', '零星小雪'], 326: ['🌨️', '小雪'], 329: ['🌨️', '中雪'], 332: ['🌨️', '中雪'],
  335: ['❄️', '大雪'], 338: ['❄️', '大雪'], 350: ['🌨️', '冰粒'], 353: ['🌦️', '阵雨'],
  356: ['🌧️', '强阵雨'], 359: ['🌧️', '暴雨'], 362: ['🌨️', '雨夹雪'], 365: ['🌨️', '雨夹雪'],
  368: ['🌨️', '阵雪'], 371: ['❄️', '强阵雪'], 374: ['🌨️', '冰粒'], 377: ['🌨️', '冰粒'],
  386: ['⛈️', '雷阵雨'], 389: ['⛈️', '雷雨'], 392: ['⛈️', '雷雪'], 395: ['⛈️', '雷雪'],
}
const wmo = (code) => WWO[Number(code)] || ['🌡️', '未知']

async function getWeather(city) {
  const base = city ? 'https://wttr.in/' + encodeURIComponent(city) : 'https://wttr.in/'
  const r = await fetch(base + '?format=j1&lang=zh', {
    headers: { 'user-agent': 'curl/8.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error('wttr.in HTTP ' + r.status)
  const j = await r.json()
  const cur = (j.current_condition || [])[0]
  const days = j.weather || []
  const tm = days[1]
  if (!cur || !tm) throw new Error('没有拿到明日预报数据')
  // 明日午后（12 点 / 15 点），缺失时回落最早的小时
  const hourly = tm.hourly || []
  const pick = hourly.find((h) => h.time === '1200') || hourly.find((h) => h.time === '1500') || hourly[0]
  const [icon, desc] = wmo(pick && pick.weatherCode)
  return {
    ok: true,
    city: city || (j.nearest_area && j.nearest_area[0] && j.nearest_area[0].areaName && j.nearest_area[0].areaName[0] && j.nearest_area[0].areaName[0].value) || '',
    icon: wmo(cur.weatherCode)[0],
    temp: cur.temp_C + '°C',
    tomorrowIcon: icon,
    tomorrowLow: Number(tm.mintempC),
    tomorrowHigh: Number(tm.maxtempC),
    tomorrowDesc: desc,
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function readKey() {
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const text = fs.readFileSync(p, 'utf8')
  const m = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (!m) throw new Error('没有找到 DeepSeek API Key（DEEPSEEK_API_KEY 未配置）')
  return m[1]
}

const redact = (s) => String(s || '').replace(/sk-[A-Za-z0-9]+/g, 'sk-***')

/**
 * 取余额明细（充值监测用，不走 HTTP 路由）。
 *
 * 判断「充值到账」必须用 topped（topped_up_balance，实充部分），不能用 total：
 * 赠送额度刷新也会让 total 变大，那会误判成充值。topped 只在真的充钱时增加，
 * 用量消耗和赠送刷新都不影响它。
 *
 * @returns {Promise<{total:number, topped:number, granted:number, currency:string}>}
 */
async function fetchBalanceTotal() {
  const key = readKey()
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  const info = (j.balance_infos || [])[0] || {}
  return {
    total: Number(info.total_balance || 0),
    topped: Number(info.topped_up_balance || 0),
    granted: Number(info.granted_balance || 0),
    currency: info.currency || 'CNY',
  }
}

function createApi(deps) {
  const watcher = createWatcher(deps)
  watcher.start()

  /**
   * @param req  http 请求
   * @param res  响应
   * @param url  已解析的 URL
   * @returns true 表示已处理
   */
  async function handle(req, res, url) {
    const p = url.pathname
    const json = (obj, status) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(status || 200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      })
      res.end(body)
    }
    const text = (s, status) => {
      const body = Buffer.from(String(s), 'utf8')
      res.writeHead(status || 200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length) })
      res.end(body)
    }

    // ---- 状态 ----
    if (p === '/api/whale-pet/state') {
      if (req.method !== 'GET') return text('method not allowed', 405) || true
      json({ items: takeItems(), settings: deps.getSettings() })
      return true
    }

    // ---- 分时段用量 ----
    if (p === '/api/whale-pet/usage') {
      if (req.method !== 'GET') return text('method not allowed', 405) || true
      try {
        const hours = Number(url.searchParams.get('hours'))
        const days = Number(url.searchParams.get('days'))
        const payload = await deps.usage({
          hours: Number.isFinite(hours) && hours >= 1 ? Math.floor(Math.min(24, hours)) : undefined,
          days: Number.isFinite(days) && days >= 1 ? Math.floor(Math.min(30, days)) : undefined,
        })
        json(payload)
      } catch (e) {
        json({ ok: false, error: redact(e && e.message) }, 500)
      }
      return true
    }

    // ---- 天气 ----
    if (p === '/api/whale-pet/weather') {
      if (req.method !== 'GET') return text('method not allowed', 405) || true
      try {
        json(await getWeather(deps.getSettings().city))
      } catch (e) {
        json({ ok: false, error: redact(e && e.message) }, 502)
      }
      return true
    }

    // ---- 余额 + 今日用量 ----
    if (p === '/api/whale-balance') {
      if (req.method !== 'GET') return text('method not allowed', 405) || true
      let usage = null
      try { usage = await deps.todayTotals() } catch { usage = { ok: false, error: '会话服务不可用' } }
      try {
        const key = readKey()
        const r = await fetch('https://api.deepseek.com/user/balance', {
          headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        const info = (j.balance_infos || [])[0] || {}
        json({
          ok: true,
          currency: info.currency || 'CNY',
          total: String(info.total_balance !== undefined ? info.total_balance : '0'),
          granted: String(info.granted_balance || '0'),
          topped: String(info.topped_up_balance || '0'),
          usage,
        })
      } catch (e) {
        json({ ok: false, error: redact(e && e.message), usage }, 502)
      }
      return true
    }

    // ---- 设置 ----
    if (p === '/api/whale-pet/settings') {
      if (req.method === 'GET') {
        json({ value: deps.getSettings(), writable: true })
        return true
      }
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (c) => {
          body += c
          if (body.length > 65536) { try { req.destroy() } catch { /* ignore */ } }
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}')
            const ops = Array.isArray(parsed.ops) ? parsed.ops : []
            // 增量 patch：只改 path 指定的键
            const patch = {}
            for (const op of ops) {
              if (!op || op.op !== 'set' || !Array.isArray(op.path) || op.path.length === 0) continue
              patch[String(op.path[0])] = op.value
            }
            if (Object.keys(patch).length) deps.setSettings(patch)
            json({ ok: true })
          } catch (e) {
            json({ ok: false, error: redact(e && e.message) }, 400)
          }
        })
        return true
      }
      return text('method not allowed', 405) || true
    }

    return false
  }

  return { handle, watcher }
}

module.exports = { createApi, SETTING_DEFAULTS, pushItem, fetchBalanceTotal }
