import { autoApproveState, setAutoApprove } from '../services/auto-approve.js';
import { approvalSubTabs, approvalHistoryPage } from './admin-approval-history.js';
import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { first, all, run, now, getSetting } from '../lib/db.js';
import { findLookalikes } from '../auth/email-check.js';
import { visibleOrdersSql } from '../lib/order-visibility.js';
import { authorize, can } from '../admin/rbac.js';
import { RULES } from '../lib/ratelimit.js';
import * as A from '../admin/actions.js';
import { money, pillClassOrder } from '../payments/core-ui.js';
import { pillClassUser } from '../payments/core-ui.js';
import { adminTabs } from './admin-tabs.js';
import { fmtIST, fmtISTs, dayIST } from '../lib/time.js';
import { revealSecret } from '../auth/accounts.js';
import { sha256Hex } from '../lib/crypto.js';

/** Display name of a role: the single SUPER_ADMIN account (email from ADMIN_EMAIL) is shown as "Owner". */
const roleLabel = (r) => ({ SUPER_ADMIN: 'Owner', ADMIN: 'Admin', SUPPORT: 'Support', USER: 'User' }[r] || r);
function guardStaff(ctx, user) { return ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'].includes(user.role); }
const fail = (ctx, msg) => { ctx._flash = [msg, 'err']; return ctx.redirect(ctx.request.headers.get('Referer')?.includes('/admin') ? new URL(ctx.request.headers.get('Referer')).pathname : '/admin'); };

export async function adminHome(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!guardStaff(ctx, user)) { ctx._flash = ['Your account cannot access the admin panel.', 'err']; return ctx.redirect('/dashboard'); }
  return ctx.redirect('/admin/users');
}
const tabs = adminTabs;
function activityCard(title, rows, headers, render) {
  return html`<div class="card"><h2>${title}</h2>${!rows.length ? html`<p class="field-note">None.</p>` : html`<div class="table-scroll"><table class="orders"><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map(render)}</tbody></table></div>`}</div>`;
}

export async function adminApprovalsPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!guardStaff(ctx, user) || !can(user.role, 'users.approve')) {
    ctx._flash = ['Your account cannot review pending approvals.', 'err'];
    return ctx.redirect('/admin/users');
  }
  return adminUsersPage(ctx, true);
}

function userFilterHref(path, filters, field, value) {
  const params = new URLSearchParams();
  for (const [key, current] of Object.entries(filters)) if (current) params.set(key, current);
  if (value) params.set(field, value); else params.delete(field);
  params.delete('page'); params.delete('all');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export async function adminUsersPage(ctx, onlyPendingApproval = false) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!guardStaff(ctx, user)) return ctx.redirect('/dashboard');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    const id = Number(ctx.form.id || 0); const reason = (ctx.form.reason || '').trim(); const act = ctx.form.action || '';
    if (act === 'auto_approve_on' || act === 'auto_approve_off') {
      const ar = await setAutoApprove(ctx.env, user, act === 'auto_approve_on', ctx.ip);
      ctx._flash = !ar.ok ? [ar.reason, 'err'] : act === 'auto_approve_on'
        ? [`⚡ Auto Approve is ON${ar.approved ? ` — ${ar.approved} waiting request${ar.approved === 1 ? '' : 's'} approved` : ''}.`, 'ok']
        : ['Auto Approve is OFF — approve manually.', 'ok'];
      if ((ctx.request.headers.get('accept') || '').includes('application/json')) {      // the switch on the page: answer in place, no reload
        const now_on = ar.ok ? act === 'auto_approve_on' : (await autoApproveState(ctx.env)).on;
        return ctx.json({ ok: !!ar.ok, on: now_on, approved: ar.approved || 0, message: ctx._flash[0] }, ar.ok ? 200 : 403);
      }
      return ctx.redirect('/admin/approvals');
    }
    let r;
    if (act === 'approve') r = await A.decideApproval(ctx.env, user, id, true, reason, ctx.ip);
    else if (act === 'reject') r = await A.decideApproval(ctx.env, user, id, false, reason, ctx.ip);
    else if (act === 'status') r = await A.setStatus(ctx.env, user, id, ctx.form.status, reason, ctx.ip, ctx.form.minutes);
    else if (['unfreeze', 'freeze', 'suspend', 'ban'].includes(act)) r = await A.setStatus(ctx.env, user, id, { unfreeze: 'active', freeze: 'frozen', suspend: 'suspended', ban: 'banned' }[act], reason, ctx.ip, ctx.form.minutes);
    else if (act === 'force_logout') r = await A.forceLogoutUser(ctx.env, user, id, reason, ctx.ip);
    else if (act === 'api_enable') r = await A.setApiEnabled(ctx.env, user, id, true, reason, ctx.ip);
    else if (act === 'api_disable') r = await A.setApiEnabled(ctx.env, user, id, false, reason, ctx.ip);
    else if (act === 'api_revoke') r = await A.revokeUserApiKey(ctx.env, user, id, reason, ctx.ip);
    else if (act === 'api_reissue') r = await A.reissueUserApiKey(ctx.env, user, id, reason, ctx.ip);
    else if (act === 'api_create') {
      const custom = ctx.form.key_mode === 'custom' ? (ctx.form.custom_key || '').trim() : '';
      const infinite = ctx.form.expiry_mode !== 'duration';
      const amount = Math.max(0, Number(ctx.form.duration_value) || 0);
      const unitSec = { minutes: 60, hours: 3600, days: 86400 }[ctx.form.duration_unit] || 86400;
      r = await A.createApiKeyForUser(ctx.env, user, id, { customKey: custom, durationSeconds: infinite ? 0 : amount * unitSec }, reason, ctx.ip);
    }
    else if (act === 'api_renew') r = await A.renewApiKeyForUser(ctx.env, user, id, { days: ctx.form.renew_days, infinite: ctx.form.renew_never === '1' }, reason, ctx.ip);
    else if (act === 'email_verify') r = await A.setEmailVerified(ctx.env, user, id, true, reason, ctx.ip);
    else if (act === 'email_unverify') r = await A.setEmailVerified(ctx.env, user, id, false, reason, ctx.ip);
    else if (act === 'password_reset') r = await A.adminResetPassword(ctx.env, user, id, reason, ctx.ip);
    else if (act === 'delete_user') r = await A.deleteUserAccount(ctx.env, user, id, reason, ctx.ip);
    else if (act === 'role') r = await A.setRole(ctx.env, user, id, ctx.form.role, reason, ctx.ip);
    else if (act === 'resend_verification') r = await A.resendVerification(ctx.env, user, id, reason, ctx.ip);
    else r = { ok: false, reason: 'unknown action' };
    if (r.ok && r.key) {
      const expiryNote = r.expiresAt ? ` — expires ${fmtIST(r.expiresAt)}` : ' — never expires';
      ctx._flash = [`New API key: ${r.key} (shown once — copy it now)${expiryNote}${r.emailed ? ' — the key was also emailed to the user 📧' : ''}`, 'keep'];
    } else {
      ctx._flash = r.ok ? [r.note || 'Done.', 'ok'] : [r.reason || 'Action failed.', 'err'];
    }
    return ctx.redirect('/admin/users' + (id && !(act === 'delete_user' && r.ok) ? `/${id}` : ''));
  }
  const q = ctx.url.searchParams.get('q') || '', status = ctx.url.searchParams.get('status') || '', approval = onlyPendingApproval ? 'pending' : ctx.url.searchParams.get('approval') || '', role = ctx.url.searchParams.get('role') || '';
  if (onlyPendingApproval && ctx.url.searchParams.get('view') === 'history') return approvalHistoryPage(ctx, user);
  const listPath = onlyPendingApproval ? '/admin/approvals' : '/admin/users';
  const filters = { q, status, approval, role };
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') || 1));
  const viewAll = !onlyPendingApproval && ctx.url.searchParams.get('all') === '1';
  // With "Email code at sign-up" on, Pending approvals lists only accounts that already verified their e-mail (the others can't be approved yet).
  const autoState = onlyPendingApproval ? await autoApproveState(ctx.env) : { on: false }, otpOn = (await getSetting(ctx.env, 'otp_signup', '0')) === '1';
  const hideUnverified = onlyPendingApproval && (await getSetting(ctx.env, 'otp_signup', '0')) === '1';
  const hideUnverifiedPending = !onlyPendingApproval && otpOn;   // with e-mail codes on, the Users list also leaves out pending accounts that never verified
  const { rows, total } = await A.listUsers(ctx.env, { q, status, role, approval, verifiedOnly: hideUnverified, hideUnverifiedPending, page: viewAll ? 1 : page, pageSize: viewAll ? 5000 : 25 });
  // Typo / look-alike sign-ups: an address that is one letter away from another account (e.g. kevinheguor vs kevinheiguor) is flagged next to it.
  let lookalike = new Map();
  try { const watch = rows.filter((u) => u.role === 'USER' && (u.approval === 'pending' || !u.email_verified)); if (watch.length) lookalike = findLookalikes(watch, await all(ctx.env, "SELECT id, email FROM users WHERE role = 'USER'")); } catch { lookalike = new Map(); }
  const hiddenUnverified = (hideUnverified || hideUnverifiedPending) ? Number((await first(ctx.env, "SELECT COUNT(*) AS n FROM users WHERE approval = 'pending' AND email_verified = 0"))?.n) || 0 : 0;
  const flash = ctx._flashIn;
  const opt = (cur, vals) => vals.map(([v, l]) => html`<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`);
  const approvalCategories = [['', 'All approvals'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];
  const statusCategories = [['', 'All account states'], ['active', 'Active'], ['frozen', 'Frozen'], ['suspended', 'Suspended'], ['banned', 'Banned']];
  // The UPI ID column is only useful for approved, non-banned users (pending users cannot add a UPI ID yet).
  const showUpi = !onlyPendingApproval && status !== 'banned' && approval !== 'pending';
  // The key issued to THIS admin account (personal key, else the active shared key saved in their Settings) pre-fills the Universal UTR test box.
  let ownKey = '', ownKeyKind = '';
  if (!onlyPendingApproval) {
    try {
      if (user.api_key_enc) { ownKey = (await revealSecret(ctx.env, user.api_key_enc)) || ''; ownKeyKind = 'personal'; }
      if (!ownKey && user.shared_api_key_enc) {
        const sk = (await revealSecret(ctx.env, user.shared_api_key_enc)) || '';
        const rec = sk ? await first(ctx.env, 'SELECT revoked_at, expires_at FROM shared_api_keys WHERE key_hash = ?', await sha256Hex(sk)) : null;
        if (rec && rec.revoked_at == null && Number(rec.expires_at) > now()) { ownKey = sk; ownKeyKind = 'shared'; }
      }
    } catch { ownKey = ''; ownKeyKind = ''; }
  }
  const body = html`<p class="eyebrow">Admin panel</p><h1>${onlyPendingApproval ? 'Pending approvals' : 'Users'}</h1>${tabs(user, onlyPendingApproval ? 'approvals' : 'users')}${alert(flash?.[0], flash?.[1])}
  ${onlyPendingApproval ? approvalSubTabs('pending') : ''}
  ${onlyPendingApproval && can(user.role, 'users.approve') ? html`<div class="card aa-row"><span class="aa-title">⚡ Auto Approve</span>
    <form method="post" action="/admin/approvals" style="margin:0;" data-toggle-ajax>${csrfField(await ctx.csrf())}<input type="hidden" name="action" value="${autoState.on ? 'auto_approve_off' : 'auto_approve_on'}">
      <button type="submit" class="aa-switch ${autoState.on ? 'on' : 'off'}" role="switch" aria-checked="${autoState.on ? 'true' : 'false'}" aria-label="Auto Approve ${autoState.on ? 'on, tap to turn off' : 'off, tap to turn on'}"><span class="aa-label aa-on">ON</span><span class="aa-label aa-off">OFF</span><span class="aa-knob"></span></button></form></div>` : ''}
  ${hiddenUnverified ? html`<div class="banner wait"><b>⏳ Sign-up verification pending</b></div>` : ''}
  ${!onlyPendingApproval ? html`<div class="card"><p class="field-note" style="margin:0 0 8px;">Approval categories</p><div class="acts" style="flex-wrap:wrap;">${approvalCategories.map(([value, label]) => html`<a class="btn small ${approval === value ? 'primary' : ''}" href="${userFilterHref('/admin/users', filters, 'approval', value)}">${label}</a>`)}</div>
    <p class="field-note" style="margin:12px 0 8px;">Account states</p><div class="acts" style="flex-wrap:wrap;">${statusCategories.map(([value, label]) => html`<a class="btn small ${status === value ? 'primary' : ''}" href="${userFilterHref('/admin/users', filters, 'status', value)}">${label}</a>`)}</div></div>` : ''}
  <div class="card"><form method="get" action="${listPath}" class="toolbar" style="margin-bottom:0;">
    <input type="text" name="q" value="${q}" placeholder="Search name, email, UPI" style="max-width:220px;">
    <select name="status">${opt(status, [['', 'Any status'], ['active', 'Active'], ['frozen', 'Frozen'], ['suspended', 'Suspended'], ['banned', 'Banned']])}</select>
    <select name="approval">${opt(approval, onlyPendingApproval ? [['pending', 'Pending approvals']] : [['', 'Any approval'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']])}</select>
    <select name="role">${opt(role, [['', 'Any role'], ['USER', 'User'], ['SUPPORT', 'Support'], ['ADMIN', 'Admin'], ['SUPER_ADMIN', 'Owner']])}</select>
    ${viewAll ? html`<input type="hidden" name="all" value="1">` : ''}<button class="btn small" type="submit">Filter</button>
    ${!onlyPendingApproval ? html`<a class="btn small ${viewAll ? 'primary' : ''}" href="?q=${encodeURIComponent(q)}&status=${status}&role=${role}&approval=${approval}&all=${viewAll ? '0' : '1'}">${viewAll ? 'Back to pages' : 'View all users'}</a>` : ''}
    ${!onlyPendingApproval ? html`<a class="btn small" href="/admin/users/emails.csv?q=${encodeURIComponent(q)}&status=${status}&role=${role}&approval=${approval}">Export emails (.csv)</a>` : ''}
    </form></div>
  <div class="card"><div class="table-scroll"><table class="orders"><thead><tr><th>Name</th><th>Email</th>${showUpi ? html`<th style="white-space:nowrap;">FamPay balance</th><th>UPI ID</th>` : ''}<th>Role</th><th>Approval</th><th>Status</th><th>API</th><th>Payments</th><th>Joined</th></tr></thead><tbody>
    ${rows.map((u) => html`<tr><td><a href="/admin/users/${u.id}" style="color:inherit;">${u.name}</a></td><td class="mono">${u.email}${u.email_verified ? ' ✓' : ''}${lookalike.has(u.id) ? html`<div class="field-note" style="margin:2px 0 0;color:#b45309;">⚠ Looks like <b>${lookalike.get(u.id)}</b> — possibly a typo or a different person${u.email_verified ? '' : '. Email not verified'}.</div>` : ''}</td>${showUpi ? html`<td class="mono" style="white-space:nowrap;" ${u.last_balance_at ? html`title="updated ${fmtIST(u.last_balance_at)}"` : ''}>${u.last_known_balance != null ? html`₹${money(u.last_known_balance)}` : html`<span class="field-note">not read</span>`}</td><td class="mono">${u.approval === 'pending' || u.acct_status === 'banned' ? '—' : u.upi || html`<span class="field-note">not added</span>`}</td>` : ''}<td>${roleLabel(u.role)}</td>
      <td><span class="pill ${pillClassUser(u.approval)}">${u.approval}</span></td><td><span class="pill ${pillClassUser(u.acct_status)}">${u.acct_status}</span></td>
      <td>${u.api_enabled ? 'on' : 'off'}</td><td>${u.approval === 'approved' && u.acct_status !== 'banned' ? html`<a class="btn small" href="/admin/users/${u.id}#payment-history">History</a>` : '—'}</td><td>${dayIST(u.created_at)}</td></tr>`)}
  </tbody></table></div><p class="field-note">${viewAll ? `Showing all ${total} user(s).` : total > 25 ? html`${rows.length} of ${total} — <a href="${listPath}?q=${encodeURIComponent(q)}&status=${status}&role=${role}&approval=${approval}&page=${page + 1}">next page</a>` : `${total} user(s).`}</p></div>
  ${!onlyPendingApproval ? html`<div class="card"><h2 class="api-title">Universal UTR Verification</h2>
    <p class="field-note" style="margin:0 0 10px;">Any valid API key works; no UPI ID needed. ${ownKey ? html`Your own ${ownKeyKind} key is used — enter a UTR or transaction ID and press Test.` : html`You have no key yet (create one in <a href="/settings" style="color:var(--gold);">Settings</a>) — enter any valid key below.`}</p>
    <div class="copybox"><input type="text" id="adminUniUrl" value="${ctx.c.appUrl}/gateway-api/check_payment.php?id={utr}&key={key}" readonly><button class="btn" type="button" data-copy="adminUniUrl">Copy</button></div>
    ${ownKey ? html`<input type="hidden" id="adminUniKey" value="${ownKey}">` : html`<div class="copybox" style="margin-top:10px;"><input type="password" id="adminUniKey" placeholder="API key" autocomplete="off" autocapitalize="off" spellcheck="false"></div>`}
    <div class="copybox" style="margin-top:10px;"><input type="text" id="adminUniUtr" placeholder="UTR or transaction ID" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn primary" type="button" data-api-test data-url-id="adminUniUrl" data-input-id="adminUniUtr" data-key-input-id="adminUniKey" data-output-id="adminUniOut" data-token="utr">Test</button></div>
    <pre id="adminUniOut" style="margin-top:10px;display:none;" aria-live="polite"></pre></div><script src="/assets/app.js"></script>` : ''}
`;
  return ctx.page(shell({ title: `Admin · ${onlyPendingApproval ? 'Pending approvals' : 'Users'}`, user, body, bodyClass: 'dash' }));
}

export async function adminUsersEmailsCsv(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!guardStaff(ctx, user)) return ctx.redirect('/dashboard');
  const q = ctx.url.searchParams.get('q') || '', status = ctx.url.searchParams.get('status') || '', approval = ctx.url.searchParams.get('approval') || '', role = ctx.url.searchParams.get('role') || '';
  const { rows } = await A.listUsers(ctx.env, { q, status, role, approval, page: 1, pageSize: 5000 });
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['name,email,role,approval,status,joined', ...rows.map((u) => [u.name, u.email, u.role, u.approval, u.acct_status, dayIST(u.created_at)].map(esc).join(','))];
  return new Response(lines.join('\r\n'), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="users.csv"', 'Cache-Control': 'no-store' } });
}

export async function adminUserDetailPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!guardStaff(ctx, user)) return ctx.redirect('/dashboard');
  const id = Number(ctx.params.id);
  const t = await A.userDetail(ctx.env, id); if (!t) return ctx.page(shell({ title: 'Not found', user, body: html`<h1>User not found</h1>` }), 404);
  const [orders, api, sec, audit, gm, records] = await Promise.all([A.userOrders(ctx.env, id, 30), A.userApiActivity(ctx.env, id, 30), A.userSecurityEvents(ctx.env, id, 30), A.auditForTarget(ctx.env, id, 30), first(ctx.env, 'SELECT email, connected_at, last_checked FROM gmail_accounts WHERE user_id = ?', id), A.userPaymentRecords(ctx.env, id, 50)]);
  const paySum = await A.userPaymentSummary(ctx.env, id);
  const flash = ctx._flashIn;
  // "Issued keys": the personal API key an admin issued to this user + the shared key this user saved in Settings. Visible to staff who can manage API keys;
  // the key VALUES are shown to the SUPER_ADMIN only (same rule as Admin -> Shared keys), everyone else sees status and dates. The page is never cached.
  let issuedCard = '';
  if (can(user.role, 'users.api')) {
    const showVals = can(user.role, 'shared_api.manage'), nowS = Math.floor(Date.now() / 1000), red = 'color:var(--red,#c0392b);';
    const pKey = t.api_key_hash && t.api_key_enc ? ((await revealSecret(ctx.env, t.api_key_enc).catch(() => null)) || null) : null;
    const sKey = t.shared_api_key_enc ? ((await revealSecret(ctx.env, t.shared_api_key_enc).catch(() => null)) || null) : null;
    const sRec = sKey ? await first(ctx.env, 'SELECT id, expires_at, revoked_at FROM shared_api_keys WHERE key_hash = ?', await sha256Hex(sKey)) : null;
    const sActive = !!sRec && sRec.revoked_at == null && sRec.expires_at > nowS;
    const val = (v, stored) => showVals ? (stored ? html`<div class="keyval" style="font-size:15px;font-weight:600;color:var(--ink);">${v}</div>` : html`<div class="field-note">value not stored</div>`) : html`<div class="mono">••••••••</div><div class="field-note">Key values are visible to the super admin only.</div>`;
    const pExpired = t.api_key_expires_at != null && t.api_key_expires_at <= nowS;
    const personal = !t.api_key_hash ? html`<span class="field-note">No API key issued yet.</span>`
      : html`${val(pKey, !!pKey)}<div class="field-note">${t.api_key_custom ? 'Custom value' : 'Random 7-digit key'} · issued ${t.api_key_issued_at ? fmtIST(t.api_key_issued_at) : '—'} · ${t.api_key_expires_at == null ? 'never expires' : pExpired ? html`<b style="${red}">expired</b> ${fmtIST(t.api_key_expires_at)}` : html`expires ${fmtIST(t.api_key_expires_at)}`}${t.api_enabled ? '' : html` · <b style="${red}">API access is disabled</b>`}</div>`;
    const shared = !t.shared_api_key_enc ? html`<span class="field-note">No shared key saved by this user.</span>`
      : html`${val(sKey, !!sKey)}<div class="field-note" style="${sActive ? '' : red + 'font-weight:600;'}">${sRec ? html`Shared key #${sRec.id} · ` : ''}${sActive ? html`active until ${fmtIST(sRec.expires_at)}` : sRec && sRec.revoked_at != null ? 'revoked by an administrator' : sRec ? html`expired ${fmtIST(sRec.expires_at)}` : 'no longer available (removed or not recognised)'}</div>`;
    issuedCard = html`<div class="card"><h2>Issued keys</h2><table class="orders"><tbody>
      <tr><td>API key <span class="field-note">(issued by admin)</span></td><td>${personal}</td></tr>
      <tr><td>Shared key <span class="field-note">(saved by the user)</span></td><td>${shared}</td></tr>
    </tbody></table></div>`;
  }
  const body = html`<p class="eyebrow">Admin panel · user</p><h1>${t.name}</h1>${alert(flash?.[0], flash?.[1])}
  <div class="stat-grid" style="margin:12px 0;">
    <div class="stat"><div class="stat-icon gold"><span class="rupee">₹</span></div><div class="stat-body stacked"><span class="lbl">FamPay balance</span><span class="val">${t.last_known_balance != null ? html`₹${money(t.last_known_balance)}` : '—'}</span><span class="field-note" style="margin:2px 0 0;">${t.last_known_balance != null ? html`updated ${fmtIST(t.last_balance_at)} · from the latest "Updated Balance" e-mail` : 'not read yet (the user has to connect Gmail)'}</span></div></div>
    <div class="stat"><div class="stat-icon"><span class="rupee">✅</span></div><div class="stat-body stacked"><span class="lbl">Successful payments</span><span class="val">${paySum.count}</span><span class="field-note" style="margin:2px 0 0;">total ₹${money(paySum.total)} · <a href="#payment-history" style="color:var(--gold);">view history</a></span></div></div>
  </div>
  <div class="card"><table class="orders"><tbody>
    <tr><td>Login email</td><td class="mono">${t.email} ${t.email_verified ? '✓ verified' : '(unverified)'}</td></tr>
    <tr><td>FamPay balance <span class="field-note">(from the latest "Updated Balance" email)</span></td><td class="mono">${t.last_known_balance != null ? html`₹${money(t.last_known_balance)}<br><span class="field-note">as of ${fmtIST(t.last_balance_at)}</span>` : html`<span class="field-note">not read yet</span>`}</td></tr>
    <tr><td>FamPay Gmail</td><td class="mono">${gm ? html`${gm.email}<br><span class="field-note">Connected ${fmtIST(gm.connected_at)}${gm.last_checked ? html` · Checked ${fmtIST(gm.last_checked)}` : ' · Not checked yet'}</span>` : html`<span class="field-note">not connected</span>`}</td></tr>
    <tr><td>Role</td><td>${roleLabel(t.role)}</td></tr><tr><td>Approval</td><td><span class="pill ${pillClassUser(t.approval)}">${t.approval}</span></td></tr>
    <tr><td>Account status</td><td><span class="pill ${pillClassUser(t.acct_status)}">${t.acct_status}</span>${t.acct_status === 'suspended' && t.suspended_until ? html` until ${fmtIST(t.suspended_until)}` : ''}${t.status_reason ? html` — ${t.status_reason}` : ''}</td></tr>
    <tr><td>API access</td><td>${t.api_enabled ? 'enabled' : 'disabled'}, key ${t.api_key_hash ? (t.api_key_custom ? 'set (custom value)' : 'set (random)') : 'none'}${t.api_key_hash ? (t.api_key_expires_at ? html` — ${t.api_key_expires_at <= Math.floor(Date.now() / 1000) ? html`<b style="color:var(--red,#c0392b);">expired</b> ` : ''}expires ${fmtIST(t.api_key_expires_at)}` : ' — never expires') : ''}</td></tr>
    ${t.approval === 'pending' || t.acct_status === 'banned' ? '' : html`<tr><td>UPI ID <span class="field-note">(added by the user)</span></td><td class="mono">${t.upi || html`<span class="field-note">not added yet</span>`}</td></tr>`}<tr><td>Joined</td><td>${dayIST(t.created_at)}</td></tr>
    <tr><td>Last login</td><td>${t.last_login_at ? fmtIST(t.last_login_at) : '—'}</td></tr>
  </tbody></table></div>
  ${issuedCard}
  <div class="card"><h2>Actions</h2>
    <p class="field-note" style="margin:0 0 10px;">A reason is recommended and is written to the audit log.</p>
    <form method="post" action="/admin/users" style="margin:0;">${csrfField(await ctx.csrf())}<input type="hidden" name="id" value="${id}">
      <div class="copybox"><input type="text" name="reason" placeholder="Reason (recorded in the audit log)"></div>
      <input type="hidden" name="status" value="">
      <div class="acts" style="margin-top:10px;flex-wrap:wrap;">
        ${can(user.role, 'users.approve') && t.approval !== 'approved' ? html`<button class="btn small teal" type="submit" name="action" value="approve">Approve</button>` : ''}
        ${can(user.role, 'users.approve') && t.approval !== 'rejected' ? html`<button class="btn small danger" type="submit" name="action" value="reject">Reject</button>` : ''}
        ${can(user.role, 'support.resend_verification') && t.role === 'USER' && !t.email_verified ? html`<button class="btn small" type="submit" name="action" value="resend_verification">Resend verification</button>` : ''}
        ${can(user.role, 'users.status') && t.acct_status !== 'active' ? html`<button class="btn small teal" type="submit" name="action" value="unfreeze">Unfreeze / reinstate</button>` : ''}
        ${can(user.role, 'users.status') && t.acct_status !== 'frozen' ? html`<button class="btn small" type="submit" name="action" value="freeze">Freeze</button>` : ''}
        ${can(user.role, 'users.status') && t.acct_status !== 'suspended' ? html`<span class="copybox" style="display:inline-flex;"><input type="number" name="minutes" value="60" style="max-width:80px;" title="Minutes"><button class="btn small" type="submit" name="action" value="suspend">Suspend</button></span>` : ''}
        ${can(user.role, 'users.status') && t.acct_status !== 'banned' ? html`<button class="btn small danger" type="submit" name="action" value="ban" data-confirm="Ban this user? They will be blocked from logging in and using the API.">Ban</button>` : ''}
        ${can(user.role, 'users.force_logout') ? html`<button class="btn small" type="submit" name="action" value="force_logout">Force logout</button>` : ''}
        ${can(user.role, 'users.api') ? (t.api_enabled ? html`<button class="btn small" type="submit" name="action" value="api_disable">Disable API</button>` : html`<button class="btn small teal" type="submit" name="action" value="api_enable">Enable API</button>`) : ''}
        ${can(user.role, 'users.api') ? html`<button class="btn small danger" type="submit" name="action" value="api_revoke">Revoke API key</button><button class="btn small" type="submit" name="action" value="api_reissue">Reissue API key</button>` : ''}
        ${can(user.role, 'users.email_verify') ? (t.email_verified ? html`<button class="btn small" type="submit" name="action" value="email_unverify">Mark email unverified</button>` : html`<button class="btn small" type="submit" name="action" value="email_verify">Mark email verified</button>`) : ''}
        ${can(user.role, 'users.password_reset') ? html`<button class="btn small danger" type="submit" name="action" value="password_reset">Issue reset code</button>` : ''}
        ${can(user.role, 'users.delete') && t.role !== 'SUPER_ADMIN' && t.id !== user.id ? html`<button class="btn small danger" type="submit" name="action" value="delete_user" data-confirm="Permanently delete this account? Their orders, payments, Gmail link and API keys are erased and cannot be recovered. They would have to register again.">Delete account</button>` : ''}
        ${can(user.role, 'roles.manage') && t.role !== 'SUPER_ADMIN' ? html`<select name="role" style="padding:6px;border-radius:8px;"><option value="USER"${t.role === 'USER' ? ' selected' : ''}>User</option><option value="SUPPORT"${t.role === 'SUPPORT' ? ' selected' : ''}>Support</option><option value="ADMIN"${t.role === 'ADMIN' ? ' selected' : ''}>Admin</option></select><button class="btn small" type="submit" name="action" value="role">Set role</button>` : ''}
      </div></form></div>
  ${can(user.role, 'users.api') && t.api_key_hash ? html`<div class="card"><h2>Renew API key</h2>
    <p class="field-note" style="margin:0 0 10px;">${t.api_key_expires_at == null ? 'This key never expires.' : t.api_key_expires_at <= Math.floor(Date.now() / 1000) ? html`This key <b>expired</b> on ${fmtIST(t.api_key_expires_at)}.` : html`This key expires on <b>${fmtIST(t.api_key_expires_at)}</b>.`} Renewing keeps the <b>same key value</b> (nothing to change in the user's integration), also revives an expired key, and e-mails the user. The user gets a daily e-mail reminder from 3 days before expiry.</p>
    <form method="post" action="/admin/users">${csrfField(await ctx.csrf())}<input type="hidden" name="id" value="${id}"><input type="hidden" name="action" value="api_renew">
      <label for="renewDays">Extend by (days)</label><input type="number" id="renewDays" name="renew_days" value="30" min="1" max="3650" style="max-width:140px;">
      <label style="display:flex;gap:8px;align-items:center;margin-top:8px;"><input type="checkbox" name="renew_never" value="1"> Never expires</label>
      <div class="copybox" style="margin-top:12px;"><input type="text" name="reason" placeholder="Reason (recorded in the audit log)"></div>
      <div class="actions"><button class="btn primary" type="submit">Renew key</button></div>
    </form>
  </div>` : ''}
  ${can(user.role, 'users.api') ? html`<div class="card"><h2>Create / replace API key</h2>
    <p class="field-note" style="margin:0 0 10px;">Replaces the user's current key (shown on their Settings page). The key is shown once — save it now.</p>
    <form method="post" action="/admin/users">${csrfField(await ctx.csrf())}<input type="hidden" name="id" value="${id}"><input type="hidden" name="action" value="api_create">
      <label style="display:flex;gap:8px;align-items:center;"><input type="radio" name="key_mode" value="random" checked> Random 7-digit key</label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:6px;"><input type="radio" name="key_mode" value="custom"> Custom key value</label>
      <input type="text" id="customKeyInput" name="custom_key" placeholder="4-40 letters, numbers, _ or -" style="margin-top:6px;" data-selects="key_mode:custom">
      <label style="display:flex;gap:8px;align-items:center;margin-top:14px;"><input type="radio" name="expiry_mode" value="infinite" checked> Infinite (never expires)</label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:6px;"><input type="radio" name="expiry_mode" value="duration"> Custom duration</label>
      <div class="copybox" style="margin-top:6px;"><input type="number" id="durationValue" name="duration_value" value="30" min="1" style="max-width:100px;" data-selects="expiry_mode:duration">
        <select id="durationUnit" name="duration_unit" data-selects="expiry_mode:duration" style="padding:10px;border-radius:10px;border:1px solid var(--line);"><option value="minutes">minutes</option><option value="hours">hours</option><option value="days" selected>days</option></select></div>
      <div class="copybox" style="margin-top:14px;"><input type="text" name="reason" placeholder="Reason (recorded in the audit log)"></div>
      <div class="actions"><button class="btn primary" type="submit">Create / replace key</button></div>
    </form>
  </div>` : ''}
  <div class="card" id="payment-history"><h2>Payment history</h2><p class="field-note" style="margin:0 0 8px;">Successful payments, newest first (from alert emails, webhooks and manual confirmations).</p>${!records.length ? html`<p class="field-note">No successful payments yet.</p>` : html`<div class="table-scroll"><table class="orders"><thead><tr><th>Time</th><th>Amount</th><th>From</th><th>UTR</th><th>Transaction ID</th><th>Status</th><th>Order</th></tr></thead><tbody>${records.map((x) => html`<tr><td>${fmtIST(x.at)}</td><td>₹${money(x.amount)}</td><td>${x.received_from || '—'}</td><td class="mono">${x.utr || '—'}</td><td class="mono">${x.transaction_id || '—'}</td><td>${x.result === 'success' || x.result === 'PAID' ? 'Payment Received ✅' : 'Received ✅'}</td><td class="mono">${x.order_id || '—'}</td></tr>`)}</tbody></table></div>`}</div>
  <div class="card"><h2>Orders</h2>${!orders.length ? html`<p class="field-note">None.</p>` : html`<div class="table-scroll"><table class="orders"><thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead><tbody>${orders.map((o) => html`<tr><td class="mono">${o.id}</td><td>₹${money(o.pay_amount)}</td><td><span class="pill ${pillClassOrder(o.status)}">${o.status === 'PAID' ? 'Success' : o.status}</span></td><td>${fmtIST(o.created_at)}</td></tr>`)}</tbody></table></div>`}</div>
  ${can(user.role, 'apiactivity.view') ? activityCard('API activity', api, ['Endpoint', 'Status', 'IP', 'When'], (a) => html`<tr><td class="mono">${a.endpoint}</td><td>${a.status_code}</td><td class="mono">${a.ip}</td><td>${fmtIST(a.created_at)}</td></tr>`) : ''}
  ${can(user.role, 'security.view') ? activityCard('Security activity', sec, ['Event', 'IP', 'When'], (s) => html`<tr><td>${s.type}</td><td class="mono">${s.ip}</td><td>${fmtIST(s.created_at)}</td></tr>`) : ''}
  ${can(user.role, 'audit.view') ? activityCard('Admin actions on this account', audit, ['Action', 'Reason', 'When'], (a) => html`<tr><td>${a.action}</td><td>${a.reason || '—'}</td><td>${fmtIST(a.created_at)}</td></tr>`) : ''}`;
  return ctx.page(shell({ title: `Admin · ${t.name}`, user, body: html`${body}<script src="/assets/app.js"></script>`, bodyClass: 'dash' }));
}

export async function adminPaymentsPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!guardStaff(ctx, user)) return ctx.redirect('/dashboard');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    if (!ctx.c.paymentsEnabled) return ctx.json({ error: 'Manual payment confirmation is disabled on this testing site.' }, 503);
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    const { manualConfirmPayment } = A;
    const r = await manualConfirmPayment(ctx.env, user, ctx.form.order_id, ctx.form.reason, ctx.ip);
    ctx._flash = r.ok ? ['Payment confirmed.', 'ok'] : [r.reason || r.code || 'Could not confirm.', 'err'];
    return ctx.redirect('/admin/payments');
  }
  const q = (ctx.url.searchParams.get('q') || '').trim(); const status = ctx.url.searchParams.get('status') || '';
  const where = []; const args = [];
  if (q) { where.push('(o.id = ? OR o.payment_id = ? OR o.txn_ref = ? OR o.transaction_id = ? OR o.provider ILIKE ? OR u.name ILIKE ? OR u.email ILIKE ?)'); args.push(q, q, q, q, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('o.status = ?'); args.push(status); }
  if (!q) { where.push(visibleOrdersSql('o')); args.push(now()); }   // the list only shows paid orders, ones needing review and ones whose QR is still valid; a search by ID / UTR still finds any order (support)
  const sql = `SELECT o.*, u.name AS uname FROM orders o JOIN users u ON u.id = o.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT 50`;
  const rows = await all(ctx.env, sql, ...args);
  let timeline = []; let detail = null;
  if (q && rows.length === 1) { detail = rows[0]; timeline = await all(ctx.env, 'SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC', detail.id); }
  const flash = ctx._flashIn;
  const body = html`<p class="eyebrow">Admin panel</p><h1>Payments</h1>${tabs(user, 'payments')}${alert(flash?.[0], flash?.[1])}
  <div class="card"><form method="get" action="/admin/payments" class="toolbar" style="margin-bottom:0;">
    <input type="text" name="q" value="${q}" placeholder="Order ID, payment ID, UTR, transaction ID, provider, merchant" style="max-width:320px;">
    <select name="status"><option value="">Any status</option>${['PENDING', 'PROCESSING', 'PAID', 'MANUAL_REVIEW'].map((s) => html`<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`)}</select>
    <button class="btn small" type="submit">Filter</button></form></div>
  <div class="card"><div class="table-scroll"><table class="orders"><thead><tr><th>Payment ID</th><th>Order ID</th><th>Merchant</th><th>Amount</th><th>Status</th><th>Provider</th><th>UTR / Txn ID</th><th>Verified by</th><th>Created</th></tr></thead><tbody>
    ${rows.map((o) => html`<tr><td class="mono">${o.payment_id}</td><td class="mono">${o.id}</td><td>${o.uname}</td><td>${o.currency} ${money(o.pay_amount)}</td><td><span class="pill ${pillClassOrder(o.status)}">${o.status}</span></td><td>${o.provider || '—'}</td><td class="mono">${o.txn_ref || o.transaction_id || '—'}</td><td>${o.verification_method || '—'}</td><td>${fmtIST(o.created_at)}</td></tr>`)}
  </tbody></table></div></div>
  ${detail ? html`<div class="card"><h2>Timeline for ${detail.id}</h2><div class="table-scroll"><table class="orders"><thead><tr><th>When</th><th>Type</th><th>Source</th><th>Detail</th></tr></thead><tbody>
      ${timeline.map((e) => html`<tr><td>${fmtISTs(e.created_at)}</td><td>${e.type}</td><td>${e.source || '—'}</td><td class="mono">${e.detail || ''}</td></tr>`)}
    </tbody></table></div>
    ${ctx.c.paymentsEnabled && can(user.role, 'payments.manual_confirm') && ['PENDING', 'PROCESSING', 'UNSUCCESSFUL', 'MANUAL_REVIEW'].includes(detail.status) ? html`<form method="post" action="/admin/payments" style="margin-top:14px;">${csrfField(await ctx.csrf())}<input type="hidden" name="order_id" value="${detail.id}">
        <label for="reason">Reason (required) — Owner only, fully audited</label><input type="text" id="reason" name="reason" required>
        <div class="actions"><button class="btn danger" type="submit" data-confirm="Manually mark this payment SUCCESS? This bypasses normal verification and is logged.">Manually confirm payment</button></div></form>` : ''}
    </div>` : ''}`;
  return ctx.page(shell({ title: 'Admin · Payments', user, body, bodyClass: 'dash' }));
}

export async function adminAuditPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!can(user.role, 'audit.view')) return ctx.redirect('/admin');
  const rows = await A.auditLog(ctx.env, { limit: 150 });
  const body = html`<p class="eyebrow">Admin panel</p><h1>Audit log</h1>${tabs(user, 'audit')}
  <div class="card"><div class="table-scroll"><table class="orders"><thead><tr><th>When</th><th>Admin</th><th>Target</th><th>Action</th><th>Reason</th><th>IP</th></tr></thead><tbody>
    ${rows.map((a) => html`<tr><td>${fmtISTs(a.created_at)}</td><td>${a.admin_id ? '#' + a.admin_id : 'system'}</td><td>${a.target_user_id ? html`<a href="/admin/users/${a.target_user_id}" style="color:inherit;">#${a.target_user_id}</a>` : '—'}</td><td>${a.action}</td><td>${a.reason || '—'}</td><td class="mono">${a.ip || '—'}</td></tr>`)}
  </tbody></table></div></div>`;
  return ctx.page(shell({ title: 'Admin · Audit log', user, body, bodyClass: 'dash' }));
}

export async function adminGmailPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!can(user.role, 'gmail.view')) return ctx.redirect('/admin');
  const rows = await all(ctx.env, `SELECT gm.*, u.name AS uname, u.email AS uemail,
    (SELECT pm.reason FROM payment_matches pm WHERE pm.gmail_message_id = gm.gmail_message_id
      AND pm.order_id = gm.order_id ORDER BY pm.id DESC LIMIT 1) AS match_reason
    FROM gmail_payment_messages gm JOIN users u ON u.id = gm.user_id
    ORDER BY gm.id DESC LIMIT 150`);
  const body = html`<p class="eyebrow">Admin panel</p><h1>Gmail payment checks</h1>${tabs(user, 'gmail')}
    <p class="sub">The message body is never stored. This page shows the structured result of each processed alert so an admin can explain ignored or manual-review payments.</p>
    <div class="card"><div class="table-scroll"><table class="orders"><thead><tr><th>When</th><th>Merchant</th><th>Sender</th><th>Amount</th><th>Reference</th><th>Result</th><th>Order</th><th>Reason</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td>${fmtIST(r.created_at)}</td>
        <td>${r.uname}<br><span class="field-note">${r.uemail}</span></td><td class="mono">${r.sender || '—'}</td>
        <td>${r.amount == null ? '—' : '₹' + money(r.amount)}</td><td class="mono">${r.utr || r.transaction_id || '—'}</td>
        <td><span class="pill ${r.result === 'success' ? 'credited' : r.result === 'manual_review' ? 'pending' : 'expired'}">${r.result}</span></td>
        <td class="mono">${r.order_id || '—'}</td><td>${r.match_reason || '—'}</td></tr>`)}
    </tbody></table></div><p class="field-note">Showing the latest ${rows.length} processed message(s).</p></div>`;
  return ctx.page(shell({ title: 'Admin · Gmail checks', user, body, bodyClass: 'dash' }));
}
