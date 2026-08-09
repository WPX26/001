/**
 * Token 服务：签发/校验 access + refresh 双令牌
 * - access token：JWT，短期（默认 1 天），接口透传 Authorization 头
 * - refresh token：JWT + 服务端记录（RefreshToken 表），可登出失效/轮换
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { RefreshToken } from '../models/index.js';

/** 签发 access token */
export function signAccessToken(userId) {
  return jwt.sign({ uid: String(userId), type: 'access' }, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES,
  });
}

/** 签发 refresh token 并落库（登出/轮换时凭记录失效） */
export async function signRefreshToken(userId) {
  // jti 随机因子：JWT 的 iat 是秒级时间戳，同一秒签发可能产生相同字符串，
  // 会撞 RefreshToken 集合的 token 唯一索引，故加随机串保证每次签发唯一
  const token = jwt.sign(
    { uid: String(userId), type: 'refresh', jti: randomUUID() },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_REFRESH_EXPIRES,
    }
  );
  await RefreshToken.create({
    token,
    userId,
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_EXPIRES * 1000),
  });
  return token;
}

/** 校验 refresh token：JWT 合法 + 服务端记录存在且未吊销 */
export async function verifyRefreshToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (e) {
    throw new AppError(ERR.AUTH, '刷新令牌无效或已过期', 401);
  }
  if (payload.type !== 'refresh' || !payload.uid) {
    throw new AppError(ERR.AUTH, '刷新令牌类型错误', 401);
  }
  const record = await RefreshToken.findOne({ token, revokedAt: null });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw new AppError(ERR.AUTH, '刷新令牌已失效，请重新登录', 401);
  }
  return { userId: payload.uid, record };
}

/** 吊销指定用户的全部 refresh token（登出） */
export async function revokeUserTokens(userId) {
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

/** 登录/注册/刷新成功后的统一返回体（对齐 api.md 1.2） */
export async function issueTokens(user) {
  const accessToken = signAccessToken(user._id);
  const refreshToken = await signRefreshToken(user._id);
  return {
    token: accessToken,
    refreshToken,
    expiresIn: env.JWT_ACCESS_EXPIRES,
    user: {
      id: String(user._id),
      nickname: user.nickname,
      avatar: user.avatar || '',
      isNewUser: false,
    },
  };
}
