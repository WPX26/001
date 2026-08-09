/**
 * 参数校验中间件：与 express-validator 校验链配合使用
 * 校验失败统一返回：HTTP 400 + code 1001（api.md 附录 B）
 */
import { validationResult } from 'express-validator';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

export function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const first = errors.array()[0];
    throw new AppError(ERR.VALIDATE, first.msg || '参数校验失败', 400);
  }
  next();
}
