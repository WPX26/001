/**
 * 用户路由（api.md 第 2 章）
 */
import { Router } from 'express';
import { param, body, query } from 'express-validator';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as user from '../controllers/user.controller.js';

const router = Router();

// 全部接口需登录
router.use(requireAuth);

const userIdParam = (name = 'userId') =>
  param(name).isMongoId().withMessage('用户 ID 格式不正确');

// 2.1 获取我的资料 / 2.2 更新我的资料
router.get('/me', user.getMe);
router.put(
  '/me',
  [
    body('nickname').optional().trim().isLength({ min: 2, max: 20 }).withMessage('昵称长度需在 2-20 字符'),
    body('avatar').optional().isString().isLength({ max: 500 }).withMessage('头像地址过长'),
    body('bio').optional().isString().isLength({ max: 200 }).withMessage('简介不能超过 200 字符'),
    validate,
  ],
  user.updateMe
);

// 2.9 切换生活/工作模式
router.put(
  '/me/mode',
  [body('mode').isIn(['life', 'work']).withMessage('mode 必须是 life 或 work'), validate],
  user.updateMode
);

// 2.10 我收藏的坐标
router.get('/me/collected-coords', user.getCollectedCoords);

// 2.3 他人主页
router.get('/:userId/profile', [userIdParam(), validate], user.getProfile);

// 2.4 他人作品列表
router.get('/:userId/coords', [userIdParam(), validate], user.getUserCoords);

// 2.5 关注 / 2.6 取消关注
router.post('/:userId/follow', [userIdParam(), validate], user.follow);
router.delete('/:userId/follow', [userIdParam(), validate], user.unfollow);

// 2.7 关注列表 / 2.8 粉丝列表
router.get('/:userId/following', [userIdParam(), validate], user.getFollowing);
router.get('/:userId/followers', [userIdParam(), validate], user.getFollowers);

export default router;
