/* ============================================================
 * script/test-transport-mock.js — usb-transport.js 传输层 Node 冒烟测试
 *
 * 2026-08-16 r14 新增：r13 曾把 ifaceCount 声明误删（真机 [open] ifaceCount
 * is not defined 实锤）——纯 JS 回归 bug 不在协议栈单测范围内。本测试用
 * mock plus.android 桥在 Node 里真跑 requestConnect → 授权 → _open →
 * bulkOut/bulkIn 全流程，把所有 JS 级错误（未定义变量/类型/逻辑）抓在本地。
 *
 * 运行：node script/test-transport-mock.js
 * ============================================================ */
'use strict';
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------- mock 5D2 设备（与真机描述符一致） ---------- */
function make5D2() {
  const ep = (addr, type, dir) => ({
    getType: () => type,
    getDirection: () => dir,
    getAddress: () => addr
  });
  const device = {
    getDeviceName: () => '/dev/bus/usb/001/008',
    getVendorId: () => 0x04A9,
    getProductId: () => 0x3199,
    getSerialNumber: () => null,
    getConfigurationCount: () => 1,
    getConfiguration: () => ({ getId: () => 1 }), // UsbConfiguration 对象（桥可返回对象）
    getInterfaceCount: () => 1,
    getInterface: () => ({
      getInterfaceClass: () => 6, // PTP
      getEndpointCount: () => 3,
      getEndpoint: (j) => [ep(0x81, 2, 0x80), ep(0x02, 2, 0), ep(0x83, 3, 0x80)][j]
    })
  };
  const connection = {
    opened: true,
    getConfiguration: () => 1,          // UsbDeviceConnection.getConfiguration() → int
    setConfiguration: (id) => { connection.setCfg = id; return 0; },
    claimInterface: (iface, force) => true,
    releaseInterface: () => {},
    close: () => { connection.opened = false; },
    controlTransfer: (rt, rq, v, idx, buf, len, t) => 0,
    // 端点参数是 UsbEndpoint 对象（真机语义），按 getAddress() 判断方向。
    // 写方向返回写入字节数；读方向返回一个模拟 PTP 响应头（12 字节，code=0x2001）。
    bulkTransfer: (ep, buf, len, t) => {
      const addr = ep && typeof ep.getAddress === 'function' ? ep.getAddress() : -1;
      if (addr === 0x02) return len;
      if (addr === 0x81) {
        // 12B: length=12, type=3(Response), code=0x2001(OK), tid=1
        const data = [0x0C, 0, 0, 0, 3, 0, 0x01, 0x20, 1, 0, 0, 0];
        const n = Math.min(data.length, len);
        for (let i = 0; i < n; i++) buf[i] = data[i];
        return n;
      }
      return 0;
    }
  };
  return { device, connection };
}

/* ---------- mock plus.android 桥 ---------- */
function makePlus(dev5d2) {
  const objects = {
    'android.content.Intent': () => ({ setPackage: () => {} })
  };
  let connectionRef = null;
  const um = {
    _devices: [dev5d2.device],
    hasPermission: () => true,          // 已授权，跳过弹窗流程
    getDeviceList: () => um,            // 模拟 HashMap
    values: () => um,
    iterator: () => ({ _i: 0, hasNext: function () { return this._i < 1; }, next: function () { this._i++; return dev5d2.device; } }),
    openDevice: () => { connectionRef = dev5d2.connection; return dev5d2.connection; },
    requestPermission: () => {}
  };
  const main = {
    getSystemService: () => um,
    getPackageName: () => 'com.mock.app',
    createPendingResult: () => ({})
  };
  return {
    android: {
      runtimeMainActivity: () => main,
      invoke: (obj, name, ...args) => {
        // 字符串类名 invoke 在此 mock 中不支持（真机也不支持，返回 null 模拟桥语义）
        if (typeof obj === 'string') return null;
        if (obj && typeof obj === 'object' && typeof obj[name] === 'function') {
          // Java 对象方法：返回 this 绑定调用（模拟桥对实例方法的 invoke）
          return obj[name].apply(obj, args);
        }
        // 集合迭代器 hasNext/next 的模拟
        if (obj && obj[name] === undefined && typeof obj === 'function') return obj.apply(obj, args);
        return null;
      },
      newObject: (cls, ...args) => {
        if (objects[cls]) return objects[cls](...args);
        return null;
      },
      implements: () => ({})
    }
  };
}

/* ---------- 运行 ---------- */
async function run() {
  // 载入 usb-transport.js（在 mock 环境里执行）
  const src = fs.readFileSync(path.join(__dirname, '..', 'usb-transport.js'), 'utf8');
  const sandbox = { plus: makePlus(make5D2()), Uint8Array, Array, Promise, Error, Date, Math, JSON, setTimeout, clearInterval, setInterval, console };
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const UsbTether = sandbox.UsbTether;

  console.log('① 环境检测');
  ok('isSupported（有 plus）', !!UsbTether.isSupported());

  console.log('② 设备枚举');
  const list = UsbTether.get().listDevices();
  ok('枚举到 1 台', list.length === 1, '实际: ' + list.length);
  ok('VID/PID 正确', list[0].vid === 0x04A9 && list[0].pid === 0x3199, JSON.stringify(list[0]));

  console.log('③ 连接（授权跳过 → _open 全流程）');
  const transport = await UsbTether.get().requestConnect(list[0].id);
  ok('返回 AndroidTransport', !!transport && typeof transport.bulkOut === 'function');
  ok('ifaceInfo 含接口结构', /class=6/.test(transport.ifaceInfo), transport.ifaceInfo);

  console.log('④ bulk 调用链（写命令 → 读响应）');
  const cmd = new Uint8Array(16); // 模拟 PTP 命令包
  await transport.bulkOut(cmd, 4000);
  ok('bulkOut 成功', true);
  const u8 = await transport.bulkIn(16384, 3000);
  ok('bulkIn 调用链正常（无未定义变量/类型错误）', u8 instanceof Uint8Array, '返回: ' + u8);

  console.log('⑤ 释放');
  transport.release();
  ok('release 不抛错', true);

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

run().catch(e => {
  console.error('测试异常:', e && e.stack || e);
  process.exit(1);
});
