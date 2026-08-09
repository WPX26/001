/**
 * 404 兜底：未匹配任何路由时返回统一错误格式
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

export function notFound(req, res, next) {
  next(new AppError(ERR.NOT_FOUND, `接口不存在：${req.method} ${req.path}`, 404));
}
