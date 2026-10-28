/* Renders a real, scannable UPI QR in the purple neon style.
 * Requires assets/qr.js (QRCodeLib). Every pixel of the QR comes from the encoded text —
 * the styling (dark background, glowing border, panel) is drawn AROUND the QR, never over it.
 * Rules: error correction H, 4-module quiet zone on a white panel, no logo over modules. */
(function (global) {
  var QUIET = 4;                    // quiet-zone modules (QR spec minimum)
  var PAD = 46;                     // space between canvas edge and the white panel (border lives here)
  var BORDER_INSET = 14, BORDER_W = 4, GLOW = 22;

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw(canvas, text, opts) {
    opts = opts || {};
    var qr = global.QRCodeLib.create(text, 'H');
    var n = qr.getModuleCount(), total = n + QUIET * 2;
    var s = Math.max(3, Math.floor((opts.target || 520) / total));      // integer module size => crisp edges
    var panel = total * s, W = panel + PAD * 2, K = opts.scale || 2;   // K = backing-store scale
    canvas.width = W * K; canvas.height = W * K;
    var ctx = canvas.getContext('2d'); ctx.setTransform(K, 0, 0, K, 0, 0);

    // dark background with a soft purple glow
    var bg = ctx.createLinearGradient(0, 0, W, W); bg.addColorStop(0, '#07010f'); bg.addColorStop(1, '#14002e');
    ctx.fillStyle = bg; rr(ctx, 0, 0, W, W, 26); ctx.fill();
    var rg = ctx.createRadialGradient(W / 2, W / 2, panel / 3, W / 2, W / 2, W * 0.75);
    rg.addColorStop(0, 'rgba(124,58,237,0)'); rg.addColorStop(1, 'rgba(168,85,247,.28)');
    ctx.fillStyle = rg; rr(ctx, 0, 0, W, W, 26); ctx.fill();

    // neon border — drawn in the margin OUTSIDE the panel
    var g = ctx.createLinearGradient(0, 0, W, W);
    g.addColorStop(0, '#c084fc'); g.addColorStop(.5, '#7c3aed'); g.addColorStop(1, '#d946ef');
    ctx.save(); ctx.shadowColor = '#a855f7'; ctx.shadowBlur = GLOW; ctx.strokeStyle = g; ctx.lineWidth = BORDER_W;
    rr(ctx, BORDER_INSET, BORDER_INSET, W - BORDER_INSET * 2, W - BORDER_INSET * 2, 22); ctx.stroke(); ctx.restore();

    // white panel = QR + quiet zone (opaque, so nothing glows into the code area)
    ctx.fillStyle = '#ffffff'; rr(ctx, PAD, PAD, panel, panel, 12); ctx.fill();

    // modules (deep purple on white keeps strong contrast for scanners)
    ctx.fillStyle = '#16002e';
    var ox = PAD + QUIET * s, oy = PAD + QUIET * s;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + c * s, oy + r * s, s, s);

    // geometry, so tests can prove the border never touches the QR area
    var borderInner = BORDER_INSET + BORDER_W / 2 + GLOW;   // furthest the glow can reach inward
    return {
      modules: n, quietModules: QUIET, moduleSize: s, canvasSize: W, backing: W * K,
      panel: { x: PAD, y: PAD, size: panel }, qr: { x: ox, y: oy, size: n * s },
      glowReach: borderInner, clearance: PAD - borderInner,
      matrix: (function () { var out = ''; for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) out += qr.isDark(r, c) ? '1' : '0'; return out; })()
    };
  }
  global.PayQR = { draw: draw };
})(window);
