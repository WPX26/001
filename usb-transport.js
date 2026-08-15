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
        var n = self.connection.bulkTransfer(self.bulkOutEp, jsArr, u8.length, timeoutMs || 3000);
        if (n < 0) throw new Error('bulkTransfer(out) 失败 n=' + n);
        resolve();
      } catch (e) { reject(e); }
    });
  };

  /** 读数据（同步阻塞；返回实际字节；超时/无数据返回空） */
  AndroidTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.released) return reject(new Error('USB 连接已释放'));
      try {
        var size = maxLen || 4096;
        var jbuf = plus.android.newArray('byte', size);
        var n = self.connection.bulkTransfer(self.bulkInEp, jbuf, size, timeoutMs || 3000);
        if (n <= 0) return resolve(new Uint8Array(0)); // 超时/无数据
        var u8 = new Uint8Array(n);
        for (var i = 0; i < n; i++) u8[i] = jbuf[i] & 0xFF; // Java byte 有符号，转 0-255
        resolve(u8);
      } catch (e) { reject(e); }
    });
  };

  AndroidTransport.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    try {
      if (this.connection) {
        if (this.device && this.device.getInterface(0)) {
          try { this.connection.releaseInterface(this.device.getInterface(0)); } catch (e) {}
        }
        this.connection.close();
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
    var UsbManager = plus.android.importClass('android.hardware.usb.UsbManager');
    this.um = this.main.getSystemService('usb');
  };

  /**
   * 枚举已连接的 USB 设备
   * @returns {Array<{id:String, vid:number, pid:number, name:String, serial:String, isCanon:boolean}>}
   */
  UsbTetherAndroid.prototype.listDevices = function () {
    this._init();
    var out = [];
    var map = this.um.getDeviceList(); // HashMap<String, UsbDevice>
    var it = map.values().iterator();
    while (it.hasNext()) {
      var d = it.next();
      var vid = d.getVendorId(), pid = d.getProductId();
      var serial = null;
      try { serial = d.getSerialNumber(); } catch (e) {}
      out.push({
        id: d.getDeviceName(),           // 用 deviceName 作为设备 ID（唯一且稳定）
        vid: vid & 0xFFFFFFFF,
        pid: pid & 0xFFFFFFFF,
        name: d.getDeviceName(),
        serial: serial,
        isCanon: (vid & 0xFFFF) === CANON_VID
      });
    }
    return out;
  };

  /** 注册权限广播接收器（一次性） */
  UsbTetherAndroid.prototype._ensurePermReceiver = function () {
    if (this._permReceiver) return;
    var self = this;
    var Intent = plus.android.importClass('android.content.Intent');
    var IntentFilter = plus.android.importClass('android.content.IntentFilter');
    var UsbManager = plus.android.importClass('android.hardware.usb.UsbManager');
    this._permReceiver = plus.android.implements('android.content.BroadcastReceiver', {
      onReceive: function (context, intent) {
        try {
          var action = intent.getAction();
          if (action !== UsbManager.ACTION_USB_PERMISSION || !self.pendingPerm) return;
          var granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
          var device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
          var resolve = self.pendingPerm.resolve, reject = self.pendingPerm.reject;
          self.pendingPerm = null;
          if (granted && device) resolve(device);
          else reject(new Error('USB 权限被拒绝'));
        } catch (e) {
          if (self.pendingPerm) {
            var r = self.pendingPerm.reject;
            self.pendingPerm = null;
            r(e);
          }
        }
      }
    });
    var permIntent = new Intent(UsbManager.ACTION_USB_PERMISSION);
    permIntent.setPackage(this.main.getPackageName());
    var PendingIntent = plus.android.importClass('android.app.PendingIntent');
    var pi = PendingIntent.getBroadcast(this.main, 0, permIntent, 0);
    this.main.registerReceiver(this._permReceiver, new IntentFilter(UsbManager.ACTION_USB_PERMISSION));
  };

  /**
   * 申请权限并连接
   * @param {String} deviceId 设备 ID（listDevices 返回的 id）
   * @returns {Promise<AndroidTransport>}
   */
  UsbTetherAndroid.prototype.requestConnect = function (deviceId) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self._init();
      var UsbManager = plus.android.importClass('android.hardware.usb.UsbManager');
      // 按 deviceName 找回设备对象
      var map = self.um.getDeviceList();
      var device = null;
      var it = map.values().iterator();
      while (it.hasNext()) {
        var d = it.next();
        if (d.getDeviceName() === deviceId) { device = d; break; }
      }
      if (!device) return reject(new Error('设备已拔出，请重新插上'));
      // 已授权则直接连
      if (self.um.hasPermission(device)) {
        return resolve(self._open(device));
      }
      // 未授权：弹系统授权框
      self._ensurePermReceiver();
      self.pendingPerm = {
        resolve: function (dev) {
          try { resolve(self._open(dev)); }
          catch (e) { reject(e); }
        },
        reject: reject
      };
      var permIntent = new (plus.android.importClass('android.content.Intent'))(UsbManager.ACTION_USB_PERMISSION);
      permIntent.setPackage(self.main.getPackageName());
      var PendingIntent = plus.android.importClass('android.app.PendingIntent');
      var pi = PendingIntent.getBroadcast(self.main, 0, permIntent, 0);
      self.um.requestPermission(device, pi);
    });
  };

  /** 打开设备并锁定 bulk 端点 */
  UsbTetherAndroid.prototype._open = function (device) {
    var UsbConstants = plus.android.importClass('android.hardware.usb.UsbConstants');
    var connection = this.um.openDevice(device);
    if (!connection) throw new Error('打开 USB 设备失败（可能被其他应用占用）');
    var iface = device.getInterface(0);
    if (!iface) {
      connection.close();
      throw new Error('设备无接口（非 PTP 相机）');
    }
    if (!connection.claimInterface(iface, true)) {
      connection.close();
      throw new Error('claimInterface 失败（设备被占用）');
    }
    var bulkInEp = null, bulkOutEp = null;
    var n = iface.getEndpointCount();
    for (var i = 0; i < n; i++) {
      var ep = iface.getEndpoint(i);
      if (ep.getType() !== UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
      if (ep.getDirection() === UsbConstants.USB_DIR_IN) bulkInEp = ep;
      else if (ep.getDirection() === UsbConstants.USB_DIR_OUT) bulkOutEp = ep;
    }
    if (!bulkInEp || !bulkOutEp) {
      connection.close();
      throw new Error('未找到 bulk 端点（非 PTP 设备）');
    }
    return new AndroidTransport({
      usbManager: this.um, device: device, connection: connection,
      bulkInEp: bulkInEp, bulkOutEp: bulkOutEp
    });
  };

  /**
   * 监听设备插拔（可选，用于页面自动刷新设备列表）
   */
  UsbTetherAndroid.prototype.watchAttach = function (cb) {
    this._init();
    var self = this;
    var IntentFilter = plus.android.importClass('android.content.IntentFilter');
    var UsbManager = plus.android.importClass('android.hardware.usb.UsbManager');
    this._attachCallback = cb;
    if (!this._attachReceiver) {
      this._attachReceiver = plus.android.implements('android.content.BroadcastReceiver', {
        onReceive: function (context, intent) {
          try {
            var dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (dev && self._attachCallback) self._attachCallback(dev);
          } catch (e) {}
        }
      });
      this.main.registerReceiver(this._attachReceiver,
        new IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED));
    }
  };

  UsbTetherAndroid.prototype.watchDetach = function (cb) {
    this._init();
    var self = this;
    var IntentFilter = plus.android.importClass('android.content.IntentFilter');
    var UsbManager = plus.android.importClass('android.hardware.usb.UsbManager');
    this._detachCallback = cb;
    if (!this._detachReceiver) {
      this._detachReceiver = plus.android.implements('android.content.BroadcastReceiver', {
        onReceive: function (context, intent) {
          try {
            if (self._detachCallback) self._detachCallback();
          } catch (e) {}
        }
      });
      this.main.registerReceiver(this._detachReceiver,
        new IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED));
    }
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
