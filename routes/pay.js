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

// Shared renderer (i18n + partials). Retry-payment pages must never be cached.
const sharedRender = require('../lib/render');
function renderPage(res, templateName, data = {}) {
  res.set('Cache-Control', 'no-store');
  return sharedRender(res, templateName, data);
}

function renderMissing(req, res) {
  const lang = req.locale === 'zh-CN' ? 'zh-CN' : 'en';
  return res.status(404).send(
    '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>' + req.t('pay.expiredTitle') + '</title>' +
    '<link rel="stylesheet" href="/css/style.css"></head><body>' +
    '<div class="container" style="padding:80px 20px;max-width:640px;">' +
    '<h1 style="font-size:1.6em;margin-bottom:12px;">' + req.t('pay.expiredTitle') + '</h1>' +
    '<p style="color:#556;">' + req.t('pay.expiredBody') + '</p>' +
    '<p style="margin-top:24px;"><a class="btn btn-primary" href="' + req.localePrefix + '/account">' +
    req.t('pay.goToAccount') + '</a></p>' +
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
  if (!order) return renderMissing(req, res);

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
  if (order.payment_status === 'paid') message = req.t('pay.received');
  else if (order.status === 'cancelled') message = req.t('pay.cancelledOrder');
  else if (order.payment_status === 'refunded') message = req.t('pay.refunded');

  return renderPage(res, 'pay.html', {
    pageTitle: req.t('pay.title') + ' · ' + order.order_number,
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
    if (!order) return res.status(404).json({ success: false, error: req.t('pay.errLinkExpired') });
    if (!ps.isPayable(order)) {
      return res.status(409).json({ success: false, error: req.t('pay.errNotPayable') });
    }

    const account = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
    if (!account) return res.status(503).json({ success: false, error: req.t('pay.errUnavailable') });

    const amount = ps.moneyToCents(order.total);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: req.t('pay.errInvalidAmount') });
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
    return res.status(502).json({ success: false, error: req.t('pay.errStart') });
  }
});

router.post('/:token/confirm', async (req, res) => {
  try {
    const order = ps.findOrderByToken(req.params.token);
    if (!order) return res.status(404).json({ success: false, error: req.t('pay.errLinkExpired') });

    const intentId = String(req.body.paymentIntentId || '');
    if (!intentId.startsWith('pi_')) return res.status(400).json({ success: false, error: req.t('pay.errInvalidRef') });
    if (String(order.transaction_id) !== intentId) {
      return res.status(409).json({ success: false, error: req.t('pay.errUnverified') });
    }

    const account = getStripeAccount(order.payment_account_id, true) || getStripeAccount(order.payment_account_id, false);
    if (!account) return res.status(503).json({ success: false, error: req.t('pay.errUnavailable') });

    const intent = await stripe(account.config_data.secret_key).paymentIntents.retrieve(intentId);
    if (ps.isPendingIntent(intent)) {
      return res.status(202).json({
        success: false,
        processing: true,
        error: req.t('pay.errStillProcessing')
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
      return res.status(409).json({ success: false, error: req.t('pay.errMismatch') });
    }
    return res.json({ success: true, orderNumber: order.order_number, paymentStatus: 'paid' });
  } catch (error) {
    console.error('Retry payment confirmation failed:', error.message);
    return res.status(502).json({ success: false, error: req.t('pay.errDelayed') });
  }
});

module.exports = router;
