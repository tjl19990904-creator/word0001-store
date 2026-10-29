const express = require('express');
const router = express.Router();
const db = require('../db/init');
const https = require('https');

// Airwallex API endpoints
const AIRWALLEX_API_BASE = process.env.NODE_ENV === 'production'
  ? 'https://api.airwallex.com'
  : 'https://api-demo.airwallex.com';

// Helper: get active Airwallex account config
function getAirwallexAccount() {
  const accounts = db.findAll('payment_accounts', { where: { status: 'active' } });
  return accounts.find(a => a.type === 'airwallex' && a.config_data && a.config_data.client_id && a.config_data.api_key);
}

// Helper: get settings
function getSettings() {
  return db.getAllSettings();
}

// Helper: make HTTPS request (returns Promise)
function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Helper: get Airwallex access token
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const account = getAirwallexAccount();
  if (!account) {
    throw new Error('Airwallex account not configured');
  }

  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const { client_id, api_key } = account.config_data;

  const options = {
    hostname: AIRWALLEX_API_BASE.replace('https://', ''),
    path: '/api/v1/authentication/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': client_id,
      'x-api-key': api_key
    }
  };

  const response = await makeRequest(options, {});

  if (response.statusCode !== 200 && response.statusCode !== 201) {
    console.error('Airwallex auth error:', response.statusCode, response.body);
    throw new Error(`Airwallex authentication failed: ${response.body.message || response.body}`);
  }

  cachedToken = response.body.token;
  // Token expires in ~30 min, refresh at 25 min
  tokenExpiry = Date.now() + (25 * 60 * 1000);

  return cachedToken;
}

// ===== Create Airwallex Payment Intent =====
router.post('/create-payment-intent', async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) {
    return res.status(400).json({ success: false, error: 'Cart is empty' });
  }

  const account = getAirwallexAccount();
  if (!account) {
    return res.status(400).json({ success: false, error: 'Airwallex is not configured. Please contact the store administrator.' });
  }

  try {
    const token = await getAccessToken();

    const settings = getSettings();

    // Build cart items and calculate total
    let subtotal = 0;
    const items = cart.map(item => {
      const product = db.findOne('products', { id: item.productId });
      if (product) {
        const lineTotal = product.price * item.quantity;
        subtotal += lineTotal;
        return {
          name: product.name,
          sku: product.sku || String(product.id),
          quantity: item.quantity,
          unit_price: {
            value: parseFloat(product.price).toFixed(2),
            currency: 'USD'
          },
          total_price: {
            value: lineTotal.toFixed(2),
            currency: 'USD'
          },
          image_url: product.image_list && product.image_list.length > 0
            ? (product.image_list[0].startsWith('http')
              ? product.image_list[0]
              : (process.env.NODE_ENV === 'production' ? 'https://word0001.com' : '') + product.image_list[0])
            : undefined
        };
      }
      return null;
    }).filter(item => item !== null);

    if (items.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid items in cart' });
    }

    // Calculate shipping
    const freeShipThreshold = parseFloat(settings.free_shipping_threshold || 50);
    const flatRate = parseFloat(settings.flat_shipping_rate || 5.99);
    const shippingCost = subtotal >= freeShipThreshold ? 0 : flatRate;
    const total = subtotal + shippingCost;

    // Create order record
    const orderNumber = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const { email, phone, firstName, lastName, address, city, state, zip, country, notes } = req.body;
    const customerName = `${firstName || ''} ${lastName || ''}`.trim();
    const shippingAddress = `${address || ''}, ${city || ''}, ${state || ''} ${zip || ''}, ${country || 'United States'}`;

    const orderResult = db.insert('orders', {
      order_number: orderNumber,
      customer_email: email || '',
      customer_phone: phone || '',
      customer_name: customerName,
      shipping_address: shippingAddress,
      shipping_city: city || '',
      shipping_state: state || '',
      shipping_zip: zip || '',
      shipping_country: country || 'United States',
      shipping_method: 'Standard Shipping',
      shipping_cost: shippingCost,
      subtotal: subtotal,
      tax: 0,
      total: total,
      status: 'pending',
      payment_status: 'unpaid',
      payment_method: 'airwallex',
      payment_account_id: account.id,
      notes: notes || '',
      transaction_id: ''
    });

    const orderId = orderResult.lastInsertRowid;

    // Insert order items
    cart.forEach(item => {
      const product = db.findOne('products', { id: item.productId });
      if (product) {
        db.insert('order_items', {
          order_id: orderId,
          product_id: product.id,
          product_name: product.name,
          product_image: product.primary_image || '',
          price: product.price,
          quantity: item.quantity,
          total: product.price * item.quantity
        });
      }
    });

    // Create shipment record
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

    // Determine base URL
    const baseUrl = process.env.NODE_ENV === 'production'
      ? 'https://word0001.com'
      : `http://localhost:${process.env.PORT || 3000}`;

    // Create Airwallex PaymentIntent
    const paymentIntentBody = JSON.stringify({
      request_id: `${orderId}-${Date.now()}`,
      amount: parseFloat(total).toFixed(2),
      currency: 'USD',
      merchant_order_id: orderNumber,
      order: {
        type: 'physical_goods',
        products: items
      },
      return_url: `${baseUrl}/payment/airwallex-success?order=${orderNumber}`,
      descriptor: settings.store_name || 'Word0001 Store'
    });

    const createIntentOptions = {
      hostname: AIRWALLEX_API_BASE.replace('https://', ''),
      path: '/api/v1/pa/payment_intents/create',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-client-id': account.config_data.client_id
      }
    };

    const intentResponse = await makeRequest(createIntentOptions, paymentIntentBody);

    if (intentResponse.statusCode !== 200 && intentResponse.statusCode !== 201) {
      console.error('Airwallex create intent error:', intentResponse.statusCode, intentResponse.body);
      // Update order status to reflect failure
      db.update('orders', orderId, {
        payment_status: 'failed',
        status: 'payment_failed'
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to create payment intent',
        details: intentResponse.body.message || JSON.stringify(intentResponse.body)
      });
    }

    const intent = intentResponse.body;
    const intentId = intent.id;
    const clientSecret = intent.client_secret;

    // Update order with intent ID
    db.update('orders', orderId, {
      transaction_id: intentId,
      payment_status: 'pending'
    });

    // Build the Airwallex Hosted Payment Page URL
    // We use redirectToCheckout flow: client loads Airwallex.js and redirects
    // For simplicity, we return the intent ID + client_secret and let the frontend handle the redirect
    res.json({
      success: true,
      intentId: intentId,
      clientSecret: clientSecret,
      orderId: orderId,
      orderNumber: orderNumber,
      amount: total.toFixed(2),
      currency: 'USD',
      returnUrl: `${baseUrl}/payment/airwallex-success?order=${orderNumber}`
    });

  } catch (err) {
    console.error('Airwallex payment intent error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'An error occurred creating the payment session'
    });
  }
});

// ===== Airwallex Success Page =====
router.get('/airwallex-success', (req, res) => {
  const orderNumber = req.query.order;

  let order = null;
  let orderItems = [];
  let isPaid = false;

  if (orderNumber) {
    order = db.findOne('orders', { order_number: orderNumber });
    if (order) {
      orderItems = db.findAll('order_items', { where: { order_id: order.id } });

      // Verify payment status via Airwallex API
      const account = getAirwallexAccount();
      if (account && order.transaction_id) {
        getAccessToken().then(token => {
          const options = {
            hostname: AIRWALLEX_API_BASE.replace('https://', ''),
            path: `/api/v1/pa/payment_intents/${order.transaction_id}`,
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'x-client-id': account.config_data.client_id
            }
          };
          return makeRequest(options);
        }).then(response => {
          if (response.statusCode === 200) {
            const intent = response.body;
            const status = intent.status || '';
            if (status === 'SUCCEEDED' || status === 'REQUIRES_CAPTURE') {
              isPaid = true;
              db.update('orders', order.id, {
                payment_status: 'paid',
                status: 'processing'
              });
            }
          }

          req.session.cart = [];
          renderAirwallexSuccessPage(res, order, orderItems, isPaid);
        }).catch(err => {
          console.error('Airwallex verify error:', err);
          req.session.cart = [];
          renderAirwallexSuccessPage(res, order, orderItems, false);
        });
        return;
      }
    }
  }

  req.session.cart = [];
  renderAirwallexSuccessPage(res, order, orderItems, false);
});

function renderAirwallexSuccessPage(res, order, orderItems, isPaid) {
  const fs = require('fs');
  const path = require('path');
  const settings = getSettings();
  const templatePath = path.join(__dirname, '..', 'views', 'payment-success.html');

  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
      return settings[key] !== undefined ? String(settings[key]) : '';
    });
    html = html.replace(/\{\{data\.(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const parts = key.split('.');
      let val = { order, orderItems, isPaid };
      for (const part of parts) { val = val ? val[part] : undefined; }
      return val !== undefined && val !== null ? String(val) : '';
    });
    html = html.replace(/\{\{data:json:(\w+)\}\}/g, (match, key) => {
      const data = { order, orderItems, isPaid };
      const val = data[key];
      return val !== undefined ? JSON.stringify(val) : '[]';
    });
    html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const data = { order, orderItems, isPaid, settings };
      return data[key] !== undefined ? String(data[key]) : '';
    });
    res.send(html);
  } else {
    res.send(`<h1>Payment ${isPaid ? 'Successful' : 'Processing'}</h1><p>Order: ${order ? order.order_number : 'N/A'}</p><a href="/">Continue Shopping</a>`);
  }
}

// ===== Airwallex Webhook =====
router.post('/airwallex-webhook', (req, res) => {
  const account = getAirwallexAccount();
  if (!account) {
    return res.status(400).send('Airwallex not configured');
  }

  try {
    const event = req.body;
    const eventType = event.name || event.type || '';

    console.log('Airwallex webhook received:', eventType);

    switch (eventType) {
      case 'payment_intent.succeeded':
      case 'payment_intent.succeeded.v2': {
        const intent = event.data && event.data.object ? event.data.object : event.data;
        const orderNumber = intent && intent.merchant_order_id;

        if (orderNumber) {
          const order = db.findOne('orders', { order_number: orderNumber });
          if (order) {
            db.update('orders', order.id, {
              payment_status: 'paid',
              status: 'processing',
              transaction_id: intent.id || order.transaction_id
            });
          }
        }
        break;
      }
      case 'payment_intent.failed':
      case 'payment_intent.failed.v2': {
        const intent = event.data && event.data.object ? event.data.object : event.data;
        const orderNumber = intent && intent.merchant_order_id;

        if (orderNumber) {
          const order = db.findOne('orders', { order_number: orderNumber });
          if (order) {
            db.update('orders', order.id, {
              payment_status: 'failed',
              status: 'payment_failed'
            });
          }
        }
        break;
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Airwallex webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
