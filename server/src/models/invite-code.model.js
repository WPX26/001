/**
 * 邀请码模型（王总定稿：管理员生成、一次性、可叠加兑换）
 * 产品规则：
 * - 仅管理端生成（createdBy 记录生成者标识），用户不可自生成
 * - 一次性：每个码只能兑换一次，用后置 usedBy/usedAt 作废；
 *   兑换时通过 findOneAndUpdate({ code, usedBy: null }) 原子抢占，防并发重复兑换
 * - 可叠加：每兑换 1 个码 = 会员 +rewardDays 天（默认 30），在 memberExpireAt 上顺延
 * - 兑换即认证：兑换成功后走会员激活联动（isPhotographer=true，与订阅规则一致）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const inviteCodeSchema = new Schema(
  {
    // 邀请码：VIP + 8 位大写字母数字（生成侧去掉易混淆字符 O/0/I/1）
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    // 生成者标识（管理员 Token 无用户 ID，统一记 'admin'）
    createdBy: { type: String, default: 'admin' },
    // 兑换用户（null = 未使用）
    usedBy: { type: Types.ObjectId, ref: 'User', default: null, index: true },
    // 兑换时间（null = 未使用）
    usedAt: { type: Date, default: null },
    // 兑换奖励天数（默认 30，与 MEMBER_PLAN.days 对齐，预留可调）
    rewardDays: { type: Number, default: 30 },
  },
  { timestamps: true }
);

export default mongoose.model('InviteCode', inviteCodeSchema);
