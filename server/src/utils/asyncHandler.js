/**
 * Express 4 不自动捕获 async 中间件/控制器的 Promise 拒绝，
 * 统一用本包装器把异常交给 errorHandler 处理。
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
