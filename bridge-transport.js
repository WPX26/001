/*!
 * bridge-transport.js r69 -- App 内（uni-app web-view）UTS 原生 USB 桥接传输层
 *
 * 与 browser-usb-transport.js（WebUSB 版）接口同构：本文件在 App web-view 环境中
 * 检测到 uni.postMessage 可用时覆盖全局 UsbTether（后加载者优先；非 App 环境
 * 直接 return，WebUSB 版继续生效，PC/Chrome 行为零改动）。
 *
 * 链路：页面 --uni.postMessage--> connect.vue --UTS--> uts-usb-camera(Kotlin)
 *       <--evalJS(base64)-- connect.vue <--Kotlin 回调-- uts-usb-camera
 * 命令走 msgId 关联的 rpc；中断事件由 App 侧 evalJS 主动推 __usbBridge.__interrupt。
 * 协议栈 camera-ptp.js 零改动：transport 暴露 bulkInCap=1MB，照片/EVF 帧大块读，
 * 单帧仅 2-3 次桥往返。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (!(window.uni && typeof window.uni.postMessage === 'function')) return; // 非App：让WebUSB版生效

  var nextId = 1;
  var pending = {};          // msgId -> {resolve, reject, timer}
  var interruptHandler = null;
  var lastScan = [];         // 最近一次 scan 结果（listDevices 同步取）
  var lastOpenErr = null;
  var candidates = [];

  function rpc(op, args, timeoutMs) {
    var id = 'u' + (nextId++);
    var tmo = timeoutMs || 8000;
    return new Promise(function (resolve, reject) {
      pending[id] = {
        resolve: resolve,
        reject: reject,
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

  // App -> web 回调通道（connect.vue 用 evalJS 调用）
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
      try {
        if (interruptHandler) interruptHandler(b64ToU8(b64));
      } catch (e) { /* 中断解析异常不影响读循环 */ }
    }
  };

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

  // ---- transport（协议层 PtpCamera 消费） ----
  function BridgeTransport() {
    this.bulkInCap = 1048576; // r69：UTS原生bulkTransfer单次可读1MB（返回实际长度，短包语义）
  }
  BridgeTransport.prototype.bulkOut = function (u8, timeoutMs) {
    var t = timeoutMs || 4000;
    var b64 = u8ToB64(u8); // PTP命令均为小包（≤几百字节）
    return rpc('out', { data: b64, timeout: t }, t).then(function (n) {
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
    try { rpc('release', {}, 5000); } catch (e) { /* fire-and-forget */ }
    return Promise.resolve();
  };
  BridgeTransport.prototype.startEventReader = function (onEvent, onError) {
    // 中断推送在 connect 成功后由 App 侧常驻回调 -> __interrupt -> 此处转发协议层
    interruptHandler = onEvent;
    this._onErr = onError || null;
  };
  BridgeTransport.prototype.stopEventReader = function () {
    interruptHandler = null;
  };
  BridgeTransport.prototype.diagInfo = function () {
    return { mode: 'uts-bridge', lastErr: lastOpenErr || '', candidates: candidates };
  };

  // ---- UsbTether 桥接版（覆盖 browser-usb-transport.js 注册的 WebUSB 版） ----
  function UsbTetherUts() {}
  UsbTetherUts.prototype.isSupported = function () { return true; };
  UsbTetherUts.prototype.webusbMode = false; // 页面据此走 scan 异步分支而非 WebUSB 授权框
  UsbTetherUts.prototype.utsMode = true;     // connect-prototype.html r69：scan 分支与文案适配
  UsbTetherUts.prototype.get = function () { return this; };
  UsbTetherUts.prototype.scan = function () {
    return rpc('scan', {}, 10000).then(function (jsonStr) {
      var list = [];
      try { list = JSON.parse(jsonStr) || []; } catch (e) {}
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        d.isCanon = d.vid === 0x04A9; // renderDeviceList 佳能标记（对齐 browser 版）
        var serial = d.serial || '';
        d.id = 'uts:' + (d.vid || 0).toString(16) + ':' + (d.pid || 0).toString(16) +
          ':' + (serial || 'ns');
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
  UsbTetherUts.prototype.probeByteArray = function () {
    return 'uts-bridge（原生Kotlin ByteArray，无需探测）';
  };

  var singleton = new UsbTetherUts();
  window.UsbTether = singleton; // 后加载覆盖：App 内原生桥优先
})();
