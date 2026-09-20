/**
 * 雷达位置模型（2026-09-20 雷达一期）
 * 摄影师实时位置：每人一条（upsert 覆盖），供雷达模式查询
 * 语义：只存「最后位置＋上报时间」，不做位置历史；超过心跳窗口（60 秒）未更新视为离线
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const radarLocationSchema = new Schema(
  {
    // 上报用户（唯一：一人一条，随上报覆盖）
    userId: { type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    lng: { type: Number, required: true, min: -180, max: 180 },
    lat: { type: Number, required: true, min: -90, max: 90 },
    // 定位精度（米，GPS/网络定位误差估计）
    accuracy: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// 经纬度联合索引（bbox 预过滤，对齐 coord 的 {lng:1,lat:1} 风格）
radarLocationSchema.index({ lng: 1, lat: 1 });
// 心跳查询索引（按最后上报时间过滤在线）
radarLocationSchema.index({ updatedAt: -1 });

export default mongoose.model('RadarLocation', radarLocationSchema);
