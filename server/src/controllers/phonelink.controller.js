/**
 * 手机互联控制器（2026-08-15 王总定稿 UI 后落地；api.md 8.10 节）
 * - POST /phonelink/pairs            被控端 A 创建配对（6 位连接码，10 分钟有效）
 * - POST /phonelink/pairs/join       控制端 B 输入连接码加入（匿名，IP 限频）
 * - GET  /phonelink/pairs/:code      查询配对状态（A 端轮询 / B 端确认）
 * - POST /phonelink/pairs/:code/close 被控端主动关闭（幂等）
 *
 * 设计取舍（为什么这样）：
 * - 码即凭证（匿名加入）：B 端是网页游客（不强制登录），6 位数字 + 10 分钟 TTL + 一次性
 *   加入（原子抢占）+ IP 限频，与 Zoom 会议码同模型；正式版如需更严可加 B 端登录（P2）
 * - 配对状态落 MongoDB（TTL 索引自动过期清理），WS 房间只存内存连接态（服务重启配对
 *   仍在但连接断开，A 端重新扫码/输码即可）
 * - 每用户同时只保留一个 pending 配对（重复创建先关旧的），防止连接码堆集
 */
import crypto from 'node:crypto';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCodeIpLimit } from '../middleware/rateLimit.js';
import { PhonelinkPair } from '../models/index.js';

/** 配对有效期：10 分钟（对齐模型 TTL 索引） */
const PAIR_TTL_MS = 10 * 60 * 1000;
/** 连接码位数：6 位数字 */
const CODE_LEN = 6;
/** 生成连接码去重重试上限 */
const CODE_GEN_MAX_TRIES = 5;

/** 生成 6 位数字连接码（重试避免与现有 pending 码冲突） */
async function genUniqueCode() {
  for (let i = 0; i < CODE_GEN_MAX_TRIES; i++) {
    const code = String(crypto.randomInt(0, 10 ** CODE_LEN)).padStart(CODE_LEN, '0');
    const exist = await PhonelinkPair.exists({ code });
    if (!exist) return code;
  }
  throw new AppError(ERR.SERVER, '连接码生成失败，请重试', 500);
}

/**
 * 创建配对（被控端 A，需登录）
 * 参数：hostDevice 设备名（可选，工作台顶栏展示，如「Mate 60 Pro」）
 */
export const createPair = asyncHandler(async (req, res) => {
  const hostDevice = String((req.body && req.body.hostDevice) || '').trim().slice(0, 30);
  const hostId = req.user._id;

  // 关闭该用户旧的 pending 配对（连接码不堆集）
  await PhonelinkPair.updateMany(
    { hostId, status: 'pending' },
    { $set: { status: 'closed', closedAt: new Date() } }
  );

  const pair = await PhonelinkPair.create({
    pairId: 'ph_' + crypto.randomBytes(5).toString('hex'),
    code: await genUniqueCode(),
    hostId,
    hostDevice,
    expiresAt: new Date(Date.now() + PAIR_TTL_MS),
  });

  ok(res, {
    pairId: pair.pairId,
    code: pair.code,
    hostDevice: pair.hostDevice,
    expiresAt: pair.expiresAt.toISOString(),
  });
});

/**
 * 加入配对（控制端 B 网页，匿名；IP 限频防枚举）
 * 参数：code 6 位连接码；clientLabel 设备标识（可选）
 */
export const joinPair = [
  sendCodeIpLimit,
  asyncHandler(async (req, res) => {
    const code = String((req.body && req.body.code) || '').trim();
    const clientLabel = String((req.body && req.body.clientLabel) || '').trim().slice(0, 30);
    if (!/^\d{6}$/.test(code)) {
      throw new AppError(ERR.VALIDATE, '连接码格式不正确：需为 6 位数字', 400);
    }

    // 先查存在性，区分「码不存在/已过期」与「已被加入」
    const exist = await PhonelinkPair.findOne({ code });
    if (!exist) {
      throw new AppError(ERR.NOT_FOUND, '连接码无效或已过期', 404);
    }
    if (exist.status === 'closed') {
      throw new AppError(ERR.NOT_FOUND, '配对已关闭，请让被控手机重新发起', 404);
    }
    if (exist.status !== 'pending') {
      throw new AppError(ERR.DUPLICATE, '该配对已被加入，请使用新的连接码', 409);
    }

    // 原子抢占：只有 status=pending 且未过期的记录能置为 joined（防并发重复加入）
    const joined = await PhonelinkPair.findOneAndUpdate(
      { code, status: 'pending', expiresAt: { $gt: new Date() } },
      { $set: { status: 'joined', joinedAt: new Date(), clientLabel } },
      { new: true }
    );
    if (!joined) {
      throw new AppError(ERR.DUPLICATE, '该配对已被加入或已过期，请使用新的连接码', 409);
    }

    ok(res, {
      pairId: joined.pairId,
      hostDevice: joined.hostDevice,
      status: joined.status,
    });
  }),
];

/** 查询配对状态（A 端轮询 / B 端确认；不泄露 hostId） */
export const getPair = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new AppError(ERR.VALIDATE, '连接码格式不正确：需为 6 位数字', 400);
  }
  const pair = await PhonelinkPair.findOne({ code });
  if (!pair) {
    throw new AppError(ERR.NOT_FOUND, '连接码无效或已过期', 404);
  }
  ok(res, {
    pairId: pair.pairId,
    status: pair.status,
    hostDevice: pair.hostDevice,
    expiresAt: pair.expiresAt.toISOString(),
  });
});

/** 被控端主动关闭配对（需登录且为配对创建者；幂等） */
export const closePair = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new AppError(ERR.VALIDATE, '连接码格式不正确：需为 6 位数字', 400);
  }
  const pair = await PhonelinkPair.findOne({ code });
  if (!pair) {
    // 已过期被 TTL 清理：视为已关闭，幂等返回
    ok(res, { pairId: null, status: 'closed' });
    return;
  }
  if (!pair.hostId.equals(req.user._id)) {
    throw new AppError(ERR.FORBIDDEN, '只有配对创建者可以关闭', 403);
  }
  if (pair.status !== 'closed') {
    await PhonelinkPair.updateOne(
      { _id: pair._id },
      { $set: { status: 'closed', closedAt: new Date() } }
    );
  }
  ok(res, { pairId: pair.pairId, status: 'closed' });
});
