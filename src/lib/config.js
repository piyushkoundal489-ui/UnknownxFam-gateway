// Central place that reads configuration from environment variables (process.env on Render). Nothing else touches `env` for configuration.
export const ORDER_TTL = 900;                       // QR / order lifetime: 15 minutes (spec: expires_in = 900)
export const SESSION_TTL = 14 * 86400;

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const flag = (v, d) => (v === undefined || v === '' ? d : String(v) !== '0' && String(v).toLowerCase() !== 'false');
export const paymentsEnabled = (env) => flag(env.PAYMENTS_ENABLED, true);

export function cfg(env) {
  const replitDomain = String(env.REPLIT_DOMAINS || '').split(',').map((s) => s.trim()).find(Boolean)
    || env.REPLIT_DEV_DOMAIN || '';
  const inferredUrl = env.RENDER_EXTERNAL_URL || (replitDomain ? `https://${replitDomain}` : '');
  const appUrl = String(env.APP_URL || inferredUrl).replace(/\/+$/, '');
  const appEnv = env.APP_ENV || 'production';
  const isProd = appEnv === 'production';
  // A private Replit development preview can reuse a context-derived key until
  // a dedicated ENCRYPTION_KEY is provisioned. Production always fails closed.
  const encryptionKey = env.ENCRYPTION_KEY || (!isProd && env.SESSION_SECRET
    ? `replit-dev-encryption:${env.SESSION_SECRET}`
    : '');
  return {
    isProd,
    appEnv,
    paymentsEnabled: paymentsEnabled(env),
    appUrl,
    origin: appUrl ? new URL(appUrl).origin : '',
    adminEmail: String(env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    pbkdf2: Math.min(Number(env.PBKDF2_ITERATIONS) || 100000, 100000),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    encryptionKey,
    sessionSecret: env.SESSION_SECRET || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    gmailAllowedSenders: list(env.GMAIL_ALLOWED_SENDERS),
    gmailProviderMap: env.GMAIL_PROVIDER_MAP || '',
    gmailRequireDkim: flag(env.GMAIL_REQUIRE_DKIM, true),
    gmailRequireReference: flag(env.GMAIL_REQUIRE_REFERENCE, true),
    allowedEmailDomains: list(env.ALLOWED_EMAIL_DOMAINS),
    blockedEmailDomains: list(env.BLOCKED_EMAIL_DOMAINS),
    emailDnsCheck: flag(env.EMAIL_DNS_CHECK, true),
    upiName: env.UPI_NAME || 'UnknownXfam Gateway',
  };
}
/** Fails closed: the app refuses to serve if the signing/encryption secrets are missing. */
export function missingSecrets(env) {
  const c = cfg(env);
  return [
    ...(!c.sessionSecret || String(c.sessionSecret).length < 16 ? ['SESSION_SECRET'] : []),
    ...(!c.encryptionKey || String(c.encryptionKey).length < 16 ? ['ENCRYPTION_KEY'] : []),
  ];
}
export const gmailConfigured = (c) => !!(c.googleClientId && c.googleClientSecret && c.encryptionKey);
