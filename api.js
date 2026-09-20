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
  var REFRESH_TOKEN_KEY = 'memo_refresh_token'; // refresh token（token 过期时换取新 token）
  var USER_KEY = 'memo_user';         // 登录用户信息（JSON）
  var PHOTO_ID_MAP_KEY = 'memo_photo_id_map'; // 本地照片 id → 后端照片 id（上传回调后登记）
  var USER_ID_MAP_KEY = 'memo_user_id_map';   // 作者名 → 后端用户 id（关注用）

  /* ---------------- token / 用户信息 ---------------- */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function getRefreshToken() {
    try { return localStorage.getItem(REFRESH_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function getUser() {
    try {
      var raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /** 登录/注册成功后保存 token + refreshToken + user */
  function setAuth(token, user, refreshToken) {
    try {
      localStorage.setItem(TOKEN_KEY, token || '');
      if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) { /* 忽略存储异常 */ }
  }

  /** 登出时清除 */
  function clearAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
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

  // token 过期（1002）时用 refreshToken 换取新 token（并发去重，一次只刷一次）
  var refreshing = null;
  function refreshTokens() {
    var rt = getRefreshToken();
    if (!rt || rt.indexOf('mock_') === 0) {
      clearAuth();
      var err0 = new Error('登录已过期，请重新登录');
      err0.business = true;
      err0.code = 1002;
      return Promise.reject(err0);
    }
    if (!refreshing) {
      refreshing = fetch(BASE_URL + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
        mode: 'cors'
      })
        .then(function (res) { return res.json(); })
        .then(function (json) {
          if (json && json.code === 0 && json.data && json.data.token) {
            // 轮换：refresh token 也换新（后端吊销旧的）
            setAuth(json.data.token, json.data.user || getUser(), json.data.refreshToken);
            return json.data.token;
          }
          clearAuth();
          var err = new Error((json && json.message) || '登录已过期，请重新登录');
          err.business = true;
          err.code = 1002;
          throw err;
        })
        .then(function (t) { refreshing = null; return t; }, function (e) { refreshing = null; throw e; });
    }
    return refreshing;
  }

  function doRequest(method, path, body, retried) {
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
        // token 过期：刷新后重试一次（已重试过则不再刷）
        if (!retried && json && json.code === 1002) {
          return refreshTokens().then(function () {
            return doRequest(method, path, body, true);
          }).catch(function (e) {
            if (e && e.code === 1002) throw e;
            throw e;
          });
        }
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

  function request(method, path, body) {
    return doRequest(method, path, body, false);
  }

  /** 退出登录：调后端吊销 refresh token + 清本地登录态（后端不可达也清本地） */
  function logout() {
    var token = getToken();
    if (!token || token.indexOf('mock_') === 0) {
      clearAuth();
      return Promise.resolve();
    }
    var headers = { 'Content-Type': 'application/json' };
    headers['Authorization'] = 'Bearer ' + token;
    return fetch(BASE_URL + '/auth/logout', { method: 'POST', headers: headers, mode: 'cors' })
      .catch(function () { /* 网络失败也继续清本地 */ })
      .then(function () { clearAuth(); });
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


  /* ---------------- 小文件直传（api.md 14.4：头像/聊天图/作品集） ----------------
   * multipart/form-data，带 Bearer token；返回 { url, relativePath, name, size, scene }
   */
  function uploadFile(file, scene) {
    if (!file) return Promise.reject(new Error('缺少文件'));
    var token = getToken();
    var form = new FormData();
    form.append('file', file);
    form.append('scene', scene || 'avatar');
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(BASE_URL + '/upload/file', { method: 'POST', headers: headers, mode: 'cors', body: form })
      .then(function (res) {
        return res.json().catch(function () {
          var err = new Error('HTTP ' + res.status);
          err.network = true;
          throw err;
        });
      })
      .then(function (json) {
        if (json && json.code === 0) return json.data;
        var msg = (json && json.message) || ('上传失败（code=' + (json && json.code) + '）');
        console.warn('[MemoAPI] POST /upload/file →', msg);
        var err = new Error(msg);
        err.business = true;
        err.code = json && json.code;
        throw err;
      })
      .catch(function (e) {
        if (!e.business && !e.network) {
          e.network = true;
          console.warn('[MemoAPI] 服务不可达: POST /upload/file', e && e.message);
        }
        throw e;
      });
  }

  /* ---------------- 私信 WebSocket（api.md 附录 A：/chat/ws） ----------------
   * 地址：ws(s)://<host>/api/v1/chat/ws?token=<access token>（JWT 走 query，服务端校验）
   * 心跳：客户端每 30s 上行 {type:'ping'}，服务端回 {type:'pong'}；
   * 断线：指数退避自动重连（1s→2s→…→15s 封顶），页面无需手动重连。
   */
  function chatWsUrl() {
    var token = getToken();
    if (!token || token.indexOf('mock_') === 0) return '';
    var base = BASE_URL.replace(/\/+$/, '');
    var wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    return wsBase + '/chat/ws?token=' + encodeURIComponent(token);
  }

  /**
   * 创建私信 WS 客户端（仅新增方法，不改动既有行为）
   * @param {object} opts { onMessage(evt), onStatus({status, detail}) }
   * @returns {object} { close(), isOpen() }
   */
  function createChatSocket(opts) {
    opts = opts || {};
    var onMessage = opts.onMessage || function () {};
    var onStatus = opts.onStatus || function () {};
    var url = chatWsUrl();
    var ws = null;
    var closedByUser = false;
    var reconnectDelay = 1000;
    var heartbeatTimer = null;

    function notify(status, detail) {
      try { onStatus({ status: status, detail: detail || '' }); } catch (e) { /* 回调异常不打断连接 */ }
    }

    function scheduleReconnect() {
      if (closedByUser) return;
      notify('reconnecting', 'delay=' + reconnectDelay);
      setTimeout(function () {
        if (closedByUser) return;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }

    function connect() {
      if (closedByUser) return;
      if (typeof WebSocket === 'undefined') { notify('unsupported'); return; }
      if (!url) { notify('unavailable'); return; }
      notify('connecting');
      var socket;
      try { socket = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
      ws = socket;

      socket.onopen = function () {
        reconnectDelay = 1000;
        notify('open');
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(function () {
          if (socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* 忽略 */ }
          }
        }, 30000);
      };

      socket.onmessage = function (ev) {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || !msg.type) return;
        if (msg.type === 'pong') return; // 心跳应答，无需上抛
        try { onMessage(msg); } catch (e) { /* 回调异常不打断连接 */ }
      };

      socket.onclose = function (ev) {
        clearInterval(heartbeatTimer);
        notify('closed', 'code=' + (ev && ev.code));
        if (closedByUser) return;
        // 4001 = 服务端 JWT 校验拒绝（token 失效）：不再无限重连，交由 REST 兜底
        if (ev && ev.code === 4001) { notify('unauthorized'); return; }
        scheduleReconnect();
      };

      socket.onerror = function () {
        /* close 事件随后触发重连 */
      };
    }

    connect();

    return {
      // 上行通用发送（typing 等；未连接时静默丢弃）
      send: function (obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
        }
      },
      close: function () {
        closedByUser = true;
        clearInterval(heartbeatTimer);
        if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
      },
      isOpen: function () {
        return !!(ws && ws.readyState === WebSocket.OPEN);
      }
    };
  }

  /* ---------------- 导出 ---------------- */

  var MemoAPI = {
    baseUrl: BASE_URL,
    // 认证
    getToken: getToken,
    getRefreshToken: getRefreshToken,
    getUser: getUser,
    setAuth: setAuth,
    clearAuth: clearAuth,
    logout: logout,
    isLoggedIn: isLoggedIn,
    // 请求
    request: request,
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body); },
    put: function (path, body) { return request('PUT', path, body); },
    del: function (path, body) { return request('DELETE', path, body); },
    // 上传 / WebSocket（2026-08-18 前端补齐新增，仅追加）
    uploadFile: uploadFile,
    chatWsUrl: chatWsUrl,
    createChatSocket: createChatSocket,
    // id 映射
    getPhotoBackendId: getPhotoBackendId,
    setPhotoBackendId: setPhotoBackendId,
    getUserBackendId: getUserBackendId,
    setUserBackendId: setUserBackendId
  };

  global.MemoAPI = MemoAPI;
})(typeof window !== 'undefined' ? window : this);