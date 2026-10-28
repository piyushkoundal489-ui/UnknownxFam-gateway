// Sends the OTP emails through the Gmail account the super-admin signed in to (Gmail API, "send" permission).
// The Gmail API is the transport (no SMTP credentials to manage; works on Render's outbound HTTPS).
import { LOGO_CID, logoBytes } from './email-templates.js';
import { getSettings, setSetting, run, now } from '../lib/db.js';
import { seal, open, b64, b64u } from '../lib/crypto.js';
import { cfg } from '../lib/config.js';
import { G, accessTokenFromRefresh, forgetCachedToken } from '../gmail/google.js';
import { releaseGrant } from '../gmail/connection.js';

const SENDER_KEYS = ['sender_refresh_enc', 'sender_email', 'sender_scopes', 'sender_connected_at', 'mail_from_name', 'mail_tested', 'otp_signup', 'otp_login', 'otp_subject', 'otp_body'];
export const getMailSettings = (env) => getSettings(env, SENDER_KEYS);
export async function mailConfigured(env) { const s = await getMailSettings(env); return !!(s.sender_refresh_enc && s.sender_email); }
export const senderCanRead = (s) => !!(s.sender_refresh_enc && s.sender_scopes.includes('gmail.readonly'));

export async function senderForget(env) {
  for (const k of ['sender_refresh_enc', 'sender_email', 'sender_scopes', 'sender_connected_at']) await setSetting(env, k, '');
  for (const k of ['mail_tested', 'otp_signup', 'otp_login']) await setSetting(env, k, '0');
  forgetCachedToken('sender');
}
export async function senderSave(env, { refreshToken, email, scopes }) {
  await setSetting(env, 'sender_refresh_enc', await seal(cfg(env).encryptionKey, refreshToken));
  await setSetting(env, 'sender_email', email); await setSetting(env, 'sender_scopes', scopes); await setSetting(env, 'sender_connected_at', String(now()));
  for (const k of ['mail_tested', 'otp_signup', 'otp_login']) await setSetting(env, k, '0');   // must be re-tested before codes are required
  forgetCachedToken('sender');
}
export async function senderDisconnect(env) {
  const s = await getMailSettings(env);
  const rt = s.sender_refresh_enc ? await open(cfg(env).encryptionKey, s.sender_refresh_enc) : null;
  // Google ends ALL of this app's access to a Google account when one token is revoked, so this only revokes when no user's inbox uses the same account.
  if (rt) await releaseGrant(env, { email: s.sender_email, refreshToken: rt, exceptUserId: 0, ignoreSender: true });
  await senderForget(env);
}
/** Access token for the sender account (null if not connected or access was revoked). */
export async function senderAccessToken(env) {
  const s = await getMailSettings(env); if (!s.sender_refresh_enc) return null;
  const rt = await open(cfg(env).encryptionKey, s.sender_refresh_enc); if (!rt) return null;
  const r = await accessTokenFromRefresh(env, 'sender', rt);
  if (r.revoked) { await senderForget(env); return null; }
  return r.token || null;
}

const clean = (s) => String(s).replace(/[\r\n\0]/g, '').trim();
const encWord = (t) => '=?UTF-8?B?' + b64(new TextEncoder().encode(t)) + '?=';
/** RFC 5322 message, UTF-8, base64 body, RFC 2047 headers. Header values are stripped of CR/LF (no header injection). */
export function buildMessage({ from, fromName, to, subject, body, htmlBody, host = 'localhost', inline = [] }) {
  const encodeBody = (value) => b64(new TextEncoder().encode(String(value).replace(/\r\n|\r/g, '\n'))).replace(/(.{76})/g, '$1\r\n');
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const headers = ['From: ' + encWord(clean(fromName)) + ' <' + clean(from) + '>', 'To: <' + clean(to) + '>', 'Subject: ' + encWord(clean(subject)),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'), 'Message-ID: <' + id + '@' + clean(host) + '>', 'MIME-Version: 1.0', 'Auto-Submitted: auto-generated'];
  if (htmlBody == null) return headers.concat(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']).join('\r\n') + '\r\n\r\n' + encodeBody(body);
  const boundary = '----=_UnknownxGateway_' + id;
  const alternative = [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodeBody(body), `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodeBody(htmlBody), `--${boundary}--`];
  if (!inline.length) return headers.concat([`Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...alternative]).join('\r\n');
  // images that the HTML shows via cid: (the logo) travel inside the message: multipart/related -> [ alternative(text, html), image... ]
  const rel = '----=_UnknownxRelated_' + id;
  const parts = inline.flatMap((im) => [`--${rel}`, `Content-Type: ${im.type}; name="${im.filename}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${im.cid}>`,
    `Content-Disposition: inline; filename="${im.filename}"`, '', b64(im.data).replace(/(.{76})/g, '$1\r\n')]);
  return headers.concat([`Content-Type: multipart/related; type="multipart/alternative"; boundary="${rel}"`, '', `--${rel}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...alternative, ...parts, `--${rel}--`]).join('\r\n');
}

export async function sendMail(env, to, subject, body, { htmlBody, fromName } = {}) {
  to = clean(to);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return { ok: false, error: 'bad_recipient' };
  const s = await getMailSettings(env); if (!s.sender_refresh_enc || !s.sender_email) return { ok: false, error: 'not_configured' };
  const token = await senderAccessToken(env);
  if (!token) return { ok: false, error: 'Sender Gmail access ended (revoked or expired at Google). Reconnect it in the admin panel.' };
  const host = new URL(cfg(env).appUrl || 'https://localhost').hostname;
  const logo = htmlBody && htmlBody.includes('cid:' + LOGO_CID) ? logoBytes() : null;
  const inline = logo ? [{ cid: LOGO_CID, type: 'image/png', filename: 'logo.png', data: logo }] : [];
  const mime = buildMessage({ from: s.sender_email, fromName: fromName || s.mail_from_name || 'UnknownXfam Gateway', to, subject, body, htmlBody, host, inline });
  try {
    const r = await fetch(`${G.API}/messages/send`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64u(new TextEncoder().encode(mime)) }), signal: AbortSignal.timeout(10000) });
    return r.status === 200 ? { ok: true } : { ok: false, error: `Gmail refused to send (HTTP ${r.status})` };
  } catch { return { ok: false, error: 'Gmail send failed' }; }
}
