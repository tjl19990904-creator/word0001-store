// ============================================================================
// Stripe Payment Link builder (the buy.stripe.com hosted page shown in the
// reference videos: editable amount box, adaptive CNY/USD pricing, Apple Pay /
// Link / Amazon Pay buttons, native Apple Pay sheet on iPhone).
//
// The merchant never controls the amount here: it is priced from the
// server-side cart. To keep the visual "editable amount" of the reference page
// without letting a buyer underpay, custom_unit_amount is preset to the order
// total with minimum == maximum == preset. Set
// STRIPE_PAYMENT_LINK_CUSTOM_AMOUNT=false to drop the editable box entirely.
//
// The Payment Link's `metadata` is copied to every resulting Checkout Session,
// and `payment_intent_data.metadata` to the resulting PaymentIntent, so the
// webhook can bind the payment back to the order without knowing the intent id
// at link-creation time.
// ============================================================================
const { CURRENCY } = require('./payment-status');

function sessionMetadata(order, retry) {
  const metadata = {
    order_id: String(order.id),
    order_number: String(order.order_number || ''),
    customer_id: order.customer_id ? String(order.customer_id) : ''
  };
  if (retry) metadata.retry = '1';
  return metadata;
}

function buildPaymentLinkParams({ order, amountCents, baseUrl, successPath, customerEmail, locale, retry }) {
  const metadata = sessionMetadata(order, retry);
  const root = String(baseUrl || '').replace(/\/$/, '');
  const priceData = {
    currency: CURRENCY,
    product_data: { name: `Order ${order.order_number}` },
    unit_amount: amountCents
  };

  // Editable-looking amount box, locked to the server price (no underpayment).
  if (process.env.STRIPE_PAYMENT_LINK_CUSTOM_AMOUNT !== 'false') {
    priceData.custom_unit_amount = {
      enabled: true,
      preset: amountCents,
      minimum: amountCents,
      maximum: amountCents
    };
  }

  return {
    line_items: [{ price_data: priceData, quantity: 1 }],
    // submit_type 'pay' gives the buy.stripe.com hostname (as in the videos).
    submit_type: 'pay',
    after_completion: {
      type: 'redirect',
      redirect: {
        url: `${root}${successPath}?order=${encodeURIComponent(order.order_number)}&session_id={CHECKOUT_SESSION_ID}`
      }
    },
    customer_email: customerEmail || undefined,
    // NOTE: Payment Links API does not accept `locale` (unlike Checkout
    // Sessions); Stripe localizes the hosted page from the buyer's browser.
    metadata,
    // Copied onto the PaymentIntent so payment_intent.succeeded carries the
    // order binding for the webhook.
    payment_intent_data: { metadata: { ...metadata } }
  };
}

module.exports = { buildPaymentLinkParams, sessionMetadata };
