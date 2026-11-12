// Service worker aplikace TalkToClaude.
//  • drží kopii aplikace v telefonu, takže se otevře i bez počítače a bez internetu,
//  • přijímá upozornění z počítače (Web Push) a zobrazí je, i když je aplikace zavřená.
const VERSION = 'ttc-v2';
const SHELL = [
  './', 'manifest.webmanifest',
  'public/style.css', 'public/app.js', 'public/core.js', 'public/link.js', 'public/intents.js', 'public/phone.js',
  'public/panels.js', 'public/blob.js', 'public/markdown.js', 'public/icon.svg',
  'public/icons/icon-192.png', 'public/icons/badge-96.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Vlastní soubory: nejdřív síť (ať se změny projeví hned), při výpadku uložená kopie.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const rel = url.pathname.slice(scope.length);
  if (rel === 'health' || rel === 'ws' || rel === 'qr.svg') return;       // živé věci z počítače
  e.respondWith(networkFirst(req, url));
});

async function networkFirst(req, url) {
  const cache = await caches.open(VERSION);
  const key = url.origin + url.pathname;
  const net = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(async res => {
    if (res.ok) await cache.put(key, res.clone());
    // přesměrovanou odpověď nejde vrátit na navigaci – zabalit ji do nové
    return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
  try {
    return await Promise.race([net, timeout]);
  } catch {
    net.catch(() => {});
    const hit = (await cache.match(key)) || (req.mode === 'navigate' ? await cache.match(new URL('./', self.registration.scope).href) : null);
    if (hit) return hit;
    try { return await net; } catch { return Response.error(); }
  }
}

// ---------------------------------------------------------------- upozornění

self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'push', payload: p, clicked: false });
    // Aplikace je otevřená a vidět → ukáže (a přečte) si to sama, systémové oznámení by bylo navíc.
    if (wins.some(w => w.visibilityState === 'visible' && w.focused)) return;
    const call = p.kind === 'call';
    await self.registration.showNotification(p.title || 'Claude', {
      body: p.body || '',
      tag: String(p.id || p.type || 'ttc'),
      renotify: true,
      requireInteraction: call || p.type === 'perm' || p.type === 'action',
      icon: 'public/icons/icon-192.png',
      badge: 'public/icons/badge-96.png',
      vibrate: call ? [500, 250, 500, 250, 500, 800, 500, 250, 500] : [120, 80, 120],
      timestamp: p.ts || Date.now(),
      data: p,
      actions: call ? [{ action: 'open', title: 'Poslechnout' }, { action: 'dismiss', title: 'Zavřít' }] : [],
    });
  })());
});

self.addEventListener('notificationclick', e => {
  const p = e.notification.data || {};
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil((async () => {
    const scope = self.registration.scope;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(scope));
    if (win) {
      try { await win.focus(); } catch {}
      win.postMessage({ type: 'push', payload: p, clicked: true });
      return;
    }
    await self.clients.openWindow(`${scope}#n=${encodeURIComponent(JSON.stringify(p))}`);
  })());
});
