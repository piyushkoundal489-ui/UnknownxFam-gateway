import { html } from '../lib/html.js';
import { shell, alert, banner, csrfField } from './layout.js';
import { first, all, run, now } from '../lib/db.js';
import { visibleOrdersSql } from '../lib/order-visibility.js';
import { money, pillClassOrder, ST } from '../payments/core-ui.js';
import { revealSecret } from '../auth/accounts.js';
import { cfg } from '../lib/config.js';
import { getMailSettings, mailConfigured, senderCanRead } from '../services/mail.js';
import { gmailAccount, loadMiniInbox, disconnectGmail, completeConnect } from '../gmail/connection.js';
import { beginOAuth, userScopes } from '../gmail/google.js';
import { sha256Hex } from '../lib/crypto.js';
import { audit, securityEvent } from '../admin/audit.js';
import { RULES } from '../lib/ratelimit.js';
import { senderCell, snippetText } from '../lib/gmail-ui.js';
import { fmtIST, fmtISTms } from '../lib/time.js';
import { payGraphCard, loadPaySeries } from './pay-graph.js';

function pill(status) { return html`<span class="pill ${pillClassOrder(status)}">${status}</span>`; }

const MINI_PROBLEM = {
  reconnect: ['Gmail needs to be reconnected', 'Google reports that access for this Gmail ended or was revoked. Reconnect it to see your inbox again.'],
  unavailable: ['Gmail is not responding right now', 'This is usually temporary and your connection is still saved. Use Refresh inbox to try again in a moment.'],
  config: ['Gmail is not available on this server yet', 'The Google project behind this app needs attention (Gmail API or OAuth client). Please tell the admin.'],
};
/** The whole Mini Gmail inbox card. Used by the dashboard tab and by /gmail-inbox/mini (in-place refresh), so both always look the same. */
export async function miniInboxCard(ctx, inbox) {
  const csrf = await ctx.csrf(); const st = inbox.state;
  const rows = st === 'ok' ? inbox.messages.map((m) => {
    const p = m.payload || {};
    const h = (name) => (p.headers || []).find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || '';
    const unread = (m.labelIds || []).includes('UNREAD'); const ts = Number(m.internalDate || 0);
    return html`<tr style="${unread ? 'font-weight:700;' : ''}"><td>${senderCell(h('From'))}</td>
      <td><a href="/gmail-message?id=${encodeURIComponent(m.id || '')}" style="color:inherit;">${h('Subject') || '(no subject)'}</a>
        <div class="field-note" style="margin:2px 0 0;font-weight:400;">${snippetText(m.snippet)}</div></td>
      <td style="white-space:nowrap;">${unread ? '● ' : ''}${ts ? fmtISTms(ts) : '—'}</td></tr>`;
  }) : [];
  const problem = MINI_PROBLEM[st];
  return html`<div class="card" id="miniInbox" aria-live="polite"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
    <div><h2>Mini Gmail inbox</h2><p class="field-note" style="margin:4px 0 0;">${inbox.email} · read-only · latest 6 messages</p></div>
    <a class="btn small" href="/gmail-inbox">Full inbox</a>
  </div>
  ${problem ? banner(problem[0], problem[1], st === 'unavailable' ? 'wait' : 'bad') : ''}
  ${st === 'reconnect' ? html`<div class="acts" style="margin-top:12px;"><a class="btn small primary" href="/gmail-connect">Reconnect Gmail</a>
      <form method="post" action="/dashboard" class="inline" data-confirm="Disconnect this Gmail? You can connect it or another Gmail afterwards.">${csrfField(csrf)}<input type="hidden" name="action" value="gmail_disconnect"><input type="hidden" name="return_tab" value="gmail"><button class="btn small danger" type="submit">Disconnect Gmail</button></form></div>` : ''}
  ${st === 'empty' ? html`<p class="field-note" style="margin:16px 0 0;">Your inbox is empty — there are no messages to show.</p>` : ''}
  ${st === 'ok' ? html`<div class="table-scroll" style="margin-top:12px;"><table class="orders"><thead><tr><th>From</th><th>Subject</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
  <div class="acts" style="margin-top:14px;"><a class="btn small" id="miniRefresh" href="/dashboard?tab=gmail" data-mini-url="/gmail-inbox/mini">Refresh inbox</a>
    <form method="post" action="/dashboard" class="inline">${csrfField(csrf)}<input type="hidden" name="action" value="gmail_refresh"><input type="hidden" name="return_tab" value="gmail"><button class="btn small primary" type="submit">Check payment emails</button></form>
  </div>
  <p class="field-note">A payment counts only when the sender, amount, time and reference all match — never because an email was opened.</p></div>`;
}
/** GET /gmail-inbox/mini — the card as an HTML fragment (the Refresh inbox button swaps it in without reloading the page). */
/** A short fingerprint of everything the Overview shows that a payment can change (orders + FamPay balance). */
async function dashSig(env, userId) {
  const u = await first(env, 'SELECT last_known_balance, last_balance_at FROM users WHERE id = ?', userId) || {};
  const rows = await all(env, `SELECT id, status, updated_at FROM orders WHERE user_id = ? AND ${visibleOrdersSql()} ORDER BY created_at DESC LIMIT 50`, userId, now());
  const raw = [u.last_known_balance, u.last_balance_at, ...rows.map((r) => r.id + ':' + r.status + ':' + r.updated_at)].join('|');
  let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return h.toString(36) + '.' + rows.length;
}
/** GET /dashboard/live -- the Overview asks this every few seconds: it reads new payment e-mails right now and says whether anything on the page changed. */
export async function dashboardLive(ctx) {
  const user = await ctx.user(); if (!user) return ctx.json({ ok: false, error: 'login' }, 401);
  if (user.approval !== 'approved') return ctx.json({ ok: false, error: 'not_approved' }, 403);
  const lim = await ctx.limit('dash_live', 'u' + user.id, { max: 60, windowSec: 60 }, { json: true }); if (lim) return lim;
  // Does exactly what the "Check payment emails" button does (read the mailbox now, settle open orders, otherwise refresh the balance),
  // at most once every 2 s per account, so the page no longer depends on the background poller being on time.
  let gmail = 'none'; let gm = await gmailAccount(ctx.env, user.id);
  if (gm) {
    gmail = 'ok';
    if (now() - (gm.last_checked || 0) >= 2) {
      try {
        const { reconcile, refreshBalance } = await import('../gmail/reconcile.js');
        const open = await first(ctx.env, "SELECT 1 AS x FROM orders WHERE user_id = ? AND status IN ('PENDING','PROCESSING') AND expires_at > ? LIMIT 1", user.id, now());
        const r = open ? await reconcile(ctx.env, user) : await refreshBalance(ctx.env, user);
        if (r && r.error) gmail = r.error;
      } catch (e) { gmail = 'error'; console.error('dash live check failed:', e.message); }
      gm = await gmailAccount(ctx.env, user.id);
    }
  }
  const { expireOrders } = await import('../payments/core.js'); await expireOrders(ctx.env);
  return ctx.json({ ok: true, sig: await dashSig(ctx.env, user.id), gmail, checked: gm && gm.last_checked ? fmtIST(gm.last_checked) : null });
}

export async function gmailMiniFragment(ctx) {
  const user = await ctx.user(); if (!user) return ctx.text('login', 401);
  const gm = await gmailAccount(ctx.env, user.id); if (!gm) return ctx.text('none', 404);
  if (user.approval === 'approved') { const { pollNow } = await import('../gmail/reconcile.js'); await pollNow(ctx.env, user.id, 3).catch((e) => console.error('mini poll failed:', e.message)); }   // settle new payment e-mails now, not on the next button press
  const inbox = await loadMiniInbox(ctx.env, user.id, 6);
  if (inbox.code) console.error('mini inbox:', inbox.state, inbox.code);
  return ctx.page(await miniInboxCard(ctx, inbox));
}

export async function dashboardPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    if (user.approval === 'approved' && ctx.form.action === 'mark_paid') {
      ctx._flash = ['Manual confirmation is only available to the owner, from Admin → Payments, with a reason on record.', 'err'];
    } else if (user.approval === 'approved' && ctx.form.action === 'gmail_disconnect') {
      try {
        const d = await disconnectGmail(ctx.env, user.id);
        ctx._flash = !d.had ? ['Gmail was already disconnected.', 'ok']
          : d.google === 'failed' ? ['Gmail disconnected here. Google could not be reached to revoke access — you can also remove this app at myaccount.google.com/permissions.', 'ok']
          : d.google === 'kept' ? ['Gmail disconnected and the stored token deleted. (Google access was kept because the same Google account is also used for the admin sender.)', 'ok']
          : ['Gmail disconnected. Access was revoked and the stored token deleted.', 'ok'];
      } catch (e) { console.error('gmail disconnect failed:', e.code || e.message); ctx._flash = ['Could not disconnect Gmail. Please try again.', 'err']; }
    } else if (user.approval === 'approved' && ctx.form.action === 'gmail_refresh') {
      const { reconcile } = await import('../gmail/reconcile.js');
      const r = await reconcile(ctx.env, user);
      ctx._flash = r.error === 'not_configured' ? ['No bank sender addresses are configured, so nothing was checked.', 'err']
        : r.error ? ['Could not reach Gmail. Please try again.', 'err'] : [`Checked ${r.checked} new message(s); ${r.matched} payment(s) verified.`, 'ok'];
    }
    return ctx.redirect(ctx.form.return_tab === 'gmail' ? '/dashboard?tab=gmail' : '/dashboard');
  }
  const { expireOrders } = await import('../payments/core.js'); await expireOrders(ctx.env);
  const flash = ctx._flashIn;
  const body = [];
  body.push(html`<p class="eyebrow">${['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(user.role) ? 'Staff · your account' : 'Your account'}</p><h1>Hi, ${user.name.split(' ')[0]}</h1>`);
  body.push(alert(flash?.[0], flash?.[1]));
  const settings = await getMailSettings(ctx.env);
  if (user.role === 'USER' && !user.email_verified && settings.otp_signup === '1' && (await mailConfigured(ctx.env)))
    body.push(banner('Verify your email', html`Enter the code we emailed you so the admin can approve your account. <a href="/verify-email" style="color:inherit;font-weight:600;">Enter code</a>`));

  if (user.approval === 'pending') { body.push(banner('Waiting for admin approval', 'Your request has been sent. Once approved you can set your UPI ID; the admin then sends you your API key.')); return ctx.page(shell({ title: 'Dashboard', user, body: html`${body}`, bodyClass: 'dash' })); }
  if (user.approval === 'rejected') { body.push(banner('Request not approved', 'The admin declined this account request. Contact the admin if this is a mistake.', 'bad')); return ctx.page(shell({ title: 'Dashboard', user, body: html`${body}`, bodyClass: 'dash' })); }

  const activeTab = ctx.url.searchParams.get('tab') === 'gmail' ? 'gmail' : 'overview';
  body.push(html`<div class="acts" role="tablist" aria-label="Dashboard sections" style="margin:16px 0;">
    <a class="btn small ${activeTab === 'overview' ? 'primary' : ''}" role="tab" aria-current="${activeTab === 'overview' ? 'page' : 'false'}" href="/dashboard">Overview</a>
    <a class="btn small ${activeTab === 'gmail' ? 'primary' : ''}" role="tab" aria-current="${activeTab === 'gmail' ? 'page' : 'false'}" href="/dashboard?tab=gmail">Gmail inbox</a>
  </div>`);
  if (activeTab === 'gmail') {
    const gm = await gmailAccount(ctx.env, user.id);
    const gmOn = !!(ctx.c.googleClientId && ctx.c.googleClientSecret);
    if (!gm) {
      body.push(html`<div class="card"><h2>Mini Gmail inbox</h2>
        ${gmOn
          ? html`<p class="field-note">Connect Gmail (read-only) to see your inbox here. We never see your password or codes.</p>
              <a class="btn primary" href="/gmail-connect">Connect Gmail</a>`
          : html`<p class="field-note">Gmail connection is not configured on this server yet.</p>`}</div>`);
    } else {
      const inbox = await loadMiniInbox(ctx.env, user.id, 6);
      if (inbox.code) console.error('mini inbox:', inbox.state, inbox.code);
      body.push(await miniInboxCard(ctx, inbox));
      body.push(html`<script src="/assets/mini-inbox.js" defer></script>`);
    }
    return ctx.page(shell({ title: 'Gmail inbox', user, body: html`${body}`, bodyClass: 'dash' }));
  }

  const orders = await all(ctx.env, `SELECT * FROM orders WHERE user_id = ? AND ${visibleOrdersSql()} ORDER BY created_at DESC LIMIT 50`, user.id, now());   // paid / needs-review / QR still valid
  const tot = await first(ctx.env, "SELECT COALESCE(SUM(CASE WHEN status='PAID' THEN pay_amount END),0)::bigint AS rec, COUNT(*) FILTER (WHERE status='PAID') AS ok FROM orders WHERE user_id = ?", user.id);
  const gmAcct = await gmailAccount(ctx.env, user.id);
  const balanceNote = user.last_known_balance != null ? `as of ${fmtIST(user.last_balance_at)} · read from your FamApp email` : gmAcct ? 'waiting for a FamApp "Updated Balance" email' : 'connect Gmail to fill it in automatically';
  const balanceCard = html`<div class="stat"><div class="stat-icon gold"><span class="rupee">₹</span></div><div class="stat-body stacked"><span class="lbl">FamPay balance</span><span class="val">${user.last_known_balance != null ? html`₹${money(user.last_known_balance)}` : '—'}</span><span class="field-note" style="margin:2px 0 0;">${balanceNote}</span></div></div>`;
  // 4th card: when the API key an admin issued and (if saved) the shared key stop working - date AND time
  const tNow = now();
  const apiKeyLine = !user.api_key_hash ? ['No key issued yet', false] : user.api_key_expires_at == null ? ['Never expires', false]
    : user.api_key_expires_at <= tNow ? [`Expired ${fmtIST(user.api_key_expires_at)}`, true] : [fmtIST(user.api_key_expires_at), false];
  let sharedLine = null;
  if (user.shared_api_key_enc) {
    const sk = await revealSecret(ctx.env, user.shared_api_key_enc).catch(() => null);
    const rec = sk ? await first(ctx.env, 'SELECT expires_at, revoked_at FROM shared_api_keys WHERE key_hash = ?', await sha256Hex(sk)) : null;
    sharedLine = !rec ? ['No longer available', true] : rec.revoked_at != null ? ['Revoked by an admin', true] : rec.expires_at <= tNow ? [`Expired ${fmtIST(rec.expires_at)}`, true] : [fmtIST(rec.expires_at), false];
  }
  const keyCard = html`<div class="stat"><div class="stat-icon gold"><span class="rupee">🔑</span></div><div class="stat-body stacked"><span class="lbl">Key expiry</span>
    <span class="kx${apiKeyLine[1] ? ' bad' : ''}"><b>API key</b> · ${apiKeyLine[0]}</span>${sharedLine ? html`<span class="kx${sharedLine[1] ? ' bad' : ''}"><b>Shared key</b> · ${sharedLine[0]}</span>` : ''}</div></div>`;
  const upi = user.upi || '';
  body.push(html`<div class="stat-grid" id="liveStats"><div class="stat"><div class="stat-icon gold"><span class="rupee">₹</span></div><div class="stat-body"><span class="lbl">Received</span><span class="val">₹${money(tot.rec)}</span></div></div>
    <div class="stat"><div class="stat-icon teal"><span class="rupee">✓</span></div><div class="stat-body"><span class="lbl">Successful</span><span class="val">${tot.ok || 0}</span></div></div>${balanceCard}${keyCard}</div>`);
  body.push(upi ? html`<div class="card" style="margin-top:16px;"><h2>API ready</h2><p class="field-note" style="margin:0 0 12px;">Paying to <span class="mono">${upi}</span>. Your create-order URL, status/UTR URLs and webhook are in Settings.</p><a href="/settings" class="btn primary">Open API URLs</a></div>`
    : banner('Add your UPI ID to get your API URLs', html`Save it in <a href="/settings" style="color:inherit;font-weight:600;">Settings</a> and your API URLs are built for you.`, 'wait'));

  const gm = await gmailAccount(ctx.env, user.id); const gmOn = !!(ctx.c.googleClientId && ctx.c.googleClientSecret);
  body.push(html`<div class="card"><h2>Gmail <span class="hint" style="font-weight:400;">connection compulsory · read-only payment-notification check</span></h2>
    ${gm ? html`<p style="margin:10px 0 2px;">${gm.status === 'active' ? html`<span class="pill credited">✓ Connected</span>` : html`<span class="pill">⚠ Reconnect needed</span>`} <b class="mono">${gm.email}</b></p>
        ${gm.status === 'active' ? '' : html`<p class="field-note" style="margin:6px 0 0;">Google ended access for this Gmail. <a href="/gmail-connect" style="color:inherit;font-weight:600;">Reconnect Gmail</a> or disconnect it below.</p>`}
        <p class="field-note" style="margin:6px 0 14px;">Checked: <span id="liveChecked">${gm.last_checked ? fmtIST(gm.last_checked) : 'not yet'}</span><span id="liveGmailNote"></span></p>
        <div class="acts"><a class="btn small primary" href="/dashboard?tab=gmail">Open Gmail tab</a>
          <form method="post" action="/dashboard" class="inline">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="gmail_refresh"><input type="hidden" name="return_tab" value="overview"><button class="btn small" type="submit">Check payment emails</button></form>
          <form method="post" action="/dashboard" class="inline" data-confirm="Disconnect Gmail? Access will be revoked and the stored token deleted.">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="gmail_disconnect"><button class="btn small danger" type="submit">Disconnect Gmail</button></form></div>
        <p class="field-note">Read-only: never sends, deletes or changes email, and doesn't store email content.</p>`
      : gmOn ? html`<p class="field-note" style="margin:8px 0 14px;">You sign in on Google's page; we never see your password or codes.</p>
        <a class="btn primary" href="/gmail-connect">Connect Gmail</a>`
      : html`<p class="field-note" style="margin:8px 0 0;">Gmail connection isn't configured on this server yet.</p>`}</div>`);

  body.push(payGraphCard(await loadPaySeries(ctx.env, user.id), user, now()));            // between the Gmail card and Payments
  body.push(html`<div class="card" id="livePayments"><h2>Payments</h2>${!orders.length ? html`<p class="field-note">No payments yet.</p>` : html`<div class="table-scroll"><table class="orders">
    <thead><tr><th>Order ID</th><th>Payment ID</th><th>Amount</th><th>Status</th><th>UTR / ref</th><th>Txn ID</th><th>Verified by</th><th>Created</th></tr></thead><tbody>
    ${orders.map((o) => html`<tr><td class="mono">${o.id}</td><td class="mono">${o.payment_id}</td><td>${o.currency === 'INR' ? '₹' : o.currency + ' '}${money(o.pay_amount)}</td>
      <td>${pill(o.status)}</td><td class="mono">${o.txn_ref || '—'}</td><td class="mono">${o.transaction_id || '—'}</td><td>${o.verification_method || '—'}</td><td>${fmtIST(o.created_at)}</td></tr>`)}
    </tbody></table></div>`}</div>`);
  body.push(html`<script src="/assets/pay-graph.js" defer></script><div id="liveSig" data-sig="${await dashSig(ctx.env, user.id)}" hidden></div><script src="/assets/dash-live.js" defer></script>`);
  return ctx.page(shell({ title: 'Dashboard', user, body: html`${body}`, bodyClass: 'dash' }));
}

import { settingsTabs } from './settings-password.js';
export async function settingsPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    if (ctx.form.action === 'api_key_save') {
      if (user.approval !== 'approved' || !user.upi) ctx._flash = ['Save a valid UPI ID after approval before saving an API key.', 'err'];
      else {
        const key = String(ctx.form.api_key || '').trim();
        if (!/^[A-Za-z0-9_-]{4,40}$/.test(key)) {
          ctx._flash = ['Enter the API key provided by an Admin/Owner.', 'err'];
        } else {
          const keyHash = await sha256Hex(key);
          const assigned = await first(ctx.env, 'SELECT api_key_expires_at FROM users WHERE id = ? AND api_key_hash = ?', user.id, keyHash);
          if (!assigned) {
            ctx._flash = ['That key was not issued for your account. Ask an Admin/Owner to issue or replace your API key.', 'err'];
          } else if (assigned.api_key_expires_at != null && assigned.api_key_expires_at <= now()) {
            ctx._flash = ['That API key has expired. Ask an Admin/Owner to issue a new one.', 'err'];
          } else {
            await run(ctx.env, 'UPDATE users SET api_key_enc = ? WHERE id = ? AND api_key_hash = ?', await seal(cfg(ctx.env).encryptionKey, key), user.id, keyHash);
            await securityEvent(ctx.env, { userId: user.id, type: 'API_KEY_SAVED', ip: ctx.ip });
            ctx._flash = ['API key saved. It remains assigned to your account.', 'ok'];
          }
        }
      }
      return ctx.redirect('/settings');
    }
    if (['api_key_generate', 'api_key_replace', 'api_key_revoke'].includes(ctx.form.action)) {
      ctx._flash = ['Only an Admin/Owner can issue, replace, or revoke a personal API key.', 'err'];
      return ctx.redirect('/settings');
    }
    if (ctx.form.action === 'shared_api_key_save') {
      if (user.approval !== 'approved' || !user.upi) ctx._flash = ['Save a valid UPI ID after approval before adding a shared API key.', 'err'];
      else {
        const sharedKey = String(ctx.form.shared_api_key || '').trim();
        if (!/^[A-Za-z0-9_-]{2,49}$/.test(sharedKey)) ctx._flash = ['Enter the active shared API key provided by an administrator.', 'err'];
        else {
          const keyHash = await sha256Hex(sharedKey);
          const record = await first(ctx.env, 'SELECT id, expires_at, revoked_at FROM shared_api_keys WHERE key_hash = ?', keyHash);
          if (!record || record.revoked_at != null || record.expires_at <= now()) {
            ctx._flash = ['That shared API key is invalid, expired, or revoked.', 'err'];
          } else {
            await run(ctx.env, 'UPDATE users SET shared_api_key_enc = ? WHERE id = ?', await seal(cfg(ctx.env).encryptionKey, sharedKey), user.id);
            await securityEvent(ctx.env, { userId: user.id, type: 'SHARED_API_KEY_ADDED', ip: ctx.ip, meta: { sharedKeyId: record.id } });
            ctx._flash = ['Shared API key added. Its value is encrypted at rest.', 'ok'];
          }
        }
      }
      return ctx.redirect('/settings');
    }
    if (ctx.form.action === 'shared_api_key_remove') {
      if (user.shared_api_key_enc) {
        await run(ctx.env, 'UPDATE users SET shared_api_key_enc = NULL WHERE id = ?', user.id);
        await securityEvent(ctx.env, { userId: user.id, type: 'SHARED_API_KEY_REMOVED', ip: ctx.ip });
        ctx._flash = ['Shared API key removed from your settings.', 'ok'];
      } else ctx._flash = ['There is no shared API key to remove.', 'err'];
      return ctx.redirect('/settings');
    }
    const name = (ctx.form.name || '').trim(); const upi = (ctx.form.upi || '').trim().toLowerCase();
    const { validUpi } = await import('../payments/core.js');
    if (!name || name.length > 80) ctx._flash = ['Enter your name.', 'err'];
    else if (user.approval === 'approved' && !validUpi(upi)) ctx._flash = ['Enter a valid UPI ID, like name@bank.', 'err'];
    else {
      try {
        if (user.approval === 'approved') await run(ctx.env, 'UPDATE users SET name = ?, upi = ? WHERE id = ?', name, upi, user.id);
        else await run(ctx.env, 'UPDATE users SET name = ? WHERE id = ?', name, user.id);
        ctx._flash = ['Settings saved.', 'ok'];
      } catch (e) { ctx._flash = [/UNIQUE/.test(String(e.message)) ? 'That UPI ID is already linked to another account.' : 'Could not save.', 'err']; }
    }
    return ctx.redirect('/settings');
  }
  const flash = ctx._flashIn; const approved = user.approval === 'approved';
  const upi = user.upi || ''; const key = user.api_key_enc ? await revealSecret(ctx.env, user.api_key_enc) : null;
  const base = ctx.c.appUrl;
  const body = [html`<p class="eyebrow">Profile settings</p><h1>Settings</h1>${settingsTabs('profile')}<p class="sub">Save your UPI ID once. Your API URLs are built for you.</p>`, alert(flash?.[0], flash?.[1])];
  if (!ctx.c.paymentsEnabled) body.push(banner('Temporary testing site — payments are disabled', 'Order creation, UPI payment links, payment verification, and manual confirmation are off. No payments will be processed here.'));
  const gmSet = await gmailAccount(ctx.env, user.id);
  const balLine = user.last_known_balance != null ? html`<b>₹${money(user.last_known_balance)}</b> <span class="field-note" style="margin:0;">as of ${fmtIST(user.last_balance_at)}</span>` : gmSet ? html`<span class="field-note" style="margin:0;">Waiting for a FamApp balance email…</span>` : html`<span class="field-note" style="margin:0;">Connect Gmail on the dashboard to fill this in.</span>`;
  body.push(html`<div class="card"><h2>Profile</h2><form method="post" action="/settings" style="margin-top:14px;">${csrfField(await ctx.csrf())}
    <label for="name">Name</label><input type="text" id="name" name="name" value="${user.name}" required>
    <label for="email">Email</label><input type="text" id="email" value="${user.email}" readonly>
    ${approved ? html`<label for="upi">UPI ID <span class="hint">Every QR pays this UPI ID directly.</span></label><input type="text" id="upi" name="upi" value="${upi}" placeholder="yourname@bank" autocapitalize="off" required>` : ''}
    ${approved ? html`<label>FamPay balance <span class="hint">Read automatically from your latest FamApp "Updated Balance" email.</span></label><div class="mono" id="famBalance" style="padding:10px 0 2px;">${balLine}</div>` : ''}
    <div class="actions profile-actions"><button class="btn primary" type="submit">Save</button><a href="/logout" class="btn danger logout-btn"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg><span>Logout</span></a></div></form></div>`);
  if (!approved || !upi) { body.push(user.approval === 'pending' ? banner('Waiting for admin approval', 'After approval, save your UPI ID. An Admin/Owner will issue your API key.') : user.approval === 'rejected' ? banner('Request not approved', 'Contact the admin if you think this is a mistake.', 'bad') : banner('Save your UPI ID to get your API URLs', 'Enter it above and press Save.')); return ctx.page(shell({ title: 'Settings', user, body: html`${body}` })); }

  const sharedKey = user.shared_api_key_enc ? await revealSecret(ctx.env, user.shared_api_key_enc) : null;
  const sharedKeyHash = sharedKey ? await sha256Hex(sharedKey) : null;
  const sharedKeyRecord = sharedKeyHash ? await first(ctx.env, 'SELECT id, expires_at, revoked_at FROM shared_api_keys WHERE key_hash = ?', sharedKeyHash) : null;
  const sharedKeyActive = !!sharedKeyRecord && sharedKeyRecord.revoked_at == null && sharedKeyRecord.expires_at > now();
  const keyExpired = user.api_key_expires_at != null && user.api_key_expires_at <= Math.floor(Date.now() / 1000);
  const expiryLine = user.api_key_expires_at == null ? 'This key never expires.'
    : keyExpired ? `This key expired on ${fmtIST(user.api_key_expires_at)} — ask the admin for a new one.`
    : `This key expires on ${fmtIST(user.api_key_expires_at)}.`;
  body.push(html`<div class="card"><h2>API Key</h2>
    <p class="field-note">Works only for your UPI account. Anyone with this key can create and check your payment orders — keep it private. Only an Admin/Owner can replace or revoke it.</p>
    ${user.api_enabled ? '' : html`<p class="field-note" style="color:var(--red,#c0392b);">API access is currently disabled by an administrator.</p>`}
    <form method="post" action="/settings">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="api_key_save">
      <label for="apiKey">API Key</label><p class="field-note" style="margin:0 0 8px;">«Enter the API key provided by Admin/Owner.»</p>
      <div class="copybox"><input type="password" id="apiKey" name="api_key" value="${key || ''}" autocomplete="off" required>
        <button class="btn" type="button" id="showKey">Show</button><button class="btn" type="button" data-copy="apiKey">Copy</button></div>
      <div class="actions"><button class="btn primary" type="submit">Save</button></div>
    </form>
  </div>`);
  if (!key) body.push(html`<div class="card"><p class="field-note" style="margin:0;">No personal key yet. Ask an Admin/Owner for one and enter it above, or add a shared key below.</p></div>`);
  else body.push(html`<div class="card"><p class="field-note" style="margin:0 0 4px;${keyExpired ? ' color:var(--red,#c0392b);font-weight:600;' : ''}">${expiryLine}</p>
    <p class="field-note" style="margin:0;">Replace the amount, UTR and order-ID placeholders in the URLs.</p></div>`);
  body.push(html`<div class="card"><h2>Shared API key</h2>
    <p class="field-note">Paste the shared key from an admin. It's stored encrypted; the UPI ID in each URL picks the account.</p>
    ${user.shared_api_key_enc ? html`<p class="field-note" style="${sharedKeyActive ? '' : 'color:var(--red,#c0392b);font-weight:600;'}">Saved key status: ${sharedKeyActive ? `active until ${fmtIST(sharedKeyRecord.expires_at)}` : sharedKeyRecord?.revoked_at != null ? 'revoked by an administrator' : 'expired or no longer available'}</p>
      <form method="post" action="/settings" style="margin:10px 0;">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="shared_api_key_remove"><button class="btn small danger" type="submit" data-confirm="Remove this shared key from your settings?">Remove shared key</button></form>` : ''}
    <form method="post" action="/settings">${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="shared_api_key_save">
      <label for="sharedApiKey">Admin-issued shared key</label><input type="password" id="sharedApiKey" name="shared_api_key" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="Enter the shared key" required>
      <div class="actions"><button class="btn primary" type="submit">${user.shared_api_key_enc ? 'Replace shared key' : 'Add shared key'}</button></div>
    </form></div>`);
  if (!ctx.c.paymentsEnabled) {
    body.push(html`<div class="card"><h2>Payment APIs are off</h2><p class="field-note">Test site: settings work, but UPI links, webhooks and payment confirmation are off (payment APIs return HTTP 503).</p></div>`);
    return ctx.page(shell({ title: 'Settings', user, body: html`${body}<script src="/assets/app.js"></script>`, bodyClass: 'dash' }));
  }
  if (key && !keyExpired) {
    const apiBase = `${base}/gateway-api`;
    const encodedUpi = encodeURIComponent(upi);
    const createUrl = `${apiBase}/${encodedUpi}/create_order.php?amount={amount}&key=${encodeURIComponent(key)}`;
    const checkUrl = `${apiBase}/${encodedUpi}/check_payment.php?id={utr}&key=${encodeURIComponent(key)}`;
    const statusUrl = `${apiBase}/payment/status?upi=${encodedUpi}&order_id={order_id}&key=${encodeURIComponent(key)}`;
    body.push(apiTestCard('Generate QR / Create Payment (Personal key)', 'createUrl', createUrl, 'tAmount', 'Amount, e.g. 499', 'oCreate', 'amount'));
    body.push(apiTestCard('Check Payment By UTR / TXN ID (Personal key)', 'checkUrl', checkUrl, 'tUtr', 'UTR or order ID', 'oCheck', 'utr'));
    const universalUrl = `${apiBase}/check_payment.php?id={utr}&key=${encodeURIComponent(key)}`;
    body.push(apiTestCard('Universal UTR Verification (Personal key)', 'uniUrl', universalUrl, 'uniUtr', 'UTR or transaction ID', 'uniOut', 'utr', 'Works with any valid key and needs no UPI ID. Finds the payment from the matching Gmail alert; order_id is always null here (merchant order ids are never shown).'));
    body.push(apiTestCard('Payment Status Check (Personal key)', 'statusUrl', statusUrl, 'tOrder', 'Order ID, e.g. ORDER_ABC123', 'oStatus', 'order_id', 'Read-only. Returns PAID, PENDING, PROCESSING, UNSUCCESSFUL, EXPIRED or NOT_FOUND. The key can also be sent as an X-API-Key header.'));
  }
  if (sharedKeyActive) {
    const apiBase = `${base}/gateway-api`;
    const encodedUpi = encodeURIComponent(upi);
    const encodedSharedKey = encodeURIComponent(sharedKey);
    const createUrl = `${apiBase}/${encodedUpi}/create_order.php?amount={amount}&key=${encodedSharedKey}`;
    const checkUrl = `${apiBase}/${encodedUpi}/check_payment.php?id={utr}&key=${encodedSharedKey}`;
    const statusUrl = `${apiBase}/payment/status?upi=${encodedUpi}&order_id={order_id}&key=${encodedSharedKey}`;
    body.push(apiTestCard('Generate QR / Create Payment (Shared key)', 'sharedCreateUrl', createUrl, 'sharedTAmount', 'Amount, e.g. 499', 'sharedOCreate', 'amount'));
    body.push(apiTestCard('Check Payment By UTR / TXN ID (Shared key)', 'sharedCheckUrl', checkUrl, 'sharedTUtr', 'UTR or order ID', 'sharedOCheck', 'utr'));
    const sharedUniversalUrl = `${apiBase}/check_payment.php?id={utr}&key=${encodedSharedKey}`;
    body.push(apiTestCard('Universal UTR Verification (Shared key)', 'sharedUniUrl', sharedUniversalUrl, 'sharedUniUtr', 'UTR or transaction ID', 'sharedUniOut', 'utr', 'Works with any valid key and needs no UPI ID. Finds the payment from the matching Gmail alert; order_id is always null here (merchant order ids are never shown).'));
    body.push(apiTestCard('Payment Status Check (Shared key)', 'sharedStatusUrl', statusUrl, 'sharedTOrder', 'Order ID, e.g. ORDER_ABC123', 'sharedOStatus', 'order_id', 'Read-only; this URL includes your UPI ID to keep shared-key lookups scoped to your account.'));
  }
  // The "Payment alerts (webhook)" card (verify.php URL + secret) is intentionally hidden on the settings page.
  return ctx.page(shell({ title: 'Settings', user, body: html`${body}<script src="/assets/app.js"></script>`, bodyClass: 'dash' }));
}

function apiTestCard(title, urlId, url, inputId, inputPlaceholder, outputId, token, note = '') {
  return html`<div class="card"><h2 class="api-title">${title}</h2><div class="copybox"><input type="text" id="${urlId}" value="${url}" readonly><button class="btn" type="button" data-copy="${urlId}">Copy</button></div>
    <div class="copybox" style="margin-top:10px;"><input type="text" id="${inputId}" placeholder="${inputPlaceholder}" inputmode="${token === 'amount' ? 'decimal' : 'text'}"><button class="btn primary" type="button" data-api-test data-url-id="${urlId}" data-input-id="${inputId}" data-output-id="${outputId}" data-token="${token}">Test</button></div>
    ${note ? html`<p class="field-note">${note}</p>` : ''}<pre id="${outputId}" style="margin-top:10px;display:none;" aria-live="polite"></pre></div>`;
}

export async function gmailConnectRoute(ctx) {
  const user = await ctx.user(); if (!user || user.approval !== 'approved') return ctx.redirect('/login');
  const lim = await ctx.limit('oauth_ip', ctx.ip, RULES.oauth_ip); if (lim) return lim;
  if (!(ctx.c.googleClientId && ctx.c.googleClientSecret)) { ctx._flash = ['Gmail connection is not configured on this server.', 'err']; return ctx.redirect('/dashboard'); }
  const redirectUri = `${ctx.c.appUrl}/gmail-callback`;
  const url = await beginOAuth(ctx.env, { kind: 'gmail_user', userId: user.id, scope: userScopes(), redirectUri });
  return ctx.redirect(url);
}
const CONNECT_ERRORS = {
  not_readonly: 'Only read-only Gmail access is allowed. The connection was cancelled.',
  no_identity: 'Could not confirm which Gmail account was authorized. Please try again.',
  need_refresh_token: 'Google did not return offline access. Remove this app at myaccount.google.com/permissions and connect again.',
};
export async function gmailCallbackRoute(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  const lim = await ctx.limit('oauth_ip', ctx.ip, RULES.oauth_ip); if (lim) return lim;
  const { consumeOAuthState, exchangeCode } = await import('../gmail/google.js');
  const state = ctx.url.searchParams.get('state'); const code = ctx.url.searchParams.get('code');
  const s = await consumeOAuthState(ctx.env, { kind: 'gmail_user', userId: user.id, state });
  const fail = (m) => { ctx._flash = [m, 'err']; return ctx.redirect('/dashboard'); };
  if (!s || !s.verifier) return fail('The Gmail authorization request was invalid or expired. Please try again.');
  if (ctx.url.searchParams.get('error') || !code) return fail('Gmail was not connected (authorization was cancelled or denied).');
  const { status, body } = await exchangeCode(ctx.env, code, s.verifier, `${ctx.c.appUrl}/gmail-callback`);
  if (status === 0) return fail('Could not reach Google. Please try again.');
  if (status !== 200 || !body.access_token) return fail('Google did not accept the authorization. Please try again.');
  let r;
  try { r = await completeConnect(ctx.env, { userId: user.id, exchange: body }); }
  catch (e) { console.error('gmail connect failed:', e.code || e.message); return fail('Could not save the Gmail connection. Please try again.'); }
  if (r.error === 'conflict') return fail(`${r.email} is already connected to another gateway account. It can be connected here once that account disconnects it, or use a different Gmail.`);
  if (r.error) return fail(CONNECT_ERRORS[r.error] || 'Gmail was not connected. Please try again.');
  const email = r.email;
  // read the last 30 days of FamApp alerts right away so the balance ("Updated Balance") is filled in (waits up to 4 s, keeps going in the background)
  const { refreshBalance } = await import('../gmail/reconcile.js');
  await Promise.race([refreshBalance(ctx.env, user, { backfill: true }).catch((e) => console.error('balance backfill failed:', e.message)), new Promise((res) => setTimeout(res, 4000))]);
  ctx._flash = ['Gmail connected: ' + email + (user.last_known_balance != null ? ` — FamPay balance ₹${money(user.last_known_balance)}` : ''), 'ok']; return ctx.redirect('/dashboard?tab=gmail');
}
/** One inbox row (shared by the page and the live endpoint, so both render identically). */
function inboxRow(m, payment = false) {
  const p = m.payload || {}; const unread = (m.labelIds || []).includes('UNREAD'); const h = (n) => (p.headers || []).find((x) => x.name === n)?.value || '';
  return html`<tr data-id="${m.id}" class="${payment ? 'pay-row' : ''}" style="${unread ? 'font-weight:700;' : ''}"><td>${senderCell(h('From'))}</td><td><a href="/gmail-message?id=${encodeURIComponent(m.id)}" style="color:inherit;">${payment ? '✅ ' : ''}${h('Subject') || '(no subject)'}</a><div class="field-note" style="margin:2px 0 0;font-weight:400;">${snippetText(m.snippet)}</div></td><td style="white-space:nowrap;">${unread ? '● ' : ''}${fmtISTms(m.internalDate)}</td></tr>`;
}
const liveCache = new Map();   // userId -> Map(messageId -> metadata message): an inbox row never has to be fetched twice
/** JSON for the live inbox: verifies new payment e-mails right now (throttled), then returns the newest rows as ready-made HTML. */
export async function gmailInboxLive(ctx) {
  const user = await ctx.user(); if (!user) return ctx.json({ ok: false, error: 'login' }, 401);
  const acct = await gmailAccount(ctx.env, user.id); if (!acct) return ctx.json({ ok: false, error: 'no_gmail' }, 404);
  const lim = await ctx.limit('inbox_live', 'u' + user.id, { max: 60, windowSec: 60 }, { json: true }); if (lim) return lim;
  const { userAccessToken, pollNow, isPaymentAlertHeaders } = await import('../gmail/reconcile.js');
  const { gmailGet } = await import('../gmail/google.js');
  await pollNow(ctx.env, user.id, 3).catch((e) => console.error('live poll failed:', e.message));
  const token = await userAccessToken(ctx.env, user.id);
  const list = token ? await gmailGet(token, '/messages', { maxResults: 15, labelIds: 'INBOX' }) : { status: 401, body: {} };
  if (list.status !== 200) return ctx.json({ ok: false, error: 'gmail_unavailable' }, 502);
  let cache = liveCache.get(user.id); if (!cache) { cache = new Map(); liveCache.set(user.id, cache); } if (cache.size > 120) cache.clear();
  await Promise.all((list.body.messages || []).filter((m) => !cache.has(m.id)).map(async (m) => {
    const r = await gmailGet(token, '/messages/' + encodeURIComponent(m.id), { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    if (r.status === 200) cache.set(m.id, r.body);
  }));
  const rows = (list.body.messages || []).map((m) => cache.get(m.id)).filter(Boolean).map((m) => {
    const h = (n) => (m.payload?.headers || []).find((x) => x.name === n)?.value || '';
    const payment = isPaymentAlertHeaders(ctx.env, h('From'), h('Subject'));
    return { id: m.id, payment, subject: h('Subject'), html: String(inboxRow(m, payment)) };
  });
  const fresh = await first(ctx.env, 'SELECT last_known_balance, last_balance_at FROM users WHERE id = ?', user.id) || {};
  return ctx.json({ ok: true, rows, balance: fresh.last_known_balance != null ? { text: '₹' + money(fresh.last_known_balance), at: fmtIST(fresh.last_balance_at) } : null, checkedAt: fmtIST(Math.floor(Date.now() / 1000)) });
}

export async function gmailInboxPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  const acct = await gmailAccount(ctx.env, user.id);
  if (!acct) { ctx._flash = ['Connect Gmail first.', 'err']; return ctx.redirect('/dashboard'); }
  const { userAccessToken, header, bodyText } = await import('../gmail/reconcile.js');
  const { gmailGet } = await import('../gmail/google.js');
  const page = /^[A-Za-z0-9_-]{1,300}$/.test(ctx.url.searchParams.get('page') || '') ? ctx.url.searchParams.get('page') : null;
  const token = await userAccessToken(ctx.env, user.id);
  const list = token ? await gmailGet(token, '/messages', { maxResults: 15, labelIds: 'INBOX', pageToken: page }) : { status: 401, body: {} };
  let rows = [];
  if (list.status === 200 && list.body.messages) {
    const results = await Promise.all(list.body.messages.map((m) => gmailGet(token, '/messages/' + encodeURIComponent(m.id), { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })));
    rows = results.filter((r) => r.status === 200).map((r) => r.body);
  }
  const body = html`<p class="eyebrow">Gmail · read-only</p><h1>Inbox</h1><p class="sub">${acct.email} · <a href="/dashboard" style="color:var(--gold);">Back to dashboard</a></p>
  ${list.status !== 200 ? banner("Couldn't load your inbox", 'Google did not respond, or access was revoked. Reconnect Gmail from the dashboard.', 'bad')
    : !rows.length ? html`<div class="card"><p class="field-note">No messages.</p></div>`
    : html`<div class="card" id="liveInbox" ${page ? '' : html`data-live-url="/gmail-inbox/live"`}>
      ${page ? '' : html`<p class="field-note" style="margin:0 0 8px;"><span id="liveBadge" class="live-badge">● Live</span> New payment e-mails are read every few seconds and verify your orders at once. <span id="liveBalanceWrap">FamPay balance: <b id="liveBalance">${user.last_known_balance != null ? '₹' + money(user.last_known_balance) : '—'}</b></span> <span id="liveChecked"></span></p><div id="livePayAlert" class="alert ok" role="status" style="display:none;"></div>`}
      <div class="table-scroll"><table class="orders"><thead><tr><th>From</th><th>Subject</th><th>Date</th></tr></thead><tbody id="liveRows">
        ${rows.map((m) => inboxRow(m))}
      </tbody></table></div>${page ? '' : html`<script src="/assets/inbox-live.js" defer></script>`}${list.body.nextPageToken ? html`<div class="actions"><a class="btn" href="/gmail-inbox?page=${encodeURIComponent(list.body.nextPageToken)}">Older messages →</a></div>` : ''}</div>`}`;
  return ctx.page(shell({ title: 'Inbox', user, body, bodyClass: 'dash' }));
}
export async function gmailMessagePage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!(await gmailAccount(ctx.env, user.id))) return ctx.redirect('/dashboard');
  const id = ctx.url.searchParams.get('id') || '';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return ctx.text('Bad request', 400);
  const { userAccessToken, header, bodyText } = await import('../gmail/reconcile.js');
  const { gmailGet } = await import('../gmail/google.js');
  const token = await userAccessToken(ctx.env, user.id);
  const r = token ? await gmailGet(token, '/messages/' + encodeURIComponent(id), { format: 'full' }) : { status: 401, body: {} };
  const body = html`<p class="eyebrow">Gmail · read-only</p>
  ${r.status !== 200 || !r.body.payload ? banner('Message not found', 'It may have been deleted, or your Gmail access changed.', 'bad')
    : html`<h1 style="font-size:24px;">${header(r.body.payload, 'Subject') || '(no subject)'}</h1><div class="card"><p class="field-note" style="margin:0;"><b>From:</b> ${header(r.body.payload, 'From')}<br><b>To:</b> ${header(r.body.payload, 'To')}<br><b>Date:</b> ${fmtISTms(r.body.internalDate)}</p><hr style="border:0;border-top:1px solid var(--line);margin:14px 0;"><pre style="white-space:pre-wrap;word-break:break-word;background:none;border:0;padding:0;color:inherit;font-family:inherit;">${bodyText(r.body.payload)}</pre></div>`}
  <p><a href="/gmail-inbox" class="btn">← Inbox</a></p>`;
  return ctx.page(shell({ title: 'Message', user, body, bodyClass: 'dash' }));
}
