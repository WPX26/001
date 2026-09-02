/**
 * 全局常量：业务错误码（对齐 api.md 附录 B）
 *
 * | HTTP | errcode | 说明 |
 * |------|---------|------|
 * | 200  | 0       | 成功 |
 * | 400  | 1001    | 参数校验失败 |
 * | 401  | 1002    | Token 过期或无效 |
 * | 403  | 1003    | 权限不足 |
 * | 404  | 1004    | 资源不存在 |
 * | 409  | 1005    | 重复操作 |
 * | 429  | 1006    | 请求频率超限 |
 * | 500  | 9999    | 服务器内部错误 |
 *
 * 扩展（api.md 未占用，用于外部服务未配置时的明确提示）：
 * | 503  | 1007    | 外部服务配置缺失（短信/OSS 密钥未配置）|
 */
export const ERR = {
  OK: 0,
  VALIDATE: 1001, // 参数校验失败
  AUTH: 1002, // Token 过期或无效
  FORBIDDEN: 1003, // 权限不足
  NOT_FOUND: 1004, // 资源不存在
  DUPLICATE: 1005, // 重复操作（已关注/已点赞等）
  RATE_LIMIT: 1006, // 请求频率超限
  SERVICE_CONFIG: 1007, // 外部服务配置缺失（扩展码）
  SERVER: 9999, // 服务器内部错误
};

/** 用户模式：life 生活（进灵感池）/ work 工作（进探索池） */
export const USER_MODE = { LIFE: 'life', WORK: 'work' };

/** 短信验证码场景 */
export const SMS_SCENE = { LOGIN: 'login', REGISTER: 'register' };

/** 地图聚合网格粒度（度）：level 1 粗 / 2 中 / 3 细 */
export const GRID_SIZE_BY_LEVEL = { 1: 0.05, 2: 0.02, 3: 0.01 };

/** 通知类型（对齐 api.md 14.1 表 + reply/collect 扩展，与 Notification.type 枚举一致） */
export const NOTIFICATION_TYPE = {
  LIKE: 'like', // 有人赞了你的照片
  COMMENT: 'comment', // 有人评论了你的照片
  REPLY: 'reply', // 有人回复了你的评论
  TIP: 'tip', // 收到了打赏
  COLLECT: 'collect', // 有人收藏了你的照片
  FOLLOW: 'follow', // 有人关注了你
  SYSTEM: 'system', // 系统通知
  CHAT: 'chat', // 收到了新私信
};

/** 打赏限频：同一用户同一照片 60 秒内最多一次 */
export const TIP_MIN_INTERVAL_MS = 60 * 1000;

/** 地图标记颜色：按模式区分 */
export const MARKER_COLOR = {
  normal: '#2196F3', // 默认蓝
  inspire: '#E53935', // 灵感红
  explore: '#7B1FA2', // 探索紫蓝
};

/** 会员月卡套餐（王总定稿：仅 ¥6/月，订阅即认证摄影师，半自动人工确认支付） */
export const MEMBER_PLAN = {
  planId: 'plan_pro_monthly',
  planName: '高级会员',
  amount: 600, // 分（¥6）
  period: 'month',
  days: 30, // 激活后有效天数（续费顺延 30 天）
  benefits: ['订阅即认证摄影师', '作品进入探索池展示', '照片上传不限量', '高清原图保存'],
};

/** 坐标置顶套餐（王总 2026-08 定稿：¥6/7天，探索模式三赛道付费席，半自动人工确认支付） */
export const BOOST_PLAN = {
  planId: 'boost_coord_7d',
  planName: '坐标置顶·7天',
  amount: 600, // 分（¥6）
  period: 'week',
  days: 7,
};

/** 会员订单超时未确认（pending_confirm）的惰性过期时长：48 小时 */
export const MEMBER_PENDING_EXPIRE_MS = 48 * 3600 * 1000;
