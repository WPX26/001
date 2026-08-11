/**
 * 全局环境配置
 * 通过 .env.development / .env.production 注入（vite import.meta.env.VITE_*）
 */
const DEFAULT_API_BASE = 'http://localhost:3000/api/v1'
const DEFAULT_MEMO_HOME_URL = 'https://dsofatjxxjyf.sealoshzh.site/memo-home.html'

/** 后端 API 基址（已含 /api/v1 前缀），与 Web 端 api.js 的 BASE_URL 语义一致 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE || DEFAULT_API_BASE

/** 主地图 web-view 页面地址（memo-home.html 云端部署） */
export const MEMO_HOME_URL = import.meta.env.VITE_MEMO_HOME_URL || DEFAULT_MEMO_HOME_URL

/** 存储键（与 Web 端 localStorage 键名一致，便于跨端迁移） */
export const TOKEN_KEY = 'memo_token'
export const USER_KEY = 'memo_user'
