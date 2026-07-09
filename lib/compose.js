/**
 * 服务端封面拼图：把 3 张帧拼成横排封面，叠左上角 logo，导出 640×360 WebP。
 * 忠实复刻手动工具 index.html 的 stitch() 'h' 布局 + drawCover + logo 投影。
 */
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const OUT_W = 1280, OUT_H = 720;      // 内部合成尺寸（同手动工具）
const EXPORT_W = 640, EXPORT_H = 360; // 导出尺寸
const CROP_TOP = 0.075;               // 裁顶比例

// object-fit: cover，先掐掉源图顶部再取景（与手动工具 drawCover 一致）
function drawCover(ctx, img, x, y, dw, dh) {
  const top = Math.min(CROP_TOP, 0.2) * img.height;
  const availW = img.width, availH = img.height - top;
  const sRatio = availW / availH, dRatio = dw / dh;
  let sw = availW, sh = availH, sx = 0, sy = top;
  if (sRatio > dRatio) { sw = sh * dRatio; sx = (availW - sw) / 2; }
  else { sh = sw / dRatio; sy = top + (availH - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, dw, dh);
}

async function composeCover({ frames, logoPath }) {
  if (!Array.isArray(frames) || frames.length < 3) throw new Error('需要 3 帧');
  const imgs = await Promise.all(frames.slice(0, 3).map((b) => loadImage(b)));

  const big = createCanvas(OUT_W, OUT_H);
  const ctx = big.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, OUT_W, OUT_H);

  // 横排：三列等宽
  const cw = Math.round(OUT_W / 3);
  drawCover(ctx, imgs[0], 0, 0, cw, OUT_H);
  drawCover(ctx, imgs[1], cw, 0, cw, OUT_H);
  drawCover(ctx, imgs[2], cw * 2, 0, OUT_W - cw * 2, OUT_H);

  // 左上角 logo：无底板，用黑投影衬出，画两遍加深轮廓
  if (logoPath) {
    const logo = await loadImage(logoPath);
    const lw = 400, lh = Math.round(lw * logo.height / logo.width);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = 18;
    ctx.drawImage(logo, 24, 24, lw, lh);
    ctx.drawImage(logo, 24, 24, lw, lh);
    ctx.restore();
  }

  // 超采样降到 640×360
  const small = createCanvas(EXPORT_W, EXPORT_H);
  small.getContext('2d').drawImage(big, 0, 0, EXPORT_W, EXPORT_H);
  return await small.encode('webp', 90);
}

module.exports = { composeCover };
