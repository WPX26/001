/**
 * 照片模型
 * 对应 api.md 第 6/7/13 章：clientPhotoId 幂等、坐标归属、互动（点赞/打赏/收藏）、EXIF、软删除
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const photoSchema = new Schema(
  {
    // 幂等键：上传回调的 hash（同一文件重复回调不会产生重复照片）
    clientPhotoId: { type: String, unique: true, index: true },
    // 归属坐标（上传回调时为空，创建坐标时关联）
    coordId: { type: Types.ObjectId, ref: 'Coord', default: null, index: true },
    authorId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    imageUrl: { type: String, required: true },
    thumbnailUrl: { type: String, default: '' },
    // 拍摄时间（由坐标 photoTimes 回填）
    takenAt: { type: Date, default: null },
    uploadTime: { type: Date, default: Date.now, index: true },
    // 互动计数（冗余）+ 互动人数组（P0 用数组即可，量大后可拆互动表）
    likes: { type: Number, default: 0 },
    tips: { type: Number, default: 0 },
    collects: { type: Number, default: 0 }, // 收藏数
    likedBy: [{ type: Types.ObjectId, ref: 'User' }],
    tippedBy: [{ type: Types.ObjectId, ref: 'User' }],
    collectedBy: [{ type: Types.ObjectId, ref: 'User' }],
    // 联机拍摄时应用的色彩预设（api.md 8.7）
    filterApplied: { type: String, default: '' },
    // EXIF：iso/aperture/shutter/wb（对齐 api.md 3.3 字段）
    exif: {
      _id: false,
      iso: { type: Number, default: null },
      aperture: { type: String, default: '' },
      shutter: { type: String, default: '' },
      wb: { type: String, default: '' },
    },
    // 定位来源：exif 读取 / 手动指定 / 联机拍摄 / 无
    gpsSource: { type: String, enum: ['exif', 'manual', 'tether', 'none'], default: 'none' },
    // 文件信息（回调上报）
    size: { type: Number, default: 0 },
    hash: { type: String, default: '' },
    // 软删除标记
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// 作者相册/坐标照片查询常用索引
photoSchema.index({ authorId: 1, deletedAt: 1, uploadTime: -1 });
photoSchema.index({ coordId: 1, deletedAt: 1, takenAt: -1 });

export default mongoose.model('Photo', photoSchema);
