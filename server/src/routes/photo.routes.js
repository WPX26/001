/**
 * 照片路由（api.md 第 6/13 章）
 */
import { Router } from 'express';
import { param, query, body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as photo from '../controllers/photo.controller.js';
import * as comment from '../controllers/comment.controller.js';

const router = Router();

router.use(requireAuth);

const photoIdParam = param('photoId').isMongoId().withMessage('照片 ID 格式不正确');
const commentIdParam = param('commentId').isMongoId().withMessage('评论 ID 格式不正确');

// 13.1 我的照片列表
router.get(
  '/mine',
  [
    query('sortBy').optional().isIn(['time', 'coord']).withMessage('sortBy 必须是 time 或 coord'),
    validate,
  ],
  photo.getMyPhotos
);

// 13.2 回收站
router.get(
  '/trash',
  [query('type').optional().isIn(['photos', 'markers', 'all']).withMessage('type 必须是 photos/markers/all'), validate],
  photo.getTrash
);

// 6.1 照片详情
router.get('/:photoId', [photoIdParam, validate], photo.getPhotoDetail);

// 6.2 点赞 / 6.3 取消点赞
router.post('/:photoId/like', [photoIdParam, validate], photo.likePhoto);
router.delete('/:photoId/like', [photoIdParam, validate], photo.unlikePhoto);

// 6.5 收藏 / 6.6 取消收藏
router.post('/:photoId/collect', [photoIdParam, validate], photo.collectPhoto);
router.delete('/:photoId/collect', [photoIdParam, validate], photo.uncollectPhoto);

// 6.4 打赏（平台代币 1-100，同用户同照片 60 秒限一次）
router.post(
  '/:photoId/tip',
  [
    photoIdParam,
    body('amount').isInt({ min: 1, max: 100 }).withMessage('打赏金额须为 1-100 的整数代币').toInt(),
    validate,
  ],
  photo.tipPhoto
);

// 6.7 评论列表（分页）/ 6.8 发表评论
router.get('/:photoId/comments', [photoIdParam, validate], comment.getComments);
router.post(
  '/:photoId/comments',
  [
    photoIdParam,
    body('content').isString().trim().isLength({ min: 1, max: 500 }).withMessage('评论内容须为 1-500 字符'),
    body('replyTo').optional({ values: 'null' }).isMongoId().withMessage('回复目标用户 ID 格式不正确'),
    validate,
  ],
  comment.createComment
);

// 6.9 删除评论（软删，仅评论作者或照片作者）
router.delete(
  '/:photoId/comments/:commentId',
  [photoIdParam, commentIdParam, validate],
  comment.deleteComment
);

// 7.6 删除 / 7.7 恢复 / 13.3 永久删除
router.delete('/:photoId', [photoIdParam, validate], photo.softDeletePhoto);
router.post('/:photoId/restore', [photoIdParam, validate], photo.restorePhoto);
router.delete('/:photoId/permanent', [photoIdParam, validate], photo.permanentDeletePhoto);

export default router;
