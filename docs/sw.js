/*! SVG Stripper | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/svg-stripper */
/* Offline support. The shell is precached at install, same-origin requests
   are answered from cache and refreshed in the background, and cross-origin
   requests pass through untouched. The cache name carries the release version
   and old caches are dropped on activate. */

const VERSION = "?v=1.6.3";
const CACHE = "svg-stripper-" + VERSION;
const SHELL = [
  "./",
  "404.html",
  "notfound.js" + VERSION,
  "styles.css" + VERSION,
  "app.js" + VERSION,
  "optimizer.js" + VERSION,
];

addEventListener("install", (event) => {
  // no-cache requests, so the versioned cache holds exactly the deployed
  // bytes rather than whatever the HTTP cache still had from before a deploy
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "no-cache" })))).then(() => skipWaiting()));
});

addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => clients.claim())
  );
});

addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Pages go network-first: a fresh deploy reaches the very next load
    // instead of waiting a full visit behind a cached shell, and every
    // query-string variant collapses into the one precached copy instead of
    // filling the cache with duplicates. Offline still gets the shell, and an
    // offline deep link gets the not-found page rather than a silent home.
    if (req.mode === "navigate") {
      const scopePath = new URL("./", location.href).pathname;
      try {
        const res = await fetch(req);
        if (res && res.ok && new URL(req.url).pathname === scopePath) cache.put("./", res.clone());
        return res;
      } catch (error) {
        const isRoot = new URL(req.url).pathname === scopePath;
        const fallback = (!isRoot && await cache.match("404.html")) || await cache.match("./");
        if (fallback) return fallback;
        throw error;
      }
    }

    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    if (cached) {
      network.catch(() => { /* offline refresh can wait */ });
      return cached;
    }
    return network;
  })());
});
