/**
 * 智能封面图 — m3u8 自动选帧截图服务
 *
 * 依赖：本机 ffmpeg / ffprobe（无 npm 依赖）
 * 启动：node server.js  （默认 http://localhost:3000）
 */
const http = require('http');
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
      if (data.length > 1024 * 64) {
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

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await fs.promises.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && req.url === '/logo.png') {
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

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { error: '服务器内部错误', detail: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`智能封面图服务已启动: http://localhost:${PORT}`);
});
