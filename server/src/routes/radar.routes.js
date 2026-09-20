/**
 * 雷达路由（2026-09-20 雷达一期，api.md 第 16 章待补）
 */
import { Router } from 'express';
import { body, query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as radar from '../controllers/radar.controller.js';

const router = Router();

// 全部接口需登录
router.use(requireAuth);

// 16.1 上报实时位置（工作模式、未隐身）
router.post(
  '/report',
  [
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('经度不合法'),
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('纬度不合法'),
    body('accuracy').optional().isFloat({ min: 0 }).withMessage('accuracy 必须是非负数'),
    validate,
  ],
  radar.reportLocation
);

// 16.2 附近在线摄影师（lng/lat 可省略，提供其一则两者必须齐全——控制器内校验）
router.get(
  '/nearby',
  [
    query('lng').optional().isFloat({ min: -180, max: 180 }).withMessage('经度不合法'),
    query('lat').optional().isFloat({ min: -90, max: 90 }).withMessage('纬度不合法'),
    query('radius').optional().isFloat({ gt: 0 }).withMessage('radius 必须是正数'),
    validate,
  ],
  radar.nearby
);

// 16.3 雷达隐身开关
router.put(
  '/visibility',
  [body('hidden').isBoolean().withMessage('hidden 必须是布尔值'), validate],
  radar.setRadarHidden
);

export default router;
