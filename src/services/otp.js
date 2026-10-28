// One-time email codes for sign-up verification, login (2-step or code-only) and password reset.
// 6 digits, 10 min, single use, 5 wrong tries, 60 s between sends, 5 per hour per address. Only a salted HMAC is stored.
import { logoInline, buildEmail } from './email-templates.js';
import { cfg } from '../lib/config.js';
import { first, run, now, changes } from '../lib/db.js';
import { randomInt, randomHex, hmacHex, safeEqual } from '../lib/crypto.js';
import { sendMail } from './mail.js';

export const OTP_TTL = 600, OTP_MAX_ATTEMPTS = 5, OTP_COOLDOWN = 60, OTP_MAX_PER_HOUR = 5;
export const OTP_PURPOSES = ['signup', 'login', 'reset'];
export const OTP_SPAM_NOTE = 'If the OTP is not in your inbox, please check your Spam folder.';
export const OTP_DEFAULT_SUBJECT = '🔐 UnknownXfam Gateway — Verification Code';
export const OTP_DEFAULT_BODY = "🔐 UnknownXfam Gateway — Verification Code\n\nYour OTP is:\n\n{{OTP}}\n\nUse this code to verify your account on UnknownXfam Gateway.\n\n⏱️ This OTP is valid for {{EXPIRY}} minutes.\n⚠️ Never share this OTP with anyone.\n\nIf you didn't request this code, you can safely ignore this message. No action needed.\n\n— UnknownXfam Gateway";

export const otpRender = (tpl, code, minutes) => tpl.replaceAll('{{OTP}}', code).replaceAll('{{EXPIRY}}', String(minutes));
export function otpEmail(code, subject = '', body = '') {
  const s = subject || OTP_DEFAULT_SUBJECT; let b = body || OTP_DEFAULT_BODY;
  if (!b.includes('{{OTP}}')) b = OTP_DEFAULT_BODY;               // a template without the code would be useless
  const m = OTP_TTL / 60; return [otpRender(s, code, m), otpRender(b, code, m)];
}

const OTP_KINDS = {
  signup: { emoji: '🔐', name: 'Verification Code', title: 'Verify your email', lead: 'Use this code to verify your email and finish creating your UnknownXfam Gateway account.', ignore: "If you didn't create an account, you can safely ignore this message. No action needed." },
  login: { emoji: '🔓', name: 'Login Code', title: 'Your login code', lead: 'Use this code to log in to your UnknownXfam Gateway account.', ignore: "If you didn't try to log in, you can safely ignore this message. No action needed." },
  reset: { emoji: '🔑', name: 'Password Reset Code', title: 'Reset your password', lead: 'Use this code to reset the password of your UnknownXfam Gateway account.', ignore: "If you didn't ask to reset your password, you can safely ignore this message. Your password will not change." },
};
/** The e-mail for one code: { subject, text, html }. Each purpose has its own wording (a password reset no longer says "verify your account").
 *  Text the admin customised under Admin → Support email still applies to sign-up and login codes; reset codes always use the reset wording. */
export function otpMessage(env, purpose, code, customSubject = '', customBody = '') {
  const m = OTP_TTL / 60;
  if ((customSubject || customBody) && purpose !== 'reset') { const [subject, text] = otpEmail(code, customSubject, customBody); return { subject, text, html: otpHtml(text, code) }; }
  const k = OTP_KINDS[purpose] || OTP_KINDS.signup;
  const text = [`${k.emoji} UnknownXfam Gateway — ${k.name}`, '', 'Your OTP is:', '', code, '', k.lead, '', `⏱️ This OTP is valid for ${m} minutes.`, '⚠️ Never share this OTP with anyone.', '', k.ignore, '', '— UnknownXfam Gateway'].join('\n');
  const { html } = buildEmail(env, { emoji: k.emoji, title: k.title, greet: false, paragraphs: [k.lead], code, bullets: [`⏱️ This code is valid for ${m} minutes.`, '⚠️ Never share it with anyone. Our team will never ask for it.'], note: k.ignore, preheader: `Your code is ${code}` });
  return { subject: `${k.emoji} UnknownXfam Gateway — ${k.name}`, text, html };
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
export function otpHtml(body, code) {
  const lines = String(body).split(/\r?\n/);
  let firstDone = false;
  const content = lines.map((line) => {
    if (line && line !== String(code) && !firstDone) { firstDone = true; return `<p style="margin:0 0 10px;line-height:1.55;color:#253247;font-weight:700">${logoInline(21)}${escapeHtml(line)}</p>`; }
    if (!line) return '<div style="height:8px;line-height:8px">&nbsp;</div>';
    if (line === String(code)) return `<div style="margin:12px 0 18px;text-align:left;font-size:32px;line-height:1.25;font-weight:700;letter-spacing:5px;color:#182230">${escapeHtml(line)}</div>`;
    return `<p style="margin:0 0 10px;line-height:1.55;color:#253247">${escapeHtml(line)}</p>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif"><main style="max-width:520px;margin:0 auto;padding:28px 24px;background:#fff;border:1px solid #e4e8ed;border-radius:12px">${content}</main></body></html>`;
}
const hashCode = (env, code, salt, email, purpose) => hmacHex(cfg(env).sessionSecret + salt, `${code}|${email}|${purpose}`);

export async function otpIssue(env, purpose, email, userId = null) {
  if (!OTP_PURPOSES.includes(purpose)) return { ok: false, code: 'bad_purpose' };
  email = email.trim().toLowerCase(); const t = now();
  const last = await first(env, 'SELECT MAX(created_at) AS m FROM email_otps WHERE email = ? AND purpose = ?', email, purpose);
  if (last && last.m && t - last.m < OTP_COOLDOWN) return { ok: false, code: 'cooldown', wait: OTP_COOLDOWN - (t - last.m) };
  const cnt = await first(env, 'SELECT COUNT(*) AS n FROM email_otps WHERE email = ? AND created_at > ?', email, t - 3600);
  if (cnt.n >= OTP_MAX_PER_HOUR) return { ok: false, code: 'rate_limited' };

  const code = String(randomInt(1000000)).padStart(6, '0'); const salt = randomHex(8);
  await run(env, 'UPDATE email_otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0', email, purpose);   // only the newest code can ever work
  const ins = await first(env, 'INSERT INTO email_otps(email,purpose,user_id,code_hash,salt,expires_at,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id',
    email, purpose, userId, await hashCode(env, code, salt, email, purpose), salt, t + OTP_TTL, t);
  const msg = otpMessage(env, purpose, code, await settingText(env, 'otp_subject'), await settingText(env, 'otp_body'));
  const r = await sendMail(env, email, msg.subject, msg.text, { htmlBody: msg.html });
  if (!r.ok) { await run(env, 'UPDATE email_otps SET used = 1 WHERE id = ?', ins.id); return { ok: false, code: 'send_failed' }; }
  return { ok: true };
}
/** Creates a reset code for an admin-assisted recovery. The code is returned once and is never emailed or stored in clear. */
export async function otpIssueManual(env, purpose, email, userId = null) {
  if (!OTP_PURPOSES.includes(purpose)) return { ok: false, code: 'bad_purpose' };
  email = email.trim().toLowerCase(); const t = now();
  const code = String(randomInt(1000000)).padStart(6, '0'); const salt = randomHex(8);
  await run(env, 'UPDATE email_otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0', email, purpose);
  await run(env, 'INSERT INTO email_otps(email,purpose,user_id,code_hash,salt,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
    email, purpose, userId, await hashCode(env, code, salt, email, purpose), salt, t + OTP_TTL, t);
  return { ok: true, code };
}
async function settingText(env, k) { const r = await first(env, 'SELECT v FROM app_settings WHERE k = ?', k); return r ? r.v : ''; }

/** Checks the newest unused code. Every guess is counted atomically, correct or not. */
export async function otpVerify(env, purpose, email, code) {
  email = email.trim().toLowerCase(); code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const r = await first(env, 'SELECT * FROM email_otps WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1', email, purpose);
  if (!r || r.expires_at < now()) return false;
  const bump = await first(env, 'UPDATE email_otps SET attempts = attempts + 1 WHERE id = ? AND used = 0 AND attempts < ? RETURNING attempts', r.id, OTP_MAX_ATTEMPTS);
  if (!bump) return false;                                        // out of tries (or consumed by a parallel request)
  if (!safeEqual(r.code_hash, await hashCode(env, code, r.salt, email, purpose))) return false;
  return changes(await run(env, 'UPDATE email_otps SET used = 1 WHERE id = ? AND used = 0', r.id)) === 1;
}
export function otpErrorMessage(r) {
  if (r.code === 'cooldown') return `Please wait ${r.wait || 60} seconds before asking for another code.`;
  if (r.code === 'rate_limited') return 'Too many codes were requested for this address. Please try again in an hour.';
  return "We couldn't send the email right now. Please try again later or contact support.";
}
export async function sweepOtps(env) { await run(env, 'DELETE FROM email_otps WHERE created_at < ?', now() - 86400); }

/** A code proves mailbox control. Code-only login on an unverified account discards the old password (anti pre-registration). */
export async function markEmailVerified(env, userId, discardOldPassword, newHash = null) {
  const u = await first(env, 'SELECT email_verified, role FROM users WHERE id = ?', userId);
  if (!u || u.email_verified) return;
  if (discardOldPassword && u.role === 'USER') await run(env, 'UPDATE users SET email_verified = 1, pass_hash = ? WHERE id = ?', newHash, userId);
  else await run(env, 'UPDATE users SET email_verified = 1 WHERE id = ?', userId);
  try { const { maybeAutoApprove } = await import('./auto-approve.js'); await maybeAutoApprove(env, userId); } catch { /* auto approve is best effort */ }
}
