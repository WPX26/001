/**
 * 公共 API 封装（HTML 原型 → 真实后端桥接）
 * =====================================================
 * 后端：http://localhost:3000/api/v1（Node + Express，CORS 全放开）
 * 认证：Authorization: Bearer <token>（除登录/注册外均需携带）
 *
 * 双模式设计：
 *  - 未登录（localStorage 无 memo_token）：页面继续使用本地模拟数据，本文件不参与
 *  - 已登录：页面通过 MemoAPI 调用真实接口；服务不可达时各页面回退本地模拟逻辑
 *
 * 错误处理约定：业务错误（code != 0）与网络错误只 console 提示，
 * 不弹出任何 UI（保持原型现有视觉与交互不变）。
 *
 * 使用示例：
 *   MemoAPI.post('/auth/login', { phone, code }).then(data => {...}).catch(err => {...});
 *   MemoAPI.get('/map/markers?minLng=..&maxLng=..&minLat=..&maxLat=..&zoom=..&level=..');
 *   MemoAPI.del('/photos/' + photoId + '/like');
 */
(function (global) {
  'use strict';

  // 后端地址：默认 http://localhost:3000/api/v1；可用 localStorage['memo_api_base'] 覆盖（联调不同环境）
  var BASE_URL = (function () {
    try {
      return localStorage.getItem('memo_api_base') || 'http://localhost:3000/api/v1';
    } catch (e) {
      return 'http://localhost:3000/api/v1';
    }
  })();

  var TOKEN_KEY = 'memo_token';       // Bearer token
  var USER_KEY = 'memo_user';         // 登录用户信息（JSON）
  var PHOTO_ID_MAP_KEY = 'memo_photo_id_map'; // 本地照片 id → 后端照片 id（上传回调后登记）
  var USER_ID_MAP_KEY = 'memo_user_id_map';   // 作者名 → 后端用户 id（关注用）

  /* ---------------- token / 用户信息 ---------------- */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function getUser() {
    try {
      var raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /** 登录/注册成功后保存 token + user */
  function setAuth(token, user) {
    try {
      localStorage.setItem(TOKEN_KEY, token || '');
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) { /* 忽略存储异常 */ }
  }

  /** 登出时清除 */
  function clearAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (e) { /* 忽略 */ }
  }

  function isLoggedIn() {
    var t = getToken();
    // mock_ 前缀是原型模拟登录态（密码登录/后端不可达时的模拟验证码），并非真实登录，
    // 视为未登录——否则残留 mock token 会伪造登录态：登录引导不弹、真实接口却必拒（1002）
    return !!t && t.indexOf('mock_') !== 0;
  }

  /* ---------------- 请求核心 ---------------- */

  function request(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var options = { method: method, headers: headers, mode: 'cors' };
    if (body !== undefined && body !== null) options.body = JSON.stringify(body);

    return fetch(BASE_URL + path, options)
      .then(function (res) {
        return res.json().catch(function () {
          var err = new Error('HTTP ' + res.status);
          err.network = true;
          throw err;
        });
      })
      .then(function (json) {
        if (json && json.code === 0) return json.data;
        var msg = (json && json.message) || ('请求失败（code=' + (json && json.code) + '）');
        console.warn('[MemoAPI]', method, path, '→', msg);
        var err = new Error(msg);
        err.business = true;   // 业务错误（后端可达但 code != 0）
        err.code = json && json.code;
        throw err;
      })
      .catch(function (e) {
        // 网络/解析异常标记 network=true，供页面区分"服务不可达→回退模拟"
        if (!e.business && !e.network) {
          e.network = true;
          console.warn('[MemoAPI] 服务不可达:', method, path, e && e.message);
        }
        throw e;
      });
  }

  /* ---------------- id 映射（本地演示数据 ↔ 后端资源） ---------------- */

  function readMap(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function setMapEntry(key, localKey, backendId) {
    try {
      var map = readMap(key);
      map[String(localKey)] = backendId;
      localStorage.setItem(key, JSON.stringify(map));
    } catch (e) { /* 忽略 */ }
  }

  /** 本地照片 id → 后端照片 id（点赞/收藏时使用真实照片 ID） */
  function getPhotoBackendId(localId) {
    return readMap(PHOTO_ID_MAP_KEY)[String(localId)] || null;
  }

  function setPhotoBackendId(localId, backendId) {
    setMapEntry(PHOTO_ID_MAP_KEY, localId, backendId);
  }

  /** 作者名 → 后端用户 id（关注时使用真实用户 ID） */
  function getUserBackendId(name) {
    return readMap(USER_ID_MAP_KEY)[String(name)] || null;
  }

  function setUserBackendId(name, userId) {
    setMapEntry(USER_ID_MAP_KEY, name, userId);
  }

  /* ---------------- 导出 ---------------- */

  var MemoAPI = {
    baseUrl: BASE_URL,
    // 认证
    getToken: getToken,
    getUser: getUser,
    setAuth: setAuth,
    clearAuth: clearAuth,
    isLoggedIn: isLoggedIn,
    // 请求
    request: request,
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body); },
    put: function (path, body) { return request('PUT', path, body); },
    del: function (path, body) { return request('DELETE', path, body); },
    // id 映射
    getPhotoBackendId: getPhotoBackendId,
    setPhotoBackendId: setPhotoBackendId,
    getUserBackendId: getUserBackendId,
    setUserBackendId: setUserBackendId
  };

  global.MemoAPI = MemoAPI;
})(typeof window !== 'undefined' ? window : this);
