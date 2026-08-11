/**
 * P1 第一批冒烟测试：评论 + 打赏 + 通知（mongodb-memory-server 内存库，无需本机 mongod）
 * 用法：node scripts/smoke-comments-tips-notify.js
 *
 * 覆盖（对应 api.md 6.4 / 6.7-6.9 / 14.1-14.3）：
 * - 评论：空列表 / 发表（含 commentCount +1）/ content 校验 / replyTo 校验（不存在、未评论过）/ 列表 join / 删除（作者与照片作者）/ 越权 1003 / 重复删除与不存在 404
 * - 打赏：成功（tips 按金额累加、tippedBy 联动、通知 type=tip）/ 60 秒限频 1006 / 自己打赏 403 / amount 校验
 * - 通知：写入（comment/reply/tip）/ 未读数 / 列表 type 过滤 / 单条已读 / 越权 1003 / 全部已读
 */
// 先注入测试环境变量再加载 app。
// 注意：ESM 静态 import 会提升到模块顶部先执行（env.js 在赋值前就被加载），
// 因此 app 必须用动态 import，保证 process.env 赋值先于 env.js 读取（dotenv 不覆盖已存在的变量）
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { VerificationCode, Photo, Tip } from '../src/models/index.js';

const { default: app } = await import('../src/app.js');

const MIN60_MS = 60 * 1000;
const results = [];
let tokenA = ''; // 照片作者
let uidA = '';
let tokenB = ''; // 评论/打赏用户
let uidB = '';
let tokenC = ''; // 越权测试用户
let uidC = '';
let photoId = '';

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

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] 内存 MongoDB 已就绪');

  // ============ 前置：注册 3 用户 + 作者建照片 ============
  const uA = await registerUser('13700137001', '照片作者A');
  const uB = await registerUser('13700137002', '评论者B');
  const uC = await registerUser('13700137003', '越权用户C');
  tokenA = uA.token; uidA = uA.uid;
  tokenB = uB.token; uidB = uB.uid;
  tokenC = uC.token; uidC = uC.uid;
  check('注册 A/B/C → 均 200/0 且返回 token', uA.ok && uB.ok && uC.ok && Boolean(uidA && uidB && uidC));

  const photo = await Photo.create({
    authorId: uidA,
    imageUrl: 'https://example.com/smoke-p1.jpg',
    thumbnailUrl: 'https://example.com/smoke-p1-thumb.jpg',
    clientPhotoId: 'smoke-p1-photo-1',
  });
  photoId = String(photo._id);
  check('作者直插照片文档 → 成功', Boolean(photoId));

  // ============ 未登录 ============
  const noTokenComment = await call('POST', `/api/v1/photos/${photoId}/comments`, { body: { content: 'hi' } });
  check('未登录发表评论 → 401/1002', noTokenComment.status === 401 && noTokenComment.body?.code === 1002);
  const noTokenNotify = await call('GET', '/api/v1/notifications');
  check('未登录查通知 → 401/1002', noTokenNotify.status === 401 && noTokenNotify.body?.code === 1002);

  // ============ 评论：初始空列表 ============
  const list0 = await call('GET', `/api/v1/photos/${photoId}/comments`, { token: tokenA });
  check('初始评论列表 → total=0', list0.status === 200 && list0.body?.data?.total === 0);

  // ============ 评论：校验 ============
  const badEmpty = await call('POST', `/api/v1/photos/${photoId}/comments`, { body: { content: '   ' }, token: tokenB });
  check('content 空白 → 400/1001', badEmpty.status === 400 && badEmpty.body?.code === 1001);

  const badLong = await call('POST', `/api/v1/photos/${photoId}/comments`, { body: { content: '长'.repeat(501) }, token: tokenB });
  check('content 501 字 → 400/1001', badLong.status === 400 && badLong.body?.code === 1001);

  const badReplyTo = await call('POST', `/api/v1/photos/${photoId}/comments`, {
    body: { content: '回复不存在的人', replyTo: new mongoose.Types.ObjectId().toString() },
    token: tokenB,
  });
  check('replyTo 用户不存在 → 404/1004', badReplyTo.status === 404 && badReplyTo.body?.code === 1004);

  const replyToNoComment = await call('POST', `/api/v1/photos/${photoId}/comments`, {
    body: { content: '回复没评论过的人', replyTo: uidC },
    token: tokenB,
  });
  check('replyTo 未评论该照片 → 404/1004', replyToNoComment.status === 404 && replyToNoComment.body?.code === 1004);

  const badPhoto = await call('GET', `/api/v1/photos/${new mongoose.Types.ObjectId().toString()}/comments`, { token: tokenB });
  check('评论列表-照片不存在 → 404/1004', badPhoto.status === 404 && badPhoto.body?.code === 1004);

  // ============ 评论：发表 ============
  // A 评论自己的照片（本人不通知自己）
  const cA = await call('POST', `/api/v1/photos/${photoId}/comments`, { body: { content: 'A 的第一条评论' }, token: tokenA });
  check('作者评论自己照片 → 200/0，作者 join 正确', cA.status === 200 && cA.body?.code === 0 && cA.body?.data?.author?.nickname === '照片作者A');
  const photoAfterA = await Photo.findById(photoId).select('commentCount').lean();
  check('发布评论后 commentCount=1', photoAfterA?.commentCount === 1);

  // B 评论（通知 A type=comment）
  const cB = await call('POST', `/api/v1/photos/${photoId}/comments`, { body: { content: 'B 的评论' }, token: tokenB });
  check('B 发表评论 → 200/0', cB.status === 200 && cB.body?.code === 0);

  // B 回复 A（通知 A type=reply）
  const cBReply = await call('POST', `/api/v1/photos/${photoId}/comments`, {
    body: { content: 'B 回复 A', replyTo: uidA },
    token: tokenB,
  });
  check('B 回复 A → 200/0 且 replyTo 回显', cBReply.status === 200 && cBReply.body?.data?.replyTo === uidA);

  // C 回复 B（通知 B type=reply）
  const cCReply = await call('POST', `/api/v1/photos/${photoId}/comments`, {
    body: { content: 'C 回复 B', replyTo: uidB },
    token: tokenC,
  });
  check('C 回复 B → 200/0', cCReply.status === 200 && cCReply.body?.code === 0);

  const photoAfter4 = await Photo.findById(photoId).select('commentCount').lean();
  check('累计 4 条评论 → commentCount=4', photoAfter4?.commentCount === 4);

  // ============ 评论：列表（join 作者 + replyTo） ============
  const list1 = await call('GET', `/api/v1/photos/${photoId}/comments`, { token: tokenA });
  const l1 = list1.body?.data?.list || [];
  const l1Reply = l1.find((x) => x.replyTo?.id === uidA);
  check(
    '列表 → total=4、倒序、作者昵称 join、replyTo 昵称 join',
    list1.status === 200 &&
      list1.body?.data?.total === 4 &&
      l1.length === 4 &&
      l1[0].content === 'C 回复 B' &&
      l1.every((x) => x.author?.nickname) &&
      Boolean(l1Reply?.replyTo?.nickname === '照片作者A')
  );

  // ============ 评论：删除 ============
  // B 删自己的评论
  const delSelf = await call('DELETE', `/api/v1/photos/${photoId}/comments/${cB.body.data.id}`, { token: tokenB });
  check('作者本人删除自己评论 → 200/0', delSelf.status === 200 && delSelf.body?.code === 0);

  // C 删 B 的评论（越权，C 非评论作者也非照片作者）
  const delForbidden = await call('DELETE', `/api/v1/photos/${photoId}/comments/${cBReply.body.data.id}`, { token: tokenC });
  check('C 删 B 的评论 → 403/1003', delForbidden.status === 403 && delForbidden.body?.code === 1003);

  // 照片作者 A 删 C 的评论
  const delByPhotoAuthor = await call('DELETE', `/api/v1/photos/${photoId}/comments/${cCReply.body.data.id}`, { token: tokenA });
  check('照片作者删除他人评论 → 200/0', delByPhotoAuthor.status === 200 && delByPhotoAuthor.body?.code === 0);
  const photoAfterDel = await Photo.findById(photoId).select('commentCount').lean();
  check('删除 2 条后 commentCount=2', photoAfterDel?.commentCount === 2);

  // 重复删除 / 不存在
  const delAgain = await call('DELETE', `/api/v1/photos/${photoId}/comments/${cB.body.data.id}`, { token: tokenB });
  check('重复删除同一条 → 404/1004', delAgain.status === 404 && delAgain.body?.code === 1004);
  const delGhost = await call('DELETE', `/api/v1/photos/${photoId}/comments/${new mongoose.Types.ObjectId().toString()}`, { token: tokenB });
  check('删除不存在的评论 → 404/1004', delGhost.status === 404 && delGhost.body?.code === 1004);

  // ============ 打赏：校验 ============
  const tipBad0 = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 0 }, token: tokenB });
  check('amount=0 → 400/1001', tipBad0.status === 400 && tipBad0.body?.code === 1001);
  const tipBad101 = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 101 }, token: tokenB });
  check('amount=101 → 400/1001', tipBad101.status === 400 && tipBad101.body?.code === 1001);
  const tipBadStr = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 'abc' }, token: tokenB });
  check('amount 非数字 → 400/1001', tipBadStr.status === 400 && tipBadStr.body?.code === 1001);
  const tipSelf = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 10 }, token: tokenA });
  check('打赏自己的照片 → 403/1003', tipSelf.status === 403 && tipSelf.body?.code === 1003);

  // ============ 打赏：成功与限频 ============
  const tip1 = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 10 }, token: tokenB });
  const photoTip1 = await Photo.findById(photoId).select('tips tippedBy').lean();
  check(
    'B 打赏 10 → 200/0，tips=10 且 tippedBy 含 B',
    tip1.status === 200 && tip1.body?.data?.tips === 10 && photoTip1?.tips === 10 && photoTip1?.tippedBy?.map(String).includes(uidB)
  );

  const tipAgain = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 5 }, token: tokenB });
  check('60 秒内再次打赏 → 429/1006 限频', tipAgain.status === 429 && tipAgain.body?.code === 1006);

  // 回拨最近一条打赏时间到 61 秒前，验证限频解除
  // 注意：必须走原生驱动 Tip.collection（mongoose 的 timestamps:true 会覆盖 updateOne 里手动 $set 的 createdAt）
  await Tip.collection.updateOne(
    { photoId: new mongoose.Types.ObjectId(photoId), tipperId: new mongoose.Types.ObjectId(uidB) },
    { $set: { createdAt: new Date(Date.now() - 61 * 1000) } }
  );
  const tip2 = await call('POST', `/api/v1/photos/${photoId}/tip`, { body: { amount: 5 }, token: tokenB });
  const photoTip2 = await Photo.findById(photoId).select('tips tippedBy').lean();
  check(
    '限频解除后再打赏 5 → 200/0，tips=15（金额累加）',
    tip2.status === 200 && tip2.body?.data?.tips === 15 && photoTip2?.tips === 15 && photoTip2?.tippedBy?.length === 1
  );

  // ============ 通知：写入与未读数 ============
  // A 应收到：comment（B 评论）、reply（B 回复 A）、tip ×2（B 两次打赏）→ 4 条未读
  const unreadA = await call('GET', '/api/v1/notifications/unread-count', { token: tokenA });
  check('A 未读数 = 6（comment×3 + reply + tip×2）', unreadA.status === 200 && unreadA.body?.data?.count === 6, `实际 ${unreadA.body?.data?.count}`);

  // B 应收到：reply（C 回复 B）→ 1 条未读
  const unreadB = await call('GET', '/api/v1/notifications/unread-count', { token: tokenB });
  check('B 未读数 = 1（C 的回复）', unreadB.status === 200 && unreadB.body?.data?.count === 1);

  // 通知列表：类型过滤 + actor join + photo join
  const nListTip = await call('GET', '/api/v1/notifications?type=tip', { token: tokenA });
  const nlt = nListTip.body?.data?.list || [];
  check(
    '通知列表 type=tip → 2 条，actor/photo join 完整',
    nListTip.status === 200 &&
      nListTip.body?.data?.total === 2 &&
      nlt.length === 2 &&
      nlt.every((x) => x.type === 'tip') &&
      nlt.every((x) => x.actor?.nickname === '评论者B') &&
      nlt.every((x) => x.photo?.id === photoId)
  );

  const nListAll = await call('GET', '/api/v1/notifications', { token: tokenA });
  check('通知列表（不分页过滤）→ total=6 且含 comment/reply/tip 三种', nListAll.status === 200 && nListAll.body?.data?.total === 6 && new Set(nListAll.body?.data?.list?.map((x) => x.type)).size === 3, `实际 ${nListAll.body?.data?.total}`);

  const nBadType = await call('GET', '/api/v1/notifications?type=bogus', { token: tokenA });
  check('通知 type 非法 → 400/1001', nBadType.status === 400 && nBadType.body?.code === 1001);

  // ============ 通知：已读与越权 ============
  const firstN = nListAll.body?.data?.list[0];
  const readForbidden = await call('PUT', `/api/v1/notifications/${firstN.id}/read`, { token: tokenB });
  check('B 读 A 的通知 → 403/1003', readForbidden.status === 403 && readForbidden.body?.code === 1003);

  const readGhost = await call('PUT', `/api/v1/notifications/${new mongoose.Types.ObjectId().toString()}/read`, { token: tokenA });
  check('读不存在的通知 → 404/1004', readGhost.status === 404 && readGhost.body?.code === 1004);

  const read1 = await call('PUT', `/api/v1/notifications/${firstN.id}/read`, { token: tokenA });
  check('A 单条已读 → 200/0', read1.status === 200 && read1.body?.code === 0 && read1.body?.data?.isRead === true);

  const unreadA2 = await call('GET', '/api/v1/notifications/unread-count', { token: tokenA });
  check('单条已读后 A 未读数 = 5', unreadA2.status === 200 && unreadA2.body?.data?.count === 5, `实际 ${unreadA2.body?.data?.count}`);

  const readAll = await call('PUT', '/api/v1/notifications/read-all', { token: tokenA });
  check('全部已读 → updated=5', readAll.status === 200 && readAll.body?.code === 0 && readAll.body?.data?.updated === 5, `实际 ${readAll.body?.data?.updated}`);

  const unreadA3 = await call('GET', '/api/v1/notifications/unread-count', { token: tokenA });
  check('全部已读后 A 未读数 = 0', unreadA3.status === 200 && unreadA3.body?.data?.count === 0);

  // 照片详情透出 commentCount（P1 联动）
  const detail = await call('GET', `/api/v1/photos/${photoId}`, { token: tokenA });
  check('照片详情 → commentCount=2 / tips=15', detail.status === 200 && detail.body?.data?.commentCount === 2 && detail.body?.data?.tips === 15);

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
