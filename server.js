import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import session from 'express-session';
import { createClient } from '@libsql/client';
import { Rettiwt } from 'rettiwt-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

// ── DATABASE ──────────────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      handle    TEXT PRIMARY KEY,
      manager   TEXT NOT NULL,
      added_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      date         TEXT NOT NULL,
      handle       TEXT NOT NULL,
      manager      TEXT NOT NULL,
      tweets       INTEGER DEFAULT 0,
      replies      INTEGER DEFAULT 0,
      last_updated TEXT,
      error        TEXT,
      PRIMARY KEY (date, handle)
    );
  `);
  addLog('Database ready');
}

// ── DB HELPERS ──────────────────────────────────────────────
async function getConfig(key) {
  const r = await db.execute({ sql: 'SELECT value FROM config WHERE key = ?', args: [key] });
  return r.rows[0]?.value ?? null;
}
async function setConfig(key, value) {
  await db.execute({ sql: 'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', args: [key, value] });
}

async function getAccounts() {
  const r = await db.execute('SELECT handle, manager, added_at FROM accounts ORDER BY added_at');
  return r.rows.map(r => ({ handle: r.handle, manager: r.manager, addedAt: r.added_at }));
}

async function getTodayStats(date) {
  const r = await db.execute({ sql: 'SELECT * FROM daily_stats WHERE date = ?', args: [date] });
  return r.rows;
}

async function upsertStat({ date, handle, manager, tweets, replies, lastUpdated, error }) {
  await db.execute({
    sql: `INSERT INTO daily_stats (date, handle, manager, tweets, replies, last_updated, error)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(date, handle) DO UPDATE SET
            manager = excluded.manager,
            tweets = excluded.tweets,
            replies = excluded.replies,
            last_updated = excluded.last_updated,
            error = excluded.error`,
    args: [date, handle, manager, tweets, replies, lastUpdated, error],
  });
}

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── AUTH ROUTES ──────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.authed) return res.redirect('/');
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
h1{font-size:22px;font-weight:800}p{color:#6b6b80;font-size:14px;margin-top:4px}
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

// ── PROTECTED ──────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

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

function todayKey() { return new Date().toISOString().split('T')[0]; }

function todayRange() {
  const now = new Date();
  return {
    start: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
    end:   new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
  };
}

async function fetchAccountStats(handle, apiKey) {
  const clean = handle.replace('@', '');
  addLog(`Fetching @${clean}...`);
  const rettiwt = new Rettiwt({ apiKey });
  const { start, end } = todayRange();

  let tweets = 0, replies = 0, cursor = undefined, pages = 0;
  do {
    const result = await rettiwt.tweet.search(
      { fromUsers: [clean], startDate: start, endDate: end },
      20,
      cursor
    );
    if (!result?.list?.length) break;
    for (const tweet of result.list) {
      if (tweet.replyTo) replies++;
      else tweets++;
    }
    cursor = result.next?.value || result.next || null;
    pages++;
  } while (cursor && pages < 10);

  addLog(`  @${clean}: ${tweets} tweets, ${replies} replies`);
  return { tweets, replies };
}

async function runFetch() {
  if (isFetching) { addLog('Already running, skipping'); return; }

  const accounts = await getAccounts();
  if (!accounts.length) { lastFetchStatus = 'No accounts configured'; addLog('No accounts — skipping'); return; }

  const apiKey = await getConfig('rettiwt_api_key');
  if (!apiKey) { lastFetchStatus = 'No API key configured'; addLog('No API key — skipping'); return; }

  isFetching = true;
  lastFetchStatus = 'Running...';
  addLog('=== Starting fetch ===');

  const date = todayKey();
  let errors = 0;

  for (const acc of accounts) {
    try {
      const { tweets, replies } = await fetchAccountStats(acc.handle, apiKey);
      await upsertStat({
        date, handle: acc.handle, manager: acc.manager,
        tweets, replies,
        lastUpdated: new Date().toISOString(),
        error: null,
      });
      await new Promise(r => setTimeout(r, 2000)); // rate-limit pause
    } catch (e) {
      addLog(`❌ Error on ${acc.handle}: ${e.message}`);
      errors++;
      await upsertStat({
        date, handle: acc.handle, manager: acc.manager,
        tweets: 0, replies: 0,
        lastUpdated: null,
        error: e.message,
      });
    }
  }

  isFetching = false;
  lastFetchTime = new Date().toISOString();
  lastFetchStatus = errors > 0 ? `Done with ${errors} error(s)` : 'Success ✅';
  addLog(`=== Fetch complete (${errors} errors) ===`);
}

// ── API ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ isFetching, lastFetchTime, lastFetchStatus, log: fetchLog.slice(0, 30) });
});

app.get('/api/today', async (req, res) => {
  const accounts = await getAccounts();
  const date = todayKey();
  const stats = await getTodayStats(date);
  const statsMap = Object.fromEntries(stats.map(s => [s.handle, s]));

  const rows = accounts.map(a => ({
    handle: a.handle,
    manager: a.manager,
    tweets: statsMap[a.handle]?.tweets ?? 0,
    replies: statsMap[a.handle]?.replies ?? 0,
    lastUpdated: statsMap[a.handle]?.last_updated ?? null,
    error: statsMap[a.handle]?.error ?? null,
  }));
  res.json({ date, rows });
});

app.get('/api/report/:date', async (req, res) => {
  const accounts = await getAccounts();
  const stats = await getTodayStats(req.params.date);
  const statsMap = Object.fromEntries(stats.map(s => [s.handle, s]));

  res.json(accounts.map(a => ({
    handle: a.handle,
    manager: a.manager,
    tweets: statsMap[a.handle]?.tweets ?? 0,
    replies: statsMap[a.handle]?.replies ?? 0,
  })));
});

app.get('/api/config', async (req, res) => {
  const accounts = await getAccounts();
  const hasApiKey = !!(await getConfig('rettiwt_api_key'));
  res.json({ accounts, hasApiKey });
});

app.post('/api/apikey', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey?.trim()) return res.status(400).json({ error: 'API key required' });
  await setConfig('rettiwt_api_key', apiKey.trim());
  res.json({ success: true });
});

app.post('/api/accounts', async (req, res) => {
  const { handle, manager } = req.body;
  if (!handle || !manager) return res.status(400).json({ error: 'Both fields required' });
  const h = handle.startsWith('@') ? handle : '@' + handle;
  try {
    await db.execute({
      sql: 'INSERT INTO accounts (handle, manager, added_at) VALUES (?, ?, ?)',
      args: [h, manager, new Date().toISOString()],
    });
    res.json({ success: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: 'Account already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/accounts/:handle', async (req, res) => {
  const { manager } = req.body;
  if (!manager) return res.status(400).json({ error: 'Manager required' });
  await db.execute({
    sql: 'UPDATE accounts SET manager = ? WHERE handle = ?',
    args: [manager, decodeURIComponent(req.params.handle)],
  });
  res.json({ success: true });
});

app.delete('/api/accounts/:handle', async (req, res) => {
  await db.execute({
    sql: 'DELETE FROM accounts WHERE handle = ?',
    args: [decodeURIComponent(req.params.handle)],
  });
  res.json({ success: true });
});

app.post('/api/fetch', (req, res) => {
  res.json({ success: true });
  runFetch();
});

// ── START ──────────────────────────────────────────────
await initDb();
app.listen(PORT, () => {
  addLog(`Server started on port ${PORT}`);
  console.log(`\n𝕏 Twitter Monitor → http://localhost:${PORT}\n`);
});

cron.schedule('0 * * * *', () => { addLog('Hourly cron triggered'); runFetch(); });
setTimeout(() => runFetch(), 10000);
