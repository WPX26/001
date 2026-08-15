/**
 * 手机互联前端端到端联调（headless 驱动真实页面 → 真实后端 + 内存 MongoDB）
 * 用法：node scripts/e2e-phonelink-web.js
 *
 * 链路验证：页面点「开始连接手机」→ POST /phonelink/pairs → 工作台显示 6 位码
 *          → WS(role=host) 连接成功（title 上报 code/ws 状态）
 * 覆盖：前端 host 全流程（client 侧流程与后端 capture 透传已由 smoke-phonelink.js 覆盖）
 */
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { attachPhonelinkWS } from '../src/services/phonelink.ws.js';
import { VerificationCode } from '../src/models/index.js';

const { default: app } = await import('../src/app.js');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  attachPhonelinkWS(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  // 注册用户 A（被控端）
  await VerificationCode.create({
    phone: '13800138001',
    scene: 'register',
    code: '123456',
    expiresAt: new Date(Date.now() + 300000),
  });
  const reg = await fetch(base + '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13800138001', code: '123456', password: 'Passw0rd!2026', nickname: 'e2e用户' }),
  }).then((r) => r.json());
  const token = reg.data.token;
  check('前置：用户注册', !!token);

  // 静态服务：前端页面（connect-prototype.html 在项目根，直接用文件服务）
  const pageDir = process.cwd().replace(/\\server$/, '');
  const pageUrl = `http://127.0.0.1:8977/connect-prototype.html?token=${token}&apiBase=${base}/api/v1&mode=phone&autoHost=1`;

  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    check('Edge headless 可用', false, '未找到 msedge.exe');
    process.exit(1);
  }

  const dom = await new Promise((resolve, reject) => {
    const child = spawn(edge, ['--headless', '--disable-gpu', '--virtual-time-budget=12000', '--dump-dom', pageUrl], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => resolve(out));
    child.on('error', reject);
  });

  // 从 title 断言（autoHost 钩子写入：PLH|code=xxxxxx|ws=1|pair=ph_xxx）
  const titleMatch = dom.match(/<title>([^<]*)<\/title>/);
  const t = titleMatch ? titleMatch[1] : '';
  const m = t.match(/PLH\|code=(\d{6})\|ws=(\d+)\|pair=(ph_[0-9a-f]+)/);
  check('前端 host：点击按钮后显示 6 位连接码', !!(m && m[1]), m ? m[1] : t);
  check('前端 host：WebSocket 连接成功（readyState=1）', !!(m && m[2] === '1'), m ? 'ws=' + m[2] : t);
  check('前端 host：返回 pairId', !!(m && m[3]), m ? m[3] : t);

  // 工作台 host 视图可见 + 连接码渲染在页面
  check('前端 host：工作台打开且连接码展示', dom.indexOf('pair-host-view') > -1 && dom.indexOf('等待控制端加入') > -1);

  console.log('\n========== 结果汇总 ==========');
  const failed = results.filter((r) => !r.pass);
  for (const r of results) if (!r.pass) console.log(`  FAIL: ${r.name}`);
  console.log(`PASS ${results.length - failed.length} / ${results.length}${failed.length ? '（失败 ' + failed.length + ' 项）' : '（全部通过）'}`);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('\n[e2e] 异常终止：', err);
  process.exit(1);
} finally {
  if (mongo) await mongo.stop();
}
