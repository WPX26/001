/**
 * 探索模式路由（api.md 第 5 章）
 */
import { Router } from 'express';
import { query, body, param } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as explore from '../controllers/explore.controller.js';
import * as member from '../controllers/member.controller.js';

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

// 5.3 购买坐标置顶（6元/7天，复用会员订单半自动确认链路）
router.post(
  '/boost/order',
  [body('coordKey').isString().trim().notEmpty().withMessage('coordKey 必填'), validate],
  member.createBoostOrder
);

// 5.4 查询置顶订单（复用会员订单查询，含归属校验；前端每 3s 轮询）
router.get(
  '/boost/order/:orderId',
  [param('orderId').isString().trim().notEmpty().withMessage('orderId 必填'), validate],
  member.getOrder
);

export default router;
