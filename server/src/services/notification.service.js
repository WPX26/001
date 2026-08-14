/**
 * 通知服务：统一写通知入口（新代码一律走这里，不再散落 Notification.create）
 *
 * 规则：
 * - fire-and-forget：返回 Promise，内部 .catch 静默吞错（通知失败不影响主流程）
 * - 本人触发不通知自己（如评论自己的照片 / 回复自己）
 *
 * 用法：
 *   await notify(photo.authorId, NOTIFICATION_TYPE.COMMENT, { actorId: meId, photoId, commentId });
 */
import { Notification } from '../models/index.js';
import logger from '../utils/logger.js';

/**
 * @param {ObjectId|string} userId 接收人
 * @param {string} type NOTIFICATION_TYPE 枚举（like/comment/reply/tip/collect/follow/system）
 * @param {object} [opts]
 * @param {ObjectId|string} [opts.actorId] 触发人（null 表示系统）
 * @param {ObjectId|string} [opts.photoId] 关联照片（可选）
 * @param {ObjectId|string} [opts.commentId] 关联评论（可选）
 * @param {string} [opts.content] 系统通知正文（可选）
 * @returns {Promise<void>} 失败静默，永不 reject
 */
export function notify(userId, type, { actorId = null, photoId = null, commentId = null, content = '' } = {}) {
  if (!userId || !type) return Promise.resolve();
  // 本人触发不通知自己
  if (actorId && String(actorId) === String(userId)) return Promise.resolve();

  return Notification.create({
    userId,
    type,
    actorId: actorId || null,
    photoId: photoId || null,
    commentId: commentId || null,
    content: content || '',
  }).catch((e) => {
    logger.error(`[notify] 通知写入失败（静默忽略）: ${e.message}`);
  });
}
