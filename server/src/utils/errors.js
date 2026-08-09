/**
 * 统一业务错误：携带业务错误码 + HTTP 状态码，由 errorHandler 中间件统一响应
 */
export class AppError extends Error {
  /**
   * @param {number} code 业务错误码（见 config/constants.js ERR）
   * @param {string} message 对用户可见的错误信息
   * @param {number} httpStatus HTTP 状态码
   */
  constructor(code, message, httpStatus = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
