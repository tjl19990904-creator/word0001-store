const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// ===== Auth Middleware =====
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}

// Helper: get settings
function getSettings() {
  return db.getAllSettings();
}

// Helper: render admin template
function renderAdmin(res, templateName, data = {}) {
  const settings = getSettings();
  const admin = db.findOne('users', { id: data.sessionUserId || 0 });
  const merged = { ...data, settings, admin: admin ? { id: admin.id, username: admin.username, email: admin.email } : null };
  const templatePath = path.join(__dirname, '..', 'views', 'admin', templateName);
  
  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    
    // Replace {{data:json:xxx}}
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
      if (val === undefined || val === null) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val);
    });
    
    // Replace {{xxx}}
    html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return merged[key] !== undefined ? String(merged[key]) : '';
    });
    
    // Inject store name as data attribute
    html = html.replace('<html', `<html data-store-name="${settings.store_name || 'Store'}"`);
    
    res.send(html);
  } else {
    res.status(404).send('Admin template not found: ' + templateName);
  }
}

// ===== Login =====
router.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/admin/dashboard');
  }
  renderAdmin(res, 'login.html', { pageTitle: 'Admin Login' });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.findOne('users', { username });
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return renderAdmin(res, 'login.html', { pageTitle: 'Admin Login', error: 'Invalid username or password' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/admin/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ===== Dashboard =====
router.get('/dashboard', requireAuth, (req, res) => {
  const stats = {
    totalOrders: db.count('orders'),
    pendingOrders: db.count('orders', { status: 'pending' }),
    totalProducts: db.count('products'),
    totalRevenue: db.sum('orders', 'total', { payment_status: 'paid' }),
    totalCustomers: new Set(db.findAll('orders').map(o => o.customer_email)).size,
    shippedOrders: db.count('orders', { status: 'shipped' }),
    lowStock: db.findAll('products').filter(p => p.stock < 10 && p.status === 'active').length,
    activePaymentAccounts: db.count('payment_accounts', { status: 'active' }),
  };

  const allOrders = db.findAll('orders');
  allOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const recentOrders = allOrders.slice(0, 10);

  // Top products
  const allItems = db.findAll('order_items');
  const productMap = {};
  allItems.forEach(item => {
    if (!productMap[item.product_name]) {
      productMap[item.product_name] = { product_name: item.product_name, total_sold: 0, revenue: 0 };
    }
    productMap[item.product_name].total_sold += item.quantity;
    productMap[item.product_name].revenue += item.total;
  });
  const topProducts = Object.values(productMap).sort((a, b) => b.total_sold - a.total_sold).slice(0, 5);

  renderAdmin(res, 'dashboard.html', { 
    stats, recentOrders, topProducts, pageTitle: 'Dashboard', sessionUserId: req.session.userId 
  });
});

// ===== Products Management =====
router.get('/products', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 20;
  const search = req.query.search;

  let products = db.findAll('products');
  
  if (search) {
    const s = search.toLowerCase();
    products = products.filter(p => 
      (p.name && p.name.toLowerCase().includes(s)) ||
      (p.sku && p.sku.toLowerCase().includes(s))
    );
  }

  products.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const total = products.length;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;
  products = products.slice(offset, offset + perPage);

  products.forEach(p => {
    const cat = db.findOne('categories', { id: p.category_id });
    p.category_name = cat ? cat.name : '';
    p.image_list = p.images ? safeParseArr(p.images) : [];
    p.primary_image = p.image_list.length > 0 ? p.image_list[0] : '';
  });

  const categories = db.findAll('categories');
  categories.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  renderAdmin(res, 'products.html', { 
    products, categories, currentPage: page, totalPages, search: search || '',
    pageTitle: 'Products', sessionUserId: req.session.userId 
  });
});

// New product form
router.get('/products/new', requireAuth, (req, res) => {
  const categories = db.findAll('categories');
  categories.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  renderAdmin(res, 'product-form.html', { 
    product: null, categories, pageTitle: 'New Product', sessionUserId: req.session.userId, isEdit: false 
  });
});

// Edit product form
router.get('/products/:id/edit', requireAuth, (req, res) => {
  const product = db.findOne('products', { id: parseInt(req.params.id) });
  if (!product) {
    return res.redirect('/admin/products');
  }
  product.image_list = product.images ? safeParseArr(product.images) : [];
  const categories = db.findAll('categories');
  categories.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  renderAdmin(res, 'product-form.html', { 
    product, categories, pageTitle: 'Edit Product', sessionUserId: req.session.userId, isEdit: true 
  });
});

// Create product
router.post('/products/create', requireAuth, (req, res) => {
  const { name, description, short_description, price, compare_price, cost, sku, stock, category_id, 
    status, weight, dimensions, meta_title, meta_description, featured, sort_order, images } = req.body;

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  
  db.insert('products', {
    name, slug, description: description || '', short_description: short_description || '',
    price: parseFloat(price) || 0,
    compare_price: compare_price ? parseFloat(compare_price) : null,
    cost: cost ? parseFloat(cost) : 0,
    sku: sku || '', stock: parseInt(stock) || 0,
    category_id: category_id ? parseInt(category_id) : null,
    images: images || '[]', status: status || 'active',
    weight: parseFloat(weight) || 0, dimensions: dimensions || '',
    meta_title: meta_title || '', meta_description: meta_description || '',
    featured: featured ? 1 : 0, sort_order: parseInt(sort_order) || 0
  });

  res.redirect('/admin/products');
});

// Update product
router.post('/products/:id/update', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, description, short_description, price, compare_price, cost, sku, stock, category_id,
    status, weight, dimensions, meta_title, meta_description, featured, sort_order, images } = req.body;

  db.update('products', id, {
    name, description: description || '', short_description: short_description || '',
    price: parseFloat(price) || 0,
    compare_price: compare_price ? parseFloat(compare_price) : null,
    cost: cost ? parseFloat(cost) : 0,
    sku: sku || '', stock: parseInt(stock) || 0,
    category_id: category_id ? parseInt(category_id) : null,
    images: images || '[]', status: status || 'active',
    weight: parseFloat(weight) || 0, dimensions: dimensions || '',
    meta_title: meta_title || '', meta_description: meta_description || '',
    featured: featured ? 1 : 0, sort_order: parseInt(sort_order) || 0
  });

  res.redirect('/admin/products');
});

// Delete product
router.post('/products/:id/delete', requireAuth, (req, res) => {
  db.delete('products', parseInt(req.params.id));
  res.redirect('/admin/products');
});

// ===== Categories Management =====
router.get('/categories', requireAuth, (req, res) => {
  const categories = db.findAll('categories');
  categories.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  renderAdmin(res, 'categories.html', { 
    categories, pageTitle: 'Categories', sessionUserId: req.session.userId 
  });
});

router.post('/categories/create', requireAuth, (req, res) => {
  const { name, description, sort_order } = req.body;
  db.insert('categories', { name, description: description || '', sort_order: parseInt(sort_order) || 0 });
  res.redirect('/admin/categories');
});

router.post('/categories/:id/update', requireAuth, (req, res) => {
  const { name, description, sort_order } = req.body;
  db.update('categories', parseInt(req.params.id), { name, description: description || '', sort_order: parseInt(sort_order) || 0 });
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', requireAuth, (req, res) => {
  db.delete('categories', parseInt(req.params.id));
  res.redirect('/admin/categories');
});

// ===== Orders Management =====
router.get('/orders', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 20;
  const status = req.query.status;
  const search = req.query.search;

  let orders = db.findAll('orders');
  
  if (status && status !== 'all') {
    orders = orders.filter(o => o.status === status);
  }
  if (search) {
    const s = search.toLowerCase();
    orders = orders.filter(o => 
      (o.order_number && o.order_number.toLowerCase().includes(s)) ||
      (o.customer_email && o.customer_email.toLowerCase().includes(s)) ||
      (o.customer_name && o.customer_name.toLowerCase().includes(s))
    );
  }

  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const total = orders.length;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;
  orders = orders.slice(offset, offset + perPage);

  renderAdmin(res, 'orders.html', { 
    orders, currentPage: page, totalPages, status: status || 'all', search: search || '',
    pageTitle: 'Orders', sessionUserId: req.session.userId 
  });
});

// Order detail
router.get('/orders/:id', requireAuth, (req, res) => {
  const order = db.findOne('orders', { id: parseInt(req.params.id) });
  if (!order) {
    return res.redirect('/admin/orders');
  }
  const orderItems = db.findAll('order_items', { where: { order_id: order.id } });
  const shipment = db.findOne('shipments', { order_id: order.id });
  let trackingHistory = [];
  if (shipment) {
    trackingHistory = db.findAll('shipment_tracking', { where: { shipment_id: shipment.id } });
    trackingHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
  const paymentAccount = order.payment_account_id ? db.findOne('payment_accounts', { id: order.payment_account_id }) : null;

  renderAdmin(res, 'order-detail.html', { 
    order, orderItems, shipment, trackingHistory, paymentAccount,
    pageTitle: 'Order #' + order.order_number, sessionUserId: req.session.userId 
  });
});

// Update order status
router.post('/orders/:id/status', requireAuth, (req, res) => {
  const { status, payment_status } = req.body;
  
  const updateData = {};
  if (status) updateData.status = status;
  if (payment_status) updateData.payment_status = payment_status;
  
  db.update('orders', parseInt(req.params.id), updateData);
  res.redirect('/admin/orders/' + req.params.id);
});

// ===== Payment Accounts Management (收款账户) =====
router.get('/payment-accounts', requireAuth, (req, res) => {
  let accounts = db.findAll('payment_accounts');
  accounts.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  
  accounts.forEach(a => {
    try { a.config_data = JSON.parse(a.config || '{}'); } catch { a.config_data = {}; }
  });

  renderAdmin(res, 'payment-accounts.html', { 
    accounts, pageTitle: '收款账户管理', sessionUserId: req.session.userId 
  });
});

router.post('/payment-accounts/create', requireAuth, (req, res) => {
  const { name, type, status, is_default, sort_order, client_id, client_secret, mode,
    publishable_key, secret_key, webhook_secret, merchant_id, api_key, other_config,
    bank_region, bank_account_holder, bank_account_number, bank_name, bank_branch,
    bank_swift_code, bank_iban, bank_currency,
    usdt_network, usdt_currency, usdt_wallet_address, usdt_merchant_id, usdt_api_key,
    wise_email, wise_account_id, wise_currency, wise_api_key, wise_link,
    payoneer_email, payoneer_customer_id, payoneer_currency, payoneer_account_type,
    cashapp_cashtag, cashapp_email, cashapp_currency, cashapp_link,
    alipay_account, alipay_name, alipay_pid, alipay_app_id, alipay_private_key, alipay_type,
    wechat_account, wechat_name, wechat_mch_id, wechat_api_key, wechat_app_id, wechat_type,
    airwallex_client_id, airwallex_api_key, airwallex_webhook_secret, airwallex_currency
  } = req.body;

  let config = {};
  if (type === 'paypal') {
    config = { client_id: client_id || '', client_secret: client_secret || '', mode: mode || 'sandbox' };
  } else if (type === 'stripe') {
    config = { publishable_key: publishable_key || '', secret_key: secret_key || '', webhook_secret: webhook_secret || '' };
  } else if (type === 'airwallex') {
    config = {
      client_id: airwallex_client_id || '',
      api_key: airwallex_api_key || '',
      webhook_secret: airwallex_webhook_secret || '',
      currency: airwallex_currency || 'USD'
    };
  } else if (type === 'bank') {
    config = {
      bank_region: bank_region || 'domestic',
      bank_account_holder: bank_account_holder || '',
      bank_account_number: bank_account_number || '',
      bank_name: bank_name || '',
      bank_branch: bank_branch || '',
      bank_swift_code: bank_swift_code || '',
      bank_iban: bank_iban || '',
      bank_currency: bank_currency || 'USD'
    };
  } else if (type === 'usdt') {
    config = {
      usdt_network: usdt_network || 'trc20',
      usdt_currency: usdt_currency || 'USDT',
      usdt_wallet_address: usdt_wallet_address || '',
      usdt_merchant_id: usdt_merchant_id || '',
      usdt_api_key: usdt_api_key || ''
    };
  } else if (type === 'wise') {
    config = {
      wise_email: wise_email || '',
      wise_account_id: wise_account_id || '',
      wise_currency: wise_currency || 'USD',
      wise_api_key: wise_api_key || '',
      wise_link: wise_link || ''
    };
  } else if (type === 'payoneer') {
    config = {
      payoneer_email: payoneer_email || '',
      payoneer_customer_id: payoneer_customer_id || '',
      payoneer_currency: payoneer_currency || 'USD',
      payoneer_account_type: payoneer_account_type || 'receiving'
    };
  } else if (type === 'cashapp') {
    config = {
      cashapp_cashtag: cashapp_cashtag || '',
      cashapp_email: cashapp_email || '',
      cashapp_currency: cashapp_currency || 'USD',
      cashapp_link: cashapp_link || ''
    };
  } else if (type === 'alipay') {
    config = {
      alipay_account: alipay_account || '',
      alipay_name: alipay_name || '',
      alipay_pid: alipay_pid || '',
      alipay_app_id: alipay_app_id || '',
      alipay_private_key: alipay_private_key || '',
      alipay_type: alipay_type || 'personal'
    };
  } else if (type === 'wechat') {
    config = {
      wechat_account: wechat_account || '',
      wechat_name: wechat_name || '',
      wechat_mch_id: wechat_mch_id || '',
      wechat_api_key: wechat_api_key || '',
      wechat_app_id: wechat_app_id || '',
      wechat_type: wechat_type || 'personal'
    };
  } else if (type === 'other') {
    config = { merchant_id: merchant_id || '', api_key: api_key || '', extra: other_config || '' };
  }

  if (is_default) {
    const all = db.findAll('payment_accounts');
    all.forEach(a => db.update('payment_accounts', a.id, { is_default: 0 }));
  }

  db.insert('payment_accounts', {
    name, type, status: status || 'active', config: JSON.stringify(config),
    is_default: is_default ? 1 : 0, sort_order: parseInt(sort_order) || 0
  });

  res.redirect('/admin/payment-accounts');
});

router.post('/payment-accounts/:id/update', requireAuth, (req, res) => {
  const { name, type, status, is_default, sort_order, client_id, client_secret, mode,
    publishable_key, secret_key, webhook_secret, merchant_id, api_key, other_config,
    bank_region, bank_account_holder, bank_account_number, bank_name, bank_branch,
    bank_swift_code, bank_iban, bank_currency,
    usdt_network, usdt_currency, usdt_wallet_address, usdt_merchant_id, usdt_api_key,
    wise_email, wise_account_id, wise_currency, wise_api_key, wise_link,
    payoneer_email, payoneer_customer_id, payoneer_currency, payoneer_account_type,
    cashapp_cashtag, cashapp_email, cashapp_currency, cashapp_link,
    alipay_account, alipay_name, alipay_pid, alipay_app_id, alipay_private_key, alipay_type,
    wechat_account, wechat_name, wechat_mch_id, wechat_api_key, wechat_app_id, wechat_type,
    airwallex_client_id, airwallex_api_key, airwallex_webhook_secret, airwallex_currency
  } = req.body;

  let config = {};
  if (type === 'paypal') {
    config = { client_id: client_id || '', client_secret: client_secret || '', mode: mode || 'sandbox' };
  } else if (type === 'stripe') {
    config = { publishable_key: publishable_key || '', secret_key: secret_key || '', webhook_secret: webhook_secret || '' };
  } else if (type === 'airwallex') {
    config = {
      client_id: airwallex_client_id || '',
      api_key: airwallex_api_key || '',
      webhook_secret: airwallex_webhook_secret || '',
      currency: airwallex_currency || 'USD'
    };
  } else if (type === 'bank') {
    config = {
      bank_region: bank_region || 'domestic',
      bank_account_holder: bank_account_holder || '',
      bank_account_number: bank_account_number || '',
      bank_name: bank_name || '',
      bank_branch: bank_branch || '',
      bank_swift_code: bank_swift_code || '',
      bank_iban: bank_iban || '',
      bank_currency: bank_currency || 'USD'
    };
  } else if (type === 'usdt') {
    config = {
      usdt_network: usdt_network || 'trc20',
      usdt_currency: usdt_currency || 'USDT',
      usdt_wallet_address: usdt_wallet_address || '',
      usdt_merchant_id: usdt_merchant_id || '',
      usdt_api_key: usdt_api_key || ''
    };
  } else if (type === 'wise') {
    config = {
      wise_email: wise_email || '',
      wise_account_id: wise_account_id || '',
      wise_currency: wise_currency || 'USD',
      wise_api_key: wise_api_key || '',
      wise_link: wise_link || ''
    };
  } else if (type === 'payoneer') {
    config = {
      payoneer_email: payoneer_email || '',
      payoneer_customer_id: payoneer_customer_id || '',
      payoneer_currency: payoneer_currency || 'USD',
      payoneer_account_type: payoneer_account_type || 'receiving'
    };
  } else if (type === 'cashapp') {
    config = {
      cashapp_cashtag: cashapp_cashtag || '',
      cashapp_email: cashapp_email || '',
      cashapp_currency: cashapp_currency || 'USD',
      cashapp_link: cashapp_link || ''
    };
  } else if (type === 'alipay') {
    config = {
      alipay_account: alipay_account || '',
      alipay_name: alipay_name || '',
      alipay_pid: alipay_pid || '',
      alipay_app_id: alipay_app_id || '',
      alipay_private_key: alipay_private_key || '',
      alipay_type: alipay_type || 'personal'
    };
  } else if (type === 'wechat') {
    config = {
      wechat_account: wechat_account || '',
      wechat_name: wechat_name || '',
      wechat_mch_id: wechat_mch_id || '',
      wechat_api_key: wechat_api_key || '',
      wechat_app_id: wechat_app_id || '',
      wechat_type: wechat_type || 'personal'
    };
  } else if (type === 'other') {
    config = { merchant_id: merchant_id || '', api_key: api_key || '', extra: other_config || '' };
  }

  if (is_default) {
    const all = db.findAll('payment_accounts');
    all.forEach(a => db.update('payment_accounts', a.id, { is_default: 0 }));
  }

  db.update('payment_accounts', parseInt(req.params.id), {
    name, type, status: status || 'active', config: JSON.stringify(config),
    is_default: is_default ? 1 : 0, sort_order: parseInt(sort_order) || 0
  });

  res.redirect('/admin/payment-accounts');
});

router.post('/payment-accounts/:id/delete', requireAuth, (req, res) => {
  db.delete('payment_accounts', parseInt(req.params.id));
  res.redirect('/admin/payment-accounts');
});

// ===== Withdrawal Accounts Management (提款账户) =====
router.get('/withdrawal-accounts', requireAuth, (req, res) => {
  let accounts = db.findAll('withdrawal_accounts');
  accounts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  renderAdmin(res, 'withdrawal-accounts.html', { 
    accounts, pageTitle: '提款账户管理', sessionUserId: req.session.userId 
  });
});

router.post('/withdrawal-accounts/create', requireAuth, (req, res) => {
  const { name, type, account_holder, account_number, bank_name, bank_branch, swift_code, iban,
    paypal_email, wallet_address, currency, status, is_default, notes } = req.body;

  if (is_default) {
    const all = db.findAll('withdrawal_accounts');
    all.forEach(a => db.update('withdrawal_accounts', a.id, { is_default: 0 }));
  }

  db.insert('withdrawal_accounts', {
    name, type, account_holder: account_holder || '', account_number: account_number || '',
    bank_name: bank_name || '', bank_branch: bank_branch || '',
    swift_code: swift_code || '', iban: iban || '', paypal_email: paypal_email || '',
    wallet_address: wallet_address || '', currency: currency || 'USD',
    status: status || 'active', is_default: is_default ? 1 : 0, notes: notes || ''
  });

  res.redirect('/admin/withdrawal-accounts');
});

router.post('/withdrawal-accounts/:id/update', requireAuth, (req, res) => {
  const { name, type, account_holder, account_number, bank_name, bank_branch, swift_code, iban,
    paypal_email, wallet_address, currency, status, is_default, notes } = req.body;

  if (is_default) {
    const all = db.findAll('withdrawal_accounts');
    all.forEach(a => db.update('withdrawal_accounts', a.id, { is_default: 0 }));
  }

  db.update('withdrawal_accounts', parseInt(req.params.id), {
    name, type, account_holder: account_holder || '', account_number: account_number || '',
    bank_name: bank_name || '', bank_branch: bank_branch || '',
    swift_code: swift_code || '', iban: iban || '', paypal_email: paypal_email || '',
    wallet_address: wallet_address || '', currency: currency || 'USD',
    status: status || 'active', is_default: is_default ? 1 : 0, notes: notes || ''
  });

  res.redirect('/admin/withdrawal-accounts');
});

router.post('/withdrawal-accounts/:id/delete', requireAuth, (req, res) => {
  db.delete('withdrawal_accounts', parseInt(req.params.id));
  res.redirect('/admin/withdrawal-accounts');
});

// ===== Shipping / Logistics Management (物流管理) =====
router.get('/shipments', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 20;
  const status = req.query.status;

  let shipments = db.findAll('shipments');
  
  if (status && status !== 'all') {
    shipments = shipments.filter(s => s.status === status);
  }

  // Add order info
  shipments.forEach(s => {
    const order = db.findOne('orders', { id: s.order_id });
    s.order_number = order ? order.order_number : '';
    s.customer_name = order ? order.customer_name : '';
    s.customer_email = order ? order.customer_email : '';
    s.order_total = order ? order.total : 0;
  });

  shipments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const total = shipments.length;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;
  shipments = shipments.slice(offset, offset + perPage);

  renderAdmin(res, 'shipments.html', { 
    shipments, currentPage: page, totalPages, status: status || 'all',
    pageTitle: '物流管理', sessionUserId: req.session.userId 
  });
});

// Shipment detail
router.get('/shipments/:id', requireAuth, (req, res) => {
  const shipment = db.findOne('shipments', { id: parseInt(req.params.id) });
  
  if (!shipment) {
    return res.redirect('/admin/shipments');
  }

  const order = db.findOne('orders', { id: shipment.order_id });
  shipment.order_number = order ? order.order_number : '';
  shipment.customer_name = order ? order.customer_name : '';
  shipment.customer_email = order ? order.customer_email : '';
  shipment.order_total = order ? order.total : 0;

  const orderItems = db.findAll('order_items', { where: { order_id: shipment.order_id } });
  const trackingHistory = db.findAll('shipment_tracking', { where: { shipment_id: shipment.id } });
  trackingHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  renderAdmin(res, 'shipment-detail.html', { 
    shipment, orderItems, trackingHistory,
    pageTitle: '物流详情', sessionUserId: req.session.userId 
  });
});

// Update shipment
router.post('/shipments/:id/update', requireAuth, (req, res) => {
  const { tracking_number, carrier, shipping_method, status, estimated_delivery, notes } = req.body;

  const oldShipment = db.findOne('shipments', { id: parseInt(req.params.id) });
  
  const updateData = {
    tracking_number: tracking_number || '',
    carrier: carrier || '',
    shipping_method: shipping_method || '',
    status: status || 'pending',
    estimated_delivery: estimated_delivery || null,
    notes: notes || ''
  };

  if (status === 'shipped' && oldShipment.status !== 'shipped') {
    updateData.shipped_at = new Date().toISOString();
  }
  if (status === 'delivered' && oldShipment.status !== 'delivered') {
    updateData.delivered_at = new Date().toISOString();
  }

  db.update('shipments', parseInt(req.params.id), updateData);

  // Update order status
  if (shipment_status_matches(status, ['shipped', 'delivered'])) {
    db.update('orders', oldShipment.order_id, { status });
  }

  // Add tracking history if tracking number changed
  if (tracking_number && tracking_number !== oldShipment.tracking_number) {
    db.insert('shipment_tracking', {
      shipment_id: parseInt(req.params.id),
      status: status || 'updated',
      location: '',
      description: `Tracking number updated: ${tracking_number}`
    });
  }

  res.redirect('/admin/shipments/' + req.params.id);
});

// Add tracking event
router.post('/shipments/:id/tracking', requireAuth, (req, res) => {
  const { status, location, description } = req.body;
  
  db.insert('shipment_tracking', {
    shipment_id: parseInt(req.params.id),
    status: status || 'info',
    location: location || '',
    description: description || ''
  });

  res.redirect('/admin/shipments/' + req.params.id);
});

// ===== Settings =====
router.get('/settings', requireAuth, (req, res) => {
  renderAdmin(res, 'settings.html', { 
    pageTitle: 'Settings', sessionUserId: req.session.userId 
  });
});

router.post('/settings', requireAuth, (req, res) => {
  const allowedKeys = [
    'store_name', 'store_email', 'store_phone', 'store_address', 'store_currency',
    'store_currency_symbol', 'store_logo', 'store_favicon', 'store_description',
    'store_footer_text', 'social_facebook', 'social_twitter', 'social_instagram',
    'social_youtube', 'social_tiktok', 'homepage_title', 'homepage_banner',
    'free_shipping_threshold', 'flat_shipping_rate', 'tax_rate',
    'announcement_bar', 'announcement_enabled'
  ];

  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      db.setSetting(key, req.body[key]);
    }
  }

  renderAdmin(res, 'settings.html', { 
    pageTitle: 'Settings', sessionUserId: req.session.userId, saved: true 
  });
});

// ===== Change Password =====
router.get('/change-password', requireAuth, (req, res) => {
  renderAdmin(res, 'change-password.html', { 
    pageTitle: 'Change Password', sessionUserId: req.session.userId 
  });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  
  if (new_password !== confirm_password) {
    return renderAdmin(res, 'change-password.html', { 
      pageTitle: 'Change Password', sessionUserId: req.session.userId, error: 'New passwords do not match' 
    });
  }

  const user = db.findOne('users', { id: req.session.userId });
  if (!bcrypt.compareSync(current_password, user.password)) {
    return renderAdmin(res, 'change-password.html', { 
      pageTitle: 'Change Password', sessionUserId: req.session.userId, error: 'Current password is incorrect' 
    });
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.update('users', req.session.userId, { password: hashedPassword });

  renderAdmin(res, 'change-password.html', { 
    pageTitle: 'Change Password', sessionUserId: req.session.userId, success: true 
  });
});

// Helper functions
function safeParseArr(str) {
  try { 
    const arr = JSON.parse(str); 
    return Array.isArray(arr) ? arr : []; 
  } catch { 
    return []; 
  }
}

function shipment_status_matches(status, list) {
  return list.includes(status);
}

module.exports = router;
