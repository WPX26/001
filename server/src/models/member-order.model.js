/**
 * 会员订单模型（王总定稿产品规则：半自动人工确认支付）
 * 状态机：pending_confirm → paid / expired
 * - pending_confirm：用户下单扫码付款后待管理端人工核对（超 48h 惰性置 expired）
 * - paid：管理端已确认收款，会员已激活；自动续费模拟顺延时也会落 paid 订单（autoRenewed=true，无真实付款）
 * - expired：超时未确认 / 已过期订单
 * 邀请码兑换记录：paymentMethod=invite、amount=0 的 paid 订单（不产生支付、不入 pending，直接落账留痕）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const memberOrderSchema = new Schema(
  {
    // 业务订单号（URL/接口用）：MEMO + yyyyMMddHHmmss + 4 位随机
    orderId: { type: String, required: true, unique: true },
    // 付款备注订单号：M + 6 位数字（用户转账备注用，短小易抄）
    orderNo: { type: String, required: true, unique: true, index: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    planId: { type: String, required: true }, // 套餐 ID（plan_pro_monthly 月卡）
    planName: { type: String, default: '' },
    amount: { type: Number, required: true }, // 分（与支付平台对齐用整数分）
    period: { type: String, enum: ['month', 'year', 'week'], default: 'month' },
    // 坐标置顶订单专用：目标坐标标题（boost_coord_7d）
    coordKey: { type: String, default: '', index: true },
    paymentMethod: { type: String, enum: ['wechat', 'alipay', 'invite'], default: 'wechat' },
    status: {
      type: String,
      enum: ['pending_confirm', 'paid', 'expired'],
      default: 'pending_confirm',
      index: true,
    },
    // 自动续费模拟订单标记（无真实付款，仅记录模拟顺延）
    autoRenewed: { type: Boolean, default: false },
    // 邀请码兑换来源码（paymentMethod=invite 时留痕，历史可查；其余为空）
    inviteCode: { type: String, default: '' },
    outTradeNo: { type: String, default: '' }, // 支付平台交易号（半自动模式暂不使用）
    confirmedAt: { type: Date, default: null }, // 管理端确认时间
    paidAt: { type: Date, default: null },
    expireAt: { type: Date, default: null }, // 会员到期时间（确认/顺延时写回）
  },
  { timestamps: true }
);

export default mongoose.model('MemberOrder', memberOrderSchema);
