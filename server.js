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

// 首启种子：logos 为空且根目录有 logo.png → 存为 'default'，纳入 /logos 管理，
// 手动工具与 media-videos 默认用它；chigua 等再另传新 logo。
try {
  if (logos.list().length === 0) {
    const seedPath = path.join(__dirname, 'logo.png');
    if (fs.existsSync(seedPath)) logos.save('default', fs.readFileSync(seedPath));
  }
} catch (e) { console.error('[logo seed] failed', e && e.message); }
const queue = createQueue({
  store,
  concurrency: CONCURRENCY,
  process: (job) => processCoverJob(job, { probeDuration, pickTime, captureFrame, composeCover, uploadCover, logos }),
  onDone: async (job, result) => {
    if (!job.callback) return;
    const body = result.error
      ? { status: 'failed', job_id: job.id, external_id: job.externalId, error: result.error }
      // 成功回调带超集：url（通用）+ outputs[]（兼容 webmm 现成的封面回调，取 selection_score 最高那张）
      : { status: 'completed', job_id: job.id, external_id: job.externalId, url: result.url, outputs: [{ url: result.url, selection_score: 1 }] };
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

// ---------- 后台页面 ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function adminPage(title, bodyHtml, t) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · 智能封面图</title>
<style>body{background:#0f1115;color:#e8ecf3;font-family:-apple-system,"PingFang SC",sans-serif;margin:0;padding:24px}
.wrap{max-width:1100px;margin:0 auto}a{color:#4f7cff}h1{font-size:20px}h2{font-size:16px}
table{border-collapse:collapse;width:100%;background:#181c23;border:1px solid #2a3140;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid #2a3140;font-size:13px;text-align:left;vertical-align:middle}th{color:#8b94a7;background:#1f2530}
.badge{padding:2px 8px;border-radius:20px;font-size:12px;background:#1f2530;border:1px solid #2a3140}
.nav{margin-bottom:16px;display:flex;gap:14px}img.thumb{height:40px;border-radius:4px}code{font-size:12px;color:#8b94a7;word-break:break-all}
input,button,select{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #2a3140;background:#1f2530;color:#e8ecf3}button{cursor:pointer}</style></head>
<body><div class="wrap"><div class="nav"><a href="/queue?token=${esc(t)}">队列</a><a href="/projects?token=${esc(t)}">项目</a><a href="/logos?token=${esc(t)}">Logo</a><a href="/">手动工具</a></div>${bodyHtml}</div></body></html>`;
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

    // ---------- 公开 logo 端点（给手动工具选 logo 用，非机密，无需 admin）----------
    if (req.method === 'GET' && pathname === '/logo-list') {
      return sendJson(res, 200, { logos: logos.list(), default: logos.exists('default') ? 'default' : (logos.list()[0] || null) });
    }
    if (req.method === 'GET' && pathname.startsWith('/logo-img/')) {
      let name = pathname.slice('/logo-img/'.length);
      if (name.endsWith('.png')) name = name.slice(0, -4);
      const p = logos.pathOf(name);
      if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(p));
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

    // ---------- 后台：队列列表 ----------
    if (req.method === 'GET' && pathname === '/queue') {
      if (!requireAdmin(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
      const rows = store.listJobs(200).map((j) => `<tr><td><code>${esc(j.id)}</code></td><td>${esc(j.projectKey)}</td><td><span class="badge">${esc(j.status)}</span></td><td>${esc(j.logo)}</td><td>${j.resultUrl ? `<a href="${esc(j.resultUrl)}" target="_blank"><img class="thumb" src="${esc(j.resultUrl)}"></a>` : (j.error ? '<span style="color:#ff5c6c">' + esc(j.error) + '</span>' : '—')}</td><td>${esc(j.createdAt)}</td></tr>`).join('');
      const body = `<h1>队列 <button onclick="location.reload()">刷新</button></h1><table><thead><tr><th>ID</th><th>项目</th><th>状态</th><th>logo</th><th>结果</th><th>创建时间</th></tr></thead><tbody>${rows || '<tr><td colspan=6>暂无任务</td></tr>'}</tbody></table>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(adminPage('队列', body, ADMIN_TOKEN));
    }

    // ---------- 后台：项目管理 ----------
    if (req.method === 'GET' && pathname === '/projects') {
      if (!requireAdmin(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
      const t = ADMIN_TOKEN;
      const opts = ['none', ...logos.list()];
      const rows = store.listProjects().map((p) => `<tr><td>${esc(p.key)}</td><td>${esc(p.name)}</td><td>${esc(p.defaultLogo)}</td><td><code>${esc(p.token)}</code></td>
        <td><button onclick="reset('${esc(p.key)}')">重置token</button> <button onclick="del('${esc(p.key)}')">删除</button></td></tr>`).join('');
      const body = `<h1>项目</h1>
      <table><thead><tr><th>key</th><th>名称</th><th>默认logo</th><th>token</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan=5>暂无</td></tr>'}</tbody></table>
      <h2 style="margin-top:20px">新增项目</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="k" placeholder="key(英文)"><input id="n" placeholder="名称">
      <select id="l">${opts.map((o) => `<option>${esc(o)}</option>`).join('')}</select><button onclick="add()">创建</button></div>
      <script>const T=${JSON.stringify(t)};
      async function add(){const r=await fetch('/api/projects?token='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k.value,name:n.value,defaultLogo:l.value})});if(r.ok)location.reload();else alert('失败:'+(await r.text()));}
      async function del(key){if(!confirm('删除 '+key+'?'))return;const r=await fetch('/api/projects/delete?token='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});if(r.ok)location.reload();}
      async function reset(key){const r=await fetch('/api/projects/update?token='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,token:'RESET'})});if(r.ok)location.reload();}
      </script>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(adminPage('项目', body, t));
    }

    if (req.method === 'POST' && pathname === '/api/projects') {
      if (!requireAdmin(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { key, name, defaultLogo } = await readJsonBody(req);
      if (!/^[A-Za-z0-9_-]+$/.test(String(key || ''))) return sendJson(res, 400, { error: 'key 非法' });
      try { const project = store.addProject({ key, name, defaultLogo }); return sendJson(res, 200, { ok: true, project }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/projects/update') {
      if (!requireAdmin(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { key, ...patch } = await readJsonBody(req);
      try { const project = store.updateProject(key, patch); return sendJson(res, 200, { ok: true, project }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/projects/delete') {
      if (!requireAdmin(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { key } = await readJsonBody(req);
      store.deleteProject(key); return sendJson(res, 200, { ok: true });
    }

    // ---------- 后台：logo 管理 ----------
    if (req.method === 'GET' && pathname === '/logos') {
      if (!requireAdmin(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
      const t = ADMIN_TOKEN;
      const cards = logos.list().map((n) => `<div style="display:inline-block;text-align:center;margin:8px"><div style="background:#333;padding:8px;border-radius:8px"><img src="/logos/img/${esc(n)}?token=${esc(t)}" style="height:52px"></div><div>${esc(n)}</div><button onclick="del('${esc(n)}')">删除</button></div>`).join('');
      const body = `<h1>Logo</h1><div>${cards || '暂无 logo'}</div>
      <h2 style="margin-top:20px">上传 / 替换</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input id="ln" placeholder="logo名(英文,同名=替换)"><input id="lf" type="file" accept="image/png"><button onclick="up()">上传</button></div>
      <script>const T=${JSON.stringify(t)};
      function up(){const f=lf.files[0];if(!f||!ln.value)return alert('填名字选PNG');const rd=new FileReader();rd.onload=async()=>{const b64=rd.result.split(',')[1];const r=await fetch('/api/logos?token='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:ln.value,png_base64:b64})});if(r.ok)location.reload();else alert('失败:'+(await r.text()));};rd.readAsDataURL(f);}
      async function del(name){if(!confirm('删除 '+name+'?'))return;const r=await fetch('/api/logos/delete?token='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});if(r.ok)location.reload();}
      </script>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(adminPage('Logo', body, t));
    }
    if (req.method === 'GET' && pathname.startsWith('/logos/img/')) {
      if (!requireAdmin(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
      const name = pathname.slice('/logos/img/'.length);
      const p = logos.pathOf(name);
      if (!p) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(p));
    }
    if (req.method === 'POST' && pathname === '/api/logos') {
      if (!requireAdmin(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { name, png_base64 } = await readJsonBody(req);
      try { logos.save(name, Buffer.from(String(png_base64 || ''), 'base64')); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/logos/delete') {
      if (!requireAdmin(req)) return sendJson(res, 403, { error: 'forbidden' });
      const { name } = await readJsonBody(req);
      logos.remove(name); return sendJson(res, 200, { ok: true });
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
