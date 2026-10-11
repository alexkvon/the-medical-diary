/* ============================================================
 * МедЖурнал — Service Worker (offline-first)
 *
 * Стратегии кэширования:
 *  - свои файлы (same-origin, включая навигации) → сеть, при офлайне — кэш:
 *    новая версия app.js применяется уже при следующей загрузке страницы;
 *  - CDN (cross-origin)         → кэш, при промахе — сеть и сохранение.
 *
 * Пути относительные (./), чтобы воркер работал в подпапке GitHub Pages.
 * ============================================================ */

'use strict';

// Версия кэша: менять при каждом изменении файлов оболочки (app.js и др.),
// чтобы install заново прогрел кэш со свежими файлами
const CACHE_NAME = 'medjournal-cache-v12';

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

  event.respondWith(
    url.origin === self.location.origin
      ? networkFirst(request, request.mode === 'navigate')
      : cacheFirst(request)
  );
});

/* Сеть → при офлайне кэш; для навигаций последний рубеж — index.html.
 * cache: 'no-cache' — браузер всегда перепроверяет HTTP-кэш у сервера,
 * иначе после деплоя можно получить устаревший файл из кэша браузера */
async function networkFirst(request, isNavigation) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) ||
      (isNavigation && (await cache.match('./index.html')));
    if (cached) return cached;
    throw err;
  }
}

/* Кэш → при промахе сеть и сохранение (CDN-библиотеки: Tailwind, Lucide) */
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
