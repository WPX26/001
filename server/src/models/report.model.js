/**
 * 举报模型（api.md 14.5，P1 接口，最后一批）
 * 目标类型：photo 照片 / comment 评论 / user 用户；状态 pending 待处理 / handled 已处理
 * 去重策略：同一举报人对同一目标的"待处理"举报唯一（DB 部分唯一索引兜底并发）；
 *   handled 后允许再次举报（新一轮违规），P2 管理端审核接口按状态流转
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const reportSchema = new Schema(
  {
    reporterId: { type: Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['photo', 'comment', 'user'], required: true },
    targetId: { type: Types.ObjectId, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: ['pending', 'handled'], default: 'pending' },
  },
  { timestamps: true }
);

// 管理端按目标查（P2 审核列表）
reportSchema.index({ targetType: 1, targetId: 1 });
// 我的举报记录
reportSchema.index({ reporterId: 1, createdAt: -1 });
// 重复举报去重：同一举报人 + 同一目标 + 待处理 唯一（并发兜底）
reportSchema.index(
  { reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

export default mongoose.model('Report', reportSchema);
