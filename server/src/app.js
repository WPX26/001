/**
 * Express 应用装配（不连接数据库，便于测试）
 * 服务启动与数据库连接在 server.js
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'node:fs';
import path from 'node:path';
import env, { UPLOAD_DIR } from './config/env.js';
import { isDBConnected } from './config/db.js';
import { ok } from './utils/response.js';
import routes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// 跨域（开发期全放行，上线前收敛为白名单）
app.use(cors());

// 请求日志
app.use(morgan(env.isProd ? 'combined' : 'dev'));

// JSON 解析；rawBody 供 OSS 回调签名验签使用
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// 本地存储模式：静态托管上传目录（STORAGE_MODE=local 时使用）
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(path.join(UPLOAD_DIR)));

// 基础设施健康检查（不属于业务接口，仅运维用）
app.get('/health', (req, res) => {
  ok(res, {
    status: 'ok',
    service: 'memomap-server',
    version: '0.1.0',
    storageMode: env.STORAGE_MODE,
    db: isDBConnected() ? 'connected' : 'disconnected',
  });
});

// 根路径返回 200（Sealos 等平台的健康探针默认访问 /，需要 200 判定健康）
app.get('/', (req, res) => {
  ok(res, { status: 'ok', service: 'memomap-server' });
});

// 业务路由（api.md 前缀 /api/v1）
app.use('/api/v1', routes);

// 404 兜底 + 统一错误处理（必须最后注册）
app.use(notFound);
app.use(errorHandler);

export default app;
