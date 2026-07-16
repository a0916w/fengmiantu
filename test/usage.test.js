/**
 * 使用埋点模块单测：追加/读取往返 + 按天/模式/logo 聚合。
 * 纯文件逻辑，不起 server。 node --test  /  node test/usage.test.js
 */
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { logUsage, readUsage, aggregate, modeLabel } = require('../lib/usage');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fmusage-'));
}

test('logUsage appends and readUsage round-trips', () => {
  const dir = tmpDir();
  assert.strictEqual(logUsage({ type: 'frame' }, { dataDir: dir, now: new Date('2026-07-16T01:00:00Z') }), true);
  assert.strictEqual(logUsage({ type: 'publish', mode: 'cover', logo: 'mmchigua' }, { dataDir: dir, now: new Date('2026-07-16T02:00:00Z') }), true);
  const rows = readUsage({ dataDir: dir });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].type, 'frame');
  assert.strictEqual(rows[1].type, 'publish');
  assert.strictEqual(rows[1].mode, 'cover');
  assert.strictEqual(rows[1].logo, 'mmchigua');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readUsage on missing file returns empty, skips bad lines', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(readUsage({ dataDir: dir }), []);
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), '{"ts":"2026-07-16T00:00:00Z","type":"frame"}\nGARBAGE\n\n{"no_ts":1}\n');
  const rows = readUsage({ dataDir: dir });
  assert.strictEqual(rows.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aggregate counts frames/publishes per day and breaks publishes down by mode+logo', () => {
  const events = [
    { ts: '2026-07-16T01:00:00Z', type: 'frame' },
    { ts: '2026-07-16T02:00:00Z', type: 'frame' },
    { ts: '2026-07-16T03:00:00Z', type: 'publish', mode: 'cover', logo: 'mmchigua' },
    { ts: '2026-07-16T04:00:00Z', type: 'publish', mode: 'cover', logo: 'mmchigua' },
    { ts: '2026-07-16T05:00:00Z', type: 'publish', mode: 'logo', logo: 'mmav' },
    { ts: '2026-07-15T09:00:00Z', type: 'publish', mode: 'cover', logo: '' },
  ];
  const { days, detail, totals } = aggregate(events);

  // 每天汇总（日期倒序）
  assert.strictEqual(days.length, 2);
  assert.strictEqual(days[0].date, '2026-07-16');
  assert.strictEqual(days[0].frames, 2);
  assert.strictEqual(days[0].publishes, 3);
  assert.strictEqual(days[1].date, '2026-07-15');
  assert.strictEqual(days[1].frames, 0);
  assert.strictEqual(days[1].publishes, 1);

  // 合计
  assert.strictEqual(totals.frames, 2);
  assert.strictEqual(totals.publishes, 4);

  // 明细：同 天/模式/logo 合并计数
  const chigua = detail.find((r) => r.date === '2026-07-16' && r.logo === 'mmchigua');
  assert.ok(chigua);
  assert.strictEqual(chigua.count, 2);
  assert.strictEqual(chigua.mode, 'cover');
  assert.strictEqual(chigua.label, '新做封面');

  const av = detail.find((r) => r.logo === 'mmav');
  assert.strictEqual(av.label, '原有封面盖logo');

  // 无 logo 的 publish 归到 (无 logo)
  const noLogo = detail.find((r) => r.date === '2026-07-15');
  assert.strictEqual(noLogo.logo, '(无 logo)');
});

test('download events count per day and fold into logo detail alongside publishes', () => {
  const dir = tmpDir();
  // download 也带 mode+logo，且要能写读往返。
  assert.strictEqual(logUsage({ type: 'download', mode: 'logo', logo: 'mmchigua' }, { dataDir: dir, now: new Date('2026-07-16T01:00:00Z') }), true);
  const rows = readUsage({ dataDir: dir });
  assert.strictEqual(rows[0].type, 'download');
  assert.strictEqual(rows[0].logo, 'mmchigua');
  fs.rmSync(dir, { recursive: true, force: true });

  const events = [
    { ts: '2026-07-16T01:00:00Z', type: 'download', mode: 'logo', logo: 'mmchigua' },
    { ts: '2026-07-16T02:00:00Z', type: 'download', mode: 'logo', logo: 'mmchigua' },
    { ts: '2026-07-16T03:00:00Z', type: 'publish', mode: 'logo', logo: 'mmchigua' },
    { ts: '2026-07-16T04:00:00Z', type: 'frame' },
  ];
  const { days, detail, totals } = aggregate(events);
  assert.strictEqual(days[0].downloads, 2);
  assert.strictEqual(days[0].publishes, 1);
  assert.strictEqual(days[0].frames, 1);
  assert.strictEqual(totals.downloads, 2);
  // 明细 count = download + publish（该 logo 当天被用 3 次）
  const chigua = detail.find((r) => r.logo === 'mmchigua' && r.mode === 'logo');
  assert.strictEqual(chigua.count, 3);
});

test('modeLabel maps known modes and falls back', () => {
  assert.strictEqual(modeLabel('cover'), '新做封面');
  assert.strictEqual(modeLabel('logo'), '原有封面盖logo');
  assert.strictEqual(modeLabel('weird'), '未知');
  assert.strictEqual(modeLabel(''), '未知');
});
