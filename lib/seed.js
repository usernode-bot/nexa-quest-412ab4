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
//   * Small: two rooms, one townhall audience, ~2 weeks of rollups.

const SUP = 900001;   // Staging demo · Node setup help   (support)
const HALL = 900002;  // Staging demo · Validator townhall (townhall)

const PEOPLE = {
  anin: { id: 900101, username: 'staging-demo-anin', speaks: 'id', hears: 'id' },
  mark: { id: 900102, username: 'staging-demo-mark', speaks: 'en', hears: 'en' },
  budi: { id: 900103, username: 'staging-demo-budi', speaks: 'id', hears: 'id' },
};

// A support call: Anin speaks Indonesian, Mark answers in English.
// `tr` is the hand-written translation into the OTHER launch language.
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

// Stage 5: a townhall audience big enough to exercise listener grouping.
// Four distinct target languages — exactly the per-room cap.
const AUDIENCE_LANGS = ['id', 'en', 'ja', 'es'];

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
      `INSERT INTO rooms (id, code, title, purpose, host_user_id, host_username, ephemeral, two_way, mode, seq, created_at)
       VALUES ($1,'DEMOHALL','Staging demo · Validator townhall','townhall',$2,$3,FALSE,FALSE,'full',0, NOW() - INTERVAL '10 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [HALL, PEOPLE.mark.id, PEOPLE.mark.username]
    );

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

    // Townhall audience — 28 listeners spread across the four target
    // languages, so the roster's language grouping has something to group.
    let seq = 2;
    for (let i = 0; i < 28; i += 1) {
      const lang = AUDIENCE_LANGS[i % AUDIENCE_LANGS.length];
      seq += 1;
      await client.query(
        `INSERT INTO room_participants (id, room_id, user_id, username, speaks_lang, hears_lang, mic_on, role, tts_enabled, seq)
         VALUES ($1,$2,$3,$4,$5,$5,FALSE,'audience',TRUE,$6)
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [pid + i, HALL, 900200 + i, `staging-demo-listener-${String(i + 1).padStart(2, '0')}`, lang, seq]
      );
    }

    // Utterances + their hand-written translations.
    let uid = 900301;
    let tid = 900401;
    const seedScript = async (roomId, script, startSeq, minutesAgo) => {
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
        // The townhall audience also reads Japanese and Spanish; give those
        // groups a caption so the grouped roster is not lying about coverage.
        if (roomId === HALL) {
          for (const extra of ['ja', 'es']) {
            if (extra === srcLang) continue;
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
    const hallSeq = await seedScript(HALL, HALL_SCRIPT, seq, 8);

    await client.query(`UPDATE rooms SET seq = GREATEST(seq, $2) WHERE id = $1`, [SUP, supSeq]);
    await client.query(`UPDATE rooms SET seq = GREATEST(seq, $2) WHERE id = $1`, [HALL, hallSeq]);

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
    console.log('[seed] staging demo data ready (DEMOSUP, DEMOHALL)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] failed:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { seedStaging };
