// CSP-safe confirmation prompts (the site's security policy blocks inline onclick/onsubmit handlers).
// Add data-confirm="message" to a <form> or a submit <button>; the action only proceeds if the user accepts.
document.addEventListener('submit', function (e) {
  var m = e.target && e.target.getAttribute && e.target.getAttribute('data-confirm');
  if (m && !window.confirm(m)) e.preventDefault();
}, true);
document.addEventListener('click', function (e) {
  var b = e.target && e.target.closest && e.target.closest('button[data-confirm]');
  if (b && !window.confirm(b.getAttribute('data-confirm'))) e.preventDefault();
}, true);
