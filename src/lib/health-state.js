// Tiny in-memory record of "is payment checking (reading Gmail for FamApp payment e-mails) working?". No imports on purpose, so the Gmail helper
// can report into it without import cycles. Read by /health and by the alert watchdog (src/services/monitor.js).
const nowSec = () => Math.floor(Date.now() / 1000);
export const LIMITS = { failAfterSec: 60, stallAfterSec: 90, evidenceSec: 300 };
const S = { pollOn: false, lastRoundAt: 0, lastGoodAt: 0, badSince: 0, lastBadAt: 0, lastError: '' };

/** Called once at start-up: pollOn = the fast Gmail poll loop is enabled. */
export function configure({ pollOn }) { S.pollOn = !!pollOn; S.lastRoundAt = nowSec(); S.lastGoodAt = 0; S.badSince = 0; S.lastBadAt = 0; S.lastError = ''; }
/** A Gmail API call got a normal answer. */
export function gmailOk() { S.lastGoodAt = nowSec(); S.badSince = 0; }
/** Gmail did not answer properly (network error, timeout, 429, 5xx) or the poll round itself failed. */
export function gmailBad(msg) { const t = nowSec(); if (!S.badSince) S.badSince = t; S.lastBadAt = t; S.lastError = String(msg || 'unknown problem').replace(/[\r\n]+/g, ' ').slice(0, 140); }
/** One poll round finished (ok) or crashed (not ok, e.g. the database is unreachable). */
export function roundDone(ok, err) { S.lastRoundAt = nowSec(); if (!ok) gmailBad('Server error: ' + (err || 'poll round failed')); }
/** @returns {{state: 'off'|'ok'|'degraded'|'stalled', since: number, error: string}} */
export function currentHealth(t = nowSec()) {
  if (!S.pollOn) return { state: 'off', since: 0, error: '' };
  if (t - S.lastRoundAt > LIMITS.stallAfterSec) return { state: 'stalled', since: S.lastRoundAt, error: 'The payment-check loop has not run for ' + Math.round((t - S.lastRoundAt) / 60 * 10) / 10 + ' min' };
  if (S.badSince && t - S.badSince >= LIMITS.failAfterSec && t - S.lastBadAt <= LIMITS.evidenceSec) return { state: 'degraded', since: S.badSince, error: S.lastError };
  return { state: 'ok', since: 0, error: '' };
}
export const _state = S;
