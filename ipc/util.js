// IPC 共享小工具
/**
 * 把 handler 包一层：抛出的异常转成 {ok:false,error}，而不是让渲染层拿到 reject。
 * 注意返回的是 async 函数，同步抛错也会被包进 Promise，调用方必须 await。
 * @param {Function} fn
 */
function safe(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (e) { return { ok: false, error: e.message }; }
  };
}

module.exports = { safe };
