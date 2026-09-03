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

async function trim(cache) {
  try {
    var keys = await cache.keys();
    for (var i = 0; i < keys.length - MAX; i++) await cache.delete(keys[i]);
  } catch (err) {}
}
