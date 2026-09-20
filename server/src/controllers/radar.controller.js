/**
 * 雷达控制器（2026-09-20 雷达一期）
 * - POST /radar/report 摄影师上报实时位置（工作模式、未隐身、前台才上报；服务端限流+跳变校验）
 * - GET  /radar/nearby 查看端拉取附近在线摄影师（过滤：排除自己/仅工作模式/未隐身/心跳 60 秒内/半径内）
 * - PUT  /radar/visibility 雷达隐身开关（开启后查询过滤 + 上报拒绝，双保险）
 *
 * 设计：只存每人一条「最后位置＋时间」（radar_locations，upsert 覆盖），不做位置历史；
 * 超过心跳窗口未更新 = 自动离线（查询侧用 updatedAt 过滤，数据不删）。
 */
import { ERR, USER_MODE } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { haversineKm, radiusDelta, radiusMaxKm } from '../utils/geo.js';
import { User, RadarLocation } from '../models/index.js';

/** 心跳窗口：最后上报距今超过该时长视为离线（查询时排除） */
export const RADAR_TTL_MS = 60 * 1000;
/** 上报最小间隔（服务端防御限流，客户端节流 5–10 秒，正常不触达） */
const REPORT_MIN_INTERVAL_MS = 3 * 1000;
/** 跳变校验：相邻两次上报换算速度超过该值（km/h）视为假位置/异常，丢弃本次 */
const MAX_SPEED_KMH = 120;
/** 附近返回上限 */
const NEARBY_LIMIT = 100;

/** 每用户最近一次上报时间戳（内存限流：userId → ts） */
const lastReportAt = new Map();

/**
 * 解析中心点（lng/lat/radius，与探索模式同一约定）
 * - lng/lat 可省略（不限范围）；给出其一则两者必须齐全
 * - radius ≤180 视为度，>180 视为米，默认 5000 米
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
 * POST /radar/report 上报实时位置
 * - 仅工作模式（摄影师）可上报；隐身时不接收（前端停止上报，服务端再挡一道）
 * - 限流：同一用户 ≤1 次/3 秒（超限静默成功，不更新）
 * - 跳变校验：与上次位置换算速度 >120km/h → 丢弃本次（静默成功，不更新）
 */
export const reportLocation = asyncHandler(async (req, res) => {
  const uid = String(req.user._id);
  const { lng, lat, accuracy = 0 } = req.body;

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new AppError(ERR.VALIDATE, 'lng/lat 必须是数字', 400);
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new AppError(ERR.VALIDATE, '坐标超出合法范围', 400);
  }
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    throw new AppError(ERR.VALIDATE, 'accuracy 必须是正数', 400);
  }

  // 仅工作模式可上报（雷达 = 工作模式摄影师的实时位置）
  if (req.user.mode !== USER_MODE.WORK) {
    throw new AppError(ERR.FORBIDDEN, '仅工作模式可上报位置', 403);
  }
  // 隐身：静默成功不落库（前端应已停止上报，此处兜底）
  if (req.user.radarHidden) {
    ok(res, { accepted: false, reason: 'hidden' }, 'ok');
    return;
  }

  // 限流：≤1 次/3 秒
  const now = Date.now();
  const prevTs = lastReportAt.get(uid) || 0;
  if (now - prevTs < REPORT_MIN_INTERVAL_MS) {
    ok(res, { accepted: false, reason: 'rate_limited' }, 'ok');
    return;
  }

  // 跳变校验：与上次位置比速度（距离 km / 时间差 h）
  const prev = await RadarLocation.findOne({ userId: req.user._id }).lean();
  if (prev && prev.lng !== undefined) {
    const dtH = (now - new Date(prev.updatedAt).getTime()) / 3600000;
    const dKm = haversineKm({ lng: prev.lng, lat: prev.lat }, { lng, lat });
    if (dtH > 0 && dKm / dtH > MAX_SPEED_KMH) {
      lastReportAt.set(uid, now);
      ok(res, { accepted: false, reason: 'jump' }, 'ok');
      return;
    }
  }

  // upsert 覆盖：每人只存一条
  await RadarLocation.updateOne(
    { userId: req.user._id },
    { $set: { userId: req.user._id, lng, lat, accuracy } },
    { upsert: true }
  );
  lastReportAt.set(uid, now);
  ok(res, { accepted: true }, '位置已更新');
});

/**
 * GET /radar/nearby 拉取附近在线摄影师
 * 过滤：排除自己、仅工作模式、未隐身、最后上报 <60 秒、半径内；按距离升序
 * 返回 { total, list: [{ userId, nickname, avatar, lng, lat, accuracy, distanceKm, updatedAt }] }
 */
export const nearby = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const center = parseCenter(req);

  const query = {
    userId: { $ne: meId },
    updatedAt: { $gte: new Date(Date.now() - RADAR_TTL_MS) },
  };
  if (center) {
    const delta = radiusDelta(center.radius, center.lat);
    if (delta) {
      query.lng = { $gte: center.lng - delta.dLng, $lte: center.lng + delta.dLng };
      query.lat = { $gte: center.lat - delta.dLat, $lte: center.lat + delta.dLat };
    }
  }

  const locs = await RadarLocation.find(query).sort({ updatedAt: -1 }).limit(NEARBY_LIMIT).lean();
  if (!locs.length) {
    ok(res, { total: 0, list: [] });
    return;
  }

  // 批量校验用户：当前工作模式 + 未隐身（不信任旧状态，实时校验）
  const userIds = locs.map((l) => l.userId);
  const validUsers = await User.find({
    _id: { $in: userIds },
    mode: USER_MODE.WORK,
    radarHidden: { $ne: true },
  })
    .select('_id nickname avatar mode radarHidden')
    .lean();
  const validById = new Map(validUsers.map((u) => [String(u._id), u]));

  const list = [];
  for (const l of locs) {
    const u = validById.get(String(l.userId));
    if (!u) continue; // 已离线身份/非工作模式/隐身 → 跳过
    if (center && haversineKm(center, l) > radiusMaxKm(center.radius)) continue; // 圆形精确过滤
    list.push({
      userId: String(u._id),
      nickname: u.nickname,
      avatar: u.avatar || '',
      lng: l.lng,
      lat: l.lat,
      accuracy: l.accuracy || 0,
      distanceKm: center ? Math.round(haversineKm(center, l) * 100) / 100 : null,
      updatedAt: l.updatedAt,
    });
  }
  list.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  ok(res, { total: list.length, list });
});

/**
 * PUT /radar/visibility 雷达隐身开关
 * body: { hidden: boolean }；开启 = 查询过滤 + 上报拒绝（双保险），关闭 = 恢复
 */
export const setRadarHidden = asyncHandler(async (req, res) => {
  const hidden = Boolean(req.body.hidden);
  req.user.radarHidden = hidden;
  await req.user.save();
  ok(res, { radarHidden: hidden }, hidden ? '已隐身，雷达不再显示你的位置' : '已恢复，雷达可见');
});
