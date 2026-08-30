// Shared config for LIVE TRANSLATION. Served to the browser verbatim at
// GET /api/config so the client and server can never drift on language
// codes, room purposes or limits.

// Launch languages (Stage 1 decision: Indonesian + English).
// `stt` / `tts` are BCP-47 tags handed to the browser's Web Speech API.
const LANGUAGES = [
  { code: 'id', label: 'Bahasa Indonesia', english: 'Indonesian', stt: 'id-ID', tts: 'id-ID', flag: '🇮🇩' },
  { code: 'en', label: 'English', english: 'English', stt: 'en-US', tts: 'en-US', flag: '🇬🇧' },
  // Stage 4 language expansion.
  { code: 'ja', label: '日本語', english: 'Japanese', stt: 'ja-JP', tts: 'ja-JP', flag: '🇯🇵' },
  { code: 'es', label: 'Español', english: 'Spanish', stt: 'es-ES', tts: 'es-ES', flag: '🇪🇸' },
  { code: 'zh', label: '中文', english: 'Chinese', stt: 'zh-CN', tts: 'zh-CN', flag: '🇨🇳' },
  { code: 'pt', label: 'Português', english: 'Portuguese', stt: 'pt-BR', tts: 'pt-BR', flag: '🇧🇷' },
];

// Declared here so the language sheet can show what is coming without
// pretending it works. Promote an entry into LANGUAGES to ship it.
const COMING_SOON = [
  { code: 'ko', label: '한국어', english: 'Korean', flag: '🇰🇷' },
  { code: 'vi', label: 'Tiếng Việt', english: 'Vietnamese', flag: '🇻🇳' },
  { code: 'hi', label: 'हिन्दी', english: 'Hindi', flag: '🇮🇳' },
];

const LANG_CODES = LANGUAGES.map((l) => l.code);
const LANG_BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

// The four use cases pinned in Stage 1 product discovery.
const ROOM_PURPOSES = [
  {
    key: 'onboarding',
    label: 'Onboarding',
    blurb: 'Walk a new node runner through setup in their own language.',
    icon: '🚀',
    defaultTwoWay: true,
  },
  {
    key: 'support',
    label: 'Support call',
    blurb: 'One agent, one user, two languages, no ticket ping-pong.',
    icon: '🛟',
    defaultTwoWay: true,
  },
  {
    key: 'validator',
    label: 'Validator room',
    blurb: 'Coordinate upgrades and incidents across operator time zones.',
    icon: '🛡️',
    defaultTwoWay: true,
  },
  {
    key: 'townhall',
    label: 'Global townhall',
    blurb: 'One speaker, many listeners, everyone reads their own language.',
    icon: '📣',
    defaultTwoWay: false,
  },
];

const PURPOSE_KEYS = ROOM_PURPOSES.map((p) => p.key);

// --- scale tiers -----------------------------------------------------------
// A room's tier is what makes a 200-person townhall affordable: the axis that
// actually costs money is G (distinct target LANGUAGES), not N (participants),
// so a large room stays cheap while its roster stops being something you can
// send row-by-row. Everything tier-shaped lives here so the client and server
// read the same numbers (this file is served verbatim at GET /api/config).
const SCALE_TIERS = [
  {
    key: 'direct',
    label: 'Direct call',
    blurb: 'Two to four people, one voice at a time.',
    maxParticipants: 4,
    maxTargetLangs: 2,
    speakerSlots: 1,
    rosterMode: 'full',
    handQueue: false,
    pollActiveMs: 900,
    // Small rooms hold the /stream request open (long-poll) so a caption
    // lands as soon as it is written instead of on the next tick.
    longPoll: true,
  },
  {
    key: 'group',
    label: 'Group meeting',
    blurb: 'Up to twelve operators, three can hold the floor at once.',
    maxParticipants: 12,
    maxTargetLangs: 4,
    speakerSlots: 3,
    rosterMode: 'full',
    handQueue: true,
    pollActiveMs: 900,
    longPoll: true,
  },
  {
    key: 'large',
    label: 'Large room',
    blurb: 'One speaker, an audience of hundreds, an ordered hand queue.',
    maxParticipants: 200,
    maxTargetLangs: 4,
    speakerSlots: 1,
    rosterMode: 'aggregate',
    handQueue: true,
    pollActiveMs: 1500,
    // A held request per listener does not scale to an audience of hundreds:
    // large rooms keep plain interval polling.
    longPoll: false,
  },
];

// Ordered smallest to largest — the index IS the ordering, which is what makes
// "a host may upgrade a room but never shrink it" a one-line comparison.
const TIER_KEYS = SCALE_TIERS.map((t) => t.key);
const TIER_BY_KEY = Object.fromEntries(SCALE_TIERS.map((t) => [t.key, t]));

// Each pinned use case starts in the tier that matches how it actually runs.
const PURPOSE_TIER = {
  onboarding: 'direct',
  support: 'direct',
  validator: 'group',
  townhall: 'large',
};

// The degradation ladder. Fractions of the SPEAKER'S own daily AI cap, read
// off the proxy's meter headers — this app never computes token prices.
//   >= 0.70  shed every language group but the largest one
//   >= 0.90  translate only what the floor-holders say
//   >= 1.00  transcript only; nothing is translated, everything is still said
const DEGRADE_THRESHOLDS = {
  SHED_SMALL_GROUPS: 0.70,
  FLOOR_ONLY: 0.90,
  TRANSCRIPT_ONLY: 1.0,
};

const LIMITS = {
  // Stage 5 raised the room cap from 8; the distinct-target-language cap
  // is what actually bounds LLM spend, so it holds at every stage.
  MAX_PARTICIPANTS: 50,
  MAX_TARGET_LANGS: 4,
  MAX_UTTERANCE_CHARS: 500,
  UTTERANCES_PER_MIN_PER_ROOM: 60,
  ROOMS_PER_HOUR_PER_USER: 4,
  // Active-speaker lease (Stage 5). Renewed while the speaker keeps
  // talking; expires on its own if their tab dies.
  FLOOR_LEASE_MS: 12000,
  // A participant that stops polling is treated as gone.
  PRESENCE_TIMEOUT_MS: 45000,
  // Client poll cadence.
  POLL_ACTIVE_MS: 900,
  POLL_IDLE_MS: 2500,
  POLL_IDLE_AFTER_MS: 45000,
  POLL_LOBBY_MS: 5000,
  // Utterances and their translations are transient call captions.
  RETENTION_HOURS: 72,
};

// Protocol nouns that must survive translation verbatim. Getting
// "validator" translated into a generic word is how a support call stops
// being useful.
// Latency instrumentation and the long-poll transport. One place so the
// browser and the server cannot disagree about how long a held request runs.
const LATENCY = {
  // How long the server holds an idle /stream?wait=1 request before answering
  // "nothing changed". Comfortably under any sane proxy read timeout.
  STREAM_HOLD_MS: 8000,
  // How often the held request re-reads the room's seq.
  STREAM_TICK_MS: 250,
  // Utterances re-translated for a listener who switches hearing language
  // mid-call.
  BACKFILL_UTTERANCES: 5,
  // A caption older than this with no row for your language is not late, it
  // is missing. Drives the "diucapkan sebelum Anda pindah bahasa" state.
  CAPTION_GRACE_MS: 15000,
  // Client batches delivery samples at most this often, per tab.
  DELIVER_BATCH_MS: 10000,
  MAX_SAMPLES_PER_BATCH: 20,
  SAMPLE_RETENTION_DAYS: 7,
};

// Audio translation. The listener hears a synthesised voice reading the
// translated caption on their own device; nothing here sends or receives
// audio over the network. These numbers are the whole feel of it, so they
// live beside the languages rather than scattered through the client.
const AUDIO = {
  // What a listener wants coming out of their speaker.
  //   translation  only the translated voice
  //   original     only the room, no synthesis (subtitles only)
  //   both         the room, quietened, under the translated voice
  MODES: ['translation', 'original', 'both'],
  DEFAULT_MODE: 'both',

  // Clause sealing. A sealed segment is immutable and therefore speakable
  // while the rest of the sentence is still being written.
  SEGMENT_MIN_CHARS: 24,
  // The FIRST clause of an utterance is allowed to be shorter. It is the one
  // the listener is waiting through silence for, and every clause after it
  // arrives while a voice is already speaking, so only the first one is worth
  // trading length for speed.
  FIRST_SEGMENT_MIN_CHARS: 16,
  SEGMENT_MAX_CHARS: 160,
  SEGMENT_MAX_COUNT: 12,

  // How much finished speech to hold before starting, so the voice does not
  // stutter between clauses on a slow proxy call. Adaptive: when the room's
  // own translate p50 says clauses are arriving quickly, one clause of lead is
  // enough and waiting for a second is just added delay.
  LEAD_SEGMENTS: 2,
  LEAD_SEGMENTS_FAST: 1,
  LEAD_FAST_P50_MS: 800,
  LEAD_WAIT_MS: 350,

  // Bounded on both axes. Falling behind is a worse failure than skipping.
  MAX_QUEUE_SEGMENTS: 8,
  MAX_QUEUE_UTTERANCES: 3,
  CATCHUP_AFTER_SEGMENTS: 4,
  RATE_NORMAL: 1.05,
  RATE_CATCHUP: 1.18,

  // Ducking. Floor, and the ramps around it.
  DUCK_GAIN: 0.18,
  DUCK_ATTACK_MS: 120,
  DUCK_RELEASE_MS: 420,
  DUCK_HOLD_MS: 250,

  // Failure budget. Synthesis that never starts is the common case on
  // locked-down devices, and it reports nothing, so we time it ourselves.
  START_DEADLINE_MS: 2500,
  FALLBACK_MS: 4000,
  STALE_MS: 12000,
  CONSECUTIVE_FALLBACKS_OFF: 3,
  SPEAK_WATCHDOG_MS: 30000,
};

// The guided demo call. Six turns of an onboarding conversation, replayed
// entirely in the browser: no room row, no utterance row, no proxy call, no
// spend. It exists so somebody can see what the product does before deciding
// whether to hand it a microphone, which is why it is NOT staging-gated — a
// demo that only exists in previews is a demo nobody can show a colleague.
//
// `text` is what the speaker said; `translated` is the caption the other side
// reads. The clause splits are done in the browser by the same sealing rules
// the real path uses, so what plays back is the real rendering, not a mock of
// it. `gapMs` is how long after the previous turn this one starts.
const DEMO_SCRIPT = {
  purpose: 'onboarding',
  speakers: {
    anin: { name: 'Anin', lang: 'id', flag: '🇮🇩' },
    mark: { name: 'Mark', lang: 'en', flag: '🇬🇧' },
  },
  // The visitor is watching from the English side, so English turns are shown
  // as spoken and Indonesian turns are shown translated.
  viewerLang: 'en',
  turns: [
    { speaker: 'anin', lang: 'id', text: 'Halo Mark, saya baru selesai install node-nya tapi belum tahu langkah berikutnya.',
      targetLang: 'en', translated: 'Hi Mark, I have just finished installing the node but I do not know the next step.',
      gapMs: 900, captureMs: 1100, translateMs: 620 },
    { speaker: 'mark', lang: 'en', text: 'Welcome. First check that the node is reachable, then we will register your validator key.',
      targetLang: 'id', translated: 'Selamat datang. Cek dulu apakah node-nya bisa dijangkau, lalu kita daftarkan validator key kamu.',
      gapMs: 1400, captureMs: 980, translateMs: 540 },
    { speaker: 'anin', lang: 'id', text: 'Statusnya sudah connected, peers ada delapan. Seed phrase saya simpan di mana ya?',
      targetLang: 'en', translated: 'The status is connected, and there are eight peers. Where should I keep my seed phrase?',
      gapMs: 1500, captureMs: 1240, translateMs: 700 },
    { speaker: 'mark', lang: 'en', text: 'Offline, never in a browser. Write the seed phrase down and keep it away from the machine running the node.',
      targetLang: 'id', translated: 'Offline, jangan pernah di browser. Tulis seed phrase-nya dan simpan jauh dari mesin yang menjalankan node.',
      gapMs: 1600, captureMs: 1050, translateMs: 660 },
    { speaker: 'anin', lang: 'id', text: 'Oke sudah aman. Kalau staking-nya kapan bisa mulai?',
      targetLang: 'en', translated: 'Okay, that is safe now. When can I start staking?',
      gapMs: 1500, captureMs: 900, translateMs: 480 },
    { speaker: 'mark', lang: 'en', text: 'As soon as the node finishes syncing. You will see it in the dashboard at the next epoch.',
      targetLang: 'id', translated: 'Begitu node selesai sync. Kamu akan melihatnya di dashboard pada epoch berikutnya.',
      gapMs: 1500, captureMs: 1010, translateMs: 590 },
  ],
};

const PRESERVE_TERMS = [
  'UserNode', 'Usernode', 'node', 'validator', 'staking', 'testnet',
  'mainnet', 'wallet', 'seed phrase', 'RPC', 'gas', 'slashing', 'epoch',
  'nonce', 'mempool',
];

module.exports = {
  LANGUAGES,
  COMING_SOON,
  LANG_CODES,
  LANG_BY_CODE,
  ROOM_PURPOSES,
  PURPOSE_KEYS,
  SCALE_TIERS,
  TIER_KEYS,
  TIER_BY_KEY,
  PURPOSE_TIER,
  DEGRADE_THRESHOLDS,
  LIMITS,
  LATENCY,
  AUDIO,
  DEMO_SCRIPT,
  PRESERVE_TERMS,
};
