// Dashboard -> "Payment Amount Graph" card. The numbers come from the ORDER records the gateway itself keeps (orders marked PAID, amount = what was
// actually paid, dated by the time it was paid), the same records behind the "Received" and "Successful" cards — never from counting Gmail
// notification emails, which can repeat or be missed. Days are Indian Standard Time days. The page script (/assets/pay-graph.js) draws the chart.
import { html } from '../lib/html.js';
import { all } from '../lib/db.js';
import { money } from '../payments/core-ui.js';
import { fmtIST } from '../lib/time.js';

const IST_OFFSET = 19800, DAY = 86400;
export const istDayIndex = (sec) => Math.floor((Number(sec) + IST_OFFSET) / DAY);
const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']];
const METRICS = [['rev', '💰 Revenue'], ['cnt', '🧾 Payment Count']];

/** One row per IST day that has at least one paid order: [dayIndex, paise received, number of payments]. */
export async function loadPaySeries(env, userId) {
  const rows = await all(env, `SELECT ((COALESCE(paid_at, payment_time, updated_at) + ${IST_OFFSET}) / ${DAY}) AS d, COALESCE(SUM(pay_amount), 0)::bigint AS amt, COUNT(*)::int AS n
    FROM orders WHERE user_id = ? AND status = 'PAID' GROUP BY 1 ORDER BY 1`, userId);
  return rows.map((r) => [Number(r.d), Number(r.amt), Number(r.n)]);
}

const dropdown = (key, label, options, selected) => html`<div class="pg-dd" data-dd="${key}"><span class="pg-dd-label" id="pgl-${key}">${label}</span>
  <button type="button" class="pg-dd-btn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="pgl-${key}"><span class="pg-dd-val">${options.find((o) => o[0] === selected)[1]}</span><span class="pg-caret" aria-hidden="true"></span></button>
  <ul class="pg-dd-menu" role="listbox" aria-labelledby="pgl-${key}" hidden>${options.map(([v, t]) => html`<li role="option" tabindex="-1" data-value="${v}" aria-selected="${v === selected ? 'true' : 'false'}">${t}</li>`)}</ul></div>`;

/** @param {Array<[number, number, number]>} series  @param {{last_known_balance?: number|null, last_balance_at?: number|null}} user */
export function payGraphCard(series, user, nowSec) {
  const bal = user.last_known_balance != null;
  return html`<div class="card pg" data-pay-graph data-today="${istDayIndex(nowSec)}" data-series="${JSON.stringify(series)}">
    <h2>📈 Payment Amount Graph</h2>
    <p class="field-note" style="margin:0;">Show how much money you received over time.</p>
    <div class="pg-drops">${dropdown('range', 'Period', RANGES, '30')}${dropdown('metric', 'Graph', METRICS, 'rev')}</div>
    <div class="pg-read" aria-live="polite">Tap or slide on the graph to see a day.</div>
    <div class="pg-chart" role="img" aria-label="Line graph of money received per day"></div>
    <div class="pg-sum">
      <div><span>Total received</span><b data-sum="total">—</b></div><div><span>Payments</span><b data-sum="count">—</b></div>
      <div><span>Average payment</span><b data-sum="avg">—</b></div><div><span>Best day</span><b data-sum="best">—</b></div>
    </div>
    <p class="pg-bal">Total balance: <b>${bal ? html`₹${money(user.last_known_balance)}` : '—'}</b> · Last updated: ${bal && user.last_balance_at ? fmtIST(user.last_balance_at) : 'not read yet'}</p>
    <noscript><p class="field-note">Turn on JavaScript to see the graph.</p></noscript>
  </div>`;
}
