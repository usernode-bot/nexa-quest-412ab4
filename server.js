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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Level curve: fast early levels, slower later. level = floor(sqrt(xp/100))+1
function levelForXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}
function xpForLevel(level) {
  return 100 * (level - 1) * (level - 1);
}

async function ensureProfile(user) {
  await pool.query(
    `INSERT INTO user_profiles (user_id, username)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
    [user.id, user.username]
  );
}

// Tiny in-memory rate limiter for sensitive write endpoints (anti-abuse MVP).
const rlBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const bucket = rlBuckets.get(key) || [];
  const recent = bucket.filter((t) => now - t < windowMs);
  if (recent.length >= max) { rlBuckets.set(key, recent); return true; }
  recent.push(now);
  rlBuckets.set(key, recent);
  return false;
}

// Award XP inside an open transaction: log the transaction (source of truth),
// bump the counter, recompute level. Returns { total_xp, level }.
async function awardXp(client, userId, amount, reason, questId) {
  await client.query(
    `INSERT INTO xp_transactions (user_id, amount, reason, related_quest_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, amount, reason, questId || null]
  );
  const { rows: [p] } = await client.query(
    `UPDATE user_profiles SET total_xp = total_xp + $2
     WHERE user_id = $1 RETURNING total_xp`,
    [userId, amount]
  );
  const level = levelForXp(p.total_xp);
  await client.query(`UPDATE user_profiles SET level = $2 WHERE user_id = $1`, [userId, level]);
  return { total_xp: p.total_xp, level };
}

async function grantBadge(client, userId, badgeId) {
  const r = await client.query(
    `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2)
     ON CONFLICT (user_id, badge_id) DO NOTHING RETURNING id`,
    [userId, badgeId]
  );
  if (r.rowCount > 0) {
    await client.query(
      `INSERT INTO notifications (user_id, type, payload) VALUES ($1, 'badge', $2)`,
      [userId, JSON.stringify({ key: 'notif.badge', badge_id: badgeId })]
    );
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

app.get('/api/profile', async (req, res) => {
  try {
    await ensureProfile(req.user);
    const { rows: [p] } = await pool.query(
      `SELECT user_id, username, language, level, total_xp, current_streak, longest_streak,
              last_checkin_date::text AS last_checkin_date,
              (last_checkin_date = CURRENT_DATE) AS checked_in_today,
              created_at
       FROM user_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const [{ rows: [qc] }, { rows: [bc] }, { rows: activity }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM quest_completions WHERE user_id = $1 AND status = 'verified'`, [req.user.id]),
      pool.query(`SELECT COUNT(*)::int AS n FROM user_badges WHERE user_id = $1`, [req.user.id]),
      pool.query(
        `SELECT t.amount, t.reason, t.created_at, q.title AS quest_title
         FROM xp_transactions t
         LEFT JOIN quests q ON q.id = t.related_quest_id
         WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 8`,
        [req.user.id]
      ),
    ]);
    res.json({
      profile: {
        ...p,
        checked_in_today: !!p.checked_in_today,
        usernode_pubkey: req.user.usernode_pubkey || null,
        xp_level_start: xpForLevel(p.level),
        xp_level_next: xpForLevel(p.level + 1),
      },
      stats: { quests_completed: qc.n, badges: bc.n },
      activity,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/profile/language', async (req, res) => {
  try {
    const { language } = req.body || {};
    if (language !== 'id' && language !== 'en') {
      return res.status(400).json({ error: 'language must be "id" or "en"' });
    }
    if (rateLimited(`${req.user.id}:lang`, 20, 60_000)) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    await ensureProfile(req.user);
    await pool.query(`UPDATE user_profiles SET language = $2 WHERE user_id = $1`, [req.user.id, language]);
    res.json({ ok: true, language });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

app.get('/api/quests', async (req, res) => {
  try {
    await ensureProfile(req.user);
    const { rows } = await pool.query(
      `SELECT q.id, q.title, q.description, q.category, q.verification_type, q.xp_reward,
              q.chain, q.est_minutes, q.ends_at, c.title AS campaign_title,
              qc.status AS my_status,
              (SELECT COUNT(*) FROM quest_completions x
                WHERE x.quest_id = q.id AND x.status = 'verified')::int AS participants
       FROM quests q
       LEFT JOIN campaigns c ON c.id = q.campaign_id AND c.status = 'active'
       LEFT JOIN quest_completions qc ON qc.quest_id = q.id AND qc.user_id = $1
       WHERE q.status = 'active' AND (q.ends_at IS NULL OR q.ends_at > NOW())
       ORDER BY q.id`,
      [req.user.id]
    );
    res.json({ quests: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quests/:id/start', async (req, res) => {
  try {
    if (rateLimited(`${req.user.id}:qstart`, 30, 60_000)) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    await ensureProfile(req.user);
    const { rows: [quest] } = await pool.query(
      `SELECT id FROM quests WHERE id = $1 AND status = 'active'`, [req.params.id]
    );
    if (!quest) return res.status(404).json({ error: 'quest_not_found' });
    await pool.query(
      `INSERT INTO quest_completions (quest_id, user_id, username, status)
       VALUES ($1, $2, $3, 'started')
       ON CONFLICT (quest_id, user_id) DO NOTHING`,
      [quest.id, req.user.id, req.user.username]
    );
    const { rows: [row] } = await pool.query(
      `SELECT status FROM quest_completions WHERE quest_id = $1 AND user_id = $2`,
      [quest.id, req.user.id]
    );
    res.json({ ok: true, status: row.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quests/:id/verify', async (req, res) => {
  const client = await pool.connect();
  try {
    if (rateLimited(`${req.user.id}:qverify`, 15, 60_000)) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    await ensureProfile(req.user);
    const { rows: [quest] } = await pool.query(
      `SELECT * FROM quests WHERE id = $1 AND status = 'active'`, [req.params.id]
    );
    if (!quest) return res.status(404).json({ error: 'quest_not_found' });
    const { rows: [completion] } = await pool.query(
      `SELECT * FROM quest_completions WHERE quest_id = $1 AND user_id = $2`,
      [quest.id, req.user.id]
    );
    if (!completion) return res.status(400).json({ error: 'not_started' });
    if (completion.status === 'verified') return res.json({ status: 'verified', already: true });

    if (quest.verification_type === 'onchain') {
      // On-chain verification is async by design (spec §15) — this slice only
      // records the pending state; the verifier lands in a follow-up slice.
      await pool.query(
        `UPDATE quest_completions SET status = 'pending' WHERE id = $1`, [completion.id]
      );
      return res.json({ status: 'pending' });
    }

    // Off-chain quests verify instantly in the MVP slice.
    await client.query('BEGIN');
    await client.query(
      `UPDATE quest_completions
       SET status = 'verified', verified_at = NOW(), xp_awarded = $2
       WHERE id = $1`,
      [completion.id, quest.xp_reward]
    );
    const progress = await awardXp(client, req.user.id, quest.xp_reward, 'quest', quest.id);
    await client.query(
      `INSERT INTO notifications (user_id, type, payload) VALUES ($1, 'quest', $2)`,
      [req.user.id, JSON.stringify({ key: 'notif.quest_verified', xp: quest.xp_reward, quest_id: quest.id })]
    );
    const { rows: [{ n: verifiedCount }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM quest_completions WHERE user_id = $1 AND status = 'verified'`,
      [req.user.id]
    );
    if (verifiedCount === 1) await grantBadge(client, req.user.id, 1); // First Quest
    if (verifiedCount >= 5) await grantBadge(client, req.user.id, 3); // Explorer
    await client.query('COMMIT');
    res.json({ status: 'verified', xp: quest.xp_reward, ...progress });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Daily check-in
// ---------------------------------------------------------------------------

app.get('/api/checkin', async (req, res) => {
  try {
    await ensureProfile(req.user);
    const { rows: [p] } = await pool.query(
      `SELECT current_streak, longest_streak, last_checkin_date::text AS last_checkin_date,
              (last_checkin_date = CURRENT_DATE) AS checked_in_today,
              CURRENT_DATE::text AS today
       FROM user_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const { rows: days } = await pool.query(
      `SELECT DISTINCT created_at::date::text AS day FROM xp_transactions
       WHERE user_id = $1 AND reason = 'daily_checkin'
         AND created_at > NOW() - INTERVAL '30 days'`,
      [req.user.id]
    );
    res.json({
      streak: p.current_streak,
      longest: p.longest_streak,
      checked_in_today: !!p.checked_in_today,
      today: p.today,
      days: days.map((d) => d.day),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkin', async (req, res) => {
  const client = await pool.connect();
  try {
    if (rateLimited(`${req.user.id}:checkin`, 10, 60_000)) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    await ensureProfile(req.user);
    const { rows: [d] } = await pool.query(
      `SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday`
    );
    const { rows: [p] } = await pool.query(
      `SELECT last_checkin_date::text AS last, current_streak FROM user_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (p.last === d.today) return res.status(409).json({ error: 'already_checked_in' });

    // Calendar-day based streak (spec §7): consecutive if yesterday, else reset to 1.
    const streak = p.last === d.yesterday ? p.current_streak + 1 : 1;
    let xp = 10;
    let milestone = null;
    if (streak === 7) { xp += 50; milestone = 7; }
    if (streak === 14) { xp += 100; milestone = 14; }
    if (streak === 30) { xp += 250; milestone = 30; }

    await client.query('BEGIN');
    await client.query(
      `UPDATE user_profiles
       SET current_streak = $2, longest_streak = GREATEST(longest_streak, $2),
           last_checkin_date = CURRENT_DATE
       WHERE user_id = $1`,
      [req.user.id, streak]
    );
    const progress = await awardXp(client, req.user.id, xp, 'daily_checkin', null);
    if (streak >= 7) await grantBadge(client, req.user.id, 2); // Streak x7
    await client.query('COMMIT');
    res.json({ ok: true, streak, xp_earned: xp, milestone, ...progress });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

app.get('/api/leaderboard', async (req, res) => {
  try {
    await ensureProfile(req.user);
    const period = req.query.period === 'monthly' ? 'monthly'
      : req.query.period === 'all' ? 'all' : 'weekly';
    let rows;
    if (period === 'all') {
      ({ rows } = await pool.query(
        `WITH ranked AS (
           SELECT user_id, username, level, total_xp AS xp,
                  RANK() OVER (ORDER BY total_xp DESC) AS rank
           FROM user_profiles WHERE total_xp > 0
         )
         SELECT user_id, username, level, xp, rank::int FROM ranked
         WHERE rank <= 50 OR user_id = $1 ORDER BY rank`,
        [req.user.id]
      ));
    } else {
      const interval = period === 'monthly' ? '30 days' : '7 days';
      ({ rows } = await pool.query(
        `WITH sums AS (
           SELECT t.user_id, p.username, MAX(p.level) AS level, SUM(t.amount)::int AS xp
           FROM xp_transactions t
           JOIN user_profiles p ON p.user_id = t.user_id
           WHERE t.created_at > NOW() - $2::interval AND t.amount > 0
           GROUP BY t.user_id, p.username
         ), ranked AS (
           SELECT *, RANK() OVER (ORDER BY xp DESC) AS rank FROM sums
         )
         SELECT user_id, username, level, xp, rank::int FROM ranked
         WHERE rank <= 50 OR user_id = $1 ORDER BY rank`,
        [req.user.id, interval]
      ));
    }
    const me = rows.find((r) => r.user_id === req.user.id) || null;
    res.json({ period, leaderboard: rows.filter((r) => r.rank <= 50), me });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Static + HTML shell
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the SPA if authenticated (any path — the SPA is
// path-routed client-side), otherwise an "open in Usernode" landing page.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#4f46e5;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Migration (idempotent) — NexaQuest core schema, spec §13/§14.
// ---------------------------------------------------------------------------

async function migrate() {
  const stmts = [
    // The starter demo table is fully replaced by the NexaQuest schema.
    `DROP TABLE IF EXISTS presses`,

    `CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      language VARCHAR(5) NOT NULL DEFAULT 'id',
      level INTEGER NOT NULL DEFAULT 1,
      total_xp INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS linked_wallets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      chain VARCHAR(40) NOT NULL,
      address VARCHAR(120) NOT NULL,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, chain, address)
    )`,

    `CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      partner_id INTEGER,
      partner_name VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      description TEXT,
      cover_image_url TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      is_featured BOOLEAN NOT NULL DEFAULT FALSE,
      featured_order INTEGER,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Partner budget data lives in its own table so `campaigns` (title,
    // description, status — shown publicly in Explore) can stay public
    // while budgets are staging-private (spec §14).
    `CREATE TABLE IF NOT EXISTS campaign_budgets (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      partner_id INTEGER,
      budget NUMERIC NOT NULL DEFAULT 0,
      spent NUMERIC NOT NULL DEFAULT 0,
      fee_percentage NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `COMMENT ON TABLE campaign_budgets IS 'staging:private'`,

    `CREATE TABLE IF NOT EXISTS quests (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(40),
      verification_type VARCHAR(20) NOT NULL DEFAULT 'offchain',
      verification_config JSONB NOT NULL DEFAULT '{}',
      xp_reward INTEGER NOT NULL DEFAULT 50,
      chain VARCHAR(40),
      est_minutes INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS quest_completions (
      id SERIAL PRIMARY KEY,
      quest_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      username VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'started',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      verified_at TIMESTAMPTZ,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      UNIQUE (quest_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS badges (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      description TEXT,
      icon VARCHAR(16),
      category VARCHAR(40),
      criteria JSONB NOT NULL DEFAULT '{}'
    )`,

    // Non-transferable by design: no owner-transfer column, no transfer endpoint.
    `CREATE TABLE IF NOT EXISTS user_badges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      badge_id INTEGER NOT NULL,
      earned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, badge_id)
    )`,

    `CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_user_id INTEGER NOT NULL,
      referred_user_id INTEGER,
      referred_username VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'registered',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      activated_at TIMESTAMPTZ
    )`,
    `COMMENT ON TABLE referrals IS 'staging:private'`,

    `CREATE TABLE IF NOT EXISTS rewards (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      type VARCHAR(30) NOT NULL DEFAULT 'voucher',
      cost_points INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      min_level INTEGER NOT NULL DEFAULT 1,
      min_reputation INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS reward_redemptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255),
      reward_id INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      redeemed_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `COMMENT ON TABLE reward_redemptions IS 'staging:private'`,

    `CREATE TABLE IF NOT EXISTS wallet_reputation_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      wallet_address VARCHAR(120),
      score INTEGER NOT NULL,
      reason VARCHAR(255),
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `COMMENT ON TABLE wallet_reputation_history IS 'staging:private'`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type VARCHAR(40) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Source of truth for user_profiles.total_xp (spec §13).
    `CREATE TABLE IF NOT EXISTS xp_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      reason VARCHAR(60) NOT NULL,
      related_quest_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_xp_tx_user_time ON xp_transactions (user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_xp_tx_time ON xp_transactions (created_at)`,

    `CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_user_id INTEGER NOT NULL,
      action VARCHAR(80) NOT NULL,
      target_type VARCHAR(40),
      target_id INTEGER,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const s of stmts) await pool.query(s);

  // Badge catalog is reference data seeded in every environment (ids 1-4 are
  // relied on by the grant logic above). Idempotent, never touches user rows.
  await pool.query(
    `INSERT INTO badges (id, name, description, icon, category, criteria) VALUES
       (1, 'First Quest', 'Completed your first quest', '🎯', 'onboarding', '{"quests_completed": 1}'),
       (2, 'Streak x7', 'Checked in 7 days in a row', '🔥', 'loyalty', '{"streak": 7}'),
       (3, 'Explorer', 'Completed 5 quests', '🧭', 'onboarding', '{"quests_completed": 5}'),
       (4, 'Early Adopter', 'Joined NexaQuest in its first season', '🌱', 'rare', '{}')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `SELECT setval('badges_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM badges), 100))`
  );
}

// ---------------------------------------------------------------------------
// Staging seed — obviously-fake demo rows so every data-dependent page is
// testable against the fresh/private-empty staging DB (spec §14). No-op in
// production; idempotent via fixed high ids + ON CONFLICT DO NOTHING.
// ---------------------------------------------------------------------------

async function seedStaging() {
  const stmts = [
    `INSERT INTO user_profiles (user_id, username, language, level, total_xp, current_streak, longest_streak, last_checkin_date) VALUES
       (900001, 'staging-demo-ana',   'id', 5, 1800, 12, 15, CURRENT_DATE),
       (900002, 'staging-demo-budi',  'id', 3,  550,  3,  6, CURRENT_DATE - 1),
       (900003, 'staging-demo-clara', 'en', 7, 3900, 30, 30, CURRENT_DATE),
       (900004, 'staging-demo-dimas', 'en', 2,  150,  1,  4, CURRENT_DATE - 3)
     ON CONFLICT (user_id) DO NOTHING`,

    `INSERT INTO campaigns (id, partner_id, partner_name, title, description, status, is_featured, starts_at, ends_at) VALUES
       (900001, 900101, 'Staging demo partner: Basecamp', 'Staging demo campaign: Base Onboarding Week',
        'A gentle first week on Base — social tasks plus your first on-chain steps.', 'active', TRUE,
        NOW() - INTERVAL '3 days', NOW() + INTERVAL '11 days'),
       (900002, 900102, 'Staging demo partner: DeFiOne', 'Staging demo campaign: DeFi Starter Sprint',
        'Learn-by-doing DeFi basics with small, safe amounts.', 'active', FALSE,
        NOW() - INTERVAL '1 day', NOW() + INTERVAL '20 days')
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO campaign_budgets (id, campaign_id, partner_id, budget, spent, fee_percentage) VALUES
       (900001, 900001, 900101, 2500, 640, 5),
       (900002, 900002, 900102, 1200,  90, 5)
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO quests (id, campaign_id, title, description, category, verification_type, xp_reward, chain, est_minutes, status, ends_at) VALUES
       (900001, 900001, 'Staging demo quest #1: Follow NexaQuest on X', 'Follow the official account and stay in the loop.', 'social', 'offchain', 30, NULL, 2, 'active', NOW() + INTERVAL '30 days'),
       (900002, 900001, 'Staging demo quest #2: Join the Discord server', 'Say hi in #introductions once you are in.', 'social', 'offchain', 40, NULL, 3, 'active', NOW() + INTERVAL '30 days'),
       (900003, NULL,   'Staging demo quest #3: Complete the Web3 basics quiz', 'Five quick questions — no wrong-answer penalty.', 'learn', 'offchain', 50, NULL, 5, 'active', NOW() + INTERVAL '60 days'),
       (900004, 900002, 'Staging demo quest #4: Swap 5 USDC on Base', 'Make one small swap on any Base DEX.', 'defi', 'onchain', 120, 'base', 10, 'active', NOW() + INTERVAL '20 days'),
       (900005, 900002, 'Staging demo quest #5: Mint the starter NFT on Base', 'Mint the free starter collectible (gas only).', 'nft', 'onchain', 150, 'base', 8, 'active', NOW() + INTERVAL '20 days'),
       (900006, NULL,   'Staging demo quest #6: Set up your wallet profile', 'Open your wallet profile page and review your identity.', 'onboarding', 'offchain', 25, NULL, 2, 'active', NULL),
       (900007, NULL,   'Staging demo quest #7: Hold 0.01 ETH on Base for 7 days', 'Patience pays — keep a small balance parked.', 'defi', 'onchain', 100, 'base', 5, 'active', NOW() + INTERVAL '45 days'),
       (900008, NULL,   'Staging demo quest #8: Share your referral link', 'Copy your invite link and share it anywhere.', 'social', 'offchain', 35, NULL, 2, 'active', NULL)
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO quest_completions (id, quest_id, user_id, username, status, verified_at, xp_awarded) VALUES
       (900001, 900001, 900001, 'staging-demo-ana',   'verified', NOW() - INTERVAL '2 days', 30),
       (900002, 900002, 900001, 'staging-demo-ana',   'verified', NOW() - INTERVAL '1 day', 40),
       (900003, 900003, 900001, 'staging-demo-ana',   'verified', NOW() - INTERVAL '6 hours', 50),
       (900004, 900001, 900002, 'staging-demo-budi',  'verified', NOW() - INTERVAL '3 days', 30),
       (900005, 900001, 900003, 'staging-demo-clara', 'verified', NOW() - INTERVAL '5 days', 30),
       (900006, 900004, 900003, 'staging-demo-clara', 'verified', NOW() - INTERVAL '20 hours', 120),
       (900007, 900005, 900003, 'staging-demo-clara', 'pending', NULL, 0),
       (900008, 900003, 900004, 'staging-demo-dimas', 'started', NULL, 0)
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO xp_transactions (id, user_id, amount, reason, related_quest_id, created_at) VALUES
       (900001, 900001,  30, 'quest', 900001, NOW() - INTERVAL '2 days'),
       (900002, 900001,  40, 'quest', 900002, NOW() - INTERVAL '1 day'),
       (900003, 900001,  50, 'quest', 900003, NOW() - INTERVAL '6 hours'),
       (900004, 900001,  10, 'daily_checkin', NULL, NOW() - INTERVAL '1 day'),
       (900005, 900001,  10, 'daily_checkin', NULL, NOW() - INTERVAL '3 hours'),
       (900006, 900002,  30, 'quest', 900001, NOW() - INTERVAL '3 days'),
       (900007, 900002,  10, 'daily_checkin', NULL, NOW() - INTERVAL '1 day'),
       (900008, 900003,  30, 'quest', 900001, NOW() - INTERVAL '5 days'),
       (900009, 900003, 120, 'quest', 900004, NOW() - INTERVAL '20 hours'),
       (900010, 900003,  10, 'daily_checkin', NULL, NOW() - INTERVAL '25 days'),
       (900011, 900003,  10, 'daily_checkin', NULL, NOW() - INTERVAL '4 hours'),
       (900012, 900004,  10, 'daily_checkin', NULL, NOW() - INTERVAL '3 days')
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO user_badges (id, user_id, badge_id) VALUES
       (900001, 900001, 1),
       (900002, 900003, 1),
       (900003, 900003, 2)
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO referrals (id, referrer_user_id, referred_user_id, referred_username, status, created_at, activated_at) VALUES
       (900001, 900001, 900002, 'staging-demo-budi',  'rewarded',   NOW() - INTERVAL '20 days', NOW() - INTERVAL '18 days'),
       (900002, 900001, 900004, 'staging-demo-dimas', 'active',     NOW() - INTERVAL '10 days', NOW() - INTERVAL '9 days'),
       (900003, 900001, 900005, 'staging-demo-eko',   'registered', NOW() - INTERVAL '2 days', NULL),
       (900004, 900003, 900006, 'staging-demo-fitri', 'registered', NOW() - INTERVAL '1 day', NULL),
       (900005, 900002, 900007, 'staging-demo-gita',  'active',     NOW() - INTERVAL '4 days', NOW() - INTERVAL '3 days')
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO rewards (id, title, description, type, cost_points, stock, min_level, expires_at) VALUES
       (900001, 'Staging demo reward: 10% partner voucher', 'Discount code from a demo partner store.', 'voucher', 200, 25, 1, NOW() + INTERVAL '60 days'),
       (900002, 'Staging demo reward: Allowlist spot — Base NFT drop', 'Guaranteed allowlist seat for the demo drop.', 'whitelist', 500, 10, 3, NOW() + INTERVAL '30 days'),
       (900003, 'Staging demo reward: Collector badge NFT', 'Limited collectible badge for dedicated questers.', 'nft_badge', 800, 5, 5, NULL),
       (900004, 'Staging demo reward: Merch discount code', 'Sold out — used to test the out-of-stock state.', 'discount', 300, 0, 1, NOW() + INTERVAL '15 days')
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO reward_redemptions (id, user_id, username, reward_id, status, redeemed_at) VALUES
       (900001, 900001, 'staging-demo-ana',   900001, 'fulfilled', NOW() - INTERVAL '5 days'),
       (900002, 900002, 'staging-demo-budi',  900001, 'pending',   NOW() - INTERVAL '1 day'),
       (900003, 900003, 'staging-demo-clara', 900002, 'approved',  NOW() - INTERVAL '2 days'),
       (900004, 900004, 'staging-demo-dimas', 900004, 'rejected',  NOW() - INTERVAL '3 days')
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO wallet_reputation_history (id, user_id, wallet_address, score, reason, recorded_at) VALUES
       (900001, 900001, 'ut1stagingdemoana', 50, 'Account created',            NOW() - INTERVAL '30 days'),
       (900002, 900001, 'ut1stagingdemoana', 62, 'Verified quest completions', NOW() - INTERVAL '14 days'),
       (900003, 900001, 'ut1stagingdemoana', 58, 'Inactivity decay',           NOW() - INTERVAL '7 days'),
       (900004, 900001, 'ut1stagingdemoana', 70, 'Consistent daily streak',    NOW() - INTERVAL '1 day')
     ON CONFLICT (id) DO NOTHING`,

    `INSERT INTO notifications (id, user_id, type, payload, created_at) VALUES
       (900001, 900001, 'quest',  '{"key":"notif.quest_verified","xp":50,"quest_id":900003}', NOW() - INTERVAL '6 hours'),
       (900002, 900001, 'badge',  '{"key":"notif.badge","badge_id":1}',                      NOW() - INTERVAL '2 days'),
       (900003, 900003, 'reward', '{"key":"notif.reward_approved","reward_id":900002}',      NOW() - INTERVAL '2 days'),
       (900004, 900002, 'streak', '{"key":"notif.streak_reminder"}',                         NOW() - INTERVAL '10 hours')
     ON CONFLICT (id) DO NOTHING`,
  ];
  for (const s of stmts) await pool.query(s);
}

async function start() {
  await migrate();
  if (IS_STAGING) {
    try { await seedStaging(); } catch (err) { console.error('staging seed failed:', err); }
  }
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
