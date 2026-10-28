// Admin -> Announcements: write a message, choose one user or everyone, confirm, and it is e-mailed exactly as typed
// (gateway logo + name centred on the first line, then the message). See services/announcements.js for the sending.
import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { can } from '../admin/rbac.js';
import { RULES } from '../lib/ratelimit.js';
import { adminTabs } from './admin-tabs.js';
import { fmtIST } from '../lib/time.js';
import { prepare, startAnnouncement, retryAnnouncement, listAnnouncements, cleanDraft, MAX_MESSAGE, MAX_SUBJECT, DEFAULT_SUBJECT } from '../services/announcements.js';

const draftFields = (d, csrf) => html`${csrfField(csrf)}<input type="hidden" name="subject" value="${d.subject}"><input type="hidden" name="audience" value="${d.audience}"><input type="hidden" name="email" value="${d.email}"><textarea name="message" hidden>
${d.message}</textarea>`;

export async function adminAnnouncementsPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!can(user.role, 'announcements.send')) return ctx.redirect('/admin');
  let draft = cleanDraft({ audience: 'user' }); let error = '';
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    const act = ctx.form.action || '';
    if (act === 'send') {
      const r = await startAnnouncement(ctx.env, user, ctx.form, ctx.ip);
      if (r.ok) { ctx._flash = [r.audience === 'all' ? `Broadcast started 🚀 sending to ${r.total} user${r.total === 1 ? '' : 's'} now. You can leave this page.` : 'Email sent to the user ✅', 'ok']; return ctx.redirect('/admin/announcements'); }
      draft = cleanDraft(ctx.form); error = r.reason;
    } else if (act === 'retry') {
      const r = await retryAnnouncement(ctx.env, user, ctx.form.announcement_id, ctx.ip);
      ctx._flash = r.ok ? [r.note, 'ok'] : [r.reason, 'err']; return ctx.redirect('/admin/announcements');
    } else {                                                          // 'review' (Review & send) or 'edit' (back from the confirmation)
      draft = cleanDraft(ctx.form);
      if (act === 'review') {
        const p = await prepare(ctx.env, user, draft);
        if (!p.ok) error = p.reason;
        else {
          const csrf = await ctx.csrf(); const n = p.recipients.length;
          const who = p.draft.audience === 'all' ? html`<b>all users</b> (${n} approved account${n === 1 ? '' : 's'})` : html`<b>${p.recipients[0].email}</b>${p.recipients[0].name ? html` (${p.recipients[0].name})` : ''}`;
          const body = html`<div class="wrap"><p class="eyebrow">Admin panel · Announcements</p><h1>Confirm email broadcast</h1>${adminTabs(user, 'announcements')}
            <div class="card"><h2>⚠️ Send this email broadcast?</h2>
              <p style="margin:0 0 6px;">You are about to email ${who}. This cannot be undone once sending starts.</p>
              <p class="field-note" style="margin:0 0 14px;">Subject: <b>${p.draft.subject || DEFAULT_SUBJECT}</b></p>
              <div class="ann-preview">${p.draft.message}</div>
              ${n > 1 ? html`<p class="field-note" style="margin:12px 0 0;">Emails go out one by one (about ${Math.max(1, Math.ceil(n * 0.7 / 60))} minute${Math.ceil(n * 0.7 / 60) === 1 ? '' : 's'} for ${n} users). A normal Gmail account can send about 500 emails a day.</p>` : ''}
              <div class="acts" style="margin-top:16px;">
                <form method="post" action="/admin/announcements" style="margin:0;">${draftFields(p.draft, csrf)}<input type="hidden" name="action" value="send"><button class="btn primary" type="submit">✅ Yes, send ${p.draft.audience === 'all' ? 'to all users' : 'now'}</button></form>
                <form method="post" action="/admin/announcements" style="margin:0;">${draftFields(p.draft, csrf)}<input type="hidden" name="action" value="edit"><button class="btn" type="submit">✏️ Go back and edit</button></form>
              </div></div></div>`;
          return ctx.page(shell({ title: 'Admin · Confirm broadcast', user, body, bodyClass: 'dash' }));
        }
      }
    }
  }
  const csrf = await ctx.csrf(); const flash = ctx._flashIn; const history = await listAnnouncements(ctx.env);
  const pill = (a) => a.status === 'done' ? html`<span class="pill ok">Sent</span>` : a.status === 'stopped' ? html`<span class="pill bad">Stopped</span>` : html`<span class="pill wait">Sending…</span>`;
  const body = html`<div class="wrap"><p class="eyebrow">Admin panel</p><h1>Announcements</h1>${adminTabs(user, 'announcements')}${flash ? alert(flash[0], flash[1]) : ''}${error ? alert(error, 'err') : ''}
    <div class="card"><h2>Write an announcement</h2>
      <p class="field-note" style="margin:0 0 12px;">Sent exactly as typed (line breaks, emojis and links kept). Each email opens with the gateway logo and name, then your message.</p>
      <form method="post" action="/admin/announcements">${csrfField(csrf)}<input type="hidden" name="action" value="review">
        <label for="annSubject">Subject <span class="hint">(optional)</span></label>
        <input type="text" id="annSubject" name="subject" maxlength="${MAX_SUBJECT}" placeholder="${DEFAULT_SUBJECT}" value="${draft.subject}">
        <label for="annMessage">Message</label>
        <textarea id="annMessage" name="message" class="ann-message" maxlength="${MAX_MESSAGE}" required placeholder="Type your message here…">
${draft.message}</textarea>
        <div class="ann-aud">
          <p style="margin:14px 0 8px;font-weight:600;">Send to</p>
          <input type="radio" id="audUser" name="audience" value="user" ${draft.audience !== 'all' ? 'checked' : ''}><label for="audUser">👤 A particular user</label>
          <input type="radio" id="audAll" name="audience" value="all" ${draft.audience === 'all' ? 'checked' : ''}><label for="audAll">👥 All users</label>
          <div class="ann-email"><label for="annEmail">User's email</label><input type="email" id="annEmail" name="email" placeholder="user@gmail.com" autocomplete="off" autocapitalize="off" value="${draft.email}"></div>
          <p class="field-note ann-allnote" style="margin:8px 0 0;">All users = every approved account that is not banned.</p>
        </div>
        <button class="btn primary" type="submit" style="margin-top:14px;">Review &amp; send</button>
      </form></div>
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;"><h2 style="margin:0;">Recent announcements</h2><a class="btn small" href="/admin/announcements">↻ Refresh</a></div>
      ${history.length ? html`<div class="table-scroll"><table><thead><tr><th>When</th><th>Subject</th><th>To</th><th>Progress</th><th></th></tr></thead><tbody>
        ${history.map((a) => html`<tr><td style="white-space:nowrap;">${fmtIST(a.created_at)}<div class="field-note" style="margin:0;">${a.admin_name || ''}</div></td><td>${a.subject}</td><td>${a.audience === 'all' ? 'All users' : '1 user'}</td>
          <td>${pill(a)}<div class="field-note" style="margin:4px 0 0;">${a.sent}/${a.total} sent${a.failed ? html` · ${a.failed} failed` : ''}${a.note ? html`<br>${a.note}` : ''}</div></td>
          <td>${a.status === 'stopped' ? html`<form method="post" action="/admin/announcements" style="margin:0;">${csrfField(csrf)}<input type="hidden" name="action" value="retry"><input type="hidden" name="announcement_id" value="${a.id}"><button class="btn small" type="submit">Retry</button></form>` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<p class="field-note" style="margin:12px 0 0;">Nothing sent yet.</p>`}</div></div><script src="/assets/app.js"></script>`;
  return ctx.page(shell({ title: 'Admin · Announcements', user, body, bodyClass: 'dash' }));
}
