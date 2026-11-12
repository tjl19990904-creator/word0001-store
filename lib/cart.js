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

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid amount');
  return Math.round((amount + Number.EPSILON) * 100);
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
    const quantity = clampQuantity(product, row.quantity);
    if (quantity !== Number(row.quantity)) {
      db.update('cart_items', row.id, { quantity });
    }
    items.push({
      product,
      quantity,
      unitCents: toCents(product.price),
      lineTotalCents: toCents(product.price) * quantity
    });
  }

  return { items, removedCount };
}

function add(customerId, productId, quantity) {
  const product = db.findOne('products', { id: Number(productId) });
  if (!isProductAvailable(product)) {
    return { ok: false, status: 404, error: 'Product not found' };
  }
  const existing = db.findOne('cart_items', {
    customer_id: Number(customerId),
    product_id: product.id
  });
  const desired = clampQuantity(
    product,
    (existing ? Number(existing.quantity) : 0) + (Number.parseInt(quantity, 10) || 1)
  );

  if (existing) {
    db.update('cart_items', existing.id, { quantity: desired });
  } else {
    db.insert('cart_items', {
      customer_id: Number(customerId),
      product_id: product.id,
      quantity: desired
    });
  }
  return { ok: true, product, quantity: desired };
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
function addGuest(session, productId, quantity) {
  const product = db.findOne('products', { id: Number(productId) });
  if (!isProductAvailable(product)) {
    return { ok: false, status: 404, error: 'Product not found' };
  }
  if (!Array.isArray(session.cart)) session.cart = [];
  const existing = session.cart.find(item => Number(item.productId) === Number(product.id));
  if (existing) {
    existing.quantity = clampQuantity(product, Number(existing.quantity) + (Number.parseInt(quantity, 10) || 1));
  } else {
    session.cart.push({ productId: product.id, quantity: clampQuantity(product, quantity) });
  }
  return { ok: true, product };
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
    const quantity = clampQuantity(product, entry.quantity);
    kept.push({ productId: product.id, quantity });
    items.push({
      product,
      quantity,
      unitCents: toCents(product.price),
      lineTotalCents: toCents(product.price) * quantity
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
    const result = add(customerId, item.productId, Number(item.quantity) || 1);
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
  for (const item of items) {
    const unitCents = toCents(item.product.price);
    const lineTotalCents = unitCents * item.quantity;
    if (!Number.isSafeInteger(lineTotalCents)) throw new Error('The cart total is invalid.');
    subtotalCents += lineTotalCents;
    lines.push({ ...item, unitCents, lineTotalCents });
  }

  const freeShipCents = toCents(settings.free_shipping_threshold || 50);
  const flatRateCents = toCents(settings.flat_shipping_rate || 5.99);
  const shippingCents = subtotalCents === 0 || subtotalCents >= freeShipCents ? 0 : flatRateCents;

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
  isProductAvailable,
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
