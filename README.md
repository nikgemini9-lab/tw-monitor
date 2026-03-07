# Twitter Team Monitor — Railway Deployment

## Deploy in 5 steps

### 1. Create a GitHub repo
- Go to github.com → New repository → name it `tw-monitor`
- Upload all these files into it

### 2. Deploy to Railway
- Go to railway.app and sign up (free)
- Click **New Project → Deploy from GitHub repo**
- Select your `tw-monitor` repo
- Railway auto-detects Node.js and deploys ✅

### 3. Set Environment Variables
In Railway → your project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DASHBOARD_PASSWORD` | your chosen password (e.g. `mysecretpass123`) |
| `SESSION_SECRET` | any random string (e.g. `xk29fmq8alp3`) |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium-browser` |

### 4. Get your URL
Railway gives you a public URL like `https://tw-monitor-production.up.railway.app`
Open it → login with your `DASHBOARD_PASSWORD`

### 5. Configure the app
- Go to **Settings tab** in the dashboard
- Enter your dummy X account credentials
- Add the Twitter accounts + managers you want to track
- Done! Scrapes every hour automatically 🎉

---

## Notes
- Data is stored in `data/` folder on the Railway server
- Scraper runs every hour on the hour
- Click "Refresh Now" to force an immediate scrape
- Railway free tier: 500 hours/month — enough for always-on
