// Live Overview: every 3 s (while the tab is visible) ask /dashboard/live. The server reads new payment e-mails at that moment and returns a fingerprint;
// when it changes, only the stat cards, the graph data and the Payments table are swapped in -- no page reload, and nothing you are typing is touched.
(function () {
  var mark = document.getElementById('liveSig'); if (!mark) return;
  var sig = mark.getAttribute('data-sig'), busy = false;
  function swap(doc) {
    ['liveStats', 'livePayments'].forEach(function (id) { var a = document.getElementById(id), b = doc.getElementById(id); if (a && b) a.innerHTML = b.innerHTML; });
    var g = document.querySelector('[data-pay-graph]'), g2 = doc.querySelector('[data-pay-graph]');
    if (g && g2) { var raw = g2.getAttribute('data-series') || '[]'; g.setAttribute('data-series', raw); try { g.dispatchEvent(new CustomEvent('pg:data', { detail: JSON.parse(raw) })); } catch (e) {} }
  }
  function refresh() {
    return fetch('/dashboard', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } })
      .then(function (r) { if (r.status === 401) { location.href = '/login'; throw new Error('login'); } return r.text(); })
      .then(function (h) { swap(new DOMParser().parseFromString(h, 'text/html')); });
  }
  function tick() {
    if (busy || document.hidden) return; busy = true;
    fetch('/dashboard/live', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) { if (r.status === 401) { location.href = '/login'; throw new Error('login'); } return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        var c = document.getElementById('liveChecked'), n = document.getElementById('liveGmailNote');
        if (c && d.checked) c.textContent = d.checked;
        if (n) n.textContent = d.gmail === 'ok' || d.gmail === 'none' ? '' : d.gmail === 'not_configured' ? ' \u00b7 No bank sender addresses are configured' : ' \u00b7 Gmail is not responding, retrying\u2026';
        if (d.sig !== sig) { sig = d.sig; return refresh(); }
      })
      .catch(function () {})
      .then(function () { busy = false; });
  }
  setInterval(tick, 3000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) tick(); });
})();
