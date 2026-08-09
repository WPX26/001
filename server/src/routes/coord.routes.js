/**
 * 坐标路由（api.md 3.3 / 7.2 / 13.3 坐标部分）
 */
import { Router } from 'express';
import { param, body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as coord from '../controllers/coord.controller.js';

const router = Router();

router.use(requireAuth);

const coordIdParam = param('coordId').isMongoId().withMessage('坐标 ID 格式不正确');

// 7.2 创建坐标并关联照片
router.post(
  '/',
  [
    body('title').trim().isLength({ min: 1, max: 50 }).withMessage('地点名称长度需在 1-50 字符'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('经度不合法'),
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('纬度不合法'),
    body('photoIds').isArray({ min: 1 }).withMessage('photoIds 必须是非空数组'),
    body('photoIds.*').isMongoId().withMessage('photoIds 中包含非法照片 ID'),
    body('isPublic').optional().isBoolean().withMessage('isPublic 必须是布尔值'),
    body('mode').optional().isIn(['life', 'work']).withMessage('mode 必须是 life 或 work'),
    body('photoTimes').optional().isObject().withMessage('photoTimes 必须是对象'),
    validate,
  ],
  coord.createCoord
);

// 3.3 坐标详情（分页参数 page/pageSize 在控制器内解析）
router.get('/:coordId/detail', [coordIdParam, validate], coord.coordDetail);

// 3.4 / 7.8 更新坐标标题（仅作者本人；1-50 字符，trim 由校验链处理）
router.put(
  '/:coordId',
  [
    coordIdParam,
    body('title').trim().isLength({ min: 1, max: 50 }).withMessage('地点名称长度需在 1-50 字符'),
    validate,
  ],
  coord.updateCoord
);

// 7.4 删除坐标（软删除）
router.delete('/:coordId', [coordIdParam, validate], coord.softDeleteCoord);

// 7.5 恢复已删除的坐标
router.post('/:coordId/restore', [coordIdParam, validate], coord.restoreCoord);

// 13.3 永久删除
router.delete('/:coordId/permanent', [coordIdParam, validate], coord.permanentDeleteCoord);

export default router;
