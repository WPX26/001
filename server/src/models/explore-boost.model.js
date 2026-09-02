/**
 * 探索坐标置顶席位模型（王总 2026-08 定稿：三赛道付费席）
 * - 管理端确认置顶订单后生成/顺延一条席位：start=确认时刻、until=席位到期
 * - 同作者同坐标再次购买 → until 自 max(now, 原until) 顺延 7 天，start 刷新为本次确认时刻
 *   （「后买靠前」的排位赛语义由 start 承载，排序端只读 start/until）
 * - 排序端（memo-home showExplorePopup / exploreCoords 注入）只读本集合，不写
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const exploreBoostSchema = new Schema(
  {
    // 坐标键（与前端 photoData 坐标标题 / Coord.title 对齐）
    coordKey: { type: String, required: true, index: true },
    authorId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: String, required: true, index: true },
    start: { type: Date, required: true },
    until: { type: Date, required: true, index: true },
    status: { type: String, enum: ['active'], default: 'active' },
  },
  { timestamps: true }
);
exploreBoostSchema.index({ coordKey: 1, authorId: 1 }, { unique: true });

export default mongoose.model('ExploreBoost', exploreBoostSchema);
