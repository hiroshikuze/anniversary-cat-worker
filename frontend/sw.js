// Service Worker: Network-first strategy
// HTMLは常にネットワークから取得し、オフライン時のみキャッシュにフォールバック

const CACHE_NAME = 'nyaniversary-v1';
const OFFLINE_PAGES = [
  '/anniversary-cat-worker/',
  '/anniversary-cat-worker/index.html',
];

// インストール: オフライン用にHTMLをキャッシュ & 即座に有効化
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_PAGES))
  );
  // 旧 Service Worker を待たずに即座にアクティブ化
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除 & 全タブを即座に掌握
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // 新しい SW がすぐに全クライアントを制御できるようにする
  self.clients.claim();
});

// フェッチ: ナビゲーション(HTML)は Network-first
self.addEventListener('fetch', (event) => {
  // ページナビゲーションのリクエストのみ処理
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // 成功したらキャッシュを最新版に更新してからレスポンスを返す
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return networkResponse;
      })
      .catch(() =>
        // オフライン時のみキャッシュから返す
        caches.match(event.request).then(
          (cached) => cached ?? caches.match('/anniversary-cat-worker/')
        )
      )
  );
});
