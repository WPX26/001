/**
 * 探索模式控制器（api.md 第 5 章）
 * - GET /explore/coords 工作池公开坐标（按作者分组返回）
 * - GET /explore/ranking 摄影师排行榜（周/月/总榜 + myRank）
 *
 * 探索池 = 工作模式（mode=work）公开坐标 + 作者当前 isPhotographer=true（实时校验，
 * 会员到期收回认证后探索池隐藏——靠批量 $in 查 User 当前值过滤，数据不删）
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { haversineKm, radiusDelta, radiusMaxKm } from '../utils/geo.js';
import { User, Coord, Photo, ExploreBoost } from '../models/index.js';

/** 探索池候选坐标上限（批量过滤摄影师后内存分组排序分页） */
const COORD_CANDIDATE_LIMIT = 1000;
/** 排行榜聚合作者上限 */
const RANK_AUTHOR_LIMIT = 500;
/** 单个作者分组内返回的坐标上限 */
const COORDS_PER_AUTHOR = 20;
/** 作者分组"精选照片"上限（按获赞取前 N） */
const PHOTOS_PER_AUTHOR = 9;
/** 每坐标缩略图张数（对齐 2.4 作品卡片） */
const THUMBS_PER_COORD = 4;
/** 单次拉取照片上限 */
const PHOTOS_FETCH_LIMIT = 600;

/** 排行榜时间窗口（天） */
const RANK_WINDOW_DAYS = { weekly: 7, monthly: 30 };

/**
 * 解析可选中心点（lng/lat/radius）
 * - lng/lat 可省略（全量探索池）；给出其一则两者必须齐全
 * - 半径约定与灵感模式一致（≤180 为度，>180 为米，默认 5000 米）
 * @returns {{lng:number,lat:number,radius:number}|null}
 */
function parseCenter(req) {
  const lng = req.query.lng !== undefined ? Number(req.query.lng) : NaN;
  const lat = req.query.lat !== undefined ? Number(req.query.lat) : NaN;
  const hasLng = Number.isFinite(lng);
  const hasLat = Number.isFinite(lat);
  if ((hasLng || hasLat) && !(hasLng && hasLat)) {
    throw new AppError(ERR.VALIDATE, 'lng/lat 需同时提供', 400);
  }
  const radius = req.query.radius !== undefined ? Number(req.query.radius) : 5000;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new AppError(ERR.VALIDATE, 'radius 必须是正数', 400);
  }
  return hasLng ? { lng, lat, radius } : null;
}

/**
 * 5.1 探索坐标列表（按作者分组）
 * - 过滤：mode=work + isPublic + 未删除 + 作者当前 isPhotographer=true（批量查，勿 N+1）
 * - 排序：已关注作者优先 → 作品数（照片数）→ 热度（获赞数），分页单位为"作者组"
 * - 返回 { coords（本页坐标扁平列表）, authorGroups（作者信息 + 坐标/精选照片）, 分页字段 }
 */
export const exploreCoords = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const meId = req.user._id;
  const center = parseCenter(req);
  const followingSet = new Set((req.user.following || []).map(String));

  const query = {
    mode: 'work',
    isPublic: true,
    deletedAt: null,
    authorId: { $ne: meId }, // 不含自己的作品
  };
  if (center) {
    const delta = radiusDelta(center.radius, center.lat);
    if (delta) {
      query.lng = { $gte: center.lng - delta.dLng, $lte: center.lng + delta.dLng };
      query.lat = { $gte: center.lat - delta.dLat, $lte: center.lat + delta.dLat };
    }
  }

  let coords = await Coord.find(query)
    .sort({ createdAt: -1 })
    .limit(COORD_CANDIDATE_LIMIT)
    .lean();

  if (center) {
    const maxKm = radiusMaxKm(center.radius);
    coords = coords.filter((c) => haversineKm(center, c) <= maxKm);
  }

  // 关键联动：批量校验作者当前是否摄影师（不信任坐标历史字段，会员到期即隐藏）
  const authorIds = [...new Set(coords.map((c) => String(c.authorId)))];
  const validAuthors = authorIds.length
    ? await User.find({ _id: { $in: authorIds }, isPhotographer: true })
        .select('_id nickname avatar')
        .lean()
    : [];
  const validAuthorIds = new Set(validAuthors.map((u) => String(u._id)));
  const authorMap = new Map(validAuthors.map((u) => [String(u._id), u]));
  coords = coords.filter((c) => validAuthorIds.has(String(c.authorId)));

  // 批量聚合各坐标获赞总数（一次查询，勿 N+1）
  const likeByCoord = new Map();
  if (coords.length) {
    const likeAgg = await Photo.aggregate([
      { $match: { coordId: { $in: coords.map((c) => c._id) }, deletedAt: null } },
      { $group: { _id: '$coordId', likes: { $sum: '$likes' } } },
    ]);
    for (const a of likeAgg) likeByCoord.set(String(a._id), a.likes || 0);
  }

  // 按作者分组
  const byAuthor = new Map();
  for (const c of coords) {
    const key = String(c.authorId);
    if (!byAuthor.has(key)) byAuthor.set(key, { user: authorMap.get(key), coords: [] });
    byAuthor.get(key).coords.push(c);
  }

  const groups = [...byAuthor.values()];
  for (const g of groups) {
    g.coordCount = g.coords.length;
    g.photoCount = g.coords.reduce((s, c) => s + (c.photoCount || 0), 0);
    g.totalLikes = g.coords.reduce((s, c) => s + (likeByCoord.get(String(c._id)) || 0), 0);
    // 组内坐标按热度（获赞数）倒序
    g.coords.sort(
      (a, b) =>
        (likeByCoord.get(String(b._id)) || 0) - (likeByCoord.get(String(a._id)) || 0) ||
        new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  // 作者排序：已关注优先 → 作品数（照片数）→ 热度（获赞数）
  groups.sort((a, b) => {
    const fa = followingSet.has(String(a.user._id)) ? 0 : 1;
    const fb = followingSet.has(String(b.user._id)) ? 0 : 1;
    return fa - fb || b.photoCount - a.photoCount || b.totalLikes - a.totalLikes;
  });

  const total = groups.length;
  const pageGroups = groups.slice(skip, skip + pageSize);

  // 本页作者的坐标照片（一次查询）：每坐标前 4 张缩略图 + 作者精选前 9 张
  const pageCoordIds = pageGroups.flatMap((g) =>
    g.coords.slice(0, COORDS_PER_AUTHOR).map((c) => c._id)
  );
  const pagePhotos = pageCoordIds.length
    ? await Photo.find({ coordId: { $in: pageCoordIds }, deletedAt: null })
        .sort({ takenAt: -1 })
        .limit(PHOTOS_FETCH_LIMIT)
        .lean()
    : [];

  const thumbByCoord = new Map(); // coordId -> Photo[]（取前 4）
  const authorPicks = new Map(); // authorId -> Photo[]（取前 9，按获赞）
  for (const p of pagePhotos) {
    const cid = String(p.coordId);
    if (!thumbByCoord.has(cid)) thumbByCoord.set(cid, []);
    if (thumbByCoord.get(cid).length < THUMBS_PER_COORD) thumbByCoord.get(cid).push(p);

    const aid = String(p.authorId);
    if (!authorPicks.has(aid)) authorPicks.set(aid, []);
    if (authorPicks.get(aid).length < PHOTOS_PER_AUTHOR) authorPicks.get(aid).push(p);
  }
  // 作者精选按获赞倒序（在已抓取照片集内近似）
  for (const ps of authorPicks.values()) {
    ps.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  }

  // 置顶席位注入：本页坐标的活跃 boost，按档位分池、各池按 start 倒序（后买靠前）
  const pageCoordTitles = [...new Set(pageGroups.flatMap((g) => g.coords.map((c) => c.title)))];
  const activeBoosts = pageCoordTitles.length
    ? await ExploreBoost.find({ coordKey: { $in: pageCoordTitles }, until: { $gt: new Date() } })
        .sort({ start: -1 })
        .populate('authorId', 'nickname')
        .lean()
    : [];
  const boostByCoord = new Map();
  for (const b of activeBoosts) {
    const name = b.authorId ? b.authorId.nickname : '';
    if (!name) continue;
    const bucket = boostByCoord.get(b.coordKey) || { month: [], week: [] };
    (b.tier === 'month' ? bucket.month : bucket.week).push(name);
    boostByCoord.set(b.coordKey, bucket);
  }

  const coordsFlat = [];
  const authorGroups = pageGroups.map((g) => {
    const u = g.user;
    const authorCoords = g.coords.slice(0, COORDS_PER_AUTHOR).map((c) => {
      const card = {
        id: String(c._id),
        title: c.title,
        lng: c.lng,
        lat: c.lat,
        photoCount: c.photoCount || 0,
        likeCount: likeByCoord.get(String(c._id)) || 0,
        boostAuthors: boostByCoord.get(c.title) || { month: [], week: [] },
        thumbnails: (thumbByCoord.get(String(c._id)) || []).map((p) => p.thumbnailUrl || p.imageUrl),
      };
      coordsFlat.push({ ...card, authorId: String(c.authorId) });
      return card;
    });
    return {
      authorId: String(u._id),
      authorName: u.nickname,
      authorAvatar: u.avatar || '',
      isFollowed: followingSet.has(String(u._id)),
      coordCount: g.coordCount,
      photoCount: g.photoCount,
      totalLikes: g.totalLikes,
      photos: (authorPicks.get(String(u._id)) || []).map((p) => ({
        id: String(p._id),
        imageUrl: p.imageUrl,
        thumbnailUrl: p.thumbnailUrl || p.imageUrl,
        likes: p.likes || 0,
      })),
      coords: authorCoords,
    };
  });

  ok(res, {
    coords: coordsFlat,
    authorGroups,
    ...paginated(authorGroups, total, page, pageSize),
  });
});

/**
 * 5.2 摄影师排行榜（按获赞数聚合，周/月/总榜 + myRank）
 * - type=weekly（近 7 天）/ monthly（近 30 天）/ all（全部），按 Photo.uploadTime 窗口过滤
 * - 仅统计当前 isPhotographer=true 的用户（批量查，勿 N+1）
 * - 排名在"通过摄影师过滤后的完整列表"上编号；myRank 为当前用户在完整榜中的名次（不在榜为 null）
 */
export const ranking = asyncHandler(async (req, res) => {
  const type = req.query.type || 'all';
  const { page, pageSize, skip } = pagination(req);
  const meId = req.user._id;
  const followingSet = new Set((req.user.following || []).map(String));

  const match = { deletedAt: null };
  const days = RANK_WINDOW_DAYS[type];
  if (days) match.uploadTime = { $gte: new Date(Date.now() - days * 86400000) };

  const agg = await Photo.aggregate([
    { $match: match },
    { $group: { _id: '$authorId', totalLikes: { $sum: '$likes' }, photoCount: { $sum: 1 } } },
    { $sort: { totalLikes: -1, photoCount: -1 } },
    { $limit: RANK_AUTHOR_LIMIT },
  ]);

  // 探索池准入：仅保留当前有效摄影师（会员到期即从榜单消失，数据不删）
  const aggIds = agg.map((a) => a._id);
  const validUsers = aggIds.length
    ? await User.find({ _id: { $in: aggIds }, isPhotographer: true })
        .select('_id nickname avatar')
        .lean()
    : [];
  const validMap = new Map(validUsers.map((u) => [String(u._id), u]));
  const entries = agg
    .filter((a) => validMap.has(String(a._id)))
    .map((a, i) => ({
      rank: i + 1,
      authorId: String(a._id),
      totalLikes: a.totalLikes || 0,
      photoCount: a.photoCount || 0,
    }));

  const total = entries.length;
  const pageEntries = entries.slice(skip, skip + pageSize).map((e) => {
    const u = validMap.get(e.authorId);
    return {
      ...e,
      authorName: u.nickname,
      authorAvatar: u.avatar || '',
      isFollowed: followingSet.has(e.authorId),
    };
  });

  const meEntry = entries.find((e) => e.authorId === String(meId));
  const myRank = meEntry ? meEntry.rank : null;

  ok(res, { rankings: pageEntries, myRank, ...paginated(pageEntries, total, page, pageSize) });
});
