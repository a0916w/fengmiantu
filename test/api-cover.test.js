process.env.DATA_DIR = require('os').tmpdir() + '/fm-api-' + process.pid;
process.env.LOGOS_DIR = process.env.DATA_DIR + '/logos';
process.env.COVER_UPLOAD_STUB_DIR = process.env.DATA_DIR + '/uploads';
process.env.FTP_URL_PREFIX = 'http://cdn.test';
process.env.COVER_CALLBACK_ALLOW_LOOPBACK = '1'; // 允许 127.0.0.1 回调（测试）
process.env.ADMIN_TOKEN = 'adm';
process.env.PORT = '34700';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { app, store } = require('../server');

before(() => new Promise((r) => app.listen(34700, r)));
after(() => new Promise((r) => app.close(r)));

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((res) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}), ...headers };
    const r = http.request('http://127.0.0.1:34700' + path, { method, headers: h }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res({ status: x.statusCode, body: d })); });
    if (data) r.end(data); else r.end();
  });
}

test('无 token → 401', async () => {
  const r = await req('POST', '/api/cover', { body: { url: 'http://x/a.m3u8', callback: 'http://127.0.0.1:34700/cb' } });
  assert.strictEqual(r.status, 401);
});

test('合法项目 token → 入队返回 job_id + 可查状态', async () => {
  const p = store.addProject({ key: 'webmm', name: '猫咪', defaultLogo: 'none' });
  const r = await req('POST', '/api/cover', { headers: { Authorization: 'Bearer ' + p.token }, body: { url: 'http://127.0.0.1:34700/nope.m3u8', callback: 'http://127.0.0.1:34700/cb', external_id: 'e1' } });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.ok && j.job_id);
  const g = await req('GET', '/api/cover/' + j.job_id, { headers: { Authorization: 'Bearer ' + p.token } });
  assert.strictEqual(g.status, 200);
  assert.ok(['queued', 'processing', 'failed', 'done'].includes(JSON.parse(g.body).status));
});

test('url 非法 → 400', async () => {
  const p = store.getProject('webmm') || store.addProject({ key: 'webmm', name: 'x', defaultLogo: 'none' });
  const r = await req('POST', '/api/cover', { headers: { Authorization: 'Bearer ' + p.token }, body: { url: 'ftp://bad', callback: 'http://127.0.0.1:34700/cb' } });
  assert.strictEqual(r.status, 400);
});

test('callback 不允许（元数据地址）→ 400', async () => {
  const p = store.getProject('webmm');
  const r = await req('POST', '/api/cover', { headers: { Authorization: 'Bearer ' + p.token }, body: { url: 'http://x/a.m3u8', callback: 'http://169.254.169.254/' } });
  assert.strictEqual(r.status, 400);
});

test('logo 不存在 → 400', async () => {
  const p = store.getProject('webmm');
  const r = await req('POST', '/api/cover', { headers: { Authorization: 'Bearer ' + p.token }, body: { url: 'http://x/a.m3u8', logo: 'nosuch', callback: 'http://127.0.0.1:34700/cb' } });
  assert.strictEqual(r.status, 400);
});
