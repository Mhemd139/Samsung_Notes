const VERSION = "__VERSION__";
const FILES = __FILES__;
const APP_CACHE = `inkport-${VERSION}`;
const SHARE_CACHE = "inkport-shared";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== APP_CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(request));
  } else if (request.method === "GET" && request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./", { ignoreSearch: true })));
  } else if (request.method === "GET") {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});

// Android's share sheet posts the notes here; the page picks them up from this cache after the redirect.
async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  const files = form.getAll("files").filter((value) => value instanceof File);
  await Promise.all(
    files.map((file, i) =>
      cache.put(`./shared/${Date.now()}-${i}`, new Response(file, { headers: { "X-File-Name": encodeURIComponent(file.name) } })),
    ),
  );
  return Response.redirect("./?shared", 303);
}
