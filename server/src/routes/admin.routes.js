/**
 * 管理端路由（挂载于 /api/v1/admin）
 * 除登录外均需管理员 Token（requireAdmin）
 */
import { Router } from 'express';
import { body, param } from 'express-validator';
import multer from 'multer';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import * as admin from '../controllers/admin.controller.js';
import * as invite from '../controllers/invite.controller.js';

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

// 收款码图片上传（multipart，字段名 file）：内存存储，仅图片，≤5MB
// 大小超限/类型错误由 multer 抛错，errorHandler 统一转 400/1001
const qrcodeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new AppError(ERR.VALIDATE, '仅支持图片文件（字段名 file）', 400));
  },
});

// 上传/更换收款码图片（覆盖式写 /uploads/pay-qrcode.png，免进容器操作）
router.post('/payments/qrcode', qrcodeUpload.single('file'), admin.uploadPayQrcode);

// ============ 邀请码（管理员生成、一次性、可叠加兑换） ============
// 生成 count 个一次性邀请码（1-100，格式 VIP+8 位大写字母数字）
router.post(
  '/invite-codes/generate',
  [
    body('count')
      .isInt({ min: 1, max: 100 })
      .withMessage('count 需为 1-100 的整数'),
    validate,
  ],
  invite.generateInviteCodes
);

// 邀请码列表（分页，used/unused + usedBy 昵称）
router.get('/invite-codes', invite.listInviteCodes);

export default router;
