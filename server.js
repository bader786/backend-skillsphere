require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 5000;
// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from public directory

// Cashfree Configuration
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || '93659557a5e5adf894d82b2581595639';
const CASHFREE_SECRET = process.env.CASHFREE_SECRET || 'cfsk_ma_prod_daec103874b31d08091883da79ec9dbc_61cc3445';
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'SANDBOX';

// Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
  }
});
// Store pending payments
const pendingPayments = new Map();

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true })
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    wishlist: [{
      courseId: { type: String, required: true },
      title: { type: String, required: true }
    }] // Removed image field
  });
  

const User = mongoose.model('User', userSchema);


// Add Cashfree Endpoints
app.post('/createOrder', async (req, res) => {
  try {
      const { courseId, amount, email, coupon, title } = req.body;
      const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

      pendingPayments.set(orderId, { email, coupon, courseId, title });

      const response = await fetch(`https://${CASHFREE_ENV === 'SANDBOX' ? 'sandbox' : 'api'}.cashfree.com/pg/orders`, {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'x-client-id': CASHFREE_APP_ID,
              'x-client-secret': CASHFREE_SECRET,
              'x-api-version': '2023-08-01'
          },
          body: JSON.stringify({
              order_id: orderId,
              order_amount: amount,
              order_currency: 'INR',
              customer_details: {
                  customer_email: email
              },
              order_meta: {
                  return_url: `${process.env.BASE_URL}/payment-callback`
              }
          })
      });

      const data = await response.json();
      res.json({ 
          paymentSessionId: data.payment_session_id,
          orderId: orderId
      });
  } catch (error) {
      console.error('Payment error:', error);
      res.status(500).json({ error: 'Payment initiation failed' });
  }
});

app.post('/payment-webhook', express.json(), (req, res) => {
  const { orderId, orderStatus } = req.body;
  
  if (orderStatus === 'PAID' && pendingPayments.has(orderId)) {
      const { email, coupon, title } = pendingPayments.get(orderId);
      
      const mailOptions = {
          from: process.env.EMAIL_USER,
          to: email,
          subject: 'Your Course Coupon Code',
          html: `<h1>Thank you for purchasing ${title} From SkillSphere!</h1>
                 <p>Your coupon code: <strong>${coupon}</strong></p>
                 <p>Use this code to access your course materials and please visit again to Grap the exciting courses and offers.</p>`
      };

      transporter.sendMail(mailOptions)
          .then(() => {
              console.log(`Coupon sent to ${email}`);
              pendingPayments.delete(orderId);
          })
          .catch(error => console.error('Email error:', error));
  }
  
  res.status(200).end();
});

// Authentication Middleware
const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    next();
  } catch (error) {
    res.status(401).json({ message: 'Not authorized' });
  }
};

// Routes
app.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, email, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.status(200).json({ message: 'Login successful', token });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Wishlist Routes
app.post('/wishlist', protect, async (req, res) => {
    try {
      const { courseId, title } = req.body; // Removed image from destructuring
      const existingItem = req.user.wishlist.find(item => item.courseId === courseId);
      
      if (existingItem) {
        return res.status(400).json({ message: 'Course already in wishlist' });
      }
  
      req.user.wishlist.push({ courseId, title }); // Removed image
      await req.user.save();
      res.status(200).json(req.user.wishlist);
    } catch (error) {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

app.delete('/wishlist/:courseId', protect, async (req, res) => {
  try {
    const courseId = req.params.courseId;
    req.user.wishlist = req.user.wishlist.filter(item => item.courseId !== courseId);
    await req.user.save();
    res.status(200).json(req.user.wishlist);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/wishlist', protect, async (req, res) => {
    try {
      const user = await User.findById(req.user._id).select('wishlist');
      res.status(200).json(user.wishlist);
    } catch (error) {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });
  

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});