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

// The guided demo call. Two scripted conversations, replayed entirely in the
// browser: no room row, no utterance row, no proxy call, no spend. It exists
// so somebody can see what the product does before deciding whether to hand it
// a microphone, which is why it is NOT staging-gated — a demo that only exists
// in previews is a demo nobody can show a colleague.
//
// Each turn carries a caption for EVERY launch language as an ordered array of
// sealed clauses, so the visitor can watch the same call from any seat. The
// array is the source of truth for the caption text: the caption IS
// `parts.join('')`, which is the same invariant lib/segment.js guarantees on
// the real path. The browser feeds these straight into the renderer in the
// shape /stream sends, so the demo cannot drift from the product.
//
// PRESERVE_TERMS nouns (node, validator, seed phrase, staking, epoch,
// slashing, mainnet) and every number stay verbatim in all six languages.
// That is not decoration: it is the product claim, and a demo that quietly
// translated "seed phrase" would be advertising the opposite of what ships.
//
// `gapMs` is how long after the previous turn this one starts, `captureMs` how
// long the microphone leg takes, `translateMs` how long the first clause takes
// to come back. Fake numbers in the shape of real ones, and the only clocks
// the demo has.
function clauses(parts, lang) {
  // Latin scripts join on a space, CJK on nothing. Re-attaching the separator
  // here rather than typing it into every clause is what makes `join('')`
  // exact by construction instead of by proofreading.
  const sep = lang === 'ja' || lang === 'zh' ? '' : ' ';
  return parts.map((p, i) => (i === parts.length - 1 ? p : p + sep));
}

const DEMO_ONBOARDING = {
  key: 'onboarding',
  purpose: 'onboarding',
  tier: 'direct',
  code: 'DEMO',
  title: 'Node setup, Jakarta to Manchester',
  twoWay: true,
  rosterMode: 'full',
  participantCount: 2,
  hostUserId: 900101,
  hostUsername: 'anin',
  speakers: {
    anin: { userId: 900101, name: 'anin', lang: 'id', flag: '🇮🇩' },
    mark: { userId: 900102, name: 'mark', lang: 'en', flag: '🇬🇧' },
  },
  // Fake identities, ids in the 900000 block, exactly like the staging seed
  // rows. Nobody real is ever a participant in the demo.
  participants: [
    { userId: 900101, username: 'anin', role: 'host', speaksLang: 'id', hearsLang: 'id' },
    { userId: 900102, username: 'mark', role: 'speaker', speaksLang: 'en', hearsLang: 'en' },
  ],
  langGroups: [],
  queue: [],
  turns: [
    {
      speaker: 'anin', lang: 'id', gapMs: 600, captureMs: 1100, translateMs: 620,
      captions: {
        id: clauses(['Halo Mark,', 'saya baru selesai install node-nya tapi belum tahu langkah berikutnya.'], 'id'),
        en: clauses(['Hi Mark,', 'I have just finished installing the node but I do not know the next step.'], 'en'),
        ja: clauses(['マークさん、', 'node のインストールは終わりましたが、', '次に何をすればいいか分かりません。'], 'ja'),
        es: clauses(['Hola Mark,', 'acabo de terminar de instalar el node pero no sé cuál es el siguiente paso.'], 'es'),
        zh: clauses(['Mark 你好，', '我刚装好 node，', '但不知道下一步该做什么。'], 'zh'),
        pt: clauses(['Oi Mark,', 'acabei de instalar o node mas não sei qual é o próximo passo.'], 'pt'),
      },
    },
    {
      speaker: 'mark', lang: 'en', gapMs: 1400, captureMs: 980, translateMs: 540,
      captions: {
        en: clauses(['Good.', 'First check that the node is reachable,', 'then we register your validator key.'], 'en'),
        id: clauses(['Bagus.', 'Cek dulu apakah node-nya bisa dijangkau,', 'lalu kita daftarkan validator key kamu.'], 'id'),
        ja: clauses(['了解しました。', 'まず node に接続できるか確認してください。', 'その後で validator key を登録します。'], 'ja'),
        es: clauses(['Perfecto.', 'Primero comprueba que el node responde,', 'y después registramos tu validator key.'], 'es'),
        zh: clauses(['好的。', '先确认 node 可以连通，', '然后我们注册你的 validator key。'], 'zh'),
        pt: clauses(['Ótimo.', 'Primeiro confirme que o node responde,', 'depois registramos a sua validator key.'], 'pt'),
      },
    },
    {
      speaker: 'anin', lang: 'id', gapMs: 1500, captureMs: 1240, translateMs: 700,
      captions: {
        id: clauses(['Statusnya sudah connected,', 'peers ada 8.', 'Seed phrase saya simpan di mana ya?'], 'id'),
        en: clauses(['The status is connected,', 'and there are 8 peers.', 'Where should I keep my seed phrase?'], 'en'),
        ja: clauses(['ステータスは connected で、', 'peers は 8 です。', 'seed phrase はどこに保管すればいいですか。'], 'ja'),
        es: clauses(['El estado ya es connected,', 'hay 8 peers.', '¿Dónde debo guardar mi seed phrase?'], 'es'),
        zh: clauses(['状态已经是 connected，', '有 8 个 peers。', '我的 seed phrase 应该存在哪里？'], 'zh'),
        pt: clauses(['O status já está connected,', 'há 8 peers.', 'Onde devo guardar a minha seed phrase?'], 'pt'),
      },
    },
    {
      speaker: 'mark', lang: 'en', gapMs: 1600, captureMs: 1050, translateMs: 660,
      captions: {
        en: clauses(['Offline, never in a browser.', 'Write the seed phrase down and keep it away from the machine running the node.'], 'en'),
        id: clauses(['Offline, jangan pernah di browser.', 'Tulis seed phrase-nya dan simpan jauh dari mesin yang menjalankan node.'], 'id'),
        ja: clauses(['オフラインで、', 'ブラウザには絶対に置かないでください。', 'seed phrase は紙に書いて、', 'node を動かしているマシンから離して保管します。'], 'ja'),
        es: clauses(['Offline, nunca en un navegador.', 'Anota la seed phrase y guárdala lejos de la máquina que ejecuta el node.'], 'es'),
        zh: clauses(['离线保存，', '绝对不要放在浏览器里。', '把 seed phrase 写在纸上，', '并且远离运行 node 的那台机器。'], 'zh'),
        pt: clauses(['Offline, nunca em um navegador.', 'Anote a seed phrase e guarde longe da máquina que executa o node.'], 'pt'),
      },
    },
    {
      speaker: 'anin', lang: 'id', gapMs: 1500, captureMs: 900, translateMs: 480,
      captions: {
        id: clauses(['Oke sudah aman.', 'Kalau staking-nya kapan bisa mulai?'], 'id'),
        en: clauses(['Okay, that is safe now.', 'When can I start staking?'], 'en'),
        ja: clauses(['はい、安全に保管しました。', 'staking はいつ始められますか。'], 'ja'),
        es: clauses(['Listo, ya está a salvo.', '¿Cuándo puedo empezar el staking?'], 'es'),
        zh: clauses(['好的，已经保管好了。', '什么时候可以开始 staking？'], 'zh'),
        pt: clauses(['Pronto, já está guardada.', 'Quando posso começar o staking?'], 'pt'),
      },
    },
    {
      speaker: 'mark', lang: 'en', gapMs: 1500, captureMs: 1010, translateMs: 590,
      captions: {
        en: clauses(['As soon as the node finishes syncing.', 'You will see it in the dashboard at the next epoch.'], 'en'),
        id: clauses(['Begitu node selesai sync.', 'Kamu akan melihatnya di dashboard pada epoch berikutnya.'], 'id'),
        ja: clauses(['node の同期が終わったらすぐです。', '次の epoch でダッシュボードに表示されます。'], 'ja'),
        es: clauses(['En cuanto el node termine de sincronizar.', 'Lo verás en el dashboard en el siguiente epoch.'], 'es'),
        zh: clauses(['node 同步完成之后就可以。', '下一个 epoch 你会在面板上看到。'], 'zh'),
        pt: clauses(['Assim que o node terminar de sincronizar.', 'Você vai ver no dashboard no próximo epoch.'], 'pt'),
      },
    },
  ],
};

const DEMO_TOWNHALL = {
  key: 'townhall',
  purpose: 'townhall',
  tier: 'large',
  code: 'DEMO',
  title: 'Mainnet 2.1 townhall',
  twoWay: false,
  rosterMode: 'aggregate',
  participantCount: 200,
  hostUserId: 900201,
  hostUsername: 'rina',
  speakers: {
    rina: { userId: 900201, name: 'rina', lang: 'id', flag: '🇮🇩' },
    yuki: { userId: 900202, name: 'yuki', lang: 'ja', flag: '🇯🇵' },
  },
  // A large room's roster is a shape, not a list, so the demo sends the same
  // language groups /stream sends. The three groups here are the whole cost
  // story: 200 people, 3 translations per sentence.
  participants: [
    { userId: 900201, username: 'rina', role: 'host', speaksLang: 'id', hearsLang: 'id' },
    { userId: 900202, username: 'yuki', role: 'speaker', speaksLang: 'ja', hearsLang: 'ja' },
  ],
  langGroups: [
    { lang: 'id', size: 61, hands: 0, status: 'ok' },
    { lang: 'en', size: 74, hands: 1, status: 'ok' },
    { lang: 'ja', size: 65, hands: 1, status: 'ok' },
  ],
  queue: [
    { userId: 900203, username: 'dewi' },
    { userId: 900204, username: 'tomas' },
  ],
  turns: [
    {
      speaker: 'rina', lang: 'id', gapMs: 600, captureMs: 1180, translateMs: 700,
      captions: {
        id: clauses(['Selamat datang di townhall UserNode.', 'Mainnet naik ke versi 2.1 pada epoch 480.'], 'id'),
        en: clauses(['Welcome to the UserNode townhall.', 'Mainnet moves to version 2.1 at epoch 480.'], 'en'),
        ja: clauses(['UserNode の townhall へようこそ。', 'mainnet は epoch 480 でバージョン 2.1 に上がります。'], 'ja'),
        es: clauses(['Bienvenidos al townhall de UserNode.', 'Mainnet pasa a la versión 2.1 en el epoch 480.'], 'es'),
        zh: clauses(['欢迎参加 UserNode 的 townhall。', 'mainnet 将在 epoch 480 升级到 2.1 版本。'], 'zh'),
        pt: clauses(['Bem-vindos ao townhall da UserNode.', 'Mainnet passa para a versão 2.1 no epoch 480.'], 'pt'),
      },
    },
    {
      speaker: 'rina', lang: 'id', gapMs: 1500, captureMs: 1240, translateMs: 760,
      captions: {
        id: clauses(['Ada 200 orang di ruangan ini dan 3 bahasa.', 'Biayanya dihitung per bahasa, bukan per orang.'], 'id'),
        en: clauses(['There are 200 people in this room and 3 languages.', 'The cost is counted per language, not per person.'], 'en'),
        ja: clauses(['この部屋には 200 人がいて、', '言語は 3 つです。', '費用は人数ではなく言語ごとに計算されます。'], 'ja'),
        es: clauses(['Hay 200 personas en esta sala y 3 idiomas.', 'El coste se cuenta por idioma, no por persona.'], 'es'),
        zh: clauses(['这个房间里有 200 人，', '使用 3 种语言。', '费用按语言计算，', '不是按人数。'], 'zh'),
        pt: clauses(['Há 200 pessoas nesta sala e 3 idiomas.', 'O custo é contado por idioma, não por pessoa.'], 'pt'),
      },
    },
    {
      speaker: 'yuki', lang: 'ja', gapMs: 1700, captureMs: 1020, translateMs: 640,
      captions: {
        ja: clauses(['質問です。', 'epoch 480 の後、', 'slashing のルールは変わりますか。'], 'ja'),
        en: clauses(['A question.', 'After epoch 480, do the slashing rules change?'], 'en'),
        id: clauses(['Ada pertanyaan.', 'Setelah epoch 480, apakah aturan slashing berubah?'], 'id'),
        es: clauses(['Una pregunta.', 'Después del epoch 480, ¿cambian las reglas de slashing?'], 'es'),
        zh: clauses(['我有一个问题。', '在 epoch 480 之后，', 'slashing 的规则会变吗？'], 'zh'),
        pt: clauses(['Uma pergunta.', 'Depois do epoch 480, as regras de slashing mudam?'], 'pt'),
      },
    },
    {
      speaker: 'rina', lang: 'id', gapMs: 1500, captureMs: 1120, translateMs: 700,
      captions: {
        id: clauses(['Aturan slashing tidak berubah.', 'Yang berubah hanya jendela unstaking,', 'dari 7 hari menjadi 5 hari.'], 'id'),
        en: clauses(['The slashing rules do not change.', 'Only the unstaking window changes,', 'from 7 days to 5 days.'], 'en'),
        ja: clauses(['slashing のルールは変わりません。', '変わるのは unstaking の期間だけで、', '7 日から 5 日になります。'], 'ja'),
        es: clauses(['Las reglas de slashing no cambian.', 'Solo cambia la ventana de unstaking,', 'de 7 días a 5 días.'], 'es'),
        zh: clauses(['slashing 的规则不变。', '只有 unstaking 的窗口会变，', '从 7 天变成 5 天。'], 'zh'),
        pt: clauses(['As regras de slashing não mudam.', 'Só muda a janela de unstaking,', 'de 7 dias para 5 dias.'], 'pt'),
      },
    },
  ],
};

const DEMO_SCRIPTS = [DEMO_ONBOARDING, DEMO_TOWNHALL];

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
  DEMO_SCRIPTS,
  PRESERVE_TERMS,
};
