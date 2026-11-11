const express = require('express');
const router = express.Router();
const db = require('../db/init');
const stripe = require('stripe');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cart = require('../lib/cart');
const auth = require('../lib/auth');
const { getStripeAccounts, getStripeAccount } = require('../lib/stripe-config');
const {
  CURRENCY,
  recordPaymentFailure,
  isPendingIntent,
  validateIntentForOrder,
  markOrderPaid
} = require('../lib/payment-status');

function getSettings() {
  return db.getAllSettings();
}

// Price the signed-in customer's persisted cart. Nothing here is read from the
// request body, so a client cannot substitute products or amounts.
function getCustomerCartPricing(customerId, settings) {
  const { items } = cart.buildDetail(customerId);
  if (items.length === 0) throw new Error('Your cart is empty.');
  return cart.price(items, settings);
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

function createOrder(details, pricing, stripeAccount, customer) {
  const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const customerName = `${details.firstName} ${details.lastName}`.trim();
  const shippingAddress = formatAddress(details);
  const orderResult = db.insert('orders', {
    order_number: orderNumber,
    customer_id: customer.id,
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
    for (const line of pricing.lines) {
      const images = safeParseArray(line.product.images || line.product.image_list);
      db.insert('order_items', {
        order_id: orderId,
        product_id: line.product.id,
        product_name: line.product.name,
        product_image: line.product.primary_image || images[0] || '',
        price: line.unitCents / 100,
        quantity: line.quantity,
        total: line.lineTotalCents / 100
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

// Create a server-priced order and PaymentIntent for the signed-in customer.
// The cart is loaded from the customer's own rows; the secret key never leaves the server.
router.post('/stripe/create-payment-intent', auth.requireCustomerApi, async (req, res) => {
  let orderId = null;
  let stripeRequestStarted = false;
  try {
    const customer = auth.getCustomer(req);
    const details = validateCheckoutDetails(req.body);
    const settings = getSettings();
    // Price the customer's persisted cart before touching Stripe, so an empty
    // or tampered request can never reach the payment provider.
    const pricing = getCustomerCartPricing(customer.id, settings);

    const stripeAccount = getStripeAccount(req.body.paymentAccountId);
    if (!stripeAccount) {
      return res.status(400).json({ success: false, error: 'Stripe is not configured for the selected payment method.' });
    }

    const created = createOrder(details, pricing, stripeAccount, customer);
    orderId = created.orderId;

    const stripeClient = stripe(stripeAccount.config_data.secret_key);
    stripeRequestStarted = true;
    const intent = await stripeClient.paymentIntents.create({
      amount: pricing.totalCents,
      currency: CURRENCY,
      automatic_payment_methods: { enabled: true },
      receipt_email: details.email,
      description: `${settings.store_name || 'Store'} order ${created.orderNumber}`,
      metadata: {
        order_id: String(created.orderId),
        order_number: created.orderNumber,
        customer_id: String(customer.id)
      }
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
// Ownership is re-checked here: the order must belong to the session customer.
router.post('/stripe/confirm-payment', auth.requireCustomerApi, async (req, res) => {
  try {
    const customer = auth.getCustomer(req);
    const order = db.findOne('orders', { id: Number(req.body.orderId) });
    if (!order || order.payment_method !== 'stripe' ||
        String(order.customer_id) !== String(customer.id)) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }
    const stripeAccount = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
    if (!stripeAccount) return res.status(503).json({ success: false, error: 'Stripe account is unavailable.' });
    const intentId = String(req.body.paymentIntentId || '');
    if (!intentId.startsWith('pi_')) return res.status(400).json({ success: false, error: 'Invalid payment reference.' });

    const intent = await stripe(stripeAccount.config_data.secret_key).paymentIntents.retrieve(intentId);
    if (String(order.transaction_id) !== String(intent.id)) {
      return res.status(409).json({ success: false, error: 'Payment could not be verified.' });
    }
    if (!validateIntentForOrder(intent, order)) {
      // Intermediate states (bank debit, 3DS) are not failures.
      if (isPendingIntent(intent)) {
        return res.status(202).json({
          success: false,
          processing: true,
          error: 'Your payment is still being processed. Refresh your order status in a moment.'
        });
      }
      // The intent exists but is not a successful payment for this order: keep the
      // decline reason so the customer and the admin console can see what happened.
      if (intent.status !== 'succeeded') {
        const failed = recordPaymentFailure(order.id, intent, 'confirm');
        const reason = (intent.last_payment_error && intent.last_payment_error.message) ||
          'Your bank declined the payment. Please try another card.';
        return res.status(402).json({
          success: false,
          error: reason,
          declineCode: (failed && failed.payment_failure_decline_code) || '',
          orderNumber: order.order_number
        });
      }
      return res.status(409).json({ success: false, error: 'Payment could not be verified.' });
    }
    markOrderPaid(order, intent);
    cart.clear(customer.id);
    return res.json({ success: true, orderNumber: order.order_number, paymentStatus: 'paid' });
  } catch (error) {
    console.error('Stripe payment confirmation failed:', error.message);
    return res.status(502).json({ success: false, error: 'Payment confirmation is delayed. Do not pay again; refresh your order status shortly.' });
  }
});

// Payment return page: independently verifies the PaymentIntent before showing paid status.
// Only the customer who owns the order may view it.
router.get('/success', auth.requireCustomerPage, async (req, res) => {
  const customer = auth.getCustomer(req);
  const orderNumber = String(req.query.order || '');
  const intentId = String(req.query.payment_intent || req.query.payment_intent_id || '');

  const found = orderNumber ? db.findOne('orders', { order_number: orderNumber }) : null;
  const order = found && String(found.customer_id) === String(customer.id) ? found : null;
  if (orderNumber && !order) {
    return res.status(404).send(
      '<h1>Order not found</h1><p>This order does not belong to your account.</p><p><a href="/account">Back to my account</a></p>'
    );
  }

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
  if (isPaid) cart.clear(customer.id);
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
      if (order) {
        // Every binding must hold: same provider, same order number, same payment
        // account, same PaymentIntent, and same owning customer. A mismatch means
        // the event cannot be trusted for this order, so it is rejected outright
        // instead of being silently ignored.
        const bindingOk = order.payment_method === 'stripe' &&
          String(order.order_number) === orderNumber &&
          String(order.payment_account_id) === String(stripeAccount.id) &&
          String(order.transaction_id) === String(intent.id) &&
          String(order.customer_id) === String(intent.metadata && intent.metadata.customer_id);
        if (!bindingOk) {
          console.error('Stripe webhook rejected: order binding mismatch for event', event.id);
          return res.status(400).send('Payment does not match the order.');
        }

        if (event.type === 'payment_intent.succeeded') {
          if (!markOrderPaid(order, intent)) {
            console.error('Stripe webhook amount/order verification failed for event:', event.id);
            return res.status(400).send('Payment does not match the order.');
          }
        } else if (order.payment_status !== 'paid') {
          if (event.type === 'payment_intent.payment_failed') {
            // Persist the decline reason (code / decline_code / message) so the
            // admin console can explain the failure instead of only showing "failed".
            recordPaymentFailure(order.id, intent, 'webhook');
          } else {
            db.update('orders', order.id, { payment_status: 'cancelled' });
          }
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
