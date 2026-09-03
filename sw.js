/* memomap 瓦片缓存 v1 (v7.1, 2026-09-03 王总拍板方案②)
 * 只缓存天地图瓦片(GET, t0-t7.tianditu.gov.cn)，cache-first，上限 3000 条简易淘汰。
 * 以 cors 模式重取以读得状态码——只入真 200，绝不缓存 429 错误体，防缓存投毒。
 */
const CACHE = 'mm-tiles-v1';
const MAX = 3000;
const TILE_RE = /^https:\/\/t[0-7]\.tianditu\.gov\.cn\//;

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || !TILE_RE.test(e.request.url)) return;
  e.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var hit = await cache.match(e.request, { ignoreVary: true });
    if (hit) return hit;
    var resp;
    try {
      resp = await fetch(new Request(e.request.url, { method: 'GET', mode: 'cors' }));
    } catch (err) {
      // cors 取失败(理论不该发生——WebGL 上图本就要求 CORS)，退回原始请求
      return fetch(e.request);
    }
    if (resp && resp.ok) {
      cache.put(e.request, resp.clone()).then(function () { trim(cache); }).catch(function () {});
    }
    return resp;
  })());
});

async function trim(cache) {
  try {
    var keys = await cache.keys();
    for (var i = 0; i < keys.length - MAX; i++) await cache.delete(keys[i]);
  } catch (err) {}
}
