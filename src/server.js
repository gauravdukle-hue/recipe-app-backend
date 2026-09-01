import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import recipeRoutes from './routes/recipes.js';
import speechRoutes from './routes/speech.js';
import audioRoutes from './routes/audio.js';
import db from './config/db.js';

const app = express();
const PORT = process.env.PORT || 3000;

// 50mb covers a base64 WAV of roughly 20 minutes at 16 kHz mono.
app.use(express.json({ limit: '50mb' }));

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',').map(origin => origin.trim());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Routes
app.use('/auth', authRoutes);
app.use('/recipes', recipeRoutes);
app.use('/api/speech', speechRoutes);
app.use('/audio', audioRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🍽️  Server running on http://localhost:${PORT}`);
  console.log(`  POST   http://localhost:${PORT}/auth/signup`);
  console.log(`  POST   http://localhost:${PORT}/auth/login`);
  console.log(`  GET    http://localhost:${PORT}/auth/me (requires token)`);
  console.log(`  POST   http://localhost:${PORT}/audio/:recipeId`);
  console.log(`  GET    http://localhost:${PORT}/audio/queue/pending`);
  console.log(`  GET    http://localhost:${PORT}/health`);
});
