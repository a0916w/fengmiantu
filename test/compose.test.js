const { test } = require('node:test');
const assert = require('node:assert');
const { createCanvas } = require('@napi-rs/canvas');
const { composeCover } = require('../lib/compose');

// 造 3 张纯色 JPEG 作输入帧
function solidJpeg(color, w = 640, h = 360) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
  return c.toBuffer('image/jpeg');
}
function logoPng() {
  const c = createCanvas(192, 52);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,1)'; ctx.fillRect(0, 0, 192, 52);
  return c.toBuffer('image/png');
}

test('composeCover 无 logo → 640x360 webp', async () => {
  const frames = [solidJpeg('#f00'), solidJpeg('#0f0'), solidJpeg('#00f')];
  const out = await composeCover({ frames, logoPath: null });
  assert.ok(Buffer.isBuffer(out) && out.length > 0);
  // WebP 魔数：RIFF....WEBP
  assert.strictEqual(out.slice(0, 4).toString('ascii'), 'RIFF');
  assert.strictEqual(out.slice(8, 12).toString('ascii'), 'WEBP');
});

test('composeCover 带 logo 也能出图', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const p = path.join(os.tmpdir(), 'logo-test-' + process.pid + '.png');
  fs.writeFileSync(p, logoPng());
  const frames = [solidJpeg('#f00'), solidJpeg('#0f0'), solidJpeg('#00f')];
  const out = await composeCover({ frames, logoPath: p });
  assert.ok(out.length > 0);
  fs.unlinkSync(p);
});

test('帧数不足抛错', async () => {
  await assert.rejects(() => composeCover({ frames: [], logoPath: null }), /需要 3 帧/);
});
