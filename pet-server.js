/**
 * 桌面版的「迷你 DSH 宿主服务器」。
 *
 * 原版 client.js 是标准 DSH 浏览器插件：它用同源 HTTP 取视频（/pet/thumb/*.webm）
 * 和宿主数据（/api/*）。桌面版没有 DSH 那个 webServer，所以在 Electron 主进程里
 * 起一个只监听 127.0.0.1 的小服务器，把这些路径补齐，让原版代码**原样**跑起来。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
}

function sendFile(res, file, req) {
  let st
  try { st = fs.statSync(file) } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (!st.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': String(st.size),
    'cache-control': 'no-store',
  }
  if (req && req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  fs.createReadStream(file).pipe(res)
}

function sendJson(res, obj, status) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * @param opts.root   应用根目录（含 renderer/ 与 assets/）
 * @param opts.vendor vendor 目录
 * @param opts.api    (req, res, url) => boolean  处理 /api/*，返回 true 表示已处理
 */
function start(opts) {
  const root = opts.root
  const vendor = path.join(root, 'vendor')
  const assets = path.join(root, 'assets')

  const server = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') } catch { res.writeHead(400); res.end(); return }
    const p = decodeURIComponent(url.pathname)

    if (p.startsWith('/api/')) {
      try {
        if (opts.api && opts.api(req, res, url)) return
      } catch (e) {
        sendJson(res, { ok: false, error: String((e && e.message) || e) }, 500)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no such api')
      return
    }

    // 静态资源：只允许白名单前缀 + basename，防目录穿越
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(root, 'renderer', 'shell.html'), req)
    if (p.startsWith('/vendor/')) return sendFile(res, path.join(vendor, path.basename(p)), req)
    if (p.startsWith('/pet/thumb/') || p.startsWith('/pet/full/')) {
      return sendFile(res, path.join(assets, path.basename(p)), req)
    }
    if (p.startsWith('/assets/')) return sendFile(res, path.join(assets, path.basename(p)), req)

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, origin: 'http://127.0.0.1:' + port })
    })
  })
}

module.exports = { start, sendJson, sendFile }
