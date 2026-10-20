// Offline cache for the device-only app: the page and its files are kept on this phone.
const CACHE = 'club-rent-beta-v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'device.js', 'sql-wasm-browser.wasm',
  'tesseract/worker.min.js', 'tesseract/tesseract-core-lstm.wasm.js', 'tesseract/tesseract-core-lstm.wasm',
  'tesseract/tesseract-core-simd-lstm.wasm.js', 'tesseract/tesseract-core-simd-lstm.wasm', 'tessdata/eng.traineddata.gz',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Network first (picks up updates when online), saved copy when offline.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request)));
});
