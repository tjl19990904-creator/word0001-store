// ============================================================================
// Customer authentication and ownership helpers.
//
// Two independent identities can live in one session:
//   req.session.customerId -> storefront customer (never grants admin access)
//   req.session.userId     -> admin operator (unchanged, admin routes only)
// Keeping them separate means a signed-in customer can never inherit admin
// privileges, and an admin session can never read a customer's cart.
// ============================================================================
const bcrypt = require('bcryptjs');
const db = require('../db/init');

const CUSTOMER_SESSION_KEY = 'customerId';

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

function requireCustomerPage(req, res, next) {
  if (getCustomer(req)) return next();
  const target = req.originalUrl || '/cart';
  return res.redirect('/account/login?next=' + encodeURIComponent(target));
}

function requireCustomerApi(req, res, next) {
  if (getCustomer(req)) return next();
  return res.status(401).json({ success: false, error: 'Please sign in to continue.' });
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

function hashPassword(password) {
  return bcrypt.hashSync(String(password), 10);
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(password), hash);
  } catch (_) {
    return false;
  }
}

module.exports = {
  CUSTOMER_SESSION_KEY,
  getCustomer,
  publicCustomer,
  requireCustomerPage,
  requireCustomerApi,
  regenerateSession,
  safeNextPath,
  hashPassword,
  verifyPassword
};
