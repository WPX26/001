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
import { Coord, Photo, User, ExploreBoost } from '../models/index.js';
import {
  boostScore,
  freeScore,
  interleaveFreshSlots,
  FRESH_SLOT_WINDOW_MS,
} from '../utils/rank-score.js';
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
  // 灵感模式=生活池、探索模式=工作池（王总2026-09-03拍板：两个模式均含自己上传的坐标；注意此接口不做 isPhotographer 校验，探索资格校验在 /explore/coords）
  if (mode === 'inspire') {
    match.mode = 'life';
  } else if (mode === 'explore') {
    match.mode = 'work';
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
        authorId: 1,
        createdAt: 1,
        cell: gridKeyExpr('$lng', '$lat', grid),
      },
    },
    {
      $group: {
        _id: '$cell',
        ids: { $push: '$_id' },
        titles: { $push: '$title' },
        authorIds: { $push: '$authorId' },
        createdAts: { $push: '$createdAt' },
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
        .select('coordId thumbnailUrl takenAt uploadTime')
        .limit(1000)
        .lean()
    : [];
  const thumbByCoord = new Map();
  for (const p of photos) {
    if (!thumbByCoord.has(String(p.coordId))) thumbByCoord.set(String(p.coordId), p);
  }

  const color = MARKER_COLOR[mode] || MARKER_COLOR.normal;

  // ── 聚合点三层排序（王总 2026-09-02 定稿；仅探索模式生效，其余模式维持原排序）──
  // 簇内：月卡层 > 周卡层 > 免费层；档内 PK = 热度×(1+min(0.5×覆盖率,0.5))，同分后买靠前；
  //       免费层 × 新鲜系数 × 新人系数，每 6 席保底穿插 1 席 24h 内最新发表；
  // 簇代表 = 最高档内公式第一名（聚合点标题与首缩略图取代表）；
  // 簇间 = 含月卡簇 > 仅周卡簇 > 纯免费簇，同档比簇内公式最高分，再比点数。
  const isExplore = mode === 'explore';
  const nowMs = Date.now();
  const TIER_RANK = { month: 2, week: 1 };

  let ranked = null; // [{ cell, index, orderedIds, representative, cellTier, cellScore }]
  if (isExplore) {
    // 每坐标获赞总数（一次聚合，勿 N+1）
    const likeByCoord = new Map();
    if (allCoordIds.length) {
      const likeRows = await Photo.aggregate([
        { $match: { coordId: { $in: allCoordIds }, deletedAt: null } },
        { $group: { _id: '$coordId', likes: { $sum: '$likes' } } },
      ]);
      for (const r of likeRows) likeByCoord.set(String(r._id), r.likes || 0);
    }
    // 活跃置顶席位（boost 挂在工作池坐标，坐标标题为键）
    const cellTitles = [...new Set(cells.flatMap((c) => c.titles))];
    const boostByKey = new Map(); // coordKey|authorId -> boost
    if (cellTitles.length) {
      const boosts = await ExploreBoost.find({
        coordKey: { $in: cellTitles },
        until: { $gt: new Date(nowMs) },
      })
        .select('coordKey authorId tier start until')
        .lean();
      for (const b of boosts) boostByKey.set(`${b.coordKey}|${String(b.authorId)}`, b);
    }
    // 作者注册时间（新人系数）
    const coordAuthorIds = [...new Set(cells.flatMap((c) => c.authorIds.map(String)))];
    const createdAtByAuthor = new Map(
      (await User.find({ _id: { $in: coordAuthorIds } }).select('createdAt').lean()).map((u) => [
        String(u._id),
        u.createdAt,
      ])
    );

    ranked = cells.map((cell, index) => {
      const total = cell.count;
      // 作者在本簇覆盖点数（覆盖率分子）
      const coveredByAuthor = new Map();
      cell.authorIds.forEach((aid) => {
        const k = String(aid);
        coveredByAuthor.set(k, (coveredByAuthor.get(k) || 0) + 1);
      });
      const meta = cell.ids.map((cid, idx) => {
        const idStr = String(cid);
        const aidStr = String(cell.authorIds[idx]);
        const boost = boostByKey.get(`${cell.titles[idx]}|${aidStr}`) || null;
        const likes = likeByCoord.get(idStr) || 0;
        const covered = coveredByAuthor.get(aidStr) || 1;
        const photo = thumbByCoord.get(idStr);
        const publishedAt = photo?.uploadTime || cell.createdAts?.[idx] || null;
        const score = boost
          ? boostScore({ likes, covered, total })
          : freeScore({
              likes,
              covered,
              total,
              publishedAt,
              authorCreatedAt: createdAtByAuthor.get(aidStr),
              now: nowMs,
            });
        return {
          key: idStr,
          id: idStr,
          title: cell.titles[idx],
          boost,
          likes,
          publishedAt,
          score,
          thumbnailUrl: photo?.thumbnailUrl || null,
        };
      });
      const boosted = meta
        .filter((m) => m.boost)
        .sort(
          (a, b) =>
            (TIER_RANK[b.boost.tier] || 0) - (TIER_RANK[a.boost.tier] || 0) ||
            b.score - a.score ||
            new Date(b.boost.start).getTime() - new Date(a.boost.start).getTime()
        );
      const free = meta.filter((m) => !m.boost).sort((a, b) => b.score - a.score || b.likes - a.likes);
      const freshPool = free
        .filter(
          (m) => m.publishedAt && nowMs - new Date(m.publishedAt).getTime() <= FRESH_SLOT_WINDOW_MS
        )
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      const orderedIds = [
        ...boosted.map((m) => m.id),
        ...interleaveFreshSlots(free, freshPool, nowMs).map((m) => m.id),
      ];
      const top = boosted[0] || free[0] || null;
      return {
        cell,
        index,
        orderedIds,
        representative: top,
        cellTier: boosted[0] ? boosted[0].boost.tier : null,
        cellScore: top ? top.score : 0,
      };
    });
    ranked.sort(
      (a, b) =>
        (TIER_RANK[b.cellTier] || 0) - (TIER_RANK[a.cellTier] || 0) ||
        b.cellScore - a.cellScore ||
        b.cell.count - a.cell.count
    );
  }

  const markers = (ranked || cells.map((cell, index) => ({ cell, index }))).map(
    ({ cell, index, orderedIds, representative, cellTier }) => {
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
          ...(isExplore && cellTier ? { boostTier: cellTier } : {}),
        };
      }
      // 聚合点：探索模式簇代表打头（标题/首缩略图），子坐标按三层定稿排序
      const thumbSource = isExplore
        ? [
            representative?.thumbnailUrl,
            ...orderedIds.map((id) => thumbByCoord.get(id)?.thumbnailUrl),
          ]
        : coordIds.map((id) => thumbByCoord.get(id)?.thumbnailUrl);
      const thumbnailUrls = [...new Set(thumbSource.filter(Boolean))].slice(0, 2);
      return {
        id: `cluster_${index + 1}`,
        title: `${(isExplore ? representative?.title : null) || cell.titles[0]}及周边`,
        lng: cell.avgLng,
        lat: cell.avgLat,
        count: cell.count,
        color,
        isClustered: true,
        subCoordIds: isExplore ? orderedIds : coordIds,
        ...(isExplore
          ? { representativeId: representative?.id || coordIds[0], boostTier: cellTier || null }
          : {}),
        thumbnailUrls,
      };
    }
  );

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
