/**
 * 上传控制器（api.md 第 7/14 章上传部分）
 * - POST /upload/token 获取 OSS 直传凭证（STS 临时凭证 + 预签名 URL）
 * - POST /upload/callback 上传完成回调（OSS 模式验签 + 生成 photoIds，幂等）
 * - POST /upload/file 小文件直传（本地模式/头像等）
 */
import env from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as storageService from '../services/storage.service.js';

/** 7.1 获取上传凭证 */
export const getUploadToken = asyncHandler(async (req, res) => {
  const { fileCount = 1, scene = 'coord' } = req.body;
  const data = await storageService.getUploadToken(scene, fileCount);
  ok(res, data, '上传凭证获取成功');
});

/** 7.3 上传完成回调：验签（OSS 模式）→ 创建照片记录（幂等）→ 返回 photoIds */
export const uploadCallback = asyncHandler(async (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError(ERR.VALIDATE, 'files 参数必须是非空数组', 400);
  }

  // OSS 模式：回调签名验签（防伪造回调）
  if (env.STORAGE_MODE === 'oss') {
    if (!storageService.isOSSConfigured()) {
      throw storageService.ossConfigMissingError();
    }
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const auth = req.headers.authorization || '';
    if (!storageService.verifyCallbackSignature(rawBody, auth)) {
      throw new AppError(ERR.AUTH, '回调签名校验失败', 401);
    }
  }

  const photoIds = await storageService.createPhotosFromCallback(files, req.user._id);
  ok(res, { photoIds }, '上传确认成功');
});

/** 14.4 小文件直传（本地模式：头像/聊天图片/作品集） */
export const uploadFile = asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw new AppError(ERR.VALIDATE, '缺少文件（字段名 file）', 400);

  const scene = req.body.scene || 'chat';

  // chat 场景收紧：私信图片仅 JPG/PNG/WebP ≤10MB（与前端拦截同口径）
  if (scene === 'chat') {
    const CHAT_OK = ['image/jpeg', 'image/png', 'image/webp'];
    if (!CHAT_OK.includes(file.mimetype)) {
      throw new AppError(ERR.VALIDATE, '聊天图片仅支持 JPG/PNG/WebP', 400);
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new AppError(ERR.VALIDATE, '聊天图片不能超过 10MB', 400);
    }
  }

  const relativePath = `/uploads/${scene}/${file.filename}`;
  ok(res, {
    url: `${env.LOCAL_BASE_URL}${relativePath}`,
    relativePath,
    name: file.originalname,
    size: file.size,
    scene,
  }, '上传成功');
});
