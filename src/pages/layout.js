import { html, raw } from '../lib/html.js';
import { INSTAGRAM_URL } from '../lib/social.js';

export function shell({ title, user, body, narrow = false, bodyClass = '', robots = 'noindex, nofollow' }) {
  const isStaff = !!user && ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'].includes(user.role);
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — UnknownXfam Gateway</title>
<meta name="robots" content="${robots}">
<link rel="icon" href="/assets/logo.webp">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<meta name="theme-color" content="#ffffff">
<script src="/assets/theme.js"></script>
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/theme.css">
<link rel="stylesheet" href="/assets/toast.css">
${user && user.approval === 'approved' ? raw('<meta name="gw-notify" content="1">') : ''}
<script src="/assets/toast.js" defer></script>
<script src="/assets/confirm.js" defer></script>
<script src="/assets/nopress.js" defer></script>
<script src="/assets/motion.js" defer></script>
</head>
<body class="${bodyClass}">
<nav class="topnav${user ? (isStaff ? ' nav-user nav-staff' : ' nav-user') : ''}">
  <div class="brand"><span class="brand-mark"><img src="/assets/logo.webp" alt="Gateway logo" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"></span><div class="brand-name">UnknownXfam <span>Gateway</span></div></div>
  <div class="links">
  <button type="button" class="theme-toggle" data-theme-toggle role="switch" aria-label="Dark theme" aria-checked="false"><svg class="tt-sun" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5" stroke="none"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" fill="none"/></svg><svg class="tt-moon" viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 3.2a8.6 8.6 0 1 0 6.3 12.9 7 7 0 0 1-6.3-12.9z"/><path d="M19.2 4.2l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg><span class="tt-knob"></span></button>
  ${user ? html`<a href="/dashboard" class="btn small"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg><span>Dashboard</span></a><a href="/settings" class="btn small" aria-label="Open profile settings" title="Profile settings"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg><span>Profile</span></a>${['SUPPORT', 'ADMIN', 'SUPER_ADMIN'].includes(user.role) ? html`<a href="/admin" class="btn small admin-link"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><path d="M5 22h14"/></svg><span>Admin</span></a>` : ''}<a href="/logout" class="btn small danger"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg><span>Logout</span></a>`
        : html`<a href="/login" class="btn small">Login</a><a href="/register" class="btn small primary">Get Started</a>`}
  </div>
</nav>
<div class="wrap${narrow ? ' narrow' : ''}">
${body}
  <footer>© 2026 UnknownXfam Gateway · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms</a><div class="support-row"><a class="support-strip" href="https://t.me/UnknownNvrDie" target="_blank" rel="noopener noreferrer"><span class="ss-ic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.5 3.6 2.9 10.8c-1.3.5-1.2 1.3-.2 1.6l4.7 1.5 1.8 5.6c.2.6.4.8.9.8s.7-.2 1-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8L22.9 5c.3-1.2-.4-1.7-1.4-1.4zM9 13.6l9.3-5.9c.4-.3.8-.1.5.2l-7.6 6.9-.3 3.2z"/></svg></span><span>Support - <b>@UnknownNvrDie</b></span></a><a class="support-strip follow-strip" href="${INSTAGRAM_URL}" target="_blank" rel="noopener noreferrer" aria-label="Follow us on Instagram"><span class="ss-ic"><img src="/assets/instagram.webp" alt="" width="20" height="20" loading="lazy"></span><span><b>Follow us</b></span></a><span class="ss-break"></span><a class="support-strip designed-strip" href="https://www.instagram.com/myslf_kavyaa?exln=bGpoZGRjNXA0YTFm" target="_blank" rel="noopener noreferrer"><span class="ss-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14"/></svg></span><span>Designed By</span></a></div><br></footer>
</div>
</body>
</html>`;
}
// Short success messages (type 'ok') become bottom pop-ups when scripts run (toast.js); errors, long messages and type 'keep' (anything the person must copy, like a new API key) stay as a normal banner.
export const alert = (msg, type = 'ok') => (msg ? html`<div class="alert ${type === 'err' ? 'err' : 'ok'}" role="alert"${type === 'ok' && String(msg).length <= 120 ? raw(' data-toast') : ''}>${msg}</div>` : '');
export const banner = (title, body, cls = 'wait') => html`<div class="banner ${cls}"><b>${title}</b>${body}</div>`;
export const csrfField = (token) => raw(`<input type="hidden" name="_csrf" value="${String(token).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}">`);
