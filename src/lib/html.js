// Auto-escaping HTML templates: every ${value} is escaped unless it is already Safe HTML.
// This makes stored/reflected XSS structurally hard — you must call raw() to opt out.
export class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
const val = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
export function html(strings, ...vals) { let out = strings[0]; for (let i = 0; i < vals.length; i++) out += val(vals[i]) + strings[i + 1]; return new Safe(out); }
/** JSON for a <script type="application/json"> block (safe against </script> and HTML comments). */
export const jsonBlock = (o) => raw(JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
