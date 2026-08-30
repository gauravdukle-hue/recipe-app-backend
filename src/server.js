import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import recipeRoutes from './routes/recipes.js';
import speechRoutes from './routes/speech.js';
import db from './config/db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',').map(origin => origin.trim());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Routes
app.use('/auth', authRoutes);
app.use('/recipes', recipeRoutes);
app.use('/api/speech', speechRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🍽️  Server running on http://localhost:${PORT}`);
  console.log(`  POST   http://localhost:${PORT}/auth/signup`);
  console.log(`  POST   http://localhost:${PORT}/auth/login`);
  console.log(`  GET    http://localhost:${PORT}/auth/me (requires token)`);
  console.log(`  GET    http://localhost:${PORT}/health`);
});
