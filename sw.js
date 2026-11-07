// Mega Income - Service Worker (সাইট আপডেট হলে নতুন ভার্সন সাথে সাথে আসে)
const C = 'mega-income-v2';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/icon-192.png', '/icon-512.png'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  if (/\.apk$/i.test(new URL(r.url).pathname)) return; // APK ডাউনলোড সরাসরি যাবে, ক্যাশে ঢুকবে না // ফায়ারবেস ইত্যাদি ক্যাশ হবে না
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put('/', cp)); return res; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(r).then(h => h || fetch(r).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); return res; })));
});
