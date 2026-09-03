/* memomap 瓦片缓存+限流闸门 v2 (v7.2, 2026-09-03 王总拍板"加阻力")
 * 只管天地图瓦片(GET, t0-t7.tianditu.gov.cn)：
 * ① 排队闸门：并发上限4 + 发车间隔150ms(约6-7张/秒)，杜绝齐发撞429红线
 * ② 429自动重试：退避1s/2s/4s，取到即入库——缺图自动补齐
 * ③ 同URL并发去重：在途共享
 * ④ 常驻缓存 cache-first 上限3000，只入真200防投毒
 */
const CACHE = 'mm-tiles-v1';
const MAX = 3000;
const TILE_RE = /^https:\/\/t[0-7]\.tianditu\.gov\.cn\//;
const MAX_ACTIVE = 4;
const GAP_MS = 150;
const RETRY_DELAYS = [1000, 2000, 4000];

var active = 0;
var waiters = [];
var lastStart = 0;
var inflight = {};
var userBusyUntil = 0;   // 用户在动图: 预植让路
var rateCoolUntil = 0;   // 撞429: 预植集体歇8s,不跟用户抢

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function acquire() {
  if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
  return new Promise(function (res) { waiters.push(res); });
}
function release() {
  active--;
  var w = waiters.shift();
  if (w) { active++; w(); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function gateFetch(url) {
  await acquire();
  try {
    var gap = lastStart + GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastStart = Date.now();
    return await fetch(new Request(url, { method: 'GET', mode: 'cors' }));
  } finally { release(); }
}

async function fetchWithRetry(url) {
  for (var i = 0; i <= RETRY_DELAYS.length; i++) {
    var resp = await gateFetch(url);
    if (resp && resp.ok) return resp;
    if (resp && resp.status === 429) rateCoolUntil = Date.now() + 8000;
    if (i < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[i] + Math.floor(Math.random() * 300));
    }
  }
  return resp; // 重试耗尽，原样返回(429等)——不入缓存
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || !TILE_RE.test(e.request.url)) return;
  var url = e.request.url;
  e.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var hit = await cache.match(e.request, { ignoreVary: true });
    if (hit) return hit;
    if (inflight[url]) return inflight[url];
    var p = (async function () {
      var resp = await fetchWithRetry(url);
      if (resp && resp.ok) {
        cache.put(e.request, resp.clone()).then(function () { trim(cache); }).catch(function () {});
      }
      return resp;
    })();
    inflight[url] = p;
    try { return await p; } finally { delete inflight[url]; }
  })());
});

/* A. 世界底座预植(王总拍板C)：z1-3 底图+注记(168张) + z4 底图(256张) 一次性匀速种入仓库——世界视图永久秒开、与429绝缘 */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'preseed-world') preseedWorld(e.data.tk);
  if (e.data && e.data.type === 'user-active') userBusyUntil = Date.now() + 5000;
});

async function yieldToUser() {
  while (Date.now() < Math.max(userBusyUntil, rateCoolUntil)) await sleep(400);
}

async function preseedWorld(tk) {
  try {
    var cache = await caches.open(CACHE);
    if (await cache.match('mm://preseed-done')) return;
    var done = 0;
    var plan = [['vec', 4], ['cva', 3]];
    for (var li = 0; li < plan.length; li++) {
      var layer = plan[li][0], maxZ = plan[li][1];
      for (var z = 1; z <= maxZ; z++) {
        var dim = Math.pow(2, z);
        for (var x = 0; x < dim; x++) for (var y = 0; y < dim; y++) {
          var u = 'https://t0.tianditu.gov.cn/' + layer + '_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer + '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=' + z + '&TILEROW=' + y + '&TILECOL=' + x + '&tk=' + tk;
          await yieldToUser();
          if (await cache.match(u)) { done++; continue; }
          var r = await fetchWithRetry(u);
          if (r && r.ok) { await cache.put(u, r.clone()); done++; }
        }
      }
    }
    await cache.put('mm://preseed-done', new Response('done:' + done));
    self.clients.matchAll().then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'preseed-progress', done: done }); }); });
  } catch (err) {}
}

async function trim(cache) {
  try {
    var keys = await cache.keys();
    for (var i = 0; i < keys.length - MAX; i++) await cache.delete(keys[i]);
  } catch (err) {}
}