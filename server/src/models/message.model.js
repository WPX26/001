/**
 * 消息模型（私信聊天，api.md 9.2/9.3，P1 接口，先建模型）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const messageSchema = new Schema(
  {
    conversationId: { type: Types.ObjectId, ref: 'Conversation', required: true, index: true },
    senderId: { type: Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'image', 'coord'], default: 'text' },
    content: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    // 坐标分享消息附带的坐标 ID
    coordId: { type: Types.ObjectId, ref: 'Coord', default: null },
    // 已读用户
    readBy: [{ type: Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

// 游标分页（before 时间）查询索引
messageSchema.index({ conversationId: 1, createdAt: -1 });

export default mongoose.model('Message', messageSchema);
