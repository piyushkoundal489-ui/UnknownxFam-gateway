// Payment Amount Graph: one thin green line chart (SVG, no libraries), two dropdown menus (period, Revenue / Payment Count) and summary cards.
// Data comes from the page (data-series = [[IST day number, paise received, payments], ...] built from the order records on the server).
(function () {
  var root = document.querySelector('[data-pay-graph]'); if (!root) return;
  var NS = 'http://www.w3.org/2000/svg', W = 340, H = 200, L = 46, R = 12, T = 12, B = 26, GREEN = '#2fbf5f';
  var raw; try { raw = JSON.parse(root.getAttribute('data-series') || '[]'); } catch (e) { raw = []; }
  var today = parseInt(root.getAttribute('data-today'), 10); if (!(today > 0)) today = Math.floor((Date.now() / 1000 + 19800) / 86400);
  var byDay = {}, first = null;
  raw.forEach(function (r) { var d = +r[0]; byDay[d] = { a: +r[1] || 0, n: +r[2] || 0 }; if (first === null || d < first) first = d; });
  var state = { range: '30', metric: 'rev' }, chart = root.querySelector('.pg-chart'), read = root.querySelector('.pg-read'), hint = read.textContent;
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  function dmy(day, short) { var d = new Date(day * 86400000); return pad(d.getUTCDate()) + '-' + pad(d.getUTCMonth() + 1) + (short ? '' : '-' + d.getUTCFullYear()); }
  function inr(p) { return '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function trim(v) { return String(Math.round(v * 10) / 10).replace(/\.0$/, ''); }
  function compact(r) {                                       // axis label for an amount in rupees: ₹0.25, ₹40, ₹1.5k, ₹2L, ₹1Cr
    var v = Math.abs(r);
    if (v >= 1e7) return '₹' + trim(r / 1e7) + 'Cr'; if (v >= 1e5) return '₹' + trim(r / 1e5) + 'L'; if (v >= 1e3) return '₹' + trim(r / 1e3) + 'k';
    return '₹' + (Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : String(+r.toFixed(2)));
  }
  function el(name, attrs, text) { var e = document.createElementNS(NS, name); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; }

  function rangeDays() {
    var n = state.range === 'all' ? Math.max(7, today - (first === null ? today - 29 : Math.min(first, today)) + 1) : parseInt(state.range, 10), out = [];
    for (var i = n - 1; i >= 0; i--) out.push(today - i); return out;
  }
  function niceScale(max, integers) {                      // 4 even steps with round numbers
    if (!(max > 0)) return { top: integers ? 4 : 100, step: integers ? 1 : 25 };
    var raw4 = max / 4, mag = Math.pow(10, Math.floor(Math.log(raw4) / Math.LN10)), f = raw4 / mag;
    var step = (integers ? (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10)) * mag;
    if (integers && step < 1) step = 1;
    return { top: step * Math.ceil(max / step), step: step };
  }
  function summary(days) {
    var total = 0, count = 0, best = null;
    days.forEach(function (d) { var v = byDay[d]; if (!v) return; total += v.a; count += v.n; if (!best || v.a > best.a) best = { a: v.a, d: d }; });
    var set = function (k, t) { var n = root.querySelector('[data-sum="' + k + '"]'); if (n) n.textContent = t; };
    set('total', inr(total)); set('count', String(count)); set('avg', count ? inr(Math.round(total / count)) : '—'); set('best', best && best.a > 0 ? inr(best.a) + ' · ' + dmy(best.d, true) : '—');
    return { total: total, count: count };
  }

  function draw() {
    var days = rangeDays(), n = days.length, rev = state.metric === 'rev', sums = summary(days);
    var vals = days.map(function (d) { var v = byDay[d]; return v ? (rev ? v.a / 100 : v.n) : 0; });
    var sc = niceScale(Math.max.apply(null, vals), !rev), top = sc.top;
    var X = function (i) { return n === 1 ? (L + W - R) / 2 : L + (W - L - R) * i / (n - 1); }, Y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
    var defs = el('defs', {}), g = el('linearGradient', { id: 'pgFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    g.appendChild(el('stop', { offset: '0', 'stop-color': GREEN, 'stop-opacity': '.26' })); g.appendChild(el('stop', { offset: '1', 'stop-color': GREEN, 'stop-opacity': '0' })); defs.appendChild(g); svg.appendChild(defs);
    for (var t = 0; t <= top + sc.step / 2; t += sc.step) {
      var y = Y(t); svg.appendChild(el('line', { x1: L, x2: W - R, y1: y, y2: y, 'class': 'pg-grid' }));
      svg.appendChild(el('text', { x: L - 6, y: y + 3.5, 'text-anchor': 'end' }, rev ? compact(t) : String(Math.round(t))));
    }
    var marks = n <= 7 ? [0, 1, 2, 3, 4, 5, 6].slice(0, n) : [0, 1, 2, 3, 4].map(function (k) { return Math.round(k * (n - 1) / 4); });
    marks.forEach(function (i) { svg.appendChild(el('text', { x: X(i), y: H - 8, 'text-anchor': i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle' }, dmy(days[i], true))); });
    var line = vals.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' ');
    svg.appendChild(el('path', { d: line + ' L' + X(n - 1).toFixed(1) + ' ' + Y(0) + ' L' + X(0).toFixed(1) + ' ' + Y(0) + ' Z', fill: 'url(#pgFill)' }));
    svg.appendChild(el('path', { d: line, 'class': 'pg-line' }));
    if (n <= 31) vals.forEach(function (v, i) { if (v > 0) svg.appendChild(el('circle', { cx: X(i), cy: Y(v), r: 2, 'class': 'pg-dot' })); });
    if (!sums.count) svg.appendChild(el('text', { x: (L + W - R) / 2, y: (T + H - B) / 2 - 8, 'text-anchor': 'middle', 'class': 'pg-empty' }, 'No payments in this period'));
    var mk = el('g', { 'class': 'pg-mark', style: 'display:none' }); mk.appendChild(el('line', { y1: T, y2: H - B, 'class': 'pg-vline' })); mk.appendChild(el('circle', { r: 3.4, 'class': 'pg-dot big' })); svg.appendChild(mk);
    var hit = el('rect', { x: L, y: 0, width: W - L - R, height: H - B, fill: 'transparent', style: 'touch-action:pan-y' }); svg.appendChild(hit);
    function at(ev) {
      var box = svg.getBoundingClientRect(); if (!box.width) return;
      var x = (ev.clientX - box.left) / box.width * W, i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((x - L) / (W - L - R) * (n - 1)))), v = byDay[days[i]] || { a: 0, n: 0 };
      mk.style.display = ''; mk.firstChild.setAttribute('x1', X(i)); mk.firstChild.setAttribute('x2', X(i)); mk.lastChild.setAttribute('cx', X(i)); mk.lastChild.setAttribute('cy', Y(vals[i]));
      read.textContent = dmy(days[i]) + ' · ' + inr(v.a) + ' · ' + v.n + (v.n === 1 ? ' payment' : ' payments');
    }
    hit.addEventListener('pointerdown', at); hit.addEventListener('pointermove', function (ev) { if (ev.pointerType !== 'mouse' || ev.buttons === 0) at(ev); });
    hit.addEventListener('pointerleave', function () { mk.style.display = 'none'; read.textContent = hint; });
    chart.textContent = ''; chart.appendChild(svg); read.textContent = hint;
  }

  // ---- dropdown menus (button + listbox): click to open, click / Enter to choose, Esc or outside click to close, arrow keys to move
  var dds = Array.prototype.slice.call(root.querySelectorAll('.pg-dd'));
  function parts(dd) { return { btn: dd.querySelector('.pg-dd-btn'), menu: dd.querySelector('.pg-dd-menu'), opts: Array.prototype.slice.call(dd.querySelectorAll('[role="option"]')) }; }
  function close(dd, refocus) { var p = parts(dd); if (p.menu.hidden) return; p.menu.hidden = true; p.btn.setAttribute('aria-expanded', 'false'); dd.classList.remove('open'); if (refocus) p.btn.focus(); }
  function open(dd) { dds.forEach(function (o) { if (o !== dd) close(o); }); var p = parts(dd); p.menu.hidden = false; p.btn.setAttribute('aria-expanded', 'true'); dd.classList.add('open'); var sel = p.opts.filter(function (o) { return o.getAttribute('aria-selected') === 'true'; })[0] || p.opts[0]; if (sel) sel.focus(); }
  function choose(dd, opt) {
    var p = parts(dd); p.opts.forEach(function (o) { o.setAttribute('aria-selected', o === opt ? 'true' : 'false'); });
    p.btn.querySelector('.pg-dd-val').textContent = opt.textContent; state[dd.getAttribute('data-dd')] = opt.getAttribute('data-value'); close(dd, true); draw();
  }
  dds.forEach(function (dd) {
    var p = parts(dd);
    p.btn.addEventListener('click', function () { p.menu.hidden ? open(dd) : close(dd); });
    p.btn.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(dd); } });
    p.opts.forEach(function (o) { o.addEventListener('click', function () { choose(dd, o); }); });
    p.menu.addEventListener('keydown', function (e) {
      var i = p.opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); p.opts[Math.min(p.opts.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); p.opts[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); p.opts[0].focus(); } else if (e.key === 'End') { e.preventDefault(); p.opts[p.opts.length - 1].focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i >= 0) choose(dd, p.opts[i]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(dd, true); } else if (e.key === 'Tab') close(dd);
    });
  });
  document.addEventListener('click', function (e) { dds.forEach(function (dd) { if (!dd.contains(e.target)) close(dd); }); });
  root.addEventListener('pg:data', function (e) {              // live refresh: new payment data arrived, redraw without touching the chosen period / graph type
    byDay = {}; first = null;
    (e.detail || []).forEach(function (r) { var d = +r[0]; byDay[d] = { a: +r[1] || 0, n: +r[2] || 0 }; if (first === null || d < first) first = d; });
    draw();
  });
  draw();
})();
