/**
 * logger 冒烟验证脚本（node scripts/logger-smoke.js）
 *
 * 验证点：
 * 1. trace/debug 直接丢弃：不打印 console、不写入 SQLite（默认 LOG_LEVEL=info）
 * 2. info/warn/error/fatal 入库且级别正确
 * 3. flushSync 落盘后进程退出
 *
 * 说明：使用独立冒烟库 logs-smoke.db，避免污染真实 logs.db；
 * 脚本退出后由外部清理（进程运行中 SQLite 文件被占用，Windows 下无法删除）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// 必须在 import logger 之前设置（logger 模块加载时读取）
const SMOKE_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/logs-smoke.db');
process.env.LOG_DB_PATH = SMOKE_DB;

const logger = (await import('../src/utils/logger.js')).default;

// ---- 捕获 console，断言 trace/debug 不出现在输出里 ----
const captured = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...a) => captured.push(['log', a.join(' ')]);
console.warn = (...a) => captured.push(['warn', a.join(' ')]);
console.error = (...a) => captured.push(['error', a.join(' ')]);

logger.trace('TRACE_SMOKE_MSG 本行应被丢弃');
logger.debug('DEBUG_SMOKE_MSG 本行应被丢弃');
logger.info('INFO_SMOKE_MSG 本行应入库', { source: 'smoke' }); // 对象 context：应 JSON 序列化入库
logger.warn('WARN_SMOKE_MSG 本行应入库', 'string-context');
logger.error('ERROR_SMOKE_MSG 本行应入库');
logger.fatal('FATAL_SMOKE_MSG 本行应入库');

// 同步落盘，保证查询结果确定
logger.flushSync();

console.log = origLog;
console.warn = origWarn;
console.error = origError;

// ---- 断言 1：console 输出无 trace/debug ----
const allOut = captured.map(([, s]) => s).join('\n');
const consoleOk =
  !allOut.includes('TRACE_SMOKE_MSG') &&
  !allOut.includes('DEBUG_SMOKE_MSG') &&
  allOut.includes('INFO_SMOKE_MSG') &&
  allOut.includes('WARN_SMOKE_MSG') &&
  allOut.includes('ERROR_SMOKE_MSG') &&
  allOut.includes('FATAL_SMOKE_MSG');

// ---- 断言 2：SQLite 落库断言 ----
const db = new DatabaseSync(SMOKE_DB);
const rows = db.prepare('SELECT level, message, context FROM logs ORDER BY id').all();
db.close();

const byMsg = Object.fromEntries(rows.map((r) => [r.message.split(' ')[0], r]));
const dbOk =
  !('TRACE_SMOKE_MSG' in byMsg) &&
  !('DEBUG_SMOKE_MSG' in byMsg) &&
  byMsg.INFO_SMOKE_MSG.level === 'info' &&
  byMsg.WARN_SMOKE_MSG.level === 'warn' &&
  byMsg.ERROR_SMOKE_MSG.level === 'error' &&
  byMsg.FATAL_SMOKE_MSG.level === 'fatal' &&
  rows.length === 4 &&
  byMsg.INFO_SMOKE_MSG.context === '{"source":"smoke"}' && // 对象 context 序列化
  byMsg.WARN_SMOKE_MSG.context === 'string-context'; // 字符串 context 原样

// ---- 汇总输出 ----
console.log('\n===== logger smoke 结果 =====');
console.log('console 输出无 trace/debug 字样:', consoleOk ? 'PASS' : 'FAIL');
console.log('SQLite 落库断言（仅 4 条，级别正确）:', dbOk ? 'PASS' : 'FAIL');
console.log('入库行:', JSON.stringify(rows, null, 2));
if (!consoleOk || !dbOk) {
  console.error('冒烟验证失败！');
  process.exit(1);
}
console.log('冒烟验证全部通过');
