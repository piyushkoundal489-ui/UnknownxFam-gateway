// Public Terms of Service page (GET /terms). No login, no database access, no cookies set.
import { html } from '../lib/html.js';
import { shell } from './layout.js';

const UPDATED = 'October 6, 2026';
const SUPPORT_URL = 'https://t.me/UnknownNvrDie';
const SUPPORT_HANDLE = '@UnknownNvrDie';
const LIST = 'margin:8px 0 0;padding-left:20px;line-height:1.65;';
const PARA = 'line-height:1.65;';

export async function termsPage(ctx) {
  let user = null;
  try { user = await ctx.user(); } catch { user = null; }   // only used to show the right top-bar buttons; the page never requires a login

  const body = html`<p class="eyebrow">Legal</p><h1>Terms of Service</h1>
  <p class="field-note" style="margin-top:0;">Last updated: ${UPDATED}</p>

  <div class="card"><p style="${PARA}margin:0;">These terms apply when you use UnknownXfam Gateway, a UPI payment-collection and verification service. By creating an account or using the dashboard or API, you agree to them. If you do not agree, please do not use the service. Please also read the <a href="/privacy">Privacy Policy</a>.</p></div>

  <div class="card"><h2>1. What the service does</h2>
    <p style="${PARA}margin:0;">The gateway lets you create payment orders for your own UPI ID and automatically checks whether a matching payment arrived, for example by reading payment-alert emails in a Gmail account you connect. Payments go directly from your customer to your UPI ID. The gateway does not hold, transfer, or settle your money, and it is not a bank, a payment processor, or a UPI provider.</p>
  </div>

  <div class="card"><h2>2. Accounts and approval</h2>
    <ul style="${LIST}">
      <li>You must give accurate information and keep your password, API key, and webhook secret private. You are responsible for activity under your account.</li>
      <li>New accounts may need to be approved by an administrator before payment features are available. Approval can be declined or withdrawn.</li>
      <li>Accounts may be frozen, suspended, or banned, and API access may be turned off, if we believe these terms are broken or the service is being misused.</li>
      <li>Each email address and each UPI ID can be linked to only one account.</li>
    </ul>
  </div>

  <div class="card"><h2>3. Payment verification and orders</h2>
    <ul style="${LIST}">
      <li>Orders stay open for a limited time. After that they expire and cannot later be marked as paid.</li>
      <li>Verification depends on third-party emails and services (such as Gmail and the payment app's alerts). Delays, missing emails, format changes, or outages can cause a payment to be verified late, shown for manual review, or not detected.</li>
      <li>A "paid" status reflects what the gateway could verify at the time. You remain responsible for checking your own UPI or bank records before delivering goods or services, and for resolving disputes, refunds, and chargebacks with your customers.</li>
    </ul>
  </div>

  <div class="card"><h2>4. Gmail connection</h2>
    <p style="${PARA}margin:0;">Connecting Gmail is optional and uses read-only access for payment verification only, as described in the Privacy Policy. You can disconnect at any time from your dashboard.</p>
  </div>

  <div class="card"><h2>5. Acceptable use</h2>
    <p style="${PARA}margin-top:0;">You agree not to:</p>
    <ul style="${LIST}">
      <li>use the service for anything illegal, fraudulent, or deceptive, including collecting money for goods or services you do not intend to provide;</li>
      <li>use another person's UPI ID, Gmail account, or identity without permission;</li>
      <li>try to bypass security, probe or attack the service, scrape it, or overload it;</li>
      <li>share or sell your API key, or use it to give unapproved third parties access;</li>
      <li>submit unnecessary sensitive data such as UPI PINs, card numbers, or bank passwords.</li>
    </ul>
  </div>

  <div class="card"><h2>6. API use</h2>
    <p style="${PARA}margin:0;">The API is provided for your own integration. Requests may be rate-limited, and keys may expire or be revoked. Keep your keys secret; anyone holding a key can act through your account within what that key allows.</p>
  </div>

  <div class="card"><h2>7. Availability and changes</h2>
    <p style="${PARA}margin:0;">The service is provided "as is" and "as available". It may be slow, interrupted, changed, or discontinued at any time, including for maintenance. Features, limits, and these terms may change; the "Last updated" date shows the latest version, and continued use after a change means you accept it.</p>
  </div>

  <div class="card"><h2>8. Disclaimer and liability</h2>
    <p style="${PARA}margin:0;">We make no guarantee that the service will be uninterrupted, error-free, or that every payment will be detected correctly. To the extent allowed by applicable law, we are not liable for lost sales, unverified or wrongly verified payments, third-party outages, or other indirect losses arising from your use of the service. Nothing here limits rights you have under law that cannot be waived.</p>
  </div>

  <div class="card"><h2>9. Ending your use</h2>
    <p style="${PARA}margin:0;">You can stop using the service at any time and disconnect Gmail from your dashboard. To ask for your data to be deleted, contact support (see the Privacy Policy for how deletion works). We may suspend or end access if these terms are broken.</p>
  </div>

  <div class="card"><h2>10. Contact</h2>
    <p style="${PARA}margin-top:0;">Questions about these terms? Reach support on Telegram: <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer"><b>${SUPPORT_HANDLE}</b></a>.</p>
    <div class="actions"><a class="btn primary" href="/">← Back to UnknownXfam Gateway</a></div>
  </div>`;

  return ctx.page(shell({ title: 'Terms of Service', user, body, robots: 'index, follow' }));
}
