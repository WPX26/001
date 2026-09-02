
const fs=require('fs');
const s=fs.readFileSync(__dirname+'/../memo-home.html','utf8');
const start=s.indexOf('    const __now = Math.floor');
const end=s.indexOf('    let html', start);
const block=s.slice(start,end);
const now=Math.floor(Date.now()/1000);
function mkPhoto(a,l,t){return{author:a,likes:l,uploadTime:t}}
function run(photos,title,opt){
  opt=opt||{};
  const coord={title,boostAuthors:opt.boostAuthors||[],photos};
  const ag={};
  photos.forEach(p=>{if(!ag[p.author])ag[p.author]={author:p.author,photos:photos.filter(q=>q.author===p.author)}});
  const merged=Object.assign({},opt.crown||{},opt.boost?{['explore_boost_'+title]:JSON.stringify(opt.boost)}:{});
  const ls={getItem(k){return merged[k]!==undefined?merged[k]:null},setItem(k,v){merged[k]=String(v)}};
  const fn=new Function('coord','localStorage','authorGroups','followedUsers',block+'\nreturn JSON.stringify(sortedAuthors.map(g=>g.author))');
  return JSON.parse(fn(coord,ls,ag,[]));
}
const s1=run([mkPhoto('付费甲',5,now-86400*3),mkPhoto('付费乙',3,now-86400*3),mkPhoto('高赞王',100,now-86400*3),mkPhoto('次赞兄',50,now-86400*3),mkPhoto('新人甲',0,now-7200),mkPhoto('新人乙',0,now-3600),mkPhoto('老油条',20,now-86400*10)],'测1',
  {boostAuthors:['付费甲','付费乙']});
console.log('场景1:',s1.join(' > '),'| 预期 付费甲>高赞王>新人乙>付费乙>次赞兄>新人甲>老油条');
const s2=run([mkPhoto('新人甲',0,now-7200),mkPhoto('新人甲',0,now-1800),mkPhoto('新人乙',0,now-3600)],'测2');
console.log('场景2:',s2.join(' > '),'| 预期 新人乙>新人甲');
const s3=run([mkPhoto('霸榜者',0,now-3600),mkPhoto('老实人',30,now-86400*5)],'测3',{crown:{['explore_crown_测3']:JSON.stringify({霸榜者:{since:now-73*3600}})}});
console.log('场景3b:',s3.join(' > '),'| 预期 老实人>霸榜者');
const s4=run([mkPhoto('付费甲',2,now-86400*3),mkPhoto('付费乙',3,now-86400*3),mkPhoto('高赞王',100,now-86400*3),mkPhoto('新人甲',0,now-3600)],'测4',
  {boost:[{author:'付费甲',start:now-100,until:now+86400},{author:'付费乙',start:now-50,until:now+86400}]});
console.log('场景4:',s4.join(' > '),'| 预期 付费乙>付费甲>新人甲>高赞王');
const s5=run([mkPhoto('高赞王',100,now-86400*3),mkPhoto('次赞兄',50,now-86400*3)],'测5');
console.log('场景5:',s5.join(' > '),'| 预期 高赞王>次赞兄');
const s6=run([mkPhoto('零赞君',0,now-86400*2),mkPhoto('一赞君',1,now-86400*2)],'测6');
console.log('场景6:',s6.join(' > '),'| 预期 一赞君>零赞君');
