process.env.DATA_DIR = require('os').tmpdir() + '/fm-logoep-' + process.pid;
process.env.LOGOS_DIR = process.env.DATA_DIR + '/logos'; // 空目录 → 触发种子
process.env.ADMIN_TOKEN = 'adm';
process.env.FTP_URL_PREFIX = 'http://cdn.test';
process.env.PORT = '34702';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { app, logos } = require('../server');

before(() => new Promise((r) => app.listen(34702, r)));
after(() => new Promise((r) => app.close(r)));

function get(path) { return new Promise((res) => { http.get('http://127.0.0.1:34702' + path, (r) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => res({ status: r.statusCode, ct: r.headers['content-type'], buf: Buffer.concat(chunks) })); }); }); }

test('首启种子：logo.png → default', () => {
  assert.ok(logos.exists('default'), 'default logo 应被种子创建');
});

test('/logo-list 返回名字 + default', async () => {
  const r = await get('/logo-list');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.buf.toString());
  assert.ok(j.logos.includes('default'));
  assert.strictEqual(j.default, 'default');
});

test('/logo-img/default.png 返回 PNG', async () => {
  const r = await get('/logo-img/default.png');
  assert.strictEqual(r.status, 200);
  assert.match(r.ct, /image\/png/);
  assert.deepStrictEqual(r.buf.slice(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('/logo-img/未知 → 404', async () => {
  assert.strictEqual((await get('/logo-img/nope')).status, 404);
});
