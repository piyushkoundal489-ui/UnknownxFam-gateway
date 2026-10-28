import { html } from '../lib/html.js';
import { shell, alert, csrfField } from './layout.js';
import { can } from '../admin/rbac.js';
import { adminTabs } from './admin-tabs.js';
import { RULES } from '../lib/ratelimit.js';
import { audit } from '../admin/audit.js';
import { getSetting, setSetting } from '../lib/db.js';
import { backupConfigured, backupConfig, backupStatus, runBackup, latestBackupInfo, fetchLatestBackup, decryptBackup, restoreBackup } from '../services/backup.js';
import { fmtIST } from '../lib/time.js';

const tabs = (user, active = 'backup') => adminTabs(user, active);
const fmt = fmtIST;

export async function adminBackupPage(ctx) {
  const user = await ctx.user(); if (!user) return ctx.redirect('/login');
  if (!can(user.role, 'settings.manage')) return ctx.redirect('/admin');
  if (ctx.method === 'POST') {
    const bad = await ctx.checkCsrf(); if (bad) return bad;
    const lim = await ctx.limit('admin_action', 'u' + user.id, RULES.admin_action); if (lim) return lim;
    if (ctx.form.action === 'load') {
      // Replace ALL data with the latest backup from Telegram. Super admin only, typed confirmation, a safety copy is sent first.
      if (!backupConfigured(ctx.env)) { ctx._flash = ['Telegram backup is not configured.', 'err']; return ctx.redirect('/admin/backup'); }
      if (String(ctx.form.confirm || '').trim() !== 'RESTORE') { ctx._flash = ['Nothing was changed. Type RESTORE (capital letters) in the box to confirm loading a backup.', 'err']; return ctx.redirect('/admin/backup'); }
      const coolL = await ctx.limit('backup_load', 'global', { max: 2, windowSec: 600 }); if (coolL) return coolL;
      let step = 'downloading the latest backup from Telegram';
      try {
        const got = await fetchLatestBackup(ctx.env);
        step = 'decrypting it'; const dump = decryptBackup(got.buf, backupConfig(ctx.env).secret);   // fails here (nothing touched) on a wrong passphrase / damaged file
        step = 'sending a safety copy of the current data to Telegram'; await runBackup(ctx.env, { safety: true });
        step = 'restoring';
        const keepLatest = await getSetting(ctx.env, 'backup_latest', ''); const keepStatus = await getSetting(ctx.env, 'backup_status', '');   // restoring replaces app_settings; keep the pointer to the newest Telegram backup
        const r = await restoreBackup(ctx.env.DB, got.buf, backupConfig(ctx.env).secret, { replace: true });
        if (keepLatest) await setSetting(ctx.env, 'backup_latest', keepLatest).catch(() => {});
        if (keepStatus) await setSetting(ctx.env, 'backup_status', keepStatus).catch(() => {});
        const rows = Object.values(r.counts).reduce((a, b) => a + b, 0);
        await audit(ctx.env, { adminId: user.id, action: 'BACKUP_LOADED', ip: ctx.ip, metadata: { backupCreatedAt: dump.createdAt, rows, tables: Object.keys(r.counts).length, source: got.source } });
        ctx._flash = [`Backup from ${fmt(dump.createdAt)} loaded (${rows} rows). Everyone, including you, has to log in again.`, 'ok'];
        return ctx.redirect('/login');
      } catch (e) {
        await audit(ctx.env, { adminId: user.id, action: 'BACKUP_LOAD_FAILED', ip: ctx.ip, metadata: { step, error: String(e.message).slice(0, 200) } }).catch(() => {});
        ctx._flash = [`Load failed while ${step}: ${e.message}. Your current data was not replaced unless it says restored above.`, 'err'];
        return ctx.redirect('/admin/backup');
      }
    }
    const cool = await ctx.limit('backup_manual', 'global', { max: 3, windowSec: 600 }); if (cool) return cool;
    try {
      const r = await runBackup(ctx.env);
      await audit(ctx.env, { adminId: user.id, action: 'BACKUP_SENT', ip: ctx.ip, metadata: { parts: r.parts, bytes: r.bytes, rows: r.rows } });
      ctx._flash = [`Backup sent to Telegram (${r.parts} file${r.parts > 1 ? 's' : ''}, ${r.rows} rows).`, 'ok'];
    } catch (e) {
      await audit(ctx.env, { adminId: user.id, action: 'BACKUP_FAILED', ip: ctx.ip, metadata: { error: String(e.message).slice(0, 200) } });
      ctx._flash = ['Backup failed: ' + e.message, 'err'];
    }
    return ctx.redirect('/admin/backup');
  }
  const on = backupConfigured(ctx.env); const st = await backupStatus(ctx.env); const latest = await latestBackupInfo(ctx.env); const flash = ctx._flashIn;
  const hours = Math.round(backupConfig(ctx.env).intervalSec / 3600);
  const body = html`<div class="wrap"><h1>Admin</h1>${tabs(user)}${flash ? alert(flash[0], flash[1]) : ''}
    <div class="card"><h2>Telegram backup</h2>
      <p class="field-note">A bot sends an <b>encrypted</b> copy of the whole database to your private Telegram channel every ${hours} hour${hours === 1 ? '' : 's'}. Sessions are not included. Only someone with the backup passphrase (or ENCRYPTION_KEY) can open the files.</p>
      <table class="kv"><tbody>
        <tr><td>Status</td><td>${on ? 'Configured' : 'Not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_BACKUP_CHAT_ID'}</td></tr>
        <tr><td>Last attempt</td><td>${fmt(st.at)}${st.at ? (st.ok ? ' — sent' : ' — FAILED') : ''}</td></tr>
        ${st.ok ? html`<tr><td>Last backup</td><td>${st.rows} rows in ${st.tables} tables, ${(st.bytes / 1024).toFixed(1)} KB, ${st.parts} file${st.parts > 1 ? 's' : ''}</td></tr>` : ''}
        ${st.ok === false ? html`<tr><td>Error</td><td>${st.error}</td></tr>` : ''}
      </tbody></table>
      ${on ? html`<form method="post" action="/admin/backup" style="margin-top:12px;">${csrfField(await ctx.csrf())}<button class="btn primary" type="submit" name="action" value="send">Send Backup now</button></form>` : ''}
    </div>
    ${on ? html`<div class="card"><h2>Load backup from Telegram</h2>
      <p class="field-note">Fetches the <b>latest backup</b> from your Telegram channel and <b>replaces all current data</b> (users, orders, API keys, settings, logs) with it. A safety copy of the current data is sent to Telegram first, and you are logged out afterwards. Use it to recover a lost or empty database.</p>
      <table class="kv"><tbody>
        <tr><td>Latest recorded</td><td>${latest ? html`${fmt(latest.createdAt || latest.at)} — ${latest.rows} rows in ${latest.tables} tables, ${latest.parts.length} file${latest.parts.length > 1 ? 's' : ''}` : 'Nothing recorded in this database yet — Load Backup will look for the pinned backup in the channel.'}</td></tr>
        <tr><td>Pinned in channel</td><td>${st.ok ? (st.pinned ? 'Yes (a fresh empty database can still find it)' : 'No — give the bot the "Pin messages" right so an empty database can find the latest backup') : '—'}</td></tr>
      </tbody></table>
      <form method="post" action="/admin/backup" style="margin-top:12px;" data-confirm="Replace ALL current data with the latest Telegram backup? This cannot be undone (a safety copy is sent to Telegram first).">${csrfField(await ctx.csrf())}
        <label style="display:block;margin:0 0 8px;">Type <b>RESTORE</b> to confirm<input name="confirm" autocomplete="off" autocapitalize="characters" placeholder="RESTORE" style="margin-top:6px;"></label>
        <button class="btn danger" type="submit" name="action" value="load">Load Backup</button></form>
    </div>` : ''}</div>`;
  return ctx.page(shell({ title: 'Admin · Backup', user, body, bodyClass: 'dash' }));
}
