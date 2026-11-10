const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const cart = require('../lib/cart');
const auth = require('../lib/auth');

const router = express.Router();

function getSettings() {
  return db.getAllSettings();
}

function renderPage(res, templateName, data = {}) {
  const settings = getSettings();
  const merged = { ...data, settings };
  const templatePath = path.join(__dirname, '..', 'views', templateName);

  if (!fs.existsSync(templatePath)) {
    return res.status(404).send('Template not found: ' + templateName);
  }

  let html = fs.readFileSync(templatePath, 'utf8');
  html = html.replace(/\{\{data:json:(\w+)\}\}/g, (match, key) => {
    const val = merged[key];
    return val !== undefined ? JSON.stringify(val) : 'null';
  });
  html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
    return settings[key] !== undefined ? String(settings[key]) : '';
  });
  html = html.replace(/\{\{data\.(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
    const parts = key.split('.');
    let val = merged;
    for (const part of parts) { val = val ? val[part] : undefined; }
    return val !== undefined && val !== null ? String(val) : '';
  });
  html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return merged[key] !== undefined ? String(merged[key]) : '';
  });
  return res.send(html);
}

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
    return renderError('Too many sign-in attempts. Please wait a few minutes and try again.');
  }
  if (!isValidEmail(email) || !password) {
    recordFailure(key);
    return renderError('Please enter your email address and password.');
  }

  const customer = db.findOne('customers', { email });
  if (!customer || customer.status === 'disabled' || !auth.verifyPassword(password, customer.password_hash)) {
    recordFailure(key);
    return renderError('Invalid email or password.');
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

  if (!isValidEmail(email)) return renderError('Please enter a valid email address.');
  if (password.length < 8) return renderError('Password must be at least 8 characters long.');
  if (password !== confirm) return renderError('The two passwords do not match.');
  if (db.findOne('customers', { email })) {
    return renderError('An account with this email already exists. Please sign in instead.');
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
      '<h1>Order not found</h1><p>This order does not belong to your account.</p><p><a href="/account">Back to my account</a></p>'
    );
  }

  const orderItems = db.findAll('order_items', { where: { order_id: order.id } });
  const shipment = db.findOne('shipments', { order_id: order.id });

  return renderPage(res, 'account-order.html', {
    pageTitle: 'Order ' + order.order_number,
    customer: auth.publicCustomer(customer),
    order,
    orderItems,
    shipment
  });
});

module.exports = router;
