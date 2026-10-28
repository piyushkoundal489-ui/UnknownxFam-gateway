// Which orders appear in lists (admin Payments, a user's Orders, the dashboard): paid ones, ones that need a human
// (MANUAL_REVIEW) and ones whose QR is still valid (15 minutes). Once a QR runs out unpaid, the order disappears from the lists:
// no "expired", "cancelled" or "failed" rows. (The API and the database still know about them.)
/** SQL condition; pass now() as the one bound parameter. `alias` is the orders table alias, e.g. 'o'. */
export const visibleOrdersSql = (alias = '') => {
  const a = alias ? alias + '.' : '';
  return `(${a}status IN ('PAID','MANUAL_REVIEW') OR (${a}status IN ('PENDING','PROCESSING') AND ${a}expires_at > ?))`;
};
