// Live inbox: every 5 s ask the server for the newest inbox rows. The server also verifies new payment e-mails at that moment
// (settling open orders / refreshing the balance), so keeping this page open makes payment verification as fast as possible.
(function () {
  var box = document.getElementById('liveInbox');
  if (!box || !box.getAttribute('data-live-url')) return;
  var url = box.getAttribute('data-live-url'), rows = document.getElementById('liveRows'),
      badge = document.getElementById('liveBadge'), checked = document.getElementById('liveChecked'),
      bal = document.getElementById('liveBalance'), alertBox = document.getElementById('livePayAlert');
  var known = {}; Array.prototype.forEach.call(rows.querySelectorAll('tr[data-id]'), function (tr) { known[tr.getAttribute('data-id')] = true; });
  var busy = false, firstRound = true, failures = 0;
  function setBadge(ok) { if (!badge) return; badge.textContent = ok ? '● Live' : '○ Reconnecting…'; badge.className = 'live-badge' + (ok ? '' : ' off'); }
  function tick() {
    if (busy || document.hidden) return; busy = true;
    fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) { if (r.status === 401) { location.href = '/login'; throw new Error('login'); } return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error('bad');
        failures = 0; setBadge(true);
        if (bal && d.balance) bal.textContent = d.balance.text;
        if (checked) checked.textContent = 'Checked ' + d.checkedAt;
        var fresh = d.rows.filter(function (r) { return !known[r.id]; });
        // newest first: insert in reverse so the first new row ends up on top
        fresh.slice().reverse().forEach(function (r) {
          known[r.id] = true; var t = document.createElement('tbody'); t.innerHTML = r.html.trim(); var tr = t.firstElementChild;
          if (!tr) return; if (!firstRound) tr.className += ' live-new'; rows.insertBefore(tr, rows.firstChild);
        });
        if (!firstRound) { var pay = fresh.filter(function (r) { return r.payment; });
          if (pay.length && alertBox) { alertBox.textContent = '✅ Payment e-mail received: ' + pay[0].subject + (bal && d.balance ? ' — balance ' + d.balance.text : ''); alertBox.style.display = ''; setTimeout(function () { alertBox.style.display = 'none'; }, 12000); } }
        firstRound = false;
      })
      .catch(function (e) { if (e && e.message === 'login') return; failures++; setBadge(failures < 2); })
      .then(function () { busy = false; });
  }
  setInterval(tick, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  tick();
})();
