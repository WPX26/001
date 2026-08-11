/**
 * 业务 API 方法封装（对齐 Web 端 api.js 的 MemoAPI 语义）
 * 用法：
 *   memoApi.post('/auth/login', { phone, code }).then(data => ...)
 *   memoApi.get('/map/markers?minLng=..&maxLng=..')
 */
import { request, getToken, getUser, setAuth, clearAuth, isLoggedIn } from './request'

const memoApi = {
  // 认证 / 会话
  getToken,
  getUser,
  setAuth,
  clearAuth,
  isLoggedIn,
  // 请求
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path, body) => request('DELETE', path, body),
}

export default memoApi
