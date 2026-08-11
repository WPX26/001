/**
 * 灵感模式路由（api.md 第 4 章）
 */
import { Router } from 'express';
import { query, body, param } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as inspire from '../controllers/inspire.controller.js';

const router = Router();

router.use(requireAuth);

// 4.1 灵感坐标列表（半径单位约定见 geo.js radiusDelta：≤180 为度，>180 为米，默认 5000 米）
router.get(
  '/coords',
  [
    query('lng').isFloat({ min: -180, max: 180 }).withMessage('经度不合法'),
    query('lat').isFloat({ min: -90, max: 90 }).withMessage('纬度不合法'),
    query('radius').optional().isFloat({ gt: 0 }).withMessage('radius 必须是正数'),
    query('sortBy')
      .optional()
      .isIn(['hot', 'time', 'followed'])
      .withMessage('sortBy 必须是 hot/time/followed'),
    validate,
  ],
  inspire.inspireCoords
);

// 4.2 收藏坐标（多选合并收藏）
router.post(
  '/collect',
  [
    body('sourceCoordIds').isArray({ min: 1 }).withMessage('sourceCoordIds 必须是非空数组'),
    body('sourceCoordIds.*').isMongoId().withMessage('sourceCoordIds 中包含非法坐标 ID'),
    validate,
  ],
  inspire.collectCoords
);

// 4.3 取消收藏
router.delete(
  '/collect/:coordId',
  [param('coordId').isMongoId().withMessage('坐标 ID 格式不正确'), validate],
  inspire.uncollectCoord
);

export default router;
