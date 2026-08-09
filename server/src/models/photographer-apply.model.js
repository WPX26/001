/**
 * 摄影师认证申请模型（api.md 第 11 章，P1 接口，先建模型）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const photographerApplySchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    realName: { type: String, required: true },
    // 代表作照片 ID（3-9 张）
    portfolio: [{ type: Types.ObjectId, ref: 'Photo' }],
    description: { type: String, default: '', maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reason: { type: String, default: '' }, // 驳回原因
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('PhotographerApply', photographerApplySchema);
