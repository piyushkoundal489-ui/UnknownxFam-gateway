// Shared look for every e-mail the gateway sends (except the OTP code mails, which keep their own layout and only get the logo on top).
// The logo is embedded in the message (CID attachment, see mail.js) so it shows without "load images" prompts.
import { STATIC_ASSETS } from '../static.js';
import { cfg } from '../lib/config.js';

export const LOGO_CID = 'gwlogo@unknownxfam.gateway';
export const LOGO_PATH = '/assets/logo-email.png';
export const logoBytes = () => STATIC_ASSETS[LOGO_PATH]?.body || null;
export const SUPPORT_URL = 'https://t.me/UnknownNvrDie';
export const SUPPORT_HANDLE = '@UnknownNvrDie';

export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Small logo that sits INSIDE a line of text like an emoji (first line of every e-mail). */
export const logoInline = (size = 22) => (logoBytes()
  ? `<img src="cid:${LOGO_CID}" width="${size}" height="${size}" alt="" style="display:inline-block;vertical-align:-${Math.round(size * 0.26)}px;margin-right:8px;border:0;border-radius:${Math.round(size / 4)}px;">` : '');

/** The embedded logo (empty string if the file is missing, so a broken-image icon is never shown). */
export const logoImg = (size = 56, style = '') => (logoBytes()
  ? `<img src="cid:${LOGO_CID}" width="${size}" height="${size}" alt="UnknownXfam Gateway" style="display:block;border:0;outline:none;border-radius:${Math.round(size / 4)}px;${style}">` : '');

/**
 * Builds one e-mail (HTML + plain-text twin).
 * { emoji, title, name, paragraphs[], rows[[label,value]], cta:{label,url}, note, preheader, accent }
 */
export function buildEmail(env, { emoji = '', title, name = '', greet = true, paragraphs = [], code = '', bullets = [], rows = [], cta = null, note = '', preheader = '', accent = '#e3a24a' }) {
  const c = cfg(env); const site = c.appUrl || '';
  const hi = name ? `Hi ${name} 👋` : 'Hi there 👋';
  const rowsHtml = rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;background:#faf6ee;border:1px solid #eee2c8;border-radius:12px;">${rows.map(([k, v, o], i) =>
    `<tr><td style="padding:11px 14px;${i ? 'border-top:1px solid #eee2c8;' : ''}font-size:13px;color:#7a6a4f;width:34%;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:11px 14px;${i ? 'border-top:1px solid #eee2c8;' : ''}font-size:14px;color:#1f2937;font-weight:600;vertical-align:top;word-break:break-word;">${o && o.mono ? `<span style="font-family:Consolas,'Courier New',monospace;font-size:15px;letter-spacing:.4px;background:#fff3d6;border:1px solid #f0dca8;border-radius:8px;padding:3px 8px;word-break:break-all;">${escapeHtml(v)}</span>` : escapeHtml(v)}</td></tr>`).join('')}</table>` : '';
  const ctaHtml = cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr><td style="background:${accent};border-radius:999px;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#1b1206;text-decoration:none;">${escapeHtml(cta.label)}</a></td></tr></table>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f2eb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f5f2eb;">${escapeHtml(preheader || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2eb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:17px;font-weight:700;color:#1f2937;white-space:nowrap;">${logoInline(23)}UnknownXfam <span style="color:#c98a2b;">Gateway</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid #eadfca;border-top:4px solid ${accent};border-radius:16px;padding:28px 26px;font-family:${FONT};color:#374151;">
  <div style="font-size:36px;line-height:1.1;">${emoji}</div>
  <h1 style="margin:10px 0 14px;font-size:22px;line-height:1.3;color:#1f2937;font-family:${FONT};">${escapeHtml(title)}</h1>
  ${greet ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(hi)}</p>` : ''}
  ${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(p)}</p>`).join('')}
  ${code ? `<div style="margin:18px 0 8px;text-align:center;"><span style="display:inline-block;background:#fff7e6;border:1.5px dashed ${accent};border-radius:14px;padding:14px 22px;font-family:Consolas,'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#1f2937;">${escapeHtml(code)}</span></div>` : ''}
  ${bullets.map((b) => `<p style="margin:6px 0;font-size:14px;line-height:1.55;color:#4b5563;">${escapeHtml(b)}</p>`).join('')}
  ${rowsHtml}${ctaHtml}
  ${note ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:#6b7280;">💡 ${escapeHtml(note)}</p>` : ''}
</td></tr>
<tr><td align="center" style="padding:18px 8px 0;font-family:${FONT};font-size:12.5px;line-height:1.7;color:#7b7466;">
  📩 Need help? Message us on Telegram <a href="${SUPPORT_URL}" style="color:#b9791d;text-decoration:none;font-weight:600;">${SUPPORT_HANDLE}</a><br>${site ? `🌐 <a href="${escapeHtml(site)}" style="color:#b9791d;text-decoration:none;font-weight:600;">Open the gateway</a><br>` : ''}
  This is an automated message, please do not reply to it.<br>© 2026 UnknownXfam Gateway 🕊️
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`${emoji} ${title}`.trim(), '', ...(greet ? [hi, ''] : []), ...paragraphs.flatMap((p) => [p, '']), ...(code ? [code, ''] : []), ...(bullets.length ? [...bullets, ''] : []), ...(rows.length ? [...rows.map(([k, v]) => `${k}: ${v}`), ''] : []),
    ...(cta ? [`${cta.label}: ${cta.url}`, ''] : []), ...(note ? [`💡 ${note}`, ''] : []), `📩 Need help? Telegram ${SUPPORT_HANDLE} (${SUPPORT_URL})`, 'This is an automated message, please do not reply to it.', '— UnknownXfam Gateway 🕊️'].join('\n');
  return { html, text };
}

/** The admin's text -> HTML, exactly as typed: line breaks, blank lines and runs of spaces are kept, emojis stay, links become clickable. */
export function messageToHtml(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    let h = escapeHtml(line.replace(/\t/g, '    '));
    h = h.replace(/https?:\/\/[^\s]+/g, (m) => { const t = m.match(/[.,:!?)\]}]+$/); const trail = t ? t[0] : ''; const url = trail ? m.slice(0, -trail.length) : m;
      return `<a href="${url}" style="color:#b9791d;word-break:break-all;">${url}</a>${trail}`; });
    h = h.replace(/^ +/, (m) => '&nbsp;'.repeat(m.length)).replace(/ {2,}/g, (m) => ' ' + '&nbsp;'.repeat(m.length - 1));
    return h;
  }).join('<br>');
}

/** One announcement e-mail: logo + name centred on the first line, then the admin's message from the next line, exactly as typed. */
export function announcementEmail(env, message) {
  const site = String(cfg(env).appUrl || '');
  const pre = String(message).replace(/\s+/g, ' ').trim().slice(0, 110);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>UnknownXfam Gateway</title></head>
<body style="margin:0;padding:0;background:#f5f2eb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f5f2eb;">${escapeHtml(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2eb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:17px;font-weight:700;color:#1f2937;white-space:nowrap;">${logoInline(23)}UnknownXfam <span style="color:#c98a2b;">Gateway</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid #eadfca;border-top:4px solid #e3a24a;border-radius:16px;padding:24px 24px;font-family:${FONT};font-size:15px;line-height:1.65;color:#1f2937;word-wrap:break-word;overflow-wrap:break-word;">${messageToHtml(message)}</td></tr>
<tr><td align="center" style="padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:#7b7466;">
  🕊️ UnknownXfam Gateway &nbsp;·&nbsp; 📩 <a href="${SUPPORT_URL}" style="color:#b9791d;text-decoration:none;font-weight:600;">${SUPPORT_HANDLE}</a><br>${site ? `🌐 <a href="${escapeHtml(site)}" style="color:#b9791d;text-decoration:none;font-weight:600;">Open the gateway</a><br>` : ''}
  You are receiving this because you have an account on UnknownXfam Gateway.
</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${String(message).replace(/\r\n?/g, '\n')}\n\n— UnknownXfam Gateway 🕊️\nSupport: ${SUPPORT_HANDLE} (${SUPPORT_URL})`;
  return { html, text };
}
