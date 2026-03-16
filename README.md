# Twitter Team Monitor

Dashboard to track daily tweets and replies across your team's managed accounts. Auto-fetches every hour via [Rettiwt-API](https://github.com/Rishikant181/Rettiwt-API). Data stored in [Turso](https://turso.tech) (hosted SQLite).

---

## Deploy on Render

### 1. Create a Turso database

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Login
turso auth login

# Create a database
turso db create twmonitor

# Get the URL
turso db show twmonitor --url

# Get the auth token
turso db tokens create twmonitor
```

Or create one via [turso.tech](https://turso.tech) → Dashboard → New Database (free tier = 500 databases, 9 GB).

---

### 2. Generate a session secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output — you'll paste it as `SESSION_SECRET` below.

---

### 3. Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your repo
4. Settings:
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `node server.js`

#### Environment variables to set on Render:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://twmonitor-<yourname>.turso.io` |
| `TURSO_AUTH_TOKEN` | Token from step 1 |
| `SESSION_SECRET` | Random hex from step 2 |
| `DASHBOARD_PASSWORD` | Your login password |
| `NODE_VERSION` | `22` |

---

### 4. First-time setup in the dashboard

1. Open your Render URL → log in with `DASHBOARD_PASSWORD`
2. **Settings → Rettiwt API Key** — paste your API key (see below)
3. **Settings → Add Account** — add each Twitter/X handle, assign a manager
4. Auto-fetch runs 10 seconds after startup, then every hour

---

## Getting your Rettiwt API Key

The Rettiwt API key is derived from your Twitter/X browser cookies. It's valid for ~5 years unless you change your password.

1. Install **X Auth Helper** extension (Chrome Web Store — search "X Auth Helper")
2. Log into Twitter/X in Chrome
3. Click the extension icon → **Get API Key**
4. Copy the key → paste in **Settings → Rettiwt API Key**

The key is stored only in your Turso database, never in code or environment variables.

---

## Environment variables summary

| Variable | Required | What it does |
|---|---|---|
| `TURSO_DATABASE_URL` | Yes (prod) | Your Turso DB URL |
| `TURSO_AUTH_TOKEN` | Yes (prod) | Turso auth token |
| `SESSION_SECRET` | Yes (prod) | Signs login session cookies |
| `DASHBOARD_PASSWORD` | Yes | Dashboard login password |
| `NODE_VERSION` | Yes | Must be `22` |
| `PORT` | No | Defaults to `3000` |

> **Note:** Without `TURSO_DATABASE_URL` the app falls back to a local `file:local.db` SQLite file — useful for local development.

---

## How it works

- Hourly cron (`0 * * * *`) calls `rettiwt.tweet.search()` for each tracked account with today's date range
- A tweet with `replyTo` set is counted as a reply; otherwise it's a tweet
- All counts stored per `(date, handle)` in Turso — history is permanent
- **Team** tab shows today's totals grouped by manager (Tarun, Sasanka, Sukhman, Shub)
- **Reports** tab lets you view any past date's breakdown
