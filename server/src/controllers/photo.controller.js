/**
 * 照片控制器（api.md 第 6/13 章）
 * - GET /photos/mine 我的照片（时间 / 按坐标分组）
 * - GET /photos/{photoId} 照片详情
 * - POST/DELETE like、collect（打赏 P1）
 * - DELETE /photos/{photoId} 软删除、POST restore、DELETE permanent、GET trash 回收站
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { User, Coord, Photo, Notification } from '../models/index.js';

/** 生成照片互动状态字段（isLiked/isTipped/isCollected） */
function interactionFlags(photo, meId) {
  const me = String(meId);
  return {
    likes: photo.likes || 0,
    tips: photo.tips || 0,
    isLiked: (photo.likedBy || []).map(String).includes(me),
    isTipped: (photo.tippedBy || []).map(String).includes(me),
    isCollected: (photo.collectedBy || []).map(String).includes(me),
  };
}

/** 13.1 获取我的照片列表（sortBy: time 时间 / coord 按坐标分组） */
export const getMyPhotos = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const sortBy = req.query.sortBy || 'time';
  const meId = req.user._id;

  if (sortBy === 'coord') {
    // 按坐标分组：分页单位为"坐标组"
    const query = { authorId: meId, deletedAt: null, photoCount: { $gt: 0 } };
    const [coords, total] = await Promise.all([
      Coord.find(query).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
      Coord.countDocuments(query),
    ]);
    const coordIds = coords.map((c) => c._id);
    const photos = coordIds.length
      ? await Photo.find({ coordId: { $in: coordIds }, deletedAt: null })
          .sort({ takenAt: -1 })
          .lean()
      : [];
    const byCoord = new Map();
    for (const p of photos) {
      const key = String(p.coordId);
      if (!byCoord.has(key)) byCoord.set(key, []);
      byCoord.get(key).push(p);
    }
    const list = coords.map((c) => ({
      coordId: String(c._id),
      coordTitle: c.title,
      lng: c.lng,
      lat: c.lat,
      date: (c.createdAt || new Date()).toISOString().slice(0, 10),
      photos: (byCoord.get(String(c._id)) || []).map((p) => ({
        id: String(p._id),
        imageUrl: p.imageUrl,
        thumbnailUrl: p.thumbnailUrl || p.imageUrl,
        takenAt: p.takenAt,
        uploadTime: p.uploadTime,
        ...interactionFlags(p, meId),
      })),
    }));
    return ok(res, paginated(list, total, page, pageSize));
  }

  // 按时间倒序
  const query = { authorId: meId, deletedAt: null };
  const [photos, total] = await Promise.all([
    Photo.find(query).sort({ takenAt: -1 }).skip(skip).limit(pageSize).lean(),
    Photo.countDocuments(query),
  ]);
  const list = photos.map((p) => ({
    id: String(p._id),
    imageUrl: p.imageUrl,
    thumbnailUrl: p.thumbnailUrl || p.imageUrl,
    coordId: p.coordId ? String(p.coordId) : null,
    takenAt: p.takenAt,
    uploadTime: p.uploadTime,
    filterApplied: p.filterApplied || '',
    ...interactionFlags(p, meId),
  }));
  ok(res, paginated(list, total, page, pageSize));
});

/** 6.1 获取照片详情（含作者与互动状态） */
export const getPhotoDetail = asyncHandler(async (req, res) => {
  const photo = await Photo.findOne({ _id: req.params.photoId, deletedAt: null });
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);

  const [author, coord] = await Promise.all([
    User.findById(photo.authorId).select('nickname avatar isPhotographer').lean(),
    photo.coordId ? Coord.findById(photo.coordId).select('title lng lat').lean() : null,
  ]);

  ok(res, {
    id: String(photo._id),
    imageUrl: photo.imageUrl,
    thumbnailUrl: photo.thumbnailUrl || photo.imageUrl,
    authorId: String(photo.authorId),
    author: {
      nickname: author?.nickname || '',
      avatar: author?.avatar || '',
      isPhotographer: author?.isPhotographer || false,
    },
    coord: coord
      ? { id: String(coord._id), title: coord.title, lng: coord.lng, lat: coord.lat }
      : null,
    takenAt: photo.takenAt,
    uploadTime: photo.uploadTime,
    filterApplied: photo.filterApplied || '',
    exif: photo.exif || {},
    gpsSource: photo.gpsSource || 'none',
    ...interactionFlags(photo, req.user._id),
  });
});

/**
 * 通用互动原子操作：POST 类（push+inc，已存在则报 1005）
 * @param {string} field likedBy / collectedBy / tippedBy
 * @param {string} counter likes / collects / tips
 */
async function addInteraction(req, photoId, field, counter) {
  const meId = req.user._id;
  const result = await Photo.updateOne(
    { _id: photoId, deletedAt: null, [field]: { $ne: meId } },
    { $push: { [field]: meId }, $inc: { [counter]: 1 } }
  );
  if (result.modifiedCount === 0) {
    throw new AppError(ERR.DUPLICATE, '重复操作', 409);
  }
  const photo = await Photo.findById(photoId).select('authorId');
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);
  if (String(photo.authorId) !== String(meId)) {
    await Notification.create({
      userId: photo.authorId,
      type: field === 'likedBy' ? 'like' : 'collect',
      actorId: meId,
      photoId,
    }).catch(() => {});
  }
  const p = await Photo.findById(photoId).select(counter);
  return { [counter]: p?.[counter] || 0 };
}

/** 通用互动原子操作：DELETE 类（pull+inc，不存在则报 1005） */
async function removeInteraction(req, photoId, field, counter) {
  const meId = req.user._id;
  const result = await Photo.updateOne(
    { _id: photoId, deletedAt: null, [field]: meId },
    { $pull: { [field]: meId }, $inc: { [counter]: -1 } }
  );
  if (result.modifiedCount === 0) {
    throw new AppError(ERR.DUPLICATE, '重复操作', 409);
  }
  const p = await Photo.findById(photoId).select(counter);
  return { [counter]: Math.max(0, p?.[counter] || 0) };
}

/** 6.2 点赞 */
export const likePhoto = asyncHandler(async (req, res) => {
  const r = await addInteraction(req, req.params.photoId, 'likedBy', 'likes');
  ok(res, r, '点赞成功');
});

/** 6.3 取消点赞 */
export const unlikePhoto = asyncHandler(async (req, res) => {
  const r = await removeInteraction(req, req.params.photoId, 'likedBy', 'likes');
  ok(res, r, '已取消点赞');
});

/** 6.5 收藏照片 */
export const collectPhoto = asyncHandler(async (req, res) => {
  const r = await addInteraction(req, req.params.photoId, 'collectedBy', 'collects');
  ok(res, r, '收藏成功');
});

/** 6.6 取消收藏照片 */
export const uncollectPhoto = asyncHandler(async (req, res) => {
  const r = await removeInteraction(req, req.params.photoId, 'collectedBy', 'collects');
  ok(res, r, '已取消收藏');
});

/** 7.6 删除照片（软删除进回收站） */
export const softDeletePhoto = asyncHandler(async (req, res) => {
  const photo = await Photo.findOne({ _id: req.params.photoId, deletedAt: null });
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);
  if (String(photo.authorId) !== String(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '只能删除自己的照片', 403);
  }
  photo.deletedAt = new Date();
  await photo.save();
  ok(res, {}, '照片已删除（可在回收站恢复）');
});

/** 7.7 恢复已删除的照片 */
export const restorePhoto = asyncHandler(async (req, res) => {
  const photo = await Photo.findOne({ _id: req.params.photoId, authorId: req.user._id });
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在', 404);
  if (!photo.deletedAt) throw new AppError(ERR.DUPLICATE, '照片未删除，无需恢复', 409);
  photo.deletedAt = null;
  await photo.save();
  ok(res, {}, '照片已恢复');
});

/** 13.3 永久删除照片 */
export const permanentDeletePhoto = asyncHandler(async (req, res) => {
  const photo = await Photo.findOne({ _id: req.params.photoId, authorId: req.user._id });
  if (!photo) throw new AppError(ERR.NOT_FOUND, '照片不存在', 404);
  await Photo.deleteOne({ _id: photo._id });
  // 同步坐标计数与 photoTimes
  if (photo.coordId) {
    await Coord.updateOne(
      { _id: photo.coordId },
      { $inc: { photoCount: -1 }, $unset: { [`photoTimes.${photo._id}`]: '' } }
    );
  }
  ok(res, {}, '照片已永久删除');
});

/** 13.2 回收站列表（type: photos / markers / all） */
export const getTrash = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const type = req.query.type || 'all';
  const meId = req.user._id;

  const getPhotos = async () =>
    Promise.all([
      Photo.find({ authorId: meId, deletedAt: { $ne: null } })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .select('_id imageUrl thumbnailUrl deletedAt coordId')
        .lean(),
      Photo.countDocuments({ authorId: meId, deletedAt: { $ne: null } }),
    ]);
  const getCoords = async () =>
    Promise.all([
      Coord.find({ authorId: meId, deletedAt: { $ne: null } })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .select('_id title lng lat photoCount deletedAt')
        .lean(),
      Coord.countDocuments({ authorId: meId, deletedAt: { $ne: null } }),
    ]);

  let photos = [];
  let coords = [];
  if (type === 'photos') [photos] = await getPhotos();
  else if (type === 'markers') [coords] = await getCoords();
  else {
    [photos] = await getPhotos();
    [coords] = await getCoords();
  }

  const list = [
    ...photos.map((p) => ({
      type: 'photo',
      id: String(p._id),
      title: '',
      imageUrl: p.imageUrl,
      thumbnailUrl: p.thumbnailUrl || p.imageUrl,
      coordId: p.coordId ? String(p.coordId) : null,
      deletedAt: p.deletedAt,
    })),
    ...coords.map((c) => ({
      type: 'coord',
      id: String(c._id),
      title: c.title,
      lng: c.lng,
      lat: c.lat,
      photoCount: c.photoCount,
      deletedAt: c.deletedAt,
    })),
  ];

  ok(res, paginated(list, list.length, page, pageSize));
});
