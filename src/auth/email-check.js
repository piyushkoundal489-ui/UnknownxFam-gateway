// Sign-up email checks (no OTP needed): format, real-looking domain, allow/deny lists, Gmail rules, DNS (via DoH).
export function emailCanonical(email) {
  email = String(email).trim().toLowerCase(); const p = email.lastIndexOf('@'); if (p < 0) return email;
  let l = email.slice(0, p), d = email.slice(p + 1);
  if (d === 'googlemail.com') d = 'gmail.com';
  if (d === 'gmail.com') l = l.split('+')[0].replace(/\./g, '');
  return `${l}@${d}`;
}
export const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
  'sharklasers.com', 'grr.la', 'spam4.me', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com', 'tempr.email',
  'yopmail.com', 'yopmail.fr', 'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com',
  'mintemail.com', 'mohmal.com', 'emailondeck.com', 'burnermail.io', 'mailnesia.com', 'spamgourmet.com', 'tempinbox.com', 'moakt.com', 'discard.email', 'jetable.org',
  'mytemp.email', 'tmpmail.org', 'tmpmail.net', 'fakemail.net', 'inboxkitten.com', 'mailcatch.com', 'mailforspam.com', 'getairmail.com', 'trbvm.com', 'cool.fr.nf',
  'emailfake.com', 'fake-mail.net', 'tempail.com', 'tempmailaddress.com', 'mail.tm', 'dropmail.me', 'harakirimail.com', 'byom.de'];
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]+$/;

/** DNS-over-HTTPS. true = can receive mail, false = definitely cannot, null = could not tell (fail open). */
export async function domainHasMail(domain) {
  try {
    for (const type of ['MX', 'A']) {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null; const j = await r.json();
      if (j.Status === 3) return false;                         // NXDOMAIN
      if (Array.isArray(j.Answer) && j.Answer.some((a) => a.type === (type === 'MX' ? 15 : 1))) return true;
    }
    return false;
  } catch { return null; }
}

export async function validateSignupEmail(c, email, hasMail = domainHasMail) {
  email = String(email).trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('..') || email.startsWith('.') || email.split('@')[0].endsWith('.')) return 'Enter a valid email address.';
  const [local, domain] = email.split('@');
  if (!DOMAIN_RE.test(domain)) return 'Enter a valid email address.';
  if (domain !== 'gmail.com') return 'Only Gmail addresses (yourname@gmail.com) can be used on this gateway.';
  if (c.allowedEmailDomains.length && !c.allowedEmailDomains.includes(domain)) return `Please use an email address from: ${c.allowedEmailDomains.join(', ')}.`;
  if ([...DISPOSABLE, ...c.blockedEmailDomains].some((d) => domain === d || domain.endsWith('.' + d))) return 'Temporary or disposable email addresses are not allowed.';
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const base = local.split('+')[0]; const len = base.replace(/\./g, '').length;
    if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(base) || len < 6 || len > 30) return 'That is not a valid Gmail address.';
  }
  if (c.emailDnsCheck && (await hasMail(domain)) === false) return 'That email domain cannot receive mail. Please check the address.';
  return null;
}

/** Only @gmail.com addresses may sign in to the gateway (the owner / super-admin account is exempt, see accounts.js gmailOnlyOk). */
export const isGmailAddress = (email) => String(email || '').trim().toLowerCase().endsWith('@gmail.com');

/** true when two strings differ by exactly one inserted, deleted or changed character (a typical typo). */
export function oneEditApart(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
/** For the admin lists: maps a user id to another account's email that is one typo away from it (e.g. kevinheguor vs kevinheiguor). */
export function findLookalikes(rows, everyone) {
  const out = new Map(); const canon = everyone.map((u) => [u, emailCanonical(u.email)]);
  for (const r of rows) {
    const rc = emailCanonical(r.email); const [rl, rd] = [rc.slice(0, rc.lastIndexOf('@')), rc.slice(rc.lastIndexOf('@') + 1)];
    if (rl.length < 6) continue;
    for (const [u, c] of canon) {
      if (u.id === r.id) continue; const p = c.lastIndexOf('@');
      if (c.slice(p + 1) === rd && oneEditApart(rl, c.slice(0, p))) { out.set(r.id, u.email); break; }
    }
  }
  return out;
}
