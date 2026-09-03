/**
 * 会员控制器（用户端）
 * - GET  /member/plans 套餐（仅高级会员 ¥6/月，plan_pro_monthly）
 * - POST /member/order 创建订单（半自动人工确认：下单即 pending_confirm，返回收款码 + 备注订单号）
 * - GET  /member/order/:orderId 订单详情（本人可查）
 * - GET  /member/status 实时会员状态（refreshMembership 懒检查：自动续费模拟 / 到期收回）
 * - POST /member/cancel-renewal 关闭自动续费（幂等）
 * 管理端确认/列表（/member/order/:orderId/confirm、/member/orders）在 routes 中复用 admin.controller
 */
import env from '../config/env.js';
import { ERR, MEMBER_PLAN, MEMBER_PENDING_EXPIRE_MS, BOOST_PLANS } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { MemberOrder, Coord, ExploreBoost } from '../models/index.js';
import { genOrderId, genOrderNo, refreshMembership } from '../services/membership.service.js';

const DAY_MS = 24 * 3600 * 1000;

/** 惰性过期：当前用户超 48h 未确认的 pending_confirm 订单置为 expired（下单前调用） */
async function expireStaleOrders(userId) {
  await MemberOrder.updateMany(
    {
      userId,
      status: 'pending_confirm',
      createdAt: { $lt: new Date(Date.now() - MEMBER_PENDING_EXPIRE_MS) },
    },
    { $set: { status: 'expired' } }
  );
}

/** 收款码地址；.env 显式置空视为未配置 → 503/1007（避免对用户展示失效图片） */
function payeeQrCodeUrl() {
  if (!env.PAY_QRCODE_URL || !env.PAY_QRCODE_URL.trim()) {
    throw new AppError(ERR.SERVICE_CONFIG, '收款码未配置，请联系管理员', 503);
  }
  return env.PAY_QRCODE_URL.trim();
}

/** 创建订单响应体（新建与幂等复用同一形状） */
function toCreateResponse(order) {
  return {
    orderId: order.orderId,
    orderNo: order.orderNo,
    amount: order.amount,
    status: order.status,
    payeeQrCodeUrl: payeeQrCodeUrl(),
    remark: `付款时请备注订单号：${order.orderNo}`,
  };
}

/** GET /member/plans 会员套餐（单套餐：高级会员 ¥6/月） */
export const getPlans = asyncHandler(async (req, res) => {
  ok(res, {
    planId: MEMBER_PLAN.planId,
    name: MEMBER_PLAN.planName,
    priceYuan: MEMBER_PLAN.amount / 100,
    price: MEMBER_PLAN.amount, // 分
    period: MEMBER_PLAN.period,
    benefits: MEMBER_PLAN.benefits,
  });
});

/**
 * POST /member/order 创建月卡订单
 * - planId 校验（仅 plan_pro_monthly）、金额服务端定、状态 pending_confirm
 * - 幂等：已有 pending_confirm 订单直接返回
 */
export const createOrder = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { planId } = req.body;

  if (planId !== MEMBER_PLAN.planId) {
    throw new AppError(ERR.VALIDATE, '不支持的套餐，请选择高级会员月卡', 400);
  }

  // 惰性过期：超 48h 未确认的旧单置 expired
  await expireStaleOrders(userId);

  const existing = await MemberOrder.findOne({
    userId,
    status: 'pending_confirm',
  }).sort({ createdAt: -1 });
  if (existing) {
    return ok(res, toCreateResponse(existing), '已有待确认订单，请勿重复下单');
  }

  // orderId/orderNo 唯一索引冲突（并发撞随机数）时重试
  let order = null;
  for (let i = 0; i < 3; i++) {
    try {
      order = await MemberOrder.create({
        orderId: genOrderId(),
        orderNo: genOrderNo(),
        userId,
        planId: MEMBER_PLAN.planId,
        planName: MEMBER_PLAN.planName,
        amount: MEMBER_PLAN.amount,
        period: MEMBER_PLAN.period,
        paymentMethod: 'wechat',
        status: 'pending_confirm',
      });
      break;
    } catch (err) {
      if (err && err.code === 11000) continue; // 撞号，换号重试
      throw err;
    }
  }
  if (!order) {
    throw new AppError(ERR.DUPLICATE, '订单创建失败，请重试', 409);
  }

  ok(res, toCreateResponse(order), '订单创建成功，请扫码付款并备注订单号');
});

/** GET /member/order/:orderId 订单详情（归属校验：仅本人可查） */
export const getOrder = asyncHandler(async (req, res) => {
  const order = await MemberOrder.findOne({ orderId: req.params.orderId }).lean();
  if (!order) throw new AppError(ERR.NOT_FOUND, '订单不存在', 404);
  if (String(order.userId) !== String(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '无权查看该订单', 403);
  }

  ok(res, {
    orderId: order.orderId,
    orderNo: order.orderNo,
    planId: order.planId,
    planName: order.planName,
    amount: order.amount,
    period: order.period,
    paymentMethod: order.paymentMethod,
    status: order.status,
    autoRenewed: !!order.autoRenewed,
    confirmedAt: order.confirmedAt || null,
    paidAt: order.paidAt || null,
    expireAt: order.expireAt || null,
    coordKey: order.coordKey || '',
    createdAt: order.createdAt,
  });
});

/**
 * POST /explore/boost/order 购买坐标置顶（王总 2026-08-31 定稿：周卡7元/7天、月卡60元/30天，持卡期间不可叠加再买）
 * - coordKey 校验（坐标须存在）；活跃席位拒绝重复购买（409）
 * - 与会员下单共用全局待确认幂等（一人一笔 pending）
 */
export const createBoostOrder = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const coordKey = String(req.body.coordKey || '').trim();
  if (!coordKey) throw new AppError(ERR.VALIDATE, '缺少 coordKey', 400);
  const tier = req.body.tier === 'month' ? 'month' : 'week';
  const boostPlan = BOOST_PLANS[tier];

  const coord = await Coord.findOne({ title: coordKey, deletedAt: null });
  if (!coord) throw new AppError(ERR.NOT_FOUND, '坐标不存在', 404);

  // 已有活跃席位：同档续买被拒（持卡期间不可叠加）；周卡期内可升级月卡
  // （tier 升档 + until 顺延在管理端确认时发生——王总 2026-09-02 定稿）
  const activeBoost = await ExploreBoost.findOne({
    coordKey,
    authorId: userId,
    until: { $gt: new Date() },
  })
    .select('tier')
    .lean();
  if (activeBoost && !(activeBoost.tier === 'week' && tier === 'month')) {
    throw new AppError(ERR.DUPLICATE, '该坐标已置顶中，无需重复购买', 409);
  }

  // 惰性过期：超 48h 未确认的旧单置 expired
  await expireStaleOrders(userId);

  const existing = await MemberOrder.findOne({ userId, status: 'pending_confirm' }).sort({ createdAt: -1 });
  if (existing) {
    return ok(res, { ...toCreateResponse(existing), coordKey: existing.coordKey || '' }, '已有待确认订单，请勿重复下单');
  }

  let order = null;
  for (let i = 0; i < 3; i++) {
    try {
      order = await MemberOrder.create({
        orderId: genOrderId(),
        orderNo: genOrderNo(),
        userId,
        planId: boostPlan.planId,
        planName: boostPlan.planName,
        amount: boostPlan.amount,
        period: boostPlan.period,
        coordKey,
        paymentMethod: 'wechat',
        status: 'pending_confirm',
      });
      break;
    } catch (err) {
      if (err && err.code === 11000) continue;
      throw err;
    }
  }
  if (!order) throw new AppError(ERR.DUPLICATE, '订单创建失败，请重试', 409);

  ok(res, { ...toCreateResponse(order), coordKey }, '置顶订单创建成功，请扫码付款并备注订单号');
});

/** GET /member/status 实时会员状态（读前懒检查：自动续费模拟顺延 / 到期收回认证） */
export const getMemberStatus = asyncHandler(async (req, res) => {
  const user = await refreshMembership(req.user);
  const remainingMs = user.memberExpireAt ? user.memberExpireAt.getTime() - Date.now() : 0;
  ok(res, {
    memberStatus: user.memberStatus,
    memberExpireAt: user.memberExpireAt || null,
    remainingDays:
      user.memberStatus === 'active' ? Math.max(0, Math.ceil(remainingMs / DAY_MS)) : 0,
    autoRenew: user.autoRenew,
    isPhotographer: user.isPhotographer,
  });
});

/** POST /member/cancel-renewal 关闭自动续费（幂等：重复调用仍返回 false） */
export const cancelRenewal = asyncHandler(async (req, res) => {
  req.user.autoRenew = false;
  await req.user.save();
  ok(res, { autoRenew: false }, '已关闭自动续费，会员到期后将自动失效');
});
