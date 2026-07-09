/**
 * 项目 / 任务 JSON 文件存储：原子写（临时文件 + rename），进程内同步。
 * 规模很小（项目数十、任务数百），不引入 sqlite。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(fp, obj) {
  const tmp = fp + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, fp);
}

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const projFp = path.join(dir, 'projects.json');
  const jobFp = path.join(dir, 'jobs.json');
  let projects = readJson(projFp, []);
  let jobs = readJson(jobFp, []);
  const saveP = () => writeJsonAtomic(projFp, projects);
  const saveJ = () => writeJsonAtomic(jobFp, jobs);
  const now = () => new Date().toISOString();

  return {
    // ---- projects ----
    listProjects: () => projects.slice(),
    getProject: (key) => projects.find((p) => p.key === key),
    getProjectByToken: (token) => {
      if (!token) return undefined;
      const tb = Buffer.from(String(token));
      return projects.find((p) => {
        const pb = Buffer.from(p.token);
        return pb.length === tb.length && crypto.timingSafeEqual(pb, tb);
      });
    },
    addProject: ({ key, name, defaultLogo }) => {
      if (projects.some((p) => p.key === key)) throw new Error('项目 key 已存在');
      const p = { key, name: name || key, defaultLogo: defaultLogo || 'none', token: crypto.randomBytes(24).toString('hex'), createdAt: now() };
      projects.push(p); saveP(); return p;
    },
    updateProject: (key, patch) => {
      const p = projects.find((x) => x.key === key); if (!p) throw new Error('项目不存在');
      if (patch.token === 'RESET') patch.token = crypto.randomBytes(24).toString('hex');
      Object.assign(p, patch); saveP(); return p;
    },
    deleteProject: (key) => { projects = projects.filter((p) => p.key !== key); saveP(); },

    // ---- jobs ----
    createJob: ({ projectKey, url, logo, externalId, callback }) => {
      const j = { id: crypto.randomBytes(6).toString('hex'), projectKey, url, logo, externalId: externalId || null, callback, status: 'queued', resultUrl: null, error: null, createdAt: now(), updatedAt: now() };
      jobs.push(j); saveJ(); return j;
    },
    getJob: (id) => jobs.find((j) => j.id === id),
    updateJob: (id, patch) => {
      const j = jobs.find((x) => x.id === id); if (!j) return undefined;
      Object.assign(j, patch, { updatedAt: now() }); saveJ(); return j;
    },
    listJobs: (limit = 100) => jobs.slice(-limit).reverse(),
    // 崩溃恢复：把残留 processing 重置为 queued，返回被重置的
    recoverStuck: () => { const stuck = jobs.filter((j) => j.status === 'processing'); stuck.forEach((j) => { j.status = 'queued'; }); if (stuck.length) saveJ(); return stuck; },
  };
}

module.exports = { createStore };
