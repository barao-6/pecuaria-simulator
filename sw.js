// ══════════════════════════════════════════════════════════════
//  PECUÁRIA SIMULATOR — Service Worker v1.0
//  Funcionalidades:
//  - Cache offline de assets estáticos
//  - Fallback quando sem internet
//  - Background sync para saves pendentes
// ══════════════════════════════════════════════════════════════

const CACHE_NAME    = 'pecuaria-sim-v1';
const OFFLINE_URL   = '/offline.html';

// Assets para cache imediato no install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js',
];

// ── INSTALL: pré-cachear assets essenciais ────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        // Falha silenciosa em assets externos — não bloquear install
        console.warn('[SW] Precache partial fail:', err.message);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: limpar caches antigos ──────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deletando cache antigo:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: Estratégia por tipo de recurso ─────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Firebase API — sempre network first (dados em tempo real)
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('firebase') ||
      url.hostname.includes('googleapis.com')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Offline: retornar resposta de erro estruturada para Firebase
        return new Response(JSON.stringify({ error: 'offline' }),
          { headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // 2. API Anthropic (notícias AI) — network only, sem cache
  if (url.hostname.includes('anthropic.com')) {
    event.respondWith(fetch(event.request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }),
        { headers: { 'Content-Type': 'application/json' } })
    ));
    return;
  }

  // 3. Imagens SVG/data URIs — não cachear (geradas inline)
  if (event.request.url.startsWith('data:')) return;

  // 4. HTML principal — Network first, fallback cache
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Guardar cópia no cache
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          return new Response(OFFLINE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 5. SDKs Firebase e outros JS — Cache first, fallback network
  if (url.hostname.includes('gstatic.com') ||
      event.request.destination === 'script') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // 6. Default: network with cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── BACKGROUND SYNC: salvar quando voltar online ─────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-game-save') {
    event.waitUntil(
      // Notificar todos os clientes para tentar salvar
      self.clients.matchAll().then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'SYNC_SAVE' })
        );
      })
    );
  }
});

// ── PUSH: notificações (estrutura para futuro) ────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || '🐄 Pecuária Sim', {
      body:  data.body  || 'Sua fazenda precisa de atenção!',
      icon:  data.icon  || '/icon-192.png',
      badge: data.badge || '/badge-72.png',
      data:  { url: data.url || '/' },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || '/')
  );
});

// ── HTML offline fallback (inline para não depender de arquivo) ─
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pecuária Simulator — Offline</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050e04;color:#f0ffe8;font-family:system-ui,sans-serif;
     display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:20px}
.card{background:rgba(10,20,8,.9);border:1px solid rgba(80,200,60,.3);border-radius:20px;padding:40px 30px;max-width:380px}
h1{font-size:24px;color:#6eff3a;margin-bottom:10px}
p{color:#a8d898;font-size:14px;margin-bottom:20px;line-height:1.6}
button{background:rgba(62,207,24,.2);border:1px solid #3ecf18;color:#6eff3a;
       padding:12px 24px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer}
</style>
</head>
<body>
<div class="card">
  <div style="font-size:64px;margin-bottom:16px">🐄</div>
  <h1>Sem conexão</h1>
  <p>Seu jogo está em cache e pode ser jogado offline.<br>
     Seus avanços serão sincronizados quando a internet voltar.</p>
  <button onclick="location.reload()">🔄 Tentar novamente</button>
</div>
</body>
</html>`;
