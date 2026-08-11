/**
 * 邀请码功能冒烟测试（mongodb-memory-server 内存库，无需本机 mongod）
 * 用法：node scripts/smoke-invite.js
 *
 * 覆盖（对应王总定稿产品规则：管理员生成 / 一次性 / 可叠加 / 兑换即认证）：
 * - 生成：非管理员 401 / count 校验（0、101、非数字 → 400/1001）/ 生成 3 个码格式正确且批次内唯一
 * - 列表：分页总数 / 初始全 unused
 * - 兑换：未登录 401 / 格式非法 400 / 码不存在 404 / 小写输入大小写不敏感兑换成功 / 剩余≈30 天
 * - 一次性：重复兑换同码 409/1005；并发双请求同码仅一人成功（原子防重复）
 * - 可叠加：3 个码累计 remainingDays≈90，每次在旧到期点上顺延 ~30 天（不重置）
 * - 兑换即认证：memberStatus=active / isPhotographer=true / autoRenew=false
 * - 落账留痕：amount=0 / status=paid / paymentMethod=invite 的订单，含兑换码
 * - 管理端列表：2 used（含昵称）+ 1 unused
 */
// 先注入测试环境变量再加载 app。
// 注意：ESM 静态 import 会提升到模块顶部先执行（env.js 在赋值前就被加载），
// 因此 app 必须用动态 import，保证 process.env 赋值先于 env.js 读取（dotenv 不覆盖已存在的变量）
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { VerificationCode, MemberOrder, InviteCode } from '../src/models/index.js';

const { default: app } = await import('../src/app.js');

const DAY_MS = 24 * 3600 * 1000;
const results = [];
let tokenA = '';
let uidA = '';
let adminToken = '';

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

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] 内存 MongoDB 已就绪');

  // ============ 前置：注册用户 + 管理员登录 ============
  await VerificationCode.create({
    phone: '13700137000',
    scene: 'register',
    code: '123456',
    expiresAt: new Date(Date.now() + 300000),
  });
  const reg = await call('POST', '/api/v1/auth/register', {
    body: { phone: '13700137000', code: '123456', nickname: '邀请码冒烟用户', password: 'pass123456' },
  });
  tokenA = reg.body?.data?.token || '';
  uidA = reg.body?.data?.user?.id || '';
  check('注册用户 → 200/0 且返回 token', reg.status === 200 && reg.body?.code === 0 && Boolean(tokenA) && Boolean(uidA));

  const adminLogin = await call('POST', '/api/v1/admin/auth/login', { body: { password: process.env.ADMIN_PASSWORD } });
  adminToken = adminLogin.body?.data?.token || '';
  check('管理员登录 → 返回 admin token', adminLogin.status === 200 && Boolean(adminToken));

  // ============ 生成（管理员） ============
  const forbidden = await call('POST', '/api/v1/admin/invite-codes/generate', { body: { count: 3 }, token: tokenA });
  check('非管理员（用户 token）生成 → 401/1002', forbidden.status === 401 && forbidden.body?.code === 1002);

  const badCount0 = await call('POST', '/api/v1/admin/invite-codes/generate', { body: { count: 0 }, token: adminToken });
  check('count=0 → 400/1001', badCount0.status === 400 && badCount0.body?.code === 1001);

  const badCount101 = await call('POST', '/api/v1/admin/invite-codes/generate', { body: { count: 101 }, token: adminToken });
  check('count=101 → 400/1001', badCount101.status === 400 && badCount101.body?.code === 1001);

  const badCountStr = await call('POST', '/api/v1/admin/invite-codes/generate', { body: { count: 'abc' }, token: adminToken });
  check('count 非数字 → 400/1001', badCountStr.status === 400 && badCountStr.body?.code === 1001);

  const gen = await call('POST', '/api/v1/admin/invite-codes/generate', { body: { count: 3 }, token: adminToken });
  const codes = gen.body?.data?.codes || [];
  check(
    '生成 3 个码 → 200/0，格式 VIP+8 位大写字母数字且批次内唯一',
    gen.status === 200 &&
      gen.body?.code === 0 &&
      gen.body?.data?.count === 3 &&
      codes.length === 3 &&
      new Set(codes).size === 3 &&
      codes.every((c) => /^VIP[A-Z0-9]{8}$/.test(c))
  );

  // ============ 列表（管理员） ============
  const list0 = await call('GET', '/api/v1/admin/invite-codes', { token: adminToken });
  const list0Items = list0.body?.data?.list || [];
  check(
    '列表 → total=3 且初始全部 unused（无昵称）',
    list0.status === 200 &&
      list0.body?.code === 0 &&
      list0.body?.data?.total === 3 &&
      list0Items.length === 3 &&
      list0Items.every((c) => c.status === 'unused' && c.usedByNickname === '' && c.usedAt === null)
  );

  // ============ 兑换（用户端） ============
  const noToken = await call('POST', '/api/v1/invite/redeem', { body: { code: codes[0] } });
  check('未登录兑换 → 401/1002', noToken.status === 401 && noToken.body?.code === 1002);

  const badFormat = await call('POST', '/api/v1/invite/redeem', { body: { code: 'VIP123' }, token: tokenA });
  check('码格式非法（短码）→ 400/1001', badFormat.status === 400 && badFormat.body?.code === 1001);

  const notFound = await call('POST', '/api/v1/invite/redeem', { body: { code: 'VIPZZZZZZZZ' }, token: tokenA });
  check('码不存在 → 404/1004', notFound.status === 404 && notFound.body?.code === 1004);

  // 小写输入 → 大小写不敏感，兑换成功
  const redeem1 = await call('POST', '/api/v1/invite/redeem', { body: { code: codes[0].toLowerCase() }, token: tokenA });
  const r1 = redeem1.body?.data || {};
  check(
    '兑换成功（小写输入）→ 200/0 + memberExpireAt + remainingDays≈30 + isPhotographer=true',
    redeem1.status === 200 &&
      redeem1.body?.code === 0 &&
      Boolean(r1.memberExpireAt) &&
      r1.remainingDays >= 29 &&
      r1.remainingDays <= 30 &&
      r1.isPhotographer === true
  );

  // 兑换即认证摄影师（与订阅规则同一联动）
  const status1 = await call('GET', '/api/v1/member/status', { token: tokenA });
  check(
    '兑换即认证：memberStatus=active / isPhotographer=true / autoRenew=false',
    status1.status === 200 &&
      status1.body?.data?.memberStatus === 'active' &&
      status1.body?.data?.isPhotographer === true &&
      status1.body?.data?.autoRenew === false
  );

  // 一次性：重复兑换同码
  const redeemDup = await call('POST', '/api/v1/invite/redeem', { body: { code: codes[0] }, token: tokenA });
  check('重复兑换同一码 → 409/1005', redeemDup.status === 409 && redeemDup.body?.code === 1005);

  // 一次性（并发）：同码双请求仅一人成功（findOneAndUpdate 原子抢占）
  const [raceA, raceB] = await Promise.all([
    call('POST', '/api/v1/invite/redeem', { body: { code: codes[1] }, token: tokenA }),
    call('POST', '/api/v1/invite/redeem', { body: { code: codes[1] }, token: tokenA }),
  ]);
  const raceWin = [raceA, raceB].filter((r) => r.status === 200);
  const raceLose = [raceA, raceB].filter((r) => r.status === 409 && r.body?.code === 1005);
  check('并发兑换同码：恰一人成功、另一人 1005（原子防重复）', raceWin.length === 1 && raceLose.length === 1);

  // 可叠加：兑换第三个码（并发测试已成功兑换 codes[1]，故累计 3 码 ≈90 天）
  // 到期点对比：redeem1 → redeem2 之间相隔 60 天（两次叠加），验证在旧到期点上顺延而非重置
  const redeem2 = await call('POST', '/api/v1/invite/redeem', { body: { code: codes[2] }, token: tokenA });
  const r2 = redeem2.body?.data || {};
  const gapDays = (new Date(r2.memberExpireAt) - new Date(r1.memberExpireAt)) / DAY_MS;
  check(
    '叠加：3 个码累计 → remainingDays≈90 且到期点每次顺延 ~30 天（不重置）',
    redeem2.status === 200 &&
      r2.remainingDays >= 89 &&
      r2.remainingDays <= 91 &&
      gapDays >= 59 &&
      gapDays <= 61
  );

  // ============ 我的记录（用户端） ============
  const usage = await call('GET', '/api/v1/invite/my-usage', { token: tokenA });
  const usageData = usage.body?.data || {};
  check(
    'my-usage → totalRedeemed=3、记录含兑换码、剩余≈90 天',
    usage.status === 200 &&
      usageData.totalRedeemed === 3 &&
      usageData.records.length === 3 &&
      usageData.records.some((x) => x.code === codes[1]) &&
      usageData.records.some((x) => x.code === codes[2]) &&
      usageData.remainingDays >= 89 &&
      usageData.remainingDays <= 91
  );

  // ============ 落账留痕（amount=0 订单） ============
  const orders = await MemberOrder.find({ userId: uidA, planId: 'invite_redeem' }).lean();
  check(
    '兑换落账：3 笔 amount=0 / paid / paymentMethod=invite 且含兑换码与 expireAt',
    orders.length === 3 &&
      orders.every(
        (o) =>
          o.amount === 0 &&
          o.status === 'paid' &&
          o.paymentMethod === 'invite' &&
          o.inviteCode &&
          o.paidAt &&
          o.confirmedAt &&
          o.expireAt
      )
  );

  // 码文档被标记 used
  const usedDoc = await InviteCode.findOne({ code: codes[0] }).lean();
  check('码已标记 used（usedBy/usedAt 落库）', Boolean(usedDoc?.usedBy && usedDoc?.usedAt));

  // ============ 列表（兑换后） ============
  const list1 = await call('GET', '/api/v1/admin/invite-codes', { token: adminToken });
  const list1Items = list1.body?.data?.list || [];
  const used1 = list1Items.filter((c) => c.status === 'used');
  const unused1 = list1Items.filter((c) => c.status === 'unused');
  check(
    '列表 → 3 used（含昵称）+ 0 unused（全部码已兑换）',
    list1.status === 200 &&
      used1.length === 3 &&
      unused1.length === 0 &&
      used1.every((c) => c.usedByNickname === '邀请码冒烟用户' && c.usedAt)
  );

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
