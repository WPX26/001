/**
 * 手机互联 WebSocket 通道（api.md 8.10 节：/phonelink/ws）
 *
 * 端点：ws(s)://<host>/api/v1/phonelink/ws?code=XXXXXX&role=host|client
 * - host  = 被控端 A（装有 APP 的手机，Android 真系统相机 / iPhone APP 内相机页）
 * - client = 控制端 B（网页，只按快门）
 *
 * 职责（只做通道，不做业务）：
 * - 校验连接码（存在 + 未过期 + 未关闭）与角色，建立 1:1 房间
 * - 消息透传：任一端上行 { type, data } 原样转发对端（type=signal 信令 / command 快门等
 *   由业务层自定义；服务端保留 type=ping/pong/client_joined/host_ready/peer_left）
 * - 事件广播：client 连入 → host 收 client_joined；host 连入 → client 收 host_ready；
 *   任一端断开 → 对端收 peer_left；host 断开 → 配对置 closed（DB，异步容错）
 * - 心跳 30s ping/pong 探活（对齐 chat.ws），僵尸连接自动清理
 * - 同码同角色只允许一个连接：新连接顶掉旧连接（防止旧网页残留占用房间）
 *
 * 设计取舍：画面流（MJPEG/WebRTC）不走本通道（带宽/延迟不适合中转），
 * 由 host 端本地服务直连或二期 SRS 中转；本通道只承载命令与信令。
 */
import { WebSocketServer } from 'ws';
import { PhonelinkPair } from '../models/index.js';

/** WS 端点路径（对齐 api.md 8.10：/phonelink/ws，含 /api/v1 前缀） */
export const PHONELINK_WS_PATH = '/api/v1/phonelink/ws';

/** 心跳间隔：30 秒 */
const HEARTBEAT_MS = 30 * 1000;

/** 房间表：pairId -> { host, client }（值为 ws 实例，未连接时为 null） */
const rooms = new Map();

/**
 * 将 HTTP server 升级为支持 /phonelink/ws 的 WS 服务（在 server.js 的 app.listen 之后调用）
 * @param {import('node:http').Server} server
 */
export function attachPhonelinkWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== PHONELINK_WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, url));
  });

  // 心跳：30s 探活一次，无 pong 响应的连接直接清理
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

/** 连接处理：校验连接码与角色 → 入房间 → 事件绑定 */
async function handleConnection(ws, url) {
  const code = url.searchParams.get('code') || '';
  const role = url.searchParams.get('role') || '';
  if (!/^\d{6}$/.test(code) || !['host', 'client'].includes(role)) {
    ws.close(4001, 'invalid params');
    return;
  }

  let pair;
  try {
    pair = await PhonelinkPair.findOne({ code });
  } catch (e) {
    ws.close(4002, 'server error');
    return;
  }
  if (!pair) {
    ws.close(4003, 'code not found');
    return;
  }
  if (pair.status === 'closed') {
    ws.close(4004, 'pair closed');
    return;
  }

  const pairId = pair.pairId;
  ws.isAlive = true;
  ws.pairId = pairId;
  ws.role = role;

  // 入房间：同码同角色新连接顶掉旧连接
  let room = rooms.get(pairId);
  if (!room) {
    room = { host: null, client: null };
    rooms.set(pairId, room);
  }
  const prev = room[role];
  if (prev && prev.readyState === 1) {
    prev.close(4005, 'replaced by new connection');
  }
  room[role] = ws;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => handleMessage(ws, raw));
  ws.on('close', () => handleClose(ws, room, pairId));
  ws.on('error', () => { try { ws.close(); } catch (e) {} });

  // 配对完成事件广播（无论谁先到，双方在线即补发双方事件）：
  // host 收 client_joined（B 已连接）；client 收 host_ready（A 已就绪）
  const peer = role === 'host' ? room.client : room.host;
  if (peer && peer.readyState === 1) {
    if (role === 'host') {
      send(peer, { type: 'host_ready', data: { hostDevice: pair.hostDevice || '' } });
      send(ws, { type: 'client_joined', data: { clientLabel: pair.clientLabel || '' } });
    } else {
      send(ws, { type: 'host_ready', data: { hostDevice: pair.hostDevice || '' } });
      send(peer, { type: 'client_joined', data: { clientLabel: pair.clientLabel || '' } });
    }
  }
}

/** 消息透传：除 ping 外原样转发对端 */
function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (e) {
    return; // 非 JSON 丢弃
  }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ping') {
    send(ws, { type: 'pong' });
    return;
  }

  // 保留事件名由服务端生成，不允许两端冒充广播
  const reserved = ['pong', 'client_joined', 'host_ready', 'peer_left'];
  if (reserved.includes(msg.type)) return;

  const room = rooms.get(ws.pairId);
  if (!room) return;
  const peer = ws.role === 'host' ? room.client : room.host;
  if (peer && peer.readyState === 1) send(peer, msg);
}

/** 断开处理：通知对端；host 断开 → 配对置 closed */
function handleClose(ws, room, pairId) {
  if (room && room[ws.role] === ws) {
    room[ws.role] = null;
  }
  // host 断开 = 被控端退出 → 配对关闭（幂等更新，TTL 兜底）
  if (ws.role === 'host') {
    PhonelinkPair.updateOne(
      { pairId, status: { $ne: 'closed' } },
      { $set: { status: 'closed', closedAt: new Date() } }
    ).catch(() => {});
  }
  // 通知对端
  const peer = room ? (ws.role === 'host' ? room.client : room.host) : null;
  if (peer && peer.readyState === 1) {
    send(peer, { type: 'peer_left', data: { role: ws.role } });
  }
  // 房间空置清理
  if (room && !room.host && !room.client) {
    rooms.delete(pairId);
  }
}

/** 安全发送（连接已打开才发） */
function send(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}
