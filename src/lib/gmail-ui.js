// Small presentation helpers for the Gmail inbox lists (mini inbox + full inbox).
import { html } from './html.js';

const AV_COLORS = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#ff8a65', '#a1887f', '#90a4ae'];

/** "Name <a@b.com>", '"Name" <a@b.com>' or a bare address -> avatar circle (first letter, colour per sender) + name + email. */
export function senderCell(from) {
  const raw = String(from || '').trim();
  if (!raw) return html`<span class="field-note">—</span>`;
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : raw).trim();
  const name = ((m ? m[1] : '') || email.split('@')[0] || '?').trim();
  const initial = (Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '?').toUpperCase();
  let h = 0; for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = AV_COLORS[h % AV_COLORS.length];
  return html`<div class="sender"><span class="sender-av" style="background:${color}" aria-hidden="true">${initial}</span><span class="sender-txt"><span class="sender-name">${name}</span><span class="sender-mail">${email}</span></span></div>`;
}

const cp = (n) => { try { return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : ''; } catch { return ''; } };
/** Gmail snippets arrive HTML-escaped (e.g. "what&#39;s"); decode them to plain text (callers still escape on output). */
export const snippetText = (s, max = 110) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => cp(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, max);
