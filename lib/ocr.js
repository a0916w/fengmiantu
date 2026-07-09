/**
 * 文字检测（自动去文字功能的服务端部分），按平台自动选后端：
 * - macOS: Vision 框架（ocr.swift 启动时自动编译）
 * - Linux: tesseract（apt install tesseract-ocr tesseract-ocr-chi-sim）
 * 都不可用时 detectText 恒返回 []，功能静默关闭，不影响其余接口。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

const OCR_SRC = path.join(__dirname, '..', 'ocr.swift');
const OCR_BIN = path.join(os.tmpdir(), `fengmiantu-ocr-${process.pid}`);
let ocrBackend = null; // 'vision' | 'tesseract' | null
let tessLangs = 'eng';

if (process.platform === 'darwin' && fs.existsSync(OCR_SRC)) {
  run('swiftc', ['-O', OCR_SRC, '-o', OCR_BIN], 180_000)
    .then(() => { ocrBackend = 'vision'; console.log('文字识别组件已就绪（macOS Vision）'); })
    .catch((e) => console.log('Vision 组件编译失败，去文字功能不可用:', String(e.stderr || e.message).slice(0, 200)));
  process.on('exit', () => { try { fs.rmSync(OCR_BIN, { force: true }); } catch {} });
} else {
  run('tesseract', ['--list-langs'], 10_000)
    .then(({ stdout, stderr }) => {
      const langs = (stdout + stderr).split('\n').map((s) => s.trim());
      tessLangs = ['chi_sim', 'eng'].filter((l) => langs.includes(l)).join('+') || 'eng';
      ocrBackend = 'tesseract';
      console.log(`文字识别组件已就绪（tesseract，语言: ${tessLangs}）`);
      if (!langs.includes('chi_sim')) {
        console.log('提示: 未安装中文语言包，中文水印检测会漏。安装: apt install tesseract-ocr-chi-sim');
      }
    })
    .catch(() => {
      console.log('未检测到 OCR 组件，去文字功能不可用。Linux 安装: apt install tesseract-ocr tesseract-ocr-chi-sim');
    });
}

/** 检测图片中的文字框，返回 [{x,y,w,h}]（0~1 比例，左上原点）；不可用时返回空数组 */
async function detectText(file) {
  try {
    if (ocrBackend === 'vision') {
      const { stdout } = await run(OCR_BIN, [file], 20_000);
      const boxes = JSON.parse(stdout);
      return Array.isArray(boxes) ? boxes.slice(0, 50) : [];
    }
    if (ocrBackend === 'tesseract') return await tesseractDetect(file);
  } catch {}
  return [];
}

/** tesseract TSV 输出 → 归一化文字框。psm 11 = 稀疏文字模式，适合水印/字幕 */
async function tesseractDetect(file) {
  const { stdout } = await run(
    'tesseract', [file, 'stdout', '--psm', '11', '-l', tessLangs, 'tsv'], 30_000
  );
  let W = 0, H = 0;
  const boxes = [];
  for (const line of stdout.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12) continue;
    const level = +c[0];
    if (level === 1) { W = +c[8]; H = +c[9]; continue; } // page 行携带整图尺寸
    if (level !== 5) continue; // 只要 word 级
    const conf = parseFloat(c[10]);
    const text = (c[11] || '').trim();
    if (conf < 40 || !text) continue;
    boxes.push({ left: +c[6], top: +c[7], w: +c[8], h: +c[9] });
  }
  if (!W || !H) return [];
  return boxes.slice(0, 50).map((b) => ({ x: b.left / W, y: b.top / H, w: b.w / W, h: b.h / H }));
}

module.exports = { detectText };
