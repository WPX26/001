/** 探索五席循环排序单测：从 memo-home.html 提取排序代码块，跑 6 场景（node script/test-explore-rank.js） */
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
  const merged = Object.assign({}, opt.crown || {}, opt.boost ? { ['explore_boost_' + title]: JSON.stringify(opt.boost) } : {});
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
expect('场景1 五席循环（月周高赞最新高赞）',
  run([mkPhoto('付费甲',5,now-86400*3),mkPhoto('付费乙',3,now-86400*3),mkPhoto('高赞王',100,now-86400*3),mkPhoto('次赞兄',50,now-86400*3),mkPhoto('新人甲',0,now-7200),mkPhoto('新人乙',0,now-3600),mkPhoto('老油条',20,now-86400*10)],'测1',
    {boostAuthors:{month:['付费甲'],week:['付费乙']}}),
  ['付费甲','付费乙','高赞王','新人乙','次赞兄','老油条','新人甲']);
expect('场景2 入组锁位（重发不刷新）',
  run([mkPhoto('新人甲',0,now-7200),mkPhoto('新人甲',0,now-1800),mkPhoto('新人乙',0,now-3600)],'测2'),
  ['新人乙','新人甲']);
expect('场景3 72h霸榜惩罚即刻生效',
  run([mkPhoto('霸榜者',0,now-3600),mkPhoto('老实人',30,now-86400*5)],'测3',{crown:{['explore_crown_测3']:JSON.stringify({'霸榜者':{since:now-73*3600}})}}),
  ['老实人','霸榜者']);
expect('场景4 同档多人后买靠前（本地月卡池）',
  run([mkPhoto('付费甲',2,now-86400*3),mkPhoto('付费乙',3,now-86400*3),mkPhoto('高赞王',100,now-86400*3),mkPhoto('新人甲',0,now-3600)],'测4',
    {boost:[{author:'付费甲',tier:'month',start:now-100,until:now+86400},{author:'付费乙',tier:'month',start:now-50,until:now+86400}]}),
  ['付费乙','高赞王','新人甲','付费甲']);
expect('场景5 无付费时高赞接席',
  run([mkPhoto('高赞王',100,now-86400*3),mkPhoto('次赞兄',50,now-86400*3)],'测5'),
  ['高赞王','次赞兄']);
expect('场景6 0赞不入高赞席',
  run([mkPhoto('零赞君',0,now-86400*2),mkPhoto('一赞君',1,now-86400*2)],'测6'),
  ['一赞君','零赞君']);
process.exit(fail ? 1 : 0);
