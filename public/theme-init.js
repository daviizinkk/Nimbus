/*
 * Applies the saved theme and interface style before first paint so there is
 * no flash of the wrong colours. Kept as an external file so the strict CSP can
 * keep `script-src 'self'` without inline-script exceptions.
 */
(function () {
  try {
    var stored = window.localStorage.getItem('nimbus-theme');
    var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored === 'dark' || ((!stored || stored === 'system') && systemDark);
    var glass = window.localStorage.getItem('nimbus-ui-style') !== 'classic';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.ui = glass ? 'glass' : 'classic';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        'content',
        dark ? (glass ? '#070b16' : '#0b0d12') : glass ? '#eaf1fc' : '#f7f8fb',
      );
    }
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.ui = 'glass';
  }
})();
