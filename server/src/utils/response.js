/**
 * 统一响应封装（契约：{ code, data, message }，见 api.md 附录 B）
 */

/**
 * 成功响应
 * @param {import('express').Response} res
 * @param {*} data 业务数据
 * @param {string} message 提示信息
 */
export function ok(res, data, message = 'ok') {
  res.json({ code: 0, data, message });
}
