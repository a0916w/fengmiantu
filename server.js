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
const { uploadCover, publishUploadConfig, publishCallbackHosts } = require('./lib/upload');
const { readJsonBody, sendJson, decodeDataUrl, httpPostJson, httpGetImage, callbackAllowed } = require('./lib/net');
const { logUsage, readUsage, aggregate, filePath: usageFilePath, DEFAULT_DIR: USAGE_DIR } = require('./lib/usage');

const PORT = process.env.PORT || 3000;

// 运营指标接口 /api/report/ops 的 Bearer 口令。运营系统(ops-report)按 provider 契约拉取。
// 未设置则**关闭**端点(503)——不 fail-open；比较用定长 timingSafeEqual 防时序攻击。
const REPORT_API_TOKEN = process.env.REPORT_API_TOKEN || '';
function reportAuthReject(req, res) {
  if (!REPORT_API_TOKEN) {
    sendJson(res, 503, { error: '运营指标接口未启用（请设置 REPORT_API_TOKEN）' });
    return true;
  }
  const h = req.headers['authorization'] || '';
  const provided = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(REPORT_API_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return false;
  sendJson(res, 401, { error: 'invalid token' });
  return true;
}

// 报表页访问口令。未设置则 /report 关闭（返回提示），避免默认裸奔。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function verifyAdminToken(token) {
  if (!ADMIN_TOKEN) return false;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// SSRF 兜底：拒绝回环 / 私网 / 链路本地(含云元数据 169.254) 主机。
function isBlockedHost(h) {
  h = String(h || '').toLowerCase();
  if (h === '' || h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

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

    // 原封面代理：同域中转远程图片，绕过 canvas 跨域污染（「原有封面盖logo」用 ?cover= 时）。
    if (req.method === 'GET' && pathname === '/api/proxy-image') {
      const target = new URL(req.url, 'http://localhost').searchParams.get('url') || '';
      let host = '';
      try { host = new URL(target).hostname; } catch { return sendJson(res, 400, { error: 'url 非法' }); }
      if (isBlockedHost(host)) return sendJson(res, 403, { error: '目标地址不允许' });
      const allow = (process.env.COVER_PROXY_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (allow.length && !allow.includes(host)) return sendJson(res, 403, { error: '不在代理白名单' });
      try {
        const { contentType, buffer } = await httpGetImage(target);
        // 只放位图；拒 svg（会带脚本，同域返回=存储型 XSS）+ CSP/sandbox 兜底。
        const ct = String(contentType).split(';')[0].trim().toLowerCase();
        if (!/^image\/(png|jpe?g|webp|gif|bmp)$/.test(ct)) {
          return sendJson(res, 415, { error: '仅支持位图图片(png/jpg/webp/gif/bmp，不含 svg)' });
        }
        res.writeHead(200, {
          'Content-Type': ct,
          'Content-Length': buffer.length,
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        return res.end(buffer);
      } catch (e) {
        return sendJson(res, 502, { error: '拉取失败: ' + ((e && e.message) || e) });
      }
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
        logUsage({ type: 'frame' }); // 埋点：生成截图（仅「新做封面」tab 会截帧）
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

    // 回调发布：项目从后台跳来（带 ?logo&external_id&callback），做好封面点「用作封面」→
    // 按 logo 传到对应 FTP + 回调项目更新封面。logo 无专属配置时用全局 FTP_*/COVER_CALLBACK_HOSTS。
    if (req.method === 'POST' && req.url === '/api/publish') {
      const { image, external_id: externalId, callback, logo, mode } = await readJsonBody(req);
      if (!externalId || typeof externalId !== 'string') return sendJson(res, 400, { error: '缺少 external_id' });
      const logoName = typeof logo === 'string' ? logo : '';
      const uiMode = mode === 'logo' ? 'logo' : (mode === 'cover' ? 'cover' : '');
      // 回调地址防 SSRF：拒元数据/回环，按该 logo 的白名单校验（缺省全局）。
      const cbHosts = publishCallbackHosts(logoName);
      if (!callbackAllowed(callback, cbHosts)) {
        let cbHost = ''; try { cbHost = new URL(callback).hostname; } catch {}
        console.error('[publish] callback rejected', 'logo=' + logoName, 'callbackHost=' + cbHost, 'allow=' + JSON.stringify(cbHosts));
        return sendJson(res, 400, { error: '回调地址不被允许' });
      }
      const decoded = decodeDataUrl(image);
      if (!decoded) return sendJson(res, 400, { error: '封面图数据非法（需 webp/jpeg base64，≤8MB）' });

      const safeId = externalId.replace(/[^A-Za-z0-9_-]/g, '');
      const filename = `cover-${safeId}-${crypto.randomBytes(4).toString('hex')}.${decoded.ext}`;
      const tStart = Date.now();
      console.log(`[publish] start external_id=${externalId} logo=${logoName} size=${decoded.buffer.length}`);
      try {
        const url = await uploadCover(decoded.buffer, filename, publishUploadConfig(logoName));
        const tFtp = Date.now();
        const cb = await httpPostJson(callback, {
          status: 'completed',
          external_id: externalId,
          outputs: [{ url, selection_score: 1 }],
        });
        console.log(`[publish] done external_id=${externalId} ftp_ms=${tFtp - tStart} callback_ms=${Date.now() - tFtp} cb_status=${cb.status}`);
        logUsage({ type: 'publish', mode: uiMode, logo: logoName }); // 埋点：用作封面（按 tab + logo）
        if (cb.status < 200 || cb.status >= 300) {
          // 不回显回调响应体（可能含内部信息）；细节只落服务端日志。
          let cbHost = ''; try { cbHost = new URL(callback).hostname; } catch {}
          console.error('[publish] callback non-2xx', 'logo=' + logoName, 'host=' + cbHost, 'status=' + cb.status, 'body=' + String(cb.body).slice(0, 300));
          return sendJson(res, 502, { error: '回调项目失败（HTTP ' + cb.status + '）' });
        }
        return sendJson(res, 200, { ok: true, url });
      } catch (e) {
        // 不把内部错误（FTP 地址/路径等）回给调用方；只落日志。
        console.error(`[publish] failed external_id=${externalId} logo=${logoName} ms=${Date.now() - tStart} err=${(e && e.message) || e}`);
        return sendJson(res, 502, { error: '发布封面失败（服务端上传失败，请重试；已记录日志）' });
      }
    }

    // 埋点：生成/下载封面。前端 canvas 本地出图，服务端无从感知，靠这个轻量 ping 记一次
    // （这才是「用了几次」的主力来源——猫咪封面都是人工在网页做完直接下载，不走 publish）。
    if (req.method === 'POST' && pathname === '/api/track') {
      try {
        const { mode, logo } = await readJsonBody(req);
        const uiMode = mode === 'logo' ? 'logo' : (mode === 'cover' ? 'cover' : '');
        logUsage({ type: 'download', mode: uiMode, logo: typeof logo === 'string' ? logo : '' });
      } catch { /* 埋点失败不影响下载本身 */ }
      return sendJson(res, 200, { ok: true });
    }

    // 埋点诊断：不用 SSH 就能看数据文件到底能不能写、有多少条、最近几条。?token=ADMIN_TOKEN。
    // 「报表不更新」时开这个网址就知道是「没写进去(权限/属主)」还是「压根没触发埋点」。
    if (req.method === 'GET' && pathname === '/api/usage-debug') {
      const u = new URL(req.url, 'http://localhost');
      if (!verifyAdminToken(u.searchParams.get('token') || '')) return sendJson(res, 401, { error: 'bad token' });
      const fp = usageFilePath();
      let exists = false, size = 0, dirWritable = false, err = null;
      try { const st = fs.statSync(fp); exists = true; size = st.size; } catch {}
      try { fs.mkdirSync(USAGE_DIR, { recursive: true }); fs.accessSync(USAGE_DIR, fs.constants.W_OK); dirWritable = true; } catch (e) { err = String((e && e.message) || e); }
      const all = readUsage();
      return sendJson(res, 200, {
        data_dir: USAGE_DIR,
        file: fp,
        file_exists: exists,
        file_size: size,
        dir_writable: dirWritable,
        write_error: err,
        total_events: all.length,
        by_type: all.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {}),
        last5: all.slice(-5),
        process_uid: typeof process.getuid === 'function' ? process.getuid() : null,
        process_user: process.env.USER || process.env.LOGNAME || null,
        now_utc: new Date().toISOString(),
      });
    }

    // 标准运营指标接口：运营系统(ops-report)按 /api/report/ops 通用 sections[] 契约拉取。
    // 参数 from/to(YYYY-MM-DD，缺省近90天)；Bearer REPORT_API_TOKEN 保护(未设则开放)。
    // 无需运营系统改代码——那边只加一条数据源(ops_endpoint=本地址)即可在「运营指标」页显示。
    if (req.method === 'GET' && pathname === '/api/report/ops') {
      if (reportAuthReject(req, res)) return;
      const u = new URL(req.url, 'http://localhost');
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      let from = (u.searchParams.get('from') || '').trim();
      let to = (u.searchParams.get('to') || '').trim();
      const today = new Date().toISOString().slice(0, 10);
      if (!from && !to) {
        to = today;
        from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
      } else if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
        return sendJson(res, 400, { error: 'from & to (YYYY-MM-DD) required, from<=to' });
      }
      // 取区间内事件再聚合。
      const events = readUsage({ sinceDays: 3650 }).filter((e) => {
        const d = String(e.ts).slice(0, 10);
        return d >= from && d <= to;
      });
      const { days: dayRows, detail } = aggregate(events);
      const sections = [
        {
          key: 'cover_workshop_daily', title: '封面工坊 · 按天', type: 'table',
          columns: [
            { key: 'date', label: '日期', fmt: 'date' },
            { key: 'frames', label: '生成截图', fmt: 'int' },
            { key: 'downloads', label: '生成/下载封面', fmt: 'int' },
            { key: 'publishes', label: '用作封面', fmt: 'int' },
          ],
          rows: dayRows.map((d) => ({ date: d.date, frames: d.frames, downloads: d.downloads, publishes: d.publishes })),
        },
        {
          key: 'cover_workshop_detail', title: '用作封面明细 · 模式/logo', type: 'table',
          columns: [
            { key: 'date', label: '日期', fmt: 'date' },
            { key: 'label', label: '模式', fmt: 'text' },
            { key: 'logo', label: 'logo', fmt: 'text' },
            { key: 'count', label: '次数', fmt: 'int' },
          ],
          rows: detail.map((x) => ({ date: x.date, label: x.label, logo: x.logo, count: x.count })),
        },
      ];
      return sendJson(res, 200, {
        project_code: (u.searchParams.get('project_code') || '').trim(),
        from, to, timezone: 'UTC', sections,
      });
    }

    // 使用报表：按天统计「生成截图数 / 用作封面数」，用作封面再按 tab(模式) + logo 明细。
    // 口令保护：需 ?token= 与 ADMIN_TOKEN 一致；未设 ADMIN_TOKEN 则整页关闭。
    if (req.method === 'GET' && pathname === '/report') {
      const u = new URL(req.url, 'http://localhost');
      const token = u.searchParams.get('token') || '';

      if (!ADMIN_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end('<meta charset="utf-8"><body style="font-family:sans-serif;background:#0f1115;color:#e8ecf3;padding:40px"><h3>报表未启用</h3><p style="color:#8b94a7">请在服务端设置环境变量 <code>ADMIN_TOKEN</code> 后重启。</p></body>');
      }
      if (!verifyAdminToken(token)) {
        // 简单口令表单（GET 带 token 重新进入，不落任何存储）。
        res.writeHead(token ? 403 : 401, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>报表 · 智能封面图</title>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;background:#0f1115;color:#e8ecf3;min-height:100vh;display:flex;align-items:center;justify-content:center">
<form method="get" action="/report" style="background:#181c23;border:1px solid #2a3140;border-radius:12px;padding:28px;min-width:280px">
  <h3 style="margin:0 0 14px">📊 封面使用报表</h3>
  ${token ? '<p style="color:#ff5c6c;margin:0 0 12px;font-size:13px">口令错误</p>' : ''}
  <input name="token" type="password" placeholder="访问口令" autofocus style="width:100%;padding:10px 12px;border:1px solid #2a3140;border-radius:8px;background:#0f1115;color:#e8ecf3;font-size:14px">
  <button style="margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#4f7cff;color:#fff;font-size:14px;cursor:pointer">进入</button>
</form></body>`);
      }

      const events = readUsage({ sinceDays: 90 });
      const { days, detail, totals } = aggregate(events);
      const dayRows = days.slice(0, 90).map((s) =>
        `<tr><td class="mono">${escapeHtml(s.date)}</td><td>${s.frames}</td><td style="color:var(--accent)">${s.downloads}</td><td style="color:var(--green)">${s.publishes}</td></tr>`).join('');
      const detailRows = detail.slice(0, 500).map((x) =>
        `<tr><td class="mono">${escapeHtml(x.date)}</td><td>${escapeHtml(x.label)}</td><td>${escapeHtml(x.logo)}</td><td style="color:var(--green)">${x.count}</td></tr>`).join('');

      const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>使用报表 · 智能封面图</title>
<style>
  :root{--bg:#0f1115;--panel:#181c23;--panel-2:#1f2530;--border:#2a3140;--text:#e8ecf3;--text-dim:#8b94a7;--accent:#4f7cff;--green:#2ecc8f;--radius:12px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;padding:24px}
  .wrap{max-width:900px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .logo{display:flex;align-items:center;gap:8px;font-size:20px;font-weight:700}
  a.back{font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--border);padding:6px 12px;border-radius:8px}
  .sum{color:var(--text-dim);font-size:13px;margin:4px 0 0}
  h2.sec{font-size:15px;margin:22px 0 10px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow-x:auto}
  table{border-collapse:collapse;width:100%;min-width:420px}
  th{background:var(--panel-2);color:var(--text-dim);font-size:12px;font-weight:600;text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:10px 14px;font-size:14px;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .empty{padding:40px;text-align:center;color:var(--text-dim)}
</style></head>
<body><div class="wrap">
  <header>
    <div class="logo"><span style="color:var(--accent)">📊</span> 封面使用报表</div>
    <a class="back" href="/">← 返回工具</a>
  </header>
  <p class="sum">近 90 天 · 生成截图 ${totals.frames} 张 · 生成/下载封面 ${totals.downloads} 次 · 用作封面 ${totals.publishes} 次</p>
  <h2 class="sec">按天汇总</h2>
  <div class="card">${dayRows ? `<table><thead><tr><th>日期</th><th>生成截图</th><th>生成/下载封面</th><th>用作封面</th></tr></thead><tbody>${dayRows}</tbody></table>` : '<div class="empty">暂无数据</div>'}</div>
  <h2 class="sec">封面产出明细 · 按天 / 模式 / logo（哪个 logo 用了几次）</h2>
  <div class="card">${detailRows ? `<table><thead><tr><th>日期</th><th>模式(tab)</th><th>logo</th><th>次数</th></tr></thead><tbody>${detailRows}</tbody></table>` : '<div class="empty">暂无记录</div>'}</div>
</div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
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
