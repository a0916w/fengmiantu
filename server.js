/**
 * 智能封面图 — m3u8 自动选帧截图服务
 *
 * 依赖：本机 ffmpeg / ffprobe（FTP 上传零 npm 依赖，手写）
 * 启动：node server.js  （默认 http://localhost:3000）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { isAllowedUrl, probeDuration, captureFrame, pickTime } = require('./lib/media');
const { uploadCover } = require('./lib/upload');
const { readJsonBody, sendJson, decodeDataUrl, httpPostJson, callbackAllowed } = require('./lib/net');
const { createStore } = require('./lib/store');
const { createLogos } = require('./lib/logos');
const { createQueue } = require('./lib/queue');
const { composeCover } = require('./lib/compose');
const { processCoverJob } = require('./lib/coverjob');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOGOS_DIR = process.env.LOGOS_DIR || path.join(__dirname, 'logos');
const CONCURRENCY = parseInt(process.env.FENGMIANTU_CONCURRENCY || '2', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const store = createStore(DATA_DIR);
const logos = createLogos(LOGOS_DIR);
const queue = createQueue({
  store,
  concurrency: CONCURRENCY,
  process: (job) => processCoverJob(job, { probeDuration, pickTime, captureFrame, composeCover, uploadCover, logos }),
  onDone: async (job, result) => {
    if (!job.callback) return;
    const body = result.error
      ? { status: 'failed', job_id: job.id, external_id: job.externalId, error: result.error }
      : { status: 'completed', job_id: job.id, external_id: job.externalId, url: result.url };
    try { await httpPostJson(job.callback, body); }
    catch (e) { console.error('[cover] callback failed', job.id, e && e.message); }
  },
});

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (m) return m[1];
  try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { return ''; }
}
function requireAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const a = Buffer.from(ADMIN_TOKEN), b = Buffer.from(bearer(req));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function projectFromReq(req) { return store.getProjectByToken(bearer(req)); }

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

    // ---------- 多项目封面 API（异步 + 回调）----------
    if (req.method === 'POST' && pathname === '/api/cover') {
      const project = projectFromReq(req);
      if (!project) return sendJson(res, 401, { error: '无效 token' });
      const { url, logo, external_id: externalId, callback } = await readJsonBody(req);
      if (!isAllowedUrl(url)) return sendJson(res, 400, { error: '请输入合法的 http(s) 视频链接' });
      const useLogo = (logo === undefined || logo === null || logo === '') ? project.defaultLogo : String(logo);
      if (useLogo !== 'none' && !logos.exists(useLogo)) return sendJson(res, 400, { error: 'logo 不存在: ' + useLogo });
      if (!callback || !callbackAllowed(callback)) return sendJson(res, 400, { error: '回调地址缺失或不被允许' });
      const job = store.createJob({ projectKey: project.key, url, logo: useLogo, externalId, callback });
      queue.enqueue(job);
      return sendJson(res, 200, { ok: true, job_id: job.id });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/cover/')) {
      const project = projectFromReq(req);
      if (!project) return sendJson(res, 401, { error: '无效 token' });
      const id = pathname.slice('/api/cover/'.length);
      const job = store.getJob(id);
      if (!job || job.projectKey !== project.key) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, { status: job.status, resultUrl: job.resultUrl, error: job.error });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { error: '服务器内部错误', detail: String(e.message).slice(0, 300) });
  }
});

// 仅在直接运行时监听；被 require（测试）时由调用方控制生命周期，避免进程挂住。
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`智能封面图服务已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app: server, store, logos, queue };
