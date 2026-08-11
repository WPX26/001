/**
 * 探索模式路由（api.md 第 5 章）
 */
import { Router } from 'express';
import { query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as explore from '../controllers/explore.controller.js';

const router = Router();

router.use(requireAuth);

// 5.1 探索坐标列表（作者分组；lng/lat 可省略，提供其一则两者必须齐全——控制器内校验）
router.get(
  '/coords',
  [
    query('lng').optional().isFloat({ min: -180, max: 180 }).withMessage('经度不合法'),
    query('lat').optional().isFloat({ min: -90, max: 90 }).withMessage('纬度不合法'),
    query('radius').optional().isFloat({ gt: 0 }).withMessage('radius 必须是正数'),
    validate,
  ],
  explore.exploreCoords
);

// 5.2 摄影师排行榜（周/月/总榜）
router.get(
  '/ranking',
  [
    query('type')
      .optional()
      .isIn(['weekly', 'monthly', 'all'])
      .withMessage('type 必须是 weekly/monthly/all'),
    validate,
  ],
  explore.ranking
);

export default router;
