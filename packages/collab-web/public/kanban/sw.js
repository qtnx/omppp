const CACHE_NAME = "ompx-kanban-shell-v1";
const SHELL_URLS = [
	"/",
	"/app.js",
	"/app.css",
	"/manifest.webmanifest",
	"/favicon.svg",
	"/favicon-180x180.png",
	"/favicon-192x192.png",
	"/favicon-512x512.png",
];

self.addEventListener("install", event => {
	event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", event => {
	const request = event.request;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/") || url.pathname.endsWith("/events")) return;
	if (request.method !== "GET") return;

	if (request.mode === "navigate") {
		event.respondWith(fetch(request).catch(() => caches.match("/").then(response => response ?? Response.error())));
		return;
	}

	if (SHELL_URLS.includes(url.pathname)) {
		event.respondWith(caches.match(request).then(cached => cached ?? fetch(request)));
	}
});
