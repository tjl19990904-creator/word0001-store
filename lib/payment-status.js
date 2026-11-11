// ============================================================================
// Payment lifecycle helpers shared by the storefront, the retry page and the
// admin console.
//
// Stripe failures carry a structured `last_payment_error`. Previously only the
// order status was flipped to "failed", which left the operator with no idea
// why a customer could not pay. These helpers persist the reason on the order
// and mint short-lived tokens so a failed order can be paid again without
// creating a duplicate order.
// ============================================================================
const crypto = require('crypto');
const db = require('../db/init');

const CURRENCY = 'usd';
const PAYMENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function moneyToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid amount');
  return Math.round((amount + Number.EPSILON) * 100);
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') return 'https://word0001.com';
  return `${req.protocol}://${req.get('host')}`;
}

// Only the fields that help an operator understand the decline are kept.
// Full Stripe error objects can contain card fingerprints, so they are dropped.
function extractFailure(intent) {
  const error = intent && intent.last_payment_error;
  if (!error) return null;
  return {
    code: String(error.code || '').slice(0, 80),
    decline_code: String(error.decline_code || '').slice(0, 80),
    message: String(error.message || '').slice(0, 500),
    type: String(error.type || '').slice(0, 80)
  };
}

// Records a failed attempt. Paid orders are never downgraded.
function recordPaymentFailure(orderId, intent, source) {
  const order = db.findOne('orders', { id: Number(orderId) });
  if (!order || order.payment_status === 'paid') return null;

  const failure = extractFailure(intent) || {};
  const attempts = Number(order.payment_attempts || 0) + 1;
  const patch = {
    payment_status: 'failed',
    payment_failure_code: failure.code || '',
    payment_failure_decline_code: failure.decline_code || '',
    payment_failure_message: failure.message || 'The payment was not completed.',
    payment_failure_type: failure.type || '',
    payment_failure_at: new Date().toISOString(),
    payment_failure_source: source || 'stripe',
    payment_attempts: attempts
  };
  db.update('orders', order.id, patch);
  return { ...order, ...patch };
}

function clearPaymentFailure(orderId) {
  db.update('orders', orderId, {
    payment_failure_code: '',
    payment_failure_decline_code: '',
    payment_failure_message: '',
    payment_failure_type: '',
    payment_failure_at: null,
    payment_failure_source: ''
  });
}

function isTokenValid(order) {
  if (!order || !order.payment_token) return false;
  const expires = order.payment_token_expires_at ? new Date(order.payment_token_expires_at).getTime() : 0;
  return Number.isFinite(expires) && expires > Date.now();
}

// Returns a valid token, creating a fresh one when missing, expired or forced.
function ensurePaymentToken(order, force) {
  if (!force && isTokenValid(order)) {
    return { token: order.payment_token, expiresAt: order.payment_token_expires_at };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + PAYMENT_TOKEN_TTL_MS).toISOString();
  db.update('orders', order.id, { payment_token: token, payment_token_expires_at: expiresAt });
  return { token, expiresAt };
}

// Token lookup is constant-time-ish: an unknown token simply yields null.
function findOrderByToken(token) {
  const value = String(token || '');
  if (!/^[a-f0-9]{32,64}$/i.test(value)) return null;
  const order = db.findOne('orders', { payment_token: value });
  if (!order || !isTokenValid(order)) return null;
  return order;
}

function isPayable(order) {
  if (!order) return false;
  if (order.payment_status === 'paid' || order.payment_status === 'refunded') return false;
  if (order.status === 'cancelled') return false;
  return true;
}

// Some payment methods (bank debits, 3DS challenges) sit in an intermediate
// state. Those must never be recorded as failures.
function isPendingIntent(intent) {
  return Boolean(intent && ['processing', 'requires_action', 'requires_confirmation', 'requires_capture'].includes(intent.status));
}

function validateIntentForOrder(intent, order) {
  return Boolean(order && intent && intent.status === 'succeeded' &&
    intent.metadata && String(intent.metadata.order_id) === String(order.id) &&
    String(intent.metadata.order_number) === String(order.order_number) &&
    Number(intent.amount) === moneyToCents(order.total) &&
    String(intent.currency).toLowerCase() === CURRENCY);
}

function markOrderPaid(order, intent) {
  if (!validateIntentForOrder(intent, order)) return false;
  if (order.payment_status !== 'paid') {
    db.update('orders', order.id, {
      payment_status: 'paid',
      status: order.status === 'pending' ? 'processing' : order.status,
      transaction_id: intent.id,
      paid_at: new Date().toISOString(),
      payment_failure_code: '',
      payment_failure_decline_code: '',
      payment_failure_message: '',
      payment_failure_type: '',
      payment_failure_at: null,
      payment_failure_source: ''
    });
  }
  return true;
}

module.exports = {
  CURRENCY,
  PAYMENT_TOKEN_TTL_MS,
  moneyToCents,
  getBaseUrl,
  extractFailure,
  recordPaymentFailure,
  clearPaymentFailure,
  ensurePaymentToken,
  findOrderByToken,
  isTokenValid,
  isPayable,
  isPendingIntent,
  validateIntentForOrder,
  markOrderPaid
};
