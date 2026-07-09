const { test } = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../lib/queue');

function memStore() {
  const jobs = new Map();
  return {
    _jobs: jobs,
    createJob: (j) => { const job = { id: String(jobs.size + 1), status: 'queued', ...j }; jobs.set(job.id, job); return job; },
    updateJob: (id, patch) => { Object.assign(jobs.get(id), patch); return jobs.get(id); },
    getJob: (id) => jobs.get(id),
    recoverStuck: () => { const s = [...jobs.values()].filter((j) => j.status === 'processing'); s.forEach((j) => (j.status = 'queued')); return s; },
  };
}

test('处理到 done + onDone 收到 url', async () => {
  const store = memStore();
  const done = [];
  const q = createQueue({ store, concurrency: 2, process: async (job) => ({ url: 'u-' + job.id }), onDone: (job, r) => done.push([job.id, r.url]) });
  const j = store.createJob({ url: 'x' });
  q.enqueue(j);
  await q.idle();
  assert.strictEqual(store.getJob(j.id).status, 'done');
  assert.strictEqual(store.getJob(j.id).resultUrl, 'u-' + j.id);
  assert.deepStrictEqual(done, [[j.id, 'u-' + j.id]]);
});

test('失败 → failed + error', async () => {
  const store = memStore();
  const q = createQueue({ store, concurrency: 1, process: async () => { throw new Error('boom'); } });
  const j = store.createJob({ url: 'x' });
  q.enqueue(j); await q.idle();
  assert.strictEqual(store.getJob(j.id).status, 'failed');
  assert.match(store.getJob(j.id).error, /boom/);
});

test('并发上限：同时在跑的不超过 concurrency', async () => {
  const store = memStore();
  let running = 0, maxRunning = 0;
  const q = createQueue({ store, concurrency: 2, process: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 20)); running--; return { url: 'u' }; } });
  for (let i = 0; i < 6; i++) q.enqueue(store.createJob({ url: 'x' }));
  await q.idle();
  assert.ok(maxRunning <= 2, 'maxRunning=' + maxRunning);
});
