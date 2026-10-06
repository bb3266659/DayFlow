"use strict";

const VERSION = "v1";

// แยกชื่อ cache ตาม path ของโปรเจกต์
// ไม่ลบ cache ของแอปอื่นที่อยู่บน GitHub Pages origin เดียวกัน
const PREFIX = `dayflow:${self.registration.scope}:`;
const CACHE_NAME = `${PREFIX}${VERSION}`;

const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

function absoluteURL(path) {
  return new URL(path, self.registration.scope).href;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(
      FILES.map((path) => new Request(absoluteURL(path), {
        cache: "reload"
      }))
    );

    // ไม่ skipWaiting อัตโนมัติ
    // ผู้ใช้กดอัปเดตเมื่อพร้อม เพื่อไม่รีโหลดกลางกรอกข้อมูล
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter((key) => key.startsWith(PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);

  if (
    request.method !== "GET" ||
    url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname)
  ) {
    return;
  }

  // ให้เครื่องมือสร้างไอคอนทำงานผ่านเครือข่ายตามปกติ
  if (url.pathname.endsWith("/create-icons.html")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    if (request.mode === "navigate") {
      const page = await cache.match(absoluteURL("./index.html"));
      if (page) return page;
      return fetch(request);
    }

    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    return fetch(request);
  })());
});