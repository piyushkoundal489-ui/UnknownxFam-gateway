// The admin tab bar, shared by every admin page so a new tab shows up everywhere.
import { html } from '../lib/html.js';
import { can } from '../admin/rbac.js';

export function adminTabs(user, active) {
  const items = [['users', 'Users']];
  if (can(user.role, 'users.approve')) items.push(['approvals', 'Pending approvals']);
  items.push(['payments', 'Payments']);
  if (can(user.role, 'audit.view')) items.push(['audit', 'Audit log']);
  if (can(user.role, 'gmail.view')) items.push(['gmail', 'Gmail checks']);
  if (can(user.role, 'announcements.send')) items.push(['announcements', 'Announcements']);
  if (can(user.role, 'settings.manage')) items.push(['mail', 'Support email'], ['backup', 'Backup']);
  if (can(user.role, 'shared_api.manage')) items.push(['keys', 'Shared keys']);
  const pending = Number(user.pending_approvals) || 0;   // set by ctx.user() for staff
  return html`<div class="acts" style="margin-bottom:16px;">${items.map(([k, l]) => html`<a class="btn small ${active === k ? 'primary' : ''}" href="/admin/${k}">${l}${k === 'approvals' && pending > 0 ? html` <span class="tab-badge" title="${pending} account request(s) waiting for approval">${pending > 99 ? '99+' : pending}</span>` : ''}</a>`)}</div>`;
}
