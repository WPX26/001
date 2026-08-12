/**
 * 全局环境配置
 * 通过 .env.development / .env.production 注入（vite import.meta.env.VITE_*）
 * 默认值直接指向线上域名（HBuilderX 云打包为 production 构建，兜底保证连通）
 */
const SITE = 'https://dsofatjxxjyf.sealoshzh.site'

const DEFAULT_API_BASE = SITE + '/api/v1'
const DEFAULT_MEMO_HOME_URL = SITE + '/memo-home.html'
const DEFAULT_ALBUM_URL = SITE + '/album-prototype.html'
const DEFAULT_MESSAGE_URL = SITE + '/message-prototype.html'
const DEFAULT_PROFILE_URL = SITE + '/profile-prototype.html'
const DEFAULT_CONNECT_URL = SITE + '/connect-prototype.html'
const DEFAULT_LOGIN_URL = SITE + '/login-prototype.html'
const DEFAULT_REGISTER_URL = SITE + '/register-prototype.html'
const DEFAULT_SUBSCRIBE_URL = SITE + '/photographer-payment.html'

/** 后端 API 基址（已含 /api/v1 前缀），与 Web 端 api.js 的 BASE_URL 语义一致 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE || DEFAULT_API_BASE

/** 主地图 web-view 页面地址（memo-home.html 云端部署） */
export const MEMO_HOME_URL = import.meta.env.VITE_MEMO_HOME_URL || DEFAULT_MEMO_HOME_URL

/** 各原型页 web-view 地址（App 内 1:1 嵌入对应原型） */
export const ALBUM_URL = import.meta.env.VITE_ALBUM_URL || DEFAULT_ALBUM_URL
export const MESSAGE_URL = import.meta.env.VITE_MESSAGE_URL || DEFAULT_MESSAGE_URL
export const PROFILE_URL = import.meta.env.VITE_PROFILE_URL || DEFAULT_PROFILE_URL
export const CONNECT_URL = import.meta.env.VITE_CONNECT_URL || DEFAULT_CONNECT_URL
export const LOGIN_URL = import.meta.env.VITE_LOGIN_URL || DEFAULT_LOGIN_URL
export const REGISTER_URL = import.meta.env.VITE_REGISTER_URL || DEFAULT_REGISTER_URL
export const SUBSCRIBE_URL = import.meta.env.VITE_SUBSCRIBE_URL || DEFAULT_SUBSCRIBE_URL

/** 存储键（与 Web 端 localStorage 键名一致，便于跨端迁移） */
export const TOKEN_KEY = 'memo_token'
export const USER_KEY = 'memo_user'
