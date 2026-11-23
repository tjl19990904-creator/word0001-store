// ============================================================================
// Shared builder for Stripe Checkout (hosted payment page) sessions.
//
// Checkout renders the wallet buttons (Apple Pay, Link, Amazon Pay) and the card
// form on Stripe's own domain. The merchant never controls the amount here: it
// is computed from the server-side cart/order and passed as a single line item
// whose unit_amount equals the order total. The same metadata is attached to
// both the Session and its underlying PaymentIntent so the existing webhook
// binding checks keep working unchanged.
// ============================================================================
const { CURRENCY } = require('./payment-status');

// Stripe Checkout defaults to `payment_method_types: ['card']` when omitted.
// Apple Pay / Google Pay are card wallets and show automatically with 'card'
// (subject to domain verification + a supported device), but Link is a separate
// payment method and MUST be listed explicitly to appear on the hosted page.
// All funds still settle to the same Stripe account regardless of the method.
function getCheckoutPaymentMethodTypes() {
  return process.env.STRIPE_LINK_ENABLED === 'false' ? ['card'] : ['card', 'link'];
}

// Detect Stripe's "payment method not enabled/supported" error so we can fall
// back to card-only instead of breaking checkout on an account without Link.
function isLinkUnavailableError(error) {
  const message = String((error && (error.message || error.type || error.code)) || '').toLowerCase();
  return /link/.test(message) && /(not (enabled|supported|valid|available)|unsupported|invalid|does not)/.test(message);
}

// Create the session with wallets enabled, retrying without Link when the
// account does not have it enabled. Keeps checkout working in both cases.
async function createCheckoutSession(client, params, idempotencyKey) {
  const requested = Array.isArray(params.payment_method_types) ? params.payment_method_types : [];
  try {
    return await client.checkout.sessions.create(params, { idempotencyKey });
  } catch (error) {
    if (requested.includes('link') && isLinkUnavailableError(error)) {
      const fallback = { ...params, payment_method_types: requested.filter(type => type !== 'link') };
      console.warn('Link payment method unavailable; retrying Checkout with card only.', error.message);
      return client.checkout.sessions.create(fallback, { idempotencyKey: `${idempotencyKey}-card` });
    }
    throw error;
  }
}

function sessionMetadata(order, retry) {
  const metadata = {
    order_id: String(order.id),
    order_number: String(order.order_number || ''),
    customer_id: order.customer_id ? String(order.customer_id) : ''
  };
  if (retry) metadata.retry = '1';
  return metadata;
}

// Build the parameter object for stripe.checkout.sessions.create().
// `baseUrl` comes from payment-status.getBaseUrl(req); successPath/cancelPath
// are site-relative paths. {CHECKOUT_SESSION_ID} is a literal Stripe placeholder.
function buildCheckoutSessionParams({ order, amountCents, baseUrl, successPath, cancelPath, customerEmail, locale, retry }) {
  const metadata = sessionMetadata(order, retry);
  const root = String(baseUrl || '').replace(/\/$/, '');
  return {
    mode: 'payment',
    // card enables the card form plus the Apple Pay / Google Pay wallets;
    // link must be listed explicitly for the Link button to render.
    payment_method_types: getCheckoutPaymentMethodTypes(),
    line_items: [{
      price_data: {
        currency: CURRENCY,
        product_data: { name: `Order ${order.order_number}` },
        unit_amount: amountCents
      },
      quantity: 1
    }],
    success_url: `${root}${successPath}?order=${encodeURIComponent(order.order_number)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${root}${cancelPath}`,
    customer_email: customerEmail || undefined,
    client_reference_id: String(order.id),
    locale: locale || 'auto',
    metadata,
    // Everything the payment_intent.succeeded / .payment_failed webhook needs,
    // carried onto the underlying PaymentIntent that Checkout creates.
    payment_intent_data: { metadata: { ...metadata } }
  };
}

module.exports = { buildCheckoutSessionParams, sessionMetadata, createCheckoutSession, getCheckoutPaymentMethodTypes, isLinkUnavailableError };
