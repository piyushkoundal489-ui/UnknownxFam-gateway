// Admin -> Shared keys: generate, show again and revoke the shared ("public") API keys. A shared key works for any
// approved, active account with API access (the UPI ID in each URL picks the account); users paste it into
// Settings -> Shared API key, where it is saved (encrypted) in their profile. SUPER_ADMIN only.
import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { can } from '../admin/rbac.js';
import { RULES } from '../lib/ratelimit.js';
import { first } from '../lib/db.js';
import * as A from '../admin/actions.js';
import { adminTabs } from './admin-tabs.js';
import { fmtIST, fmtISTdmy } from '../lib/time.js';

const fmt = fmtIST;

/** Small key icon: green key + check = active, red key + cross = expired. */
const keyIcon = (ok) => html`<svg class="keyicon ${ok ? 'on' : 'off'}" viewBox="0 0 32 32" width="15" height="15" aria-hidden="true"><rect x="1.5" y="1.5" width="29" height="29" rx="8.5" class="kbox"/><path class="kfill" fill-rule="evenodd" d="M19.6 5.2a5.6 5.6 0 1 0 0 11.2 5.6 5.6 0 0 0 0-11.2zM19.6 8.9a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z"/><path class="kline" d="M15.6 15.4L7.4 23.6M11.6 19.4l3 3M8.8 22.2l2.6 2.6"/><circle class="kbadge" cx="23.4" cy="23.4" r="6.4"/>${ok ? html`<path class="kmark" d="M20.4 23.5l2.2 2.2 4-4.2"/>` : html`<path class="kmark" d="M20.8 20.8l5.2 5.2M26 20.8l-5.2 5.2"/>`}</svg>`;
export async function adminKeysPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!can(user.role, 'shared_api.manage')) return ctx.redirect('/admin');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    const act = ctx.form.action || ''; const reason = (ctx.form.reason || '').trim();
    let r;
    if (act === 'shared_key_create') r = await A.createSharedApiKey(ctx.env, user, ctx.form.duration_days, reason, ctx.ip, ctx.form.key_mode === 'custom' ? ctx.form.custom_key : '');
    else if (act === 'shared_key_revoke') r = await A.revokeSharedApiKey(ctx.env, user, ctx.form.shared_key_id, reason, ctx.ip);
    else if (act === 'shared_key_show') r = await A.revealSharedApiKey(ctx.env, user, ctx.form.shared_key_id, ctx.ip);
    else r = { ok: false, reason: 'unknown action' };
    if (r.ok && r.key) {
      const label = act === 'shared_key_show' ? `Shared API key #${Number(ctx.form.shared_key_id)}` : 'New shared API key';
      const note = r.expiresAt ? (r.expiresAt <= Math.floor(Date.now() / 1000) ? ` — expired ${fmt(r.expiresAt)}` : ` — expires ${fmt(r.expiresAt)}`) : '';
      ctx._flash = [`${label}: ${r.key}${note}`, 'keep'];
    } else ctx._flash = r.ok ? [r.note || 'Done.', 'ok'] : [r.reason || 'Action failed.', 'err'];
    return ctx.redirect('/admin/keys');
  }
  const keys = await A.listSharedApiKeys(ctx.env);
  const saved = (await first(ctx.env, 'SELECT COUNT(*)::int AS n FROM users WHERE shared_api_key_enc IS NOT NULL')).n;
  const csrf = await ctx.csrf(); const flash = ctx._flashIn; const t = Math.floor(Date.now() / 1000);
  const body = html`<div class="wrap"><p class="eyebrow">Admin panel</p><h1>Shared keys</h1>${adminTabs(user, 'keys')}${flash ? alert(flash[0], flash[1]) : ''}
    <div class="card"><h2>Generate a shared key</h2>
      <p class="field-note">A shared key (a random 7-digit number or a <b>custom value</b>) lets <b>anyone who holds it</b> create and check payments for any approved account with API access. It does <b>not</b> open admin pages. Users paste it into <b>Settings → Shared API key</b>. Treat it like a master key: set a short expiry and revoke it if it leaks.</p>
      <form method="post" action="/admin/keys" style="margin:12px 0 0;">${csrfField(csrf)}<input type="hidden" name="action" value="shared_key_create">
        <label style="display:flex;gap:8px;align-items:center;"><input type="radio" name="key_mode" value="random" checked> Random 7-digit key</label>
        <label style="display:flex;gap:8px;align-items:center;margin-top:6px;"><input type="radio" name="key_mode" value="custom"> Custom key</label>
        <input type="text" id="sharedCustomKey" name="custom_key" maxlength="49" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="2-49 letters, numbers, _ or -" style="margin-top:6px;" data-selects="key_mode:custom">
        <p class="field-note" style="margin:6px 0 12px;">2–49 characters, case-sensitive, must be unique. Short keys are easy to guess — use 12+ mixed characters.</p>
        <label for="sharedKeyDays">Expires after (days, 1–365)</label><input type="number" id="sharedKeyDays" name="duration_days" value="30" min="1" max="365" required style="max-width:140px;">
        <label for="sharedKeyReason">Audit reason</label><input type="text" id="sharedKeyReason" name="reason" placeholder="Why is a shared key needed?" required>
        <div class="actions"><button class="btn primary" type="submit">Generate shared key</button></div>
      </form>
      <p class="field-note" style="margin-top:12px;">${saved} user${saved === 1 ? ' has' : 's have'} a shared key saved in their profile.</p>
    </div>
    <div class="card"><h2>Shared keys</h2>
      ${keys.length ? html`<div class="table-scroll"><table class="keys-table"><thead><tr><th>Key</th><th>Status</th><th>Created On</th><th>Expiry Date</th><th></th></tr></thead><tbody>
        ${keys.map((k) => { const expired = k.expires_at <= t; return html`<tr>
          <td><b>Key #${k.id}</b>${k.value != null ? html`<div class="keyval">${k.value}</div>` : html`<div class="keymask">not stored</div>`}</td>
          <td style="white-space:nowrap;"><span class="keystatus ${expired ? 'off' : 'on'}">${keyIcon(!expired)}${expired ? 'Expired' : 'Active'}</span></td>
          <td style="white-space:nowrap;">${fmtISTdmy(k.created_at)}</td><td style="white-space:nowrap;">${fmtISTdmy(k.expires_at)}</td>
          <td><div class="keyacts">
            <form method="post" action="/admin/keys" style="margin:0;display:flex;gap:6px;align-items:center;">${csrfField(csrf)}<input type="hidden" name="action" value="shared_key_revoke"><input type="hidden" name="shared_key_id" value="${k.id}">
              <input type="text" name="reason" placeholder="${expired ? 'Reason to remove' : 'Reason to revoke'}" required style="width:150px;margin:0;"><button class="btn small danger" type="submit" data-confirm="${expired ? 'Remove this expired key from the list?' : 'Revoke this shared key? Everyone using it stops working immediately.'}">${expired ? 'Remove' : 'Revoke'}</button></form>
          </div></td></tr>`; })}
      </tbody></table></div>` : html`<p class="field-note" style="margin:0;">No shared keys yet. Generate one above.</p>`}
    </div>
    </div><script src="/assets/app.js"></script>`;
  return ctx.page(shell({ title: 'Admin · Shared keys', user, body, bodyClass: 'dash' }));
}
