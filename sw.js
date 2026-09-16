/* Ventana Service Worker
 *
 * 缓存策略（v2 起）：
 *   · **代码类资源（index.html / styles.css / app.js）—— 一律网络优先**，
 *     拿到就顺手更新缓存；离线或超时才落回缓存。
 *     为什么不是缓存优先：这三个文件每次迭代都会变，缓存优先会让人刷新好几次
 *     还看到旧版本，看起来像"改了没生效"。
 *     ★ 这一条是血的教训：2026-09-16 在 OPPO/夸克上排查"排版不对"，
 *       查了半天发现手机上一直在用**旧的 styles.css** —— 因为静态资源走的是
 *       缓存优先，而且 match 还带了 ignoreSearch（连 query 版本号都忽略）。
 *       结果作者按截图反馈的问题，早就在代码里修好了，只是永远发不到手机上。
 *       所以：**凡是"改了要生效"的文件，都必须网络优先。**
 *   · 图标（icons/*）—— 缓存优先 + 后台更新，它们基本不变。
 *   · 跨域请求（大模型 API）—— 一律不拦，直接放行。
 *
 * 改完这个文件记得同时改下面的 CACHE 版本号，否则 activate 不会清掉旧缓存。
 * 另外 CACHE 里的版本要和 index.html 的 VERSION 保持一致：
 * index.html 用 `sw.js?v=<VERSION>` 注册，浏览器按 URL 判断"是不是新的 Service Worker"。
 */
var VERSION = 'v0.26';
var CACHE = 'ventana-' + VERSION;
var CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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

/* 判断"这是不是一个改了就必须立刻生效的资源"。
   文档、样式、脚本都算 —— 它们是同一份 App 的三个部分，版本必须一致。
   注意不能只靠 accept 头判 CSS：<link rel=stylesheet> 的 accept 通常是 text/css，
   但某些浏览器/预加载场景下并不带，所以按 URL 后缀再兜一层。 */
function isFreshFirst(req) {
  if (req.mode === 'navigate') return true;
  var accept = req.headers.get('accept') || '';
  if (accept.indexOf('text/html') >= 0) return true;
  if (accept.indexOf('text/css') >= 0) return true;
  var path = new URL(req.url).pathname;
  return /\.(css|js|mjs|html)$/.test(path);
}

/* 自检钩子（保留是**故意**的，别删）。
   为什么需要它：从页面里 `controller.dispatchEvent(new MessageEvent('message'))`
   是打不到 `navigator.serviceWorker` 上的监听器的 —— 只有 SW 真正 postMessage
   出来的消息才会派发到那里。所以「页面收到 stale-page 会不会自己刷新」这件事，
   必须由 SW 真的发一条才能测。对应 tests/mobile.mjs 的「版本自愈」一组。 */
self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'stale-page-selftest') {
    self.clients.matchAll({ type: 'window' }).then(function (list) {
      list.forEach(function (c) { c.postMessage({ type: 'stale-page', selftest: true }); });
    });
  }
});

/* 离线兜底。命中缓存时顺带告诉页面「你看到的是缓存的旧版本」，
   页面收到会自己刷新一次去取网络版本。
   没有这一步的话，改名或换版本后手机上会一直看着旧页面 ——
   旧版 Service Worker 已经把旧 HTML 缓存住了，用户不手动清缓存就出不来。
   （Ventana 从 Chambre 改名时就真的这么坑了作者一次：
     127.0.0.1 打开还是旧版，局域网 IP 打开是新版，因为两个 origin 各有一份缓存。） */
function serveFromCache(req) {
  function notify() {
    self.clients.matchAll({ type: 'window' }).then(function (list) {
      list.forEach(function (c) { c.postMessage({ type: 'stale-page', url: req.url }); });
    });
  }
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) { notify(); return hit; }
    return caches.match('./index.html').then(function (fallback) {
      if (fallback) notify();
      return fallback;
    });
  });
}

/* 把 index.html 里的 ?v=__V__ 占位符换成真实版本号再发出去。
   为什么需要：静态托管（GitHub Pages 等）不会执行 serve.py，
   会把字面量 __V__ 直接发出去，那时 styles.css?v=__V__ 永远不变 ——
   等于没有版本号，改了样式照样可能被中间层缓存挡住。
   这里做一层替换，静态托管下也能拿到正确的版本号。
   只小改这一处，其余 CORE 预缓存仍然用响应，不额外消耗。 */
function withVersion(res) {
  return res.text().then(function (body) {
    if (body.indexOf('__V__') < 0) return new Response(body, { status: 200, headers: res.headers });
    var h = new Headers(res.headers);
    h.delete('content-length');
    h.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(body.split('__V__').join(VERSION), { status: 200, headers: h });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 大模型 API 直连，别插手

  if (isFreshFirst(req)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var cl = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cl); });
          // 只有 index.html 需要替换占位符；其它资源原样返回
          if (String(req.url).indexOf('index.html') >= 0 || req.mode === 'navigate') {
            return withVersion(res);
          }
        }
        return res;
      }).catch(function () { return serveFromCache(req); })
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
