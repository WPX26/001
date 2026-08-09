/**
 * Refresh Token 模型（认证流程使用）
 * 登出/刷新时通过 revokedAt 失效，防止旧 token 重放
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const refreshTokenSchema = new Schema(
  {
    token: { type: String, required: true, unique: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// TTL：过期自动删除
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RefreshToken', refreshTokenSchema);
