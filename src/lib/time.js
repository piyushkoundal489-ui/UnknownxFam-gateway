// All times shown to people (pages, e-mails, audit trails) are in Indian Standard Time (IST, UTC+05:30, no daylight saving).
// Stored values and API/JSON timestamps stay UTC (unix seconds / ISO "Z") so integrations are unaffected.
const IST_OFFSET = 19800;
const p2 = (n) => String(n).padStart(2, '0');
const parts = (sec) => { const d = new Date((Number(sec) + IST_OFFSET) * 1000); const h24 = d.getUTCHours(); return { y: d.getUTCFullYear(), mo: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()), h: String(h24 % 12 || 12), ap: h24 >= 12 ? 'pm' : 'am', mi: p2(d.getUTCMinutes()), s: p2(d.getUTCSeconds()) }; };
const ok = (sec) => sec != null && sec !== '' && Number.isFinite(Number(sec));
// One style everywhere people read a time: time first (12-hour, am/pm), then the date as DD-MM-YYYY — "1:20 am 21-10-2026".
/** "1:20 am 21-10-2026" (unix seconds in, IST out) */
export const fmtIST = (sec) => { if (!ok(sec)) return '—'; const t = parts(sec); return `${t.h}:${t.mi} ${t.ap} ${t.d}-${t.mo}-${t.y}`; };
/** "1:20:07 am 21-10-2026" */
export const fmtISTs = (sec) => { if (!ok(sec)) return '—'; const t = parts(sec); return `${t.h}:${t.mi}:${t.s} ${t.ap} ${t.d}-${t.mo}-${t.y}`; };
/** "2026-10-09" (the IST calendar day; a sortable key for CSV/exports, not display text) */
export const dayIST = (sec) => { if (!ok(sec)) return '—'; const t = parts(sec); return `${t.y}-${t.mo}-${t.d}`; };
/** same as fmtIST but for millisecond timestamps (e.g. Gmail internalDate) */
export const fmtISTms = (ms) => (ok(ms) ? fmtIST(Number(ms) / 1000) : '—');
/** API `date` fields: same style as the pages. */
export const fmtISTEmail = (sec) => (ok(sec) ? fmtIST(sec) : null);
/** kept for older imports — identical to fmtIST now */
export const fmtISTdmy = fmtIST;
