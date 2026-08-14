/**
 * 统一日志模块：分级 + SQLite 落库 + console 镜像
 *
 * 级别（数字越小越详细）：trace(0) < debug(1) < info(2) < warn(3) < error(4) < fatal(5)
 * - trace/debug 直接丢弃：不打印 console、不写入 SQLite（硬性要求）
 * - info 及以上：写入 SQLite（默认 server/data/logs.db），并镜像到 console
 *   （log→stdout，warn/error/fatal→stderr，保持「[标签] 」前缀风格）
 *
 * 存储设计：
 * - 内置 node:sqlite 的 DatabaseSync（Node ≥22.13 免 flag），不引入第三方 SQLite 包
 * - 内存队列 + setInterval 每 1 秒批量 flush（事务 + prepared statement 批量插入）
 * - 进程退出前调用 logger.flushSync() 兜底（见 server.js shutdown）
 * - flush 时顺带删除超过 LOG_RETENTION_DAYS（默认 7）的旧日志
 * - PRAGMA journal_mode=WAL 提高并发（会生成 -wal/-shm 文件，属正常现象，勿删除）
 * - SQLite 写入失败静默降级：仅 console 记一条错误，进程不崩溃
 *
 * 注意：本模块不 import ./env.js（env.js 加载更早，避免循环依赖），
 * 配置直接读 process.env：LOG_DB_PATH / LOG_LEVEL / LOG_RETENTION_DAYS
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 级别表：数值越小越详细 */
const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

// 日志库路径：默认 <server根>/data/logs.db，可用 LOG_DB_PATH 覆盖
const DB_PATH = process.env.LOG_DB_PATH || path.join(__dirname, '../..', 'data', 'logs.db');
// 最低入库级别（默认 info：trace/debug 直接丢弃；可调 debug 排查，但默认必须 info）
let minLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
// 日志保留天数（默认 7 天）
const retentionMs = (Number(process.env.LOG_RETENTION_DAYS) || 7) * 24 * 3600 * 1000;

/** 待入库内存队列 */
let queue = [];

// --- SQLite 初始化（打开失败静默降级：仅 console 输出，不阻断进程） ---
let db = null;
let insertStmt = null;
let deleteStmt = null;
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  // WAL 模式提高并发；失败则退回默认 journal 模式（只影响并发性能，不影响使用）
  try {
    db.exec('PRAGMA journal_mode=WAL');
  } catch {
    /* 忽略 */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_level_time ON logs(level, created_at)');
  insertStmt = db.prepare('INSERT INTO logs (level, message, context, created_at) VALUES (?, ?, ?, ?)');
  deleteStmt = db.prepare('DELETE FROM logs WHERE created_at < ?');
} catch (err) {
  db = null;
  // 日志库不可用：console 直出记一条（不再走队列），后续所有日志仅 console 输出
  console.error(`[Logger] SQLite 日志库初始化失败（仅保留 console 输出）：${DB_PATH}`, err.message);
}

/** 调整最低入库级别（默认 info；调成 debug 可排查，trace 仍丢弃） */
export function setLevel(level) {
  minLevel = LEVELS[level] ?? minLevel;
}

/**
 * 一次性落盘（进程退出前兜底；写入失败静默降级，不影响 console）
 * 批次 + 事务 + prepared statement；顺带执行保留策略清理
 */
function flushSync() {
  if (!db || queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    db.exec('BEGIN');
    try {
      for (const row of batch) {
        insertStmt.run(row.level, row.message, row.context ?? null, row.created_at);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // 保留策略：删除超过保留天数的旧日志
    deleteStmt.run(Date.now() - retentionMs);
  } catch (err) {
    // 静默降级：console 输出不受影响，进程不崩溃，error 级别记一次
    console.error('[Logger] SQLite 日志写入失败（已降级）：', err.message);
  }
}

/** 镜像到 console：log→stdout，warn/error/fatal→stderr */
function mirror(level, message) {
  if (level === 'warn') console.warn(message);
  else if (level === 'error' || level === 'fatal') console.error(message);
  else console.log(message);
}

/**
 * context 归一化：node:sqlite 只能绑定 null/数字/字符串，对象需 JSON 序列化
 * （如 morgan 传入 { source: 'http' }）
 */
function normalizeContext(context) {
  if (context == null) return null;
  if (typeof context === 'string') return context;
  try {
    return JSON.stringify(context);
  } catch {
    return String(context);
  }
}

/** 统一写入入口：低于 minLevel 的级别直接丢弃（默认 trace/debug 不入库不打印） */
function write(level, message, context) {
  if (LEVELS[level] < minLevel) return; // trace/debug 直接丢弃
  const msg = String(message);
  queue.push({ level, message: msg, context: normalizeContext(context), created_at: Date.now() });
  mirror(level, msg);
}

// 每 1 秒批量 flush 一次；unref 让定时器不阻断进程退出（退出前由 flushSync 兜底）
setInterval(flushSync, 1000).unref();

const logger = {
  trace: (message, context) => write('trace', message, context),
  debug: (message, context) => write('debug', message, context),
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
  fatal: (message, context) => write('fatal', message, context),
  flushSync,
  setLevel,
};

export default logger;
