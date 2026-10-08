const VERSION = "__VERSION__";
const FILES = __FILES__;
const PREFIX = "inkport-";
const APP_CACHE = `${PREFIX}${VERSION}`;
const SHARE_CACHE = `${PREFIX}shared`;

// cache: "reload" skips the HTTP cache, so a new worker never stores the previous deploy's page.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

// Other apps on this github.io origin keep their caches: only Inkport's old versions are removed.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => keys.filter((key) => key.startsWith(PREFIX) && key !== APP_CACHE && key !== SHARE_CACHE))
      .then((old) => Promise.all(old.map((key) => caches.delete(key))))
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
    event.respondWith(fetch(request, { cache: "no-cache" }).catch(() => caches.match("./", { ignoreSearch: true })));
  } else if (request.method === "GET") {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});

// Android's share sheet posts the notes here; the page picks them up from this cache after the redirect,
// and says so when nothing usable arrived.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll("files").filter((value) => value instanceof File);
    await Promise.all(
      files.map((file, i) =>
        cache.put(`./shared/${Date.now()}-${i}`, new Response(file, { headers: { "X-File-Name": encodeURIComponent(file.name) } })),
      ),
    );
  } catch (error) {
    console.error("Couldn't keep the shared files", error);
  }
  return Response.redirect("./?shared", 303);
}
