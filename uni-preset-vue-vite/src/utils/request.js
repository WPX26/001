/**
 * 网络请求核心封装（对齐 Web 端 api.js 语义，面向 uni.request）
 * ==============================================================
 * - baseURL 分环境：dev 局域网 / 生产 https://dsofatjxxjyf.sealoshzh.site，前缀 /api/v1
 * - token 存取（uni storage，键 memo_token）+ 请求自动携带 Authorization: Bearer
 * - 统一响应处理：code != 0 → 业务错误；1002（未登录/失效）→ 清 token 并跳登录页
 * - 错误码映射：1001 参数 / 1002 未登录 / 1003 越权 / 1004 不存在 / 1005 重复 / 1006 限频
 *
 * 用法：
 *   request('GET', '/map/markers?...')
 *   request('POST', '/auth/login', { phone, code })
 */
import { API_BASE_URL, TOKEN_KEY, USER_KEY } from './config'

/* ---------------- 错误码映射（对齐 server/src/config/constants.js ERR） ---------------- */

export const ERR = {
  OK: 0,
  VALIDATE: 1001, // 参数校验失败
  AUTH: 1002, // Token 过期或无效（未登录）
  FORBIDDEN: 1003, // 权限不足
  NOT_FOUND: 1004, // 资源不存在
  DUPLICATE: 1005, // 重复操作
  RATE_LIMIT: 1006, // 请求频率超限
  SERVICE_CONFIG: 1007, // 外部服务配置缺失
  SERVER: 9999, // 服务器内部错误
}

/** 错误码 → 用户可读提示 */
export const ERR_MSG = {
  [ERR.VALIDATE]: '参数有误，请检查输入',
  [ERR.AUTH]: '登录已过期，请重新登录',
  [ERR.FORBIDDEN]: '没有权限执行该操作',
  [ERR.NOT_FOUND]: '资源不存在',
  [ERR.DUPLICATE]: '重复操作，请勿重复提交',
  [ERR.RATE_LIMIT]: '操作过于频繁，请稍后再试',
  [ERR.SERVICE_CONFIG]: '服务暂不可用，请稍后再试',
  [ERR.SERVER]: '服务器开小差了，请稍后再试',
}

/* ---------------- token / 用户信息（uni storage，键名对齐 Web 端） ---------------- */

export function getToken() {
  return uni.getStorageSync(TOKEN_KEY) || ''
}

export function getUser() {
  try {
    const raw = uni.getStorageSync(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

/** 登录/注册成功后保存 token + user */
export function setAuth(token, user) {
  if (token) uni.setStorageSync(TOKEN_KEY, token)
  if (user) uni.setStorageSync(USER_KEY, JSON.stringify(user))
}

/** 登出时清除 */
export function clearAuth() {
  uni.removeStorageSync(TOKEN_KEY)
  uni.removeStorageSync(USER_KEY)
}

export function isLoggedIn() {
  // mock_ 前缀是原型模拟登录态（密码登录/后端不可达时的模拟验证码），并非真实登录，
  // 视为未登录（与 Web 端 api.js 语义一致）——否则残留 mock token 会伪造登录态
  const t = getToken()
  return !!t && t.indexOf('mock_') !== 0
}

/* ---------------- 请求核心 ---------------- */

/**
 * 发起请求
 * @param {string} method GET/POST/PUT/DELETE
 * @param {string} path 以 / 开头的接口路径（拼接在 /api/v1 之后）
 * @param {object} [data] 请求体（GET 场景可携带 query 参数）
 * @returns {Promise<any>} 成功 resolve 后端 data 字段
 */
function request(method, path, data) {
  const header = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) header['Authorization'] = 'Bearer ' + token

  return new Promise((resolve, reject) => {
    uni.request({
      url: API_BASE_URL + path,
      method,
      data: data !== undefined && data !== null ? data : undefined,
      header,
      timeout: 15000,
      success: (res) => {
        const json = res.data
        if (json && json.code === 0) {
          resolve(json.data)
          return
        }
        const code = json && json.code
        const msg = (json && json.message) || ERR_MSG[code] || '请求失败（code=' + code + '）'

        // 1002：未登录 / token 失效 → 清 token 跳登录页
        if (code === ERR.AUTH) {
          clearAuth()
          uni.reLaunch({ url: '/pages/login/login' })
        } else {
          uni.showToast({ title: msg, icon: 'none' })
        }

        const err = new Error(msg)
        err.business = true
        err.code = code
        reject(err)
      },
      fail: (err) => {
        console.warn('[MemoAPI] 服务不可达:', method, path, err && err.errMsg)
        uni.showToast({ title: '网络异常，请检查网络', icon: 'none' })
        const e = new Error(err && err.errMsg ? err.errMsg : '网络异常')
        e.network = true
        reject(e)
      },
    })
  })
}

export { request }
