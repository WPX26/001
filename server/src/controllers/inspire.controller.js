/**
 * 灵感模式控制器（api.md 第 4 章）
 * - GET /inspire/coords 生活池公开坐标列表（照片按时间分组）
 * - POST /inspire/collect 收藏坐标（多选合并，原子 push + inc）
 * - DELETE /inspire/collect/{coordId} 取消收藏（原子 pull + inc -1）
 *
 * 灵感池 = 生活模式（mode=life）公开坐标，无摄影师认证要求；
 * 半径约定见 utils/geo.js radiusDelta（radius ≤ 180 视为度，> 180 视为米）
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { haversineKm, radiusDelta, radiusMaxKm } from '../utils/geo.js';
import { User, Coord, Photo } from '../models/index.js';

/** 每组照片上限（api.md 4.1：按时间分组，每组前 N 张） */
const PHOTOS_PER_GROUP = 9;
/** 半径过滤候选坐标上限（防超大 radius 拖垮内存排序，参照 map/markers 的 $limit 保护） */
const COORD_CANDIDATE_LIMIT = 1000;
/** 单次拉取照片上限（照片多的坐标截断，仅影响分组饱满度） */
const PHOTOS_FETCH_LIMIT = 500;

/** 坐标热度分：照片获赞总数 + 收藏数（hot/followed 排序用） */
function hotScore(coord, likeSum) {
  return (likeSum || 0) + (coord.collectedCount || 0);
}

/** 批量查询用户资料（昵称/头像）建立 map（勿 N+1 循环查库） */
async function buildUserMap(userIds) {
  const ids = [...new Set(userIds.map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select('nickname avatar').lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

/**
 * 4.1 灵感坐标列表
 * - 生活池（mode=life）公开坐标；排除自己的坐标（api.md 4.1：他人公开内容）
 * - 排序：followed（已关注作者优先 → 热度 → 时间，默认）/ hot（热度）/ time（最新）
 * - 每个坐标返回 coordInfo + photoGroups（照片按拍摄日期分组，组内按关注优先 + 热度排序，每组前 9 张）
 */
export const inspireCoords = asyncHandler(async (req, res) => {
  const lng = Number(req.query.lng);
  const lat = Number(req.query.lat);
  const radius = req.query.radius !== undefined ? Number(req.query.radius) : 5000;
  const sortBy = req.query.sortBy || 'followed';
  const { page, pageSize, skip } = pagination(req);
  const meId = req.user._id;
  const me = String(meId);
  const followingSet = new Set((req.user.following || []).map(String));

  const query = {
    mode: 'life',
    isPublic: true,
    deletedAt: null,
    authorId: { $ne: meId }, // 排除自己
  };
  const delta = radiusDelta(radius, lat);
  if (delta) {
    // bbox 索引预过滤（矩形近似），精确距离在下方 JS 内再过滤
    query.lng = { $gte: lng - delta.dLng, $lte: lng + delta.dLng };
    query.lat = { $gte: lat - delta.dLat, $lte: lat + delta.dLat };
  }

  let coords = await Coord.find(query)
    .sort({ createdAt: -1 })
    .limit(COORD_CANDIDATE_LIMIT)
    .lean();

  if (delta) {
    const maxKm = radiusMaxKm(radius);
    coords = coords.filter((c) => haversineKm({ lng, lat }, c) <= maxKm);
  }

  // 批量聚合各坐标获赞总数（一次查询，勿 N+1）
  const likeByCoord = new Map();
  if (coords.length) {
    const likeAgg = await Photo.aggregate([
      { $match: { coordId: { $in: coords.map((c) => c._id) }, deletedAt: null } },
      { $group: { _id: '$coordId', likes: { $sum: '$likes' } } },
    ]);
    for (const a of likeAgg) likeByCoord.set(String(a._id), a.likes || 0);
  }

  // 内存排序（time 已由 DB 层完成，hot/followed 需要热度分与关注状态）
  const byFollowed = (c) => (followingSet.has(String(c.authorId)) ? 0 : 1);
  const hot = (c) => hotScore(c, likeByCoord.get(String(c._id)) || 0);
  const byTime = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  if (sortBy === 'hot') {
    coords.sort((a, b) => hot(b) - hot(a) || byTime(a, b));
  } else if (sortBy === 'followed') {
    coords.sort((a, b) => byFollowed(a) - byFollowed(b) || hot(b) - hot(a) || byTime(a, b));
  }

  const total = coords.length; // 候选集上限内的总数（超大半径场景为近似值）
  const pageCoords = coords.slice(skip, skip + pageSize);

  // 本页坐标的照片（一次查询；按拍摄时间倒序，组内再按热度重排）
  const coordIds = pageCoords.map((c) => c._id);
  const photos = coordIds.length
    ? await Photo.find({ coordId: { $in: coordIds }, deletedAt: null })
        .sort({ takenAt: -1 })
        .limit(PHOTOS_FETCH_LIMIT)
        .lean()
    : [];

  // 按坐标 → 拍摄日期分组（组内保留前 PHOTOS_PER_GROUP 张）
  const byCoord = new Map(); // coordId -> Map<date, Photo[]>
  for (const p of photos) {
    const key = String(p.coordId);
    const date = (p.takenAt || p.uploadTime || new Date()).toISOString().slice(0, 10);
    if (!byCoord.has(key)) byCoord.set(key, new Map());
    const groups = byCoord.get(key);
    if (!groups.has(date)) groups.set(date, []);
    if (groups.get(date).length < PHOTOS_PER_GROUP) groups.get(date).push(p);
  }

  const userMap = await buildUserMap(pageCoords.map((c) => c.authorId));

  // 组内照片排序：关注作者优先 → 获赞 → 上传时间
  const sortGroupPhotos = (ps) =>
    ps.sort(
      (a, b) =>
        (followingSet.has(String(a.authorId)) ? 0 : 1) -
          (followingSet.has(String(b.authorId)) ? 0 : 1) ||
        (b.likes || 0) - (a.likes || 0) ||
        new Date(b.uploadTime) - new Date(a.uploadTime)
    );

  const list = pageCoords.map((c) => {
    const author = userMap.get(String(c.authorId));
    const groups = [...(byCoord.get(String(c._id)) || new Map()).entries()];
    // 日期倒序；组内照片按关注优先 + 热度排序
    groups.sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const photoGroups = groups.map(([date, ps]) => ({
      date,
      photos: sortGroupPhotos(ps).map((p) => ({
        id: String(p._id),
        imageUrl: p.imageUrl,
        thumbnailUrl: p.thumbnailUrl || p.imageUrl,
        takenAt: p.takenAt,
        likes: p.likes || 0,
        isLiked: (p.likedBy || []).map(String).includes(me),
      })),
    }));
    return {
      coordInfo: {
        id: String(c._id),
        title: c.title,
        lng: c.lng,
        lat: c.lat,
        date: (c.createdAt || new Date()).toISOString().slice(0, 10),
        authorId: String(c.authorId),
        authorName: author?.nickname || '',
        authorAvatar: author?.avatar || '',
        isFollowedAuthor: followingSet.has(String(c.authorId)),
        photoCount: c.photoCount || 0,
        likeCount: likeByCoord.get(String(c._id)) || 0,
        collectedCount: c.collectedCount || 0,
        isCollected: (c.collectedBy || []).map(String).includes(me),
      },
      photoGroups,
    };
  });

  ok(res, paginated(list, total, page, pageSize));
});

/**
 * 4.2 收藏坐标（多选合并收藏）
 * body: { sourceCoordIds: [...] }（去重后逐个原子 push+inc）
 * - 任一坐标不存在/已删除 → 404/1004
 * - 任一坐标已收藏 → 409/1005（重复操作，整体失败，不部分生效）
 */
export const collectCoords = asyncHandler(async (req, res) => {
  const ids = [...new Set(req.body.sourceCoordIds.map(String))];
  const meId = req.user._id;

  // 先校验存在性与重复性，再统一写入（避免 updateMany 已部分生效后再抛 409）
  // P0-1 统查：仅允许收藏公开坐标（私有坐标按 404 隐藏，防 ID 直连把私有内容拉入收藏）
  const existing = await Coord.countDocuments({ _id: { $in: ids }, deletedAt: null, isPublic: true });
  if (existing !== ids.length) {
    throw new AppError(ERR.NOT_FOUND, '部分坐标不存在或已删除', 404);
  }
  const already = await Coord.countDocuments({ _id: { $in: ids }, collectedBy: meId });
  if (already > 0) {
    throw new AppError(ERR.DUPLICATE, '部分坐标已收藏，请勿重复收藏', 409);
  }

  // 原子 push + inc（collectedBy 不含我才命中）
  const result = await Coord.updateMany(
    { _id: { $in: ids }, collectedBy: { $ne: meId } },
    { $push: { collectedBy: meId }, $inc: { collectedCount: 1 } }
  );
  // 并发兜底：预检通过后仍有未命中 → 并发重复收藏，整体失败（不返回部分成功）
  if (result.modifiedCount !== ids.length) {
    throw new AppError(ERR.DUPLICATE, '部分坐标已收藏，请勿重复收藏', 409);
  }

  ok(res, { collected: ids.length, coordIds: ids }, '收藏成功');
});

/**
 * 4.3 取消收藏（原子 pull + inc -1）
 * - 坐标不存在/已删除 → 404/1004
 * - 未收藏过 → 409/1005
 */
export const uncollectCoord = asyncHandler(async (req, res) => {
  const coordId = req.params.coordId;
  const meId = req.user._id;

  const result = await Coord.updateOne(
    { _id: coordId, deletedAt: null, collectedBy: meId },
    { $pull: { collectedBy: meId }, $inc: { collectedCount: -1 } }
  );
  if (result.modifiedCount === 0) {
    const exists = await Coord.exists({ _id: coordId, deletedAt: null });
    if (!exists) throw new AppError(ERR.NOT_FOUND, '坐标不存在或已删除', 404);
    throw new AppError(ERR.DUPLICATE, '尚未收藏该坐标', 409);
  }

  ok(res, { isCollected: false }, '已取消收藏');
});
