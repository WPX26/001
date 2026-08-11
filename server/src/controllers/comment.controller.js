/**
 * 评论控制器（api.md 6.7-6.9，P1 接口）
 * - GET    /photos/{photoId}/comments  分页列表（作者/回复目标 join、软删过滤）
 * - POST   /photos/{photoId}/comments  发表（replyTo 须在该照片下评论过；通知作者/回复目标）
 * - DELETE /photos/{photoId}/comments/{commentId}  软删（仅评论作者或照片作者）
 */
import { ERR, NOTIFICATION_TYPE } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { User, Photo, Comment } from '../models/index.js';
import { notify } from '../services/notification.service.js';

/** 6.7 评论列表（分页，倒序，作者昵称/头像 join，replyTo 关联） */
export const getComments = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const photoId = req.params.photoId;

  const photo = await Photo.findOne({ _id: photoId, deletedAt: null }).select('_id').lean();
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);

  const query = { photoId, deletedAt: null };
  const [comments, total] = await Promise.all([
    Comment.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Comment.countDocuments(query),
  ]);

  // 一次性 join 作者 + 回复目标（去重后查一次）
  const userIds = new Set();
  for (const c of comments) {
    userIds.add(String(c.authorId));
    if (c.replyTo) userIds.add(String(c.replyTo));
  }
  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds] } }).select('nickname avatar').lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const brief = (id) => {
    const u = userMap.get(String(id));
    return { id: String(id), nickname: u?.nickname || '', avatar: u?.avatar || '' };
  };

  const list = comments.map((c) => ({
    id: String(c._id),
    content: c.content,
    author: brief(c.authorId),
    replyTo: c.replyTo ? brief(c.replyTo) : null,
    createdAt: c.createdAt,
  }));

  ok(res, paginated(list, total, page, pageSize));
});

/** 6.8 发表评论（content 1-500；replyTo 可选：目标用户须在该照片下评论过） */
export const createComment = asyncHandler(async (req, res) => {
  const photoId = req.params.photoId;
  const { content, replyTo } = req.body;
  const meId = req.user._id;

  const photo = await Photo.findOne({ _id: photoId, deletedAt: null }).select('authorId').lean();
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);

  if (replyTo) {
    const replied = await Comment.findOne({ photoId, authorId: replyTo, deletedAt: null })
      .select('_id')
      .lean();
    if (!replied) {
      throw new AppError(ERR.NOT_FOUND, '回复目标不存在或未评论该照片', 404);
    }
  }

  const comment = await Comment.create({
    photoId,
    authorId: meId,
    content,
    replyTo: replyTo || null,
  });
  await Photo.updateOne({ _id: photoId }, { $inc: { commentCount: 1 } });

  // 通知照片作者（type=comment）；有回复目标时另发一条 type=reply（notify 内部自动跳过本人）
  await notify(photo.authorId, NOTIFICATION_TYPE.COMMENT, {
    actorId: meId,
    photoId,
    commentId: comment._id,
  });
  if (replyTo) {
    await notify(replyTo, NOTIFICATION_TYPE.REPLY, {
      actorId: meId,
      photoId,
      commentId: comment._id,
    });
  }

  const author = await User.findById(meId).select('nickname avatar').lean();
  ok(
    res,
    {
      id: String(comment._id),
      content: comment.content,
      replyTo: replyTo ? String(replyTo) : null,
      author: { id: String(meId), nickname: author?.nickname || '', avatar: author?.avatar || '' },
      createdAt: comment.createdAt,
    },
    '评论成功'
  );
});

/** 6.9 删除评论（软删 deletedAt + photo.commentCount -1；仅评论作者或照片作者） */
export const deleteComment = asyncHandler(async (req, res) => {
  const { photoId, commentId } = req.params;
  const meId = req.user._id;

  const comment = await Comment.findOne({ _id: commentId, photoId, deletedAt: null });
  if (!comment) throw new AppError(ERR.NOT_FOUND, '评论不存在或已删除', 404);

  const photo = await Photo.findById(photoId).select('authorId').lean();
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);

  const isCommentAuthor = String(comment.authorId) === String(meId);
  const isPhotoAuthor = String(photo.authorId) === String(meId);
  if (!isCommentAuthor && !isPhotoAuthor) {
    throw new AppError(ERR.FORBIDDEN, '只能删除自己的评论或自己照片下的评论', 403);
  }

  comment.deletedAt = new Date();
  await comment.save();
  await Photo.updateOne({ _id: photoId }, { $inc: { commentCount: -1 } });
  // 防御：计数不为负（历史数据缺失/并发兜底）
  await Photo.updateOne({ _id: photoId, commentCount: { $lt: 0 } }, { $set: { commentCount: 0 } });

  ok(res, {}, '评论已删除');
});
