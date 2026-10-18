/* Isolation is scoped to this /gguf/ app, never the parent Pages site. */
try { document.documentElement.dataset.theme = localStorage.getItem('mono.gguf.theme') || 'light'; } catch {}
// Fit the app shell to the visible viewport, including a mobile software keyboard.
// Pinch zoom keeps the existing layout size so browser zoom/panning still works.
(() => {
  const viewport = window.visualViewport;
  const syncHeight = () => {
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport ? viewport.height : window.innerHeight;
    if (height > 0) document.documentElement.style.setProperty('--app-height', `${height}px`);
  };
  syncHeight();
  window.addEventListener('resize', syncHeight, { passive: true });
  viewport?.addEventListener('resize', syncHeight, { passive: true });
})();
window.monoIsolationReady = (async () => {
  if (!isSecureContext || !('serviceWorker' in navigator) || crossOriginIsolated) return;
  try {
    await navigator.serviceWorker.register('./isolation-sw.js', { scope: './' });
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
        new Promise(resolve => setTimeout(resolve, 3500))
      ]);
    }
    // One initial reload, before file selection. No reload loop if isolation is unavailable.
    if (navigator.serviceWorker.controller && !crossOriginIsolated && !sessionStorage.getItem('mono.gguf.isolationAttempt')) {
      sessionStorage.setItem('mono.gguf.isolationAttempt', '1');
      location.reload();
      await new Promise(() => {});
    }
  } catch (error) { console.warn('Isolation unavailable; single-thread mode remains available.', error); }
})();
