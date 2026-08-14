/**
 * 邀请码控制器（王总定稿：管理员生成、一次性、可叠加、兑换即认证摄影师）
 * 管理端（requireAdmin，路由挂载于 admin.routes.js）：
 * - POST /admin/invite-codes/generate 生成 count 个一次性邀请码（1-100）
 * - GET  /admin/invite-codes 邀请码列表（分页 + used/unused + usedBy 昵称）
 * 用户端（requireAuth，路由挂载于 invite.routes.js）：
 * - POST /invite/redeem 兑换邀请码（原子防并发重复兑换，时长顺延 30 天，兑换即认证）
 * - GET  /invite/my-usage 我的兑换记录与剩余时长
 */
import { ERR, MEMBER_PLAN } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pagination, paginated } from '../utils/pagination.js';
import { InviteCode, MemberOrder } from '../models/index.js';
import {
  extendMembershipByDays,
  genOrderId,
  genOrderNo,
  refreshMembership,
} from '../services/membership.service.js';

const DAY_MS = 24 * 3600 * 1000;

/** 邀请码兑换落账订单的套餐标识（amount=0，paymentMethod=invite，历史可查） */
const INVITE_PLAN_ID = 'invite_redeem';
const INVITE_PLAN_NAME = '邀请码兑换';

/** 邀请码字符集：大写字母 + 数字，去掉易混淆的 O/0/I/1 */
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成单个邀请码：VIP + 8 位字符（约 1.1e12 种组合，撞码概率可忽略，仍保留唯一索引兜底） */
function genCode() {
  let s = '';
  for (let i = 0; i < 8; i += 1) {
    s += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return `VIP${s}`;
}

/** 生成普通邀请码：8 位纯字符（与原型「我的邀请码」格式一致，输入框 maxlength=8） */
function genNormalCode() {
  let s = '';
  for (let i = 0; i < 8; i += 1) {
    s += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return s;
}

/**
 * POST /invite/my-code 用户自助生成/获取自己的普通邀请码（每用户唯一）
 * - 已有码：直接返回（含使用状态）
 * - 无码：生成 kind=normal、ownerId=本人，兑换时双方各得 rewardDays 天
 */
export const generateMyCode = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const existing = await InviteCode.findOne({ kind: 'normal', ownerId: userId }).lean();
  if (existing) {
    return ok(res, {
      code: existing.code,
      used: Boolean(existing.usedBy),
      usedAt: existing.usedAt || null,
      rewardDays: existing.rewardDays,
    }, '已获取邀请码');
  }

  // 撞库重试（唯一索引兜底）
  let code = null;
  for (let attempt = 0; attempt < 10 && !code; attempt += 1) {
    const candidate = genNormalCode();
    try {
      const doc = await InviteCode.create({
        code: candidate,
        kind: 'normal',
        createdBy: String(userId),
        ownerId: userId,
        rewardDays: MEMBER_PLAN.days,
      });
      code = doc.code;
    } catch (e) {
      if (e && e.code !== 11000) throw e; // 仅唯一索引冲突重试
    }
  }
  if (!code) throw new AppError(ERR.SERVER, '邀请码生成失败，请重试', 500);

  ok(res, { code, used: false, usedAt: null, rewardDays: MEMBER_PLAN.days }, '邀请码已生成');
});

/**
 * POST /admin/invite-codes/generate 生成 count 个一次性邀请码
 * 唯一性：批次内 Set 去重 + 入库唯一索引冲突重试（撞库中已有码时换码）
 */
export const generateInviteCodes = asyncHandler(async (req, res) => {
  const count = parseInt(req.body.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new AppError(ERR.VALIDATE, 'count 需为 1-100 的整数', 400);
  }

  const codes = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    let inserted = null;
    for (let attempt = 0; attempt < 10 && !inserted; attempt += 1) {
      const code = genCode();
      if (seen.has(code)) continue;
      try {
        await InviteCode.create({ code, createdBy: 'admin' });
        seen.add(code);
        inserted = code;
      } catch (err) {
        // 唯一索引冲突（极小概率撞库中已有码）→ 换码重试
        if (err && err.code === 11000) continue;
        throw err;
      }
    }
    if (!inserted) throw new AppError(ERR.SERVER, '邀请码生成失败，请重试', 500);
    codes.push(inserted);
  }

  ok(res, { codes, count }, `成功生成 ${count} 个邀请码`);
});

/** GET /admin/invite-codes 邀请码列表（分页，createdAt 倒序，usedBy 昵称） */
export const listInviteCodes = asyncHandler(async (req, res) => {
  const { page, pageSize, skip } = pagination(req);
  const [docs, total] = await Promise.all([
    InviteCode.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('usedBy', 'nickname')
      .lean(),
    InviteCode.countDocuments({}),
  ]);
  const list = docs.map((c) => ({
    code: c.code,
    status: c.usedAt ? 'used' : 'unused',
    usedByNickname: c.usedBy?.nickname || '',
    usedAt: c.usedAt || null,
    rewardDays: c.rewardDays,
    createdAt: c.createdAt,
  }));
  ok(res, paginated(list, total, page, pageSize));
});

/**
 * POST /invite/redeem 兑换邀请码
 * 1. 原子抢占：findOneAndUpdate({ code, usedBy: null }) 置 used —— 并发双兑换仅一人成功
 * 2. 失败分类：码不存在 → 404/1004；已使用 → 409/1005
 * 3. 原子顺延会员时长（active 未过期在到期点上 +rewardDays，否则从当前起算）+ 兑换即认证摄影师
 * 4. 落 amount=0 订单留痕（不产生支付、不走 pending 状态机）
 */
export const redeemInviteCode = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const code = String(req.body.code || '').trim().toUpperCase();

  // 预检查（原子抢占在 claim 时兜底并发；这里给出更明确的业务错误）
  const existing = await InviteCode.findOne({ code }).lean();
  if (!existing) throw new AppError(ERR.NOT_FOUND, '邀请码不存在', 404);
  if (existing.usedBy) throw new AppError(ERR.DUPLICATE, '邀请码已被使用', 409);
  if (existing.kind === 'normal' && existing.ownerId && String(existing.ownerId) === String(userId)) {
    throw new AppError(ERR.VALIDATE, '不能使用自己的邀请码', 400);
  }
  if (existing.kind === 'normal') {
    const already = await InviteCode.findOne({ kind: 'normal', usedBy: userId }).lean();
    if (already) throw new AppError(ERR.DUPLICATE, '每人限兑换一个普通邀请码', 409);
  }

  const claimed = await InviteCode.findOneAndUpdate(
    { code, usedBy: null },
    { $set: { usedBy: userId, usedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!claimed) {
    // 并发兜底：预检查通过但抢占失败（他人已抢先）
    throw new AppError(ERR.DUPLICATE, '邀请码已被使用', 409);
  }

  const user = await extendMembershipByDays(userId, claimed.rewardDays || MEMBER_PLAN.days);

  // 普通邀请码：邀请者（码归属者）同得 rewardDays 天（双方各得 1 个月）
  if (claimed.kind === 'normal' && claimed.ownerId && String(claimed.ownerId) !== String(userId)) {
    await extendMembershipByDays(claimed.ownerId, claimed.rewardDays || MEMBER_PLAN.days);
  }

  // 落账留痕（先激活会员再落单：若落单失败会员仍生效，管理员可事后查码补录，不阻断兑换）
  const now = new Date();
  await MemberOrder.create({
    orderId: genOrderId(),
    orderNo: genOrderNo(),
    userId,
    planId: INVITE_PLAN_ID,
    planName: INVITE_PLAN_NAME,
    amount: 0,
    paymentMethod: 'invite',
    status: 'paid',
    inviteCode: code,
    paidAt: now,
    confirmedAt: now,
    expireAt: user.memberExpireAt,
  });

  const remainingMs = user.memberExpireAt.getTime() - Date.now();
  ok(
    res,
    {
      memberExpireAt: user.memberExpireAt,
      remainingDays: Math.max(0, Math.ceil(remainingMs / DAY_MS)),
      isPhotographer: user.isPhotographer,
    },
    '兑换成功，会员时长已顺延'
  );
});

/** GET /invite/my-usage 我的兑换记录与剩余时长（读前懒检查，剩余时长准确） */
export const getMyUsage = asyncHandler(async (req, res) => {
  const user = await refreshMembership(req.user);
  const [records, total] = await Promise.all([
    MemberOrder.find({ userId: user._id, planId: INVITE_PLAN_ID })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    MemberOrder.countDocuments({ userId: user._id, planId: INVITE_PLAN_ID }),
  ]);
  const remainingMs = user.memberExpireAt ? user.memberExpireAt.getTime() - Date.now() : 0;
  ok(res, {
    memberStatus: user.memberStatus,
    memberExpireAt: user.memberExpireAt || null,
    remainingDays:
      user.memberStatus === 'active' ? Math.max(0, Math.ceil(remainingMs / DAY_MS)) : 0,
    isPhotographer: user.isPhotographer,
    totalRedeemed: total,
    records: records.map((o) => ({
      orderId: o.orderId,
      code: o.inviteCode || '',
      amount: o.amount,
      expireAt: o.expireAt || null,
      createdAt: o.createdAt,
    })),
  });
});
