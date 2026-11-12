const express = require('express');
const router = express.Router();
const db = require('../db/init');
const stripe = require('stripe');
const crypto = require('crypto');
const cart = require('../lib/cart');
const auth = require('../lib/auth');
const renderPage = require('../lib/render');
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
// Price whatever cart this request owns: the customer's rows, or the guest's
// session cart. Never trusts product ids or amounts from the browser.
function getRequestCartPricing(req, settings) {
  const customer = auth.getCustomer(req);
  const { items } = customer
    ? cart.buildDetail(customer.id)
    : cart.buildGuestDetail(req.session);
  if (items.length === 0) throw new Error('Your cart is empty.');
  return cart.price(items, settings);
}

// 2-D (no 3-D Secure challenge) is the default. Stripe still falls back to 3DS
// when the card issuer or local regulation (EU/UK SCA) requires it — that step
// cannot be disabled from the API, only from the issuer side.
function threeDSecureRequest() {
  return process.env.STRIPE_2D_ONLY === 'false' ? 'any' : 'automatic';
}

// Marks an error as safe to show to the customer, in whatever language it was
// rendered in (the generic message below is English-only).
function badRequest(message) {
  const error = new Error(message);
  error.isClientError = true;
  return error;
}

// The checkout form collects a recipient name and a shipping address. The
// order is priced from the server-side cart; no phone number is collected.
function validateCheckoutDetails(body, t) {
  const tr = typeof t === 'function' ? t : (key, fallback) => fallback;
  const details = {};
  for (const key of ['name', 'firstName', 'lastName', 'email', 'address', 'city', 'state', 'zip', 'country']) {
    details[key] = String(body[key] || '').trim().slice(0, 200);
  }
  details.notes = String(body.notes || '').trim().slice(0, 2000);

  if (!details.name) throw badRequest(tr('checkout.errNameRequired', 'Please enter a recipient name.'));
  if (!details.address) throw badRequest(tr('checkout.errAddressRequired', 'Please enter a shipping address.'));
  if (details.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
    throw badRequest(tr('checkout.errEmailInvalid', 'Please enter a valid email address.'));
  }
  return details;
}

// Returns '' when no address was collected, so the order record stays empty
// instead of storing a string of bare commas.
function formatAddress(details) {
  const cityLine = [details.city, details.state].filter(Boolean).join(' ');
  const parts = [details.address, [cityLine, details.zip].filter(Boolean).join(' '), details.country]
    .filter(part => part && part.trim());
  return parts.join(', ');
}

function createOrder(details, pricing, stripeAccount, customer) {
  const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const customerName = details.name || `${details.firstName || ''} ${details.lastName || ''}`.trim();
  const shippingAddress = formatAddress(details);
  const orderResult = db.insert('orders', {
    order_number: orderNumber,
    customer_id: customer ? customer.id : null,
    customer_email: details.email || (customer && customer.email) || '',
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

// Create a server-priced order and PaymentIntent. Guests can pay too: the
// customer record is created from the checkout email, without a password.
router.post('/stripe/create-payment-intent', async (req, res) => {
  let orderId = null;
  let stripeRequestStarted = false;
  try {
    const details = validateCheckoutDetails(req.body, req.t);
    const settings = getSettings();
    // Price the server-side cart before touching Stripe, so an empty or
    // tampered request can never reach the payment provider.
    const pricing = getRequestCartPricing(req, settings);

    const stripeAccount = getStripeAccount(req.body.paymentAccountId);
    if (!stripeAccount) {
      return res.status(400).json({ success: false, error: 'Stripe is not configured for the selected payment method.' });
    }

    // Guests who did not give an email are not turned into customer records:
    // the order stands on its own and the browser keeps access via lastOrderId.
    const customer = auth.getCustomer(req) || (details.email
      ? auth.findOrCreateCustomer({
        email: details.email,
        firstName: details.firstName,
        lastName: details.lastName
      })
      : null);

    const created = createOrder(details, pricing, stripeAccount, customer);
    orderId = created.orderId;
    // Lets the paying browser open the result page without being signed in.
    auth.markLastOrder(req, created.orderId);

    const stripeClient = stripe(stripeAccount.config_data.secret_key);
    stripeRequestStarted = true;
    const intent = await stripeClient.paymentIntents.create({
      amount: pricing.totalCents,
      currency: CURRENCY,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: threeDSecureRequest() }
      },
      receipt_email: details.email || undefined,
      description: `${settings.store_name || 'Store'} order ${created.orderNumber}`,
      metadata: {
        order_id: String(created.orderId),
        order_number: created.orderNumber,
        customer_id: customer ? String(customer.id) : ''
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
    const clientMessage = error.isClientError ||
      /cart|stock|available|required|valid|configured|quantity|cent amount/i.test(error.message)
      ? error.message
      : 'Unable to start your payment right now. Please try again.';
    return res.status(stripeRequestStarted ? 502 : 400).json({ success: false, error: clientMessage });
  }
});

// Server-side verification after Stripe.js confirms the payment. Webhooks remain authoritative.
// Ownership is re-checked here: the order must belong to the session customer,
// or to the guest checkout that created it in this browser.
router.post('/stripe/confirm-payment', async (req, res) => {
  try {
    const order = db.findOne('orders', { id: Number(req.body.orderId) });
    if (!order || order.payment_method !== 'stripe' || !auth.ownsOrder(req, order)) {
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
    // Clear whichever cart this browser used: the customer's rows or the session.
    const sessionCustomer = auth.getCustomer(req);
    if (sessionCustomer && String(order.customer_id) === String(sessionCustomer.id)) {
      cart.clear(sessionCustomer.id);
    } else {
      cart.clearGuest(req.session);
    }
    return res.json({ success: true, orderNumber: order.order_number, paymentStatus: 'paid' });
  } catch (error) {
    console.error('Stripe payment confirmation failed:', error.message);
    return res.status(502).json({ success: false, error: 'Payment confirmation is delayed. Do not pay again; refresh your order status shortly.' });
  }
});

// Payment return page: independently verifies the PaymentIntent before showing paid status.
// Visible to the signed-in owner, or to the guest checkout that created it.
router.get('/success', async (req, res) => {
  const orderNumber = String(req.query.order || '');
  const intentId = String(req.query.payment_intent || req.query.payment_intent_id || '');

  const found = orderNumber ? db.findOne('orders', { order_number: orderNumber }) : null;
  const order = found && auth.ownsOrder(req, found) ? found : null;
  if (orderNumber && !order) {
    return res.status(404).send(
      '<h1>' + req.t('account.orderNotFound') + '</h1>' +
      '<p>' + req.t('account.orderNotFoundHint') + '</p>' +
      '<p><a href="' + req.localePrefix + '/account">' + req.t('account.backToAccount') + '</a></p>'
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
  if (isPaid && order) {
    const sessionCustomer = auth.getCustomer(req);
    if (sessionCustomer && String(order.customer_id) === String(sessionCustomer.id)) {
      cart.clear(sessionCustomer.id);
    } else {
      cart.clearGuest(req.session);
    }
  }
  return renderSuccessPage(res, order, orderItems, isPaid);
});

function renderSuccessPage(res, order, orderItems, isPaid) {
  // 202 keeps polling clients honest while the webhook catches up.
  res.status(isPaid || !order ? 200 : 202);
  return renderPage(res, 'payment-success.html', { order, orderItems, isPaid });
}

router.get('/cancel', (req, res) => {
  return renderPage(res, 'payment-cancel.html', {});
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
        // Guest orders have no customer id, so null and '' must compare equal.
        const orderCustomerId = order.customer_id === null || order.customer_id === undefined ? '' : String(order.customer_id);
        const intentCustomerId = String((intent.metadata && intent.metadata.customer_id) || '');
        const bindingOk = order.payment_method === 'stripe' &&
          String(order.order_number) === orderNumber &&
          String(order.payment_account_id) === String(stripeAccount.id) &&
          String(order.transaction_id) === String(intent.id) &&
          orderCustomerId === intentCustomerId;
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
