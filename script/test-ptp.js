/* ============================================================
 * script/test-ptp.js — PTP 协议栈单元测试（Node，mock 相机，流式模拟）
 *
 * 运行：node script/test-ptp.js
 *
 * 2026-08-16 重写（吸取 gphoto2 成功经验后）：
 *   ① mock 相机的 opcode 表独立写死为正确值（此前与实现共用常量表，
 *      opcode 整体错位 +1 也 14/14 全过——自洽测试骗过了我们）
 *   ② transport 改流式：应答拼成字节流，模拟真实 USB 的 512 对齐/随机切分/
 *      半包/多包同流（旧版一次给一个完整包，测不出粘包 bug）
 *   ③ GetEvent 事件按 gphoto2 真实格式返回：[size:u32][code:u32][变长负载] 链
 *   ④ 快门 0x910F 无参数单发，响应 Param1=拍摄结果码
 *   ⑤ 新增场景：粘包 choppy、OpenSession 重试(0x2004)、SessionAlreadyOpen、
 *      DeviceBusy(0x2019) 重试、快门失败结果码、旧回复跳过、SDRAM 分块取图
 * ============================================================ */
'use strict';
const PtpCamera = require('../camera-ptp.js');

/* ---------- 正确 PTP 常量（与实现同源：libgphoto2 ptp.h） ---------- */
const OC = {
  OPEN_SESSION: 0x1002, CLOSE_SESSION: 0x1003, GET_DEVICE_INFO: 0x1001,
  GET_OBJECT_INFO: 0x1008, GET_OBJECT: 0x1009, SET_DEVICE_PROP_VALUE: 0x1016,
  EOS_GET_OBJECT: 0x9104, EOS_GET_PARTIAL_OBJECT: 0x9107,
  EOS_REMOTE_RELEASE: 0x910F, EOS_REMOTE_RELEASE_ON: 0x9128,
  EOS_REMOTE_RELEASE_OFF: 0x9129, EOS_SET_REMOTE_MODE: 0x9114,
  EOS_SET_EVENT_MODE: 0x9115, EOS_GET_EVENT: 0x9116,
  EOS_TRANSFER_COMPLETE: 0x9117, EOS_KEEP_DEVICE_ON: 0x911D
};
const RC = { OK: 0x2001, GENERAL_ERROR: 0x2002, INVALID_TID: 0x2004,
             DEVICE_BUSY: 0x2019, SESSION_ALREADY_OPEN: 0x201E };
const EV = { OBJECT_ADDED_EX: 0xC181 };
const DPC = { CAPTURE_DESTINATION: 0xD11C };

/* ---------- 字节工具 ---------- */
function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v) { v = v >>> 0; return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
function pkt(type, code, tid, payloadBytes) {
  const head = Buffer.from(
    u32(12 + (payloadBytes ? payloadBytes.length : 0))
      .concat(u16(type)).concat(u16(code)).concat(u32(tid)));
  return payloadBytes ? Buffer.concat([head, Buffer.from(payloadBytes)]) : head;
}
function strBytes(s) {
  const b = [s.length + 1]; // PTP 字符串长度含结尾 null
  for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xFF);
  b.push(0);
  return b;
}
function strBytes16(s) {
  // 5D2 真机实测格式（2026-08-16）：UTF-16LE，len = 字节数（含结尾 null）
  const b = [s.length * 2 + 2];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b.push(c & 0xFF, (c >>> 8) & 0xFF); }
  b.push(0, 0);
  return b;
}
const FAKE_JPEG_HEAD = Buffer.from('FFD8FFE0', 'hex');

/* ---------- mock 相机（协议正确实现，与实现解耦） ---------- */
class MockCamera {
  constructor(opts) {
    opts = opts || {};
    this.choppy = !!opts.choppy;             // 流式模拟：512 对齐/随机切分
    this.rejectSessionIds = opts.rejectSessionIds || []; // 模拟 0x2004 重试
    this.alreadyOpen = !!opts.alreadyOpen;   // 模拟 SessionAlreadyOpen
    this.busyFirst = !!opts.busyFirst;       // 模拟 DeviceBusy 重试
    this.focusFail = !!opts.focusFail;       // 0x9128 全按响应结果码=1
    this.reject9128 = !!opts.reject9128;     // 0x9128 不支持（0x2005）→ 测回退 0x910F
    this.legacy910f = !!opts.legacy910f;     // 0x910F 可用（老 EOS 模拟），且 0x9128 不支持
    this.rejectDestProp = !!opts.rejectDestProp; // SetDevicePropValue 拒绝
    this.captureDestination = 4;             // 默认 SDRAM（gphoto2 语义）
    this.sessionOpen = false;
    this.sessionId = 0;
    this.remoteMode = 0;
    this.eventMode = 0;
    this.log = [];                           // 收到的命令（code+params），测试断言用
    this.events = [];                        // 待 GetEvent 消费的事件记录
    this.objects = { 100: Buffer.concat([FAKE_JPEG_HEAD, Buffer.alloc(200)]) }; // 小 JPEG
    this.bigObject = null;                   // SDRAM 大图（分块取图测试用）
    this.nextHandle = 100;
    this.busyFired = false;
    this.storageId = 0x20001;                // CF 卡 storage id（≠0=卡上）
  }

  /* host 写来命令 → 生成应答包数组 */
  handleWrite(buf) {
    if (buf.length < 12) throw new Error('mock: 包过短');
    const len = buf.readUInt32LE(0);
    const type = buf.readUInt16LE(4);
    const code = buf.readUInt16LE(6);
    const tid = buf.readUInt32LE(8);
    if (type !== 1) throw new Error('mock: 期望命令包, 实际 type=' + type);
    const params = [];
    for (let o = 12; o + 4 <= len; o += 4) params.push(buf.readUInt32LE(o));
    this.log.push({ code, params, tid });
    return this._answer(code, tid, params);
  }

  _answer(code, tid, params) {
    switch (code) {
      case OC.OPEN_SESSION: {
        if (this.alreadyOpen) return [pkt(3, RC.SESSION_ALREADY_OPEN, tid)];
        if (this.rejectSessionIds.includes(params[0])) return [pkt(3, RC.INVALID_TID, tid)];
        this.sessionOpen = true;
        this.sessionId = params[0];
        return [pkt(3, RC.OK, tid)];
      }
      case OC.CLOSE_SESSION:
        this.sessionOpen = false;
        return [pkt(3, RC.OK, tid)];
      case OC.GET_DEVICE_INFO: {
        const b = [];
        b.push(...u16(100), ...u32(0x0B), ...u16(100));            // ver + Canon ext + ver
        b.push(...strBytes('microsoft.com: 1.0;'));                // VendorExtensionDesc
        b.push(...u16(0));                                         // FunctionalMode
        b.push(...u32(1), ...u16(OC.EOS_REMOTE_RELEASE));          // Operations
        b.push(...u32(1), ...u16(EV.OBJECT_ADDED_EX));             // Events
        b.push(...u32(0));                                         // DeviceProperties
        b.push(...u32(1), ...u16(0x3801));                         // CaptureFormats
        b.push(...u32(1), ...u16(0x3801));                         // ImageFormats
        // 5D2 真机实测：厂商/型号/固件/序列号均为 UTF-16LE（2026-08-16 直连诊断实锤）
        b.push(...strBytes16('Canon Inc.'));
        b.push(...strBytes16('Canon EOS 5D Mark II'));
        b.push(...strBytes16('2.1.2'));
        b.push(...strBytes16('mock-5d2-serial'));
        return [pkt(2, OC.GET_DEVICE_INFO, tid, b), pkt(3, RC.OK, tid)];
      }
      case OC.SET_DEVICE_PROP_VALUE: {
        this.log.push({ prop: params[0] });
        if (this.rejectDestProp) return [pkt(3, RC.GENERAL_ERROR, tid)];
        this.captureDestination = params[0] === DPC.CAPTURE_DESTINATION ? 1 : this.captureDestination;
        return [pkt(3, RC.OK, tid)];
      }
      case OC.EOS_SET_REMOTE_MODE: this.remoteMode = 1; return [pkt(3, RC.OK, tid)];
      case OC.EOS_SET_EVENT_MODE: this.eventMode = 1; return [pkt(3, RC.OK, tid)];
      case OC.EOS_KEEP_DEVICE_ON: return [pkt(3, RC.OK, tid)];
      case OC.EOS_REMOTE_RELEASE_ON: {
        // 0x9128 现代主路径（5D2 实测）：1=半按 2=全按，参数2：0=AF 启用
        if (this.reject9128) return [pkt(3, 0x2005, tid)]; // OperationNotSupported
        if (this.busyFirst && !this.busyFired && params[0] === 2) {
          this.busyFired = true;
          return [pkt(3, RC.DEVICE_BUSY, tid)];
        }
        if (params[0] === 2) {
          // 全按 → 出片（SDRAM 或卡上）+ 0xC181 事件（每次新 handle，对象独立）
          const handle = this.nextHandle++;
          const isSdram = this.captureDestination !== 1;
          const jpeg = (isSdram && this.bigObject) ? this.bigObject
            : Buffer.concat([FAKE_JPEG_HEAD, Buffer.alloc(200)]);
          this.objects[handle] = jpeg;
          this.events.push({
            code: EV.OBJECT_ADDED_EX, handle,
            storageId: isSdram ? 0 : this.storageId,  // SDRAM=0 / 卡=CF id
            size: jpeg.length
          });
          // 全按响应结果码：0=成功；1=触发失败
          return [pkt(3, RC.OK, tid, u32(this.focusFail ? 1 : 0))];
        }
        return [pkt(3, RC.OK, tid, u32(0))]; // 半按 OK
      }
      case OC.EOS_REMOTE_RELEASE_OFF:
        return [pkt(3, RC.OK, tid)];
      case OC.EOS_REMOTE_RELEASE: {
        // 0x910F 旧式：5D2 真机实测返回结果码 3（反光板抬起失败）；
        // legacy910f 模式模拟老 EOS（返回 0=成功，用于测回退路径出片）
        if (!this.legacy910f) return [pkt(3, RC.OK, tid, u32(3))];
        const handle = this.nextHandle++;
        const jpeg = Buffer.concat([FAKE_JPEG_HEAD, Buffer.alloc(200)]);
        this.objects[handle] = jpeg;
        this.events.push({ code: EV.OBJECT_ADDED_EX, handle, storageId: this.storageId, size: jpeg.length });
        return [pkt(3, RC.OK, tid, u32(0))];
      }
      case OC.EOS_GET_EVENT: {
        // 事件链：[size:u32][code:u32][Handle@8][StorageID@0C][OFC@10(u16)][10B][Size@1C][Parent@20][Name@28]
        const b = [];
        while (this.events.length) {
          const e = this.events.shift();
          const fn = Buffer.from('IMG_' + e.handle + '.JPG'); // 无 null 结尾的简化文件名
          const body = [];
          body.push(...u32(e.handle), ...u32(e.storageId), ...u16(e.ofc || 0x3801));
          for (let k = 0; k < 10; k++) body.push(0);
          body.push(...u32(e.size), ...u32(0));
          for (let k = 0; k < fn.length; k++) body.push(fn[k]);
          b.push(...u32(8 + 4 + body.length), ...u32(e.code), ...body);
        }
        b.push(...u32(8), ...u32(0)); // 结束标记
        return [pkt(2, OC.EOS_GET_EVENT, tid, b), pkt(3, RC.OK, tid)];
      }
      case OC.EOS_GET_OBJECT: {
        const handle = params[0];
        const obj = this.objects[handle];
        if (!obj) return [pkt(3, 0x2009, tid)]; // InvalidObjectHandle
        return [pkt(2, OC.EOS_GET_OBJECT, tid, obj), pkt(3, RC.OK, tid)];
      }
      case OC.EOS_GET_PARTIAL_OBJECT: {
        const handle = params[0], offset = params[1], maxSize = params[2];
        const obj = this.objects[handle];
        if (!obj) return [pkt(3, 0x2009, tid)];
        const part = obj.subarray(offset, Math.min(obj.length, offset + maxSize));
        return [pkt(2, OC.EOS_GET_PARTIAL_OBJECT, tid, part), pkt(3, RC.OK, tid)];
      }
      case OC.EOS_TRANSFER_COMPLETE:
        return [pkt(3, RC.OK, tid)];
      default:
        return [pkt(3, RC.GENERAL_ERROR, tid)];
    }
  }
}

/* ---------- mock transport：流式（模拟真实 USB bulk 流） ---------- */
class MockTransport {
  constructor(camera) {
    this.camera = camera;
    this.stream = Buffer.alloc(0);           // 相机 → host 的字节流
  }
  bulkOut(data, timeoutMs) {
    const replies = this.camera.handleWrite(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    for (const r of replies) this.stream = Buffer.concat([this.stream, r]);
    return Promise.resolve();
  }
  bulkIn(maxLen, timeoutMs) {
    if (!this.stream.length) return Promise.resolve(new Uint8Array(0));
    let n = Math.min(maxLen, this.stream.length);
    if (this.camera.choppy) {
      // 模拟 USB 高速 bulk 的 512 对齐传输：每次最多给 512 的倍数（可含多包/半包）
      n = Math.min(n, Math.max(512, Math.floor(Math.random() * 4) * 512));
    }
    const out = this.stream.subarray(0, n);
    this.stream = this.stream.subarray(n);
    return Promise.resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
  }
  release() {}
}

/* ---------- 测试 ---------- */
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

async function scenario(name, setup, run) {
  console.log('\n' + name);
  try { await run(setup); } catch (e) {
    failed++;
    console.log('  ❌ 场景异常: ' + (e && e.stack || e));
  }
}

async function main() {
  /* ① 全链路（choppy 流式 = 最接近真机） */
  await scenario('① 全链路（流式 512 切分）', { choppy: true }, async (s) => {
    const cam = new MockCamera(s);
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    ok('openSession：sessionId=1', cam.sessionId === 1, '实际: ' + cam.sessionId);
    const openCmd = cam.log.find(l => l.code === OC.OPEN_SESSION);
    ok('openSession 容器头 transid=0', openCmd && openCmd.tid === 0, '实际 tid: ' + (openCmd && openCmd.tid));

    const info = await ptp.getDeviceInfo();
    ok('事务 ID 自增（openSession 用 tid=0，后续命令 tid≥1）', ptp.tid >= 1, '实际 tid: ' + ptp.tid);
    ok('型号', info.model === 'Canon EOS 5D Mark II', '实际: ' + JSON.stringify(info.model));
    ok('厂商', info.manufacturer === 'Canon Inc.');
    ok('序列号', info.serialNumber === 'mock-5d2-serial');
    ok('固件', info.deviceVersion === '2.1.2');

    await ptp.setRemoteMode();
    await ptp.setEventMode();
    ok('远程/事件模式已开', cam.remoteMode === 1 && cam.eventMode === 1);
    await ptp.drainEosEvents();
    ok('drainEosEvents 排空完成', true);
    // 显式设照片落卡（5D2 gphoto2 默认 SDRAM=4；设 1=CF 卡后 0xC181 storageId≠0 → 走 0x9104）
    await ptp.setCaptureDestination(1);
    ok('CaptureDestination 设为卡', cam.captureDestination === 1, '实际: ' + cam.captureDestination);

    await ptp.releaseShutter();
    const half = cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE_ON && l.params[0] === 1);
    const full = cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE_ON && l.params[0] === 2);
    const off = cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE_OFF);
    ok('快门：0x9128 半按→全按→全释放（5D2 真机实证路径）',
      half.length === 1 && full.length === 1 && off.length === 1,
      '实际 half=' + half.length + ' full=' + full.length + ' off=' + off.length);
    ok('快门未误走 0x910F', cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE).length === 0);

    const obj = await ptp.waitForObject(5000);
    ok('等照片：objectId 来自 0xC181 Handle', obj.objectId === 100, '实际: ' + obj.objectId);
    ok('等照片：storageId 正确（SDRAM=0/卡=CF）', obj.storageId === 0 || obj.storageId === 0x20001,
      '实际: ' + obj.storageId);

    const jpeg = await ptp.getObject(obj);
    ok('JPEG 完整下载（卡上 0x9104 路径）', jpeg.length === cam.objects[100].length && jpeg[0] === 0xFF && jpeg[1] === 0xD8,
      '长度 ' + jpeg.length);
    const getObjLog = cam.log.filter(l => l.code === OC.EOS_GET_OBJECT);
    ok('卡上取图用 0x9104', getObjLog.length === 1);

    await ptp.keepAlive();
    ok('keepAlive 0x911D 无参', cam.log.some(l => l.code === OC.EOS_KEEP_DEVICE_ON));
  });

  /* ② 标准断言（非 choppy，快速） */
  await scenario('② 基础断言', {}, async () => {
    const cam = new MockCamera({});
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    const info = await ptp.getDeviceInfo();
    ok('事务 ID 自增', ptp.tid > 0);
    ok('远程模式', (await ptp.setRemoteMode(), cam.remoteMode === 1));
    ok('事件模式', (await ptp.setEventMode(), cam.eventMode === 1));
    await ptp.releaseShutter();
    const obj = await ptp.waitForObject(5000);
    const jpeg = await ptp.getObject(obj);
    ok('JPEG 内容一致', jpeg[0] === 0xFF && jpeg[1] === 0xD8);
  });

  /* ③ SDRAM 分块取图（大图 >1MB，验证 0x9107 分块 + 0x9117） */
  await scenario('③ SDRAM 分块取图（大图 1.5MB）', {}, async () => {
    const cam = new MockCamera({});
    cam.bigObject = Buffer.concat([FAKE_JPEG_HEAD, Buffer.alloc(0x180000)]); // 1.5MB
    cam.captureDestination = 4; // SDRAM（不设卡）
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    await ptp.setRemoteMode();
    await ptp.setEventMode();
    await ptp.drainEosEvents();
    await ptp.releaseShutter();
    const obj = await ptp.waitForObject(5000);
    ok('SDRAM 事件 storageId=0', obj.storageId === 0, '实际: ' + obj.storageId);
    const jpeg = await ptp.getObject(obj);
    ok('SDRAM 分块拼出完整大图', jpeg.length === cam.bigObject.length, '长度 ' + jpeg.length);
    const parts = cam.log.filter(l => l.code === OC.EOS_GET_PARTIAL_OBJECT);
    ok('分块次数 ≥2（1.5MB/1MB）', parts.length >= 2, '实际: ' + parts.length);
    ok('TransferComplete(0x9117) 已发', cam.log.some(l => l.code === OC.EOS_TRANSFER_COMPLETE));
  });

  /* ④ OpenSession 重试：0x2004 → sessionId 递增 */
  await scenario('④ OpenSession 重试（InvalidTransactionID）', { rejectSessionIds: [1, 2] }, async () => {
    const cam = new MockCamera({ rejectSessionIds: [1, 2] });
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    ok('重试后 sessionId=3', cam.sessionId === 3, '实际: ' + cam.sessionId);
  });

  /* ⑤ SessionAlreadyOpen 放行 */
  await scenario('⑤ SessionAlreadyOpen 放行', { alreadyOpen: true }, async () => {
    const cam = new MockCamera({ alreadyOpen: true });
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    ok('0x201E 视为已打开，不抛错', ptp.sessionOpen === true);
  });

  /* ⑥ DeviceBusy 自动重试 */
  await scenario('⑥ DeviceBusy(0x2019) 自动重试', { busyFirst: true }, async () => {
    const cam = new MockCamera({ busyFirst: true });
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    await ptp.releaseShutter();
    // 半按 1 + 全按 2（首次 Busy 重试） = 3 次 0x9128
    ok('Busy 后重试成功', cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE_ON).length === 3,
      '实际: ' + cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE_ON).length);
    const objBusy = await ptp.waitForObject(2000);
    ok('Busy 重试后照片事件仍拿到', !!objBusy && objBusy.objectId === 100, '实际: ' + (objBusy && objBusy.objectId));
  });

  /* ⑦ 快门触发失败（全按结果码=1） */
  await scenario('⑦ 快门触发失败结果码', { focusFail: true }, async () => {
    const cam = new MockCamera({ focusFail: true });
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    try {
      await ptp.releaseShutter();
      ok('触发失败应抛错', false, '未抛错');
    } catch (e) {
      ok('抛错且文案含「触发失败」', /触发失败/.test(e.message), e.message);
    }
  });

  /* ⑩ 0x9128 不支持 → 回退 0x910F（老 EOS） */
  await scenario('⑩ 0x9128 不支持回退 0x910F', { reject9128: true, legacy910f: true }, async () => {
    const cam = new MockCamera({ reject9128: true, legacy910f: true });
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    await ptp.releaseShutter();
    const fallback = cam.log.filter(l => l.code === OC.EOS_REMOTE_RELEASE);
    ok('回退走 0x910F', fallback.length === 1 && fallback[0].params.length === 0,
      '实际: ' + JSON.stringify(fallback));
    const objFb = await ptp.waitForObject(2000);
    ok('回退后仍能出片', !!objFb && objFb.objectId === 100, '实际: ' + (objFb && objFb.objectId));
  });

  /* ⑧ 旧回复跳过（tid 不匹配） */
  await scenario('⑧ 旧回复跳过（tid 校验）', {}, async () => {
    const cam = new MockCamera({});
    const t = new MockTransport(cam);
    const ptp = new PtpCamera(t);
    // 预塞一个旧 tid=1 的响应（模拟上次事务的残留回复）
    t.stream = Buffer.concat([pkt(3, RC.OK, 1), t.stream]);
    await ptp.openSession();
    ok('旧回复被跳过，openSession 成功', ptp.sessionOpen === true);
  });

  /* ⑨ SetDevicePropValue 失败不致命 */
  await scenario('⑨ CaptureDestination 设置失败不致命', { rejectDestProp: true }, async () => {
    const cam = new MockCamera({ rejectDestProp: true });
    const ptp = new PtpCamera(new MockTransport(cam));
    await ptp.openSession();
    await ptp.setCaptureDestination(1);
    ok('属性设置失败被吞掉', true);
  });

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('测试异常:', e && e.stack || e);
  process.exit(1);
});
