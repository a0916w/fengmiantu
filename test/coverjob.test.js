const { test } = require('node:test');
const assert = require('node:assert');
const { processCoverJob } = require('../lib/coverjob');

function fakeDeps(overrides = {}) {
  const calls = { capture: [] };
  return {
    calls,
    deps: {
      probeDuration: async () => 120,
      pickTime: (dur, i, n) => (i + 1) * 10,
      captureFrame: async (url, t) => { calls.capture.push(t); return Buffer.from('frame-' + t); },
      composeCover: async ({ frames, logoPath }) => { calls.compose = { n: frames.length, logoPath }; return Buffer.from('WEBP'); },
      uploadCover: async (buf, name) => { calls.upload = name; return 'http://cdn/' + name; },
      logos: { pathOf: (n) => (n && n !== 'none' ? '/logos/' + n + '.png' : null) },
      ...overrides,
    },
  };
}

test('抽 3 帧 → 拼图 → 上传，返回 url', async () => {
  const { deps, calls } = fakeDeps();
  const job = { id: 'abc', url: 'http://x/a.m3u8', logo: 'webmm', projectKey: 'webmm' };
  const out = await processCoverJob(job, deps);
  assert.strictEqual(calls.capture.length, 3);
  assert.strictEqual(calls.compose.n, 3);
  assert.strictEqual(calls.compose.logoPath, '/logos/webmm.png');
  assert.ok(calls.upload.startsWith('cover-'));
  assert.ok(out.url.startsWith('http://cdn/cover-'));
});

test('logo=none → 不叠 logo', async () => {
  const { deps, calls } = fakeDeps();
  const out = await processCoverJob({ id: 'a', url: 'http://x', logo: 'none' }, deps);
  assert.strictEqual(calls.compose.logoPath, null);
  assert.ok(out.url);
});

test('抽帧失败 → 抛错', async () => {
  const { deps } = fakeDeps({ captureFrame: async () => { throw new Error('ffmpeg boom'); } });
  await assert.rejects(() => processCoverJob({ id: 'a', url: 'http://x', logo: 'none' }, deps), /ffmpeg boom/);
});
