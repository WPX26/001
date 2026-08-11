/**
 * 会员服务：激活 / 懒检查（到期收回）/ 每日扫描
 *
 * 产品规则（王总定稿，方案 B——关闭自动续费）：
 * - 订阅成功 → 自动认证摄影师（isPhotographer=true），自动续费保持关闭
 * - 会员到期 → 一律置 expired、收回认证、mode 回落 life（不自动顺延、不落 mock 续费订单）
 * - 用户想继续会员 → 重新走下单流程（新订单 → 待确认 → 管理端确认开通）
 * - autoRenew 字段保留（默认 false，留档/状态展示，不再影响到期行为）
 * - 严禁触碰 Photo/Coord 数据：探索池隐藏靠 isPhotographer/mode 过滤（已在现有代码实现）
 */
import { MEMBER_PLAN, MEMBER_PENDING_EXPIRE_MS } from '../config/constants.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { MemberOrder, User } from '../models/index.js';

const DAY_MS = 24 * 3600 * 1000;

/** 生成业务订单号：MEMO + yyyyMMddHHmmss + 4 位随机（URL/接口用唯一标识） */
export function genOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `MEMO${ts}${rand}`;
}

/** 生成付款备注订单号：M + 6 位数字（短小易抄，唯一索引 + 冲突重试保证唯一） */
export function genOrderNo() {
  return `M${String(Math.floor(100000 + Math.random() * 900000))}`;
}

/**
 * 计算续期后的到期时间：已有未过期会员期则顺延（防重复购买丢天数），否则从当前时间新开一期
 * @param {import('mongoose').Document} user
 * @param {number} [days] 本次续期天数（默认 MEMBER_PLAN.days=30；邀请码兑换可传 rewardDays）
 */
function nextExpireAt(user, days = MEMBER_PLAN.days) {
  const now = Date.now();
  const base =
    user.memberStatus === 'active' &&
    user.memberExpireAt &&
    user.memberExpireAt.getTime() > now
      ? user.memberExpireAt
      : new Date();
  return new Date(base.getTime() + days * DAY_MS);
}

/**
 * 激活/续期会员（管理端确认支付后调用）
 * - 置 memberStatus=active、isPhotographer=true、autoRenew=false（方案 B：自动续费保持关闭）
 * - memberExpireAt 顺延 days 天（续费顺延：已有未过期会员期在其到期点上追加，否则从当前起算）
 * @param {import('mongoose').Document} user
 * @param {object} [order] 关联订单（预留；金额/天数由服务端 MEMBER_PLAN 决定，不信任入参）
 * @param {number} [days] 本次续期天数（默认 MEMBER_PLAN.days）
 */
export async function activateMembership(user, order = null, days = MEMBER_PLAN.days) {
  user.memberStatus = 'active';
  user.isPhotographer = true;
  user.autoRenew = false;
  user.memberExpireAt = nextExpireAt(user, days);
  await user.save();
  return user;
}

/**
 * 原子续期（邀请码兑换专用，单条聚合管道更新，无读-改-写竞态）：
 * - memberExpireAt = max(当前时间, 原 memberExpireAt) + days 天（null 按当前时间起算）
 *   → 现有 active 未过期会员在到期点上顺延（多码连续兑换不丢天数）；
 *     非会员 / 已过期会员从当前时间新开一期
 * - 置 memberStatus=active、isPhotographer=true（兑换即认证）、autoRenew=false
 * - 同一用户并发兑换多个码时，每次更新都在服务端原子完成，时长正确累加
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {number} days 本次续期天数
 * @returns {Promise<import('mongoose').Document>} 更新后的用户文档
 */
export async function extendMembershipByDays(userId, days) {
  const updated = await User.findOneAndUpdate(
    { _id: userId },
    [
      {
        $set: {
          memberStatus: 'active',
          isPhotographer: true,
          autoRenew: false,
          memberExpireAt: {
            $dateAdd: {
              startDate: { $max: ['$$NOW', { $ifNull: ['$memberExpireAt', '$$NOW'] }] },
              unit: 'day',
              amount: days,
            },
          },
        },
      },
    ],
    { returnDocument: 'after' }
  );
  if (!updated) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);
  return updated;
}

/**
 * 懒检查（GET /member/status 读前调用，幂等）：仅对 active 且已过期的用户生效
 * 到期一律置 expired、收回摄影师认证、mode 回落 life（不自动顺延、不落 mock 订单；
 * 用户想继续会员 → 重新走下单流程）
 * 返回最新用户文档（可能已就地更新并保存）
 * @param {import('mongoose').Document} user req.user（requireAuth 挂载的文档）
 */
export async function refreshMembership(user) {
  const isDue =
    user.memberStatus === 'active' &&
    user.memberExpireAt &&
    user.memberExpireAt.getTime() <= Date.now();
  if (!isDue) return user;

  user.memberStatus = 'expired';
  user.isPhotographer = false;
  user.mode = 'life';
  await user.save();
  return user;
}

/**
 * 每日定时扫描（幂等，由 server.js 定时调用）：
 * 1. 对 active 且已到期的会员逐个走 refreshMembership（到期收回认证，不触碰作品数据）
 * 2. 清理超 48h 未确认的 pending_confirm 订单 → expired（含历史遗留旧状态单）
 * @returns {{ revoked: number, staleOrders: number }}
 */
export async function expireMembership() {
  // 1. 到期会员处理（处理后状态已置 expired，重跑不再命中 → 幂等）
  const due = await User.find({
    memberStatus: 'active',
    memberExpireAt: { $ne: null, $lte: new Date() },
  });
  let revoked = 0;
  for (const user of due) {
    await refreshMembership(user);
    revoked += 1;
  }

  // 2. 超时未确认订单过期（历史遗留的 pending/awaiting_confirmation 旧状态单一并归入 expired）
  const stale = await MemberOrder.updateMany(
    {
      status: { $in: ['pending_confirm', 'pending', 'awaiting_confirmation'] },
      createdAt: { $lt: new Date(Date.now() - MEMBER_PENDING_EXPIRE_MS) },
    },
    { $set: { status: 'expired' } }
  );

  return { revoked, staleOrders: stale.modifiedCount || 0 };
}
