/* ============================================================
 * camera-ptp.js — 佳能 EOS PTP 联机拍摄协议栈（纯 JS，传输层解耦）
 *
 * 协议依据：ISO 15740 (PTP) + Canon EOS 厂商扩展段（0x9100+）
 * 参考实现：libgphoto2 camlibs/ptp2/ptp.h（opcode 常量定义）
 * 自行重写实现，规避 GPL 传染（不复制任何参考实现源码）
 *
 * 用途：相机互联「有线连接」——手机 USB OTG 直连 5D2 联机拍摄
 *   openSession → getDeviceInfo → setRemoteMode → setEventMode
 *   → releaseShutter（快门）→ waitForObject（等 0xC181 事件）
 *   → getObject（下载 JPEG 照片）
 *
 * 与传输层解耦：transport 只需提供 bulkOut / bulkIn / release，
 *   Android 侧由 usb-transport.js（Native.js）实现；
 *   单元测试用 Node mock（script/test-ptp.js）。
 * ============================================================ */

(function (global) {
  'use strict';

  /* ---------- PTP 包类型 ---------- */
  var PTP_TYPE_COMMAND = 1;
  var PTP_TYPE_DATA = 2;
  var PTP_TYPE_RESPONSE = 3;
  var PTP_TYPE_EVENT = 4;

  /* ---------- 标准操作码（ISO 15740） ---------- */
  var PTP_OC_OPEN_SESSION = 0x1001;
  var PTP_OC_CLOSE_SESSION = 0x1002;
  var PTP_OC_GET_DEVICE_INFO = 0x1004;
  var PTP_OC_GET_OBJECT_INFO = 0x1008;
  var PTP_OC_GET_OBJECT = 0x100A;
  var PTP_OC_DELETE_OBJECT = 0x100B;

  /* ---------- Canon EOS 厂商扩展操作码 ---------- */
  var PTP_OC_EOS_GET_DEVICE_INFO_EX = 0x9108;
  var PTP_OC_EOS_GET_OBJECT = 0x9104;
  var PTP_OC_EOS_REMOTE_RELEASE = 0x910F;
  var PTP_OC_EOS_GET_REMOTE_MODE = 0x9113;
  var PTP_OC_EOS_SET_REMOTE_MODE = 0x9114;
  var PTP_OC_EOS_SET_EVENT_MODE = 0x9115;
  var PTP_OC_EOS_GET_EVENT = 0x9116;
  var PTP_OC_EOS_KEEP_DEVICE_ON = 0x911D;
  // EVF 实时取景（阶段 2 原生插件使用，协议栈先备好）
  var PTP_OC_EOS_INITIATE_VIEWFINDER = 0x9151;
  var PTP_OC_EOS_TERMINATE_VIEWFINDER = 0x9152;
  var PTP_OC_EOS_GET_VIEWFINDER_DATA = 0x9153;

  /* ---------- 响应码 ---------- */
  var PTP_RC_OK = 0x2001;
  var PTP_RC_GENERAL_ERROR = 0x2002;
  var PTP_RC_SESSION_NOT_OPEN = 0x2005;
  var PTP_RC_DEVICE_BUSY = 0x200A;
  var PTP_RC_OBJECT_NOT_READY = 0x200B;
  var PTP_RC_INCOMPLETE_TRANSFER = 0x2007;

  /* ---------- 事件码（Canon EOS 段 0xC180+） ---------- */
  var PTP_EC_EOS_OBJECT_ADDED_EX = 0xC181; // 新照片（等这个）
  var PTP_EC_EOS_PROP_VALUE_CHANGED = 0xC189;
  var PTP_EC_EOS_AF_RESULT = 0xC101;
  var PTP_EC_EOS_CAMERA_STATUS_CHANGED = 0xC102;

  /* ---------- 错误类型 ---------- */
  function PtpError(code, message) {
    var err = new Error(message || ('PTP 响应错误 code=0x' + (code || 0).toString(16)));
    err.name = 'PtpError';
    err.code = code; // 响应码；0xE000 系列为协议层错误
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
    this.u8(b.length);
    for (var i = 0; i < b.length; i++) this._bytes.push(b.charCodeAt(i) & 0xFF);
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
    for (var i = 0; i < len; i++) s += String.fromCharCode(this.u8());
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
   * @param {number} tid   事务 ID
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
    this.tid = 0;
    this.sessionOpen = false;
    this.deviceInfo = null;
    // 读包缓冲：Canon 事件可能插在响应之间（bulk IN 是共享流）
    this._pendingEvents = [];
  }

  PtpCamera.prototype._nextTid = function () {
    this.tid = (this.tid + 1) >>> 0;
    return this.tid;
  };

  /** 读一个完整包（可能跨多个 bulk 读）。返回 {type, code, tid, data:Uint8Array, params:number[]} */
  PtpCamera.prototype._readPacket = function (timeoutMs, maxLen) {
    var self = this;
    return self.transport.bulkIn(maxLen || 65536, timeoutMs).then(function (first) {
      if (!first || first.length < 12) throw PtpError(0xE002, 'PTP 包过短');
      var h = parseHeader(first);
      if (h.length < 12 || h.length > 0x20000000) throw PtpError(0xE003, '非法包长 ' + h.length);
      var body = new Uint8Array(h.length - 12);
      var got = Math.min(first.length - 12, body.length);
      body.set(first.subarray(12, 12 + got));
      // 剩余字节不足则继续读（空读/重复读有次数上限，防设备静默挂起导致死循环）
      var emptyReads = 0;
      function readMore(offset) {
        if (offset >= body.length) {
          return Promise.resolve({ type: h.type, code: h.code, tid: h.tid, data: body });
        }
        return self.transport.bulkIn(body.length - offset, timeoutMs).then(function (chunk) {
          if (!chunk || !chunk.length) {
            emptyReads++;
            if (emptyReads > 5) throw PtpTimeoutError('等待 PTP 数据超时（已重试 5 次）');
            return readMore(offset); // 空读重试
          }
          emptyReads = 0;
          var n = Math.min(chunk.length, body.length - offset);
          body.set(chunk.subarray(0, n), offset);
          return readMore(offset + n);
        });
      }
      return readMore(got);
    });
  };

  /**
   * 执行一次事务（命令 → 可选 data → 响应）
   * @param {number} code 操作码
   * @param {number[]} [params] 命令参数
   * @param {Uint8Array} [outData] 命令携带的 data 阶段负载（一般用不到）
   * @returns {Promise<{data:Uint8Array, params:number[]}>} data 为响应带的数据
   */
  PtpCamera.prototype.transact = function (code, params, outData) {
    var self = this;
    var tid = self._nextTid();
    // 发命令
    return self.transport.bulkOut(buildCommand(code, tid, params), 3000)
      .then(function () {
        if (outData) return self.transport.bulkOut(buildData(code, tid, outData), 3000);
      })
      .then(function () {
        // 收响应：可能是 Response 或 Data+Response；Canon 可能先插入事件包
        return self._readPacket(8000);
      })
      .then(function loop(pkt) {
        if (pkt.type === PTP_TYPE_EVENT) {
          // 事件包插入（如 0xC102 状态变化），入队继续等
          self._pendingEvents.push(pkt);
          return self._readPacket(8000).then(loop);
        }
        if (pkt.type === PTP_TYPE_DATA) {
          // data 阶段结束 → 等 response
          return self._readPacket(8000).then(function (resp) {
            if (resp.type !== PTP_TYPE_RESPONSE) throw PtpError(0xE004, '期望响应包');
            if (resp.code !== PTP_RC_OK) throw PtpError(resp.code);
            // data 包的响应可能带数据（罕见），取 resp 的 data
            return { data: pkt.data, params: resp.data ? parseParams(resp.data) : [] };
          });
        }
        if (pkt.type === PTP_TYPE_RESPONSE) {
          if (pkt.code !== PTP_RC_OK) throw PtpError(pkt.code);
          return { data: null, params: parseParams(pkt.data) };
        }
        throw PtpError(0xE005, '未知包类型 ' + pkt.type);
      });
  };

  function parseParams(u8) {
    var params = [];
    if (!u8 || u8.length < 4) return params;
    var r = new PacketReader(u8);
    var n = Math.floor(r.dv.byteLength / 4);
    for (var i = 0; i < n; i++) params.push(r.u32());
    return params;
  }

  /** 读取队列中待处理的事件（不阻塞） */
  PtpCamera.prototype.drainEvents = function () {
    var evts = this._pendingEvents;
    this._pendingEvents = [];
    return evts;
  };

  /* ---------- 会话 ---------- */
  PtpCamera.prototype.openSession = function () {
    var self = this;
    // 会话 ID 取 tid 一次（任意非 0 值）
    var sessionId = 0x5D20;
    return self.transact(PTP_OC_OPEN_SESSION, [sessionId]).then(function () {
      self.sessionOpen = true;
    });
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
    // 0x9114 参数 1 = 进入远程控制模式
    return this.transact(PTP_OC_EOS_SET_REMOTE_MODE, [1]);
  };

  PtpCamera.prototype.setEventMode = function () {
    // 0x9115 参数 1 = 打开事件通知（拍照后 0xC181 事件会进入 bulk 流）
    return this.transact(PTP_OC_EOS_SET_EVENT_MODE, [1]);
  };

  PtpCamera.prototype.getRemoteMode = function () {
    return this.transact(PTP_OC_EOS_GET_REMOTE_MODE, []).then(function (res) {
      return res.params[0];
    });
  };

  /** 保活：防止相机自动休眠断链（调用方按 10-15s 周期调用） */
  PtpCamera.prototype.keepAlive = function () {
    return this.transact(PTP_OC_EOS_KEEP_DEVICE_ON, []);
  };

  /* ---------- 快门 ---------- */
  /**
   * 按快门（RemoteRelease 按下+释放两步，5D2 与多数 EOS 一致）
   * @returns {Promise} 快门指令已发出（不等照片）
   */
  PtpCamera.prototype.releaseShutter = function () {
    var self = this;
    return self.transact(PTP_OC_EOS_REMOTE_RELEASE, [0])   // 按下
      .then(function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, 120); // 按下保持 120ms
        });
      })
      .then(function () {
        return self.transact(PTP_OC_EOS_REMOTE_RELEASE, [1]); // 释放
      });
  };

  /* ---------- 事件/照片 ---------- */
  /**
   * 等待新照片事件（0xC181 ObjectAddedEx），轮询 GetEvent
   * @param {number} timeoutMs 总超时（默认 30s，拍 RAW 较慢）
   * @returns {Promise<number>} objectId
   */
  PtpCamera.prototype.waitForObject = function (timeoutMs) {
    var self = this;
    var deadline = Date.now() + (timeoutMs || 30000);
    function poll() {
      if (Date.now() > deadline) throw PtpTimeoutError('等待照片事件超时');
      // 先查队列里已有的事件
      var evts = self.drainEvents();
      for (var i = 0; i < evts.length; i++) {
        var obj = eventObjectId(evts[i]);
        if (obj) return obj;
      }
      return self.transact(PTP_OC_EOS_GET_EVENT, []).then(function (res) {
        var found = null;
        if (res.data) {
          // Canon 事件块：u32 count + count * (code + 4 params)
          var r = new PacketReader(res.data);
          var count = r.u32();
          for (var j = 0; j < count && j < 64; j++) {
            var code = r.u32();
            var p1 = r.u32(), p2 = r.u32(), p3 = r.u32(), p4 = r.u32();
            if (code === PTP_EC_EOS_OBJECT_ADDED_EX) {
              found = p1; // 0xC181 事件参数1 = objectId（gphoto2/dslrdashboard 一致）
            }
          }
        }
        if (found) return found;
        // 事件还没来，稍等再查
        return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(poll);
      });
    }
    return poll();
  };

  /**
   * 从主动推送的事件包提取 objectId。
   * 事件包（type=4）格式：12 字节头（code=事件码）+ 参数平铺（u32 数组），
   * 0xC181 ObjectAddedEx 的参数1 = objectId。
   * （与 GetEvent 命令响应里的「count+事件块」格式不同，勿混用）
   */
  function eventObjectId(pkt) {
    if (!pkt || pkt.code !== PTP_EC_EOS_OBJECT_ADDED_EX || !pkt.data || pkt.data.length < 4) return null;
    return new PacketReader(pkt.data).u32();
  }

  /**
   * 下载照片（EOS GetObject 0x9104），大文件分段回读
   * @param {number} objectId
   * @param {function} [onChunk] 进度回调(chunk, received)
   * @returns {Promise<Uint8Array>} JPEG 完整字节
   */
  PtpCamera.prototype.getObject = function (objectId, onChunk) {
    var self = this;
    var tid = self._nextTid();
    return self.transport.bulkOut(buildCommand(PTP_OC_EOS_GET_OBJECT, tid, [objectId]), 3000)
      .then(function () {
        return self._readPacket(30000, 65536);
      })
      .then(function (pkt) {
        if (pkt.type === PTP_TYPE_EVENT) {
          self._pendingEvents.push(pkt);
          return self._readPacket(30000, 65536).then(function (p2) {
            if (p2.type !== PTP_TYPE_DATA) throw PtpError(0xE007, '期望数据包');
            return p2;
          });
        }
        if (pkt.type !== PTP_TYPE_DATA) throw PtpError(0xE007, '期望数据包');
        return pkt;
      })
      .then(function (pkt) {
        var payload = pkt.data;
        // 等待响应确认 + 触发进度
        var respPromise = self._readPacket(30000).then(function (resp) {
          if (resp.type === PTP_TYPE_EVENT) { self._pendingEvents.push(resp); return null; } // 事件先入队
          if (resp.code !== PTP_RC_OK) throw PtpError(resp.code);
          return resp;
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
