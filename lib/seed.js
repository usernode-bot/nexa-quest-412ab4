// Staging-only demo data.
//
// Rules this file follows deliberately (platform convention "Seeded data
// must not fabricate a signal your logic reads"):
//   * Every seeded row belongs to a FAKE identity (staging-demo-*). The
//     visitor who opens the preview is never seeded into anything, so the
//     "am I a member of this room?" check answers the same in staging as it
//     does in production — a non-member lands in the real read-only view.
//   * Idempotent: fixed ids + ON CONFLICT DO NOTHING, because a staging
//     container re-runs this on every boot.
//   * Obviously fake: every room title starts "Staging demo ·" and every
//     seeded translation ends " [staging demo]".
//   * Small: three rooms (one per scale tier), one townhall audience,
//     ~2 weeks of rollups.

const SUP = 900001;   // Staging demo · Node setup help      (support,   direct)
const HALL = 900002;  // Staging demo · Validator townhall   (townhall,  large)
const TEAM = 900003;  // Staging demo · Validator upgrade sync (validator, group)

const PEOPLE = {
  anin: { id: 900101, username: 'staging-demo-anin', speaks: 'id', hears: 'id' },
  mark: { id: 900102, username: 'staging-demo-mark', speaks: 'en', hears: 'en' },
  budi: { id: 900103, username: 'staging-demo-budi', speaks: 'id', hears: 'id' },
  yuki: { id: 900104, username: 'staging-demo-yuki', speaks: 'ja', hears: 'ja' },
  rina: { id: 900105, username: 'staging-demo-rina', speaks: 'id', hears: 'id' },
  tom: { id: 900106, username: 'staging-demo-tom', speaks: 'en', hears: 'en' },
};

// A support call: Anin speaks Indonesian, Mark answers in English.
// `tr` is the hand-written translation into the OTHER launch language.
const segment = require('./segment');

const SUP_SCRIPT = [
  ['anin', 'id', 'Halo, node saya sudah jalan tapi statusnya masih syncing sejak tadi malam.', 'en', "Hi, my node is running but it has been stuck syncing since last night."],
  ['mark', 'en', 'Thanks for the details. Can you tell me which testnet you are on?', 'id', 'Terima kasih atas detailnya. Boleh tahu kamu ada di testnet yang mana?'],
  ['anin', 'id', 'Saya pakai testnet yang di dokumentasi, versi node 1.4.2.', 'en', 'I am on the testnet from the docs, node version 1.4.2.'],
  ['mark', 'en', 'That version had a peer discovery bug. Please upgrade to 1.4.5 and restart the node.', 'id', 'Versi itu punya bug peer discovery. Silakan upgrade ke 1.4.5 lalu restart node-nya.'],
  ['anin', 'id', 'Oke, apakah saya perlu hapus data lama sebelum upgrade?', 'en', 'Okay, do I need to delete the old data before upgrading?'],
  ['mark', 'en', 'No, keep your data directory. Only the binary changes, and your wallet stays untouched.', 'id', 'Tidak, simpan direktori data-nya. Hanya binary yang berubah, dan wallet kamu tidak tersentuh.'],
  ['anin', 'id', 'Sudah saya upgrade, sekarang peers-nya naik jadi dua belas.', 'en', 'I upgraded it, and now the peer count is up to twelve.'],
  ['mark', 'en', 'That is the fix. Your node should finish syncing within the hour.', 'id', 'Itu perbaikannya. Node kamu harusnya selesai sync dalam satu jam.'],
];

// A townhall: one speaker, an audience reading in four languages.
const HALL_SCRIPT = [
  ['mark', 'en', 'Welcome everyone. Today we cover the validator upgrade window and the new slashing parameters.', 'id', 'Selamat datang semuanya. Hari ini kita bahas jendela upgrade validator dan parameter slashing yang baru.'],
  ['mark', 'en', 'The upgrade window opens Tuesday and stays open for forty eight hours.', 'id', 'Jendela upgrade dibuka hari Selasa dan terbuka selama empat puluh delapan jam.'],
  ['budi', 'id', 'Apakah validator yang telat upgrade akan langsung kena slashing?', 'en', 'Will validators that upgrade late be slashed immediately?'],
  ['mark', 'en', 'No. Late validators are jailed first, and slashing only applies after two missed epochs.', 'id', 'Tidak. Validator yang telat akan di-jail dulu, dan slashing baru berlaku setelah dua epoch terlewat.'],
];

// A group meeting: three languages in the room, several people holding the
// floor at once — the tier the 'validator' purpose starts in.
const TEAM_SCRIPT = [
  ['rina', 'id', 'Kita mulai sync upgrade-nya. Validator saya sudah di 1.4.5 sejak pagi.', 'en', 'Let us start the upgrade sync. My validator has been on 1.4.5 since this morning.'],
  ['tom', 'en', 'Mine is still on 1.4.2 because the mempool patch broke my RPC endpoint.', 'id', 'Punya saya masih di 1.4.2 karena patch mempool merusak endpoint RPC saya.'],
  ['yuki', 'ja', 'アジア地域のバリデータは三台ともアップグレード済みです。', 'en', 'All three validators in the Asia region have already been upgraded.'],
  ['rina', 'id', 'Bagus. Sisa dua jam sebelum epoch berikutnya, jadi jangan restart node sekarang.', 'en', 'Good. Two hours left before the next epoch, so do not restart your node now.'],
];

// Stage 5: a townhall audience big enough to exercise listener grouping.
// Four distinct target languages — exactly the per-room cap.
const AUDIENCE_LANGS = ['id', 'en', 'ja', 'es'];
// Stage 2 architecture: the large tier's roster is aggregated rather than
// sent row-by-row, so the audience has to be big enough that the difference
// is visible in a preview.
const AUDIENCE_SIZE = 60;

// Seeded captions are sealed by the same code the live path uses, so a
// preview cannot drift from production on the one thing sealing promises.
function sealOf(text) {
  return segment.finalize([], text).segments;
}

async function seedStaging(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO rooms (id, code, title, purpose, host_user_id, host_username, ephemeral, two_way, mode, seq, created_at)
       VALUES ($1,'DEMOSUP','Staging demo · Node setup help','support',$2,$3,FALSE,TRUE,'full',0, NOW() - INTERVAL '20 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [SUP, PEOPLE.mark.id, PEOPLE.mark.username]
    );
    await client.query(
      `INSERT INTO rooms (id, code, title, purpose, host_user_id, host_username, ephemeral, two_way, mode, scale_tier, seq, created_at)
       VALUES ($1,'DEMOHALL','Staging demo · Validator townhall','townhall',$2,$3,FALSE,FALSE,'full','large',0, NOW() - INTERVAL '10 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [HALL, PEOPLE.mark.id, PEOPLE.mark.username]
    );
    await client.query(
      `INSERT INTO rooms (id, code, title, purpose, host_user_id, host_username, ephemeral, two_way, mode, scale_tier, seq, created_at)
       VALUES ($1,'DEMOTEAM','Staging demo · Validator upgrade sync','validator',$2,$3,FALSE,TRUE,'full','group',0, NOW() - INTERVAL '6 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [TEAM, PEOPLE.rina.id, PEOPLE.rina.username]
    );
    // Tiers are the one seeded column that post-dates these fixed ids, so
    // set them explicitly — the inserts above no-op on a container that
    // already has the rooms.
    await client.query(`UPDATE rooms SET scale_tier = 'direct' WHERE id = $1`, [SUP]);
    await client.query(`UPDATE rooms SET scale_tier = 'large' WHERE id = $1`, [HALL]);
    await client.query(`UPDATE rooms SET scale_tier = 'group' WHERE id = $1`, [TEAM]);

    let pid = 900110;
    const addParticipant = async (roomId, person, role, seq) => {
      await client.query(
        `INSERT INTO room_participants (id, room_id, user_id, username, speaks_lang, hears_lang, mic_on, role, tts_enabled, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [pid++, roomId, person.id, person.username, person.speaks, person.hears, role !== 'audience', role, seq]
      );
    };

    await addParticipant(SUP, PEOPLE.mark, 'host', 1);
    await addParticipant(SUP, PEOPLE.anin, 'audience', 2);
    await addParticipant(HALL, PEOPLE.mark, 'host', 1);
    await addParticipant(HALL, PEOPLE.budi, 'agent', 2);

    // Six operators across three languages — two of them holding a floor
    // slot right now, one queued behind them with a hand up.
    await addParticipant(TEAM, PEOPLE.rina, 'host', 1);
    await addParticipant(TEAM, PEOPLE.tom, 'agent', 2);
    await addParticipant(TEAM, PEOPLE.yuki, 'agent', 3);
    await addParticipant(TEAM, PEOPLE.budi, 'audience', 4);
    await addParticipant(TEAM, PEOPLE.anin, 'audience', 5);
    await addParticipant(TEAM, PEOPLE.mark, 'audience', 6);

    // Live floor leases. Short-dated on purpose — long enough that a preview
    // opened soon after boot shows two of the three slots genuinely held (and
    // yuki's hand up behind them), short enough that they lapse on their own
    // while a tester is still in the room, exactly as a real lease would.
    for (const holder of [PEOPLE.rina, PEOPLE.tom]) {
      await client.query(
        `INSERT INTO active_speakers (room_id, user_id, username, until)
         VALUES ($1,$2,$3, NOW() + INTERVAL '4 minutes')
         ON CONFLICT (room_id, user_id) DO UPDATE SET until = EXCLUDED.until`,
        [TEAM, holder.id, holder.username]
      );
    }
    await client.query(
      `UPDATE room_participants SET hand_raised_at = NOW() - INTERVAL '25 seconds'
        WHERE room_id = $1 AND user_id = $2`,
      [TEAM, PEOPLE.yuki.id]
    );

    // Townhall audience — sixty listeners spread across the four target
    // languages, so the roster's language grouping has something to group
    // and the aggregate roster has something to aggregate.
    let seq = 2;
    for (let i = 0; i < AUDIENCE_SIZE; i += 1) {
      const lang = AUDIENCE_LANGS[i % AUDIENCE_LANGS.length];
      seq += 1;
      await client.query(
        `INSERT INTO room_participants (id, room_id, user_id, username, speaks_lang, hears_lang, mic_on, role, tts_enabled, seq)
         VALUES ($1,$2,$3,$4,$5,$5,FALSE,'audience',TRUE,$6)
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [pid + i, HALL, 900200 + i, `staging-demo-listener-${String(i + 1).padStart(2, '0')}`, lang, seq]
      );
    }
    // Not everyone wants a synthesised voice. Every sixth demo listener is on
    // 'original', which is also what keeps tts_enabled and audio_mode honest
    // about being two views of one setting rather than two settings.
    await client.query(
      `UPDATE room_participants SET audio_mode = 'original', tts_enabled = FALSE
        WHERE room_id = $1 AND user_id >= 900200 AND (user_id % 6) = 0`,
      [HALL]
    );

    // Utterances + their hand-written translations.
    let uid = 900301;
    let tid = 900401;
    const seedScript = async (roomId, script, startSeq, minutesAgo, extras = []) => {
      let s = startSeq;
      for (let i = 0; i < script.length; i += 1) {
        const [who, srcLang, srcText, tgtLang, tgtText] = script[i];
        const person = PEOPLE[who];
        s += 1;
        const myUid = uid++;
        await client.query(
          `INSERT INTO utterances (id, room_id, speaker_user_id, speaker_username, source_lang, source_text, via, seq, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'voice',$7, NOW() - ($8 || ' seconds')::INTERVAL)
           ON CONFLICT (id) DO NOTHING`,
          [myUid, roomId, person.id, person.username, srcLang, srcText, s, minutesAgo * 60 - i * 40]
        );
        s += 1;
        await client.query(
          `INSERT INTO utterance_translations (id, utterance_id, room_id, target_lang, text, status, latency_ms, seq)
           VALUES ($1,$2,$3,$4,$5,'ok',$6,$7)
           ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
          [tid++, myUid, roomId, tgtLang, `${tgtText} [staging demo]`, 700 + ((i * 137) % 900), s]
        );
        // Sealed clauses for the finished caption, so a preview exercises
        // the audio path rather than only the subtitle path.
        await client.query(
          `UPDATE utterance_translations
              SET segments = $2::jsonb, sealed_idx = $3,
                  first_segment_at = NOW() - ($4 || ' seconds')::INTERVAL
            WHERE id = $1`,
          [tid - 1, JSON.stringify(sealOf(`${tgtText} [staging demo]`)),
           sealOf(`${tgtText} [staging demo]`).length, minutesAgo * 60 - i * 40]
        );
        // Rooms with more than two languages in them need a caption per
        // language group, or the grouped roster is lying about coverage.
        {
          for (const extra of extras) {
            if (extra === srcLang || extra === tgtLang) continue;
            s += 1;
            await client.query(
              `INSERT INTO utterance_translations (id, utterance_id, room_id, target_lang, text, status, latency_ms, seq)
               VALUES ($1,$2,$3,$4,$5,'ok',$6,$7)
               ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
              [tid++, myUid, roomId, extra, `(${extra}) ${srcText} [staging demo]`, 800 + ((i * 91) % 700), s]
            );
          }
        }
      }
      return s;
    };

    const supSeq = await seedScript(SUP, SUP_SCRIPT, 2, 18);
    const hallSeq = await seedScript(HALL, HALL_SCRIPT, seq, 8, ['ja', 'es']);
    let teamSeq = await seedScript(TEAM, TEAM_SCRIPT, 8, 5, ['ja']);

    // One caption still arriving. Streaming from the proxy writes the
    // caption in place while it is being generated, so a listener sees a
    // provisional line (rendered dim, and deliberately never spoken) before
    // the finished one replaces it. Source is Indonesian and the partial
    // targets English so a non-member preview — which reads in English —
    // actually renders it.
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterances (id, room_id, speaker_user_id, speaker_username, source_lang, source_text, via, seq, created_at)
       VALUES ($1,$2,$3,$4,'id',$5,'voice',$6, NOW() - INTERVAL '8 seconds')
       ON CONFLICT (id) DO NOTHING`,
      [900350, TEAM, PEOPLE.rina.id, PEOPLE.rina.username,
       'Terakhir, tolong cek ulang konfigurasi RPC kalian sebelum epoch berikutnya dimulai.', teamSeq]
    );
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterance_translations (id, utterance_id, room_id, target_lang, text, status, ttft_ms, group_size, engine_id, seq)
       VALUES ($1,$2,$3,'en',$4,'partial',$5,3,'proxy-text',$6)
       ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
      [900450, 900350, TEAM, 'Finally, please double check your RPC config [staging demo]', 480, teamSeq]
    );
    // The first clause is sealed and therefore speakable; the rest of the
    // sentence is still being written and must never be spoken. This is the
    // whole point of sealing, seeded so a preview can show it.
    await client.query(
      `UPDATE utterance_translations
          SET segments = $2::jsonb, sealed_idx = 1,
              first_segment_at = NOW() - INTERVAL '3 seconds'
        WHERE id = $1`,
      [900450, JSON.stringify(['Finally, please double check your RPC config ', '[staging demo]'])]
    );
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterance_translations (id, utterance_id, room_id, target_lang, text, status, seq)
       VALUES ($1,$2,$3,'ja',NULL,'pending',$4)
       ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
      [900451, 900350, TEAM, teamSeq]
    );

    // A sentence with a Japanese caption and no English one, said long enough
    // ago that the fan-out would have written one by now. This is the state a
    // listener lands in after switching hearing language mid-call: the caption
    // is not late, it is never coming, and the feed has to say so.
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterances (id, room_id, speaker_user_id, speaker_username, source_lang, source_text, via, capture_ms, seq, created_at)
       VALUES ($1,$2,$3,$4,'id',$5,'voice',$6,$7, NOW() - INTERVAL '4 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [900360, TEAM, PEOPLE.rina.id, PEOPLE.rina.username,
       'Catatan tambahan: jangan lupa cadangkan seed phrase sebelum upgrade. [staging demo]',
       310, teamSeq]
    );
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterance_translations (id, utterance_id, room_id, target_lang, text, status, latency_ms, group_size, engine_id, finalized_at, seq)
       VALUES ($1,$2,$3,'ja',$4,'ok',$5,1,'proxy-text', NOW() - INTERVAL '4 minutes', $6)
       ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
      [900460, 900360, TEAM, '補足: アップグレード前にシードフレーズのバックアップを忘れずに。 [staging demo]',
       910, teamSeq]
    );

    // A finished English caption whose clauses were sealed long enough ago
    // that speaking them now would put the listener several sentences behind
    // the room. The right answer is to stop trying and say so, which is what
    // the feed's "read this one" line is for. Seeded with fixed timestamps so
    // it renders on first paint, with no timer and no device involved.
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterances (id, room_id, speaker_user_id, speaker_username, source_lang, source_text, via, capture_ms, seq, created_at)
       VALUES ($1,$2,$3,$4,'id',$5,'voice',$6,$7, NOW() - INTERVAL '6 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [900370, TEAM, PEOPLE.budi.id, PEOPLE.budi.username,
       'Kalau node kalian sudah sinkron, laporkan di kanal validator ya. [staging demo]',
       290, teamSeq]
    );
    teamSeq += 1;
    await client.query(
      `INSERT INTO utterance_translations
         (id, utterance_id, room_id, target_lang, text, status, latency_ms, group_size, engine_id,
          segments, sealed_idx, first_segment_at, finalized_at, seq)
       VALUES ($1,$2,$3,'en',$4,'ok',$5,2,'proxy-text',$6::jsonb,$7,
               NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '6 minutes', $8)
       ON CONFLICT (utterance_id, target_lang) DO NOTHING`,
      [900470, 900370, TEAM,
       'Once your node is in sync, report it in the validator channel. [staging demo]',
       860,
       JSON.stringify(sealOf('Once your node is in sync, report it in the validator channel. [staging demo]')),
       sealOf('Once your node is in sync, report it in the validator channel. [staging demo]').length,
       teamSeq]
    );

    // End-to-end latency samples. Three legs per row, so the metrics screen
    // shows a distribution rather than an empty state. Integers only, spread
    // over the retention window, no identity attached to any of them.
    const SAMPLE_ROOMS = [
      [SUP, 'direct', ['id', 'en'], 0],
      [TEAM, 'group', ['en', 'ja'], 220],
      [HALL, 'large', ['ja', 'es'], 540],
    ];
    let sampleId = 900601;
    for (const [roomId, tier, langs, drag] of SAMPLE_ROOMS) {
      for (let i = 0; i < 20; i += 1) {
        await client.query(
          `INSERT INTO latency_samples
             (id, room_id, target_lang, tier, capture_ms, translate_ms, deliver_ms,
              audio_ms, audio_outcome, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$9,$10, NOW() - ($8 || ' hours')::INTERVAL)
           ON CONFLICT (id) DO NOTHING`,
          [sampleId++, roomId, langs[i % langs.length], tier,
           150 + ((i * 53) % 250),
           600 + drag + ((i * 311) % 1200),
           40 + ((i * 173) % 860),
           (i * 8) % 168,
           // Roughly one listener in seven never gets a voice out of their
           // device. That is a real rate, and a metrics screen that only ever
           // shows successes cannot tell you when it changes.
           i % 7 === 3 ? null : 120 + ((i * 97) % 520),
           i % 7 === 3 ? 'fallback' : 'spoken']
        );
      }
    }

    await client.query(`UPDATE rooms SET seq = GREATEST(seq, $2) WHERE id = $1`, [SUP, supSeq]);
    await client.query(`UPDATE rooms SET seq = GREATEST(seq, $2) WHERE id = $1`, [HALL, hallSeq]);
    await client.query(`UPDATE rooms SET seq = GREATEST(seq, $2) WHERE id = $1`, [TEAM, teamSeq]);

    // A closed sitting per demo room, so the cost panel on /admin/metrics
    // has real rows to average instead of an empty state. Spend is
    // whole-room and identity-free — it is a counter, not a receipt.
    const SESSIONS = [
      [900501, SUP, 'direct', 8, 8, 3.2, null],
      [900502, HALL, 'large', 4, 12, 26.5, 'shed_small'],
      [900503, TEAM, 'group', 5, 13, 11.8, null],
    ];
    for (const [id, roomId, tier, utts, calls, cents, degraded] of SESSIONS) {
      await client.query(
        `INSERT INTO room_sessions (id, room_id, engine_id, scale_tier, started_at, ended_at, utterances, translation_calls, spent_cents, degraded_to)
         VALUES ($1,$2,'proxy-text',$3, NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '12 minutes', $4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [id, roomId, tier, utts, calls, cents, degraded]
      );
    }

    // Two weeks of rollups so the admin metrics screen has a shape.
    for (let d = 13; d >= 0; d -= 1) {
      await client.query(
        `INSERT INTO daily_usage (day, rooms_started, room_minutes, utterances, translation_calls, distinct_language_pairs)
         VALUES (CURRENT_DATE - $1::INTEGER, $2, $3, $4, $5, $6)
         ON CONFLICT (day) DO NOTHING`,
        [d, 3 + (d % 5), 40 + d * 7, 120 + d * 23, 210 + d * 41, 2 + (d % 3)]
      );
    }

    await client.query('COMMIT');
    console.log('[seed] staging demo data ready (DEMOSUP, DEMOTEAM, DEMOHALL)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] failed:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { seedStaging };
