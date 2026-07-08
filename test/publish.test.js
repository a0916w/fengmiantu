/**
 * 冒烟测试：/api/publish → 上传（stub 本地）→ 按 media-cover/callback 格式回调。
 * 不碰真 FTP（COVER_UPLOAD_STUB_DIR 走本地写文件）。node test/publish.test.js
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const FM_PORT = 34121;
const CB_PORT = 34122;
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fmstub-'));
const URL_PREFIX = 'https://cdn.test/covers';

// 1x1 webp（base64）——足够走通解码/上传/回调链路。
const WEBP_1PX =
  'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

function waitPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('port ' + port + ' not up'));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function postJson(port, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d || '{}') })); },
    );
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  // 假 webmm 回调服务：记录收到的 payload
  let received = null;
  const cb = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(d || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"message":"ok"}');
    });
  });
  await new Promise((r) => cb.listen(CB_PORT, r));

  // 起 fengmiantu server（stub 上传模式）
  const srv = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(FM_PORT), COVER_UPLOAD_STUB_DIR: STUB_DIR, FTP_URL_PREFIX: URL_PREFIX },
    stdio: 'ignore',
  });

  let failed = null;
  try {
    await waitPort(FM_PORT);

    const externalId = 'mv-9195-20260708_154512';
    const callback = `http://127.0.0.1:${CB_PORT}/api/media-cover/callback?sign=DEADBEEF`;
    const res = await postJson(FM_PORT, '/api/publish', { image: WEBP_1PX, external_id: externalId, callback });

    // 1) publish 成功、返回可访问 URL
    assert.strictEqual(res.status, 200, 'publish status');
    assert.strictEqual(res.json.ok, true, 'publish ok');
    assert.ok(res.json.url.startsWith(URL_PREFIX + '/cover-' + externalId + '-'), 'url shape: ' + res.json.url);
    assert.ok(res.json.url.endsWith('.webp'), 'url ext');

    // 2) 文件确实写到 stub 目录
    const fname = res.json.url.slice((URL_PREFIX + '/').length);
    assert.ok(fs.existsSync(path.join(STUB_DIR, fname)), 'stub file exists');

    // 3) webmm 回调收到正确 payload（media-cover/callback 格式）
    assert.ok(received, 'callback received');
    assert.ok(received.url.includes('sign=DEADBEEF'), 'callback keeps sign');
    assert.strictEqual(received.body.status, 'completed', 'cb status');
    assert.strictEqual(received.body.external_id, externalId, 'cb external_id');
    assert.strictEqual(received.body.outputs[0].url, res.json.url, 'cb output url == uploaded url');
    assert.strictEqual(received.body.outputs[0].selection_score, 1, 'cb score');

    // 4) 非法 external_id / callback 被拒
    const bad = await postJson(FM_PORT, '/api/publish', { image: WEBP_1PX, external_id: '', callback });
    assert.strictEqual(bad.status, 400, 'reject empty external_id');
    const badCb = await postJson(FM_PORT, '/api/publish', { image: WEBP_1PX, external_id: 'x', callback: 'ftp://nope' });
    assert.strictEqual(badCb.status, 400, 'reject non-http callback');

    console.log('PUBLISH_TEST_PASS');
  } catch (e) {
    failed = e;
    console.error('PUBLISH_TEST_FAIL:', e.message);
  } finally {
    srv.kill();
    cb.close();
    try { fs.rmSync(STUB_DIR, { recursive: true, force: true }); } catch {}
  }
  process.exit(failed ? 1 : 0);
})();
