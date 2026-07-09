/**
 * ffmpeg/ffprobe 抽帧相关：探时长、智能截帧、选帧时间点。
 * 从 server.js 抽出，供手动工具路由与队列 worker 共用。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createSemaphore } = require('./semaphore');
const { detectText } = require('./ocr');

// 进程级 ffmpeg 抽帧并发闸：手动工具(/api/frame)与队列 worker 共享同一上限。
const ffmpegSem = createSemaphore(parseInt(process.env.FFMPEG_MAX_CONCURRENCY || '4', 10));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fengmiantu-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

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
 * 在指定时间点附近智能截一帧：先快进到 t，再解码一小批帧，用 thumbnail 滤镜挑出
 * 最有代表性的一帧（自动避开黑屏、转场、模糊帧）。
 */
function captureFrame(url, t) {
  return ffmpegSem.run(() => _captureFrameRaw(url, t));
}

/** 同 captureFrame，另带画面内文字框（供手动工具「自动去文字」用），返回 { buf, textBoxes } */
function captureFrameWithText(url, t) {
  return ffmpegSem.run(() => _captureFrameRaw(url, t, true));
}

async function _captureFrameRaw(url, t, withText) {
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
    if (!withText) return buf;
    const textBoxes = await detectText(out);
    return { buf, textBoxes };
  } finally {
    fs.promises.unlink(out).catch(() => {});
  }
}

/**
 * 为第 index 段（共 count 段）挑一个截图时间点。
 * 有时长：掐掉片头片尾各 8%，中间均分 count 段，段中部随机取点；
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

module.exports = { isAllowedUrl, probeDuration, captureFrame, captureFrameWithText, pickTime };
