/* ============================================================
 * browser-usb-transport.js — WebUSB 传输层（Chrome/Edge 桌面 + Android Chrome）
 *
 * 与 usb-transport.js（Native.js/plus 版）实现**完全相同的**
 * transport 接口（bulkOut / bulkIn / release）与顶层 API
 * （listDevices / promptDevice / requestConnect），供 camera-ptp.js
 * 使用，页面代码零改动。
 *
 * 适用环境（2026-08-16 调研实锤，见 docs/相机互联-USB真机联调指南.md）：
 *   - 电脑 Chrome/Edge 61+：USB 直连（Windows 上相机等"well-known"
 *     设备被系统驱动独占，需先用 Zadig 换 WinUSB 驱动；macOS/Linux
 *     开箱即用）
 *   - Android Chrome 61+：USB OTG 直连，默认支持 WebUSB（官方先例：
 *     GoogleChromeLabs/web-gphoto2 在 Android 手机直连佳能实测出图）
 * 不适用：uni-app App 的 web-view——系统 WebView 暴露 USB 接口但
 *   **不支持 WebUSB 功能**（MDN browser-compat-data 实锤）——
 *   那里仍走 usb-transport.js（Native.js，读方向受限）或二期 UTS 插件。
 *
 * 环境互斥（防两个版本同时接管全局 UsbTether）：
 *   App web-view 有 plus → 本文件不生效（plus 版 UsbTether 保持）；
 *   Chrome/Edge 无 plus 且 navigator.usb 可用 → 本文件接管。
 * 加载顺序：必须在 usb-transport.js 之后引入。
 * ============================================================ */
(function (global) {
  'use strict';

  var CANON_VID = 0x04A9; // Canon Inc.

  /** WebUSB 可用：无 plus（非 App web-view）且有可用 navigator.usb */
  function isSupported() {
    if (typeof plus !== 'undefined' && plus.android) return false; // App web-view → 归 plus 版
    return !!(global.navigator && navigator.usb &&
      typeof navigator.usb.requestDevice === 'function' &&
      typeof navigator.usb.getDevices === 'function');
  }

  /* ============================================================
   * 单个 WebUSB 传输通道（实现 PtpCamera 所需 transport 接口）
   * bulkIn 语义与 Android 版对齐：resolve(Uint8Array)，长度=实际字节
   * （WebUSB transferIn 的 data 是设备实际返回字节，length 只是上限）
   * ============================================================ */
  function WebUsbTransport(deps) {
    this.device = deps.device;       // USBDevice
    this.ifaceNum = deps.ifaceNum;   // interfaceNumber
    this.bulkInEpNum = deps.bulkInEpNum;   // 端点号（不含方向位，WebUSB 用法）
    this.bulkOutEpNum = deps.bulkOutEpNum;
    this.ifaceInfo = deps.ifaceInfo; // 诊断用结构文本
    this.released = false;
    // 超时兜底：WebUSB 无原生 timeout 参数（请求挂到有数据或断开），
    // 超时由 JS 侧 setTimeout 实现；残留 pending 请求靠 release() 的
    // device.close() 取消（close 会 cancel 全部 in-flight transfer，
    // 其 Promise 以 DOMException 拒绝，届时 released 标记已置位、结果丢弃）
    this._pending = [];
  }

  /** 等待 Promise 并附带超时（超时 reject，残留请求由 close() 回收） */
  WebUsbTransport.prototype._withTimeout = function (p, timeoutMs, tag) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        var i = self._pending.indexOf(p);
        if (i >= 0) self._pending.splice(i, 1);
        reject(new Error(tag + ' 超时（' + (timeoutMs || 0) + 'ms）'));
      }, timeoutMs || 20000);
      self._pending.push(p);
      p.then(function (v) {
        clearTimeout(t);
        var i = self._pending.indexOf(p);
        if (i >= 0) self._pending.splice(i, 1);
        if (self.released) return; // close() 后的迟到结果丢弃
        resolve(v);
      }, function (e) {
        clearTimeout(t);
        var i = self._pending.indexOf(p);
        if (i >= 0) self._pending.splice(i, 1);
        if (self.released && e && e.name === 'NotFoundError') return; // 设备已关闭的取消
        reject(e);
      });
    });
  };

  /** 写数据；STALL → clearHalt(OUT) 重试一次（gphoto2 gp_port_usb_clear_halt 同法） */
  WebUsbTransport.prototype.bulkOut = function (u8, timeoutMs) {
    var self = this;
    var dev = this.device;
    if (this.released) return Promise.reject(new Error('USB 连接已释放'));
    return this._withTimeout(dev.transferOut(this.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)')
      .then(function (res) {
        if (res.status === 'ok') return;
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('out', self.bulkOutEpNum), 3000, 'clearHalt(out)')
            .then(function () {
              return self._withTimeout(dev.transferOut(self.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') return;
              throw new Error('bulkTransfer(out) stall 重试后 status=' + res2.status);
            });
        }
        throw new Error('bulkTransfer(out) status=' + res.status);
      });
  };

  /** 读数据；返回实际字节（≤maxLen）。STALL → clearHalt(IN) 重试一次 */
  WebUsbTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
    var self = this;
    var dev = this.device;
    if (this.released) return Promise.reject(new Error('USB 连接已释放'));
    // WebUSB 无桥的数组限制（Android 版 16KB 上限是桥的限制），
    // 单次请求 ≤16KB 与协议栈 PacketStream 流式拼接配合（16KB 是
    // tethr 实测的分配/性能平衡点；Chrome 上限 32MB 远高于此）
    var size = Math.min(Math.max(maxLen || 512, 512), 16384);
    return this._withTimeout(dev.transferIn(this.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)')
      .then(function (res) {
        if (res.status === 'ok') {
          // ZLP（空读）：返回空 Uint8Array，协议栈 PacketStream 空读容忍（与 Android 版一致）
          return res.data ? new Uint8Array(res.data) : new Uint8Array(0);
        }
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('in', self.bulkInEpNum), 3000, 'clearHalt(in)')
            .then(function () {
              return self._withTimeout(dev.transferIn(self.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') {
                return res2.data ? new Uint8Array(res2.data) : new Uint8Array(0);
              }
              throw new Error('bulkTransfer(in) stall 重试后 status=' + res2.status);
            });
        }
        throw new Error('bulkTransfer(in) status=' + res.status + (res.data ? ' 收到 ' + res.data.byteLength + 'B' : ''));
      });
  };

  WebUsbTransport.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    var dev = this.device;
    if (dev && dev.opened) {
      // close() 会 cancel 全部 in-flight transfer（其 Promise 拒绝后
      // 被 _withTimeout 的 released 分支丢弃），并释放接口
      try { dev.close().catch(function () {}); } catch (e) {}
    }
  };

  /* ============================================================
   * 顶层管理：枚举 / 授权（系统授权框）/ 连接
   * ============================================================ */
  function UsbTetherWebUsb() {
    this.device = null; // 最近连接/授权设备（诊断用）
  }

  UsbTetherWebUsb.prototype._require = function () {
    if (!isSupported()) throw new Error('当前浏览器不支持 WebUSB（需 Chrome/Edge 61+，桌面或 Android）');
  };

  /** 设备 → 页面列表项（与 plus 版 listDevices 相同结构） */
  UsbTetherWebUsb.prototype._mapDevice = function (d, idx) {
    var vid = d.vendorId || 0;
    var pid = d.productId || 0;
    var serial = d.serialNumber || '';
    var id = 'webusb:' + vid.toString(16) + ':' + pid.toString(16) + ':' + (serial || idx);
    var name = d.productName || (serial ? serial : ('USB 设备 ' + (idx + 1)));
    return {
      id: id,
      vid: vid,
      pid: pid,
      name: name,
      serial: serial,
      isCanon: vid === CANON_VID
    };
  };

  /**
   * 枚举已授权设备（WebUSB 的 getDevices 只返回已授权列表；
   * 未授权设备需 promptDevice 弹系统授权框）
   */
  UsbTetherWebUsb.prototype.listDevices = function () {
    this._require();
    // 同步接口（页面 scanDevices 同步调用）：WebUSB getDevices 是异步——
    // 同步返回空；页面通过 webusbMode 分支调用异步 scan()（见下）
    return [];
  };

  /**
   * WebUSB 版检测（页面 webusbMode 分支调用）：
   * 已授权设备 → 直接列；无 → 弹系统授权框（**必须在用户手势内
   * 同步调用**——scanDevices 由「检测设备」按钮点击触发，满足）
   * @returns {Promise<Array>} 设备列表项（用户取消 → []）
   */
  UsbTetherWebUsb.prototype.scan = function () {
    var self = this;
    this._require();
    return navigator.usb.getDevices().then(function (list) {
      if (list && list.length) {
        return list.map(function (d, i) { return self._mapDevice(d, i); });
      }
      return self.promptAndList();
    });
  };

  /**
   * WebUSB 版检测：弹系统授权框（须在用户手势内调用）→ 返回
   * 设备列表项数组（用户取消 → []）
   */
  UsbTetherWebUsb.prototype.promptAndList = function () {
    var self = this;
    this._require();
    return navigator.usb.requestDevice({ filters: [] }) // filters 空 = 显示全部 USB 设备供选择
      .then(function (d) {
        self.device = d;
        var mapped = [self._mapDevice(d, 0)];
        return mapped;
      }, function (err) {
        if (err && err.name === 'NotFoundError') return []; // 用户取消
        throw err;
      });
  };

  /**
   * 申请权限并连接（WebUSB 版）
   * @param {String} deviceId listDevices/promptAndList 返回的 id
   * @returns {Promise<WebUsbTransport>}
   */
  UsbTetherWebUsb.prototype.requestConnect = function (deviceId) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var stage = 'init';
      try {
        self._require();
        stage = 'findDevice';
        // 优先从已授权列表按 id 匹配
        return navigator.usb.getDevices().then(function (list) {
          var dev = null;
          if (self.device) dev = self.device; // promptAndList 刚授权过的优先
          if (!dev) {
            list.forEach(function (d, i) {
              if (!dev && self._mapDevice(d, i).id === deviceId) dev = d;
            });
          }
          if (!dev) {
            // 已授权列表无匹配（极少见竞态）→ 弹系统授权框（仍在用户手势内）
            return navigator.usb.requestDevice({ filters: [] }).then(function (d) {
              self.device = d;
              return self._open(d);
            }, function (err) {
              if (err && err.name === 'NotFoundError') throw new Error('[findDevice] 未选择设备');
              throw err;
            });
          }
          return self._open(dev);
        }).then(function (transport) {
          resolve(transport);
        }, function (err) {
          reject(new Error('[' + stage + '] ' + (err && err.message || err)));
        });
      } catch (e) {
        reject(new Error('[' + stage + '] ' + (e && e.message || e)));
      }
    });
  };

  /** 打开设备：open → selectConfiguration → claimInterface(PTP) → 找 bulk 端点 → transport */
  UsbTetherWebUsb.prototype._open = function (dev) {
    var stage = 'open';
    return dev.open().then(function () {
      stage = 'config';
      if (!dev.configuration) {
        if (!dev.configurations || !dev.configurations.length) throw new Error('设备无配置');
        return dev.selectConfiguration(dev.configurations[0].configurationValue);
      }
      return null;
    }).then(function () {
      stage = 'findIface';
      var config = dev.configuration;
      if (!config || !config.interfaces || !config.interfaces.length) throw new Error('无接口');
      // 找 PTP 接口：优先 class=6（Still Image）；否则首个含 bulk 双端点的接口
      var target = null;
      config.interfaces.forEach(function (itf) {
        if (target) return;
        if (itf.alternates && itf.alternates.length) {
          var alt = itf.alternates[0];
          if (itf.interfaceClass === 6) { target = { itf: itf, alt: alt }; return; }
          var hasIn = false, hasOut = false;
          (alt.endpoints || []).forEach(function (ep) {
            if (ep.type === 'bulk' && ep.direction === 'in') hasIn = true;
            if (ep.type === 'bulk' && ep.direction === 'out') hasOut = true;
          });
          if (hasIn && hasOut) target = { itf: itf, alt: alt };
        }
      });
      if (!target) throw new Error('未找到 bulk 端点（非 PTP 设备）');
      stage = 'claim';
      return dev.claimInterface(target.itf.interfaceNumber).then(function () {
        return target;
      });
    }).then(function (target) {
      // 端点号（WebUSB 的 endpointNumber 不含方向位）
      var epIn = null, epOut = null, epInfo = [];
      (target.alt.endpoints || []).forEach(function (ep) {
        epInfo.push(ep.direction + '/' + ep.type + '/ep' + ep.endpointNumber +
          (typeof ep.packetSize === 'number' ? '(512)' : ''));
        if (ep.type === 'bulk' && ep.direction === 'in' && !epIn) epIn = ep;
        if (ep.type === 'bulk' && ep.direction === 'out' && !epOut) epOut = ep;
      });
      if (!epIn || !epOut) throw new Error('缺少 bulk 端点（IN=' + !!epIn + ' OUT=' + !!epOut + '）');
      stage = 'reset';
      // 恢复脏状态（tethr 同法，best effort）：PIMA 0x66 Device Reset
      // 中止相机侧未完成事务 + clearHalt 清端点 STALL——任一失败忽略
      var p = Promise.resolve();
      p = p.then(function () { return dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x66, value: 0, index: target.itf.interfaceNumber }).catch(function () {}); });
      p = p.then(function () { return dev.clearHalt('out', epOut.endpointNumber).catch(function () {}); });
      p = p.then(function () { return dev.clearHalt('in', epIn.endpointNumber).catch(function () {}); });
      return p.then(function () {
        return new WebUsbTransport({
          device: dev,
          ifaceNum: target.itf.interfaceNumber,
          bulkInEpNum: epIn.endpointNumber,
          bulkOutEpNum: epOut.endpointNumber,
          ifaceInfo: 'class=' + (target.itf.interfaceClass || '?') + ' [' + epInfo.join(' ') + ']'
        });
      });
    }).catch(function (err) {
      // 打开/连接失败 → 关闭设备释放资源
      try { if (dev && dev.opened) dev.close().catch(function () {}); } catch (e) {}
      throw new Error('[open:' + stage + '] ' + (err && err.message || err));
    });
  };

  /* ---------- 导出（仅 WebUSB 环境，不覆盖 plus 版） ---------- */
  var singleton = null;
  function getUsbTether() {
    if (!singleton) singleton = new UsbTetherWebUsb();
    return singleton;
  }

  if (isSupported()) {
    global.UsbTether = {
      isSupported: isSupported,
      get: getUsbTether,
      /** 页面分支标记：WebUSB 模式（检测按钮 = 弹系统授权框） */
      webusbMode: true,
      /** 诊断字段（兼容 plus 版签名） */
      probeByteArray: function () { return 'webusb'; },
      lastBufMode: function () { return 'webusb'; }
    };
  }

})(typeof window !== 'undefined' ? window : globalThis);
