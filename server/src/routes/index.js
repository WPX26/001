/**
 * 路由统一出口（挂载于 /api/v1，api.md 前缀约定）
 *
 * P0 已实现模块：auth / map / coords / photos / users / upload / member / admin / invite（邀请码兑换）
 * P1 第一批：comments（评论，挂在 /photos 下）、notifications（通知）
 * P1 第二批：inspire（灵感模式）、explore（探索模式）
 * P1 第三批（最后一批）：report（举报）、chat（私信，REST + WebSocket）
 * P1 预留模块（模型已建，路由待接入）：tether / photographer
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
import inviteRoutes from './invite.routes.js';
import notificationRoutes from './notification.routes.js';
import inspireRoutes from './inspire.routes.js';
import exploreRoutes from './explore.routes.js';
import reportRoutes from './report.routes.js';
import chatRoutes from './chat.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/map', mapRoutes);
router.use('/coords', coordRoutes);
router.use('/photos', photoRoutes);
router.use('/users', userRoutes);
router.use('/upload', uploadRoutes);
router.use('/member', memberRoutes);
router.use('/admin', adminRoutes);
router.use('/invite', inviteRoutes);
router.use('/notifications', notificationRoutes);
router.use('/inspire', inspireRoutes);
router.use('/explore', exploreRoutes);
router.use('/report', reportRoutes);
router.use('/chat', chatRoutes);

export default router;
