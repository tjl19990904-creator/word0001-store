const express = require('express');
const db = require('../db/init');
const cart = require('../lib/cart');
const auth = require('../lib/auth');
const ps = require('../lib/payment-status');
// Shared renderer: i18n placeholders, partial includes, settings overrides.
const renderPage = require('../lib/render');

const router = express.Router();

// ---------------------------------------------------------------------------
// Login throttling (per IP + email) to slow down credential stuffing.
// ---------------------------------------------------------------------------
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function attemptKey(req, email) {
  return `${req.ip || 'unknown'}|${String(email || '').toLowerCase()}`;
}

function isThrottled(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  entry.count += 1;
}

function clearFailures(key) {
  loginAttempts.delete(key);
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Values echoed back into the login/register forms must be escaped.
function authFormView({ next, error, email, firstName, lastName, phone }) {
  return {
    next: escapeHtml(next),
    nextParam: encodeURIComponent(next),
    error: escapeHtml(error || ''),
    errorDisplay: error ? 'block' : 'none',
    email: escapeHtml(email || ''),
    firstName: escapeHtml(firstName || ''),
    lastName: escapeHtml(lastName || ''),
    phone: escapeHtml(phone || '')
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  const customer = auth.getCustomer(req);
  const next = auth.safeNextPath(req.query.next);
  if (customer) return res.redirect(next);

  return renderPage(res, 'account-login.html', {
    pageTitle: 'Sign In',
    ...authFormView({ next })
  });
});

router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const next = auth.safeNextPath(req.body.next);
  const key = attemptKey(req, email);

  const renderError = (message) => renderPage(res, 'account-login.html', {
    pageTitle: 'Sign In',
    ...authFormView({ next, error: message, email })
  });

  if (isThrottled(key)) {
    return renderError(req.t('account.errTooMany'));
  }
  if (!isValidEmail(email) || !password) {
    recordFailure(key);
    return renderError(req.t('account.errMissingCredentials'));
  }

  const customer = db.findOne('customers', { email });
  if (!customer || customer.status === 'disabled' || !auth.verifyPassword(password, customer.password_hash)) {
    recordFailure(key);
    return renderError(req.t('account.errInvalidCredentials'));
  }

  clearFailures(key);

  // Snapshot the anonymous cart before the session id changes, then merge it
  // into the customer's own database cart. A new session id prevents fixation.
  const guestCart = Array.isArray(req.session.cart) ? req.session.cart.slice() : [];
  await auth.regenerateSession(req);
  req.session.customerId = customer.id;
  req.session.cart = [];
  cart.mergeGuest(customer.id, guestCart);

  return res.redirect(next);
});

// ---------------------------------------------------------------------------
// Create account
// ---------------------------------------------------------------------------
router.get('/register', (req, res) => {
  const customer = auth.getCustomer(req);
  const next = auth.safeNextPath(req.query.next);
  if (customer) return res.redirect(next);

  return renderPage(res, 'account-register.html', {
    pageTitle: 'Create Account',
    ...authFormView({ next })
  });
});

router.post('/register', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirmPassword || '');
  const firstName = String(req.body.firstName || '').trim().slice(0, 80);
  const lastName = String(req.body.lastName || '').trim().slice(0, 80);
  const phone = String(req.body.phone || '').trim().slice(0, 40);
  const next = auth.safeNextPath(req.body.next);

  const renderError = (message) => renderPage(res, 'account-register.html', {
    pageTitle: 'Create Account',
    ...authFormView({ next, error: message, email, firstName, lastName, phone })
  });

  if (!isValidEmail(email)) return renderError(req.t('account.errInvalidEmail'));
  if (password.length < 8) return renderError(req.t('account.errPasswordShort'));
  if (password !== confirm) return renderError(req.t('account.errPasswordMismatch'));
  if (db.findOne('customers', { email })) {
    return renderError(req.t('account.errEmailExists'));
  }

  const result = db.insert('customers', {
    email,
    password_hash: auth.hashPassword(password),
    first_name: firstName,
    last_name: lastName,
    phone,
    status: 'active'
  });
  const customerId = result.lastInsertRowid;

  const guestCart = Array.isArray(req.session.cart) ? req.session.cart.slice() : [];
  await auth.regenerateSession(req);
  req.session.customerId = customerId;
  req.session.cart = [];
  cart.mergeGuest(customerId, guestCart);

  return res.redirect(next);
});

// ---------------------------------------------------------------------------
// Sign out — destroys the whole session so no cart or identity survives.
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('word0001.sid');
    res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// Account area: only the signed-in customer's own orders are ever loaded.
// ---------------------------------------------------------------------------
router.get('/', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const orders = db.findAll('orders', { where: { customer_id: customer.id } })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(order => ({
      order_number: order.order_number,
      created_at: order.created_at,
      status: order.status,
      payment_status: order.payment_status,
      total: Number(order.total) || 0
    }));

  return renderPage(res, 'account.html', {
    pageTitle: 'My Account',
    customer: auth.publicCustomer(customer),
    orders,
    cartCount: cart.count(customer.id)
  });
});

router.get('/orders/:orderNumber', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const orderNumber = String(req.params.orderNumber || '');

  const order = db.findOne('orders', { order_number: orderNumber });
  // Ownership check: a mismatched order is reported exactly like a missing one,
  // so the endpoint cannot be used to probe other customers' order numbers.
  if (!order || String(order.customer_id) !== String(customer.id)) {
    return res.status(404).send(
      '<h1>' + req.t('account.orderNotFound') + '</h1>' +
      '<p>' + req.t('account.orderNotFoundHint') + '</p>' +
      '<p><a href="' + req.localePrefix + '/account">' + req.t('account.backToAccount') + '</a></p>'
    );
  }

  const orderItems = db.findAll('order_items', { where: { order_id: order.id } });
  const shipment = db.findOne('shipments', { order_id: order.id });

  // Unpaid orders get a tokenized retry link so the customer can finish payment
  // without rebuilding the cart (which would create a duplicate order).
  let payUrl = '';
  if (ps.isPayable(order)) {
    const { token } = ps.ensurePaymentToken(order, false);
    payUrl = ps.getBaseUrl(req) + '/pay/' + token;
  }

  return renderPage(res, 'account-order.html', {
    pageTitle: req.t('account.orderTitle') + ' ' + order.order_number,
    customer: auth.publicCustomer(customer),
    order,
    orderItems,
    shipment,
    payUrl
  });
});

module.exports = router;
