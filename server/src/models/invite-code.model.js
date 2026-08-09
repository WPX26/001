/**
 * 邀请码模型（api.md 第 12 章，P1 接口，先建模型）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const inviteCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true }, // 如 PHOTO268
    ownerId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    usedCount: { type: Number, default: 0 },
    totalReward: { type: Number, default: 0 }, // 累计奖励（平台代币）
    rewardDays: { type: Number, default: 30 }, // 兑换奖励天数
  },
  { timestamps: true }
);

export default mongoose.model('InviteCode', inviteCodeSchema);
