const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('../db/init');
const cart = require('../lib/cart');
const auth = require('../lib/auth');

// File upload endpoint
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
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
      cb(new Error('Invalid file type. Only images allowed.'));
    }
  }
});

router.post('/upload', upload.array('files', 10), (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const files = req.files.map(f => ({
    url: '/uploads/' + f.filename,
    name: f.originalname,
    size: f.size
  }));
  
  res.json({ success: true, files });
});

router.post('/upload-single', upload.single('file'), (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({ 
    success: true, 
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname 
  });
});

// Get cart count — signed-in customers get their own database cart count,
// anonymous visitors only ever get their own session cart count.
router.get('/cart/count', (req, res) => {
  const customer = auth.getCustomer(req);
  const count = customer ? cart.count(customer.id) : cart.guestCount(req.session);
  res.json({ count });
});

// Session probe used by the storefront header. Returns no sensitive fields.
router.get('/account/session', (req, res) => {
  const customer = auth.getCustomer(req);
  res.json({ loggedIn: Boolean(customer), customer: auth.publicCustomer(customer) });
});

module.exports = router;
