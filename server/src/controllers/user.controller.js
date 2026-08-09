/**
 * 用户控制器（api.md 第 2 章）
 * - GET/PUT /users/me、GET /users/{userId}/profile
 * - POST/DELETE /users/{userId}/follow、following/followers 列表
 * - GET /users/{userId}/coords 作品列表、PUT /users/me/mode 模式切换
 * - GET /users/me/collected-coords 我收藏的坐标
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { User, Coord, Photo, Notification } from '../models/index.js';

/** 手机号脱敏：138****1234 */
function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}

/**
 * 统计用户数据（主页 stats）
 * @param {ObjectId} userId
 * @param {boolean} isSelf 是否本人（本人统计全部，他人只统计公开内容）
 */
async function buildStats(userId, isSelf) {
  const visible = isSelf ? {} : { isPublic: true };
  const [coordCount, photoCount, followerCount, likeAgg] = await Promise.all([
    Coord.countDocuments({ authorId: userId, deletedAt: null, ...visible }),
    Photo.countDocuments({ authorId: userId, deletedAt: null }),
    User.countDocuments({ following: userId }),
    Photo.aggregate([
      { $match: { authorId: userId, deletedAt: null } },
      { $group: { _id: null, likes: { $sum: '$likes' } } },
    ]),
  ]);
  const me = isSelf ? await User.findById(userId) : null;
  return {
    coordCount,
    photoCount,
    likeCount: likeAgg[0]?.likes || 0,
    followerCount,
    followingCount: isSelf ? (me?.following?.length || 0) : 0,
  };
}

/** 2.1 获取我的资料（完整信息 + 统计） */
export const getMe = asyncHandler(async (req, res) => {
  const user = req.user;
  const stats = await buildStats(user._id, true);
  ok(res, {
    id: String(user._id),
    phone: maskPhone(user.phone),
    nickname: user.nickname,
    avatar: user.avatar || '',
    bio: user.bio || '',
    mode: user.mode,
    isPhotographer: user.isPhotographer,
    memberStatus: user.memberStatus,
    memberExpireAt: user.memberExpireAt || null,
    createdAt: user.createdAt,
    stats,
  });
});

/** 2.2 更新我的资料 */
export const updateMe = asyncHandler(async (req, res) => {
  const user = req.user;
  const { nickname, avatar, bio } = req.body;
  if (nickname !== undefined) user.nickname = nickname;
  if (avatar !== undefined) user.avatar = avatar;
  if (bio !== undefined) user.bio = bio;
  await user.save();
  ok(res, {
    id: String(user._id),
    nickname: user.nickname,
    avatar: user.avatar || '',
    bio: user.bio || '',
  }, '资料已更新');
});

/** 2.3 获取他人主页 */
export const getProfile = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.userId);
  if (!target) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  const isFollowed = req.user.following.map(String).includes(String(target._id));
  const stats = await buildStats(target._id, false);

  ok(res, {
    id: String(target._id),
    nickname: target.nickname,
    avatar: target.avatar || '',
    bio: target.bio || '',
    mode: target.mode,
    isPhotographer: target.isPhotographer,
    isFollowed,
    stats,
  });
});

/** 2.4 获取他人发布的作品列表（坐标卡片） */
export const getUserCoords = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.userId);
  if (!target) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  const { page, pageSize, skip } = pagination(req);
  const query = { authorId: target._id, deletedAt: null, isPublic: true };

  const [coords, total] = await Promise.all([
    Coord.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Coord.countDocuments(query),
  ]);

  const coordIds = coords.map((c) => c._id);
  // 坐标的照片（每坐标取前 4 张缩略图 + 统计获赞数）
  const photos = coordIds.length
    ? await Photo.find({ coordId: { $in: coordIds }, deletedAt: null })
        .sort({ takenAt: -1 })
        .lean()
    : [];
  const byCoord = new Map();
  for (const p of photos) {
    if (!byCoord.has(String(p.coordId))) byCoord.set(String(p.coordId), []);
    if (byCoord.get(String(p.coordId)).length < 4) byCoord.get(String(p.coordId)).push(p);
  }
  const likeAgg = await Photo.aggregate([
    { $match: { coordId: { $in: coordIds }, deletedAt: null } },
    { $group: { _id: '$coordId', likes: { $sum: '$likes' } } },
  ]);
  const likesByCoord = new Map(likeAgg.map((x) => [String(x._id), x.likes]));

  const list = coords.map((c) => ({
    id: String(c._id),
    title: c.title,
    lng: c.lng,
    lat: c.lat,
    date: (c.createdAt || '').toString().slice(0, 10),
    photoCount: c.photoCount,
    likeCount: likesByCoord.get(String(c._id)) || 0,
    thumbnails: (byCoord.get(String(c._id)) || []).map((p) => p.thumbnailUrl || p.imageUrl),
  }));

  ok(res, paginated(list, total, page, pageSize));
});

/** 2.5 关注用户 */
export const follow = asyncHandler(async (req, res) => {
  const targetId = req.params.userId;
  if (String(targetId) === String(req.user._id)) {
    throw new AppError(ERR.VALIDATE, '不能关注自己', 400);
  }
  const target = await User.findById(targetId);
  if (!target) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  // 原子操作：未关注才 push，避免重复
  const mine = await User.updateOne(
    { _id: req.user._id, following: { $ne: targetId } },
    { $push: { following: targetId }, $inc: { followingCount: 1 } }
  );
  if (mine.modifiedCount === 0) {
    throw new AppError(ERR.DUPLICATE, '已关注该用户', 409);
  }
  await User.updateOne({ _id: targetId }, { $inc: { followerCount: 1 } });
  // 通知对方（P1 通知接口展示）
  await Notification.create({ userId: targetId, type: 'follow', actorId: req.user._id }).catch(() => {});

  ok(res, { isFollowed: true }, '关注成功');
});

/** 2.6 取消关注 */
export const unfollow = asyncHandler(async (req, res) => {
  const targetId = req.params.userId;
  const mine = await User.updateOne(
    { _id: req.user._id, following: targetId },
    { $pull: { following: targetId }, $inc: { followingCount: -1 } }
  );
  if (mine.modifiedCount === 0) {
    throw new AppError(ERR.DUPLICATE, '尚未关注该用户', 409);
  }
  await User.updateOne({ _id: targetId }, { $inc: { followerCount: -1 } });
  ok(res, { isFollowed: false }, '已取消关注');
});

/** 2.7 获取关注列表 */
export const getFollowing = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.userId).select('following');
  if (!target) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  const { page, pageSize } = pagination(req);
  const ids = target.following || [];
  const total = ids.length;
  const pageIds = ids.slice((page - 1) * pageSize, page * pageSize);
  const users = pageIds.length
    ? await User.find({ _id: { $in: pageIds } })
        .select('_id nickname avatar bio isPhotographer mode')
        .lean()
    : [];
  // 保持关注顺序
  const orderMap = new Map(pageIds.map((id, i) => [String(id), i]));
  users.sort((a, b) => orderMap.get(String(a._id)) - orderMap.get(String(b._id)));

  // 契约字段对齐：id（而非 _id），与 getMe/注册返回的用户结构一致
  const list = users.map((u) => ({
    id: String(u._id),
    nickname: u.nickname,
    avatar: u.avatar || '',
    bio: u.bio || '',
    isPhotographer: u.isPhotographer,
    mode: u.mode,
  }));

  ok(res, paginated(list, total, page, pageSize));
});

/** 2.8 获取粉丝列表 */
export const getFollowers = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.userId);
  if (!target) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  const { page, pageSize, skip } = pagination(req);
  const query = { following: target._id };
  const [users, total] = await Promise.all([
    User.find(query)
      .select('_id nickname avatar bio isPhotographer mode')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    User.countDocuments(query),
  ]);
  // 契约字段对齐：id（而非 _id），与 getMe/注册返回的用户结构一致
  const list = users.map((u) => ({
    id: String(u._id),
    nickname: u.nickname,
    avatar: u.avatar || '',
    bio: u.bio || '',
    isPhotographer: u.isPhotographer,
    mode: u.mode,
  }));
  ok(res, paginated(list, total, page, pageSize));
});

/** 2.9 切换生活/工作模式（工作模式需摄影师认证） */
export const updateMode = asyncHandler(async (req, res) => {
  const { mode } = req.body;
  if (mode === 'work' && !req.user.isPhotographer) {
    throw new AppError(ERR.FORBIDDEN, '需要先通过摄影师认证才能切换为工作模式', 403);
  }
  req.user.mode = mode;
  await req.user.save();
  ok(res, { mode }, '模式已切换');
});

/** 2.10 获取我收藏的坐标 */
export const getCollectedCoords = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const query = { collectedBy: req.user._id, deletedAt: null };
  const [coords, total] = await Promise.all([
    Coord.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Coord.countDocuments(query),
  ]);
  const list = coords.map((c) => ({
    id: String(c._id),
    title: c.title,
    lng: c.lng,
    lat: c.lat,
    photoCount: c.photoCount,
    date: (c.createdAt || '').toString().slice(0, 10),
  }));
  ok(res, paginated(list, total, page, pageSize));
});
