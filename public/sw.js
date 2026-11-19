// Keeps the big, rarely changing files (models, map data, splash art) in the
// browser after the first visit, so later starts don't download 200 MB again.
// Bump the version when those files change.
const CACHE = 'gtd-assets-v1'
const KEEP = /\/(models|data|splash)\//

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  // drop caches of older versions
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('gtd-assets-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || !KEEP.test(new URL(request.url).pathname)) return
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request)
      if (hit) return hit
      const response = await fetch(request)
      if (response.ok && response.status === 200) cache.put(request, response.clone())
      return response
    }),
  )
})
