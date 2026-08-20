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
 * 2026-08-18（r26）：读超时毒化管道是「页面 openSession 必败」根因之一——
 *   超时后 bulkOut 仍允许（清理/复位命令可发），读方向 stale 拦截保持不变（防迟到数据污染）；
 *   慢响应的根治在 camera-ptp.js（单次读预算=完整事务剩余），本层配合。
 * 2026-08-18（r28）：端点卫生 clearPipe()——5D2 端点 HALT 时 Chrome transfer 挂起而非 stall，
 *   页面在首个命令前主动 clearHalt（IN+OUT）解卡；由页面层调用，不进 open 流程。
 * 2026-08-18（r29）：逐项对齐 gphoto2 实测语义——① 移除 claim 前 releaseInterface（libusb 从不这样，
 *   可能毒化管道）② 单次读上限 1024（gphoto2 响应容器大小）；OpenSession 包字节级已核对一致。
 * ============================================================ */
(function (global) {
  'use strict';

  var CANON_VID = 0x04A9; // Canon

  /** r43：字节级诊断——把原始收发字节打成 hex。统一走 toU8 归一化，
   *  兼容 DataView（WebUSB res.data）/ ArrayBuffer / Uint8Array，读hex 不再恒空。 */
  function toHex(v) {
    var u8 = toU8(v);
    if (!u8 || !u8.length) return '';
    var s = '';
    for (var i = 0; i < u8.length; i++) {
      s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    }
    return s;
  }

  /** r43【根因修复】：WebUSB 的 res.data 是 DataView——`new Uint8Array(DataView)` 不报错但静默返回
   *  长度 0 的空数组，导致相机每次应答都被丢弃（openSession 必超时，自研栈在 Chrome 从没连成过）。
   *  必须按 buffer/byteOffset/byteLength 正确取视图；兼容 ArrayBuffer/Uint8Array/null。 */
  function toU8(v) {
    if (!v) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (typeof v.byteOffset === 'number' && v.buffer) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return new Uint8Array(0);
  }

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
    this.intrInEpNum = deps.intrInEpNum || null; // 中断IN端点号（标准 PTP 事件通道，r44）
    this.ifaceInfo = deps.ifaceInfo;
    this.released = false;
    this._stale = false;          // 超时后管道脏标记：后续传输直接拒绝提示重连
    this._pending = [];           // in-flight 请求（超时 reject 后靠 close() 回收）
    this._evtReaderActive = false; // 中断事件监听器（单条常驻 transferIn，绝不遗弃）
    this._evtReaderErr = null;
    this.diag = {                 // 最小诊断：失败时一眼定位
      lastOutBytes: -1, lastInBytes: -1, timeouts: 0, lastErr: null,
      lastOutHex: null, lastInHex: null, intrInBytes: 0
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
    // r26：超时后不再拒绝写（读超时只毒化读方向；CloseSession/0x66 等清理命令仍可发出）
    return this._withTimeout(dev.transferOut(this.bulkOutEpNum, u8), timeoutMs || 4000, 'bulkTransfer(out)')
      .then(function (res) {
        self.diag.lastOutBytes = typeof res.bytesWritten === 'number' ? res.bytesWritten : u8.length;
        self.diag.lastOutHex = toHex(u8);
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
                self.diag.lastOutHex = toHex(u8);
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
    var size = Math.min(Math.max(maxLen || 512, 512), 1024); // r29：单次读上限对齐 gphoto2 容器(1024)，规避大缓冲读挂起
    return this._withTimeout(dev.transferIn(this.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)')
      .then(function (res) {
        if (res.status === 'ok') {
          self.diag.lastInBytes = res.data ? res.data.byteLength : 0;
          self.diag.lastInHex = toHex(res.data);
          return toU8(res.data); // r43 根因修复：原先 new Uint8Array(DataView) 静默返回空数组
        }
        if (res.status === 'stall') {
          return self._withTimeout(dev.clearHalt('in', self.bulkInEpNum), 3000, 'clearHalt(in)')
            .then(function () {
              return self._withTimeout(dev.transferIn(self.bulkInEpNum, size), timeoutMs || 20000, 'bulkTransfer(in)重试');
            }).then(function (res2) {
              if (res2.status === 'ok') {
                self.diag.lastInBytes = res2.data ? res2.data.byteLength : 0;
                self.diag.lastInHex = toHex(res2.data);
                return toU8(res2.data); // r43 根因修复
              }
              throw new Error('bulkTransfer(in) stall 重试后 status=' + res2.status);
            });
        }
        throw new Error('bulkTransfer(in) status=' + res.status);
      });
  };

  /**
   * r28：端点卫生——连接后主动对 IN/OUT 端点 clearHalt。
   * 2026-08-18 真机实锤：5D2 端点处于 HALT 时 Chrome 的 transferOut/In 会【挂起】而非返回
   * stall（页面报「bulkTransfer(out) 超时 4s」、终端 -108 PIPE 同源），stall 处理永远触发不到；
   * clearHalt 在未 halt 时是空操作，halt 时直接解卡。由页面在第一个 PTP 命令前调用。
   * 注意：不进 _open/requestConnect（保持单测「首次连接不主动 clearHalt」语义不变）。
   */
  WebUsbTransport.prototype.clearPipe = function () {
    var self = this;
    if (this.released) return Promise.resolve();
    function halt(ep, dir) {
      // 竞速 3s 兜底：clearHalt 挂起时不毒化管道（不置 _stale）
      return Promise.race([
        self.device.clearHalt(dir, ep),
        new Promise(function (resolve) { setTimeout(resolve, 3000); })
      ]).catch(function () {});
    }
    return Promise.all([
      halt(this.bulkInEpNum, 'in'),
      halt(this.bulkOutEpNum, 'out')
    ]).then(function () {});
  };

  /**
   * r44：启动中断IN端点事件监听（标准 PTP 事件，如 0x4002 ObjectAdded）。
   * 关键约束：WebUSB 对同一端点的 transferIn 是【FIFO 排队】的——若超时后遗弃一个
   * 常驻 transferIn，它会在数据到达时「偷走」下一个事件包，让新读永远等不到。
   * 因此这里保持【单条常驻 transferIn、绝不在超时后遗弃】：事件到达 → 回调 → 立即续读；
   * 相机一直不发事件就一直挂着（仅 1 条 pending，release() 时由 device.close() 回收）。
   * @param {function(Uint8Array)} onEvent 收到事件容器（type=4）时回调
   * @param {function(Error)} [onError] 传输错误/设备断开（监听随即停止）
   */
  WebUsbTransport.prototype.startEventReader = function (onEvent, onError) {
    var self = this;
    if (self._evtReaderActive || self.released) return;
    if (!self.intrInEpNum) {
      if (onError) onError(new Error('该接口无中断IN端点（无标准事件通道，仅靠 GetEvent 轮询）'));
      return;
    }
    self._evtReaderActive = true;
    self._evtReaderErr = null;
    function loop() {
      if (!self._evtReaderActive || self.released) return;
      self.device.transferIn(self.intrInEpNum, 64).then(function (res) {
        if (!self._evtReaderActive || self.released) return;
        if (res && res.status === 'ok' && res.data && res.data.byteLength) {
          self.diag.intrInBytes += res.data.byteLength;
          try { onEvent(toU8(res.data)); } catch (e) {}
        }
        loop();
      }, function (err) {
        if (self.released) return;
        self._evtReaderActive = false;
        self._evtReaderErr = err;
        if (onError) onError(err);
      });
    }
    loop();
  };

  WebUsbTransport.prototype.stopEventReader = function () {
    this._evtReaderActive = false; // 挂起的 transferIn 由 release()/device.close() 回收
  };

  WebUsbTransport.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    this._stale = false;
    this._evtReaderActive = false;
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
      epIntr: this.intrInEpNum,
      evtReader: this._evtReaderActive,
      intrInBytes: this.diag.intrInBytes,
      stale: this._stale,
      timeouts: this.diag.timeouts,
      lastOutBytes: this.diag.lastOutBytes,
      lastInBytes: this.diag.lastInBytes,
      lastErr: this.diag.lastErr,
      lastOutHex: this.diag.lastOutHex,
      lastInHex: this.diag.lastInHex
    };
  };

  /* ---------- 顶层：枚举 / 授权 / 连接 ---------- */
  function UsbTetherWebUsb() {
    this.device = null;       // 最近授权/连接设备
    this.lastOpenErr = null;  // 最近一次连接失败（诊断）
    this.candidates = [];     // r40：最近一次 _open 收集的全部候选接口（换接口重试/诊断）
  }

  /* r40：收集设备全部候选接口（class6 优先，其次接口号）。
   * 5D2 常见双接口（iface0=PTP class6 + iface1=厂商 class0），选错接口会导致
   * openSession 无响应（命令发到不路由 PTP 的接口上）。 */
  function collectCandidates(config) {
    var list = [];
    (config.interfaces || []).forEach(function (itf) {
      var alt = (itf.alternates && itf.alternates.length) ? itf.alternates[0] : null;
      if (!alt) return;
      var epIn = null, epOut = null, epIntr = null;
      (alt.endpoints || []).forEach(function (ep) {
        if (ep.type === 'bulk' && ep.direction === 'in' && !epIn) epIn = ep;
        if (ep.type === 'bulk' && ep.direction === 'out' && !epOut) epOut = ep;
        // r44：PTP 接口的标准【中断IN端点】——5D2 非远程模式拍卡后把 ObjectAdded(0x4002)
        // 发到这里；自研栈此前从不读它（只轮询 GetEvent 等 0xC181）→ 事件全丢。
        if (ep.type === 'interrupt' && ep.direction === 'in' && !epIntr) epIntr = ep;
      });
      if (!epIn || !epOut) return;
      list.push({
        itfNum: itf.interfaceNumber,
        cls: itf.interfaceClass,
        sub: itf.interfaceSubclass,
        proto: itf.interfaceProtocol,
        epIn: epIn.endpointNumber,
        epOut: epOut.endpointNumber,
        epIntr: epIntr ? epIntr.endpointNumber : null, // 中断IN端点号（无则为 null）
        isPtp: itf.interfaceClass === 6
      });
    });
    list.sort(function (a, b) {
      if (a.isPtp !== b.isPtp) return a.isPtp ? -1 : 1;
      return a.itfNum - b.itfNum;
    });
    return list;
  }

  function candidatesInfo(list) {
    return (list || []).map(function (c) {
      return '接口' + c.itfNum + ':class' + (c.cls == null ? '?' : c.cls) + ' ep' + c.epIn + 'in/ep' + c.epOut + 'out' +
        (c.epIntr ? '/ep' + c.epIntr + 'intr' : '(无中断端点)');
    }).join(' · ') || '无候选接口';
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

  /** 检测：已授权设备里有佳能 → 直接列；否则 → 弹「仅佳能」系统授权框（须用户手势内调用）
   *  r33（2026-08-19 王总实测）：曾误授权内置摄像头（0x174f:0x246a）后，getDevices()
   *  非空 → 旧逻辑直接列出不再弹框；改为：列表里没有佳能（VID 0x04A9）就强制弹授权框，
   *  且过滤器只认佳能 VID——误授权设备永远匹配不上，弹窗必然出现，不会再把摄像头当相机。 */
  UsbTetherWebUsb.prototype.scan = function () {
    var self = this;
    return navigator.usb.getDevices().then(function (list) {
      var hasCanon = list && list.some(function (d) { return d.vendorId === CANON_VID; });
      if (hasCanon) return list.map(function (d, i) { return self._mapDevice(d, i); });
      return navigator.usb.requestDevice({ filters: [{ vendorId: CANON_VID }] }).then(function (d) {
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
  UsbTetherWebUsb.prototype.requestConnect = function (deviceId, opts) {
    var self = this;
    var ifacePref = (opts && typeof opts.iface === 'number') ? opts.iface : 0;
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
          return self._open(dev, ifacePref);
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
  UsbTetherWebUsb.prototype._open = function (dev, ifacePref) {
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
      // r40：收集全部候选接口（class6 优先），记录到 singleton 供页面「换接口重试」与诊断 dump
      self.candidates = collectCandidates(config);
      var list = self.candidates;
      var idx = (typeof ifacePref === 'number' && ifacePref >= 0 && ifacePref < list.length) ? ifacePref : 0;
      var tgt = list[idx];
      if (!tgt) throw new Error('未找到 bulk 端点（非 PTP 设备）');
      stage = 'claim';
      // r41：还原「release 容错 → claim」序列——r24 真机裸传输（open→selectConfig→release容错→claim→transfer）
      // 多次复现成功；r29 曾因「疑毒化管道」移除，但此后自研栈 openSession 从未在真机连成。
      // release 未 claim 的接口在 WebUSB 是安全拒绝（InvalidStateError），容错忽略即可。
      return dev.releaseInterface(tgt.itfNum).catch(function () {})
        .then(function () { return dev.claimInterface(tgt.itfNum); })
        .then(function () { return tgt; });
    }).then(function (target) {
      return new WebUsbTransport({
        device: dev,
        bulkInEpNum: target.epIn,
        bulkOutEpNum: target.epOut,
        intrInEpNum: target.epIntr,
        ifaceInfo: '接口' + target.itfNum + ' class=' + (target.cls == null ? '?' : target.cls) + ' in=ep' + target.epIn + ' out=ep' + target.epOut +
          (target.epIntr ? ' intr=ep' + target.epIntr : ' 无中断端点')
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
      },
      listCandidates: function () {         // r40：全部候选接口（页面换接口重试用）
        return singleton ? (singleton.candidates || []) : [];
      },
      describeCandidates: function () {     // r40：候选接口紧凑描述（诊断 dump）
        return candidatesInfo(singleton ? (singleton.candidates || []) : []);
      }
    };
  }

})(typeof window !== 'undefined' ? window : globalThis);