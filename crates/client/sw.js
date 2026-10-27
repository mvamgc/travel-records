// Service worker: caches the app shell so the app boots offline (REQ-018).
//
// `build/precache.mjs` fills in VERSION and PRECACHE after every Trunk build.
// A new build changes this file, so the browser installs the new worker,
// which caches the new shell and, once active, deletes the old one.

const VERSION = "__VERSION__";
const PRECACHE = ["__PRECACHE__"];
const CACHE = `shell-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith("shell-") && key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // The API is never cached here: offline data lives in IndexedDB.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  // Every page is the single-page app, so navigation always gets the cached shell.
  const cached = request.mode === "navigate" ? caches.match("/index.html") : caches.match(request);
  event.respondWith(cached.then((response) => response ?? fetch(request)));
});
