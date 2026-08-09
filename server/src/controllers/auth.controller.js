/**
 * 认证控制器（api.md 第 1 章）
 * - POST /auth/send-code 发送短信验证码
 * - POST /auth/login 手机号 + 验证码登录
 * - POST /auth/register 手机号 + 验证码注册（可选密码）
 * - POST /auth/refresh 刷新令牌
 * - POST /auth/logout 退出登录
 */
import bcrypt from 'bcryptjs';
import env from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User, VerificationCode } from '../models/index.js';
import * as smsService from '../services/sms.service.js';
import * as tokenService from '../services/token.service.js';

/** 生成 6 位数字验证码 */
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * 校验短信验证码（登录/注册共用）
 * 取该手机号+场景最新一条：未使用、未过期、内容一致
 */
async function verifySmsCode(phone, scene, code) {
  const record = await VerificationCode.findOne({ phone, scene }).sort({ createdAt: -1 });
  if (!record || record.usedAt) throw new AppError(ERR.VALIDATE, '请先获取验证码', 400);
  if (record.expiresAt.getTime() < Date.now()) {
    throw new AppError(ERR.VALIDATE, '验证码已过期，请重新获取', 400);
  }
  if (record.code !== code) {
    throw new AppError(ERR.VALIDATE, '验证码错误', 400);
  }
  record.usedAt = new Date();
  await record.save();
}

/** 1.1 发送短信验证码 */
export const sendCode = asyncHandler(async (req, res) => {
  const { phone, scene } = req.body;

  // 配置缺失优先报错（避免未配置时静默失败，密钥到位即生效）
  // 开发模式（SMS_DEV_MODE=true）跳过密钥检查，验证码直接返回，便于本地联调
  if (!smsService.isConfigured() && !env.SMS_DEV_MODE) {
    console.warn('[短信] 请在 .env 配置 ALIYUN_SMS_* 密钥后重启服务');
    throw new AppError(ERR.SERVICE_CONFIG, '短信服务未配置，请联系管理员', 503);
  }

  // 频率限制：同一手机号同一场景间隔内只允许发送一次（api.md 附录 B：1006）
  const last = await VerificationCode.findOne({ phone, scene }).sort({ createdAt: -1 });
  if (last && Date.now() - last.createdAt.getTime() < env.SMS_SEND_INTERVAL_SECONDS * 1000) {
    throw new AppError(ERR.RATE_LIMIT, '发送过于频繁，请稍后再试', 429);
  }

  const code = genCode();
  const record = await VerificationCode.create({
    phone,
    scene,
    code,
    expiresAt: new Date(Date.now() + env.SMS_CODE_EXPIRE_SECONDS * 1000),
  });

  try {
    if (env.SMS_DEV_MODE) {
      // 开发模式：不调用真实短信，验证码在响应中返回（联调用）
      console.log(`[短信-开发模式] ${phone} ${scene} 验证码: ${code}`);
    } else {
      await smsService.sendCode(phone, scene, code);
    }
  } catch (err) {
    // 发送失败时清理验证码记录，避免留下不可用的码
    await VerificationCode.deleteOne({ _id: record._id }).catch(() => {});
    throw err;
  }

  ok(res, { expireSeconds: env.SMS_CODE_EXPIRE_SECONDS, ...(env.SMS_DEV_MODE ? { devCode: code } : {}) }, '验证码已发送');
});

/** 1.2 手机号登录 */
export const login = asyncHandler(async (req, res) => {
  const { phone, code } = req.body;
  await verifySmsCode(phone, 'login', code);

  const user = await User.findOne({ phone });
  if (!user) {
    throw new AppError(ERR.NOT_FOUND, '该手机号尚未注册，请先注册', 404);
  }

  const data = await tokenService.issueTokens(user);
  ok(res, data, '登录成功');
});

/** 1.3 手机号注册（可选密码） */
export const register = asyncHandler(async (req, res) => {
  const { phone, code, nickname, password } = req.body;

  // 先查重：已注册手机号直接 409/1005，且不消耗验证码（避免二次注册被"验证码已使用"拦截）
  const exists = await User.findOne({ phone });
  if (exists) {
    throw new AppError(ERR.DUPLICATE, '该手机号已注册，请直接登录', 409);
  }

  await verifySmsCode(phone, 'register', code);

  let user;
  try {
    user = await User.create({
      phone,
      nickname,
      ...(password ? { passwordHash: bcrypt.hashSync(password, 10) } : {}),
    });
  } catch (err) {
    // 并发兜底：两请求同时过查重后，唯一索引冲突同样转 409/1005，不泄漏 500
    if (err && err.code === 11000) {
      throw new AppError(ERR.DUPLICATE, '该手机号已注册，请直接登录', 409);
    }
    throw err;
  }

  const data = await tokenService.issueTokens(user);
  data.user.isNewUser = true;
  ok(res, data, '注册成功');
});

/** 1.4 刷新令牌（轮换：旧 refresh 失效，签发新对） */
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const { userId, record } = await tokenService.verifyRefreshToken(refreshToken);

  // 轮换：吊销旧 refresh token，防止重放
  record.revokedAt = new Date();
  await record.save();

  const user = await User.findById(userId);
  if (!user) throw new AppError(ERR.AUTH, '用户不存在', 401);

  const data = await tokenService.issueTokens(user);
  ok(res, data, '刷新成功');
});

/** 1.5 退出登录（吊销该用户全部 refresh token） */
export const logout = asyncHandler(async (req, res) => {
  await tokenService.revokeUserTokens(req.user._id);
  ok(res, {}, '已退出登录');
});
