const express = require('express');
const router = express.Router();
const db = require('../db/init');

// Helper: get settings
function getSettings() {
  return db.getAllSettings();
}

// Helper: render template
function renderPage(res, templateName, data = {}) {
  const settings = getSettings();
  const merged = { ...data, settings };
  const fs = require('fs');
  const path = require('path');
  const templatePath = path.join(__dirname, '..', 'views', templateName);
  
  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    
    // Replace {{data:json:xxx}} with JSON stringified data
    html = html.replace(/\{\{data:json:(\w+)\}\}/g, (match, key) => {
      const val = merged[key];
      return val !== undefined ? JSON.stringify(val) : '[]';
    });
    
    // Replace {{settings.xxx}}
    html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
      return settings[key] !== undefined ? String(settings[key]) : '';
    });
    
    // Replace {{data.xxx}} 
    html = html.replace(/\{\{data\.(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const parts = key.split('.');
      let val = merged;
      for (const part of parts) { val = val ? val[part] : undefined; }
      return val !== undefined && val !== null ? String(val) : '';
    });
    
    // Replace {{xxx}}
    html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return merged[key] !== undefined ? String(merged[key]) : '';
    });
    
    res.send(html);
  } else {
    res.status(404).send('Template not found: ' + templateName);
  }
}

// ===== Home page =====
router.get('/', (req, res) => {
  let products = db.findAll('products', { where: { status: 'active' }, orderBy: 'featured DESC' });
  // Sort: featured first, then by sort_order, then by created_at DESC
  products.sort((a, b) => {
    if (a.featured !== b.featured) return b.featured - a.featured;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  products = products.slice(0, 12);

  // Add category names
  products.forEach(p => {
    const cat = db.findOne('categories', { id: p.category_id });
    p.category_name = cat ? cat.name : '';
    p.image_list = p.images ? safeParseArr(p.images) : [];
    p.primary_image = p.image_list.length > 0 ? p.image_list[0] : '';
  });

  renderPage(res, 'index.html', { products, pageTitle: 'Home' });
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

// ===== Cart =====
router.get('/cart', (req, res) => {
  const cart = req.session.cart || [];
  let subtotal = 0;
  
  const cartItems = cart.map(item => {
    const product = db.findOne('products', { id: item.productId });
    if (product) {
      product.image_list = product.images ? safeParseArr(product.images) : [];
      product.primary_image = product.image_list.length > 0 ? product.image_list[0] : '';
      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;
      return { ...product, quantity: item.quantity, lineTotal };
    }
    return null;
  }).filter(item => item !== null);

  const settings = getSettings();
  const freeShipThreshold = parseFloat(settings.free_shipping_threshold || 50);
  const flatRate = parseFloat(settings.flat_shipping_rate || 5.99);
  const shippingCost = subtotal >= freeShipThreshold || subtotal === 0 ? 0 : flatRate;
  const total = subtotal + shippingCost;

  renderPage(res, 'cart.html', { 
    cartItems, subtotal, shippingCost, total, pageTitle: 'Shopping Cart' 
  });
});

// Add to cart
router.post('/cart/add', (req, res) => {
  const productId = parseInt(req.body.productId);
  const quantity = parseInt(req.body.quantity) || 1;
  
  const product = db.findOne('products', { id: productId });
  if (!product || product.status !== 'active') {
    return res.status(404).json({ error: 'Product not found' });
  }

  if (!req.session.cart) req.session.cart = [];
  
  const existing = req.session.cart.find(item => item.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    req.session.cart.push({ productId, quantity });
  }

  const cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    res.json({ success: true, cartCount });
  } else {
    res.redirect('/cart');
  }
});

// Update cart
router.post('/cart/update', (req, res) => {
  const productId = parseInt(req.body.productId);
  const quantity = parseInt(req.body.quantity);
  
  if (!req.session.cart) req.session.cart = [];
  
  if (quantity <= 0) {
    req.session.cart = req.session.cart.filter(item => item.productId !== productId);
  } else {
    const item = req.session.cart.find(item => item.productId === productId);
    if (item) item.quantity = quantity;
  }

  res.redirect('/cart');
});

// Remove from cart
router.post('/cart/remove', (req, res) => {
  const productId = parseInt(req.body.productId);
  if (req.session.cart) {
    req.session.cart = req.session.cart.filter(item => item.productId !== productId);
  }
  res.redirect('/cart');
});

// ===== Checkout =====
router.get('/checkout', (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) {
    return res.redirect('/cart');
  }

  let subtotal = 0;
  const cartItems = cart.map(item => {
    const product = db.findOne('products', { id: item.productId });
    if (product) {
      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;
      return { ...product, quantity: item.quantity, lineTotal };
    }
    return null;
  }).filter(item => item !== null);

  const settings = getSettings();
  const freeShipThreshold = parseFloat(settings.free_shipping_threshold || 50);
  const flatRate = parseFloat(settings.flat_shipping_rate || 5.99);
  const shippingCost = subtotal >= freeShipThreshold ? 0 : flatRate;
  const taxRate = parseFloat(settings.tax_rate || 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + shippingCost + tax;

  const paymentAccounts = db.findAll('payment_accounts', { where: { status: 'active' } });
  paymentAccounts.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  renderPage(res, 'checkout.html', { 
    cartItems, subtotal, shippingCost, tax, total, paymentAccounts, pageTitle: 'Checkout' 
  });
});

// Place order
router.post('/checkout/place-order', (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) {
    return res.redirect('/cart');
  }

  const { email, phone, firstName, lastName, address, city, state, zip, country, paymentMethod, paymentAccountId, notes } = req.body;
  
  let subtotal = 0;
  const cartItems = cart.map(item => {
    const product = db.findOne('products', { id: item.productId });
    if (product) {
      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;
      return { ...product, quantity: item.quantity, lineTotal };
    }
    return null;
  }).filter(item => item !== null);

  const settings = getSettings();
  const freeShipThreshold = parseFloat(settings.free_shipping_threshold || 50);
  const flatRate = parseFloat(settings.flat_shipping_rate || 5.99);
  const shippingCost = subtotal >= freeShipThreshold ? 0 : flatRate;
  const taxRate = parseFloat(settings.tax_rate || 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + shippingCost + tax;

  const orderNumber = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const customerName = `${firstName} ${lastName}`;
  const shippingAddress = `${address}, ${city}, ${state} ${zip}, ${country}`;

  // Insert order
  const orderResult = db.insert('orders', {
    order_number: orderNumber,
    customer_email: email,
    customer_phone: phone,
    customer_name: customerName,
    shipping_address: shippingAddress,
    shipping_city: city,
    shipping_state: state,
    shipping_zip: zip,
    shipping_country: country || 'United States',
    shipping_method: 'Standard Shipping',
    shipping_cost: shippingCost,
    subtotal: subtotal,
    tax: tax,
    total: total,
    status: 'pending',
    payment_status: 'unpaid',
    payment_method: paymentMethod || '',
    payment_account_id: paymentAccountId ? parseInt(paymentAccountId) : null,
    notes: notes || '',
    transaction_id: ''
  });

  const orderId = orderResult.lastInsertRowid;

  // Insert order items
  cartItems.forEach(item => {
    db.insert('order_items', {
      order_id: orderId,
      product_id: item.id,
      product_name: item.name,
      product_image: item.primary_image || '',
      price: item.price,
      quantity: item.quantity,
      total: item.lineTotal
    });
  });

  // Create initial shipment record
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
    shipping_cost: shippingCost,
    notes: ''
  });

  // Clear cart
  req.session.cart = [];

  renderPage(res, 'order-confirmation.html', { 
    orderNumber, orderId, total, email, pageTitle: 'Order Confirmed' 
  });
});

// ===== Order tracking =====
router.get('/track-order', (req, res) => {
  const orderNumber = req.query.order_number;
  let order = null;
  let orderItems = [];
  let shipment = null;
  let trackingHistory = [];

  if (orderNumber) {
    order = db.findOne('orders', { order_number: orderNumber });
    if (order) {
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
