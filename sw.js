/* ============================================================
 * МедЖурнал — Service Worker (offline-first)
 *
 * Стратегии кэширования:
 *  - навигации (index.html)     → сеть, при офлайне — кэш;
 *  - свои файлы (same-origin)   → кэш мгновенно + фоновое обновление;
 *  - CDN (cross-origin)         → кэш, при промахе — сеть и сохранение.
 *
 * Пути относительные (./), чтобы воркер работал в подпапке GitHub Pages.
 * ============================================================ */

'use strict';

const CACHE_NAME = 'medjournal-cache-v4';

/* Ядро приложения — кэшируем на этапе install строго */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './src/styles.css',
  './src/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* Внешние библиотеки — кэшируем мягко: без сети установка не должна падать.
 * Версии зафиксированы, чтобы ссылка в кэше не «уезжала». */
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.16',
  'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
];

/* ---------------- install: прогрев кэша ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    // CDN — по возможности: обрыв сети не должен ломать установку
    await Promise.allSettled(CDN_ASSETS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

/* ---------------- activate: чистим старые версии ---------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ---------------- fetch: маршрутизация ---------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Переходы по страницам — сначала сеть
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    url.origin === self.location.origin
      ? staleWhileRevalidate(request)
      : cacheFirst(request)
  );
});

/* Сеть → при ошибке/офлайне кэш (страницы приложения) */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) || (await cache.match('./index.html'));
    if (cached) return cached;
    throw err;
  }
}

/* Кэш мгновенно, обновление в фоне (css/js/иконки приложения) */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || Response.error();
}

/* Кэш → при промахе сеть и сохранение (Tailwind, Lucide, Tesseract.js,
 * а также подгружаемые им на ходу wasm-ядро и языковые данные tessdata) */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    return Response.error();
  }
}
