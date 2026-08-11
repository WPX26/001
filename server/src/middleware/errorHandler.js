/**
 * 统一错误处理中间件（必须最后注册）
 * - AppError：按业务码响应
 * - Mongoose 校验错误 → 1001；CastError → 1004；唯一键冲突 → 1005
 * - Multer 上传错误 → 1001
 * - 兜底 9999
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

export function errorHandler(err, req, res, next) {
  // 业务错误
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({ code: err.code, data: null, message: err.message });
  }

  // mongoose 文档校验错误（字段格式/枚举/必填）
  if (err.name === 'ValidationError') {
    const msg = Object.values(err.errors || {})[0]?.message || '参数校验失败';
    return res.status(400).json({ code: ERR.VALIDATE, data: null, message: msg });
  }

  // mongoose CastError 分两类（P0-3 修复）：
  // - ObjectId 格式错误（路由参数/字段不是合法 ID）→ 404/1004 资源不存在
  // - 其他类型转换错误（非法日期/数值等字段类型）→ 400/1001 参数格式不正确
  if (err.name === 'CastError') {
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ code: ERR.NOT_FOUND, data: null, message: '资源不存在' });
    }
    return res.status(400).json({ code: ERR.VALIDATE, data: null, message: '参数格式不正确' });
  }

  // 唯一键冲突（如手机号重复注册、clientPhotoId 重复）
  if (err.code === 11000) {
    return res.status(409).json({ code: ERR.DUPLICATE, data: null, message: '重复操作：资源已存在' });
  }

  // multer 文件上传错误（超出大小限制/类型不符等）
  if (err.name === 'MulterError' || err.name === 'MulterError'.toLowerCase()) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件大小超出限制' : `文件上传失败：${err.message}`;
    return res.status(400).json({ code: ERR.VALIDATE, data: null, message: msg });
  }

  // 兜底：服务器内部错误（打印堆栈供排查）
  console.error('[Error]', err);
  return res.status(500).json({ code: ERR.SERVER, data: null, message: '服务器内部错误' });
}
