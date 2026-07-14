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

const LOGOS_DIR = path.join(__dirname, 'logos');
const { uploadCover, listUploadTargets, uploadCoverToTarget } = require('./lib/upload');
const { readJsonBody, sendJson, decodeDataUrl, httpPostJson, callbackAllowed } = require('./lib/net');

const PORT = process.env.PORT || 3000;

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  try {
    // 只按【路径】匹配，忽略查询串——从 webmm 跳来时带 ?m3u8=&external_id=...，
    // 否则 req.url === '/' 不成立会误落 404。
    const pathname = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await fs.promises.readFile(path.join(__dirname, 'index.html'));
      // 禁止缓存页面，避免改版后浏览器还跑旧 JS
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // logo 库（logos/*.png）：列表 + 取图，供页面下拉选择
    if (req.method === 'GET' && pathname === '/api/logo-list') {
      let names = [];
      try {
        names = fs.readdirSync(LOGOS_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
      } catch {}
      return sendJson(res, 200, { logos: names });
    }
    // 自托管字体（fonts/*.woff2|ttf），封面文字用
    if (req.method === 'GET' && pathname.startsWith('/fonts/')) {
      const name = decodeURIComponent(pathname.slice('/fonts/'.length));
      if (!/^[A-Za-z0-9_.-]+\.(woff2|ttf|otf)$/.test(name)) { res.writeHead(404); return res.end(); }
      try {
        const buf = await fs.promises.readFile(path.join(__dirname, 'fonts', name));
        const type = name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.otf') ? 'font/otf' : 'font/ttf';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
        return res.end(buf);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }

    if (req.method === 'GET' && pathname.startsWith('/logo-img/')) {
      const name = decodeURIComponent(pathname.slice('/logo-img/'.length));
      if (!/^[A-Za-z0-9_-]+$/.test(name)) { res.writeHead(404); return res.end(); }
      try {
        const png = await fs.promises.readFile(path.join(LOGOS_DIR, name + '.png'));
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

    // 手动网页「上传到 FTP」：可选的上传目标列表（各目标一台 FTP，配置见 lib/upload.js）
    if (req.method === 'GET' && pathname === '/api/upload-targets') {
      return sendJson(res, 200, { targets: listUploadTargets() });
    }

    // 手动网页「上传到 FTP」：把当前封面直接传到选定目标的 FTP，返回可贴进 cover_url 的路径。
    if (req.method === 'POST' && pathname === '/api/upload-cover') {
      const { target, image } = await readJsonBody(req);
      if (!listUploadTargets().some((t) => t.key === target)) return sendJson(res, 400, { error: '上传目标无效或未配置' });
      const decoded = decodeDataUrl(image);
      if (!decoded) return sendJson(res, 400, { error: '封面图数据非法（需 webp/jpeg base64，≤8MB）' });
      const filename = `cover-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${decoded.ext}`;
      try {
        const out = await uploadCoverToTarget(target, decoded.buffer, filename);
        return sendJson(res, 200, { ok: true, path: out.path, url: out.url });
      } catch (e) {
        // 不回显 FTP 凭证/路径等内部信息，只落日志。
        console.error('[upload-cover] failed', e && e.message);
        return sendJson(res, 502, { error: '上传到 FTP 失败，请查看服务端日志' });
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
