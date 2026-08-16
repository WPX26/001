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
    this._t0 = Date.now();
    this.released = false;
    // 超时兜底：WebUSB 无原生 timeout 参数（请求挂到有数据或断开），
    // 超时由 JS 侧 setTimeout 实现；残留 pending 请求靠 release() 的
    // device.close() 取消（close 会 cancel 全部 in-flight transfer，
    // 其 Promise 以 DOMException 拒绝，届时 released 标记已置位、结果丢弃）
    this._pending = [];
    // 2026-08-16 r19：超时后残留 transferIn 仍在浏览器队列中（无法 cancel），
    // 其迟到的数据会被静默丢弃 → 相机响应丢失 → 后续读全部错位/连环超时。
    // 方案：超时 reject 时置 _stale=true；后续 bulkIn/bulkOut 检测到 _stale
    // 直接拒绝并提示重连（避免在脏管道上并发读）；release 或显式 reset()
    // 清除 _stale。真机连续 2 次超时即提示用户重连。
    this._stale = false;
    this._timeoutCount = 0;
    // 诊断日志（r19）：最近操作上下文，USB 诊断 JSON 输出，真机一锤定音
    this.diag = { lastOp: null, lastOutBytes: -1, lastOutStatus: null,
      lastInBytes: -1, lastInStatus: null, timeouts: 0, openStage: null };
    // r20：全链路操作日志（环形 40 条）——openSession 超时时，命令是否发出、
    // 写入字节、相机有无任何响应，一目了然
    this._ops = [];
  }

  /** 记录一次传输操作（环形日志，诊断输出） */
  WebUsbTransport.prototype._logOp = function (op, len, res, extra) {
    this._ops.push({ t: Date.now() - this._t0, op: op, len: len || null,
      res: res || null, extra: extra || null });
    if (this._ops.length > 40) this._ops.shift();
  };

  /** 标记管道已脏（超时后调用），后续传输立即拒绝提示重连 */
  WebUsbTransport.prototype._markStale = function (why) {
    this._stale = true;
    this._timeoutCount++;
    this.diag.timeouts = this._timeoutCount;
    this.diag.lastOp = 'stale:' + why;
    this._logOp(why, null, 'timeout', 'stale');
  };

  /** 清除脏标记（release 或重新连接成功后） */
  WebUsbTransport.prototype._clearStale = function () {
    this._stale = false;
    this._timeoutCount = 0;
  };

  /** 等待 Promise 并附带超时（超时 reject + 置 stale，残留请求由 close() 回收） */
  WebUsbTransport.prototype._withTimeout = function (p, timeoutMs, tag) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        var i = self._pending.indexOf(p);
        if (i >= 0) self._pending.splice(i, 1);
        // r19：超时 = 相机响应丢失（残留 transferIn 无法 cancel，迟到数据会
        // 静默丢弃导致错位）→ 标记管道脏，后续传输直接拒绝提示重连
        self._markStale(tag);
        reject(new Error(tag + ' 超时（' + (timeoutMs || 0) + 'ms）'));
      }, timeoutMs || 20000);
      self._pending.push(p);
      p.then(function (v) {
        clearTimeout(t);
        var i = self._pending.indexOf(p);
        if (i >= 0) self._pending.splice(i, 1);
        if (self.released) return; // close() 后的迟到结果丢弃
        if (self._stale) return;   // r19：超时后的迟到数据丢弃（响应已丢失）
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
    if (this._stale) return Promise.reject(new Error('USB 管道已超时变脏，请重连（点击设备重新连接）'));
    return this._withTimeout(dev.transferOut(this.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)')
      .then(function (res) {
        // r19：status=ok 不代表数据进端点——必须校验 bytesWritten（WebUSB
        // 已知坑：写 0 字节假成功，相机收不到命令 → 白等响应超时）
        if (res.status === 'ok') {
          self.diag.lastOutBytes = typeof res.bytesWritten === 'number' ? res.bytesWritten : u8.length;
          self.diag.lastOutStatus = 'ok';
          self._logOp('out', u8.length, 'ok:' + self.diag.lastOutBytes, 'ep' + self.bulkOutEpNum);
          if (res.bytesWritten === 0) {
            throw new Error('bulkTransfer(out) 写入 0 字节（相机未就绪/接口未激活）');
          }
          return;
        }
        self.diag.lastOutStatus = res.status;
        self._logOp('out', u8.length, res.status, 'ep' + self.bulkOutEpNum);
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('out', self.bulkOutEpNum), 3000, 'clearHalt(out)')
            .then(function () {
              return self._withTimeout(dev.transferOut(self.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') {
                if (res2.bytesWritten === 0) throw new Error('bulkTransfer(out) 重试写入 0 字节');
                self._logOp('out-retry', u8.length, 'ok:' + res2.bytesWritten, 'stall 后重试成功');
                return;
              }
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
    if (this._stale) return Promise.reject(new Error('USB 管道已超时变脏，请重连（点击设备重新连接）'));
    // WebUSB 无桥的数组限制（Android 版 16KB 上限是桥的限制），
    // 单次请求 ≤16KB 与协议栈 PacketStream 流式拼接配合（16KB 是
    // tethr 实测的分配/性能平衡点；Chrome 上限 32MB 远高于此）
    var size = Math.min(Math.max(maxLen || 512, 512), 16384);
    return this._withTimeout(dev.transferIn(this.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)')
      .then(function (res) {
        if (res.status === 'ok') {
          // ZLP（空读）：返回空 Uint8Array，协议栈 PacketStream 空读容忍（与 Android 版一致）
          self.diag.lastInStatus = 'ok';
          self.diag.lastInBytes = res.data ? res.data.byteLength : 0;
          self._logOp('in', size, 'ok:' + self.diag.lastInBytes, 'ep' + self.bulkInEpNum);
          return res.data ? new Uint8Array(res.data) : new Uint8Array(0);
        }
        self.diag.lastInStatus = res.status;
        self._logOp('in', size, res.status, 'ep' + self.bulkInEpNum);
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('in', self.bulkInEpNum), 3000, 'clearHalt(in)')
            .then(function () {
              return self._withTimeout(dev.transferIn(self.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') {
                self.diag.lastInStatus = 'ok-after-stall';
                self.diag.lastInBytes = res2.data ? res2.data.byteLength : 0;
                self._logOp('in-retry', size, 'ok:' + self.diag.lastInBytes, 'stall 后重试成功');
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
    this._clearStale();
    var dev = this.device;
    if (dev && dev.opened) {
      // close() 会 cancel 全部 in-flight transfer（其 Promise 拒绝后
      // 被 _withTimeout 的 released 分支丢弃），并释放接口
      try { dev.close().catch(function () {}); } catch (e) {}
    }
  };

  /** 诊断信息（r19：USB 诊断 JSON 输出——超时/假成功时一锤定音） */
  WebUsbTransport.prototype.diagInfo = function () {
    return {
      iface: this.ifaceInfo,
      epIn: this.bulkInEpNum,
      epOut: this.bulkOutEpNum,
      stale: this._stale,
      timeouts: this.diag.timeouts,
      lastOp: this.diag.lastOp,
      lastOutStatus: this.diag.lastOutStatus,
      lastOutBytes: this.diag.lastOutBytes,
      lastInStatus: this.diag.lastInStatus,
      lastInBytes: this.diag.lastInBytes,
      ops: this._ops // r20：全链路操作日志（命令发出/字节数/响应/超时）——超时根因一眼定位
    };
  };

  /* ============================================================
   * 顶层管理：枚举 / 授权（系统授权框）/ 连接
   * ============================================================ */
  function UsbTetherWebUsb() {
    this.device = null; // 最近连接/授权设备（诊断用）
    // r20：连接阶段日志（open/claim/端点查找等，transport 未建时的失败也能定位）
    this._logs = [];
    this._logT = 0;
    this.lastOpenErr = null;
  }

  UsbTetherWebUsb.prototype._log = function (stage, res, extra) {
    this._logs.push({ t: this._logT++, stage: stage, res: res || null, extra: extra || null });
    if (this._logs.length > 40) this._logs.shift();
  };

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
        // 优先从已授权列表匹配：serial 精确优先，无 serial 按 vid:pid 首个
        return navigator.usb.getDevices().then(function (list) {
          var dev = null;
          // r19：self.device 若已被 close（上次连接失败 release 过）则弃用，
          // 重新从列表匹配——否则 re-open 已关闭设备句柄可能失败
          if (self.device && !self.device.opened) self.device = null;
          if (self.device) dev = self.device; // promptAndList 刚授权过的优先
          if (!dev) {
            var m = /^webusb:([0-9a-f]+):([0-9a-f]+)(?::(.*))?$/i.exec(deviceId || '');
            var vid = m ? parseInt(m[1], 16) : -1;
            var pid = m ? parseInt(m[2], 16) : -1;
            var serial = m ? (m[3] || '') : '';
            list.forEach(function (d) {
              if (dev) return;
              if (d.vendorId !== vid || d.productId !== pid) return;
              if (serial && d.serialNumber === serial) dev = d;  // serial 精确匹配
              else if (!serial && !d.serialNumber && !dev) dev = d; // 无 serial → 首个同 vid:pid
            });
          }
          if (!dev) {
            // 已授权列表无匹配（极少见竞态）→ 弹系统授权框（仍在用户手势内）
            self._log('findDevice:list-empty', null, deviceId);
            return navigator.usb.requestDevice({ filters: [] }).then(function (d) {
              self.device = d;
              self._log('findDevice:requested', 'ok', '授权新设备');
              return self._open(d);
            }, function (err) {
              if (err && err.name === 'NotFoundError') throw new Error('[findDevice] 未选择设备');
              throw err;
            });
          }
          self._log('findDevice:matched', null, deviceId);
          return self._open(dev);
        }).then(function (transport) {
          self._transport = transport; // r20：注册当前 transport（诊断读 ops 日志）
          self._log('connect:done', 'ok', 'transport 就绪');
          resolve(transport);
        }, function (err) {
          self._log('connect:fail:' + stage, 'err', (err && err.message || err));
          reject(new Error('[' + stage + '] ' + (err && err.message || err)));
        });
      } catch (e) {
        reject(new Error('[' + stage + '] ' + (e && e.message || e)));
      }
    });
  };

  /** 打开设备：open → selectConfiguration → claimInterface(PTP) → 找 bulk 端点 → transport */
  UsbTetherWebUsb.prototype._open = function (dev, opts) {
    opts = opts || {};
    // r19：PIMA 0x66 Device Reset + clearHalt 兜底（tethr 的"页面重载后脏会话恢复"
    // 逻辑）**默认不做**——首次连接执行 0x66 可能让 5D2 真复位设备（重新枚举，
    // 接口失效 → bulk 全挂死 → openSession 超时）。仅显式 connectReset=true
    // （失败重试路径）时执行。
    var cleanReset = !!opts.cleanReset;
    var stage = 'open';
    this._log('open:start', null, 'vid=' + dev.vendorId.toString(16) + ' pid=' + dev.productId.toString(16));
    return dev.open().then(function () {
      stage = 'config';
      this._log('open:config', null, dev.configuration ? '已有配置' : '需 selectConfiguration');
      if (!dev.configuration) {
        if (!dev.configurations || !dev.configurations.length) throw new Error('设备无配置');
        return dev.selectConfiguration(dev.configurations[0].configurationValue);
      }
      return null;
    }.bind(this)).then(function () {
      stage = 'findIface';
      var config = dev.configuration;
      this._log('open:iface', null, 'configs=' + (dev.configurations || []).length + ' ifaces=' + ((config && config.interfaces) || []).length);
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
      this._log('open:target', null, 'class=' + (target.itf.interfaceClass || '?') + ' ifaceNum=' + target.itf.interfaceNumber);
      return dev.claimInterface(target.itf.interfaceNumber).then(function () {
        this._log('open:claim', 'ok', 'ifaceNum=' + target.itf.interfaceNumber);
        return target;
      }.bind(this));
    }.bind(this)).then(function (target) {
      // 端点号（WebUSB 的 endpointNumber 不含方向位）
      var epIn = null, epOut = null, epInfo = [];
      (target.alt.endpoints || []).forEach(function (ep) {
        epInfo.push(ep.direction + '/' + ep.type + '/ep' + ep.endpointNumber +
          (typeof ep.packetSize === 'number' ? '(512)' : ''));
        if (ep.type === 'bulk' && ep.direction === 'in' && !epIn) epIn = ep;
        if (ep.type === 'bulk' && ep.direction === 'out' && !epOut) epOut = ep;
      });
      if (!epIn || !epOut) throw new Error('缺少 bulk 端点（IN=' + !!epIn + ' OUT=' + !!epOut + '）');
      this._log('open:eps', null, epInfo.join(' '));
      stage = 'reset';
      // r19：0x66 仅 connectReset=true（失败重试）时执行——首次连接跳过，
      // 避免 5D2 真复位设备导致接口失效挂死（见 _open 注释）
      var p = Promise.resolve();
      if (cleanReset) {
        p = p.then(function () { return dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x66, value: 0, index: target.itf.interfaceNumber }).catch(function () {}); });
        p = p.then(function () { return dev.clearHalt('out', epOut.endpointNumber).catch(function () {}); });
        p = p.then(function () { return dev.clearHalt('in', epIn.endpointNumber).catch(function () {}); });
      }
      return p.then(function () {
        this._log('open:done', 'ok', 'transport 就绪');
        return new WebUsbTransport({
          device: dev,
          ifaceNum: target.itf.interfaceNumber,
          bulkInEpNum: epIn.endpointNumber,
          bulkOutEpNum: epOut.endpointNumber,
          ifaceInfo: 'class=' + (target.itf.interfaceClass || '?') + ' [' + epInfo.join(' ') + ']'
        });
      }.bind(this));
    }.bind(this)).catch(function (err) {
      // 打开/连接失败 → 关闭设备释放资源；记录失败日志（诊断 JSON 输出）
      this.lastOpenErr = { stage: stage, msg: (err && err.message || err) };
      this._log('open:fail:' + stage, 'err', (err && err.message || err));
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
      lastBufMode: function () { return 'webusb'; },
      /** r20：连接阶段全链路日志（open/claim/端点/失败——transport 未建时也定位） */
      diagLogs: function () {
        var t = singleton;
        if (!t) return [];
        var out = t._logs.slice();
        if (t._transport && t._transport.diagInfo) {
          var d = t._transport.diagInfo();
          if (d && d.ops) {
            out.push({ stage: 'transport-ops', res: 'ok', extra: JSON.stringify(d.ops) });
          }
        }
        return out;
      }
    };
  }

})(typeof window !== 'undefined' ? window : globalThis);
