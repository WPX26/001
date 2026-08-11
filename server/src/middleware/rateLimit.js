/**
 * 轻量内存限流（单机滑动窗口计数，无外部依赖）
 * - 验证码错误锁定：每手机号验证码错误 ≥5 次 → 锁定 10 分钟（429/1006）
 * - send-code IP 限频：每 IP 10 次/分钟（429/1006）
 *
 * 说明：
 * - 防暴力枚举验证码的主防线是"每手机号错误锁定"（与 IP 无关，代理环境也生效）；
 *   IP 限频是辅助防线。多实例/集群部署时内存计数不共享，需升级为 Redis 等共享存储（P2）。
 * - IP 取自 req.ip（未开启 trust proxy 时经 nginx 反代会收敛为代理 IP，此为已知折中，
 *   主防线不受影响）。
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

/** 验证码错误次数阈值：达到即锁定 */
const MAX_VERIFY_FAILURES = 5;
/** 锁定时长：10 分钟 */
const VERIFY_LOCK_MS = 10 * 60 * 1000;
/** send-code 单 IP 每分钟上限 */
const SEND_CODE_PER_IP = 10;
/** send-code 滑动窗口：60 秒 */
const SEND_CODE_WINDOW_MS = 60 * 1000;
/** 条目膨胀保护阈值（超过后清理过期窗口） */
const MAP_SWEEP_THRESHOLD = 10000;

/** 每手机号验证码错误状态：phone → { failures, lockedUntil } */
const phoneVerifyLocks = new Map();
/** send-code 每 IP 时间戳窗口：ip → number[] */
const ipSendWindows = new Map();

/**
 * 记录一次验证码错误；累计达到阈值即触发 10 分钟锁定（锁定期间不继续累计，解锁后重新计数）
 * @returns {{ failures: number, lockedUntil: number }}
 */
export function recordVerifyFailure(phone) {
  const now = Date.now();
  const entry = phoneVerifyLocks.get(phone) || { failures: 0, lockedUntil: 0 };
  // 锁定过期后从 0 重新计数；锁定中不再累计（锁定状态由 lockedUntil 表达）
  if (entry.lockedUntil <= now) entry.failures += 1;
  if (entry.failures >= MAX_VERIFY_FAILURES) {
    entry.lockedUntil = now + VERIFY_LOCK_MS;
    entry.failures = 0;
  }
  phoneVerifyLocks.set(phone, entry);
  return entry;
}

/** 验证成功：清除该手机号的错误计数与锁定状态 */
export function clearVerifyFailures(phone) {
  phoneVerifyLocks.delete(phone);
}

/**
 * 查询手机号是否处于锁定：锁定中返回锁信息，否则返回 null。
 * 注意：仅清除"已过期锁定"，绝不清除累计中的失败计数（lockedUntil=0 的条目），
 * 否则守卫会抹掉前几次失败记录，错误次数永远无法累计到阈值。
 */
export function getVerifyLock(phone) {
  const entry = phoneVerifyLocks.get(phone);
  if (!entry) return null;
  if (entry.lockedUntil > Date.now()) return entry;
  if (entry.lockedUntil !== 0) phoneVerifyLocks.delete(phone); // 锁定已过期，清除残留
  return null;
}

/**
 * 验证码锁定守卫中间件（登录/注册/发送前置）：锁定期间一律 429/1006
 * 手机号从 body 读取（校验器已先行验证格式）
 */
export function verifyLockGuard(req, res, next) {
  const lock = getVerifyLock(String(req.body.phone || ''));
  if (lock) {
    return next(new AppError(ERR.RATE_LIMIT, '验证码错误次数过多，请 10 分钟后再试', 429));
  }
  next();
}

/** send-code 单 IP 限频中间件：每分钟最多 SEND_CODE_PER_IP 次，超出 429/1006 */
export function sendCodeIpLimit(req, res, next) {
  // 条目过多时先清理过期窗口，防内存无限增长
  if (ipSendWindows.size >= MAP_SWEEP_THRESHOLD) sweepIpWindows();

  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  let hits = ipSendWindows.get(ip);
  if (!hits) {
    hits = [];
    ipSendWindows.set(ip, hits);
  }
  // 滑动窗口：剔除窗口外的旧记录
  while (hits.length && now - hits[0] >= SEND_CODE_WINDOW_MS) hits.shift();
  if (hits.length >= SEND_CODE_PER_IP) {
    return next(new AppError(ERR.RATE_LIMIT, '发送过于频繁，请稍后再试', 429));
  }
  hits.push(now);
  next();
}

/** 清理所有已过期（空窗口）的 IP 记录 */
function sweepIpWindows() {
  const now = Date.now();
  for (const [ip, hits] of ipSendWindows) {
    while (hits.length && now - hits[0] >= SEND_CODE_WINDOW_MS) hits.shift();
    if (!hits.length) ipSendWindows.delete(ip);
  }
}
