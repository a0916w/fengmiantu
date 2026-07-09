const { test } = require('node:test');
const assert = require('node:assert');
const { createSemaphore } = require('../lib/semaphore');

test('并发不超过 n', async () => {
  const sem = createSemaphore(2);
  let running = 0, max = 0;
  const task = () => sem.run(async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 15)); running--; return 1; });
  await Promise.all(Array.from({ length: 6 }, task));
  assert.ok(max <= 2, 'max=' + max);
});

test('返回值透传 + 出错释放名额', async () => {
  const sem = createSemaphore(1);
  assert.strictEqual(await sem.run(async () => 42), 42);
  await assert.rejects(() => sem.run(async () => { throw new Error('x'); }), /x/);
  assert.strictEqual(await sem.run(async () => 7), 7); // 名额已释放
});
