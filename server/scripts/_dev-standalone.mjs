/**
 * 本地联调独立后端（内存 Mongo，端口 8082）——只为前端私信 E2E，不碰生产库
 * 用法：node scripts/_dev-standalone.js   （测试完 Ctrl+C 或被 job_kill）
 * 启动后打印 JSON：{ port, users:[{id,phone,nickname,token}] , conversationId }
 */
process.env.MONGODB_URI = ''; // 占位，下面实例化后重设
const { MongoMemoryServer } = await import('mongodb-memory-server');
const mem = await MongoMemoryServer.create();
process.env.MONGODB_URI = mem.getUri('memomap');

const { connectDB } = await import('../src/config/db.js');
const User = (await import('../src/models/index.js')).User;
const { signAccessToken } = await import('../src/services/token.service.js');
const Conversation = (await import('../src/models/index.js')).Conversation;
const Message = (await import('../src/models/index.js')).Message;

await connectDB();

// 两个测试身份
const mk = async (phone, nickname) => {
  let u = await User.findOne({ phone });
  if (!u) u = await User.create({ phone, nickname });
  return u;
};
const A = await mk('13800000001', '测试甲');
const B = await mk('13800000002', '测试乙');

// 种子会话 + 几条历史（B→A 两条未读、A→B 一条）
let conv = await Conversation.findOne({ participants: { $all: [A._id, B._id] } });
if (!conv) {
  conv = await Conversation.create({ participants: [A._id, B._id] });
  const t0 = Date.now();
  await Message.create([
    { conversationId: conv._id, senderId: A._id, type: 'text', content: '你好呀，看到你在断桥拍的照片了！', createdAt: new Date(t0 - 60000) },
    { conversationId: conv._id, senderId: B._id, type: 'text', content: '谢谢！那个机位日落特别美 📷', createdAt: new Date(t0 - 30000) },
    { conversationId: conv._id, senderId: B._id, type: 'text', content: '周末有空一起去拍吗？', createdAt: new Date(t0 - 10000) },
  ]);
  const last = await Message.findOne({ conversationId: conv._id }).sort({ createdAt: -1 });
  conv.lastMessage = { type: 'text', content: last.content, senderId: B._id, at: last.createdAt };
  conv.lastMessageAt = last.createdAt;
  conv.unreadCounts = { [String(A._id)]: 2, [String(B._id)]: 1 };
  await conv.save();
}

const app = (await import('../src/app.js')).default;
const { attachChatWS } = await import('../src/services/chat.ws.js');
const server = app.listen(8082, () => {});
attachChatWS(server);

console.log('READY ' + JSON.stringify({
  port: 8082,
  users: [
    { id: String(A._id), phone: A.phone, nickname: A.nickname, token: signAccessToken(A._id) },
    { id: String(B._id), phone: B.phone, nickname: B.nickname, token: signAccessToken(B._id) },
  ],
  conversationId: String(conv._id),
}));
