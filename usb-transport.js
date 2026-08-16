/* ============================================================
 * usb-transport.js — Android USB Host 传输层（Native.js，零原生编译）
 *
 * 在 uni-app App 的 web-view（5+ Webview）页面里直接调用
 * Android USB API：枚举设备 → 申请权限 → openDevice →
 * claimInterface → bulkTransfer，为 camera-ptp.js 提供
 * transport 接口（bulkOut / bulkIn / release）。
 *
 * 仅 App 环境可用（plus 存在）；桌面浏览器打开时 isSupported()=false，
 * 页面据此显示「USB 直连需在 App 内使用」。
 * 阶段 2 原生插件实现同一 transport 接口，页面代码零改动。
 * ============================================================ */
(function (global) {
  'use strict';

  var CANON_VID = 0x04A9; // Canon Inc.

  /** 环境检测：必须在 uni-app App 的 web-view 内（有 plus 对象） */
  function isSupported() {
    return typeof plus !== 'undefined' && plus.android;
  }

  /**
   * 单个 Android USB 传输通道（实现 PtpCamera 所需 transport 接口）
   * @param {Object} deps {usbManager, device, connection, bulkInEp, bulkOutEp}
   */
  function AndroidTransport(deps) {
    this.um = deps.usbManager;
    this.device = deps.device;
    this.connection = deps.connection;
    this.bulkInEp = deps.bulkInEp;
    this.bulkOutEp = deps.bulkOutEp;
    this.ifaceInfo = deps.ifaceInfo;   // 2026-08-16 排查补：接口结构（之前漏存，错误不带结构）
    this.released = false;
  }

  /** 写数据（同步阻塞；USB 2.0 bulk 写命令包毫秒级） */
  AndroidTransport.prototype.bulkOut = function (u8, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.released) return reject(new Error('USB 连接已释放'));
      try {
        var jsArr = new Array(u8.length);
        for (var i = 0; i < u8.length; i++) jsArr[i] = u8[i] & 0xFF;
        var n = plus.android.invoke(self.connection, 'bulkTransfer', self.bulkOutEp, jsArr, u8.length, timeoutMs || 3000);
        // n<=0 视为失败（n=0 假成功会让相机收不到命令，排查第 10 轮补）
        if (!(n > 0)) throw new Error('bulkTransfer(out) 失败 n=' + n + ' len=' + u8.length);
        resolve();
      } catch (e) { reject(new Error('[bulkOut] ' + (e && e.message || e) +
        (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : ''))); }
    });
  };

  /** 读数据（同步阻塞；返回实际字节；超时/无数据返回空） */
  AndroidTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.released) return reject(new Error('USB 连接已释放'));
      try {
        // 排查第 12 轮实锤：bulkTransfer(in) 返回 -1 的根因是**读 buffer 必须 ≥ 端点
        // maxPacketSize**（5D2 USB2.0 高速 bulk 端点 = 512 字节）；之前 expectAck 传
        // bulkIn(12) 只有 12 字节 buffer → Android 直接返回 -1。bulkOut 写方向无此限制。
        var size = Math.max(maxLen || 4096, 512);
        // web-view 桥没有 plus.android.newArray（2026-08-16 实锤 not a function），
        // bulkOut 已验证 JS 数组可直接作 byte[] 参数，bulkIn 同法（桥自动转换）
        var jbuf = new Array(size);
        for (var i = 0; i < size; i++) jbuf[i] = 0;
        var n = plus.android.invoke(self.connection, 'bulkTransfer', self.bulkInEp, jbuf, size, timeoutMs || 3000);
        // 读空/错误时把 n 值 + 接口结构打出来（2026-08-16 全面扫描：-1 可能是指向
        // 端点方向/接口选错，带上 ifaceInfo 定位）
        if (!(n > 0)) {
          var why = self.ifaceInfo ? ' 接口: ' + self.ifaceInfo : '';
          if (typeof n === 'undefined') throw new Error('bulkTransfer(in) invoke 失败返回 undefined（JS 数组读方向可能不被桥支持）' + why);
          if (n === 0) throw new Error('bulkTransfer(in) 返回 0（相机无响应或无数据，可能是 init 格式/端点问题）' + why);
          throw new Error('bulkTransfer(in) 返回 n=' + n + why);
        }
        var u8 = new Uint8Array(n);
        for (var i = 0; i < n; i++) u8[i] = jbuf[i] & 0xFF; // Java byte 有符号，转 0-255
        resolve(u8);
      } catch (e) { reject(new Error('[bulkIn] ' + (e && e.message || e) +
        (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : ''))); }
    });
  };

  AndroidTransport.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    try {
      if (this.connection) {
        if (this.device && plus.android.invoke(this.device, 'getInterface', 0)) {
          try { plus.android.invoke(this.connection, 'releaseInterface', plus.android.invoke(this.device, 'getInterface', 0)); } catch (e) {}
        }
        plus.android.invoke(this.connection, 'close');
      }
    } catch (e) {}
  };

  /* ============================================================
   * 顶层管理：枚举 / 权限 / 连接 / 插拔监听
   * ============================================================ */
  function UsbTetherAndroid() {
    this.main = null;
    this.um = null;
    this.pendingPerm = null;     // {resolve, reject, deviceId}
    this._permReceiver = null;
    this._attachReceiver = null;
    this._detachReceiver = null;
    this._attachCallback = null;
    this._detachCallback = null;
  }

  /** 懒初始化（拿到主 Activity 与 UsbManager） */
  UsbTetherAndroid.prototype._init = function () {
    if (!isSupported()) throw new Error('当前环境不支持 USB（需 App 内打开）');
    if (this.um) return;
    this.main = plus.android.runtimeMainActivity();
    this.um = plus.android.invoke(this.main, 'getSystemService', 'usb');
  };

  /** 遍历 UsbManager.getDeviceList() 的 HashMap——必须用 plus.android.invoke 显式调用（Native.js 不能链式调用 Java 集合方法，map.values().iterator() 会报 map.values is not a function） */
  UsbTetherAndroid.prototype._eachDevice = function (cb) {
    var map = plus.android.invoke(this.um, 'getDeviceList'); // HashMap<String, UsbDevice>
    var col = plus.android.invoke(map, 'values');            // Collection<UsbDevice>
    var it = plus.android.invoke(col, 'iterator');           // Iterator<UsbDevice>
    while (plus.android.invoke(it, 'hasNext')) {
      var d = plus.android.invoke(it, 'next');               // UsbDevice
      cb(d);
    }
  };

  /**
   * 枚举已连接的 USB 设备
   * @returns {Array<{id:String, vid:number, pid:number, name:String, serial:String, isCanon:boolean}>}
   */
  UsbTetherAndroid.prototype.listDevices = function () {
    this._init();
    var out = [];
    this._eachDevice(function (d) {
      var vid = plus.android.invoke(d, 'getVendorId');
      var pid = plus.android.invoke(d, 'getProductId');
      var serial = null;
      try { serial = plus.android.invoke(d, 'getSerialNumber'); } catch (e) {}
      var name = plus.android.invoke(d, 'getDeviceName');
      out.push({
        id: name,                        // 用 deviceName 作为设备 ID（唯一且稳定）
        vid: vid & 0xFFFFFFFF,
        pid: pid & 0xFFFFFFFF,
        name: name,
        serial: serial,
        isCanon: (vid & 0xFFFF) === CANON_VID
      });
    });
    return out;
  };

  /**
   * 申请权限并连接
   * 授权结果采用「轮询 hasPermission」——web-view 里 importClass/implements 会因
   * 类名解析报 Unexpected identifier 'android'（2026-08-16 真机实锤），广播接收器
   * 方案不可行；Android 授权是瞬时的，500ms 轮询足够及时
   * @param {String} deviceId 设备 ID（listDevices 返回的 id）
   * @returns {Promise<AndroidTransport>}
   */
  UsbTetherAndroid.prototype.requestConnect = function (deviceId) {
    var self = this;
    return new Promise(function (resolve, reject) {
      // 分步阶段标记（2026-08-16 真机排查：web-view 桥对类名/对象序列化会抛
      // SyntaxError，加 stage 让错误信息直接指出炸在哪一步）
      var stage = 'init';
      try {
        self._init();
        stage = 'findDevice';
        var device = null;
        self._eachDevice(function (d) {
          if (device) return;
          if (plus.android.invoke(d, 'getDeviceName') === deviceId) device = d;
        });
        if (!device) return reject(new Error('[findDevice] 设备已拔出，请重新插上'));
        stage = 'hasPermission';
        if (plus.android.invoke(self.um, 'hasPermission', device)) {
          return resolve(self._open(device));
        }
        // 未授权：弹系统授权框
        // web-view 桥铁律（2026-08-16 五连实锤）：importClass / 字符串类名 invoke /
        // Class 对象 invoke 静态方法 全部内部 eval 类名 → SyntaxError；
        // 只有「实例对象 invoke」与 newObject 安全。
        // PendingIntent 不能用静态方法 getBroadcast 创建（需类名）——
        // 改用 Activity.createPendingResult(requestCode, intent, flags)【实例方法】，
        // 返回 PendingIntent 同样可传给 requestPermission 弹系统授权框；
        // 授权结果仍由轮询 hasPermission 感知（本方案不需要广播接收器/回调）。
        stage = 'newObjectIntent';
        var ACTION_USB_PERMISSION = 'android.hardware.usb.action.USB_PERMISSION';
        var permIntent = plus.android.newObject('android.content.Intent', ACTION_USB_PERMISSION);
        stage = 'setPackage';
        plus.android.invoke(permIntent, 'setPackage', plus.android.invoke(self.main, 'getPackageName'));
        stage = 'pendingIntent';
        var pi = plus.android.invoke(self.main, 'createPendingResult', 0, permIntent, 0);
        if (!pi) throw new Error('createPendingResult 返回 null');
        stage = 'requestPermission';
        plus.android.invoke(self.um, 'requestPermission', device, pi);
        // 轮询授权结果（拒绝/超时都会 hasPermission=false）
        stage = 'poll';
        var start = Date.now();
        var timer = setInterval(function () {
          var granted = false;
          try { granted = plus.android.invoke(self.um, 'hasPermission', device); } catch (e) {}
          if (granted) {
            clearInterval(timer);
            try { resolve(self._open(device)); }
            catch (e) { reject(new Error('[open] ' + (e && e.message || e))); }
          } else if (Date.now() - start > 30000) {
            clearInterval(timer);
            reject(new Error('[poll] USB 授权超时，请确认弹窗并点允许'));
          }
        }, 500);
      } catch (e) {
        reject(new Error('[' + stage + '] ' + (e && e.message || e) +
          (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : '')));
      }
    });
  };

  /** 打开设备并锁定 bulk 端点（全面扫描版：遍历全部接口找 PTP，不写死 interface 0） */
  UsbTetherAndroid.prototype._open = function (device) {
    // UsbConstants 是 Android 公开 API 常量（官方文档定义，永不变化），直接硬编码，
    // 避免 web-view 里 importClass/getAttribute 类名解析问题（2026-08-16 真机实锤）
    var USB_ENDPOINT_XFER_BULK = 2;
    var USB_DIR_IN = 0x80;
    var USB_DIR_OUT = 0;
    var connection = plus.android.invoke(this.um, 'openDevice', device);
    if (!connection) throw new Error('打开 USB 设备失败（可能被其他应用占用）');
    // setConfiguration：Android 文档要求 claimInterface 前设置配置，否则 bulk 传输返回 -1
    try {
      var cfg = plus.android.invoke(device, 'getConfiguration');
      if (cfg) {
        var cfgId = plus.android.invoke(cfg, 'getId');
        plus.android.invoke(connection, 'setConfiguration', cfgId);
      }
    } catch (e) {}
    // 遍历全部接口（2026-08-16 全面扫描：5D2 PTP 接口不一定在 interface 0）
    var ifaceCount = 0;
    try { ifaceCount = plus.android.invoke(device, 'getInterfaceCount'); } catch (e) {}
    var cfgInfo = 'cfg?';
    try {
      var cfg0 = plus.android.invoke(device, 'getConfiguration');
      if (cfg0) cfgInfo = 'cfgId=' + plus.android.invoke(cfg0, 'getId');
    } catch (e) {}
    var bulkInEp = null, bulkOutEp = null, iface = null, ifaceInfo = [cfgInfo];
    for (var i = 0; i < ifaceCount; i++) {
      var cand = plus.android.invoke(device, 'getInterface', i);
      if (!cand) continue;
      var ifClass = -1;
      try { ifClass = plus.android.invoke(cand, 'getInterfaceClass'); } catch (e) {}
      var epCount = 0, epInfo = [];
      try { epCount = plus.android.invoke(cand, 'getEndpointCount'); } catch (e) {}
      epInfo.push('class=' + ifClass);
      for (var j = 0; j < epCount; j++) {
        var ep = plus.android.invoke(cand, 'getEndpoint', j);
        var eType = plus.android.invoke(ep, 'getType');
        var eDir = plus.android.invoke(ep, 'getDirection');
        var eAddr = -1;
        try { eAddr = plus.android.invoke(ep, 'getAddress'); } catch (e) {}
        // 方向判断用地址高位（0x80=IN）更稳，getDirection 在桥里可能返回异常值
        var dirByAddr = (eAddr >= 0 && (eAddr & 0x80)) ? 'IN' : ((eAddr >= 0) ? 'OUT' : '未知');
        epInfo.push('ep' + j + ':addr=0x' + (eAddr >= 0 ? (eAddr & 0xFF).toString(16) : '?') +
          ',type=' + eType + ',dir=' + eDir + '(' + dirByAddr + ')');
        if (eType !== USB_ENDPOINT_XFER_BULK) continue;
        var isIn = (eDir === USB_DIR_IN) || (eAddr >= 0 && (eAddr & 0x80) && !bulkInEp);
        var isOut = (eDir === USB_DIR_OUT) || (eAddr >= 0 && !(eAddr & 0x80) && !bulkOutEp);
        if (isIn && !bulkInEp) bulkInEp = ep;
        else if (isOut && !bulkOutEp) bulkOutEp = ep;
      }
      ifaceInfo.push('iface' + i + '[' + epInfo.join(' ') + ']');
      if (!iface && bulkInEp && bulkOutEp) iface = cand; // 首个含 bulk 双端点的接口
    }
    if (!iface || !bulkInEp || !bulkOutEp) {
      plus.android.invoke(connection, 'close');
      throw new Error('未找到 bulk 端点（非 PTP 设备） 结构: ' + (ifaceInfo.join(' | ') || '空'));
    }
    var claimed = false;
    try { claimed = plus.android.invoke(connection, 'claimInterface', iface, true); } catch (e) {}
    if (!claimed) {
      plus.android.invoke(connection, 'close');
      throw new Error('claimInterface 失败（设备被占用） 结构: ' + ifaceInfo.join(' | '));
    }
    return new AndroidTransport({
      usbManager: this.um, device: device, connection: connection,
      bulkInEp: bulkInEp, bulkOutEp: bulkOutEp, ifaceInfo: ifaceInfo.join(' | ')
    });
  };

  /**
   * 监听设备插拔（可选，用于页面自动刷新设备列表）
   */
  UsbTetherAndroid.prototype.watchAttach = function (cb) {
    this._init();
    var self = this;
    this._attachCallback = cb;
    // web-view 里 implements 会报 Unexpected identifier（2026-08-16 实锤）——
    // 插拔监听属增强功能，注册失败静默降级（不影响手动检测/连接主链路）
    try {
      if (!this._attachReceiver) {
        this._attachReceiver = plus.android.implements('android.content.BroadcastReceiver', {
          onReceive: function (context, intent) {
            try {
              var dev = plus.android.invoke(intent, 'getParcelableExtra', 'device');
              if (dev && self._attachCallback) self._attachCallback(dev);
            } catch (e) {}
          }
        });
        plus.android.invoke(this.main, 'registerReceiver', this._attachReceiver,
          plus.android.newObject('android.content.IntentFilter', 'android.hardware.usb.action.USB_DEVICE_ATTACHED'));
      }
    } catch (e) {}
  };

  UsbTetherAndroid.prototype.watchDetach = function (cb) {
    this._init();
    var self = this;
    this._detachCallback = cb;
    try {
      if (!this._detachReceiver) {
        this._detachReceiver = plus.android.implements('android.content.BroadcastReceiver', {
          onReceive: function (context, intent) {
            try {
              if (self._detachCallback) self._detachCallback();
            } catch (e) {}
          }
        });
        plus.android.invoke(this.main, 'registerReceiver', this._detachReceiver,
          plus.android.newObject('android.content.IntentFilter', 'android.hardware.usb.action.USB_DEVICE_DETACHED'));
      }
    } catch (e) {}
  };

  /* ---------- 导出 ---------- */
  var singleton = null;
  function getUsbTether() {
    if (!singleton) singleton = new UsbTetherAndroid();
    return singleton;
  }

  global.UsbTether = {
    isSupported: isSupported,
    get: getUsbTether
  };

})(typeof window !== 'undefined' ? window : globalThis);
