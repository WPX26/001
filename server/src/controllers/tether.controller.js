/**
 * 相机互联控制器（2026-08-15 去模拟化：真实检测，不假装连接；api.md 8.1-8.3）
 * - POST /tether/detect      真实 SSDP 扫描局域网相机（云端执行返回空列表为真实结果）
 * - POST /tether/connect     连接检测到的相机（无相机/未检测到 → 真实 404）
 * - POST /tether/disconnect  断开（幂等）
 *
 * 诚实边界（为什么这样设计）：
 * - 浏览器无 UDP/裸 TCP 能力、相机 HTTP API 有 CORS 限制——H5 端无法直连专业相机；
 *   相机直连协议（PTP/IP、Sony/Canon HTTP API）由被控手机原生插件执行（二期），
 *   本模块先实现真实扫描与会话管理，前端接入真实空态（未检测到相机 → 引导/重试）
 * - capability=cloud 明确告知前端：检测发生在云端，非手机端局域网
 * - 会话（liveview/capture/settings）依赖真实相机连接，检测到相机后由二期原生
 *   通道接管；当前无相机时 connect 返回真实错误，前端不进入模拟工作台
 */
import crypto from 'node:crypto';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { scanCameras } from '../services/tether.scan.js';

/** 内存会话表：sessionId -> { cameraId, ip, vendor, connectedAt }（重启即失效，相机连接态本就不跨进程） */
const sessions = new Map();

/** 8.1 检测可用相机：真实 SSDP 扫描 */
export const detect = asyncHandler(async (req, res) => {
  const type = String((req.body && req.body.type) || 'wireless').trim();
  if (!['wired', 'wireless'].includes(type)) {
    throw new AppError(ERR.VALIDATE, 'type 需为 wired 或 wireless', 400);
  }
  const cameras = await scanCameras();
  ok(res, {
    cameras,
    capability: 'cloud', // 诚实标注：检测由云端执行（用户局域网相机需手机端原生能力，二期）
    scannedAt: new Date().toISOString(),
  });
});

/** 8.2 连接相机：仅能连接本次检测到的相机 */
export const connect = asyncHandler(async (req, res) => {
  const cameraId = String((req.body && req.body.cameraId) || '').trim();
  const connectionType = String((req.body && req.body.connectionType) || 'wireless').trim();
  if (!cameraId) {
    throw new AppError(ERR.VALIDATE, 'cameraId 不能为空', 400);
  }
  // 实时扫描确认相机仍在线（不信任前端传入的伪造 ID）
  const cameras = await scanCameras();
  const cam = cameras.find((c) => c.id === cameraId);
  if (!cam) {
    throw new AppError(ERR.NOT_FOUND, '未检测到该相机：请确认相机已开机并开启 WiFi 直连，再重新检测', 404);
  }
  const sessionId = 'sess_' + crypto.randomBytes(4).toString('hex');
  sessions.set(sessionId, {
    sessionId,
    cameraId: cam.id,
    model: cam.model,
    vendor: cam.vendor,
    ip: cam.ip,
    connectionType,
    connectedAt: new Date(),
  });
  ok(res, { sessionId, status: 'connected', camera: { model: cam.model, vendor: cam.vendor, ip: cam.ip } });
});

/** 8.3 断开相机（幂等） */
export const disconnect = asyncHandler(async (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || '').trim();
  if (sessionId) sessions.delete(sessionId);
  ok(res, { status: 'disconnected' });
});
