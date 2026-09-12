/* Ventana Service Worker
 *
 * 缓存策略（v2 起）：
 *   · 导航请求（index.html / ./）—— **网络优先**，拿到就顺手更新缓存；
 *     离线或超时才落回缓存。
 *     为什么不是缓存优先：index.html 是唯一会变的文件（单文件 App），
 *     缓存优先会让人刷新三次还看到旧版本，看起来像"改了没生效"。
 *     v1 就是缓存优先，本轮开发时踩了个结实。
 *   · 其它同源静态资源（图标、manifest）—— 缓存优先 + 后台更新，它们基本不变。
 *   · 跨域请求（大模型 API）—— 一律不拦，直接放行。
 *
 * 改完这个文件记得同时改下面的 CACHE 版本号，否则 activate 不会清掉旧缓存。
 * 另外 CACHE 里的版本要和 index.html 的 VERSION 保持一致：
 * index.html 用 `sw.js?v=<VERSION>` 注册，浏览器按 URL 判断"是不是新的 Service Worker"。
 */
var VERSION = 'v0.2';
var CACHE = 'ventana-' + VERSION;
var CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(CORE); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function isDocument(req) {
  if (req.mode === 'navigate') return true;
  var accept = req.headers.get('accept') || '';
  return accept.indexOf('text/html') >= 0;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 大模型 API 直连，别插手

  if (isDocument(req)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var cl = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cl); });
        }
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var fetched = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var cl = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cl); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || fetched;
    })
  );
});
