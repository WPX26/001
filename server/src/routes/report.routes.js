/**
 * 举报路由（api.md 14.5，P1 接口，最后一批）
 */
import { Router } from 'express';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { createReport } from '../controllers/report.controller.js';

const router = Router();

router.use(requireAuth);

// 14.5 举报内容（reason 的必填/长度在控制器内 trim 后校验，与现有控制器风格一致）
router.post(
  '/',
  [
    body('targetType').isIn(['photo', 'comment', 'user']).withMessage('targetType 必须是 photo/comment/user 之一'),
    body('targetId').isMongoId().withMessage('targetId 格式不正确'),
    validate,
  ],
  createReport
);

export default router;
