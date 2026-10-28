export { money, ST } from './core.js';
export function pillClassOrder(s) { return { PAID: 'credited', PENDING: 'pending', PROCESSING: 'pending', UNSUCCESSFUL: 'duplicate', EXPIRED: 'expired', CANCELLED: 'expired', MANUAL_REVIEW: 'pending', NOT_FOUND: 'expired' }[s] || 'expired'; }
export function pillClassUser(s) { return { approved: 'credited', pending: 'pending', rejected: 'duplicate', active: 'credited', frozen: 'pending', suspended: 'duplicate', banned: 'expired' }[s] || 'expired'; }
