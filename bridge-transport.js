/* ============================================================
 * bridge-transport.js — r79：UTS 原生 USB 桥（真实现，取代 r72 空操作）
 *
 * 架构（2026-08-22 王总拍板方案 B：一次云打包引入 UTS 原生模块）：
 *   web-view 页面(本文件)
 *     ⇄ uni.postMessage / evalJS（window.__usbBridge.__resolve/__interrupt）
 *   connect.vue handleUsb（App 内，已就绪）
 *     ⇄ UTS 插件 uts-usb-camera → UsbCamera.kt（真 byte[] USB Host 传输）
 *
 * 为什么走这条路（r78 真机铁证）：
 *   DCloud web-view 的 JS⇄Java 桥（plus.android）在 IN 方向拿不到数据——
 *   字节数组按值复制，相机返回的字节写在 Java 侧副本被丢弃（读到的是缓冲
 *   区残留 0x41414141="AAAA"，报错"非法包长 1094795585"）。OUT 方向正常、
 *   小字符串正常，唯独 bulk IN 数据永远不可达。原生 UTS 层在 Kotlin 内完成
 *   bulkTransfer 再 base64 经 evalJS 回传，彻底绕开该桥。
 *
 * 本文件职责：
 *   1. 安装 window.__usbBridge（App evalJS 回推的落点）
 *   2. RpcBridgeTransport：与 UsbTether 传输层同接口（clearPipe/bulkOut/
 *      bulkIn/startEventReader/stopEventReader/release/diagInfo/bulkInCap）
 *   3. 门面：包装 UsbTether.get()——App 内优先原生桥（utsMode=true 走
 *      scan 分支），桥缺失（旧 APK）时回落 plus 并在错误上追加升级指引；
 *      Chrome WebUSB 环境零影响（gate 不成立，纯委托）。
 * ============================================================ */
(function () {
  'use strict';
  var global = typeof window !== 'undefined' ? window : globalThis;
  var RPC_TIMEOUT = 2500;      // scan 探测与常规 rpc 超时（页面已有「USB桥超时→升级APK」文案）
  var CONNECT_TIMEOUT = 32000; // connect 含系统授权框等待（原生侧等 25s）
  var IN_TIMEOUT = 20000;      // 原生 bulkIn 内部循环上限
  var IN_RPC_EXTRA = 9000;     // rpc 超时 = 原生超时 + 桥余量
  var BULK_IN_CAP = 131072;    // 单次 rpc 读上限（原生 16KB 分片循环填充；EVF 帧约 1 次 rpc）

  // ---------- 环境判定：仅 App web-view（5+ 运行时 plus + uni 桥 SDK）----------
  // 注意：uni-webview SDK 在任何浏览器都定义 window.uni（bfab67f 教训），
  // 必须同时要求 plus 存在——只有 DCloud App web-view 才有 plus。
  function bridgeEnv() {
    try {
      return typeof plus !== 'undefined' && !!global.uni &&
        typeof global.uni.postMessage === 'function';
    } catch (e) { return false; }
  }

  // ---------- base64 工具（分片防 apply 参数上限） ----------
  function u8ToB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
    }
    return btoa(s);
  }
  function b64ToU8(b64) {
    if (!b64) return new Uint8Array(0);
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xFF;
    return u8;
  }

  // ---------- uni.postMessage RPC 客户端 ----------
  var rpcSeq = 0;
  var rpcPending = {}; // id -> {resolve, reject, timer}
  function rpcResolve(payload) {
    var p = payload && rpcPending[payload.id];
    if (!p) return;
    delete rpcPending[payload.id];
    clearTimeout(p.timer);
    if (payload.ok) p.resolve(payload.result);
    else p.reject(new Error((payload.result && payload.result.message) || 'App 原生层调用失败'));
  }
  function rpcInterrupt(b64) {
    var t = global.__usbActiveTransport;
    if (t && t._onEvent) { try { t._onEvent(b64ToU8(b64)); } catch (e) {} }
  }
  // App 侧 evalJS 回推落点（connect.vue: __resolve({id,ok,result}) / __interrupt(base64)）
  global.__usbBridge = { __resolve: rpcResolve, __interrupt: rpcInterrupt };

  function rpc(op, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!bridgeEnv()) return reject(new Error('uni 桥不可用（非 App 环境）'));
      var id = ++rpcSeq;
      var timer = setTimeout(function () {
        delete rpcPending[id];
        reject(new Error('USB桥超时(' + op + ')'));
      }, timeoutMs || RPC_TIMEOUT);
      rpcPending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        global.uni.postMessage({ data: { type: 'usb', id: id, op: op, args: args || {} } });
      } catch (e) {
        clearTimeout(timer);
        delete rpcPending[id];
        reject(e);
      }
    });
  }

  // ---------- RpcBridgeTransport（与 UsbTether 传输层同构） ----------
  function RpcBridgeTransport(connectRes, deviceId) {
    this.deviceId = deviceId;
    this.info = connectRes;
    this.bufMode = 'uts-rpc';            // 出现在错误诊断里，一眼识别走的原生桥
    this.bulkInCap = BULK_IN_CAP;
    this.version = 'r79';
    this.ifaceInfo = 'iface=' + (connectRes && connectRes.iface);
    this._onEvent = null;
    this.released = false;
  }
  RpcBridgeTransport.prototype.clearPipe = function () {
    return rpc('clear', {}, 8000).then(function () {});
  };
  RpcBridgeTransport.prototype.bulkOut = function (u8, timeoutMs) {
    var t = timeoutMs || 4000;
    return rpc('out', { data: u8ToB64(u8), timeout: t }, t + 9000).then(function (n) {
      if (n !== u8.length) throw new Error('bulkOut 写不完整 n=' + n + ' len=' + u8.length);
      return n;
    });
  };
  RpcBridgeTransport.prototype.bulkIn = function (maxLen) {
    var cap = Math.min(maxLen || 16384, BULK_IN_CAP);
    // 原生返回 base64（空串 = 超时/无数据，ZLP 语义由 camera-ptp PacketStream 处理）
    return rpc('in', { maxLen: cap, timeout: IN_TIMEOUT }, IN_TIMEOUT + IN_RPC_EXTRA)
      .then(function (s) { return b64ToU8(typeof s === 'string' ? s : ''); });
  };
  RpcBridgeTransport.prototype.startEventReader = function (onEvent) {
    // 中断事件由原生常驻线程读取，经 connect.vue evalJS 主动推 __interrupt
    this._onEvent = onEvent;
  };
  RpcBridgeTransport.prototype.stopEventReader = function () { this._onEvent = null; };
  RpcBridgeTransport.prototype.release = function () {
    this.released = true;
    this._onEvent = null;
    if (global.__usbActiveTransport === this) global.__usbActiveTransport = null;
    return rpc('release', {}, 3000).catch(function () {});
  };
  RpcBridgeTransport.prototype.diagInfo = function () {
    return { mode: 'uts-rpc-r79', bufMode: this.bufMode, ifaceInfo: this.ifaceInfo };
  };

  // ---------- 设备枚举结果 → 页面形状（对齐 UsbTetherAndroid.listDevices） ----------
  function parseDevices(s) {
    var arr = [];
    try { arr = JSON.parse(s || '[]'); } catch (e) { arr = []; }
    return arr.map(function (d) {
      var vid = d.vid >>> 0, pid = d.pid >>> 0;
      var serial = d.serial || 'ns';
      return {
        id: 'uts:' + vid.toString(16) + ':' + pid.toString(16) + ':' + serial,
        vid: vid, pid: pid,
        name: d.name || ('USB设备 0x' + vid.toString(16)),
        serial: d.serial || null,
        isCanon: (vid & 0xFFFF) === 0x04A9
      };
    });
  }

  // ---------- 桥探测（页面加载即后台探测；scan 时等待结果） ----------
  var probePromise = null;
  var bridgeState = 'unknown'; // unknown | ok | missing
  function probe() {
    if (!probePromise) {
      probePromise = rpc('scan', {}, RPC_TIMEOUT).then(function (s) {
        bridgeState = 'ok';
        return parseDevices(s);
      }, function (e) {
        bridgeState = 'missing';
        if (global.UsbTether) global.UsbTether.utsMode = false;
        throw e;
      });
    }
    return probePromise;
  }

  // ---------- 门面：包装 UsbTether.get() ----------
  function makeFacade(inner) {
    return {
      __facade: true,
      scan: function () {
        if (!bridgeEnv()) {
          return inner.scan ? inner.scan() : Promise.resolve(inner.listDevices());
        }
        return probe(); // 失败（旧 APK 无插件）→ 页面已有「USB桥超时→升级APK」提示文案
      },
      listDevices: function () { return inner.listDevices(); }, // plus 同步路径（桥缺失时）
      requestConnect: function (deviceId, opts) {
        if (typeof deviceId === 'string' && deviceId.indexOf('uts:') === 0) {
          return rpc('connect', { deviceId: deviceId, iface: (opts && opts.iface) || 0 }, CONNECT_TIMEOUT)
            .then(function (s) {
              var res;
              try { res = JSON.parse(s); } catch (e) { throw new Error('原生连接结果解析失败'); }
              if (!res.ok) throw new Error(res.message || '原生连接失败');
              var t = new RpcBridgeTransport(res, deviceId);
              global.__usbActiveTransport = t;
              return t;
            });
        }
        var p = inner.requestConnect(deviceId, opts);
        if (p && p.catch) {
          return p.catch(function (e) {
            // App 内 plus 路径已被真机证死（IN 数据不可达）：桥缺失时把死路错误
            // 转成可操作的升级指引
            if (bridgeEnv() && bridgeState === 'missing') {
              throw new Error((e && e.message || String(e)) +
                '｜App 内置 USB 服务未检测到：请升级最新云打包 APK（或改用手机 Chrome 打开本页直连）');
            }
            throw e;
          });
        }
        return p;
      }
    };
  }

  function install() {
    if (!global.UsbTether || global.UsbTether.__r79facade) return;
    var origGet = global.UsbTether.get;
    var facade = null;
    global.UsbTether.get = function () {
      if (facade) return facade;
      facade = makeFacade(origGet());
      return facade;
    };
    global.UsbTether.__r79facade = true;
    if (bridgeEnv()) {
      // 乐观置位（页面检测分支选择 scan 路径的依据）；探测失败自动回落
      global.UsbTether.utsMode = true;
      probe().catch(function () {});
    }
  }

  install();
  try { console.log('[usb-bridge] r79：UTS 原生桥门面已安装（bridgeEnv=' + bridgeEnv() + '）'); } catch (e) {}
})();
