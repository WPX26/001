// CDP PtpCamera 全链路对照实验 + 会话残留/清理验证 —— r25 实验版
// 用法：node script/cdp/drive.js <页面ws> script/cdp/protocol-full-test.js
//
// ① 与页面 connectDevice 同协议栈全链路：openSession → getDeviceInfo →
//    setRemoteMode → setEventMode → drainEosEvents → setCaptureDestination → keepAlive；
// ② 模拟页面断开（不发 CloseSession 直接关 USB）→ 重开直接 openSession
//    （复现页面「openSession 超时」）→ 失败则走页面修复路径：
//    try CloseSession(0x1003) → 再 openSession；
// ③ 清理仍失败 → 最后手段 0x66 Device Reset（相机可能短暂掉线/需重新授权）。
// 结论判定：
//   chain1.ok=true 且 reopen.openSession='FAIL:…' 且 afterCleanupOpenSession='OK'
//     → 会话残留假设成立，页面「连接前 CloseSession」修复有效；
//   reopen.openSession='OK' → 残留不阻塞（0x201E 放行/自动清），需重新定位；
//   afterCleanupOpenSession 仍 FAIL 且 reset66.afterOpen='OK' → 0x66 兜底有效。
(async () => {
  const out = {};

  function makeTransport(dev, epOut, epIn) {
    return {
      bulkOut: function (u8) {
        return dev.transferOut(epOut, u8).then(function (r) {
          if (r.status !== 'ok') throw new Error('out:' + r.status);
          if (r.bytesWritten === 0) throw new Error('out:0bytes');
        });
      },
      bulkIn: function (maxLen) {
        var size = Math.min(Math.max(maxLen || 512, 512), 16384);
        return dev.transferIn(epIn, size).then(function (r) {
          if (r.status !== 'ok') throw new Error('in:' + r.status);
          return r.data ? new Uint8Array(r.data) : new Uint8Array(0);
        });
      },
      release: function () { try { if (dev.opened) dev.close().catch(function () {}); } catch (e) {} }
    };
  }

  async function openDev(dev) {
    if (!dev.opened) await dev.open();
    if (!dev.configuration && dev.configurations && dev.configurations.length) {
      await dev.selectConfiguration(dev.configurations[0].configurationValue);
    }
    var itf = dev.configuration.interfaces[0];
    try { await dev.releaseInterface(itf.interfaceNumber); } catch (e) {}
    await dev.claimInterface(itf.interfaceNumber);
    var eps = itf.alternates[0].endpoints;
    return {
      epOut: eps.find(function (e) { return e.type === 'bulk' && e.direction === 'out'; }).endpointNumber,
      epIn: eps.find(function (e) { return e.type === 'bulk' && e.direction === 'in'; }).endpointNumber
    };
  }

  // 与页面 connectDevice 相同的全链路
  async function runChain(ptp) {
    var s = {};
    var steps = [
      ['openSession', function () { return ptp.openSession(); }],
      ['getDeviceInfo', function () { return ptp.getDeviceInfo(); }],
      ['setRemoteMode', function () { return ptp.setRemoteMode(); }],
      ['setEventMode', function () { return ptp.setEventMode(); }],
      ['drainEosEvents', function () { return ptp.drainEosEvents(); }],
      ['setCaptureDestination', function () { return ptp.setCaptureDestination(1); }],
      ['keepAlive', function () { return ptp.keepAlive(); }]
    ];
    s.stage = steps[0][0];
    try {
      for (var i = 0; i < steps.length; i++) {
        s.stage = steps[i][0];
        await steps[i][1]();
      }
      s.ok = true;
      s.model = ptp.deviceInfo ? ptp.deviceInfo.model : null;
      s.sessionOpen = ptp.sessionOpen;
    } catch (e) {
      s.ok = false;
      s.err = e.message;
      s.stage = s.stage || '?';
    }
    return s;
  }

  // 0x66 响应读取带 5s 保护（相机卡死时不挂死整轮实验）
  function readIn(dev, ep, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now(), done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ timedOut: true, waitMs: Date.now() - t0 }); } }, ms);
      dev.transferIn(ep, 16384).then(function (r) {
        if (done) return; done = true; clearTimeout(timer);
        var u8 = r.data ? new Uint8Array(r.data) : null;
        resolve({ status: r.status, bytes: u8 ? u8.length : 0, hex: u8 ? [...u8.slice(0, 16)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join(' ') : '', waitMs: Date.now() - t0 });
      }).catch(function (e) {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ err: e.message, waitMs: Date.now() - t0 });
      });
    });
  }

  try {
    var devs = await navigator.usb.getDevices();
    var dev = devs.find(function (d) { return d.vendorId === 0x04A9; });
    if (!dev) { out.err = 'no canon'; return out; }

    // ① 全链路（CDP 环境跑页面同款协议栈）
    var eps1 = await openDev(dev);
    var ptp1 = new PtpCamera(makeTransport(dev, eps1.epOut, eps1.epIn));
    out.chain1 = await runChain(ptp1);
    if (!out.chain1.ok) {
      out.abort = '全链路失败，先解决该失败（见 chain1.stage/err）——与页面同源问题';
      try { await dev.close(); } catch (e) {}
      return out;
    }

    // ② 模拟页面断开：不发 CloseSession 直接关 USB（会话残留来源）
    try { await dev.close(); out.simulateDisconnect = { closed: true }; }
    catch (e) { out.simulateDisconnect = { closedErr: e.message }; }

    // ③ 重开：等价页面再次 requestConnect 后直接 openSession（复现页面路径）
    var eps2 = await openDev(dev);
    var ptp2 = new PtpCamera(makeTransport(dev, eps2.epOut, eps2.epIn));
    out.reopen = {};
    try {
      await ptp2.openSession();
      out.reopen.openSession = 'OK（残留未阻塞：0x201E 放行或会话已自动清）';
    } catch (e) {
      out.reopen.openSession = 'FAIL: ' + e.message + (e.code ? ' (code=0x' + e.code.toString(16) + ')' : '');
      // ④ 页面修复路径 A：连接前 try CloseSession(0x1003)
      try {
        await ptp2.closeSession();
        out.reopen.cleanupCloseSession = 'OK';
      } catch (e2) {
        out.reopen.cleanupCloseSession = 'FAIL(忽略): ' + e2.message;
      }
      // ⑤ 页面修复路径 B：清理后再 openSession
      try {
        await ptp2.openSession();
        out.reopen.afterCleanupOpenSession = 'OK（会话清理生效）';
      } catch (e3) {
        out.reopen.afterCleanupOpenSession = 'FAIL: ' + e3.message;
        // ⑥ 最后手段：0x66 Device Reset（相机可能短暂掉线/需重新授权）
        out.reset66 = {};
        try {
          var pkt = new Uint8Array(12);
          var dv = new DataView(pkt.buffer);
          dv.setUint32(0, 12, true); pkt[4] = 1; dv.setUint16(6, 0x0066, true); dv.setUint32(8, 0, true);
          var ro = await dev.transferOut(eps2.epOut, pkt);
          out.reset66.out = { status: ro.status, bytes: ro.bytesWritten };
          out.reset66.in = await readIn(dev, eps2.epIn, 5000);
        } catch (e4) { out.reset66.err = e4.message; }
        // 0x66 后尝试重开（相机可能掉线；掉线则需重新授权/插拔）
        try { await dev.close(); } catch (e) {}
        try {
          var eps3 = await openDev(dev);
          var ptp3 = new PtpCamera(makeTransport(dev, eps3.epOut, eps3.epIn));
          try { await ptp3.openSession(); out.reset66.afterOpen = 'OK（0x66 生效）'; }
          catch (e5) { out.reset66.afterOpen = 'FAIL: ' + e5.message; }
        } catch (e6) {
          out.reset66.reopenErr = e6.message + '（相机可能已掉线，需重新授权/插拔）';
        }
      }
    }

    // 收尾：尽量干净
    try { if (ptp2 && ptp2.sessionOpen) await ptp2.closeSession().catch(function () {}); } catch (e) {}
    try { await dev.close(); } catch (e) {}
    out.allDone = true;
  } catch (e) { out.fatal = e.message; }
  return out;
})()
