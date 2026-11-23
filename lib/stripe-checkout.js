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

module.exports = { buildCheckoutSessionParams, sessionMetadata };
