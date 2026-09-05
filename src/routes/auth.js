import express from 'express';
import { randomBytes } from 'crypto';
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

// POST /auth/google
// Verified against Google's tokeninfo endpoint rather than a library, to keep
// the backend free of another dependency. The two checks that matter: the
// token was issued for OUR client id, and the email is verified. Skipping the
// audience check would let a token minted for any other site log someone in.
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!credential) {
      return res.status(400).json({ error: 'Invalid request', details: 'Missing credential' });
    }
    if (!clientId) {
      return res.status(500).json({
        error: 'Not configured',
        details: 'GOOGLE_CLIENT_ID is not set on the server'
      });
    }

    const verify = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!verify.ok) {
      return res.status(401).json({ error: 'Unauthorized', details: 'Google token rejected' });
    }

    const payload = await verify.json();

    if (payload.aud !== clientId) {
      return res.status(401).json({ error: 'Unauthorized', details: 'Token issued for another app' });
    }
    if (payload.email_verified !== 'true' && payload.email_verified !== true) {
      return res.status(401).json({ error: 'Unauthorized', details: 'Google email is not verified' });
    }

    const email = (payload.email || '').toLowerCase();
    const name = payload.name || email.split('@')[0];

    if (!email) {
      return res.status(401).json({ error: 'Unauthorized', details: 'No email on the Google account' });
    }

    let result = await db.query(
      'SELECT id, email, name FROM users WHERE lower(email) = $1',
      [email]
    );

    if (result.rows.length === 0) {
      // First sign-in creates the account. password_hash is filled with random
      // bytes that nothing can match, so this account can never be entered
      // through the email/password route.
      const unusable = await hashPassword(randomBytes(32).toString('hex'));
      result = await db.query(
        'INSERT INTO users (email, password_hash, name, auth_provider) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
        [email, unusable, name, 'google']
      );
    }

    const user = result.rows[0];
    const token = generateToken(user.id, user.email);

    res.status(200).json({
      user_id: user.id,
      email: user.email,
      name: user.name,
      auth_token: token
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
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
