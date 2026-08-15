/**
 * 相机互联冒烟测试（真实检测：云端扫描返回空列表为真实结果；connect 未检测到 → 404）
 * 用法：node scripts/smoke-tether.js
 */
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const { default: app } = await import('../src/app.js');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

  // detect：真实扫描（云端/测试环境无相机 → 空列表，真实结果）+ 结构校验
  const d = await call('POST', '/api/v1/tether/detect', { type: 'wireless' });
  check('detect：200 + cameras 数组', d.status === 200 && Array.isArray(d.body.data.cameras));
  check('detect：capability 标注', d.body.data.capability === 'cloud');
  const dBad = await call('POST', '/api/v1/tether/detect', { type: 'bluetooth' });
  check('detect：非法 type 400', dBad.status === 400);

  // connect：未检测到相机 → 真实 404
  const c = await call('POST', '/api/v1/tether/connect', { cameraId: 'cam_1_2_3_4', connectionType: 'wireless' });
  check('connect：未检测到相机 404（真实）', c.status === 404, c.body.message || '');
  const cNoId = await call('POST', '/api/v1/tether/connect', {});
  check('connect：缺 cameraId 400', cNoId.status === 400);

  // disconnect：幂等
  const disc = await call('POST', '/api/v1/tether/disconnect', { sessionId: 'sess_x' });
  check('disconnect：幂等 200', disc.status === 200 && disc.body.data.status === 'disconnected');

  console.log('\n========== 结果汇总 ==========');
  const failed = results.filter((r) => !r.pass);
  for (const r of results) if (!r.pass) console.log(`  FAIL: ${r.name}`);
  console.log(`PASS ${results.length - failed.length} / ${results.length}`);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('\n[smoke] 异常终止：', err);
  process.exit(1);
} finally {
  if (mongo) await mongo.stop();
}
