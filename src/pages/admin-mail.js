import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { can } from '../admin/rbac.js';
import { adminTabs } from './admin-tabs.js';
import { RULES } from '../lib/ratelimit.js';
import { getMailSettings, senderCanRead, senderSave, senderDisconnect, sendMail } from '../services/mail.js';
import { getSetting, setSetting } from '../lib/db.js';
import { beginOAuth, consumeOAuthState, exchangeCode, senderScopeOk, idTokenClaims } from '../gmail/google.js';
import { releaseGrant } from '../gmail/connection.js';
import { OTP_DEFAULT_SUBJECT, OTP_DEFAULT_BODY } from '../services/otp.js';
import { audit } from '../admin/audit.js';
import { fmtISTms, fmtIST } from '../lib/time.js';
import { buildEmail } from '../services/email-templates.js';

const tabs = (user, active = 'mail') => adminTabs(user, active);

export async function adminMailPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!can(user.role, 'settings.manage')) return ctx.redirect('/admin');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    if (ctx.form.action === 'disconnect_sender') {
      await senderDisconnect(ctx.env); await audit(ctx.env, { adminId: user.id, action: 'MAIL_SENDER_DISCONNECTED', ip: ctx.ip });
      ctx._flash = ['Sender Gmail disconnected and its access revoked at Google. Email codes are switched off.', 'ok'];
    } else if (ctx.form.action === 'save_template') {
      const subj = (ctx.form.otp_subject || '').trim().slice(0, 120); const body = (ctx.form.otp_body || '').replace(/\r\n/g, '\n').slice(0, 2000);
      if (body.trim() && !body.includes('{{OTP}}')) ctx._flash = ['The email text must include {{OTP}} so the code is sent.', 'err'];
      else { await setSetting(ctx.env, 'otp_subject', subj); await setSetting(ctx.env, 'otp_body', body.trim()); ctx._flash = ['Email text saved.', 'ok']; }
    } else if (ctx.form.action === 'save_toggles') {
      const tested = (await getSetting(ctx.env, 'mail_tested')) === '1';
      const wantSignup = !!ctx.form.otp_signup, wantLogin = !!ctx.form.otp_login;
      await setSetting(ctx.env, 'otp_signup', wantSignup && tested ? '1' : '0'); await setSetting(ctx.env, 'otp_login', wantLogin && tested ? '1' : '0');
      ctx._flash = (wantSignup || wantLogin) && !tested ? ['Send a test email first — the code switches stay off until a test succeeds.', 'err'] : ['Settings saved.', 'ok'];
    } else if (ctx.form.action === 'test_mail') {
      const tm = buildEmail(ctx.env, { emoji: '✅', title: 'Your support email is working!', name: 'Admin', accent: '#2fbf8f', preheader: 'Test message from your UnknownXfam Gateway admin panel.',
        paragraphs: ['This is a test message from your UnknownXfam Gateway admin panel.', 'If you can read this, your support mailbox is connected and sending correctly 🎉'],
        rows: [['Status', 'Working ✅'], ['Sent to', ctx.c.adminEmail], ['Time', fmtIST(Math.floor(Date.now() / 1000))]], note: 'You can now switch the email code options on in Admin → Support email.' });
      const r = await sendMail(ctx.env, ctx.c.adminEmail, '✅ Test email from UnknownXfam Gateway', tm.text, { htmlBody: tm.html });
      if (r.ok) { await setSetting(ctx.env, 'mail_tested', '1'); ctx._flash = [`Test email sent to ${ctx.c.adminEmail}. Check your inbox, then you can switch the code options on.`, 'ok']; }
      else { await setSetting(ctx.env, 'mail_tested', '0'); ctx._flash = [`Test failed: ${r.error || 'unknown error'}.`, 'err']; }
      await audit(ctx.env, { adminId: user.id, action: 'MAIL_TEST_SENT', ip: ctx.ip, metadata: { ok: r.ok } });
    }
    return ctx.redirect('/admin/mail');
  }
  const s = await getMailSettings(ctx.env); const tested = (await getSetting(ctx.env, 'mail_tested')) === '1'; const flash = ctx._flashIn;
  const body = html`<p class="eyebrow">Admin panel</p><h1>Support email &amp; codes</h1>${tabs(user, 'mail')}${alert(flash?.[0], flash?.[1])}
  <div class="card"><p class="field-note" style="margin:0 0 12px;">Sign-up, login and password-reset codes are sent from the Gmail you connect here. Only the newest code works, once, for 10 minutes.</p>
  ${s.sender_refresh_enc ? html`<p style="margin:6px 0;"><span class="pill credited">✓ Connected</span> <b class="mono">${s.sender_email}</b></p>
      <p class="field-note" style="margin:4px 0 12px;">Signed in through Google. Permissions: <b>send email</b>${senderCanRead(s) ? ' and <b>read-only inbox</b>' : ' only — this connection cannot read the mailbox'}.</p>
      <div class="acts">${senderCanRead(s) ? html`<a class="btn small primary" href="/admin/inbox">Open Gmail inbox</a>` : ''}
        <form method="post" action="/admin/mail" class="inline" data-confirm="Disconnect this Gmail? Codes will stop until you connect one again.">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="disconnect_sender"><button class="btn small danger" type="submit">Disconnect Gmail</button></form></div>
      ${!senderCanRead(s) ? html`<a class="btn small" href="/admin/mail-connect?inbox=1" style="margin-top:10px;">Reconnect with inbox access</a>` : ''}`
    : ctx.c.googleClientId ? html`<a class="btn primary" href="/admin/mail-connect?inbox=1">Sign in with Google to choose the sender Gmail</a>
      <p class="field-note" style="margin:10px 0 0;">This also enables a read-only inbox here. <a href="/admin/mail-connect" style="color:inherit;font-weight:600;">Connect without inbox access</a>.</p>
      <p class="field-note">You sign in on Google's page; we never see your password or codes.</p>`
    : html`<p class="field-note">First set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ENCRYPTION_KEY.</p>`}
  </div>
  <div class="card"><h2>Email text (subject &amp; message)</h2><p class="field-note">Use <span class="mono">{{OTP}}</span> for the code and <span class="mono">{{EXPIRY}}</span> for the minutes it stays valid. Leave both empty for the default.</p>
    <form method="post" action="/admin/mail">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="save_template">
      <label for="otp_subject">Subject</label><input type="text" id="otp_subject" name="otp_subject" value="${s.otp_subject}" placeholder="${OTP_DEFAULT_SUBJECT}">
      <label for="otp_body">Message</label><textarea id="otp_body" name="otp_body" rows="10" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);font:inherit;" placeholder="${OTP_DEFAULT_BODY}">${s.otp_body}</textarea>
      <div class="actions"><button class="btn primary" type="submit">Save text</button></div></form></div>
  <div class="card"><h2>Code requirements</h2>
    <form method="post" action="/admin/mail">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="save_toggles">
      <label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" name="otp_signup" value="1"${s.otp_signup === '1' ? ' checked' : ''}> Require an email code at sign-up</label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:8px;"><input type="checkbox" name="otp_login" value="1"${s.otp_login === '1' ? ' checked' : ''}> Require an email code at login (2-step, users only)</label>
      <p class="field-note">Status: <b>${tested ? '✓ test email succeeded' : 'not tested yet'}</b></p>
      <div class="actions"><button class="btn primary" type="submit">Save</button></div></form>
    <form method="post" action="/admin/mail" style="margin-top:10px;"><input type="hidden" name="action" value="test_mail">${csrfField(await ctx.csrf())}<button class="btn" type="submit">Send test email to me</button></form></div>`;
  return ctx.page(shell({ title: 'Admin · Support email', user, body, bodyClass: 'dash' }));
}

export async function adminMailConnectRoute(ctx) {
  const user = await ctx.user(); if (!user || !can(user.role, 'settings.manage')) return ctx.redirect('/admin');
  const lim = await ctx.limit('oauth_ip', ctx.ip, RULES.oauth_ip); if (lim) return lim;
  if (!(ctx.c.googleClientId && ctx.c.googleClientSecret)) { ctx._flash = ['Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET first.', 'err']; return ctx.redirect('/admin/mail'); }
  const wantInbox = ctx.url.searchParams.get('inbox') === '1';
  const scope = 'openid email https://www.googleapis.com/auth/gmail.send' + (wantInbox ? ' https://www.googleapis.com/auth/gmail.readonly' : '');
  const url = await beginOAuth(ctx.env, { kind: 'gmail_sender', userId: user.id, scope, redirectUri: `${ctx.c.appUrl}/admin/mail-callback`, extra: wantInbox ? '1' : '0' });
  return ctx.redirect(url);
}
export async function adminMailCallbackRoute(ctx) {
  const user = await ctx.user(); if (!user || !can(user.role, 'settings.manage')) return ctx.redirect('/admin');
  const lim = await ctx.limit('oauth_ip', ctx.ip, RULES.oauth_ip); if (lim) return lim;
  const fail = (m) => { ctx._flash = [m, 'err']; return ctx.redirect('/admin/mail'); };
  const state = ctx.url.searchParams.get('state'); const code = ctx.url.searchParams.get('code');
  const s = await consumeOAuthState(ctx.env, { kind: 'gmail_sender', userId: user.id, state });
  if (!s || !s.verifier) return fail('The Gmail authorization request was invalid or expired. Please try again.');
  if (ctx.url.searchParams.get('error') || !code) return fail('Gmail was not connected (authorization was cancelled or denied).');
  const { status, body } = await exchangeCode(ctx.env, code, s.verifier, `${ctx.c.appUrl}/admin/mail-callback`);
  if (status !== 200 || !body.refresh_token) return fail('Google did not return offline access. Remove this app at myaccount.google.com/permissions and try again.');
  const granted = body.scope || '';
  if (!senderScopeOk(granted, s.extra === '1')) { ctx.defer(releaseGrant(ctx.env, { email: String(idTokenClaims(body.id_token || '').email || '').toLowerCase(), refreshToken: body.refresh_token })); return fail('Google granted different permissions than requested. The connection was cancelled.'); }
  const claims = idTokenClaims(body.id_token || ''); const email = String(claims.email || '').toLowerCase();
  if (claims.aud !== ctx.c.googleClientId || !email || !claims.email_verified) return fail('Could not confirm which Gmail account was connected.');
  await senderSave(ctx.env, { refreshToken: body.refresh_token, email, scopes: granted });
  await setSetting(ctx.env, 'mail_from_name', 'UnknownXfam Gateway');
  await audit(ctx.env, { adminId: user.id, action: 'MAIL_SENDER_CONNECTED', ip: ctx.ip, metadata: { email } });
  ctx._flash = [`Connected as ${email}. Send a test email, then you can switch the code options on.`, 'ok'];
  return ctx.redirect('/admin/mail');
}
export async function adminInboxPage(ctx) {
  const user = await ctx.user(); if (!user || !can(user.role, 'settings.manage')) return ctx.redirect('/admin');
  const s = await getMailSettings(ctx.env);
  if (!senderCanRead(s)) { ctx._flash = ['Reconnect the sender Gmail with "show inbox" ticked to use this page.', 'err']; return ctx.redirect('/admin/mail'); }
  const { senderAccessToken } = await import('../services/mail.js'); const { gmailGet } = await import('../gmail/google.js');
  const token = await senderAccessToken(ctx.env);
  const page = /^[A-Za-z0-9_-]{1,300}$/.test(ctx.url.searchParams.get('page') || '') ? ctx.url.searchParams.get('page') : null;
  const list = token ? await gmailGet(token, '/messages', { maxResults: 15, labelIds: 'INBOX', pageToken: page }) : { status: 401, body: {} };
  let rows = [];
  if (list.status === 200 && list.body.messages) {
    const results = await Promise.all(list.body.messages.map((m) => gmailGet(token, '/messages/' + encodeURIComponent(m.id), { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })));
    rows = results.filter((r) => r.status === 200).map((r) => r.body);
  }
  const body = html`<p class="eyebrow">Gmail · read-only</p><h1>Sender inbox</h1><p class="sub">${s.sender_email} · <a href="/admin/mail" style="color:var(--gold);">Back to admin</a></p>
  ${list.status !== 200 ? html`<div class="banner bad"><b>Couldn't load the inbox</b>Google didn't respond, or access ended. Reconnect the sender Gmail in the admin panel.</div>`
    : !rows.length ? html`<div class="card"><p class="field-note">No messages.</p></div>`
    : html`<div class="card"><div class="table-scroll"><table class="orders"><thead><tr><th>From</th><th>Subject</th><th>Date</th></tr></thead><tbody>
        ${rows.map((m) => { const p = m.payload || {}; const h = (n) => (p.headers || []).find((x) => x.name === n)?.value || ''; const unread = (m.labelIds || []).includes('UNREAD'); return html`<tr style="${unread ? 'font-weight:700;' : ''}"><td>${h('From')}</td><td>${h('Subject') || '(no subject)'}</td><td>${fmtISTms(m.internalDate)}</td></tr>`; })}
      </tbody></table></div></div>`}`;
  return ctx.page(shell({ title: 'Sender inbox', user, body, bodyClass: 'dash' }));
}
