// The interface string table — English and Bahasa Indonesia.
//
// Issue #16: the app shipped with English chrome and Indonesian body copy, so
// every user read half a language they did not choose. The fix is not "pick
// English"; it is one table with both, resolved per user.
//
// Resolution order (implemented in public/app.js `boot()`):
//   1. user_language_prefs.ui_lang   the override this person set in-app
//   2. usernode.getUserLocale()      the platform-level preference
//   3. navigator.language            the device
//   4. 'en'
// A null platform locale means "no preference set", NOT English, which is why
// step 3 exists at all.
//
// Keys are flat dot paths. `{name}` placeholders are substituted by `t()`.
// A missing key falls back to English, and a missing English key returns the
// key itself, so a typo is visible rather than blank.
//
// House rule: no em dashes in any string in this file.

const STRINGS = {
  en: {
    'app.name': 'LIVE TRANSLATION',
    'app.tagline': 'You speak. They hear it in their language.',

    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.send': 'Send',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.retry': 'Try again',
    'common.loading': 'Loading',
    'common.none': 'None',
    'common.days7': '7 days',
    'common.hours24': '24 hours',
    'common.language': 'Language',

    'lobby.start': 'Start a call',
    'lobby.demo': 'See a 40 second demo',
    'lobby.demoBlurb': 'A scripted call between an Indonesian speaker and an English speaker. No microphone needed.',

    'room.notFound': 'Room not found',
    'room.notFoundBlurb': 'That code does not match an open room. Check it with whoever sent it.',
    'room.preview': 'Translation preview',
    'room.typedTitle': 'Type instead',
    'room.typedBlurb': 'Type your sentence and everything runs as usual: the original goes out, the translation comes back.',
    'room.disconnected': 'Connection lost. We are reconnecting, and anything you say will be queued.',
    'room.disconnectedQueued': 'Connection lost. {n} sentences are queued and will send when you are back.',
    'room.reconnected': 'Connected again.',
    'room.reconnectedSent': 'Connected again. {n} sentences sent.',
    'room.langSwitched': 'Language changed. The last {n} sentences are being translated again.',

    'audio.youHear': 'What you hear',
    'audio.both': 'You hear the room quietly under the translated voice.',
    'audio.original': 'No translated voice. Everything still appears as text.',
    'audio.translation': 'You only hear the translated voice.',
    'audio.trySentence': 'Try one sentence',
    'audio.cannotSpeak': 'This device cannot speak it. The full text is above.',
    'audio.missingSwitched': 'Spoken before you changed language. There is no {lang} text for this sentence.',
    'audio.missing': 'There is no {lang} text for this sentence. The original is above.',

    'metrics.title': 'Metrics',
    'metrics.endToEnd': 'End to end',
    'metrics.audioLeg': 'Audio leg',
    'metrics.captureLeg': 'Microphone p50 / p95',
    'metrics.translateLeg': 'Translation p50 / p95',
    'metrics.deliverLeg': 'Delivery p50 / p95',
    'metrics.deliverNote': 'to the screen',
    'metrics.totalLeg': 'All three legs p50 / p95',
    'metrics.heardLeg': 'Heard p50 / p95',
    'metrics.audioStart': 'Voice start p50 / p95',
    'metrics.audioFallbacks': 'Could not be spoken',
    'metrics.audioFallbackNote': 'fell back to text',
    'metrics.noSamples': 'No end to end samples in this range yet.',
    'metrics.noAudio': 'Nothing has been spoken in this range yet.',
    'metrics.samples': 'samples',
    'metrics.readiness': 'Production readiness',
    'metrics.readinessBlurb': 'The same thresholds the alert evaluator uses.',
    'metrics.failures': 'Failure causes',
    'metrics.noFailures': 'No failed captions in this range.',
    'metrics.range': 'Range',
    'metrics.adminOnly': 'visible to app admins',
    'metrics.target': 'target',

    'verdict.pass': 'Pass',
    'verdict.warn': 'Warn',
    'verdict.crit': 'Critical',
    'verdict.insufficient': 'Not enough data',

    'alerts.title': 'Alerts',
    'alerts.open': 'Open',
    'alerts.resolved': 'Recently resolved',
    'alerts.none': 'No alerts have fired.',
    'alerts.noneOpen': 'Nothing is firing right now.',
    'alerts.banner': '{n} alerts are open.',
    'alerts.opened': 'opened',
    'alerts.rule.latency_p95': 'Captions are slow',
    'alerts.rule.first_word_p95': 'First words are slow',
    'alerts.rule.error_rate': 'Translations are failing',
    'alerts.rule.audio_fallback_rate': 'Captions cannot be spoken',
    'alerts.rule.silent_room': 'A room went quiet',
    'alerts.rule.proxy_grants': 'People are declining AI access',

    'errors.title': 'Errors',
    'errors.none': 'No errors recorded in this range.',
    'errors.recent': 'Ten most recent',
    'errors.server': 'Server',
    'errors.client': 'Browser',

    'compat.title': 'Device check',
    'compat.blurb': 'What this browser can actually do. Run it on the device you plan to use for the call.',
    'compat.speech': 'Speech recognition',
    'compat.mic': 'Microphone in this frame',
    'compat.tts': 'Speech synthesis',
    'compat.voices': 'Voices installed',
    'compat.audioContext': 'Audio mixing and ducking',
    'compat.storage': 'Local storage',
    'compat.longPoll': 'Long poll delivery',
    'compat.safeArea': 'Safe area insets',
    'compat.yes': 'Works',
    'compat.no': 'Not available',
    'compat.unknown': 'Cannot tell',
    'compat.micBlocked': 'Blocked by the page that embeds this app',
    'compat.micNote': 'The platform does not delegate microphone access to app frames, and a frame that was never granted it fails with the same code as a person tapping Block. When this row is not green, type instead: the typed composer runs the identical path.',
    'compat.typedFallback': 'Typed input is the primary input on this device.',

    'feedback.title': 'How did the call go?',
    'feedback.blurb': 'Two questions and a box. It goes to the people building this.',
    'feedback.rating': 'How well did it work?',
    'feedback.comment': 'What happened?',
    'feedback.commentPlaceholder': 'What worked, what did not, what you expected instead.',
    'feedback.contactOk': 'You may contact me about this',
    'feedback.purpose': 'What were you doing?',
    'feedback.submit': 'Send feedback',
    'feedback.thanks': 'Thank you. That is recorded.',
    'feedback.tooMany': 'You have sent several notes recently. Try again in an hour.',
    'feedback.listTitle': 'Pilot feedback',
    'feedback.listEmpty': 'No feedback yet.',
    'feedback.average': 'Average score',
    'feedback.byPurpose': 'By use case',
    'feedback.fromRoom': 'from room {code}',

    'err.not_authenticated': 'Sign in through the platform to use this app.',
    'err.room_not_found': 'No call is using that code.',
    'err.removed_by_host': 'The host removed you from this call.',
    'err.not_a_member': 'You are not in this call.',
    'err.host_only': 'Only the host can do that.',
    'err.cannot_moderate_self': 'You cannot do that to yourself.',
    'err.bad_user_id': 'That person is not in this call.',
    'err.bad_tier': 'That is not a room size this app offers.',
    'err.muted_by_host': 'The host muted you in this call.',
    'err.empty_text': 'There was nothing to send.',
    'err.too_long': 'That is longer than one turn of speech. Send it in pieces.',
    'err.not_yours': 'You can only change what you said.',
    'err.forbidden': 'That is not available to your account.',
    'err.not_found': 'That is not here.',
    'err.bad_request': 'Something in that request did not look right.',
    'err.rate_limited': 'That is happening too fast. Wait a moment and try again.',
    'err.room_full': 'This room is full.',
    'err.room_ended': 'This room has ended.',
    'err.too_many_rooms': 'You have started several rooms in the last hour. Try again later.',
    'err.too_many_languages': 'A room can carry {n} translated languages at once. Ask someone to switch to one already in the room.',
    'err.room_busy': 'The room is getting more speech than it can translate. Give it a moment.',
    'err.room_full_tier': 'This {tier} holds {n} people. The host can move it to a larger room.',
    'err.too_many_languages_tier': 'This call already carries {n} listening languages, the maximum for a {tier}.',
    'err.cannot_shrink_tier': 'A room can grow mid-call but cannot shrink. Nobody gets ejected.',
    'err.listen_only': 'Raise your hand to ask for the floor.',
    'err.captions_behind': 'This call is producing captions faster than we can translate them.',
    'err.internal': 'Something broke on our side. The request id below helps us find it.',
    'err.unavailable': 'That is not available right now.',

    'telephony.note': 'Dialling in by phone needs a telephony bridge the platform does not provide yet. It is announced here so nobody builds around a promise that does not exist.',
    'telephony.label': 'Join by phone',
    'telephony.comingSoon': 'coming soon',
  },

  id: {
    'app.name': 'LIVE TRANSLATION',
    'app.tagline': 'Anda bicara. Mereka mendengarnya dalam bahasa mereka.',

    'common.cancel': 'Batal',
    'common.save': 'Simpan',
    'common.send': 'Kirim',
    'common.close': 'Tutup',
    'common.back': 'Kembali',
    'common.retry': 'Coba lagi',
    'common.loading': 'Memuat',
    'common.none': 'Tidak ada',
    'common.days7': '7 hari',
    'common.hours24': '24 jam',
    'common.language': 'Bahasa',

    'lobby.start': 'Mulai panggilan',
    'lobby.demo': 'Lihat demo 40 detik',
    'lobby.demoBlurb': 'Panggilan bernaskah antara penutur bahasa Indonesia dan penutur bahasa Inggris. Tidak perlu mikrofon.',

    'room.notFound': 'Ruangan tidak ditemukan',
    'room.notFoundBlurb': 'Kode itu tidak cocok dengan ruangan yang terbuka. Periksa lagi dengan pengirimnya.',
    'room.preview': 'Pratinjau terjemahan',
    'room.typedTitle': 'Ketik saja',
    'room.typedBlurb': 'Ketik kalimat Anda dan semuanya berjalan seperti biasa: teks asli terkirim, terjemahannya kembali.',
    'room.disconnected': 'Sambungan putus. Kami mencoba menyambung lagi, dan apa pun yang Anda ucapkan akan diantre.',
    'room.disconnectedQueued': 'Sambungan putus. {n} kalimat diantre dan akan terkirim setelah tersambung.',
    'room.reconnected': 'Tersambung lagi.',
    'room.reconnectedSent': 'Tersambung lagi. {n} kalimat terkirim.',
    'room.langSwitched': 'Bahasa diganti. {n} kalimat terakhir sedang diterjemahkan ulang.',

    'audio.youHear': 'Yang Anda dengar',
    'audio.both': 'Anda mendengar ruangan pelan di bawah suara terjemahan.',
    'audio.original': 'Tidak ada suara terjemahan. Semua tetap tampil sebagai teks.',
    'audio.translation': 'Anda hanya mendengar suara terjemahan.',
    'audio.trySentence': 'Coba satu kalimat',
    'audio.cannotSpeak': 'Tidak bisa dibacakan di perangkat ini. Teksnya lengkap di atas.',
    'audio.missingSwitched': 'Diucapkan sebelum Anda pindah bahasa. Tidak ada teks {lang} untuk kalimat ini.',
    'audio.missing': 'Tidak ada teks {lang} untuk kalimat ini. Yang asli ada di atas.',

    'metrics.title': 'Metrik',
    'metrics.endToEnd': 'Ujung ke ujung',
    'metrics.audioLeg': 'Jalur suara',
    'metrics.captureLeg': 'Mikrofon p50 / p95',
    'metrics.translateLeg': 'Terjemahan p50 / p95',
    'metrics.deliverLeg': 'Kirim p50 / p95',
    'metrics.deliverNote': 'ke layar',
    'metrics.totalLeg': 'Tiga jalur p50 / p95',
    'metrics.heardLeg': 'Terdengar p50 / p95',
    'metrics.audioStart': 'Mulai suara p50 / p95',
    'metrics.audioFallbacks': 'Gagal dibacakan',
    'metrics.audioFallbackNote': 'jatuh ke teks',
    'metrics.noSamples': 'Belum ada sampel ujung ke ujung pada rentang ini.',
    'metrics.noAudio': 'Belum ada kalimat yang dibacakan pada rentang ini.',
    'metrics.samples': 'sampel',
    'metrics.readiness': 'Kesiapan produksi',
    'metrics.readinessBlurb': 'Ambang yang sama dengan yang dipakai evaluator peringatan.',
    'metrics.failures': 'Penyebab kegagalan',
    'metrics.noFailures': 'Tidak ada teks gagal pada rentang ini.',
    'metrics.range': 'Rentang',
    'metrics.adminOnly': 'hanya untuk admin aplikasi',
    'metrics.target': 'target',

    'verdict.pass': 'Lulus',
    'verdict.warn': 'Peringatan',
    'verdict.crit': 'Kritis',
    'verdict.insufficient': 'Data belum cukup',

    'alerts.title': 'Peringatan',
    'alerts.open': 'Terbuka',
    'alerts.resolved': 'Baru selesai',
    'alerts.none': 'Belum ada peringatan yang muncul.',
    'alerts.noneOpen': 'Tidak ada yang menyala sekarang.',
    'alerts.banner': '{n} peringatan sedang terbuka.',
    'alerts.opened': 'dibuka',
    'alerts.rule.latency_p95': 'Teks terlalu lambat',
    'alerts.rule.first_word_p95': 'Kata pertama terlalu lambat',
    'alerts.rule.error_rate': 'Terjemahan gagal',
    'alerts.rule.audio_fallback_rate': 'Teks tidak bisa dibacakan',
    'alerts.rule.silent_room': 'Sebuah ruangan sunyi',
    'alerts.rule.proxy_grants': 'Banyak yang menolak akses AI',

    'errors.title': 'Kesalahan',
    'errors.none': 'Tidak ada kesalahan pada rentang ini.',
    'errors.recent': 'Sepuluh terbaru',
    'errors.server': 'Server',
    'errors.client': 'Peramban',

    'compat.title': 'Cek perangkat',
    'compat.blurb': 'Apa yang benar-benar bisa dilakukan peramban ini. Jalankan di perangkat yang akan Anda pakai untuk panggilan.',
    'compat.speech': 'Pengenalan suara',
    'compat.mic': 'Mikrofon di dalam frame ini',
    'compat.tts': 'Sintesis suara',
    'compat.voices': 'Suara yang terpasang',
    'compat.audioContext': 'Pencampuran dan peredaman suara',
    'compat.storage': 'Penyimpanan lokal',
    'compat.longPoll': 'Pengiriman long poll',
    'compat.safeArea': 'Inset area aman',
    'compat.yes': 'Berfungsi',
    'compat.no': 'Tidak tersedia',
    'compat.unknown': 'Tidak bisa dipastikan',
    'compat.micBlocked': 'Diblokir oleh halaman yang memuat aplikasi ini',
    'compat.micNote': 'Platform tidak mendelegasikan akses mikrofon ke frame aplikasi, dan frame yang tidak pernah diberi izin gagal dengan kode yang sama seperti orang yang menekan Blokir. Kalau baris ini tidak hijau, ketik saja: komposer ketik menjalankan jalur yang sama persis.',
    'compat.typedFallback': 'Masukan ketik adalah masukan utama di perangkat ini.',

    'feedback.title': 'Bagaimana panggilannya?',
    'feedback.blurb': 'Dua pertanyaan dan satu kotak. Ini sampai ke orang yang membangunnya.',
    'feedback.rating': 'Seberapa baik jalannya?',
    'feedback.comment': 'Apa yang terjadi?',
    'feedback.commentPlaceholder': 'Apa yang berhasil, apa yang tidak, apa yang Anda harapkan.',
    'feedback.contactOk': 'Boleh hubungi saya soal ini',
    'feedback.purpose': 'Anda sedang apa?',
    'feedback.submit': 'Kirim masukan',
    'feedback.thanks': 'Terima kasih. Sudah tercatat.',
    'feedback.tooMany': 'Anda sudah mengirim beberapa catatan. Coba lagi satu jam lagi.',
    'feedback.listTitle': 'Masukan pilot',
    'feedback.listEmpty': 'Belum ada masukan.',
    'feedback.average': 'Skor rata-rata',
    'feedback.byPurpose': 'Per kasus pakai',
    'feedback.fromRoom': 'dari ruangan {code}',

    'err.not_authenticated': 'Masuk lewat platform untuk memakai aplikasi ini.',
    'err.room_not_found': 'Tidak ada panggilan dengan kode itu.',
    'err.removed_by_host': 'Tuan rumah mengeluarkan Anda dari panggilan ini.',
    'err.not_a_member': 'Anda tidak ada di panggilan ini.',
    'err.host_only': 'Hanya tuan rumah yang bisa melakukan itu.',
    'err.cannot_moderate_self': 'Anda tidak bisa melakukan itu pada diri sendiri.',
    'err.bad_user_id': 'Orang itu tidak ada di panggilan ini.',
    'err.bad_tier': 'Ukuran ruangan itu tidak tersedia.',
    'err.muted_by_host': 'Tuan rumah membisukan Anda di panggilan ini.',
    'err.empty_text': 'Tidak ada yang bisa dikirim.',
    'err.too_long': 'Itu lebih panjang dari satu giliran bicara. Kirim sepotong-sepotong.',
    'err.not_yours': 'Anda hanya bisa mengubah apa yang Anda katakan.',
    'err.forbidden': 'Itu tidak tersedia untuk akun Anda.',
    'err.not_found': 'Itu tidak ada di sini.',
    'err.bad_request': 'Ada yang tidak beres dengan permintaan itu.',
    'err.rate_limited': 'Terlalu cepat. Tunggu sebentar lalu coba lagi.',
    'err.room_full': 'Ruangan ini penuh.',
    'err.room_ended': 'Ruangan ini sudah selesai.',
    'err.too_many_rooms': 'Anda sudah membuka beberapa ruangan dalam satu jam terakhir. Coba lagi nanti.',
    'err.too_many_languages': 'Satu ruangan bisa membawa {n} bahasa terjemahan sekaligus. Minta seseorang pindah ke bahasa yang sudah ada.',
    'err.room_busy': 'Ruangan menerima lebih banyak ucapan daripada yang bisa diterjemahkan. Beri waktu sebentar.',
    'err.room_full_tier': '{tier} ini memuat {n} orang. Host bisa memindahkannya ke ruangan yang lebih besar.',
    'err.too_many_languages_tier': 'Panggilan ini sudah membawa {n} bahasa dengar, maksimum untuk {tier}.',
    'err.cannot_shrink_tier': 'Ruangan bisa membesar di tengah panggilan tapi tidak bisa mengecil. Tidak ada yang dikeluarkan.',
    'err.listen_only': 'Angkat tangan untuk meminta giliran bicara.',
    'err.captions_behind': 'Panggilan ini menghasilkan teks lebih cepat daripada yang bisa kami terjemahkan.',
    'err.internal': 'Ada yang rusak di sisi kami. Id permintaan di bawah membantu kami menemukannya.',
    'err.unavailable': 'Itu sedang tidak tersedia.',

    'telephony.note': 'Panggilan lewat telepon butuh jembatan telefoni yang belum disediakan platform. Ini diumumkan di sini supaya tidak ada yang membangun di atas janji yang belum ada.',
    'telephony.label': 'Gabung lewat telepon',
    'telephony.comingSoon': 'segera hadir',
  },
};

const UI_LANGS = Object.keys(STRINGS);
const DEFAULT_UI_LANG = 'en';

// Map any BCP-47 tag onto a table we actually ship. "pt-BR" has no table, so
// it lands on English rather than on a half-translated screen.
function resolveUiLang(tag) {
  if (!tag) return null;
  const s = String(tag).toLowerCase();
  if (STRINGS[s]) return s;
  const prefix = s.split('-')[0];
  return STRINGS[prefix] ? prefix : null;
}

function fill(template, vars) {
  if (!vars) return template;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  ));
}

function t(lang, key, vars) {
  const table = STRINGS[resolveUiLang(lang) || DEFAULT_UI_LANG] || STRINGS.en;
  const raw = table[key] != null ? table[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
  return fill(raw, vars);
}

module.exports = { STRINGS, UI_LANGS, DEFAULT_UI_LANG, resolveUiLang, t };
