/**
 * 照片路由（api.md 第 6/13 章）
 */
import { Router } from 'express';
import { param, query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as photo from '../controllers/photo.controller.js';

const router = Router();

router.use(requireAuth);

const photoIdParam = param('photoId').isMongoId().withMessage('照片 ID 格式不正确');

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

// 7.6 删除 / 7.7 恢复 / 13.3 永久删除
router.delete('/:photoId', [photoIdParam, validate], photo.softDeletePhoto);
router.post('/:photoId/restore', [photoIdParam, validate], photo.restorePhoto);
router.delete('/:photoId/permanent', [photoIdParam, validate], photo.permanentDeletePhoto);

export default router;
