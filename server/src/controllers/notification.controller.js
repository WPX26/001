/**
 * 通知控制器（api.md 14.1-14.3，P1 接口）
 * - GET  /notifications                 分页列表（type 过滤，actor/photo join）
 * - PUT  /notifications/{id}/read       单条已读（仅接收人本人，越权 1003）
 * - PUT  /notifications/read-all        全部已读
 * - GET  /notifications/unread-count    未读数（红点）
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { User, Photo, Notification } from '../models/index.js';

/** 14.1 通知列表（分页；deletedAt null 过滤，字段缺失即视为未删） */
export const getNotifications = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const meId = req.user._id;

  const query = { userId: meId, deletedAt: null };
  if (req.query.type) query.type = req.query.type;

  const [items, total] = await Promise.all([
    Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Notification.countDocuments(query),
  ]);

  // 一次性 join 触发人 + 关联照片（去重）
  const actorIds = [...new Set(items.map((n) => n.actorId && String(n.actorId)).filter(Boolean))];
  const photoIds = [...new Set(items.map((n) => n.photoId && String(n.photoId)).filter(Boolean))];
  const [actors, photos] = await Promise.all([
    actorIds.length ? User.find({ _id: { $in: actorIds } }).select('nickname avatar').lean() : [],
    photoIds.length ? Photo.find({ _id: { $in: photoIds } }).select('thumbnailUrl imageUrl').lean() : [],
  ]);
  const actorMap = new Map(actors.map((a) => [String(a._id), a]));
  const photoMap = new Map(photos.map((p) => [String(p._id), p]));

  const list = items.map((n) => ({
    id: String(n._id),
    type: n.type,
    isRead: n.isRead,
    content: n.content || '',
    createdAt: n.createdAt,
    actor: n.actorId
      ? {
          id: String(n.actorId),
          nickname: actorMap.get(String(n.actorId))?.nickname || '',
          avatar: actorMap.get(String(n.actorId))?.avatar || '',
        }
      : null,
    photo: n.photoId
      ? {
          id: String(n.photoId),
          thumbnailUrl: photoMap.get(String(n.photoId))?.thumbnailUrl || '',
          imageUrl: photoMap.get(String(n.photoId))?.imageUrl || '',
        }
      : null,
    commentId: n.commentId ? String(n.commentId) : null,
  }));

  ok(res, paginated(list, total, page, pageSize));
});

/** 14.2 单条已读（仅接收人本人，越权 1003） */
export const readNotification = asyncHandler(async (req, res) => {
  const meId = req.user._id;

  const n = await Notification.findOne({ _id: req.params.notificationId, deletedAt: null });
  if (!n) throw new AppError(ERR.NOT_FOUND, '通知不存在', 404);
  if (String(n.userId) !== String(meId)) {
    throw new AppError(ERR.FORBIDDEN, '只能操作自己的通知', 403);
  }

  if (!n.isRead) {
    n.isRead = true;
    await n.save();
  }
  ok(res, { id: String(n._id), isRead: true }, '已标记已读');
});

/** 14.2 全部已读 */
export const readAllNotifications = asyncHandler(async (req, res) => {
  const r = await Notification.updateMany(
    { userId: req.user._id, isRead: false },
    { $set: { isRead: true } }
  );
  ok(res, { updated: r.modifiedCount || 0 }, '已全部标记已读');
});

/** 14.3 未读通知数（红点） */
export const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({
    userId: req.user._id,
    isRead: false,
    deletedAt: null,
  });
  ok(res, { count });
});
