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
  LIMITS,
  PRESERVE_TERMS,
};
