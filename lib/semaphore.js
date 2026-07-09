/**
 * 极简并发信号量：同时在跑的任务不超过 n 个，其余排队。
 * 用于给 ffmpeg 抽帧加进程级并发闸（手动工具 + 队列共享）。
 */
function createSemaphore(n) {
  let active = 0;
  const waiters = [];
  const release = () => { active--; if (waiters.length) { active++; waiters.shift()(); } };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        const go = () => Promise.resolve().then(fn).then((v) => { release(); resolve(v); }, (e) => { release(); reject(e); });
        if (active < n) { active++; go(); } else { waiters.push(go); }
      });
    },
  };
}

module.exports = { createSemaphore };
