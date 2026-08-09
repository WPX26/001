/**
 * 会员订单模型（api.md 第 10 章，P1 接口，先建模型）
 * 支付对接微信/支付宝，P1 接入真实支付
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const memberOrderSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true }, // 业务订单号 ord_xxx
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    planId: { type: String, required: true }, // 套餐 ID（plan_pro / plan_basic 等）
    planName: { type: String, default: '' },
    amount: { type: Number, required: true }, // 分（与支付平台对齐用整数分）
    period: { type: String, enum: ['month', 'year'], default: 'year' },
    paymentMethod: { type: String, enum: ['wechat', 'alipay'], required: true },
    status: {
      type: String,
      enum: ['pending', 'paid', 'cancelled', 'expired'],
      default: 'pending',
    },
    outTradeNo: { type: String, default: '' }, // 支付平台交易号
    paidAt: { type: Date, default: null },
    expireAt: { type: Date, default: null }, // 会员到期时间
  },
  { timestamps: true }
);

export default mongoose.model('MemberOrder', memberOrderSchema);
