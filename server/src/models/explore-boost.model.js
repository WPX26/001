/**
 * 探索坐标置顶记录（王总 2026-08-31 定稿：周卡7元/7天(2026-09-02 由6元改)、月卡60元/30天，持卡期间不可叠加再买）
 * - 每条 = 一位作者在某坐标的一次付费席位（管理端确认付款后写入）
 * - 排位赛：start（确认时刻）倒序 = 后买靠前（王总定案 C>B>A）
 * - 续买顺延：until = max(now, 原until) + 7天，start 刷新为确认时刻（新购买排前）
 * - 探索池过滤只读此表：作品/坐标数据永不改动
 */
import mongoose from 'mongoose';

const exploreBoostSchema = new mongoose.Schema(
  {
    coordKey: { type: String, required: true, index: true }, // 坐标标题（Coord.title）
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: String, required: true, index: true }, // 关联 MemberOrder.orderId
    tier: { type: String, enum: ['week', 'month'], default: 'week' }, // 席位档位（三层排序：月卡层>周卡层>免费层）
    start: { type: Date, required: true }, // 席位起始（=最近一次确认时刻，排位赛依据）
    until: { type: Date, required: true, index: true }, // 席位到期
    status: { type: String, enum: ['active'], default: 'active' },
  },
  { timestamps: true, versionKey: false }
);

// 同一作者同一坐标一条有效席位（续买走顺延，不新建）
exploreBoostSchema.index({ coordKey: 1, authorId: 1 }, { unique: true });

export default mongoose.model('ExploreBoost', exploreBoostSchema);
