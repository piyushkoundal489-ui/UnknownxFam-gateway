// Tiny helpers for the loading animations (CSS does the rest):
//  - a form that is being submitted shows a spinner on its button and cannot be double-submitted
//  - clicking a normal link or submitting a form shows a thin loading bar at the top until the next page appears
(function () {
  var root = document.documentElement, timer;
  function clear() {
    clearTimeout(timer);
    root.classList.remove('navigating');
    Array.prototype.forEach.call(document.querySelectorAll('.loading'), function (b) { b.classList.remove('loading'); });
    Array.prototype.forEach.call(document.querySelectorAll('form[data-busy]'), function (f) { f.removeAttribute('data-busy'); });
  }
  function start(ms) { root.classList.add('navigating'); clearTimeout(timer); timer = setTimeout(clear, ms); }
  window.addEventListener('pageshow', clear);                       // coming back (bfcache) shows the page as it was, not "loading"

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM' || e.defaultPrevented) return;      // cancelled (e.g. the confirmation was declined)
    if (f.target && f.target !== '_self') return;
    if (f.getAttribute('data-busy')) { e.preventDefault(); return; }   // already sending: ignore the second tap
    f.setAttribute('data-busy', '1');
    var b = e.submitter || f.querySelector('button[type="submit"], button:not([type])');
    if (b && !b.classList.contains('aa-switch')) b.classList.add('loading');
    start(30000);
  });

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    if (!/^https?:$/.test(a.protocol) || a.origin !== location.origin) return;
    if (a.pathname === location.pathname && a.search === location.search) return;           // same page / #anchor
    if (/\.(csv|zip|json|pdf|png|webp|txt)$/i.test(a.pathname)) return;                       // downloads do not leave the page
    start(12000);
  });
})();

// ---- Switches that save in place (Auto Approve): flip with an animation right away, save in the background, no page reload ----
(function () {
  function toast(msg, kind) { if (window.gwToast) return window.gwToast(msg, kind); }   // the shared bottom pop-up (toast.js)
  function paint(btn, form, on) {
    btn.classList.toggle('on', on); btn.classList.toggle('off', !on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false'); btn.setAttribute('aria-label', 'Auto Approve ' + (on ? 'on, tap to turn off' : 'off, tap to turn on'));
    var a = form.querySelector('input[name="action"]'); if (a) a.value = on ? 'auto_approve_off' : 'auto_approve_on';
  }
  function approvedNow() {                                  // everything that was waiting is approved: tidy the list and the red number
    Array.prototype.forEach.call(document.querySelectorAll('.tab-badge'), function (b) { b.remove(); });
    var rows = document.querySelectorAll('.table-scroll tbody tr');
    Array.prototype.forEach.call(rows, function (r) { r.classList.add('row-out'); });
    setTimeout(function () {
      Array.prototype.forEach.call(rows, function (r) { r.remove(); });
      Array.prototype.forEach.call(document.querySelectorAll('p.field-note'), function (n) { if (/user\(s\)/.test(n.textContent)) n.textContent = '0 user(s).'; });
    }, 380);
  }
  document.addEventListener('submit', function (e) {
    var f = e.target; if (!f || !f.matches || !f.matches('form[data-toggle-ajax]')) return;
    e.preventDefault();                                     // also stops the generic submit spinner / navigation bar below
    if (f.getAttribute('data-pending')) return; f.setAttribute('data-pending', '1');
    var btn = f.querySelector('.aa-switch'), want = f.querySelector('input[name="action"]').value === 'auto_approve_on';
    var body = new URLSearchParams(new FormData(f)).toString();   // read BEFORE flipping: paint() already sets the next action on the form
    paint(btn, f, want);                                    // instant, animated
    fetch(f.getAttribute('action'), { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { return r.json().catch(function () { return { ok: false, on: !want, message: 'Could not save. Please try again.' }; }); })
      .then(function (j) { paint(btn, f, !!j.on); toast(j.message || (j.ok ? 'Saved' : 'Could not save'), j.ok ? 'ok' : 'err'); if (j.ok && j.on && j.approved) approvedNow(); })
      .catch(function () { paint(btn, f, !want); toast('Could not save. Check your connection and try again.', 'err'); })
      .then(function () { f.removeAttribute('data-pending'); });
  }, true);
})();

// ---- Scroll reveal: blocks that start below the fold fade up ONCE when they first come into view ----
// Replaces the scroll-linked CSS version, which re-ran on every scroll and whenever the phone's address bar resized the screen (that was the blinking).
(function () {
  if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  var SEL = '.wrap > .card, .wrap > .grid > .card, .wrap .stat, .step, .trust-item, .cta-card, .section-head, .wrap > form.card';
  var vh = window.innerHeight || document.documentElement.clientHeight, pending = [], io = null;
  function show(el) { el.classList.add('rv-in'); var done = function () { el.classList.remove('rv', 'rv-in'); el.style.transitionDelay = ''; el.removeEventListener('transitionend', done); }; el.addEventListener('transitionend', done); setTimeout(done, 900); }
  function revealAll() { pending.forEach(function (el) { if (!el.classList.contains('rv-in')) show(el); }); pending = []; if (io) io.disconnect(); }
  function init() {
    var list = document.querySelectorAll(SEL), rects = [];
    Array.prototype.forEach.call(list, function (el) { rects.push(el.getBoundingClientRect().top); });      // read all first, write after: one layout, no thrash
    Array.prototype.forEach.call(list, function (el, i) { if (rects[i] > vh * 0.95) { el.classList.add('rv'); pending.push(el); } });
    if (!pending.length) return;
    io = new IntersectionObserver(function (entries) {
      var n = 0;
      entries.forEach(function (e) { if (!e.isIntersecting) return; io.unobserve(e.target); e.target.style.transitionDelay = Math.min(n++ * 60, 180) + 'ms'; show(e.target); });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });
    pending.forEach(function (el) { io.observe(el); });
    setTimeout(revealAll, 4000);                                        // never leave anything hidden if the observer is throttled (background tab, odd browsers)
    window.addEventListener('pageshow', function (e) { if (e.persisted) revealAll(); });
    window.addEventListener('beforeprint', revealAll);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
