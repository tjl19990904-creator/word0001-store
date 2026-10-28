const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const db = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Trust proxy for production (needed for Render.com / reverse proxies)
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'word0001-store-secret-key-2026',
  resave: false,
  saveUninitialized: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: false,
    sameSite: 'lax'
  }
}));

// View engine - use custom template rendering
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'views'));

// Helper function to get settings
function getSettings() {
  return db.getAllSettings();
}

// Helper to render template
function renderTemplate(res, templateName, data = {}) {
  const settings = getSettings();
  const mergedData = { ...data, settings, path: data.path || '' };
  const templatePath = path.join(__dirname, 'views', templateName);
  
  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    // Replace {{settings.xxx}} placeholders
    html = html.replace(/\{\{settings\.(\w+)\}\}/g, (match, key) => {
      return settings[key] !== undefined ? String(settings[key]) : '';
    });
    // Replace {{data.xxx}} or {{xxx}} placeholders
    html = html.replace(/\{\{data\.(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const parts = key.split('.');
      let val = mergedData;
      for (const part of parts) {
        val = val ? val[part] : undefined;
      }
      return val !== undefined && val !== null ? String(val) : '';
    });
    // Replace {{xxx}} simple placeholders
    html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return mergedData[key] !== undefined ? String(mergedData[key]) : '';
    });
    res.send(html);
  } else {
    res.status(404).send('Template not found: ' + templateName);
  }
}

app.locals.renderTemplate = renderTemplate;
app.locals.db = db;
app.locals.getSettings = getSettings;

// ===== File Upload =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = uuidv4() + ext;
    cb(null, name);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});
app.locals.upload = upload;

// ===== Auth Middleware =====
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}
app.locals.requireAuth = requireAuth;

// ===== Routes =====
const storeRoutes = require('./routes/store');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

app.use('/', storeRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).send('Server Error: ' + err.message);
});

// 404
app.use((req, res) => {
  res.status(404).send('<h1>404 - Page Not Found</h1><p><a href="/">Go Home</a></p>');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  Word0001 Store is running!`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Admin login: admin / admin123456`);
  console.log(`========================================\n`);
});
