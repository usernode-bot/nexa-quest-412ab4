// The audio bus — how a sealed caption becomes a voice.
//
// No audio ever crosses the network in this app. Speech recognition runs in
// the speaker's browser, only text is POSTed, and the translated caption is
// spoken here, on the listener's own device, by speechSynthesis. That is not
// a stylistic choice: the platform LLM proxy is text only, its file storage
// accepts images only, and neither credential exists in a staging preview. So
// the voice has to be local, and everything hard about making local synthesis
// feel live lives in this file.
//
// Four pieces:
//   VoiceResolver  picking a voice for a language, around an API that reports
//                  its voice list asynchronously and sometimes not at all
//   DuckBus        one place that decides what gets quieter while we speak,
//                  so the microphone and (later) the original voice never
//                  fight over the same rule
//   SpeechQueue    the actual mouth: bounded, catch-up aware, and it never
//                  speaks a segment the server has not sealed
//   AudioClock     when a segment started being spoken, for the audio leg of
//                  the latency measurement
//
// The bus reports failure rather than hiding it. If a voice will not start,
// the caption stays on screen and the listener is told they are reading
// rather than listening. Silence that looks like success is the one outcome
// worth engineering against.

(function () {
  'use strict';

  function now() { return Date.now(); }

  // --- voices ----------------------------------------------------------------
  // getVoices() is empty on first call in most browsers and fills in later via
  // 'voiceschanged'. Some devices never fire it. Re-reading on every pick is
  // cheap and is the only thing that works everywhere.
  function createVoiceResolver() {
    var cache = [];
    function load() {
      try { cache = (window.speechSynthesis && window.speechSynthesis.getVoices()) || []; }
      catch (e) { cache = []; }
      return cache;
    }
    if (window.speechSynthesis) {
      load();
      try { window.speechSynthesis.addEventListener('voiceschanged', load); }
      catch (e) { try { window.speechSynthesis.onvoiceschanged = load; } catch (e2) {} }
    }
    return {
      count: function () { return (cache.length ? cache : load()).length; },
      pick: function (tag) {
        var list = cache.length ? cache : load();
        if (!list.length) return null;
        var t = String(tag || '').toLowerCase().replace('_', '-');
        var base = t.split('-')[0];
        var exact = null; var loose = null;
        for (var i = 0; i < list.length; i += 1) {
          var vl = String(list[i].lang || '').toLowerCase().replace('_', '-');
          if (!vl) continue;
          if (vl === t && !exact) exact = list[i];
          if (vl.split('-')[0] === base && !loose) loose = list[i];
        }
        return exact || loose || null;
      },
    };
  }

  // --- ducking ---------------------------------------------------------------
  // Sinks register a floor: the gain they drop to while a translation is
  // being spoken. The microphone recogniser registers at floor 0 (it stops
  // outright, which is what today's echo suppression already does). When a
  // transport for the original voice lands, it registers at DUCK_GAIN and
  // gets quieter instead of disappearing. Nothing else in the app decides
  // this, so the two can never disagree.
  function createDuckBus(cfg) {
    var sinks = new Map();
    var ducked = false;
    var holdTimer = null;

    function apply() {
      sinks.forEach(function (s) {
        try { s.apply(ducked ? s.floor : 1, ducked ? cfg.DUCK_ATTACK_MS : cfg.DUCK_RELEASE_MS); }
        catch (e) {}
      });
    }

    return {
      register: function (name, floor, apply2) {
        sinks.set(name, { floor: Math.max(0, Math.min(1, Number(floor) || 0)), apply: apply2 });
        if (ducked) { try { apply2(sinks.get(name).floor, 0); } catch (e) {} }
      },
      unregister: function (name) { sinks.delete(name); },
      duck: function () {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (ducked) return;
        ducked = true;
        apply();
      },
      release: function () {
        if (!ducked) return;
        if (holdTimer) clearTimeout(holdTimer);
        // A short hold stops the microphone flapping open between two
        // segments of the same sentence.
        holdTimer = setTimeout(function () {
          holdTimer = null;
          ducked = false;
          apply();
        }, cfg.DUCK_HOLD_MS);
      },
      cancelHold: function () { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } },
      isDucked: function () { return ducked; },
      sinkCount: function () { return sinks.size; },
    };
  }

  // --- the bus ----------------------------------------------------------------
  function createAudioBus(opts) {
    var options = opts || {};
    var cfg = options.config || {};
    var on = options.on || {};
    var voices = createVoiceResolver();
    var duck = createDuckBus(cfg);

    var mode = cfg.DEFAULT_MODE || 'both';
    var queue = [];              // { key, utteranceId, targetLang, tag, index, text, offeredAt, ageMs }
    var spoken = new Map();      // key -> highest segment index already spoken
    var offered = new Map();     // key -> { first, sealedIdx, final, started }
    var speaking = null;
    var watchdog = null;
    var startTimer = null;
    var fallbacks = new Set();   // keys the listener is reading instead of hearing
    var consecutiveFailures = 0;
    var disabled = false;        // switched off after repeated failures
    var unsealedBlocked = 0;     // invariant counter: must stay 0
    var lastOutcome = null;

    function supported() {
      return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    }

    function wantsTranslation() { return mode !== 'original' && !disabled; }

    function changed() { if (typeof on.change === 'function') { try { on.change(); } catch (e) {} } }

    function markFallback(key, reason) {
      if (fallbacks.has(key)) return;
      fallbacks.add(key);
      lastOutcome = 'fallback';
      consecutiveFailures += 1;
      if (consecutiveFailures >= cfg.CONSECUTIVE_FALLBACKS_OFF) {
        // Three in a row is not bad luck, it is a device that cannot do this.
        disabled = true;
        lastOutcome = 'off';
        queue.length = 0;
      }
      if (typeof on.fallback === 'function') {
        var parts = String(key).split('|');
        try { on.fallback({ utteranceId: Number(parts[0]), targetLang: parts[1], reason: reason }); } catch (e) {}
      }
      changed();
    }

    function utteranceKeys() {
      var set = new Set();
      for (var i = 0; i < queue.length; i += 1) set.add(queue[i].key);
      return set;
    }

    // Bounded on both axes. A listener who fell behind wants the CURRENT
    // sentence, not a faithful replay of the last minute, so the oldest
    // utterance is dropped whole rather than trimming its tail.
    function trim() {
      while (queue.length > cfg.MAX_QUEUE_SEGMENTS) {
        var dropped = queue.shift();
        if (dropped) markFallback(dropped.key, 'queue_overflow');
      }
      var keys = [];
      for (var i = 0; i < queue.length; i += 1) {
        if (keys.indexOf(queue[i].key) < 0) keys.push(queue[i].key);
      }
      while (keys.length > cfg.MAX_QUEUE_UTTERANCES) {
        var drop = keys.shift();
        queue = queue.filter(function (it) { return it.key !== drop; });
        markFallback(drop, 'queue_overflow');
      }
    }

    function rate() {
      return queue.length > cfg.CATCHUP_AFTER_SEGMENTS ? cfg.RATE_CATCHUP : cfg.RATE_NORMAL;
    }

    function finish(item, outcome) {
      if (speaking !== item) return;
      speaking = null;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      if (outcome === 'ok') {
        consecutiveFailures = 0;
        lastOutcome = 'spoken';
      }
      if (!queue.length) duck.release();
      pump();
      changed();
    }

    function pump() {
      if (speaking || !queue.length) return;
      if (!wantsTranslation() || !supported()) { queue.length = 0; return; }

      var item = queue.shift();

      // Too old to be worth hearing. Being three sentences behind is worse
      // than reading this one.
      if (now() - item.offeredAt + (item.ageMs || 0) > cfg.STALE_MS) {
        markFallback(item.key, 'stale');
        pump();
        return;
      }

      var text = String(item.text || '').trim();
      if (!text) { pump(); return; }

      var u;
      try { u = new window.SpeechSynthesisUtterance(text); }
      catch (e) { markFallback(item.key, 'synthesis_failed'); pump(); return; }

      var voice = voices.pick(item.tag);
      if (voice) u.voice = voice;
      u.lang = item.tag;
      u.rate = rate();

      speaking = item;
      duck.cancelHold();
      duck.duck();

      var startedAt = now();
      var began = false;

      u.onstart = function () {
        began = true;
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        var prior = spoken.get(item.key);
        spoken.set(item.key, Math.max(prior === undefined ? -1 : prior, item.index));
        var rec = offered.get(item.key);
        if (rec && !rec.started) {
          rec.started = true;
          if (typeof on.spoken === 'function') {
            try {
              on.spoken({
                utteranceId: item.utteranceId,
                targetLang: item.targetLang,
                // A duration this device measured, plus the age the SERVER
                // computed. Never a timestamp, so the two clocks never have
                // to agree on anything.
                audioMs: Math.max(0, Math.round((item.ageMs || 0) + (startedAt - item.offeredAt))),
              });
            } catch (e) {}
          }
        }
        changed();
      };
      u.onend = function () { finish(item, 'ok'); };
      u.onerror = function () {
        if (!began) markFallback(item.key, 'synthesis_error');
        finish(item, 'error');
      };

      // Chrome in particular will accept an utterance and simply never start
      // it. Nothing reports that, so we time it ourselves.
      startTimer = setTimeout(function () {
        startTimer = null;
        if (began) return;
        markFallback(item.key, 'never_started');
        try { window.speechSynthesis.cancel(); } catch (e) {}
        finish(item, 'error');
      }, cfg.START_DEADLINE_MS);

      // onend is unreliable for long utterances; the watchdog is what keeps
      // the queue moving when it never fires.
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(function () { finish(item, 'watchdog'); }, cfg.SPEAK_WATCHDOG_MS);

      try { window.speechSynthesis.speak(u); }
      catch (e) { markFallback(item.key, 'synthesis_failed'); finish(item, 'error'); }
      changed();
    }

    return {
      // --- listening mode ---
      get mode() { return mode; },
      setMode: function (next) {
        var list = cfg.MODES || ['translation', 'original', 'both'];
        var m = list.indexOf(next) >= 0 ? next : (cfg.DEFAULT_MODE || 'both');
        if (m === mode) return mode;
        mode = m;
        if (!wantsTranslation()) this.clear();
        changed();
        return mode;
      },
      wantsTranslation: wantsTranslation,
      supported: supported,
      voiceCount: function () { return voices.count(); },
      voiceFor: function (tag) { var v = voices.pick(tag); return v ? v.name : null; },

      // --- ducking ---
      duck: duck,
      registerSink: function (name, floor, apply) { duck.register(name, floor, apply); },
      unregisterSink: function (name) { duck.unregister(name); },

      // Offer sealed segments. Only indices below `sealedIdx` are eligible:
      // an unsealed segment can still be rewritten, and a listener must never
      // hear a sentence that the screen then contradicts.
      offer: function (o) {
        if (!o || !wantsTranslation() || !supported()) return 0;
        var key = String(o.utteranceId) + '|' + o.targetLang;
        if (fallbacks.has(key)) return 0;
        var segments = Array.isArray(o.segments) ? o.segments : [];
        var sealedIdx = Number.isFinite(Number(o.sealedIdx)) ? Number(o.sealedIdx) : segments.length;
        if (sealedIdx > segments.length) {
          // The server promised more than it sent. Trust the shorter one.
          unsealedBlocked += 1;
          sealedIdx = segments.length;
        }
        var already = spoken.get(key);
        var from = already === undefined ? -1 : already;
        for (var i = 0; i < queue.length; i += 1) {
          if (queue[i].key === key) from = Math.max(from, queue[i].index);
        }
        var rec = offered.get(key);
        if (!rec) { rec = { first: now(), sealedIdx: 0, final: false, started: false }; offered.set(key, rec); }
        rec.sealedIdx = Math.max(rec.sealedIdx, sealedIdx);
        rec.final = rec.final || !!o.final;

        var added = 0;
        for (var j = from + 1; j < sealedIdx; j += 1) {
          var text = segments[j];
          if (typeof text !== 'string' || !text.trim()) continue;
          queue.push({
            key: key,
            utteranceId: Number(o.utteranceId),
            targetLang: o.targetLang,
            tag: o.ttsTag || o.targetLang,
            index: j,
            text: text,
            offeredAt: now(),
            ageMs: Number.isFinite(Number(o.ageMs)) ? Number(o.ageMs) : 0,
          });
          added += 1;
        }
        if (!added) return 0;
        trim();
        pump();
        changed();
        return added;
      },

      // Called on every poll so an utterance that was offered but never got a
      // voice degrades to text instead of sitting silently forever.
      sweep: function () {
        var cut = now();
        var self = this;
        offered.forEach(function (rec, key) {
          if (rec.started || fallbacks.has(key)) return;
          if (cut - rec.first > cfg.FALLBACK_MS) self.noteFallback(key, 'never_spoke');
        });
        if (!speaking && !queue.length) duck.release();
      },

      noteFallback: function (key, reason) { markFallback(key, reason || 'fallback'); },
      isFallback: function (utteranceId, targetLang) {
        return fallbacks.has(String(utteranceId) + '|' + targetLang);
      },

      clear: function () {
        queue.length = 0;
        speaking = null;
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
        duck.cancelHold();
        duck.release();
        changed();
      },

      reset: function () {
        this.clear();
        spoken.clear();
        offered.clear();
        fallbacks.clear();
        consecutiveFailures = 0;
        disabled = false;
        unsealedBlocked = 0;
        lastOutcome = null;
      },

      // Everything the invariants, the issue snapshot and the demo panel read.
      // No caption text: this shape goes into public GitHub issue bodies.
      state: function () {
        var keys = utteranceKeys();
        return {
          mode: mode,
          supported: supported(),
          disabled: disabled,
          voices: voices.count(),
          queuedSegments: queue.length,
          queuedUtterances: keys.size,
          speaking: !!speaking,
          ducked: duck.isDucked(),
          sinks: duck.sinkCount(),
          fallbacks: fallbacks.size,
          consecutiveFailures: consecutiveFailures,
          unsealedBlocked: unsealedBlocked,
          rate: rate(),
          lastOutcome: lastOutcome,
        };
      },
    };
  }

  window.LTAudio = { createAudioBus: createAudioBus };
}());
