// ============================================================================
// Customer identity and ownership helpers — passwordless.
//
// A customer is identified by email and is created automatically the first time
// they check out. There is no password anywhere in the flow:
//   - signing in requires an email plus the order number of one of that email's
//     own orders (the "payment record"), which only the buyer receives;
//   - guests can browse and check out without an account at all.
//
// Two independent identities can live in one session:
//   req.session.customerId -> storefront customer (never grants admin access)
//   req.session.userId     -> admin operator (admin routes only)
// ============================================================================
const db = require('../db/init');

const CUSTOMER_SESSION_KEY = 'customerId';
// Set when a guest finishes checkout, so the browser that paid can still open
// the result page without being signed in.
const LAST_ORDER_KEY = 'lastOrderId';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getCustomer(req) {
  const id = req.session && req.session[CUSTOMER_SESSION_KEY];
  if (!id) return null;
  const customer = db.findOne('customers', { id: Number(id) });
  if (!customer || customer.status === 'disabled') return null;
  return customer;
}

// Only non-sensitive fields may ever be sent to a template or JSON response.
function publicCustomer(customer) {
  if (!customer) return null;
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.first_name || '',
    lastName: customer.last_name || '',
    phone: customer.phone || ''
  };
}

function findCustomerByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return db.findOne('customers', { email: normalized }) || null;
}

// Create the account from the checkout form when it does not exist yet.
// Existing profile fields are never overwritten with empty values.
function findOrCreateCustomer({ email, firstName, lastName, phone } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const existing = findCustomerByEmail(normalized);
  if (existing) {
    const patch = {};
    if (!existing.first_name && firstName) patch.first_name = String(firstName).slice(0, 80);
    if (!existing.last_name && lastName) patch.last_name = String(lastName).slice(0, 80);
    if (!existing.phone && phone) patch.phone = String(phone).slice(0, 40);
    if (Object.keys(patch).length > 0) db.update('customers', existing.id, patch);
    return db.findOne('customers', { id: existing.id });
  }

  const result = db.insert('customers', {
    email: normalized,
    first_name: String(firstName || '').slice(0, 80),
    last_name: String(lastName || '').slice(0, 80),
    phone: String(phone || '').slice(0, 40),
    status: 'active'
  });
  return db.findOne('customers', { id: result.lastInsertRowid });
}

// The login credential: an email plus the order number of one of that email's
// orders. The order number is only sent to the buyer (confirmation page and
// receipt), so knowing it is proof of the purchase.
function findPaymentRecord(email, orderNumber) {
  const normalized = normalizeEmail(email);
  const number = String(orderNumber || '').trim().toUpperCase();
  if (!normalized || !number) return null;

  const order = db.findOne('orders', { order_number: number });
  if (!order) return null;

  const customer = order.customer_id ? db.findOne('customers', { id: Number(order.customer_id) }) : null;
  const orderEmail = normalizeEmail(order.customer_email);
  const customerEmail = customer ? normalizeEmail(customer.email) : '';

  if (orderEmail !== normalized && customerEmail !== normalized) return null;
  return { order, customer };
}

function requireCustomerPage(req, res, next) {
  if (getCustomer(req)) return next();
  const target = req.originalUrl || '/cart';
  return res.redirect('/account/login?next=' + encodeURIComponent(target));
}

function requireCustomerApi(req, res, next) {
  if (getCustomer(req)) return next();
  return res.status(401).json({ success: false, error: 'Please sign in to continue.' });
}

// An order belongs to the session either through the signed-in customer or
// through the guest checkout that created it in this browser session.
function ownsOrder(req, order) {
  if (!order) return false;
  const customer = getCustomer(req);
  if (customer && String(order.customer_id) === String(customer.id)) return true;
  const lastOrderId = req.session && req.session[LAST_ORDER_KEY];
  return Boolean(lastOrderId && String(order.id) === String(lastOrderId));
}

function markLastOrder(req, orderId) {
  if (req.session) req.session[LAST_ORDER_KEY] = String(orderId);
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => (error ? reject(error) : resolve()));
  });
}

// Prevent open redirects: only same-site absolute paths are allowed.
function safeNextPath(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/account';
  return raw;
}

module.exports = {
  CUSTOMER_SESSION_KEY,
  LAST_ORDER_KEY,
  normalizeEmail,
  getCustomer,
  publicCustomer,
  findCustomerByEmail,
  findOrCreateCustomer,
  findPaymentRecord,
  requireCustomerPage,
  requireCustomerApi,
  ownsOrder,
  markLastOrder,
  regenerateSession,
  safeNextPath
};
