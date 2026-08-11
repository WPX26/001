/**
 * 上线前安全修复冒烟测试（P0-1 ~ P1-6，mongodb-memory-server 内存库）
 * 用法：node scripts/smoke-security.js
 *
 * 覆盖：
 * - P0-1 IDOR：私有坐标照片他人访问 404 隐藏 / 公开坐标照片他人可看 / 未挂坐标照片视为私有 /
 *   私有坐标不可收藏 / 私有照片评论列表 404 / 作者本人不受限
 * - P0-2 验证码枚举：错误 ≥5 次锁定 10 分钟（正确码也被拦）/ 锁定期间 send-code 429 /
 *   每 IP send-code 10 次/分钟限频
 * - P0-3 错误语义：点赞不存在照片 404/1004；CastError 拆分（ObjectId→404，日期→400）
 * - P1-1 软删照片 coord.photoCount 同步 -1 / 恢复 +1
 * - P1-2 photoTimes 非法键过滤 / photoIds 上限 100
 * - P1-3 验签长度不等返回 false 不抛异常（不 500）
 * - P1-4 幂等键按用户隔离（同 hash 两用户各得各的照片）
 * - P1-5 requireAuth 加载的用户文档不含 passwordHash
 * - P1-6 回收站分页 total 按类型正确计数
 */
// 先注入测试环境变量再加载 app（ESM 静态 import 提升问题，app 必须动态 import）
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';
process.env.SMS_DEV_MODE = 'true'; // send-code 直接返回验证码，测试 IP 限频用

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { VerificationCode, Photo, Coord } from '../src/models/index.js';

const { default: app } = await import('../src/app.js');

const results = [];
let tokenA = '';
let uidA = '';
let tokenB = '';
let uidB = '';

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

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

/** 注册用户（预置短信验证码） */
async function registerUser(phone, nickname, password = 'pass123456') {
  await VerificationCode.create({
    phone,
    scene: 'register',
    code: '123456',
    expiresAt: new Date(Date.now() + 300000),
  });
  const r = await call('POST', '/api/v1/auth/register', {
    body: { phone, code: '123456', nickname, password },
  });
  return {
    token: r.body?.data?.token || '',
    uid: r.body?.data?.user?.id || '',
    ok: r.status === 200 && r.body?.code === 0,
  };
}

/** 上传回调创建照片（本地模式，STORAGE_MODE 默认 local） */
async function uploadPhoto(token, key, hash) {
  const r = await call('POST', '/api/v1/upload/callback', {
    body: { files: [{ key, hash, size: 1024 }] },
    token,
  });
  return r.body?.data?.photoIds?.[0] || '';
}

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] 内存 MongoDB 已就绪');

  // ============ 前置：注册用户 A/B ============
  const uA = await registerUser('13700130001', '隐私测试A');
  const uB = await registerUser('13700130002', '越权用户B');
  tokenA = uA.token; uidA = uA.uid;
  tokenB = uB.token; uidB = uB.uid;
  check('注册 A/B → 200/0 且返回 token', uA.ok && uB.ok && Boolean(uidA && uidB));

  // ============ P0-1 IDOR 隐私越权 ============
  // 未挂坐标的照片视为私有：B 访问 A 的未挂坐标照片 → 404 隐藏
  const photoU = await uploadPhoto(tokenA, 'sec/u.jpg', 'sec-hash-u');
  check('A 上传回调创建未挂坐标照片', Boolean(photoU));
  const leakU = await call('GET', `/api/v1/photos/${photoU}`, { token: tokenB });
  check('P0-1 未挂坐标照片：他人访问 → 404 隐藏', leakU.status === 404 && leakU.body?.code === 1004);

  // 公开坐标：B 可看照片详情与坐标详情
  const pub = await call('POST', '/api/v1/coords', {
    body: {
      title: '公开坐标',
      lng: 120.3,
      lat: 36.06,
      photoIds: [photoU],
      photoTimes: { [photoU]: '2026-08-09T10:30:00Z' },
      isPublic: true,
      mode: 'life',
    },
    token: tokenA,
  });
  const coordPub = pub.body?.data?.id || '';
  check('A 创建公开坐标 → 200/0', pub.status === 200 && pub.body?.code === 0 && Boolean(coordPub));
  const pubPhoto = await call('GET', `/api/v1/photos/${photoU}`, { token: tokenB });
  check('P0-1 公开坐标照片：他人可看详情 → 200', pubPhoto.status === 200 && pubPhoto.body?.code === 0);
  const pubDetail = await call('GET', `/api/v1/coords/${coordPub}/detail`, { token: tokenB });
  check('P0-1 公开坐标：他人可看详情 → 200', pubDetail.status === 200 && pubDetail.body?.code === 0 && pubDetail.body?.data?.photos?.length === 1);

  // 私有坐标：B 访问照片/坐标/评论列表 → 404 隐藏；A（作者）不受限
  const photoP = await uploadPhoto(tokenA, 'sec/p.jpg', 'sec-hash-p');
  const priv = await call('POST', '/api/v1/coords', {
    body: {
      title: '私有坐标',
      lng: 120.31,
      lat: 36.07,
      photoIds: [photoP],
      isPublic: false,
      mode: 'life',
    },
    token: tokenA,
  });
  const coordPriv = priv.body?.data?.id || '';
  check('A 创建私有坐标 → 200/0', priv.status === 200 && priv.body?.code === 0 && Boolean(coordPriv));
  const leakPrivPhoto = await call('GET', `/api/v1/photos/${photoP}`, { token: tokenB });
  check('P0-1 私有坐标照片：他人访问 → 404 隐藏', leakPrivPhoto.status === 404 && leakPrivPhoto.body?.code === 1004);
  const leakPrivCoord = await call('GET', `/api/v1/coords/${coordPriv}/detail`, { token: tokenB });
  check('P0-1 私有坐标：他人访问 detail → 404 隐藏', leakPrivCoord.status === 404 && leakPrivCoord.body?.code === 1004);
  const leakPrivComments = await call('GET', `/api/v1/photos/${photoP}/comments`, { token: tokenB });
  check('P0-1 私有照片评论列表：他人访问 → 404 隐藏', leakPrivComments.status === 404 && leakPrivComments.body?.code === 1004);
  const authorPhoto = await call('GET', `/api/v1/photos/${photoP}`, { token: tokenA });
  check('P0-1 私有坐标照片：作者本人 → 200', authorPhoto.status === 200 && authorPhoto.body?.code === 0);
  const authorCoord = await call('GET', `/api/v1/coords/${coordPriv}/detail`, { token: tokenA });
  check('P0-1 私有坐标：作者本人 detail → 200', authorCoord.status === 200 && authorCoord.body?.code === 0);

  // 私有坐标不可收藏（统查加固）
  const collectPriv = await call('POST', '/api/v1/inspire/collect', { body: { sourceCoordIds: [coordPriv] }, token: tokenB });
  check('P0-1 私有坐标：他人收藏 → 404 隐藏', collectPriv.status === 404 && collectPriv.body?.code === 1004);

  // ============ P0-2 验证码暴力枚举 ============
  // 5 次错误 → 锁定；第 6 次即使验证码正确也被 429/1006 拦截
  await VerificationCode.create({
    phone: '13700130001',
    scene: 'login',
    code: '654321',
    expiresAt: new Date(Date.now() + 300000),
  });
  let lockBlocked = false;
  for (let i = 1; i <= 6; i++) {
    const r = await call('POST', '/api/v1/auth/login', { body: { phone: '13700130001', code: '000000' } });
    if (i <= 5) {
      check(`P0-2 验证码错误第 ${i} 次 → 400/1001`, r.status === 400 && r.body?.code === 1001);
    } else {
      lockBlocked = r.status === 429 && r.body?.code === 1006;
    }
  }
  check('P0-2 第 6 次尝试（含此前错误）→ 429/1006 锁定', lockBlocked);
  const correctWhileLocked = await call('POST', '/api/v1/auth/login', { body: { phone: '13700130001', code: '654321' } });
  check('P0-2 锁定期间正确验证码也被拦截 → 429/1006', correctWhileLocked.status === 429 && correctWhileLocked.body?.code === 1006);
  // 断言锁定守卫的专属文案，排除"每手机号 60s 发送间隔"的干扰
  const sendWhileLocked = await call('POST', '/api/v1/auth/send-code', { body: { phone: '13700130001', scene: 'login' } });
  check(
    'P0-2 锁定期间 send-code → 429/1006（锁定守卫拦截）',
    sendWhileLocked.status === 429 && sendWhileLocked.body?.code === 1006 && sendWhileLocked.body?.message === '验证码错误次数过多，请 10 分钟后再试'
  );

  // 每 IP send-code 限频：10 次/分钟。
  // 注意：上方 sendWhileLocked 已占用 1 个 IP 窗口位 → 本组 11 个新手机号中前 9 个放行、第 10/11 个被 IP 限频
  const ipResults = [];
  for (let i = 1; i <= 11; i++) {
    const phone = `1371000${String(i).padStart(4, '0')}`; // 13710000001..13710000011
    const r = await call('POST', '/api/v1/auth/send-code', { body: { phone, scene: 'login' } });
    ipResults.push({ i, r });
  }
  const acceptedIp = ipResults.filter((x) => x.r.status === 200 && x.r.body?.code === 0);
  const blockedIp = ipResults.filter((x) => x.r.status === 429 && x.r.body?.code === 1006);
  check(
    'P0-2 每 IP send-code 窗口 10 次：本组前 9 个放行、第 10/11 个 429 IP 限频',
    acceptedIp.length === 9 &&
      blockedIp.length === 2 &&
      blockedIp.every((x) => x.i >= 10) &&
      blockedIp.every((x) => x.r.body?.message === '发送过于频繁，请稍后再试')
  );

  // ============ P0-3 错误语义 ============
  const likeGhost = await call('POST', `/api/v1/photos/${new mongoose.Types.ObjectId().toString()}/like`, { token: tokenB });
  check('P0-3 点赞不存在的照片 → 404/1004', likeGhost.status === 404 && likeGhost.body?.code === 1004);
  const likeOk = await call('POST', `/api/v1/photos/${photoU}/like`, { token: tokenB });
  check('点赞存在的照片 → 200/0', likeOk.status === 200 && likeOk.body?.code === 0);
  const likeDup = await call('POST', `/api/v1/photos/${photoU}/like`, { token: tokenB });
  check('重复点赞 → 409/1005（语义未回退）', likeDup.status === 409 && likeDup.body?.code === 1005);

  // CastError 拆分（单元级：直接驱动 errorHandler）
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const captureRes = () => {
    const r = { statusCode: 0, jsonBody: null };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (body) => { r.jsonBody = body; return r; };
    return r;
  };
  const badDate = Object.assign(new Error('非法日期'), { name: 'CastError', kind: 'Date' });
  const badOid = Object.assign(new Error('非法 ID'), { name: 'CastError', kind: 'ObjectId' });
  const resDate = captureRes();
  errorHandler(badDate, {}, resDate, () => {});
  const resOid = captureRes();
  errorHandler(badOid, {}, resOid, () => {});
  check('P0-3 CastError(Date) → 400/1001（非法日期）', resDate.statusCode === 400 && resDate.jsonBody?.code === 1001);
  check('P0-3 CastError(ObjectId) → 404/1004（路由参数非法 ID）', resOid.statusCode === 404 && resOid.jsonBody?.code === 1004);

  // ============ P1-1 软删/恢复同步 coord.photoCount ============
  const cb11 = await call('POST', '/api/v1/upload/callback', {
    body: { files: [
      { key: 'sec/c1.jpg', hash: 'sec-hash-c1', size: 100 },
      { key: 'sec/c2.jpg', hash: 'sec-hash-c2', size: 100 },
    ] },
    token: tokenA,
  });
  const [p1, p2] = cb11.body?.data?.photoIds || [];
  const coord3 = await call('POST', '/api/v1/coords', {
    body: { title: '计数坐标', lng: 120.32, lat: 36.08, photoIds: [p1, p2], isPublic: true, mode: 'life' },
    token: tokenA,
  });
  const coord3Id = coord3.body?.data?.id || '';
  const coord3Doc0 = await Coord.findById(coord3Id).lean();
  check('P1-1 创建含 2 张照片的坐标 → photoCount=2', coord3Doc0?.photoCount === 2);

  const del1 = await call('DELETE', `/api/v1/photos/${p1}`, { token: tokenA });
  check('P1-1 软删照片 → 200/0', del1.status === 200 && del1.body?.code === 0);
  const coord3Doc1 = await Coord.findById(coord3Id).lean();
  check('P1-1 软删后 coord.photoCount=1（同步 -1）', coord3Doc1?.photoCount === 1);
  const detailAfterDel = await call('GET', `/api/v1/coords/${coord3Id}/detail`, { token: tokenA });
  check('P1-1 坐标详情 totalCount=1（照片已被隐藏）', detailAfterDel.body?.data?.totalCount === 1);

  const res1 = await call('POST', `/api/v1/photos/${p1}/restore`, { token: tokenA });
  check('P1-1 恢复照片 → 200/0', res1.status === 200 && res1.body?.code === 0);
  const coord3Doc2 = await Coord.findById(coord3Id).lean();
  check('P1-1 恢复后 coord.photoCount=2（同步 +1）', coord3Doc2?.photoCount === 2);

  // 软删未挂坐标照片：不崩、无坐标可同步
  const solo = await uploadPhoto(tokenA, 'sec/solo.jpg', 'sec-hash-solo');
  const delSolo = await call('DELETE', `/api/v1/photos/${solo}`, { token: tokenA });
  check('P1-1 软删未挂坐标照片 → 200 且不报错', delSolo.status === 200 && delSolo.body?.code === 0);

  // ============ P1-2 photoTimes 键校验 + photoIds 上限 ============
  const p3 = await uploadPhoto(tokenA, 'sec/p3.jpg', 'sec-hash-p3');
  const strayId = new mongoose.Types.ObjectId().toString();
  const badTimes = await call('POST', '/api/v1/coords', {
    body: {
      title: '键校验坐标',
      lng: 120.33,
      lat: 36.09,
      photoIds: [p3],
      photoTimes: { [p3]: '2026-08-09T10:30:00Z', [strayId]: '2026-08-10T11:00:00Z', notAnId: '2026-08-10T12:00:00Z' },
      isPublic: true,
      mode: 'life',
    },
    token: tokenA,
  });
  const coord4Id = badTimes.body?.data?.id || '';
  const coord4Doc = await Coord.findById(coord4Id).lean();
  // 注意：.lean() 下 Map 字段是普通对象（无 .keys()），用 Object.keys 取键
  const ptKeys = coord4Doc?.photoTimes ? Object.keys(coord4Doc.photoTimes) : [];
  check(
    'P1-2 photoTimes 非法键（不在 photoIds）被过滤 → 仅保留合法键',
    badTimes.status === 200 && ptKeys.length === 1 && ptKeys[0] === p3
  );
  const pT3 = await Photo.findById(p3).lean();
  check('P1-2 合法键回填 takenAt', pT3?.takenAt instanceof Date);

  // photoIds 上限 100
  const many = [];
  for (let i = 0; i < 101; i++) {
    many.push({ clientPhotoId: `bulk-${i}`, authorId: new mongoose.Types.ObjectId(uidA), imageUrl: `https://x/${i}.jpg`, uploadTime: new Date() });
  }
  await Photo.insertMany(many);
  const manyIds = (await Photo.find({ clientPhotoId: { $in: many.map((m) => m.clientPhotoId) } }).select('_id').lean()).map((m) => String(m._id));
  const over100 = await call('POST', '/api/v1/coords', {
    body: { title: '超限坐标', lng: 120.34, lat: 36.1, photoIds: manyIds, isPublic: true, mode: 'life' },
    token: tokenA,
  });
  check('P1-2 photoIds 101 张 → 400/1001（上限 100）', over100.status === 400 && over100.body?.code === 1001);

  // ============ P1-3 验签长度不等不崩溃 ============
  const storage = await import('../src/services/storage.service.js');
  const rawBody = '{"files":[{"key":"a.jpg"}]}';
  const goodSign = crypto.createHmac('sha1', '').update(rawBody, 'utf8').digest('base64');
  check('P1-3 正确签名 → true', storage.verifyCallbackSignature(rawBody, `OSS ${goodSign}`) === true);
  let shortOk = false;
  try {
    shortOk = storage.verifyCallbackSignature(rawBody, 'OSS short') === false;
  } catch {
    shortOk = false;
  }
  check('P1-3 长度不符签名 → false 且不抛异常（不 500）', shortOk);
  check('P1-3 同长度错误签名 → false', storage.verifyCallbackSignature(rawBody, `OSS ${'x'.repeat(goodSign.length)}`) === false);
  check('P1-3 无 Authorization → false', storage.verifyCallbackSignature(rawBody, undefined) === false);
  check('P1-3 非 OSS 前缀 → false', storage.verifyCallbackSignature(rawBody, 'Basic abc') === false);

  // ============ P1-4 幂等键按用户隔离 ============
  const dupA1 = await uploadPhoto(tokenA, 'sec/dup.jpg', 'sec-hash-dup');
  const dupA2 = await uploadPhoto(tokenA, 'sec/dup.jpg', 'sec-hash-dup');
  check('P1-4 同一用户重复回调 → 幂等返回同一照片', Boolean(dupA1) && dupA1 === dupA2);
  const dupB = await uploadPhoto(tokenB, 'sec/dup.jpg', 'sec-hash-dup');
  const dupCount = await Photo.countDocuments({ hash: 'sec-hash-dup' });
  check('P1-4 两用户同 hash → 各得各的照片（不冒领）', Boolean(dupA1) && Boolean(dupB) && dupA1 !== dupB && dupCount === 2);

  // ============ P1-5 requireAuth 不加载 passwordHash ============
  const { requireAuth } = await import('../src/middleware/auth.js');
  const envMod = await import('../src/config/env.js');
  const authToken = jwt.sign({ uid: uidA, type: 'access' }, envMod.default.JWT_SECRET, { expiresIn: 3600 });
  const fakeReq = { headers: { authorization: `Bearer ${authToken}` } };
  await requireAuth(fakeReq, {}, () => {});
  check('P1-5 requireAuth 用户文档不含 passwordHash', Boolean(fakeReq.user) && fakeReq.user.passwordHash === undefined);
  check('P1-5 requireAuth 业务字段仍可用（phone/nickname）', Boolean(fakeReq.user?.phone) && Boolean(fakeReq.user?.nickname));

  // ============ P1-6 回收站分页 total ============
  const cb6 = await call('POST', '/api/v1/upload/callback', {
    body: { files: [
      { key: 'sec/r1.jpg', hash: 'sec-hash-r1', size: 100 },
      { key: 'sec/r2.jpg', hash: 'sec-hash-r2', size: 100 },
    ] },
    token: tokenA,
  });
  const [r1, r2] = cb6.body?.data?.photoIds || [];
  const coord5 = await call('POST', '/api/v1/coords', {
    body: { title: '回收站坐标1', lng: 120.35, lat: 36.11, photoIds: [r1, r2], isPublic: true, mode: 'life' },
    token: tokenA,
  });
  const coord5Id = coord5.body?.data?.id || '';
  await call('DELETE', `/api/v1/photos/${r1}`, { token: tokenA });
  await call('DELETE', `/api/v1/photos/${r2}`, { token: tokenA });
  const r3 = await uploadPhoto(tokenA, 'sec/r3.jpg', 'sec-hash-r3');
  const coord6 = await call('POST', '/api/v1/coords', {
    body: { title: '回收站坐标2', lng: 120.36, lat: 36.12, photoIds: [r3], isPublic: true, mode: 'life' },
    token: tokenA,
  });
  const coord6Id = coord6.body?.data?.id || '';
  await call('DELETE', `/api/v1/coords/${coord6Id}`, { token: tokenA }); // 坐标 + 其照片 r3 一并进回收站

  // 回收站照片 4 张：solo（P1-1 软删未恢复）+ r1、r2（单张软删）+ r3（随坐标软删）；坐标 1 个：coord6
  const trashPhotos = await call('GET', '/api/v1/photos/trash?type=photos&pageSize=1&page=2', { token: tokenA });
  check(
    'P1-6 trash type=photos 第 2 页 → total=4（全部照片）、本页 1 条、响应注明类型',
    trashPhotos.status === 200 &&
      trashPhotos.body?.data?.total === 4 &&
      trashPhotos.body?.data?.list?.length === 1 &&
      trashPhotos.body?.data?.type === 'photos'
  );
  const trashMarkers = await call('GET', '/api/v1/photos/trash?type=markers', { token: tokenA });
  check('P1-6 trash type=markers → total=1（仅坐标）', trashMarkers.status === 200 && trashMarkers.body?.data?.total === 1 && trashMarkers.body?.data?.type === 'markers');
  const trashAll = await call('GET', '/api/v1/photos/trash?type=all&pageSize=5&page=1', { token: tokenA });
  check('P1-6 trash type=all → total=5（照片4+坐标1）', trashAll.status === 200 && trashAll.body?.data?.total === 5 && trashAll.body?.data?.list?.length === 5 && trashAll.body?.data?.type === 'all');
  // hasMore 依据正确 total 计算（第 1 页 4/5 条 → 无更多）
  check('P1-6 hasMore 计算正确（pageSize=5 时 false）', trashAll.body?.data?.hasMore === false);

  // ============ 清理 ============
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await mongo.stop();
  mongo = null;
  console.log('[DB] 内存库已清理并停止');
} catch (e) {
  console.error('[SMOKE] 异常终止：', e);
  check('冒烟流程无异常', false, e.message);
} finally {
  server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n========== 结果：${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ✗ ${f.name}`));
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}
