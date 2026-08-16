// CDP 驱动：执行 JS 并返回结果
// 用法: node cdp-drive.js <页面ws> <js代码文件或->
const fs = require('fs');
const wsUrl = process.argv[2];
const code = process.argv[3] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(process.argv[3], 'utf8');

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
};

ws.onopen = async () => {
  try {
    await send('Runtime.enable');
    const r = await send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true, userGesture: true,
      returnByValue: true,
      timeout: 60000
    });
    if (r.exceptionDetails) {
      console.log('EXCEPTION:', JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    } else {
      console.log('RESULT:', JSON.stringify(r.result && r.result.value));
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  ws.close();
  process.exit(0);
};
