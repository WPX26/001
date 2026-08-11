/**
 * P1 第二批冒烟测试：灵感模式 + 探索模式（mongodb-memory-server 内存库，无需本机 mongod）
 * 用法：node scripts/smoke-inspire-explore.js
 *
 * 覆盖（对应 api.md 第 4/5 章）：
 * - 灵感列表：半径过滤（米/度）、sortBy=hot/time/followed、排除自己、非公开/工作池排除、
 *   照片按时间分组（组内关注优先+热度排序、每组上限 9 张）、isCollected/isLiked 透出
 * - 收藏：多选合并、原子 push+inc、重复 1005、不存在 404、取消收藏、重复取消 1005
 * - 探索列表：作者分组、已关注优先 → 作品数 → 热度、非摄影师（含会员到期收回）作品隐藏
 * - 排行榜：周/月/总榜时间窗口、myRank、非摄影师排除
 */
// 先注入测试环境变量再加载 app（ESM 静态 import 提升，app 必须动态 import）
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { VerificationCode, User, Coord, Photo } from '../src/models/index.js';
import { gridKeyOf } from '../src/utils/geo.js';

const { default: app } = await import('../src/app.js');

const DAY_MS = 86400000;
const results = [];
const CENTER = { lng: 120.38, lat: 36.06 };

let uidA = '', uidB = '', uidC = '', uidD = '', uidV = '';
let tokenV = '';
// 坐标 ID
let L1 = '', L2 = '', L3 = '', L7 = '', L6 = '', L4 = '', L5 = '', W_A1 = '', W_B1 = '';
let p1 = ''; // L1 的第一张照片（isLiked 断言用）

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
async function registerUser(phone, nickname) {
  await VerificationCode.create({
    phone,
    scene: 'register',
    code: '123456',
    expiresAt: new Date(Date.now() + 300000),
  });
  const r = await call('POST', '/api/v1/auth/register', {
    body: { phone, code: '123456', nickname, password: 'pass123456' },
  });
  return {
    token: r.body?.data?.token || '',
    uid: r.body?.data?.user?.id || '',
    ok: r.status === 200 && r.body?.code === 0,
  };
}

/** 直插照片文档 */
let photoSeq = 0;
async function makePhoto({ authorId, coordId = null, likes = 0, takenAt = new Date(), uploadTime = new Date(), likedBy = [] }) {
  photoSeq += 1;
  return Photo.create({
    authorId,
    coordId,
    imageUrl: `https://example.com/ie${photoSeq}.jpg`,
    thumbnailUrl: `https://example.com/ie${photoSeq}-t.jpg`,
    clientPhotoId: `inspire-explore-${photoSeq}`,
    likes,
    takenAt,
    uploadTime,
    likedBy,
  });
}

/** 直插坐标文档 */
async function makeCoord({ authorId, title, lng, lat, mode = 'life', isPublic = true, createdAt = new Date(), photoCount = 0 }) {
  return Coord.create({
    title, lng, lat, authorId, mode, isPublic, photoCount,
    gridKey: gridKeyOf(lng, lat),
    createdAt,
  });
}

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] 内存 MongoDB 已就绪');

  // ============ 前置：注册用户并设定摄影师身份 ============
  const uA = await registerUser('13800138001', '摄影师A');
  const uB = await registerUser('13800138002', '摄影师B');
  const uC = await registerUser('13800138003', '普通用户C');
  const uD = await registerUser('13800138004', '摄影师D');
  const uV = await registerUser('13800138005', '观众V');
  uidA = uA.uid; uidB = uB.uid; uidC = uC.uid; uidD = uD.uid; uidV = uV.uid;
  tokenV = uV.token;
  check('注册 A/B/C/D/V → 均 200/0 且返回 token', uA.ok && uB.ok && uC.ok && uD.ok && uV.ok);

  // A/B/D/V 为当前有效摄影师（会员订阅中）；C 非摄影师
  await User.updateMany(
    { _id: { $in: [uidA, uidB, uidD, uidV] } },
    { $set: { isPhotographer: true, memberStatus: 'active', mode: 'work' } }
  );

  // ============ 前置：灵感池数据（生活坐标） ============
  // L1：A 的坐标，3 张照片分属 2 天（2026-08-01 ×2、2026-08-03 ×1），热度 16
  const cL1 = await makeCoord({ authorId: uidA, title: 'L1生活坐标', lng: 120.38, lat: 36.06, photoCount: 3, createdAt: new Date('2026-08-01T00:00:00Z') });
  L1 = String(cL1._id);
  const ph1 = await makePhoto({ authorId: uidA, coordId: cL1._id, likes: 10, takenAt: new Date('2026-08-01T10:00:00Z'), likedBy: [uV.uid] });
  p1 = String(ph1._id);
  await makePhoto({ authorId: uidA, coordId: cL1._id, likes: 5, takenAt: new Date('2026-08-01T12:00:00Z') });
  await makePhoto({ authorId: uidA, coordId: cL1._id, likes: 1, takenAt: new Date('2026-08-03T09:00:00Z') });

  // L2：B 的坐标，1 张照片热度 20（B 会被 V 关注 → followed 排序优先）
  const cL2 = await makeCoord({ authorId: uidB, title: 'L2生活坐标', lng: 120.381, lat: 36.0605, photoCount: 1, createdAt: new Date('2026-08-02T00:00:00Z') });
  L2 = String(cL2._id);
  await makePhoto({ authorId: uidB, coordId: cL2._id, likes: 20, takenAt: new Date('2026-08-02T10:00:00Z') });

  // L3：C（非摄影师）的生活坐标 → 灵感池不要求摄影师，应出现
  const cL3 = await makeCoord({ authorId: uidC, title: 'L3生活坐标', lng: 120.385, lat: 36.063, photoCount: 1, createdAt: new Date('2026-08-05T00:00:00Z') });
  L3 = String(cL3._id);
  await makePhoto({ authorId: uidC, coordId: cL3._id, likes: 0, takenAt: new Date('2026-08-05T10:00:00Z') });

  // L7：A 的坐标，同一天 12 张照片 → 分组上限 9 张
  const cL7 = await makeCoord({ authorId: uidA, title: 'L7批量照片', lng: 120.382, lat: 36.061, photoCount: 12, createdAt: new Date('2026-07-20T00:00:00Z') });
  L7 = String(cL7._id);
  for (let i = 0; i < 12; i += 1) {
    await makePhoto({ authorId: uidA, coordId: cL7._id, likes: 0, takenAt: new Date('2026-08-04T09:00:00Z') });
  }

  // L6：A 的坐标，距中心约 7.3km → 2000 米半径排除、0.5° 半径包含
  const cL6 = await makeCoord({ authorId: uidA, title: 'L6较远坐标', lng: 120.3, lat: 36.05, photoCount: 1, createdAt: new Date('2026-08-04T00:00:00Z') });
  L6 = String(cL6._id);
  await makePhoto({ authorId: uidA, coordId: cL6._id, likes: 3, takenAt: new Date('2026-08-04T10:00:00Z') });

  // L4：约 100km 外 → 两种半径均排除；L5：非公开；W1：工作池（灵感排除）
  const cL4 = await makeCoord({ authorId: uidA, title: 'L4远处坐标', lng: 121.5, lat: 36.1, photoCount: 1 });
  L4 = String(cL4._id);
  await makePhoto({ authorId: uidA, coordId: cL4._id, likes: 99, takenAt: new Date('2026-08-04T11:00:00Z') });
  const cL5 = await makeCoord({ authorId: uidA, title: 'L5非公开', lng: 120.38, lat: 36.06, isPublic: false, photoCount: 1 });
  L5 = String(cL5._id);
  // 工作坐标不进灵感池的验证由探索池的 W_A1/W_A2（同在中心点）承担
  // V 自己的生活坐标 → 列表排除自己
  await makeCoord({ authorId: uidV, title: 'V自己的坐标', lng: 120.38, lat: 36.06, photoCount: 1, createdAt: new Date('2026-08-06T00:00:00Z') });

  // ============ 前置：探索池数据（工作坐标） ============
  // A：3 个工作坐标（1 个远处），照片 10+5+2+0 → 热度 17
  const cW1 = await makeCoord({ authorId: uidA, title: 'W_A1', lng: 120.38, lat: 36.06, mode: 'work', photoCount: 2 });
  W_A1 = String(cW1._id);
  await makePhoto({ authorId: uidA, coordId: cW1._id, likes: 10, uploadTime: new Date(Date.now() - 1 * DAY_MS) });
  await makePhoto({ authorId: uidA, coordId: cW1._id, likes: 5, uploadTime: new Date(Date.now() - 1 * DAY_MS) });
  const cW2 = await makeCoord({ authorId: uidA, title: 'W_A2', lng: 120.382, lat: 36.062, mode: 'work', photoCount: 1 });
  await makePhoto({ authorId: uidA, coordId: cW2._id, likes: 2, uploadTime: new Date(Date.now() - 2 * DAY_MS) });
  await makeCoord({ authorId: uidA, title: 'W_A3远处', lng: 121.5, lat: 36.1, mode: 'work', photoCount: 1 });
  // A 的 40 天前旧照片（排行榜 all 榜 +100，周/月榜不计；独立照片无坐标，不污染探索池统计）
  await makePhoto({ authorId: uidA, likes: 100, uploadTime: new Date(Date.now() - 40 * DAY_MS) });

  // B：1 个工作坐标 30 赞（V 关注 B → 探索列表 B 组第一）
  const cB1 = await makeCoord({ authorId: uidB, title: 'W_B1', lng: 120.381, lat: 36.061, mode: 'work', photoCount: 1 });
  W_B1 = String(cB1._id);
  await makePhoto({ authorId: uidB, coordId: cB1._id, likes: 30, uploadTime: new Date(Date.now() - 1 * DAY_MS) });

  // C：非摄影师的工作坐标（50 赞）→ 探索池必须隐藏
  const cC1 = await makeCoord({ authorId: uidC, title: 'W_C1', lng: 120.38, lat: 36.06, mode: 'work', photoCount: 1 });
  await makePhoto({ authorId: uidC, coordId: cC1._id, likes: 50, uploadTime: new Date(Date.now() - 1 * DAY_MS) });

  // D：摄影师，1 个工作坐标 4 赞 → 排在 A 之后
  const cD1 = await makeCoord({ authorId: uidD, title: 'W_D1', lng: 120.38, lat: 36.06, mode: 'work', photoCount: 1 });
  await makePhoto({ authorId: uidD, coordId: cD1._id, likes: 4, uploadTime: new Date(Date.now() - 1 * DAY_MS) });

  // V 的照片（排行榜 myRank 用，无坐标）
  await makePhoto({ authorId: uidV, likes: 3, uploadTime: new Date(Date.now() - 1 * DAY_MS) });

  // V 关注 B
  await call('POST', `/api/v1/users/${uidB}/follow`, { token: tokenV });

  // ============ 灵感列表：未登录 / 参数校验 ============
  const noToken = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=2000`);
  check('未登录查灵感列表 → 401/1002', noToken.status === 401 && noToken.body?.code === 1002);

  const noLng = await call('GET', '/api/v1/inspire/coords?lat=36.06', { token: tokenV });
  check('缺 lng → 400/1001', noLng.status === 400 && noLng.body?.code === 1001);

  const badSort = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&sortBy=bogus`, { token: tokenV });
  check('sortBy 非法 → 400/1001', badSort.status === 400 && badSort.body?.code === 1001);

  // ============ 灵感列表：默认 followed 排序 + 半径(米)过滤 ============
  const inspBase = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=2000`, { token: tokenV });
  const iList = inspBase.body?.data?.list || [];
  const iIds = iList.map((x) => x.coordInfo.id);
  check(
    '灵感列表(2000米) → 含 L1/L2/L3/L7，排除 L4(远)/L6(>2km)/L5(非公开)/工作池/自己的坐标',
    inspBase.status === 200 &&
      inspBase.body?.data?.total === 4 &&
      [L1, L2, L3, L7].every((id) => iIds.includes(id)) &&
      !iIds.includes(L4) && !iIds.includes(L6) && !iIds.includes(L5),
    `实际 ${JSON.stringify(iIds)}`
  );
  check(
    '灵感列表默认 followed → 已关注作者(B)优先，再热度倒序 [L2,L1,L3,L7]',
    iIds[0] === L2 && iIds[1] === L1 && iIds[2] === L3 && iIds[3] === L7,
    `实际 ${JSON.stringify(iIds)}`
  );
  check(
    'L1 坐标信息 → coordInfo 字段完整 + isFollowedAuthor=false',
    iList[1]?.coordInfo?.authorId === uidA &&
      iList[1]?.coordInfo?.authorName === '摄影师A' &&
      iList[1]?.coordInfo?.photoCount === 3 &&
      iList[1]?.coordInfo?.likeCount === 16 &&
      iList[1]?.coordInfo?.isFollowedAuthor === false &&
      iList[1]?.coordInfo?.isCollected === false
  );

  // 照片按时间分组：L1 分 2 组（日期倒序），组内按热度排序，isLiked 透出
  const l1Groups = iList[1]?.photoGroups || [];
  check(
    'L1 照片按时间分组 → 2 组、日期倒序 [2026-08-03, 2026-08-01]',
    l1Groups.length === 2 &&
      l1Groups[0].date === '2026-08-03' &&
      l1Groups[1].date === '2026-08-01' &&
      l1Groups[0].photos.length === 1 &&
      l1Groups[1].photos.length === 2,
    `实际 ${JSON.stringify(l1Groups.map((g) => g.date))}`
  );
  check(
    '组内照片按热度排序 + isLiked → 08-01 组首张 likes=10 且 isLiked=true',
    l1Groups[1]?.photos[0]?.id === p1 &&
      l1Groups[1]?.photos[0]?.likes === 10 &&
      l1Groups[1]?.photos[0]?.isLiked === true &&
      l1Groups[1]?.photos[1]?.likes === 5
  );
  check(
    'L7 同一天 12 张照片 → 分组仅保留前 9 张',
    (iList[3]?.photoGroups?.[0]?.photos?.length) === 9,
    `实际 ${iList[3]?.photoGroups?.[0]?.photos?.length}`
  );

  // ============ 灵感列表：hot / time 排序 ============
  const inspHot = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=2000&sortBy=hot`, { token: tokenV });
  const hotIds = inspHot.body?.data?.list.map((x) => x.coordInfo.id);
  check('sortBy=hot → 热度倒序 [L2(20),L1(16),L3(0),L7(0)]', hotIds[0] === L2 && hotIds[1] === L1 && hotIds[2] === L3 && hotIds[3] === L7, `实际 ${JSON.stringify(hotIds)}`);

  const inspTime = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=2000&sortBy=time`, { token: tokenV });
  const timeIds = inspTime.body?.data?.list.map((x) => x.coordInfo.id);
  check('sortBy=time → 最新优先 [L3,L2,L1,L7]', timeIds[0] === L3 && timeIds[1] === L2 && timeIds[2] === L1 && timeIds[3] === L7, `实际 ${JSON.stringify(timeIds)}`);

  // ============ 灵感列表：半径（度） ============
  const inspDeg = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=0.5`, { token: tokenV });
  const degIds = inspDeg.body?.data?.list.map((x) => x.coordInfo.id);
  check('radius=0.5(度) → 包含 L6(7km)，仍排除 L4(100km)', degIds.includes(L6) && !degIds.includes(L4 || ''), `实际 ${JSON.stringify(degIds)}`);

  // ============ 收藏：多选合并 / 重复 / 不存在 ============
  const col = await call('POST', '/api/v1/inspire/collect', { body: { sourceCoordIds: [L1, L2] }, token: tokenV });
  const l1After = await Coord.findById(L1).lean();
  const l2After = await Coord.findById(L2).lean();
  check(
    '收藏 [L1,L2] → 200/0，collectedBy 与 collectedCount 原子联动',
    col.status === 200 && col.body?.data?.collected === 2 &&
      l1After?.collectedCount === 1 && l1After?.collectedBy?.map(String).includes(uidV) &&
      l2After?.collectedCount === 1
  );

  const colDup = await call('POST', '/api/v1/inspire/collect', { body: { sourceCoordIds: [L1] }, token: tokenV });
  check('重复收藏 L1 → 409/1005', colDup.status === 409 && colDup.body?.code === 1005);

  const colPartial = await call('POST', '/api/v1/inspire/collect', { body: { sourceCoordIds: [L1, L3] }, token: tokenV });
  check('部分已收藏 [L1,L3] → 409/1005（整体失败）', colPartial.status === 409 && colPartial.body?.code === 1005);

  const colGhost = await call('POST', '/api/v1/inspire/collect', { body: { sourceCoordIds: [new mongoose.Types.ObjectId().toString()] }, token: tokenV });
  check('收藏不存在的坐标 → 404/1004', colGhost.status === 404 && colGhost.body?.code === 1004);

  const colBad = await call('POST', '/api/v1/inspire/collect', { body: { sourceCoordIds: ['abc'] }, token: tokenV });
  check('sourceCoordIds 非法格式 → 400/1001', colBad.status === 400 && colBad.body?.code === 1001);

  // 收藏后列表 isCollected/collectedCount 透出
  const inspCol = await call('GET', `/api/v1/inspire/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=2000&sortBy=hot`, { token: tokenV });
  const colList = inspCol.body?.data?.list || [];
  const l2Item = colList.find((x) => x.coordInfo.id === L2);
  check('收藏后列表 → L2.isCollected=true、collectedCount=1、热度仍第一', l2Item?.coordInfo?.isCollected === true && l2Item?.coordInfo?.collectedCount === 1 && colList[0].coordInfo.id === L2);

  // ============ 取消收藏 ============
  const uncol = await call('DELETE', `/api/v1/inspire/collect/${L1}`, { token: tokenV });
  const l1AfterUn = await Coord.findById(L1).lean();
  check('取消收藏 L1 → 200/0，collectedCount 回 0', uncol.status === 200 && uncol.body?.data?.isCollected === false && l1AfterUn?.collectedCount === 0 && !l1AfterUn?.collectedBy?.map(String).includes(uidV));

  const uncolDup = await call('DELETE', `/api/v1/inspire/collect/${L1}`, { token: tokenV });
  check('重复取消收藏 → 409/1005', uncolDup.status === 409 && uncolDup.body?.code === 1005);

  const uncolGhost = await call('DELETE', `/api/v1/inspire/collect/${new mongoose.Types.ObjectId().toString()}`, { token: tokenV });
  check('取消收藏不存在的坐标 → 404/1004', uncolGhost.status === 404 && uncolGhost.body?.code === 1004);

  // 与 2.10 我收藏的坐标联动
  const myCols = await call('GET', '/api/v1/users/me/collected-coords', { token: tokenV });
  check('我收藏的坐标 → 仅剩 L2', myCols.status === 200 && myCols.body?.data?.total === 1 && myCols.body?.data?.list[0]?.id === L2, `实际 ${JSON.stringify(myCols.body?.data?.list)}`);

  // ============ 探索列表：作者分组 ============
  const expAll = await call('GET', '/api/v1/explore/coords', { token: tokenV });
  const groups = expAll.body?.data?.authorGroups || [];
  const groupAuthors = groups.map((g) => g.authorId);
  check(
    '探索列表 → 作者分组 [B(已关注),A,D]，C(非摄影师)隐藏，扁平 coords=5',
    expAll.status === 200 &&
      groupAuthors[0] === uidB && groupAuthors[1] === uidA && groupAuthors[2] === uidD &&
      !groupAuthors.includes(uidC) &&
      expAll.body?.data?.coords?.length === 5 &&
      expAll.body?.data?.total === 3,
    `实际 ${JSON.stringify(groupAuthors)}`
  );
  const gA = groups.find((g) => g.authorId === uidA);
  const gB = groups.find((g) => g.authorId === uidB);
  check(
    'B 组 → isFollowed=true、photoCount=1、totalLikes=30、精选照片 30 赞；A 组 → 3 坐标 17 赞',
    gB?.isFollowed === true && gB?.photoCount === 1 && gB?.totalLikes === 30 && gB?.photos?.[0]?.likes === 30 &&
      gA?.isFollowed === false && gA?.coordCount === 3 && gA?.photoCount === 4 && gA?.totalLikes === 17 &&
      gA?.photos?.[0]?.likes === 10
  );
  check('A 组坐标卡片 → 含坐标信息与缩略图', gA?.coords?.length === 3 && Array.isArray(gA?.coords?.[0]?.thumbnails));

  // 半径过滤：A 的远处坐标 W_A3 被排除
  const expRad = await call('GET', `/api/v1/explore/coords?lng=${CENTER.lng}&lat=${CENTER.lat}&radius=2000`, { token: tokenV });
  const gARad = expRad.body?.data?.authorGroups?.find((g) => g.authorId === uidA);
  check('探索列表(2000米) → A 组仅 2 坐标（远处坐标排除）', gARad?.coordCount === 2 && gARad?.photoCount === 3, `实际 ${gARad?.coordCount}/${gARad?.photoCount}`);

  // lng 与 lat 必须成对
  const expHalf = await call('GET', '/api/v1/explore/coords?lng=120.38', { token: tokenV });
  check('探索列表只给 lng → 400/1001', expHalf.status === 400 && expHalf.body?.code === 1001);

  // ============ 探索列表：会员到期收回认证 → 探索池隐藏（关键联动） ============
  await User.updateOne({ _id: uidB }, { $set: { isPhotographer: false, memberStatus: 'expired' } });
  const expAfterRevoke = await call('GET', '/api/v1/explore/coords', { token: tokenV });
  const authorsAfter = expAfterRevoke.body?.data?.authorGroups?.map((g) => g.authorId);
  check('B 会员到期(isPhotographer=false) → 探索池隐藏 B，仅剩 [A,D]', authorsAfter[0] === uidA && authorsAfter[1] === uidD && !authorsAfter.includes(uidB), `实际 ${JSON.stringify(authorsAfter)}`);
  await User.updateOne({ _id: uidB }, { $set: { isPhotographer: true, memberStatus: 'active' } });

  // ============ 排行榜：周/月/总榜 + myRank ============
  // 语义：榜单聚合"摄影师全部照片的获赞"（生活+工作+独立照片，任务契约未限制 mode），
  // 仅过滤当前 isPhotographer=true。A 近 7 天 = 工作 17 + 生活 L1 16 + L6 3 + L4 99 = 135；B = 工作 30 + L2 20 = 50
  const rankWeekly = await call('GET', '/api/v1/explore/ranking?type=weekly', { token: tokenV });
  const rw = rankWeekly.body?.data?.rankings || [];
  check(
    '周榜 → [A(135),B(50),D(4),V(3)]，myRank=4',
    rankWeekly.status === 200 &&
      rw[0]?.authorId === uidA && rw[0]?.totalLikes === 135 &&
      rw[1]?.authorId === uidB && rw[1]?.totalLikes === 50 && rw[1]?.photoCount === 2 &&
      rw[3]?.authorId === uidV &&
      rankWeekly.body?.data?.myRank === 4,
    `实际 ${JSON.stringify(rw.map((x) => [x.authorId, x.totalLikes]))} myRank=${rankWeekly.body?.data?.myRank}`
  );
  check('周榜条目 → authorName/avatar/isFollowed 完整', rw[0]?.authorName === '摄影师A' && typeof rw[0]?.isFollowed === 'boolean');

  const rankMonthly = await call('GET', '/api/v1/explore/ranking?type=monthly', { token: tokenV });
  const rm = rankMonthly.body?.data?.rankings || [];
  check('月榜 → 与周榜一致（40 天旧照片不计）A=135', rm[0]?.authorId === uidA && rm[1]?.authorId === uidB && rm[0]?.totalLikes === 135);

  const rankAll = await call('GET', '/api/v1/explore/ranking?type=all', { token: tokenV });
  const ra = rankAll.body?.data?.rankings || [];
  check(
    '总榜 → 40 天前旧照片计入 A=235 → [A(235),B(50),D(4),V(3)]，myRank=4',
    rankAll.status === 200 &&
      ra[0]?.authorId === uidA && ra[0]?.totalLikes === 235 &&
      ra[1]?.authorId === uidB && ra[1]?.totalLikes === 50 &&
      rankAll.body?.data?.myRank === 4,
    `实际 ${JSON.stringify(ra.map((x) => [x.authorId, x.totalLikes]))} myRank=${rankAll.body?.data?.myRank}`
  );

  const rankDefault = await call('GET', '/api/v1/explore/ranking', { token: tokenV });
  check('排行榜默认 type=all', rankDefault.status === 200 && rankDefault.body?.data?.rankings?.[0]?.authorId === uidA);

  const rankBad = await call('GET', '/api/v1/explore/ranking?type=bogus', { token: tokenV });
  check('排行榜 type 非法 → 400/1001', rankBad.status === 400 && rankBad.body?.code === 1001);

  // 非摄影师不出现在榜单（C 有 50 赞照片但未认证）
  check('C（非摄影师 50 赞）不出现在任何榜单', !rw.map((x) => x.authorId).includes(uidC) && !ra.map((x) => x.authorId).includes(uidC));

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
