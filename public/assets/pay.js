(function () {
  var D = JSON.parse(document.getElementById('pay-data').textContent);
  var card = document.getElementById('card'), stText = document.getElementById('stText'), stLine = document.getElementById('stLine');
  var LABEL = { PENDING: ['Payment Pending', '● Waiting for payment'], PROCESSING: ['Payment Pending', '● Verifying payment'], PAID: ['Payment Successful', '● Payment received'], UNSUCCESSFUL: ['Payment Failed', '● Payment failed'], EXPIRED: ['Payment Expired', '● Expired'], CANCELLED: ['Payment Cancelled', '● Cancelled'], MANUAL_REVIEW: ['Under Review', '● Being verified manually'] };
  var tick = null, poll = null, end = Date.now() + D.left * 1000;
  function setState(s) {
    var cls = { PENDING: 'pending', PROCESSING: 'pending', PAID: 'success', UNSUCCESSFUL: 'failed', EXPIRED: 'expired', CANCELLED: 'expired', MANUAL_REVIEW: 'review' }[s] || 'pending';
    var was = card.getAttribute('data-state'); card.setAttribute('data-state', s);
    card.className = 'card ' + cls; stText.textContent = LABEL[s][0]; stLine.textContent = LABEL[s][1];
    if (was && was !== s && window.gwToast) {
      if (s === 'PAID') window.gwToast('💸 Payment received: ₹' + D.amount + ' paid successfully 🕊️', 'pay', { ms: 6000 });
      else if (s === 'EXPIRED') window.gwToast('⌛ This payment request has expired.', 'err');
      else if (s === 'UNSUCCESSFUL') window.gwToast('❌ Payment was not successful.', 'err');
    }
    if (s === 'PAID' || s === 'UNSUCCESSFUL' || s === 'EXPIRED' || s === 'CANCELLED') { clearInterval(tick); clearInterval(poll); }   // MANUAL_REVIEW keeps polling: it can still resolve to PAID
  }
  function check() {
    fetch('/api/order_status.php?order_id=' + encodeURIComponent(D.id), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { if (j.state && LABEL[j.state]) setState(j.state); }).catch(function () {});
  }
  setState(D.state);
  addEventListener('load', function () { if (D.state === 'PENDING' && window.gwToast) window.gwToast('🔳 QR ready: scan with any UPI app to pay ₹' + D.amount, 'ok'); });
  if (D.state === 'PENDING' || D.state === 'PROCESSING') {
    try { PayQR.draw(document.getElementById('qr'), D.upi); } catch (e) { document.getElementById('qr').style.display = 'none'; }
    tick = setInterval(function () {
      var s = Math.max(0, Math.round((end - Date.now()) / 1000));
      document.getElementById('timer').textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      if (s === 0) { setState('EXPIRED'); check(); }
    }, 500);
    poll = setInterval(check, 3000);
  }
  var rb = document.getElementById('refresh'); if (rb) rb.addEventListener('click', check);
})();
