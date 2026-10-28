// Bottom pop-up messages (window.gwToast, two at a time at most) + three sources that use them:
//  1. short success messages the server would otherwise show as a banner after a redirect (".alert[data-toast]")
//  2. real events from the backend, polled lightly while the tab is visible: payments received, QR codes generated (/notify/feed)
//  3. other scripts (theme switch, Auto Approve, the payment page)
(function () {
  var MIN_MS = 1600, MAX_LIVE = 2, QUEUE_MAX = 3, box = null, recent = {}, live = [], queue = [], wake = null;
  function container() {
    if (box && box.isConnected) return box;
    box = document.createElement('div'); box.id = 'gwToasts'; box.setAttribute('aria-live', 'polite'); box.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(box); return box;
  }
  function tops(c) { var m = new Map(); Array.prototype.forEach.call(c.children, function (el) { m.set(el, el.getBoundingClientRect().top); }); return m; }
  function glide(c, before) {                                // the older pop-up slides up to its new place instead of jumping when a newer one is added
    if (!c.firstElementChild || !Element.prototype.animate) return;
    Array.prototype.forEach.call(c.children, function (el) {
      var was = before.get(el); if (was == null || el._gone) return;
      var dy = was - el.getBoundingClientRect().top; if (Math.abs(dy) < 1) return;
      el.animate([{ translate: '0 ' + dy + 'px' }, { translate: '0 0' }], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1)' });
    });
  }
  function leave(t) {
    if (t._gone) return; t._gone = true; clearTimeout(t._timer);
    t.classList.remove('in'); t.classList.add('out');
    var done = function () { if (t.parentNode) t.parentNode.removeChild(t); };
    t.addEventListener('transitionend', function (e) { if (e.target === t && e.propertyName === 'opacity') done(); });
    setTimeout(done, 450);                                   // safety net when transitions are off (reduced motion, background tab)
  }
  function end(t) { leave(t); pump(); }
  function alive() { live = live.filter(function (el) { return !el._gone; }); return live; }
  // At most MAX_LIVE (2) pop-ups on screen, newest at the bottom. A third one replaces the OLDEST, but only once that has been up for MIN_MS (so every
  // message is readable); until then it waits in a short queue, in order.
  function waitMs() { var l = alive(); return l.length < MAX_LIVE ? 0 : Math.max(0, MIN_MS - (Date.now() - l[0]._at)); }
  function display(msg, kind, opts) {
    var c = container(), before = tops(c);
    while (alive().length >= MAX_LIVE) leave(live.shift());
    var t = document.createElement('div'); t.className = 'toast ' + (kind || 'ok'); t.setAttribute('role', kind === 'err' ? 'alert' : 'status'); t.textContent = msg;
    c.appendChild(t); live.push(t); t._at = Date.now();
    glide(c, before);
    void t.offsetWidth;                                      // commit the hidden start state, then let the transition run (no keyframes -> no flash)
    requestAnimationFrame(function () { t.classList.add('in'); });
    t._timer = setTimeout(function () { end(t); }, (opts && opts.ms) || (kind === 'err' ? 5200 : 3800));
    t.addEventListener('click', function () { end(t); });
    return t;
  }
  function pump() {
    if (!queue.length) return;
    var w = waitMs();
    if (w > 0) { if (!wake) wake = setTimeout(function () { wake = null; pump(); }, w); return; }
    var j = queue.shift(); display(j.msg, j.kind, j.opts); pump();
  }
  function show(msg, kind, opts) {
    msg = String(msg == null ? '' : msg).trim(); if (!msg) return null;
    var now = Date.now(); if (recent[msg] && now - recent[msg] < 1500) return null; recent[msg] = now;
    if (!queue.length && waitMs() === 0) return display(msg, kind, opts);
    queue.push({ msg: msg, kind: kind, opts: opts }); while (queue.length > QUEUE_MAX) queue.shift();
    pump(); return null;
  }
  window.gwToast = show;

  // 1. flash messages -> pop-ups (the server keeps a normal banner for errors and for anything long or sensitive)
  function flashes() {
    var list = document.querySelectorAll('.alert[data-toast]'), i = 0;
    Array.prototype.forEach.call(list, function (a) {
      var m = a.textContent.replace(/\s+/g, ' ').trim(); if (!m) return;
      if (!/^\p{Extended_Pictographic}/u.test(m)) m = '✅ ' + m;
      setTimeout(function () { show(m, 'ok'); }, 250 + (i++) * 450);
    });
  }

  // 2. backend events
  function feed() {
    var SINCE = 'gw-notify-since', SEEN = 'gw-notify-seen', busy = false;
    function get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    var seen; try { seen = JSON.parse(get(SEEN) || '[]'); } catch (e) { seen = []; }
    function poll() {
      if (busy || document.hidden) return; busy = true;
      var since = parseInt(get(SINCE), 10);
      fetch('/notify/feed' + (since > 0 ? '?since=' + since : ''), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || typeof j.now !== 'number') return;
          put(SINCE, String(j.now));
          var fresh = (j.events || []).filter(function (e) { return e && e.id && e.text && seen.indexOf(e.id) < 0; });
          fresh.forEach(function (e) { seen.push(e.id); }); seen = seen.slice(-60); put(SEEN, JSON.stringify(seen));
          fresh.slice(0, 3).forEach(function (e, i) { setTimeout(function () { show(e.text, e.kind === 'pay' ? 'pay' : 'ok', { ms: e.kind === 'pay' ? 6000 : 4200 }); }, i * 700); });
          if (fresh.length > 3) setTimeout(function () { show('🔔 ' + (fresh.length - 3) + ' more update' + (fresh.length - 3 > 1 ? 's' : '') + ' — check your dashboard', 'ok'); }, 3 * 700);
        })
        .catch(function () { /* offline: try again next time */ })
        .then(function () { busy = false; });
    }
    poll(); setInterval(poll, 8000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) poll(); });
  }

  function start() { flashes(); if (document.querySelector('meta[name="gw-notify"]')) feed(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
