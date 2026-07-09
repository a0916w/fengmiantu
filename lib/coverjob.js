/**
 * 单个封面任务流水线：探时长 → 抽默认 3 帧 → 服务端拼图 → 上传，返回 { url }。
 * 依赖全部注入，方便单测（不碰真实 ffmpeg/FTP）。
 */
const crypto = require('crypto');

async function processCoverJob(job, deps) {
  const { probeDuration, pickTime, captureFrame, composeCover, uploadCover, logos } = deps;

  let duration = null;
  try { duration = await probeDuration(job.url); } catch { duration = null; } // 直播/无时长：从头选帧

  const frames = [];
  for (let i = 0; i < 3; i++) {
    const t = pickTime(duration, i, 3);
    frames.push(await captureFrame(job.url, t));
  }

  const logoPath = job.logo && job.logo !== 'none' ? logos.pathOf(job.logo) : null;
  const buffer = await composeCover({ frames, logoPath });

  const filename = `cover-${String(job.id).replace(/[^A-Za-z0-9_-]/g, '')}-${crypto.randomBytes(4).toString('hex')}.webp`;
  const url = await uploadCover(buffer, filename);
  return { url };
}

module.exports = { processCoverJob };
