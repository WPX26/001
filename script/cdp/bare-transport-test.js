// CDP 裸传输对照实验（会话残留假设验证）——r25 实验版
// 用法：node script/cdp/drive.js <页面ws> script/cdp/bare-transport-test.js
//
// 目标链：裸传输 open/claim → OpenSession(0x1002) 成功 → 不发 CloseSession 直接关 USB
//        （模拟裸实验/页面断开的「会话残留」）→ 重开再 OpenSession
//        → 观察：超时=假设成立 / 0x201E=残留但放行 / 0x2001=无残留（假设证伪）
//        → 发 CloseSession(0x1003) 清理 → 再 OpenSession 验证清理生效。
// 结论判定：
//   phaseC.in.timedOut=true + phaseD.in.timedOut=true → 残留阻塞 OpenSession，假设成立；
//   phaseD.in.codeName='OK' + phaseE.in.codeName='OK' → 页面加「连接前 CloseSession」有效；
//   phaseC.in.codeName='OK' 或 'SESSION_ALREADY_OPEN' → 残留不阻塞，需重新定位。
(async () => {
  const out = {};
  const hex = (u8, n) => (u8 ? [...u8.slice(0, n || 16)].map(b => b.toString(16).padStart(2, '0')).join(' ') : '');
  const codeOf = (u8) => (u8 && u8.length >= 8) ? (u8[6] | (u8[7] << 8)) : -1;
  const codeName = (c) => ({ 0x2001: 'OK', 0x2003: 'SESSION_NOT_OPEN', 0x2004: 'INVALID_TID', 0x2019: 'BUSY', 0x201E: 'SESSION_ALREADY_OPEN' })[c] || ('0x' + c.toString(16));

  function buildCmd(code, params) {
    var n = (params || []).length;
    var pkt = new Uint8Array(12 + n * 4);
    var dv = new DataView(pkt.buffer);
    dv.setUint32(0, 12 + n * 4, true);
    pkt[4] = 1; pkt[5] = 0;
    dv.setUint16(6, code, true);
    dv.setUint32(8, 0, true); // OpenSession 必须 tid=0（gphoto2 语义）
    for (var i = 0; i < n; i++) dv.setUint32(12 + i * 4, params[i], true);
    return pkt;
  }

  function xferOut(dev, ep, pkt, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now(), done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ timedOut: true, waitMs: Date.now() - t0 }); } }, ms);
      dev.transferOut(ep, pkt).then(function (r) {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ status: r.status, bytes: r.bytesWritten, waitMs: Date.now() - t0 });
      }).catch(function (e) {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ err: e.message, waitMs: Date.now() - t0 });
      });
    });
  }
  function xferIn(dev, ep, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now(), done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ timedOut: true, waitMs: Date.now() - t0 }); } }, ms);
      dev.transferIn(ep, 16384).then(function (r) {
        if (done) return; done = true; clearTimeout(timer);
        var u8 = r.data ? new Uint8Array(r.data) : null;
        resolve({ status: r.status, bytes: u8 ? u8.length : 0, hex: hex(u8, 16), code: codeOf(u8), codeName: codeName(codeOf(u8)), waitMs: Date.now() - t0 });
      }).catch(function (e) {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ err: e.message, waitMs: Date.now() - t0 });
      });
    });
  }

  // 打开 + claim，返回端点（close 后可重复调用重开）
  async function openDev(dev, tag) {
    var o = { tag: tag };
    try {
      if (!dev.opened) await dev.open();
      if (!dev.configuration && dev.configurations && dev.configurations.length) {
        await dev.selectConfiguration(dev.configurations[0].configurationValue);
      }
      if (!dev.configuration) { o.err = '无 configuration'; return o; }
      var itf = dev.configuration.interfaces[0];
      o.ifaceClass = itf.interfaceClass;
      try { await dev.releaseInterface(itf.interfaceNumber); } catch (e) { o.relErr = e.message; }
      try { await dev.claimInterface(itf.interfaceNumber); o.claim = 'ok'; }
      catch (e) { o.claim = 'FAIL: ' + e.message; return o; }
      var eps = itf.alternates[0].endpoints;
      o.epOut = eps.find(function (e) { return e.type === 'bulk' && e.direction === 'out'; }).endpointNumber;
      o.epIn = eps.find(function (e) { return e.type === 'bulk' && e.direction === 'in'; }).endpointNumber;
    } catch (e) { o.err = e.message; }
    return o;
  }

  async function openSessionOp(dev, o) {
    var res = {};
    res.out = await xferOut(dev, o.epOut, buildCmd(0x1002, [1]), 3000);
    res.in = await xferIn(dev, o.epIn, 5000);
    return res;
  }

  try {
    var devs = await navigator.usb.getDevices();
    out.devs = devs.map(function (d) { return d.vendorId.toString(16) + ':' + d.productId.toString(16) + ' opened=' + d.opened; });
    var dev = devs.find(function (d) { return d.vendorId === 0x04A9; });
    if (!dev) { out.err = 'no canon'; return out; }

    // 阶段0：首次打开 + claim
    out.open1 = await openDev(dev, 'open1');
    if (!out.open1.claim || out.open1.claim !== 'ok') { out.fatal = '首次 claim 失败（Windows 服务抢占？）——环境问题，不继续'; return out; }

    // 阶段A：OpenSession #1（预期 0x2001 OK）
    out.phaseA = await openSessionOp(dev, out.open1);

    // 阶段B：制造残留——不发 CloseSession 直接关 USB（等价裸实验/页面断开）
    try { await dev.close(); out.phaseB = { closed: true, openedAfter: dev.opened }; }
    catch (e) { out.phaseB = { closedErr: e.message }; }

    // 阶段C：重开 + OpenSession #2（残留下观察：超时=假设成立）
    out.open2 = await openDev(dev, 'open2');
    if (out.open2.claim === 'ok') out.phaseC = await openSessionOp(dev, out.open2);

    // 阶段C 超时后：pending 的 transferIn 会污染后续读——关掉重开再清理
    out.open3 = null;
    if (out.phaseC && out.phaseC.in && out.phaseC.in.timedOut && out.open2.claim === 'ok') {
      try { await dev.close(); } catch (e) {}
      out.open3 = await openDev(dev, 'open3');
    }
    var cur = out.open3 || out.open2;

    // 阶段D：清理——CloseSession(0x1003)（页面修复方案第一步）
    if (cur.claim === 'ok') {
      out.phaseD = {};
      out.phaseD.out = await xferOut(dev, cur.epOut, buildCmd(0x1003, []), 3000);
      out.phaseD.in = await xferIn(dev, cur.epIn, 5000);
    }

    // 阶段E：清理后再 OpenSession（预期 OK → 页面 CloseSession 前置有效）
    if (cur.claim === 'ok' && out.phaseD && out.phaseD.in && out.phaseD.in.code === 0x2001) {
      out.phaseE = await openSessionOp(dev, cur);
    }

    // 收尾：干净关闭
    try { await dev.close(); } catch (e) {}
  } catch (e) { out.fatal = e.message; }
  return out;
})()
