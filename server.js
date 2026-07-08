/**
 * 智能封面图 — m3u8 自动选帧截图服务
 *
 * 依赖：本机 ffmpeg / ffprobe（FTP 上传零 npm 依赖，手写）
 * 启动：node server.js  （默认 http://localhost:3000）
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fengmiantu-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

// ---------- 工具 ----------

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

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

// ---------- 核心逻辑 ----------

/** 探测视频时长（秒），直播/未知返回 null */
async function probeDuration(url) {
  const args = [
    '-v', 'error',
    '-user_agent', UA,
    '-show_entries', 'format=duration',
    '-of', 'json',
    url,
  ];
  const { stdout } = await run('ffprobe', args, 30_000);
  const info = JSON.parse(stdout);
  const d = parseFloat(info?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * 在指定时间点附近智能截一帧：
 * 先快进到 t，再解码一小批帧，用 thumbnail 滤镜挑出其中最有代表性的一帧
 * （自动避开黑屏、转场、模糊帧）。
 */
async function captureFrame(url, t) {
  const out = path.join(TMP_DIR, `f-${crypto.randomBytes(8).toString('hex')}.jpg`);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', UA,
    '-ss', String(Math.max(0, t)),
    '-i', url,
    '-vf', 'thumbnail=25,scale=min(1280\\,iw):-2',
    '-frames:v', '1',
    '-q:v', '2',
    '-y', out,
  ];
  try {
    await run('ffmpeg', args, 120_000);
    const buf = await fs.promises.readFile(out);
    if (!buf.length) throw new Error('empty frame');
    return buf;
  } finally {
    fs.promises.unlink(out).catch(() => {});
  }
}

/**
 * 为第 index 段（共 count 段）挑一个截图时间点。
 * 有时长：掐掉片头片尾各 8%，中间均分成 count 段，在每段中部随机取点；
 * 无时长（直播）：从头部往后按固定间隔取。
 */
function pickTime(duration, index, count) {
  if (duration) {
    const start = duration * 0.08;
    const end = duration * 0.92;
    const segLen = (end - start) / count;
    const segStart = start + segLen * index;
    return segStart + segLen * (0.25 + Math.random() * 0.5);
  }
  return 3 + index * 8 + Math.random() * 4;
}

// ---------- 发布封面：上传 + 回调 webmm ----------

/** dataURL(image/webp|jpeg|png) → { buffer, ext }。非法返回 null。 */
function decodeDataUrl(dataUrl) {
  const m = /^data:image\/(webp|jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
  return { buffer, ext };
}

/**
 * 上传封面，返回可公开访问的完整 URL。
 * - 测试/本地：设 COVER_UPLOAD_STUB_DIR 时写本地文件，URL = FTP_URL_PREFIX + '/' + 文件名。
 * - 生产：走 FTP（被动模式 STOR，二进制），URL = FTP_URL_PREFIX + '/' + 文件名。
 */
async function uploadCover(buffer, filename) {
  const prefix = (process.env.FTP_URL_PREFIX || '').replace(/\/+$/, '');
  if (!prefix) throw new Error('未配置 FTP_URL_PREFIX（回传给 webmm 的图片地址前缀）');

  const stubDir = process.env.COVER_UPLOAD_STUB_DIR;
  if (stubDir) {
    await fs.promises.mkdir(stubDir, { recursive: true });
    await fs.promises.writeFile(path.join(stubDir, filename), buffer);
  } else {
    await ftpStore(buffer, filename);
  }
  return prefix + '/' + filename;
}

/** 最小 FTP 客户端：被动模式二进制 STOR 单文件。零 npm 依赖。 */
function ftpStore(buffer, filename) {
  const host = process.env.FTP_HOST;
  const port = parseInt(process.env.FTP_PORT || '21', 10);
  const user = process.env.FTP_USER;
  const pass = process.env.FTP_PASS || '';
  const dir = (process.env.FTP_DIR || '').replace(/\/+$/, '');
  const timeoutMs = parseInt(process.env.FTP_TIMEOUT_MS || '360000', 10); // 默认 360s，可 env 调
  if (!host || !user) return Promise.reject(new Error('未配置 FTP_HOST / FTP_USER'));

  return new Promise((resolve, reject) => {
    const ctrl = net.connect({ host, port });
    ctrl.setEncoding('utf8');
    ctrl.setTimeout(timeoutMs);

    let buf = '';
    let waiter = null;
    const done = (err) => { try { ctrl.destroy(); } catch {} err ? reject(err) : resolve(); };

    ctrl.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3} /.test(line) && waiter) { const w = waiter; waiter = null; w(line); }
      }
    });
    ctrl.on('timeout', () => done(new Error('FTP 控制连接超时')));
    ctrl.on('error', (e) => done(e));

    const expect = (codes) => new Promise((res, rej) => {
      waiter = (line) => {
        const code = parseInt(line.slice(0, 3), 10);
        codes.includes(code) ? res(line) : rej(new Error('FTP 应答 ' + line.slice(0, 60)));
      };
    });
    const cmd = (c) => { ctrl.write(c + '\r\n'); };

    (async () => {
      await expect([220]);
      cmd('USER ' + user); await expect([331, 230]);
      if (pass) { cmd('PASS ' + pass); await expect([230]); }
      cmd('TYPE I'); await expect([200]);
      cmd('PASV');
      const pasv = await expect([227]);
      const mm = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv);
      if (!mm) throw new Error('PASV 解析失败');
      const dataHost = mm.slice(1, 5).join('.');
      const dataPort = (parseInt(mm[5], 10) << 8) + parseInt(mm[6], 10);

      const remote = (dir ? dir + '/' : '') + filename;
      const data = net.connect({ host: dataHost, port: dataPort });
      data.setTimeout(timeoutMs);
      const dataClosed = new Promise((res, rej) => {
        data.on('error', rej);
        data.on('timeout', () => rej(new Error('FTP 数据连接超时')));
        data.on('close', res);
      });
      await new Promise((res, rej) => { data.on('connect', res); data.on('error', rej); });

      cmd('STOR ' + remote);
      await expect([150, 125]);
      data.end(buffer);
      await dataClosed;
      await expect([226, 250]);
      cmd('QUIT');
      done(null);
    })().catch(done);
  });
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

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  try {
    // 只按【路径】匹配，忽略查询串——从 webmm 跳来时带 ?m3u8=&external_id=...，
    // 否则 req.url === '/' 不成立会误落 404。
    const pathname = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await fs.promises.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && pathname === '/logo.png') {
      try {
        const png = await fs.promises.readFile(path.join(__dirname, 'logo.png'));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(png);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }

    if (req.method === 'POST' && req.url === '/api/probe') {
      const { url } = await readJsonBody(req);
      if (!isAllowedUrl(url)) return sendJson(res, 400, { error: '请输入合法的 http(s) 链接' });
      try {
        const duration = await probeDuration(url);
        return sendJson(res, 200, { duration });
      } catch (e) {
        return sendJson(res, 502, {
          error: '无法读取该视频流，请检查链接是否可访问',
          detail: String(e.stderr || e.message).slice(0, 500),
        });
      }
    }

    if (req.method === 'POST' && req.url === '/api/frame') {
      const { url, duration, index = 0, count = 3 } = await readJsonBody(req);
      if (!isAllowedUrl(url)) return sendJson(res, 400, { error: '请输入合法的 http(s) 链接' });
      const t = pickTime(duration || null, Number(index) || 0, Math.max(1, Number(count) || 3));
      try {
        const buf = await captureFrame(url, t);
        return sendJson(res, 200, {
          time: Math.round(t * 10) / 10,
          image: `data:image/jpeg;base64,${buf.toString('base64')}`,
        });
      } catch (e) {
        return sendJson(res, 502, {
          error: '截帧失败',
          detail: String(e.stderr || e.message).slice(0, 500),
        });
      }
    }

    if (req.method === 'POST' && req.url === '/api/publish') {
      const { image, external_id: externalId, callback } = await readJsonBody(req);
      if (!externalId || typeof externalId !== 'string') return sendJson(res, 400, { error: '缺少 external_id' });
      // 回调地址防 SSRF：拒元数据/回环，配了白名单则必须命中。
      if (!callbackAllowed(callback)) return sendJson(res, 400, { error: '回调地址不被允许' });
      const decoded = decodeDataUrl(image);
      if (!decoded) return sendJson(res, 400, { error: '封面图数据非法（需 webp/jpeg base64，≤8MB）' });

      const safeId = externalId.replace(/[^A-Za-z0-9_-]/g, '');
      const filename = `cover-${safeId}-${crypto.randomBytes(4).toString('hex')}.${decoded.ext}`;
      try {
        const url = await uploadCover(decoded.buffer, filename);
        const cb = await httpPostJson(callback, {
          status: 'completed',
          external_id: externalId,
          outputs: [{ url, selection_score: 1 }],
        });
        if (cb.status < 200 || cb.status >= 300) {
          // 不回显回调响应体（可能含内部信息）；细节只落服务端日志。
          console.error('[publish] callback non-2xx', cb.status, String(cb.body).slice(0, 300));
          return sendJson(res, 502, { error: 'webmm 回调失败' });
        }
        return sendJson(res, 200, { ok: true, url });
      } catch (e) {
        // 不把内部错误（FTP 地址/路径等）回给调用方；只落日志。
        console.error('[publish] failed', e && e.message);
        return sendJson(res, 502, { error: '发布封面失败' });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { error: '服务器内部错误', detail: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`智能封面图服务已启动: http://localhost:${PORT}`);
});
