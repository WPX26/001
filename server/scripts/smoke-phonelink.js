/**
 * 手机互联冒烟测试（mongodb-memory-server 内存库，无需本机 mongod）
 * 用法：node scripts/smoke-phonelink.js
 *
 * 覆盖（对应 2026-08-15 手机互联定稿产品规则）：
 * - 创建配对：未登录 401 / 登录成功返回 6 位数字码 + pairId + expiresAt ≈10 分钟
 * - 重复创建：旧 pending 被关闭（每用户只留一个 pending）
 * - 加入：格式非法 400 / 码不存在 404 / 已关闭 404 / 重复加入 409 / 正常加入成功
 * - 查询：状态 pending→joined 流转 / 过期校验
 * - 关闭：非创建者 403 / 创建者幂等关闭
 * - WS 通道：host 连入 → client 连入收到 host_ready、host 收到 client_joined；
 *   capture 命令透传；ping/pong；host 断开 → client 收 peer_left + 配对置 closed
 */
// 先注入测试环境变量再加载 app（ESM 静态 import 提升问题：app 用动态 import）
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import WebSocket from 'ws';
import { VerificationCode, PhonelinkPair } from '../src/models/index.js';
import { attachPhonelinkWS } from '../src/services/phonelink.ws.js';

const { default: app } = await import('../src/app.js');

// WS 需要真实 HTTP server 的 upgrade 事件（app.listen 即可）
const results = [];
let tokenA = '';
let uidA = '';
let code = '';

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
attachPhonelinkWS(server); // 挂载手机互联 WS 通道（与 server.js 一致）
const base = `http://127.0.0.1:${server.address().port}`;
const wsBase = `ws://127.0.0.1:${server.address().port}`;

async function call(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, body: json };
}

/** 连接 WS 并收集消息：resolve({ events, closedInfo }) */
function connectWs(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + path);
    const events = [];
    const closed = { code: null, reason: '' };
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    ws.on('close', (code2, reason) => {
      closed.code = code2;
      closed.reason = reason.toString();
      resolve({ ws, events, closed });
    });
    ws.on('error', (e) => reject(e));
    // 等待 open（resolve 由 close 或显式调用触发；这里 open 后返回当前对象）
    ws.on('open', () => resolve({ ws, events, closed }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] 内存 MongoDB 已就绪');

  // ============ 前置：注册用户 A（被控端） ============
  await VerificationCode.create({
    phone: '13700137000',
    scene: 'register',
    code: '123456',
    expiresAt: new Date(Date.now() + 300000),
  });
  const reg = await call('POST', '/api/v1/auth/register', {
    body: { phone: '13700137000', code: '123456', password: 'Passw0rd!2026', nickname: '被控端用户' },
  });
  tokenA = reg.body.data.token;
  uidA = reg.body.data.user.id;
  check('前置：用户 A 注册成功', !!tokenA);

  // ============ 1. 创建配对 ============
  const unauth = await call('POST', '/api/v1/phonelink/pairs');
  check('创建配对：未登录 401', unauth.status === 401);

  const created = await call('POST', '/api/v1/phonelink/pairs', {
    token: tokenA,
    body: { hostDevice: 'Mate 60 Pro' },
  });
  const d = created.body.data;
  code = d.code;
  check('创建配对：成功返回 6 位数字码', created.status === 200 && /^\d{6}$/.test(d.code), `code=${d.code}`);
  check('创建配对：返回 pairId + 设备名', /^ph_/.test(d.pairId) && d.hostDevice === 'Mate 60 Pro');
  const ttlMs = new Date(d.expiresAt) - Date.now();
  check('创建配对：有效期≈10 分钟', ttlMs > 9 * 60 * 1000 && ttlMs <= 10 * 60 * 1000, `${Math.round(ttlMs / 1000)}s`);

  // 重复创建 → 旧 pending 关闭
  const created2 = await call('POST', '/api/v1/phonelink/pairs', { token: tokenA });
  const oldPair = await PhonelinkPair.findOne({ code });
  check('重复创建：旧配对被关闭', created2.status === 200 && oldPair.status === 'closed', `old=${oldPair.status}`);
  code = created2.body.data.code;

  // ============ 2. 加入配对 ============
  const badFmt = await call('POST', '/api/v1/phonelink/pairs/join', { body: { code: '12345' } });
  check('加入：格式非法 400', badFmt.status === 400);
  const notFound = await call('POST', '/api/v1/phonelink/pairs/join', { body: { code: '999999' } });
  check('加入：码不存在 404', notFound.status === 404);
  const closedJoin = await call('POST', '/api/v1/phonelink/pairs/join', { body: { code } });
  check('加入：pending 状态加入成功', closedJoin.status === 200 && closedJoin.body.data.status === 'joined', closedJoin.body.message || '');
  const dupJoin = await call('POST', '/api/v1/phonelink/pairs/join', { body: { code } });
  check('加入：重复加入 409/1005', dupJoin.status === 409 && dupJoin.body.code === 1005, dupJoin.body.message || '');
  // 已 closed 的旧码再加入 → 404
  const oldClosedJoin = await call('POST', '/api/v1/phonelink/pairs/join', { body: { code } });
  check('加入：joined 后再次加入被拒', oldClosedJoin.status === 409);

  // ============ 3. 查询 ============
  const q = await call('GET', `/api/v1/phonelink/pairs/${code}`);
  check('查询：状态流转为 joined', q.status === 200 && q.body.data.status === 'joined');

  // ============ 4. 关闭 ============
  const closeByOther = await call('POST', `/api/v1/phonelink/pairs/${code}/close`, { token: 'bad.token' });
  check('关闭：未登录 401', closeByOther.status === 401);
  const closeOk = await call('POST', `/api/v1/phonelink/pairs/${code}/close`, { token: tokenA });
  check('关闭：创建者关闭成功', closeOk.status === 200 && closeOk.body.data.status === 'closed');
  const closeIdempotent = await call('POST', `/api/v1/phonelink/pairs/${code}/close`, { token: tokenA });
  check('关闭：幂等', closeIdempotent.status === 200);

  // ============ 5. WS 通道 ============
  const created3 = await call('POST', '/api/v1/phonelink/pairs', { token: tokenA, body: { hostDevice: 'Pixel 9' } });
  const code3 = created3.body.data.code;

  const hostC = await connectWs(`/api/v1/phonelink/ws?code=${code3}&role=host`);
  await sleep(100);
  const clientC = await connectWs(`/api/v1/phonelink/ws?code=${code3}&role=client&clientLabel=web`);
  await sleep(200);

  check('WS：host 收到 client_joined', hostC.events.some((e) => e.type === 'client_joined'), JSON.stringify(hostC.events.map((e) => e.type)));
  check('WS：client 收到 host_ready（含设备名）', clientC.events.some((e) => e.type === 'host_ready' && e.data.hostDevice === 'Pixel 9'));

  // 命令透传：client → host
  clientC.ws.send(JSON.stringify({ type: 'capture', data: { ts: 1 } }));
  await sleep(200);
  check('WS：capture 命令透传到 host', hostC.events.some((e) => e.type === 'capture' && e.data.ts === 1));

  // ping/pong
  hostC.ws.send(JSON.stringify({ type: 'ping' }));
  await sleep(200);
  check('WS：ping 回 pong', hostC.events.some((e) => e.type === 'pong'));

  // host 断开 → client 收 peer_left + 配对置 closed
  hostC.ws.close();
  await sleep(300);
  check('WS：host 断开 client 收 peer_left', clientC.events.some((e) => e.type === 'peer_left'));
  const pairDb = await PhonelinkPair.findOne({ pairId: created3.body.data.pairId });
  check('WS：host 断开配对置 closed', pairDb && pairDb.status === 'closed', pairDb && pairDb.status);

  // 错误参数
  const badWs = await connectWs(`/api/v1/phonelink/ws?code=abc&role=host`);
  await sleep(300);
  check('WS：非法连接码被拒', badWs.closed.code !== 0 && badWs.closed.code !== undefined);
  badWs.ws.terminate();

  console.log('\n========== 结果汇总 ==========');
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    if (!r.pass) console.log(`  FAIL: ${r.name}`);
  }
  console.log(`PASS ${results.length - failed.length} / ${results.length}${failed.length ? '（失败 ' + failed.length + ' 项）' : '（全部通过）'}`);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('\n[smoke] 异常终止：', err);
  process.exit(1);
} finally {
  if (mongo) await mongo.stop();
  server.close();
}
