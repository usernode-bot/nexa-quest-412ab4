// Language-group resolver.
//
// The single idea that makes a 200-person townhall affordable: the axis that
// costs money is G — the number of DISTINCT target languages in the room — not
// N, the number of people. Twelve Indonesian listeners are one translation
// call, not twelve. So the roster is collapsed into groups before anything is
// translated, and the group is what gets fanned out to.
//
// It is also the roster the LARGE tier sends to the client: two hundred rows
// of names is not something a poll should carry every second, but "three
// languages, 61 / 74 / 65 people" is, and it is what the room actually needs
// to show.

const { LIMITS, DEGRADE_THRESHOLDS } = require('./config');

/**
 * Collapse a room's live participants into language groups, largest first.
 * Returns `[{ lang, size, speaking, hands }]`.
 */
async function languageGroups(pool, roomId) {
  const { rows } = await pool.query(
    `SELECT hears_lang AS lang,
            COUNT(*)::int AS size,
            COUNT(*) FILTER (WHERE mic_on)::int AS speaking,
            COUNT(*) FILTER (WHERE hand_raised_at IS NOT NULL)::int AS hands
       FROM room_participants
      WHERE room_id = $1 AND left_at IS NULL AND removed = FALSE
      GROUP BY hears_lang
      ORDER BY COUNT(*) DESC, hears_lang ASC`,
    [roomId]
  );
  return rows;
}

/**
 * Which languages this utterance should actually be translated into.
 *
 * Three bounds, applied in order, all of them structural rather than hopeful:
 *   1. Never translate into the language it was spoken in.
 *   2. The tier's own cap, and never above the global MAX_TARGET_LANGS.
 *   3. The degradation ladder, when the speaker's AI budget is running out.
 *
 * `degrade` is one of 'normal' | 'shed_small' | 'floor_only' |
 * 'transcript_only' (see lib/cost.js). The ladder deliberately keeps the
 * BIGGEST groups — degrading should cost the fewest people their captions.
 */
function resolveTargets(groups, sourceLang, tier, degrade, opts) {
  const options = opts || {};
  if (degrade === 'transcript_only') return [];

  let list = (groups || []).filter((g) => g.lang && g.lang !== sourceLang);

  // 'floor_only' means only a floor-holder's speech is worth translating; a
  // non-holder still gets a transcript, same as transcript_only.
  if (degrade === 'floor_only' && !options.speakerHoldsFloor) return [];

  if (degrade === 'shed_small' && list.length > 1) {
    list = list.slice(0, 1);
  }

  const cap = Math.min(
    (tier && tier.maxTargetLangs) || LIMITS.MAX_TARGET_LANGS,
    LIMITS.MAX_TARGET_LANGS
  );
  return list.slice(0, cap);
}

/**
 * The last known translation status per target language in a room, so the
 * aggregated roster can say "Japanese: unavailable" without shipping every
 * translation row to every client.
 */
async function groupStatuses(pool, roomId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (target_lang) target_lang, status
       FROM utterance_translations
      WHERE room_id = $1
      ORDER BY target_lang, seq DESC`,
    [roomId]
  );
  return Object.fromEntries(rows.map((r) => [r.target_lang, r.status]));
}

module.exports = { languageGroups, resolveTargets, groupStatuses, DEGRADE_THRESHOLDS };
