/* LIVE TRANSLATION — client.
 *
 * Architecture note worth keeping in mind while reading: NO AUDIO EVER
 * LEAVES THE BROWSER. Speech-to-text runs locally (Web Speech API), only the
 * recognised text is POSTed, translation happens server-side through the
 * platform LLM proxy, and the translated caption is spoken back by the local
 * speech synthesiser. That is what makes this buildable under platform rules
 * — and it is also why it works on a bad connection.
 */
(function () {
  'use strict';

  // --- plumbing ------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const authHeaders = token ? { 'x-usernode-token': token } : {};

  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch(path, {
      method: o.method || 'GET',
      headers: o.body
        ? { 'Content-Type': 'application/json', ...authHeaders }
        : { ...authHeaders },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data && data.error;
      err.data = data;
      throw err;
    }
    return data;
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const appEl = () => document.getElementById('app');

  function notify(msg) {
    if (window.unNative && typeof window.unNative.toast === 'function') {
      try { window.unNative.toast(msg); return; } catch { /* fall through */ }
    }
    const el = document.createElement('div');
    el.className = 'fixed left-1/2 -translate-x-1/2 bottom-6 z-50 px-4 py-2 rounded-full bg-zinc-800 text-zinc-100 text-sm shadow-lg';
    el.style.bottom = 'calc(1.5rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // --- interface language --------------------------------------------------
  // The table is served verbatim inside /api/config, so the client and the
  // server cannot drift on a string. `t()` mirrors lib/strings.js exactly:
  // missing key falls back to English, missing English returns the key, so a
  // typo shows up on screen instead of blanking a label.
  function t(key, vars) {
    const tables = (S.config && S.config.strings) || {};
    const table = tables[S.uiLang] || tables.en || {};
    const en = tables.en || {};
    const raw = table[key] != null ? table[key] : (en[key] != null ? en[key] : key);
    if (!vars) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (m, k) => (
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
    ));
  }

  // The same lookup, but pinned to a language the caller names instead of the
  // interface one. Used for text that is SPOKEN rather than read: the words
  // have to match the voice tag they are handed to, and that voice belongs to
  // the listening language, not to whatever the buttons are written in.
  function tFor(lang, key, vars) {
    const tables = (S.config && S.config.strings) || {};
    const table = tables[lang] || tables.en || {};
    const en = tables.en || {};
    const raw = table[key] != null ? table[key] : (en[key] != null ? en[key] : key);
    if (!vars) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (m, k) => (
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
    ));
  }

  // Map any BCP-47 tag onto a table we ship, or null for "no preference".
  function resolveUiLang(tag) {
    if (!tag) return null;
    const tables = (S.config && S.config.strings) || {};
    const v = String(tag).toLowerCase();
    if (tables[v]) return v;
    const prefix = v.split('-')[0];
    return tables[prefix] ? prefix : null;
  }

  // What the interface language would be with no in-app choice: the platform
  // setting, then the device, then English. Synchronous, because the platform
  // answer is cached on S — the picker needs to label its "Match my device" row
  // without awaiting anything. A null platform locale means "no preference
  // recorded", not "English", which is why it falls through to the device.
  function resolveAutoUiLang() {
    return resolveUiLang(S.platformLocale)
      || resolveUiLang(navigator.language)
      || (S.config && S.config.defaultUiLang)
      || 'en';
  }

  // The full chain, applied. `?lang=` is a display-only override for one page
  // view: it writes nothing and survives no reload, which is what makes it safe
  // to point a screenshot at.
  function applyUiLang() {
    const forced = resolveUiLang(new URLSearchParams(location.search).get('lang'));
    S.uiLang = forced || resolveUiLang(S.prefs && S.prefs.uiLang) || resolveAutoUiLang();
    document.documentElement.setAttribute('lang', S.uiLang);
    return S.uiLang;
  }

  // --- client error reporting ----------------------------------------------
  // Deliberately a fetch and never a console.error: every proposal gets a
  // free "loads with no console errors" check, so a caught error written to
  // the console would fail the merge gate for the app working as designed.
  // The endpoint always answers {ok:true}, so this never needs a retry.
  const reported = new Set();
  function report(where, err) {
    try {
      const code = (err && (err.code || err.name)) || 'unknown';
      const key = `${where}:${code}`;
      // One report per cause per session. A poll that fails every second is
      // one problem, not three hundred.
      if (reported.has(key)) return;
      reported.add(key);
      const body = {
        roomCode: (S.route && S.route.code) || null,
        errors: [{
          where: String(where).slice(0, 64),
          code: String(code).slice(0, 48),
          message: String((err && err.message) || '').slice(0, 300),
        }],
      };
      fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch { /* reporting must never be the thing that breaks */ }
  }
  window.ltReport = report;

  // --- state ---------------------------------------------------------------
  const S = {
    config: null,
    // The interface language. Resolved in boot(); `?lang=` overrides it for
    // one page view and writes nothing.
    uiLang: 'en',
    // The platform-level locale, asked for ONCE in boot() and cached here so
    // the interface language can be re-resolved synchronously every time the
    // picker moves. null means "not asked yet or no preference recorded", which
    // is not the same as English.
    platformLocale: null,
    metricsRange: '7d',
    prefs: { speaksLang: 'en', hearsLang: 'en', audioMode: 'both', ttsEnabled: true, uiLang: null, isDefault: true },
    route: null,
    room: null,
    me: null,
    isMember: false,
    hearsLang: 'en',
    participants: new Map(),
    utterances: new Map(),
    cursor: 0,
    pollTimer: null,
    lastChangeAt: Date.now(),
    connected: true,
    spokenIds: new Set(),
    listening: false,
    floorHeldUntil: 0,
    metrics: null,
    summary: null,
    error: null,
    // Stage 2 architecture — everything tier-shaped arrives on /stream.
    tier: null,
    rosterMode: 'full',
    participantCount: 0,
    langGroups: [],
    activeSpeakers: [],
    queue: [],
    myQueuePosition: null,
    budget: null,
    dialIn: null,
    // A tab that was hidden comes back to a backlog. Reading four minutes of
    // captions aloud at once is noise, not translation.
    suppressTts: false,
    // When this listener last changed the language they hear. Sentences older
    // than this were spoken to a room that had no caption for them, and the
    // feed says so instead of pretending one is still coming.
    langSwitchedAt: 0,
    backfilling: 0,
    // Delivery-latency samples measured in this tab, batched to the server.
    latency: { pending: [], recent: [], lastSentAt: 0, sampled: new Set(), byKey: new Map() },
    // Translate-leg samples observed in this room, used to size the audio
    // bus lead-in. Bounded, and reset when the route changes.
    translateSamples: [],
    // Sealed clauses already handed to the audio bus, so a caption that is
    // still streaming is offered once per new clause and never re-offered.
    offeredSegments: new Map(),
    audioDemo: false,
    // What the listener was hearing before they muted, so the quick toggle
    // puts them back where they were instead of guessing a default.
    lastHeardMode: null,
    // Did the last /stream call hold the connection open, and is it worth
    // asking it to. Server decides; this is only what it last answered.
    held: false,
    restTick: false,
    // How long the last held /stream call actually parked for, in ms. The
    // device-check screen reports it: an observed hold is the only honest
    // proof that this browser and this network let a long poll through.
    lastHoldMs: 0,
    // Capability flags gathered by /admin/compat, reused by the pilot
    // feedback form. Flags and counters only, never caption text.
    compat: null,
    // The scripted demo call. Client-side only: no API calls, no rows, no
    // spend, and available in every environment because it is not data.
    demo: { timers: [], seq: 0, running: false },
  };

  // The room's tier, with a shape that is safe to read before the first poll
  // lands. The server is the authority; this only keeps the first paint sane.
  const tierOf = () =>
    S.tier ||
    ((S.config && S.config.tiers) || [])[0] ||
    {
      key: 'direct', label: 'Direct call', speakerSlots: 1, rosterMode: 'full',
      handQueue: false, maxParticipants: 4, maxTargetLangs: 2, pollActiveMs: 900,
    };

  const langOf = (code) =>
    (S.config && S.config.languages.find((l) => l.code === code)) ||
    { code, label: code, english: code, stt: code, tts: code, flag: '🏳️' };

  // Unsent utterances survive a dropped connection or a frame reload (the
  // platform shell re-points the iframe when the network comes back).
  const OUTBOX_KEY = 'lt.outbox.v1';
  const outbox = {
    read() {
      try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
    },
    write(list) {
      try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-40))); } catch { /* private mode */ }
    },
    add(item) { const l = this.read(); l.push(item); this.write(l); },
    remove(id) { this.write(this.read().filter((i) => i.id !== id)); },
  };

  // --- routing -------------------------------------------------------------
  function parseRoute() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    let m = p.match(/^\/room\/([A-Za-z0-9]{3,12})\/ended$/);
    if (m) return { name: 'ended', code: m[1].toUpperCase() };
    m = p.match(/^\/room\/([A-Za-z0-9]{3,12})$/);
    if (m) return { name: 'room', code: m[1].toUpperCase() };
    if (p === '/admin/metrics') return { name: 'metrics' };
    if (p === '/admin/alerts') return { name: 'alerts' };
    if (p === '/admin/compat') return { name: 'compat' };
    if (p === '/admin/feedback') return { name: 'adminFeedback' };
    if (p === '/admin/errors') return { name: 'errors' };
    if (p === '/feedback') return { name: 'feedback' };
    if (p === '/demo') return { name: 'demo' };
    return { name: 'lobby' };
  }

  function navigate(to, opts) {
    const type = (opts && opts.transition) || 'push';
    const go = () => { history.pushState({}, '', to); render(); };
    if (window.unNative && typeof window.unNative.transition === 'function' && type !== 'none') {
      try { window.unNative.transition(go, { type }); return; } catch { /* fall through */ }
    }
    go();
  }
  window.addEventListener('popstate', () => render());

  // --- shared chrome -------------------------------------------------------
  function header(title, opts) {
    const o = opts || {};
    return `
      <header class="sticky top-0 z-30 bg-zinc-950/85 backdrop-blur border-b border-zinc-800"
              style="padding-top: var(--un-safe-inset-top, env(safe-area-inset-top, 0px))">
        <div class="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          ${o.back ? `<button data-nav="${esc(o.back)}" class="un-touch-target -ml-1 text-violet-400 text-sm">‹ Back</button>` : ''}
          <div class="min-w-0 flex-1">
            <h1 class="text-sm font-semibold truncate">${esc(title)}</h1>
            ${o.subtitle ? `<p class="text-xs text-zinc-500 truncate">${esc(o.subtitle)}</p>` : ''}
          </div>
          ${o.right || ''}
        </div>
      </header>`;
  }

  function langChip(code, muted) {
    const l = langOf(code);
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${muted ? 'bg-zinc-800 text-zinc-400' : 'bg-violet-600/20 text-violet-300'}">${l.flag} ${esc(l.label)}</span>`;
  }

  // --- language sheet ------------------------------------------------------
  // Rendered as our own DOM (not a kit sheet) so `#lang-sheet` is a stable
  // test anchor and the `?screen=languages` deep link renders identically in
  // production, where the "before" screenshot is taken.
  // Step 1 of the interface-language chain has always been writable through
  // the API and documented in the troubleshooting guide, but nothing in the UI
  // could reach it. This section is that missing control. "Match my device" is
  // the null row: it clears the stored choice and hands the decision back to
  // the platform locale, then the device.
  function uiLangSectionHTML() {
    const codes = (S.config && S.config.uiLangs) || ['en'];
    const langs = (S.config && S.config.languages) || [];
    const stored = S.prefs && S.prefs.uiLang ? String(S.prefs.uiLang) : '';
    const row = (code, label, sub, on) => `
      <button data-ui-lang-pick data-code="${esc(code)}" aria-pressed="${on ? 'true' : 'false'}"
              class="un-pressable w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left ${on ? 'bg-violet-600/20 ring-1 ring-violet-500' : 'bg-zinc-900'}">
        <span class="flex-1 min-w-0">
          <span class="block text-sm">${esc(label)}</span>
          ${sub ? `<span class="block text-xs text-zinc-500">${esc(sub)}</span>` : ''}
        </span>
        ${on ? '<span class="text-violet-400 text-sm">✓</span>' : ''}
      </button>`;
    // Endonyms, exactly as in the speak / hear lists: a language's own name is
    // the one label a person can recognise without already reading the
    // interface language.
    const rows = codes.map((code) => {
      const l = langs.find((x) => x.code === code);
      const label = l ? `${l.flag} ${l.label}` : code;
      return row(code, label, l ? l.english : '', stored === code);
    });
    return `
      <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">${esc(t('sheet.uiLang'))}</h3>
      <div id="ui-lang-picker" data-ui-lang="${esc(stored)}" class="grid gap-1.5 mb-2">
        ${row('', t('sheet.uiLangAuto'), langOf(resolveAutoUiLang() || 'en').label, !stored)}
        ${rows.join('')}
      </div>
      <p class="text-xs text-zinc-600 mb-5">${esc(t('sheet.uiLangBlurb'))}</p>
    `;
  }

  function renderLanguageSheet() {
    const overlay = document.getElementById('overlay');
    const langs = (S.config && S.config.languages) || [];
    const soon = (S.config && S.config.comingSoon) || [];

    const option = (l, field, selected) => `
      <button data-lang-pick="${esc(field)}" data-code="${esc(l.code)}"
              class="un-pressable w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left ${selected ? 'bg-violet-600/20 ring-1 ring-violet-500' : 'bg-zinc-900'}">
        <span class="text-lg">${l.flag}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm truncate">${esc(l.label)}</span>
          <span class="block text-xs text-zinc-500 truncate">${esc(l.english)}</span>
        </span>
        ${selected ? '<span class="text-violet-400 text-sm">✓</span>' : ''}
      </button>`;

    overlay.innerHTML = `
      <div class="fixed inset-0 z-40 bg-black/60" data-close-sheet></div>
      <section id="lang-sheet" role="dialog" aria-label="${esc(t('sheet.aria'))}"
               class="fixed inset-x-0 bottom-0 z-50 max-h-[88vh] overflow-y-auto rounded-t-2xl bg-zinc-950 border-t border-zinc-800 fade-in"
               style="padding-bottom: calc(1.25rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">
        <div class="max-w-2xl mx-auto px-4 pt-3">
          <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-700"></div>
          <h2 class="text-base font-semibold">${esc(t('sheet.title'))}</h2>
          <p class="text-xs text-zinc-500 mt-0.5 mb-4">${esc(t('sheet.blurb'))}</p>

          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">${esc(t('sheet.iSpeak'))}</h3>
          <div class="grid gap-1.5 mb-5">
            ${langs.map((l) => option(l, 'speaksLang', S.prefs.speaksLang === l.code)).join('')}
          </div>

          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">${esc(t('sheet.iHear'))}</h3>
          <div class="grid gap-1.5 mb-5">
            ${langs.map((l) => option(l, 'hearsLang', S.prefs.hearsLang === l.code)).join('')}
          </div>

          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">${esc(t('audio.youHear'))}</h3>
          <div id="audio-mode-sheet" data-mode="${esc(audioMode())}" class="grid gap-1.5 mb-2">
            ${(((S.config && S.config.audio) || {}).MODES || ['translation', 'original', 'both']).map((m) => {
              const on = m === audioMode();
              return `
                <button data-audio-mode-pick="${esc(m)}" aria-pressed="${on ? 'true' : 'false'}"
                        class="un-pressable w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left ${on ? 'bg-violet-600/20 ring-1 ring-violet-500' : 'bg-zinc-900'}">
                  <span class="text-lg">${AUDIO_MODE_ICONS[m] || '🔈'}</span>
                  <span class="flex-1 min-w-0">
                    <span class="block text-sm">${esc(audioModeLabel(m))}</span>
                    <span class="block text-xs text-zinc-500">${esc(audioModeHint(m))}</span>
                  </span>
                  ${on ? '<span class="text-violet-400 text-sm">✓</span>' : ''}
                </button>`;
            }).join('')}
          </div>
          <p class="text-xs text-zinc-600 mb-5">${esc(t('audio.hearingIn', { lang: langOf(S.prefs.hearsLang).label }))}</p>

          ${uiLangSectionHTML()}

          ${soon.length ? `
            <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">${esc(t('sheet.comingSoon'))}</h3>
            <div class="flex flex-wrap gap-1.5 mb-5">
              ${soon.map((l) => `<span class="px-2 py-1 rounded-full bg-zinc-900 text-zinc-500 text-xs">${l.flag} ${esc(l.label)}</span>`).join('')}
            </div>` : ''}

          <button id="lang-save" class="un-pressable w-full py-3 rounded-xl bg-violet-600 text-white font-medium">${esc(t('sheet.save'))}</button>
        </div>
      </section>`;

    overlay.querySelectorAll('[data-lang-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        S.prefs[b.dataset.langPick] = b.dataset.code;
        renderLanguageSheet();
      });
    });
    const closeSheet = () => {
      overlay.innerHTML = '';
      const url = new URL(location.href);
      url.searchParams.delete('screen');
      history.replaceState({}, '', url.pathname + url.search);
      render();
    };
    overlay.querySelector('[data-close-sheet]').addEventListener('click', closeSheet);
    overlay.querySelectorAll('[data-ui-lang-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        // Applied immediately so the sheet you are looking at re-renders in the
        // language you just picked; Save is what makes it survive a reload.
        S.prefs.uiLang = b.dataset.code || null;
        applyUiLang();
        renderLanguageSheet();
      });
    });
    overlay.querySelectorAll('[data-audio-mode-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        // Applied to the bus straight away so the change is audible before the
        // sheet is saved; the save is what makes it survive a reload.
        S.prefs.audioMode = b.dataset.audioModePick;
        S.prefs.ttsEnabled = S.prefs.audioMode !== 'original';
        const bus = ensureAudio();
        if (bus) bus.setMode(S.prefs.audioMode);
        renderLanguageSheet();
      });
    });
    overlay.querySelector('#lang-save').addEventListener('click', async () => {
      const hadHears = S.hearsLang;
      const lastGood = Object.assign({}, S.prefs);
      try {
        // uiLang is sent explicitly, including as null: the server preserves a
        // stored value for any key the body omits, so "Match my device" has to
        // say null out loud or it can never be cleared.
        const body = Object.assign({}, S.prefs, { uiLang: S.prefs.uiLang || null });
        const r = await api('/api/me/prefs', { method: 'PUT', body });
        S.prefs = r.prefs;
        applyUiLang();
        if (S.route && S.route.name === 'room' && S.isMember) {
          const patched = await api(`/api/rooms/${S.route.code}/me`, {
            method: 'PATCH',
            body: {
              speaksLang: S.prefs.speaksLang,
              hearsLang: S.prefs.hearsLang,
              audioMode: S.prefs.audioMode,
            },
          });
          if (S.prefs.hearsLang !== hadHears) {
            // Everything already on screen was said for the old language. Mark
            // the moment so a caption with no row for the new one can say why,
            // instead of looking like it is still loading.
            S.langSwitchedAt = Date.now();
            S.latency.sampled.clear();
            S.latency.byKey.clear();
            S.offeredSegments.clear();
            if (Audio) Audio.reset();
            S.backfilling = patched.backfilling || 0;
            if (S.backfilling) {
              notify(t('room.langSwitched', { n: S.backfilling }));
            }
          }
          S.cursor = 0;
        }
        notify(t('sheet.saved'));
      } catch (err) {
        // The picker already repainted the interface. A failed save has to put
        // that back, or the app is speaking a language the server never stored.
        S.prefs = lastGood;
        applyUiLang();
        notify(err.message);
      }
      closeSheet();
    });
  }

  function openLanguageSheet() {
    const url = new URL(location.href);
    url.searchParams.set('screen', 'languages');
    history.replaceState({}, '', url.pathname + url.search);
    renderLanguageSheet();
  }

  // --- lobby ---------------------------------------------------------------
  async function renderLobby() {
    const purposes = (S.config && S.config.purposes) || [];
    appEl().innerHTML = `
      ${header('LIVE TRANSLATION', { subtitle: 'Talk in your language. They hear theirs.' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-6"
            style="padding-bottom: calc(2rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">

        <button id="open-langs" class="un-pressable w-full flex items-center gap-3 p-4 rounded-2xl bg-zinc-900 text-left">
          <span class="text-2xl">${langOf(S.prefs.speaksLang).flag}${langOf(S.prefs.hearsLang).flag}</span>
          <span class="flex-1 min-w-0">
            <span class="block text-sm">You speak ${esc(langOf(S.prefs.speaksLang).label)}</span>
            <span class="block text-sm text-zinc-400">You hear ${esc(langOf(S.prefs.hearsLang).label)}</span>
          </span>
          <span class="text-zinc-600">›</span>
        </button>

        <section>
          <h2 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">What is this call for?</h2>
          <div class="grid sm:grid-cols-2 gap-2" id="purpose-grid">
            ${purposes.map((p, i) => `
              <button data-purpose="${esc(p.key)}"
                      class="un-pressable p-3 rounded-xl text-left bg-zinc-900 ring-1 ${i === 0 ? 'ring-violet-500' : 'ring-transparent'}">
                <span class="block text-lg">${p.icon}</span>
                <span class="block text-sm font-medium mt-1">${esc(p.label)}</span>
                <span class="block text-xs text-zinc-500 mt-0.5">${esc(p.blurb)}</span>
              </button>`).join('')}
          </div>
        </section>

        <section class="space-y-2">
          <button id="try-demo" data-nav="/demo"
                  class="un-pressable w-full p-3 rounded-xl bg-zinc-900 text-left ring-1 ring-zinc-800">
            <span class="block text-sm font-medium">${esc(t('lobby.demo'))}</span>
            <span class="block text-xs text-zinc-500 mt-0.5">${esc(t('lobby.demoBlurb'))}</span>
          </button>
          <input id="room-title" maxlength="120" placeholder="Call title (optional)"
                 class="w-full px-3 py-3 rounded-xl bg-zinc-900 text-sm placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500">
          <button id="start-call" class="un-pressable w-full py-3.5 rounded-xl bg-violet-600 text-white font-semibold">
            ${esc(t('lobby.start'))}
          </button>
        </section>

        <section>
          <h2 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">Join with a code</h2>
          <form id="join-form" class="flex gap-2">
            <input id="join-code" maxlength="12" placeholder="ABC123" autocapitalize="characters"
                   class="flex-1 px-3 py-3 rounded-xl bg-zinc-900 text-sm uppercase tracking-widest placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500">
            <button class="un-pressable px-5 rounded-xl bg-zinc-800 text-sm font-medium">Join</button>
          </form>
        </section>

        <section id="open-rooms">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">Open calls</h2>
          <p class="text-sm text-zinc-600">Loading…</p>
        </section>

        <p class="text-center text-xs text-zinc-700">
          <a href="/admin/metrics" data-nav="/admin/metrics" class="underline decoration-zinc-800">Service metrics</a>
        </p>
      </main>`;

    let purpose = purposes.length ? purposes[0].key : 'support';
    $$('[data-purpose]').forEach((b) => b.addEventListener('click', () => {
      purpose = b.dataset.purpose;
      $$('[data-purpose]').forEach((x) => x.classList.toggle('ring-violet-500', x === b));
      $$('[data-purpose]').forEach((x) => x.classList.toggle('ring-transparent', x !== b));
    }));

    $('#open-langs').addEventListener('click', openLanguageSheet);

    $('#start-call').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('/api/rooms', {
          method: 'POST',
          body: {
            title: $('#room-title').value.trim(),
            purpose,
            speaksLang: S.prefs.speaksLang,
            hearsLang: S.prefs.hearsLang,
          },
        });
        navigate(`/room/${r.room.code}`);
      } catch (err) {
        e.target.disabled = false;
        notify(err.message);
      }
    });

    $('#join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#join-code').value.trim().toUpperCase();
      if (!code) return;
      navigate(`/room/${code}`);
    });

    try {
      const { rooms } = await api('/api/rooms/mine');
      const el = $('#open-rooms');
      if (!rooms.length) {
        el.innerHTML = `<h2 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">Open calls</h2>
          <p class="text-sm text-zinc-600">No calls running. Start one above.</p>`;
        return;
      }
      el.innerHTML = `<h2 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">Open calls</h2>
        <div class="un-group grid gap-1.5">
          ${rooms.map((r) => `
            <button data-nav="/room/${esc(r.code)}" class="un-pressable un-group-row w-full flex items-center gap-3 p-3 rounded-xl bg-zinc-900 text-left">
              <span class="flex-1 min-w-0">
                <span class="block text-sm truncate">${esc(r.title)}</span>
                <span class="block text-xs text-zinc-500">${esc(r.code)} · ${esc(r.purpose)} · ${r.liveCount} in the room</span>
              </span>
              <span class="text-zinc-600">›</span>
            </button>`).join('')}
        </div>`;
      bindNav(el);
    } catch { /* the lobby is still usable without the list */ }
  }

  function bindNav(root) {
    $$('[data-nav]', root).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(el.dataset.nav);
      });
    });
  }

  // --- speech: recognition (in) and synthesis (out) -------------------------
  const Speech = {
    rec: null,
    wantListening: false,
    suppressed: false,
    // When the recogniser first produced anything for the phrase now being
    // spoken. The gap between that and the final transcript is the capture
    // leg of the latency budget, and this clock is the only one that sees it.
    phraseStartedAt: 0,
    stream: null,
    audioCtx: null,
    analyser: null,
    levelRaf: null,

    supported() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },

    async start(langCode, onFinal) {
      if (!this.supported()) throw new Error('This browser cannot do speech recognition. Type instead.');
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.wantListening = true;
      this.onFinal = onFinal;
      this.langCode = langCode;

      const rec = new Ctor();
      rec.lang = langOf(langCode).stt;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const r = ev.results[i];
          const text = (r[0] && r[0].transcript ? r[0].transcript : '').trim();
          if (!text) continue;
          if (!this.phraseStartedAt) this.phraseStartedAt = Date.now();
          if (r.isFinal) {
            const captureMs = this.phraseStartedAt ? Date.now() - this.phraseStartedAt : null;
            this.phraseStartedAt = 0;
            this.onFinal(text, captureMs);
          } else interim += ` ${text}`;
        }
        setInterim(interim.trim());
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          this.wantListening = false;
          setMicError('Microphone blocked. Allow it in your browser, or type instead.');
        } else if (ev.error === 'no-speech' || ev.error === 'aborted') {
          /* normal in a quiet room */
        } else {
          setMicError(`Speech recognition: ${ev.error}`);
        }
      };
      // Chrome ends a continuous session on its own every ~60s; restart it
      // unless we deliberately stopped or are suppressing our own echo.
      rec.onend = () => {
        if (this.wantListening && !this.suppressed) {
          try { rec.start(); } catch { /* already starting */ }
        }
      };

      this.rec = rec;
      try { rec.start(); } catch { /* already started */ }
      await this.startLevelMeter();
    },

    stop() {
      this.wantListening = false;
      this.phraseStartedAt = 0;
      if (this.rec) { try { this.rec.stop(); } catch { /* ignore */ } }
      this.rec = null;
      this.stopLevelMeter();
      setInterim('');
    },

    // Echo suppression (Stage 4): while the local synthesiser is speaking a
    // translation, the recogniser must not hear it and re-translate our own
    // output into an infinite loop. Pause it, resume 250ms after the tail.
    suppress() {
      if (this.suppressed || !this.rec) return;
      this.suppressed = true;
      try { this.rec.stop(); } catch { /* ignore */ }
    },
    resume() {
      if (!this.suppressed) return;
      this.suppressed = false;
      if (this.wantListening && this.rec) {
        setTimeout(() => {
          if (this.wantListening && !this.suppressed && this.rec) {
            try { this.rec.start(); } catch { /* ignore */ }
          }
        }, 250);
      }
    },

    async startLevelMeter() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        return; // the recogniser may still work; the meter is a nicety
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128));
        setLevel(Math.min(1, peak / 60));
        this.levelRaf = requestAnimationFrame(tick);
      };
      tick();
    },

    stopLevelMeter() {
      if (this.levelRaf) cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
      this.analyser = null;
      if (this.audioCtx) { try { this.audioCtx.close(); } catch { /* ignore */ } this.audioCtx = null; }
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      setLevel(0);
    },
  };

  const Voice = {
    queue: [],
    speaking: false,
    watchdog: null,

    say(text, langCode) {
      if (!window.speechSynthesis || !text) return;
      this.queue.push({ text, langCode });
      this.pump();
    },

    pump() {
      if (this.speaking || !this.queue.length) return;
      const { text, langCode } = this.queue.shift();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langOf(langCode).tts;
      u.rate = 1.05;
      this.speaking = true;
      Speech.suppress();
      const done = () => {
        if (!this.speaking) return;
        this.speaking = false;
        clearTimeout(this.watchdog);
        if (!this.queue.length) Speech.resume();
        this.pump();
      };
      u.onend = done;
      u.onerror = done;
      // Some engines never fire onend on a cancelled utterance; never leave
      // the microphone suppressed forever because of it.
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(done, 30000);
      try { window.speechSynthesis.speak(u); } catch { done(); }
    },

    clear() {
      this.queue = [];
      this.speaking = false;
      clearTimeout(this.watchdog);
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
      Speech.resume();
    },
  };


  // --- audio bus -----------------------------------------------------------
  // Slice 2. The listener hears the translation on their own device: the
  // server seals immutable clauses out of the streaming caption, and the bus
  // speaks clause 1 while clause 2 is still being written. Nothing here sends
  // or receives audio over the network.
  //
  // `Voice` above stays as the one-shot path used outside a room (and by the
  // demo panel); inside a room every spoken word goes through the bus so the
  // queue caps, the ducking and the fallback budget apply.
  let Audio = null;

  function audioCfg() {
    return (S.config && S.config.audio) || {};
  }

  function audioMode() {
    const modes = audioCfg().MODES || ['translation', 'original', 'both'];
    const want = S.prefs.audioMode;
    if (modes.indexOf(want) >= 0) return want;
    return audioCfg().DEFAULT_MODE || 'both';
  }

  function ensureAudio() {
    if (Audio || !window.LTAudio) return Audio;
    Audio = window.LTAudio.createAudioBus({
      config: audioCfg(),
      on: {
        spoken: (ev) => noteAudioLeg(ev.utteranceId, ev.targetLang, ev.audioMs, 'spoken'),
        fallback: (ev) => {
          noteAudioLeg(ev.utteranceId, ev.targetLang, null, 'fallback');
          scheduleAudioRender();
        },
        change: () => refreshAudioPanel(),
      },
    });
    // The microphone is a duck sink with a floor of zero: while a translation
    // is being spoken the recogniser is off, which is exactly the Stage 4 echo
    // suppression rule, now expressed once for every sink instead of inline.
    Audio.registerSink('microphone', 0, (gain) => {
      if (gain < 1) Speech.suppress(); else Speech.resume();
    });
    Audio.setMode(audioMode());
    return Audio;
  }

  let audioRenderQueued = false;
  function scheduleAudioRender() {
    if (audioRenderQueued) return;
    audioRenderQueued = true;
    setTimeout(() => {
      audioRenderQueued = false;
      if (S.route && S.route.name === 'room' && S.room) renderRoom();
    }, 80);
  }

  // The bus changes state far more often than a caption arrives (every clause
  // start and end), so a full re-render would fight the composer for focus.
  // Only the demo panel reads the live numbers, so only it is refreshed.
  function refreshAudioPanel() {
    const el = document.getElementById('audio-demo-state');
    if (!el || !Audio) return;
    el.textContent = audioDemoLine(Audio.state());
  }

  // Push a caption's sealed clauses at the bus. Called for streaming captions
  // (partial, sealed prefix only) and again when the caption finishes; the bus
  // dedupes by segment index, so the same clause is never spoken twice.
  function offerAudio(u, tr, final) {
    if (!tr || !Audio || !S.room || S.room.endedAt) return;
    if (S.suppressTts) return;
    if (S.me && u && u.speakerUserId === S.me.userId) return;
    if (u && !S.room.twoWay) {
      const speaker = S.participants.get(u.speakerUserId);
      if (speaker && speaker.role === 'audience') return;
    }
    const segments = Array.isArray(tr.segments) && tr.segments.length
      ? tr.segments
      : (final && tr.text ? [tr.text] : []);
    const sealedIdx = Array.isArray(tr.segments) && tr.segments.length
      ? Math.min(Number(tr.sealedIdx || tr.segments.length), tr.segments.length)
      : segments.length;
    if (!sealedIdx) return;
    Audio.offer({
      utteranceId: tr.utteranceId != null ? tr.utteranceId : (u && u.id),
      targetLang: tr.targetLang || S.hearsLang,
      ttsTag: langOf(tr.targetLang || S.hearsLang).tts,
      segments,
      sealedIdx,
      final: !!final,
      ageMs: Number.isFinite(Number(tr.audioAgeMs)) ? Number(tr.audioAgeMs) : 0,
    });
  }

  // Sealed clauses of a caption that is STILL STREAMING. Deliberately does not
  // touch S.spokenIds: that set means "this whole utterance has been handled",
  // and marking a partial there would let the finished caption be skipped, and
  // would trip the no-tts-for-partial-captions invariant besides.
  function noteSegments(events) {
    if (!Array.isArray(events) || !events.length || !Audio) return;
    for (const ev of events) {
      if (!ev || ev.type !== 'translation.segment') continue;
      if (ev.targetLang !== S.hearsLang) continue;
      if (ev.final) continue; // the finished caption goes through the fresh path
      const u = S.utterances.get(ev.utteranceId);
      if (!u || u.retracted) continue;
      const key = `${ev.utteranceId}:${ev.targetLang}`;
      const had = S.offeredSegments.get(key) || 0;
      if (ev.sealedIdx <= had) continue;
      S.offeredSegments.set(key, ev.sealedIdx);
      offerAudio(u, {
        utteranceId: ev.utteranceId,
        targetLang: ev.targetLang,
        segments: ev.segments,
        sealedIdx: ev.sealedIdx,
        audioAgeMs: ev.audioAgeMs,
      }, false);
    }
  }

  // The fourth latency leg. The bus reports the time from "the clause was on
  // screen" to "the synthesiser actually started", added to the server's own
  // age for the clause. Attached to the delivery sample that is already
  // waiting to be sent, so no extra request exists for it.
  function noteAudioLeg(utteranceId, targetLang, audioMs, outcome) {
    const sample = S.latency.byKey.get(`${utteranceId}:${targetLang}`);
    if (!sample) return;
    if (audioMs != null && sample.audioMs == null) sample.audioMs = audioMs;
    if (!sample.audioOutcome || outcome === 'spoken') sample.audioOutcome = outcome;
  }

  async function setAudioMode(next) {
    const bus = ensureAudio();
    S.prefs.audioMode = next;
    S.prefs.ttsEnabled = next !== 'original';
    if (bus) bus.setMode(next);
    try {
      await api('/api/me/prefs', { method: 'PUT', body: S.prefs });
    } catch { /* the local choice still applies for this tab */ }
    if (S.route && S.route.name === 'room' && S.isMember) {
      try {
        await api(`/api/rooms/${S.route.code}/me`, { method: 'PATCH', body: { audioMode: next } });
      } catch { /* the room row catches up on the next save */ }
    }
  }

  // Only the glyphs live here now. An icon is the same in every language; the
  // label and the sentence under it come from the string table, so this
  // constant can no longer pin the section to one language the way it did.
  const AUDIO_MODE_ICONS = { translation: '🔊', original: '📝', both: '🎧' };

  const audioModeLabel = (m) => t(`audio.mode.${m}`);
  const audioModeHint = (m) => t(`audio.${m}`);

  // The three-mode selector. Rendered for members AND for someone reading the
  // room without having joined: choosing whether to be read to is a listener's
  // choice, and a non-member is a listener.
  function audioModeHTML(id) {
    const modes = audioCfg().MODES || ['translation', 'original', 'both'];
    const cur = audioMode();
    const st = Audio ? Audio.state() : null;
    let note = '';
    if (st && !st.supported) {
      note = t('audio.noTts');
    } else if (st && st.disabled) {
      note = t('audio.paused');
    } else {
      note = audioModeHint(cur);
    }
    return `
      <div id="${esc(id)}" data-mode="${esc(cur)}" class="p-3 rounded-xl bg-zinc-900 space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('audio.youHear'))}</span>
          <span class="flex-1"></span>
          ${st && st.speaking ? `<span class="text-[11px] text-emerald-400">${esc(t('audio.speaking'))}</span>` : ''}
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          ${modes.map((m) => {
            const on = m === cur;
            return `
              <button data-audio-mode="${esc(m)}" aria-pressed="${on ? 'true' : 'false'}"
                      class="un-pressable flex flex-col items-center gap-0.5 py-2 rounded-lg text-xs ${on ? 'bg-violet-600/20 ring-1 ring-violet-500 text-violet-200' : 'bg-zinc-800 text-zinc-400'}">
                <span class="text-base">${AUDIO_MODE_ICONS[m] || '🔈'}</span>
                <span>${esc(audioModeLabel(m))}</span>
              </button>`;
          }).join('')}
        </div>
        <p class="text-[11px] text-zinc-600">${esc(note)}</p>
        <p class="text-[11px] text-zinc-600">${esc(t('audio.hearingIn', { lang: langOf(S.hearsLang).label }))}</p>
      </div>`;
  }

  // Field names, not prose: this line is read by whoever is debugging the bus,
  // and ASCII keys stay the same in every interface language rather than
  // needing a translation nobody would trust.
  function audioDemoLine(st) {
    if (!st) return t('audio.busNotReady');
    return [
      `mode ${st.mode}`,
      `voices ${st.voices}`,
      `queued ${st.queuedSegments}/${st.queuedUtterances}`,
      `speaking ${st.speaking ? 'yes' : 'no'}`,
      `ducked ${st.ducked ? 'yes' : 'no'}`,
      `sinks ${st.sinks}`,
      `text ${st.fallbacks}`,
      `rate ${st.rate}`,
    ].join(' · ');
  }

  // `?audio=demo` is pure client state and writes nothing, so it renders in
  // BOTH environments: the "before" screenshot is taken from production, and a
  // panel that only existed in staging would never get one. It also renders on
  // a device with no synthesiser at all, saying so, which is what makes it
  // checkable headlessly.
  function audioDemoHTML() {
    if (!S.audioDemo) return '';
    const st = Audio ? Audio.state() : null;
    return `
      <section id="audio-demo" class="p-3 rounded-xl bg-zinc-900 ring-1 ring-violet-600/30 space-y-2">
        <h3 class="text-xs uppercase tracking-wide text-violet-300">${esc(t('audio.busTitle'))}</h3>
        <p class="text-[11px] text-zinc-500">${esc(t('audio.busBlurb'))}</p>
        <p id="audio-demo-state" class="text-[11px] font-mono text-zinc-400 break-words">${esc(audioDemoLine(st))}</p>
        <div class="flex gap-2">
          <button id="audio-demo-say" class="un-pressable flex-1 py-2 rounded-lg bg-zinc-800 text-xs">${esc(t('audio.trySentence'))}</button>
          <button id="audio-demo-stop" class="un-pressable flex-1 py-2 rounded-lg bg-zinc-800 text-xs">${esc(t('audio.stopVoice'))}</button>
        </div>
        ${st && !st.supported
          ? `<p class="text-[11px] text-amber-400/80">${esc(t('audio.noSynth'))}</p>`
          : ''}
      </section>`;
  }

  function setInterim(text) {
    const el = document.getElementById('interim');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }
  function setLevel(v) {
    const el = document.getElementById('level');
    if (el) el.style.transform = `scaleX(${v.toFixed(3)})`;
  }
  function setMicError(msg) {
    const el = document.getElementById('mic-error');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  // --- room ----------------------------------------------------------------
  // A caption with no row for your language is only MISSING once it is old
  // enough that the fan-out would have written one by now. Before that it is
  // simply still coming, which is a different sentence to show.
  function captionIsMissing(u) {
    const grace = ((S.config && S.config.latency) || {}).CAPTION_GRACE_MS || 15000;
    const at = new Date(u.createdAt).getTime();
    if (!Number.isFinite(at)) return false;
    return Date.now() - at > grace;
  }

  // A caption that was meant to be spoken but never was. Two ways to know:
  // the bus told us the synthesiser refused or never started, or the sealed
  // clause is older than the whole audio budget and no voice ever claimed it.
  // Either way the listener is reading it, and saying so beats silence they
  // cannot explain.
  function audioFellBack(u, tr) {
    if (!tr || tr.status !== 'ok') return false;
    if (audioMode() === 'original') return false;
    if (u.sourceLang === tr.targetLang) return false;
    if (Audio && Audio.isFallback(u.id, tr.targetLang)) return true;
    if (Audio && !Audio.state().supported) return false;
    const stale = audioCfg().STALE_MS || 12000;
    const age = Number(tr.audioAgeMs);
    const sealed = Array.isArray(tr.segments) && tr.segments.length;
    return !!sealed && Number.isFinite(age) && age > stale && !S.spokenIds.has(u.id);
  }

  function utteranceHTML(u) {
    const mine = S.me && u.speakerUserId === S.me.userId;
    const target = S.hearsLang;
    const tr = (u.translations || []).find((t) => t.targetLang === target);
    const sameLang = u.sourceLang === target;

    let translationBlock = '';
    if (u.retracted) {
      translationBlock = `<p class="translation text-sm text-zinc-600 italic">Retracted by the speaker.</p>`;
    } else if (sameLang) {
      translationBlock = `<p class="translation text-sm text-zinc-100">${esc(u.sourceText)}</p>
        <p class="text-xs text-zinc-600 mt-1">Already in your language</p>`;
    } else if (tr && tr.status === 'ok') {
      translationBlock = `<p class="translation text-sm text-zinc-100">${esc(tr.text)}</p>
        ${audioFellBack(u, tr)
          ? `<p class="audio-fallback text-[11px] text-amber-400/80 mt-1">${esc(t('audio.cannotSpeak'))}</p>`
          : ''}
        ${tr.latencyMs != null ? `<p class="text-[11px] text-zinc-700 mt-1">${tr.latencyMs} ms</p>` : ''}`;
    } else if (tr && tr.status === 'partial') {
      // The caption is still being generated. Shown dim and provisional, and
      // deliberately NEVER spoken — half a sentence read aloud, then the same
      // sentence again in full, is worse than a moment of silence.
      translationBlock = `<p class="translation partial text-sm text-zinc-400 italic">${esc(tr.text || '')}<span class="text-zinc-600">…</span></p>
        <p class="text-[11px] text-zinc-700 mt-1">Still coming through. Not read aloud until it is finished.</p>`;
    } else if (tr && tr.status === 'pending') {
      translationBlock = `<p class="translation text-sm text-zinc-500 animate-pulse">Translating into ${esc(langOf(target).label)}…</p>`;
    } else if (tr && tr.status === 'unavailable') {
      translationBlock = `<p class="translation text-sm text-amber-400/80">Translation unavailable here. Showing the original.</p>`;
    } else if (tr) {
      translationBlock = `<p class="translation text-sm text-red-400/80">Translation failed. The original is above.</p>`;
    } else if (captionIsMissing(u)) {
      // No row for this language, and the sentence is old enough that one is
      // not on its way. Usually because the listener changed hearing language
      // after it was said, so name that rather than spinning forever.
      const switched = S.langSwitchedAt
        && new Date(u.createdAt).getTime() < S.langSwitchedAt;
      translationBlock = `<p class="translation missing text-sm text-zinc-500">${
        switched
          ? esc(t('audio.missingSwitched', { lang: langOf(target).label }))
          : esc(t('audio.missing', { lang: langOf(target).label }))
      }</p>`;
    } else {
      translationBlock = `<p class="translation text-sm text-zinc-500">Waiting for a ${esc(langOf(target).label)} caption…</p>`;
    }

    return `
      <article class="utterance fade-in p-3 rounded-xl ${mine ? 'bg-violet-600/10 ring-1 ring-violet-600/30' : 'bg-zinc-900'}" data-utterance-id="${u.id}">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-xs font-medium ${mine ? 'text-violet-300' : 'text-zinc-400'}">${esc(u.speakerUsername)}</span>
          ${langChip(u.sourceLang, true)}
          ${u.via === 'typed' ? '<span class="text-[11px] text-zinc-600">typed</span>' : ''}
          <span class="flex-1"></span>
          ${!u.retracted && (mine || (S.room && S.me && S.room.hostUserId === S.me.userId))
            ? `<button data-retract="${u.id}" class="un-touch-target text-[11px] text-zinc-600">retract</button>` : ''}
          ${!u.retracted && !mine && S.isMember
            ? `<button data-report="${u.id}" class="un-touch-target text-[11px] text-zinc-600">report</button>` : ''}
        </div>
        ${u.retracted
          ? ''
          : `<p class="original text-sm text-zinc-500 mb-1.5">${esc(u.sourceText)}</p>`}
        ${translationBlock}
      </article>`;
  }

  // Who holds the floor right now, and how many slots there are to hold. A
  // direct call has one; a group meeting has three; a large room has one and a
  // queue behind it. Rendered at every tier, and for non-members too — "can I
  // speak right now" is the first thing anyone opening a room wants to know.
  function floorHTML() {
    const tier = tierOf();
    const slots = tier.speakerSlots || 1;
    const holders = S.activeSpeakers || [];
    const waiting = (S.queue || []).length;
    const names = holders.map((h) => h.username).join(', ');
    return `
      <div id="speaker-slots" data-tier="${esc(tier.key)}" data-slots="${slots}" data-held="${holders.length}"
           class="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 text-xs">
        <span class="shrink-0 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400" title="${esc(tier.blurb || '')}">${esc(tier.label)}</span>
        <span class="text-zinc-500 shrink-0">Floor</span>
        <span class="font-mono shrink-0 ${holders.length ? 'text-emerald-400' : 'text-zinc-600'}">${holders.length}/${slots}</span>
        <span class="min-w-0 flex-1 truncate ${holders.length ? 'text-zinc-300' : 'text-zinc-600'}">${
          holders.length ? `${esc(names)} speaking` : 'open, nobody is speaking'
        }</span>
        ${tier.handQueue && waiting
          ? `<span class="shrink-0 text-amber-400">✋ ${waiting} waiting</span>`
          : ''}
      </div>`;
  }

  // The dial-in leg does not exist yet and says so, in every environment. A
  // capability that only appeared in staging would be worse than none.
  function dialInHTML() {
    const d = S.dialIn || (S.config && S.config.dialIn);
    if (!d) return '';
    return `
      <div id="dial-in" class="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900/60 text-xs text-zinc-500">
        <span aria-hidden="true">☎️</span>
        <span class="min-w-0 flex-1">${esc(d.label)} — ${esc(d.note)}</span>
        <button id="dial-in-why" class="un-touch-target text-[11px] text-zinc-600 underline">why</button>
      </div>`;
  }

  // A large room's roster is a shape, not a list: nobody scrolls two hundred
  // names, and the poll should not carry them. The server sends language
  // groups instead, and this renders the same .lang-group sections the full
  // roster does so everything downstream (including the invariant) still works.
  function aggregateRosterHTML() {
    const groups = S.langGroups || [];
    const total = S.participantCount || 0;
    if (!groups.length) {
      return `<div id="roster" class="space-y-2"><p class="text-sm text-zinc-600">Nobody in the room yet.</p></div>`;
    }
    const statusLabel = {
      ok: 'captions flowing', pending: 'translating…', partial: 'translating…',
      unavailable: 'no translation here', error: 'translation failing', off: 'transcript only', idle: 'quiet',
    };
    return `<div id="roster" class="space-y-3">
      <h3 class="text-xs uppercase tracking-wide text-zinc-500">${total} in the room · ${groups.length} languages</h3>
      ${groups.map((g) => `
        <section class="lang-group flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-900" data-lang="${esc(g.lang)}">
          <span class="shrink-0">${langOf(g.lang).flag}</span>
          <span class="min-w-0 flex-1 truncate text-sm">${esc(langOf(g.lang).label)}</span>
          ${g.hands ? `<span class="text-[11px] text-amber-400">✋ ${g.hands}</span>` : ''}
          <span class="text-[11px] text-zinc-600">${esc(statusLabel[g.status] || g.status)}</span>
          <span class="text-sm font-mono text-zinc-400">${g.size}</span>
        </section>`).join('')}
      <p class="text-[11px] text-zinc-700">
        A room this size is billed per language, not per person. These ${groups.length} groups cost
        ${groups.length} translations per sentence, however many people are listening.
      </p>
    </div>`;
  }

  function rosterHTML() {
    if (tierOf().rosterMode === 'aggregate' || S.rosterMode === 'aggregate') return aggregateRosterHTML();
    const people = Array.from(S.participants.values()).filter((p) => !p.left && !p.removed);
    const groups = new Map();
    for (const p of people) {
      if (!groups.has(p.hearsLang)) groups.set(p.hearsLang, []);
      groups.get(p.hearsLang).push(p);
    }
    if (!groups.size) {
      return `<div id="roster" class="space-y-2"><p class="text-sm text-zinc-600">Nobody in the room yet.</p></div>`;
    }
    const isHost = S.room && S.me && S.room.hostUserId === S.me.userId;
    return `<div id="roster" class="space-y-3">
      ${Array.from(groups.entries()).map(([lang, list]) => `
        <section class="lang-group" data-lang="${esc(lang)}">
          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-1.5 flex items-center gap-2">
            <span>${langOf(lang).flag} Hearing ${esc(langOf(lang).label)}</span>
            <span class="text-zinc-700">${list.length}</span>
          </h3>
          <div class="grid gap-1">
            ${list.map((p) => `
              <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 text-sm">
                <span class="w-1.5 h-1.5 rounded-full ${p.online ? 'bg-emerald-500' : 'bg-zinc-700'}"></span>
                <span class="min-w-0 truncate ${p.role === 'audience' ? 'text-zinc-400' : 'text-zinc-100'}">${esc(p.username)}</span>
                ${p.role !== 'audience' ? `<span class="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">${esc(p.role)}</span>` : ''}
                ${p.handRaisedAt ? '<span title="Raised hand">✋</span>' : ''}
                ${p.mutedByHost ? '<span class="text-[11px] text-amber-500">muted</span>' : ''}
                ${p.micOn ? '<span class="text-[11px] text-emerald-500">mic</span>' : ''}
                <span class="flex-1"></span>
                ${isHost && S.me && p.userId !== S.me.userId
                  ? `<button data-moderate="${p.userId}" class="un-touch-target text-[11px] text-violet-400">manage</button>` : ''}
              </div>`).join('')}
          </div>
        </section>`).join('')}
    </div>`;
  }

  function composerHTML() {
    if (!S.isMember) {
      return `
        <div class="p-3 rounded-xl bg-zinc-900 space-y-2">
          <p class="text-sm font-medium">${esc(t('room.preview'))}</p>
          <p class="text-xs text-zinc-500">
            You are reading this call in ${esc(langOf(S.hearsLang).label)} without having joined it.
            Join to speak, to raise your hand, and to have your own words translated for everyone else.
          </p>
          <button id="join-room" class="un-pressable w-full py-2.5 rounded-lg bg-violet-600 text-white text-sm font-medium">
            Join this call
          </button>
        </div>`;
    }

    const room = S.room;
    const me = S.me;
    const listenOnly = room && !room.twoWay && me && me.role === 'audience';
    const muted = me && me.mutedByHost;

    if (muted) {
      return `<div class="p-3 rounded-xl bg-amber-500/10 ring-1 ring-amber-500/30">
        <p class="text-sm text-amber-300">The host muted you. You can still read the call.</p>
      </div>`;
    }

    if (listenOnly) {
      const raised = !!me.handRaisedAt;
      return `
        <div class="p-3 rounded-xl bg-zinc-900 space-y-2">
          <p class="text-sm text-zinc-400">This is a one-way call. The host and agents speak, you listen in ${esc(langOf(S.hearsLang).label)}.</p>
          ${raised && S.myQueuePosition ? `<p id="queue-status" class="text-xs text-amber-300">✋ Number ${S.myQueuePosition} in the queue.</p>` : ''}
          <button id="raise-hand" class="un-pressable w-full py-2.5 rounded-lg ${raised ? 'bg-amber-500/20 text-amber-300' : 'bg-zinc-800 text-zinc-200'} text-sm font-medium">
            ${raised ? '✋ Hand raised, waiting for the host' : '✋ Raise your hand'}
          </button>
        </div>`;
    }

    const tier = tierOf();

    if (!Speech.supported()) {
      // No SpeechRecognition here (Firefox, most in-app browsers). Say so up
      // front and hand over a typing box, rather than showing a mic button
      // that only explains itself after it has failed.
      const queueLineTyped = tier.handQueue && S.myQueuePosition
        ? `<p id="queue-status" class="text-xs text-amber-300 px-1">✋ ${esc(t('room.queuedShort', { n: S.myQueuePosition }))}</p>`
        : '';
      return `
        <div class="space-y-2">
          ${queueLineTyped}
          <div id="stt-unsupported" class="p-2.5 rounded-lg bg-zinc-900 text-xs text-zinc-400">${esc(t('room.noStt'))}</div>
          <p id="mic-error" class="hidden text-xs text-amber-400"></p>
          <form id="type-form" class="flex gap-2">
            <input id="type-input" maxlength="${(S.config && S.config.limits.MAX_UTTERANCE_CHARS) || 500}"
                   placeholder="${esc(t('room.typePlaceholder', { lang: langOf(S.prefs.speaksLang).label }))}"
                   class="flex-1 px-3 py-2.5 rounded-xl bg-zinc-900 text-sm placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500">
            <button class="un-pressable px-4 rounded-xl bg-violet-600 text-white text-sm font-medium">${esc(t('common.send'))}</button>
          </form>
          <button id="tts-quick" class="un-pressable w-full py-2 rounded-xl bg-zinc-800 text-sm">
            ${S.prefs.ttsEnabled ? `🔊 ${esc(t('room.ttsOn'))}` : `🔇 ${esc(t('room.ttsOff'))}`}
          </button>
        </div>`;
    }

    const listening = Speech.wantListening;
    // In a tier with a queue, a refused floor claim is not an error — it is a
    // position. The server puts your hand up for you when it refuses, so this
    // line is a database fact rather than a guess.
    const queueLine = tier.handQueue && S.myQueuePosition
      ? `<p id="queue-status" class="text-xs text-amber-300 px-1">✋ ${esc(t('room.queued', { n: S.myQueuePosition }))}</p>`
      : '';
    return `
      <div class="space-y-2">
        ${queueLine}
        <p id="mic-error" class="hidden text-xs text-amber-400"></p>
        <p id="interim" class="hidden text-sm text-zinc-500 italic px-1"></p>
        <div class="h-1 rounded-full bg-zinc-800 overflow-hidden">
          <div id="level" class="level-bar h-full bg-violet-500" style="transform: scaleX(0)"></div>
        </div>
        <div class="flex gap-2">
          <button id="mic-toggle" class="un-pressable flex-1 py-3 rounded-xl font-medium text-sm ${listening ? 'bg-red-600 text-white' : 'bg-violet-600 text-white'}">
            ${listening ? `■ ${esc(t('room.stopSpeaking'))}` : `🎙 ${esc(t('room.startSpeaking'))}`}
          </button>
          <button id="tts-quick" class="un-pressable px-4 rounded-xl bg-zinc-800 text-sm" title="${esc(t('room.ttsQuickTitle'))}">
            ${S.prefs.ttsEnabled ? '🔊' : '🔇'}
          </button>
        </div>
        <form id="type-form" class="flex gap-2">
          <input id="type-input" maxlength="${(S.config && S.config.limits.MAX_UTTERANCE_CHARS) || 500}"
                 placeholder="${esc(t('room.orTypePlaceholder', { lang: langOf(S.prefs.speaksLang).label }))}"
                 class="flex-1 px-3 py-2.5 rounded-xl bg-zinc-900 text-sm placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500">
          <button class="un-pressable px-4 rounded-xl bg-zinc-800 text-sm">${esc(t('common.send'))}</button>
        </form>
      </div>`;
  }

  // One line, host only. The full breakdown lives on the metrics screen; what
  // a host needs mid-call is whether captions are landing late right now.
  function hostLatencyHTML() {
    const recent = S.latency.recent;
    if (!recent.length) return '';
    const sorted = recent.map((r) => r.deliverMs).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    return `<p id="host-latency" class="text-[11px] text-zinc-700 px-1">${
      esc(t('room.hostLatency', { med, worst, n: sorted.length }))
    }</p>`;
  }

  // Naming the number is the whole point. "Reconnecting" alone leaves you
  // wondering whether the three sentences you just said are gone.
  function reconnectCopy() {
    const queued = S.route && S.route.code
      ? outbox.read().filter((i) => i.code === S.route.code).length
      : 0;
    if (!queued) return t('room.disconnected');
    return t('room.disconnectedQueued', { n: queued });
  }

  // Shown to the host only, and as a rung plus a percentage — never a dollar
  // figure. The meter belongs to the speaker's own platform AI budget; this
  // app reads it off the proxy's response headers and never prices a token.
  function budgetNoticeHTML() {
    const b = S.budget;
    if (!b || !b.level || b.level === 'normal') return '';
    const copy = {
      shed_small: 'Nearing the daily AI budget. Only the largest language group is being translated for now.',
      floor_only: 'Close to the daily AI budget. Only what the floor-holders say is being translated.',
      transcript_only: 'The daily AI budget is spent. The call is running transcript-only until it resets.',
    };
    return `<div id="budget-notice" data-level="${esc(b.level)}" class="p-2.5 rounded-lg bg-amber-500/10 text-amber-300 text-xs">
      ${esc(copy[b.level] || 'Translation is degraded to stay inside the daily AI budget.')}
      ${b.spentPct != null ? `<span class="text-amber-400/60">(${b.spentPct}% of cap)</span>` : ''}
    </div>`;
  }

  function renderRoom() {
    const room = S.room;
    if (!room) return;
    const utterances = Array.from(S.utterances.values()).sort((a, b) => a.id - b.id);
    const purposeDef = ((S.config && S.config.purposes) || []).find((p) => p.key === room.purpose);
    const isHost = S.me && room.hostUserId === S.me.userId;

    const feedEl = document.getElementById('feed');
    const atBottom = feedEl
      ? feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80
      : true;

    appEl().innerHTML = `
      ${header(room.title, {
        back: '/',
        subtitle: `${purposeDef ? `${purposeDef.icon} ${purposeDef.label} · ` : ''}${room.code} · ${tierOf().label}`,
        right: `<button id="open-langs" class="un-touch-target text-xs px-2 py-1 rounded-full bg-zinc-800">${langOf(S.prefs.speaksLang).flag}→${langOf(S.hearsLang).flag}</button>`,
      })}
      <main class="max-w-2xl mx-auto px-4 py-4 space-y-4"
            style="padding-bottom: calc(2rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">

        ${!S.connected ? `<div id="reconnect-notice" class="p-2.5 rounded-lg bg-amber-500/10 text-amber-300 text-xs">${reconnectCopy()}</div>` : ''}
        ${room.endedAt ? `<div class="p-2.5 rounded-lg bg-zinc-800 text-zinc-400 text-xs">This call has ended.</div>` : ''}
        ${room.mode === 'transcript_only' ? `<div class="p-2.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs">Transcript-only mode: everything is captured in the original language, nothing is translated.</div>` : ''}
        ${S.config && !S.config.llmEnabled ? `<div class="p-2.5 rounded-lg bg-zinc-800 text-zinc-400 text-xs">Live translation is unavailable in this environment. Captions show the original language.</div>` : ''}
        ${budgetNoticeHTML()}

        ${floorHTML()}

        ${audioModeHTML('audio-mode')}

        ${audioDemoHTML()}

        <div id="feed" class="space-y-2 max-h-[52vh] overflow-y-auto pr-1">
          ${utterances.length
            ? utterances.map(utteranceHTML).join('')
            : `<p class="text-sm text-zinc-600 py-8 text-center">Nothing said yet. When someone speaks, their words appear here in ${esc(langOf(S.hearsLang).label)}.</p>`}
        </div>

        ${composerHTML()}

        ${isHost ? hostLatencyHTML() : ''}

        ${!S.isMember ? '' : isHost ? `
          <div class="flex gap-2">
            <button id="toggle-mode" class="un-pressable flex-1 py-2 rounded-lg bg-zinc-900 text-xs text-zinc-300">
              ${room.mode === 'transcript_only' ? 'Turn translation back on' : 'Switch to transcript-only'}
            </button>
            <button id="end-call" class="un-pressable flex-1 py-2 rounded-lg bg-red-600/20 text-red-300 text-xs">End the call</button>
          </div>` : `
          <button id="leave-call" class="un-pressable w-full py-2 rounded-lg bg-zinc-900 text-xs text-zinc-400">Leave the call</button>`}

        ${rosterHTML()}

        ${dialInHTML()}

        <div class="pt-2 text-center">
          <p class="text-[11px] text-zinc-700">Share this call: code <span class="font-mono text-zinc-500">${esc(room.code)}</span></p>
          <p class="text-[11px] text-zinc-700">
            <a href="/feedback?room=${esc(room.code)}&purpose=${esc(room.purpose || '')}"
               data-nav="/feedback?room=${esc(room.code)}&purpose=${esc(room.purpose || '')}"
               class="underline decoration-zinc-800">${esc(t('feedback.title'))}</a>
          </p>
        </div>
      </main>`;

    bindNav(appEl());
    bindRoomEvents();
    const feed = document.getElementById('feed');
    if (feed && atBottom) feed.scrollTop = feed.scrollHeight;
  }

  function bindRoomEvents() {
    const code = S.route.code;
    const el = (id) => document.getElementById(id);

    if (el('open-langs')) el('open-langs').addEventListener('click', openLanguageSheet);

    if (el('dial-in-why')) {
      el('dial-in-why').addEventListener('click', async () => {
        const d = S.dialIn || (S.config && S.config.dialIn) || {};
        // Hit the real endpoint rather than describing it: the 501 and its
        // reason are the product surface, and they answer identically in
        // staging and production.
        let reason = d.reason || 'Not available yet.';
        try {
          await api(`/api/rooms/${code}/dial-in`, { method: 'POST', body: {} });
        } catch (err) {
          reason = (err.data && err.data.reason) || err.message || reason;
        }
        notify(reason);
      });
    }

    if (el('join-room')) {
      el('join-room').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await api(`/api/rooms/${code}/join`, {
            method: 'POST',
            body: { speaksLang: S.prefs.speaksLang, hearsLang: S.prefs.hearsLang },
          });
          S.cursor = 0;
          await poll();
        } catch (err) {
          e.target.disabled = false;
          notify(err.message);
        }
      });
    }

    if (el('raise-hand')) {
      el('raise-hand').addEventListener('click', async () => {
        try {
          await api(`/api/rooms/${code}/me`, {
            method: 'PATCH',
            body: { handRaised: !(S.me && S.me.handRaisedAt) },
          });
          await poll();
        } catch (err) { notify(err.message); }
      });
    }

    if (el('mic-toggle')) {
      el('mic-toggle').addEventListener('click', async () => {
        if (Speech.wantListening) {
          Speech.stop();
          await releaseFloor();
          try { await api(`/api/rooms/${code}/me`, { method: 'PATCH', body: { micOn: false } }); } catch { /* best effort */ }
          renderRoom();
          return;
        }
        try {
          await Speech.start(S.prefs.speaksLang, onFinalTranscript);
          await api(`/api/rooms/${code}/me`, { method: 'PATCH', body: { micOn: true } });
        } catch (err) {
          setMicError(err.message);
        }
        renderRoom();
      });
    }

    appEl().querySelectorAll('#audio-mode [data-audio-mode]').forEach((b) => {
      b.addEventListener('click', async () => {
        await setAudioMode(b.dataset.audioMode);
        renderRoom();
      });
    });

    if (el('audio-demo-say')) {
      el('audio-demo-say').addEventListener('click', () => {
        const bus = ensureAudio();
        if (!bus) return;
        // Offered through the bus rather than spoken directly, so the panel
        // exercises the real path: sealed clauses, queue caps and ducking.
        // The sample text only exists in the languages we ship a table for.
        const demoLang = resolveUiLang(S.hearsLang) || 'en';
        bus.offer({
          utteranceId: -1,
          targetLang: S.hearsLang,
          ttsTag: demoLang === S.hearsLang ? langOf(S.hearsLang).tts : 'en-US',
          // Spoken, not read: resolved against the LISTENING language so the
          // words match the voice tag on the line above. A hears language with
          // no string table of its own falls back to English text, which is
          // why the tag falls back with it.
          segments: [tFor(demoLang, 'audio.sample1'), tFor(demoLang, 'audio.sample2')],
          sealedIdx: 2,
          final: true,
          ageMs: 0,
        });
        refreshAudioPanel();
      });
    }
    if (el('audio-demo-stop')) {
      el('audio-demo-stop').addEventListener('click', () => {
        if (Audio) Audio.reset();
        Voice.clear();
        refreshAudioPanel();
      });
    }

    if (el('tts-quick')) {
      el('tts-quick').addEventListener('click', async () => {
        const next = audioMode() === 'original'
          ? (S.lastHeardMode || audioCfg().DEFAULT_MODE || 'both')
          : 'original';
        if (next === 'original') S.lastHeardMode = audioMode();
        if (Audio) Audio.clear();
        Voice.clear();
        await setAudioMode(next);
        renderRoom();
      });
    }

    if (el('type-form')) {
      el('type-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = el('type-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        await sendUtterance(text, 'typed');
      });
    }

    if (el('end-call')) {
      el('end-call').addEventListener('click', async () => {
        Speech.stop(); Voice.clear();
        try { await api(`/api/rooms/${code}/leave`, { method: 'POST', body: { endRoom: true } }); } catch { /* ignore */ }
        navigate(`/room/${code}/ended`, { transition: 'pop' });
      });
    }
    if (el('leave-call')) {
      el('leave-call').addEventListener('click', async () => {
        Speech.stop(); Voice.clear();
        try { await api(`/api/rooms/${code}/leave`, { method: 'POST' }); } catch { /* ignore */ }
        navigate('/', { transition: 'pop' });
      });
    }
    if (el('toggle-mode')) {
      el('toggle-mode').addEventListener('click', async () => {
        notify(S.room.mode === 'transcript_only' ? 'Translation back on' : 'Transcript-only mode');
        try {
          await api(`/api/rooms/${code}/mode`, {
            method: 'POST',
            body: { mode: S.room.mode === 'transcript_only' ? 'full' : 'transcript_only' },
          });
          await poll();
        } catch (err) { notify(err.message); }
      });
    }

    $$('[data-retract]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/rooms/${code}/utterances/${b.dataset.retract}/retract`, { method: 'POST' });
        await poll();
      } catch (err) { notify(err.message); }
    }));

    $$('[data-report]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/rooms/${code}/utterances/${b.dataset.report}/report`, {
          method: 'POST', body: { reason: 'reported from the call' },
        });
        notify('Reported to the host.');
      } catch (err) { notify(err.message); }
    }));

    $$('[data-moderate]').forEach((b) => b.addEventListener('click', async () => {
      const userId = parseInt(b.dataset.moderate, 10);
      const p = S.participants.get(userId);
      if (!p) return;
      const items = [
        { label: p.role === 'audience' ? 'Give them the floor' : 'Return them to the audience',
          value: { role: p.role === 'audience' ? 'agent' : 'audience' } },
        { label: p.mutedByHost ? 'Un-mute' : 'Mute', value: { mutedByHost: !p.mutedByHost } },
        { label: 'Remove from the call', destructive: true, value: { removed: true } },
      ];
      let chosen = null;
      if (window.unNative && typeof window.unNative.menu === 'function') {
        try {
          chosen = await window.unNative.menu({ anchorEl: b, title: p.username, items });
        } catch { chosen = null; }
      }
      if (!chosen) {
        const answer = window.prompt(
          `${p.username}\n1 = ${items[0].label}\n2 = ${items[1].label}\n3 = ${items[2].label}`, ''
        );
        const i = parseInt(answer, 10) - 1;
        chosen = items[i] || null;
      }
      if (!chosen) return;
      try {
        await api(`/api/rooms/${code}/participants/${userId}`, { method: 'PATCH', body: chosen.value });
        await poll();
      } catch (err) { notify(err.message); }
    }));
  }

  // --- speaking ------------------------------------------------------------
  async function claimFloor() {
    if (Date.now() < S.floorHeldUntil - 3000) return true;
    try {
      await api(`/api/rooms/${S.route.code}/floor`, { method: 'POST', body: {} });
      S.floorHeldUntil = Date.now() + ((S.config && S.config.limits.FLOOR_LEASE_MS) || 12000);
      return true;
    } catch (err) {
      if (err.code === 'floor_taken') {
        const d = err.data || {};
        // The server raised our hand when it refused, so we have a position,
        // not just a rejection. Reflect it immediately rather than waiting a
        // poll for the composer to catch up.
        if (d.position) S.myQueuePosition = d.position;
        const names = (d.holders || [])
          .map((h) => h.username)
          .filter(Boolean);
        const holder = S.participants.get(d.holder);
        const who = names.length
          ? names.join(' and ')
          : (holder ? holder.username : 'Someone else');
        setMicError(
          d.position
            ? `${who} ${names.length > 1 ? 'have' : 'has'} the floor. Your hand is up, you are number ${d.position}.`
            : `${who} ${names.length > 1 ? 'have' : 'has'} the floor right now.`
        );
        if (S.room) renderRoom();
        return false;
      }
      // A lease we could not renew is not a reason to drop what was said.
      return true;
    }
  }

  async function releaseFloor() {
    S.floorHeldUntil = 0;
    try { await api(`/api/rooms/${S.route.code}/floor`, { method: 'POST', body: { release: true } }); }
    catch { /* the lease expires on its own */ }
  }

  async function onFinalTranscript(text, captureMs) {
    if (!await claimFloor()) return;
    setMicError('');
    await sendUtterance(text, 'voice', captureMs);
  }

  // One id per sentence, minted where the sentence starts. It travels with
  // the utterance through the fan-out, the translation write and the latency
  // sample, so a slow caption can be followed across the three legs in the
  // logs instead of being guessed at from timestamps.
  function newTraceId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      }
    } catch { /* fall through */ }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 16);
  }

  async function sendUtterance(text, via, captureMs) {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id: localId, code: S.route.code, text, via, sourceLang: S.prefs.speaksLang,
      traceId: newTraceId(),
      // Queued in the outbox with the sentence, so a phrase that waited out a
      // dropped connection still reports the capture time it actually had
      // rather than the time it spent offline.
      captureMs: typeof captureMs === 'number' ? Math.round(captureMs) : null,
    };
    outbox.add(item);
    await flushOutbox();
  }

  async function flushOutbox() {
    const pending = outbox.read().filter((i) => i.code === (S.route && S.route.code));
    for (const item of pending) {
      try {
        await api(`/api/rooms/${item.code}/utterances`, {
          method: 'POST',
          body: {
            text: item.text, via: item.via, sourceLang: item.sourceLang,
            captureMs: item.captureMs, traceId: item.traceId,
          },
        });
        outbox.remove(item.id);
        S.connected = true;
      } catch (err) {
        if (err.status && err.status >= 400 && err.status < 500) {
          // A rejection is final — drop it rather than retrying forever.
          outbox.remove(item.id);
          notify(err.message);
        } else {
          report('outbox', err);
          S.connected = false;
          return;
        }
      }
    }
    // Answer now, not in eight seconds: everything after this in render() is
    // waiting on it, so this one catch-up poll never holds.
    await poll({ hold: false });
  }

  // --- the poll loop -------------------------------------------------------
  async function poll(opts) {
    if (!S.route || S.route.name !== 'room') return;
    try {
      // Long poll where the tier allows it: the server holds the request and
      // answers the instant a caption lands, so the idle tick stops being
      // part of what a listener waits through. Never on a cold cursor (there
      // is already something to send) and never while hidden.
      // A hold that expired with nothing to send earns one plain tick before
      // the next one. It costs a silent room about a second of the long-poll
      // win, and it means a listener's tab is never holding a socket open
      // without pause, which is what a quiet room would otherwise do forever.
      const mayHold = !(opts && opts.hold === false);
      const wait = mayHold && !!(S.tier && S.tier.longPoll) && S.cursor > 0 && !document.hidden && !S.restTick;
      const requestedAt = Date.now();
      const data = await api(
        `/api/rooms/${S.route.code}/stream?since=${S.cursor}${wait ? '&wait=1' : ''}`
      );
      const receivedAt = Date.now();
      if (data.notFound) {
        S.error = 'not_found';
        stopPolling();
        renderRoomNotFound();
        return;
      }
      const before = S.cursor;
      S.room = data.room;
      S.me = data.me;
      S.isMember = data.isMember;
      S.hearsLang = data.hearsLang || S.prefs.hearsLang;
      S.tier = data.tier || S.tier;
      S.rosterMode = data.rosterMode || 'full';
      S.participantCount = data.participantCount || 0;
      S.langGroups = data.langGroups || [];
      S.activeSpeakers = data.activeSpeakers || [];
      S.queue = data.queue || [];
      S.myQueuePosition = data.myQueuePosition || null;
      S.budget = data.budget || null;
      S.dialIn = data.dialIn || S.dialIn;
      if (!S.connected) {
        // Say it landed. A banner that only ever appears when things are
        // broken leaves you guessing about the moment they stop being broken.
        const queued = outbox.read().filter((i) => i.code === S.route.code).length;
        notify(queued
          ? t('room.reconnectedSent', { n: queued })
          : t('room.reconnected'));
      }
      S.connected = true;
      S.held = !!data.held;
      S.restTick = !!data.held;
      // What the hold actually cost, measured on one clock. /admin/compat
      // reads it: a browser or proxy that quietly caps request duration shows
      // up here as a hold far shorter than the server asked for.
      if (wait) S.lastHoldMs = Math.max(0, receivedAt - requestedAt);
      S.error = null;

      if (data.me) {
        // The room row is the truth while you are in a room; keep the local
        // preference in step so the composer labels do not lie.
        S.prefs.speaksLang = data.me.speaksLang;
        S.prefs.hearsLang = data.me.hearsLang;
      }

      for (const p of data.participants) S.participants.set(p.userId, p);

      const fresh = [];
      for (const u of data.utterances) {
        const prev = S.utterances.get(u.id);
        S.utterances.set(u.id, u);
        const tr = (u.translations || []).find((t) => t.targetLang === S.hearsLang);
        const wasReady = prev && (prev.translations || []).some(
          (t) => t.targetLang === S.hearsLang && t.status === 'ok'
        );
        if (tr && tr.status === 'ok' && !wasReady) fresh.push(u);
      }
      // Cap the feed so a long call does not grow the DOM without bound.
      if (S.utterances.size > 120) {
        const ids = Array.from(S.utterances.keys()).sort((a, b) => a - b);
        for (const id of ids.slice(0, S.utterances.size - 120)) S.utterances.delete(id);
      }
      S.cursor = data.seq;
      if (data.seq !== before) S.lastChangeAt = Date.now();

      noteTranslateLatency(data.events);
      noteDelivery(data.events, requestedAt, receivedAt);
      // Sealed clauses of captions still being written. This is the whole
      // latency win: clause 1 is spoken while clause 2 is still arriving.
      if (S.room && !S.room.endedAt) noteSegments(data.events);

      // Play new captions out loud. Stage 3 (one-way rooms) restricts this to
      // the people who actually hold the floor; Stage 4 (two-way) plays
      // everyone. Never play our own words back at ourselves.
      if (S.room && !S.room.endedAt) {
        for (const u of fresh) {
          if (S.spokenIds.has(u.id)) continue;
          // Marked spoken even when we stay silent, so a caption that was
          // already on screen while the tab was hidden is never read out
          // minutes late when the tab comes back.
          S.spokenIds.add(u.id);
          if (S.suppressTts) continue;
          const tr = (u.translations || []).find((t) => t.targetLang === S.hearsLang);
          // Only SEALED text is spoken. A sealed clause is immutable, which is
          // what lets the voice start before the sentence is finished; an
          // unsealed tail is provisional and is never offered. The bus applies
          // the listening mode, dedupes clauses it already spoke while the
          // caption was streaming, and drops the rest of the guards.
          if (tr && tr.status === 'ok') offerAudio(u, tr, true);
        }
      }
      S.suppressTts = false;
      // An utterance that was offered but never got a voice degrades to text
      // here rather than sitting silent forever.
      if (Audio) Audio.sweep();

      if (S.room.endedAt && S.route.name === 'room') {
        Speech.stop(); Voice.clear();
        if (Audio) Audio.reset();
        navigate(`/room/${S.route.code}/ended`, { transition: 'pop' });
        return;
      }
      renderRoom();
    } catch (err) {
      if (err.status === 404) {
        S.error = 'not_found';
        renderRoomNotFound();
        stopPolling();
        return;
      }
      // A 404 is the room, not the app. Anything else is worth knowing
      // about centrally, once per cause per session.
      report('poll', err);
      S.connected = false;
      S.held = false;
      S.restTick = false;
      if (S.room) renderRoom();
    }
  }

  // The audio bus starts a sentence once it holds `lead` sealed clauses, and
  // how big that cushion should be depends on how fast this room's captions
  // actually come back. Rooms differ (a townhall fanning out to four
  // languages is not a two-person call), so the number is observed here
  // rather than fixed in config.
  function noteTranslateLatency(events) {
    if (!Array.isArray(events) || !events.length || !Audio) return;
    let saw = false;
    for (const ev of events) {
      if (!ev || ev.type !== 'translation.final') continue;
      if (typeof ev.latencyMs !== 'number' || ev.latencyMs <= 0) continue;
      S.translateSamples.push(ev.latencyMs);
      if (S.translateSamples.length > 20) S.translateSamples.shift();
      saw = true;
    }
    if (!saw || S.translateSamples.length < 3) return;
    const sorted = S.translateSamples.slice().sort((a, b) => a - b);
    Audio.setLeadFromP50(sorted[Math.floor(sorted.length / 2)]);
  }

  // --- delivery latency ----------------------------------------------------
  // The third leg. The server tells us how old a caption was when it wrote the
  // response (ageMs, measured entirely on its own clock); we add only the time
  // the response spent in flight and on our own render path. Nothing here is a
  // timestamp, so the two clocks never have to agree.
  function noteDelivery(events, requestedAt, receivedAt) {
    if (!Array.isArray(events) || !events.length) return;
    const renderedAt = Date.now();
    for (const ev of events) {
      if (!ev || ev.type !== 'translation.final') continue;
      if (ev.targetLang !== S.hearsLang) continue;
      if (typeof ev.ageMs !== 'number') continue;
      const key = `${ev.utteranceId}:${ev.targetLang}`;
      if (S.latency.sampled.has(key)) continue;
      S.latency.sampled.add(key);
      const deliverMs = Math.max(0, Math.round(ev.ageMs + (renderedAt - receivedAt)));
      const sample = { utteranceId: ev.utteranceId, targetLang: ev.targetLang, deliverMs };
      S.latency.pending.push(sample);
      // The audio leg lands later (the synthesiser has to actually start), so
      // the sample stays reachable by key until the batch is sent.
      S.latency.byKey.set(key, sample);
      S.latency.recent.push({ deliverMs, at: renderedAt });
      if (S.latency.recent.length > 20) S.latency.recent.shift();
    }
    // A held request that waited eight seconds for nothing is not a slow
    // caption; requestedAt is kept so that stays visible while debugging.
    void requestedAt;
    flushLatency();
  }

  async function flushLatency() {
    const cfg = (S.config && S.config.latency) || {};
    const every = cfg.DELIVER_BATCH_MS || 10000;
    if (!S.latency.pending.length) return;
    if (Date.now() - S.latency.lastSentAt < every) return;
    const samples = S.latency.pending.splice(0, cfg.MAX_SAMPLES_PER_BATCH || 20);
    for (const smp of samples) S.latency.byKey.delete(`${smp.utteranceId}:${smp.targetLang}`);
    S.latency.lastSentAt = Date.now();
    try {
      await api(`/api/rooms/${S.route.code}/latency`, { method: 'POST', body: { samples } });
    } catch {
      // Telemetry. Dropping a batch is the correct failure, not a retry loop.
    }
  }

  function pollDelay() {
    const limits = (S.config && S.config.limits) || {};
    // The previous request was held open, so the server is already doing the
    // waiting. Come straight back rather than sleeping a second time.
    if (S.held) return 150;
    const idleAfter = limits.POLL_IDLE_AFTER_MS || 45000;
    if (Date.now() - S.lastChangeAt > idleAfter) return limits.POLL_IDLE_MS || 2500;
    // A large room polls slower on purpose: two hundred tabs at 900ms is a
    // load the room's own shape does not need, because a townhall audience is
    // reading rather than interrupting.
    return tierOf().pollActiveMs || limits.POLL_ACTIVE_MS || 900;
  }

  function startPolling() {
    stopPolling();
    const loop = async () => {
      if (!document.hidden) await poll();
      S.pollTimer = setTimeout(loop, document.hidden ? 4000 : pollDelay());
    };
    loop();
  }
  function stopPolling() {
    if (S.pollTimer) clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.route && S.route.name === 'room') {
      // Whatever arrived while we were away is history now — show it, do not
      // perform it. Anything that lands after this poll is spoken normally.
      S.suppressTts = true;
      Voice.clear();
      poll();
    }
  });

  function renderRoomNotFound() {
    appEl().innerHTML = `
      ${header('LIVE TRANSLATION', { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-16 text-center space-y-3">
        <p class="text-4xl">🔍</p>
        <h2 class="text-lg font-semibold">${esc(t('room.notFound'))}</h2>
        <p class="text-sm text-zinc-500">
          <span class="font-mono text-zinc-400">${esc(S.route.code)}</span><br>
          ${esc(t('room.notFoundBlurb'))}
        </p>
        <button data-nav="/" class="un-pressable mt-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-medium">${esc(t('common.back'))}</button>
        <p class="pt-2">
          <a href="/demo" data-nav="/demo" class="text-sm text-violet-400 underline decoration-violet-900">${esc(t('lobby.demo'))}</a>
        </p>
      </main>`;
    bindNav(appEl());
  }

  // --- ended screen --------------------------------------------------------
  async function renderEnded() {
    appEl().innerHTML = `${header('Call ended', { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">Loading summary…</main>`;
    let data;
    try {
      data = await api(`/api/rooms/${S.route.code}/summary`);
    } catch (err) {
      if (err.status === 404) return renderRoomNotFound();
      appEl().innerHTML = `${header('Call ended', { back: '/' })}
        <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(err.message)}</main>`;
      bindNav(appEl());
      return;
    }
    if (data.notFound) return renderRoomNotFound();
    const s = data.summary;
    const mins = Math.max(1, Math.round((s.duration_s || 0) / 60));
    const stat = (label, value) => `
      <div class="p-3 rounded-xl bg-zinc-900">
        <p class="text-xl font-semibold">${esc(value)}</p>
        <p class="text-xs text-zinc-500 mt-0.5">${esc(label)}</p>
      </div>`;
    appEl().innerHTML = `
      ${header(data.room.title, { back: '/', subtitle: 'Call ended' })}
      <main class="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <p class="text-sm text-zinc-400">
          Everyone heard this call in their own language. Captions are kept for
          ${(S.config && S.config.limits.RETENTION_HOURS) || 72} hours, then deleted.
        </p>
        <div class="grid grid-cols-2 gap-2">
          ${stat('minutes', mins)}
          ${stat('people', s.people || 0)}
          ${stat('things said', s.utterances || 0)}
          ${stat('languages in the room', s.languages || 0)}
        </div>
        ${s.avg_latency_ms != null
          ? `<p class="text-xs text-zinc-600 text-center">Average caption latency ${s.avg_latency_ms} ms</p>` : ''}
        <button data-nav="/feedback?room=${esc(S.route.code)}&purpose=${esc(data.room.purpose || '')}"
                class="un-pressable w-full p-3 rounded-xl bg-zinc-900 text-left ring-1 ring-zinc-800">
          <span class="block text-sm font-medium">${esc(t('feedback.title'))}</span>
          <span class="block text-xs text-zinc-500 mt-0.5">${esc(t('feedback.blurb'))}</span>
        </button>
        <button data-nav="/" class="un-pressable w-full py-3 rounded-xl bg-violet-600 text-white font-medium">${esc(t('common.back'))}</button>
      </main>`;
    bindNav(appEl());
  }

  // --- metrics -------------------------------------------------------------
  // Verdict colours are shared by the readiness panel and the alert list, so
  // "warn" means the same shade of amber in both places.
  function verdictClass(v) {
    if (v === 'pass') return 'bg-emerald-500/15 text-emerald-300';
    if (v === 'warn') return 'bg-amber-500/15 text-amber-300';
    if (v === 'crit') return 'bg-red-500/15 text-red-300';
    return 'bg-zinc-800 text-zinc-400';
  }

  function fmtCheckValue(c) {
    if (c.value == null) return '—';
    if (c.unit === 'rate') return `${(Number(c.value) * 100).toFixed(1)}%`;
    return `${Math.round(Number(c.value))} ms`;
  }
  function fmtCheckTarget(c) {
    if (c.target == null) return '';
    return c.unit === 'rate'
      ? `${t('metrics.target')} ${(Number(c.target) * 100).toFixed(0)}%`
      : `${t('metrics.target')} ${c.target} ms`;
  }

  function alertBannerHTML(count) {
    if (!count) return '';
    return `<button data-nav="/admin/alerts"
      class="un-pressable w-full text-left p-3 rounded-xl bg-red-500/10 text-red-300 text-sm">
      ${esc(t('alerts.banner', { n: count }))}
    </button>`;
  }

  async function renderMetrics() {
    const range = new URLSearchParams(location.search).get('range');
    S.metricsRange = range === '1h' || range === '24h' ? range : '7d';
    appEl().innerHTML = `${header(t('metrics.title'), { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(t('common.loading'))}</main>`;
    let m;
    try {
      m = await api(`/api/metrics?range=${encodeURIComponent(S.metricsRange)}`);
    } catch (err) {
      report('metrics', err);
      appEl().innerHTML = `${header(t('metrics.title'), { back: '/' })}
        <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(err.message)}</main>`;
      bindNav(appEl());
      return;
    }
    const l = m.latency || {};
    const c = m.cost || {};
    const admin = m.cost != null;
    const tierLabel = (key) => {
      const tt = ((S.config && S.config.tiers) || []).find((x) => x.key === key);
      return tt ? tt.label : (key || 'unknown');
    };
    const row = (label, value, hint) => `
      <div class="flex items-baseline justify-between gap-3 px-3 py-2.5 rounded-lg bg-zinc-900">
        <span class="text-sm text-zinc-400">${esc(label)}</span>
        <span class="text-sm font-mono">${esc(value)}</span>
        ${hint ? `<span class="text-[11px] text-zinc-600">${esc(hint)}</span>` : ''}
      </div>`;
    // Admin-only numbers keep their LABEL in every case. A row that vanishes
    // for most viewers makes the dashboard look broken rather than gated, and
    // the label plus "visible to app admins" says exactly what is going on.
    const adminRow = (label, value, hint) => row(label, admin ? value : '—', admin ? hint : t('metrics.adminOnly'));
    const e2e = (m.endToEnd && m.endToEnd.overall) || {};
    const e2eTiers = (m.endToEnd && m.endToEnd.byTier) || [];
    const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);
    const maxU = Math.max(1, ...(m.daily || []).map((d) => d.utterances));
    const rangeLabel = { '1h': '1h', '24h': t('common.hours24'), '7d': t('common.days7') };
    const rangeBtn = (key) => `
      <button data-nav="/admin/metrics?range=${key}"
        class="un-pressable px-3 py-1.5 rounded-full text-xs ${S.metricsRange === key ? 'bg-violet-600 text-white' : 'bg-zinc-900 text-zinc-400'}">
        ${esc(rangeLabel[key])}
      </button>`;
    const checks = (m.slo && m.slo.checks) || [];
    const failures = (m.failures && m.failures.rows) || [];

    appEl().innerHTML = `
      ${header(t('metrics.title'), { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-5">
        ${alertBannerHTML(m.openAlerts || 0)}

        <div class="flex items-center gap-2">
          <span class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('metrics.range'))}</span>
          ${rangeBtn('1h')}${rangeBtn('24h')}${rangeBtn('7d')}
        </div>

        <section id="readiness" class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('metrics.readiness'))}</h2>
          <p class="text-[11px] text-zinc-600 px-1">${esc(t('metrics.readinessBlurb'))}</p>
          ${checks.map((ck) => `
            <div class="px-3 py-2.5 rounded-lg bg-zinc-900 space-y-1">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-sm text-zinc-300">${esc(ck.label)}</span>
                <span class="text-sm font-mono">${esc(fmtCheckValue(ck))}</span>
                <span class="px-2 py-0.5 rounded-full text-[11px] ${verdictClass(ck.verdict)}">${esc(t(`verdict.${ck.verdict}`))}</span>
              </div>
              <p class="text-[11px] text-zinc-600">${esc(fmtCheckTarget(ck))} · ${ck.n || 0} ${esc(t('metrics.samples'))}${ck.note ? ` · ${esc(ck.note)}` : ''}</p>
            </div>`).join('')}
        </section>

        <section id="failures" class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('metrics.failures'))}</h2>
          ${failures.length
            ? failures.map((f) => row(
              f.code || 'unknown',
              `${f.n}`,
              `${f.status} · ${Math.round((f.share || 0) * 1000) / 10}%`
            )).join('')
            : `<p class="text-sm text-zinc-600">${esc(t('metrics.noFailures'))}</p>`}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Caption latency</h2>
          ${row('p50 latency', l.p50 != null ? `${l.p50} ms` : '—')}
          ${row('p95 latency', l.p95 != null ? `${l.p95} ms` : '—')}
          ${row('p50 first word', l.ttft_p50 != null ? `${l.ttft_p50} ms` : '—', 'streamed')}
          ${row('p95 first word', l.ttft_p95 != null ? `${l.ttft_p95} ms` : '—', 'streamed')}
          ${row('captions produced', l.n || 0)}
          ${row('failed', l.errors || 0)}
          ${row('unavailable', l.unavailable || 0)}
        </section>

        <section id="end-to-end" class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('metrics.endToEnd'))}</h2>
          ${e2e.n
            ? `
              ${row(t('metrics.totalLeg'), `${ms(e2e.total_p50)} / ${ms(e2e.total_p95)}`, `${e2e.n} ${t('metrics.samples')}`)}
              ${row(t('metrics.captureLeg'), `${ms(e2e.capture_p50)} / ${ms(e2e.capture_p95)}`)}
              ${row(t('metrics.translateLeg'), `${ms(e2e.translate_p50)} / ${ms(e2e.translate_p95)}`)}
              ${row(t('metrics.deliverLeg'), `${ms(e2e.deliver_p50)} / ${ms(e2e.deliver_p95)}`, t('metrics.deliverNote'))}
              ${e2eTiers.map((tt) => row(
                tierLabel(tt.tier),
                `${ms(tt.total_p50)} / ${ms(tt.total_p95)}`,
                `${tt.n} ${t('metrics.samples')}`
              )).join('')}`
            : `<p class="text-sm text-zinc-600">${esc(t('metrics.noSamples'))}</p>`}
        </section>

        <section id="audio-leg" class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('metrics.audioLeg'))}</h2>
          ${e2e.audio_n
            ? `
              ${row(t('metrics.audioStart'), `${ms(e2e.audio_p50)} / ${ms(e2e.audio_p95)}`, `${e2e.audio_n} ${t('metrics.samples')}`)}
              ${row(t('metrics.heardLeg'), `${ms(e2e.heard_p50)} / ${ms(e2e.heard_p95)}`)}
              ${row(t('metrics.audioFallbacks'), e2e.audio_fallbacks || 0, t('metrics.audioFallbackNote'))}`
            : `<p class="text-sm text-zinc-600">${esc(t('metrics.noAudio'))}</p>`}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Latency by room size</h2>
          ${(m.byTier || []).length
            ? (m.byTier || []).map((tt) => row(
              tierLabel(tt.tier),
              `${tt.p50 != null ? `${tt.p50} ms` : '—'} / ${tt.p95 != null ? `${tt.p95} ms` : '—'}`,
              `${tt.n} captions`
            )).join('')
            : '<p class="text-sm text-zinc-600">No captions in this window.</p>'}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Cost</h2>
          ${adminRow('Cost per call', c.centsPerCall != null ? `${c.centsPerCall.toFixed(4)}¢` : '—', 'proxy meter')}
          ${adminRow('translation calls', c.calls || 0)}
          ${adminRow('sentences said', c.utterances || 0)}
          ${row('listeners per call', l.avg_group_size != null ? `${l.avg_group_size}×` : '—', 'grouping payoff')}
          ${adminRow('sittings recorded', c.sessions || 0)}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Budget degradation</h2>
          ${row('largest group only', (m.degraded && m.degraded.shed_small) || 0, '≥70% of cap')}
          ${row('floor-holders only', (m.degraded && m.degraded.floor_only) || 0, '≥90% of cap')}
          ${row('transcript only', (m.degraded && m.degraded.transcript_only) || 0, 'cap spent')}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Translation engines</h2>
          ${(m.engines || []).map((e) => row(
            e.label || e.id,
            e.active ? 'active' : (e.available ? 'available' : 'blocked'),
            e.blockedReason ? 'platform capability missing' : `queue ${e.queueDepth || 0}`
          )).join('')}
          ${row('dial-in', m.dialIn && m.dialIn.available ? 'available' : 'coming soon')}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Right now</h2>
          ${row('open calls', (m.live && m.live.open_rooms) || 0)}
          ${row('people in a call', (m.live && m.live.live_participants) || 0)}
          ${row('translation service', m.llmEnabled ? 'available' : 'unavailable here')}
          ${row('speaker sessions held', m.translationSessions || 0, 'per speaker, per pair')}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Translation grant acceptance (30 days)</h2>
          ${adminRow('asked', (m.grants && m.grants.asked) || 0)}
          ${adminRow('granted', (m.grants && m.grants.granted) || 0)}
          ${adminRow('acceptance rate', m.grants && m.grants.acceptanceRate != null ? `${m.grants.acceptanceRate}%` : '—')}
        </section>

        <section>
          <h2 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">Daily usage</h2>
          <div class="space-y-1">
            ${(m.daily || []).map((d) => `
              <div class="flex items-center gap-2">
                <span class="w-20 shrink-0 text-[11px] text-zinc-600 font-mono">${esc(String(d.day).slice(0, 10))}</span>
                <span class="flex-1 h-3 rounded bg-zinc-900 overflow-hidden">
                  <span class="block h-full bg-violet-600/70" style="width:${Math.round((d.utterances / maxU) * 100)}%"></span>
                </span>
                <span class="w-24 shrink-0 text-right text-[11px] text-zinc-500 font-mono">${d.utterances} said</span>
              </div>`).join('') || '<p class="text-sm text-zinc-600">No usage recorded yet.</p>'}
          </div>
        </section>

        <p class="text-center text-xs text-zinc-700 space-x-3">
          <a href="/admin/alerts" data-nav="/admin/alerts" class="underline decoration-zinc-800">${esc(t('alerts.title'))}</a>
          <a href="/admin/compat" data-nav="/admin/compat" class="underline decoration-zinc-800">${esc(t('compat.title'))}</a>
          <a href="/admin/errors" data-nav="/admin/errors" class="underline decoration-zinc-800">${esc(t('errors.title'))}</a>
          <a href="/admin/feedback" data-nav="/admin/feedback" class="underline decoration-zinc-800">${esc(t('feedback.listTitle'))}</a>
        </p>
      </main>`;
    bindNav(appEl());
  }

  // --- alerts --------------------------------------------------------------
  async function renderAlerts() {
    appEl().innerHTML = `${header(t('alerts.title'), { back: '/admin/metrics' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(t('common.loading'))}</main>`;
    let data;
    try {
      data = await api('/api/alerts?limit=40');
    } catch (err) {
      report('alerts', err);
      appEl().innerHTML = `${header(t('alerts.title'), { back: '/admin/metrics' })}
        <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(err.message)}</main>`;
      bindNav(appEl());
      return;
    }
    const list = data.alerts || [];
    const open = list.filter((a) => !a.resolved_at);
    const closed = list.filter((a) => a.resolved_at);
    const when = (iso) => {
      try { return new Date(iso).toLocaleString(); } catch { return String(iso || ''); }
    };
    const card = (a) => `
      <div class="p-3 rounded-xl bg-zinc-900 space-y-1">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-sm">${esc(t(`alerts.rule.${a.rule}`))}</span>
          <span class="px-2 py-0.5 rounded-full text-[11px] ${verdictClass(a.resolved_at ? 'pass' : (a.severity === 'crit' ? 'crit' : 'warn'))}">
            ${esc(a.resolved_at ? t('alerts.resolved') : t('alerts.open'))}
          </span>
        </div>
        <p class="text-xs text-zinc-500 font-mono">${esc(a.rule)}${a.room_code ? ` · ${esc(a.room_code)}` : ''}</p>
        ${a.detail ? `<p class="text-xs text-zinc-400">${esc(a.detail)}</p>` : ''}
        <p class="text-[11px] text-zinc-600">${esc(t('alerts.opened'))} ${esc(when(a.opened_at))}</p>
      </div>`;
    appEl().innerHTML = `
      ${header(t('alerts.title'), { back: '/admin/metrics' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-5">
        <p class="text-[11px] text-zinc-600">
          ${esc(t('metrics.readinessBlurb'))} ${Math.round((data.evalIntervalMs || 300000) / 60000)} min.
        </p>
        <section id="alert-list" class="space-y-2">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('alerts.open'))}</h2>
          ${open.length ? open.map(card).join('') : `<p class="text-sm text-zinc-600">${esc(t('alerts.noneOpen'))}</p>`}
          <h2 class="text-xs uppercase tracking-wide text-zinc-500 pt-3">${esc(t('alerts.resolved'))}</h2>
          ${closed.length ? closed.map(card).join('') : `<p class="text-sm text-zinc-600">${esc(t('alerts.none'))}</p>`}
        </section>
        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Rules</h2>
          ${(data.rules || []).map((r) => `
            <div class="flex items-baseline justify-between gap-3 px-3 py-2 rounded-lg bg-zinc-900">
              <span class="text-sm text-zinc-400">${esc(t(`alerts.rule.${r}`))}</span>
              <span class="text-[11px] font-mono text-zinc-600">${esc(r)}</span>
            </div>`).join('')}
        </section>
      </main>`;
    bindNav(appEl());
  }

  // --- device check --------------------------------------------------------
  // Every row here is something a real browser answers for itself, which is
  // why there is no automated cross-browser suite in this repo: the matrix in
  // docs/testing-checklist.md is filled in by opening this screen on each
  // device and writing down what it says.
  async function probeCompat() {
    const out = {};
    out.speech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    out.tts = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    out.audioContext = !!(window.AudioContext || window.webkitAudioContext);
    try {
      localStorage.setItem('lt.probe', '1');
      localStorage.removeItem('lt.probe');
      out.storage = true;
    } catch { out.storage = false; }

    // The microphone is the important one. The platform delegates only
    // geolocation, clipboard-write and pointer-lock to app frames, and an
    // undelegated capability rejects with the SAME PERMISSION_DENIED a person
    // tapping Block produces. So ask the frame's own policy first: "the page
    // that embeds us never handed this down" is a different answer from "you
    // said no", and telling someone to check a permission they were never
    // asked for is the failure this screen exists to prevent.
    let delegated = null;
    try {
      const policy = document.permissionsPolicy || document.featurePolicy;
      if (policy && typeof policy.allowsFeature === 'function') {
        delegated = policy.allowsFeature('microphone');
      }
    } catch { delegated = null; }
    let micState = null;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'microphone' });
        micState = st && st.state;
      }
    } catch { micState = null; }
    out.micPolicy = delegated === false ? 'blocked' : (delegated === true ? 'delegated' : 'unknown');
    out.mic = delegated === false ? false : (micState === 'granted' ? true : (micState === 'denied' ? false : null));

    // Voices are counted per launch language, because "speech synthesis
    // works" and "this device can say Bahasa Indonesia" are different facts.
    const voices = {};
    let voiceCount = 0;
    for (const lang of (S.config && S.config.languages) || []) {
      const name = Audio && typeof Audio.voiceFor === 'function' ? Audio.voiceFor(lang.tts) : null;
      voices[lang.code] = name;
      if (name) voiceCount += 1;
    }
    out.voices = voiceCount;

    let safeArea = 'unknown';
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--un-safe-inset-bottom').trim();
      safeArea = v ? v : 'unset';
    } catch { safeArea = 'unknown'; }
    out.safeArea = safeArea;
    out.longPoll = S.lastHoldMs > 0 ? Math.round(S.lastHoldMs) : 0;
    out.platform = (window.unNative && window.unNative.platform) || 'unknown';
    out.tier = (S.tier && S.tier.key) || 'none';
    return { flags: out, voices, delegated, micState };
  }

  async function renderCompat() {
    appEl().innerHTML = `${header(t('compat.title'), { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(t('common.loading'))}</main>`;
    const probe = await probeCompat();
    S.compat = probe.flags;
    const f = probe.flags;
    const badge = (state) => {
      const cls = state === 'yes' ? 'pass' : state === 'no' ? 'crit' : state === 'blocked' ? 'warn' : 'insufficient';
      const label = state === 'yes' ? t('compat.yes')
        : state === 'no' ? t('compat.no')
          : state === 'blocked' ? t('compat.micBlocked') : t('compat.unknown');
      return `<span class="px-2 py-0.5 rounded-full text-[11px] shrink-0 ${verdictClass(cls)}">${esc(label)}</span>`;
    };
    const rowFor = (label, state, note) => `
      <div class="px-3 py-2.5 rounded-lg bg-zinc-900 space-y-1">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-sm text-zinc-300">${esc(label)}</span>
          ${badge(state)}
        </div>
        ${note ? `<p class="text-[11px] text-zinc-600">${esc(note)}</p>` : ''}
      </div>`;
    const micState = f.micPolicy === 'blocked' ? 'blocked' : (f.mic === true ? 'yes' : (f.mic === false ? 'no' : 'unknown'));
    const missingVoices = Object.keys(probe.voices || {})
      .filter((k) => !probe.voices[k])
      .map((k) => langOf(k).label);
    const langCount = ((S.config && S.config.languages) || []).length;

    appEl().innerHTML = `
      ${header(t('compat.title'), { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-4">
        <p class="text-sm text-zinc-400">${esc(t('compat.blurb'))}</p>
        ${micState !== 'yes' ? `<p class="p-3 rounded-xl bg-amber-500/10 text-amber-300 text-xs">${esc(t('compat.typedFallback'))}</p>` : ''}
        <section id="compat-table" class="space-y-1.5">
          ${rowFor(t('compat.speech'), f.speech ? 'yes' : 'no',
            f.speech ? '' : 'This browser has no speech recognition. Type instead.')}
          ${rowFor(t('compat.mic'), micState, t('compat.micNote'))}
          ${rowFor(t('compat.tts'), f.tts ? 'yes' : 'no')}
          ${rowFor(t('compat.voices'), f.voices >= langCount ? 'yes' : (f.voices ? 'blocked' : 'no'),
            missingVoices.length ? `${t('common.none')}: ${missingVoices.join(', ')}` : '')}
          ${rowFor(t('compat.audioContext'), f.audioContext ? 'yes' : 'no')}
          ${rowFor(t('compat.storage'), f.storage ? 'yes' : 'no')}
          ${rowFor(t('compat.longPoll'), f.longPoll > 0 ? 'yes' : 'unknown',
            f.longPoll > 0 ? `${f.longPoll} ms held` : 'Open a call first, then come back.')}
          ${rowFor(t('compat.safeArea'), f.safeArea && f.safeArea !== 'unset' && f.safeArea !== 'unknown' ? 'yes' : 'unknown',
            String(f.safeArea))}
        </section>
        <p class="text-center text-xs text-zinc-700">
          <a href="/feedback" data-nav="/feedback" class="underline decoration-zinc-800">${esc(t('feedback.title'))}</a>
        </p>
      </main>`;
    bindNav(appEl());
  }

  // --- pilot feedback ------------------------------------------------------
  async function renderFeedback() {
    const q = new URLSearchParams(location.search);
    const roomCode = (q.get('room') || '').toUpperCase().slice(0, 12);
    const purposes = (S.config && S.config.purposes) || [];
    const wantPurpose = q.get('purpose');
    const purpose = purposes.some((p) => p.key === wantPurpose) ? wantPurpose : '';
    appEl().innerHTML = `
      ${header(t('feedback.title'), { back: roomCode ? `/room/${roomCode}/ended` : '/' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-5">
        <p class="text-sm text-zinc-400">${esc(t('feedback.blurb'))}</p>
        <form id="feedback-form" class="space-y-5">
          ${roomCode ? `<p class="text-xs text-zinc-600">${esc(t('feedback.fromRoom', { code: roomCode }))}</p>` : ''}
          <section class="space-y-2">
            <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('feedback.rating'))}</h2>
            <div class="flex gap-2" id="rating-row">
              ${[1, 2, 3, 4, 5].map((n) => `
                <button type="button" data-rating="${n}"
                  class="un-pressable flex-1 py-3 rounded-xl bg-zinc-900 ring-1 ring-transparent text-sm">${n}</button>`).join('')}
            </div>
          </section>
          <section class="space-y-2">
            <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('feedback.purpose'))}</h2>
            <select id="feedback-purpose" class="w-full px-3 py-3 rounded-xl bg-zinc-900 text-sm outline-none focus:ring-1 focus:ring-violet-500">
              <option value="">${esc(t('common.none'))}</option>
              ${purposes.map((p) => `<option value="${esc(p.key)}" ${p.key === purpose ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
            </select>
          </section>
          <section class="space-y-2">
            <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('feedback.comment'))}</h2>
            <textarea id="feedback-comment" rows="5" maxlength="1000"
              placeholder="${esc(t('feedback.commentPlaceholder'))}"
              class="w-full px-3 py-3 rounded-xl bg-zinc-900 text-sm placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500"></textarea>
          </section>
          <label class="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-zinc-900 text-sm">
            <input type="checkbox" id="feedback-contact" class="un-switch">
            <span>${esc(t('feedback.contactOk'))}</span>
          </label>
          <button type="submit" id="feedback-submit"
            class="un-pressable w-full py-3.5 rounded-xl bg-violet-600 text-white font-semibold">${esc(t('feedback.submit'))}</button>
        </form>
      </main>`;
    bindNav(appEl());

    let rating = 0;
    $$('[data-rating]').forEach((b) => b.addEventListener('click', () => {
      rating = Number(b.dataset.rating);
      $$('[data-rating]').forEach((x) => {
        x.classList.toggle('ring-violet-500', x === b);
        x.classList.toggle('ring-transparent', x !== b);
      });
    }));

    $('#feedback-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!rating) { notify(t('feedback.rating')); return; }
      const btn = $('#feedback-submit');
      btn.disabled = true;
      // The device report is capability flags and counters only. A pilot note
      // describes the browser it came from, never the conversation.
      let compat = S.compat;
      if (!compat) { try { compat = (await probeCompat()).flags; } catch { compat = null; } }
      try {
        await api('/api/feedback', {
          method: 'POST',
          body: {
            rating,
            purpose: $('#feedback-purpose').value || null,
            comment: $('#feedback-comment').value,
            contactOk: $('#feedback-contact').checked,
            roomCode: roomCode || null,
            compat,
          },
        });
        appEl().innerHTML = `
          ${header(t('feedback.title'), { back: '/' })}
          <main class="max-w-2xl mx-auto px-4 py-16 text-center space-y-3">
            <p class="text-4xl">✅</p>
            <p class="text-sm text-zinc-400">${esc(t('feedback.thanks'))}</p>
            <button data-nav="/" class="un-pressable mt-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-medium">${esc(t('common.back'))}</button>
          </main>`;
        bindNav(appEl());
      } catch (err) {
        btn.disabled = false;
        notify(err.code === 'rate_limited' ? t('feedback.tooMany') : err.message);
      }
    });
  }

  async function renderAdminFeedback() {
    appEl().innerHTML = `${header(t('feedback.listTitle'), { back: '/admin/metrics' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(t('common.loading'))}</main>`;
    let data;
    let gated = '';
    try {
      data = await api('/api/feedback');
      // The server withholds the rows with a 200 rather than a 403, so a
      // non-admin opening this screen does not make the browser log a failed
      // request on a page that is behaving correctly.
      if (data && data.adminOnly) gated = t('metrics.adminOnly');
    } catch (err) {
      // The list is admin-only on the server and stays that way. The SECTION
      // still renders, because a screen that vanishes into an error line looks
      // broken rather than gated, and the reader needs to know which it is.
      data = { items: [], byPurpose: [], overall: {} };
      gated = err.status === 403 ? t('metrics.adminOnly') : err.message;
    }
    const purposeLabel = (key) => {
      const p = ((S.config && S.config.purposes) || []).find((x) => x.key === key);
      return p ? p.label : (key || '—');
    };
    const overall = data.overall || {};
    const items = data.items || [];
    appEl().innerHTML = `
      ${header(t('feedback.listTitle'), { back: '/admin/metrics' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-5">
        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('feedback.average'))}</h2>
          <div class="flex items-baseline justify-between gap-3 px-3 py-2.5 rounded-lg bg-zinc-900">
            <span class="text-sm text-zinc-400">${esc(t('feedback.average'))}</span>
            <span class="text-sm font-mono">${overall.avg_rating != null ? esc(overall.avg_rating) : '—'} / 5</span>
            <span class="text-[11px] text-zinc-600">${overall.n || 0}</span>
          </div>
          <h2 class="text-xs uppercase tracking-wide text-zinc-500 pt-2">${esc(t('feedback.byPurpose'))}</h2>
          ${(data.byPurpose || []).map((p) => `
            <div class="flex items-baseline justify-between gap-3 px-3 py-2.5 rounded-lg bg-zinc-900">
              <span class="text-sm text-zinc-400">${esc(purposeLabel(p.purpose))}</span>
              <span class="text-sm font-mono">${p.avg_rating != null ? esc(p.avg_rating) : '—'} / 5</span>
              <span class="text-[11px] text-zinc-600">${p.n}</span>
            </div>`).join('')}
        </section>
        <section id="feedback-list" class="space-y-2">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('feedback.listTitle'))}</h2>
          ${gated ? `<p class="text-sm text-zinc-600">${esc(gated)}</p>` : ''}
          ${items.length ? items.map((it) => `
            <div class="p-3 rounded-xl bg-zinc-900 space-y-1">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-sm">${esc(it.username || 'anon')}</span>
                <span class="text-sm font-mono">${it.rating} / 5</span>
              </div>
              <p class="text-[11px] text-zinc-600">
                ${esc(purposeLabel(it.purpose))}${it.room_code ? ` · ${esc(it.room_code)}` : ''}${it.contact_ok ? ' · contact ok' : ''}
              </p>
              ${it.comment ? `<p class="text-sm text-zinc-300">${esc(it.comment)}</p>` : ''}
              ${it.compat ? `<p class="text-[11px] font-mono text-zinc-700 break-all">${esc(JSON.stringify(it.compat))}</p>` : ''}
            </div>`).join('') : `<p class="text-sm text-zinc-600">${esc(t('feedback.listEmpty'))}</p>`}
        </section>
      </main>`;
    bindNav(appEl());
  }

  // --- error console -------------------------------------------------------
  async function renderErrors() {
    appEl().innerHTML = `${header(t('errors.title'), { back: '/admin/metrics' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(t('common.loading'))}</main>`;
    let data;
    let gated = '';
    try {
      data = await api('/api/errors?range=7d');
      if (data && data.adminOnly) gated = t('metrics.adminOnly');
    } catch (err) {
      data = { grouped: [], recent: [] };
      gated = err.status === 403 ? t('metrics.adminOnly') : err.message;
    }
    const grouped = data.grouped || [];
    const recent = data.recent || [];
    const sourceLabel = (s) => (s === 'client' ? t('errors.client') : t('errors.server'));
    const when = (iso) => {
      try { return new Date(iso).toLocaleString(); } catch { return String(iso || ''); }
    };
    appEl().innerHTML = `
      ${header(t('errors.title'), { back: '/admin/metrics' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-5">
        <section id="error-list" class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('errors.title'))}</h2>
          ${gated ? `<p class="text-sm text-zinc-600">${esc(gated)}</p>` : ''}
          ${grouped.length ? grouped.map((g) => `
            <div class="flex items-baseline justify-between gap-3 px-3 py-2.5 rounded-lg bg-zinc-900">
              <span class="text-sm text-zinc-300 font-mono">${esc(g.code)}</span>
              <span class="text-[11px] text-zinc-600">${esc(sourceLabel(g.source))}</span>
              <span class="text-sm font-mono">${g.n}</span>
            </div>`).join('') : `<p class="text-sm text-zinc-600">${esc(t('errors.none'))}</p>`}
        </section>
        <section class="space-y-2">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">${esc(t('errors.recent'))}</h2>
          ${recent.map((e) => `
            <details class="p-3 rounded-xl bg-zinc-900">
              <summary class="text-sm cursor-pointer">
                <span class="font-mono">${esc(e.code)}</span>
                <span class="text-[11px] text-zinc-600"> · ${esc(sourceLabel(e.source))} · ${esc(when(e.created_at))}</span>
              </summary>
              <p class="text-xs text-zinc-400 mt-2">${esc(e.where_at || '')}</p>
              ${e.message ? `<p class="text-xs text-zinc-500 mt-1">${esc(e.message)}</p>` : ''}
              ${e.stack_head ? `<pre class="text-[11px] text-zinc-600 mt-1 whitespace-pre-wrap break-all">${esc(e.stack_head)}</pre>` : ''}
              <p class="text-[11px] text-zinc-700 mt-1 font-mono">
                ${esc(e.req_id || '')}${e.room_code ? ` · ${esc(e.room_code)}` : ''}
              </p>
              ${e.user_agent ? `<p class="text-[11px] text-zinc-700 break-all">${esc(e.user_agent)}</p>` : ''}
            </details>`).join('') || `<p class="text-sm text-zinc-600">${esc(t('errors.none'))}</p>`}
        </section>
      </main>`;
    bindNav(appEl());
  }

  // --- the scripted demo call ----------------------------------------------
  // Entirely client side: no API calls, no rows, no LLM spend. That is why it
  // is NOT gated on staging — it is not data, it is a rehearsal, and the
  // "before" screenshot of any later change to it is taken from production.
  function stopDemo() {
    for (const id of S.demo.timers) clearTimeout(id);
    S.demo.timers = [];
    S.demo.running = false;
  }
  function demoLater(fn, ms) {
    S.demo.timers.push(setTimeout(fn, ms));
  }

  // The same rule the server applies in lib/segment.js, in miniature: a clause
  // is only spoken once it can no longer be rewritten.
  function demoClauses(text) {
    const parts = String(text).split(/(?<=[,.;!?])\s+/).filter(Boolean);
    return parts.length ? parts : [String(text)];
  }

  function demoCardHTML(turn, idx, script) {
    const sp = script.speakers[turn.speaker] || { name: turn.speaker, flag: '🏳️' };
    return `
      <article class="utterance fade-in p-3 rounded-xl bg-zinc-900" data-utterance-id="demo-${idx}">
        <div class="flex items-center gap-2 text-xs text-zinc-500 mb-1">
          <span>${sp.flag}</span><span>${esc(sp.name)}</span>
          <span class="text-zinc-700">${esc(langOf(turn.lang).label)} → ${esc(langOf(turn.targetLang).label)}</span>
        </div>
        <p class="original text-sm text-zinc-400">${esc(turn.text)}</p>
        <p class="translation text-sm mt-1" data-demo-translation="${idx}"></p>
      </article>`;
  }

  function renderDemo() {
    stopDemo();
    const script = (S.config && S.config.demo) || null;
    if (!script || !Array.isArray(script.turns) || !script.turns.length) {
      appEl().innerHTML = `${header(t('lobby.demo'), { back: '/' })}
        <main class="max-w-2xl mx-auto px-4 py-16 text-center text-sm text-zinc-500">${esc(t('common.none'))}</main>`;
      bindNav(appEl());
      return;
    }
    const purposeDef = ((S.config && S.config.purposes) || []).find((p) => p.key === script.purpose);
    appEl().innerHTML = `
      ${header(t('lobby.demo'), {
        back: '/',
        subtitle: purposeDef ? `${purposeDef.icon} ${purposeDef.label}` : '',
        right: '<span class="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[11px]">Demo</span>',
      })}
      <main class="max-w-2xl mx-auto px-4 py-4 space-y-4"
            style="padding-bottom: calc(2rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">
        <p class="text-sm text-zinc-400">${esc(t('lobby.demoBlurb'))}</p>
        <div id="feed" class="space-y-2">
          ${demoCardHTML(script.turns[0], 0, script)}
        </div>
        <div class="flex gap-2">
          <button id="demo-restart" class="un-pressable flex-1 py-3 rounded-xl bg-zinc-900 text-sm">${esc(t('common.retry'))}</button>
          <button id="start-real-call" data-nav="/" class="un-pressable flex-1 py-3 rounded-xl bg-violet-600 text-white text-sm font-semibold">
            ${esc(t('lobby.start'))}
          </button>
        </div>
      </main>`;
    bindNav(appEl());
    const restart = document.getElementById('demo-restart');
    if (restart) restart.addEventListener('click', () => renderDemo());

    // The first turn is complete on first paint. Everything after it is
    // replayed clause by clause on the same code path a real caption takes.
    const first = script.turns[0];
    const firstClauses = demoClauses(first.translated);
    const firstEl = document.querySelector('[data-demo-translation="0"]');
    if (firstEl) firstEl.textContent = first.translated;
    demoOffer(0, first, firstClauses, firstClauses.length, true);

    S.demo.running = true;
    let at = 0;
    for (let i = 1; i < script.turns.length; i += 1) {
      const turn = script.turns[i];
      at += (turn.gapMs || 1200) + (turn.captureMs || 900);
      const startAt = at;
      demoLater(() => {
        const feed = document.getElementById('feed');
        if (!feed || !S.route || S.route.name !== 'demo') return;
        feed.insertAdjacentHTML('beforeend', demoCardHTML(turn, i, script));
      }, startAt);
      const clauses = demoClauses(turn.translated);
      const step = Math.max(220, Math.round((turn.translateMs || 600) / clauses.length));
      for (let cIdx = 0; cIdx < clauses.length; cIdx += 1) {
        const sealed = cIdx + 1;
        const final = sealed === clauses.length;
        at = startAt + (turn.translateMs || 600) + step * cIdx;
        demoLater(() => {
          if (!S.route || S.route.name !== 'demo') return;
          const el = document.querySelector(`[data-demo-translation="${i}"]`);
          if (!el) return;
          el.textContent = clauses.slice(0, sealed).join(' ');
          el.classList.toggle('partial', !final);
          demoOffer(i, turn, clauses, sealed, final);
        }, at);
      }
    }
  }

  // The demo speaks through the real bus, so a listener hears exactly what a
  // real call sounds like — including that only sealed clauses ever go out.
  function demoOffer(idx, turn, clauses, sealedIdx, final) {
    if (!Audio) return;
    try {
      Audio.offer({
        utteranceId: `demo-${idx}`,
        targetLang: turn.targetLang,
        ttsTag: langOf(turn.targetLang).tts,
        segments: clauses,
        sealedIdx,
        final: !!final,
        ageMs: 0,
      });
    } catch { /* a demo must never break on a device with no voice */ }
  }

  // --- render --------------------------------------------------------------
  async function render() {
    const route = parseRoute();
    // `?audio=demo` is an explicit opt-in that writes nothing, so it is
    // available in every environment rather than gated on staging.
    S.audioDemo = new URLSearchParams(location.search).get('audio') === 'demo';
    const changedRoom = !S.route || S.route.name !== route.name || S.route.code !== route.code;
    S.route = route;

    if (changedRoom) {
      stopPolling();
      Speech.stop();
      Voice.clear();
      if (Audio) Audio.reset();
      S.latency.byKey.clear();
      S.offeredSegments.clear();
      S.translateSamples = [];
      stopDemo();
      if (route.name !== 'room') {
        S.room = null; S.me = null; S.participants.clear(); S.utterances.clear();
        S.cursor = 0; S.spokenIds.clear();
      }
    }

    // The `?screen=languages` deep link is pure client state, so it opens
    // before the route does its own network work rather than behind it. A
    // /stream request held open for eight seconds must never be the thing a
    // deep-linked sheet is waiting on.
    const sheetOpen = new URLSearchParams(location.search).get('screen') === 'languages';
    if (sheetOpen) renderLanguageSheet();
    else document.getElementById('overlay').innerHTML = '';

    if (route.name === 'lobby') {
      await renderLobby();
      bindNav(appEl());
    } else if (route.name === 'room') {
      appEl().innerHTML = `${header('Joining…', { back: '/' })}
        <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">Opening the call…</main>`;
      bindNav(appEl());
      S.cursor = 0;
      await poll();
      if (S.error !== 'not_found') {
        await flushOutbox().catch(() => {});
        startPolling();
      }
    } else if (route.name === 'ended') {
      await renderEnded();
    } else if (route.name === 'metrics') {
      await renderMetrics();
    } else if (route.name === 'alerts') {
      await renderAlerts();
    } else if (route.name === 'compat') {
      await renderCompat();
    } else if (route.name === 'errors') {
      await renderErrors();
    } else if (route.name === 'adminFeedback') {
      await renderAdminFeedback();
    } else if (route.name === 'feedback') {
      await renderFeedback();
    } else if (route.name === 'demo') {
      renderDemo();
    }

    // Re-render it once the route has landed: poll() may have corrected the
    // language pair from the room row, and the sheet must not show a stale
    // pair. Deep linking works identically in production, which is where the
    // "before" screenshot of this sheet gets taken.
    if (sheetOpen && new URLSearchParams(location.search).get('screen') === 'languages') {
      renderLanguageSheet();
    }
  }

  // --- boot ----------------------------------------------------------------
  async function boot() {
    try {
      S.config = await api('/api/config');
    } catch {
      S.config = { languages: [], comingSoon: [], purposes: [], limits: {}, llmEnabled: false };
    }
    try {
      const r = await api('/api/me/prefs');
      S.prefs = r.prefs;
      S.hearsLang = r.prefs.hearsLang;
    } catch { /* the defaults above are fine */ }
    // The bus needs S.config.audio, so it is built after the config lands and
    // before anything can render a mode selector against it.
    ensureAudio();

    // The platform locale is asked for exactly once and cached. Two things
    // want it — which language the INTERFACE speaks, and which language a
    // first-time visitor is assumed to speak and hear — and asking twice made
    // one boot wait on two round trips for the same answer.
    if (window.usernode && typeof window.usernode.getUserLocale === 'function') {
      try {
        const { locale } = await window.usernode.getUserLocale();
        S.platformLocale = locale || null;
      } catch { /* standalone: stays null, and the device decides */ }
    }
    applyUiLang();

    // The speak / hear pair follows the platform locale only when this person
    // has made no choice inside the app. Their in-app choice always wins.
    if (S.prefs.isDefault && S.platformLocale) {
      const locale = S.platformLocale;
      const match = (S.config.languages || []).find(
        (l) => locale === l.code || locale.toLowerCase().startsWith(`${l.code}-`)
      );
      if (match) { S.prefs.speaksLang = match.code; S.prefs.hearsLang = match.code; S.hearsLang = match.code; }
    }

    // Consent for AI translation is platform-owned; an app cannot approve
    // itself. Ask once, record the outcome, and carry on either way —
    // subtitles in the original language still work without a grant.
    if (S.config.llmEnabled && window.usernode && typeof window.usernode.getLlmAccess === 'function') {
      try {
        const access = await window.usernode.getLlmAccess();
        if (!access.granted && !sessionStorage.getItem('lt.asked')) {
          sessionStorage.setItem('lt.asked', '1');
          const result = await window.usernode.requestLlmAccess();
          api('/api/llm-grant-outcome', {
            method: 'POST',
            body: { outcome: result.granted ? 'granted' : (result.declined ? 'declined' : 'dismissed') },
          }).catch(() => {});
        }
      } catch { /* standalone / no shell */ }
    }

    // Opt-in structural self-check: the room feed and the roster must agree
    // on which languages the call is carrying. A caption rendered for a
    // language nobody is listening in means the fan-out targeted the wrong
    // set, which a screenshot would never show.
    if (window.usernode && window.usernode.invariants) {
      window.usernode.invariants.register('feed-matches-roster-languages', function () {
        if (!S.room) return true;
        // A large room sends language GROUPS instead of rows, so read the
        // groups there — the cap is a property of the room, not of whichever
        // roster shape happens to be on screen.
        const aggregated = S.rosterMode === 'aggregate';
        if (!aggregated && !S.participants.size) return true;
        if (aggregated && !S.langGroups.length) return true;
        const listening = aggregated
          ? new Set(S.langGroups.map((g) => g.lang))
          : new Set(
            Array.from(S.participants.values()).filter((p) => !p.left && !p.removed).map((p) => p.hearsLang)
          );
        const tier = tierOf();
        // Join enforces exactly this ceiling on DISTINCT listening languages,
        // so a roster over it means the cap leaked, not that the room grew.
        const max = Math.min(
          tier.maxTargetLangs || 4,
          (S.config && S.config.limits.MAX_TARGET_LANGS) || 4
        );
        if (listening.size > max) {
          return `roster carries ${listening.size} listening languages, over the ${max} cap`;
        }
        return true;
      });

      // The floor is the app's spend valve as much as its turn-taking rule:
      // more people holding it than the tier allows means more concurrent
      // fan-outs than the room was sized for.
      window.usernode.invariants.register('speaker-slots-within-tier-cap', function () {
        if (!S.room || !S.activeSpeakers) return true;
        const slots = tierOf().speakerSlots || 1;
        if (S.activeSpeakers.length > slots) {
          return `${S.activeSpeakers.length} speakers hold the floor, tier allows ${slots}`;
        }
        return true;
      });

      // A provisional caption must never be one we already read aloud —
      // hearing half a sentence and then the whole sentence again is the
      // single worst failure mode streaming captions can have.
      window.usernode.invariants.register('no-tts-for-partial-captions', function () {
        const spoken = [];
        for (const el of document.querySelectorAll('.utterance')) {
          if (!el.querySelector('.translation.partial')) continue;
          const id = Number(el.getAttribute('data-utterance-id'));
          if (S.spokenIds.has(id)) spoken.push(id);
        }
        if (spoken.length) {
          return `${spoken.length} caption(s) went back to provisional after being spoken`;
        }
        return true;
      });

      // The whole safety rule of Slice 2 in one line: a segment that is not
      // sealed can still be rewritten, so it must never reach a speaker. The
      // bus counts every time it was offered more than the server sent.
      window.usernode.invariants.register('no-audio-for-unsealed-segments', function () {
        if (!Audio) return true;
        const st = Audio.state();
        if (st.unsealedBlocked > 0) {
          return `${st.unsealedBlocked} unsealed segment(s) were offered for speech`;
        }
        return true;
      });

      // Ducking that is never released is the failure nobody reports: the
      // room stays quiet, or the microphone stays off, and it looks like the
      // call died. Idle and ducked at the same time is always a bug.
      window.usernode.invariants.register('duck-released-when-idle', function () {
        if (!Audio) return true;
        const st = Audio.state();
        if (st.ducked && !st.speaking && st.queuedSegments === 0) {
          return 'audio is ducked while nothing is being spoken';
        }
        return true;
      });

      // Falling behind is a worse failure than skipping, so the queue is
      // bounded on both axes. Over the cap means trim() stopped working and
      // the voice is drifting away from the screen.
      window.usernode.invariants.register('audio-queue-within-caps', function () {
        if (!Audio) return true;
        const cfg = audioCfg();
        const st = Audio.state();
        const maxSeg = cfg.MAX_QUEUE_SEGMENTS || 8;
        const maxUtt = cfg.MAX_QUEUE_UTTERANCES || 3;
        if (st.queuedSegments > maxSeg) {
          return `${st.queuedSegments} clauses queued, cap is ${maxSeg}`;
        }
        if (st.queuedUtterances > maxUtt) {
          return `${st.queuedUtterances} captions queued, cap is ${maxUtt}`;
        }
        return true;
      });
    }

    // Opt-in debug snapshot for filed issues. Deliberately carries NO
    // utterance text — issue bodies are public, and what people say in a
    // support call is not ours to publish.
    if (window.usernode && window.usernode.issueState) {
      window.usernode.issueState.register(function () {
        return {
          route: S.route && S.route.name,
          roomCode: S.room && S.room.code,
          purpose: S.room && S.room.purpose,
          twoWay: S.room && S.room.twoWay,
          mode: S.room && S.room.mode,
          isMember: S.isMember,
          myRole: S.me && S.me.role,
          speaks: S.prefs.speaksLang,
          hears: S.hearsLang,
          tier: S.tier && S.tier.key,
          rosterMode: S.rosterMode,
          participantCount: S.participantCount,
          langGroups: (S.langGroups || []).map((g) => `${g.lang}:${g.size}:${g.status}`),
          activeSpeakers: (S.activeSpeakers || []).length,
          queueLength: (S.queue || []).length,
          myQueuePosition: S.myQueuePosition,
          degradeLevel: S.budget && S.budget.level,
          dialInAvailable: !!(S.dialIn && S.dialIn.available),
          participants: S.participants.size,
          utterancesInFeed: S.utterances.size,
          cursor: S.cursor,
          connected: S.connected,
          listening: Speech.wantListening,
          sttSupported: Speech.supported(),
          ttsSupported: !!window.speechSynthesis,
          // Audio bus. Counters and states only, never a clause of text.
          audioMode: audioMode(),
          audioSupported: !!(Audio && Audio.state().supported),
          audioDisabled: !!(Audio && Audio.state().disabled),
          audioVoices: Audio ? Audio.state().voices : 0,
          audioQueuedSegments: Audio ? Audio.state().queuedSegments : 0,
          audioQueuedUtterances: Audio ? Audio.state().queuedUtterances : 0,
          audioSpeaking: !!(Audio && Audio.state().speaking),
          audioDucked: !!(Audio && Audio.state().ducked),
          audioSinks: Audio ? Audio.state().sinks : 0,
          audioFallbacks: Audio ? Audio.state().fallbacks : 0,
          audioLastOutcome: Audio ? Audio.state().lastOutcome : null,
          llmEnabled: !!(S.config && S.config.llmEnabled),
          outboxPending: outbox.read().length,
        };
      });
    }

    try {
      await render();
    } catch (err) {
      report('boot', err);
      throw err;
    }
  }

  window.addEventListener('beforeunload', () => {
    Speech.stop();
    Voice.clear();
    if (Audio) Audio.clear();
  });
  boot();
})();
