// Renders a plain black-and-white PNG QR (server-side, for /temporary/qr/*.png). No styling here — this must be a
// generic scannable image; the purple-styled version customers see is drawn client-side on the /pay page.
import { qrMatrix } from './qr-encode.js';
import { encodePng } from './png.js';

export function qrCodePng(text, { scale = 6, quiet = 4 } = {}) {
  const q = qrMatrix(text, 'H');
  const modules = q.size + quiet * 2; const px = modules * scale;
  return encodePng(px, px, (x, y) => {
    const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
    if (mx < 0 || my < 0 || mx >= q.size || my >= q.size) return false;   // quiet zone: white
    return q.isDark(my, mx);
  });
}
/** A plain placeholder (light gray) for expired/settled/unknown orders — still a real, valid PNG. */
export function placeholderPng({ size = 240 } = {}) { return encodePng(size, size, () => false); }
