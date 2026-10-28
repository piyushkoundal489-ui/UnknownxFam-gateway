// Pending approvals -> History: every approval and rejection with the user's email (newest first).
import { html } from '../lib/html.js';
import { shell, alert } from './layout.js';
import { all } from '../lib/db.js';
import { fmtISTdmy } from '../lib/time.js';
import { adminTabs } from './admin-tabs.js';

/** Small "Pending | History" switch shown at the top of the Pending approvals page. */
export const approvalSubTabs = (active) => html`<div class="acts" style="margin:0 0 14px;"><a class="btn small ${active === 'pending' ? 'primary' : ''}" href="/admin/approvals">⏳ Pending</a><a class="btn small ${active === 'history' ? 'primary' : ''}" href="/admin/approvals?view=history">🗂️ History</a></div>`;

export async function approvalHistoryPage(ctx, user) {
  const f = ['approved', 'rejected'].includes(ctx.url.searchParams.get('f')) ? ctx.url.searchParams.get('f') : '';
  const actions = f === 'approved' ? ["'USER_APPROVED'"] : f === 'rejected' ? ["'USER_REJECTED'"] : ["'USER_APPROVED'", "'USER_REJECTED'"];
  const rows = await all(ctx.env, `SELECT a.id, a.action, a.reason, a.created_at, a.metadata, a.target_user_id, u.email AS user_email, u.name AS user_name, ad.name AS admin_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.target_user_id LEFT JOIN users ad ON ad.id = a.admin_id
    WHERE a.action IN (${actions.join(',')}) ORDER BY a.id DESC LIMIT 200`);
  const by = (r) => { let m = {}; try { m = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ } return m.auto ? 'Auto Approve' : (r.admin_name || '—'); };
  const flash = ctx._flashIn;
  const pill = (v, label) => html`<a class="btn small ${f === v ? 'primary' : ''}" href="/admin/approvals?view=history${v ? '&f=' + v : ''}">${label}</a>`;
  const body = html`<p class="eyebrow">Admin panel</p><h1>Pending approvals</h1>${adminTabs(user, 'approvals')}${flash ? alert(flash[0], flash[1]) : ''}
    ${approvalSubTabs('history')}
    <div class="card"><h2 style="margin:0 0 10px;">Approval &amp; rejection history</h2>
      <div class="acts" style="margin:0 0 12px;flex-wrap:wrap;">${pill('', 'All')}${pill('approved', '🟢 Approved')}${pill('rejected', '🔴 Rejected')}</div>
      ${rows.length ? html`<div class="table-scroll"><table class="keys-table"><thead><tr><th>Email</th><th>Status</th><th>By</th><th>Date</th><th>Reason</th></tr></thead><tbody>
        ${rows.map((r) => { const ok = r.action === 'USER_APPROVED'; return html`<tr>
          <td>${r.user_email ? html`<a href="/admin/users/${r.target_user_id}" style="color:inherit;">${r.user_email}</a>` : html`<span class="field-note" style="margin:0;">(deleted user)</span>`}${r.user_name ? html`<div class="keymask">${r.user_name}</div>` : ''}</td>
          <td style="white-space:nowrap;"><span class="kdot ${ok ? 'kdot-on' : 'kdot-off'}"></span>${ok ? 'Approved' : 'Rejected'}</td>
          <td style="white-space:nowrap;">${by(r)}</td><td style="white-space:nowrap;">${fmtISTdmy(r.created_at)}</td><td>${r.reason || '—'}</td></tr>`; })}
      </tbody></table></div><p class="field-note" style="margin:10px 0 0;">Showing the latest ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.</p>` : html`<p class="field-note" style="margin:0;">No approvals or rejections yet.</p>`}
    </div>`;
  return ctx.page(shell({ title: 'Admin · Approval history', user, body: html`<div class="wrap">${body}</div>`, bodyClass: 'dash' }));
}
