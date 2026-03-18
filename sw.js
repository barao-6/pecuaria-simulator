const CACHE_VERSION = 'v3';
const CACHE_PREFIX = 'pecuaria-sim';
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const IMAGE_CACHE = `${CACHE_PREFIX}-images-${CACHE_VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE]);

// App shell minimo. Bump em CACHE_VERSION a cada deploy para invalidar caches antigos.
const APP_SHELL = ['/', '/index.html'];
const INDEX_FALLBACK = '/index.html';
const STATIC_DESTINATIONS = new Set(['script', 'style', 'font']);

// APIs que precisam continuar em tempo real e nao devem entrar no cache.
const NETWORK_ONLY_API_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebase.googleapis.com',
  'firebasestorage.googleapis.com',
  'anthropic.com',
];

// SDKs externos devem continuar fora do cache gerenciado pelo app.
const NO_CACHE_EXTERNAL_HOSTS = ['gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(APP_SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (_) {
          // Navigation preload eh opcional.
        }
      }

      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter(key => key.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.has(key))
          .map(key => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const { request } = event;

  if (!isHttpRequest(request)) {
    return;
  }

  const url = new URL(request.url);

  if (isServiceWorkerRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (isNetworkOnlyApiRequest(url)) {
    event.respondWith(networkOnly(request, () => offlineJsonResponse()));
    return;
  }

  if (isNoCacheExternalRequest(url)) {
    event.respondWith(networkOnly(request, () => safeFallback(request)));
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstHtml(event));
    return;
  }

  if (isStaticAssetRequest(url, request)) {
    event.respondWith(staleWhileRevalidate(event, STATIC_CACHE));
    return;
  }

  if (isImageRequest(url, request)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, offlineImageResponse));
    return;
  }

  event.respondWith(fallbackFetch(request));
});

self.addEventListener('sync', event => {
  if (event.tag === 'sync-game-save') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SYNC_SAVE' });
        });
      })
    );
  }
});

self.addEventListener('push', event => {
  if (!event.data) {
    return;
  }

  let data = {};

  try {
    data = event.data.json();
  } catch (_) {
    data = { body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Pecuaria Simulator', {
      body: data.body || 'Sua fazenda precisa de atencao.',
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/badge-72.png',
      data: { url: data.url || '/' },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});

function isHttpRequest(request) {
  return request.url.startsWith('http://') || request.url.startsWith('https://');
}

function isServiceWorkerRequest(url) {
  return url.origin === self.location.origin && url.pathname.endsWith('/sw.js');
}

function isNetworkOnlyApiRequest(url) {
  return NETWORK_ONLY_API_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function isNoCacheExternalRequest(url) {
  return NO_CACHE_EXTERNAL_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

function isStaticAssetRequest(url, request) {
  return url.origin === self.location.origin && STATIC_DESTINATIONS.has(request.destination);
}

function isImageRequest(url, request) {
  return url.origin === self.location.origin && request.destination === 'image';
}

async function networkOnly(request, fallbackFactory) {
  try {
    return await fetch(request);
  } catch (_) {
    return fallbackFactory();
  }
}

// HTML usa network-first para evitar shell antigo e manter o app atualizavel.
async function networkFirstHtml(event) {
  const { request } = event;

  try {
    const preloadResponse = await event.preloadResponse;
    if (preloadResponse) {
      await putInCache(SHELL_CACHE, request, preloadResponse.clone());
      return preloadResponse;
    }

    const networkResponse = await fetch(request);
    if (isCacheableResponse(networkResponse)) {
      await putInCache(SHELL_CACHE, request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_) {
    const cachedPage = await caches.match(request, { ignoreSearch: true });
    if (cachedPage) {
      return cachedPage;
    }

    const cachedShell = await caches.match(INDEX_FALLBACK, { ignoreSearch: true });
    if (cachedShell) {
      return cachedShell;
    }

    return offlineDocumentResponse();
  }
}

// JS/CSS usam stale-while-revalidate para abrir rapido sem perder atualizacao em background.
async function staleWhileRevalidate(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request, { ignoreSearch: false });

  const networkPromise = fetch(request)
    .then(async response => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cachedResponse) {
    event.waitUntil(networkPromise);
    return cachedResponse;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) {
    return networkResponse;
  }

  return safeFallback(request);
}

// Imagens usam cache-first para reduzir custo de rede e manter a UI consistente offline.
async function cacheFirst(request, cacheName, fallbackFactory) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request, { ignoreSearch: false });
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    if (isCacheableResponse(networkResponse)) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_) {
    return fallbackFactory();
  }
}

async function fallbackFetch(request) {
  try {
    return await fetch(request);
  } catch (_) {
    const cachedResponse = await caches.match(request, { ignoreSearch: false });
    if (cachedResponse) {
      return cachedResponse;
    }

    return safeFallback(request);
  }
}

async function putInCache(cacheName, request, response) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
}

function isCacheableResponse(response) {
  return response && response.ok;
}

function safeFallback(request) {
  if (request.destination === 'image') {
    return offlineImageResponse();
  }

  if (request.destination === 'script') {
    return offlineAssetResponse('application/javascript; charset=utf-8');
  }

  if (request.destination === 'style') {
    return offlineAssetResponse('text/css; charset=utf-8');
  }

  if (request.destination === 'font') {
    return new Response(null, {
      status: 503,
      statusText: 'Offline',
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (request.headers.get('accept')?.includes('text/html')) {
    return offlineDocumentResponse();
  }

  if (request.headers.get('accept')?.includes('application/json')) {
    return offlineJsonResponse();
  }

  return new Response('', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Cache-Control': 'no-store' },
  });
}

function offlineJsonResponse() {
  return new Response(
    JSON.stringify({
      error: 'offline',
      message: 'Recurso indisponivel sem conexao.',
    }),
    {
      status: 503,
      statusText: 'Offline',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}

function offlineAssetResponse(contentType) {
  return new Response('', {
    status: 503,
    statusText: 'Offline',
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    },
  });
}

function offlineDocumentResponse() {
  return new Response(OFFLINE_DOCUMENT, {
    status: 503,
    statusText: 'Offline',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function offlineImageResponse() {
  return new Response(OFFLINE_IMAGE_SVG, {
    status: 503,
    statusText: 'Offline',
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const OFFLINE_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Imagem indisponivel">' +
  '<rect width="640" height="360" fill="#0a1208"/>' +
  '<rect x="24" y="24" width="592" height="312" rx="24" fill="#122012" stroke="#3c6b35" stroke-width="2"/>' +
  '<path d="M120 250l90-92 70 66 88-102 152 128H120z" fill="#244021"/>' +
  '<circle cx="224" cy="118" r="28" fill="#6aa85b"/>' +
  '<text x="50%" y="83%" text-anchor="middle" fill="#d7ead1" font-size="24" font-family="Arial, sans-serif">Imagem indisponivel offline</text>' +
  '</svg>';

const OFFLINE_DOCUMENT = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pecuaria Simulator Offline</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(circle at top, #153117 0%, #081108 58%, #040804 100%);
      color: #edf7e8;
      font-family: Arial, sans-serif;
    }
    .card {
      width: min(420px, 100%);
      padding: 32px 28px;
      border-radius: 24px;
      border: 1px solid rgba(118, 191, 87, 0.35);
      background: rgba(11, 22, 10, 0.92);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
      text-align: center;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      color: #7ed957;
    }
    p {
      margin: 0 0 20px;
      line-height: 1.6;
      color: #c8ddbf;
      font-size: 15px;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 12px 18px;
      background: linear-gradient(135deg, #73c84f, #4e8f37);
      color: #081108;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Sem conexao</h1>
    <p>O jogo nao conseguiu buscar a versao mais recente agora, mas o app shell continua disponivel offline.</p>
    <button onclick="location.reload()">Tentar novamente</button>
  </main>
</body>
</html>`;
