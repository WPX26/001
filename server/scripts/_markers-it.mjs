/** /map/markers 三模式数据级集成测试（内存库）：验证三层排序改动后 normal/inspire/explore 全链路 */
process.env.ADMIN_PASSWORD = 'smoke-admin-pass-2026';
process.env.JWT_SECRET = 'smoke-secret-2026-0123456789';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User, Coord, Photo, ExploreBoost } from '../src/models/index.js';

const { default: app } = await import('../src/app.js');
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = 'http://127.0.0.1:' + server.address().port;

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri());

// 造数据：两个作者、4 个坐标聚在一个格子、照片带赞、一个活跃月卡 boost
const u1 = await User.create({ phone: '13800000001', password: 'x', nickname: '作者甲', isPhotographer: true });
const u2 = await User.create({ phone: '13800000002', password: 'x', nickname: '作者乙', isPhotographer: true });
const me = await User.create({ phone: '13800000003', password: 'x', nickname: '我自己', isPhotographer: true });
const lng0 = 120.38, lat0 = 36.06;
const mk = (i, author) => ({ title: '坐标' + i, lng: lng0 + i * 0.0008, lat: lat0 + i * 0.0008, mode: 'work', isPublic: true, authorId: author._id, description: '' });
const c1 = await Coord.create(mk(1, u1));
const c2 = await Coord.create(mk(2, u1));
const c3 = await Coord.create(mk(3, u2));
const c4 = await Coord.create(mk(4, u2));
const life1 = await Coord.create({ title: '灵感一', lng: lng0 + 0.004, lat: lat0 + 0.004, mode: 'life', isPublic: true, authorId: u2._id });
const lifeMine = await Coord.create({ title: '我的灵感', lng: lng0 + 0.02, lat: lat0 + 0.02, mode: 'life', isPublic: true, authorId: me._id }); // 王总2026-09-03拍板：列表含自己
const now = Date.now();
const cpk = () => 'cp' + Math.random().toString(36).slice(2);
await Photo.create({ clientPhotoId: cpk(), coordId: c1._id, authorId: u1._id, imageUrl: 'u1', likes: 120, isPublic: true, uploadTime: new Date(now - 3 * 86400000) });
await Photo.create({ clientPhotoId: cpk(), coordId: c2._id, authorId: u1._id, imageUrl: 'u2', likes: 10, isPublic: true, uploadTime: new Date(now - 3600e3) });
await Photo.create({ clientPhotoId: cpk(), coordId: c3._id, authorId: u2._id, imageUrl: 'u3', likes: 60, isPublic: true, uploadTime: new Date(now - 2 * 86400e3) });
await Photo.create({ clientPhotoId: cpk(), coordId: c4._id, authorId: u2._id, imageUrl: 'u4', likes: 25, isPublic: true, uploadTime: new Date(now - 7200e3) });
await Photo.create({ clientPhotoId: cpk(), coordId: life1._id, authorId: u2._id, imageUrl: 'l1', likes: 5, isPublic: true, uploadTime: new Date(now) });
await ExploreBoost.create({ coordKey: '坐标1', authorId: u1._id, orderId: 'T1', tier: 'month', start: new Date(now - 86400e3), until: new Date(now + 20 * 86400e3), status: 'active' });
await ExploreBoost.create({ coordKey: '坐标3', authorId: u2._id, orderId: 'T2', tier: 'week', start: new Date(now - 3600e3), until: new Date(now + 6 * 86400e3), status: 'active' });

// 直接铸造访问令牌（与 token.service 同构）
const jwt = (await import('jsonwebtoken')).default;
const token = jwt.sign({ uid: String(me._id), type: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function markers(qs) {
  const res = await fetch(base + '/api/v1/map/markers?' + qs, { headers: { Authorization: 'Bearer ' + token } });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, code: j.code, data: j.data };
}
let fail = 0;
const ck = (name, pass, detail) => { if (!pass) fail++; console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); };

async function list(path) {
  const res = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, code: j.code, j };
}
const ip = 'lng=120.38&lat=36.06&radius=20000&page=1&pageSize=50';
const insp = await list('/api/v1/inspire/coords?' + ip);
console.log('INSPIRE status=' + insp.status + ' code=' + insp.code + ' listLen=' + ((insp.j.data && insp.j.data.list) || []).length + (insp.status !== 200 ? ' body=' + JSON.stringify(insp.j).slice(0, 200) : ''));
if (insp.status === 200) console.log('INSPIRE list=', JSON.stringify(((insp.j.data && insp.j.data.list) || []).map(c => c.title || (c.coord && c.coord.title))).slice(0, 200));
const exp = await list('/api/v1/explore/coords?' + ip);
console.log('EXPLORE status=' + exp.status + ' code=' + exp.code + ' groups=' + (((exp.j.data && exp.j.data.authorGroups) || []).length) + (exp.status !== 200 ? ' body=' + JSON.stringify(exp.j).slice(0, 200) : ''));
if (exp.status === 200) { const g = ((exp.j.data && exp.j.data.authorGroups) || []); console.log('EXPLORE groups=', JSON.stringify(g.map(x => ({ a: x.authorName, n: (x.coords || []).length }))).slice(0, 300)); }

const q = 'minLng=120.35&maxLng=120.42&minLat=36.03&maxLat=36.09&zoom=17&level=2';
const normal = await markers(q);
ck('normal 模式 200', normal.status === 200 && Array.isArray(normal.data), 'status=' + normal.status + ' code=' + normal.code + ' n=' + (normal.data || []).length);
const inspire = await markers(q + '&mode=inspire');
ck('inspire 模式 200', inspire.status === 200 && Array.isArray(inspire.data), 'status=' + inspire.status + ' code=' + inspire.code + ' n=' + (inspire.data || []).length);
ck('inspire 只出生活池', (inspire.data || []).every(m => !/坐标/.test(m.title)), JSON.stringify((inspire.data || []).map(m => m.title)));
const explore = await markers(q + '&mode=explore');
ck('explore 模式 200', explore.status === 200 && Array.isArray(explore.data), 'status=' + explore.status + ' code=' + explore.code + ' n=' + (explore.data || []).length);
const cl = (explore.data || []).find(m => m.isClustered);
ck('explore 聚合点存在', !!cl, JSON.stringify(cl || {}).slice(0, 240));
if (cl) {
  ck('簇代表=月卡坐标1', cl.title.indexOf('坐标1') === 0 && cl.representativeId, 'title=' + cl.title + ' rep=' + cl.representativeId);
  ck('簇间 boostTier=month', cl.boostTier === 'month', 'boostTier=' + cl.boostTier);
  const sub = cl.subCoordIds || [];
  const idOf = { '坐标1': String(c1._id), '坐标2': String(c2._id), '坐标3': String(c3._id), '坐标4': String(c4._id) };
  const seq = sub.map(id => Object.keys(idOf).find(k => idOf[k] === id)).filter(Boolean);
  ck('子点含全部4坐标', seq.length === 4, 'seq=' + seq.join(','));
  ck('月卡坐标1打头+周卡坐标3次之', seq[0] === '坐标1' && seq[1] === '坐标3', 'seq=' + seq.join(','));
}
const single = (inspire.data || [])[0];
ck('inspire 单点字段完整', !!(single && single.id && typeof single.lng === 'number' && single.isClustered === false), JSON.stringify(single || {}).slice(0, 160));
ck('inspire 含自己上传的坐标(拍板①)', (inspire.data || []).some(m => Array.isArray(m.subCoordIds) && m.subCoordIds.includes(String(lifeMine._id))) || (inspire.data || []).some(m => String(m.id) === String(lifeMine._id)) || JSON.stringify(inspire.data).includes('我的灵感'), JSON.stringify((inspire.data || []).map(m => m.title)));

console.log(fail ? 'FAILED ' + fail : 'ALL MARKERS-IT PASS');
await mongoose.disconnect();
await mongod.stop();
server.close();
process.exit(fail ? 1 : 0);
