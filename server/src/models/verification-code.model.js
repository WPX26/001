/**
 * 短信验证码模型（认证流程使用）
 * 存储手机号 + 场景 + 验证码 + 过期时间；expiresAt 上建 TTL 索引自动清理
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;

const verificationCodeSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    scene: { type: String, enum: ['login', 'register'], required: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null }, // 使用后标记，防止重放
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 频率限制/校验查询：同一手机号同一场景取最新一条
verificationCodeSchema.index({ phone: 1, scene: 1, createdAt: -1 });
// TTL：过期自动删除
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('VerificationCode', verificationCodeSchema);
