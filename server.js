const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/user', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, user_id, username, level, xp, streak
      FROM users WHERE user_id = $1
    `, [req.user.id]);
    if (rows.length === 0) {
      return res.json({ user: null });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quests', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT q.id, q.title, q.description, q.is_locked, q.xp_reward,
             CASE WHEN uq.id IS NOT NULL THEN true ELSE false END as started,
             CASE WHEN uq.completed_at IS NOT NULL THEN true ELSE false END as completed
      FROM quests q
      LEFT JOIN user_quests uq ON q.id = uq.quest_id AND uq.user_id = $1
      ORDER BY q.id
    `, [req.user.id]);
    res.json({ quests: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quest/start', async (req, res) => {
  try {
    const { quest_id } = req.body;
    await pool.query(`
      INSERT INTO user_quests (user_id, quest_id, started_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, quest_id) DO NOTHING
    `, [req.user.id, quest_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quest/verify', async (req, res) => {
  try {
    const { quest_id } = req.body;
    const { rows: questRows } = await pool.query(
      'SELECT xp_reward FROM quests WHERE id = $1', [quest_id]
    );
    if (questRows.length === 0) {
      return res.status(404).json({ error: 'Quest not found' });
    }
    const xp_reward = questRows[0].xp_reward;

    await pool.query(`
      UPDATE user_quests SET completed_at = NOW()
      WHERE user_id = $1 AND quest_id = $2
    `, [req.user.id, quest_id]);

    await pool.query(`
      UPDATE users SET xp = xp + $1 WHERE user_id = $2
    `, [xp_reward, req.user.id]);

    res.json({ ok: true, xp_earned: xp_reward });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, xp, level FROM users ORDER BY xp DESC LIMIT 50
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-in/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT check_in_date FROM check_ins
      WHERE user_id = $1
      ORDER BY check_in_date DESC
    `, [req.user.id]);
    res.json({ history: rows.map(r => r.check_in_date) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/check-in', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows: existingRows } = await pool.query(`
      SELECT id FROM check_ins WHERE user_id = $1 AND check_in_date = $2
    `, [req.user.id, today]);

    if (existingRows.length > 0) {
      return res.json({ ok: false, message: 'Already checked in today' });
    }

    await pool.query(`
      INSERT INTO check_ins (user_id, check_in_date) VALUES ($1, $2)
    `, [req.user.id, today]);

    const { rows: streakRows } = await pool.query(`
      SELECT COUNT(*) as streak FROM check_ins WHERE user_id = $1
    `, [req.user.id]);
    const streak = streakRows[0].streak;

    await pool.query(`
      UPDATE users SET streak = $1 WHERE user_id = $2
    `, [streak, req.user.id]);

    res.json({ ok: true, streak });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      level INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      language VARCHAR(10) DEFAULT 'id',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quests (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      is_locked BOOLEAN DEFAULT false,
      xp_reward INTEGER DEFAULT 30,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_quests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      quest_id INTEGER NOT NULL,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      UNIQUE(user_id, quest_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS check_ins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      check_in_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, check_in_date)
    )
  `);

  if (IS_STAGING) {
    const demoUserId = 99001;
    const demoUsername = 'staging-demo-user';

    await pool.query(`
      INSERT INTO users (user_id, username, level, xp, streak, language)
      VALUES ($1, $2, 5, 250, 7, 'id')
      ON CONFLICT (user_id) DO NOTHING
    `, [demoUserId, demoUsername]);

    await pool.query(`
      INSERT INTO quests (title, description, is_locked, xp_reward)
      VALUES
        ('Follow NexaQuest on X', 'Follow our social media account', false, 30),
        ('Join Discord', 'Join our community server', true, 50),
        ('Invite a friend', 'Invite someone to play', false, 20)
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`
      INSERT INTO users (user_id, username, level, xp, streak)
      VALUES
        (99002, 'staging-demo-ana', 8, 450, 5),
        (99003, 'staging-demo-bob', 6, 380, 3),
        (99004, 'staging-demo-charlie', 4, 210, 1),
        (99005, 'staging-demo-diana', 7, 520, 9)
      ON CONFLICT (user_id) DO NOTHING
    `);

    const today = new Date().toISOString().split('T')[0];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      await pool.query(`
        INSERT INTO check_ins (user_id, check_in_date)
        VALUES ($1, $2)
        ON CONFLICT (user_id, check_in_date) DO NOTHING
      `, [demoUserId, dateStr]);
    }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
