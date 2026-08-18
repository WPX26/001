/**
 * ③ 灵感/探索 本地验收辅助服务（内存 MongoDB，零生产库风险）
 * ============================================================
 * 用途：在本地起一个"预置真实格式数据"的后端，供 memo-home.html 灵感/探索
 *       真实验收（真实数据展示 + 停服降级）。绝不连接生产数据库。
 *
 * 用法（server 目录下，先安装依赖一次）：
 *   cd server
 *   npm install
 *   node scripts/dev-acceptance-server.js
 *
 * 另开窗口：python server.py            （静态页 8080）
 * 浏览器：  http://localhost:8080/memo-home.html
 * 登录：    手机号 13800138000，点"发送验证码"，验证码看本窗口日志
 *           （[短信-开发模式] ... 验证码: XXXXXX，SMS_DEV_MODE 直接返回，不真发短信）
 * 退出：    Ctrl+C（自动清理内存库，不留任何数据）
 *
 * 说明：
 * - 首次运行 mongodb-memory-server 会下载 MongoDB 二进制（约 1-3 分钟）；
 *   下载慢/失败可设环境变量后重试：
 *     set MONGOMS_DOWNLOAD_MIRROR=https://npmmirror.com/mirrors/mongodb/
 * - 照片统一用项目根 card-bg.jpg（8080 可访问），用于验证"真实图片"渲染链路。
 * - 端口默认 3000（与 api.js 默认后端地址一致）；占用时可先停掉占用进程。
 */
process.env.NODE_ENV = 'development';
process.env.SMS_DEV_MODE = 'true';          // 验证码直接返回（联调用，不真发短信）
process.env.JWT_SECRET = 'acceptance-secret-2026-0123456789';
process.env.STORAGE_MODE = 'local';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User, Coord, Photo } from '../src/models/index.js';
import { gridKeyOf } from '../src/utils/geo.js';

const { default: app } = await import('../src/app.js');

const PORT = Number(process.env.ACCEPT_PORT || 3000);
const IMG = 'card-bg.jpg'; // 相对 http://localhost:8080/ 可访问的本地图片

/** 建坐标 + 挂照片（clientPhotoId 幂等键唯一） */
async function addCoord({ author, title, lng, lat, mode, createdAt, photos }) {
  const coord = await Coord.create({
    title,
    lng,
    lat,
    authorId: author._id,
    mode,
    isPublic: true,
    photoCount: photos.length,
    gridKey: gridKeyOf(lng, lat),
    createdAt: createdAt || new Date(),
  });
  for (let i = 0; i < photos.length; i++) {
    const ph = photos[i];
    await Photo.create({
      clientPhotoId: mode + '-' + title + '-' + i + '-' + Date.now(),
      coordId: coord._id,
      authorId: author._id,
      imageUrl: IMG,
      thumbnailUrl: IMG,
      takenAt: new Date(ph.takenAt),
      uploadTime: new Date(ph.takenAt),
      likes: ph.likes,
    });
  }
  return coord;
}

async function seed() {
  // 验收观众（登录账号，本地内存库专属，不影响生产）
  const viewer = await User.create({ phone: '13800138000', nickname: '验收观众', mode: 'life' });
  // 灵感池作者（生活模式，无需摄影师认证）
  const life1 = await User.create({ phone: '13800138001', nickname: '灵感摄影师小林', mode: 'life' });
  const life2 = await User.create({ phone: '13800138002', nickname: '城市漫步者', mode: 'life' });
  // 探索池作者（工作模式 + 摄影师认证，会员有效）
  const work1 = await User.create({ phone: '13800138003', nickname: '婚礼摄影师阿杰', mode: 'work', isPhotographer: true, memberStatus: 'active' });
  const work2 = await User.create({ phone: '13800138004', nickname: '风光摄影师老陈', mode: 'work', isPhotographer: true, memberStatus: 'active' });

  // 观众关注 life1（用于验证"已关注作者优先"排序）
  await User.updateOne(
    { _id: viewer._id },
    { $push: { following: life1._id }, $inc: { followingCount: 1 } }
  );

  // 灵感坐标（mode=life，五四广场周边 5km 内，前端初始视口可见）
  await addCoord({
    author: life1, title: '五四广场观景台', lng: 120.3826, lat: 36.0671, mode: 'life',
    createdAt: new Date('2026-08-15T08:00:00+08:00'),
    photos: [
      { takenAt: '2026-08-15T09:30:00+08:00', likes: 128 },
      { takenAt: '2026-08-15T10:15:00+08:00', likes: 56 },
      { takenAt: '2026-08-15T11:00:00+08:00', likes: 89 },
    ],
  });
  await addCoord({
    author: life2, title: '奥帆中心码头', lng: 120.3894, lat: 36.058, mode: 'life',
    createdAt: new Date('2026-08-14T08:00:00+08:00'),
    photos: [
      { takenAt: '2026-08-14T16:00:00+08:00', likes: 210 },
      { takenAt: '2026-08-14T16:40:00+08:00', likes: 88 },
    ],
  });
  await addCoord({
    author: life1, title: '八大关银杏道', lng: 120.3467, lat: 36.058, mode: 'life',
    createdAt: new Date('2026-08-13T08:00:00+08:00'),
    photos: [
      { takenAt: '2026-08-13T08:00:00+08:00', likes: 156 },
      { takenAt: '2026-08-13T09:00:00+08:00', likes: 92 },
    ],
  });

  // 探索坐标（mode=work，作者必须为当前有效摄影师）
  await addCoord({
    author: work1, title: '五四广场婚纱拍摄点', lng: 120.3826, lat: 36.0671, mode: 'work',
    createdAt: new Date('2026-08-15T08:00:00+08:00'),
    photos: [
      { takenAt: '2026-08-15T15:30:00+08:00', likes: 342 },
      { takenAt: '2026-08-15T16:00:00+08:00', likes: 256 },
      { takenAt: '2026-08-15T16:30:00+08:00', likes: 198 },
    ],
  });
  await addCoord({
    author: work1, title: '奥帆中心夜景', lng: 120.3894, lat: 36.058, mode: 'work',
    createdAt: new Date('2026-08-14T08:00:00+08:00'),
    photos: [
      { takenAt: '2026-08-14T19:30:00+08:00', likes: 421 },
      { takenAt: '2026-08-14T20:00:00+08:00', likes: 178 },
    ],
  });
  await addCoord({
    author: work2, title: '八大关老建筑', lng: 120.3467, lat: 36.058, mode: 'work',
    createdAt: new Date('2026-08-13T08:00:00+08:00'),
    photos: [
      { takenAt: '2026-08-13T15:00:00+08:00', likes: 289 },
      { takenAt: '2026-08-13T15:30:00+08:00', likes: 167 },
    ],
  });

  return { viewer };
}

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 10000 });
  console.log('[验收] 内存 MongoDB 已就绪（不连接生产库）');

  const { viewer } = await seed();
  console.log('[验收] 预置数据完成：灵感坐标 3 个 / 探索坐标 3 个 / 作者 4 位');
  console.log('[验收] 登录账号：13800138000（昵称：验收观众）');
  console.log('[验收] 登录密码/验证码：页面点"发送验证码"，验证码看本窗口日志（SMS_DEV_MODE 直接返回）');

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('============================================================');
    console.log('[验收] 后端已启动：http://localhost:' + PORT + '   （健康检查 /health）');
    console.log('[验收] 请另开窗口运行静态服务器：python server.py');
    console.log('[验收] 浏览器打开：http://localhost:8080/memo-home.html');
    console.log('[验收] 验收步骤：登录 → 点灵感/探索 → 应显示预置真实坐标与图片');
    console.log('[验收] 降级验证：Ctrl+C 停掉本窗口 → 刷新页面 → 回退演示数据');
    console.log('[验收] 退出即自动清理内存库，不留任何数据');
    console.log('============================================================');
  });

  const shutdown = async () => {
    console.log('\n[验收] 正在关闭并清理内存库...');
    try { server.close(); } catch (e) {}
    try { await mongoose.disconnect(); } catch (e) {}
    try { await mongo.stop(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error('[验收] 启动失败：', err && err.message);
  if (mongo) { try { await mongo.stop(); } catch (e) {} }
  process.exit(1);
}
