/**
 * 封面上传：本地 stub（测试）或 FTP（生产），返回可公开访问的完整 URL。
 * 供 /api/publish（回调发布）使用。支持按 logo 走不同 FTP / URL 前缀 / 回调白名单，
 * 没有该 logo 专属配置时退回全局 FTP_* / FTP_URL_PREFIX / COVER_CALLBACK_HOSTS。
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

function envKey(key) { return String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_'); }

// 回调发布用的 per-logo FTP 配置：logo 配了 LOGO_<K>_FTP_HOST 用它那套；否则用全局 FTP_*。
//   LOGO_<K>_FTP_HOST/PORT/USER/PASS/DIR、LOGO_<K>_FTP_URL_PREFIX、LOGO_<K>_FTP_TIMEOUT_MS
function publishFtpConfig(logo) {
  const g = process.env;
  const K = logo ? envKey(logo) : '';
  if (K && g[`LOGO_${K}_FTP_HOST`]) {
    return {
      host: g[`LOGO_${K}_FTP_HOST`],
      port: parseInt(g[`LOGO_${K}_FTP_PORT`] || g.FTP_PORT || '21', 10),
      user: g[`LOGO_${K}_FTP_USER`] || '',
      pass: g[`LOGO_${K}_FTP_PASS`] || '',
      dir: (g[`LOGO_${K}_FTP_DIR`] || '').replace(/\/+$/, ''),
      urlPrefix: (g[`LOGO_${K}_FTP_URL_PREFIX`] || g.FTP_URL_PREFIX || '').replace(/\/+$/, ''),
      timeoutMs: parseInt(g[`LOGO_${K}_FTP_TIMEOUT_MS`] || g.FTP_TIMEOUT_MS || '360000', 10),
    };
  }
  return {
    host: g.FTP_HOST,
    port: parseInt(g.FTP_PORT || '21', 10),
    user: g.FTP_USER || '',
    pass: g.FTP_PASS || '',
    dir: (g.FTP_DIR || '').replace(/\/+$/, ''),
    urlPrefix: (g.FTP_URL_PREFIX || '').replace(/\/+$/, ''),
    timeoutMs: parseInt(g.FTP_TIMEOUT_MS || '360000', 10),
  };
}

// 回调白名单：logo 配了 LOGO_<K>_CALLBACK_HOSTS 用它；否则用全局 COVER_CALLBACK_HOSTS。
function publishCallbackHosts(logo) {
  const K = logo ? envKey(logo) : '';
  const raw = (K && process.env[`LOGO_${K}_CALLBACK_HOSTS`]) || process.env.COVER_CALLBACK_HOSTS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 上传封面，返回可公开访问的完整 URL（ftp.urlPrefix + '/' + 文件名）。
 * @param {Buffer} buffer  图片字节
 * @param {string} filename 远端文件名
 * @param {object} [ftp]   来自 publishFtpConfig() 的配置；缺省用全局 FTP_*。
 * - 测试/本地：设 COVER_UPLOAD_STUB_DIR 时写本地文件。
 */
async function uploadCover(buffer, filename, ftp) {
  ftp = ftp || publishFtpConfig(null);
  const prefix = (ftp.urlPrefix || '').replace(/\/+$/, '');
  if (!prefix) throw new Error('未配置 URL 前缀（FTP_URL_PREFIX 或 LOGO_<x>_FTP_URL_PREFIX）');

  const stubDir = process.env.COVER_UPLOAD_STUB_DIR;
  if (stubDir) {
    await fs.promises.mkdir(stubDir, { recursive: true });
    await fs.promises.writeFile(path.join(stubDir, filename), buffer);
    return prefix + '/' + filename;
  }

  // 重试：FTP 偶发失败（连接被重置 / 数据口卡住 / 服务端瞬时拒绝）很常见，
  // 自动重试 N 次比让用户手动点 7-8 次靠谱。次数可用 FTP_UPLOAD_RETRIES 调。
  const retries = Math.max(0, parseInt(process.env.FTP_UPLOAD_RETRIES || '2', 10));
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const t0 = Date.now();
    try {
      await ftpStore(buffer, filename, ftp);
      console.log(`[ftp] upload ok host=${ftp.host} file=${filename} size=${buffer.length} attempt=${attempt} ms=${Date.now() - t0}`);
      return prefix + '/' + filename;
    } catch (e) {
      lastErr = e;
      console.error(`[ftp] upload fail host=${ftp.host} file=${filename} attempt=${attempt}/${retries + 1} ms=${Date.now() - t0} err=${(e && e.message) || e}`);
      if (attempt <= retries) await new Promise((r) => setTimeout(r, 800 * attempt)); // 退避后重试
    }
  }
  throw lastErr;
}

/** 最小 FTP 客户端：被动模式二进制 STOR 单文件。零 npm 依赖。ftp 缺省用全局 FTP_*。 */
function ftpStore(buffer, filename, ftp) {
  ftp = ftp || {};
  const host = ftp.host || process.env.FTP_HOST;
  const port = ftp.port || parseInt(process.env.FTP_PORT || '21', 10);
  const user = ftp.user || process.env.FTP_USER;
  const pass = ftp.pass != null ? ftp.pass : (process.env.FTP_PASS || '');
  const dir = (ftp.dir != null ? ftp.dir : (process.env.FTP_DIR || '')).replace(/\/+$/, '');
  // 默认 60s（原 360s 太长：数据口卡住时用户要等 6 分钟才报错=「一直上传中」）。
  const timeoutMs = ftp.timeoutMs || parseInt(process.env.FTP_TIMEOUT_MS || '60000', 10);
  if (!host || !user) return Promise.reject(new Error('未配置 FTP host / user'));

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
      const pasvHost = mm.slice(1, 5).join('.');
      const dataPort = (parseInt(mm[5], 10) << 8) + parseInt(mm[6], 10);
      // 关键修复：数据连接一律连回控制连接的同一主机（host），不用 PASV 回的 IP——
      // FTP 服务器在 NAT 后面时 PASV 常返回内网 IP（192.168/10.x），直接连会连不上、
      // 卡到超时（=偶发「一直上传中」+ 要重试 7-8 次）。只借用它的端口。
      if (pasvHost !== host) console.log(`[ftp] PASV host ${pasvHost} != control host ${host}, 用控制主机连数据口 ${dataPort}`);

      const remote = (dir ? dir + '/' : '') + filename;
      const data = net.connect({ host, port: dataPort });
      data.setTimeout(timeoutMs);
      const dataClosed = new Promise((res, rej) => {
        data.on('error', rej);
        data.on('timeout', () => rej(new Error('FTP 数据连接超时（' + host + ':' + dataPort + '）')));
        data.on('close', res);
      });
      await new Promise((res, rej) => {
        data.on('connect', res);
        data.on('error', rej);
        data.on('timeout', () => rej(new Error('FTP 数据连接建立超时（' + host + ':' + dataPort + '）')));
      });

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

module.exports = { uploadCover, ftpStore, publishFtpConfig, publishCallbackHosts };
