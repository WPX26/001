/* ============================================================
 * camera-ptp.js — 佳能 EOS PTP 联机拍摄协议栈（纯 JS，传输层解耦）
 *
 * 协议依据：ISO 15740 (PTP) + Canon EOS 厂商扩展段（0x9100+）
 * 常量与流程对照 libgphoto2 master 源码逐行核实（2026-08-16）：
 *   camlibs/ptp2/{ptp.h, ptp.c, ptp-pack.c, library.c, config.c}
 * 自行重写实现，规避 GPL 传染（不复制任何参考实现源码）。
 *
 * ⚠️ 2026-08-16 全面修订（吸取 gphoto2/RemoteYourCam/JPhoto 成功经验）：
 *   ① 标准 opcode 曾整体错位 +1（OpenSession 发成了 0x1001=GetDeviceInfo）→ 已修正
 *   ② 响应码 0x2003/0x2019/0x201E 曾标错 → 已修正
 *   ③ 快门 0x910F 曾用「按下=0→120ms→释放=1」两段式 → 改 gphoto2 权威做法：
 *      无参数单发，响应 Param1 为拍摄结果码（0 成功/1 对焦失败/3 反光板/7 卡满/8 只读）
 *   ④ GetEvent(0x9116) 事件数据曾按「count+定长 20 字节」解析 → 改 gphoto2 格式：
 *      [size:u32][code:u32][变长负载] 链，size==8&&code==0 结束，0xC181 Handle@0x08
 *   ⑤ 读取改流式粘包（一次 bulk 读可能含半个/多个包，多余字节必须缓存）
 *   ⑥ OpenSession：容器头 transid=0、sessionId 从 1、0x201E 放行、0x2004 递增重试
 *   ⑦ DEVICE_BUSY(0x2019) 自动 200ms 重试（拍照后相机忙是常态）
 *   ⑧ 取图双路径：卡上=0x9104；SDRAM(StorageID==0)=0x9107 分块 ≤1MB + 0x9117
 *   ⑨ 超时对齐 gphoto2：常规事务 20s、取图 100s、等照片 90s、保活 0x911D 每 10s
 *
 * 用途：相机互联「有线连接」——手机 USB OTG 直连 5D2 联机拍摄
 *   openSession → getDeviceInfo → setRemoteMode → setEventMode
 *   → drainEosEvents（排空初始事件，防拍照 Busy）→ setCaptureDestination(卡)
 *   → releaseShutter（无参 0x910F）→ waitForObject（0x9116 轮询 0xC181）
 *   → getObject（0x9104 卡上 / 0x9107+0x9117 SDRAM）
 *
 * 与传输层解耦：transport 只需提供 bulkOut / bulkIn / release，
 *   Android 侧由 usb-transport.js（Native.js）实现；
 *   单元测试用 Node mock（script/test-ptp.js，流式模拟真实 USB）。
 * ============================================================ */

(function (global) {
  'use strict';

  /* ---------- PTP 包类型 ---------- */
  var PTP_TYPE_COMMAND = 1;
  var PTP_TYPE_DATA = 2;
  var PTP_TYPE_RESPONSE = 3;
  var PTP_TYPE_EVENT = 4;

  /* ---------- 标准操作码（ISO 15740，libgphoto2 ptp.h 核实） ---------- */
  var PTP_OC_OPEN_SESSION = 0x1002;           // 曾误标 0x1001（=GetDeviceInfo）
  var PTP_OC_CLOSE_SESSION = 0x1003;          // 曾误标 0x1002（=OpenSession）
  var PTP_OC_GET_DEVICE_INFO = 0x1001;        // 曾误标 0x1004（=GetStorageIDs）
  var PTP_OC_GET_STORAGE_IDS = 0x1004;        // 保活降级兜底（r44：非远程模式 0x911D 可能被拒时改用）
  var PTP_OC_GET_NUM_OBJECTS = 0x1006;        // r48 废弃：5D2 真机对 0x1006 一律回 0x201d（EOS 不支持，gphoto2 canon 驱动从不调用）
  var PTP_OC_GET_OBJECT_HANDLES = 0x1007;     // r45 轮询兜底：存储内对象句柄枚举（GetObjectHandles）
  var PTP_OC_GET_OBJECT_INFO = 0x1008;
  var PTP_OC_GET_OBJECT = 0x1009;             // 曾误标 0x100A（=GetThumb）
  var PTP_OC_DELETE_OBJECT = 0x100B;
  var PTP_OC_GET_DEVICE_PROP_VALUE = 0x1015;
  var PTP_OC_SET_DEVICE_PROP_VALUE = 0x1016;  // 注意：0x1013 是 PowerDown！

  /* ---------- Canon EOS 厂商扩展操作码（libgphoto2 ptp.h 核实） ---------- */
  var PTP_OC_EOS_GET_DEVICE_INFO_EX = 0x9108;
  var PTP_OC_EOS_GET_OBJECT = 0x9104;         // 卡上取图
  var PTP_OC_EOS_GET_PARTIAL_OBJECT = 0x9107; // SDRAM 分块取图
  var PTP_OC_EOS_TRANSFER_COMPLETE = 0x9117;  // SDRAM 读完告知相机
  var PTP_OC_EOS_REMOTE_RELEASE = 0x910F;     // 快门（旧式无参单发；5D2 实测结果码 3 失败）
  var PTP_OC_EOS_REMOTE_RELEASE_ON = 0x9128;  // 快门（现代主路径；gphoto2"用 5Dm2 验证过"）
  var PTP_OC_EOS_REMOTE_RELEASE_OFF = 0x9129; // 参数1：1=半按 2=全按 / 释放：3=全释放
  var PTP_OC_EOS_GET_REMOTE_MODE = 0x9113;
  var PTP_OC_EOS_SET_REMOTE_MODE = 0x9114;
  var PTP_OC_EOS_SET_EVENT_MODE = 0x9115;
  var PTP_OC_EOS_GET_EVENT = 0x9116;
  var PTP_OC_EOS_KEEP_DEVICE_ON = 0x911D;
  // EVF 实时取景（阶段 2 原生插件使用，协议栈先备好）
  var PTP_OC_EOS_INITIATE_VIEWFINDER = 0x9151;
  var PTP_OC_EOS_TERMINATE_VIEWFINDER = 0x9152;
  var PTP_OC_EOS_GET_VIEWFINDER_DATA = 0x9153;

  /* ---------- 相机属性（ptp.h 核实） ---------- */
  var PTP_DPC_EOS_CAPTURE_DESTINATION = 0xD11C; // 1=CF 卡，4=SDRAM 机身内存

  /* ---------- 响应码（ISO 15740，ptp.h 核实；0x2005/0x200A 曾标错） ---------- */
  var PTP_RC_OK = 0x2001;
  var PTP_RC_GENERAL_ERROR = 0x2002;
  var PTP_RC_SESSION_NOT_OPEN = 0x2003;          // 曾误标 0x2005（=OperationNotSupported）
  var PTP_RC_INVALID_TRANSACTION_ID = 0x2004;
  var PTP_RC_INCOMPLETE_TRANSFER = 0x2007;
  var PTP_RC_DEVICE_BUSY = 0x2019;               // 曾误标 0x200A（=DevicePropNotSupported）
  var PTP_RC_SESSION_ALREADY_OPEN = 0x201E;
  var PTP_RC_OPERATION_NOT_SUPPORTED = 0x2005;

  /* ---------- 事件码（Canon EOS 段，ptp.h 核实） ---------- */
  var PTP_EC_OBJECT_ADDED = 0x4002;          // 标准 PTP ObjectAdded——非远程模式 5D2 拍卡后发到【中断端点】
                                             // （其 "Events Supported" 声明的是标准事件集 0x4002/0x4003/0x4007/0x4009/0xC101，
                                             //   不是 0xC181；0xC181 只在远程模式经 GetEvent(0x9116) 走）
  var PTP_EC_EOS_OBJECT_ADDED_EX = 0xC181;   // 新照片（等这个），Handle@0x08
  var PTP_EC_EOS_OBJECT_ADDED_EX64 = 0xC1A7; // 新相机 64 位变体（5D2 不用，识别防御）
  var PTP_EC_EOS_REQUEST_GET_EVENT = 0xC101; // 相机请求主机来取事件（曾误标 AF_RESULT）
  var PTP_EC_EOS_PROP_VALUE_CHANGED = 0xC189;
  var PTP_EC_EOS_CAMERA_STATUS_CHANGED = 0xC18B; // 曾误标 0xC102（那是 Nikon 的）

  /* ---------- 0x910F 拍摄结果码（响应 Param1；gphoto2 5D2 实证） ---------- */
  var SHUTTER_OK = 0, SHUTTER_FOCUS_FAIL = 1, SHUTTER_MIRROR = 3,
      SHUTTER_MEDIA_FULL = 7, SHUTTER_MEDIA_RO = 8;

  /* ---------- 错误类型 ---------- */
  function PtpError(code, message) {
    var err = new Error(message || ('PTP 响应错误 code=0x' + (code || 0).toString(16)));
    err.name = 'PtpError';
    err.code = code; // 响应码；0xE000 系列为协议层错误；0xF100 系列为拍摄结果码
    err.isPtp = true;
    return err;
  }
  function PtpTimeoutError(message) {
    var err = new Error(message || 'PTP 传输超时');
    err.name = 'PtpTimeoutError';
    err.code = 0xE001;
    err.isPtp = true;
    return err;
  }

  /* ============================================================
   * PTP 包编解码（little-endian，12 字节标准头）
   * ============================================================ */
  function PacketBuilder() {
    this._bytes = [];
  }
  PacketBuilder.prototype.u8 = function (v) { this._bytes.push(v & 0xFF); return this; };
  PacketBuilder.prototype.u16 = function (v) { this._bytes.push(v & 0xFF, (v >>> 8) & 0xFF); return this; };
  PacketBuilder.prototype.u32 = function (v) {
    // >>> 0 防负数；Uint8Array 装不下就用 push 拆分
    v = v >>> 0;
    this._bytes.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
    return this;
  };
  PacketBuilder.prototype.data = function (u8) {
    for (var i = 0; i < u8.length; i++) this._bytes.push(u8[i] & 0xFF);
    return this;
  };
  PacketBuilder.prototype.str = function (s) {
    var b = String(s || '');
    this.u8(b.length + 1);           // PTP 字符串长度含结尾 null
    for (var i = 0; i < b.length; i++) this._bytes.push(b.charCodeAt(i) & 0xFF);
    this._bytes.push(0);
    return this;
  };
  PacketBuilder.prototype.arr16 = function (arr) {
    this.u32(arr.length);
    for (var i = 0; i < arr.length; i++) this.u16(arr[i]);
    return this;
  };
  PacketBuilder.prototype.build = function () { return new Uint8Array(this._bytes); };

  function PacketReader(u8) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = 0;
  }
  PacketReader.prototype.u8 = function () { var v = this.dv.getUint8(this.pos); this.pos += 1; return v; };
  PacketReader.prototype.u16 = function () { var v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; };
  PacketReader.prototype.u32 = function () { var v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; };
  PacketReader.prototype.str = function () {
    var len = this.u8();
    if (len === 0 || this.pos >= this.dv.byteLength) return '';
    var s = '';
    // 真机实测（2026-08-16 5D2 直连诊断）：Canon 的 PTP 字符串是 **UTF-16LE**
    // （"Canon" = 43 00 61 00 6E 00 6F 00 6E 00，len 为字节数含结尾 null）；
    // ASCII 相机（mock/Nikon 等）为 1 字节/字符。判据：第二字节 == 0 → UTF-16。
    var b1 = this.dv.getUint8(this.pos + 1);
    if (b1 === 0) {
      for (var i = 0; i + 1 < len && this.pos + i + 1 < this.dv.byteLength; i += 2) {
        var c = this.dv.getUint16(this.pos + i, true);
        if (c === 0) break; // UTF-16 结尾 null（2 字节）
        s += String.fromCharCode(c);
      }
      this.pos += len;
    } else {
      for (var j = 0; j < len && this.pos < this.dv.byteLength; j++) s += String.fromCharCode(this.u8());
      // PTP 字符串以 null 结尾（长度已含终止符）——剥掉尾部 \0
      while (s.length && s.charCodeAt(s.length - 1) === 0) s = s.slice(0, -1);
    }
    return s;
  };
  PacketReader.prototype.arr16 = function () {
    var count = this.u32();
    var arr = [];
    for (var i = 0; i < count; i++) arr.push(this.u16());
    return arr;
  };

  /**
   * 构造命令包：header + 参数
   * @param {number} code  操作码
   * @param {number} tid   事务 ID（OpenSession 必须为 0，见 gphoto2 ptp_open_session）
   * @param {number[]} params 最多 5 个
   */
  function buildCommand(code, tid, params) {
    var b = new PacketBuilder();
    var paramCount = Math.min(5, params ? params.length : 0);
    b.u32(12 + paramCount * 4);           // length（含 12 字节头）
    b.u16(PTP_TYPE_COMMAND);
    b.u16(code);
    b.u32(tid);
    for (var i = 0; i < paramCount; i++) b.u32(params[i]);
    return b.build();
  }

  function buildData(code, tid, payload) {
    var b = new PacketBuilder();
    b.u32(12 + (payload ? payload.length : 0));
    b.u16(PTP_TYPE_DATA);
    b.u16(code);
    b.u32(tid);
    if (payload) b.data(payload);
    return b.build();
  }

  /** 解析首 12 字节头；返回 {length, type, code, tid} */
  function parseHeader(u8) {
    var r = new PacketReader(u8.subarray(0, 12));
    return { length: r.u32(), type: r.u16(), code: r.u16(), tid: r.u32() };
  }

  /* ============================================================
   * PacketStream — 流式粘包读取器（2026-08-16 新增）
   *
   * 真实 USB bulk 流不保证「一次读 = 一个 PTP 包」：一次 bulkIn 可能
   * 返回半个包、一个包、或多个包（尤其 12 字节响应头后紧跟数据段时）。
   * 旧实现把「超出本包长度的字节」直接丢弃 → 真机必炸（mock 一次一包
   * 所以测不出）。本类把读到的所有字节缓存，按包长精确消费。
   *
   * 同时实现 gphoto2 的 ZLP 语义：读到 0 字节不是错误（可能是上次传输
   * 末尾设备遗留的零写），继续读；超时以 deadline 为准。
   * ============================================================ */
  function PacketStream(transport) {
    this.transport = transport;
    this._bytes = [];   // 字节队列（Append 时按块入队，避免逐字节 push）
    this._len = 0;
    this._chunks = [];
  }
  /** 追加一段读到的字节 */
  PacketStream.prototype._append = function (u8) {
    this._chunks.push(u8);
    this._len += u8.length;
  };
  /** 从队列消费 n 字节（返回 Uint8Array），不足返回 null */
  PacketStream.prototype._take = function (n) {
    if (this._len < n) return null;
    var out = new Uint8Array(n);
    var got = 0;
    while (got < n) {
      var c = this._chunks[0];
      var need = n - got;
      if (c.length <= need) {
        out.set(c, got);
        got += c.length;
        this._chunks.shift();
      } else {
        out.set(c.subarray(0, need), got);
        this._chunks[0] = c.subarray(need);
        got += need;
      }
    }
    this._len -= n;
    return out;
  };
  /**
   * 读一个完整 PTP 包（自动跨多次 bulkIn 拼接）。
   * @returns {Promise<{type:number, code:number, tid:number, data:Uint8Array}>}
   */
  PacketStream.prototype.readPacket = function (timeoutMs) {
    var self = this;
    var deadline = Date.now() + (timeoutMs || 20000);
    var h = null; // 已解析的包头——只消费一次，避免把 body 开头误当下一包的头
    // 循环：凑头（一次性）→ 凑满包体（可跨多次 bulkIn）
    function pump() {
      if (Date.now() > deadline) return Promise.reject(PtpTimeoutError('等待 PTP 包超时'));
      if (!h) {
        if (self._len >= 12) {
          h = parseHeader(self._take(12));
          if (h.length < 12 || h.length > 0x20000000) {
            return Promise.reject(PtpError(0xE003, '非法包长 ' + h.length));
          }
        }
      }
      if (h && self._len >= h.length - 12) {
        var body = self._take(h.length - 12);
        var pkt = { type: h.type, code: h.code, tid: h.tid, data: body };
        // 事件包（type=4，interrupt 端点容器）负载 = 12 字节头后的平铺参数——
        // Canon EOS 流程事件本体不走这条（走 0x9116 轮询），保留作防御/通用相机支持
        return Promise.resolve(pkt);
      }
      // 缓存不足：读一段（单次 ≤16KB，Android bulkTransfer 上限）
      // r26 根因修复（2026-08-18 实锤）：单次读预算 = 整个事务剩余时间（gphoto2 语义），
      // 旧实现把 3s 小预算当传输层超时——5D2 慢响应/瞬时故障时一次超时即毒化管道，必败。
      var remain = deadline - Date.now();
      if (remain <= 0) return Promise.reject(PtpTimeoutError('等待 PTP 包超时'));
      return self.transport.bulkIn(16384, remain).then(function (chunk) {
        if (chunk && chunk.length) self._append(chunk);
        // 空读（ZLP 遗留）不算错误，继续 pump；超时由 pump 顶部检查兜底
        return pump();
      });
    }
    return pump();
  };

  /* ============================================================
   * PtpCamera — 传输层之上的协议会话
   * transport 接口（由调用方实现）：
   *   bulkOut(data:Uint8Array, timeoutMs) -> Promise<void>
   *   bulkIn(maxLen:number, timeoutMs) -> Promise<Uint8Array>  // 可能短于 maxLen
   *   release() -> void
   * ============================================================ */
  function PtpCamera(transport, opts) {
    if (!transport || !transport.bulkOut || !transport.bulkIn) {
      throw new Error('PtpCamera: 需要 transport(bulkOut/bulkIn)');
    }
    this.transport = transport;
    this.opts = opts || {};
    this.stream = new PacketStream(transport);
    this.tid = 0;
    this.sessionOpen = false;
    this.deviceInfo = null;
    this._pendingEvents = [];        // 响应流中插入的事件包（防御性保留）
    this._lastKeepAlive = 0;
  }

  PtpCamera.prototype._nextTid = function () {
    this.tid = (this.tid + 1) >>> 0;
    return this.tid;
  };

  /** 解析 EOS 事件记录链（GetEvent 数据阶段负载；libgphoto2 ptp-pack.c 逐行对照） */
  function parseEosEvents(u8) {
    var evts = [];
    if (!u8 || u8.length < 8) return evts;
    var r = new PacketReader(u8);
    while (r.pos + 8 <= r.dv.byteLength) {
      var size = r.u32();
      var code = r.u32();
      if (size > r.dv.byteLength) break;        // size 超数据总长 → 非法，中止
      if (size < 8) break;                      // 记录最短 8 字节
      if (size === 8 && code === 0) break;      // 结束标记（gphoto2 同）
      if (r.pos + (size - 8) > r.dv.byteLength) break; // 记录越界 → 中止
      var body = u8.subarray(r.pos, r.pos + (size - 8));
      if (code === PTP_EC_EOS_OBJECT_ADDED_EX) {
        // 布局（ptp-pack.c PTP_cee_OA_*）：Handle@0x08(相对记录头) StorageID@0x0C
        // OFC@0x10(u16) Size@0x1C Parent@0x20 Filename@0x28(C 串)
        var br = new PacketReader(body);
        var handle = br.u32();            // @0x08
        var storageId = br.u32();         // @0x0C
        var ofc = br.u16();               // @0x10
        evts.push({
          code: code, handle: handle, storageId: storageId, ofc: ofc,
          size: size, raw: body
        });
      } else if (code === PTP_EC_EOS_OBJECT_ADDED_EX64) {
        var br64 = new PacketReader(body);
        var h64 = br64.u32();             // Handle@0x08
        var s64 = br64.u32();             // StorageID@0x0C
        evts.push({ code: code, handle: h64, storageId: s64, ofc: 0, size: size, raw: body });
      }
      // 其他事件（0xC18B 状态变化等）跳过继续
      r.pos += (size - 8);
    }
    return evts;
  }

  /** 解析标准 PTP 事件容器（type=4，来自【中断端点】）——非远程模式下 5D2 拍卡后把
   *  ObjectAdded(0x4002) 发到这里（其 "Events Supported" 声明即标准 PTP 事件集）。
   *  容器 = 12B 头(长度/type=4/code/tid) + 平铺 u32 参数；一次中断传输可能带多个容器。
   *  @returns {Array<{code:number, tid:number, params:number[]}>}
   */
  function parseInterruptEvents(u8) {
    var out = [];
    if (!u8 || u8.length < 12) return out;
    var r = new PacketReader(u8);
    while (r.pos + 12 <= r.dv.byteLength) {
      var len = r.u32();
      var type = r.u16();
      var code = r.u16();
      var tid = r.u32();
      if (type !== PTP_TYPE_EVENT) break;          // 非事件容器 → 整包无效，中止
      if (len < 12) break;                         // 容器头必须 ≥12
      var end = r.pos + (len - 12);                // 参数区结束
      if (end > r.dv.byteLength) break;            // 越界 → 中止（防御脏数据）
      var params = [];
      while (r.pos + 4 <= end) params.push(r.u32());
      out.push({ code: code, tid: tid, params: params });
      if (end <= r.pos) break;                     // 无进展 → 防死循环
    }
    return out;
  }

  /**
   * 执行一次事务（命令 → 可选 data → 响应），带 gphoto2 语义：
   *   - 响应 tid 与请求不符 → 视为旧回复跳过（最多 3 次）
   *   - DEVICE_BUSY(0x2019) → sleep 200ms 重发整个事务（最多 5 次）
   *   - 响应流中插入的事件包 → 入队继续等（Canon EOS 不走此路径，防御）
   *   - data 阶段收到 Response（相机报错）→ 直接返回该错误码
   * @param {number} code 操作码
   * @param {number[]} [params] 命令参数
   * @param {Uint8Array} [outData] 命令携带的 data 阶段负载
   * @returns {Promise<{data:Uint8Array, params:number[]}>}
   */
  /** r47：全栈事务串行化——单 bulk 管道绝不允许两个 transact 并发。
   *  PTP 规范：收到上一条响应前不得发下一条；并发 = 后到的命令被相机丢弃/错位 →
   *  真机 r46 实测 0x1004 GetStorageIDs 在 keepAlive(0x911D) 尚在飞行时被丢 → 20s 读超时 →
   *  管道毒化（后续写也 4s 超时）→ 会话 24s 内死。此前 keepAlive 是 fire-and-forget 不 await，
   *  与轮询/GetEvent 同管道并发——本文件 _pollEnsureBaseline 注释早已警告同类抢包。
   *  mutex 让 fire-and-forget 也只是排队，永不并发（与 gphoto2 严格串行一致）。 */
  PtpCamera.prototype._txRun = function (fn) {
    var self = this;
    var run = (self._txChain || Promise.resolve()).then(function () { return fn(); });
    self._txChain = run.then(function () {}, function () {}); // 吞错保链，错误仍由调用方处理
    return run;
  };
  PtpCamera.prototype.transact = function (code, params, outData, timeoutMs) {
    var self = this;
    var t0 = Date.now();
    return self._txRun(function () { return self._transactImpl(code, params, outData, timeoutMs); })
      .then(function (res) {
        var ms = Date.now() - t0;
        if (ms > 800) self._diag('⏱ 命令 0x' + (code || 0).toString(16) + ' 耗时 ' + ms + 'ms'); // r47 慢命令追踪
        return res;
      }, function (e) {
        var ms = Date.now() - t0;
        if (ms > 800) self._diag('⏱ 命令 0x' + (code || 0).toString(16) + ' 耗时 ' + ms + 'ms 后失败: ' + ((e && e.message) || e).toString().slice(0, 40));
        throw e;
      });
  };
  PtpCamera.prototype._transactImpl = function (code, params, outData, timeoutMs) {
    var self = this;
    var t = timeoutMs || 20000;
    var busytries = 0;
    function attempt() {
      var tid = (code === PTP_OC_OPEN_SESSION) ? 0 : self._nextTid();
      // 发命令
      return self.transport.bulkOut(buildCommand(code, tid, params), 4000)
        .then(function () {
          if (outData) return self.transport.bulkOut(buildData(code, tid, outData), 4000);
        })
        .then(function () {
          return self._waitResponse(code, tid, t);
        })
        .then(function (res) { return res; })
        .catch(function (e) {
          if (e && e.isPtp && e.code === PTP_RC_DEVICE_BUSY && busytries < 5) {
            busytries++;
            return new Promise(function (r) { setTimeout(r, 200); }).then(attempt);
          }
          throw e;
        });
    }
    return attempt();
  };

  /** 读响应包直到拿到与 tid 匹配的 Response；事件包入队；data 阶段后等 Response */
  PtpCamera.prototype._waitResponse = function (code, tid, timeoutMs) {
    var self = this;
    var stale = 0;
    function loop() {
      return self.stream.readPacket(timeoutMs).then(function (pkt) {
        if (pkt.type === PTP_TYPE_EVENT) {
          self._pendingEvents.push(pkt);
          return loop();
        }
        if (pkt.type === PTP_TYPE_DATA) {
          // data 阶段结束 → 等 response（若期间收到 Response 说明相机拒绝该操作）
          return self.stream.readPacket(timeoutMs).then(function (resp) {
            if (resp.type === PTP_TYPE_EVENT) { self._pendingEvents.push(resp); return loop(); }
            if (resp.type === PTP_TYPE_RESPONSE) {
              if (resp.tid !== tid && stale++ < 3) return loop(); // 旧回复跳过
              if (resp.code !== PTP_RC_OK) throw PtpError(resp.code);
              return { data: pkt.data, params: parseParams(resp.data) };
            }
            throw PtpError(0xE004, '期望响应包，收到 type=' + resp.type);
          });
        }
        if (pkt.type === PTP_TYPE_RESPONSE) {
          if (pkt.tid !== tid && stale++ < 3) return loop(); // 旧回复跳过（gphoto2 同）
          if (pkt.code !== PTP_RC_OK) throw PtpError(pkt.code);
          return { data: null, params: parseParams(pkt.data) };
        }
        throw PtpError(0xE005, '未知包类型 ' + pkt.type);
      });
    }
    return loop();
  };

  function parseParams(u8) {
    var params = [];
    if (!u8 || u8.length < 4) return params;
    var r = new PacketReader(u8);
    var n = Math.floor(r.dv.byteLength / 4);
    for (var i = 0; i < n; i++) params.push(r.u32());
    return params;
  }

  /** 读取队列中待处理的事件包（不阻塞） */
  PtpCamera.prototype.drainEvents = function () {
    var evts = this._pendingEvents;
    this._pendingEvents = [];
    return evts;
  };

  /** 排空相机事件队列：连续 GetEvent 直到空（gphoto2 prepare_capture 前必做，防拍照 Busy）。
   *  r50【锁机身快门根因修复】：非远程会话【必须】排空。真机证据链——r38/r43/r44
   *  （连接时 drainEosEvents + 等待循环 GetEvent 轮询）→ 机身快门可用；r47/r48/r49
   *  （r46 起非远程删光 GetEvent、r49 再跳过连接排空）→ 机身快门锁死。机制：SetEventMode(0x9115)
   *  开启事件模式后相机端排队事件，宿主从不 GetEvent 排空 → 相机报 Busy → 锁机身快门
   *  （gphoto2 canon 驱动 prepare_capture 前必先排空防 Busy，同此机制）。r46 删 GetEvent 的
   *  理由「高频 GetEvent 挂起拖死循环」是误诊——真凶是 keepAlive(0x911D) 与轮询并发抢包
   *  （r47 全局 mutex 已根治），GetEvent 本身不挂。r50：无论远程与否都排空；每轮 1.5s 短超时、
   *  非断开类错误视为空继续（最坏退化为 r49 行为，绝不会更差）。 */
  PtpCamera.prototype.drainEosEvents = function (maxRounds) {
    var self = this;
    var rounds = 0;
    function poll() {
      if (rounds++ > (maxRounds || 8)) return Promise.resolve();
      return self.transact(PTP_OC_EOS_GET_EVENT, [], null, 1500).then(function (res) {
        var evts = parseEosEvents(res.data);
        if (evts.length) { self._queueEosEvents(evts); return poll(); }
        return undefined; // 空 → 排空完成
      }, function (e) {
        // 非断开类错误：视为无事件可排，停止（不打断连接流程）
        var msg = (e && e.message || '').toString();
        if (/disconnected|NotFoundError|Access denied|拒绝访问|设备已断开|device was disconnected/i.test(msg)) throw e;
        return undefined;
      });
    }
    return poll();
  };

  /** 把 GetEvent 解析出的事件存入内部队列（waitForObject 消费） */
  PtpCamera.prototype._queueEosEvents = function (evts) {
    for (var i = 0; i < evts.length; i++) this._pendingEvents.push({ type: PTP_TYPE_EVENT, code: evts[i].code, eos: evts[i] });
  };

  /* ---------- 事件监听（双通道） ---------- */
  /**
   * 启动事件监听。两条通道并跑：
   *   ① 传输层中断端点（标准 PTP 事件 0x4002 ObjectAdded——非远程模式 5D2 的主通道，
   *      自研栈此前从不读中断端点 → 拍卡事件全丢，这是「按快门没反应」的主导根因）；
   *   ② GetEvent(0x9116) 轮询（EOS 事件 0xC181——远程模式通道，waitForObject 内照常进行）。
   * transport 无 startEventReader（Android 原生版）时自动降级为仅 ②。
   */
  PtpCamera.prototype.startEvents = function () {
    var self = this;
    if (self._evtStarted) return;
    self._evtStarted = true;
    var t = self.transport;
    if (t && typeof t.startEventReader === 'function') {
      t.startEventReader(function (u8) {
        try {
          var evts = parseInterruptEvents(u8);
          for (var i = 0; i < evts.length; i++) {
            self._lastInterruptAt = Date.now();
            self._pendingEvents.push({ type: PTP_TYPE_EVENT, code: evts[i].code, intr: evts[i] });
          }
        } catch (e) {}
      }, function (err) {
        // 设备断开/传输错误：只记录并停监听，页面负责重连提示
        self._evtStarted = false;
        if (self._onEventError) self._onEventError(err);
      });
    }
  };

  PtpCamera.prototype.stopEvents = function () {
    this._evtStarted = false;
    var t = this.transport;
    if (t && typeof t.stopEventReader === 'function') t.stopEventReader();
  };

  /** 注册中断端点监听器错误回调（设备断开等） */
  PtpCamera.prototype.onEventError = function (fn) {
    this._onEventError = fn;
  };

  /** r46：注册诊断回调（页面日志）——真机定位「轮询/保活/GetEvent」实际行为 */
  PtpCamera.prototype.onDiag = function (fn) {
    this._onDiag = fn;
  };
  PtpCamera.prototype._diag = function (msg) {
    if (this._onDiag) { try { this._onDiag(msg); } catch (e) {} }
  };

  /**
   * 标准 ObjectAdded(0x4002) 事件只有 handle（部分机身带 StorageID 参数）。
   * 缺 storage 时用 GetObjectInfo(0x1008) 补齐（并顺带拿到文件大小），
   * 拿不到时按 5D2 卡存储 0x00010001 兜底（卡路径 0x9104 整读）。
   * @returns {Promise<{objectId:number, storageId:number, size:number}>}
   */
  PtpCamera.prototype._resolveStdObject = function (handle, storageId) {
    var self = this;
    if (!handle) return Promise.reject(PtpError(0xE008, 'ObjectAdded 缺 objectId'));
    if (storageId) return Promise.resolve({ objectId: handle, storageId: storageId, size: 0 });
    return self.transact(PTP_OC_GET_OBJECT_INFO, [handle]).then(function (res) {
      // ObjectInfo 标准布局：StorageID@0 / ObjectFormat@4(u16) / Protection@6(u16) / CompressedSize@8(u32)
      var u8 = res.data;
      if (!u8 || u8.length < 12) return { objectId: handle, storageId: 0x00010001, size: 0 };
      var r = new PacketReader(u8);
      var sid = r.u32();
      r.u16(); r.u16();
      var size = r.u32();
      return { objectId: handle, storageId: sid, size: size };
    }).catch(function () {
      return { objectId: handle, storageId: 0x00010001, size: 0 };
    });
  };

  /* ---------- 会话 ---------- */
  /**
   * 打开 PTP 会话（gphoto2 camera_init 语义）：
   *   容器头 transid=0、sessionId 从 1 开始；
   *   0x201E 已打开 → 放行（其他程序占着会话也继续）；
   *   0x2004 InvalidTransactionID → sessionId 递增重试（最多 10 次）。
   */
  PtpCamera.prototype.openSession = function () {
    var self = this;
    self._pollState = null; // r45：新会话重抓轮询基线（卡被换/清空后计数才可靠）
    var sessionId = 1;
    var tries = 0;
    function tryOpen() {
      if (tries >= 10) throw PtpError(0xE008, 'OpenSession 重试 10 次失败（InvalidTransactionID），请拔插 USB 重试');
      tries++;
      return self.transact(PTP_OC_OPEN_SESSION, [sessionId]).then(function () {
        self.sessionOpen = true;
      }).catch(function (e) {
        if (e && e.isPtp && e.code === PTP_RC_SESSION_ALREADY_OPEN) {
          self.sessionOpen = true; // 会话已打开（可能上次断开不彻底），继续用
          return;
        }
        if (e && e.isPtp && e.code === PTP_RC_INVALID_TRANSACTION_ID) {
          sessionId++;
          return tryOpen();
        }
        throw e;
      });
    }
    return tryOpen();
  };

  PtpCamera.prototype.closeSession = function (timeoutMs, noWait) {
    var self = this;
    // r25：支持短超时（连接前清理/断开清理用 5s，避免相机卡死时拖满 20s）
    // r26：noWait=true 只发不读——清理命令的响应无关紧要，不等响应可避免「读超时毒化管道」，
    //      后续 openSession 才能在同一传输层上获得完整 20s 事务预算（根因修复）。
    if (noWait) {
      var tid1 = self._nextTid();
      return self.transport.bulkOut(buildCommand(PTP_OC_CLOSE_SESSION, tid1, []), timeoutMs || 3000)
        .then(function () { self.sessionOpen = false; })
        .catch(function () { self.sessionOpen = false; });
    }
    return self.transact(PTP_OC_CLOSE_SESSION, [], null, timeoutMs || 20000)
      .then(function () { self.sessionOpen = false; })
      .catch(function (e) { self.sessionOpen = false; throw e; });
  };

  /**
   * r25：Device Reset（0x0066，标准 PTP 操作码）——首次 openSession 失败后的会话清理兜底。
   * 注意：5D2 深度卡死时该命令也可能无响应（2026-08-18 真机实验证实），此时只能物理断电重启；
   * 复位后设备可能需重新枚举/claim，调用方应在重连后的传输层上使用。
   * 不加入顶部常量表（保持协议常量表不动）。
   */
  PtpCamera.prototype.deviceReset = function (timeoutMs, noWait) {
    var self = this;
    // r26：noWait=true 只发不读（复位响应无关紧要），避免等响应超时毒化管道后 openSession 秒败
    if (noWait) {
      var tid2 = self._nextTid();
      return self.transport.bulkOut(buildCommand(0x0066, tid2, []), timeoutMs || 3000)
        .catch(function () {});
    }
    return self.transact(0x0066, [], null, timeoutMs || 10000);
  };

  /* ---------- 设备信息 ---------- */
  PtpCamera.prototype.getDeviceInfo = function () {
    var self = this;
    return self.transact(PTP_OC_GET_DEVICE_INFO, []).then(function (res) {
      if (!res.data) throw PtpError(0xE006, 'GetDeviceInfo 无数据');
      var r = new PacketReader(res.data);
      var info = {
        standardVersion: r.u16(),
        vendorExtensionId: r.u32(),
        vendorExtensionVersion: r.u16(),
        vendorExtensionDesc: r.str(),
        functionalMode: r.u16(),
        operations: r.arr16(),
        events: r.arr16(),
        deviceProperties: r.arr16(),
        captureFormats: r.arr16(),
        imageFormats: r.arr16(),
        manufacturer: r.str(),
        model: r.str(),
        deviceVersion: r.str(),
        serialNumber: r.str()
      };
      self.deviceInfo = info;
      return info;
    });
  };

  /* ---------- Canon EOS 远程模式 ---------- */
  PtpCamera.prototype.setRemoteMode = function () {
    // 0x9114 参数 1 = 进入远程控制模式（5D2 用 1；EOS M 才用特殊值）
    this._remoteMode = true; // r49：模式状态由命令维护（drainEosEvents 据此跳过/执行）
    return this.transact(PTP_OC_EOS_SET_REMOTE_MODE, [1]);
  };

  PtpCamera.prototype.setEventMode = function () {
    // 0x9115 参数 1 = 打开事件通知——不开相机不排队 ObjectAdded，拍照还会 Busy
    return this.transact(PTP_OC_EOS_SET_EVENT_MODE, [1]);
  };

  PtpCamera.prototype.getRemoteMode = function () {
    return this.transact(PTP_OC_EOS_GET_REMOTE_MODE, []).then(function (res) {
      return res.params[0];
    });
  };

  /** 保活：0x911D 无参事务，每 10s 一次（gphoto2 camera_keep_device_on）。
   *  r44 加固：0x911D 是远程模式专用操作码——5D2 非远程模式下可能被拒（r43 静默吞掉
   *  =保活从未生效，6 分钟掉线很可能由此而来）。被拒一次后记住改走通用 0x1004
   *  GetStorageIDs 保持总线活动；断开类错误不吞，抛给上层掉线分支提示拔插。 */
  PtpCamera.prototype.keepAlive = function () {
    var self = this;
    if (self._keepAliveUseFallback) return self.transact(PTP_OC_GET_STORAGE_IDS, []);
    return self.transact(PTP_OC_EOS_KEEP_DEVICE_ON, []).catch(function (e) {
      if (/disconnected|NotFoundError|Access denied|拒绝访问|设备已断开|device was disconnected/i.test((e && e.message || '').toString())) throw e;
      self._keepAliveUseFallback = true;   // 非断开类失败 → 判定该机身不吃 0x911D，此后直接用 0x1004
      return self.transact(PTP_OC_GET_STORAGE_IDS, []);
    });
  };

  /**
   * 设置照片存放目标（gphoto2 默认 SDRAM=4，会走慢速分块取图；设 1=CF 卡走 0x9104）
   * 5D2 支持 0xD11C：1=CF 卡、4=SDRAM。设置失败忽略（相机可能不支持，走事件判断兜底）。
   */
  PtpCamera.prototype.setCaptureDestination = function (v) {
    var self = this;
    var b = new PacketBuilder();
    b.u16(v === 1 ? 1 : 4); // CaptureDestination 类型 UINT16
    return self.transact(PTP_OC_SET_DEVICE_PROP_VALUE, [PTP_DPC_EOS_CAPTURE_DESTINATION], b.build())
      .catch(function (e) { return undefined; }); // 失败不致命
  };

  /* ---------- 快门 ---------- */
  /** 0x910F 旧式路径的结果码 → 用户可见错误 */
  function shutterResultError(result) {
    var msg = '拍摄失败';
    if (result === SHUTTER_FOCUS_FAIL) msg = '对焦失败，未释放快门（检查对焦/半按状态）';
    else if (result === SHUTTER_MIRROR) msg = '反光板抬起失败（若 5D2 请用 0x9128 路径）';
    else if (result === SHUTTER_MEDIA_FULL) msg = '存储卡已满或无内存';
    else if (result === SHUTTER_MEDIA_RO) msg = '存储卡只读';
    else msg += '（结果码 ' + result + '）';
    return PtpError(0xF100 + result, msg);
  }

  /**
   * 按快门。
   *
   * **5D2 真机实测（2026-08-16 电脑直连诊断）**：
   *   0x910F 无参单发 → 结果码 **3（反光板抬起失败）**，无法出片；
   *   0x9128/0x9129（gphoto2 现代主路径，源码注释"用 5Dm2 验证过"）→ 全通并成功出片
   *   （半按 0x9128(1,0) 对焦 → 全按 0x9128(2,0) 触发，响应 Param1=0 成功 → 0x9129(3) 全释放）。
   * 策略：优先 0x9128 路径；若相机不支持（0x2005 OperationNotSupported）回退 0x910F。
   */
  PtpCamera.prototype.releaseShutter = function () {
    var self = this;
    return self.transact(PTP_OC_EOS_REMOTE_RELEASE_ON, [1, 0], null, 30000) // 半按（AF 启用）
      .then(function () {
        // 等对焦完成（gphoto2 注释：慢镜头最长可阻塞 8 秒；5D2 单反实测 1.5s 足够）
        return new Promise(function (resolve) { setTimeout(resolve, 1500); });
      })
      .then(function () {
        return self.transact(PTP_OC_EOS_REMOTE_RELEASE_ON, [2, 0], null, 30000); // 全按触发
      })
      .then(function (res) {
        var r = res.params[0];
        if (r) throw PtpError(0xF200 + r, '快门触发失败（结果码 ' + r + '）');
      })
      .then(function () {
        return self.transact(PTP_OC_EOS_REMOTE_RELEASE_OFF, [3], null, 30000); // 全释放
      })
      .catch(function (e) {
        if (e && e.isPtp && e.code === PTP_RC_OPERATION_NOT_SUPPORTED) {
          // 回退：0x910F 无参单发（老 EOS / 其他相机）
          return self.transact(PTP_OC_EOS_REMOTE_RELEASE, []).then(function (res) {
            var result = res.params[0];
            if (result) throw shutterResultError(result);
          });
        }
        throw e;
      });
  };

  /* ---------- 事件/照片 ---------- */
  /* r45：事件无关的照片检测兜底。r44 假设「5D2 非远程模式拍卡后 ObjectAdded 走中断端点」
   * 在真机两次验收未兑现（r44 验收= r43 同：照片进卡但收不到事件，且日志出现「中断事件监听
   * 停止」）。为不再依赖任何事件通道，这里加标准 PTP 轮询：维护每存储对象计数/句柄基线，
   * 等待期间若计数增长 → GetObjectHandles 枚举差异出新句柄 → 当新照片。全部 best-effort：
   * 非断开类失败静默跳过，事件通道仍为主（轮询只是兜底）。 */
  function _pollDisconnectRe(e) {
    var m = (e && e.message || '').toString();
    return /disconnected|NotFoundError|Access denied|拒绝访问|设备已断开|device was disconnected/i.test(m);
  }
  /** 初始化轮询基线（每会话一次，跨 waitForObject 保持）：发现存储 + 句柄集（GetObjectHandles）。
   *  r47：存储枚举探测（短超时 3s）——真机 r46 实锤 0x1004 在等待循环里 20s 读超时并毒化管道，
   *  每次轮询都卡 20s 会饿死事件循环（r45「6 分钟零检测+掉线」主因）。探测失败 → 立即关闭
   *  轮询兜底（仅靠事件通道），绝不反复试探；成功才启用。所有命令经全局 mutex 串行。
   *  r48：真机实锤——5D2 对 GetNumObjects(0x1006) 一律回 PTP 错误 0x201d（Invalid Parameter，
   *  EOS 不实现该命令；gphoto2 的 canon 驱动也从不调 0x1006，只用 GetObjectHandles(0x1007)）。
   *  轮询改为纯句柄枚举：基线 = 每存储的句柄集，检测 = 句柄集差集（与 gphoto2 同款语义）。 */
  PtpCamera.prototype._pollEnsureBaseline = function () {
    var self = this;
    if (self._pollState) return Promise.resolve(self._pollState);
    if (self._storageOk === false) return Promise.resolve(null);
    return self.transact(PTP_OC_GET_STORAGE_IDS, [], null, 3000).then(function (res) {
      var ids = parseParams(res.data);
      var storages = (ids && ids.length) ? ids : [0x00010001];
      self._storageOk = true;
      var st = { storages: storages, counts: {}, handles: {} };
      // 顺序遍历（mutex 已全局串行，双保险——单 bulk 管道绝不允许并发 transact 抢包）
      return storages.reduce(function (chain, s) {
        return chain.then(function () {
          return self.transact(PTP_OC_GET_OBJECT_HANDLES, [s, 0, 0], null, 2500).then(function (h) {
            st.handles[s] = parseParams(h.data) || [];
            st.counts[s] = st.handles[s].length;
            return true;
          }).catch(function (e) {
            if (_pollDisconnectRe(e)) throw e;
            st.handles[s] = [];
            st.counts[s] = 0;
            self._diag('轮询 GetObjectHandles(0x1007) 失败: ' + ((e && e.message) || e).toString().slice(0, 50) + '（句柄集记 0，继续等）');
            return true;
          });
        });
      }, Promise.resolve()).then(function () {
        self._pollState = st;
        self._diag('轮询基线: ' + storages.map(function (s) { return '0x' + s.toString(16) + '=' + (st.counts[s] || 0); }).join(' ') + ' 张');
        return st;
      });
    }, function (e) {
      if (_pollDisconnectRe(e)) throw e;
      self._storageOk = false;
      self._pollDisabledReason = ((e && e.message) || e).toString().slice(0, 60);
      self._diag('存储枚举 GetStorageIDs(0x1004) 失败: ' + self._pollDisabledReason + ' → 关闭轮询兜底，仅靠事件通道（中断端点/GetEvent）');
      return null;
    });
  };
  /** 轮询检测新照片（best-effort）：返回 {objectId, storageId, source} 或 null；断开类错误抛出。
   *  r48：真机 0x1006=0x201d → 纯 GetObjectHandles(0x1007) 句柄差集（gphoto2 canon 驱动同款语义） */
  PtpCamera.prototype._pollDetectNew = function () {
    var self = this;
    if (self._storageOk === false) return Promise.resolve(null); // r47：探测失败 → 轮询彻底关闭（防反复 20s 卡死）
    return self._pollEnsureBaseline().then(function (st) {
      if (!st) return null;
      // r46 诊断：心跳（每 15 轮≈30s 一行）证明轮询活着 + 实时张数
      self._pollDiagN = (self._pollDiagN || 0) + 1;
      if (self._pollDiagN % 15 === 1) {
        self._diag('轮询心跳: ' + st.storages.map(function (s) { return '0x' + s.toString(16) + '=' + (st.counts[s] || 0); }).join(' ') + ' 张');
      }
      // 顺序遍历（勿并发，理由见 _pollEnsureBaseline）
      return st.storages.reduce(function (chain, s) {
        return chain.then(function (found) {
          if (found) return found;
          return self.transact(PTP_OC_GET_OBJECT_HANDLES, [s, 0, 0], null, 2500).then(function (h) {
            var hs = parseParams(h.data) || [];
            var known = st.handles[s] || [];
            var fresh = hs.filter(function (x) { return known.indexOf(x) < 0; });
            var n = hs.length;
            var oldN = st.counts[s] || 0;
            st.counts[s] = n;
            if (!fresh.length) {
              if (n !== oldN) { st.handles[s] = hs; self._diag('轮询: 0x' + s.toString(16) + ' 张数 ' + oldN + '→' + n + ' 但无新句柄（更新基线继续等）'); }
              return null;
            }
            var handle = fresh[0];
            st.handles[s] = hs;
            self._diag('轮询命中: 0x' + s.toString(16) + ' 张数 ' + oldN + '→' + n + ' 新句柄 0x' + handle.toString(16));
            return { objectId: handle, storageId: s, source: '轮询(GetObjectHandles)' };
          }, function (e) {
            if (_pollDisconnectRe(e)) throw e;
            self._diag('轮询 GetObjectHandles(0x1007) 失败: ' + ((e && e.message) || e).toString().slice(0, 50));
            return null;
          });
        });
      }, Promise.resolve(null));
    }).catch(function (e) { if (_pollDisconnectRe(e)) throw e; return null; });
  };
  /**
   * 等待新照片事件（r51：事件通道优先，卡枚举轮询默认关闭——防锁机身快门）：
   *   ① GetEvent(0x9116) 排空 + 0xC181 ObjectAddedEx（远程模式事件源；非远程也排空防事件堆积 Busy）；
   *   ② 中断端点标准 PTP ObjectAdded(0x4002)——非远程模式 5D2 拍卡后的候选主通道
   *      （startEvents 已把中断包解析进 _pendingEvents，这里消费，含 .source 标注来源）；
   *   ③ 轮询兜底 GetObjectHandles(0x1007) 句柄差集【opt-in，默认关】：r51 真机证据链定案——
   *      每 2s 枚举存储卡让 5D2 一直「读卡忙」→ 机身快门锁死（r43/r44 零卡枚举快门可用、
   *      r45 加轮询后 r46-r50 全锁、r50 恢复 GetEvent 仍锁证明 GetEvent 不是变量）。
   *      仅在显式 {poll:true}（远程取图/页面一次性「已按快门」扫描）时启用。
   * 每轮按 10s 间隔保活；事件轮询间隔 250ms（gphoto2 是紧密排空，Android 上
   * 250ms 避免打满带宽，事件不丢——0x9116 数据是积攒式的）；兜底轮询间隔默认 2s。
   * @param {number} timeoutMs 总超时（默认 90s = gphoto2 EOS_CAPTURE_TIMEOUT）
   * @param {object} [opts] {poll:boolean=false 关闭兜底(默认), pollIntervalMs:number}
   * @returns {Promise<{objectId:number, storageId:number, size:number, source?:string}>}
   *          objectId=照片 Handle；storageId=0 表示 SDRAM（走 0x9107 分块取图）
   */
  PtpCamera.prototype.waitForObject = function (timeoutMs, opts) {
    var self = this;
    var deadline = Date.now() + (timeoutMs || 90000);
    var o = opts || {};
    var pollEnabled = (o.poll === true);       // r51：默认关闭卡枚举轮询——0x1007 每 2s 枚举=锁机身快门真根因
    var lastPoll = 0;
    var pollInterval = o.pollIntervalMs || 2000;
    // r51【锁机身快门·真正的根因（r50 复测后定案）】：GetObjectHandles(0x1007) 每 2s 枚举存储卡
    // → 5D2 一直处于「读卡忙」→ 机身快门锁死。真机证据链：
    //   r43/r44（等待循环 = GetEvent 250ms + 保活，零卡枚举）→ 快门可用、照片进卡；
    //   r45 加 0x1007 轮询后 r46-r50 全部锁死；r50 恢复 GetEvent 仍锁 → GetEvent 不是变量
    //   （r44 里 GetEvent 就在、快门正常），唯一与锁同步的命令就是 0x1007 卡枚举。
    //   gphoto2 等待事件时从不连续枚举卡；r38 wasm 补丁会话（非远程、不枚举）→ 快门可用。同机制。
    // GetEvent 保持每轮排空（r44 同款，防事件堆积报 Busy，绝不拖死：2s 短超时+非断开错误视为空）。
    // 检测新照片：中断端点 0x4002（自动）+ 页面「我已按过快门」一次性 _pollDetectNew()（瞬时枚举）。
    var remoteMode = !!o.remoteMode || !!self._remoteMode; // r51：仅用于注释/诊断；GetEvent 两种模式都轮询
    function schedule() { return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll); }
    function poll() {
      if (Date.now() > deadline) throw PtpTimeoutError('等待照片事件超时');
      // 先查队列里已有的事件（GetEvent 插入的 .eos + 中断端点插入的 .intr）
      var evts = self.drainEvents();
      for (var i = 0; i < evts.length; i++) {
        if (evts[i].eos && evts[i].eos.code === PTP_EC_EOS_OBJECT_ADDED_EX) {
          var oa = evts[i].eos;
          return { objectId: oa.handle, storageId: oa.storageId, size: oa.size, source: 'GetEvent(0xC181)' };
        }
        if (evts[i].intr && evts[i].intr.code === PTP_EC_OBJECT_ADDED) {
          var it = evts[i].intr;
          // 标准 ObjectAdded：Param1=ObjectHandle；Param2=StorageID（部分机身带）
          return self._resolveStdObject(it.params[0], it.params.length > 1 ? it.params[1] : 0)
            .then(function (obj) { obj.source = '中断端点(0x4002)'; return obj; });
        }
      }
      // 保活：每 10s 一次（gphoto2 camera_keep_device_on 同频）
      // r44：失败不再无声吞掉——非断开类失败记录后继续等（不打断等待），
      // 设备级断开让轮询抛错 → 页面掉线分支明示「拔插重连」。r46：结果上报诊断。
      if (self._lastKeepAliveErr) {
        var kErr = self._lastKeepAliveErr;
        self._lastKeepAliveErr = null;
        var kMsg = (kErr && kErr.message || '').toString();
        if (/disconnected|NotFoundError|Access denied|拒绝访问|设备已断开|device was disconnected/i.test(kMsg)) throw kErr;
      }
      var now = Date.now();
      if (self._storageOk !== false && now - self._lastKeepAlive > 10000) {
        self._lastKeepAlive = now;
        var kaMode = self._keepAliveUseFallback ? '0x1004降级' : '0x911D';
        if (self._keepAliveDiagMode !== kaMode) { self._keepAliveDiagMode = kaMode; self._diag('保活走 ' + kaMode); }
        self.keepAlive().then(function () {
          var m2 = self._keepAliveUseFallback ? '0x1004降级' : '0x911D';
          if (self._keepAliveDiagMode !== m2) { self._keepAliveDiagMode = m2; self._diag('保活走 ' + m2); }
        }).catch(function (e) {
          self._lastKeepAliveErr = e;
          self._diag('保活失败: ' + ((e && e.message) || e).toString().slice(0, 60));
        });
      }
      // 轮询兜底（r46：独立于 GetEvent 执行——GetEvent 不再能拖死它）
      function runPoll() {
        if (pollEnabled && self._storageOk !== false && Date.now() - lastPoll >= pollInterval) {
          lastPoll = Date.now();
          return self._pollDetectNew().then(function (hit) {
            if (hit) return self._resolveStdObject(hit.objectId, hit.storageId)
              .then(function (obj) { obj.source = hit.source; return obj; });
            return schedule();
          });
        }
        return schedule();
      }
      return self.transact(PTP_OC_EOS_GET_EVENT, [], null, 2000).then(function (res) {
        var found = null;
        var evs = parseEosEvents(res.data);
        for (var j = 0; j < evs.length; j++) {
          if (evs[j].code === PTP_EC_EOS_OBJECT_ADDED_EX) {
            found = { objectId: evs[j].handle, storageId: evs[j].storageId, size: evs[j].size, source: 'GetEvent(0xC181)' };
            break;
          }
        }
        if (found) return found;
        return runPoll();
      }, function (e) {
        // r46：GetEvent 挂起/超时/被拒——非断开类错误视为空，继续轮询兜底
        if (_pollDisconnectRe(e)) throw e;
        return runPoll();
      });
    }
    return poll();
  };

  /**
   * 下载照片（双路径，2026-08-16 按 gphoto2 5D2 流程实现）：
   *   卡上（storageId != 0）→ EOS GetObject(0x9104)，一次读回；
   *   SDRAM（storageId == 0）→ GetPartialObject(0x9107, handle, offset, 1MB) 分块
   *      + 读完发 TransferComplete(0x9117, handle)——SDRAM 照片读完即失，不读会滞留机身
   * @param {{objectId:number, storageId:number}} obj waitForObject 返回值
   * @param {function} [onChunk] 进度回调(chunk, received)
   * @returns {Promise<Uint8Array>} JPEG 完整字节
   */
  PtpCamera.prototype.getObject = function (obj, onChunk) {
    var self = this;
    var handle = (typeof obj === 'number') ? obj : obj.objectId;
    var storageId = (typeof obj === 'object' && obj) ? (obj.storageId || 0) : 0;
    if (storageId !== 0) {
      // 卡上：0x9104 整读（100s 超时，gphoto2 取图超时级别）
      return self._readFullObject(PTP_OC_EOS_GET_OBJECT, [handle], onChunk);
    }
    // SDRAM：0x9107 分块 ≤1MB（gphoto2 对 EOS 的建议分块）
    var CHUNK = 0x100000;
    var chunks = [];
    var received = 0;
    function readPart(offset) {
      return self._readFullObject(PTP_OC_EOS_GET_PARTIAL_OBJECT, [handle, offset, CHUNK], null)
        .then(function (bytes) {
          chunks.push(bytes);
          received += bytes.length;
          if (onChunk) onChunk(bytes, received);
          if (bytes.length === CHUNK) return readPart(offset + CHUNK); // 满块 → 继续
          return undefined; // 短块 → 读完
        });
    }
    return readPart(0).then(function () {
      // 告知相机传输完成（SDRAM 照片不读会滞留机身内存）
      return self.transact(PTP_OC_EOS_TRANSFER_COMPLETE, [handle]).catch(function () {})
        .then(function () {
          var total = 0;
          for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
          var out = new Uint8Array(total);
          var off = 0;
          for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], off); off += chunks[j].length; }
          return out;
        });
    });
  };

  /** 0x9104/0x9107 通用：发命令 → 等 data 包 → 等 OK 响应（100s 超时） */
  PtpCamera.prototype._readFullObject = function (code, params, onChunk) {
    var self = this;
    var tid = self._nextTid();
    return self.transport.bulkOut(buildCommand(code, tid, params), 4000)
      .then(function () {
        return self.stream.readPacket(100000);
      })
      .then(function (pkt) {
        if (pkt.type === PTP_TYPE_EVENT) {
          self._pendingEvents.push(pkt);
          return self.stream.readPacket(100000).then(function (p2) {
            if (p2.type !== PTP_TYPE_DATA) throw PtpError(0xE007, '期望数据包');
            return p2;
          });
        }
        if (pkt.type !== PTP_TYPE_DATA) throw PtpError(0xE007, '期望数据包');
        return pkt;
      })
      .then(function (pkt) {
        var payload = pkt.data;
        // 等响应确认（大文件下载期间相机可能插事件）
        var respPromise = self.stream.readPacket(100000).then(function (resp) {
          if (resp.type === PTP_TYPE_EVENT) { self._pendingEvents.push(resp); return null; }
          if (resp.type === PTP_TYPE_RESPONSE) {
            if (resp.tid !== tid) return null; // 旧回复，忽略（文件已完整拿到）
            if (resp.code !== PTP_RC_OK) throw PtpError(resp.code);
            return resp;
          }
          return null;
        });
        if (onChunk) onChunk(payload, payload.length);
        return respPromise.then(function () { return payload; });
      });
  };

  /* ---------- 静态工具 ---------- */
  PtpCamera.PTP_RC_OK = PTP_RC_OK;
  PtpCamera.PtpError = PtpError;
  PtpCamera.PtpTimeoutError = PtpTimeoutError;

  /* ---------- 导出 ---------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PtpCamera;
  }
  global.PtpCamera = PtpCamera;
  global.PtpError = PtpError;
  global.PtpTimeoutError = PtpTimeoutError;

})(typeof window !== 'undefined' ? window : globalThis);