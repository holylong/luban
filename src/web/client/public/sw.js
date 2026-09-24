/*
 * luban 手机遥控 — service worker.
 *
 * The phone console is a live remote control: every task, log and approval is
 * the laptop's current state, so the API must never be served from a cache —
 * a stale "queued" would look like a job that never started. Only the shell and
 * its static assets are cached, which is what lets Chrome treat the console as
 * an installable app and reopen it offline with the last screen on display.
 *
 * Caching policy, per request:
 *   /api/*, /relay/*, /login, /logout  -> always live, never cached
 *   navigation (the shell)             -> network first, cached for offline
 *   static files                       -> cache first, network to fill the gap
 *   sw.js                              -> always live, so updates are not blocked
 */

const CACHE = "luban-mobile-v1";
// Absolute URL of the shell, used as the single offline fallback key so any
// entry point (with or without a query) reopens the same cached screen.
const SHELL = new URL("./", self.location).href;

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#050607"><title>luban · 离线</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050607;
color:#e8eaf0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.wrap{text-align:center;max-width:320px}.dot{width:10px;height:10px;border-radius:50%;
background:#5a6070;display:inline-block;margin-bottom:14px}h1{font-size:17px;margin:0 0 8px}
p{color:#9aa0b0;margin:0}</style></head><body><div class="wrap">
<div class="dot"></div><h1>需要联网</h1><p>luban 是实时遥控，请连回电脑的网络后再打开。</p>
</div></body></html>`;

self.addEventListener("install", () => {
  // Do not wait for old clients to close: the new shell should take over now.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    // Claim the open tab so the very first load is already under SW control.
    await self.clients.claim();
  })());
});

/** Live endpoints: the laptop's state must never come from a cache. */
function isLive(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/relay/") ||
    pathname === "/login" ||
    pathname === "/logout"
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLive(url.pathname)) return;
  // Never cache the worker itself, or a fix could not reach an installed app.
  if (url.pathname === new URL("./sw.js", self.location).pathname) return;

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(navigation(request));
    return;
  }
  event.respondWith(staticAsset(request, url));
});

/** The shell: prefer the live copy, fall back to the cache when offline. */
async function navigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      cache.put(SHELL, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(SHELL);
    return cached || new Response(OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

/** Static assets: cached copy first, network to fill a gap, then cache it. */
async function staticAsset(request, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url.href);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      cache.put(url.href, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response("", { status: 503 });
  }
}
