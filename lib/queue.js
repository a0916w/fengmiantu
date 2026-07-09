/**
 * 限并发任务队列：FIFO + 并发池，落库由注入的 store 负责，启动时恢复残留 processing。
 * process(job) -> Promise<{url}>；成功置 done+resultUrl，失败置 failed+error；两种都回调 onDone。
 */
function createQueue({ store, process: processFn, concurrency = 2, onDone }) {
  const pending = [];
  let active = 0;
  let idleResolvers = [];

  // 崩溃恢复：残留 processing → queued，重新入队
  for (const j of store.recoverStuck()) pending.push(j);

  function settleIdle() {
    if (active === 0 && pending.length === 0) {
      idleResolvers.forEach((r) => r());
      idleResolvers = [];
    }
  }
  function pump() {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      store.updateJob(job.id, { status: 'processing' });
      Promise.resolve()
        .then(() => processFn(job))
        .then((r) => { store.updateJob(job.id, { status: 'done', resultUrl: r.url }); onDone && onDone(job, { url: r.url }); })
        .catch((e) => { const error = String((e && e.message) || e).slice(0, 300); store.updateJob(job.id, { status: 'failed', error }); onDone && onDone(job, { error }); })
        .finally(() => { active--; pump(); settleIdle(); });
    }
    settleIdle();
  }

  // 启动即尝试消费恢复进来的
  setImmediate(pump);

  return {
    enqueue: (job) => { pending.push(job); pump(); },
    size: () => pending.length + active,
    idle: () => new Promise((res) => { if (active === 0 && pending.length === 0) return res(); idleResolvers.push(res); }),
  };
}

module.exports = { createQueue };
