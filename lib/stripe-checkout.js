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

// Stripe Checkout uses DYNAMIC payment methods by default: when
// payment_method_types is omitted, Stripe shows every method enabled for the
// account in the Dashboard — including the Link wallet and the Apple Pay /
// Google Pay card wallets (subject to domain verification + device support).
// Stripe explicitly recommends NOT hard-coding payment_method_types unless the
// integration requires it, so we leave it unset and manage wallets from the
// Dashboard. All funds settle to the same Stripe account regardless of method.
//
// Optional override: set STRIPE_CHECKOUT_METHODS="card,link" to pin the list.
function getCheckoutPaymentMethodTypes() {
  const configured = String(process.env.STRIPE_CHECKOUT_METHODS || '').trim();
  if (!configured) return null; // -> omit the field -> Stripe dynamic methods
  const types = configured.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return types.length ? types : null;
}

// Thin wrapper kept for a single create path. When methods are pinned and the
// create fails (e.g. an account without Link), retry with card only so
// checkout never breaks; genuine request errors fail both and surface normally.
async function createCheckoutSession(client, params, idempotencyKey) {
  const requested = Array.isArray(params.payment_method_types) ? params.payment_method_types : [];
  if (!requested.includes('link')) {
    return client.checkout.sessions.create(params, { idempotencyKey });
  }
  try {
    return await client.checkout.sessions.create(params, { idempotencyKey });
  } catch (error) {
    const fallback = { ...params, payment_method_types: requested.filter(type => type !== 'link') };
    console.warn('Pinned payment methods failed; retrying with card only.', error && error.message);
    return client.checkout.sessions.create(fallback, { idempotencyKey: `${idempotencyKey}-card` });
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
  const pinnedMethods = getCheckoutPaymentMethodTypes();
  const params = {
    mode: 'payment',
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
  if (pinnedMethods) params.payment_method_types = pinnedMethods;
  return params;
}

module.exports = { buildCheckoutSessionParams, sessionMetadata, createCheckoutSession, getCheckoutPaymentMethodTypes };
