# Recipe App Backend

Node.js + Express + PostgreSQL backend for the Family Recipe App.

## Quick Start (5 Minutes)

### 1. Start PostgreSQL (Docker)
```bash
docker run --name recipe-db \
  -e POSTGRES_USER=admin \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=recipe_app \
  -p 5432:5432 \
  -d postgres:15
```

### 2. Set Up Environment
```bash
cp .env.example .env
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Create Database Tables
```bash
npm run db:migrate
```

Should see: `✅ Database migrations completed successfully!`

### 5. Start Server
```bash
npm run dev
```

You should see:
```
🚀 Server running on http://localhost:3000
```

### 6. Test It (New Terminal)
```bash
curl http://localhost:3000/health
```

Should return:
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "..."
}
```

## API Endpoints

**Authentication:**
- `POST /auth/signup` - Register a new user
- `POST /auth/login` - Login with email/password
- `GET /auth/me` - Get current user (requires token)

**Health Check:**
- `GET /health` - Check server & database status

## Project Structure

```
recipe-app-backend/
├── src/
│   ├── server.js              # Express app
│   ├── config/
│   │   └── db.js              # PostgreSQL connection
│   ├── middleware/
│   │   └── auth.js            # JWT middleware
│   ├── routes/
│   │   └── auth.js            # Auth endpoints
│   ├── utils/
│   │   └── auth.js            # Password & JWT utilities
│   └── db/
│       ├── schema.sql         # Database schema
│       └── migrate.js         # Migration runner
├── package.json
├── .env.example
├── .env (create from .env.example)
└── README.md
```

## Database

7 tables: users, recipes, ingredients, steps, photos, recipe_shares, recipe_notes

See `src/db/schema.sql` for full schema.

## Next Steps

- Add recipe CRUD routes
- Add sharing/permissions logic
- Integrate Claude API for recipe parsing
- Connect React frontend

## Troubleshooting

**Port 3000 in use?**
```bash
lsof -i :3000
kill -9 <PID>
```

**Database not connecting?**
```bash
docker ps | grep recipe-db
# If not running: docker start recipe-db
```

**Module errors?**
```bash
rm -rf node_modules
npm install
```
