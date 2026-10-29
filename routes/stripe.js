const express = require('express');
const router = express.Router();
const db = require('../db/init');
const stripe = require('stripe');

// Helper: get active Stripe account config
function getStripeAccount() {
  const accounts = db.findAll('payment_accounts', { where: { status: 'active' } });
  return accounts.find(a => a.type === 'stripe' && a.config_data && a.config_data.secret_key);
}

// Helper: get settings
function getSettings() {
  return db.getAllSettings();
}

// ===== Create Stripe Checkout Session =====
router.post('/create-checkout-session', (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) {
    return res.redirect('/cart');
  }

  // Get Stripe account with valid secret key
  const stripeAccount = getStripeAccount();
  if (!stripeAccount) {
    return res.status(400).send('Stripe is not configured. Please contact the store administrator.');
  }

  const stripeSecretKey = stripeAccount.config_data.secret_key;
  const stripePublishableKey = stripeAccount.config_data.publishable_key;
  const stripeClient = stripe(stripeSecretKey);

  const settings = getSettings();
  const storeName = settings.store_name || 'Word0001 Store';

  // Build line items from cart
  let subtotal = 0;
  const lineItems = cart.map(item => {
    const product = db.findOne('products', { id: item.productId });
    if (product) {
      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            images: product.image_list ? (typeof product.image_list === 'string' ? JSON.parse(product.image_list) : product.image_list).map(img => {
              if (img.startsWith('http')) return img;
              return (process.env.NODE_ENV === 'production' ? 'https://word0001.com' : '') + img;
            }).filter(Boolean) : []
          },
          unit_amount: Math.round(product.price * 100) // Stripe uses cents
        },
        quantity: item.quantity
      };
    }
    return null;
  }).filter(item => item !== null);

  if (lineItems.length === 0) {
    return res.redirect('/cart');
  }

  // Calculate shipping
  const freeShipThreshold = parseFloat(settings.free_shipping_threshold || 50);
  const flatRate = parseFloat(settings.flat_shipping_rate || 5.99);
  const shippingCost = subtotal >= freeShipThreshold ? 0 : flatRate;

  // Add shipping as a line item if not free
  if (shippingCost > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Shipping (Standard)'
        },
        unit_amount: Math.round(shippingCost * 100)
      },
      quantity: 1
    });
  }

  // Calculate total for order record
  const total = subtotal + shippingCost;

  // Create a pending order record
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
    payment_method: 'stripe',
    payment_account_id: stripeAccount.id,
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

  // Create Stripe Checkout Session
  stripeClient.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: lineItems,
    mode: 'payment',
    success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}&order=${orderNumber}`,
    cancel_url: `${baseUrl}/payment/cancel?order=${orderNumber}`,
    customer_email: email || undefined,
    metadata: {
      order_id: String(orderId),
      order_number: orderNumber
    },
    shipping_address_collection: {
      allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'JP', 'CN', 'SG', 'AE']
    }
  }).then(session => {
    // Store session ID in order
    db.update('orders', orderId, {
      transaction_id: session.id,
      payment_status: 'pending'
    });

    // Return session URL for redirect
    res.json({
      success: true,
      url: session.url,
      sessionId: session.id
    });
  }).catch(err => {
    console.error('Stripe Checkout Session error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to create payment session. Please try again or contact support.',
      details: err.message
    });
  });
});

// ===== Payment Success Page =====
router.get('/success', (req, res) => {
  const sessionId = req.query.session_id;
  const orderNumber = req.query.order;

  let order = null;
  let orderItems = [];

  if (orderNumber) {
    order = db.findOne('orders', { order_number: orderNumber });
    if (order) {
      orderItems = db.findAll('order_items', { where: { order_id: order.id } });

      // If we have a session ID, verify payment status
      if (sessionId) {
        const stripeAccount = getStripeAccount();
        if (stripeAccount && stripeAccount.config_data.secret_key) {
          const stripeClient = stripe(stripeAccount.config_data.secret_key);
          stripeClient.checkout.sessions.retrieve(sessionId).then(session => {
            if (session.payment_status === 'paid') {
              db.update('orders', order.id, {
                payment_status: 'paid',
                status: 'processing',
                transaction_id: session.id
              });
            }

            // Clear cart
            req.session.cart = [];

            // Render success page
            renderSuccessPage(res, order, orderItems, session.payment_status === 'paid');
          }).catch(err => {
            console.error('Stripe session retrieve error:', err);
            req.session.cart = [];
            renderSuccessPage(res, order, orderItems, false);
          });
          return;
        }
      }
    }
  }

  req.session.cart = [];
  renderSuccessPage(res, order, orderItems, false);
});

function renderSuccessPage(res, order, orderItems, isPaid) {
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
    res.send(`
      <h1>Payment ${isPaid ? 'Successful' : 'Processing'}</h1>
      <p>Order: ${order ? order.order_number : 'N/A'}</p>
      <p>Thank you for your purchase!</p>
      <a href="/">Continue Shopping</a>
    `);
  }
}

// ===== Payment Cancel Page =====
router.get('/cancel', (req, res) => {
  const orderNumber = req.query.order;
  if (orderNumber) {
    const order = db.findOne('orders', { order_number: orderNumber });
    if (order) {
      db.update('orders', order.id, {
        payment_status: 'cancelled',
        status: 'cancelled'
      });
    }
  }

  const fs = require('fs');
  const path = require('path');
  const settings = getSettings();
  const templatePath = path.join(__dirname, '..', 'views', 'payment-cancel.html');

  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
      return settings[key] !== undefined ? String(settings[key]) : '';
    });
    html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return settings[key] !== undefined ? String(settings[key]) : '';
    });
    res.send(html);
  } else {
    res.send(`
      <h1>Payment Cancelled</h1>
      <p>Your payment was cancelled. You can try again anytime.</p>
      <a href="/cart">Return to Cart</a> | <a href="/">Continue Shopping</a>
    `);
  }
});

// ===== Stripe Webhook (for payment confirmation) =====
router.post('/webhook', (req, res) => {
  const stripeAccount = getStripeAccount();
  if (!stripeAccount || !stripeAccount.config_data.webhook_secret) {
    return res.status(400).send('Webhook secret not configured');
  }

  const stripeClient = stripe(stripeAccount.config_data.secret_key);
  const sig = req.headers['stripe-signature'];
  let event;

  // Use raw body stored by express.json verify callback
  const rawBody = req.rawBody || JSON.stringify(req.body);

  try {
    event = stripeClient.webhooks.constructEvent(
      rawBody,
      sig,
      stripeAccount.config_data.webhook_secret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const orderId = session.metadata ? session.metadata.order_id : null;
      const orderNumber = session.metadata ? session.metadata.order_number : null;

      if (orderId && orderNumber) {
        const order = db.findOne('orders', { id: parseInt(orderId) });
        if (order) {
          db.update('orders', order.id, {
            payment_status: 'paid',
            status: 'processing',
            transaction_id: session.id
          });
        }
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      console.error('Payment failed:', paymentIntent.id);
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
