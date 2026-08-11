/**
 * 环境变量加载与统一配置出口
 * 所有配置从这里读取，禁止在业务代码中直接访问 process.env
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** server 根目录（server/） */
export const SERVER_ROOT = path.resolve(__dirname, '../..');
/** 本地存储模式的上传目录 */
export const UPLOAD_DIR = path.join(SERVER_ROOT, 'uploads');

// 显式指定 .env 路径，保证从任意 cwd 启动都能正确加载
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const str = (k, def = '') => process.env[k] ?? def;
const num = (k, def) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const env = {
  NODE_ENV: str('NODE_ENV', 'development'),
  PORT: num('PORT', 3000),
  isProd: process.env.NODE_ENV === 'production',

  MONGODB_URI: str('MONGODB_URI', 'mongodb://127.0.0.1:27017/memomap'),

  JWT_SECRET: str('JWT_SECRET', ''),
  JWT_ACCESS_EXPIRES: num('JWT_ACCESS_EXPIRES', 86400), // 秒
  JWT_REFRESH_EXPIRES: num('JWT_REFRESH_EXPIRES', 2592000), // 秒

  SMS_CODE_EXPIRE_SECONDS: num('SMS_CODE_EXPIRE_SECONDS', 300),
  SMS_SEND_INTERVAL_SECONDS: num('SMS_SEND_INTERVAL_SECONDS', 60),
  /** 开发模式：不调用真实短信，验证码直接返回给客户端（联调用，生产必须关闭） */
  SMS_DEV_MODE: str('SMS_DEV_MODE') === 'true',
  /** 阿里云短信配置（密钥未提供时为空，send-code 返回明确错误） */
  ALIYUN_SMS: {
    accessKeyId: str('ALIYUN_SMS_ACCESS_KEY_ID'),
    accessKeySecret: str('ALIYUN_SMS_ACCESS_KEY_SECRET'),
    signName: str('ALIYUN_SMS_SIGN_NAME'),
    templateCode: str('ALIYUN_SMS_TEMPLATE_CODE'),
  },

  /** 存储模式：local 本地磁盘（开发）/ oss 阿里云 OSS（生产） */
  STORAGE_MODE: str('STORAGE_MODE', 'local').toLowerCase(),
  LOCAL_BASE_URL: str('LOCAL_BASE_URL', 'http://localhost:3000'),
  /** 阿里云 OSS / STS 配置 */
  OSS: {
    region: str('OSS_REGION'),
    bucket: str('OSS_BUCKET'),
    roleArn: str('OSS_ROLE_ARN'),
    roleSessionName: str('OSS_ROLE_SESSION_NAME', 'memomap-upload'),
    accessKeyId: str('OSS_ACCESS_KEY_ID'),
    accessKeySecret: str('OSS_ACCESS_KEY_SECRET'),
  },

  /** 天地图 Key（地名搜索/地理编码，见 .env.example 说明；未配置时地图搜索降级为空结果） */
  TDT_KEY: str('TDT_KEY', ''),

  /** 管理端登录密码（未配置时管理端接口返回 503/1007） */
  ADMIN_PASSWORD: str('ADMIN_PASSWORD', ''),
  /**
   * 收款码图片地址（会员下单时展示给用户扫码付款）
   * 默认指向本地静态托管的占位图（LOCAL_BASE_URL + /uploads/pay-qrcode.png）；
   * .env 中显式置空视为"未配置"，会员下单返回 503/1007
   */
  PAY_QRCODE_URL: str(
    'PAY_QRCODE_URL',
    `${str('LOCAL_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '')}/uploads/pay-qrcode.png`
  ),
};

// 开发环境使用默认 JWT 密钥时给出警告（生产环境强制要求显式配置）
if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
  console.warn('[警告] .env 未配置 JWT_SECRET 或过短，正在使用不安全默认值，生产环境必须配置！');
  env.JWT_SECRET = 'dev-only-insecure-secret';
}

export default env;
