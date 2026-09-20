/**
 * 私信聊天控制器（api.md 第 9 章 + 附录 A，P1 接口，最后一批）
 * - GET  /chat/conversations                    会话列表（peer join、lastMessage 快照、未读数）
 * - POST /chat/conversations                    创建/获取与某用户的会话（幂等，不能和自己建）
 * - GET  /chat/conversations/:id/messages       聊天记录（before 时间游标 + limit，仅成员）
 * - POST /chat/conversations/:id/messages       发消息（text/image/coord，同步快照+未读数+通知+WS 推送）
 * - PUT  /chat/conversations/:id/read           标记已读（清零本人未读 + 回写 readBy）
 */
import { ERR, NOTIFICATION_TYPE } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User, Conversation, Message } from '../models/index.js';
import { notify } from '../services/notification.service.js';
import { pushToUser } from '../services/chat.ws.js';

/** 消息 limit 上限（契约默认 30，防超大分页） */
const MSG_LIMIT_MAX = 50;

/** 消息文档 → 接口 DTO */
function messageDTO(m) {
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: String(m.senderId),
    type: m.type,
    content: m.content || '',
    imageUrl: m.imageUrl || '',
    coord: m.coord && (m.coord.lng != null || m.coord.lat != null)
      ? { lng: m.coord.lng, lat: m.coord.lat }
      : null,
    createdAt: m.createdAt,
    readBy: (m.readBy || []).map(String),
  };
}

/** 会话文档 → 接口 DTO（peer join 后填充） */
function conversationDTO(c, userMap) {
  const meId = String(c.meId);
  const peerId = String(c.participants.find((p) => String(p) !== meId) || '');
  const peer = peerId ? userMap.get(peerId) : null;
  // 快照预览文案：text 原文 / image / coord 占位；imageUrl 单列供列表缩略图
  const lm = c.lastMessage || {};
  const lastText =
    lm.type === 'image' ? '[图片]' : lm.type === 'coord' ? '[位置]' : lm.content || '';
  return {
    conversationId: String(c._id),
    peerId,
    peerName: peer?.nickname || '',
    peerAvatar: peer?.avatar || '',
    lastMessage: lastText,
    lastImageUrl: lm.imageUrl || '',
    lastTime: c.lastMessageAt || c.updatedAt || c.createdAt,
    unreadCount: (c.unreadCounts && c.unreadCounts[meId]) || 0,
  };
}

/** 校验当前用户是否为会话成员（非成员 → 403/1003；会话不存在 → 404/1004） */
async function assertMember(conversationId, meId) {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new AppError(ERR.NOT_FOUND, '会话不存在', 404);
  if (!conv.participants.some((p) => String(p) === String(meId))) {
    throw new AppError(ERR.FORBIDDEN, '无权访问该会话', 403);
  }
  return conv;
}

/** 9.1 会话列表（按 lastMessageAt 倒序；未聊过的会话排最后） */
export const getConversations = asyncHandler(async (req, res) => {
  const meId = req.user._id;

  const conversations = await Conversation.find({ participants: meId })
    .sort({ lastMessageAt: -1 })
    .lean();
  // 批量 join peer（去重查一次）
  const peerIds = [...new Set(
    conversations
      .map((c) => c.participants.find((p) => String(p) !== String(meId)))
      .filter(Boolean)
      .map(String)
  )];
  const users = peerIds.length
    ? await User.find({ _id: { $in: peerIds } }).select('nickname avatar').lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const list = conversations.map((c) => conversationDTO({ ...c, meId }, userMap));
  ok(res, { list, total: list.length });
});

/** 9.4 创建/获取与某用户的会话（幂等：已存在直接返回；不能和自己建会话） */
export const createConversation = asyncHandler(async (req, res) => {
  const { peerId } = req.body;
  const meId = req.user._id;

  if (String(peerId) === String(meId)) {
    throw new AppError(ERR.VALIDATE, '不能和自己创建会话', 400);
  }
  const peer = await User.findById(peerId).select('nickname avatar').lean();
  if (!peer) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  let conv = await Conversation.findOne({
    participants: { $all: [meId, peerId] },
  }).lean();
  if (!conv) {
    // P1 双人会话；极端并发下可能建出两条（无唯一约束），P2 可用规范化字段收敛
    // 转 toObject()：与 findOne().lean() 返回形态一致，避免 Mongoose 文档展开丢字段
    conv = (await Conversation.create({ participants: [meId, peerId] })).toObject();
  }
  const userMap = new Map([[String(peerId), peer]]);
  ok(res, conversationDTO({ ...conv, meId }, userMap), '会话就绪');
});

/** 9.2 聊天记录（before 时间游标：createdAt < before，倒序取 limit 条；仅会话成员） */
export const getMessages = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const meId = req.user._id;
  const limitRaw = parseInt(req.query.limit, 10) || 30;
  const limit = Math.min(MSG_LIMIT_MAX, Math.max(1, limitRaw));
  const before = req.query.before;

  await assertMember(conversationId, meId);

  const query = { conversationId };
  if (before) {
    const t = Date.parse(before);
    if (Number.isNaN(t)) throw new AppError(ERR.VALIDATE, 'before 游标格式不正确', 400);
    query.createdAt = { $lt: new Date(t) };
  }

  // 多取 1 条判断 hasMore
  const messages = await Message.find(query).sort({ createdAt: -1 }).limit(limit + 1).lean();
  const hasMore = messages.length > limit;
  const list = (hasMore ? messages.slice(0, limit) : messages).map(messageDTO);

  ok(res, { list, hasMore, limit });
});

/** 9.3 发消息（type 细分校验；同步会话 lastMessage 快照 + 对端未读 +1 + 通知 + WS 推送） */
export const sendMessage = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const { type, content, imageUrl, coord } = req.body;
  const meId = req.user._id;

  const conv = await assertMember(conversationId, meId);

  // type 细分字段校验（路由层已校验 type 枚举）
  const payload = { type, content: '', imageUrl: '', coord: { lng: null, lat: null } };
  if (type === 'text') {
    const text = (content ?? '').toString().trim();
    if (!text) throw new AppError(ERR.VALIDATE, '消息内容不能为空', 400);
    if (text.length > 2000) throw new AppError(ERR.VALIDATE, '消息内容不能超过 2000 字', 400);
    payload.content = text;
  } else if (type === 'image') {
    const url = (imageUrl || '').trim();
    if (!url) throw new AppError(ERR.VALIDATE, '图片消息必须提供 imageUrl', 400);
    payload.imageUrl = url;
  } else if (type === 'coord') {
    const lng = Number(coord?.lng);
    const lat = Number(coord?.lat);
    if (coord == null || Number.isNaN(lng) || Number.isNaN(lat) ||
        lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new AppError(ERR.VALIDATE, '坐标消息必须提供合法的 coord {lng, lat}', 400);
    }
    payload.coord = { lng, lat };
  }

  const message = await Message.create({ conversationId, senderId: meId, ...payload });
  const peerId = conv.participants.find((p) => String(p) !== String(meId));

  // 同步会话快照 + 对端未读 +1（Map 键原子 $inc；会话未读仅记对端，本人始终 0）
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        lastMessage: {
          senderId: meId,
          type: message.type,
          content: payload.content,
          imageUrl: payload.imageUrl,
          coord: payload.coord,
          createdAt: message.createdAt,
        },
        lastMessageAt: message.createdAt,
      },
      $inc: { [`unreadCounts.${String(peerId)}`]: 1 },
    }
  );

  // 通知对端（type=chat；notify 内部自动跳过发给自己的场景——本接口 peer ≠ 本人）
  await notify(peerId, NOTIFICATION_TYPE.CHAT, {
    actorId: meId,
    content: payload.content || (type === 'image' ? '[图片]' : '[位置]'),
  });

  // WebSocket 实时推送对端（若在线；多连接广播）
  pushToUser(peerId, {
    type: 'new_message',
    data: { conversationId: String(conversationId), message: messageDTO(message) },
  });

  ok(res, messageDTO(message), '发送成功');
});

/** 9.5 标记已读（清零本人未读 + 回写本会话消息 readBy；仅会话成员） */
export const markRead = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const meId = req.user._id;

  await assertMember(conversationId, meId);

  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { [`unreadCounts.${String(meId)}`]: 0 } }
  );
  // 本会话所有消息把本人追加进 readBy（$ne 防重复）
  await Message.updateMany(
    { conversationId, readBy: { $ne: meId } },
    { $addToSet: { readBy: meId } }
  );

  ok(res, { unreadCount: 0, conversationId: String(conversationId) }, '已读');
});
