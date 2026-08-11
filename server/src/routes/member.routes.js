/**
 * 会员路由（挂载于 /api/v1/member）
 * 用户端：plans / order / order 详情 / status / cancel-renewal（requireAuth）
 * 管理端：orders 列表 / order 确认（requireAdmin，复用 admin.controller）
 * 支付模式：半自动人工确认——下单 → 用户扫码付款备注订单号 → 王总在管理端确认 → 会员生效
 */
import { Router } from 'express';
import { body, param } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as member from '../controllers/member.controller.js';
import * as admin from '../controllers/admin.controller.js';

const router = Router();

// 业务订单号（MEMO + 时间戳 + 随机数），非 MongoId
const orderIdParam = () => param('orderId').isString().notEmpty().withMessage('订单号格式不正确');

// ============ 管理端（需管理员 Token，按路由挂载，先于用户端 requireAuth 注册） ============
// 注意：不能放子路由 requireAdmin 拦截全部请求，否则用户端接口也会被管理员鉴权挡掉
// 订单列表（默认 pending_confirm，?status= 可过滤）——管理端待确认列表
router.get('/orders', requireAdmin, admin.getPendingPayments);
// 确认收款并激活会员（幂等）
router.post('/order/:orderId/confirm', requireAdmin, [orderIdParam(), validate], admin.confirmPayment);

// ============ 用户端（需登录） ============
router.use(requireAuth);

// 会员套餐（高级会员 ¥6/月）
router.get('/plans', member.getPlans);

// 创建订单（幂等；planId 仅支持 plan_pro_monthly）
router.post(
  '/order',
  [body('planId').isString().notEmpty().withMessage('planId 不能为空'), validate],
  member.createOrder
);

// 订单详情（本人可查）
router.get('/order/:orderId', [orderIdParam(), validate], member.getOrder);

// 实时会员状态（懒检查：自动续费模拟 / 到期收回）
router.get('/status', member.getMemberStatus);

// 关闭自动续费（幂等）
router.post('/cancel-renewal', member.cancelRenewal);

export default router;
