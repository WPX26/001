/**
 * 打赏记录模型（api.md 6.4，P1 接口）
 * - 平台代币 1-100（整数）
 * - 限频：同一用户同一照片 60 秒内一次（由控制器查最近一条判断，配合该索引倒序查询）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const tipSchema = new Schema(
  {
    photoId: { type: Types.ObjectId, ref: 'Photo', required: true, index: true },
    tipperId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1, max: 100 },
  },
  { timestamps: true }
);

// 限频查询（同照片最近一次打赏）+ 打赏明细分页共用
tipSchema.index({ photoId: 1, createdAt: -1 });

export default mongoose.model('Tip', tipSchema);
