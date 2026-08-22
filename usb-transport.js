/* ============================================================
 * usb-transport.js — Android USB Host 传输层（Native.js，零原生编译）r72
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
    this.intrEp = deps.intrEp || null;   // r72：中断端点（ObjectAdded 事件通道）
    this.bulkInCap = 16384;              // r72：协议层 readPacket 单次读上限（Android 单次传输硬上限）
    this._jbuf = null;                   // r72：共享 Java byte[]（16384B，String.getBytes 路径创建）
    this._jbufErr = '';                  // r72：buffer 创建失败原因（诊断）
    // 2026-08-16 r13：单次 bulk 读大小自适应。真机实锤：大 JS 数组（16384）被桥
    // byte[] 转换返回 null（"参数不匹配"语义）、65536 返回 -1（Android 上限）；
    // 512 已实证可读（2c9316e）。从 512 起，成功×2、失败÷2（512~16384），
    // 兼顾小包零开销与大文件吞吐（PacketStream 本来就是流式拼接）。
    this._readSize = 512;
    this.bufMode = 'unknown'; // r16 诊断：实际用的读 buffer 形态（java/[B/js）
  }

  /**
   * 创建共享 Java byte[]（16384B，r72 方案）：
   * r16 的 newObject('byte[]'/'[B') 已实锤不支持（数组类名）；r71 的 importClass
   * 静态方法路径也实锤 SyntaxError（web-view 桥铁律：只有 newObject 与实例
   * invoke 安全）。r72 用 String(ISO-8859-1).getBytes 路径：
   *   newObject('java.lang.String', seed)  -- 构造器，桥安全
   *   invoke(jstr, 'getBytes', 'ISO-8859-1') -- 实例方法，桥安全，返回 Java byte[]
   * ISO-8859-1 逐字节无损映射（字节值=字符码），seed 全 \\x00 得到干净 buffer。
   * bulkTransfer(ep, buf, size, timeout) 的 size 参数独立于 buffer 长度
   * （只写前 size 字节），故单一大 buffer 即可服务全部自适应读尺寸。
   */
  AndroidTransport.prototype._ensureBuf = function () {
    if (this._jbuf) return this._jbuf;
    if (!(typeof plus !== 'undefined' && plus.android)) return null;
    try {
      var seed = new Array(16385).join('\x00'); // 16384 个 NUL 字符
      var jstr = plus.android.newObject('java.lang.String', seed);
      var jbuf = plus.android.invoke(jstr, 'getBytes', 'ISO-8859-1');
      if (jbuf) {
        this._jbuf = jbuf;
        this.bufMode = 'java-str-getBytes';
        if (getUsbTether) { try { getUsbTether()._lastBufMode = this.bufMode; } catch (e) {} }
        return jbuf;
      }
      this._jbufErr = 'getBytes 返回 null';
    } catch (e) {
      this._jbufErr = '' + (e && e.message || e);
    }
    return null; // 失败：走 JS 数组兜底（数据不回写的已知死路，仅环境探测用）
  };

  /**
   * 把读回的前 n 字节转 Uint8Array（r72）：
   * String(byte[], offset, length, charsetName) 构造器整块转换（1 次 newObject），
   * ISO-8859-1 逐字节无损；桥把 Java String 转 JS string（getDeviceName 等已实证）。
   * r16 时代此路径「社区验证过」但上游 byte[] 创建失败没走到；r72 上游已通。
   */
  AndroidTransport.prototype._toU8 = function (n) {
    var u8 = new Uint8Array(n);
    if (this._jbuf) {
      var s = plus.android.newObject('java.lang.String', this._jbuf, 0, n, 'ISO-8859-1');
      if (typeof s === 'string' && s.length >= n) {
        for (var i = 0; i < n; i++) u8[i] = s.charCodeAt(i) & 0xFF;
        return u8;
      }
      throw new Error('byte[]->String 桥转换失败（s.length=' + (s && s.length) + ' 需 ' + n + '）');
    }
    if (this._lastJsBuf) { for (var j = 0; j < n; j++) u8[j] = this._lastJsBuf[j] & 0xFF; }
    return u8;
  };

  /**
   * clear halt：CLEAR_FEATURE(ENDPOINT_HALT)（gphoto2 gp_port_usb_clear_halt 同法）。
   * 端点地址用真实端点（2026-08-16 修正：之前硬编码 0x81，换相机/固件会错）。
   */
  AndroidTransport.prototype._clearHalt = function (epAddr) {
    if (!epAddr) return;
    try {
      // requestType=0x02(OUT|standard|endpoint), request=0x01(CLEAR_FEATURE),
      // value=0(ENDPOINT_HALT), index=端点地址
      plus.android.invoke(this.connection, 'controlTransfer', 0x02, 0x01, 0, epAddr, null, 0, 1000);
    } catch (e) {}
  };

  /** 写数据（同步阻塞；USB 2.0 bulk 写命令包毫秒级；失败 clear halt(OUT) 重试一次） */
  AndroidTransport.prototype.bulkOut = function (u8, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.released) return reject(new Error('USB 连接已释放'));
      try {
        var jsArr = new Array(u8.length);
        for (var i = 0; i < u8.length; i++) jsArr[i] = u8[i] & 0xFF;
        var outEp = self.bulkOutEp;
        var outAddr = 0;
        try { outAddr = plus.android.invoke(outEp, 'getAddress'); } catch (e) {}
        var n = plus.android.invoke(self.connection, 'bulkTransfer', outEp, jsArr, u8.length, timeoutMs || 4000);
        // n<=0 视为失败（n=0 假成功会让相机收不到命令，排查第 10 轮补）；
        // 写方向 STALL → clear halt(OUT) 重试一次（gphoto2 同）
        if (!(n > 0)) {
          if (n === -1) {
            self._clearHalt(outAddr & 0xFF);
            n = plus.android.invoke(self.connection, 'bulkTransfer', outEp, jsArr, u8.length, timeoutMs || 4000);
          }
          if (!(n > 0)) throw new Error('bulkTransfer(out) 失败 n=' + n + ' len=' + u8.length);
        }
        resolve();
      } catch (e) { reject(new Error('[bulkOut] ' + (e && e.message || e) +
        (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : ''))); }
    });
  };

  /** 读数据（同步阻塞；返回实际字节；单次读大小自适应，见 _readSize 说明） */
  AndroidTransport.prototype.bulkIn = function (maxLen, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.released) return reject(new Error('USB 连接已释放'));
      try {
        // 排查第 12 轮实锤：bulkTransfer(in) 返回 -1 的根因是**读 buffer 必须 ≥ 端点
        // maxPacketSize**（5D2 USB2.0 高速 bulk 端点 = 512 字节）；bulkOut 写方向无此限制。
        // r13 实锤修正：**桥对超过可用上限的 JS 数组转换会返回 null**（真机 n=null，
        // "参数不匹配"语义）；65536 直接 -1（Android 单次传输上限 16384）。
        // 解决：从 512 起自适应（成功×2 失败÷2），PacketStream 负责跨次拼接。
        var size = Math.min(Math.max(maxLen || 512, 512), self._readSize);
        var timeout = timeoutMs || 20000;
        var inEp = self.bulkInEp;
        var inAddr = 0;
        try { inAddr = plus.android.invoke(inEp, 'getAddress'); } catch (e) {}
        var n = self._readOnce(inEp, size, timeout);
        // n=null（桥转换失败/参数不匹配）→ 减半重试一次（真机 16384→null 的修复路径）
        if (n === null) {
          if (self._readSize > 512) self._readSize = Math.max(512, self._readSize >> 1);
          n = self._readOnce(inEp, size, timeout);
        }
        // n=-1（STALL）→ clear halt(IN) 重试一次（gphoto2 标准做法，端点 STALL 时必用）
        if (!(n > 0) && n === -1) {
          self._clearHalt(inAddr & 0xFF);
          n = self._readOnce(inEp, size, timeout);
          if (n > 0) { self._growReadSize(); return resolve(self._readBytes(n)); }
        }
        // n=0：ZLP（上次传输末尾设备遗留的零写，gphoto2 读到 0 字节再读一次）
        if (n === 0) {
          n = self._readOnce(inEp, size, timeout);
          if (n > 0) { self._growReadSize(); return resolve(self._readBytes(n)); }
        }
        // 读空/错误时把 n 值 + 接口结构打出来（2026-08-16 全面扫描：-1 可能是指向
        // 端点方向/接口选错，带上 ifaceInfo 定位）
        if (!(n > 0)) {
          var why = self.ifaceInfo ? ' 接口: ' + self.ifaceInfo : '';
          if (n === null || typeof n === 'undefined') {
            // 512 也失败 = 桥对 byte[] 参数整体不支持（对照组 useJavaByteArray 可试）
            throw new Error('bulkTransfer(in) 桥转换失败（n=' + n + '，已减到 ' + self._readSize + 'B）' + why);
          }
          if (n === 0) throw new Error('bulkTransfer(in) 连续两次返回 0（相机无响应）' + why);
          throw new Error('bulkTransfer(in) 返回 n=' + n + why);
        }
        self._growReadSize();
        resolve(self._readBytes(n));
      } catch (e) { reject(new Error('[bulkIn] ' + (e && e.message || e) +
        (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : ''))); }
    });
  };

  /** 单次 bulkTransfer(in)（r72：共享 Java byte[]，size 参数自适应；无 Java buffer 走 JS 兜底） */
  AndroidTransport.prototype._readOnce = function (ep, size, timeout) {
    var jbuf = this._ensureBuf();
    if (jbuf) {
      return plus.android.invoke(this.connection, 'bulkTransfer', ep, jbuf, size, timeout);
    }
    var js = new Array(size);
    for (var i = 0; i < size; i++) js[i] = 0;
    this._lastJsBuf = js;
    return plus.android.invoke(this.connection, 'bulkTransfer', ep, js, size, timeout);
  };

  /** 把最后一次读取的数据转 Uint8Array */
  AndroidTransport.prototype._readBytes = function (n) {
    return this._toU8(n);
  };

  /** 成功读到数据 → 尝试加大单次读（上限 16384 = Android 单次传输上限） */
  AndroidTransport.prototype._growReadSize = function () {
    if (this._readSize < 16384) this._readSize = Math.min(16384, this._readSize << 1);
  };

  /**
   * r72：清两端点 halt（PTP 打开会话前必须调用——r28 语义，容错不阻断）。
   * 这就是 r68-r71 真机报错 "transport.clearPipe is not a function" 缺失的方法。
   */
  AndroidTransport.prototype.clearPipe = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {
        var inAddr = 0, outAddr = 0;
        try { inAddr = plus.android.invoke(self.bulkInEp, 'getAddress') & 0xFF; } catch (e) {}
        try { outAddr = plus.android.invoke(self.bulkOutEp, 'getAddress') & 0xFF; } catch (e) {}
        if (inAddr) self._clearHalt(inAddr);
        if (outAddr) self._clearHalt(outAddr);
      } catch (e) {}
      resolve(); // clearHalt 失败不阻断连接（后续命令自然暴露问题）
    });
  };

  /**
   * r72：中断事件轮询（ObjectAdded 等 PTP 事件走中断 IN 端点）。
   * setInterval 200ms 读中断端点（bulkTransfer 超时 200ms 自然节流）；
   * JS 单线程保证与 bulkIn 不并发（bulkIn 阻塞时定时器排队）。
   */
  AndroidTransport.prototype.startEventReader = function (onEvent, onError) {
    var self = this;
    if (!self.intrEp) return; // 无中断端点：协议层自行降级 GetEvent 轮询
    self.stopEventReader();
    var mps = 64;
    try { mps = plus.android.invoke(self.intrEp, 'getMaxPacketSize') || 64; } catch (e) {}
    var readLen = Math.max(mps, 64);
    self._intrTimer = setInterval(function () {
      if (self.released) { self.stopEventReader(); return; }
      try {
        var jbuf = self._ensureBuf();
        if (!jbuf) return;
        var n = plus.android.invoke(self.connection, 'bulkTransfer', self.intrEp, jbuf, readLen, 200);
        if (n > 0) onEvent(self._toU8(n));
      } catch (e) { if (onError) { try { onError(e); } catch (e2) {} } }
    }, 200);
  };

  AndroidTransport.prototype.stopEventReader = function () {
    if (this._intrTimer) { clearInterval(this._intrTimer); this._intrTimer = null; }
  };

  /** r72：诊断信息（USB 诊断按钮消费） */
  AndroidTransport.prototype.diagInfo = function () {
    return {
      mode: 'nativejs-plus-r72',
      bufMode: this.bufMode,
      jbufErr: this._jbufErr || '',
      readSize: this._readSize,
      hasIntrEp: !!this.intrEp,
      ifaceInfo: this.ifaceInfo || ''
    };
  };

  AndroidTransport.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    this.stopEventReader();
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
    // setConfiguration（2026-08-16 r13 修正）：**UsbDevice.getConfiguration() 返回的
    // UsbConfiguration 对象在 web-view 桥里是 null**（真机诊断 cfg?）→ 之前 setConfiguration
    // 从未真正执行（typeof 检查挡掉）。改用 UsbDeviceConnection.getConfiguration()——
    // **返回 int**（0=未激活，非 0=当前配置 id），桥可直接转换。Android 不自动激活配置，
    // 必须显式 setConfiguration 否则 bulk 传输 -1。
    var cfgInfo = 'cfg?';
    try {
      var cfgCur = plus.android.invoke(connection, 'getConfiguration');
      if (typeof cfgCur === 'number') {
        cfgInfo = 'cfgId=' + cfgCur;
        if (cfgCur === 0) {
          var cfgCount = plus.android.invoke(device, 'getConfigurationCount');
          for (var ci = 0; ci < cfgCount; ci++) {
            var cfgI = plus.android.invoke(device, 'getConfiguration', ci);
            if (!cfgI) continue;
            var cfgIdI = plus.android.invoke(cfgI, 'getId');
            if (typeof cfgIdI === 'number' && cfgIdI > 0) {
              plus.android.invoke(connection, 'setConfiguration', cfgIdI);
              cfgInfo = 'cfgId=' + cfgIdI + '(set)';
              break; // 设第一个可用配置
            }
          }
        }
      }
    } catch (e) {}
    // r13 曾误删 ifaceCount 声明（真机 [open] ifaceCount is not defined 实锤，r14 修复）
    var ifaceCount = 0;
    try { ifaceCount = plus.android.invoke(device, 'getInterfaceCount'); } catch (e) {}
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
      bulkInEp: bulkInEp, bulkOutEp: bulkOutEp, intrEp: intrEp, ifaceInfo: ifaceInfo.join(' | ')
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

  /** r72：当场探测 byte[] 双向桥（String+getBytes 创建 / String 构造器读回） */
  function probeByteArray() {
    if (!isSupported()) return '无plus';
    var out = [];
    // 写方向：'AB' -> getBytes -> [65,66]
    try {
      var jstr = plus.android.newObject('java.lang.String', 'AB');
      var jbuf = plus.android.invoke(jstr, 'getBytes', 'ISO-8859-1');
      out.push('getBytes=' + (jbuf ? 'ok' : 'null'));
      if (jbuf) {
        // 读方向：byte[] -> String 构造器 -> 'AB'
        var back = plus.android.newObject('java.lang.String', jbuf, 0, 2, 'ISO-8859-1');
        out.push('readback=' + (back === 'AB' ? 'ok("AB")' : JSON.stringify(back).slice(0, 40)));
      }
    } catch (e) {
      out.push('throw:' + String(e && e.message || e).slice(0, 80));
    }
    return out.join(' | ');
  }

  global.UsbTether = {
    isSupported: isSupported,
    get: getUsbTether,
    probeByteArray: probeByteArray,
    /** r17：最近一次传输实际用的 buffer 形态（连接失败后也能读，单例级） */
    lastBufMode: function () { return singleton ? singleton._lastBufMode : '未连接'; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
