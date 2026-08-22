/* ============================================================
 * bridge-transport.js — r85：UTS 原生 USB 桥（真实现，取代 r72 空操作）
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
 *
 * r85【USB桥超时(scan)根因修正 + 决定性诊断】：
 *   1. scan 专用超时 2500→8000ms——排除慢首次原生 UTS 调用被误判超时；
 *   2. UTS rpc 失败自动回落 plus 同步枚举（枚举方向真机可靠），相机列表照常显示；
 *   3. installCalls（connect.vue 每 500ms evalJS 触发 install 的次数 = App→web 通道探针）、
 *      扫描时刻环境快照 env@scan、用时 lastScanMs、迟到回复 lateReplies（慢 vs 根本不回）；
 *      全部进 bridgeDiag，页面 USB 弹层底部 env 行一键可见。
 * ============================================================ */
(function () {
  'use strict';
  var global = typeof window !== 'undefined' ? window : globalThis;
  var RPC_TIMEOUT = 2500;      // 常规 rpc 超时（连接/写/读等）
  var SCAN_TIMEOUT = 8000;     // r85：scan 专用超时——排除慢首次原生 UTS 调用（此前 2500 冷启动误判超时）
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
  var timedOut = {};   // r85：id -> true（超时后迟到的 App 回复）
  var lateReplies = 0; // r85：迟到回复计数——判断「慢但通」vs「根本不回」
  function rpcResolve(payload) {
    var p = payload && rpcPending[payload.id];
    if (!p) {
      if (payload && timedOut[payload.id]) { delete timedOut[payload.id]; lateReplies++; }
      return;
    }
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
        if (rpcPending[id]) {
          delete rpcPending[id];
          timedOut[id] = true; // r85：记超时 id，回复迟到时计入 lateReplies
        }
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
    this.version = 'r85';
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
    return { mode: 'uts-rpc-r85', bufMode: this.bufMode, ifaceInfo: this.ifaceInfo };
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
  var bridgeState = 'unknown'; // unknown | ok | missing | plus
  var installCalls = 0;  // r85：install() 执行次数（connect.vue 每 500ms evalJS 触发；>=2 = App→web 通道通）
  var scanAttempts = 0;  // r85：scan 尝试次数
  var lastScanMs = 0;    // r85：最近一次 scan 用时 ms
  var lastScanEnv = null;// r85：最近一次 scan 时刻的环境快照（env 行默认只在加载时刷新，点击时已过期）
  var lastScanPath = ''; // r85：最近一次 scan 成功路径：uts | plus | uts-fail
  function snapDiag() {  // r85：无自嵌套的环境快照（防诊断对象随扫描次数无限加深）
    var d = bridgeDiag();
    delete d.lastScanEnv;
    return d;
  }
  function probe() {
    if (!probePromise) {
      probePromise = rpc('scan', {}, SCAN_TIMEOUT).then(function (s) {
        bridgeState = 'ok';
        if (global.UsbTether) global.UsbTether.utsMode = true; // r80：成功明确保持
        fireInstalled();
        return parseDevices(s);
      }, function (e) {
        bridgeState = 'missing';
        // r80【根因修复】：失败不再永久禁用 utsMode——保留乐观置位，下次 scan/install
        // 触发全新重试。此前"首次探测失败→utsMode=false→页面静默退回 plus 旧桥(IN 方向
        // 已被 r78 真机证死，读到缓冲残留 0x41414141)"是本次"一模一样报错"的直接原因。
        probePromise = null; // 失败后允许重试
        throw e;
      });
    }
    return probePromise;
  }

  // r82【根因修复】：每次「检测设备」都强制重新探测——不复用 probePromise 缓存。
  // 根因：probe() 在页面加载瞬间缓存了首次 rpc('scan') 结果（此刻相机通常未插/
  // 未枚举完成，缓存的是空数组），scan() 复用它会让「先开页后插 OTG」的用户
  // 永远看到"未检测到 USB 设备"——这正是 r80 上线后王总操作无误却检测不到的根因。
  // freshScan 每次向原生层真实查询设备列表，插线后点「检测设备」必然重新枚举。
  function freshScan() {
    var t0 = Date.now();
    return rpc('scan', {}, SCAN_TIMEOUT).then(function (s) {
      lastScanMs = Date.now() - t0;
      lastScanPath = 'uts';
      bridgeState = 'ok';
      if (global.UsbTether) global.UsbTether.utsMode = true; // r80：成功明确保持
      fireInstalled();
      return parseDevices(s);
    }, function (e) {
      lastScanMs = Date.now() - t0;
      lastScanPath = 'uts-fail';
      bridgeState = 'missing';
      probePromise = null; // 失败允许重试
      throw e;
    });
  }

  // r80：桥激活事件（页面 usbtether-installed 监听 → 弹层开着时自动重扫 + 刷新诊断行）
  function fireInstalled() {
    try {
      var ev = (typeof Event === 'function') ? new Event('usbtether-installed')
        : (function () { var e = document.createEvent('Event'); e.initEvent('usbtether-installed', false, false); return e; })();
      global.dispatchEvent(ev);
    } catch (e) {}
  }

  // r80：桥诊断（页面底部/错误提示用，一眼看出哪一环断了）
  function bridgeDiag() {
    return {
      bridgeEnv: bridgeEnv(),
      plus: typeof plus !== 'undefined',
      plusAndroid: !!(typeof plus !== 'undefined' && plus.android),
      uni: !!global.uni,
      uniPostMessage: !!(global.uni && global.uni.postMessage),
      weexPost: typeof (global.__dcloud_weex_postMessage) !== 'undefined',
      weex: typeof (global.__dcloud_weex_) !== 'undefined',
      uaHtml5: /Html5Plus/i.test(navigator.userAgent),
      utsMode: !!(global.UsbTether && global.UsbTether.utsMode),
      bridgeState: bridgeState,
      rpcPending: Object.keys(rpcPending).length,
      installCalls: installCalls,
      lateReplies: lateReplies,
      scanAttempts: scanAttempts,
      lastScanMs: lastScanMs,
      lastScanPath: lastScanPath,
      lastScanEnv: lastScanEnv
    };
  }

  // ---------- 门面：包装 UsbTether.get() ----------
  function makeFacade(inner) {
    // r85【备用通道】：UTS 原生桥 rpc 失败时，直接用 plus.android 同步枚举设备列表。
    // 枚举方向（deviceList 遍历）在真机上可靠（r78 证死的是 bulk IN 数据方向，不是枚举）。
    // 作用：桥故障时相机列表仍能出来（王总能确认设备在），并把走过的路写进诊断。
    function plusEnumFallback(utsErr, t0) {
      lastScanMs = Date.now() - t0;
      lastScanPath = 'plus';
      lastScanEnv = snapDiag();
      var msg = (utsErr && utsErr.message) ? utsErr.message : 'USB桥超时(scan)';
      try {
        var devs = inner.listDevices ? inner.listDevices() : [];
        if (devs && devs.length) {
          bridgeState = 'plus';
          if (global.UsbTether) global.UsbTether.utsMode = false; // 非原生桥成功，别让版本行误标「原生桥」
          lastScanEnv = snapDiag();
          return devs; // 列表照常渲染；requestConnect 会对 plus 态快速给出桥不可用指引
        }
        throw new Error('plus 枚举成功但无设备');
      } catch (pe) {
        bridgeState = 'missing';
        lastScanEnv = snapDiag();
        throw new Error(msg + '｜备用枚举:' + ((pe && pe.message) || String(pe)) +
          '｜用时' + lastScanMs + 'ms｜path=' + lastScanPath +
          '｜env@scan=' + JSON.stringify(lastScanEnv) +
          '｜installCalls=' + installCalls + '｜lateReplies=' + lateReplies);
      }
    }
    return {
      __facade: true,
      diag: bridgeDiag,
      scan: function () {
        var t0 = Date.now();
        scanAttempts++;
        lastScanEnv = snapDiag(); // r85：扫描时刻环境快照（env 行默认只在加载时刷新，点击时已过期）
        if (!bridgeEnv()) {
          if (typeof plus !== 'undefined') {
            // App 内但 uni 桥缺失：plus 枚举方向可靠，直接枚举给出设备（不静默失败）
            return plusEnumFallback(null, t0);
          }
          return inner.scan ? inner.scan() : Promise.resolve(inner.listDevices());
        }
        // r82：每次点击都真实查询原生设备列表；r85：失败自动回落 plus 枚举
        return freshScan().catch(function (e) { return plusEnumFallback(e, t0); });
      },
      listDevices: function () { return inner.listDevices(); }, // plus 同步路径（桥缺失时）
      requestConnect: function (deviceId, opts) {
        if (bridgeState === 'plus') {
            // r85：scan 走的是备用 plus 枚举（原生桥不可用）——任何连接都快速失败并给指引，别走死路 plus 桥
            return Promise.reject(new Error('UTS 原生桥未响应（列表来自备用枚举）。请彻底退出 App 重开重试；仍失败请把 USB 弹层底部 env 诊断发我'));
          }
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
    installCalls++; // r85：evalJS 通道探针——connect.vue 每 500ms evalJS 触发一次，>=2 证明 App→web 通道通
    if (!global.UsbTether) {
      // r80：usb-transport.js 尚未就绪（极少见），短轮询等待后重装
      if (!global.__usbInstallT) {
        global.__usbInstallT = setInterval(function () {
          if (global.UsbTether) {
            clearInterval(global.__usbInstallT);
            global.__usbInstallT = null;
            install();
          }
        }, 250);
      }
      return;
    }
    if (!global.UsbTether.__r79facade) {
      var origGet = global.UsbTether.get;
      var facade = null;
      global.UsbTether.get = function () {
        if (facade) return facade;
        facade = makeFacade(origGet());
        return facade;
      };
      global.UsbTether.__r79facade = true;
      if (!global.UsbTether.bridgeDiag) global.UsbTether.bridgeDiag = bridgeDiag;
    }
    // r80【根因修复】：幂等重装。connect.vue 每 500ms evalJS __usbAppBridgeReady() 触发本函数；
    // uni/plus 注入晚时，这里反复评估，一旦就绪即置位 utsMode 并启动探测——
    // 杜绝「脚本加载瞬间 plus/uni 未就绪 → utsMode 永不置位 → 页面静默走死路旧桥」的根因。
    if (bridgeEnv()) {
      if (!global.UsbTether.utsMode) {
        global.UsbTether.utsMode = true;
      }
      if (bridgeState !== 'ok') {
        probe().catch(function () {});
      }
    }
  }

  install();
  // connect.vue 兜底触发点（forceAppMode：8 次 × 500ms evalJS）——实现 r70 预留的钩子
  global.__usbAppBridgeReady = function () { try { install(); } catch (e) {} };
  try {
    console.log('[usb-bridge] r85：UTS 原生桥门面已安装（env=' + JSON.stringify(bridgeDiag()) + '）');
  } catch (e) {}
})();
