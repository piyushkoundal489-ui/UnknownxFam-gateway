(function () {
  var nav = document.querySelector('nav.topnav');
  if (nav) { var sync = function () { nav.classList.toggle('is-stuck', window.scrollY > 2); }; document.addEventListener('scroll', sync, { passive: true }); sync(); }
  var pw = document.getElementById('pwToggle');
  if (pw) pw.addEventListener('click', function () { var p = document.getElementById('password'), s = p.type === 'password'; p.type = s ? 'text' : 'password'; this.textContent = s ? 'Hide' : 'Show'; });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = document.getElementById(b.dataset.copy), t = i.type; i.type = 'text'; i.select();
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1400); i.type = t; };
      navigator.clipboard ? navigator.clipboard.writeText(i.value).then(done) : (document.execCommand('copy'), done());
    });
  });
  var showKey = document.getElementById('showKey');
  if (showKey) showKey.addEventListener('click', function () { var i = document.getElementById('apiKey'), s = i.type === 'password'; i.type = s ? 'text' : 'password'; this.textContent = s ? 'Hide' : 'Show'; });
  var showWebhookSecret = document.getElementById('showWebhookSecret');
  if (showWebhookSecret) showWebhookSecret.addEventListener('click', function () { var i = document.getElementById('webhookSecret'), s = i.type === 'password'; i.type = s ? 'text' : 'password'; this.textContent = s ? 'Hide' : 'Show'; });
  function run(url, out) {
    out.style.display = 'block'; out.textContent = 'Loading…'; out.classList.add('working');
    fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) {
        try { out.textContent = 'HTTP ' + r.status + '\n' + JSON.stringify(JSON.parse(t), null, 2); }
        catch (e) { out.textContent = 'HTTP ' + r.status + '\n' + t; }
      });
    }).catch(function () { out.textContent = 'Request failed'; }).then(function () { out.classList.remove('working'); });
  }
  document.querySelectorAll('[data-selects]').forEach(function (el) {
    var p = el.dataset.selects.split(':');
    var pick = function () { var r = document.querySelector('input[name="' + p[0] + '"][value="' + p[1] + '"]'); if (r) r.checked = true; };
    el.addEventListener('input', pick); el.addEventListener('focus', pick);
  });
  document.querySelectorAll('[data-api-test]').forEach(function (button) {
    button.addEventListener('click', function () {
      var url = document.getElementById(button.dataset.urlId);
      var input = document.getElementById(button.dataset.inputId);
      var output = document.getElementById(button.dataset.outputId);
      if (!url || !input || !output) return;
      var token = '{' + button.dataset.token + '}';
      var target = url.value.replace(token, encodeURIComponent(input.value.trim()));
      if (button.dataset.keyInputId) { var k = document.getElementById(button.dataset.keyInputId); target = target.replace('{key}', encodeURIComponent(k ? k.value.trim() : '')); }
      run(target, output);
    });
  });
})();
