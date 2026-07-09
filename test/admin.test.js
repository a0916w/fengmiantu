process.env.DATA_DIR = require('os').tmpdir() + '/fm-admin-' + process.pid;
process.env.LOGOS_DIR = process.env.DATA_DIR + '/logos';
process.env.ADMIN_TOKEN = 'adm';
process.env.FTP_URL_PREFIX = 'http://cdn.test';
process.env.PORT = '34701';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { app, store, logos } = require('../server');

before(() => new Promise((r) => app.listen(34701, r)));
after(() => new Promise((r) => app.close(r)));

function get(path, token) { return new Promise((res) => { http.get('http://127.0.0.1:34701' + path + (token ? '?token=' + token : ''), (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ status: r.statusCode, body: d })); }); }); }
function post(path, obj, token) { return new Promise((res) => { const b = Buffer.from(JSON.stringify(obj)); const r = http.request('http://127.0.0.1:34701' + path + '?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res({ status: x.statusCode, body: d })); }); r.end(b); }); }

// ---- /queue ----
test('/queue 无 token → 403', async () => { assert.strictEqual((await get('/queue')).status, 403); });
test('/queue 带 token → 200 且含任务', async () => {
  store.createJob({ projectKey: 'p', url: 'u', logo: 'none', callback: 'http://cb' });
  const r = await get('/queue', 'adm');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /队列/);
});

// ---- /projects ----
test('创建项目 → 列表可见 + 有 token', async () => {
  const r = await post('/api/projects', { key: 'luntan', name: '论坛', defaultLogo: 'none' }, 'adm');
  assert.strictEqual(r.status, 200);
  assert.ok(JSON.parse(r.body).project.token);
  const page = await get('/projects', 'adm');
  assert.match(page.body, /论坛/);
});
test('创建项目无 token → 403', async () => {
  const r = await post('/api/projects', { key: 'x', name: 'x' }, 'WRONG');
  assert.strictEqual(r.status, 403);
});
test('删除项目', async () => {
  await post('/api/projects', { key: 'tmp', name: 't', defaultLogo: 'none' }, 'adm');
  const r = await post('/api/projects/delete', { key: 'tmp' }, 'adm');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.getProject('tmp'), undefined);
});

// ---- /logos ----
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
test('上传 logo → list 可见', async () => {
  const r = await post('/api/logos', { name: 'webmm', png_base64: PNG_B64 }, 'adm');
  assert.strictEqual(r.status, 200);
  const page = await get('/logos', 'adm');
  assert.match(page.body, /webmm/);
});
test('上传非 PNG → 400', async () => {
  const r = await post('/api/logos', { name: 'bad', png_base64: Buffer.from('nope').toString('base64') }, 'adm');
  assert.strictEqual(r.status, 400);
});
test('删除 logo', async () => {
  await post('/api/logos', { name: 'delme', png_base64: PNG_B64 }, 'adm');
  const r = await post('/api/logos/delete', { name: 'delme' }, 'adm');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(logos.exists('delme'), false);
});
