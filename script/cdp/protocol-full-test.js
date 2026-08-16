(async () => {
  const out = {};
  try {
    const devs = await navigator.usb.getDevices();
    const dev = devs.find(d => d.vendorId === 0x04A9);
    if (!dev) { out.err = 'no canon'; return out; }
    if (!dev.opened) await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(dev.configurations[0].configurationValue);
    const itf = dev.configuration.interfaces[0];
    try { await dev.releaseInterface(itf.interfaceNumber); } catch(e) {}
    await dev.claimInterface(itf.interfaceNumber);
    const eps = itf.alternates[0].endpoints;
    const epOut = eps.find(e => e.type === 'bulk' && e.direction === 'out');
    const epIn = eps.find(e => e.type === 'bulk' && e.direction === 'in');
    // 裸传输逻辑包成 transport 接口（与页面 WebUsbTransport 等价）
    const rawTransport = {
      bulkOut: (u8) => dev.transferOut(epOut.endpointNumber, u8).then(r => {
        if (r.status !== 'ok') throw new Error('out:' + r.status);
        if (r.bytesWritten === 0) throw new Error('out:0bytes');
      }),
      bulkIn: (maxLen, timeoutMs) => {
        const size = Math.min(Math.max(maxLen || 512, 512), 16384);
        return dev.transferIn(epIn.endpointNumber, size).then(r => {
          if (r.status !== 'ok') throw new Error('in:' + r.status);
          return r.data ? new Uint8Array(r.data) : new Uint8Array(0);
        });
      },
      release: () => {}
    };
    out.transportReady = true;
    // 页面协议栈 PtpCamera 全链路
    const ptp = new PtpCamera(rawTransport);
    out.stage = 'openSession';
    await ptp.openSession();
    out.stage = 'getDeviceInfo';
    const info = await ptp.getDeviceInfo();
    out.model = info && info.model;
    out.stage = 'remoteMode';
    await ptp.setRemoteMode();
    out.stage = 'eventMode';
    await ptp.setEventMode();
    out.stage = 'drain';
    await ptp.drainEosEvents();
    out.stage = 'captureDest';
    await ptp.setCaptureDestination(1);
    out.stage = 'keepalive';
    await ptp.keepAlive();
    out.allDone = true;
    try { await dev.close(); } catch(e) {}
  } catch (e) { out.failAt = 'fail@' + (out.stage || '?'); out.err = e.message; }
  return out;
})()
