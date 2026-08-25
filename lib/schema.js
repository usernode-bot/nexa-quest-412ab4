// Idempotent boot migration + staging seed for LIVE TRANSLATION.
//
// Table privacy (platform convention: tables are PUBLIC by default, mark
// the sensitive ones):
//   utterances / utterance_translations — what people actually SAID in a
//     call. A stranger opening a staging preview must never read a support
//     call transcript. Marked `staging:private` (schema copies, rows do not).
//   reports — moderation reports naming a user and quoting them. Private.
//   Everything else (rooms, participants, prefs, grant events, rate events,
//     daily rollups) is either already visible in-app to everyone in the
//     room or is aggregate/config data. Public.
//
// Note no PUBLIC table carries a foreign key into a PRIVATE one — the FKs
// run the other way (utterances -> rooms), which is what the migration
// linter requires.

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id BIGSERIAL PRIMARY KEY,
      code VARCHAR(12) NOT NULL UNIQUE,
      title VARCHAR(120) NOT NULL,
      purpose VARCHAR(24) NOT NULL DEFAULT 'support',
      host_user_id INTEGER NOT NULL,
      host_username VARCHAR(255) NOT NULL,
      ephemeral BOOLEAN NOT NULL DEFAULT TRUE,
      seq BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      end_reason VARCHAR(32)
    )
  `);
  // Stage 4 / 5 / 7 columns, added separately so an existing deploy migrates.
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS two_way BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_speaker_user_id INTEGER`);
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_speaker_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'full'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_participants (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      speaks_lang VARCHAR(8) NOT NULL DEFAULT 'en',
      hears_lang VARCHAR(8) NOT NULL DEFAULT 'en',
      mic_on BOOLEAN NOT NULL DEFAULT FALSE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      seq BIGINT NOT NULL DEFAULT 0,
      UNIQUE (room_id, user_id)
    )
  `);
  await pool.query(`ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'audience'`);
  await pool.query(`ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS tts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS hand_raised_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS muted_by_host BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS removed BOOLEAN NOT NULL DEFAULT FALSE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS utterances (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      speaker_user_id INTEGER NOT NULL,
      speaker_username VARCHAR(255) NOT NULL,
      source_lang VARCHAR(8) NOT NULL,
      source_text TEXT NOT NULL,
      retracted BOOLEAN NOT NULL DEFAULT FALSE,
      via VARCHAR(12) NOT NULL DEFAULT 'voice',
      seq BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE utterances IS 'staging:private'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS utterance_translations (
      id BIGSERIAL PRIMARY KEY,
      utterance_id BIGINT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      target_lang VARCHAR(8) NOT NULL,
      text TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      seq BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (utterance_id, target_lang)
    )
  `);
  await pool.query(`COMMENT ON TABLE utterance_translations IS 'staging:private'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_language_prefs (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      speaks_lang VARCHAR(8) NOT NULL DEFAULT 'en',
      hears_lang VARCHAR(8) NOT NULL DEFAULT 'en',
      tts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Consent-dialog outcomes. Nothing here identifies content, only whether
  // a user granted this app AI access — one of the launch KPIs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llm_grant_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      outcome VARCHAR(16) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Stage 7 — abuse protection and moderation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      utterance_id BIGINT,
      reporter_user_id INTEGER NOT NULL,
      reported_user_id INTEGER,
      reported_username VARCHAR(255),
      quoted_text TEXT,
      reason VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_events (
      id BIGSERIAL PRIMARY KEY,
      scope VARCHAR(32) NOT NULL,
      scope_key VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Aggregates only — no identity, so public.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      day DATE PRIMARY KEY,
      rooms_started INTEGER NOT NULL DEFAULT 0,
      room_minutes INTEGER NOT NULL DEFAULT 0,
      utterances INTEGER NOT NULL DEFAULT 0,
      translation_calls INTEGER NOT NULL DEFAULT 0,
      distinct_language_pairs INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_utterances_room_seq ON utterances (room_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_translations_room_seq ON utterance_translations (room_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_participants_room_seq ON room_participants (room_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rate_events_scope ON rate_events (scope, scope_key, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms (ended_at, created_at DESC)`);
}

module.exports = { migrate };
