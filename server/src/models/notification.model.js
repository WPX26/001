/**
 * 通知模型（api.md 14.1-14.3，P1 接口，先建模型）
 * 类型枚举对齐 config/constants.js NOTIFICATION_TYPE：like / comment / reply / tip / collect / follow / system / chat
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true }, // 接收人
    type: {
      type: String,
      enum: ['like', 'comment', 'reply', 'tip', 'collect', 'follow', 'system', 'chat'],
      required: true,
    },
    actorId: { type: Types.ObjectId, ref: 'User', default: null }, // 触发人
    photoId: { type: Types.ObjectId, ref: 'Photo', default: null },
    commentId: { type: Types.ObjectId, ref: 'Comment', default: null },
    content: { type: String, default: '' }, // 系统通知的正文
    isRead: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// 接收人未读通知查询
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
