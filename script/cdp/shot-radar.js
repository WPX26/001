// Edge CDP：打开 memo-home?radar=1，mock 定位，截图雷达模式实况
const CDP = 'http://127.0.0.1:9222';
const fileUrl = 'http://127.0.0.1:8123/memo-home.html?radar=1';
const outPng = process.argv[2] || 'docs/雷达实况-v2.png';
const LAT = 39.9087, LNG = 116.3975;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  let r = await fetch(CDP + '/json/new?url=' + encodeURIComponent(fileUrl), { method: 'PUT' });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setGeolocationOverride', { latitude: LAT, longitude: LNG, accuracy: 10 });
  await send('Page.navigate', { url: fileUrl });
  await sleep(5000); // 等页面加载
  // 无外网环境：geolocation 授权不可靠 → 页面级 monkey-patch，保证定位回调必触发
  await send('Runtime.evaluate', {
    expression: `(function(){
      if (navigator.geolocation && !navigator.geolocation.__patched) {
        var p = function(){ navigator.geolocation.__patched = true;
          navigator.geolocation.getCurrentPosition = function(success){
            success({ coords: { latitude: ${LAT}, longitude: ${LNG}, accuracy: 10 } });
          };
        }; p();
      }
      return 'patched';
    })()`, returnByValue: true });
  // 退出再进雷达模式 → 触发定位 → 画圈/扇形
  await send('Runtime.evaluate', { expression: `(function(){
    var on = document.querySelector("#phoneScreen").classList.contains("radar-mode");
    if (on) toggleRadarMode();
    setTimeout(function(){ toggleRadarMode(); }, 300);
    return 'reenter';
  })()`, returnByValue: true });
  await sleep(5000); // 等定位 + 圈 + 扇形渲染
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const fs = require('fs');
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存: ' + outPng + ' (' + (shot.data.length / 1024).toFixed(0) + 'KB)');
  ws.close();
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
