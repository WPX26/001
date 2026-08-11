/**
 * 管理端路由（挂载于 /api/v1/admin）
 * 除登录外均需管理员 Token（requireAdmin）
 */
import { Router } from 'express';
import { body, param } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import * as admin from '../controllers/admin.controller.js';

const router = Router();

// 管理员登录（无需 Token）
router.post(
  '/auth/login',
  [body('password').isString().notEmpty().withMessage('密码不能为空'), validate],
  admin.login
);

// 以下接口均需管理员 Token
router.use(requireAdmin);

// 待确认付款列表
router.get('/payments/pending', admin.getPendingPayments);

// 确认收款并激活会员（幂等）
router.post(
  '/payments/:orderId/confirm',
  [param('orderId').isString().notEmpty().withMessage('订单号格式不正确'), validate],
  admin.confirmPayment
);

// 订单历史（分页 + status 过滤）
router.get('/payments/history', admin.getPaymentHistory);

export default router;
