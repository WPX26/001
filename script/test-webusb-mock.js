/* ============================================================
 * script/test-webusb-mock.js — browser-usb-transport.js（WebUSB 传输层）Node 冒烟测试
 *
 * 2026-08-16 r18 新增：mock navigator.usb + USBDevice（模拟 5D2），
 * 在 Node 里真跑 browser-usb-transport.js 的 scan → requestConnect →
 * _open → bulkOut/bulkIn 全流程 + 与 camera-ptp.js 协议栈联通
 * （openSession → getDeviceInfo → 远程/事件模式 → 排空 → 保活），
 * 把所有 JS 级错误抓在本地。
 *
 * 运行：node script/test-webusb-mock.js
 * ============================================================ */
'use strict';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------- 字节工具（与 test-ptp.js 同源） ---------- */
function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32(v) { v = v >>> 0; return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
function pkt(type, code, tid, payloadBytes) {
  const head = Buffer.from(
    u32(12 + (payloadBytes ? payloadBytes.length : 0))
      .concat(u16(type)).concat(u16(code)).concat(u32(tid)));
  return payloadBytes ? Buffer.concat([head, Buffer.from(payloadBytes)]) : head;
}
function strBytes16(s) {
  const b = [s.length * 2 + 2];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b.push(c & 0xFF, (c >>> 8) & 0xFF); }
  b.push(0, 0);
  return b;
}
/* 标准 PTP 事件容器（type=4）：12B 头 + 平铺 u32 参数——模拟中断端点收到 ObjectAdded */
function intrPkt(code, params) {
  const payload = [];
  for (const p of (params || [])) payload.push(...u32(p));
  return Buffer.from(u32(12 + payload.length).concat(u16(4)).concat(u16(code)).concat(u32(0)).concat(payload));
}
const OC = { OPEN_SESSION: 0x1002, GET_DEVICE_INFO: 0x1001,
  SET_DEVICE_PROP_VALUE: 0x1016, EOS_SET_REMOTE_MODE: 0x9114,
  EOS_SET_EVENT_MODE: 0x9115, EOS_GET_EVENT: 0x9116, EOS_KEEP_DEVICE_ON: 0x911D,
  GET_STORAGE_IDS: 0x1004, GET_NUM_OBJECTS: 0x1006, GET_OBJECT_HANDLES: 0x1007 };
const RC = { OK: 0x2001 };
const EV = { OBJECT_ADDED_EX: 0xC181 };
const DPC = { CAPTURE_DESTINATION: 0xD11C };

/* ---------- mock 相机（应答生成，模拟 5D2 连接流程所需命令） ---------- */
class MockUsbCamera {
  constructor() {
    this.stream = Buffer.alloc(0);   // 相机 → host 字节流（模拟 USB 流）
    this.log = [];                   // 收到的命令
    this.sessionId = 0;
    this.remoteMode = 0;
    this.eventMode = 0;
    this.captureDestination = 4;     // 默认 SDRAM
    this.stallNextIn = 0;            // 模拟端点 STALL 次数
    this.delayMs = 0;                // 模拟设备处理延迟（ZLP 前空读）
    this.intrEvents = [];            // 中断端点事件队列（标准 PTP 事件，r44）
    this._intrWait = null;           // 常驻中断读的等待器
    this.store = [0x100, 0x200, 0x300]; // 已存对象句柄（r45 轮询兜底）
    this.getEventCalls = 0;          // r50：统计 GetEvent(0x9116) 被调用次数（非远程也必须 >0——排空防 Busy 锁机身快门）
    this.hangGetEvent = false;       // r46：模拟真机 GetEvent 挂起（无应答，读端等到超时）
    this.hangStorage = false;        // r47：模拟真机标准 PTP 存储命令挂起（0x1004/0x1006/0x1007 无应答）
    this.getNumObjectsCalls = 0;     // r48：守卫——轮询绝不允许再调 0x1006（真机回 0x201d）
  }
  /** 模拟相机把标准 PTP 事件（type=4 容器）发到中断IN端点——非远程模式 5D2 的 ObjectAdded 通道 */
  pushIntrEvent(buf) {
    this.intrEvents.push(buf);
    if (this._intrWait) {
      const w = this._intrWait;
      this._intrWait = null;
      const ev = this.intrEvents.shift();
      w({ status: 'ok', data: copyBuf(ev) });
    }
  }
  /** r45：模拟拍卡——卡上新增一个对象（GetObjectHandles 句柄集 +1；r48 起计数通道已废弃） */
  pushStoredObject(handle) {
    this.store.push(handle);
  }
  handleWrite(buf) {
    if (buf.length < 12) throw new Error('mock: 包过短');
    const code = buf.readUInt16LE(6);
    const tid = buf.readUInt32LE(8);
    const len = buf.readUInt32LE(0);
    const params = [];
    for (let o = 12; o + 4 <= len; o += 4) params.push(buf.readUInt32LE(o));
    this.log.push({ code, params, tid });
    const replies = this._answer(code, tid, params);
    for (const r of replies) this.stream = Buffer.concat([this.stream, r]);
  }
  _answer(code, tid, params) {
    switch (code) {
      case OC.OPEN_SESSION:
        this.sessionId = params[0];
        return [pkt(3, RC.OK, tid)];
      case OC.GET_DEVICE_INFO: {
        const b = [];
        b.push(...u16(100), ...u32(0x0B), ...u16(100));            // ver + Canon ext + ver
        b.push(...strBytes16('microsoft.com: 1.0;'));
        b.push(...u16(0));                                          // FunctionalMode
        b.push(...u32(1), ...u16(0x9128));                          // Operations
        b.push(...u32(1), ...u16(EV.OBJECT_ADDED_EX));              // Events
        b.push(...u32(0));
        b.push(...u32(1), ...u16(0x3801));
        b.push(...u32(1), ...u16(0x3801));
        b.push(...strBytes16('Canon Inc.'));
        b.push(...strBytes16('Canon EOS 5D Mark II'));
        b.push(...strBytes16('2.1.2'));
        b.push(...strBytes16('mock-5d2-serial'));
        return [pkt(2, OC.GET_DEVICE_INFO, tid, b), pkt(3, RC.OK, tid)];
      }
      case OC.SET_DEVICE_PROP_VALUE:
        if (params[0] === DPC.CAPTURE_DESTINATION) this.captureDestination = params[1] || 1;
        return [pkt(3, RC.OK, tid)];
      case OC.EOS_SET_REMOTE_MODE: this.remoteMode = 1; return [pkt(3, RC.OK, tid)];
      case OC.EOS_SET_EVENT_MODE: this.eventMode = 1; return [pkt(3, RC.OK, tid)];
      case OC.EOS_GET_EVENT:
        this.getEventCalls = (this.getEventCalls || 0) + 1;
        if (this.hangGetEvent) return []; // r46：挂起——无任何应答，传输层读端空读转圈直到超时
        return [pkt(2, OC.EOS_GET_EVENT, tid, u32(8).concat(u32(0))), pkt(3, RC.OK, tid)]; // 空事件链
      case OC.EOS_KEEP_DEVICE_ON:
        this.keepDeviceOnCalls = (this.keepDeviceOnCalls || 0) + 1;
        if (this.rejectKeepDeviceOn) return [pkt(3, 0x2002, tid)]; // 模拟非远程模式拒绝（PTP 错误，非断开）
        return [pkt(3, RC.OK, tid)];
      case OC.GET_STORAGE_IDS: // 保活降级兜底：0x1004 应答一张 CF 卡
        this.getStorageIdsCalls = (this.getStorageIdsCalls || 0) + 1;
        if (this.hangStorage) return []; // r47：挂起——无应答 → 读端空读转圈到短超时
        return [pkt(2, OC.GET_STORAGE_IDS, tid, u32(1).concat(u32(0x00010001))), pkt(3, RC.OK, tid)];
      case OC.GET_NUM_OBJECTS: // r48：真机 5D2 对 0x1006 回 0x201d（EOS 不支持该命令）——守卫轮询不再用它
        this.getNumObjectsCalls = (this.getNumObjectsCalls || 0) + 1;
        return [pkt(3, 0x201d, tid)];
      case OC.GET_OBJECT_HANDLES: { // r45 轮询兜底：句柄枚举
        if (this.hangStorage) return []; // r47：挂起
        const hb = [];
        for (const h of this.store) hb.push(...u32(h));
        return [pkt(2, OC.GET_OBJECT_HANDLES, tid, hb), pkt(3, RC.OK, tid)];
      }
      case 0x1008: { // GET_OBJECT_INFO：标准 ObjectAdded 事件缺 storageId 时 _resolveStdObject 用它补齐
        const b = [];
        b.push(...u32(0x00010001), ...u16(0x3801), ...u16(0)); // StorageID=CF / ObjectFormat=JPEG / Protection
        b.push(...u32(0x12345));                                // CompressedSize
        b.push(...u16(0), ...u32(0), ...u32(0), ...u32(0));     // Thumb 区
        b.push(...u32(4000), ...u32(3000), ...u32(24));         // 图像尺寸/位深
        b.push(...u32(0), ...u16(0), ...u32(0), ...u32(0));     // Parent/Assoc/Sequence
        return [pkt(2, 0x1008, tid, b), pkt(3, RC.OK, tid)];
      }
      default: return [pkt(3, 0x2002, tid)];
    }
  }
  /** 读一块（512 对齐切分，模拟 USB bulk；队列空 → null=空读/ZLP） */
  readChunk(maxLen) {
    if (!this.stream.length) return null;
    const n = Math.min(maxLen, this.stream.length);
    const out = this.stream.subarray(0, n);
    this.stream = this.stream.subarray(n);
    return out;
  }
}

/* ---------- mock USBDevice（WebUSB spec 形状） ---------- */
function makeUsbDevice(camera, opts) {
  opts = opts || {};
  return {
    vendorId: 0x04A9, productId: 0x3199,
    productName: 'Canon EOS 5D Mark II', serialNumber: opts.noSerial ? '' : (opts.serial || 'mock-5d2'),
    opened: false,
    _halts: [],
    configurations: [{
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0, interfaceClass: 6,
        alternates: [{ endpoints: [
          { endpointNumber: 1, type: 'bulk', direction: 'in', packetSize: 512 },
          { endpointNumber: 2, type: 'bulk', direction: 'out', packetSize: 512 },
          ...(opts.noIntr ? [] : [{ endpointNumber: 3, type: 'interrupt', direction: 'in', packetSize: 16 }])
        ] }]
      }]
    }],
    open() { this.opened = true; return Promise.resolve(); },
    selectConfiguration(v) {
      this._cfg = v;
      this.configuration = this.configurations.find(c => c.configurationValue === v) || null;
      return Promise.resolve();
    },
    claimInterface(n) { this._claimed = n; return Promise.resolve(); },
    releaseInterface() { return Promise.resolve(); },
    controlTransferOut() { return Promise.resolve({ status: 'ok' }); },
    clearHalt(dir, ep) { this._halts.push(dir + ':' + ep); return Promise.resolve(); },
    transferOut(epNum, data) {
      if (opts.writeZero) return Promise.resolve({ status: 'ok', bytesWritten: 0 }); // 假成功模拟
      camera.handleWrite(Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength));
      return Promise.resolve({ status: 'ok', bytesWritten: data.byteLength });
    },
    transferIn(epNum, len) {
      // 中断端点（标准 PTP 事件通道）：事件未到则挂起（常驻读语义），pushIntrEvent 时解挂
      if (epNum === 3) {
        if (camera.intrEvents.length) {
          const ev = camera.intrEvents.shift();
          return Promise.resolve({ status: 'ok', data: copyBuf(ev) });
        }
        return new Promise(resolve => { camera._intrWait = resolve; });
      }
      if (camera.stallNextIn > 0) {
        camera.stallNextIn--;
        return Promise.resolve({ status: 'stall' });
      }
      const chunk = camera.readChunk(len);
      if (chunk === null && camera.delayMs > 0) {
        // 模拟设备延迟：稍后再读（首次空读 → ZLP 容忍路径）
        return new Promise(resolve => setTimeout(() => {
          const c2 = camera.readChunk(len);
          resolve(c2 === null
            ? { status: 'ok', data: new DataView(new ArrayBuffer(0)) }
            : { status: 'ok', data: copyBuf(c2) });
        }, camera.delayMs));
      }
      return Promise.resolve(chunk === null
        ? { status: 'ok', data: new DataView(new ArrayBuffer(0)) }
        : { status: 'ok', data: copyBuf(chunk) });
    },
    close() { this.opened = false; return Promise.resolve(); }
  };
}
/* r43 回归修复：真实 WebUSB 的 transferIn 返回 { data: DataView }（不是 ArrayBuffer！）。
 * 旧 mock 返回 ArrayBuffer 导致 `new Uint8Array(ArrayBuffer)` 正常、测试全绿，
 * 而真机 `new Uint8Array(DataView)` 静默返回空数组——bug 全被 mock 放跑。
 * 现在 mock 与 Chrome 一致：data 为 DataView（可带 byteOffset），transport 必须正确取视图。 */
function copyBuf(b) {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  return new DataView(out, 0, out.byteLength);
}

/* ---------- 加载被测代码（先设 navigator 环境再 require） ---------- */
function loadModule(env) {
  // 清理环境（互斥测试用）+ 清 require 缓存（否则 IIFE 不重新执行）
  delete global.navigator;
  delete global.plus;
  delete global.UsbTether;
  global.navigator = env.navigator;
  if (env.plus) global.plus = env.plus;
  delete require.cache[require.resolve('../browser-usb-transport.js')];
  require('../browser-usb-transport.js');
  return global.UsbTether;
}

async function main() {
  /* ===== 1. 环境判定与互斥 ===== */
  console.log('\n[1] 环境判定（WebUSB 可用 / plus 互斥）');
  const cam1 = new MockUsbCamera();
  const dev1 = makeUsbDevice(cam1);
  const t1 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev1]),
    requestDevice: () => Promise.resolve(dev1)
  } } });
  ok('无 plus + navigator.usb → isSupported()=true', t1 && t1.isSupported());
  ok('webusbMode=true', t1 && t1.webusbMode === true);
  ok('probeByteArray() 返回 webusb 标记', t1 && t1.probeByteArray() === 'webusb');

  const cam2 = new MockUsbCamera();
  const dev2 = makeUsbDevice(cam2);
  const t2 = loadModule({
    plus: { android: {} }, // App web-view 环境
    navigator: { usb: { getDevices: () => Promise.resolve([dev2]), requestDevice: () => Promise.resolve(dev2) } }
  });
  ok('有 plus（App web-view）→ 不接管（isSupported()=false 或未定义）',
    !t2 || !t2.isSupported(), 't2=' + JSON.stringify(t2 && { s: t2.isSupported(), w: t2.webusbMode }));

  /* ===== 2. scan 流程（已授权 / 弹框） ===== */
  console.log('\n[2] scan 流程');
  const cam3 = new MockUsbCamera();
  const dev3 = makeUsbDevice(cam3);
  let requestDeviceCalled = false;
  const t3 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev3]),
    requestDevice: () => { requestDeviceCalled = true; return Promise.resolve(dev3); }
  } } });
  const listed = await t3.get().scan();
  ok('scan 已授权设备 → 列表 1 项', listed.length === 1);
  ok('列表项 isCanon=true（0x04A9）', listed[0].isCanon === true && listed[0].vid === 0x04A9);
  ok('已授权时 requestDevice 不被调', !requestDeviceCalled);
  ok('设备 id 含 vid:pid', /webusb:4a9:3199/.test(listed[0].id), listed[0].id);

  const cam4 = new MockUsbCamera();
  const dev4 = makeUsbDevice(cam4);
  let rq4 = false;
  const t4 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([]),   // 无已授权
    requestDevice: () => { rq4 = true; return Promise.resolve(dev4); }
  } } });
  const listed4 = await t4.get().scan();
  ok('无已授权 → 弹系统授权框（requestDevice 被调）', rq4);
  ok('弹框后返回设备列表 1 项', listed4.length === 1);

  const t5 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([]),
    requestDevice: () => Promise.reject(Object.assign(new Error('cancel'), { name: 'NotFoundError' }))
  } } });
  const listed5 = await t5.get().scan();
  ok('用户取消 → 空列表（不抛错）', Array.isArray(listed5) && listed5.length === 0);

  /* ===== 3. requestConnect → _open → WebUsbTransport ===== */
  console.log('\n[3] requestConnect 连接链路');
  const cam6 = new MockUsbCamera();
  const dev6 = makeUsbDevice(cam6);
  const t6 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev6]),
    requestDevice: () => Promise.resolve(dev6)
  } } });
  const tr6 = await t6.get().requestConnect(listed[0].id);
  ok('连接成功返回 WebUsbTransport', tr6 && typeof tr6.bulkOut === 'function' && typeof tr6.bulkIn === 'function');
  ok('open/claimInterface 执行', dev6.opened === true && dev6._claimed === 0);
  ok('端点锁定（IN=1 OUT=2）', tr6.bulkInEpNum === 1 && tr6.bulkOutEpNum === 2);
  ok('首次连接 0x66/clearHalt 默认不执行（r19：避免 5D2 复位挂死）', dev6._halts.length === 0, dev6._halts.join(','));

  /* ===== 3c. _open 失败路径不抛 TypeError（r21：catch 的 this 绑定） + 非佳能拒绝 ===== */
  console.log('\n[3c] _open 失败友好报错 + 非相机设备拒绝');
  const cam6c = new MockUsbCamera();
  const dev6c = makeUsbDevice(cam6c);
  dev6c.claimInterface = () => Promise.reject(new Error('The requested interface implements a protected class'));
  const t6c = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev6c]),
    requestDevice: () => Promise.resolve(dev6c)
  } } });
  let claimErr = null;
  try {
    await t6c.get().requestConnect('webusb:4a9:3199:mock-5d2');
  } catch (e) {
    claimErr = e && e.message || '';
  }
  ok('claim 失败 → 报 [open:claim] 真实错误（不再 TypeError）',
    /open:claim/.test(claimErr), claimErr);

  const t6d = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([]), // 列表无佳能
    requestDevice: () => Promise.reject(new Error('不应弹框'))
  } } });
  let nonCanonErr = null;
  try {
    await t6d.get().requestConnect('webusb:46d:c539'); // 罗技 HID
  } catch (e) {
    nonCanonErr = e && e.message || '';
  }
  ok('非佳能设备 → 友好拒绝且不弹授权框', /不是佳能/.test(nonCanonErr), nonCanonErr);

  /* ===== 3d. 无序列号设备匹配（r23：serial 空 → ns 标记，requestConnect 能匹配） ===== */
  console.log('\n[3d] 无序列号设备（5D2 实况）匹配');
  const cam6e = new MockUsbCamera();
  const dev6e = makeUsbDevice(cam6e, { noSerial: true });
  const t6e = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev6e]),
    requestDevice: () => { throw new Error('不应弹授权框'); }
  } } });
  const listed6e = await t6e.get().scan();
  ok('scan 返回设备（id 用 ns 标记）', listed6e.length === 1 && /:ns$/.test(listed6e[0].id), JSON.stringify(listed6e[0].id));
  const tr6e = await t6e.get().requestConnect(listed6e[0].id);
  ok('requestConnect 匹配无 serial 设备成功（不弹框）', tr6e && typeof tr6e.bulkOut === 'function');
  tr6e.release();

  /* ===== 3b. 失败后重连（r19：self.device 已 close 时从列表重新匹配） ===== */
  console.log('\n[3b] 连接失败 release 后重连');
  const cam6b = new MockUsbCamera();
  const dev6b = makeUsbDevice(cam6b);
  const t6b = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev6b]),
    requestDevice: () => Promise.resolve(dev6b)
  } } });
  const tr6b1 = await t6b.get().requestConnect('webusb:4a9:3199:mock-5d2');
  tr6b1.release(); // 失败路径：transport 释放（device 被 close）
  const tr6b2 = await t6b.get().requestConnect('webusb:4a9:3199:mock-5d2');
  ok('release 后重连成功（从列表重新匹配并 re-open）', tr6b2 && typeof tr6b2.bulkOut === 'function');
  tr6b2.release();

  /* ===== 4. 协议栈全链路（transport 与 camera-ptp.js 联通） ===== */
  console.log('\n[4] 协议栈联通（openSession → getDeviceInfo → 模式 → 排空 → 保活）');
  const cam7 = new MockUsbCamera();
  cam7.delayMs = 5; // 设备延迟：验证 ZLP 空读容忍
  const dev7 = makeUsbDevice(cam7);
  const t7 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev7]),
    requestDevice: () => Promise.resolve(dev7)
  } } });
  const tr7 = await t7.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera = require('../camera-ptp.js');
  const ptp = new PtpCamera(tr7);
  const info = await ptp.openSession().then(function () { return ptp.getDeviceInfo(); });
  ok('openSession + getDeviceInfo 成功', !!(info && info.model), 'model=' + (info && info.model));
  ok('5D2 model 解析正确', info.model === 'Canon EOS 5D Mark II', 'got=' + info.model);
  await ptp.setRemoteMode();
  await ptp.setEventMode();
  await ptp.drainEosEvents();
  await ptp.setCaptureDestination(1);
  await ptp.keepAlive();
  ok('远程模式/事件模式/排空/设卡/保活 全通过',
    cam7.remoteMode === 1 && cam7.eventMode === 1 && cam7.captureDestination === 1);
  ok('命令序正确（open→info→remote→event→getevent→prop→keep）',
    cam7.log.map(c => c.code.toString(16)).join(',') ===
    '1002,1001,9114,9115,9116,1016,1016,911d', // 0x1016 两条 = 命令包+data 包（mock 对每个写入包记 log）
    cam7.log.map(c => c.code.toString(16)).join(','));
  tr7.release();
  ok('release 后设备关闭', dev7.opened === false);

  /* ===== 5. STALL → clearHalt → 重试 ===== */
  console.log('\n[5] STALL 恢复');
  const cam8 = new MockUsbCamera();
  const dev8 = makeUsbDevice(cam8);
  const t8 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev8]),
    requestDevice: () => Promise.resolve(dev8)
  } } });
  const tr8 = await t8.get().requestConnect('webusb:4a9:3199:mock-5d2');
  // 命令阶段（openSession）的读返回 stall 一次 → clearHalt(in) → 重试成功
  cam8.stallNextIn = 1;
  const ptp8 = new PtpCamera(tr8);
  await ptp8.openSession();
  ok('STALL → clearHalt(in) 被调', dev8._halts.some(h => h === 'in:1'));
  ok('STALL 重试后 openSession 成功', cam8.sessionId > 0);

  /* ===== 6. bulkIn 超时 + stale 机制（r19） ===== */
  console.log('\n[6] bulkIn 超时 → stale 拒绝后续传输');
  const cam9 = new MockUsbCamera();
  const dev9 = makeUsbDevice(cam9);
  const t9 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev9]),
    requestDevice: () => Promise.resolve(dev9)
  } } });
  const tr9 = await t9.get().requestConnect('webusb:4a9:3199:mock-5d2');
  ok('UsbTether.lastError 连接成功时为 null', t9.lastError() === null, JSON.stringify(t9.lastError()));
  cam9.delayMs = 99999; // 相机不响应
  let timedOut = false;
  try {
    await tr9.bulkIn(512, 150); // 150ms 超时
  } catch (e) {
    timedOut = /超时/.test(e && e.message || '');
  }
  ok('150ms 超时 reject（相机无响应）', timedOut);
  let staleRejected = false;
  try {
    await tr9.bulkIn(512, 300);
  } catch (e) {
    staleRejected = /超时|连接/.test(e && e.message || '');
  }
  ok('超时后管道置 stale → 后续 bulkIn 拒绝提示重连', staleRejected);
  const diag9 = tr9.diagInfo();
  ok('diagInfo 输出超时次数/stale 标记', diag9.timeouts >= 1 && diag9.stale === true && diag9.timeouts === 1,
    JSON.stringify(diag9));
  ok('diagInfo 记录 lastErr=超时', /超时/.test(diag9.lastErr || ''), diag9.lastErr);
  tr9.release();
  ok('release 后 stale 清除', tr9.diagInfo().stale === false);

  /* ===== 7. bytesWritten=0 假成功拦截（r19） ===== */
  console.log('\n[7] bulkOut 写 0 字节拦截');
  const cam10 = new MockUsbCamera();
  const dev10 = makeUsbDevice(cam10, { writeZero: true });
  const t10 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev10]),
    requestDevice: () => Promise.resolve(dev10)
  } } });
  const tr10 = await t10.get().requestConnect('webusb:4a9:3199:mock-5d2');
  let zeroRejected = false;
  try {
    await tr10.bulkOut(new Uint8Array(12), 500);
  } catch (e) {
    zeroRejected = /0 字节/.test(e && e.message || '');
  }
  ok('bytesWritten=0 → 报「写入 0 字节」', zeroRejected);
  ok('diagInfo 记录 lastOutBytes=0', tr10.diagInfo().lastOutBytes === 0);
  tr10.release();

  /* ===== 8. 0x66 默认不执行（r19：避免 5D2 复位挂死） ===== */
  console.log('\n[8] 0x66 Device Reset 默认关闭');
  const cam11 = new MockUsbCamera();
  const dev11 = makeUsbDevice(cam11);
  const t11 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev11]),
    requestDevice: () => Promise.resolve(dev11)
  } } });
  let ctrl66Called = false;
  dev11.controlTransferOut = (opts) => { if (opts && opts.request === 0x66) ctrl66Called = true; return Promise.resolve({ status: 'ok' }); };
  const tr11 = await t11.get().requestConnect('webusb:4a9:3199:mock-5d2');
  ok('首次连接 0x66 不被调用（避免复位设备）', !ctrl66Called);
  ok('首次连接 clearHalt 也不调用', dev11._halts.length === 0, dev11._halts.join(','));
  tr11.release();

  /* ===== 9. 中断端点识别（r44：标准 PTP 事件通道） ===== */
  console.log('\n[9] 中断端点识别');
  const cam12 = new MockUsbCamera();
  const dev12 = makeUsbDevice(cam12);
  const t12 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev12]),
    requestDevice: () => Promise.resolve(dev12)
  } } });
  const tr12 = await t12.get().requestConnect('webusb:4a9:3199:mock-5d2');
  ok('候选含中断IN端点（intrInEpNum=3）', tr12.intrInEpNum === 3, 'got=' + tr12.intrInEpNum);
  ok('diagInfo 暴露 epIntr=3 / evtReader=false', tr12.diagInfo().epIntr === 3 && tr12.diagInfo().evtReader === false,
    JSON.stringify(tr12.diagInfo()));
  const cands12 = await t12.describeCandidates();
  ok('candidatesInfo 标注中断端点', /intr|中断/.test(JSON.stringify(cands12) || ''), JSON.stringify(cands12));
  tr12.release();

  /* ===== 10. 中断端点事件 → waitForObject 双通道（r44 主导修复） ===== */
  console.log('\n[10] 中断事件(0x4002)经 startEvents → waitForObject 消费');
  const cam13 = new MockUsbCamera();
  const dev13 = makeUsbDevice(cam13);
  const t13 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev13]),
    requestDevice: () => Promise.resolve(dev13)
  } } });
  const tr13 = await t13.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera13 = require('../camera-ptp.js');
  const ptp13 = new PtpCamera13(tr13);
  await ptp13.openSession();
  await ptp13.getDeviceInfo();
  await ptp13.setEventMode();
  ptp13.startEvents();                       // 启动常驻中断读（模拟 5D2 非远程模式主通道）
  ok('startEvents 后 evtReader 激活', tr13.diagInfo().evtReader === true);
  const wait13 = ptp13.waitForObject(5000);
  setTimeout(() => cam13.pushIntrEvent(intrPkt(0x4002, [0x100, 0x00010001])), 100); // handle=0x100, StorageID=CF
  const obj13 = await wait13;
  ok('waitForObject 拿到标准 ObjectAdded', obj13 && obj13.objectId === 0x100 && obj13.storageId === 0x00010001,
    JSON.stringify(obj13));
  ok('事件来源标注为中断端点', obj13.source === '中断端点(0x4002)', obj13.source);
  ok('中断端点收到字节被记录', tr13.diagInfo().intrInBytes > 0, 'bytes=' + tr13.diagInfo().intrInBytes);
  ptp13.stopEvents();
  tr13.release();

  /* ===== 11. 标准事件缺 storageId → GetObjectInfo(0x1008) 补齐 + 无中断端点降级 ===== */
  console.log('\n[11] ObjectAdded 缺 storageId 补齐 + 无中断端点降级');
  const cam14 = new MockUsbCamera();
  const dev14 = makeUsbDevice(cam14);
  const t14 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev14]),
    requestDevice: () => Promise.resolve(dev14)
  } } });
  const tr14 = await t14.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera14 = require('../camera-ptp.js');
  const ptp14 = new PtpCamera14(tr14);
  await ptp14.openSession();
  await ptp14.getDeviceInfo();
  ptp14.startEvents();
  const wait14 = ptp14.waitForObject(5000);
  setTimeout(() => cam14.pushIntrEvent(intrPkt(0x4002, [0x200])), 100); // 仅 handle，无 storageId
  const obj14 = await wait14;
  ok('缺 storageId → GetObjectInfo 补齐（storageId=CF, size=0x12345）',
    obj14 && obj14.objectId === 0x200 && obj14.storageId === 0x00010001 && obj14.size === 0x12345,
    JSON.stringify(obj14));
  ptp14.stopEvents();
  tr14.release();

  // 无中断端点的接口：startEvents 不崩溃，onEventError 收到降级提示
  const cam15 = new MockUsbCamera();
  const dev15 = makeUsbDevice(cam15, { noIntr: true });
  const t15 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev15]),
    requestDevice: () => Promise.resolve(dev15)
  } } });
  const tr15 = await t15.get().requestConnect('webusb:4a9:3199:mock-5d2');
  ok('无中断端点 → intrInEpNum=null', tr15.intrInEpNum === null);
  const PtpCamera15 = require('../camera-ptp.js');
  const ptp15 = new PtpCamera15(tr15);
  await ptp15.openSession();
  let intrErrMsg = null;
  ptp15.onEventError(function (e) { intrErrMsg = (e && e.message) || String(e); });
  ptp15.startEvents();
  ok('无中断端点 → 不崩溃且报降级', /无中断IN端点/.test(intrErrMsg || ''), intrErrMsg);
  ptp15.stopEvents();
  tr15.release();

  // [12] 保活降级：5D2 非远程模式拒 0x911D（PTP 错误）→ 自动改走 0x1004 保持总线活动
  const cam16 = new MockUsbCamera();
  cam16.rejectKeepDeviceOn = true;
  const dev16 = makeUsbDevice(cam16, {});
  const t16 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev16]),
    requestDevice: () => Promise.resolve(dev16)
  } } });
  const tr16 = await t16.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera16 = require('../camera-ptp.js');
  const ptp16 = new PtpCamera16(tr16);
  await ptp16.openSession();
  await ptp16.keepAlive();   // 第一次：0x911D 被拒 → 降级 0x1004 成功
  ok('0x911D 被拒 → 降级 0x1004 保活成功',
    ptp16._keepAliveUseFallback === true && cam16.keepDeviceOnCalls === 1 && cam16.getStorageIdsCalls === 1,
    'keepDeviceOn=' + cam16.keepDeviceOnCalls + ' storageIds=' + cam16.getStorageIdsCalls);
  await ptp16.keepAlive();   // 第二次：不再重试 0x911D，直接走 0x1004
  ok('再次保活直接走 0x1004（不重试 0x911D）',
    cam16.keepDeviceOnCalls === 1 && cam16.getStorageIdsCalls === 2,
    'keepDeviceOn=' + cam16.keepDeviceOnCalls + ' storageIds=' + cam16.getStorageIdsCalls);
  tr16.release();

  /* ===== 13. r45 轮询兜底：无任何事件通道也能发现新照片（r48 起纯 GetObjectHandles 句柄差集） ===== */
  console.log('\n[13] 无事件 → 轮询兜底检测新照片（纯 GetObjectHandles，0x1006 永不调用）');
  const cam17 = new MockUsbCamera();
  const dev17 = makeUsbDevice(cam17, {});
  const t17 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev17]),
    requestDevice: () => Promise.resolve(dev17)
  } } });
  const tr17 = await t17.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera17 = require('../camera-ptp.js');
  const ptp17 = new PtpCamera17(tr17);
  await ptp17.openSession();
  await ptp17.getDeviceInfo();
  // 不启动中断事件监听：模拟真机「中断端点不产生事件 / 该接口无中断端点」的失败情形
  const wait17 = ptp17.waitForObject(9000);
  setTimeout(() => cam17.pushStoredObject(0x456), 800); // 800ms 后卡上多一张
  const obj17 = await wait17;
  ok('无事件 → 轮询兜底发现新照片（objectId=0x456, source=轮询(GetObjectHandles)）',
    obj17 && obj17.objectId === 0x456 && /轮询\(GetObjectHandles\)/.test(obj17.source || ''),
    JSON.stringify(obj17));
  ok('r48：轮询全程未调用 GetNumObjects(0x1006)（getNumObjectsCalls=0）',
    cam17.getNumObjectsCalls === 0, 'getNumObjectsCalls=' + cam17.getNumObjectsCalls);
  ptp17.stopEvents();
  tr17.release();

  /* ===== 14. r50 回归：非远程模式也轮询 GetEvent 排空（锁机身快门根因）；挂起也不拖死轮询兜底 ===== */
  console.log('\n[14] r50：非远程也 GetEvent 排空 + 挂起不拖死轮询（锁快门根因）');
  const cam18 = new MockUsbCamera();
  cam18.hangGetEvent = true; // 0x9116 无应答 = 挂起（2s 短超时后继续，不得拖死轮询兜底）
  const dev18 = makeUsbDevice(cam18);
  const t18 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev18]),
    requestDevice: () => Promise.resolve(dev18)
  } } });
  const tr18 = await t18.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera18 = require('../camera-ptp.js');
  const ptp18 = new PtpCamera18(tr18);
  await ptp18.openSession();
  await ptp18.getDeviceInfo();
  const diags = [];
  ptp18.onDiag((m) => diags.push(m));
  const wait18 = ptp18.waitForObject(9000); // 默认非远程
  setTimeout(() => cam18.pushStoredObject(0x789), 800); // 800ms 后卡上多一张
  const obj18 = await wait18;
  ok('GetEvent 挂起 + 非远程 → 轮询仍检测到新照片（objectId=0x789）',
    obj18 && obj18.objectId === 0x789 && /轮询/.test(obj18.source || ''),
    JSON.stringify(obj18));
  ok('r50 非远程 waitForObject 也轮询 GetEvent(0x9116) 排空（getEventCalls>0，r46/r49 曾为 0 → 锁快门）',
    cam18.getEventCalls > 0, 'getEventCalls=' + cam18.getEventCalls);
  ok('诊断含「轮询基线」（GetEvent 挂起被 2s 短超时兜住，未拖死）',
    diags.some((m) => /轮询基线/.test(m)),
    JSON.stringify(diags));
  ptp18.stopEvents();
  tr18.release();

  /* ===== 15. r47 回归：存储枚举挂起 → 3s 探测失败即关闭轮询兜底，中断事件通道仍检测 ===== */
  console.log('\n[15] r47：存储挂起 → 探测关轮询，中断事件仍检测');
  const cam19 = new MockUsbCamera();
  cam19.hangStorage = true; // 0x1004/0x1006/0x1007 无应答（r46 真机：0x1004 挂 20s 毒化管道）
  const dev19 = makeUsbDevice(cam19);
  const t19 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev19]),
    requestDevice: () => Promise.resolve(dev19)
  } } });
  const tr19 = await t19.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera19 = require('../camera-ptp.js');
  const ptp19 = new PtpCamera19(tr19);
  await ptp19.openSession();
  await ptp19.getDeviceInfo();
  const diags19 = [];
  ptp19.onDiag((m) => diags19.push(m));
  ptp19.startEvents(); // 存储挂起时唯一的检测通道 = 中断端点
  const wait19 = ptp19.waitForObject(12000); // 默认非远程
  setTimeout(() => cam19.pushIntrEvent(intrPkt(0x4002, [0x9AB, 0x00010001])), 4500); // 探测 3s 失败后再来事件
  const obj19 = await wait19;
  ok('存储挂起 → 探测失败关轮询后，中断事件(0x4002)仍检测到（objectId=0x9AB, source=中断端点）',
    obj19 && obj19.objectId === 0x9AB && obj19.source === '中断端点(0x4002)',
    JSON.stringify(obj19));
  ok('存储挂起 → 轮询兜底被关闭（_storageOk=false）',
    ptp19._storageOk === false, '_storageOk=' + ptp19._storageOk);
  ok('诊断含「关闭轮询兜底」',
    diags19.some((m) => /关闭轮询/.test(m)), JSON.stringify(diags19));
  ptp19.stopEvents();
  tr19.release();

  /* ===== 16. r50 回归：非远程模式 drainEosEvents 也排空 GetEvent（锁机身快门根因） ===== */
  console.log('\n[16] r50：非远程也 GetEvent 排空，远程照常排空');
  const cam20 = new MockUsbCamera();
  const dev20 = makeUsbDevice(cam20);
  const t20 = loadModule({ navigator: { usb: {
    getDevices: () => Promise.resolve([dev20]),
    requestDevice: () => Promise.resolve(dev20)
  } } });
  const tr20 = await t20.get().requestConnect('webusb:4a9:3199:mock-5d2');
  const PtpCamera20 = require('../camera-ptp.js');
  const ptp20 = new PtpCamera20(tr20);
  await ptp20.openSession();
  await ptp20.getDeviceInfo();
  await ptp20.setEventMode();               // 非远程：setRemoteMode 未调 → _remoteMode 非 true
  await ptp20.drainEosEvents(8);
  ok('r50 非远程 drainEosEvents 排空 → GetEvent 有调用（r49 曾跳过=0 → 锁机身快门）',
    cam20.getEventCalls > 0, 'getEventCalls=' + cam20.getEventCalls);
  await ptp20.setRemoteMode();              // 远程：setRemoteMode 置 _remoteMode=true
  await ptp20.drainEosEvents(8);
  ok('远程 drainEosEvents 正常排空 → GetEvent 有调用',
    cam20.getEventCalls > 1, 'getEventCalls=' + cam20.getEventCalls);
  tr20.release();

  /* ===== 结果 ===== */
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0); // 强制退出：hang 挂起测试的常驻读循环会阻止事件循环自然退出
}

main().catch(function (e) {
  console.error('测试异常:', e && e.stack || e);
  process.exit(1);
});
