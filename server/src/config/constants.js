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

/** 地图标记颜色：按模式区分 */
export const MARKER_COLOR = {
  normal: '#2196F3', // 默认蓝
  inspire: '#E53935', // 灵感红
  explore: '#7B1FA2', // 探索紫蓝
};
