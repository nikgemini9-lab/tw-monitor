# Twitter Team Monitor

Dashboard to track daily tweets and replies across your team's managed accounts. Automatically fetches data every hour via [Rettiwt-API](https://github.com/Rishikant181/Rettiwt-API) — no browser, no dummy login needed.

## How it works

- Fetches tweets + replies for each tracked account hourly via the Rettiwt API
- Counts tweets vs replies separately per account
- Shows a per-manager breakdown (Team view)
- Stores daily history for reports

---

## Deploy on Render

### 1. Push this repo to GitHub

### 2. Create a new Web Service on Render
- Go to [render.com](https://render.com) → New → **Web Service**
- Connect your GitHub repo
- Runtime: **Node**
- Build command: `npm install`
- Start command: `node server.js`

### 3. Add a Persistent Disk *(recommended)*
- In your Render service → **Disks** tab → Add disk
- Mount path: `/data`
- This keeps your config and history across restarts

### 4. Set Environment Variables
In Render → your service → **Environment** tab:

| Variable | Value |
|---|---|
| `DASHBOARD_PASSWORD` | Your chosen login password |
| `SESSION_SECRET` | Any random string (e.g. `xk29fmq8alp3`) |
| `DATA_DIR` | `/data` *(if you added a persistent disk)* |
| `NODE_VERSION` | `22` |

### 5. Deploy & configure

Once deployed, open your Render URL and:

1. **Settings → Rettiwt API Key** — paste your API key (see below)
2. **Settings → Add Account** — add each Twitter handle + assign a manager
3. The first auto-fetch runs 10 seconds after startup

---

## Getting your Rettiwt API Key

1. Install the **X Auth Helper** extension:
   - Chrome: search "X Auth Helper" in the Chrome Web Store
   - Firefox: search "Rettiwt Auth Helper" in Firefox Add-ons
2. Log into Twitter/X in your browser
3. Click the extension icon → **Get API Key**
4. Copy the generated key — paste it in Settings

The key is derived from your browser cookies and lasts ~5 years.

---

## Team members

Pre-configured: **Tarun, Sasanka, Sukhman, Shub**

You can reassign any account to a different manager at any time from Settings.

---

## Notes

- Data is stored in `data/` (or `DATA_DIR` if set)
- Fetcher runs every hour on the hour
- Click "Refresh Now" on the dashboard to force an immediate fetch
- The **Team** tab shows a summary card per team member
- The **Reports** tab lets you pick any past date to view that day's counts
