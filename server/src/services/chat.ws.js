/**
 * 私信 WebSocket 服务（api.md 附录 A：/chat/ws new_message 实时推送，P1 接口，最后一批）
 *
 * 实现要点：
 * - 端点：ws(s)://<host>/api/v1/chat/ws?token=<access token>（query 传 token，JWT 校验）
 * - 在线表：Map<userId(String), Set<ws>>；同一用户多连接（多设备/多标签页）全部广播
 * - 推送入口：chat.controller 发消息后调用 pushToUser(peerId, {type:'new_message', data})
 * - 心跳：30s ping/pong 探活，僵尸连接自动清理
 * - 客户端上行暂只处理 ping（保活）；typing 等上行事件 P2 扩展
 */
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { User } from '../models/index.js';

/** WS 端点路径（对齐 api.md 附录 A /chat/ws，含 /api/v1 前缀） */
export const CHAT_WS_PATH = '/api/v1/chat/ws';

/** 心跳间隔：30 秒 */
const HEARTBEAT_MS = 30 * 1000;

/** 在线连接表：userId(String) -> Set<ws>（同用户多连接） */
const online = new Map();

/**
 * 将 HTTP server 升级为支持 /chat/ws 的 WS 服务（在 server.js 的 app.listen 之后调用）
 * @param {import('node:http').Server} server
 */
export function attachChatWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // 只接管聊天端点，其余升级请求（未来 tether/notifications ws）不受影响
    if (url.pathname !== CHAT_WS_PATH) return;
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

/** 连接处理：JWT 鉴权（access token + 用户真实存在）→ 注册在线表 → 事件绑定 */
async function handleConnection(ws, url) {
  const token = url.searchParams.get('token') || '';

  let uid = null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.type !== 'access' || !payload.uid) throw new Error('token type error');
    const user = await User.findById(payload.uid).select('_id').lean();
    if (!user) throw new Error('user not found');
    uid = String(user._id);
  } catch {
    ws.close(4001, 'unauthorized');
    return;
  }

  ws.userId = uid;
  ws.isAlive = true;
  let set = online.get(uid);
  if (!set) {
    set = new Set();
    online.set(uid, set);
  }
  set.add(ws);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // 客户端上行：当前仅处理 ping 保活（其余事件留 P2，如 typing）
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch {
      // 非 JSON 上行忽略
    }
  });

  ws.on('close', () => {
    const socks = online.get(uid);
    if (socks) {
      socks.delete(ws);
      if (socks.size === 0) online.delete(uid);
    }
  });

  ws.on('error', () => {
    /* 连接错误由 close 清理在线表 */
  });
}

/**
 * 推送给某用户的全部在线连接（多连接广播）
 * @param {string|ObjectId} userId 接收人
 * @param {object} payload 事件对象，序列化为 { type, data }
 * @returns {boolean} 是否至少推送到一个在线连接
 */
export function pushToUser(userId, payload) {
  const socks = online.get(String(userId));
  if (!socks || socks.size === 0) return false;
  const data = JSON.stringify(payload);
  let sent = 0;
  for (const ws of socks) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      sent += 1;
    }
  }
  return sent > 0;
}

/** 在线用户数（冒烟测试/监控用） */
export function onlineUserCount() {
  return online.size;
}
