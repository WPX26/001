/**
 * MongoDB 连接管理
 * 连接失败由 server.js 捕获并优雅退出（打印明确提示）
 */
import mongoose from 'mongoose';
import env from './env.js';

export async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000, // 5 秒内找不到服务即失败
    connectTimeoutMS: 5000,
  });
  console.log(`[DB] MongoDB 已连接：${env.MONGODB_URI}`);
  return mongoose.connection;
}

/** 是否已连接（供 /health 使用） */
export function isDBConnected() {
  return mongoose.connection.readyState === 1;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  console.log('[DB] MongoDB 已断开');
}
