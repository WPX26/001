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
const OC = { OPEN_SESSION: 0x1002, GET_DEVICE_INFO: 0x1001,
  SET_DEVICE_PROP_VALUE: 0x1016, EOS_SET_REMOTE_MODE: 0x9114,
  EOS_SET_EVENT_MODE: 0x9115, EOS_GET_EVENT: 0x9116, EOS_KEEP_DEVICE_ON: 0x911D };
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
        return [pkt(2, OC.EOS_GET_EVENT, tid, u32(8).concat(u32(0))), pkt(3, RC.OK, tid)]; // 空事件链
      case OC.EOS_KEEP_DEVICE_ON: return [pkt(3, RC.OK, tid)];
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
    productName: 'Canon EOS 5D Mark II', serialNumber: opts.serial || 'mock-5d2',
    opened: false,
    _halts: [],
    configurations: [{
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0, interfaceClass: 6,
        alternates: [{ endpoints: [
          { endpointNumber: 1, type: 'bulk', direction: 'in', packetSize: 512 },
          { endpointNumber: 2, type: 'bulk', direction: 'out', packetSize: 512 },
          { endpointNumber: 3, type: 'interrupt', direction: 'in', packetSize: 16 }
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
            ? { status: 'ok', data: new ArrayBuffer(0) }
            : { status: 'ok', data: copyBuf(c2) });
        }, camera.delayMs));
      }
      return Promise.resolve(chunk === null
        ? { status: 'ok', data: new ArrayBuffer(0) }
        : { status: 'ok', data: copyBuf(chunk) });
    },
    close() { this.opened = false; return Promise.resolve(); }
  };
}
function copyBuf(b) {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  return out;
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
    staleRejected = /变脏|重连/.test(e && e.message || '');
  }
  ok('超时后管道置 stale → 后续 bulkIn 拒绝提示重连', staleRejected);
  const diag9 = tr9.diagInfo();
  ok('diagInfo 输出超时次数/stale 标记', diag9.timeouts >= 1 && diag9.stale === true && diag9.timeouts === 1,
    JSON.stringify(diag9));
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

  /* ===== 结果 ===== */
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  if (failed) process.exit(1);
}

main().catch(function (e) {
  console.error('测试异常:', e && e.stack || e);
  process.exit(1);
});
