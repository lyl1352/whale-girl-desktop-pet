/**
 * 用量数据源：从本机 DSH 会话文件里算出「本会话 / 今日 / 分时段」的 token 与费用，
 * 并输出成原版 /api/whale-pet/usage 的**精确形状**（字段名/单位/口径对齐契约）。
 *
 * 为什么这么做：DSH 的网页接口对普通进程返回 403（需要浏览器令牌），所以桌面版
 * 直接读 ~/.dsh/sessions 下的事件流自己算。计费口径不自己发明——复用
 * dsh-whale-girl-pet 的 lib/usage.js（MIT，已 vendor 到 vendor/usage.mjs）。
 *
 * 事件流是追加写的多帧 zstd，Node 的 zstdDecompressSync 只解第一帧，故按帧魔数切开。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { pathToFileURL } = require('node:url')

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const USAGE_MOD = path.join(__dirname, 'vendor', 'usage.mjs')
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const BJ_OFFSET = 8 * 3600e3
const DAY_MS = 864e5
const HOUR_MS = 3600e3

let usageMod = null
async function loadUsage() {
  if (!usageMod) usageMod = await import(pathToFileURL(USAGE_MOD).href)
  return usageMod
}

/** 多帧 zstd -> 事件数组（坏帧跳过）。 */
function readEvents(file) {
  const buf = fs.readFileSync(file)
  const events = []
  const starts = []
  let pos = 0
  while ((pos = buf.indexOf(FRAME_MAGIC, pos)) >= 0) { starts.push(pos); pos += 4 }
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    let plain
    try { plain = zlib.zstdDecompressSync(buf.subarray(starts[i], end)) } catch { continue }
    for (const line of plain.toString('utf8').split('\n')) {
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行 */ }
    }
  }
  return events
}

/** 只读文件尾部并按帧解压（活动轮询用）。 */
function tailEvents(file, maxBytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - (maxBytes || 262144))
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const events = []
    const starts = []
    let p = 0
    while ((p = buf.indexOf(FRAME_MAGIC, p)) >= 0) { starts.push(p); p += 4 }
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1] : buf.length
      let plain
      try { plain = zlib.zstdDecompressSync(buf.subarray(starts[i], end)) } catch { continue }
      for (const line of plain.toString('utf8').split('\n')) {
        if (!line) continue
        try { events.push(JSON.parse(line)) } catch { /* 半行 */ }
      }
    }
    return events
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 会话事件 -> 计费样本（替换语义与 lib/usage.js 的 foldTodayUsage 完全一致）。
 */
function samplesOf(events) {
  const last = new Map()
  let model = ''
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type === 'request/header') {
      const m = ev.data && ev.data.header && ev.data.header.config ? ev.data.header.config.model : ''
      if (m) model = String(m)
      continue
    }
    if (ev.type === 'request/context') {
      const m = ev.data ? ev.data.model : ''
      if (m) model = String(m)
      continue
    }
    if (ev.type === 'llm/retry-started') {
      const d = ev.data || {}
      last.delete(String(d.turn) + ':' + String(d.step))
      continue
    }
    if (ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && ev.data.chunk.type === 'usage') {
      const d = ev.data
      last.set(String(d.turn) + ':' + String(d.step), { turn: d.turn, step: d.step, usage: d.chunk.usage, time: ev.time, model })
      continue
    }
    if (ev.type === 'assistant/message' || ev.type === 'assistant/attempt') {
      const usage = usageMod.usageOfEvent(ev)
      if (!usage || !ev.data) continue
      const d = ev.data
      last.set(String(d.turn) + ':' + String(d.step), {
        turn: d.turn,
        step: d.step,
        usage,
        time: typeof ev.time === 'number' ? ev.time : Date.now(),
        model,
      })
    }
  }
  const out = []
  for (const s of last.values()) {
    const buckets = usageMod.bucketsFromUsage(s.usage)
    const rate = usageMod.rateAt(s.model, s.time)
    const cost = usageMod.costOfBuckets(buckets, rate)
    out.push({ time: s.time, turn: s.turn, model: s.model, buckets, cost, regime: rate.regime })
  }
  return out
}

const cache = new Map()

function listSessionFiles() {
  const files = []
  const stack = [SESSIONS_ROOT]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/\.jsonl\.zstd$/i.test(p)) files.push(p)
    }
  }
  return files
}

function loadAll(maxAgeDays) {
  const cutoff = Date.now() - (maxAgeDays || 8) * DAY_MS
  const sessions = []
  let events = 0
  let failed = 0
  for (const file of listSessionFiles()) {
    let st
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < cutoff) continue
    let entry = cache.get(file)
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      try {
        const evs = readEvents(file)
        const usable = evs.some((e) => e.type === 'request/header' || e.type === 'assistant/message')
        entry = { mtimeMs: st.mtimeMs, size: st.size, samples: usable ? samplesOf(evs) : [], events: evs.length }
      } catch {
        entry = { mtimeMs: st.mtimeMs, size: st.size, samples: [], events: 0 }
        failed += 1
      }
      cache.set(file, entry)
    }
    events += entry.events || 0
    sessions.push({ file, mtimeMs: st.mtimeMs, samples: entry.samples })
  }
  return { sessions, events, failed }
}

const round4 = (n) => Math.round(n * 1e4) / 1e4
const round1 = (n) => Math.round(n * 10) / 10
const bjDayStart = (ms) => Math.floor((ms + BJ_OFFSET) / DAY_MS) * DAY_MS - BJ_OFFSET
const bjHourIndex = (ms) => Math.floor((ms + BJ_OFFSET) / HOUR_MS)
const bjDayIndex = (ms) => Math.floor((ms + BJ_OFFSET) / DAY_MS)
const dayKeyOf = (dayIndex) => new Date(dayIndex * DAY_MS - BJ_OFFSET + 12 * HOUR_MS).toISOString().slice(0, 10)

function newAcc() {
  return {
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    cost: { hit: 0, miss: 0, out: 0, total: 0 },
    regime: { flat: 0, peak: 0, off: 0 },
    calls: 0,
    models: new Set(),
  }
}

function addSample(acc, s) {
  acc.tokens.input += s.buckets.input
  acc.tokens.cacheRead += s.buckets.cacheRead
  acc.tokens.cacheWrite += s.buckets.cacheWrite
  acc.tokens.output += s.buckets.output
  acc.cost.hit += s.cost.hit
  acc.cost.miss += s.cost.miss
  acc.cost.out += s.cost.out
  acc.cost.total += s.cost.total
  acc.regime[s.regime] = (acc.regime[s.regime] || 0) + s.cost.total
  acc.calls += 1
  if (s.model) acc.models.add(s.model)
}

/** 把一个累加器摊成契约里的 bucket 字段。 */
function bucketShape(acc, extra) {
  const inputTotal = acc.tokens.input + acc.tokens.cacheRead + acc.tokens.cacheWrite
  const total = inputTotal + acc.tokens.output
  return Object.assign({
    tokens: {
      input: acc.tokens.input,
      cacheRead: acc.tokens.cacheRead,
      cacheWrite: acc.tokens.cacheWrite,
      output: acc.tokens.output,
      inputTotal,
      total,
    },
    cacheHitPercent: inputTotal > 0 ? round1((acc.tokens.cacheRead / inputTotal) * 100) : null,
    costCny: round4(acc.cost.total),
    costHitCny: round4(acc.cost.hit),
    costMissCny: round4(acc.cost.miss),
    costOutCny: round4(acc.cost.out),
    costPeakCny: round4(acc.regime.peak || 0),
    costOffPeakCny: round4(acc.regime.off || 0),
    calls: acc.calls,
    models: [...acc.models].slice(0, 6),
  }, extra || {})
}

/**
 * /api/whale-pet/usage 的完整响应体。
 * @param opts.hours 小时轴长度（1..24，默认 24）
 * @param opts.days  日轴长度（1..30，默认 7）
 */
async function getUsage(opts) {
  await loadUsage()
  const now = Date.now()
  const hourCount = Math.max(1, Math.min(24, Number(opts && opts.hours) || 24))
  const dayCount = Math.max(1, Math.min(30, Number(opts && opts.days) || 7))

  const { sessions, events, failed } = loadAll(8)
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const current = sessions[0] || null

  const hourNow = bjHourIndex(now)
  const dayNow = bjDayIndex(now)

  const hourAcc = new Map()
  const dayAcc = new Map()
  const todayAcc = newAcc()
  const last24Acc = newAcc()
  const windowAcc = newAcc()
  const sessionAcc = newAcc()
  const turnAcc = new Map()

  const todayStart = bjDayStart(now)
  const hourFrom = hourNow - (hourCount - 1)
  const dayFrom = dayNow - (dayCount - 1)

  if (current) {
    for (const s of current.samples) {
      addSample(sessionAcc, s)
      let t = turnAcc.get(s.turn)
      if (!t) { t = newAcc(); turnAcc.set(s.turn, t) }
      addSample(t, s)
    }
  }

  for (const sess of sessions) {
    for (const s of sess.samples) {
      const hi = bjHourIndex(s.time)
      const di = bjDayIndex(s.time)
      if (s.time >= todayStart) addSample(todayAcc, s)
      if (hi >= hourNow - 23) {
        addSample(last24Acc, s)
        if (hi >= hourFrom) {
          let a = hourAcc.get(hi)
          if (!a) { a = newAcc(); hourAcc.set(hi, a) }
          addSample(a, s)
        }
      }
      if (di >= dayFrom) {
        addSample(windowAcc, s)
        let d = dayAcc.get(di)
        if (!d) { d = newAcc(); dayAcc.set(di, d) }
        addSample(d, s)
      }
      // 日视图要画最近 N 天，但小时视图只画当天，所以窗口外的今天数据也要有日桶
      if (di > dayNow) continue
      let d2 = dayAcc.get(di)
      if (!d2) { d2 = newAcc(); dayAcc.set(di, d2) }
      addSample(d2, s)
    }
  }

  const hours = []
  for (let i = 0; i < hourCount; i += 1) {
    const hi = hourFrom + i
    const a = hourAcc.get(hi) || newAcc()
    const hour = ((hi % 24) + 24) % 24
    hours.push(bucketShape(a, {
      index: hi,
      hour,
      day: dayKeyOf(Math.floor(hi / 24)),
      current: hi === hourNow,
      peak: usageMod.isPeakBeijing(hi * HOUR_MS),
    }))
  }

  const days = []
  for (let i = 0; i < dayCount; i += 1) {
    const di = dayFrom + i
    const a = dayAcc.get(di) || newAcc()
    days.push(bucketShape(a, {
      index: di,
      date: dayKeyOf(di),
      current: di === dayNow,
      peak: (a.regime.peak || 0) > 0,
    }))
  }

  const turns = [...turnAcc.keys()].sort((x, y) => x - y)
  const lastTurn = turns.length ? turns[turns.length - 1] : 0

  return {
    ok: true,
    now,
    timeZone: 'Asia/Shanghai',
    windowDays: dayCount,
    hours,
    days,
    totals: {
      today: bucketShape(todayAcc),
      last24h: bucketShape(last24Acc),
      window: bucketShape(windowAcc),
    },
    calls: windowAcc.calls,
    scan: {
      status: failed > 0 ? 'done' : 'done',
      startedAt: now,
      finishedAt: now,
      ms: 0,
      sessions: sessions.length,
      events,
      failed,
      error: null,
    },
    session: current
      ? Object.assign(bucketShape(sessionAcc), {
        turn: lastTurn,
        turnCost: lastTurn ? round4(bucketShape(turnAcc.get(lastTurn)).costCny) : 0,
      })
      : null,
  }
}

/** 今日汇总（给 /api/whale-balance 的 usage 字段用）。 */
async function getTodayTotals() {
  const u = await getUsage({ hours: 1, days: 1 })
  const t = u.totals.today
  return {
    ok: true,
    date: dayKeyOf(bjDayIndex(Date.now())),
    tokens: t.tokens,
    costCny: t.costCny,
    costHitCny: t.costHitCny,
    costMissCny: t.costMissCny,
    costOutCny: t.costOutCny,
    costFlatCny: 0,
    costPeakCny: t.costPeakCny,
    costOffCny: t.costOffPeakCny,
    tier: (t.models || []).every((m) => usageMod && usageMod.tierOfModel(m) === 'flash') ? 'flash' : 'pro',
    sessions: u.scan.sessions,
    models: t.models,
  }
}

/** 当前 Agent 正在调用哪个工具（打字机气泡用）。 */
function lastActivity() {
  let newest = null
  let newestMs = 0
  for (const f of listSessionFiles()) {
    try {
      const st = fs.statSync(f)
      if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newest = f }
    } catch { /* ignore */ }
  }
  if (!newest) return { ok: true, act: null }
  let act = null
  try {
    for (const ev of tailEvents(newest, 262144)) {
      if (!ev || typeof ev.type !== 'string') continue
      if (ev.type === 'tool/call' && ev.data && ev.data.name) act = String(ev.data.name)
      else if (ev.type === 'tool/result' || ev.type === 'assistant/message' || ev.type === 'step/end') act = null
    }
  } catch { /* ignore */ }
  return { ok: true, act, at: newestMs }
}

/** 最近一个已完成轮的用量（完成通知里的「消耗/花费/用时」用它）。 */
async function getLastTurn() {
  await loadUsage()
  const { sessions } = loadAll(8)
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const current = sessions[0]
  if (!current || current.samples.length === 0) return null
  const turnAcc = new Map()
  for (const s of current.samples) {
    let t = turnAcc.get(s.turn)
    if (!t) { t = newAcc(); turnAcc.set(s.turn, t) }
    addSample(t, s)
  }
  const turns = [...turnAcc.keys()].sort((a, b) => a - b)
  if (!turns.length) return null
  const last = turns[turns.length - 1]
  const acc = turnAcc.get(last)
  const shaped = bucketShape(acc)
  // 该轮的起点：从事件流里找 turn/start
  let startedAt = null
  try {
    const evs = readEvents(current.file)
    for (const ev of evs) {
      if (ev && ev.type === 'turn/start' && ev.data && ev.data.turn === last && typeof ev.time === 'number') {
        startedAt = ev.time
      }
    }
  } catch { /* ignore */ }
  return { turn: last, tokens: shaped.tokens, costCny: shaped.costCny, calls: shaped.calls, models: shaped.models, startedAt }
}

/** 最新会话文件尾部的事件（状态机用；调用方按 seq 去重后可增量消费）。 */
function getTailEvents(maxBytes) {
  let newest = null
  let newestMs = 0
  for (const f of listSessionFiles()) {
    try {
      const st = fs.statSync(f)
      if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newest = f }
    } catch { /* ignore */ }
  }
  if (!newest) return { file: null, events: [] }
  try {
    return { file: newest, events: tailEvents(newest, maxBytes || 262144) }
  } catch {
    return { file: newest, events: [] }
  }
}

module.exports = { getUsage, getTodayTotals, getLastTurn, lastActivity, getTailEvents, loadUsage }
