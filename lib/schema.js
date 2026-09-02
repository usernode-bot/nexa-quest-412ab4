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
  // Stage 2 architecture: the scale tier a room runs at. Existing rooms are
  // all small ones, so 'direct' is the correct backfill.
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS scale_tier VARCHAR(12) NOT NULL DEFAULT 'direct'`);

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
  // What the listener wants coming out of their speaker. `tts_enabled` stays
  // as the derived boolean (audio_mode <> 'original') so older rows, older
  // clients and the language-group queries all keep working unchanged.
  await pool.query(`ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS audio_mode VARCHAR(12) NOT NULL DEFAULT 'both'`);
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
  // Capture leg of the end-to-end latency: how long the browser's recogniser
  // took from the start of the phrase to handing us a final transcript.
  // Measured client-side because that clock is the only one that sees it.
  await pool.query(`ALTER TABLE utterances ADD COLUMN IF NOT EXISTS capture_ms INTEGER`);

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
  // Time to FIRST token — the number a listener actually feels, as distinct
  // from latency_ms (time to the finished caption).
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS ttft_ms INTEGER`);
  // How many listeners this one call served. Cost per person is
  // cost/group_size, which is the whole argument for language grouping.
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS group_size INTEGER`);
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS engine_id VARCHAR(24)`);
  // When the caption actually became final on the server. `created_at` is when
  // the pending row was placed, and the gap between the two includes queue
  // wait — so only this column can answer "how stale was it when we shipped
  // it", which is the delivery leg of the latency budget.
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`);
  // Sealed speech segments. `segments` is the ordered clause list, `sealed_idx`
  // is how many of them are promised immutable and therefore speakable. A
  // listener's synthesiser may read segments[0 .. sealed_idx-1] and nothing
  // beyond, which is what lets clause 1 be spoken while clause 2 is still
  // being written. `first_segment_at` starts the audio latency leg.
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS segments JSONB`);
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS sealed_idx INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS first_segment_at TIMESTAMPTZ`);

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
  await pool.query(`ALTER TABLE user_language_prefs ADD COLUMN IF NOT EXISTS audio_mode VARCHAR(12) NOT NULL DEFAULT 'both'`);

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

  // Multi-slot floor leases. One row per speaker currently holding a slot;
  // the row IS the lease, and an expired `until` releases it without anyone
  // having to notice a tab died. Who is speaking is visible to the whole room
  // already, so this is public.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_speakers (
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      until TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (room_id, user_id)
    )
  `);

  // A room is a durable address; a SESSION is one sitting inside it. Cost and
  // engine attribution belong to the sitting, not the address. Counters and
  // spend only — no identity, no content — so public.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_sessions (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      engine_id VARCHAR(24) NOT NULL DEFAULT 'proxy-text',
      scale_tier VARCHAR(12) NOT NULL DEFAULT 'direct',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      utterances INTEGER NOT NULL DEFAULT 0,
      translation_calls INTEGER NOT NULL DEFAULT 0,
      spent_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
      degraded_to VARCHAR(24)
    )
  `);

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

  // Latency samples. PUBLIC on purpose: integers only, no text, no user id,
  // and the only foreign key points at the public `rooms` table. Rows are
  // assembled server-side from the private tables but carry nothing that
  // identifies a person or reveals what was said.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS latency_samples (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
      target_lang VARCHAR(8),
      tier VARCHAR(12),
      capture_ms INTEGER,
      translate_ms INTEGER,
      deliver_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The fourth leg: how long after the caption was sealed the listener's
  // device actually started speaking it, and whether it managed to at all.
  // Still integers only, still nothing that identifies anyone.
  await pool.query(`ALTER TABLE latency_samples ADD COLUMN IF NOT EXISTS audio_ms INTEGER`);
  await pool.query(`ALTER TABLE latency_samples ADD COLUMN IF NOT EXISTS audio_outcome VARCHAR(12)`);


  // --- Production hardening (Stage 5/6) ---------------------------------------

  // Structured error records. PRIVATE: a client stack head or a server error
  // message can quote a room, a path or a fragment of what somebody typed, and
  // none of that belongs in a preview container. Pruned at 14 days.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS error_events (
      id BIGSERIAL PRIMARY KEY,
      source VARCHAR(8) NOT NULL,
      code VARCHAR(48) NOT NULL,
      where_at VARCHAR(64),
      message VARCHAR(300),
      stack_head VARCHAR(500),
      user_agent VARCHAR(200),
      room_id BIGINT REFERENCES rooms(id) ON DELETE SET NULL,
      req_id VARCHAR(16),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE error_events IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_error_events_code ON error_events (code, created_at DESC)`);

  // Why a caption failed, kept on the caption itself. `latency_ms` told us how
  // long a failure took and never what it was, so every proxy problem looked
  // identical on the dashboard.
  await pool.query(`ALTER TABLE utterance_translations ADD COLUMN IF NOT EXISTS fail_code VARCHAR(32)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_translations_failcode
    ON utterance_translations (created_at DESC) WHERE fail_code IS NOT NULL`);

  // A trace id the browser mints per utterance, so one caption can be followed
  // from the microphone through fan-out to the latency sample in the logs.
  await pool.query(`ALTER TABLE utterances ADD COLUMN IF NOT EXISTS trace_id VARCHAR(16)`);

  // Alerts. PUBLIC: a rule name, a severity and two timestamps. The detail
  // blob carries aggregate numbers only, never text and never a person.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id BIGSERIAL PRIMARY KEY,
      rule VARCHAR(32) NOT NULL,
      severity VARCHAR(8) NOT NULL DEFAULT 'warn',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      detail JSONB,
      room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_open
    ON alerts (rule, opened_at DESC) WHERE resolved_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_recent ON alerts (opened_at DESC)`);

  // Pilot feedback. PRIVATE: a free-text comment from a tester is exactly the
  // kind of thing a stranger opening a staging preview must not read.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_feedback (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username VARCHAR(64),
      room_id BIGINT REFERENCES rooms(id) ON DELETE SET NULL,
      purpose VARCHAR(24),
      rating SMALLINT,
      comment TEXT,
      contact_ok BOOLEAN NOT NULL DEFAULT FALSE,
      compat JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE pilot_feedback IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_created ON pilot_feedback (created_at DESC)`);

  // The interface language a person picked inside this app, overriding the
  // platform locale. NULL means "no override", which is not the same as "en".
  await pool.query(`ALTER TABLE user_language_prefs ADD COLUMN IF NOT EXISTS ui_lang VARCHAR(8)`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_latency_room_created ON latency_samples (room_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_latency_audio
    ON latency_samples (created_at DESC) WHERE audio_ms IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_utterances_room_seq ON utterances (room_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_translations_room_seq ON utterance_translations (room_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_participants_room_seq ON room_participants (room_id, seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rate_events_scope ON rate_events (scope, scope_key, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms (ended_at, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_active_speakers_room ON active_speakers (room_id, until DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_sessions_room ON room_sessions (room_id, started_at DESC)`);
  // Partial index: a large room's roster query only ever asks for the people
  // still in it, so the 140 rows of people who left never get scanned.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_participants_room_active
    ON room_participants (room_id) WHERE left_at IS NULL AND removed = FALSE`);
}

module.exports = { migrate };
