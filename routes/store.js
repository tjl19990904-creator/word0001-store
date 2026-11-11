const express = require('express');
const router = express.Router();
const db = require('../db/init');
const cart = require('../lib/cart');
const auth = require('../lib/auth');
const i18n = require('../lib/i18n');

// Helper: get settings
function getSettings() {
  return db.getAllSettings();
}

function isStripeConfigured(config) {
  const mode = process.env.STRIPE_MODE === 'test' || process.env.STRIPE_MODE === 'live'
    ? process.env.STRIPE_MODE
    : (process.env.NODE_ENV === 'production' ? 'live' : 'test');
  const secretKey = process.env.STRIPE_SECRET_KEY || config.secret_key || '';
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || config.publishable_key || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || config.webhook_secret || '';
  const correctPrefixes = mode === 'live'
    ? secretKey.startsWith('sk_live_') && publishableKey.startsWith('pk_live_')
    : secretKey.startsWith('sk_test_') && publishableKey.startsWith('pk_test_');
  return Boolean(correctPrefixes && (mode !== 'live' || webhookSecret));
}

// Build the cart view model strictly from the signed-in customer's own rows.
// Product ids, prices and quantities never come from the browser.
function buildCartView(customerId, locale = i18n.DEFAULT_LOCALE) {
  const { items } = cart.buildDetail(customerId);
  if (items.length === 0) {
    return { cartItems: [], subtotal: 0, shippingCost: 0, tax: 0, total: 0 };
  }
  const priced = cart.price(items, getSettings());
  const cartItems = priced.lines.map(line => {
    const imageList = line.product.images ? safeParseArr(line.product.images) : [];
    // Never send internal cost, SEO-only fields or the long description to the browser.
    const {
      cost, meta_title, meta_description, description,
      name_zh, short_description_zh, ...publicProduct
    } = line.product;
    return {
      ...publicProduct,
      // Catalog content falls back to English when no Chinese copy exists.
      name: i18n.localizeField(locale, name_zh, line.product.name),
      short_description: i18n.localizeField(locale, short_description_zh, line.product.short_description),
      image_list: imageList,
      primary_image: imageList.length > 0 ? imageList[0] : '',
      quantity: line.quantity,
      lineTotal: line.lineTotalCents / 100
    };
  });
  return {
    cartItems,
    subtotal: priced.subtotalCents / 100,
    shippingCost: priced.shippingCents / 100,
    tax: priced.taxCents / 100,
    total: priced.totalCents / 100
  };
}

// Shared renderer: i18n placeholders, partial includes, settings overrides.
const renderPage = require('../lib/render');

// ===== Home page =====
router.get('/', (req, res) => {
  const locale = req.locale || i18n.DEFAULT_LOCALE;
  let products = db.findAll('products', { where: { status: 'active' }, orderBy: 'featured DESC' });
  // Sort: featured first, then by sort_order, then by created_at DESC
  products.sort((a, b) => {
    if (a.featured !== b.featured) return b.featured - a.featured;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  products = products.slice(0, 12);

  // Localize catalog content (name_zh / short_description_zh) and whitelist the
  // fields the grid needs. Internal cost and SEO-only fields never reach the browser.
  const productCards = products.map(product => {
    const imageList = product.images ? safeParseArr(product.images) : [];
    const category = db.findOne('categories', { id: product.category_id });
    return {
      id: product.id,
      slug: product.slug,
      name: i18n.localizeField(locale, product.name_zh, product.name),
      short_description: i18n.localizeField(locale, product.short_description_zh, product.short_description),
      category_name: category ? i18n.localizeField(locale, category.name_zh, category.name) : '',
      price: Number(product.price) || 0,
      compare_price: product.compare_price ? Number(product.compare_price) : null,
      primary_image: imageList.length > 0 ? imageList[0] : '',
      image_list: imageList
    };
  });

  renderPage(res, 'index.html', {
    products: productCards,
    pageTitle: i18n.t(locale, 'nav.home')
  });
});

// ===== Products listing =====
router.get('/products', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 12;
  const categoryId = req.query.category;
  const search = req.query.search;

  let products = db.findAll('products', { where: { status: 'active' } });
  
  if (categoryId) {
    products = products.filter(p => p.category_id == categoryId);
  }
  if (search) {
    const s = search.toLowerCase();
    products = products.filter(p => 
      (p.name && p.name.toLowerCase().includes(s)) ||
      (p.description && p.description.toLowerCase().includes(s)) ||
      (p.short_description && p.short_description.toLowerCase().includes(s))
    );
  }

  // Sort
  products.sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const total = products.length;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;
  products = products.slice(offset, offset + perPage);

  const categories = db.findAll('categories', { orderBy: 'sort_order ASC' });

  products.forEach(p => {
    const cat = db.findOne('categories', { id: p.category_id });
    p.category_name = cat ? cat.name : '';
    p.image_list = p.images ? safeParseArr(p.images) : [];
    p.primary_image = p.image_list.length > 0 ? p.image_list[0] : '';
  });

  renderPage(res, 'products.html', { 
    products, categories, currentPage: page, totalPages,
    selectedCategory: categoryId || '', search: search || '', pageTitle: 'Products' 
  });
});

// ===== Product detail =====
router.get('/products/:slug', (req, res) => {
  const product = db.findOne('products', { slug: req.params.slug });
  
  if (!product || product.status !== 'active') {
    return res.status(404).send('<h1>Product not found</h1><p><a href="/products">Back to products</a></p>');
  }

  const cat = db.findOne('categories', { id: product.category_id });
  product.category_name = cat ? cat.name : '';
  product.image_list = product.images ? safeParseArr(product.images) : [];
  product.primary_image = product.image_list.length > 0 ? product.image_list[0] : '';

  // Related products
  let related = db.findAll('products', { where: { category_id: product.category_id, status: 'active' } });
  related = related.filter(p => p.id !== product.id).slice(0, 4);
  related.forEach(p => {
    p.image_list = p.images ? safeParseArr(p.images) : [];
    p.primary_image = p.image_list.length > 0 ? p.image_list[0] : '';
  });

  renderPage(res, 'product-detail.html', { product, related, pageTitle: product.name });
});

// ===== Cart (customer-only, database backed) =====
// The cart is read from `cart_items` for the signed-in customer. A visitor
// without a customer session is sent to sign in; they never see a cart that
// belongs to somebody else, on any IP address.
router.get('/cart', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const view = buildCartView(customer.id, req.locale);

  // Expose only public account labels and Stripe availability; never send payment credentials to the browser.
  const paymentAccounts = db.findAll('payment_accounts', { where: { status: 'active' } })
    .map(account => {
      let config = {};
      try { config = JSON.parse(account.config || '{}'); } catch { config = {}; }
      return {
        id: account.id,
        name: account.name,
        type: account.type,
        is_configured: account.type === 'stripe' ? isStripeConfigured(config) : false
      };
    });

  renderPage(res, 'cart.html', {
    ...view,
    paymentAccounts,
    customer: auth.publicCustomer(customer),
    pageTitle: 'Shopping Cart'
  });
});

// Add to cart. Guests get a session-scoped cart which is merged into their own
// database cart at sign-in; signed-in customers write straight to their rows.
router.post('/cart/add', (req, res) => {
  const productId = parseInt(req.body.productId);
  const quantity = parseInt(req.body.quantity) || 1;
  const customer = auth.getCustomer(req);

  let result;
  let cartCount;
  if (customer) {
    result = cart.add(customer.id, productId, quantity);
    cartCount = cart.count(customer.id);
  } else {
    result = cart.addGuest(req.session, productId, quantity);
    cartCount = cart.guestCount(req.session);
  }

  if (!result.ok) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.status(result.status || 400).json({ error: result.error || 'Unable to add this item.' });
    }
    return res.status(result.status || 400).send(result.error || 'Unable to add this item.');
  }

  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    return res.json({ success: true, cartCount });
  }
  return res.redirect('/cart');
});

// Update cart — scoped to the current customer's rows only.
router.post('/cart/update', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const productId = parseInt(req.body.productId);
  const quantity = parseInt(req.body.quantity);
  cart.setQuantity(customer.id, productId, quantity);
  res.redirect('/cart');
});

// Remove from cart — scoped to the current customer's rows only.
router.post('/cart/remove', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const productId = parseInt(req.body.productId);
  cart.remove(customer.id, productId);
  res.redirect('/cart');
});

// ===== Checkout (customer-only) =====
router.get('/checkout', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const view = buildCartView(customer.id, req.locale);
  if (view.cartItems.length === 0) {
    return res.redirect('/cart');
  }

  // Only expose public payment labels and a boolean configuration state to the browser.
  // Never serialize provider credentials or bank account configuration into the checkout page.
  const paymentAccounts = db.findAll('payment_accounts', { where: { status: 'active' } })
    .map(account => {
      let config = {};
      try { config = JSON.parse(account.config || '{}'); } catch { config = {}; }
      let isConfigured = true;
      if (account.type === 'stripe') {
        isConfigured = isStripeConfigured(config);
      }
      if (account.type === 'airwallex') isConfigured = Boolean(config.client_id && config.api_key);
      if (account.type === 'cashapp') isConfigured = Boolean(config.square_app_id && config.square_access_token && config.square_location_id);
      return {
        id: account.id,
        name: account.name,
        type: account.type,
        sort_order: account.sort_order || 0,
        is_configured: isConfigured
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order);

  renderPage(res, 'checkout.html', {
    ...view,
    paymentAccounts,
    customer: auth.publicCustomer(customer),
    pageTitle: 'Checkout'
  });
});

// Place an offline/unpaid order. The line items are rebuilt from the customer's
// own database cart; any product or amount supplied by the browser is ignored.
router.post('/checkout/place-order', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const { items } = cart.buildDetail(customer.id);
  if (items.length === 0) {
    return res.redirect('/cart');
  }

  const { email, phone, firstName, lastName, address, city, state, zip, country, paymentMethod, paymentAccountId, notes } = req.body;
  const settings = getSettings();
  const pricing = cart.price(items, settings);

  const orderNumber = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const customerName = `${firstName || ''} ${lastName || ''}`.trim();
  const shippingAddress = `${address || ''}, ${city || ''}, ${state || ''} ${zip || ''}, ${country || 'United States'}`;

  // Validate that the selected payment account really exists and is active.
  let accountId = null;
  if (paymentAccountId) {
    const account = db.findOne('payment_accounts', { id: Number(paymentAccountId) });
    if (account && account.status === 'active') accountId = account.id;
  }

  const orderResult = db.insert('orders', {
    order_number: orderNumber,
    customer_id: customer.id,
    customer_email: customer.email || email,
    customer_phone: phone,
    customer_name: customerName,
    shipping_address: shippingAddress,
    shipping_city: city,
    shipping_state: state,
    shipping_zip: zip,
    shipping_country: country || 'United States',
    shipping_method: 'Standard Shipping',
    shipping_cost: pricing.shippingCents / 100,
    subtotal: pricing.subtotalCents / 100,
    tax: pricing.taxCents / 100,
    total: pricing.totalCents / 100,
    status: 'pending',
    payment_status: 'unpaid',
    payment_method: paymentMethod || '',
    payment_account_id: accountId,
    notes: notes || '',
    transaction_id: ''
  });

  const orderId = orderResult.lastInsertRowid;

  pricing.lines.forEach(line => {
    const imageList = line.product.images ? safeParseArr(line.product.images) : [];
    db.insert('order_items', {
      order_id: orderId,
      product_id: line.product.id,
      product_name: line.product.name,
      product_image: imageList[0] || '',
      price: line.unitCents / 100,
      quantity: line.quantity,
      total: line.lineTotalCents / 100
    });
  });

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

  // Only this customer's cart is cleared.
  cart.clear(customer.id);

  renderPage(res, 'order-confirmation.html', {
    orderNumber, orderId, total: (pricing.totalCents / 100).toFixed(2), email: customer.email || email,
    pageTitle: 'Order Confirmed'
  });
});

// ===== Order tracking (customer-only, own orders only) =====
router.get('/track-order', auth.requireCustomerPage, (req, res) => {
  const customer = auth.getCustomer(req);
  const orderNumber = req.query.order_number;
  let order = null;
  let orderItems = [];
  let shipment = null;
  let trackingHistory = [];

  if (orderNumber) {
    const found = db.findOne('orders', { order_number: orderNumber });
    // Ownership check: another customer's order is treated as not found so the
    // page cannot be used to enumerate or read someone else's order.
    if (found && String(found.customer_id) === String(customer.id)) {
      order = found;
      orderItems = db.findAll('order_items', { where: { order_id: order.id } });
      shipment = db.findOne('shipments', { order_id: order.id });
      if (shipment) {
        trackingHistory = db.findAll('shipment_tracking', { where: { shipment_id: shipment.id } });
        trackingHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      }
    }
  }

  renderPage(res, 'track-order.html', {
    order, orderItems, shipment, trackingHistory,
    customer: auth.publicCustomer(customer),
    searchedOrderNumber: orderNumber || '', pageTitle: 'Track Order'
  });
});

// ===== About / Contact =====
router.get('/about', (req, res) => {
  renderPage(res, 'about.html', { pageTitle: 'About Us' });
});

router.get('/contact', (req, res) => {
  renderPage(res, 'contact.html', { pageTitle: 'Contact Us' });
});

router.post('/contact', (req, res) => {
  renderPage(res, 'contact.html', { pageTitle: 'Contact Us' });
});

// Helper function
function safeParseArr(str) {
  try { 
    const arr = JSON.parse(str); 
    return Array.isArray(arr) ? arr : []; 
  } catch { 
    return []; 
  }
}

module.exports = router;
