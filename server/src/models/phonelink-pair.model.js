/**
 * 手机互联配对模型（2026-08-15 王总定稿 UI 后的后端落地）
 *
 * 产品规则（对齐手机互联 UI：扫码连接 / 局域网直连 两种入口，控制端 B 网页只按快门）：
 * - 被控端 A（装了 APP 的 Android/iPhone）创建配对 → 获得 6 位数字连接码（10 分钟有效）
 * - 控制端 B（网页）输入连接码（或扫码等价输入）加入配对 → 建立 1:1 通道（WS 房间）
 * - 码即凭证：6 位数字 + 10 分钟 TTL + 一次性加入（joined 后 join 不可再入）
 * - 状态机：pending（待加入）→ joined（已配对）→ closed（A 主动断开）；TTL 到期自动过期删除
 * - 连接码不绑定账号：B 端匿名可入（产品上知道码即可控制 A 的快门，与 Zoom 会议码同模型）
 * - hostId 记 A 端账号（创建者）；hostDevice 记 A 端设备名（UI 工作台顶栏展示用）
 */
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

const phonelinkPairSchema = new Schema(
  {
    // 配对 ID（ph_ + 10 位随机，REST 返回给两端）
    pairId: { type: String, required: true, unique: true },
    // 6 位数字连接码（唯一索引；创建侧生成时去重）
    code: { type: String, required: true, unique: true },
    // 被控端账号（创建者；B 端匿名不落库）
    hostId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    // 被控端设备名（UI 工作台顶栏「被控手机 · Android」展示）
    hostDevice: { type: String, trim: true, maxlength: 30, default: '' },
    // 配对状态：pending 待加入 / joined 已配对 / closed 被控端关闭
    status: { type: String, enum: ['pending', 'joined', 'closed'], default: 'pending', index: true },
    // B 端加入信息（匿名，仅记设备标识与时间）
    clientLabel: { type: String, trim: true, maxlength: 30, default: '' },
    joinedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    // 有效期：10 分钟；TTL 索引到期自动删除（无论状态）
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL 索引：连接码到期自动清理（MongoDB 后台线程每分钟扫描一次）
phonelinkPairSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PhonelinkPair', phonelinkPairSchema);
