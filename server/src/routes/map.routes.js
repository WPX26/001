/**
 * 地图路由（api.md 3.1 /map/markers；3.2 /map/search、/map/reverse；3.3 /map/regions）
 */
import { Router } from 'express';
import { query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { getMarkers, searchMap, reverseGeocode, getRegions } from '../controllers/map.controller.js';

const router = Router();

// 3.1 获取视窗内坐标点（核心接口）
router.get(
  '/markers',
  requireAuth,
  [
    query('minLng').isFloat({ min: -180, max: 180 }).withMessage('minLng 必须是经度数值'),
    query('maxLng').isFloat({ min: -180, max: 180 }).withMessage('maxLng 必须是经度数值'),
    query('minLat').isFloat({ min: -90, max: 90 }).withMessage('minLat 必须是纬度数值'),
    query('maxLat').isFloat({ min: -90, max: 90 }).withMessage('maxLat 必须是纬度数值'),
    query('zoom').isInt({ min: 1, max: 18 }).withMessage('zoom 必须是 1-18 的整数'),
    query('mode').optional().isIn(['normal', 'inspire', 'explore']).withMessage('mode 必须是 normal/inspire/explore'),
    query('level').optional().isInt({ min: 1, max: 3 }).withMessage('level 必须是 1-3 的整数'),
    validate,
  ],
  getMarkers
);

// 3.2 搜索地点（地标 + 本地坐标混合，lng/lat 可选用于就近排序）
router.get(
  '/search',
  requireAuth,
  [
    query('keyword').trim().notEmpty().withMessage('keyword 不能为空').isLength({ max: 50 }).withMessage('keyword 最长 50 字'),
    query('lng').optional().isFloat({ min: -180, max: 180 }).withMessage('lng 必须是经度数值'),
    query('lat').optional().isFloat({ min: -90, max: 90 }).withMessage('lat 必须是纬度数值'),
    validate,
  ],
  searchMap
);

// 3.2 逆地理编码（坐标 → 地点名称 + 地址）
router.get(
  '/reverse',
  requireAuth,
  [
    query('lng').isFloat({ min: -180, max: 180 }).withMessage('lng 必须是经度数值'),
    query('lat').isFloat({ min: -90, max: 90 }).withMessage('lat 必须是纬度数值'),
    validate,
  ],
  reverseGeocode
);

// 3.3 行政区中心点（地图行政级聚合，level 必填；可选认证：未登录可用）
router.get(
  '/regions',
  [
    query('level').trim().toLowerCase().isIn(['city', 'province', 'country']).withMessage('level 必须是 city/province/country'),
    validate,
  ],
  optionalAuth,
  getRegions
);

export default router;
