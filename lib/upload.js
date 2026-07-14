/**
 * 封面上传：本地 stub（测试）或 FTP（生产），返回可公开访问的完整 URL。
 * 从 server.js 抽出，供 /api/publish 与队列 worker 共用。
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

/**
 * 上传封面，返回可公开访问的完整 URL。
 * - 测试/本地：设 COVER_UPLOAD_STUB_DIR 时写本地文件，URL = FTP_URL_PREFIX + '/' + 文件名。
 * - 生产：走 FTP（被动模式 STOR，二进制），URL = FTP_URL_PREFIX + '/' + 文件名。
 */
async function uploadCover(buffer, filename) {
  const prefix = (process.env.FTP_URL_PREFIX || '').replace(/\/+$/, '');
  if (!prefix) throw new Error('未配置 FTP_URL_PREFIX（回传给 webmm 的图片地址前缀）');

  const stubDir = process.env.COVER_UPLOAD_STUB_DIR;
  if (stubDir) {
    await fs.promises.mkdir(stubDir, { recursive: true });
    await fs.promises.writeFile(path.join(stubDir, filename), buffer);
  } else {
    await ftpStore(buffer, filename);
  }
  return prefix + '/' + filename;
}

/** 最小 FTP 客户端：被动模式二进制 STOR 单文件。零 npm 依赖。 */
function ftpStore(buffer, filename) {
  const host = process.env.FTP_HOST;
  const port = parseInt(process.env.FTP_PORT || '21', 10);
  const user = process.env.FTP_USER;
  const pass = process.env.FTP_PASS || '';
  const dir = (process.env.FTP_DIR || '').replace(/\/+$/, '');
  const timeoutMs = parseInt(process.env.FTP_TIMEOUT_MS || '360000', 10); // 默认 360s，可 env 调
  if (!host || !user) return Promise.reject(new Error('未配置 FTP_HOST / FTP_USER'));

  return new Promise((resolve, reject) => {
    const ctrl = net.connect({ host, port });
    ctrl.setEncoding('utf8');
    ctrl.setTimeout(timeoutMs);

    let buf = '';
    let waiter = null;
    const done = (err) => { try { ctrl.destroy(); } catch {} err ? reject(err) : resolve(); };

    ctrl.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3} /.test(line) && waiter) { const w = waiter; waiter = null; w(line); }
      }
    });
    ctrl.on('timeout', () => done(new Error('FTP 控制连接超时')));
    ctrl.on('error', (e) => done(e));

    const expect = (codes) => new Promise((res, rej) => {
      waiter = (line) => {
        const code = parseInt(line.slice(0, 3), 10);
        codes.includes(code) ? res(line) : rej(new Error('FTP 应答 ' + line.slice(0, 60)));
      };
    });
    const cmd = (c) => { ctrl.write(c + '\r\n'); };

    (async () => {
      await expect([220]);
      cmd('USER ' + user); await expect([331, 230]);
      if (pass) { cmd('PASS ' + pass); await expect([230]); }
      cmd('TYPE I'); await expect([200]);
      cmd('PASV');
      const pasv = await expect([227]);
      const mm = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv);
      if (!mm) throw new Error('PASV 解析失败');
      const dataHost = mm.slice(1, 5).join('.');
      const dataPort = (parseInt(mm[5], 10) << 8) + parseInt(mm[6], 10);

      const remote = (dir ? dir + '/' : '') + filename;
      const data = net.connect({ host: dataHost, port: dataPort });
      data.setTimeout(timeoutMs);
      const dataClosed = new Promise((res, rej) => {
        data.on('error', rej);
        data.on('timeout', () => rej(new Error('FTP 数据连接超时')));
        data.on('close', res);
      });
      await new Promise((res, rej) => { data.on('connect', res); data.on('error', rej); });

      cmd('STOR ' + remote);
      await expect([150, 125]);
      data.end(buffer);
      await dataClosed;
      await expect([226, 250]);
      cmd('QUIT');
      done(null);
    })().catch(done);
  });
}

// ---- 多目标上传（手动网页「上传到 FTP」按钮用；每个目标各配一台 FTP）----
// env（KEY 大写、非字母数字转 _）：
//   UPLOAD_TARGETS=vodvip[,其他]
//   UPLOAD_<KEY>_LABEL       下拉展示名（缺省 = key）
//   UPLOAD_<KEY>_FTP_HOST/PORT/USER/PASS
//   UPLOAD_<KEY>_FTP_DIR     STOR 前先 CWD 进的目录（= 目标站 {UPLOAD_FTP_BASE_DIR}/covers，须已存在）
//   UPLOAD_<KEY>_COVER_PATH  返回给用户贴进 cover_url 的相对路径前缀（= 目标站 /{UPLOAD_COVER_URL_PREFIX}/covers）
//   UPLOAD_<KEY>_URL_PREFIX  可选，CDN 完整 URL 前缀（仅用于预览展示）
//   UPLOAD_<KEY>_FTP_TIMEOUT_MS 可选，默认取 FTP_TIMEOUT_MS 或 360000
function envKey(key) { return String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_'); }

function uploadTargetConfig(key) {
  const K = envKey(key);
  const host = process.env[`UPLOAD_${K}_FTP_HOST`];
  const user = process.env[`UPLOAD_${K}_FTP_USER`];
  if (!host || !user) return null;
  return {
    key,
    label: process.env[`UPLOAD_${K}_LABEL`] || key,
    host,
    port: parseInt(process.env[`UPLOAD_${K}_FTP_PORT`] || '21', 10),
    user,
    pass: process.env[`UPLOAD_${K}_FTP_PASS`] || '',
    dir: (process.env[`UPLOAD_${K}_FTP_DIR`] || '').replace(/\/+$/, ''),
    coverPath: (process.env[`UPLOAD_${K}_COVER_PATH`] || '').replace(/\/+$/, ''),
    urlPrefix: (process.env[`UPLOAD_${K}_URL_PREFIX`] || '').replace(/\/+$/, ''),
    timeoutMs: parseInt(process.env[`UPLOAD_${K}_FTP_TIMEOUT_MS`] || process.env.FTP_TIMEOUT_MS || '360000', 10),
  };
}

// 已配置好的目标列表（只回 key/label，不泄露 FTP 凭证）。
function listUploadTargets() {
  return (process.env.UPLOAD_TARGETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((key) => uploadTargetConfig(key)).filter(Boolean)
    .map((c) => ({ key: c.key, label: c.label }));
}

// 把 buffer 传到指定目标的 FTP，返回 { path, url }：
//   path = 贴进目标站 cover_url 的相对路径（与目标站自己「上传封面」产出的格式一致）
//   url  = 配了 URL_PREFIX 时的完整预览地址（否则空串）
async function uploadCoverToTarget(key, buffer, filename) {
  const cfg = uploadTargetConfig(key);
  if (!cfg) throw new Error('上传目标未配置: ' + key);
  const stubDir = process.env.COVER_UPLOAD_STUB_DIR;
  if (stubDir) {
    await fs.promises.mkdir(stubDir, { recursive: true });
    await fs.promises.writeFile(path.join(stubDir, filename), buffer);
  } else {
    await ftpStoreCwd(cfg, buffer, filename);
  }
  const relPath = (cfg.coverPath ? '/' + cfg.coverPath.replace(/^\/+/, '') : '') + '/' + filename;
  const url = cfg.urlPrefix ? cfg.urlPrefix + relPath : '';
  return { path: relPath, url };
}

// 带 CWD 的被动模式 STOR：对齐 vodvip 的 ftp_chdir + ftp_put（covers 目录须已存在，不建目录）。
// 与上面的 ftpStore（env 单目标、STOR 全路径、无 CWD）分开，避免动到 webmm 发布链路。
function ftpStoreCwd(cfg, buffer, filename) {
  return new Promise((resolve, reject) => {
    const ctrl = net.connect({ host: cfg.host, port: cfg.port });
    ctrl.setEncoding('utf8');
    ctrl.setTimeout(cfg.timeoutMs);

    let buf = '';
    let waiter = null;
    const done = (err) => { try { ctrl.destroy(); } catch {} err ? reject(err) : resolve(); };

    ctrl.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3} /.test(line) && waiter) { const w = waiter; waiter = null; w(line); }
      }
    });
    ctrl.on('timeout', () => done(new Error('FTP 控制连接超时')));
    ctrl.on('error', (e) => done(e));

    const expect = (codes) => new Promise((res, rej) => {
      waiter = (line) => {
        const code = parseInt(line.slice(0, 3), 10);
        codes.includes(code) ? res(line) : rej(new Error('FTP 应答 ' + line.slice(0, 60)));
      };
    });
    const cmd = (c) => { ctrl.write(c + '\r\n'); };

    (async () => {
      await expect([220]);
      cmd('USER ' + cfg.user); await expect([331, 230]);
      if (cfg.pass) { cmd('PASS ' + cfg.pass); await expect([230]); }
      cmd('TYPE I'); await expect([200]);
      if (cfg.dir) { cmd('CWD ' + cfg.dir); await expect([250]); }
      cmd('PASV');
      const pasv = await expect([227]);
      const mm = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv);
      if (!mm) throw new Error('PASV 解析失败');
      const dataHost = mm.slice(1, 5).join('.');
      const dataPort = (parseInt(mm[5], 10) << 8) + parseInt(mm[6], 10);

      const data = net.connect({ host: dataHost, port: dataPort });
      data.setTimeout(cfg.timeoutMs);
      const dataClosed = new Promise((res, rej) => {
        data.on('error', rej);
        data.on('timeout', () => rej(new Error('FTP 数据连接超时')));
        data.on('close', res);
      });
      await new Promise((res, rej) => { data.on('connect', res); data.on('error', rej); });

      cmd('STOR ' + filename);
      await expect([150, 125]);
      data.end(buffer);
      await dataClosed;
      await expect([226, 250]);
      cmd('QUIT');
      done(null);
    })().catch(done);
  });
}

module.exports = { uploadCover, ftpStore, listUploadTargets, uploadCoverToTarget };
