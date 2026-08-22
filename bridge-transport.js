/*!
 * bridge-transport.js r71 -- App 内（uni-app web-view）UTS 原生 USB 桥接传输层
 *
 * 与 browser-usb-transport.js（WebUSB 版）接口同构：本文件在 App web-view 环境中
 * 覆盖全局 UsbTether（非 App 环境不注册，WebUSB 版继续生效，PC/Chrome 零改动）。
 *
 * r71 根因修复（真机两次实锤）：r69/r70 走 uni.postMessage -> connect.vue -> UTS
 * 中转链，但真机 web-view 里 window.uni 桥始终不可用（注入缺失，非时机问题）
 * -> 桥从未注册 -> USB 落入 usb-transport.js 的 plus 版死路（无 clearPipe，报
 * "transport.clearPipe is not a function"）。r71 改为 plus.android（Native.js）
 * 直接反射调用 UTS 插件 Kotlin 单例（io.dcloud.uni_modules.uts_usbcamera.UsbCamera，
 * r71 起全部方法 @JvmStatic + 提供 *Sync 同步版）：
 *
 *   页面 JS --plus.android--> UsbCamera.connectSync/bulkInSync/...（Kotlin）
 *
 * plus 注入早且稳定（phone-link 的 App 模式判断即依赖 plus.android，真机验证）。
 * 同步调用阻塞 web-view 独占 JS 线程（天然串行，符合协议层 _txRun 纪律），USB
 * 权限弹框/广播在主线程不受影响。中断事件由 Kotlin 队列暂存，本桥 150ms 轮询
 * pollInterrupts() 取走转发协议层。
 *
 * 通道优先级：① plus.android 直连（含旧 APK stub 明确报错，绝不静默掉回死路）
 * ② uni.postMessage 中转（保留，部分 ROM 可用）③ 均无 -> 轮询等待安装。
 * 安装成功 dispatch 'usbtether-installed'（页面据此自动重扫）。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var installed = false;
  var CLS = 'io.dcloud.uni_modules.uts_usbcamera.UsbCamera';

  function plusReady() {
    return !!(window.plus && plus.android && typeof plus.android.importClass === 'function');
  }
  function uniReady() {
    return !!(window.uni && typeof window.uni.postMessage === 'function');
  }

  // ---- base64 <-> Uint8Array（分块避免大数组逐字节拼接卡顿） ----
  function u8ToB64(u8) {
    var CH = 0x8000, parts = [];
    for (var i = 0; i < u8.length; i += CH) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length))));
    }
    return btoa(parts.join(''));
  }
  function b64ToU8(b64) {
    var s = atob(b64 || ''), n = s.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  // ================ 通道①：plus.android Native.js 直连（r71 主通道） ================
  function installPlus() {
    var U = null;
    var loadErr = '';
    try {
      U = plus.android.importClass(CLS);
    } catch (e) {
      loadErr = e && e.message ? e.message : ('' + e);
    }
    // 探测：直接实调 r71 新增的静态方法（Native.js 代理对象属性探测不可靠，须实调验证）。
    // isConnected 无参无副作用：r71 插件（@JvmStatic）返回 boolean；旧插件（r69 无静态方法）throw。
    if (!U) {
      installStub('App 未包含 USB 插件类(' + CLS + ')' +
        (loadErr ? '：' + loadErr : '') +
        '--请用 HBuilderX 对最新项目重新云打包并安装新 APK（uts-usb-camera 插件 r71+）');
      return 'stub';
    }
    try {
      U.isConnected(); // r71 静态接口探测（返回值不用）
    } catch (e) {
      // 类存在但静态方法不可调 = 旧版插件（r69 及更早无 @JvmStatic / 无 Sync 方法）
      installStub('USB 插件版本过旧（类已加载但缺 r71 静态接口）：' +
        (e && e.message ? e.message : e) +
        '--请用 HBuilderX 对最新项目重新云打包并安装新 APK');
      return 'stub';
    }

    var act = null;
    function activity() { return act || (act = plus.android.runtimeMainActivity()); }
    var lastOpenErr = null;
    var candidates = [];

    // ---- transport（协议层 PtpCamera 消费；同步调 Kotlin，JS 线程天然串行） ----
    function PlusTransport() { this.bulkInCap = 1048576; }
    PlusTransport.prototype.bulkOut = function (u8, timeoutMs) {
      return new Promise(function (resolve, reject) {
        try {
          var n = U.bulkOutSync(u8ToB64(u8), timeoutMs || 4000);
          if (typeof n !== 'number' || n < 0) {
            throw new Error('bulkTransfer(out)失败: ' + n + (lastErrOf() ? ' / ' + lastErrOf() : ''));
          }
          if (n !== u8.length) throw new Error('短写 ' + n + '/' + u8.length);
          resolve();
        } catch (e) { reject(e); }
      });
    };
    PlusTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
      return new Promise(function (resolve, reject) {
        try { resolve(b64ToU8(U.bulkInSync(maxLen | 0, timeoutMs || 20000))); }
        catch (e) { reject(e); }
      });
    };
    PlusTransport.prototype.clearPipe = function () {
      return new Promise(function (resolve, reject) {
        try {
          if (!U.clearPipeSync()) { /* clearHalt 容错：连接仍可尝试，协议层后续命令自然暴露问题 */ }
          resolve();
        } catch (e) { reject(e); }
      });
    };
    PlusTransport.prototype.release = function () {
      try { U.releaseSync(); } catch (e) { /* 静默 */ }
      this.stopEventReader();
      return Promise.resolve();
    };
    PlusTransport.prototype.startEventReader = function (onEvent, onError) {
      var self = this;
      this._pollTimer = setInterval(function () {
        try {
          var s = U.pollInterrupts();
          if (s && s.length > 2) { // "[]" 长度 2 = 空队列
            var arr = JSON.parse(s);
            for (var i = 0; i < arr.length; i++) {
              try { onEvent(b64ToU8(arr[i])); } catch (e) { /* 单事件解析异常不停轮询 */ }
            }
          }
        } catch (e) { if (onError) onError(e); }
      }, 150);
    };
    PlusTransport.prototype.stopEventReader = function () {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    };
    PlusTransport.prototype.diagInfo = function () {
      return { mode: 'uts-plus', lastErr: lastOpenErr || lastErrOf(), candidates: candidates };
    };
    function lastErrOf() {
      try { var d = JSON.parse(U.diag() || '{}'); return d.err || ''; } catch (e) { return ''; }
    }

    // ---- UsbTether plus 直连版 ----
    function UsbTetherPlus() {}
    UsbTetherPlus.prototype.isSupported = function () { return true; };
    UsbTetherPlus.prototype.webusbMode = false;
    UsbTetherPlus.prototype.utsMode = true;
    UsbTetherPlus.prototype.utsChannel = 'plus-nativejs';
    UsbTetherPlus.prototype.get = function () { return this; };
    UsbTetherPlus.prototype.scan = function () {
      return new Promise(function (resolve, reject) {
        try {
          var list = [];
          try { list = JSON.parse(U.listDevices(activity()) || '[]') || []; } catch (e) {}
          for (var i = 0; i < list.length; i++) {
            var d = list[i];
            d.isCanon = d.vid === 0x04A9;
            d.id = 'uts:' + (d.vid || 0).toString(16) + ':' + (d.pid || 0).toString(16) +
              ':' + (d.serial || 'ns');
          }
          lastScan = list;
          resolve(list);
        } catch (e) { reject(new Error('原生枚举失败: ' + (e && e.message || e))); }
      });
    };
    UsbTetherPlus.prototype.listDevices = function () { return lastScan.slice(); };
    UsbTetherPlus.prototype.requestConnect = function (deviceId, opts) {
      lastOpenErr = null;
      var iface = (opts && typeof opts.iface === 'number') ? opts.iface : 0;
      return new Promise(function (resolve, reject) {
        var r;
        try { r = JSON.parse(U.connectSync(activity(), deviceId, iface) || '{}'); }
        catch (e) { reject(new Error('原生连接异常: ' + (e && e.message || e))); return; }
        candidates = r.candidates || [];
        if (!r.ok) {
          lastOpenErr = r.message || '连接失败';
          reject(new Error(lastOpenErr));
          return;
        }
        resolve(new PlusTransport());
      });
    };
    UsbTetherPlus.prototype.lastOpenError = function () { return lastOpenErr; };
    UsbTetherPlus.prototype.candidatesInfo = function () { return candidates; };
    UsbTetherPlus.prototype.probeByteArray = function () { return 'uts-plus（Kotlin ByteArray 原生，无需探测）'; };

    var lastScan = [];
    window.UsbTether = new UsbTetherPlus();
    return 'plus';
  }

  // ---- stub 桥（旧 APK）：scan/connect 报安装指引，绝不让流程掉回 plus 版死路 ----
  function installStub(msg) {
    function UsbTetherStub() {}
    UsbTetherStub.prototype.isSupported = function () { return true; };
    UsbTetherStub.prototype.webusbMode = false;
    UsbTetherStub.prototype.utsMode = true;
    UsbTetherStub.prototype.utsChannel = 'stub';
    UsbTetherStub.prototype.get = function () { return this; };
    UsbTetherStub.prototype.scan = function () {
      return Promise.reject(new Error(msg));
    };
    UsbTetherStub.prototype.listDevices = function () { return []; };
    UsbTetherStub.prototype.requestConnect = function () {
      return Promise.reject(new Error(msg));
    };
    UsbTetherStub.prototype.lastOpenError = function () { return msg; };
    UsbTetherStub.prototype.probeByteArray = function () { return 'stub'; };
    window.UsbTether = new UsbTetherStub();
    return 'stub';
  }

  // ================ 通道②：uni.postMessage -> connect.vue -> UTS（r70 保留） ================
  function installUni() {
    var nextId = 1;
    var pending = {};
    var interruptHandler = null;
    var lastScan = [];
    var lastOpenErr = null;
    var candidates = [];

    function rpc(op, args, timeoutMs) {
      var id = 'u' + (nextId++);
      var tmo = timeoutMs || 8000;
      return new Promise(function (resolve, reject) {
        pending[id] = {
          resolve: resolve, reject: reject,
          timer: setTimeout(function () {
            delete pending[id];
            reject(new Error('USB桥超时: ' + op + ' (' + tmo + 'ms)'));
          }, tmo + 4000)
        };
        try {
          uni.postMessage({ data: { type: 'usb', id: id, op: op, args: args || {} } });
        } catch (e) {
          clearTimeout(pending[id].timer);
          delete pending[id];
          reject(e);
        }
      });
    }

    window.__usbBridge = {
      __resolve: function (m) {
        if (!m) return;
        var p = pending[m.id];
        if (!p) return;
        clearTimeout(p.timer);
        delete pending[m.id];
        if (m.ok) p.resolve(m.result);
        else {
          var msg = (m.result && (m.result.message || m.result)) || '未知错误';
          p.reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        }
      },
      __interrupt: function (b64) {
        try { if (interruptHandler) interruptHandler(b64ToU8(b64)); } catch (e) {}
      }
    };

    function BridgeTransport() { this.bulkInCap = 1048576; }
    BridgeTransport.prototype.bulkOut = function (u8, timeoutMs) {
      var t = timeoutMs || 4000;
      return rpc('out', { data: u8ToB64(u8), timeout: t }, t).then(function (n) {
        if (typeof n !== 'number' || n < 0) throw new Error('bulkTransfer(out)失败: ' + n);
        if (n !== u8.length) throw new Error('短写 ' + n + '/' + u8.length);
      });
    };
    BridgeTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
      var t = timeoutMs || 20000;
      return rpc('in', { maxLen: maxLen | 0, timeout: t }, t).then(function (b64) {
        return b64 ? b64ToU8(b64) : new Uint8Array(0);
      });
    };
    BridgeTransport.prototype.clearPipe = function () {
      return rpc('clear', {}, 8000).then(function () { return null; });
    };
    BridgeTransport.prototype.release = function () {
      try { rpc('release', {}, 5000); } catch (e) {}
      return Promise.resolve();
    };
    BridgeTransport.prototype.startEventReader = function (onEvent) { interruptHandler = onEvent; };
    BridgeTransport.prototype.stopEventReader = function () { interruptHandler = null; };
    BridgeTransport.prototype.diagInfo = function () {
      return { mode: 'uts-uni-bridge', lastErr: lastOpenErr || '', candidates: candidates };
    };

    function UsbTetherUts() {}
    UsbTetherUts.prototype.isSupported = function () { return true; };
    UsbTetherUts.prototype.webusbMode = false;
    UsbTetherUts.prototype.utsMode = true;
    UsbTetherUts.prototype.utsChannel = 'uni-postmessage';
    UsbTetherUts.prototype.get = function () { return this; };
    UsbTetherUts.prototype.scan = function () {
      return rpc('scan', {}, 10000).then(function (jsonStr) {
        var list = [];
        try { list = JSON.parse(jsonStr) || []; } catch (e) {}
        for (var i = 0; i < list.length; i++) {
          var d = list[i];
          d.isCanon = d.vid === 0x04A9;
          d.id = 'uts:' + (d.vid || 0).toString(16) + ':' + (d.pid || 0).toString(16) +
            ':' + (d.serial || 'ns');
        }
        lastScan = list;
        return list;
      });
    };
    UsbTetherUts.prototype.listDevices = function () { return lastScan.slice(); };
    UsbTetherUts.prototype.requestConnect = function (deviceId, opts) {
      lastOpenErr = null;
      var iface = (opts && typeof opts.iface === 'number') ? opts.iface : 0;
      return rpc('connect', { deviceId: deviceId, iface: iface }, 35000).then(function (jsonStr) {
        var r = {};
        try { r = JSON.parse(jsonStr) || {}; } catch (e) {}
        candidates = r.candidates || [];
        if (!r.ok) {
          lastOpenErr = r.message || '连接失败';
          throw new Error(lastOpenErr);
        }
        return new BridgeTransport();
      });
    };
    UsbTetherUts.prototype.lastOpenError = function () { return lastOpenErr; };
    UsbTetherUts.prototype.candidatesInfo = function () { return candidates; };
    UsbTetherUts.prototype.probeByteArray = function () { return 'uts-bridge（原生Kotlin ByteArray）'; };

    window.UsbTether = new UsbTetherUts();
    return 'uni';
  }

  // ================ 安装调度：plus 优先（含 stub 兜底），uni 备选，轮询等待 ================
  function install() {
    if (installed) return true;
    var how = null;
    if (plusReady()) {
      how = installPlus(); // 'plus' 或 'stub'（均视为已安装：绝不让 USB 流程掉回 plus 版死路）
    } else if (uniReady()) {
      how = installUni();
    }
    if (how) {
      installed = true;
      try {
        window.dispatchEvent(new CustomEvent('usbtether-installed', { detail: { channel: how } }));
        console.log('[usb-bridge] UTS 桥已安装，通道: ' + how);
      } catch (e) {}
      return true;
    }
    return false;
  }

  if (!install()) {
    var n = 0;
    var timer = setInterval(function () {
      n++;
      if (install() || n >= 60) clearInterval(timer); // 500ms × 60 = 30s
    }, 500);
  }

  // App 侧（connect.vue forceAppMode 节拍）主动通知：最可靠通道
  window.__usbAppBridgeReady = function () { install(); };
})();
