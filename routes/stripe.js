const express = require('express');
const router = express.Router();
const db = require('../db/init');
const stripe = require('stripe');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_QUANTITY_PER_ITEM = 99;
const CURRENCY = 'usd';

function getStripeMode() {
  if (process.env.STRIPE_MODE === 'test' || process.env.STRIPE_MODE === 'live') return process.env.STRIPE_MODE;
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

function hasExpectedStripeKeys(config) {
  const mode = getStripeMode();
  const secretPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_';
  const publishablePrefix = mode === 'live' ? 'pk_live_' : 'pk_test_';
  return Boolean(config.secret_key && config.secret_key.startsWith(secretPrefix) &&
    config.publishable_key && config.publishable_key.startsWith(publishablePrefix));
}

function parseConfig(account) {
  if (!account) return {};
  let config = {};
  if (typeof account.config === 'string') {
    try { config = JSON.parse(account.config || '{}'); } catch { config = {}; }
  } else if (account.config_data && typeof account.config_data === 'object') {
    config = account.config_data;
  }
  if (account.type === 'stripe') {
    config = {
      ...config,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || config.publishable_key || '',
      secret_key: process.env.STRIPE_SECRET_KEY || config.secret_key || '',
      webhook_secret: process.env.STRIPE_WEBHOOK_SECRET || config.webhook_secret || ''
    };
  }
  return config;
}

function getStripeAccounts(includeInactive = false) {
  const accounts = db.findAll('payment_accounts');
  return accounts.filter(account => {
    if (account.type !== 'stripe' || (!includeInactive && account.status !== 'active')) return false;
    const config = parseConfig(account);
    if (!hasExpectedStripeKeys(config)) return false;
    if (getStripeMode() === 'live' && !config.webhook_secret) return false;
    return true;
  }).map(account => ({ ...account, config_data: parseConfig(account) }));
}

function getStripeAccount(accountId, includeInactive = false) {
  const accounts = getStripeAccounts(includeInactive);
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    return accounts.find(account => String(account.id) === String(accountId)) || null;
  }
  return accounts[0] || null;
}

function getSettings() {
  return db.getAllSettings();
}

function moneyToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid amount');
  return Math.round((amount + Number.EPSILON) * 100);
}

function getCartPricing(cart, settings) {
  if (!Array.isArray(cart) || cart.length === 0) throw new Error('Your cart is empty.');
  const items = [];
  let subtotalCents = 0;

  for (const cartItem of cart) {
    const productId = Number(cartItem.productId);
    const quantity = Number(cartItem.quantity);
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
      throw new Error('Your cart contains an invalid item or quantity.');
    }
    const product = db.findOne('products', { id: productId });
    if (!product || product.status !== 'active') throw new Error('An item in your cart is no longer available.');
    if (Number.isFinite(Number(product.stock)) && Number(product.stock) >= 0 && quantity > Number(product.stock)) {
      throw new Error(`Not enough stock for ${product.name}.`);
    }

    const numericPrice = Number(product.price);
    const unitAmount = moneyToCents(numericPrice);
    if (Math.abs(numericPrice - unitAmount / 100) > 1e-8) {
      throw new Error(`The price for ${product.name} must be set to a whole cent amount.`);
    }
    const lineTotal = unitAmount * quantity;
    if (!Number.isSafeInteger(lineTotal)) throw new Error('The cart total is invalid.');
    subtotalCents += lineTotal;
    items.push({ product, quantity, unitAmount, lineTotal });
  }

  const freeShipCents = moneyToCents(parseFloat(settings.free_shipping_threshold || 50));
  const flatRateCents = moneyToCents(parseFloat(settings.flat_shipping_rate || 5.99));
  const shippingCents = subtotalCents >= freeShipCents ? 0 : flatRateCents;
  const taxRate = Number.parseFloat(settings.tax_rate || 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error('The store tax configuration is invalid.');
  const taxCents = Math.round(subtotalCents * taxRate / 100);
  const totalCents = subtotalCents + shippingCents + taxCents;

  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new Error('The payment amount is invalid.');
  return { items, subtotalCents, shippingCents, taxCents, totalCents };
}

function validateCheckoutDetails(body) {
  const details = {};
  for (const key of ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country']) {
    details[key] = String(body[key] || '').trim();
  }
  details.notes = String(body.notes || '').trim().slice(0, 2000);
  const requiredFields = ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'];
  if (requiredFields.some(key => !details[key])) {
    throw new Error('Please complete all required contact and shipping fields.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) throw new Error('Please enter a valid email address.');
  return details;
}

function formatAddress(details) {
  return `${details.address}, ${details.city}, ${details.state} ${details.zip}, ${details.country}`;
}

function createOrder(details, pricing, stripeAccount) {
  const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const customerName = `${details.firstName} ${details.lastName}`.trim();
  const shippingAddress = formatAddress(details);
  const orderResult = db.insert('orders', {
    order_number: orderNumber,
    customer_email: details.email,
    customer_phone: details.phone,
    customer_name: customerName,
    shipping_address: shippingAddress,
    shipping_city: details.city,
    shipping_state: details.state,
    shipping_zip: details.zip,
    shipping_country: details.country,
    shipping_method: 'Standard Shipping',
    shipping_cost: pricing.shippingCents / 100,
    subtotal: pricing.subtotalCents / 100,
    tax: pricing.taxCents / 100,
    total: pricing.totalCents / 100,
    status: 'pending',
    payment_status: 'pending',
    payment_method: 'stripe',
    payment_account_id: stripeAccount.id,
    notes: details.notes,
    transaction_id: ''
  });

  const orderId = orderResult.lastInsertRowid;
  try {
    for (const item of pricing.items) {
      const images = safeParseArray(item.product.images || item.product.image_list);
      db.insert('order_items', {
        order_id: orderId,
        product_id: item.product.id,
        product_name: item.product.name,
        product_image: item.product.primary_image || images[0] || '',
        price: item.unitAmount / 100,
        quantity: item.quantity,
        total: item.lineTotal / 100
      });
    }
    db.insert('shipments', {
      order_id: orderId,
      tracking_number: '',
      carrier: '',
      shipping_method: 'Standard Shipping',
      status: 'pending',
      estimated_delivery: null,
      shipped_at: null,
      delivered_at: null,
      shipping_address: shippingAddress,
      shipping_cost: pricing.shippingCents / 100,
      notes: ''
    });
  } catch (error) {
    removePendingOrder(orderId);
    throw error;
  }
  return { orderId, orderNumber };
}

function removePendingOrder(orderId) {
  db.findAll('order_items', { where: { order_id: orderId } }).forEach(item => db.delete('order_items', item.id));
  db.findAll('shipments', { where: { order_id: orderId } }).forEach(shipment => db.delete('shipments', shipment.id));
  db.delete('orders', orderId);
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
      transaction_id: intent.id
    });
  }
  return true;
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') return 'https://word0001.com';
  return `${req.protocol}://${req.get('host')}`;
}

// Create a server-priced order and PaymentIntent. The secret key never leaves the server.
router.post('/stripe/create-payment-intent', async (req, res) => {
  let orderId = null;
  let stripeRequestStarted = false;
  try {
    const cart = req.session.cart || [];
    const stripeAccount = getStripeAccount(req.body.paymentAccountId);
    if (!stripeAccount) {
      return res.status(400).json({ success: false, error: 'Stripe is not configured for the selected payment method.' });
    }

    const details = validateCheckoutDetails(req.body);
    const settings = getSettings();
    const pricing = getCartPricing(cart, settings);
    const created = createOrder(details, pricing, stripeAccount);
    orderId = created.orderId;

    const stripeClient = stripe(stripeAccount.config_data.secret_key);
    stripeRequestStarted = true;
    const intent = await stripeClient.paymentIntents.create({
      amount: pricing.totalCents,
      currency: CURRENCY,
      automatic_payment_methods: { enabled: true },
      receipt_email: details.email,
      description: `${settings.store_name || 'Store'} order ${created.orderNumber}`,
      metadata: { order_id: String(created.orderId), order_number: created.orderNumber }
    }, { idempotencyKey: `order-${created.orderNumber}` });

    db.update('orders', created.orderId, { transaction_id: intent.id, payment_status: 'pending' });
    return res.json({
      success: true,
      clientSecret: intent.client_secret,
      publishableKey: stripeAccount.config_data.publishable_key,
      paymentIntentId: intent.id,
      orderId: created.orderId,
      orderNumber: created.orderNumber,
      amount: pricing.totalCents,
      currency: CURRENCY
    });
  } catch (error) {
    if (orderId !== null) removePendingOrder(orderId);
    console.error('Stripe PaymentIntent creation failed:', error.message);
    const clientError = /cart|stock|available|required|valid|configured|quantity|cent amount/i.test(error.message)
      ? error.message
      : 'Unable to start your payment right now. Please try again.';
    return res.status(stripeRequestStarted ? 502 : 400).json({ success: false, error: clientError });
  }
});

// Server-side verification after Stripe.js confirms the payment. Webhooks remain authoritative.
router.post('/stripe/confirm-payment', async (req, res) => {
  try {
    const order = db.findOne('orders', { id: Number(req.body.orderId) });
    if (!order || order.payment_method !== 'stripe') {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }
    const stripeAccount = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
    if (!stripeAccount) return res.status(503).json({ success: false, error: 'Stripe account is unavailable.' });
    const intentId = String(req.body.paymentIntentId || '');
    if (!intentId.startsWith('pi_')) return res.status(400).json({ success: false, error: 'Invalid payment reference.' });

    const intent = await stripe(stripeAccount.config_data.secret_key).paymentIntents.retrieve(intentId);
    if (String(order.transaction_id) !== String(intent.id) || !validateIntentForOrder(intent, order)) {
      return res.status(409).json({ success: false, error: 'Payment could not be verified.' });
    }
    markOrderPaid(order, intent);
    req.session.cart = [];
    return res.json({ success: true, orderNumber: order.order_number, paymentStatus: 'paid' });
  } catch (error) {
    console.error('Stripe payment confirmation failed:', error.message);
    return res.status(502).json({ success: false, error: 'Payment confirmation is delayed. Do not pay again; refresh your order status shortly.' });
  }
});

// Payment return page: independently verifies the PaymentIntent before showing paid status.
router.get('/success', async (req, res) => {
  const orderNumber = String(req.query.order || '');
  const intentId = String(req.query.payment_intent || req.query.payment_intent_id || '');
  const order = orderNumber ? db.findOne('orders', { order_number: orderNumber }) : null;
  let isPaid = Boolean(order && order.payment_status === 'paid');

  if (order && intentId && order.payment_method === 'stripe') {
    try {
      const account = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
      if (account) {
        const intent = await stripe(account.config_data.secret_key).paymentIntents.retrieve(intentId);
        if (String(order.transaction_id) === String(intent.id) && markOrderPaid(order, intent)) isPaid = true;
      }
    } catch (error) {
      console.error('Stripe return verification failed:', error.message);
    }
  }

  const orderItems = order ? db.findAll('order_items', { where: { order_id: order.id } }) : [];
  if (isPaid) req.session.cart = [];
  return renderSuccessPage(res, order, orderItems, isPaid);
});

function renderSuccessPage(res, order, orderItems, isPaid) {
  const settings = getSettings();
  const templatePath = path.join(__dirname, '..', 'views', 'payment-success.html');
  if (!fs.existsSync(templatePath)) return res.status(404).send('Payment result page is unavailable.');

  let html = fs.readFileSync(templatePath, 'utf8');
  html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => settings[key] !== undefined ? String(settings[key]) : '');
  html = html.replace(/\{\{data:json:(\w+)\}\}/g, (match, key) => {
    const value = { order, orderItems }[key];
    return JSON.stringify(value === undefined ? null : value).replace(/</g, '\\u003c');
  });
  html = html.replace(/\{\{data\.isPaid\}\}/g, isPaid ? 'true' : 'false');
  return res.status(isPaid || !order ? 200 : 202).send(html);
}

router.get('/cancel', (req, res) => {
  const settings = getSettings();
  const templatePath = path.join(__dirname, '..', 'views', 'payment-cancel.html');
  if (!fs.existsSync(templatePath)) return res.redirect('/cart');
  let html = fs.readFileSync(templatePath, 'utf8');
  html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => settings[key] !== undefined ? String(settings[key]) : '');
  return res.send(html);
});

// Stripe webhook: verify signature against configured account secrets and apply idempotent updates.
router.post('/webhook', async (req, res) => {
  const rawBody = req.rawBody;
  const signature = req.headers['stripe-signature'];
  if (!rawBody || !signature) return res.status(400).send('Invalid webhook request.');

  let event = null;
  let stripeAccount = null;
  for (const account of getStripeAccounts(true)) {
    try {
      event = stripe(account.config_data.secret_key).webhooks.constructEvent(
        rawBody,
        signature,
        account.config_data.webhook_secret || ''
      );
      stripeAccount = account;
      break;
    } catch (_) {
      // With multiple Stripe accounts, the incoming signature may belong to another account.
    }
  }
  if (!event || !stripeAccount) return res.status(400).send('Webhook signature verification failed.');

  if (db.findOne('payment_events', { event_id: event.id })) return res.json({ received: true, duplicate: true });

  try {
    const intent = event.data && event.data.object;
    if (intent && ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled'].includes(event.type)) {
      const orderId = Number(intent.metadata && intent.metadata.order_id);
      const orderNumber = String(intent.metadata && intent.metadata.order_number || '');
      const order = orderId ? db.findOne('orders', { id: orderId }) : null;
      if (order && order.payment_method === 'stripe' && String(order.order_number) === orderNumber &&
          String(order.payment_account_id) === String(stripeAccount.id) && String(order.transaction_id) === String(intent.id)) {
        if (event.type === 'payment_intent.succeeded') {
          if (!markOrderPaid(order, intent)) {
            console.error('Stripe webhook amount/order verification failed for event:', event.id);
            return res.status(400).send('Payment does not match the order.');
          }
        } else if (order.payment_status !== 'paid') {
          db.update('orders', order.id, {
            payment_status: event.type === 'payment_intent.payment_failed' ? 'failed' : 'cancelled'
          });
        }
      }
    }
    db.insert('payment_events', { event_id: event.id, event_type: event.type, provider: 'stripe' });
    return res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing failed:', error.message);
    return res.status(500).send('Webhook processing failed.');
  }
});

function safeParseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = router;
