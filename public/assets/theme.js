// Dark/light theme. Loaded in <head> (blocking, tiny) so the saved theme applies before first paint — no flash.
// Default is the normal (light) theme; the toggle button switches dark on/off and remembers the choice.
(function () {
  var KEY = 'gw-theme', root = document.documentElement;
  root.classList.add('js');                                  // lets CSS know scripts run (used to show short success messages as pop-ups instead of banners)
  function get() { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
  function apply(t) {
    if (t === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t === 'dark' ? '#0f0e0b' : '#ffffff');
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
      b.setAttribute('title', t === 'dark' ? 'Dark theme on — tap for normal theme' : 'Normal theme — tap for dark theme');
    });
  }
  apply(get());
  document.addEventListener('DOMContentLoaded', function () {
    apply(get());
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var next = get() === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: still switches for this page */ }
        apply(next);
        if (window.gwToast) window.gwToast(next === 'dark' ? '🌙 Dark theme selected.' : '☀️ Light theme selected.', 'ok');
      });
    });
  });
})();
