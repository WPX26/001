/* ============================================================
 * browser-usb-transport.js — WebUSB 传输层（Chrome/Edge 桌面 + Android Chrome）
 *
 * 与 usb-transport.js（Native.js/plus 版）提供相同的 transport 接口
 * （bulkOut / bulkIn / release）与顶层 API（scan / requestConnect），
 * 供 camera-ptp.js 使用，页面代码零改动。
 *
 * 环境互斥：App web-view 有 plus → 本文件不生效；无 plus 且
 * navigator.usb 可用 → 接管全局 UsbTether（webusbMode=true）。
 * 加载顺序：必须在 usb-transport.js 之后引入。
 *
 * 2026-08-16 精简版（r24）：移除六轮补丁累积的冗余诊断（ops 日志/
 * diagLogs/多版本注释），保留经真机实证的必要逻辑：
 *   ① 非佳能设备拒绝（r21）     ② claim 前 releaseInterface 容错（r22）
 *   ③ 无序列号设备匹配（r23）   ④ bytesWritten 校验（r19）
 *   ⑤ 超时 stale 标记（r19）    ⑥ 0x66 默认不做（r19，避免 5D2 复位）
 * ============================================================ */
(function (global) {
  'use strict';

  var CANON_VID = 0x04A9; // Canon

  /** WebUSB 可用（App web-view 有 plus 时归 plus 版，不接管） */
  function isSupported() {
    if (typeof plus !== 'undefined' && plus.android) return false;
    return !!(global.navigator && navigator.usb &&
      typeof navigator.usb.requestDevice === 'function');
  }

  /* ---------- transport（实现 PtpCamera 的 bulkOut/bulkIn/release） ---------- */
  function WebUsbTransport(deps) {
    this.device = deps.device;
    this.bulkInEpNum = deps.bulkInEpNum;
    this.bulkOutEpNum = deps.bulkOutEpNum;
    this.ifaceInfo = deps.ifaceInfo;
    this.released = false;
    this._stale = false;          // 超时后管道脏标记：后续传输直接拒绝提示重连
    this._pending = [];           // in-flight 请求（超时 reject 后靠 close() 回收）
    this.diag = {                 // 最小诊断：失败时一眼定位
      lastOutBytes: -1, lastInBytes: -1, timeouts: 0, lastErr: null
    };
    this._t0 = Date.now();
  }

  /** 带超时的 Promise 包装；超时置 stale（残留请求迟到数据丢弃，靠 close 回收） */
  WebUsbTransport.prototype._withTimeout = function (p, ms, tag) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        self._stale = true;
        self.diag.timeouts++;
        self.diag.lastErr = tag + ' 超时';
        reject(new Error(tag + ' 超时（' + ms + 'ms）'));
      }, ms);
      self._pending.push(p);
      p.then(function (v) {
        clearTimeout(t);
        if (self.released || self._stale) return; // 迟到结果丢弃
        resolve(v);
      }, function (e) {
        clearTimeout(t);
        if (self.released && e && e.name === 'NotFoundError') return;
        reject(e);
      });
    });
  };

  WebUsbTransport.prototype.bulkOut = function (u8, timeoutMs) {
    var self = this, dev = this.device;
    if (this.released) return Promise.reject(new Error('USB 连接已释放'));
    if (this._stale) return Promise.reject(new Error('USB 管道已超时，请重新连接'));
    return this._withTimeout(dev.transferOut(this.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)')
      .then(function (res) {
        self.diag.lastOutBytes = typeof res.bytesWritten === 'number' ? res.bytesWritten : u8.length;
        if (res.status === 'ok') {
          // status=ok 不代表数据进端点——必须校验 bytesWritten（写 0 字节假成功）
          if (res.bytesWritten === 0) throw new Error('bulkTransfer(out) 写入 0 字节（相机未就绪）');
          return;
        }
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('out', self.bulkOutEpNum), 3000, 'clearHalt(out)')
            .then(function () {
              return self._withTimeout(dev.transferOut(self.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') {
                if (res2.bytesWritten === 0) throw new Error('bulkTransfer(out) 重试写入 0 字节');
                return;
              }
              throw new Error('bulkTransfer(out) stall 重试后 status=' + res2.status);
            });
        }
        throw new Error('bulkTransfer(out) status=' + res.status);
      });
  };

  WebUsbTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
    var self = this, dev = this.device;
    if (this.released) return Promise.reject(new Error('USB 连接已释放'));
    if (this._stale) return Promise.reject(new Error('USB 管道已超时，请重新连接'));
    var size = Math.min(Math.max(maxLen || 512, 512), 16384);
    return this._withTimeout(dev.transferIn(this.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)')
      .then(function (res) {
        if (res.status === 'ok') {
          self.diag.lastInBytes = res.data ? res.data.byteLength : 0;
          return res.data ? new Uint8Array(res.data) : new Uint8Array(0); // ZLP 空读容忍
        }
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('in', self.bulkInEpNum), 3000, 'clearHalt(in)')
            .then(function () {
              return self._withTimeout(dev.transferIn(self.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') {
                self.diag.lastInBytes = res2.data ? res2.data.byteLength : 0;
                return res2.data ? new Uint8Array(res2.data) : new Uint8Array(0);
              }
              throw new Error('bulkTransfer(in) stall 重试后 status=' + res2.status);
            });
        }
        throw new Error('bulkTransfer(in) status=' + res.status);
      });
  };

  WebUsbTransport.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    this._stale = false;
    if (this.device && this.device.opened) {
      try { this.device.close().catch(function () {}); } catch (e) {} // close 回收全部 pending
    }
  };

  /** 诊断信息（失败后保存快照，USB 诊断 JSON 输出） */
  WebUsbTransport.prototype.diagInfo = function () {
    return {
      iface: this.ifaceInfo,
      epIn: this.bulkInEpNum,
      epOut: this.bulkOutEpNum,
      stale: this._stale,
      timeouts: this.diag.timeouts,
      lastOutBytes: this.diag.lastOutBytes,
      lastInBytes: this.diag.lastInBytes,
      lastErr: this.diag.lastErr
    };
  };

  /* ---------- 顶层：枚举 / 授权 / 连接 ---------- */
  function UsbTetherWebUsb() {
    this.device = null;       // 最近授权/连接设备
    this.lastOpenErr = null;  // 最近一次连接失败（诊断）
  }

  UsbTetherWebUsb.prototype._mapDevice = function (d, idx) {
    var vid = d.vendorId || 0, pid = d.productId || 0;
    var serial = d.serialNumber || '';
    // 无序列号（5D2 实况）用固定 'ns' 标记，保证 requestConnect 能匹配
    var id = 'webusb:' + vid.toString(16) + ':' + pid.toString(16) + ':' + (serial || 'ns');
    return {
      id: id, vid: vid, pid: pid,
      name: d.productName || (serial || ('USB 设备 ' + (idx + 1))),
      serial: serial,
      isCanon: vid === CANON_VID
    };
  };

  /** 检测：已授权设备直接列；无 → 弹系统授权框（须用户手势内调用） */
  UsbTetherWebUsb.prototype.scan = function () {
    var self = this;
    return navigator.usb.getDevices().then(function (list) {
      if (list && list.length) return list.map(function (d, i) { return self._mapDevice(d, i); });
      return navigator.usb.requestDevice({ filters: [] }).then(function (d) {
        self.device = d;
        return [self._mapDevice(d, 0)];
      }, function (err) {
        if (err && err.name === 'NotFoundError') return []; // 用户取消
        throw err;
      });
    });
  };

  /**
   * 申请权限并连接
   * @param {String} deviceId scan 返回的 id（webusb:vid:pid:[serial|ns]）
   * @returns {Promise<WebUsbTransport>}
   */
  UsbTetherWebUsb.prototype.requestConnect = function (deviceId) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var stage = 'findDevice';
      try {
        navigator.usb.getDevices().then(function (list) {
          // 匹配设备：serial 精确；空/'ns'/'0' 按「无序列号」；非佳能 VID 拒绝
          var m = /^webusb:([0-9a-f]+):([0-9a-f]+)(?::(.*))?$/i.exec(deviceId || '');
          var vid = m ? parseInt(m[1], 16) : -1;
          var pid = m ? parseInt(m[2], 16) : -1;
          var serial = m ? (m[3] || '') : '';
          if (vid !== CANON_VID) throw new Error('该设备不是佳能 PTP 相机（VID=0x' + vid.toString(16) + '）');
          var dev = null;
          if (self.device && self.device.opened) dev = self.device;
          if (!dev) {
            var wantNoSerial = !serial || serial === 'ns' || serial === '0';
            list.forEach(function (d) {
              if (dev) return;
              if (d.vendorId !== vid || d.productId !== pid) return;
              if (wantNoSerial ? !d.serialNumber : d.serialNumber === serial) dev = d;
            });
          }
          if (!dev) throw new Error('设备已拔出，请重新插上');
          return self._open(dev);
        }).then(function (transport) {
          resolve(transport);
        }, function (err) {
          self.lastOpenErr = { stage: stage, msg: (err && err.message || err) };
          reject(new Error('[' + stage + '] ' + (err && err.message || err)));
        });
      } catch (e) {
        reject(new Error('[' + stage + '] ' + (e && e.message || e)));
      }
    });
  };

  /** 打开设备：open → selectConfiguration → releaseInterface 容错 → claim → transport */
  UsbTetherWebUsb.prototype._open = function (dev) {
    var stage = 'open';
    var self = this;
    return dev.open().then(function () {
      stage = 'config';
      if (!dev.configuration) {
        if (!dev.configurations || !dev.configurations.length) throw new Error('设备无配置');
        return dev.selectConfiguration(dev.configurations[0].configurationValue);
      }
      return null;
    }).then(function () {
      stage = 'iface';
      var config = dev.configuration;
      if (!config || !config.interfaces || !config.interfaces.length) throw new Error('无接口');
      // 找 PTP 接口：优先 class=6，否则首个含 bulk 双端点的接口
      var target = null;
      config.interfaces.forEach(function (itf) {
        if (target || !itf.alternates || !itf.alternates.length) return;
        var alt = itf.alternates[0];
        var hasIn = false, hasOut = false;
        (alt.endpoints || []).forEach(function (ep) {
          if (ep.type === 'bulk' && ep.direction === 'in') hasIn = true;
          if (ep.type === 'bulk' && ep.direction === 'out') hasOut = true;
        });
        if (itf.interfaceClass === 6 || (hasIn && hasOut)) target = { itf: itf, alt: alt };
      });
      if (!target) throw new Error('未找到 bulk 端点（非 PTP 设备）');
      stage = 'claim';
      // claim 前 releaseInterface 容错（消除上次会话/其他页面占用残留）；
      // 不做 reset（5D2 老固件复位会接口失效挂死）
      return dev.releaseInterface(target.itf.interfaceNumber).catch(function () {})
        .then(function () { return dev.claimInterface(target.itf.interfaceNumber); })
        .then(function () { return target; });
    }).then(function (target) {
      var epIn = null, epOut = null;
      (target.alt.endpoints || []).forEach(function (ep) {
        if (ep.type === 'bulk' && ep.direction === 'in' && !epIn) epIn = ep;
        if (ep.type === 'bulk' && ep.direction === 'out' && !epOut) epOut = ep;
      });
      if (!epIn || !epOut) throw new Error('缺少 bulk 端点（IN=' + !!epIn + ' OUT=' + !!epOut + '）');
      return new WebUsbTransport({
        device: dev,
        bulkInEpNum: epIn.endpointNumber,
        bulkOutEpNum: epOut.endpointNumber,
        ifaceInfo: 'class=' + (target.itf.interfaceClass || '?') + ' in=ep' + epIn.endpointNumber + ' out=ep' + epOut.endpointNumber
      });
    }).catch(function (err) {
      self.lastOpenErr = { stage: stage, msg: (err && err.message || err) };
      try { if (dev && dev.opened) dev.close().catch(function () {}); } catch (e) {}
      throw new Error('[open:' + stage + '] ' + (err && err.message || err));
    });
  };

  /* ---------- 导出 ---------- */
  var singleton = null;
  function getUsbTether() {
    if (!singleton) singleton = new UsbTetherWebUsb();
    return singleton;
  }

  if (isSupported()) {
    global.UsbTether = {
      isSupported: isSupported,
      get: getUsbTether,
      webusbMode: true,                     // 页面分支标记
      probeByteArray: function () { return 'webusb'; }, // 兼容诊断签名
      lastBufMode: function () { return 'webusb'; },
      lastError: function () {              // 最近一次连接失败（诊断 JSON）
        return singleton ? singleton.lastOpenErr : null;
      }
    };
  }

})(typeof window !== 'undefined' ? window : globalThis);
