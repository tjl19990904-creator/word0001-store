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

// Values echoed back into the sign-in form must be escaped.
function authFormView({ next, error, email, orderNumber }) {
  return {
    next: escapeHtml(next),
    nextParam: encodeURIComponent(next),
    error: escapeHtml(error || ''),
    errorDisplay: error ? 'block' : 'none',
    email: escapeHtml(email || ''),
    orderNumber: escapeHtml(orderNumber || '')
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Sign in — passwordless. The credential is an email plus the order number of
// one of that email's own orders. Accounts are created at checkout, so every
// buyer already has at least one order.
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  const customer = auth.getCustomer(req);
  const next = auth.safeNextPath(req.query.next);
  if (customer) return res.redirect(next);

  return renderPage(res, 'account-login.html', {
    pageTitle: req.t('account.signIn'),
    ...authFormView({ next })
  });
});

router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const orderNumber = String(req.body.orderNumber || '').trim().toUpperCase();
  const next = auth.safeNextPath(req.body.next);
  const key = attemptKey(req, email);

  const renderError = (message) => renderPage(res, 'account-login.html', {
    pageTitle: req.t('account.signIn'),
    ...authFormView({ next, error: message, email, orderNumber })
  });

  if (isThrottled(key)) {
    return renderError(req.t('account.errTooMany'));
  }
  if (!isValidEmail(email) || !orderNumber) {
    recordFailure(key);
    return renderError(req.t('account.errMissingRecord'));
  }

  const record = auth.findPaymentRecord(email, orderNumber);
  if (!record) {
    // Same message for "unknown email" and "wrong order number" so the form
    // cannot be used to discover which emails have shopped here.
    recordFailure(key);
    return renderError(req.t('account.errNoPaymentRecord'));
  }

  const customer = record.customer || auth.findOrCreateCustomer({ email });
  if (!customer || customer.status === 'disabled') {
    recordFailure(key);
    return renderError(req.t('account.errNoPaymentRecord'));
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
// Registration no longer exists. Old links and bookmarks land on sign-in.
// ---------------------------------------------------------------------------
router.get('/register', (req, res) => {
  const next = auth.safeNextPath(req.query.next);
  return res.redirect('/account/login?next=' + encodeURIComponent(next));
});

router.post('/register', (req, res) => {
  return res.redirect('/account/login');
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
