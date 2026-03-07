const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'data.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

// Dashboard password — set via env var DASHBOARD_PASSWORD, fallback to 'admin123'
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'twmonitor-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// ── HELPERS ──────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { accounts: [], xUsername: '', xPassword: '' };
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return { accounts: [], xUsername: '', xPassword: '' }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

function todayKey() { return new Date().toISOString().split('T')[0]; }

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── SCRAPER ──────────────────────────────────────────────
let browser = null;
let isLoggedIn = false;
let isScraping = false;
let lastScrapeTime = null;
let lastScrapeStatus = 'Not yet run';
let scrapeLog = [];

function addLog(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(entry);
  scrapeLog.unshift(entry);
  if (scrapeLog.length > 50) scrapeLog.pop();
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  addLog('Launching browser...');
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ]
  });
  isLoggedIn = false;
  return browser;
}

async function loginToX(page, username, password) {
  addLog(`Logging into X as ${username}...`);
  await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.type('input[autocomplete="username"]', username, { delay: 80 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 2500));

  // Handle possible extra verification step
  const allInputs = await page.$$('input');
  for (const input of allInputs) {
    const name = await input.evaluate(el => el.getAttribute('name'));
    if (name === 'text') {
      await input.type(username, { delay: 80 });
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));
      break;
    }
  }

  await page.waitForSelector('input[name="password"]', { timeout: 10000 });
  await page.type('input[name="password"]', password, { delay: 80 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 4000));

  const url = page.url();
  if (!url.includes('login')) {
    addLog('✅ Login successful');
    return true;
  }
  throw new Error('Login failed — check X credentials in Settings');
}

async function scrapeProfile(page, handle) {
  const clean = handle.replace('@', '');
  addLog(`Scraping @${clean}...`);
  await page.goto(`https://x.com/${clean}`, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const notFound = await page.$('[data-testid="emptyState"]');
  if (notFound) throw new Error('Profile not found');

  const todayStr = todayKey();
  let tweets = 0, comments = 0;
  let prevHeight = 0;

  for (let scroll = 0; scroll < 10; scroll++) {
    const result = await page.evaluate((d) => {
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      let t = 0, c = 0, hitOld = false;
      for (const a of articles) {
        const timeEl = a.querySelector('time');
        if (!timeEl) continue;
        const date = (timeEl.getAttribute('datetime') || '').split('T')[0];
        if (date < d) { hitOld = true; break; }
        if (date !== d) continue;
        if ((a.innerText || '').includes('Replying to')) c++; else t++;
      }
      return { t, c, hitOld };
    }, todayStr);

    tweets = result.t;
    comments = result.c;
    if (result.hitOld) break;

    const newH = await page.evaluate(() => { window.scrollBy(0, 1500); return document.body.scrollHeight; });
    await new Promise(r => setTimeout(r, 2000));
    if (newH === prevHeight) break;
    prevHeight = newH;
  }

  addLog(`  @${clean}: ${tweets} tweets, ${comments} comments`);
  return { tweets, comments };
}

async function runScrape() {
  if (isScraping) { addLog('Scrape already running, skipping'); return; }
  const config = loadConfig();
  if (!config.accounts || config.accounts.length === 0) { lastScrapeStatus = 'No accounts configured'; return; }
  if (!config.xUsername) { lastScrapeStatus = 'No X credentials configured'; return; }

  isScraping = true;
  lastScrapeStatus = 'Running...';
  addLog('=== Starting hourly scrape ===');

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    if (!isLoggedIn) {
      await loginToX(page, config.xUsername, config.xPassword);
      isLoggedIn = true;
    }

    const data = loadData();
    const today = todayKey();
    if (!data[today]) data[today] = {};

    let errors = 0;
    for (const acc of config.accounts) {
      try {
        const r = await scrapeProfile(page, acc.handle);
        data[today][acc.handle] = { manager: acc.manager, tweets: r.tweets, comments: r.comments, lastUpdated: new Date().toISOString(), error: null };
        saveData(data);
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        addLog(`❌ Error on ${acc.handle}: ${e.message}`);
        errors++;
        if (!data[today][acc.handle]) {
          data[today][acc.handle] = { manager: acc.manager, tweets: 0, comments: 0, lastUpdated: null, error: e.message };
          saveData(data);
        }
      }
    }

    await page.close();
    lastScrapeTime = new Date().toISOString();
    lastScrapeStatus = errors > 0 ? `Done with ${errors} error(s)` : 'Success ✅';
    addLog(`=== Scrape complete (${errors} errors) ===`);
  } catch (e) {
    addLog(`❌ Scrape failed: ${e.message}`);
    lastScrapeStatus = 'Failed: ' + e.message;
    isLoggedIn = false;
  } finally {
    isScraping = false;
  }
}

// ── AUTH ROUTES ──────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authed) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html>
<head>
<title>Login — Twitter Monitor</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e8e8f0;font-family:'Syne',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#111118;border:1px solid #2a2a3a;border-radius:20px;padding:48px 40px;width:100%;max-width:400px}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
.logo-icon{width:44px;height:44px;background:#1d9bf0;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px}
h1{font-size:22px;font-weight:800}
p{color:#6b6b80;font-size:14px;margin-top:4px}
label{display:block;font-size:11px;color:#6b6b80;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;margin-top:20px}
input{width:100%;background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;padding:12px 16px;color:#e8e8f0;font-family:'DM Mono',monospace;font-size:14px;outline:none}
input:focus{border-color:#1d9bf0}
button{width:100%;margin-top:24px;padding:13px;background:#1d9bf0;color:#fff;border:none;border-radius:10px;font-family:'Syne',sans-serif;font-size:15px;font-weight:700;cursor:pointer}
button:hover{background:#1a8cd8}
.error{background:rgba(255,77,106,0.1);border:1px solid rgba(255,77,106,0.3);color:#ff4d6a;border-radius:8px;padding:10px 14px;font-size:13px;margin-top:16px}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><div class="logo-icon">𝕏</div><div><h1>Team Monitor</h1><p>Sign in to continue</p></div></div>
  <form method="POST" action="/login">
    <label>Password</label>
    <input type="password" name="password" placeholder="Enter your password" autofocus />
    ${req.query.error ? '<div class="error">Wrong password. Try again.</div>' : ''}
    <button type="submit">Sign In →</button>
  </form>
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    req.session.authed = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── PROTECTED STATIC ──────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── API ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  res.json({
    isScraping, lastScrapeTime, lastScrapeStatus, isLoggedIn,
    accountCount: (config.accounts || []).length,
    hasCredentials: !!config.xUsername,
    log: scrapeLog.slice(0, 20),
  });
});

app.get('/api/today', (req, res) => {
  const data = loadData();
  const config = loadConfig();
  const today = todayKey();
  const todayData = data[today] || {};
  const rows = (config.accounts || []).map(a => ({
    handle: a.handle,
    manager: a.manager,
    ...(todayData[a.handle] || { tweets: 0, comments: 0, lastUpdated: null, error: null }),
  }));
  res.json({ date: today, rows });
});

app.get('/api/report/:date', (req, res) => {
  const data = loadData();
  const config = loadConfig();
  const d = data[req.params.date] || {};
  const rows = (config.accounts || []).map(a => ({
    handle: a.handle, manager: a.manager,
    ...(d[a.handle] || { tweets: 0, comments: 0 }),
  }));
  res.json(rows);
});

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({ accounts: config.accounts || [], hasCredentials: !!config.xUsername, xUsername: config.xUsername ? '****' : '' });
});

app.post('/api/credentials', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Both fields required' });
  const config = loadConfig();
  config.xUsername = username;
  config.xPassword = password;
  saveConfig(config);
  isLoggedIn = false;
  res.json({ success: true });
});

app.post('/api/accounts', (req, res) => {
  const { handle, manager } = req.body;
  if (!handle || !manager) return res.status(400).json({ error: 'Both fields required' });
  const config = loadConfig();
  const h = handle.startsWith('@') ? handle : '@' + handle;
  if ((config.accounts || []).find(a => a.handle.toLowerCase() === h.toLowerCase()))
    return res.status(400).json({ error: 'Account already exists' });
  config.accounts = [...(config.accounts || []), { handle: h, manager, addedAt: new Date().toISOString() }];
  saveConfig(config);
  res.json({ success: true });
});

app.delete('/api/accounts/:handle', (req, res) => {
  const config = loadConfig();
  config.accounts = (config.accounts || []).filter(a => a.handle.toLowerCase() !== decodeURIComponent(req.params.handle).toLowerCase());
  saveConfig(config);
  res.json({ success: true });
});

app.post('/api/scrape', (req, res) => {
  res.json({ success: true });
  runScrape();
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => {
  addLog(`Server started on port ${PORT}`);
  console.log(`\n🐦 Twitter Monitor → http://localhost:${PORT}\n`);
});

cron.schedule('0 * * * *', () => { addLog('Hourly cron triggered'); runScrape(); });
setTimeout(() => runScrape(), 8000);
