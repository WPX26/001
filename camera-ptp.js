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
  var PTP_OC_EOS_REMOTE_RELEASE = 0x910F;     // 快门：无参数单发，响应 Param1=结果码
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

  /* ---------- 事件码（Canon EOS 段，ptp.h 核实） ---------- */
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
    var s = '';
    for (var i = 0; i < len && this.pos < this.dv.byteLength; i++) s += String.fromCharCode(this.u8());
    // PTP 字符串以 null 结尾（长度已含终止符）——剥掉尾部 \0
    while (s.length && s.charCodeAt(s.length - 1) === 0) s = s.slice(0, -1);
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
      return self.transport.bulkIn(16384, Math.min(3000, deadline - Date.now())).then(function (chunk) {
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
  PtpCamera.prototype.transact = function (code, params, outData, timeoutMs) {
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

  /** 排空相机事件队列：连续 GetEvent 直到空（gphoto2 prepare_capture 前必做，防拍照 Busy） */
  PtpCamera.prototype.drainEosEvents = function (maxRounds) {
    var self = this;
    var rounds = 0;
    function poll() {
      if (rounds++ > (maxRounds || 8)) return Promise.resolve();
      return self.transact(PTP_OC_EOS_GET_EVENT, []).then(function (res) {
        var evts = parseEosEvents(res.data);
        if (evts.length) { self._queueEosEvents(evts); return poll(); }
        return undefined; // 空 → 排空完成
      });
    }
    return poll();
  };

  /** 把 GetEvent 解析出的事件存入内部队列（waitForObject 消费） */
  PtpCamera.prototype._queueEosEvents = function (evts) {
    for (var i = 0; i < evts.length; i++) this._pendingEvents.push({ type: PTP_TYPE_EVENT, code: evts[i].code, eos: evts[i] });
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

  PtpCamera.prototype.closeSession = function () {
    var self = this;
    return self.transact(PTP_OC_CLOSE_SESSION, [])
      .then(function () { self.sessionOpen = false; })
      .catch(function (e) { self.sessionOpen = false; throw e; });
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

  /** 保活：0x911D 无参事务，每 10s 一次（gphoto2 camera_keep_device_on） */
  PtpCamera.prototype.keepAlive = function () {
    return this.transact(PTP_OC_EOS_KEEP_DEVICE_ON, []);
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
  /**
   * 按快门（gphoto2 ptp_canon_eos_capture 语义，5D2 实证）：
   *   0x910F **无参数**单发（NODATA），相机内部完成按下+对焦+释放；
   *   响应 Param1 = 拍摄结果码：0=成功 / 1=对焦失败 / 3=反光板抬起失败 /
   *   7=卡满/无内存 / 8=卡只读。
   *   不要用「按下=0→释放=1」两段式（那是旧文档写法，成功实现无人采用）。
   */
  PtpCamera.prototype.releaseShutter = function () {
    var self = this;
    return self.transact(PTP_OC_EOS_REMOTE_RELEASE, []).then(function (res) {
      var result = res.params[0];
      if (!result) return; // 0 = 成功
      var msg = '拍摄失败';
      if (result === SHUTTER_FOCUS_FAIL) msg = '对焦失败，未释放快门（检查对焦/半按状态）';
      else if (result === SHUTTER_MIRROR) msg = '反光板抬起失败';
      else if (result === SHUTTER_MEDIA_FULL) msg = '存储卡已满或无内存';
      else if (result === SHUTTER_MEDIA_RO) msg = '存储卡只读';
      else msg += '（结果码 ' + result + '）';
      var err = PtpError(0xF100 + result, msg);
      throw err;
    });
  };

  /* ---------- 事件/照片 ---------- */
  /**
   * 等待新照片事件（0xC181 ObjectAddedEx），轮询 GetEvent(0x9116)。
   * 每轮轮询前按 10s 间隔保活；轮询间隔 250ms（gphoto2 是紧密排空，Android 上
   * 250ms 避免打满带宽，事件不丢——0x9116 数据是积攒式的）。
   * @param {number} timeoutMs 总超时（默认 90s = gphoto2 EOS_CAPTURE_TIMEOUT）
   * @returns {Promise<{objectId:number, storageId:number, size:number}>}
   *          objectId=0xC181 Handle；storageId=0 表示 SDRAM（走 0x9107 分块取图）
   */
  PtpCamera.prototype.waitForObject = function (timeoutMs) {
    var self = this;
    var deadline = Date.now() + (timeoutMs || 90000);
    function poll() {
      if (Date.now() > deadline) throw PtpTimeoutError('等待照片事件超时');
      // 先查队列里已有的 EOS 事件
      var evts = self.drainEvents();
      for (var i = 0; i < evts.length; i++) {
        if (evts[i].eos && evts[i].eos.code === PTP_EC_EOS_OBJECT_ADDED_EX) {
          var oa = evts[i].eos;
          return { objectId: oa.handle, storageId: oa.storageId, size: oa.size };
        }
      }
      // 保活：每 10s 一次（gphoto2 camera_keep_device_on 同频）
      var now = Date.now();
      if (now - self._lastKeepAlive > 10000) {
        self._lastKeepAlive = now;
        self.keepAlive().catch(function () {});
      }
      return self.transact(PTP_OC_EOS_GET_EVENT, []).then(function (res) {
        var found = null;
        var evs = parseEosEvents(res.data);
        for (var j = 0; j < evs.length; j++) {
          if (evs[j].code === PTP_EC_EOS_OBJECT_ADDED_EX) {
            found = { objectId: evs[j].handle, storageId: evs[j].storageId, size: evs[j].size };
            break;
          }
        }
        if (found) return found;
        return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll);
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
