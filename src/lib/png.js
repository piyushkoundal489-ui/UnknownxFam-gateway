// Minimal, dependency-free PNG encoder for a 1-bit-per-pixel image, for the /temporary/qr/*.png route.
// There is no <canvas> on the server, so this hand-rolls: PNG chunks (CRC32) + a valid zlib stream built ONLY from
// "stored" (uncompressed) deflate blocks — no compression library needed, just correct bit-packing.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function adler32(buf) {
  let a = 1, b = 0; const MOD = 65521;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % MOD; b = (b + a) % MOD; }
  return ((b << 16) | a) >>> 0;
}
function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16le(n) { return [n & 255, (n >>> 8) & 255]; }

/** Wraps raw bytes in a valid zlib stream using only stored (BTYPE=00) deflate blocks. */
function zlibStore(raw) {
  const blocks = []; const MAX = 65535;
  for (let off = 0; off < raw.length || off === 0; off += MAX) {
    const chunk = raw.subarray(off, Math.min(off + MAX, raw.length));
    const isFinal = off + MAX >= raw.length;
    blocks.push(isFinal ? 1 : 0, ...u16le(chunk.length), ...u16le(chunk.length ^ 0xffff), ...chunk);
    if (raw.length === 0) break;
  }
  return new Uint8Array([0x78, 0x01, ...blocks, ...u32be(adler32(raw))]);
}
function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array([...t, ...data]);
  return new Uint8Array([...u32be(data.length), ...body, ...u32be(crc32(body))]);
}

/**
 * Encodes a grayscale (8-bit, color type 0) PNG from get(x,y) -> true (black) | false (white).
 * @returns {Uint8Array}
 */
export function encodePng(width, height, get) {
  const stride = width + 1;                          // +1 filter-type byte per scanline
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;                              // filter type 0 (none)
    for (let x = 0; x < width; x++) raw[y * stride + 1 + x] = get(x, y) ? 0 : 255;
  }
  const ihdr = new Uint8Array([...u32be(width), ...u32be(height), 8, 0, 0, 0, 0]);  // bit depth 8, color type 0 (grayscale)
  const idat = zlibStore(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0))]);
}
