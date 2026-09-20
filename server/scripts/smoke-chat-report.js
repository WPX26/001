/**
 * P1 第三批（最后一批）冒烟测试：举报 + 私信（REST + WebSocket）
 * 用法：node scripts/smoke-chat-report.js（mongodb-memory-server 内存库，无需本机 mongod）
 *
 * 覆盖（对应 api.md 14.5 举报 / 第 9 章私信 / 附录 A WebSocket）：
 * - 举报：photo/comment/user 成功、目标不存在 404、重复举报 1005、举报自己 1001、
 *   软删照片 404、reason 超长 1001、未登录 401、targetType 非法 1001
 * - 会话：创建成功、幂等返回同一会话、不能和自己建 1001、peer 不存在 404
 * - 发消息：text/image/coord 成功、type 细分校验 1001、lastMessage 快照同步、对端未读 +1、
 *   chat 通知落库且不通知自己
 * - 会话列表：unreadCount / peer 昵称头像 / lastMessage 预览
 * - 已读：清零本人未读 + readBy 回写
 * - 游标分页：before 语义（createdAt < before 倒序）、hasMore、非法 before 1001、limit 超限 1001
 * - 越权：非成员 GET/POST/PUT 均 403/1003；会话不存在 404/1004
 * - WebSocket：鉴权成功接收 new_message 推送、多连接广播、非法 token 4001 拒绝、断线清理
 */
// 先注入测试环境变量再加载 app（ESM 静态 import 提升，app 必须动态 import）
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import WebSocketClient from 'ws';
import { VerificationCode, User, Photo, Comment, Conversation, Message, Notification, Report } from '../src/models/index.js';
import { attachChatWS, onlineUserCount } from '../src/services/chat.ws.js';

const { default: app } = await import('../src/app.js');

const results = [];
let uidA = '', uidB = '', uidC = '';
let tokenA = '', tokenB = '', tokenC = '';
let convAB = ''; // A↔B 会话
let convAC = ''; // A↔C 会话（游标分页专用）
let photoId = '', photoDeletedId = '', commentId = '';
let coordMsg = null; // B 发坐标消息的响应

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
attachChatWS(server);
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

/** 直插照片（deleted 时带软删标记） */
let photoSeq = 0;
async function makePhoto(authorId, { deleted = false } = {}) {
  photoSeq += 1;
  return Photo.create({
    authorId,
    imageUrl: `https://example.com/r${photoSeq}.jpg`,
    thumbnailUrl: `https://example.com/r${photoSeq}-t.jpg`,
    clientPhotoId: `chat-report-${photoSeq}`,
    likes: 0,
    takenAt: new Date(),
    uploadTime: new Date(),
    likedBy: [],
    deletedAt: deleted ? new Date() : null,
  });
}

/** 直插消息（createdAt 用原生 collection.updateOne 覆盖——Mongoose timestamps 插件会覆盖 $set 的 createdAt，
 *  原生驱动绕过插件，保证游标时间确定） */
async function makeMessage({ conversationId, senderId, type = 'text', content = '', createdAt }) {
  const m = await Message.create({ conversationId, senderId, type, content });
  await Message.collection.updateOne({ _id: m._id }, { $set: { createdAt } });
  return m;
}

/** 等待 ws 客户端收到下一条消息（轮询队列，超时返回 null） */
async function waitForWsMessage(ws, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ws._queue && ws._queue.length) return ws._queue.shift();
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

let mongo = null;
try {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 5000 });
  console.log('[DB] 内存 MongoDB 已就绪');

  // ============ 前置：注册用户 + 举报目标数据 ============
  const uA = await registerUser('13800138101', '用户A');
  const uB = await registerUser('13800138102', '用户B');
  const uC = await registerUser('13800138103', '用户C');
  uidA = uA.uid; uidB = uB.uid; uidC = uC.uid;
  tokenA = uA.token; tokenB = uB.token; tokenC = uC.token;
  check('注册 A/B/C → 均 200/0 且返回 token', uA.ok && uB.ok && uC.ok);

  // B 的照片（正常 + 已软删）、B 在正常照片下的评论
  const ph1 = await makePhoto(uidB);
  photoId = String(ph1._id);
  const phDel = await makePhoto(uidB, { deleted: true });
  photoDeletedId = String(phDel._id);
  const cm1 = await Comment.create({ photoId, authorId: uidB, content: '这是一条待举报的评论' });
  commentId = String(cm1._id);

  // ============ 举报（api.md 14.5） ============
  const rPhoto = await call('POST', '/api/v1/report', {
    body: { targetType: 'photo', targetId: photoId, reason: '疑似盗图' },
    token: tokenA,
  });
  check('举报照片 → 200/0 返回 id/status=pending', rPhoto.status === 200 && rPhoto.body?.code === 0 && rPhoto.body?.data?.status === 'pending');

  const rDup = await call('POST', '/api/v1/report', {
    body: { targetType: 'photo', targetId: photoId, reason: '再报一次' },
    token: tokenA,
  });
  check('重复举报同一照片 → 409/1005', rDup.status === 409 && rDup.body?.code === 1005);

  const rComment = await call('POST', '/api/v1/report', {
    body: { targetType: 'comment', targetId: commentId, reason: '人身攻击' },
    token: tokenA,
  });
  check('举报评论 → 200/0', rComment.status === 200 && rComment.body?.code === 0);

  const rUser = await call('POST', '/api/v1/report', {
    body: { targetType: 'user', targetId: uidB, reason: '发布垃圾内容' },
    token: tokenA,
  });
  check('举报用户 → 200/0', rUser.status === 200 && rUser.body?.code === 0);

  const rSelf = await call('POST', '/api/v1/report', {
    body: { targetType: 'user', targetId: uidA, reason: '测试举报自己' },
    token: tokenA,
  });
  check('举报自己(user) → 400/1001', rSelf.status === 400 && rSelf.body?.code === 1001);

  const ghostId = new mongoose.Types.ObjectId().toString();
  const rGhostPhoto = await call('POST', '/api/v1/report', { body: { targetType: 'photo', targetId: ghostId, reason: '不存在' }, token: tokenA });
  const rGhostComment = await call('POST', '/api/v1/report', { body: { targetType: 'comment', targetId: ghostId, reason: '不存在' }, token: tokenA });
  const rGhostUser = await call('POST', '/api/v1/report', { body: { targetType: 'user', targetId: ghostId, reason: '不存在' }, token: tokenA });
  check('举报不存在的照片/评论/用户 → 404/1004',
    rGhostPhoto.status === 404 && rGhostPhoto.body?.code === 1004 &&
    rGhostComment.status === 404 && rGhostComment.body?.code === 1004 &&
    rGhostUser.status === 404 && rGhostUser.body?.code === 1004);

  const rDeleted = await call('POST', '/api/v1/report', { body: { targetType: 'photo', targetId: photoDeletedId, reason: '已删除' }, token: tokenA });
  check('举报已软删照片 → 404/1004', rDeleted.status === 404 && rDeleted.body?.code === 1004);

  const rLong = await call('POST', '/api/v1/report', { body: { targetType: 'photo', targetId: photoId, reason: '长'.repeat(201) }, token: tokenA });
  check('举报原因超 200 字 → 400/1001', rLong.status === 400 && rLong.body?.code === 1001);

  const rNoToken = await call('POST', '/api/v1/report', { body: { targetType: 'photo', targetId: photoId, reason: '未登录' } });
  check('未登录举报 → 401/1002', rNoToken.status === 401 && rNoToken.body?.code === 1002);

  const rBadType = await call('POST', '/api/v1/report', { body: { targetType: 'bogus', targetId: photoId, reason: '类型非法' }, token: tokenA });
  check('targetType 非法 → 400/1001', rBadType.status === 400 && rBadType.body?.code === 1001);

  const reportTotal = await Report.countDocuments({ reporterId: uidA, status: 'pending' });
  check('落库 3 条待处理举报', reportTotal === 3, `实际 ${reportTotal}`);

  // ============ 会话：创建/幂等/非法（9.4） ============
  const conv1 = await call('POST', '/api/v1/chat/conversations', { body: { peerId: uidB }, token: tokenA });
  convAB = conv1.body?.data?.conversationId || '';
  check('A 创建与 B 的会话 → 200/0 且 peer 信息完整',
    conv1.status === 200 && conv1.body?.code === 0 &&
    conv1.body?.data?.peerId === uidB && conv1.body?.data?.peerName === '用户B' &&
    conv1.body?.data?.unreadCount === 0,
    `实际 ${JSON.stringify(conv1.body?.data)}`);

  const conv2 = await call('POST', '/api/v1/chat/conversations', { body: { peerId: uidB }, token: tokenA });
  check('重复创建同一会话 → 幂等返回同一 conversationId', conv2.status === 200 && conv2.body?.data?.conversationId === convAB);

  const convFromB = await call('POST', '/api/v1/chat/conversations', { body: { peerId: uidA }, token: tokenB });
  check('B 反向创建 → 幂等返回同一会话', convFromB.status === 200 && convFromB.body?.data?.conversationId === convAB);

  const convSelf = await call('POST', '/api/v1/chat/conversations', { body: { peerId: uidA }, token: tokenA });
  check('和自己创建会话 → 400/1001', convSelf.status === 400 && convSelf.body?.code === 1001);

  const convGhost = await call('POST', '/api/v1/chat/conversations', { body: { peerId: ghostId }, token: tokenA });
  check('peer 不存在 → 404/1004', convGhost.status === 404 && convGhost.body?.code === 1004);

  // ============ 发消息：text / image / coord（9.3） ============
  const mText = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'text', content: '你好呀～很高兴在这里相遇！' }, token: tokenA });
  check('A 发文字消息 → 200/0 返回完整 DTO',
    mText.status === 200 && mText.body?.code === 0 &&
    mText.body?.data?.type === 'text' && mText.body?.data?.content === '你好呀～很高兴在这里相遇！' &&
    mText.body?.data?.senderId === uidA && Array.isArray(mText.body?.data?.readBy));

  let convDoc = await Conversation.findById(convAB).lean();
  check('会话快照同步 → lastMessage=该文字 + lastMessageAt 更新 + B 未读=1',
    convDoc?.lastMessage?.type === 'text' && convDoc?.lastMessage?.content === '你好呀～很高兴在这里相遇！' &&
    convDoc?.lastMessage?.senderId?.toString() === uidA && convDoc?.lastMessageAt &&
    convDoc?.unreadCounts?.[uidB] === 1,
    `实际 unread=${JSON.stringify(convDoc?.unreadCounts)} last=${JSON.stringify(convDoc?.lastMessage)}`);
  check('A 本人未读不增加（unreadCounts 无 A 键）', !convDoc?.unreadCounts?.[uidA]);

  const nB = await Notification.countDocuments({ userId: uidB, type: 'chat', actorId: uidA });
  const nA = await Notification.countDocuments({ userId: uidA, type: 'chat' });
  check('chat 通知 → B 收到 1 条且 actor=A；A 不收到自己的通知', nB === 1 && nA === 0, `B=${nB} A=${nA}`);

  const mTextEmpty = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'text', content: '   ' }, token: tokenA });
  check('空文字内容 → 400/1001', mTextEmpty.status === 400 && mTextEmpty.body?.code === 1001);
  const mTextLong = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'text', content: '长'.repeat(2001) }, token: tokenA });
  check('文字超 2000 字 → 400/1001', mTextLong.status === 400 && mTextLong.body?.code === 1001);

  const mImg = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'image', imageUrl: 'https://example.com/chat.jpg' }, token: tokenB });
  check('B 发图片消息 → 200/0 带 imageUrl', mImg.status === 200 && mImg.body?.data?.type === 'image' && mImg.body?.data?.imageUrl === 'https://example.com/chat.jpg');

  const mImgNoUrl = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'image' }, token: tokenB });
  check('图片缺 imageUrl → 400/1001', mImgNoUrl.status === 400 && mImgNoUrl.body?.code === 1001);

  const mCoord = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'coord', coord: { lng: 120.38, lat: 36.06 } }, token: tokenB });
  coordMsg = mCoord.body?.data;
  check('B 发坐标消息 → 200/0 返回 coord {lng,lat}',
    mCoord.status === 200 && mCoord.body?.data?.type === 'coord' &&
    mCoord.body?.data?.coord?.lng === 120.38 && mCoord.body?.data?.coord?.lat === 36.06);

  const mCoordNone = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'coord' }, token: tokenB });
  check('坐标消息缺 coord → 400/1001', mCoordNone.status === 400 && mCoordNone.body?.code === 1001);
  const mCoordBad = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'coord', coord: { lng: 120, lat: 200 } }, token: tokenB });
  check('坐标越界(lat=200) → 400/1001', mCoordBad.status === 400 && mCoordBad.body?.code === 1001);

  convDoc = await Conversation.findById(convAB).lean();
  check('会话快照最终态 → lastMessage=坐标(lng/lat 同步) + A 未读=2、B 未读=1',
    convDoc?.lastMessage?.type === 'coord' && convDoc?.lastMessage?.coord?.lng === 120.38 &&
    convDoc?.lastMessage?.coord?.lat === 36.06 &&
    convDoc?.unreadCounts?.[uidA] === 2 && convDoc?.unreadCounts?.[uidB] === 1,
    `实际 unread=${JSON.stringify(convDoc?.unreadCounts)} last=${JSON.stringify(convDoc?.lastMessage)}`);

  // ============ 会话列表（9.1） ============
  const listA = await call('GET', '/api/v1/chat/conversations', { token: tokenA });
  const itemA = listA.body?.data?.list?.find((c) => c.conversationId === convAB);
  check('A 的会话列表 → unreadCount=2、lastMessage=[位置]、peer=B 昵称头像完整',
    listA.status === 200 && itemA?.unreadCount === 2 && itemA?.lastMessage === '[位置]' &&
    itemA?.peerId === uidB && itemA?.peerName === '用户B' && typeof itemA?.peerAvatar === 'string');

  const listB = await call('GET', '/api/v1/chat/conversations', { token: tokenB });
  const itemB = listB.body?.data?.list?.find((c) => c.conversationId === convAB);
  check('B 的会话列表 → unreadCount=1、peer=A', listB.status === 200 && itemB?.unreadCount === 1 && itemB?.peerId === uidA);

  // ============ 聊天记录 + 游标分页（9.2） ============
  const hist = await call('GET', `/api/v1/chat/conversations/${convAB}/messages`, { token: tokenA });
  const hList = hist.body?.data?.list || [];
  check('聊天记录默认 limit=30 → 3 条倒序 [coord,image,text] hasMore=false',
    hist.status === 200 && hList.length === 3 &&
    hList[0]?.type === 'coord' && hList[1]?.type === 'image' &&
    hList[2]?.content === '你好呀～很高兴在这里相遇！' &&
    hist.body?.data?.hasMore === false,
    `实际 ${hList.map((m) => m.type).join(',')}`);

  const p1 = await call('GET', `/api/v1/chat/conversations/${convAB}/messages?limit=2&before=${coordMsg.createdAt}`, { token: tokenA });
  check('游标 before=坐标消息 → 取 [image, text] hasMore=false（仅 3 条，已到底）',
    p1.status === 200 && (p1.body?.data?.list || []).length === 2 &&
    p1.body?.data?.list[0]?.type === 'image' && p1.body?.data?.list[1]?.type === 'text' &&
    p1.body?.data?.hasMore === false,
    `实际 ${JSON.stringify((p1.body?.data?.list || []).map((m) => m.type))}`);

  const p2 = await call('GET', `/api/v1/chat/conversations/${convAB}/messages?limit=1&before=${hList[1]?.createdAt}`, { token: tokenA });
  check('继续翻页 before=image → 取 [text] hasMore=false',
    p2.status === 200 && (p2.body?.data?.list || []).length === 1 &&
    p2.body?.data?.list[0]?.type === 'text' && p2.body?.data?.hasMore === false);

  const pBad = await call('GET', `/api/v1/chat/conversations/${convAB}/messages?before=bogus-date`, { token: tokenA });
  check('before 非法格式 → 400/1001', pBad.status === 400 && pBad.body?.code === 1001);

  const pLimit = await call('GET', `/api/v1/chat/conversations/${convAB}/messages?limit=999`, { token: tokenA });
  check('limit 超上限(999) → 400/1001', pLimit.status === 400 && pLimit.body?.code === 1001);

  // ============ 已读（9.5） ============
  const rd = await call('PUT', `/api/v1/chat/conversations/${convAB}/read`, { token: tokenB });
  check('B 标记已读 → 200/0 unreadCount=0', rd.status === 200 && rd.body?.data?.unreadCount === 0);

  convDoc = await Conversation.findById(convAB).lean();
  check('已读后 B 未读清零、A 未读不受影响(2)', convDoc?.unreadCounts?.[uidB] === 0 && convDoc?.unreadCounts?.[uidA] === 2);

  const histAfterRead = await call('GET', `/api/v1/chat/conversations/${convAB}/messages`, { token: tokenA });
  const textMsg = histAfterRead.body?.data?.list?.find((m) => m.content === '你好呀～很高兴在这里相遇！');
  check('readBy 回写 → 文字消息 readBy 含 B', textMsg?.readBy?.includes(uidB));

  // ============ 越权（非成员） + 不存在 ============
  const cGet = await call('GET', `/api/v1/chat/conversations/${convAB}/messages`, { token: tokenC });
  check('非成员 C 查记录 → 403/1003', cGet.status === 403 && cGet.body?.code === 1003);
  const cPost = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'text', content: '插话' }, token: tokenC });
  check('非成员 C 发消息 → 403/1003', cPost.status === 403 && cPost.body?.code === 1003);
  const cRead = await call('PUT', `/api/v1/chat/conversations/${convAB}/read`, { token: tokenC });
  check('非成员 C 标记已读 → 403/1003', cRead.status === 403 && cRead.body?.code === 1003);

  const ghostConv = await call('GET', `/api/v1/chat/conversations/${ghostId}/messages`, { token: tokenA });
  check('会话不存在 → 404/1004', ghostConv.status === 404 && ghostConv.body?.code === 1004);

  // ============ 游标分页（独立会话，确定性 createdAt） ============
  const convAC1 = await call('POST', '/api/v1/chat/conversations', { body: { peerId: uidC }, token: tokenA });
  convAC = convAC1.body?.data?.conversationId || '';
  check('A 创建与 C 的会话（分页专用）→ 200', convAC1.status === 200 && !!convAC);

  const T1 = new Date('2026-08-10T10:00:01Z');
  const T2 = new Date('2026-08-10T10:00:02Z');
  const T3 = new Date('2026-08-10T10:00:03Z');
  const T4 = new Date('2026-08-10T10:00:04Z');
  const T5 = new Date('2026-08-10T10:00:05Z');
  for (const t of [T1, T2, T3, T4, T5]) {
    await makeMessage({ conversationId: convAC, senderId: uidC, content: `page-${t.getUTCSeconds()}`, createdAt: t });
  }

  const pg1 = await call('GET', `/api/v1/chat/conversations/${convAC}/messages?limit=2&before=${T4.toISOString()}`, { token: tokenA });
  check('分页 page1(before=T4,limit=2) → [T3,T2] hasMore=true',
    pg1.status === 200 && (pg1.body?.data?.list || []).map((m) => m.content).join(',') === 'page-3,page-2' && pg1.body?.data?.hasMore === true,
    `实际 ${JSON.stringify((pg1.body?.data?.list || []).map((m) => m.content))}`);

  const pg2 = await call('GET', `/api/v1/chat/conversations/${convAC}/messages?limit=2&before=${T2.toISOString()}`, { token: tokenA });
  check('分页 page2(before=T2,limit=2) → [T1] hasMore=false',
    pg2.status === 200 && (pg2.body?.data?.list || []).map((m) => m.content).join(',') === 'page-1' && pg2.body?.data?.hasMore === false);

  const pgAll = await call('GET', `/api/v1/chat/conversations/${convAC}/messages`, { token: tokenA });
  check('分页默认拉取 → 5 条倒序 [T5..T1]',
    pgAll.status === 200 && (pgAll.body?.data?.list || []).map((m) => m.content).join(',') === 'page-5,page-4,page-3,page-2,page-1');

  // ============ WebSocket（附录 A /chat/ws） ============
  const wsB1 = new WebSocketClient(`ws://127.0.0.1:${server.address().port}/api/v1/chat/ws?token=${encodeURIComponent(tokenB)}`);
  wsB1._queue = [];
  wsB1.on('message', (raw) => wsB1._queue.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    wsB1.once('open', resolve);
    wsB1.once('error', reject);
  });
  check('WS 连接(B 合法 token) → 握手成功', wsB1.readyState === WebSocketClient.OPEN);

  const wsB2 = new WebSocketClient(`ws://127.0.0.1:${server.address().port}/api/v1/chat/ws?token=${encodeURIComponent(tokenB)}`);
  wsB2._queue = [];
  wsB2.on('message', (raw) => wsB2._queue.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    wsB2.once('open', resolve);
    wsB2.once('error', reject);
  });
  check('WS 多连接(B 第二个连接) → 握手成功', wsB2.readyState === WebSocketClient.OPEN);
  check('WS 在线用户表 → B 1 个用户 2 连接', onlineUserCount() === 1);

  const wsPush = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'text', content: 'WS 实时推送测试' }, token: tokenA });
  const push1 = await waitForWsMessage(wsB1);
  const push2 = await waitForWsMessage(wsB2);
  check('A 发消息 → B 两个连接都收到 new_message 推送',
    wsPush.status === 200 &&
    push1?.type === 'new_message' && push1?.data?.conversationId === convAB && push1?.data?.message?.content === 'WS 实时推送测试' &&
    push2?.type === 'new_message' && push2?.data?.conversationId === convAB,
    `实际 wsB1=${JSON.stringify(push1)} wsB2=${JSON.stringify(push2)}`);

  const wsPush2 = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`, { body: { type: 'text', content: '第二条实时推送' }, token: tokenA });
  const push3 = await waitForWsMessage(wsB1);
  check('再次发消息 → B 第一连接继续收到推送', wsPush2.status === 200 && push3?.data?.message?.content === '第二条实时推送');

  const badWs = new WebSocketClient(`ws://127.0.0.1:${server.address().port}/api/v1/chat/ws?token=invalid-token-xxx`);
  const badClose = await new Promise((resolve) => {
    badWs.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    badWs.once('error', () => resolve({ code: -1 }));
    setTimeout(() => resolve({ code: -1, reason: 'timeout' }), 2000);
  });
  check('WS 非法 token → 4001 拒绝', badClose.code === 4001, `实际 code=${badClose.code}`);

  // WS 消息也计未读：B 已读后 A 又发 2 条 → B 未读=2，再次已读清零
  convDoc = await Conversation.findById(convAB).lean();
  check('WS 推送消息同步未读 → B 未读=2', convDoc?.unreadCounts?.[uidB] === 2, `实际 ${JSON.stringify(convDoc?.unreadCounts)}`);
  await call('PUT', `/api/v1/chat/conversations/${convAB}/read`, { token: tokenB });
  convDoc = await Conversation.findById(convAB).lean();
  check('再次已读 → B 未读清零', convDoc?.unreadCounts?.[uidB] === 0);

  // 断线清理
  wsB1.close();
  await new Promise((r) => setTimeout(r, 100));
  check('关闭一个连接 → B 仍在线（另一连接在）', onlineUserCount() === 1);
  wsB2.close();
  await new Promise((r) => setTimeout(r, 100));
  check('全部断开 → 在线表清空', onlineUserCount() === 0);

  // ============ 私信图片上传（/upload/file chat 场景）+ 图片消息全链路 ============
  /** multipart 上传（fetch FormData，Node 18+ 原生） */
  async function uploadChat(token, blob, filename) {
    const form = new FormData();
    form.append('scene', 'chat');
    form.append('file', blob, filename);
    const res = await fetch(base + '/api/v1/upload/file', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body: json };
  }

  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const upOk = await uploadChat(tokenA, new Blob([png1x1], { type: 'image/png' }), 'a.png');
  check('chat 场景上传 PNG → 200 且 url 含 /uploads/chat/',
    upOk.status === 200 && /\/uploads\/chat\//.test(upOk.body?.data?.url || ''),
    'status=' + upOk.status + ' body=' + JSON.stringify(upOk.body));

  const upBadType = await uploadChat(tokenA, new Blob([png1x1], { type: 'image/bmp' }), 'a.bmp');
  check('chat 场景非 JPG/PNG/WebP → 400', upBadType.status === 400, 'status=' + upBadType.status);

  const upBig = await uploadChat(tokenA, new Blob([Buffer.alloc(10 * 1024 * 1024 + 1, 1)], { type: 'image/jpeg' }), 'big.jpg');
  check('chat 场景 >10MB → 400', upBig.status === 400, 'status=' + upBig.status);

  const imgMsgReal = await call('POST', `/api/v1/chat/conversations/${convAB}/messages`,
    { body: { type: 'image', imageUrl: upOk.body?.data?.url || '' }, token: tokenA });
  check('A 发图片消息（真实上传 url）→ 200',
    imgMsgReal.status === 200 && imgMsgReal.body?.data?.imageUrl === upOk.body?.data?.url,
    'status=' + imgMsgReal.status + ' data=' + JSON.stringify(imgMsgReal.body?.data));

  const convListAfter = await call('GET', '/api/v1/chat/conversations', { token: tokenB });
  const convABRow = convListAfter.body?.data?.list?.find((c) => c.conversationId === convAB);
  check('图片消息会话列表快照同步 lastImageUrl',
    convABRow?.lastImageUrl === upOk.body?.data?.url,
    JSON.stringify(convABRow));

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
