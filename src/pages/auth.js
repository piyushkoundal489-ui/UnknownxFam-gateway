import { first } from '../lib/db.js';
import { maybeAutoApprove } from '../services/auto-approve.js';
import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { RULES, loginLockRemaining, recordLoginFailure, clearLoginFailures, clearLoginLock, LOGIN_LOCK } from '../lib/ratelimit.js';
import { createUser, findUserByEmail, authenticate, setPassword, isReservedEmail, gmailOnlyOk } from '../auth/accounts.js';
import { isGmailAddress } from '../auth/email-check.js';

const GMAIL_ONLY_MSG = 'Only Gmail login is allowed. Please use your @gmail.com address.';
// anyone typing a non-Gmail address is told so (the owner account is exempt)
const notGmail = (ctx, email, candidate = null) => !isGmailAddress(email) && !isReservedEmail(ctx.env, email) && candidate?.role !== 'SUPER_ADMIN';
import { validateSignupEmail, emailCanonical } from '../auth/email-check.js';
import { createSession, clearSessionCookie, destroySession, sessionCookieName, effectiveStatus } from '../auth/session.js';
import { getMailSettings, mailConfigured } from '../services/mail.js';
import { otpIssue, otpVerify, otpErrorMessage, markEmailVerified, OTP_SPAM_NOTE } from '../services/otp.js';
import { hashPassword } from '../lib/crypto.js';
import { cfg } from '../lib/config.js';
import { securityEvent } from '../admin/audit.js';

const authCard = (inner) => html`<div class="auth-logo"><img src="/assets/logo.webp" alt="Gateway logo"></div><div class="card auth-card">${inner}</div>`;

export async function registerPage(ctx) {
  if (await ctx.user()) return ctx.redirect('/dashboard');
  let err = '', name = '', email = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('register_ip', ctx.ip, RULES.register_ip); if (lim) return lim;
    ({ name = '', email = '' } = ctx.form); const password = ctx.form.password || '', password2 = ctx.form.password2 || '';
    email = email.trim().toLowerCase();
    const emailErr = await validateSignupEmail(ctx.c, email);
    if (!name.trim() || name.length > 80) err = 'Enter your name.';
    else if (isReservedEmail(ctx.env, email)) err = 'That email address is reserved.';
    else if (emailErr) err = emailErr;
    else if (password.length < 8) err = 'Password must be at least 8 characters.';
    else if (password !== password2) err = 'Passwords do not match.';
    else {
      const u = await createUser(ctx.env, { name, email, password });
      if (!u) err = 'That email is already registered. Try logging in.';
      else {
        ctx.cookies.push(await createSession(ctx.env, ctx.request, u));
        await securityEvent(ctx.env, { userId: u.id, type: 'ACCOUNT_CREATED', ip: ctx.ip, ua: ctx.ua });
        const settings = await getMailSettings(ctx.env);
        if (settings.otp_signup === '1' && (await mailConfigured(ctx.env))) {
          const r = await otpIssue(ctx.env, 'signup', email, u.id);
          if (!r.ok) ctx._flash = [otpErrorMessage(r) + ' You can resend it on the next page.', 'err'];
          return ctx.redirect('/verify-email');
        }
        ctx._flash = (await maybeAutoApprove(ctx.env, u.id)) ? ['Account created and approved automatically. Welcome! 🎉', 'ok'] : ['Account created. Your request has been sent to the admin for approval.', 'ok'];
        return ctx.redirect('/dashboard');
      }
    }
  }
  const body = authCard(html`<h1>Create your account</h1><p class="sub">Use your Gmail address (only @gmail.com is accepted). New accounts are reviewed by the admin before you get an API key.</p>
    ${alert(err, 'err')}
    <form method="post" action="/register">${csrfField(await ctx.csrf())}
      <label for="name">Name</label><input type="text" id="name" name="name" value="${name}" autocomplete="name" required>
      <label for="email">Gmail address</label><input type="email" id="email" name="email" value="${email}" placeholder="you@gmail.com" autocomplete="email" required>
      <label for="password">Password <span class="hint">At least 8 characters</span></label><input type="password" id="password" name="password" autocomplete="new-password" required>
      <label for="password2">Confirm password</label><input type="password" id="password2" name="password2" autocomplete="new-password" required>
      <div class="actions"><button class="btn primary block" type="submit">Request account</button></div>
    </form>
    <p class="switch-link">Already have an account? <a href="/login">Log in</a></p>`);
  return ctx.page(shell({ title: 'Create account', user: null, body, narrow: true }));
}

const lockText = (sec) => { const h = Math.floor(sec / 3600), m = Math.ceil((sec % 3600) / 60); return h >= 1 && m === 60 ? `${h + 1} hours` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} min` : ''}` : `${Math.max(1, m)} min`; };
export async function loginPage(ctx) {
  if (await ctx.user()) return ctx.redirect('/dashboard');
  let err = '', email = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    ({ email = '' } = ctx.form); email = email.trim().toLowerCase(); const password = ctx.form.password || '';
    const limIp = await ctx.limit('login_ip', ctx.ip, RULES.login_ip); if (limIp) return limIp;
    const limEmail = await ctx.limit('login_email', emailCanonical(email), RULES.login_email); if (limEmail) return limEmail;
    const acct = emailCanonical(email), lockLeft = email ? await loginLockRemaining(ctx.env, acct) : 0;
    if (lockLeft > 0) {   // too many wrong passwords: nothing is checked at all (not even a correct password) until the cool-down is over
      await securityEvent(ctx.env, { userId: null, type: 'LOGIN_LOCKED', ip: ctx.ip, ua: ctx.ua });
      err = `Too many wrong passwords. This account is locked for another ${lockText(lockLeft)}.` + (await mailConfigured(ctx.env) ? ' You can still use "Forgot password?" or "Email me a login code".' : '');
    } else {
    const candidate = await findUserByEmail(ctx.env, email);
    if (candidate && ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'].includes(candidate.role)) {
      const adminLimit = await ctx.limit('admin_login_ip', ctx.ip, RULES.admin_login_ip);
      if (adminLimit) return adminLimit;
    }
    const blocked = notGmail(ctx, email, candidate);
    const { ok, user, disabled } = blocked ? { ok: false, user: null, disabled: false } : await authenticate(ctx.env, email, password);
    if (blocked) err = GMAIL_ONLY_MSG;
    else if (disabled) err = 'Admin login is disabled until ADMIN_PASSWORD is set on the server.';
    else if (ok && !gmailOnlyOk(ctx.env, user)) err = 'Only Gmail addresses (yourname@gmail.com) can log in to this gateway.';
    else if (!ok) {
      await securityEvent(ctx.env, { userId: user?.id ?? null, type: 'LOGIN_FAILED', ip: ctx.ip, ua: ctx.ua });
      const f = await recordLoginFailure(ctx.env, acct);
      err = f.locked ? `Incorrect password. After ${LOGIN_LOCK.maxFails} wrong attempts this account is locked for ${lockText(LOGIN_LOCK.lockSec)}.`
        : 'Incorrect email or password.' + (f.left <= 3 ? ` ${f.left} attempt${f.left === 1 ? '' : 's'} left before this account is locked for ${lockText(LOGIN_LOCK.lockSec)}.` : '');
    }
    else {
      await clearLoginFailures(ctx.env, acct);
      const status = await effectiveStatus(ctx.env, user);
      if (status === 'banned' || status === 'suspended') {
        err = status === 'banned' ? 'This account is banned. Contact support.' : 'This account is temporarily suspended. Please try again after the suspension ends.';
      } else {
      const settings = await getMailSettings(ctx.env);
      if (user.role === 'USER' && settings.otp_login === '1' && (await mailConfigured(ctx.env))) {
        const r = await otpIssue(ctx.env, 'login', user.email, user.id);
        if (r.ok) return pendingLoginRedirect(ctx, user.id, 'password');
        err = otpErrorMessage(r);
      } else { ctx.cookies.push(await createSession(ctx.env, ctx.request, user)); await securityEvent(ctx.env, { userId: user.id, type: 'LOGIN_OK', ip: ctx.ip, ua: ctx.ua }); return ctx.redirect('/dashboard'); }
      }
    }
    }
  }
  const mailOn = await mailConfigured(ctx.env);
  const body = authCard(html`<h1>Welcome back</h1><p class="sub">Log in to manage your UPI ID, API key and orders.</p>
    ${ctx._flashIn && !err ? alert(ctx._flashIn[0], ctx._flashIn[1] === 'ok' ? 'ok' : 'err') : ''}${alert(err, 'err')}
    <form method="post" action="/login">${csrfField(await ctx.csrf())}
      <label for="email">Email address</label><input type="email" id="email" name="email" value="${email}" autocomplete="username" required>
      <label for="password">Password</label><div class="pw-wrap"><input type="password" id="password" name="password" autocomplete="current-password" required><button type="button" class="pw-toggle" id="pwToggle">Show</button></div>
      <div class="actions"><button class="btn primary block" type="submit">Log in</button></div>
    </form>
    ${mailOn ? html`<p class="switch-link"><a href="/forgot-password">Forgot password?</a> · <a href="/login-code">Email me a login code</a></p>` : ''}
    <p class="switch-link">New here? <a href="/register">Create a free account</a></p>`);
  return ctx.page(shell({ title: 'Login', user: null, body: html`${body}<script src="/assets/app.js"></script>`, narrow: true }));
}

// ---- pending-login cookie: a signed short-lived cookie naming which account still needs a code ----
import { setCookie, parseCookies } from '../lib/http.js';
import { hmacHex, safeEqual } from '../lib/crypto.js';
const PL_COOKIE = 'gw_pending_login';
async function signPending(env, uid, mode) { const exp = Math.floor(Date.now() / 1000) + 600; const payload = `${uid}.${mode}.${exp}`; return `${payload}.${(await hmacHex(cfg(env).sessionSecret, 'pl:' + payload)).slice(0, 32)}`; }
async function readPending(env, request) {
  const v = parseCookies(request)[PL_COOKIE]; if (!v) return null;
  const [uid, mode, exp, sig] = v.split('.'); if (!uid || !mode || !exp || !sig) return null;
  if (!(await safeEqual((await hmacHex(cfg(env).sessionSecret, 'pl:' + `${uid}.${mode}.${exp}`)).slice(0, 32), sig))) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return { uid: Number(uid), mode };
}
function pendingLoginRedirect(ctx, uid, mode) { ctx.cookies.push(setCookie(PL_COOKIE, '', { maxAge: 0 })); return signPending(ctx.env, uid, mode).then((v) => { ctx.cookies.push(setCookie(PL_COOKIE, v, { maxAge: 600, secure: ctx.c.isProd })); return ctx.redirect('/login-verify'); }); }

export async function loginCodePage(ctx) {
  if (await ctx.user()) return ctx.redirect('/dashboard');
  let err = '', email = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('otp_ip', ctx.ip, RULES.otp_ip); if (lim) return lim;
    ({ email = '' } = ctx.form); email = email.trim().toLowerCase();
    if (!(await mailConfigured(ctx.env))) err = 'Email codes are not available right now. Please log in with your password.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err = 'Enter a valid email address.';
    else if (notGmail(ctx, email)) err = GMAIL_ONLY_MSG;
    else {
      const u = await findUserByEmail(ctx.env, email); let uid = 0;
      if (u && u.role === 'USER') { const r = await otpIssue(ctx.env, 'login', u.email, u.id); if (r.ok) uid = u.id; else if (['cooldown', 'rate_limited'].includes(r.code)) err = otpErrorMessage(r); }
      if (!err) return pendingLoginRedirect(ctx, uid, 'code');
    }
  }
  const body = authCard(html`<h1>Log in with a code</h1><p class="sub">We'll email a 6-digit code. No password needed.</p>${alert(err, 'err')}
    <form method="post" action="/login-code">${csrfField(await ctx.csrf())}<label for="email">Email address</label><input type="email" id="email" name="email" value="${email}" autocomplete="username" required>
      <div class="actions"><button class="btn primary block" type="submit">Send code</button></div></form>
    <p class="switch-link"><a href="/login">Use my password instead</a></p>`);
  return ctx.page(shell({ title: 'Email me a code', user: null, body, narrow: true }));
}

export async function loginVerifyPage(ctx) {
  if (await ctx.user()) return ctx.redirect('/dashboard');
  const pending = await readPending(ctx.env, ctx.request);
  if (!pending) { ctx._flash = ['Your login request expired. Please start again.', 'err']; return ctx.redirect('/login'); }
  const { getUser } = await import('../auth/accounts.js'); const user = pending.uid ? await getUser(ctx.env, pending.uid) : null;
  let err = '', info = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('otp_verify_ip', ctx.ip, RULES.otp_verify_ip); if (lim) return lim;
    if (ctx.form.action === 'resend') {
      const limO = await ctx.limit('otp_ip', ctx.ip, RULES.otp_ip); if (limO) return limO;
      if (user) { const r = await otpIssue(ctx.env, 'login', user.email, user.id); if (r.ok) info = 'A new code was sent. ' + OTP_SPAM_NOTE; else err = otpErrorMessage(r); } else info = 'A new code was sent. ' + OTP_SPAM_NOTE;
    } else {
      const good = user && user.role === 'USER' && (await otpVerify(ctx.env, 'login', user.email, ctx.form.code || ''));
      if (!good) err = 'That code is wrong or has expired.';
      else if (['banned', 'suspended'].includes(await effectiveStatus(ctx.env, user))) {
        const st = await effectiveStatus(ctx.env, user);
        ctx.cookies.push(setCookie(PL_COOKIE, '', { maxAge: 0 }));
        await securityEvent(ctx.env, { userId: user.id, type: 'LOGIN_BLOCKED', ip: ctx.ip, ua: ctx.ua, meta: { status: st } });
        ctx._flash = [st === 'banned' ? 'This account is banned. Contact support.' : 'This account is temporarily suspended. Please try again after the suspension ends.', 'err'];
        return ctx.redirect('/login');
      } else {
        if (pending.mode === 'code') await markEmailVerified(ctx.env, user.id, true, await hashPassword(crypto.randomUUID(), ctx.c.pbkdf2));
        else await markEmailVerified(ctx.env, user.id, false);
        ctx.cookies.push(setCookie(PL_COOKIE, '', { maxAge: 0 }));
        await clearLoginLock(ctx.env, emailCanonical(user.email));      // proved by e-mail code: any password lock is lifted
        ctx.cookies.push(await createSession(ctx.env, ctx.request, user));
        await securityEvent(ctx.env, { userId: user.id, type: 'LOGIN_OK', ip: ctx.ip, ua: ctx.ua, meta: { via: pending.mode === 'code' ? 'code' : '2step' } });
        return ctx.redirect('/dashboard');
      }
    }
  }
  const body = authCard(html`<h1>Check your email</h1><p class="sub">Enter the 6-digit code we sent${user ? html` to <b>${user.email}</b>` : ''}.</p>
    ${alert(info)}${alert(err, 'err')}
    <form method="post" action="/login-verify">${csrfField(await ctx.csrf())}<label for="code">6-digit code</label><input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus>
      <div class="actions"><button class="btn primary block" type="submit">Log in</button></div></form>
    <form method="post" action="/login-verify" style="margin-top:10px;text-align:center;">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="resend"><button class="btn small" type="submit">Resend code</button></form>
    <p class="field-note" style="text-align:center;">📬 ${OTP_SPAM_NOTE}</p>
    <p class="switch-link"><a href="/login">Cancel</a></p>`);
  return ctx.page(shell({ title: 'Enter code', user: null, body, narrow: true }));
}

export async function forgotPasswordPage(ctx) {
  if (await ctx.user()) return ctx.redirect('/dashboard');
  let err = '', email = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('reset_ip', ctx.ip, RULES.reset_ip); if (lim) return lim;
    ({ email = '' } = ctx.form); email = email.trim().toLowerCase();
    if (!(await mailConfigured(ctx.env))) err = 'Password reset by email is not available right now. Please contact support.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err = 'Enter a valid email address.';
    else if (notGmail(ctx, email)) err = GMAIL_ONLY_MSG;
    else {
      const u = await findUserByEmail(ctx.env, email);
      if (u && u.role === 'USER') { const r = await otpIssue(ctx.env, 'reset', u.email, u.id); if (!r.ok && ['cooldown', 'rate_limited'].includes(r.code)) err = otpErrorMessage(r); }
      if (!err) { ctx.cookies.push(setCookie('gw_reset_email', email, { maxAge: 600, secure: ctx.c.isProd })); ctx._flash = ['If that address has an account, we have emailed it a 6-digit code. ' + OTP_SPAM_NOTE, 'ok']; return ctx.redirect('/reset-password'); }
    }
  }
  const body = authCard(html`<h1>Reset your password</h1><p class="sub">Enter your account email and we'll send a 6-digit code.</p>${alert(err, 'err')}
    <form method="post" action="/forgot-password">${csrfField(await ctx.csrf())}<label for="email">Email address</label><input type="email" id="email" name="email" value="${email}" autocomplete="username" required>
      <div class="actions"><button class="btn primary block" type="submit">Send code</button></div></form><p class="switch-link"><a href="/login">Back to login</a></p>`);
  return ctx.page(shell({ title: 'Forgot password', user: null, body, narrow: true }));
}
import { setCookie as setCookie2 } from '../lib/http.js';
export async function resetPasswordPage(ctx) {
  if (await ctx.user()) return ctx.redirect('/dashboard');
  const cookieEmail = parseCookies(ctx.request).gw_reset_email || '';
  const requestedEmail = String(ctx.url.searchParams.get('email') || '').trim().toLowerCase();
  const email = cookieEmail || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedEmail) ? requestedEmail : '');
  if (!cookieEmail && email) ctx.cookies.push(setCookie2('gw_reset_email', email, { maxAge: 600, secure: ctx.c.isProd }));
  if (!email) return ctx.redirect('/forgot-password');
  let err = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('otp_verify_ip', ctx.ip, RULES.otp_verify_ip); if (lim) return lim;
    const pw = ctx.form.password || '', pw2 = ctx.form.password2 || '';
    if (pw.length < 8) err = 'Password must be at least 8 characters.';
    else if (pw !== pw2) err = 'Passwords do not match.';
    else {
      const u = await findUserByEmail(ctx.env, email);
      const good = u && u.role === 'USER' && (await otpVerify(ctx.env, 'reset', u.email, ctx.form.code || ''));
      if (!good) err = 'That code is wrong or has expired.';
      else {
        await setPassword(ctx.env, u.id, pw); await markEmailVerified(ctx.env, u.id, false);
        await clearLoginLock(ctx.env, emailCanonical(u.email));          // a fresh password: the lock from the old one no longer applies
        const { forceLogout } = await import('../auth/session.js'); await forceLogout(ctx.env, u.id);
        await securityEvent(ctx.env, { userId: u.id, type: 'PASSWORD_RESET', ip: ctx.ip, ua: ctx.ua });
        ctx.cookies.push(setCookie2('gw_reset_email', '', { maxAge: 0 }));
        ctx._flash = ['Password updated. You can log in now.', 'ok']; return ctx.redirect('/login');
      }
    }
  }
  const body = authCard(html`<h1>Enter your code</h1><p class="sub">Code sent to <b>${email}</b> (if the account exists).</p>${alert(err, 'err')}
    <form method="post" action="/reset-password">${csrfField(await ctx.csrf())}
      <label for="code">6-digit code</label><input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required>
      <label for="password">New password <span class="hint">At least 8 characters</span></label><input type="password" id="password" name="password" autocomplete="new-password" required>
      <label for="password2">Confirm new password</label><input type="password" id="password2" name="password2" autocomplete="new-password" required>
      <div class="actions"><button class="btn primary block" type="submit">Update password</button></div></form>
    <p class="field-note" style="text-align:center;">📬 ${OTP_SPAM_NOTE}</p>
    <p class="switch-link"><a href="/forgot-password">Send a new code</a> · <a href="/login">Back to login</a></p>`);
  return ctx.page(shell({ title: 'Choose a new password', user: null, body, narrow: true }));
}

export async function verifyEmailPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  const settings = await getMailSettings(ctx.env);
  if (user.email_verified || user.role !== 'USER' || settings.otp_signup !== '1') return ctx.redirect('/dashboard');
  let err = '', info = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('otp_verify_ip', ctx.ip, RULES.otp_verify_ip); if (lim) return lim;
    if (ctx.form.action === 'resend') { const r = await otpIssue(ctx.env, 'signup', user.email, user.id); if (r.ok) info = 'A new code was sent. ' + OTP_SPAM_NOTE; else err = otpErrorMessage(r); }
    else if (await otpVerify(ctx.env, 'signup', user.email, ctx.form.code || '')) { await markEmailVerified(ctx.env, user.id, false); const done = await first(ctx.env, 'SELECT approval FROM users WHERE id = ?', user.id); ctx._flash = done?.approval === 'approved' ? ['Email verified and your account was approved automatically. Welcome! 🎉', 'ok'] : ['Email verified. Your account is now waiting for admin approval.', 'ok']; return ctx.redirect('/dashboard'); }
    else err = 'That code is wrong or has expired.';
  }
  const body = html`<div class="card auth-card"><h1>Verify your email</h1><p class="sub">Enter the 6-digit code sent to <b>${user.email}</b>.</p>${alert(info)}${alert(err, 'err')}
    <form method="post" action="/verify-email">${csrfField(await ctx.csrf())}<label for="code">6-digit code</label><input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus>
      <div class="actions"><button class="btn primary block" type="submit">Verify</button></div></form>
    <form method="post" action="/verify-email" style="margin-top:10px;text-align:center;">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="resend"><button class="btn small" type="submit">Resend code</button></form><p class="field-note" style="text-align:center;">📬 ${OTP_SPAM_NOTE}</p></div>`;
  return ctx.page(shell({ title: 'Verify email', user, body, narrow: true }));
}

export async function logoutPage(ctx) {
  await destroySession(ctx.env, ctx.request);
  ctx.cookies.push(clearSessionCookie(ctx.env));
  return ctx.redirect('/login');
}
