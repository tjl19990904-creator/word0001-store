// Simple JSON-based database (no native dependencies required)
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'store.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Default database structure
const defaultDb = {
  users: [],
  categories: [],
  products: [],
  customers: [],
  orders: [],
  order_items: [],
  payment_accounts: [],
  withdrawal_accounts: [],
  shipments: [],
  shipment_tracking: [],
  settings: {},
  counters: {
    users: 0, categories: 0, products: 0, customers: 0,
    orders: 0, order_items: 0, payment_accounts: 0,
    withdrawal_accounts: 0, shipments: 0, shipment_tracking: 0
  }
};

// Load or initialize database
let db;
if (fs.existsSync(dbFile)) {
  db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  // Ensure all keys exist
  for (const key of Object.keys(defaultDb)) {
    if (db[key] === undefined) db[key] = defaultDb[key];
  }
} else {
  db = JSON.parse(JSON.stringify(defaultDb));
}

// ===== Save function =====
function save() {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
}

// ===== Query helpers =====
const dbWrapper = {
  // Insert: { table, data } -> returns { lastInsertRowid }
  insert(table, data) {
    const id = (db.counters[table] || 0) + 1;
    db.counters[table] = id;
    const row = { id, ...data, created_at: data.created_at || new Date().toISOString() };
    if (!db[table]) db[table] = [];
    db[table].push(row);
    save();
    return { lastInsertRowid: id };
  },

  // Update: { table, id, data }
  update(table, id, data) {
    if (!db[table]) return { changes: 0 };
    const idx = db[table].findIndex(r => r.id == id);
    if (idx === -1) return { changes: 0 };
    db[table][idx] = { ...db[table][idx], ...data, updated_at: new Date().toISOString() };
    save();
    return { changes: 1 };
  },

  // Delete: { table, id }
  delete(table, id) {
    if (!db[table]) return { changes: 0 };
    const before = db[table].length;
    db[table] = db[table].filter(r => r.id != id);
    const changes = before - db[table].length;
    if (changes > 0) save();
    return { changes };
  },

  // Find one: { table, where: {key: val, ...} }
  findOne(table, where = {}) {
    if (!db[table]) return null;
    return db[table].find(row => {
      for (const [key, val] of Object.entries(where)) {
        if (row[key] != val) return false;
      }
      return true;
    }) || null;
  },

  // Find all: { table, where: {}, orderBy, limit, offset }
  findAll(table, options = {}) {
    if (!db[table]) return [];
    let results = db[table];
    
    if (options.where) {
      results = results.filter(row => {
        for (const [key, val] of Object.entries(options.where)) {
          if (row[key] != val) return false;
        }
        return true;
      });
    }
    
    if (options.orderBy) {
      const [field, dir] = options.orderBy.split(' ');
      results.sort((a, b) => {
        if (a[field] === undefined) return 1;
        if (b[field] === undefined) return -1;
        const av = a[field], bv = b[field];
        if (typeof av === 'string') {
          return dir === 'DESC' ? bv.localeCompare(av) : av.localeCompare(bv);
        }
        return dir === 'DESC' ? (bv || 0) - (av || 0) : (av || 0) - (bv || 0);
      });
    }
    
    if (options.offset) results = results.slice(options.offset);
    if (options.limit) results = results.slice(0, options.limit);
    
    return results;
  },

  // Count
  count(table, where = {}) {
    if (!db[table]) return 0;
    if (Object.keys(where).length === 0) return db[table].length;
    return db[table].filter(row => {
      for (const [key, val] of Object.entries(where)) {
        if (row[key] != val) return false;
      }
      return true;
    }).length;
  },

  // Sum
  sum(table, field, where = {}) {
    if (!db[table]) return 0;
    return db[table].filter(row => {
      for (const [key, val] of Object.entries(where)) {
        if (row[key] != val) return false;
      }
      return true;
    }).reduce((sum, row) => sum + (parseFloat(row[field]) || 0), 0);
  },

  // Get settings
  getSetting(key) {
    return db.settings[key];
  },

  // Set setting
  setSetting(key, value) {
    db.settings[key] = value;
    save();
  },

  // Get all settings
  getAllSettings() {
    return { ...db.settings };
  },

  // Raw access to db object
  raw: db,

  // Save
  save,

  // Get next ID
  nextId(table) {
    return (db.counters[table] || 0) + 1;
  }
};

// ===== Seed Default Data =====
function seedData() {
  // Default admin
  if (db.users.length === 0) {
    const hashedPassword = bcrypt.hashSync('admin123456', 10);
    dbWrapper.insert('users', {
      username: 'admin',
      password: hashedPassword,
      email: 'admin@word0001.com',
      role: 'admin'
    });
  }

  // Default settings
  const defaultSettings = {
    store_name: 'Word0001 Store',
    store_email: 'support@word0001.com',
    store_phone: '',
    store_address: '',
    store_currency: 'USD',
    store_currency_symbol: '$',
    store_logo: '',
    store_favicon: '',
    store_description: 'Your trusted online store for quality products.',
    store_footer_text: '\u00a9 2026 Word0001 Store. All rights reserved.',
    social_facebook: '',
    social_twitter: '',
    social_instagram: '',
    social_youtube: '',
    social_tiktok: '',
    homepage_title: 'Welcome to Word0001 Store',
    homepage_banner: '',
    free_shipping_threshold: '50',
    flat_shipping_rate: '5.99',
    tax_rate: '0',
    announcement_bar: 'Free shipping on orders over $50!',
    announcement_enabled: '1'
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    if (db.settings[key] === undefined) {
      db.settings[key] = value;
    }
  }

  // Default categories
  if (db.categories.length === 0) {
    dbWrapper.insert('categories', { name: 'Featured', description: 'Featured products', sort_order: 1 });
    dbWrapper.insert('categories', { name: 'New Arrivals', description: 'Latest products', sort_order: 2 });
    dbWrapper.insert('categories', { name: 'Best Sellers', description: 'Most popular products', sort_order: 3 });
    dbWrapper.insert('categories', { name: 'Accessories', description: 'Accessory products', sort_order: 4 });
  }

  // Default payment accounts
  if (db.payment_accounts.length === 0) {
    dbWrapper.insert('payment_accounts', {
      name: 'PayPal', type: 'paypal', status: 'active',
      config: JSON.stringify({ client_id: '', client_secret: '', mode: 'sandbox' }),
      is_default: 1, sort_order: 1
    });
    dbWrapper.insert('payment_accounts', {
      name: 'Stripe', type: 'stripe', status: 'active',
      config: JSON.stringify({ publishable_key: '', secret_key: '', webhook_secret: '' }),
      is_default: 0, sort_order: 2
    });
  }

  // Default sample products
  if (db.products.length === 0) {
    const sampleProducts = [
      { name: 'Handmade Crystal Healing Bracelet', price: 29.99, compare_price: 49.99, short_description: 'Beautiful handmade crystal bracelet for meditation and healing.', description: 'This exquisite handmade crystal healing bracelet is crafted with natural amethyst and clear quartz crystals. Each bead is carefully selected and strung to create a beautiful piece that not only looks stunning but also promotes positive energy and well-being.\n\nFeatures:\n- Natural amethyst and clear quartz crystals\n- Adjustable elastic band\n- Handcrafted with care\n- Comes with a gift box', stock: 100, category_id: 1, sku: 'CRYSTAL-BR-001', status: 'active', featured: 1, images: '[]', weight: 0.05, dimensions: 'Adjustable', sort_order: 1 },
      { name: 'Natural Desert Rose Crystal Cluster', price: 39.99, compare_price: null, short_description: 'Raw desert rose selenite crystal for home decoration.', description: 'A stunning natural desert rose selenite crystal cluster. Each piece is unique and formed naturally in desert environments. Perfect for crystal collectors, home decoration, or as a thoughtful gift.\n\nFeatures:\n- 100% natural formation\n- Unique desert rose shape\n- Approximately 0.25kg\n- Great for display or healing', stock: 50, category_id: 1, sku: 'CRYSTAL-DR-002', status: 'active', featured: 1, images: '[]', weight: 0.25, dimensions: '10x8x5cm', sort_order: 2 },
      { name: 'Mixed Crystal Meditation Energy Cube', price: 19.99, compare_price: 29.99, short_description: '0.5 inch mixed crystal cube for meditation and energy work.', description: 'A beautifully polished mixed crystal cube, perfect for meditation, energy work, or as a decorative piece. Each cube is unique with natural crystal patterns.', stock: 80, category_id: 2, sku: 'CRYSTAL-CB-003', status: 'active', featured: 1, images: '[]', weight: 0.1, dimensions: '1.27cm', sort_order: 3 },
      { name: 'Sandalwood Mala Meditation Bracelet', price: 24.99, compare_price: null, short_description: '8mm Mysore sandalwood mala bracelet for meditation.', description: 'Authentic 8mm Mysore sandalwood mala bracelet, traditionally used for meditation and prayer. The natural fragrance of sandalwood promotes calmness and focus.\n\nFeatures:\n- 8mm natural sandalwood beads\n- Traditional mala design\n- Soothing natural fragrance\n- Adjustable fit', stock: 60, category_id: 3, sku: 'WOOD-ML-004', status: 'active', featured: 1, images: '[]', weight: 0.03, dimensions: '8mm beads', sort_order: 4 },
      { name: 'Crystal Spiritual Protection Pendant', price: 34.99, compare_price: 49.99, short_description: '1.1 inch mixed crystal pendant for healing and protection.', description: 'A beautiful mixed crystal spiritual pendant designed for healing and protection. Comes with a stainless steel chain.', stock: 45, category_id: 3, sku: 'CRYSTAL-PD-005', status: 'active', featured: 1, images: '[]', weight: 0.02, dimensions: '2.8cm', sort_order: 5 },
      { name: 'Chinese Xun Pottery Flute 10 Holes', price: 59.99, compare_price: null, short_description: 'Handmade Chinese Xun pottery flute with 10 holes.', description: 'A traditional handmade Chinese Xun pottery flute with 10 holes. This ancient instrument produces a haunting, beautiful sound. Each piece is handcrafted by skilled artisans.', stock: 25, category_id: 4, sku: 'POTTERY-XN-006', status: 'active', featured: 1, images: '[]', weight: 0.3, dimensions: '8x6x4cm', sort_order: 6 },
    ];

    sampleProducts.forEach(p => {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
      dbWrapper.insert('products', { ...p, slug, cost: 0, meta_title: '', meta_description: '' });
    });
  }

  save();
}

// Run seed
seedData();

module.exports = dbWrapper;
