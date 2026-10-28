// Public Privacy Policy page (GET /privacy). No login, no database access, no cookies set.
import { html } from '../lib/html.js';
import { shell } from './layout.js';

const UPDATED = 'October 6, 2026';
const SUPPORT_URL = 'https://t.me/UnknownNvrDie';
const SUPPORT_HANDLE = '@UnknownNvrDie';

const LIST = 'margin:8px 0 0;padding-left:20px;line-height:1.65;';
const PARA = 'line-height:1.65;';

export async function privacyPage(ctx) {
  let user = null;
  try { user = await ctx.user(); } catch { user = null; }   // only used to show the right top-bar buttons; the page never requires a login

  const body = html`<p class="eyebrow">Legal</p><h1>Privacy Policy</h1>
  <p class="field-note" style="margin-top:0;">Last updated: ${UPDATED}</p>

  <div class="card"><p style="${PARA}margin:0;">UnknownXfam Gateway is a UPI payment-collection and verification service. This page explains what information the service may collect, how it is used, and the choices you have. It describes how the application works today; it is not a promise of any certification, legal compliance, or guaranteed outcome.</p></div>

  <div class="card"><h2>1. Information we may collect</h2>
    <p class="field-note" style="${PARA}">Depending on how you use the gateway, the following information may be stored:</p>
    <ul style="${LIST}">
      <li><b>Account information</b> — your name, email address, role and approval/account status, and whether your email is verified. Your password is stored only as a salted hash, never in plain text.</li>
      <li><b>Payment and UPI-related information</b> — the UPI ID you register, the orders you create (order ID, amount, status, timestamps), and, once a payment is verified, details such as amount, transaction ID, UTR, the payer name shown on the payment alert, the purpose text, payment time, and the balance reported in that alert.</li>
      <li><b>API credentials</b> — your API key and webhook secret. They are stored hashed for lookup, and an encrypted copy is kept so you can view them again in your dashboard.</li>
      <li><b>Gmail-derived information</b> — only if you connect Gmail (see section 3).</li>
      <li><b>Technical and log information</b> — IP address, browser/device user-agent, login sessions, API request records (endpoint, method, result, IP), security events (such as sign-ins and password resets), administrator audit-log entries, and short-lived rate-limit counters used to prevent abuse.</li>
      <li><b>Cookies and local storage</b> — a session cookie to keep you signed in, a short-lived cookie for one-time notices, security (CSRF) tokens on forms, and a browser setting that remembers your light/dark theme choice.</li>
    </ul>
  </div>

  <div class="card"><h2>2. How we use information</h2>
    <ul style="${LIST}">
      <li>To create and run your account, approve access, and sign you in.</li>
      <li>To create payment orders, verify payments, and report their status to you through the dashboard and API.</li>
      <li>To send emails you trigger, such as email verification links, sign-in codes, and password-reset messages.</li>
      <li>To protect the service: detect abuse, enforce rate limits, investigate disputes, and keep an audit trail of administrative actions.</li>
      <li>To provide support when you contact us.</li>
    </ul>
    <p style="${PARA}">We do not sell your personal information, and we do not use it for advertising.</p>
  </div>

  <div class="card"><h2>3. Gmail access</h2>
    <p style="${PARA}margin-top:0;">Connecting Gmail is optional and is used only for the payment-verification features the gateway provides.</p>
    <ul style="${LIST}">
      <li><b>Read-only.</b> The gateway requests read-only Gmail access. It cannot send, delete, or change your email.</li>
      <li><b>Limited purpose.</b> It searches for payment-notification emails from the sender addresses the gateway is configured to trust (for example, FamApp's no-reply address) in order to confirm payments for your orders. The payment details extracted from those emails (for example amount, transaction ID, UTR, payer name, and balance) are saved with your payment records. The gateway does not keep a copy of your whole mailbox.</li>
      <li><b>Your inbox view.</b> If you open the inbox page in your dashboard, messages are fetched from Google when you open them and shown only to you.</li>
      <li><b>Token storage.</b> The access token Google gives us for refreshing access is stored encrypted on the server.</li>
      <li><b>No selling, no ads.</b> Gmail data is not sold, not shared for advertising, and not used to build advertising profiles.</li>
      <li><b>Disconnect any time.</b> Use <i>Disconnect Gmail</i> in your dashboard; this revokes access at Google and deletes the stored token. You can also remove the gateway from your Google Account's third-party access page.</li>
    </ul>
    <p class="field-note" style="${PARA}">Separately, the site operator may connect one Gmail account that the gateway uses to send system emails (verification links, sign-in codes, password resets). That is the operator's own mailbox, not yours.</p>
  </div>

  <div class="card"><h2>4. Who information is shared with</h2>
    <p style="${PARA}margin-top:0;">We do not sell or rent your information. It may be handled by the services the gateway needs in order to run:</p>
    <ul style="${LIST}">
      <li><b>Hosting and database</b> — the platform that runs the application and its database (currently Render).</li>
      <li><b>Google</b> — for Gmail access you choose to connect and for sending system emails.</li>
      <li><b>Telegram</b> — encrypted database backups are delivered to a private Telegram channel, and Telegram is also used if you contact support there.</li>
      <li><b>Authorities or other parties</b> — only if we are required to by law or need to protect the service and its users from fraud or abuse.</li>
    </ul>
    <p style="${PARA}">Authorized administrators and support staff can see account details and payment records as needed to approve accounts, resolve problems, and investigate abuse. They cannot read your Gmail inbox through the gateway.</p>
  </div>

  <div class="card"><h2>5. Security</h2>
    <p style="${PARA}margin-top:0;">We take reasonable steps to protect your information: passwords and API keys are stored hashed, Gmail tokens and backups are encrypted, connections use HTTPS in production, sessions can be revoked, and administrator actions are logged. No online service can be perfectly secure, so we cannot guarantee absolute security.</p>
    <p style="${PARA}"><b>Please do not submit unnecessary sensitive information.</b> The gateway never needs your UPI PIN, card numbers, bank passwords, one-time passwords from your bank, or government ID numbers. Do not type them into any field or send them to support. Keep your password and API key private, and disconnect Gmail or change your password if you think they were exposed.</p>
  </div>

  <div class="card"><h2>6. Retention and deletion</h2>
    <ul style="${LIST}">
      <li><b>Short-lived data</b> — expired login sessions, one-time email codes (removed after about a day), rate-limit counters, and sign-in handshake records are removed automatically.</li>
      <li><b>Gmail connection</b> — deleted immediately when you click <i>Disconnect Gmail</i>.</li>
      <li><b>Account and payment records</b> — kept while your account exists and as long as reasonably needed for payment disputes, fraud prevention, and administrative audit.</li>
      <li><b>Backups</b> — the database is backed up periodically in encrypted form. Data you ask us to delete may remain in earlier backups until those backups are replaced or removed.</li>
    </ul>
    <p style="${PARA}">The app does not currently have a self-service "delete my account" button. To ask for access to, correction of, or deletion of your data, contact support using the details below from your registered account. We will review the request and delete or anonymize what we reasonably can; some payment, security, and audit records may need to be kept.</p>
  </div>

  <div class="card"><h2>7. Children</h2>
    <p style="${PARA}margin:0;">The gateway is not intended for children, and we do not knowingly collect information from them.</p>
  </div>

  <div class="card"><h2>8. Changes to this policy</h2>
    <p style="${PARA}margin:0;">We may update this page when the application changes. The "Last updated" date at the top shows the latest revision.</p>
  </div>

  <div class="card"><h2>9. Contact and support</h2>
    <p style="${PARA}margin-top:0;">Questions or requests about your data? Reach support on Telegram: <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer"><b>${SUPPORT_HANDLE}</b></a>.</p>
    <p class="field-note" style="${PARA}">See also the <a href="/terms">Terms of Service</a>.</p>
    <div class="actions"><a class="btn primary" href="/">← Back to UnknownXfam Gateway</a></div>
  </div>`;

  return ctx.page(shell({ title: 'Privacy Policy', user, body, robots: 'index, follow' }));
}
