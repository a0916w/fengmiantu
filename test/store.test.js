const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createStore } = require('../lib/store');

function tmpDir() { const d = path.join(os.tmpdir(), 'fm-store-' + process.pid + '-' + Math.round(process.hrtime()[1])); fs.mkdirSync(d, { recursive: true }); return d; }

test('project 增查删 + token 唯一定位', () => {
  const s = createStore(tmpDir());
  const p = s.addProject({ key: 'webmm', name: '猫咪', defaultLogo: 'webmm' });
  assert.ok(p.token && p.token.length >= 24);
  assert.strictEqual(s.getProject('webmm').name, '猫咪');
  assert.strictEqual(s.getProjectByToken(p.token).key, 'webmm');
  assert.strictEqual(s.getProjectByToken('nope'), undefined);
  s.updateProject('webmm', { defaultLogo: 'none' });
  assert.strictEqual(s.getProject('webmm').defaultLogo, 'none');
  s.deleteProject('webmm');
  assert.strictEqual(s.getProject('webmm'), undefined);
});

test('job 生命周期', () => {
  const s = createStore(tmpDir());
  const j = s.createJob({ projectKey: 'webmm', url: 'http://x/a.m3u8', logo: 'webmm', externalId: 'e1', callback: 'http://cb/x' });
  assert.strictEqual(j.status, 'queued');
  assert.ok(j.id);
  s.updateJob(j.id, { status: 'done', resultUrl: 'http://cdn/c.webp' });
  assert.strictEqual(s.getJob(j.id).status, 'done');
  assert.strictEqual(s.getJob(j.id).resultUrl, 'http://cdn/c.webp');
  assert.ok(s.listJobs(10).some((x) => x.id === j.id));
});

test('持久化：新实例读到旧数据', () => {
  const d = tmpDir();
  const s1 = createStore(d);
  const p = s1.addProject({ key: 'k', name: 'n', defaultLogo: 'none' });
  const s2 = createStore(d);
  assert.strictEqual(s2.getProject('k').name, 'n');
  assert.strictEqual(s2.getProjectByToken(p.token).key, 'k');
});

test('recoverStuck: processing → queued', () => {
  const d = tmpDir();
  const s1 = createStore(d);
  const j = s1.createJob({ projectKey: 'k', url: 'u', logo: 'none', callback: 'http://cb' });
  s1.updateJob(j.id, { status: 'processing' });
  const s2 = createStore(d);
  const stuck = s2.recoverStuck();
  assert.strictEqual(stuck.length, 1);
  assert.strictEqual(s2.getJob(j.id).status, 'queued');
});
