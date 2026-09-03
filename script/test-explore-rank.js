/** 探索三层排序单测（王总 2026-09-02 定稿）：从 memo-home.html 提取排序代码块跑场景（node script/test-explore-rank.js） */
const fs = require('fs');
const s = fs.readFileSync(__dirname + '/../memo-home.html', 'utf8');
const start = s.indexOf('    const __now = Math.floor');
const end = s.indexOf('    let html', start);
if (start < 0 || end < 0) { console.error('锚点未找到'); process.exit(1); }
const block = s.slice(start, end);
const now = Math.floor(Date.now() / 1000);
function mkPhoto(a, l, t) { return { author: a, likes: l, uploadTime: t }; }
function run(photos, title, opt) {
  opt = opt || {};
  const coord = { title, boostAuthors: opt.boostAuthors || { month: [], week: [] }, photos };
  const ag = {};
  photos.forEach(p => { if (!ag[p.author]) ag[p.author] = { author: p.author, photos: photos.filter(q => q.author === p.author) }; });
  const merged = opt.boost ? { ['explore_boost_' + title]: JSON.stringify(opt.boost) } : {};
  const ls = { getItem(k) { return merged[k] !== undefined ? merged[k] : null; }, setItem(k, v) { merged[k] = String(v); } };
  const fn = new Function('coord', 'localStorage', 'authorGroups', 'followedUsers', block + '\nreturn JSON.stringify(sortedAuthors.map(g => g.author))');
  return JSON.parse(fn(coord, ls, ag, []));
}
let fail = 0;
function expect(name, got, want) {
  const ok2 = got.join('>') === want.join('>');
  if (!ok2) fail++;
  console.log((ok2 ? 'PASS' : 'FAIL') + ' ' + name + ': ' + got.join(' > ') + (ok2 ? '' : ' | 预期 ' + want.join(' > ')));
}
// 场景1 三层架构：月卡层 > 周卡层 > 免费层（免费层=热度×广度×新鲜×新人）
expect('场景1 三层（月>周>免费公式）',
  run([mkPhoto('付费甲',5,now-86400*3),mkPhoto('付费乙',3,now-86400*3),mkPhoto('高赞王',100,now-86400*3),mkPhoto('次赞兄',50,now-86400*3),mkPhoto('新人甲',0,now-7200),mkPhoto('新人乙',0,now-3600),mkPhoto('老油条',20,now-86400*10)],'测1',
    {boostAuthors:{month:['付费甲'],week:['付费乙']}}),
  ['付费甲','付费乙','高赞王','次赞兄','老油条','新人乙','新人甲']);
// 场景2 档内公式：广播型（覆盖率高）以更少赞反超爆款
expect('场景2 档内公式（广度反超）',
  run([mkPhoto('广播甲',25,now-86400*3),mkPhoto('广播甲',25,now-86400*3),mkPhoto('广播甲',25,now-86400*3),mkPhoto('广播甲',25,now-86400*3),mkPhoto('爆款王',120,now-86400*3)],'测2',
    {boost:[{author:'广播甲',tier:'month',start:now-100,until:now+86400},{author:'爆款王',tier:'month',start:now-50,until:now+86400}]}),
  ['广播甲','爆款王']);
// 场景3 同分后买靠前（start 倒序兜底）
expect('场景3 同分后买靠前',
  run([mkPhoto('先买甲',50,now-86400*3),mkPhoto('后买乙',50,now-86400*3)],'测3',
    {boost:[{author:'先买甲',tier:'month',start:now-100,until:now+86400},{author:'后买乙',tier:'month',start:now-50,until:now+86400}]}),
  ['后买乙','先买甲']);
// 场景4 新鲜系数：等赞时新作品反超老作品
expect('场景4 新鲜反超（等赞）',
  run([mkPhoto('老作君',50,now-86400*5),mkPhoto('新作君',50,now-7200)],'测4'),
  ['新作君','老作君']);
// 场景5 保底穿插：免费层第 6 席后插入 24h 内零赞新人
expect('场景5 保底穿插（零赞露脸）',
  run([mkPhoto('甲1',100,now-86400*3),mkPhoto('甲2',90,now-86400*3),mkPhoto('甲3',80,now-86400*3),mkPhoto('甲4',70,now-86400*3),mkPhoto('甲5',60,now-86400*3),mkPhoto('甲6',50,now-86400*3),mkPhoto('老油条',20,now-86400*10),mkPhoto('新人丙',0,now-3600)],'测5'),
  ['甲1','甲2','甲3','甲4','甲5','甲6','新人丙','老油条']);
// 场景6 无付费：高赞王按公式排前（回归 sanity）
expect('场景6 免费层公式序',
  run([mkPhoto('高赞王',100,now-86400*3),mkPhoto('次赞兄',50,now-86400*3)],'测6'),
  ['高赞王','次赞兄']);
process.exit(fail ? 1 : 0);
