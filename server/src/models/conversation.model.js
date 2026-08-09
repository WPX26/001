/**
 * 会话模型（私信聊天，api.md 第 9 章，P1 接口，先建模型）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const conversationSchema = new Schema(
  {
    // 参与人（双人会话 = 2 个 userId）
    participants: [{ type: Types.ObjectId, ref: 'User', index: true }],
    // 最后一条消息快照（会话列表直接展示，避免联查消息表）
    lastMessage: {
      _id: false,
      senderId: { type: Types.ObjectId, ref: 'User', default: null },
      type: { type: String, enum: ['text', 'image', 'coord'], default: 'text' },
      content: { type: String, default: '' },
      imageUrl: { type: String, default: '' },
      createdAt: { type: Date, default: null },
    },
    lastMessageAt: { type: Date, default: null, index: true },
    // 各参与人的未读数 { userId: count }
    unreadCounts: { type: Map, of: Number, default: {} },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export default mongoose.model('Conversation', conversationSchema);
