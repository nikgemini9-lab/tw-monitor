import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import session from 'express-session';
import { Rettiwt } from 'rettiwt-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'twmonitor-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── HELPERS ──────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { accounts: [], apiKey: '' };
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return { accounts: [], apiKey: '' }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

function todayKey() { return new Date().toISOString().split('T')[0]; }

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { start, end };
}

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── FETCHER ──────────────────────────────────────────────
let isFetching = false;
let lastFetchTime = null;
let lastFetchStatus = 'Not yet run';
let fetchLog = [];

function addLog(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(entry);
  fetchLog.unshift(entry);
  if (fetchLog.length > 100) fetchLog.pop();
}

async function fetchAccountStats(handle, apiKey) {
  const clean = handle.replace('@', '');
  addLog(`Fetching @${clean}...`);

  const rettiwt = new Rettiwt({ apiKey });
  const { start, end } = todayRange();

  let tweets = 0, replies = 0;
  let cursor = undefined;
  let pages = 0;
  const MAX_PAGES = 10; // safety limit

  do {
    const result = await rettiwt.tweet.search(
      { fromUsers: [clean], startDate: start, endDate: end },
      20,
      cursor
    );

    if (!result || !result.list || result.list.length === 0) break;

    for (const tweet of result.list) {
      if (tweet.replyTo) replies++;
      else tweets++;
    }

    cursor = result.next?.value || result.next || null;
    pages++;
  } while (cursor && pages < MAX_PAGES);

  addLog(`  @${clean}: ${tweets} tweets, ${replies} replies`);
  return { tweets, replies };
}

async function runFetch() {
  if (isFetching) { addLog('Fetch already running, skipping'); return; }
  const config = loadConfig();
  if (!config.accounts || config.accounts.length === 0) {
    lastFetchStatus = 'No accounts configured';
    addLog('No accounts configured — skipping');
    return;
  }
  if (!config.apiKey) {
    lastFetchStatus = 'No API key configured';
    addLog('No Rettiwt API key — skipping');
    return;
  }

  isFetching = true;
  lastFetchStatus = 'Running...';
  addLog('=== Starting fetch ===');

  const data = loadData();
  const today = todayKey();
  if (!data[today]) data[today] = {};

  let errors = 0;
  for (const acc of config.accounts) {
    try {
      const r = await fetchAccountStats(acc.handle, config.apiKey);
      data[today][acc.handle] = {
        manager: acc.manager,
        tweets: r.tweets,
        replies: r.replies,
        lastUpdated: new Date().toISOString(),
        error: null,
      };
      saveData(data);
      // small delay between accounts to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      addLog(`❌ Error on ${acc.handle}: ${e.message}`);
      errors++;
      if (!data[today][acc.handle]) {
        data[today][acc.handle] = {
          manager: acc.manager,
          tweets: 0,
          replies: 0,
          lastUpdated: null,
          error: e.message,
        };
        saveData(data);
      }
    }
  }

  isFetching = false;
  lastFetchTime = new Date().toISOString();
  lastFetchStatus = errors > 0 ? `Done with ${errors} error(s)` : 'Success ✅';
  addLog(`=== Fetch complete (${errors} errors) ===`);
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

// ── PROTECTED ROUTES ──────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── API ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  res.json({
    isFetching,
    lastFetchTime,
    lastFetchStatus,
    accountCount: (config.accounts || []).length,
    hasApiKey: !!config.apiKey,
    log: fetchLog.slice(0, 30),
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
    ...(todayData[a.handle] || { tweets: 0, replies: 0, lastUpdated: null, error: null }),
  }));
  res.json({ date: today, rows });
});

app.get('/api/report/:date', (req, res) => {
  const data = loadData();
  const config = loadConfig();
  const d = data[req.params.date] || {};
  const rows = (config.accounts || []).map(a => ({
    handle: a.handle,
    manager: a.manager,
    ...(d[a.handle] || { tweets: 0, replies: 0 }),
  }));
  res.json(rows);
});

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({ accounts: config.accounts || [], hasApiKey: !!config.apiKey });
});

app.post('/api/apikey', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: 'API key required' });
  const config = loadConfig();
  config.apiKey = apiKey.trim();
  saveConfig(config);
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

app.patch('/api/accounts/:handle', (req, res) => {
  const { manager } = req.body;
  if (!manager) return res.status(400).json({ error: 'Manager required' });
  const config = loadConfig();
  const handle = decodeURIComponent(req.params.handle).toLowerCase();
  config.accounts = (config.accounts || []).map(a =>
    a.handle.toLowerCase() === handle ? { ...a, manager } : a
  );
  saveConfig(config);
  res.json({ success: true });
});

app.delete('/api/accounts/:handle', (req, res) => {
  const config = loadConfig();
  config.accounts = (config.accounts || []).filter(
    a => a.handle.toLowerCase() !== decodeURIComponent(req.params.handle).toLowerCase()
  );
  saveConfig(config);
  res.json({ success: true });
});

app.post('/api/fetch', (req, res) => {
  res.json({ success: true });
  runFetch();
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => {
  addLog(`Server started on port ${PORT}`);
  console.log(`\n𝕏 Twitter Monitor → http://localhost:${PORT}\n`);
});

// Fetch every hour at :00
cron.schedule('0 * * * *', () => { addLog('Hourly cron triggered'); runFetch(); });
// Initial fetch 10s after startup
setTimeout(() => runFetch(), 10000);
