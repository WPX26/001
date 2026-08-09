/**
 * 服务入口：连接数据库 → 启动 HTTP 服务
 * MongoDB 未就绪时打印明确提示并优雅退出（不会白屏挂起）
 */
import app from './app.js';
import env from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';

async function main() {
  try {
    await connectDB();
  } catch (err) {
    console.error('\n[MongoDB] 连接失败：', err.message);
    console.error('提示：请先启动 MongoDB（mongod 或 docker）或检查 .env 中的 MONGODB_URI 配置。');
    console.error('参考：MONGODB_URI=' + env.MONGODB_URI);
    process.exit(1);
  }

  const server = app.listen(env.PORT, () => {
    console.log(`[Server] 地图相册平台后端已启动：http://localhost:${env.PORT}`);
    console.log(`[Server] 存储模式：${env.STORAGE_MODE === 'oss' ? '阿里云 OSS' : '本地磁盘'}`);
    console.log(`[Server] 健康检查：http://localhost:${env.PORT}/health`);
  });

  // 优雅退出
  const shutdown = async (signal) => {
    console.log(`\n[Server] 收到 ${signal}，正在关闭...`);
    server.close(async () => {
      await disconnectDB().catch(() => {});
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
