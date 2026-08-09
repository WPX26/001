/**
 * 上传路由（api.md 7.1/7.3 与 14.4）
 */
import { Router } from 'express';
import { body } from 'express-validator';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { UPLOAD_DIR } from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import * as upload from '../controllers/upload.controller.js';

const router = Router();

router.use(requireAuth);

// 7.1 获取上传凭证
router.post(
  '/token',
  [
    body('fileCount').optional().isInt({ min: 1, max: 20 }).withMessage('fileCount 需在 1-20 之间'),
    body('scene').optional().isIn(['coord', 'avatar', 'chat']).withMessage('scene 必须是 coord/avatar/chat'),
    validate,
  ],
  upload.getUploadToken
);

// 7.3 上传完成回调
router.post(
  '/callback',
  [
    body('files').isArray({ min: 1 }).withMessage('files 必须是非空数组'),
    body('files.*.key').isString().withMessage('files[].key 必须是字符串'),
    body('files.*.hash').optional().isString().withMessage('files[].hash 必须是字符串'),
    body('files.*.size').optional().isInt().withMessage('files[].size 必须是整数'),
    validate,
  ],
  upload.uploadCallback
);

// 14.4 小文件直传（本地模式）
// multer 磁盘存储：uploads/<scene>/<时间戳>-<随机>.jpg
const allowedScenes = ['avatar', 'chat', 'portfolio', 'coord'];
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const scene = allowedScenes.includes(req.body.scene) ? req.body.scene : 'chat';
    const dir = path.join(UPLOAD_DIR, scene);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const uploadFileMiddleware = multer({
  storage: multerStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new AppError(ERR.VALIDATE, '仅支持图片文件', 400));
  },
});

router.post('/file', uploadFileMiddleware.single('file'), upload.uploadFile);

export default router;
