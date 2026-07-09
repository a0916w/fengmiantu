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

/**
 * 回调地址是否放行（防 SSRF）：
 * - 必须 http(s)；
 * - 永远拒绝云元数据 / 回环 / 链路本地地址（169.254.x、127.x、::1、localhost）；
 * - 配了 COVER_CALLBACK_HOSTS（逗号分隔主机名）则必须命中白名单。
 * 生产务必配 COVER_CALLBACK_HOSTS = webmm 的域名。
 */
function callbackAllowed(urlStr) {
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
  const allow = (process.env.COVER_CALLBACK_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.length === 0 ? true : allow.includes(host);
}

module.exports = { readJsonBody, sendJson, decodeDataUrl, httpPostJson, callbackAllowed };
