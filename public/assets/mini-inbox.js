// Mini Gmail inbox: it refreshes itself every 5 s while the page is visible (quietly: the card is only swapped when the message list changed),
// and "Refresh inbox" still reloads just the card (loading state -> fresh messages / empty / error / reconnect) without a page reload.
// The server returns an already-escaped HTML fragment of its own card; if anything fails we fall back to a normal page load.
(function () {
  var busy = false;
  function wire() {
    var btn = document.getElementById('miniRefresh');
    if (!btn || btn.getAttribute('data-wired')) return;
    btn.setAttribute('data-wired', '1');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (busy) return; busy = true;
      var card = document.getElementById('miniInbox');
      var label = btn.textContent;
      btn.textContent = 'Refreshing…'; btn.setAttribute('aria-busy', 'true'); btn.style.pointerEvents = 'none';
      if (card) card.style.opacity = '0.6';
      fetch(btn.getAttribute('data-mini-url'), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
          if (!r.ok) throw new Error('http ' + r.status);
          return r.text();
        })
        .then(function (markup) {
          var t = document.createElement('div'); t.innerHTML = markup.trim();
          var fresh = t.firstElementChild;
          if (!fresh || fresh.id !== 'miniInbox' || !card) throw new Error('shape');
          card.replaceWith(fresh);
          busy = false; wire();
        })
        .catch(function (err) {
          if (err && err.message === 'login') return;
          busy = false; btn.textContent = label; btn.removeAttribute('aria-busy'); btn.style.pointerEvents = '';
          if (card) card.style.opacity = '';
          location.href = '/dashboard?tab=gmail';       // fall back to a full reload
        });
    });
  }
  wire();
  var auto = false;
  function liveTick() {
    var card = document.getElementById('miniInbox'), btn = document.getElementById('miniRefresh');
    if (!card || !btn || busy || auto || document.hidden) return; auto = true;
    fetch(btn.getAttribute('data-mini-url'), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } })
      .then(function (r) { if (r.status === 401) { location.href = '/login'; throw new Error('login'); } if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (markup) {
        var t = document.createElement('div'); t.innerHTML = markup.trim(); var fresh = t.firstElementChild, cur = document.getElementById('miniInbox');
        if (!fresh || fresh.id !== 'miniInbox' || !cur || busy) return;
        var a = cur.querySelector('tbody'), b = fresh.querySelector('tbody');
        if ((a ? a.innerHTML : cur.textContent) === (b ? b.innerHTML : fresh.textContent)) return;       // nothing new: leave the page untouched
        cur.replaceWith(fresh); wire();
      })
      .catch(function () {})
      .then(function () { auto = false; });
  }
  setInterval(liveTick, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) liveTick(); });
})();
