(async () => {
  const out = {};
  try {
    const devs = await navigator.usb.getDevices();
    out.devs = devs.map(d => d.vendorId.toString(16) + ':' + d.productId.toString(16) + ' opened=' + d.opened);
    const dev = devs.find(d => d.vendorId === 0x04A9);
    if (!dev) { out.err = 'no canon'; return out; }
    if (!dev.opened) await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(dev.configurations[0].configurationValue);
    const itf = dev.configuration.interfaces[0];
    out.ifaceClass = itf.interfaceClass;
    out.altCount = (itf.alternates || []).length;
    try { await dev.releaseInterface(itf.interfaceNumber); } catch(e) { out.relErr = e.message; }
    try { await dev.claimInterface(itf.interfaceNumber); out.claim = 'ok'; } catch(e) { out.claim = 'FAIL: ' + e.message; return out; }
    const eps = itf.alternates[0].endpoints;
    const epOut = eps.find(e => e.type === 'bulk' && e.direction === 'out');
    const epIn = eps.find(e => e.type === 'bulk' && e.direction === 'in');
    out.eps = 'out=ep' + epOut.endpointNumber + ' in=ep' + epIn.endpointNumber;
    // OpenSession 命令: length=16 type=1 code=0x1002 tid=0 sessionId=1
    const pkt = new Uint8Array(16);
    const dv = new DataView(pkt.buffer);
    dv.setUint32(0, 16, true); pkt[4]=1; pkt[6]=0x02; pkt[7]=0x10;
    dv.setUint32(12, 1, true);
    const outRes = await dev.transferOut(epOut.endpointNumber, pkt);
    out.outStatus = outRes.status;
    out.outBytes = outRes.bytesWritten;
    const t0 = Date.now();
    const t = setTimeout(() => { out.inTimedOut = true; out.inWaitMs = Date.now() - t0; }, 3000);
    try {
      const res = await dev.transferIn(epIn.endpointNumber, 16384);
      clearTimeout(t);
      out.inStatus = res.status;
      out.inBytes = res.data ? res.data.byteLength : 0;
      out.inWaitMs = Date.now() - t0;
      if (res.data) out.inHex = [...new Uint8Array(res.data).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join(' ');
    } catch(e) { clearTimeout(t); out.inErr = e.message; }
    try { await dev.close(); } catch(e) {}
  } catch (e) { out.fatal = e.message; }
  return out;
})()
