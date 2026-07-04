const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Signed-in user basics — never touches the DB, so it always renders.
app.get('/api/me', (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username } });
});

// Button press
app.post('/api/press', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO presses (user_id, username) VALUES ($1, $2)
    `, [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, COUNT(*) as presses
      FROM presses
      GROUP BY username
      ORDER BY presses DESC
      LIMIT 50
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    // Degrade to an empty list rather than throwing — a blank list must
    // never surface as a 500 / console error on the frontend.
    res.json({ leaderboard: [] });
  }
});

// Available quests (Explore)
app.get('/api/quests', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, description, points
      FROM quests
      ORDER BY points ASC, id ASC
      LIMIT 100
    `);
    res.json({ quests: rows });
  } catch (err) {
    res.json({ quests: [] });
  }
});

// Record a daily check-in for the signed-in user
app.post('/api/check-in', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO check_ins (user_id, username) VALUES ($1, $2)
    `, [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent check-ins (own + seeded demo rows). Supports a read-only demo
// state via ?demo=1 in staging so the "already checked in today" screen
// is populated without writing anything.
app.get('/api/check-ins', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, created_at
      FROM check_ins
      ORDER BY created_at DESC
      LIMIT 20
    `);
    let checkins = rows;
    let checkedInToday = rows.some(r =>
      r.username === req.user.username &&
      new Date(r.created_at).toDateString() === new Date().toDateString()
    );

    // Request-time demo injection: read-only, staging-only, never persisted.
    if (IS_STAGING && req.query.demo === '1') {
      checkedInToday = true;
      checkins = [
        { username: req.user.username, created_at: new Date().toISOString() },
        ...checkins,
      ];
    }

    res.json({ checkins, checkedInToday });
  } catch (err) {
    res.json({ checkins: [], checkedInToday: false });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // Idempotent schema — safe to re-run on every boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quests (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS check_ins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Staging-only seed data. Fresh staging DBs start empty, so seed a handful
  // of obviously-fake rows for every data-dependent screen. Idempotent and a
  // strict no-op in production.
  if (IS_STAGING) {
    await seedStaging();
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

async function seedStaging() {
  // Leaderboard / presses — three demo players with descending counts so the
  // top row is deterministic (Staging demo Aria wins).
  const demoPresses = [
    ['Staging demo Aria', 7],
    ['Staging demo Bex', 4],
    ['Staging demo Cyrus', 2],
  ];
  for (const [username, count] of demoPresses) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM presses WHERE username = $1`, [username]
    );
    const have = rows[0] ? rows[0].n : 0;
    for (let i = have; i < count; i++) {
      await pool.query(
        `INSERT INTO presses (user_id, username) VALUES ($1, $2)`,
        [900000, username]
      );
    }
  }

  // Quests (Explore) — fixed ids so re-seeding is a no-op.
  const demoQuests = [
    [900001, 'Staging demo Quest: First Steps', 'Press the button once to get started.', 10],
    [900002, 'Staging demo Quest: Daily Streak', 'Check in three days in a row.', 30],
    [900003, 'Staging demo Quest: Explorer', 'Visit every screen in NEXA QUEST.', 50],
  ];
  for (const [id, title, description, points] of demoQuests) {
    await pool.query(
      `INSERT INTO quests (id, title, description, points)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, title, description, points]
    );
  }

  // Check-in history — a couple of rows for the demo user so the history
  // list is populated the moment the screen loads.
  const { rows: ciRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM check_ins WHERE username = $1`,
    ['staging-demo-user']
  );
  const haveCi = ciRows[0] ? ciRows[0].n : 0;
  for (let i = haveCi; i < 2; i++) {
    await pool.query(
      `INSERT INTO check_ins (user_id, username) VALUES ($1, $2)`,
      [900000, 'staging-demo-user']
    );
  }
}

start().catch(err => { console.error(err); process.exit(1); });
