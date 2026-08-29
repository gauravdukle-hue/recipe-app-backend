import { verifyToken } from '../utils/auth.js';

export const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      details: 'Missing or invalid authorization header'
    });
  }
  
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  
  if (!decoded) {
    return res.status(401).json({
      error: 'Unauthorized',
      details: 'Invalid or expired token'
    });
  }
  
  req.user = decoded;
  next();
};
