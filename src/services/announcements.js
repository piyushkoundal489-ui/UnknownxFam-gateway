// Admin -> Announcements: e-mail broadcasts typed by an admin (to one user or to every user).
// Recipients are stored one row each, so a long send continues after a restart (see resumeAnnouncements, called by maintenance) and the
// admin sees progress. E-mails go out one at a time (about 1.4 per second) because Gmail limits how fast a mailbox may send.
import { first, all, run, now } from '../lib/db.js';
import { sendMail, mailConfigured } from './mail.js';
import { announcementEmail } from './email-templates.js';
import { findUserByEmail } from '../auth/accounts.js';
import { audit } from '../admin/audit.js';
import { can } from '../admin/rbac.js';

export const MAX_MESSAGE = 10000, MAX_SUBJECT = 150;
export const DEFAULT_SUBJECT = '📢 Announcement from UnknownXfam Gateway';
const GAP_MS = 700, STOP_AFTER_FAILURES = 5;
const active = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cleanDraft(d = {}) {
  return {
    subject: String(d.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_SUBJECT),
    message: String(d.message || '').replace(/\r\n?/g, '\n').replace(/\s+$/, ''),      // exactly as typed (only trailing blank space is dropped)
    audience: d.audience === 'all' ? 'all' : d.audience === 'user' ? 'user' : '',
    email: String(d.email || '').trim().toLowerCase(),
  };
}

async function recipientsFor(env, d) {
  if (d.audience === 'user') {
    const u = await findUserByEmail(env, d.email);
    if (!u) return { ok: false, reason: 'No user found with that email address.' };
    return { ok: true, list: [{ id: u.id, name: u.name, email: u.email }] };
  }
  // everyone with an approved account that is not banned
  return { ok: true, list: await all(env, "SELECT id, name, email FROM users WHERE approval = 'approved' AND acct_status <> 'banned' ORDER BY id") };
}

/** Checks a draft and returns who would receive it (used by the confirmation step and again right before sending). */
export async function prepare(env, admin, draft) {
  if (!can(admin.role, 'announcements.send')) return { ok: false, reason: 'You cannot send announcements.' };
  const d = cleanDraft(draft);
  if (!d.message.trim()) return { ok: false, reason: 'Type a message first.' };
  if (d.message.length > MAX_MESSAGE) return { ok: false, reason: `The message is too long (maximum ${MAX_MESSAGE} characters).` };
  if (!d.audience) return { ok: false, reason: 'Choose who gets it: a particular user or all users.' };
  if (d.audience === 'user' && !d.email) return { ok: false, reason: "Enter the user's email address." };
  if (!(await mailConfigured(env))) return { ok: false, reason: 'Connect the support sender Gmail first (Admin → Support email).' };
  const rec = await recipientsFor(env, d); if (!rec.ok) return rec;
  if (!rec.list.length) return { ok: false, reason: 'There is nobody to send this to yet.' };
  return { ok: true, draft: d, recipients: rec.list };
}

export async function startAnnouncement(env, admin, draft, ip) {
  const p = await prepare(env, admin, draft); if (!p.ok) return p;
  const d = p.draft;
  if (d.audience === 'all' && await first(env, "SELECT 1 AS x FROM announcements WHERE status = 'sending' AND audience = 'all' LIMIT 1"))
    return { ok: false, reason: 'A broadcast to all users is still being sent. Wait until it finishes.' };
  const ins = await first(env, 'INSERT INTO announcements(admin_id, subject, message, audience, total, status, created_at) VALUES(?,?,?,?,?,?,?) RETURNING id',
    admin.id, d.subject || DEFAULT_SUBJECT, d.message, d.audience, p.recipients.length, 'sending', now());
  const id = Number(ins.id);
  for (let i = 0; i < p.recipients.length; i += 200) {
    const chunk = p.recipients.slice(i, i + 200);
    await run(env, 'INSERT INTO announcement_recipients(announcement_id, email, name) VALUES ' + chunk.map(() => '(?,?,?)').join(','), ...chunk.flatMap((r) => [id, r.email, r.name || '']));
  }
  await audit(env, { adminId: admin.id, targetUserId: d.audience === 'user' ? p.recipients[0].id : null, action: 'ANNOUNCEMENT_SENT', ip, metadata: { announcement_id: id, audience: d.audience, total: p.recipients.length } });
  kick(env, id);
  return { ok: true, id, total: p.recipients.length, audience: d.audience };
}

/** Starts (once per process) the background loop that sends the waiting recipients of one announcement. */
export function kick(env, id) {
  if (active.has(id)) return;
  active.add(id);
  runLoop(env, id).catch((e) => console.error('announcement ' + id + ' failed:', e && e.message)).finally(() => active.delete(id));
}

async function runLoop(env, id) {
  const a = await first(env, 'SELECT * FROM announcements WHERE id = ?', id);
  if (!a || a.status !== 'sending') return;
  const { html, text } = announcementEmail(env, a.message);
  let streak = 0;
  for (;;) {
    const r = await first(env, `UPDATE announcement_recipients SET status = 'sending' WHERE id = (
      SELECT id FROM announcement_recipients WHERE announcement_id = ? AND status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, email`, id);
    if (!r) break;
    const res = await sendMail(env, r.email, a.subject, text, { htmlBody: html });
    if (res.ok) { streak = 0; await run(env, "UPDATE announcement_recipients SET status = 'sent' WHERE id = ?", r.id); await run(env, 'UPDATE announcements SET sent = sent + 1 WHERE id = ?', id); }
    else {
      await run(env, "UPDATE announcement_recipients SET status = 'failed', error = ? WHERE id = ?", String(res.error || 'failed').slice(0, 200), r.id);
      await run(env, 'UPDATE announcements SET failed = failed + 1 WHERE id = ?', id);
      if (res.error !== 'bad_recipient') streak++;                      // one bad address must not stop the whole broadcast
      if (streak >= STOP_AFTER_FAILURES || res.error === 'not_configured') {
        await run(env, "UPDATE announcements SET status = 'stopped', note = ? WHERE id = ?", String(res.error === 'not_configured' ? 'The support sender Gmail is not connected.' : res.error || 'Gmail refused to send.').slice(0, 300), id);
        return;
      }
    }
    if (!(await first(env, "SELECT 1 AS x FROM announcement_recipients WHERE announcement_id = ? AND status = 'pending' LIMIT 1", id))) break;   // last one: finish at once
    await sleep(GAP_MS);
  }
  await run(env, "UPDATE announcements SET status = 'done', finished_at = ? WHERE id = ?", now(), id);
}

/** Maintenance: picks up broadcasts that were interrupted (e.g. the server restarted while sending). */
export async function resumeAnnouncements(env) {
  const rows = await all(env, "SELECT id FROM announcements WHERE status = 'sending'");
  for (const r of rows) {
    if (active.has(Number(r.id))) continue;
    await run(env, "UPDATE announcement_recipients SET status = 'pending' WHERE announcement_id = ? AND status = 'sending'", r.id);
    kick(env, Number(r.id));
  }
}

export async function retryAnnouncement(env, admin, id, ip) {
  if (!can(admin.role, 'announcements.send')) return { ok: false, reason: 'You cannot send announcements.' };
  const a = await first(env, 'SELECT id, status FROM announcements WHERE id = ?', Number(id));
  if (!a || a.status !== 'stopped') return { ok: false, reason: 'That broadcast is not stopped.' };
  await run(env, "UPDATE announcement_recipients SET status = 'pending', error = NULL WHERE announcement_id = ? AND status = 'failed'", a.id);
  await run(env, "UPDATE announcements SET status = 'sending', note = NULL, failed = 0 WHERE id = ?", a.id);
  await audit(env, { adminId: admin.id, action: 'ANNOUNCEMENT_RETRY', ip, metadata: { announcement_id: Number(a.id) } });
  kick(env, Number(a.id));
  return { ok: true, note: 'Sending continues with the remaining recipients.' };
}

export const listAnnouncements = (env, limit = 20) => all(env,
  'SELECT a.id, a.subject, a.audience, a.total, a.sent, a.failed, a.status, a.note, a.created_at, u.name AS admin_name FROM announcements a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ?', limit);
