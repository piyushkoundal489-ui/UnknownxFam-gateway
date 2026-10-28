// Holding a button / pill / menu link must not open the browser's link menu ("Open in new tab", "Preview page", "Copy link address" ...).
// Normal tap, middle-click and keyboard use are unchanged; text links inside paragraphs and tables keep the normal menu.
(function () {
  var BUTTONS = 'a.btn, button, .btn, a.support-strip, nav a, .theme-toggle, .aa-switch, .acts a, .tab-badge, [role="button"]';
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest(BUTTONS)) e.preventDefault();
  }, true);
})();
