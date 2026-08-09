/**
 * 用户模型
 * 对应 api.md 第 1/2 章：手机号唯一、资料、生活/工作模式、摄影师标记、会员状态、
 * 关注关系（following 数组 + 冗余计数）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const userSchema = new Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true, // 手机号唯一（登录标识）
      match: /^1\d{10}$/,
      index: true,
    },
    // 可选密码（注册时提供则后续可用密码登录；未提供则仅短信验证码登录）
    passwordHash: { type: String, default: null },
    nickname: { type: String, required: true, trim: true, maxlength: 20 },
    avatar: { type: String, default: '' }, // 头像 URL（本地上传路径或 OSS URL）
    bio: { type: String, default: '', maxlength: 200 },
    // 生活/工作模式：life 内容进灵感池，work 内容进探索池（需摄影师认证）
    mode: { type: String, enum: ['life', 'work'], default: 'life' },
    isPhotographer: { type: Boolean, default: false },
    memberStatus: { type: String, enum: ['none', 'active', 'expired'], default: 'none' },
    memberExpireAt: { type: Date, default: null },
    // 冗余计数（关注/粉丝数，避免实时聚合）
    followerCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    // 我关注的用户 ID 数组（粉丝列表通过反查此数组获得）
    following: [{ type: Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

// 粉丝反查索引：找到 following 数组里包含目标用户的记录
userSchema.index({ following: 1 });

export default mongoose.model('User', userSchema);
