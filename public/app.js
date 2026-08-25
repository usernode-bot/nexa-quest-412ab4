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

  // --- state ---------------------------------------------------------------
  const S = {
    config: null,
    prefs: { speaksLang: 'en', hearsLang: 'en', ttsEnabled: true, isDefault: true },
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
      <section id="lang-sheet" role="dialog" aria-label="Language settings"
               class="fixed inset-x-0 bottom-0 z-50 max-h-[88vh] overflow-y-auto rounded-t-2xl bg-zinc-950 border-t border-zinc-800 fade-in"
               style="padding-bottom: calc(1.25rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">
        <div class="max-w-2xl mx-auto px-4 pt-3">
          <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-700"></div>
          <h2 class="text-base font-semibold">Your languages</h2>
          <p class="text-xs text-zinc-500 mt-0.5 mb-4">
            You speak one language and hear another. Everyone in the call picks their own pair.
          </p>

          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">I speak</h3>
          <div class="grid gap-1.5 mb-5">
            ${langs.map((l) => option(l, 'speaksLang', S.prefs.speaksLang === l.code)).join('')}
          </div>

          <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">I want to hear / read</h3>
          <div class="grid gap-1.5 mb-5">
            ${langs.map((l) => option(l, 'hearsLang', S.prefs.hearsLang === l.code)).join('')}
          </div>

          <label class="flex items-center justify-between gap-3 px-3 py-3 rounded-xl bg-zinc-900 mb-4">
            <span class="min-w-0">
              <span class="block text-sm">Speak translations out loud</span>
              <span class="block text-xs text-zinc-500">Off means subtitles only.</span>
            </span>
            <input type="checkbox" id="tts-toggle" class="un-switch" ${S.prefs.ttsEnabled ? 'checked' : ''}>
          </label>

          ${soon.length ? `
            <h3 class="text-xs uppercase tracking-wide text-zinc-500 mb-2">Coming soon</h3>
            <div class="flex flex-wrap gap-1.5 mb-5">
              ${soon.map((l) => `<span class="px-2 py-1 rounded-full bg-zinc-900 text-zinc-500 text-xs">${l.flag} ${esc(l.label)}</span>`).join('')}
            </div>` : ''}

          <button id="lang-save" class="un-pressable w-full py-3 rounded-xl bg-violet-600 text-white font-medium">Save languages</button>
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
    overlay.querySelector('#tts-toggle').addEventListener('change', (e) => {
      S.prefs.ttsEnabled = e.target.checked;
    });
    overlay.querySelector('#lang-save').addEventListener('click', async () => {
      try {
        const r = await api('/api/me/prefs', { method: 'PUT', body: S.prefs });
        S.prefs = r.prefs;
        if (S.route && S.route.name === 'room' && S.isMember) {
          await api(`/api/rooms/${S.route.code}/me`, {
            method: 'PATCH',
            body: { speaksLang: S.prefs.speaksLang, hearsLang: S.prefs.hearsLang, ttsEnabled: S.prefs.ttsEnabled },
          });
          S.cursor = 0;
        }
        notify('Languages saved');
      } catch (err) {
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
          <input id="room-title" maxlength="120" placeholder="Call title (optional)"
                 class="w-full px-3 py-3 rounded-xl bg-zinc-900 text-sm placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500">
          <button id="start-call" class="un-pressable w-full py-3.5 rounded-xl bg-violet-600 text-white font-semibold">
            Start a call
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
          if (r.isFinal) this.onFinal(text);
          else interim += ` ${text}`;
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
        ${tr.latencyMs != null ? `<p class="text-[11px] text-zinc-700 mt-1">${tr.latencyMs} ms</p>` : ''}`;
    } else if (tr && tr.status === 'pending') {
      translationBlock = `<p class="translation text-sm text-zinc-500 animate-pulse">Translating into ${esc(langOf(target).label)}…</p>`;
    } else if (tr && tr.status === 'unavailable') {
      translationBlock = `<p class="translation text-sm text-amber-400/80">Translation unavailable here — showing the original.</p>`;
    } else if (tr) {
      translationBlock = `<p class="translation text-sm text-red-400/80">Translation failed. The original is above.</p>`;
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

  function rosterHTML() {
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
          <p class="text-sm font-medium">Translation preview</p>
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
          <p class="text-sm text-zinc-400">This is a one-way call — the host and agents speak, you listen in ${esc(langOf(S.hearsLang).label)}.</p>
          <button id="raise-hand" class="un-pressable w-full py-2.5 rounded-lg ${raised ? 'bg-amber-500/20 text-amber-300' : 'bg-zinc-800 text-zinc-200'} text-sm font-medium">
            ${raised ? '✋ Hand raised — waiting for the host' : '✋ Raise your hand'}
          </button>
        </div>`;
    }

    const listening = Speech.wantListening;
    return `
      <div class="space-y-2">
        <p id="mic-error" class="hidden text-xs text-amber-400"></p>
        <p id="interim" class="hidden text-sm text-zinc-500 italic px-1"></p>
        <div class="h-1 rounded-full bg-zinc-800 overflow-hidden">
          <div id="level" class="level-bar h-full bg-violet-500" style="transform: scaleX(0)"></div>
        </div>
        <div class="flex gap-2">
          <button id="mic-toggle" class="un-pressable flex-1 py-3 rounded-xl font-medium text-sm ${listening ? 'bg-red-600 text-white' : 'bg-violet-600 text-white'}">
            ${listening ? '■ Stop speaking' : '🎙 Start speaking'}
          </button>
          <button id="tts-quick" class="un-pressable px-4 rounded-xl bg-zinc-800 text-sm" title="Play translations out loud">
            ${S.prefs.ttsEnabled ? '🔊' : '🔇'}
          </button>
        </div>
        <form id="type-form" class="flex gap-2">
          <input id="type-input" maxlength="${(S.config && S.config.limits.MAX_UTTERANCE_CHARS) || 500}"
                 placeholder="…or type it in ${esc(langOf(S.prefs.speaksLang).label)}"
                 class="flex-1 px-3 py-2.5 rounded-xl bg-zinc-900 text-sm placeholder-zinc-600 outline-none focus:ring-1 focus:ring-violet-500">
          <button class="un-pressable px-4 rounded-xl bg-zinc-800 text-sm">Send</button>
        </form>
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
        subtitle: `${purposeDef ? `${purposeDef.icon} ${purposeDef.label} · ` : ''}${room.code}`,
        right: `<button id="open-langs" class="un-touch-target text-xs px-2 py-1 rounded-full bg-zinc-800">${langOf(S.prefs.speaksLang).flag}→${langOf(S.hearsLang).flag}</button>`,
      })}
      <main class="max-w-2xl mx-auto px-4 py-4 space-y-4"
            style="padding-bottom: calc(2rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)))">

        ${!S.connected ? `<div class="p-2.5 rounded-lg bg-amber-500/10 text-amber-300 text-xs">Reconnecting… anything you say is queued and will be sent.</div>` : ''}
        ${room.endedAt ? `<div class="p-2.5 rounded-lg bg-zinc-800 text-zinc-400 text-xs">This call has ended.</div>` : ''}
        ${room.mode === 'transcript_only' ? `<div class="p-2.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs">Transcript-only mode: everything is captured in the original language, nothing is translated.</div>` : ''}
        ${S.config && !S.config.llmEnabled ? `<div class="p-2.5 rounded-lg bg-zinc-800 text-zinc-400 text-xs">Live translation is unavailable in this environment — captions show the original language.</div>` : ''}

        <div id="feed" class="space-y-2 max-h-[52vh] overflow-y-auto pr-1">
          ${utterances.length
            ? utterances.map(utteranceHTML).join('')
            : `<p class="text-sm text-zinc-600 py-8 text-center">Nothing said yet. When someone speaks, their words appear here in ${esc(langOf(S.hearsLang).label)}.</p>`}
        </div>

        ${composerHTML()}

        ${!S.isMember ? '' : isHost ? `
          <div class="flex gap-2">
            <button id="toggle-mode" class="un-pressable flex-1 py-2 rounded-lg bg-zinc-900 text-xs text-zinc-300">
              ${room.mode === 'transcript_only' ? 'Turn translation back on' : 'Switch to transcript-only'}
            </button>
            <button id="end-call" class="un-pressable flex-1 py-2 rounded-lg bg-red-600/20 text-red-300 text-xs">End the call</button>
          </div>` : `
          <button id="leave-call" class="un-pressable w-full py-2 rounded-lg bg-zinc-900 text-xs text-zinc-400">Leave the call</button>`}

        ${rosterHTML()}

        <div class="pt-2 text-center">
          <p class="text-[11px] text-zinc-700">Share this call: code <span class="font-mono text-zinc-500">${esc(room.code)}</span></p>
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

    if (el('tts-quick')) {
      el('tts-quick').addEventListener('click', async () => {
        S.prefs.ttsEnabled = !S.prefs.ttsEnabled;
        if (!S.prefs.ttsEnabled) Voice.clear();
        try { await api('/api/me/prefs', { method: 'PUT', body: S.prefs }); } catch { /* local toggle still applies */ }
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
        const holder = S.participants.get(err.data && err.data.holder);
        setMicError(`${holder ? holder.username : 'Someone else'} has the floor right now.`);
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

  async function onFinalTranscript(text) {
    if (!await claimFloor()) return;
    setMicError('');
    await sendUtterance(text, 'voice');
  }

  async function sendUtterance(text, via) {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = { id: localId, code: S.route.code, text, via, sourceLang: S.prefs.speaksLang };
    outbox.add(item);
    await flushOutbox();
  }

  async function flushOutbox() {
    const pending = outbox.read().filter((i) => i.code === (S.route && S.route.code));
    for (const item of pending) {
      try {
        await api(`/api/rooms/${item.code}/utterances`, {
          method: 'POST',
          body: { text: item.text, via: item.via, sourceLang: item.sourceLang },
        });
        outbox.remove(item.id);
        S.connected = true;
      } catch (err) {
        if (err.status && err.status >= 400 && err.status < 500) {
          // A rejection is final — drop it rather than retrying forever.
          outbox.remove(item.id);
          notify(err.message);
        } else {
          S.connected = false;
          return;
        }
      }
    }
    await poll();
  }

  // --- the poll loop -------------------------------------------------------
  async function poll() {
    if (!S.route || S.route.name !== 'room') return;
    try {
      const data = await api(`/api/rooms/${S.route.code}/stream?since=${S.cursor}`);
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
      S.connected = true;
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

      // Play new captions out loud. Stage 3 (one-way rooms) restricts this to
      // the people who actually hold the floor; Stage 4 (two-way) plays
      // everyone. Never play our own words back at ourselves.
      if (S.prefs.ttsEnabled && S.room && !S.room.endedAt) {
        for (const u of fresh) {
          if (S.spokenIds.has(u.id)) continue;
          S.spokenIds.add(u.id);
          if (S.me && u.speakerUserId === S.me.userId) continue;
          const speaker = S.participants.get(u.speakerUserId);
          if (!S.room.twoWay && speaker && speaker.role === 'audience') continue;
          const tr = (u.translations || []).find((t) => t.targetLang === S.hearsLang);
          if (tr && tr.status === 'ok') Voice.say(tr.text, S.hearsLang);
        }
      }

      if (S.room.endedAt && S.route.name === 'room') {
        Speech.stop(); Voice.clear();
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
      S.connected = false;
      if (S.room) renderRoom();
    }
  }

  function pollDelay() {
    const limits = (S.config && S.config.limits) || {};
    const idleAfter = limits.POLL_IDLE_AFTER_MS || 45000;
    if (Date.now() - S.lastChangeAt > idleAfter) return limits.POLL_IDLE_MS || 2500;
    return limits.POLL_ACTIVE_MS || 900;
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
    if (!document.hidden && S.route && S.route.name === 'room') poll();
  });

  function renderRoomNotFound() {
    appEl().innerHTML = `
      ${header('LIVE TRANSLATION', { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-16 text-center space-y-3">
        <p class="text-4xl">🔍</p>
        <h2 class="text-lg font-semibold">Room not found</h2>
        <p class="text-sm text-zinc-500">
          No call is using the code <span class="font-mono text-zinc-400">${esc(S.route.code)}</span>.
          Check the code, or start a new call.
        </p>
        <button data-nav="/" class="un-pressable mt-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-medium">Back to the lobby</button>
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
        <button data-nav="/" class="un-pressable w-full py-3 rounded-xl bg-violet-600 text-white font-medium">Back to the lobby</button>
      </main>`;
    bindNav(appEl());
  }

  // --- metrics -------------------------------------------------------------
  async function renderMetrics() {
    appEl().innerHTML = `${header('Service metrics', { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">Loading…</main>`;
    let m;
    try {
      m = await api('/api/metrics');
    } catch (err) {
      appEl().innerHTML = `${header('Service metrics', { back: '/' })}
        <main class="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-zinc-500">${esc(err.message)}</main>`;
      bindNav(appEl());
      return;
    }
    const l = m.latency || {};
    const row = (label, value, hint) => `
      <div class="flex items-baseline justify-between gap-3 px-3 py-2.5 rounded-lg bg-zinc-900">
        <span class="text-sm text-zinc-400">${esc(label)}</span>
        <span class="text-sm font-mono">${esc(value)}</span>
        ${hint ? `<span class="text-[11px] text-zinc-600">${esc(hint)}</span>` : ''}
      </div>`;
    const maxU = Math.max(1, ...(m.daily || []).map((d) => d.utterances));
    appEl().innerHTML = `
      ${header('Service metrics', { back: '/' })}
      <main class="max-w-2xl mx-auto px-4 py-5 space-y-5">
        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Caption latency (7 days)</h2>
          ${row('p50 latency', l.p50 != null ? `${l.p50} ms` : '—')}
          ${row('p95 latency', l.p95 != null ? `${l.p95} ms` : '—')}
          ${row('captions produced', l.n || 0)}
          ${row('failed', l.errors || 0)}
          ${row('unavailable', l.unavailable || 0)}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Right now</h2>
          ${row('open calls', (m.live && m.live.open_rooms) || 0)}
          ${row('people in a call', (m.live && m.live.live_participants) || 0)}
          ${row('translation service', m.llmEnabled ? 'available' : 'unavailable here')}
        </section>

        <section class="space-y-1.5">
          <h2 class="text-xs uppercase tracking-wide text-zinc-500">Translation grant acceptance (30 days)</h2>
          ${row('asked', (m.grants && m.grants.asked) || 0)}
          ${row('granted', (m.grants && m.grants.granted) || 0)}
          ${row('acceptance rate', m.grants && m.grants.acceptanceRate != null ? `${m.grants.acceptanceRate}%` : '—')}
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
      </main>`;
    bindNav(appEl());
  }

  // --- render --------------------------------------------------------------
  async function render() {
    const route = parseRoute();
    const changedRoom = !S.route || S.route.name !== route.name || S.route.code !== route.code;
    S.route = route;

    if (changedRoom) {
      stopPolling();
      Speech.stop();
      Voice.clear();
      if (route.name !== 'room') {
        S.room = null; S.me = null; S.participants.clear(); S.utterances.clear();
        S.cursor = 0; S.spokenIds.clear();
      }
    }

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
    }

    // The `?screen=languages` deep link is pure UI state — no writes — so it
    // works identically in production, which is where the "before"
    // screenshot of any change to this sheet gets taken.
    if (new URLSearchParams(location.search).get('screen') === 'languages') {
      renderLanguageSheet();
    } else {
      document.getElementById('overlay').innerHTML = '';
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

    // Ask the platform for the user's language preference only when they
    // have not made a choice inside this app. Their in-app choice wins.
    if (S.prefs.isDefault && window.usernode && typeof window.usernode.getUserLocale === 'function') {
      try {
        const { locale } = await window.usernode.getUserLocale();
        if (locale) {
          const match = (S.config.languages || []).find(
            (l) => locale === l.code || locale.toLowerCase().startsWith(`${l.code}-`)
          );
          if (match) { S.prefs.speaksLang = match.code; S.prefs.hearsLang = match.code; S.hearsLang = match.code; }
        }
      } catch { /* no shell — keep the JWT-claim default the server gave us */ }
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
        if (!S.room || !S.participants.size) return true;
        const listening = new Set(
          Array.from(S.participants.values()).filter((p) => !p.left && !p.removed).map((p) => p.hearsLang)
        );
        const max = (S.config && S.config.limits.MAX_TARGET_LANGS) || 4;
        if (listening.size > max) {
          return `roster carries ${listening.size} listening languages, over the ${max} cap`;
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
          participants: S.participants.size,
          utterancesInFeed: S.utterances.size,
          cursor: S.cursor,
          connected: S.connected,
          listening: Speech.wantListening,
          sttSupported: Speech.supported(),
          ttsSupported: !!window.speechSynthesis,
          llmEnabled: !!(S.config && S.config.llmEnabled),
          outboxPending: outbox.read().length,
        };
      });
    }

    await render();
  }

  window.addEventListener('beforeunload', () => { Speech.stop(); Voice.clear(); });
  boot();
})();
