/**
 * 认证中间件：校验 Bearer Token（api.md：除登录/注册外均需携带）
 * 校验通过后把用户文档挂到 req.user
 */
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { User } from '../models/index.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      throw new AppError(ERR.AUTH, '未登录：请携带 Bearer Token', 401);
    }

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch (e) {
      // 过期或无效 token 统一按 1002 处理
      throw new AppError(ERR.AUTH, 'Token 已过期或无效', 401);
    }

    // 只接受 access token（refresh token 仅用于 /auth/refresh）
    if (payload.type !== 'access' || !payload.uid) {
      throw new AppError(ERR.AUTH, 'Token 类型错误', 401);
    }

    const user = await User.findById(payload.uid);
    if (!user) {
      throw new AppError(ERR.AUTH, '用户不存在或已被注销', 401);
    }

    req.user = user;
    req.tokenPayload = payload;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 可选认证中间件：有合法 token 则挂载 req.user，无 token / 无效 token 一律放行
 * 用于"登录可用、未登录也可用"的接口（如地图行政区聚合）
 */
export async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return next();

    const payload = jwt.verify(token, env.JWT_SECRET);
    // 只挂载合法 access token；refresh token / 无效 token 不阻断
    if (payload.type === 'access' && payload.uid) {
      const user = await User.findById(payload.uid);
      if (user) req.user = user;
    }
  } catch {
    // 无效 token 按未登录处理，不阻断请求
  }
  next();
}
