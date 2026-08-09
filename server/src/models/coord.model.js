/**
 * 坐标模型（地图上的一个地点，聚合多张照片）
 * 对应 api.md 第 3 章：title/lng/lat/authorId/isPublic/photoTimes/gridKey，软删除
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const coordSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 50 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    lat: { type: Number, required: true, min: -90, max: 90 },
    authorId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    // 是否公开到灵感/探索模式
    isPublic: { type: Boolean, default: true },
    // life 生活（灵感池）/ work 工作（探索池）
    mode: { type: String, enum: ['life', 'work'], default: 'life' },
    // 每张照片的拍摄时间 { photoId: "2026-08-04T15:30:00Z" }（api.md 7.2）
    photoTimes: { type: Map, of: Date, default: {} },
    // 冗余照片数（列表/卡片直接使用）
    photoCount: { type: Number, default: 0 },
    // 0.01° 网格键，用于地图聚合（写入时按坐标计算）
    gridKey: { type: String, index: true },
    // 收藏该坐标的用户（灵感模式收藏，api.md 4.2）
    collectedBy: [{ type: Types.ObjectId, ref: 'User' }],
    // 软删除标记（回收站 30 天内可恢复）
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// 地图视窗范围查询索引（bbox 查询 lng/lat 区间）
coordSchema.index({ lng: 1, lat: 1 });
// 地图聚合常用过滤条件
coordSchema.index({ isPublic: 1, mode: 1, deletedAt: 1 });

export default mongoose.model('Coord', coordSchema);
