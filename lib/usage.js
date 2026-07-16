/**
 * 使用埋点：把「截帧生成截图 / 用作封面(publish)」事件按行追加到 data/usage.jsonl，
 * 供 /report 页按天 + 按 logo + 按 tab(模式) 聚合统计。
 *
 * 无数据库依赖：一行一个 JSON。写入 best-effort（记录失败绝不影响主流程/回调）。
 */
const fs = require('fs');
const path = require('path');

// 默认落 data/；服务端可用 DATA_DIR 覆盖（与 DEPLOY.md 的持久化目录约定一致）。
const DEFAULT_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = 'usage.jsonl';

// 模式(tab)代号 → 中文名。cover=新做封面(抽帧拼图)，logo=原有封面盖logo。
const MODE_LABELS = { cover: '新做封面', logo: '原有封面盖logo' };
function modeLabel(mode) {
  return MODE_LABELS[mode] || '未知';
}

function filePath(dataDir) {
  return path.join(dataDir || DEFAULT_DIR, FILE);
}

// 追加一条事件。now 可注入（测试用）。永不抛出——埋点失败不能拖垮主流程。
function logUsage(event, opts = {}) {
  try {
    const dataDir = opts.dataDir || DEFAULT_DIR;
    fs.mkdirSync(dataDir, { recursive: true });
    const now = opts.now instanceof Date ? opts.now : new Date();
    // 三种事件：frame=抽帧截图(仅新做封面tab)、download=生成/下载封面、publish=用作封面。
    const type = event.type === 'frame' ? 'frame' : (event.type === 'download' ? 'download' : 'publish');
    const rec = { ts: now.toISOString(), type };
    if (type !== 'frame') {
      // download 和 publish 都带 tab(模式) + logo，供明细「哪个 logo 用了几次」。
      rec.mode = typeof event.mode === 'string' ? event.mode : '';
      rec.logo = typeof event.logo === 'string' ? event.logo : '';
    }
    fs.appendFileSync(filePath(dataDir), JSON.stringify(rec) + '\n');
    return true;
  } catch (e) {
    // 埋点是尽力而为；失败只落一行日志，不影响调用方。
    try { console.error('[usage] log failed:', (e && e.message) || e); } catch {}
    return false;
  }
}

// 读取事件（容错：坏行跳过）。sinceDays>0 时只保留最近 N 天（按事件日期 UTC）。
function readUsage(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DIR;
  let text = '';
  try {
    text = fs.readFileSync(filePath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && typeof r.ts === 'string') out.push(r);
    } catch { /* 跳过坏行 */ }
  }
  if (opts.sinceDays && opts.sinceDays > 0) {
    const cutoff = Date.now() - opts.sinceDays * 86400000;
    return out.filter((r) => Date.parse(r.ts) >= cutoff);
  }
  return out;
}

const dayOf = (ts) => String(ts || '').slice(0, 10) || '未知';

/**
 * 聚合成报表所需结构：
 *  - days:   [{ date, frames, downloads, publishes }] 每天：抽帧 / 生成下载 / 用作封面（日期倒序）
 *  - detail: [{ date, mode, label, logo, count }]     产出明细：按 天/模式/logo，count=下载+用作封面（即该 logo 被用几次）
 *  - totals: { frames, downloads, publishes }          全区间合计
 */
function aggregate(events) {
  const days = new Map();   // date -> { date, frames, downloads, publishes }
  const detail = new Map(); // date||mode||logo -> { date, mode, logo, count }
  let frames = 0, downloads = 0, publishes = 0;

  const addDetail = (d, e) => {
    const mode = typeof e.mode === 'string' ? e.mode : '';
    const logo = (typeof e.logo === 'string' && e.logo) ? e.logo : '(无 logo)';
    const key = d + '||' + mode + '||' + logo;
    if (!detail.has(key)) detail.set(key, { date: d, mode, logo, count: 0 });
    detail.get(key).count++;
  };

  for (const e of events || []) {
    const d = dayOf(e.ts);
    if (!days.has(d)) days.set(d, { date: d, frames: 0, downloads: 0, publishes: 0 });
    const day = days.get(d);
    if (e.type === 'frame') {
      day.frames++; frames++;
    } else if (e.type === 'download') {
      day.downloads++; downloads++; addDetail(d, e); // 生成/下载封面也算「用了该 logo」
    } else {
      day.publishes++; publishes++; addDetail(d, e);
    }
  }

  const dayRows = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
  const detailRows = [...detail.values()]
    .map((x) => ({ ...x, label: modeLabel(x.mode) }))
    .sort((a, b) =>
      b.date.localeCompare(a.date) ||
      a.label.localeCompare(b.label) ||
      b.count - a.count ||
      a.logo.localeCompare(b.logo));

  return { days: dayRows, detail: detailRows, totals: { frames, downloads, publishes } };
}

module.exports = { logUsage, readUsage, aggregate, modeLabel, filePath, DEFAULT_DIR };
