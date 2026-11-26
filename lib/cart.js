// ============================================================================
// Cart service — server-authoritative cart storage.
//
// Signed-in customers keep their cart rows in the `cart_items` table, keyed by
// `customer_id`. Every read/write is scoped to that id, so one customer can
// never read or mutate another customer's cart, regardless of IP address.
//
// Anonymous visitors keep a throwaway cart inside their own server-side
// session. That cart is merged into the customer cart when they sign in.
// ============================================================================
const db = require('../db/init');

const MAX_QUANTITY_PER_ITEM = 99;
// Stripe rejects amounts below the minimum charge for the currency. For USD
// that is 50 cents. No business upper limit is imposed; the only ceiling is
// JS safe-integer precision so the amount cannot silently overflow.
const MIN_CUSTOM_AMOUNT_CENTS = 50;
const MAX_CUSTOM_AMOUNT_CENTS = Number.MAX_SAFE_INTEGER;

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid amount');
  return Math.round((amount + Number.EPSILON) * 100);
}

function isCustomAmountProduct(product) {
  return Boolean(product && Number(product.allow_custom_amount) === 1);
}

// Validate a buyer-entered donation amount. Accepts a string with at most two
// decimals; rejects negatives, zero, junk and amounts the payment gateway
// cannot charge. Returns integer cents or { error } for the caller to surface.
function validateCustomAmount(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    return { error: 'Enter a valid amount (up to two decimal places).' };
  }
  const cents = toCents(raw);
  if (!Number.isSafeInteger(cents) || cents < MIN_CUSTOM_AMOUNT_CENTS || cents > MAX_CUSTOM_AMOUNT_CENTS) {
    return { error: 'Enter an amount of at least $0.50.' };
  }
  return { cents };
}

function isProductAvailable(product) {
  if (!product || product.status !== 'active') return false;
  if (product.stock === undefined || product.stock === null) return true;
  return Number(product.stock) > 0;
}

// Clamp a requested quantity to a sane, in-stock range.
function clampQuantity(product, quantity) {
  let qty = Number.parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  let limit = MAX_QUANTITY_PER_ITEM;
  const stock = Number(product && product.stock);
  if (Number.isFinite(stock) && stock > 0) limit = Math.min(limit, stock);
  return Math.max(1, Math.min(qty, limit));
}

// ---------------------------------------------------------------------------
// Signed-in customer cart (database backed)
// ---------------------------------------------------------------------------
function getRows(customerId) {
  if (!customerId) return [];
  return db.findAll('cart_items', { where: { customer_id: Number(customerId) } });
}

/**
 * Resolve the persisted cart for a customer into real products.
 * Drops rows whose product was deleted, unpublished or went out of stock.
 * Never accepts product data from the browser.
 */
function buildDetail(customerId) {
  const rows = getRows(customerId);
  const items = [];
  let removedCount = 0;

  for (const row of rows) {
    const product = db.findOne('products', { id: row.product_id });
    if (!isProductAvailable(product)) {
      db.delete('cart_items', row.id);
      removedCount += 1;
      continue;
    }
    const custom = isCustomAmountProduct(product);
    const storedCents = Number(row.custom_amount_cents);
    // A donation row without a valid server-stored amount cannot be priced —
    // drop it rather than falling back to the placeholder price of 0.
    if (custom && (!Number.isSafeInteger(storedCents) || storedCents < MIN_CUSTOM_AMOUNT_CENTS)) {
      db.delete('cart_items', row.id);
      removedCount += 1;
      continue;
    }
    const quantity = custom ? 1 : clampQuantity(product, row.quantity);
    if (quantity !== Number(row.quantity)) {
      db.update('cart_items', row.id, { quantity });
    }
    const unitCents = custom ? storedCents : toCents(product.price);
    items.push({
      product,
      quantity,
      unitCents,
      lineTotalCents: unitCents * quantity,
      customAmountCents: custom ? unitCents : undefined
    });
  }

  return { items, removedCount };
}

function add(customerId, productId, quantity, customAmount) {
  const product = db.findOne('products', { id: Number(productId) });
  if (!isProductAvailable(product)) {
    return { ok: false, status: 404, error: 'Product not found' };
  }
  const custom = isCustomAmountProduct(product);
  let customCents = null;
  if (custom) {
    const validated = validateCustomAmount(customAmount);
    if (validated.error) return { ok: false, status: 400, error: validated.error };
    customCents = validated.cents;
  }

  const existing = db.findOne('cart_items', {
    customer_id: Number(customerId),
    product_id: product.id
  });
  const desired = custom ? 1 : clampQuantity(
    product,
    (existing ? Number(existing.quantity) : 0) + (Number.parseInt(quantity, 10) || 1)
  );
  const rowData = custom
    ? { quantity: desired, custom_amount_cents: customCents }
    : { quantity: desired };

  if (existing) {
    db.update('cart_items', existing.id, rowData);
  } else {
    db.insert('cart_items', {
      customer_id: Number(customerId),
      product_id: product.id,
      ...rowData
    });
  }
  return { ok: true, product, quantity: desired, customAmountCents: customCents };
}

function setQuantity(customerId, productId, quantity) {
  const row = db.findOne('cart_items', {
    customer_id: Number(customerId),
    product_id: Number(productId)
  });
  if (!row) return { ok: false, status: 404, error: 'Item is not in your cart' };

  const qty = Number.parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty <= 0) {
    db.delete('cart_items', row.id);
    return { ok: true, removed: true };
  }
  const product = db.findOne('products', { id: row.product_id });
  if (!isProductAvailable(product)) {
    db.delete('cart_items', row.id);
    return { ok: true, removed: true };
  }
  db.update('cart_items', row.id, { quantity: clampQuantity(product, qty) });
  return { ok: true };
}

function remove(customerId, productId) {
  const row = db.findOne('cart_items', {
    customer_id: Number(customerId),
    product_id: Number(productId)
  });
  if (row) db.delete('cart_items', row.id);
  return { ok: true };
}

function clear(customerId) {
  if (!customerId) return;
  getRows(customerId).forEach(row => db.delete('cart_items', row.id));
}

function count(customerId) {
  return getRows(customerId).reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
}

// ---------------------------------------------------------------------------
// Anonymous guest cart (session scoped, never shared with other visitors)
// ---------------------------------------------------------------------------
function addGuest(session, productId, quantity, customAmount) {
  const product = db.findOne('products', { id: Number(productId) });
  if (!isProductAvailable(product)) {
    return { ok: false, status: 404, error: 'Product not found' };
  }
  const custom = isCustomAmountProduct(product);
  let customCents = null;
  if (custom) {
    const validated = validateCustomAmount(customAmount);
    if (validated.error) return { ok: false, status: 400, error: validated.error };
    customCents = validated.cents;
  }
  if (!Array.isArray(session.cart)) session.cart = [];
  const existing = session.cart.find(item => Number(item.productId) === Number(product.id));
  if (existing) {
    existing.quantity = custom ? 1 : clampQuantity(product, Number(existing.quantity) + (Number.parseInt(quantity, 10) || 1));
    if (custom) existing.customAmountCents = customCents;
  } else {
    const entry = { productId: product.id, quantity: custom ? 1 : clampQuantity(product, quantity) };
    if (custom) entry.customAmountCents = customCents;
    session.cart.push(entry);
  }
  return { ok: true, product, customAmountCents: customCents };
}

function guestCount(session) {
  if (!Array.isArray(session.cart)) return 0;
  return session.cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

/**
 * Resolve a guest's session cart into real products, using the same shape as
 * buildDetail so the cart page and the payment routes can treat both sources
 * identically. Unavailable products are dropped from the session.
 */
function buildGuestDetail(session) {
  const items = [];
  if (!Array.isArray(session.cart)) return { items, removedCount: 0 };

  const kept = [];
  let removedCount = 0;
  for (const entry of session.cart) {
    const product = db.findOne('products', { id: Number(entry.productId) });
    if (!isProductAvailable(product)) {
      removedCount += 1;
      continue;
    }
    const custom = isCustomAmountProduct(product);
    const storedCents = Number(entry.customAmountCents);
    if (custom && (!Number.isSafeInteger(storedCents) || storedCents < MIN_CUSTOM_AMOUNT_CENTS)) {
      removedCount += 1;
      continue;
    }
    const quantity = custom ? 1 : clampQuantity(product, entry.quantity);
    const keptEntry = { productId: product.id, quantity };
    if (custom) keptEntry.customAmountCents = storedCents;
    kept.push(keptEntry);
    const unitCents = custom ? storedCents : toCents(product.price);
    items.push({
      product,
      quantity,
      unitCents,
      lineTotalCents: unitCents * quantity,
      customAmountCents: custom ? unitCents : undefined
    });
  }
  session.cart = kept;
  return { items, removedCount };
}

function setGuestQuantity(session, productId, quantity) {
  if (!Array.isArray(session.cart)) session.cart = [];
  const id = Number(productId);
  const qty = Number.parseInt(quantity, 10);

  if (!Number.isFinite(qty) || qty <= 0) {
    session.cart = session.cart.filter(item => Number(item.productId) !== id);
    return { ok: true, removed: true };
  }
  const product = db.findOne('products', { id });
  if (!isProductAvailable(product)) {
    session.cart = session.cart.filter(item => Number(item.productId) !== id);
    return { ok: true, removed: true };
  }
  const entry = session.cart.find(item => Number(item.productId) === id);
  if (entry) entry.quantity = clampQuantity(product, qty);
  else session.cart.push({ productId: id, quantity: clampQuantity(product, qty) });
  return { ok: true };
}

function removeGuest(session, productId) {
  if (!Array.isArray(session.cart)) session.cart = [];
  const id = Number(productId);
  session.cart = session.cart.filter(item => Number(item.productId) !== id);
  return { ok: true };
}

function clearGuest(session) {
  if (session) session.cart = [];
}

/**
 * Merge the anonymous session cart into the signed-in customer cart.
 * Called only after the session has been regenerated on login/registration.
 */
function mergeGuest(customerId, guestCart) {
  if (!Array.isArray(guestCart) || guestCart.length === 0) return 0;
  let merged = 0;
  for (const item of guestCart) {
    const result = add(customerId, item.productId, Number(item.quantity) || 1, item.customAmountCents);
    if (result.ok) merged += 1;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Pricing (single source of truth for cart, checkout and every payment route)
// ---------------------------------------------------------------------------
function price(items, settings) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Your cart is empty.');

  let subtotalCents = 0;
  const lines = [];
  let allCustomAmount = true;
  for (const item of items) {
    // Normal products: always re-price from the database (never trust the
    // browser). Donation products: use the validated amount stored in the cart.
    const custom = isCustomAmountProduct(item.product);
    const storedCents = Number(item.customAmountCents);
    const unitCents = custom && Number.isSafeInteger(storedCents) && storedCents >= MIN_CUSTOM_AMOUNT_CENTS
      ? storedCents
      : toCents(item.product.price);
    if (!custom) allCustomAmount = false;
    const lineTotalCents = unitCents * item.quantity;
    if (!Number.isSafeInteger(lineTotalCents)) throw new Error('The cart total is invalid.');
    subtotalCents += lineTotalCents;
    lines.push({ ...item, unitCents, lineTotalCents });
  }

  const freeShipCents = toCents(settings.free_shipping_threshold || 50);
  const flatRateCents = toCents(settings.flat_shipping_rate || 5.99);
  // A donation-only cart has nothing to ship, so never add a shipping fee.
  const shippingCents = allCustomAmount || subtotalCents === 0 || subtotalCents >= freeShipCents
    ? 0
    : flatRateCents;

  const taxRate = Number.parseFloat(settings.tax_rate || 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new Error('The store tax configuration is invalid.');
  }
  const taxCents = Math.round(subtotalCents * taxRate / 100);
  const totalCents = subtotalCents + shippingCents + taxCents;
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new Error('The payment amount is invalid.');

  return { lines, subtotalCents, shippingCents, taxCents, totalCents };
}

module.exports = {
  MAX_QUANTITY_PER_ITEM,
  MIN_CUSTOM_AMOUNT_CENTS,
  isProductAvailable,
  isCustomAmountProduct,
  validateCustomAmount,
  buildDetail,
  add,
  setQuantity,
  remove,
  clear,
  count,
  addGuest,
  guestCount,
  buildGuestDetail,
  setGuestQuantity,
  removeGuest,
  clearGuest,
  mergeGuest,
  price
};
