/**
 * 认证路由（api.md 第 1 章）
 */
import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyLockGuard, sendCodeIpLimit } from '../middleware/rateLimit.js';
import * as auth from '../controllers/auth.controller.js';

const router = Router();

const phoneRule = body('phone')
  .matches(/^1\d{10}$/)
  .withMessage('手机号格式不正确（11 位，1 开头）');
const codeRule = body('code')
  .matches(/^\d{6}$/)
  .withMessage('验证码格式不正确（6 位数字）');

// 1.1 发送短信验证码（IP 限频 10 次/分钟；手机号处于验证码锁定期间禁止发送）
router.post(
  '/send-code',
  [
    phoneRule,
    body('scene').isIn(['login', 'register']).withMessage('scene 必须是 login 或 register'),
    validate,
    sendCodeIpLimit,
    verifyLockGuard,
  ],
  auth.sendCode
);

// 1.2 手机号登录（验证码登录 / 密码登录双模式，2026-08-14：code 与 password 二选一）
// 验证码错误 ≥5 次锁定 10 分钟，见 middleware/rateLimit.js
router.post(
  '/login',
  [
    phoneRule,
    body('code').optional({ values: 'falsy' }).matches(/^\d{6}$/).withMessage('验证码格式不正确（6 位数字）'),
    body('password').optional({ values: 'falsy' }).isLength({ min: 6, max: 20 }).withMessage('密码长度需在 6-20 字符'),
    validate,
    verifyLockGuard,
  ],
  auth.login
);

// 1.3 手机号注册（同上锁定防护）
router.post(
  '/register',
  [
    phoneRule,
    codeRule,
    body('nickname').trim().isLength({ min: 2, max: 20 }).withMessage('昵称长度需在 2-20 字符'),
    body('password')
      .optional({ values: 'falsy' })
      .isLength({ min: 6, max: 20 })
      .withMessage('密码长度需在 6-20 字符'),
    validate,
    verifyLockGuard,
  ],
  auth.register
);

// 1.4 刷新 Token
router.post(
  '/refresh',
  [body('refreshToken').notEmpty().withMessage('refreshToken 不能为空'), validate],
  auth.refresh
);

// 1.5 退出登录
router.post('/logout', requireAuth, auth.logout);

export default router;
