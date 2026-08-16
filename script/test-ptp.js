/* ============================================================
 * script/test-ptp.js — PTP 协议栈单元测试（Node，mock 相机）
 *
 * 运行：node script/test-ptp.js
 * mock 一台「佳能 5D2 模拟相机」：按协议栈发出的命令逐条应答，
 * 覆盖完整链路：openSession → getDeviceInfo → setRemoteMode →
 * setEventMode → releaseShutter → waitForObject(0xC181) → getObject
 * ============================================================ */
'use strict';
const PtpCamera = require('../camera-ptp.js');

/* ---------- mock 相机 ---------- */
const FAKE_JPEG = Buffer.from(
  'FFD8FFE000104A46494600010100000100010000FFDB0043FFD9', 'hex'); // 极短假 JPEG

function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v) { v = v >>> 0; return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
function pkt(type, code, tid, payloadBytes) {
  const head = Buffer.from(
    u32(12 + (payloadBytes ? payloadBytes.length : 0))
      .concat(u16(type)).concat(u16(code)).concat(u32(tid)));
  return payloadBytes ? Buffer.concat([head, Buffer.from(payloadBytes)]) : head;
}
/* PTP USB init ack（12 字节：byte0=type, byte4..7=length=12） */
function pktInit(type) {
  const b = Buffer.alloc(12);
  b[0] = type;
  b.writeUInt32LE(12, 4);
  return b;
}
function strBytes(s) {
  const b = [];
  b.push(s.length);
  for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xFF);
  return b;
}

class MockCamera {
  constructor() {
    this.sessionOpen = false;
    this.remoteMode = 0;
    this.eventMode = 0;
    this.releaseCount = 0;
    this.pendingEventPacket = null; // 释放快门后要主动推给 host 的事件包
    this.getEventCleared = false;
    this.pendingObjects = { 100: FAKE_JPEG };
    this.nextObjectId = 100;
    this.log = [];
  }

  /* host 写过来（命令/数据）→ 可能生成回复包，塞进 outQueue */
  handleWrite(buf) {
    if (buf.length < 12) throw new Error('mock: 包过短');
    const len = buf.readUInt32LE(0);
    const type = buf.readUInt16LE(4);
    const code = buf.readUInt16LE(6);
    const tid = buf.readUInt32LE(8);
    // PTP USB init 块：byte0=type（0x05/0x07），非标准 12 字节头布局
    if (buf[0] === 0x05) return [pktInit(0x06)];  // Init Command → Init Ack
    if (buf[0] === 0x07) return [pktInit(0x08)];  // Init Event → Init Event Ack
    if (type !== 1) throw new Error('mock: 期望命令包, 实际 type=' + type);
    const params = [];
    for (let o = 12; o + 4 <= len; o += 4) params.push(buf.readUInt32LE(o));
    this.log.push({ code: '0x' + code.toString(16), params });
    return this._answer(code, tid, params);
  }

  _answer(code, tid) {
    switch (code) {
      case 0x1001: this.sessionOpen = true; return [pkt(3, 0x2001, tid)];
      case 0x1002: this.sessionOpen = false; return [pkt(3, 0x2001, tid)];
      case 0x1004: {
        // GetDeviceInfo 数据块（标准 PTP 结构）
        const b = [];
        b.push(...u16(100));                                    // StandardVersion
        b.push(...u32(0x00000006));                             // VendorExtensionID
        b.push(...u16(100));                                    // VendorExtensionVersion
        b.push(...strBytes('microsoft.com: 1.0;'));             // VendorExtensionDesc
        b.push(...u16(0));                                      // FunctionalMode
        b.push(...u32(1), ...u16(0x910F));                      // Operations [RemoteRelease]
        b.push(...u32(1), ...u16(0xC181));                      // Events [ObjectAddedEx]
        b.push(...u32(0));                                      // DeviceProperties
        b.push(...u32(1), ...u16(0x3801));                      // CaptureFormats [JPEG]
        b.push(...u32(1), ...u16(0x3801));                      // ImageFormats [JPEG]
        b.push(...strBytes('Canon Inc.'));
        b.push(...strBytes('Canon EOS 5D Mark II'));
        b.push(...strBytes('2.1.2'));
        b.push(...strBytes('mock-5d2-serial'));
        return [pkt(2, 0x1004, tid, b), pkt(3, 0x2001, tid)];
      }
      case 0x9114: this.remoteMode = 1; return [pkt(3, 0x2001, tid)];
      case 0x9115: this.eventMode = 1; return [pkt(3, 0x2001, tid)];
      case 0x9113: return [pkt(3, 0x2001, tid, u32(this.remoteMode))];
      case 0x911D: return [pkt(3, 0x2001, tid)];
      case 0x910F: {
        // 按下+释放 = 一次完整拍摄 → 相机产生新照片，主动推 0xC181 事件
        this.releaseCount++;
        const evt = pkt(4, 0xC181, tid, u32(100)); // event 包：code=0xC181, param=objectId
        return [evt, pkt(3, 0x2001, tid)];
      }
      case 0x9116: {
        // GetEvent：返回事件列表 data（Canon 格式：count + (code,4*param)）
        const b = [];
        if (!this.getEventCleared) {
          b.push(...u32(1));                                   // count=1
          b.push(...u32(0xC181));                              // event code
          b.push(...u32(100));                                 // objectId
          b.push(...u32(0), ...u32(0), ...u32(0));
          this.getEventCleared = true;
        } else {
          b.push(...u32(0));                                   // 无新事件
        }
        return [pkt(2, 0x9116, tid, b), pkt(3, 0x2001, tid)];
      }
      case 0x9104: {
        // EOS GetObject：返回 objectId 对应照片
        const oid = 100;
        const jpeg = this.pendingObjects[oid];
        if (!jpeg) return [pkt(3, 0x2013, tid)]; // ObjectDoesNotExist
        return [pkt(2, 0x9104, tid, jpeg), pkt(3, 0x2001, tid)];
      }
      default:
        return [pkt(3, 0x2002, tid)]; // GeneralError
    }
  }
}

/* ---------- mock transport：把协议栈的 bulk 读写接到 MockCamera ---------- */
class MockTransport {
  constructor(camera) {
    this.camera = camera;
    this.outQueue = [];
  }
  bulkOut(data, timeoutMs) {
    const replies = this.camera.handleWrite(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    for (const r of replies) this.outQueue.push(r);
    return Promise.resolve();
  }
  bulkIn(maxLen, timeoutMs) {
    if (!this.outQueue.length) return Promise.resolve(new Uint8Array(0));
    const bytes = this.outQueue.shift();
    return Promise.resolve(new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, maxLen)));
  }
  release() {}
}

/* ---------- 测试 ---------- */
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

async function run() {
  const cam = new MockCamera();
  const ptp = new PtpCamera(new MockTransport(cam));

  console.log('① 打开会话');
  await ptp.openSession();
  ok('openSession', cam.sessionOpen === true);
  ok('事务 ID 自增', ptp.tid > 0);

  console.log('② 设备信息');
  const info = await ptp.getDeviceInfo();
  ok('型号', info.model === 'Canon EOS 5D Mark II', '实际: ' + info.model);
  ok('厂商', info.manufacturer === 'Canon Inc.');
  ok('序列号', info.serialNumber === 'mock-5d2-serial');
  ok('固件', info.deviceVersion === '2.1.2');

  console.log('③ 远程模式');
  await ptp.setRemoteMode();
  await ptp.setEventMode();
  ok('远程模式已开', cam.remoteMode === 1);
  ok('事件模式已开', cam.eventMode === 1);

  console.log('④ 快门');
  await ptp.releaseShutter();
  ok('相机收到按下+释放各一次', cam.releaseCount === 2, '实际: ' + cam.releaseCount);
  const queuedEvents = ptp.drainEvents();
  ok('队列收到 0xC181 事件包', queuedEvents.length === 2, '实际: ' + queuedEvents.length);

  console.log('⑤ 等照片事件');
  const objectId = await ptp.waitForObject(5000);
  ok('拿到 objectId', objectId === 100, '实际: ' + objectId);

  console.log('⑥ 下载照片');
  const jpeg = await ptp.getObject(objectId);
  ok('JPEG 完整下载', jpeg.length === FAKE_JPEG.length, '长度 ' + jpeg.length);
  ok('JPEG 内容一致', jpeg[0] === 0xFF && jpeg[1] === 0xD8);

  console.log('⑦ 保活');
  await ptp.keepAlive();
  ok('keepAlive OK', cam.log.some(l => l.code === '0x911d'));

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

run().catch(e => {
  console.error('测试异常:', e && e.stack || e);
  process.exit(1);
});
