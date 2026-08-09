/**
 * 冒烟测试脚本（不依赖测试框架）
 * 用法：npm run smoke（或 node scripts/smoke.js）
 *
 * 覆盖两级：
 * 1. 不依赖 MongoDB 的验证（启动服务即可跑）：
 *    健康检查 / 未登录拦截 / Token 无效 / 参数校验 / 短信密钥缺失 / 上传凭证 / 文件直传 / 404 兜底
 * 2. 依赖 MongoDB 的完整业务闭环（MongoDB 未就绪时标记"待 MongoDB 就绪"跳过）：
 *    注册（直写验证码种子）→ 资料 → 回调创建照片（幂等）→ 创建坐标 → 地图 markers →
 *    坐标详情 → 点赞/收藏（含 1005 重复）→ 我的照片 → 软删除/恢复/永久删除 → 回收站 →
 *    关注/取关 → 工作模式权限 → refresh/logout
 */
import mongoose from 'mongoose';
import app from '../src/app.js';
import env from '../src/config/env.js';
import { VerificationCode } from '../src/models/index.js';
import * as smsService from '../src/services/sms.service.js';

const results = [];
let tokenA = '';
let refreshTokenA = '';
let tokenB = '';
let photoIdA = '';

function check(name, pass, detail = '') {
  results.push({ name, pass });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`${icon}  ${name}${detail ? '  —  ' + detail : ''}`);
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

try {
  // ================= 第一部分：不依赖 MongoDB =================
  console.log('\n========== 第一部分：不依赖 MongoDB 的冒烟 ==========');

  const health = await call('GET', '/health');
  check('GET /health 返回 200 且 code=0', health.status === 200 && health.body?.code === 0);

  const noToken = await call('GET', '/api/v1/users/me');
  check('未携带 Token 访问受保护接口 → 401/1002', noToken.status === 401 && noToken.body?.code === 1002);

  const badToken = await call('GET', '/api/v1/map/markers?minLng=120&maxLng=121&minLat=36&maxLat=37&zoom=10', { token: 'not-a-real-token' });
  check('无效 Token → 401/1002', badToken.status === 401 && badToken.body?.code === 1002);

  const badPhone = await call('POST', '/api/v1/auth/send-code', { body: { phone: '123', scene: 'login' } });
  check('send-code 手机号格式错误 → 400/1001', badPhone.status === 400 && badPhone.body?.code === 1001);

  const badScene = await call('POST', '/api/v1/auth/send-code', { body: { phone: '13800138000', scene: 'hack' } });
  check('send-code scene 非法 → 400/1001', badScene.status === 400 && badScene.body?.code === 1001);

  if (smsService.isConfigured()) {
    check('短信密钥已配置（跳过 1007 断言，真实发送请人工验证）', true, 'SKIP');
  } else {
    const noSms = await call('POST', '/api/v1/auth/send-code', { body: { phone: '13800138000', scene: 'login' } });
    check('短信密钥未配置 → 503/1007（适配层生效）', noSms.status === 503 && noSms.body?.code === 1007, noSms.body?.message || '');
  }

  const tokenNoBody = await call('POST', '/api/v1/upload/token', { body: {}, token: 'x' });
  // 注意：路由 requireAuth 先于校验器，无效 token 时先 401 —— 这里只断言"有鉴权拦截"
  check('upload/token 未带有效凭证 → 401/1002', tokenNoBody.status === 401 && tokenNoBody.body?.code === 1002);

  if (env.STORAGE_MODE === 'local') {
    const localToken = await call('POST', '/api/v1/upload/token', { body: { fileCount: 3, scene: 'coord' }, token: 'x' });
    check('upload/token 本地模式未登录 → 401/1002', localToken.status === 401 && localToken.body?.code === 1002);
  } else if (env.STORAGE_MODE === 'oss') {
    const ossMis = await call('POST', '/api/v1/upload/token', { body: { fileCount: 1, scene: 'coord' }, token: 'x' });
    check('OSS 模式未登录 → 401/1002', ossMis.status === 401 && ossMis.body?.code === 1002);
  }

  const unknown = await call('GET', '/api/v1/no-such-route');
  check('未知路由 → 404/1004', unknown.status === 404 && unknown.body?.code === 1004);

  const markersBad = await call('GET', '/api/v1/map/markers?minLng=120&maxLng=119&minLat=36&maxLat=37&zoom=10', { token: 'x' });
  check('markers 未登录 → 401/1002（鉴权优先）', markersBad.status === 401 && markersBad.body?.code === 1002);

  // ================= 第二部分：依赖 MongoDB =================
  console.log('\n========== 第二部分：MongoDB 业务闭环（需 mongod 运行）==========');
  let db = false;
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
    db = true;
    console.log('[DB] 已连接，开始完整流程...');
  } catch (e) {
    console.log('[DB] 待 MongoDB 就绪 —— 第二部分跳过（请先启动 mongod）');
  }

  if (db) {
    // 直写验证码种子（绕过短信，属测试步骤）
    await VerificationCode.create({
      phone: '13800138000',
      scene: 'register',
      code: '123456',
      expiresAt: new Date(Date.now() + 300000),
    });
    await VerificationCode.create({
      phone: '13900139000',
      scene: 'register',
      code: '654321',
      expiresAt: new Date(Date.now() + 300000),
    });

    const reg = await call('POST', '/api/v1/auth/register', {
      body: { phone: '13800138000', code: '123456', nickname: '冒烟测试甲', password: 'pass123456' },
    });
    tokenA = reg.body?.data?.token || '';
    refreshTokenA = reg.body?.data?.refreshToken || '';
    check('注册 → 200/0 且返回 token', reg.status === 200 && reg.body?.code === 0 && Boolean(tokenA) && reg.body?.data?.user?.isNewUser === true);

    const regDup = await call('POST', '/api/v1/auth/register', {
      body: { phone: '13800138000', code: '123456', nickname: '冒烟测试甲' },
    });
    check('重复注册 → 409/1005', regDup.status === 409 && regDup.body?.code === 1005);

    const me = await call('GET', '/api/v1/users/me', { token: tokenA });
    check('GET /users/me → 200/0 且手机号脱敏', me.status === 200 && me.body?.code === 0 && /138\*\*\*\*8000/.test(me.body?.data?.phone));

    const upd = await call('PUT', '/api/v1/users/me', { body: { nickname: '冒烟测试甲改', bio: '后端冒烟' }, token: tokenA });
    check('PUT /users/me → 200/0', upd.status === 200 && upd.body?.code === 0 && upd.body?.data?.nickname === '冒烟测试甲改');

    // 上传回调创建照片（本地模式）+ 幂等验证
    const cb1 = await call('POST', '/api/v1/upload/callback', {
      body: { files: [{ key: 'smoke/a.jpg', hash: 'hash-a', size: 1024 }] },
      token: tokenA,
    });
    photoIdA = cb1.body?.data?.photoIds?.[0] || '';
    check('upload/callback 创建照片 → 返回 photoIds', cb1.status === 200 && cb1.body?.code === 0 && Boolean(photoIdA));

    const cb2 = await call('POST', '/api/v1/upload/callback', {
      body: { files: [{ key: 'smoke/a.jpg', hash: 'hash-a', size: 1024 }, { key: 'smoke/b.jpg', hash: 'hash-b', size: 2048 }] },
      token: tokenA,
    });
    const ids2 = cb2.body?.data?.photoIds || [];
    check('回调幂等：重复 hash 不产生新照片（仍为 2 个 ID 且第一个不变）', cb2.status === 200 && ids2.length === 2 && ids2[0] === photoIdA);

    // 创建坐标
    const coord = await call('POST', '/api/v1/coords', {
      body: {
        title: '冒烟坐标·五四广场',
        lng: 120.3826,
        lat: 36.0671,
        photoIds: [photoIdA],
        photoTimes: { [photoIdA]: '2026-08-09T10:30:00Z' },
        isPublic: true,
        mode: 'life',
      },
      token: tokenA,
    });
    const coordId = coord.body?.data?.id || '';
    check('POST /coords 创建坐标 → 200/0', coord.status === 200 && coord.body?.code === 0 && Boolean(coordId));

    // 地图 markers
    const markers = await call('GET', '/api/v1/map/markers?minLng=119&maxLng=121&minLat=35&maxLat=37&zoom=14', { token: tokenA });
    const found = (markers.body?.data || []).some((m) => m.id === coordId);
    check('GET /map/markers 视窗内返回该坐标', markers.status === 200 && markers.body?.code === 0 && found);

    // 坐标详情
    const detail = await call('GET', `/api/v1/coords/${coordId}/detail`, { token: tokenA });
    check('GET coords/detail → 返回坐标信息与照片', detail.status === 200 && detail.body?.code === 0 && detail.body?.data?.totalCount === 1 && detail.body?.data?.photos?.[0]?.id === photoIdA);

    // 点赞/取消 + 1005
    const like1 = await call('POST', `/api/v1/photos/${photoIdA}/like`, { token: tokenA });
    check('POST like → 200/0', like1.status === 200 && like1.body?.code === 0);
    const like2 = await call('POST', `/api/v1/photos/${photoIdA}/like`, { token: tokenA });
    check('重复点赞 → 409/1005', like2.status === 409 && like2.body?.code === 1005);
    const unlike = await call('DELETE', `/api/v1/photos/${photoIdA}/like`, { token: tokenA });
    check('DELETE like → 200/0', unlike.status === 200 && unlike.body?.code === 0);
    const unlike2 = await call('DELETE', `/api/v1/photos/${photoIdA}/like`, { token: tokenA });
    check('重复取消点赞 → 409/1005', unlike2.status === 409 && unlike2.body?.code === 1005);

    // 收藏
    const col1 = await call('POST', `/api/v1/photos/${photoIdA}/collect`, { token: tokenA });
    check('POST collect → 200/0', col1.status === 200 && col1.body?.code === 0);
    const col2 = await call('DELETE', `/api/v1/photos/${photoIdA}/collect`, { token: tokenA });
    check('DELETE collect → 200/0', col2.status === 200 && col2.body?.code === 0);

    // 照片详情
    const pDetail = await call('GET', `/api/v1/photos/${photoIdA}`, { token: tokenA });
    check('GET photos/{id} → 含作者与 EXIF 字段', pDetail.status === 200 && pDetail.body?.code === 0 && 'author' in pDetail.body?.data && 'exif' in pDetail.body?.data);

    // 我的照片（时间 / 坐标分组）
    const mineTime = await call('GET', '/api/v1/photos/mine?sortBy=time', { token: tokenA });
    check('GET photos/mine(time) → 包含照片', mineTime.status === 200 && mineTime.body?.code === 0 && mineTime.body?.data?.total >= 1);
    const mineCoord = await call('GET', '/api/v1/photos/mine?sortBy=coord', { token: tokenA });
    check('GET photos/mine(coord) → 返回坐标分组', mineCoord.status === 200 && mineCoord.body?.code === 0 && (mineCoord.body?.data?.list || []).length >= 1);

    // 关注流：第二个用户关注第一个
    const regB = await call('POST', '/api/v1/auth/register', {
      body: { phone: '13900139000', code: '654321', nickname: '冒烟测试乙' },
    });
    tokenB = regB.body?.data?.token || '';
    const uidA = me.body?.data?.id;
    const follow1 = await call('POST', `/api/v1/users/${uidA}/follow`, { token: tokenB });
    check('关注他人 → 200/0', follow1.status === 200 && follow1.body?.code === 0);
    const follow2 = await call('POST', `/api/v1/users/${uidA}/follow`, { token: tokenB });
    check('重复关注 → 409/1005', follow2.status === 409 && follow2.body?.code === 1005);

    const followers = await call('GET', `/api/v1/users/${uidA}/followers`, { token: tokenA });
    check('粉丝列表包含新粉丝', followers.status === 200 && (followers.body?.data?.list || []).some((u) => u.id === regB.body?.data?.user?.id));

    const unfollow1 = await call('DELETE', `/api/v1/users/${uidA}/follow`, { token: tokenB });
    check('取消关注 → 200/0', unfollow1.status === 200 && unfollow1.body?.code === 0);

    // 工作模式权限
    const modeWork = await call('PUT', '/api/v1/users/me/mode', { body: { mode: 'work' }, token: tokenA });
    check('非摄影师切工作模式 → 403/1003', modeWork.status === 403 && modeWork.body?.code === 1003);
    const modeLife = await call('PUT', '/api/v1/users/me/mode', { body: { mode: 'life' }, token: tokenA });
    check('切换回生活模式 → 200/0', modeLife.status === 200 && modeLife.body?.code === 0);

    // 软删除 → 详情 404 → 恢复 → 详情 OK
    const del = await call('DELETE', `/api/v1/coords/${coordId}`, { token: tokenA });
    check('DELETE /coords 软删除 → 200/0', del.status === 200 && del.body?.code === 0);
    const afterDel = await call('GET', `/api/v1/coords/${coordId}/detail`, { token: tokenA });
    check('删除后详情 → 404/1004', afterDel.status === 404 && afterDel.body?.code === 1004);
    const trash = await call('GET', '/api/v1/photos/trash?type=all', { token: tokenA });
    check('回收站包含已删坐标', trash.status === 200 && (trash.body?.data?.list || []).some((x) => x.type === 'coord' && x.id === coordId));
    const restore = await call('POST', `/api/v1/coords/${coordId}/restore`, { token: tokenA });
    check('恢复坐标 → 200/0', restore.status === 200 && restore.body?.code === 0);
    const afterRestore = await call('GET', `/api/v1/coords/${coordId}/detail`, { token: tokenA });
    check('恢复后详情 → 200/0', afterRestore.status === 200 && afterRestore.body?.code === 0);

    // refresh / logout
    const refresh = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: refreshTokenA } });
    check('refresh 换新令牌 → 200/0', refresh.status === 200 && refresh.body?.code === 0 && Boolean(refresh.body?.data?.token));
    const refreshReplay = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: refreshTokenA } });
    check('旧 refresh 重放 → 401/1002（轮换生效）', refreshReplay.status === 401 && refreshReplay.body?.code === 1002);

    const logout = await call('POST', '/api/v1/auth/logout', { token: tokenA });
    check('logout → 200/0', logout.status === 200 && logout.body?.code === 0);

    // 永久删除
    await call('DELETE', `/api/v1/coords/${coordId}/permanent`, { token: tokenA });
    const gone = await call('GET', `/api/v1/coords/${coordId}/detail`, { token: tokenA });
    check('永久删除后详情 → 404/1004', gone.status === 404 && gone.body?.code === 1004);

    // 清理测试数据
    await mongoose.connection.dropDatabase();
    console.log('[DB] 测试数据已清理（dropDatabase）');
    await mongoose.disconnect();
  }

  // ================= 汇总 =================
  const failed = results.filter((r) => !r.pass);
  console.log(`\n========== 结果：${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ✗ ${f.name}`));
    process.exitCode = 1;
  }
} finally {
  server.close();
  process.exit(process.exitCode || 0);
}
