import express from 'express';
import db from '../config/db.js';
import { hashPassword, comparePassword, generateToken } from '../utils/auth.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// POST /auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'Email, password, and name are required'
      });
    }
    
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'Email already registered'
      });
    }
    
    const passwordHash = await hashPassword(password);
    
    const result = await db.query(
      'INSERT INTO users (email, password_hash, name, auth_provider) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [email, passwordHash, name, 'email']
    );
    
    const user = result.rows[0];
    const token = generateToken(user.id, user.email);
    
    res.status(201).json({
      user_id: user.id,
      email: user.email,
      name: user.name,
      auth_token: token
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'Email and password are required'
      });
    }
    
    const result = await db.query(
      'SELECT id, email, password_hash, name FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Unauthorized',
        details: 'Invalid email or password'
      });
    }
    
    const user = result.rows[0];
    
    const isMatch = await comparePassword(password, user.password_hash);
    
    if (!isMatch) {
      return res.status(401).json({
        error: 'Unauthorized',
        details: 'Invalid email or password'
      });
    }
    
    const token = generateToken(user.id, user.email);
    
    res.status(200).json({
      user_id: user.id,
      email: user.email,
      name: user.name,
      auth_token: token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /auth/me
router.get('/me', authMiddleware, (req, res) => {
  res.status(200).json({
    user_id: req.user.user_id,
    email: req.user.email
  });
});

export default router;
