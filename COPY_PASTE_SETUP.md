# Copy-Paste Setup (Just Follow These Commands)

## Already Done:
✅ Docker PostgreSQL is running (`recipe-db` container)

## Now Do This (Copy Each Line):

### Step 1: Download & Navigate
Go to your Downloads folder and find `recipe-app-backend` folder. Double-click to unzip if needed.

Then open Terminal in that folder:
- Right-click the `recipe-app-backend` folder
- Select "Open in Terminal" (or "New Terminal at Folder")

### Step 2: Copy This Entire Block & Paste into Terminal

```bash
cp .env.example .env && npm install
```

Press Enter. Wait 1-2 minutes.

### Step 3: Create Database Tables

```bash
npm run db:migrate
```

You should see: `✅ Database migrations completed successfully!`

### Step 4: Start the Server

```bash
npm run dev
```

You should see:
```
🚀 Server running on http://localhost:3000
```

**Leave this terminal open.**

---

## Test It (Open a NEW Terminal Tab)

### Test 1: Health Check
```bash
curl http://localhost:3000/health
```

Should return JSON with `"status": "ok"`.

### Test 2: Sign Up
```bash
curl -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123","name":"Test User"}'
```

You'll get back a `auth_token`. **Copy this token.**

### Test 3: Use Your Token
Replace `YOUR_TOKEN` with the token from Test 2:

```bash
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Should return your user info.

---

## ✅ Done!

Your backend is running and ready.

**Next:** Build recipe CRUD routes or connect the React frontend.
