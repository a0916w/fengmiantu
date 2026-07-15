/**
 * HTTP 小工具：读 JSON body、发 JSON 响应、POST 回调、回调 SSRF 校验、dataURL 解码。
 * 从 server.js 抽出，供路由与队列 worker 共用。
 */
const http = require('http');
const https = require('https');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** dataURL(image/webp|jpeg|png) → { buffer, ext }。非法返回 null。 */
function decodeDataUrl(dataUrl) {
  const m = /^data:image\/(webp|jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
  return { buffer, ext };
}

/** POST JSON 到任意 http(s) URL（回调 webmm）。 */
function httpPostJson(urlStr, obj) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('回调地址非法')); }
    const body = Buffer.from(JSON.stringify(obj));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 20_000,
    }, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('回调超时')));
    req.on('error', reject);
    req.end(body);
  });
}

// SSRF 核心防护：按【实际连上的 IP】判断内网/回环/链路本地——挡住 DNS 重绑定
// 和「公网域名 302 跳内网」两种绕过（仅查主机名字符串挡不住）。
function isPrivateIp(ip) {
  if (!ip) return true;
  ip = String(ip).replace(/^::ffff:/i, ''); // IPv4-mapped IPv6
  if (ip === '::1' || ip === '::') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // 链路本地 + 云元数据
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // IPv6 ULA fc00::/7
  if (/^fe80:/i.test(ip)) return true;             // IPv6 链路本地
  return false;
}

/** GET 一张远程图片（原封面代理用），返回 { contentType, buffer }。仅跟随一次
 *  3xx 重定向；限 http(s) + 大小上限，防拉超大文件 / 慢响应吊住。 */
function httpGetImage(urlStr, maxBytes = 25 * 1024 * 1024, _redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('图片地址非法')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('仅支持 http(s)'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: 20_000 }, (resp) => {
      // 实际连上的 IP 落在内网 → 直接掐断（含重定向后每一跳都会重新走到这里再查）。
      const ip = resp.socket && resp.socket.remoteAddress;
      if (isPrivateIp(ip)) { resp.destroy(); req.destroy(); return reject(new Error('目标解析到内网地址')); }
      const code = resp.statusCode || 0;
      if (code >= 300 && code < 400 && resp.headers.location && _redirects < 1) {
        resp.resume();
        return httpGetImage(new URL(resp.headers.location, u).toString(), maxBytes, _redirects + 1).then(resolve, reject);
      }
      if (code !== 200) { resp.resume(); return reject(new Error('源站返回 ' + code)); }
      const chunks = [];
      let size = 0;
      resp.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('图片过大')); return; }
        chunks.push(c);
      });
      resp.on('end', () => resolve({ contentType: String(resp.headers['content-type'] || ''), buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('图片下载超时')));
    req.on('error', reject);
  });
}

/**
 * 回调地址是否放行（防 SSRF）：
 * - 必须 http(s)；
 * - 永远拒绝云元数据 / 回环 / 链路本地地址（169.254.x、127.x、::1、localhost）；
 * - 传入 hosts 白名单（数组）则必须命中；不传则退回全局 COVER_CALLBACK_HOSTS。
 * 生产务必按 logo 配好各自的回调域名白名单。
 * @param {string} urlStr 回调地址
 * @param {string[]} [hosts] 该 logo 的回调域名白名单；缺省用全局 COVER_CALLBACK_HOSTS。
 */
function callbackAllowed(urlStr, hosts) {
  let host;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  // 元数据 / 链路本地：永远拒绝（云元数据 SSRF 常用），任何开关都不放开。
  if (host === '169.254.169.254' || /^169\.254\./.test(host)) {
    return false;
  }
  // 回环：默认拒绝，仅测试用 COVER_CALLBACK_ALLOW_LOOPBACK 放开。
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
    return !!process.env.COVER_CALLBACK_ALLOW_LOOPBACK;
  }
  const allow = (Array.isArray(hosts) ? hosts : (process.env.COVER_CALLBACK_HOSTS || '').split(','))
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return allow.length === 0 ? true : allow.includes(host);
}

module.exports = { readJsonBody, sendJson, decodeDataUrl, httpPostJson, httpGetImage, callbackAllowed };
