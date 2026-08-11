/**
 * 管理端控制器（半自动人工确认支付）
 * - POST /admin/auth/login 管理员登录（密码比对签发管理员 Token）
 * - GET  /admin/payments/pending 待确认付款列表（?status= 可选过滤，默认 pending_confirm）
 * - POST /admin/payments/:orderId/confirm 确认收款并激活会员（同时挂载于 /member/order/:orderId/confirm）
 * - GET  /admin/payments/history 订单历史（分页 + status 过滤）
 * - POST /admin/payments/qrcode 上传/更换收款码图片（覆盖式，免进容器操作）
 * - GET  /member/orders 管理端订单列表（复用 getPendingPayments，挂载于 member.routes）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import env, { UPLOAD_DIR } from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { MemberOrder, User } from '../models/index.js';
import { activateMembership } from '../services/membership.service.js';

/** 收款码图片对外相对路径（静态托管于 /uploads；容器内落盘即 /app/uploads/pay-qrcode.png） */
const PAY_QRCODE_RELATIVE = '/uploads/pay-qrcode.png';

/** 管理员 Token 有效期（秒，12 小时） */
const ADMIN_TOKEN_EXPIRES = 12 * 3600;

/** 订单状态枚举（与 member-order 模型一致，历史遗留旧状态统一归入 expired 不再作为查询项） */
const ORDER_STATUSES = ['pending_confirm', 'paid', 'expired'];

/** 常量时间字符串比较（防时序攻击；长度不一致直接不等） */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 手机号脱敏：138****1234 */
function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}

/** POST /admin/auth/login 管理员登录 */
export const login = asyncHandler(async (req, res) => {
  if (!env.ADMIN_PASSWORD) {
    throw new AppError(ERR.SERVICE_CONFIG, '管理端未配置密码，请联系管理员', 503);
  }
  const { password } = req.body;
  if (!safeEqual(password, env.ADMIN_PASSWORD)) {
    throw new AppError(ERR.AUTH, '管理密码错误', 401);
  }
  const token = jwt.sign({ type: 'admin' }, env.JWT_SECRET, { expiresIn: ADMIN_TOKEN_EXPIRES });
  ok(res, { token, expiresIn: ADMIN_TOKEN_EXPIRES }, '登录成功');
});

/**
 * GET 待确认付款列表（默认 status=pending_confirm；?status= 可选过滤）
 * 同时服务 /admin/payments/pending（admin.html）与 /member/orders（管理端列表）
 * createdAt 倒序，populate User 脱敏展示
 */
export const getPendingPayments = asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending_confirm';
  if (!ORDER_STATUSES.includes(status)) {
    throw new AppError(ERR.VALIDATE, 'status 参数不合法', 400);
  }

  const orders = await MemberOrder.find({ status })
    .sort({ createdAt: -1 })
    .populate('userId', 'phone nickname')
    .lean();
  const list = orders.map((o) => ({
    orderId: o.orderId,
    orderNo: o.orderNo,
    phone: maskPhone(o.userId?.phone),
    nickname: o.userId?.nickname || '',
    amount: o.amount,
    autoRenewed: !!o.autoRenewed,
    createdAt: o.createdAt,
    confirmedAt: o.confirmedAt || null,
  }));
  ok(res, { list, total: list.length });
});

/**
 * POST 确认收款（同时服务 /admin/payments/:orderId/confirm 与 /member/order/:orderId/confirm）
 * pending_confirm → paid（paidAt/confirmedAt）+ 激活会员（顺延/恢复）
 * 幂等：已 paid 的订单直接返回当前状态，不做二次激活
 */
export const confirmPayment = asyncHandler(async (req, res) => {
  const order = await MemberOrder.findOne({ orderId: req.params.orderId });
  if (!order) throw new AppError(ERR.NOT_FOUND, '订单不存在', 404);

  // 幂等：已确认过的直接返回（一致性兜底：会员未激活则补齐）
  if (order.status === 'paid') {
    const user = await User.findById(order.userId);
    if (user && user.memberStatus !== 'active') await activateMembership(user);
    if (user && !order.expireAt) {
      order.expireAt = user.memberExpireAt;
      await order.save();
    }
    return ok(
      res,
      {
        orderId: order.orderId,
        status: order.status,
        paidAt: order.paidAt,
        confirmedAt: order.confirmedAt,
      },
      '该订单已确认'
    );
  }

  if (order.status !== 'pending_confirm') {
    throw new AppError(ERR.DUPLICATE, `当前状态（${order.status}）不可确认`, 409);
  }

  const user = await User.findById(order.userId);
  if (!user) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);

  // 先激活会员再落订单状态：若中途失败订单仍停留 awaiting，管理员可重试确认
  await activateMembership(user);

  const now = new Date();
  order.status = 'paid';
  order.paidAt = now;
  order.confirmedAt = now;
  order.expireAt = user.memberExpireAt;
  await order.save();

  ok(
    res,
    {
      orderId: order.orderId,
      status: order.status,
      paidAt: order.paidAt,
      confirmedAt: order.confirmedAt,
      memberStatus: user.memberStatus,
      memberExpireAt: user.memberExpireAt,
    },
    '确认成功，会员已激活'
  );
});

/** GET /admin/payments/history 订单历史（分页，status 可选过滤） */
export const getPaymentHistory = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const { status } = req.query;
  const filter = {};
  if (status) {
    if (!ORDER_STATUSES.includes(status)) {
      throw new AppError(ERR.VALIDATE, 'status 参数不合法', 400);
    }
    filter.status = status;
  }

  const [orders, total] = await Promise.all([
    MemberOrder.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('userId', 'phone nickname')
      .lean(),
    MemberOrder.countDocuments(filter),
  ]);
  const list = orders.map((o) => ({
    orderId: o.orderId,
    orderNo: o.orderNo,
    phone: maskPhone(o.userId?.phone),
    nickname: o.userId?.nickname || '',
    amount: o.amount,
    status: o.status,
    autoRenewed: !!o.autoRenewed,
    confirmedAt: o.confirmedAt || null,
    paidAt: o.paidAt || null,
    createdAt: o.createdAt,
  }));
  ok(res, paginated(list, total, page, pageSize));
});

/**
 * POST /admin/payments/qrcode 上传/更换收款码图片（覆盖式，multipart 字段名 file）
 * 落盘固定路径 UPLOAD_DIR/pay-qrcode.png（容器内 /app/uploads/pay-qrcode.png），
 * 静态托管 URL 与 PAY_QRCODE_URL 默认值一致，上传即对用户端生效
 */
export const uploadPayQrcode = asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file || file.size === 0) {
    throw new AppError(ERR.VALIDATE, '缺少文件（字段名 file）', 400);
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, 'pay-qrcode.png'), file.buffer);

  const url = `${env.LOCAL_BASE_URL.replace(/\/+$/, '')}${PAY_QRCODE_RELATIVE}`;
  ok(
    res,
    {
      url,
      relativePath: PAY_QRCODE_RELATIVE,
      size: file.size,
      name: file.originalname,
    },
    '收款码图片已更新'
  );
});
