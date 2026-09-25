/* Service Worker „Letzte Runde“: hält die App auf dem Gerät vor, damit der Übungsraum offline läuft (z. B. im Flugzeug).
   Online immer frisch vom Server – aber höchstens 1,5 s warten; hängt das Netz (Flugzeug-WLAN ohne Internet) oder
   meldet das Gerät „offline“, sofort aus dem Speicher und für die nächsten 15 s gar nicht erst aufs Netz warten.
   API, Admin, Einladungen und WebSocket gehen nie in den Speicher. Bei neuen Dateien VERSION erhöhen. */
const VERSION = 'lr-4';
const ASSETS = ['./', 'index.html', 'hand.js', 'qrcode.js', 'logo.svg', 'favicon.svg', 'favicon-32.png', 'icon-192.png',
  'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png', 'manifest.json', 'impressum.html'];
const WAIT_MS = 1500, SLOW_MS = 15000;
let slowUntil = 0;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/\/(api|admin-api|ws)$/.test(url.pathname) || /\/r\/[^/]+\/?$/.test(url.pathname) || /admin\.html$/.test(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : null);
    const offline = self.navigator && self.navigator.onLine === false;
    if (cached && (offline || Date.now() < slowUntil)) return cached;          // kein Netz / Netz hängt → sofort gespeicherte Version
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req.mode === 'navigate' ? './' : req, res.clone()); return res; });
    if (!cached) return net;
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('langsam')), WAIT_MS))]);
    } catch (err) {
      slowUntil = Date.now() + SLOW_MS;
      net.catch(() => {});
      return cached;
    }
  })());
});
