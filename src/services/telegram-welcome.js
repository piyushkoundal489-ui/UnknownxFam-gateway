import { safeEqual } from '../lib/crypto.js';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

export function telegramWelcomeHtml(firstName) {
  const name = escapeHtml(String(firstName || 'there').trim() || 'there');
  return `<blockquote>𝑾𝒆𝒍𝒄𝒐𝒎𝒆 ${name}👾

𝑰 𝒂𝒎 𝑨 𝑫𝒂𝒕𝒂𝒃𝒂𝒔𝒆 𝑩𝒂𝒄𝒌𝒖𝒑 𝑩𝒐𝒕 𝑾𝒐𝒓𝒌𝒊𝒏𝒈 𝑼𝒏𝒅𝒆𝒓 <b>@UnknownNvrDie</b> 𝑭𝒐𝒓 𝑭𝒂𝒎𝒑𝒂𝒚 𝑮𝒂𝒕𝒆𝒘𝒂𝒚 🕊️</blockquote>`;
}

export async function telegramWelcomeRoute(ctx) {
  const botToken = String(ctx.env.TELEGRAM_BOT_TOKEN || '').trim();
  const secret = String(ctx.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!botToken || secret.length < 32) return ctx.json({ ok: false, error: 'telegram_welcome_not_configured' }, 503);

  const providedSecret = ctx.request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!safeEqual(secret, providedSecret)) return ctx.json({ ok: false, error: 'forbidden' }, 403);

  const contentLength = Number(ctx.request.headers.get('content-length') || 0);
  if (contentLength > 65536) return ctx.json({ ok: false, error: 'payload_too_large' }, 413);

  let update;
  try {
    const body = await ctx.request.text();
    if (body.length > 65536) return ctx.json({ ok: false, error: 'payload_too_large' }, 413);
    update = JSON.parse(body);
  } catch {
    return ctx.json({ ok: false, error: 'invalid_update' }, 400);
  }

  const message = update?.message;
  if (!message?.chat?.id || message.from?.is_bot) return ctx.json({ ok: true, ignored: true });

  const payload = {
    chat_id: message.chat.id,
    text: telegramWelcomeHtml(message.from?.first_name),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      console.error('Telegram welcome reply failed:', response.status);
      return ctx.json({ ok: false, error: 'telegram_send_failed' }, 502);
    }
    return ctx.json({ ok: true });
  } catch {
    console.error('Telegram welcome reply failed: network error');
    return ctx.json({ ok: false, error: 'telegram_send_failed' }, 502);
  }
}

/**
 * Registers this app's /telegram/welcome-forward as the bot's Telegram webhook (so /start gets a reply).
 * Runs at startup when TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (32+ chars, letters/digits/_/- only) are set.
 * Set TELEGRAM_AUTO_WEBHOOK=0 to skip it if another service already owns the bot's webhook.
 */
export async function registerTelegramWebhook(env, appUrl) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (String(env.TELEGRAM_AUTO_WEBHOOK || '1') === '0') return { skipped: 'disabled' };
  if (!botToken || secret.length < 32) return { skipped: 'not_configured' };
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) return { skipped: 'secret_has_invalid_characters' };
  const base = String(appUrl || APP_URL).replace(/\/+$/, '');
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${base}/telegram/welcome-forward`, secret_token: secret, allowed_updates: ['message'] }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`setWebhook failed: ${response.status} ${result.description || ''}`.trim());
  return { ok: true, url: `${base}/telegram/welcome-forward` };
}
