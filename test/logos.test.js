const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createLogos } = require('../lib/logos');

function tmpDir() { const d = path.join(os.tmpdir(), 'fm-logos-' + process.pid + '-' + Math.round(process.hrtime()[1])); fs.mkdirSync(d, { recursive: true }); return d; }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('save/list/exists/pathOf/remove', () => {
  const L = createLogos(tmpDir());
  assert.deepStrictEqual(L.list(), []);
  L.save('webmm', PNG);
  assert.ok(L.exists('webmm'));
  assert.deepStrictEqual(L.list(), ['webmm']);
  assert.ok(L.pathOf('webmm').endsWith('webmm.png'));
  assert.strictEqual(L.pathOf('nope'), null);
  L.remove('webmm');
  assert.strictEqual(L.exists('webmm'), false);
});

test('拒绝非 PNG', () => {
  const L = createLogos(tmpDir());
  assert.throws(() => L.save('x', Buffer.from('not a png')), /PNG/);
});

test('拒绝非法名', () => {
  const L = createLogos(tmpDir());
  assert.throws(() => L.save('../evil', PNG), /名/);
});
