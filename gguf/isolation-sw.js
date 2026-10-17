/* Provides COOP/COEP on GitHub Pages, where custom HTTP headers are unavailable.
   No model files, prompts, or responses enter this worker. No persistent caching. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || (request.cache === 'only-if-cached' && request.mode !== 'same-origin')) return;
  event.respondWith((async () => {
    const response = await fetch(request);
    if (response.status === 0 || response.type === 'opaqueredirect') return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  })());
});
