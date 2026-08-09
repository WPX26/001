/**
 * 地图控制器（api.md 3.1 GET /map/markers；3.2 GET /map/search、GET /map/reverse）
 * 视窗 bbox + zoom/level → 网格聚合返回坐标点/聚合点
 *
 * 聚合规则（基础版）：
 * - level 由 zoom 联动：≤14 → 1（粗网格 0.05°），15 → 2（0.02°），≥16 → 3（0.01°）
 * - 同一网格内多个坐标合并为一个聚合点（cluster），返回子坐标 ID + 缩略图
 */
import { ERR, GRID_SIZE_BY_LEVEL, MARKER_COLOR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { gridKeyExpr, haversineKm, escapeRegex } from '../utils/geo.js';
import { Coord, Photo } from '../models/index.js';
import { tdtGeocode, tdtReverse } from '../services/tdt.service.js';
import regions from '../data/regions.js';

// 行政级聚合数据：仅返回 name/lng/lat（数据量大，精简响应；模块加载时预裁剪一次）
const REGIONS_BY_LEVEL = {
  city: regions.city.map(({ name, lng, lat }) => ({ name, lng, lat })),
  province: regions.province.map(({ name, lng, lat }) => ({ name, lng, lat })),
  country: regions.country.map(({ name, lng, lat }) => ({ name, lng, lat })),
};

export const getMarkers = asyncHandler(async (req, res) => {
  const { minLng, maxLng, minLat, maxLat } = req.query;
  const zoom = Number(req.query.zoom) || 10;
  const mode = req.query.mode || 'normal';

  // zoom/level 联动（api.md 3.1）
  const level = Number(req.query.level) || (zoom <= 14 ? 1 : zoom >= 16 ? 3 : 2);
  const grid = GRID_SIZE_BY_LEVEL[level] ?? 0.01;

  if (Number(minLng) >= Number(maxLng) || Number(minLat) >= Number(maxLat)) {
    throw new AppError(ERR.VALIDATE, '经纬度范围不合法', 400);
  }

  const match = {
    deletedAt: null,
    isPublic: true,
    lng: { $gte: Number(minLng), $lte: Number(maxLng) },
    lat: { $gte: Number(minLat), $lte: Number(maxLat) },
  };
  // 灵感模式=生活池、探索模式=工作池；均不含自己的内容
  if (mode === 'inspire') {
    match.mode = 'life';
    match.authorId = { $ne: req.user._id };
  } else if (mode === 'explore') {
    match.mode = 'work';
    match.authorId = { $ne: req.user._id };
  }

  // 按网格聚合（$limit 防止超大视窗拖垮查询，P0 基础版）
  const cells = await Coord.aggregate([
    { $match: match },
    { $limit: 3000 },
    {
      $project: {
        title: 1,
        lng: 1,
        lat: 1,
        cell: gridKeyExpr('$lng', '$lat', grid),
      },
    },
    {
      $group: {
        _id: '$cell',
        ids: { $push: '$_id' },
        titles: { $push: '$title' },
        count: { $sum: 1 },
        avgLng: { $avg: '$lng' },
        avgLat: { $avg: '$lat' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  // 取每个坐标最新一张照片作缩略图/最新拍摄时间
  const allCoordIds = cells.flatMap((c) => c.ids);
  const photos = allCoordIds.length
    ? await Photo.find({ coordId: { $in: allCoordIds }, deletedAt: null })
        .sort({ takenAt: -1 })
        .select('coordId thumbnailUrl takenAt')
        .limit(1000)
        .lean()
    : [];
  const thumbByCoord = new Map();
  for (const p of photos) {
    if (!thumbByCoord.has(String(p.coordId))) thumbByCoord.set(String(p.coordId), p);
  }

  const color = MARKER_COLOR[mode] || MARKER_COLOR.normal;

  const markers = cells.map((cell, i) => {
    const coordIds = cell.ids.map(String);
    // 单点：直接返回坐标
    if (cell.count === 1) {
      const cid = coordIds[0];
      const photo = thumbByCoord.get(cid);
      return {
        id: cid,
        title: cell.titles[0],
        lng: cell.avgLng,
        lat: cell.avgLat,
        count: 1,
        color,
        isClustered: false,
        latestPhotoTime: photo?.takenAt || null,
      };
    }
    // 聚合点：取前 2 张不同坐标的缩略图
    const thumbnailUrls = [
      ...new Set(coordIds.map((id) => thumbByCoord.get(id)?.thumbnailUrl).filter(Boolean)),
    ].slice(0, 2);
    return {
      id: `cluster_${i + 1}`,
      title: `${cell.titles[0]}及周边`,
      lng: cell.avgLng,
      lat: cell.avgLat,
      count: cell.count,
      color,
      isClustered: true,
      subCoordIds: coordIds,
      thumbnailUrls,
    };
  });

  ok(res, markers);
});

/**
 * 3.2 搜索地点（地标 + 本地坐标混合，就近排序）
 * GET /map/search?keyword=&lng=&lat=
 * - 天地图正向编码 → 地标（type: landmark）
 * - 本地 coords 集合 title 模糊匹配 → 用户坐标（mode: work → coord）与灵感坐标（mode: life → inspire）
 * - 有 lng/lat 时按球面距离升序；无则地标在前
 * - 天地图失败降级为仅本地结果，不抛 500
 */
export const searchMap = asyncHandler(async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const center = { lng: Number(req.query.lng), lat: Number(req.query.lat) };
  const hasCenter = Number.isFinite(center.lng) && Number.isFinite(center.lat);

  // 1. 天地图正向编码 → 地标（失败返回空数组，不阻断本地结果）
  const landmarks = (await tdtGeocode(keyword)).map((p) => ({
    name: p.name,
    lng: p.lng,
    lat: p.lat,
    address: p.address || '',
    type: 'landmark',
    coordId: null,
    distance: hasCenter ? haversineKm(center, p) : null,
  }));

  // 2. 本地坐标：title 模糊匹配（公开 + 未删除）
  const coords = await Coord.find({
    title: { $regex: escapeRegex(keyword), $options: 'i' },
    deletedAt: null,
    isPublic: true,
  })
    .select('title lng lat mode')
    .limit(30)
    .lean();

  const locals = coords.map((c) => ({
    name: c.title,
    lng: c.lng,
    lat: c.lat,
    address: '',
    // 生活池（灵感）→ inspire；工作池（探索）→ coord
    type: c.mode === 'life' ? 'inspire' : 'coord',
    coordId: String(c._id),
    distance: hasCenter ? haversineKm(center, c) : null,
  }));

  // 3. 合并 + 就近排序（有中心点按距离升序，无则保持地标在前）+ 限制条数
  let results = [...landmarks, ...locals];
  if (hasCenter) {
    results.sort((a, b) => a.distance - b.distance);
  }
  results = results
    .slice(0, 20)
    .map(({ distance, ...rest }) => rest);

  ok(res, { results }, '搜索完成');
});

/**
 * 3.2 逆地理编码：坐标 → 地点名称 + 地址
 * GET /map/reverse?lng=&lat=
 * 天地图失败时降级返回空名称（不抛 500）
 */
export const reverseGeocode = asyncHandler(async (req, res) => {
  const lng = Number(req.query.lng);
  const lat = Number(req.query.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new AppError(ERR.VALIDATE, 'lng/lat 必须是数值', 400);
  }

  const info = await tdtReverse(lng, lat);
  ok(
    res,
    info || { name: '', address: '', lng, lat },
    info ? '逆地理编码成功' : '未找到对应地点'
  );
});

/**
 * 3.3 行政区中心点（行政级聚合数据源）
 * GET /map/regions?level=city|province|country
 * - 静态数据（server/src/data/regions.js），无 DB 依赖
 * - 可选认证：带合法 token 挂 req.user，未登录/无效 token 均放行
 */
export const getRegions = (req, res) => {
  const level = req.query.level;
  ok(res, { level, regions: REGIONS_BY_LEVEL[level] || [] });
};
