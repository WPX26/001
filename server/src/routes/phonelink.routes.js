/**
 * 手机互联路由（api.md 8.10 节，挂载于 /api/v1/phonelink）
 * - POST /pairs        被控端创建配对（需登录）
 * - POST /pairs/join   控制端加入（匿名，IP 限频）
 * - GET  /pairs/:code  查询配对状态
 * - POST /pairs/:code/close 被控端关闭（需登录 + 创建者）
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createPair, joinPair, getPair, closePair } from '../controllers/phonelink.controller.js';

const router = Router();

router.post('/pairs', requireAuth, createPair);
router.post('/pairs/join', joinPair);
router.get('/pairs/:code', getPair);
router.post('/pairs/:code/close', requireAuth, closePair);

export default router;
