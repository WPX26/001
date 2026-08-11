/**
 * 通知路由（api.md 第 14.1-14.3 章，P1）
 * 注意：/read-all、/unread-count 为静态路径，置于 /:notificationId/read 之前（无冲突但保持清晰）
 */
import { Router } from 'express';
import { param, query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as notification from '../controllers/notification.controller.js';
import { NOTIFICATION_TYPE } from '../config/constants.js';

const router = Router();

router.use(requireAuth);

const typeValues = Object.values(NOTIFICATION_TYPE);

// 14.1 通知列表（type 过滤）
router.get(
  '/',
  [
    query('type').optional().isIn(typeValues).withMessage(`type 必须是 ${typeValues.join('/')} 之一`),
    validate,
  ],
  notification.getNotifications
);

// 14.2 全部已读
router.put('/read-all', notification.readAllNotifications);

// 14.3 未读通知数（红点）
router.get('/unread-count', notification.getUnreadCount);

// 14.2 单条已读（仅接收人本人）
router.put(
  '/:notificationId/read',
  [param('notificationId').isMongoId().withMessage('通知 ID 格式不正确'), validate],
  notification.readNotification
);

export default router;
