/*
 * Applies the saved theme before first paint so there is no flash of the
 * wrong colour scheme. Kept as an external file so the strict CSP can keep
 * `script-src 'self'` without inline-script exceptions.
 */
(function () {
  try {
    var stored = window.localStorage.getItem('nimbus-theme');
    var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored === 'dark' || ((!stored || stored === 'system') && systemDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b0d12' : '#f7f8fb');
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
