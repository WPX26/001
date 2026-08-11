/**
 * 路由统一出口（挂载于 /api/v1，api.md 前缀约定）
 *
 * P0 已实现模块：auth / map / coords / photos / users / upload / member / admin
 * P1 预留模块（模型已建，路由待接入）：inspire / explore / comments / tether / chat / photographer / invite / notifications / report
 */
import { Router } from 'express';
import authRoutes from './auth.routes.js';
import mapRoutes from './map.routes.js';
import coordRoutes from './coord.routes.js';
import photoRoutes from './photo.routes.js';
import userRoutes from './user.routes.js';
import uploadRoutes from './upload.routes.js';
import memberRoutes from './member.routes.js';
import adminRoutes from './admin.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/map', mapRoutes);
router.use('/coords', coordRoutes);
router.use('/photos', photoRoutes);
router.use('/users', userRoutes);
router.use('/upload', uploadRoutes);
router.use('/member', memberRoutes);
router.use('/admin', adminRoutes);

export default router;
