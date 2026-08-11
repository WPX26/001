/**
 * 会员服务：激活 / 懒检查（自动续费模拟或到期收回）/ 每日扫描
 *
 * 产品规则（王总定稿）：
 * - 订阅成功 → 自动认证摄影师（isPhotographer=true）
 * - 到期时 autoRenew=true → 模拟顺延 30 天并落 mock 订单（会员不中断）
 * - 到期时 autoRenew=false → 置 expired、收回认证、mode 回落 life
 * - 严禁触碰 Photo/Coord 数据：探索池隐藏靠 isPhotographer/mode 过滤（已在现有代码实现）
 */
import { MEMBER_PLAN, MEMBER_PENDING_EXPIRE_MS } from '../config/constants.js';
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
 */
function nextExpireAt(user) {
  const now = Date.now();
  const base =
    user.memberStatus === 'active' &&
    user.memberExpireAt &&
    user.memberExpireAt.getTime() > now
      ? user.memberExpireAt
      : new Date();
  return new Date(base.getTime() + MEMBER_PLAN.days * DAY_MS);
}

/**
 * 激活/续期会员（管理端确认支付后调用，也用于自动续费模拟）
 * - 置 memberStatus=active、isPhotographer=true、autoRenew=true
 * - memberExpireAt 顺延 30 天
 * @param {import('mongoose').Document} user
 * @param {object} [order] 关联订单（预留；金额/天数由服务端 MEMBER_PLAN 决定，不信任入参）
 */
export async function activateMembership(user, order = null) {
  user.memberStatus = 'active';
  user.isPhotographer = true;
  user.autoRenew = true;
  user.memberExpireAt = nextExpireAt(user);
  await user.save();
  return user;
}

/**
 * 落 mock 订单：自动续费模拟顺延时调用（status=paid + autoRenewed=true，无真实付款）
 */
async function createMockOrder(user, expireAt) {
  for (let i = 0; i < 3; i++) {
    try {
      await MemberOrder.create({
        orderId: genOrderId(),
        orderNo: genOrderNo(),
        userId: user._id,
        planId: MEMBER_PLAN.planId,
        planName: MEMBER_PLAN.planName,
        amount: MEMBER_PLAN.amount,
        period: MEMBER_PLAN.period,
        paymentMethod: 'wechat',
        status: 'paid',
        autoRenewed: true,
        paidAt: new Date(),
        confirmedAt: new Date(),
        expireAt,
      });
      return;
    } catch (err) {
      if (err && err.code === 11000) continue; // orderId/orderNo 冲突，换号重试
      throw err;
    }
  }
}

/**
 * 懒检查（GET /member/status 读前调用，幂等）：仅对 active 且已过期的用户生效
 * - autoRenew=true：模拟顺延 30 天（从旧到期点起算，兜底不早于当前时间）并落 mock 订单
 * - autoRenew=false：置 expired、收回摄影师认证、mode 回落 life
 * 返回最新用户文档（可能已就地更新并保存）
 * @param {import('mongoose').Document} user req.user（requireAuth 挂载的文档）
 */
export async function refreshMembership(user) {
  const isDue =
    user.memberStatus === 'active' &&
    user.memberExpireAt &&
    user.memberExpireAt.getTime() <= Date.now();
  if (!isDue) return user;

  if (user.autoRenew) {
    // 从旧的到期点顺延（晚于当前时间时兜底取当前，防止长期离线后仍过期）
    const base = Math.max(user.memberExpireAt.getTime(), Date.now());
    user.memberExpireAt = new Date(base + MEMBER_PLAN.days * DAY_MS);
    await user.save();
    await createMockOrder(user, user.memberExpireAt);
  } else {
    user.memberStatus = 'expired';
    user.isPhotographer = false;
    user.mode = 'life';
    await user.save();
  }
  return user;
}

/**
 * 每日定时扫描（幂等，由 server.js 定时调用）：
 * 1. 对 active 且已到期的会员逐个走 refreshMembership（自动续费模拟 / 收回认证）
 * 2. 清理超 48h 未确认的 pending_confirm 订单 → expired（含历史遗留旧状态单）
 * @returns {{ renewed: number, revoked: number, staleOrders: number }}
 */
export async function expireMembership() {
  // 1. 过期会员处理（处理完自动续费者到期点已顺延、收回认证者状态已置 expired，重跑不再命中）
  const due = await User.find({
    memberStatus: 'active',
    memberExpireAt: { $ne: null, $lte: new Date() },
  });
  let renewed = 0;
  let revoked = 0;
  for (const user of due) {
    const before = user.autoRenew;
    await refreshMembership(user);
    if (before) renewed += 1;
    else revoked += 1;
  }

  // 2. 超时未确认订单过期（历史遗留的 pending/awaiting_confirmation 旧状态单一并归入 expired）
  const stale = await MemberOrder.updateMany(
    {
      status: { $in: ['pending_confirm', 'pending', 'awaiting_confirmation'] },
      createdAt: { $lt: new Date(Date.now() - MEMBER_PENDING_EXPIRE_MS) },
    },
    { $set: { status: 'expired' } }
  );

  return { renewed, revoked, staleOrders: stale.modifiedCount || 0 };
}
