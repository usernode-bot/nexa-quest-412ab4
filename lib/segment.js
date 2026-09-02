// Clause sealing — turning a caption that is still being written into speech
// that can start now.
//
// A streamed caption is rewritten in place until it is finished, so speaking
// it as it arrives would mean reading half a sentence and then the same
// sentence again. Sealing solves that without waiting: the server cuts the
// text at clause boundaries and marks everything up to the last complete
// boundary IMMUTABLE. A sealed segment is a promise — it will never be
// rewritten — so the listener's synthesiser can start on clause 1 while
// clause 2 is still being generated.
//
// Everything here is pure. No pool, no clock, no config beyond the constants,
// which is what makes the rule ("never speak an unsealed segment") checkable
// from both ends of the wire.

const CONFIG = require('./config');

const { AUDIO } = CONFIG;

// Sentence enders. A cut after one of these is a natural place to breathe.
const STRONG = '.!?。！？…';
// Clause separators. Weaker, but a long sentence with no full stop still has
// to be broken somewhere or the first word waits for the last one.
const WEAK = ',;:、，；：';
// Punctuation that legitimately trails a sentence ender.
const TRAILING = /["'”’)\]」』]/;
// CJK punctuation carries its own spacing; latin punctuation needs a space
// after it before we believe it ended a clause (so "1.4.5" and "e.g." survive).
const CJK_PUNCT = '。！？、，；：…';

function isBoundaryChar(ch) {
  return STRONG.indexOf(ch) >= 0 || WEAK.indexOf(ch) >= 0;
}

// Every offset in `text` at which a clause legitimately ends, in order.
// `final` allows the very end of the text to be one of them.
function cutPoints(text, final) {
  const cuts = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!isBoundaryChar(ch)) continue;
    // A decimal point or a version number is not a clause end. Translating
    // "1.4.5" and then breathing inside it is worse than not breathing.
    if ((ch === '.' || ch === ',') && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue;
    let j = i + 1;
    while (j < text.length && TRAILING.test(text[j])) j += 1;
    if (j >= text.length) {
      if (final) cuts.push(j);
      continue;
    }
    if (CJK_PUNCT.indexOf(ch) < 0 && !/\s/.test(text[j])) continue;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    cuts.push(j);
  }
  return cuts;
}

// Seal what can be sealed. `sealed` is the list already promised to clients;
// it is never rewritten, only appended to.
//
// Returns { segments, diverged }. `diverged` means the caption no longer
// starts with what we already sealed, which must never happen with an
// append-only stream — the flag exists so a bug cannot turn into a listener
// hearing two different versions of the same clause.
function sealSegments(sealed, textSoFar, opts) {
  const options = opts || {};
  const final = !!options.final;
  const list = Array.isArray(sealed) ? sealed.filter((s) => typeof s === 'string') : [];
  const text = String(textSoFar == null ? '' : textSoFar);
  const prefix = list.join('');
  if (prefix && !text.startsWith(prefix)) return { segments: list, diverged: true };

  const rest = text.slice(prefix.length);
  const cuts = cutPoints(rest, final);
  const out = list.slice();

  let consumed = 0;
  let guard = 0;
  while (out.length < AUDIO.SEGMENT_MAX_COUNT && guard < 256) {
    guard += 1;
    const remaining = rest.slice(consumed);
    if (!remaining.trim()) break;

    // The first clause of the utterance seals sooner. See FIRST_SEGMENT_MIN_CHARS.
    const minChars = out.length === 0 ? AUDIO.FIRST_SEGMENT_MIN_CHARS : AUDIO.SEGMENT_MIN_CHARS;
    const cut = cuts.find((at) => at - consumed >= minChars);
    let at = cut === undefined ? -1 : cut;

    if (at < 0 || at - consumed > AUDIO.SEGMENT_MAX_CHARS) {
      if (remaining.length <= AUDIO.SEGMENT_MAX_CHARS) {
        // Nothing sealable yet. A short tail with no boundary is exactly the
        // case where waiting is right: the next token may finish the clause.
        if (!final) break;
        at = rest.length;
      } else {
        // The run is already longer than a listener wants to wait for. Break
        // it at the last word boundary inside the cap rather than mid-word.
        const window = rest.slice(consumed, consumed + AUDIO.SEGMENT_MAX_CHARS);
        const sp = window.lastIndexOf(' ');
        at = consumed + (sp > minChars ? sp + 1 : AUDIO.SEGMENT_MAX_CHARS);
      }
    }

    if (at <= consumed) break;
    out.push(rest.slice(consumed, at));
    consumed = at;
  }

  // On the final pass the segments must reconstruct the caption exactly, or
  // a listener hears a shorter sentence than the one on their screen.
  if (final && consumed < rest.length) {
    const tail = rest.slice(consumed);
    if (tail.trim()) out.push(tail);
  }

  return { segments: out, diverged: false };
}

// The concatenated segments must be a prefix of the caption. Used as the
// safety net at finalization and as the client-side invariant's rule.
function verifyPrefix(segments, text) {
  const joined = (Array.isArray(segments) ? segments : []).join('');
  return String(text == null ? '' : text).startsWith(joined);
}

// Finalization. If anything at all disagrees, throw the segment list away and
// speak the finished caption as a single segment: one honest reading beats a
// clever one that contradicts what is on screen.
function finalize(sealed, finalText) {
  const text = String(finalText == null ? '' : finalText);
  if (!text.trim()) return { segments: [], reset: false };
  const r = sealSegments(sealed, text, { final: true });
  if (r.diverged || r.segments.join('') !== text) {
    return { segments: [text], reset: true };
  }
  return { segments: r.segments, reset: false };
}

module.exports = { sealSegments, finalize, verifyPrefix, cutPoints };
