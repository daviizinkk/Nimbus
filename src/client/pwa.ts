/**
 * Registers the static-shell service worker. API responses and public share
 * media are deliberately never cached by the worker.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('Nimbus could not register the offline shell.', error);
    });
  });
}
