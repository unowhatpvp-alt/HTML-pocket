/* Isolation is scoped to this /gguf/ app, never the parent Pages site. */
try { document.documentElement.dataset.theme = localStorage.getItem('mono.gguf.theme') || 'light'; } catch {}
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
