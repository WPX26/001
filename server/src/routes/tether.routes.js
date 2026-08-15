/**
 * 相机互联路由（api.md 第 8 章，挂载于 /api/v1/tether）
 * 2026-08-15 去模拟化：detect 真实扫描；connect 仅连接真实检测到的相机
 */
import { Router } from 'express';
import { detect, connect, disconnect } from '../controllers/tether.controller.js';

const router = Router();

router.post('/detect', detect);
router.post('/connect', connect);
router.post('/disconnect', disconnect);

export default router;
