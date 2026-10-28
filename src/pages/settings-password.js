// Settings → Password: a signed-in user asks for a password-reset OTP, enters it from their email and sets a new password.
// Uses the same 'reset' codes as "Forgot password?" (6 digits, 10 min, single use, 5 tries, 60 s between sends).
import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { RULES, clearLoginLock } from '../lib/ratelimit.js';
import { setPassword } from '../auth/accounts.js';
import { emailCanonical } from '../auth/email-check.js';
import { forceLogout } from '../auth/session.js';
import { mailConfigured } from '../services/mail.js';
import { otpIssue, otpVerify, otpErrorMessage, markEmailVerified, OTP_SPAM_NOTE } from '../services/otp.js';
import { securityEvent } from '../admin/audit.js';

/** The two tabs shown at the top of Settings (exported so the Profile page can show the same bar). */
export const settingsTabs = (active) => html`<div class="acts" style="flex-wrap:wrap;margin:0 0 14px;"><a class="btn small ${active === 'profile' ? 'primary' : ''}" href="/settings">Profile</a><a class="btn small ${active === 'password' ? 'primary' : ''}" href="/settings/password">Password</a></div>`;

export async function settingsPasswordPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  const canReset = user.role === 'USER';                 // same rule as "Forgot password?" (staff passwords are managed by the owner)
  const mailOn = canReset && (await mailConfigured(ctx.env));
  const step = ctx.url.searchParams.get('step') === 'code' ? 'code' : 'send';
  let err = '', info = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('otp_verify_ip', ctx.ip, RULES.otp_verify_ip); if (lim) return lim;
    if (!mailOn) err = canReset ? 'Password reset by email is not available right now. Please contact support.' : 'Please ask the owner to change this account\'s password.';
    else if (ctx.form.action === 'send') {
      const limO = await ctx.limit('reset_ip', ctx.ip, RULES.reset_ip); if (limO) return limO;
      const r = await otpIssue(ctx.env, 'reset', user.email, user.id);
      if (r.ok) { ctx._flash = ['A 6-digit code was sent to ' + user.email + '. ' + OTP_SPAM_NOTE, 'ok']; return ctx.redirect('/settings/password?step=code'); }
      err = otpErrorMessage(r);
    } else if (ctx.form.action === 'change') {
      const pw = ctx.form.password || '', pw2 = ctx.form.password2 || '';
      if (pw.length < 8) err = 'Password must be at least 8 characters.';
      else if (pw !== pw2) err = 'Passwords do not match.';
      else if (!(await otpVerify(ctx.env, 'reset', user.email, ctx.form.code || ''))) err = 'That code is wrong or has expired.';
      else {
        await setPassword(ctx.env, user.id, pw); await markEmailVerified(ctx.env, user.id, false);
        await clearLoginLock(ctx.env, emailCanonical(user.email));
        await forceLogout(ctx.env, user.id);                 // every device (this one too) must log in again with the new password
        await securityEvent(ctx.env, { userId: user.id, type: 'PASSWORD_RESET', ip: ctx.ip, ua: ctx.ua, meta: { via: 'settings' } });
        ctx._flash = ['Password updated. Please log in with your new password.', 'ok']; return ctx.redirect('/login');
      }
    }
  }
  const flash = ctx._flashIn; const showCode = step === 'code' || (ctx.method === 'POST' && (ctx.form.action === 'change' || (ctx.form.action === 'send' && !!err)));
  const csrf = await ctx.csrf();
  const sendCard = html`<div class="card"><h2>Reset password with an email code</h2>
    <p class="field-note">We will send a 6-digit code to <b>${user.email}</b>. Enter it on the next step and choose a new password. ${OTP_SPAM_NOTE}</p>
    <form method="post" action="/settings/password">${csrfField(csrf)}<input type="hidden" name="action" value="send"><div class="actions"><button class="btn primary" type="submit">Send password reset OTP</button></div></form>
    <p class="field-note" style="margin-top:12px;"><a href="/settings/password?step=code" style="color:var(--gold);">I already have a code</a></p></div>`;
  const codeCard = html`<div class="card"><h2>Enter the code and set a new password</h2>
    <p class="field-note">Code sent to <b>${user.email}</b>. It is valid for 10 minutes. ${OTP_SPAM_NOTE}</p>
    <form method="post" action="/settings/password">${csrfField(csrf)}<input type="hidden" name="action" value="change">
      <label for="code">6-digit code</label><input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus>
      <label for="password">New password <span class="hint">At least 8 characters</span></label><input type="password" id="password" name="password" autocomplete="new-password" required>
      <label for="password2">Confirm new password</label><input type="password" id="password2" name="password2" autocomplete="new-password" required>
      <div class="actions"><button class="btn primary" type="submit">Update password</button></div></form>
    <form method="post" action="/settings/password" style="margin-top:10px;">${csrfField(csrf)}<input type="hidden" name="action" value="send"><button class="btn small" type="submit">Send a new code</button></form></div>`;
  const body = html`<p class="eyebrow">Profile settings</p><h1>Settings</h1>${settingsTabs('password')}${alert(flash?.[0], flash?.[1])}${alert(info)}${alert(err, 'err')}
    ${!canReset ? html`<div class="card"><h2>Password</h2><p class="field-note">The password of this account is managed by the owner, so it cannot be reset here.</p></div>`
      : !mailOn ? html`<div class="card"><h2>Password</h2><p class="field-note">Password reset by email is not available right now. Please contact support.</p></div>`
      : showCode ? codeCard : sendCard}`;
  return ctx.page(shell({ title: 'Settings · Password', user, body, bodyClass: 'dash' }));
}
