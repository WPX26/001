/**
 * 评论模型（api.md 6.7-6.9，P1 接口，先建模型）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const commentSchema = new Schema(
  {
    photoId: { type: Types.ObjectId, ref: 'Photo', required: true, index: true },
    authorId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    content: { type: String, required: true, maxlength: 500 },
    // 回复目标用户（可选）
    replyTo: { type: Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

commentSchema.index({ photoId: 1, createdAt: -1 });

export default mongoose.model('Comment', commentSchema);
