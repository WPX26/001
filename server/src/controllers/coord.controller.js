/**
 * 坐标控制器（api.md 第 3/7 章坐标部分）
 * - POST /coords 创建坐标 + 关联照片（含 photoTimes）
 * - GET /coords/{coordId}/detail 坐标详情 + 照片分页列表
 * - DELETE /coords/{coordId} 软删除、POST /coords/{coordId}/restore 恢复
 * - DELETE /coords/{coordId}/permanent 永久删除
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination } from '../utils/pagination.js';
import { gridKeyOf } from '../utils/geo.js';
import { User, Coord, Photo } from '../models/index.js';

/** 批量查询用户资料（昵称/头像）建立 map */
async function buildUserMap(userIds) {
  const ids = [...new Set(userIds.map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select('nickname avatar').lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

/** 7.2 创建坐标并关联照片 */
export const createCoord = asyncHandler(async (req, res) => {
  const { title, lng, lat, photoIds, isPublic = true, photoTimes = {}, mode = 'life' } = req.body;

  // 工作模式发布需摄影师认证（探索池准入）
  if (mode === 'work' && !req.user.isPhotographer) {
    throw new AppError(ERR.FORBIDDEN, '需先通过摄影师认证才能以工作模式发布', 403);
  }

  const uniqueIds = [...new Set(photoIds.map(String))];
  const photos = await Photo.find({ _id: { $in: uniqueIds }, authorId: req.user._id, deletedAt: null });
  if (photos.length !== uniqueIds.length) {
    throw new AppError(ERR.NOT_FOUND, '部分照片不存在或不属于当前用户', 404);
  }
  const attached = photos.find((p) => p.coordId);
  if (attached) {
    throw new AppError(ERR.DUPLICATE, '部分照片已关联其他坐标，请勿重复关联', 409);
  }

  const coord = await Coord.create({
    title,
    lng,
    lat,
    authorId: req.user._id,
    isPublic,
    mode,
    photoTimes,
    photoCount: photos.length,
    gridKey: gridKeyOf(lng, lat),
  });

  // 回填照片的坐标归属与拍摄时间
  for (const photo of photos) {
    const taken = photoTimes[String(photo._id)];
    await Photo.updateOne(
      { _id: photo._id },
      { $set: { coordId: coord._id, ...(taken ? { takenAt: new Date(taken) } : {}) } }
    );
  }

  ok(
    res,
    {
      id: String(coord._id),
      title: coord.title,
      lng: coord.lng,
      lat: coord.lat,
      isPublic: coord.isPublic,
      mode: coord.mode,
      photoCount: coord.photoCount,
    },
    '坐标创建成功'
  );
});

/** 3.4 / 7.8 更新坐标标题（仅作者本人，软删除的坐标不可改） */
export const updateCoord = asyncHandler(async (req, res) => {
  const coord = await Coord.findOne({ _id: req.params.coordId, deletedAt: null });
  if (!coord) throw new AppError(ERR.NOT_FOUND, '坐标不存在或已删除', 404);
  if (String(coord.authorId) !== String(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '只能修改自己创建的坐标', 403);
  }

  coord.title = req.body.title;
  await coord.save();

  // 返回结构对齐 POST /coords（api.md 7.2）
  ok(
    res,
    {
      id: String(coord._id),
      title: coord.title,
      lng: coord.lng,
      lat: coord.lat,
      isPublic: coord.isPublic,
      mode: coord.mode,
      photoCount: coord.photoCount,
    },
    '坐标标题更新成功'
  );
});

/** 3.3 获取单个坐标详情与照片列表 */
export const coordDetail = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);

  const coord = await Coord.findOne({ _id: req.params.coordId, deletedAt: null });
  if (!coord) throw new AppError(ERR.NOT_FOUND, '坐标不存在或已删除', 404);

  const [photos, totalCount] = await Promise.all([
    Photo.find({ coordId: coord._id, deletedAt: null })
      .sort({ takenAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    Photo.countDocuments({ coordId: coord._id, deletedAt: null }),
  ]);

  const userMap = await buildUserMap([...photos.map((p) => p.authorId), coord.authorId]);
  const me = String(req.user._id);

  const coordAuthor = userMap.get(String(coord.authorId));
  const photoList = photos.map((p) => {
    const author = userMap.get(String(p.authorId));
    return {
      id: String(p._id),
      imageUrl: p.imageUrl,
      thumbnailUrl: p.thumbnailUrl || p.imageUrl,
      authorId: String(p.authorId),
      authorName: author?.nickname || '',
      authorAvatar: author?.avatar || '',
      likes: p.likes || 0,
      tips: p.tips || 0,
      isLiked: (p.likedBy || []).map(String).includes(me),
      isTipped: (p.tippedBy || []).map(String).includes(me),
      isCollected: (p.collectedBy || []).map(String).includes(me),
      uploadTime: p.uploadTime,
      filterApplied: p.filterApplied || '',
      exif: p.exif || {},
    };
  });

  ok(res, {
    coordInfo: {
      id: String(coord._id),
      title: coord.title,
      lng: coord.lng,
      lat: coord.lat,
      date: (coord.createdAt || new Date()).toISOString().slice(0, 10),
      authorId: String(coord.authorId),
      authorName: coordAuthor?.nickname || '',
      isCollected: (coord.collectedBy || []).map(String).includes(me),
    },
    photos: photoList,
    totalCount,
    page,
    pageSize,
  });
});

/** 7.4 删除坐标（软删除：坐标 + 其照片进回收站，30 天内可恢复） */
export const softDeleteCoord = asyncHandler(async (req, res) => {
  const coord = await Coord.findOne({ _id: req.params.coordId, deletedAt: null });
  if (!coord) throw new AppError(ERR.NOT_FOUND, '坐标不存在或已删除', 404);
  if (String(coord.authorId) !== String(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '只能删除自己的坐标', 403);
  }
  const now = new Date();
  coord.deletedAt = now;
  await coord.save();
  await Photo.updateMany({ coordId: coord._id, deletedAt: null }, { $set: { deletedAt: now } });
  ok(res, {}, '坐标已删除（可在回收站恢复）');
});

/** 7.5 恢复已删除的坐标（同时恢复其照片） */
export const restoreCoord = asyncHandler(async (req, res) => {
  const coord = await Coord.findOne({ _id: req.params.coordId });
  if (!coord) throw new AppError(ERR.NOT_FOUND, '坐标不存在', 404);
  if (String(coord.authorId) !== String(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '只能恢复自己的坐标', 403);
  }
  if (!coord.deletedAt) throw new AppError(ERR.DUPLICATE, '坐标未删除，无需恢复', 409);
  coord.deletedAt = null;
  await coord.save();
  await Photo.updateMany({ coordId: coord._id }, { $set: { deletedAt: null } });
  ok(res, {}, '坐标已恢复');
});

/** 13.3 永久删除坐标（物理删除 + 其照片物理删除，不可恢复） */
export const permanentDeleteCoord = asyncHandler(async (req, res) => {
  const coord = await Coord.findById(req.params.coordId);
  if (!coord) throw new AppError(ERR.NOT_FOUND, '坐标不存在', 404);
  if (String(coord.authorId) !== String(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '只能删除自己的坐标', 403);
  }
  await Photo.deleteMany({ coordId: coord._id });
  await Coord.deleteOne({ _id: coord._id });
  ok(res, {}, '坐标已永久删除');
});
