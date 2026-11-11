// ============================================================================
// Tokenized retry-payment page.
//
// A failed payment used to force the customer back to the cart, which created a
// second order. This route re-opens the SAME order behind an unguessable token,
// so the amount, items and customer stay bound to the original order.
//
// Security notes:
//   - The token is a 48-char random bearer credential with a 7-day expiry.
//   - Amounts always come from the order row, never from the request body.
//   - The order must not be paid, refunded or cancelled.
// ============================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/init');
const stripe = require('stripe');
const { getStripeAccount } = require('../lib/stripe-config');
const ps = require('../lib/payment-status');

const router = express.Router();

function renderPage(res, templateName, data = {}) {
  const settings = db.getAllSettings();
  const merged = { ...data, settings };
  const templatePath = path.join(__dirname, '..', 'views', templateName);
  if (!fs.existsSync(templatePath)) return res.status(404).send('Template not found: ' + templateName);

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
  res.set('Cache-Control', 'no-store');
  return res.send(html);
}

function renderMissing(res) {
  return res.status(404).send(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment link expired</title>' +
    '<link rel="stylesheet" href="/css/style.css"></head><body>' +
    '<div class="container" style="padding:80px 20px;max-width:640px;">' +
    '<h1 style="font-size:1.6em;margin-bottom:12px;">This payment link is no longer valid</h1>' +
    '<p style="color:#556;">The link may have expired, or the order was already completed. ' +
    'Please sign in to your account to check the order status, or contact us for a new link.</p>' +
    '<p style="margin-top:24px;"><a class="btn btn-primary" href="/account">Go to my account</a></p>' +
    '</div></body></html>'
  );
}

function publicOrder(order) {
  return {
    order_number: order.order_number,
    total: Number(order.total) || 0,
    currency: 'USD',
    created_at: order.created_at,
    payment_status: order.payment_status,
    customer_name: order.customer_name || '',
    shipping_city: order.shipping_city || '',
    shipping_country: order.shipping_country || ''
  };
}

router.get('/:token', async (req, res) => {
  let order = ps.findOrderByToken(req.params.token);
  if (!order) return renderMissing(res);

  // Returning from Stripe: verify the intent server-side before trusting it.
  const intentId = String(req.query.payment_intent || '');
  if (intentId.startsWith('pi_') && order.payment_status !== 'paid') {
    try {
      const account = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
      if (account) {
        const intent = await stripe(account.config_data.secret_key).paymentIntents.retrieve(intentId);
        if (String(order.transaction_id) === String(intent.id)) {
          if (intent.status === 'succeeded') ps.markOrderPaid(order, intent);
          else if (!ps.isPendingIntent(intent)) ps.recordPaymentFailure(order.id, intent, 'return');
        }
      }
    } catch (error) {
      console.error('Retry payment return verification failed:', error.message);
    }
    order = db.findOne('orders', { id: order.id }) || order;
  }

  const items = db.findAll('order_items', { where: { order_id: order.id } });
  const payable = ps.isPayable(order);

  let message = '';
  if (order.payment_status === 'paid') message = 'Payment received. Thank you — your order is confirmed.';
  else if (order.status === 'cancelled') message = 'This order has been cancelled. Please contact us if you still want these items.';
  else if (order.payment_status === 'refunded') message = 'This order was refunded.';

  return renderPage(res, 'pay.html', {
    pageTitle: 'Pay for order ' + order.order_number,
    token: order.payment_token,
    order: publicOrder(order),
    orderItems: items.map(item => ({
      product_name: item.product_name,
      quantity: item.quantity,
      price: Number(item.price) || 0,
      total: Number(item.total) || 0
    })),
    payable,
    message,
    failureMessage: order.payment_failure_message || '',
    declineCode: order.payment_failure_decline_code || order.payment_failure_code || ''
  });
});

router.post('/:token/intent', async (req, res) => {
  try {
    const order = ps.findOrderByToken(req.params.token);
    if (!order) return res.status(404).json({ success: false, error: 'This payment link is no longer valid.' });
    if (!ps.isPayable(order)) {
      return res.status(409).json({ success: false, error: 'This order can no longer be paid online.' });
    }

    const account = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
    if (!account) return res.status(503).json({ success: false, error: 'Card payments are temporarily unavailable.' });

    const amount = ps.moneyToCents(order.total);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'The order amount is invalid.' });
    }

    const intent = await stripe(account.config_data.secret_key).paymentIntents.create({
      amount,
      currency: ps.CURRENCY,
      automatic_payment_methods: { enabled: true },
      receipt_email: order.customer_email || undefined,
      description: `Order ${order.order_number} (retry)`,
      metadata: {
        order_id: String(order.id),
        order_number: order.order_number,
        customer_id: String(order.customer_id || ''),
        retry: '1'
      }
    }, { idempotencyKey: `retry-${order.order_number}-${crypto.randomBytes(8).toString('hex')}` });

    db.update('orders', order.id, {
      transaction_id: intent.id,
      payment_status: 'pending',
      payment_last_attempt_at: new Date().toISOString()
    });

    return res.json({
      success: true,
      clientSecret: intent.client_secret,
      publishableKey: account.config_data.publishable_key,
      paymentIntentId: intent.id,
      orderNumber: order.order_number,
      amount
    });
  } catch (error) {
    console.error('Retry PaymentIntent creation failed:', error.message);
    return res.status(502).json({ success: false, error: 'Unable to start the payment. Please try again.' });
  }
});

router.post('/:token/confirm', async (req, res) => {
  try {
    const order = ps.findOrderByToken(req.params.token);
    if (!order) return res.status(404).json({ success: false, error: 'This payment link is no longer valid.' });

    const intentId = String(req.body.paymentIntentId || '');
    if (!intentId.startsWith('pi_')) return res.status(400).json({ success: false, error: 'Invalid payment reference.' });
    if (String(order.transaction_id) !== intentId) {
      return res.status(409).json({ success: false, error: 'Payment could not be verified.' });
    }

    const account = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
    if (!account) return res.status(503).json({ success: false, error: 'Card payments are temporarily unavailable.' });

    const intent = await stripe(account.config_data.secret_key).paymentIntents.retrieve(intentId);
    if (ps.isPendingIntent(intent)) {
      return res.status(202).json({
        success: false,
        processing: true,
        error: 'Your bank is still processing this payment. Refresh this page in a moment.'
      });
    }
    if (intent.status !== 'succeeded') {
      const failed = ps.recordPaymentFailure(order.id, intent, 'retry');
      const reason = (intent.last_payment_error && intent.last_payment_error.message) ||
        'Your bank declined the payment. Please try another card.';
      return res.status(402).json({
        success: false,
        error: reason,
        declineCode: (failed && failed.payment_failure_decline_code) || ''
      });
    }
    if (!ps.markOrderPaid(order, intent)) {
      return res.status(409).json({ success: false, error: 'Payment does not match this order.' });
    }
    return res.json({ success: true, orderNumber: order.order_number, paymentStatus: 'paid' });
  } catch (error) {
    console.error('Retry payment confirmation failed:', error.message);
    return res.status(502).json({ success: false, error: 'Payment confirmation is delayed. Refresh this page in a moment.' });
  }
});

module.exports = router;
