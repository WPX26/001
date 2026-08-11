/**
 * 邀请码路由（用户端，挂载于 /api/v1/invite，均需登录 requireAuth）
 * - POST /invite/redeem 兑换邀请码（一次性、可叠加、兑换即认证摄影师）
 * - GET  /invite/my-usage 我的兑换记录与剩余时长
 * 管理端生成/列表在 admin.routes.js（/admin/invite-codes/*，requireAdmin）
 */
import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as invite from '../controllers/invite.controller.js';

const router = Router();

router.use(requireAuth);

// 兑换邀请码（码格式：VIP + 8 位大写字母数字；大小写不敏感，服务端统一转大写）
router.post(
  '/redeem',
  [
    body('code')
      .isString()
      .notEmpty()
      .withMessage('邀请码不能为空')
      .matches(/^VIP[A-Z0-9]{8}$/i)
      .withMessage('邀请码格式不正确（VIP + 8 位大写字母数字）'),
    validate,
  ],
  invite.redeemInviteCode
);

// 我的兑换记录与剩余时长
router.get('/my-usage', invite.getMyUsage);

export default router;
