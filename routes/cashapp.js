const express = require('express');
const router = express.Router();
const db = require('../db/init');
const https = require('https');

// Helper: get active Cash App account config
function getCashAppAccount() {
  const accounts = db.findAll('payment_accounts', { where: { status: 'active' } });
  return accounts.find(a => a.type === 'cashapp' && a.config_data && a.config_data.square_app_id && a.config_data.square_access_token);
}

// Helper: get settings
function getSettings() {
  return db.getAllSettings();
}

// Helper: make HTTPS request to Square API
function squareRequest(method, path, body, accessToken) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'connect.squareupsandbox.com',
      // For production: hostname: 'connect.squareup.com',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Square-Version': '2024-12-18'
      }
    };

    if (data) {
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: responseBody });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (data) {
      req.write(data);
    }
    req.end();
  });
}

// ===== Create Cash App Payment (Server-side payment creation) =====
// This endpoint creates a Square payment using the token generated client-side
router.post('/create-payment', async (req, res) => {
  try {
    const cart = req.session.cart || [];
    if (cart.length === 0) {
      return res.status(400).json({ success: false, error: 'Cart is empty' });
    }

    // Get Cash App account with Square config
    const cashAppAccount = getCashAppAccount();
    if (!cashAppAccount) {
      return res.status(400).json({ success: false, error: 'Cash App is not configured. Please contact the store administrator.' });
    }

    const config = cashAppAccount.config_data;
    const accessToken = config.square_access_token;
    const locationId = config.square_location_id;
    const isProduction = config.square_environment === 'production';
    const apiHost = isProduction ? 'connect.squareup.com' : 'connect.squareupsandbox.com';

    const settings = getSettings();
    const storeName = settings.store_name || 'Word0001 Store';

    // Calculate total from cart
    let subtotal = 0;
    const orderItems = [];
    cart.forEach(item => {
      const product = db.findOne('products', { id: item.productId });
      if (product) {
        const lineTotal = product.price * item.quantity;
        subtotal += lineTotal;
        orderItems.push({ product, quantity: item.quantity, lineTotal });
      }
    });

    if (orderItems.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid items in cart' });
    }

    // Calculate shipping
    const freeShipThreshold = parseFloat(settings.free_shipping_threshold || 50);
    const flatRate = parseFloat(settings.flat_shipping_rate || 5.99);
    const shippingCost = subtotal >= freeShipThreshold ? 0 : flatRate;
    const total = subtotal + shippingCost;

    // Square uses cents
    const totalCents = Math.round(total * 100);

    // Create order record first
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
      payment_method: 'cashapp',
      payment_account_id: cashAppAccount.id,
      notes: notes || '',
      transaction_id: ''
    });

    const orderId = orderResult.lastInsertRowid;

    // Insert order items
    orderItems.forEach(item => {
      db.insert('order_items', {
        order_id: orderId,
        product_id: item.product.id,
        product_name: item.product.name,
        product_image: item.product.primary_image || '',
        price: item.product.price,
        quantity: item.quantity,
        total: item.lineTotal
      });
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

    // Create Square Order (required for Cash App Pay)
    const squareOrderData = {
      order: {
        location_id: locationId,
        line_items: orderItems.map(item => ({
          name: item.product.name,
          quantity: String(item.quantity),
          base_price_money: {
            amount: Math.round(item.product.price * 100),
            currency: config.cashapp_currency || 'USD'
          }
        })),
        fulfillments: [{
          type: 'SHIPMENT',
          shipment_details: {
            recipient: {
              display_name: customerName,
              email_address: email || '',
              phone_number: phone || ''
            },
            shipping_address: {
              address_line_1: address || '',
              locality: city || '',
              administrative_district_level_1: state || '',
              postal_code: zip || '',
              country: (country || 'US').substring(0, 2).toUpperCase()
            }
          }
        }]
      },
      idempotency_key: orderNumber + '-order'
    };

    // Add shipping as a line item if not free
    if (shippingCost > 0) {
      squareOrderData.order.line_items.push({
        name: 'Shipping (Standard)',
        quantity: '1',
        base_price_money: {
          amount: Math.round(shippingCost * 100),
          currency: config.cashapp_currency || 'USD'
        }
      });
    }

    // Create Square Order
    const orderResponse = await new Promise((resolve, reject) => {
      const data = JSON.stringify(squareOrderData);
      const options = {
        hostname: apiHost,
        port: 443,
        path: '/v2/orders',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
          'Square-Version': '2024-12-18',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const sqReq = https.request(options, (sqRes) => {
        let body = '';
        sqRes.on('data', chunk => body += chunk);
        sqRes.on('end', () => {
          try {
            resolve({ statusCode: sqRes.statusCode, body: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: sqRes.statusCode, body: body });
          }
        });
      });

      sqReq.on('error', reject);
      sqReq.write(data);
      sqReq.end();
    });

    if (orderResponse.statusCode !== 200 || !orderResponse.body.order) {
      console.error('Square order creation failed:', orderResponse.body);
      return res.status(500).json({
        success: false,
        error: 'Failed to create Square order',
        details: orderResponse.body.errors ? JSON.stringify(orderResponse.body.errors) : 'Unknown error'
      });
    }

    const squareOrderId = orderResponse.body.order.id;
    const squareOrderVersion = orderResponse.body.order.version;

    // Store Square order ID in transaction_id
    db.update('orders', orderId, {
      transaction_id: squareOrderId
    });

    // Return data for client-side Cash App Pay
    res.json({
      success: true,
      orderId: String(orderId),
      orderNumber: orderNumber,
      squareOrderId: squareOrderId,
      squareOrderVersion: squareOrderVersion,
      locationId: locationId,
      appId: config.square_app_id,
      environment: isProduction ? 'production' : 'sandbox',
      totalCents: totalCents,
      currency: config.cashapp_currency || 'USD',
      returnUrl: baseUrl + '/payment/cashapp-success?order=' + orderNumber + '&square_order_id=' + squareOrderId,
      cancelUrl: baseUrl + '/payment/cancel?order=' + orderNumber
    });
  } catch (err) {
    console.error('Cash App payment creation error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to create payment session. Please try again.',
      details: err.message
    });
  }
});

// ===== Confirm Cash App Payment (after client-side token is generated) =====
router.post('/confirm-payment', async (req, res) => {
  try {
    const { orderId, paymentToken, squareOrderId } = req.body;

    if (!orderId || !paymentToken || !squareOrderId) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const order = db.findOne('orders', { id: parseInt(orderId) });
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const cashAppAccount = getCashAppAccount();
    if (!cashAppAccount) {
      return res.status(400).json({ success: false, error: 'Cash App not configured' });
    }

    const config = cashAppAccount.config_data;
    const accessToken = config.square_access_token;
    const locationId = config.square_location_id;
    const isProduction = config.square_environment === 'production';
    const apiHost = isProduction ? 'connect.squareup.com' : 'connect.squareupsandbox.com';

    // Create Square Payment with the token from Cash App Pay
    const paymentData = {
      source_id: paymentToken,
      idempotency_key: order.order_number + '-pay',
      amount_money: {
        amount: Math.round(order.total * 100),
        currency: config.cashapp_currency || 'USD'
      },
      order_id: squareOrderId,
      location_id: locationId,
      cash_details: {
        buyer_supplied_money: {
          amount: Math.round(order.total * 100),
          currency: config.cashapp_currency || 'USD'
        }
      }
    };

    const paymentResponse = await new Promise((resolve, reject) => {
      const data = JSON.stringify(paymentData);
      const options = {
        hostname: apiHost,
        port: 443,
        path: '/v2/payments',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
          'Square-Version': '2024-12-18',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const payReq = https.request(options, (payRes) => {
        let body = '';
        payRes.on('data', chunk => body += chunk);
        payRes.on('end', () => {
          try {
            resolve({ statusCode: payRes.statusCode, body: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: payRes.statusCode, body: body });
          }
        });
      });

      payReq.on('error', reject);
      payReq.write(data);
      payReq.end();
    });

    if (paymentResponse.statusCode === 200 && paymentResponse.body.payment) {
      const payment = paymentResponse.body.payment;

      // Update order status
      db.update('orders', parseInt(orderId), {
        payment_status: 'paid',
        status: 'processing',
        transaction_id: payment.id
      });

      // Clear cart
      req.session.cart = [];

      res.json({
        success: true,
        paymentId: payment.id,
        paymentStatus: payment.status,
        orderId: String(orderId),
        orderNumber: order.order_number
      });
    } else {
      console.error('Square payment failed:', paymentResponse.body);
      // Update order to failed
      db.update('orders', parseInt(orderId), {
        payment_status: 'failed'
      });

      res.status(400).json({
        success: false,
        error: 'Payment failed',
        details: paymentResponse.body.errors ? JSON.stringify(paymentResponse.body.errors) : 'Unknown error'
      });
    }
  } catch (err) {
    console.error('Cash App confirm payment error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to confirm payment',
      details: err.message
    });
  }
});

// ===== Cash App Payment Success Page =====
router.get('/cashapp-success', (req, res) => {
  const orderNumber = req.query.order;
  const squareOrderId = req.query.square_order_id;

  let order = null;
  let orderItems = [];

  if (orderNumber) {
    order = db.findOne('orders', { order_number: orderNumber });
    if (order) {
      orderItems = db.findAll('order_items', { where: { order_id: order.id } });
      // Order status should already be updated by confirm-payment endpoint
    }
  }

  req.session.cart = [];

  const fs = require('fs');
  const path = require('path');
  const settings = getSettings();
  const templatePath = path.join(__dirname, '..', 'views', 'payment-success.html');

  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
      return settings[key] !== undefined ? String(settings[key]) : '';
    });
    html = html.replace(/\{\{data:json:(\w+)\}\}/g, (match, key) => {
      const data = { order, orderItems, isPaid: order && order.payment_status === 'paid' };
      const val = data[key];
      return val !== undefined ? JSON.stringify(val) : '[]';
    });
    html = html.replace(/\{\{data\.(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const parts = key.split('.');
      let val = { order, orderItems, isPaid: order && order.payment_status === 'paid' };
      for (const part of parts) { val = val ? val[part] : undefined; }
      return val !== undefined && val !== null ? String(val) : '';
    });
    html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const data = { order, orderItems, isPaid: order && order.payment_status === 'paid', settings };
      return data[key] !== undefined ? String(data[key]) : '';
    });
    res.send(html);
  } else {
    const isPaid = order && order.payment_status === 'paid';
    res.send(`
      <h1>Payment ${isPaid ? 'Successful' : 'Processing'}</h1>
      <p>Order: ${order ? order.order_number : 'N/A'}</p>
      <p>Thank you for your purchase!</p>
      <a href="/">Continue Shopping</a>
    `);
  }
});

// ===== Square Webhook (for payment confirmation) =====
router.post('/square-webhook', (req, res) => {
  try {
    const event = req.body;

    // Handle payment events
    if (event.type === 'payment.updated' || event.type === 'payment.created') {
      const payment = event.data.object.payment;
      if (payment && payment.status === 'COMPLETED') {
        // Find order by transaction_id (Square payment ID)
        const order = db.findOne('orders', { transaction_id: payment.id });
        if (order && order.payment_status !== 'paid') {
          db.update('orders', order.id, {
            payment_status: 'paid',
            status: 'processing'
          });
        }
      } else if (payment && payment.status === 'FAILED') {
        const order = db.findOne('orders', { transaction_id: payment.id });
        if (order) {
          db.update('orders', order.id, {
            payment_status: 'failed'
          });
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Square webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
