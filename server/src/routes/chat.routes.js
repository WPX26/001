/**
 * 私信聊天路由（api.md 第 9 章，P1 接口，最后一批）
 * WebSocket 端点 /chat/ws 不走本路由（HTTP 升级由 server.js → services/chat.ws.js 接管）
 */
import { Router } from 'express';
import { param, query, body } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as chat from '../controllers/chat.controller.js';

const router = Router();

router.use(requireAuth);

// 9.1 会话列表
router.get('/conversations', chat.getConversations);

// 9.4 创建/获取与某用户的会话（幂等）
router.post(
  '/conversations',
  [body('peerId').isMongoId().withMessage('peerId 格式不正确'), validate],
  chat.createConversation
);

// 9.2 聊天记录（before 时间游标 + limit 默认 30）
router.get(
  '/conversations/:conversationId/messages',
  [
    param('conversationId').isMongoId().withMessage('会话 ID 格式不正确'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit 须为 1-50 的整数'),
    query('before')
      .optional()
      .custom((v) => !Number.isNaN(Date.parse(v)))
      .withMessage('before 游标须为 ISO 时间格式'),
    validate,
  ],
  chat.getMessages
);

// 9.3 发消息（type 细分字段校验在控制器内，与现有风格一致）
router.post(
  '/conversations/:conversationId/messages',
  [
    param('conversationId').isMongoId().withMessage('会话 ID 格式不正确'),
    body('type').isIn(['text', 'image', 'coord']).withMessage('type 必须是 text/image/coord 之一'),
    validate,
  ],
  chat.sendMessage
);

// 9.5 标记已读
router.put(
  '/conversations/:conversationId/read',
  [param('conversationId').isMongoId().withMessage('会话 ID 格式不正确'), validate],
  chat.markRead
);

export default router;
