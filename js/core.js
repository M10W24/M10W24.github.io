/*!
 * Hypha — js/core.js  (SPEC.md §4.1 — copy verbatim; change only together with the spec)
 * Shared namespace window.FT: event bus, utilities, storage, codecs, state table, palette,
 * timeline analysis, worker-driven heartbeat clock, environment flags.
 * Classic script, loaded FIRST with `defer`. No dependencies. Creates no DOM at load time.
 */
(function () {
  'use strict';

  const FT = (window.FT = window.FT || {});
  FT.VERSION = '1.0.0';
  FT.APP_NAME = 'Hypha';

  /* =================================================================== *
   * 1. Event bus — synchronous; a throwing listener never breaks others *
   * =================================================================== */
  const listeners = new Map(); // name -> Set<fn>

  FT.bus = {
    /** Subscribe. Returns an unsubscribe function. */
    on(name, fn) {
      let set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(fn);
      return () => FT.bus.off(name, fn);
    },
    /** Subscribe for one emission only. Returns an unsubscribe function. */
    once(name, fn) {
      const off = FT.bus.on(name, (payload) => { off(); fn(payload); });
      return off;
    },
    off(name, fn) {
      const set = listeners.get(name);
      if (set) set.delete(fn);
    },
    emit(name, payload) {
      const set = listeners.get(name);
      if (!set || set.size === 0) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); }
        catch (err) { console.error('[FT.bus] "' + name + '" listener threw:', err); }
      }
    },
    count(name) { const set = listeners.get(name); return set ? set.size : 0; },
  };

  /* =================================================================== *
   * 2. Utilities                                                         *
   * =================================================================== */
  const U = (FT.util = {});
  const TAU = Math.PI * 2;
  U.TAU = TAU;

  U.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  U.clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.invLerp = (a, b, v) => (a === b ? 0 : (v - a) / (b - a));
  U.remap = (v, inLo, inHi, outLo, outHi) => U.lerp(outLo, outHi, U.clamp01(U.invLerp(inLo, inHi, v)));
  U.smoothstep = (e0, e1, x) => { const t = U.clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

  /** Frame-rate-independent exponential approach of `current` toward `target` (63% after tauMs). */
  U.damp = (current, target, tauMs, dtMs) =>
    (tauMs > 0 ? target + (current - target) * Math.exp(-dtMs / tauMs) : target);
  /** Same, with one time constant while rising (target > current) and another while falling. */
  U.dampAsym = (current, target, tauUpMs, tauDownMs, dtMs) =>
    U.damp(current, target, target > current ? tauUpMs : tauDownMs, dtMs);
  /** Wrap radians into (-PI, PI]. */
  U.wrapAngle = (a) => { a %= TAU; if (a <= -Math.PI) a += TAU; else if (a > Math.PI) a -= TAU; return a; };
  /** Exponential approach for angles in radians, taking the short way round. */
  U.dampAngle = (current, target, tauMs, dtMs) =>
    U.wrapAngle(current + U.wrapAngle(target - current) * (tauMs > 0 ? 1 - Math.exp(-dtMs / tauMs) : 1));

  U.mean = (arr) => { const n = arr.length; if (!n) return NaN; let s = 0; for (let i = 0; i < n; i++) s += arr[i]; return s / n; };
  /** p in [0,1], linear interpolation between closest ranks. Accepts arrays and typed arrays. */
  U.percentile = (arr, p) => {
    const n = arr.length; if (!n) return NaN;
    const a = Array.from(arr).sort((x, y) => x - y);
    const idx = U.clamp(p, 0, 1) * (n - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
  };
  U.median = (arr) => U.percentile(arr, 0.5);
  /** Median absolute deviation. */
  U.mad = (arr) => { const m = U.median(arr); return U.median(Array.from(arr, (v) => Math.abs(v - m))); };

  /** 32-bit FNV-1a hash of a string -> unsigned int. */
  U.hashString = (str) => {
    let h = 0x811c9dc5;
    str = String(str);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  /** Seeded PRNG (mulberry32). Returns a function producing floats in [0, 1). */
  U.rng = (seed) => {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  U.uid = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  U.pad2 = (n) => (n < 10 ? '0' : '') + n;
  /** "4:05", "25:00", "1:02:03". roundUp=true for countdowns (25:00 at start, 0:01 in the last second). */
  U.fmtClock = (ms, roundUp) => {
    const total = Math.max(0, roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h > 0 ? h + ':' + U.pad2(m) + ':' + U.pad2(s) : m + ':' + U.pad2(s);
  };
  /** "45s", "12m", "1h 05m". Null/NaN -> "–". */
  U.fmtDuration = (ms) => {
    if (ms == null || !isFinite(ms)) return '–';
    ms = Math.max(0, ms);
    if (ms < 59500) return Math.round(ms / 1000) + 's';
    if (ms < 3570000) return Math.round(ms / 60000) + 'm';
    let h = Math.floor(ms / 3600000), m = Math.round((ms - h * 3600000) / 60000);
    if (m === 60) { h += 1; m = 0; }
    return h + 'h ' + U.pad2(m) + 'm';
  };
  /** 0.912 -> "91%". Null/NaN -> "–". */
  U.fmtPercent = (x) => (x == null || !isFinite(x) ? '–' : Math.round(x * 100) + '%');
  U.truncate = (str, n) => {
    str = String(str == null ? '' : str).trim();
    return str.length > n ? str.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : str;
  };

  /* Dates — local time. Day keys are "YYYY-MM-DD". Weeks start Monday (weekday 0 = Monday). */
  const toDate = (d) => (d instanceof Date ? d : new Date(d == null ? Date.now() : d));
  U.dayKey = (d) => { d = toDate(d); return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()); };
  U.parseDayKey = (key) => { const p = String(key).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
  U.addDays = (key, n) => { const d = U.parseDayKey(key); d.setDate(d.getDate() + n); return U.dayKey(d); };
  U.weekday = (d) => (toDate(d).getDay() + 6) % 7;
  U.mondayOf = (key) => U.addDays(key, -U.weekday(U.parseDayKey(key)));

  /** Leading + trailing throttle. */
  U.throttle = (fn, ms) => {
    let last = 0, timer = null, pending = null;
    return function (...args) {
      const now = Date.now(), wait = ms - (now - last);
      if (wait <= 0) { last = now; fn.apply(this, args); return; }
      pending = args;
      if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, pending); }, wait);
    };
  };
  U.param = (name) => { try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; } };

  /* Colours */
  U.hexToRgb = (hex) => {
    const h = String(hex).replace('#', '');
    const v = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  U.mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  U.rgba = (rgb, alpha) =>
    'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' +
    (alpha == null ? 1 : +U.clamp01(alpha).toFixed(3)) + ')';

  FT.$ = (id) => document.getElementById(id);

  /* =================================================================== *
   * 3. Storage — localStorage under the "hypha." prefix, JSON values.    *
   *    Falls back to an in-memory map when storage is unavailable.       *
   * =================================================================== */
  const PREFIX = 'hypha.';
  const memory = new Map(); // key -> raw JSON of the latest value set in this page
  let storageOk = false;
  try {
    const k = PREFIX + '__probe';
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    storageOk = true;
  } catch (e) { storageOk = false; }

  FT.store = {
    get available() { return storageOk; },
    get(key, fallback) {
      let raw = memory.has(key) ? memory.get(key) : null;
      if (raw == null && storageOk) { try { raw = localStorage.getItem(PREFIX + key); } catch (e) { raw = null; } }
      if (raw == null) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    },
    /** Returns true when persisted to localStorage; false when only kept in memory. Emits 'store:error' on failure. */
    set(key, value) {
      let raw;
      try { raw = JSON.stringify(value); } catch (e) { return false; }
      memory.set(key, raw);
      if (!storageOk) return false;
      try { localStorage.setItem(PREFIX + key, raw); return true; }
      catch (e) {
        const quota = !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
        FT.bus.emit('store:error', { key: key, name: (e && e.name) || 'Error', quota: quota });
        return false;
      }
    },
    remove(key) {
      memory.delete(key);
      if (storageOk) { try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ } }
    },
    /** All keys (without prefix) known in memory or localStorage. */
    keys() {
      const out = new Set(memory.keys());
      if (storageOk) {
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf(PREFIX) === 0) out.add(k.slice(PREFIX.length));
          }
        } catch (e) { /* ignore */ }
      }
      return Array.from(out);
    },
    clearAll() { for (const k of FT.store.keys()) FT.store.remove(k); },
  };

  /* =================================================================== *
   * 4. Codecs — one char per active second in session timelines          *
   * =================================================================== */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  FT.codec = {
    ALPHABET: B64,
    ANGLE_STEPS: 36, // 10 degree steps
    /** 0..1 -> one char (64 levels). */
    level(v01) { return B64[Math.round(U.clamp01(+v01 || 0) * 63)]; },
    unlevel(ch) { const i = B64.indexOf(ch); return i < 0 ? 0 : i / 63; },
    /** Radians (screen space: 0 = right, +PI/2 = down) -> one char; null/NaN -> '.'. */
    angle(rad) {
      if (rad == null || !isFinite(rad)) return '.';
      let a = rad % TAU; if (a < 0) a += TAU;
      return B64[Math.round((a / TAU) * 36) % 36];
    },
    unangle(ch) {
      if (!ch || ch === '.') return null;
      const i = B64.indexOf(ch);
      return i < 0 || i >= 36 ? null : U.wrapAngle((i / 36) * TAU);
    },
    /** Decoded record i of a timeline {s,f,d,a}: { s: code char, f: 0..1, d: 0..1, a: radians|null }. */
    rec(tl, i) {
      return { s: tl.s[i], f: FT.codec.unlevel(tl.f[i]), d: FT.codec.unlevel(tl.d[i]), a: FT.codec.unangle(tl.a[i]) };
    },
    /** Run-length view of a code string: [{ code, start, len }]. */
    runs(s) {
      const out = [];
      let i = 0;
      while (i < s.length) {
        const c = s[i]; let j = i + 1;
        while (j < s.length && s[j] === c) j++;
        out.push({ code: c, start: i, len: j - i });
        i = j;
      }
      return out;
    },
  };

  /* =================================================================== *
   * 5. State table, causes, palette                                      *
   * =================================================================== */
  // held: counts as focused time.  measured: counts in the focus-% denominator.
  // away: a distraction record (starts / extends an episode).
  const C = (code, state, cause, word, label, held, measured, away, color) =>
    ({ code, state, cause, word, label, held, measured, away, color });
  FT.CODES = {
    F: C('F', 'focused',     null,     'rooted',    'Focused',        true,  true,  false, 'hypha'),
    W: C('W', 'drifting',    null,     'wavering',  'Wavering',       true,  true,  false, 'hyphaDim'),
    K: C('K', 'forgiven',    null,     'rooted',    'Forgiven drift', true,  true,  false, 'hyphaDim'),
    M: C('M', 'unmeasured',  null,     'growing',   'Timer only',     true,  false, false, 'hyphaDim'),
    T: C('T', 'away',        'turned', 'shy',       'Head turned',    false, true,  true,  'scar'),
    G: C('G', 'away',        'glance', 'shy',       'Glance',         false, true,  true,  'scar'),
    D: C('D', 'away',        'down',   'sinking',   'Looking down',   false, true,  true,  'scar'),
    U: C('U', 'away',        'up',     'shy',       'Looking up',     false, true,  true,  'scar'),
    X: C('X', 'away',        'tab',    'elsewhere', 'Other tab',      false, true,  true,  'scar'),
    E: C('E', 'eyes-closed', 'eyes',   'asleep',    'Eyes closed',    false, true,  false, 'amber'),
    A: C('A', 'absent',      'absent', 'dormant',   'Stepped away',   false, false, false, 'frost'),
    N: C('N', 'unseen',      null,     'unseen',    'Not observed',   false, false, false, 'unseen'),
  };
  FT.codeFor = (state, cause) => {
    switch (state) {
      case 'focused': return 'F';
      case 'drifting': return 'W';
      case 'forgiven': return 'K';
      case 'unmeasured': return 'M';
      case 'eyes-closed': return 'E';
      case 'absent': return 'A';
      case 'away':
        return cause === 'glance' ? 'G' : cause === 'down' ? 'D' : cause === 'up' ? 'U' : cause === 'tab' ? 'X' : 'T';
      default: return 'N';
    }
  };
  /** Distraction causes (episode causes), in display order. */
  FT.CAUSES = ['down', 'turned', 'glance', 'up', 'tab', 'eyes'];
  FT.CAUSE_LABEL = {
    down: 'Looking down', turned: 'Turned away', glance: 'Side glances',
    up: 'Looking up', tab: 'Other tabs', eyes: 'Eyes closed',
  };
  /** Words shown for non-attention phases. */
  FT.PHASE_WORDS = { idle: 'dormant', calibrating: 'germinating', paused: 'paused', break: 'resting', complete: 'fruiting' };

  /** Canonical colours for canvas code (CSS mirrors these as --tokens). */
  FT.PALETTE = {
    abyss: '#04080A', dish: '#0B1719', line: '#1B3431',
    hypha: '#7CF5D0', hyphaDim: '#4FA893', flow: '#A99BFF', core: '#EFFFF8',
    gold: '#F4D58D', amber: '#E3A15A', frost: '#3C5F78', scar: '#C45A72',
    text: '#CFE6DF', muted: '#6C8883', unseen: '#33403F',
  };

  /* =================================================================== *
   * 6. Timeline analysis — the ONE definition of episodes, streaks,      *
   *    scars and mending. Used by Session (stats), Visual (scars, caps)  *
   *    and Keepsake. Pure: same timeline -> same result.                 *
   *                                                                      *
   *    Rules (N records are transparent: they neither extend nor break): *
   *    - An episode starts at the first away record (T G D U X), or when *
   *      an E-run reaches 10 records (t0 = start of that E-run).         *
   *    - While open, E and A records extend it. The first held record    *
   *      (F W K M) ends it: t1 = that index, and it counts as a return.  *
   *    - Streak = consecutive held records. Frozen (not reset) during    *
   *      E/A/away records; reset once an episode reaches 5 records       *
   *      ("short slips under 5 s don't break a streak") or an A-run      *
   *      reaches 10 records.                                             *
   *    - An ended episode is MENDED when 60 held records follow it       *
   *      (E/A/away records reset that count; a new episode cancels it).  *
   *    - A maximal run of K records is a forgiven episode.               *
   *    - An A-run of >= 10 records is an absence ("stepped away").       *
   * =================================================================== */
  const SECTOR = Math.PI / 4;
  FT.analyze = function (tl) {
    const s = (tl && tl.s) || '', aStr = (tl && tl.a) || '', dStr = (tl && tl.d) || '';
    const n = s.length;
    const counts = { F: 0, W: 0, K: 0, M: 0, T: 0, G: 0, D: 0, U: 0, X: 0, E: 0, A: 0, N: 0 };
    const episodes = [], forgiven = [], absences = [], streaks = [];
    const byCause = { down: 0, turned: 0, glance: 0, up: 0, tab: 0, eyes: 0 };
    const byCauseSec = { down: 0, turned: 0, glance: 0, up: 0, tab: 0, eyes: 0 };
    const dirs = [0, 0, 0, 0, 0, 0, 0, 0];

    let ep = null;                 // open episode (internal accumulator)
    let streak = 0, streakStart = -1, longest = 0, timeToRoot = null;
    let eRun = 0, eRunStart = -1, aRun = 0, aRunStart = -1;
    let kRun = null;               // open forgiven run
    let pendingMend = null, mendCount = 0;
    let peakDepth = 0;

    const closeStreak = () => {
      if (streak >= 60) streaks.push({ t0: streakStart, t1: streakStart + streak, dur: streak });
      streak = 0; streakStart = -1;
    };
    const openEpisode = (t0, dur) => {
      ep = { t0: t0, dur: dur, causeCount: { down: 0, turned: 0, glance: 0, up: 0, tab: 0, eyes: 0 }, cx: 0, cy: 0, na: 0 };
      pendingMend = null; mendCount = 0;
    };
    const finishEpisode = (t1) => {
      let cause = 'eyes', best = -1;
      for (const k of ['down', 'turned', 'glance', 'up', 'tab']) {
        if (ep.causeCount[k] > best && ep.causeCount[k] > 0) { best = ep.causeCount[k]; cause = k; }
      }
      let angle = ep.na > 0 ? Math.atan2(ep.cy, ep.cx) : null;
      if (angle === null && cause === 'down') angle = Math.PI / 2;
      if (angle === null && (cause === 'up' || cause === 'tab')) angle = -Math.PI / 2;
      const out = { t0: ep.t0, t1: t1, dur: ep.dur, cause: cause, angle: angle, mended: false, mendAt: null };
      episodes.push(out);
      byCause[cause] += 1;
      for (const k in ep.causeCount) byCauseSec[k] += ep.causeCount[k];
      if (angle !== null && cause !== 'eyes' && cause !== 'tab') {
        dirs[((Math.round(angle / SECTOR) % 8) + 8) % 8] += 1;
      }
      ep = null;
      return out;
    };
    const closeKRun = () => {
      if (kRun) { forgiven.push({ t0: kRun.t0, t1: kRun.t0 + kRun.dur, dur: kRun.dur, angle: kRun.na ? Math.atan2(kRun.cy, kRun.cx) : null }); kRun = null; }
    };

    for (let i = 0; i < n; i++) {
      const c = s[i];
      if (counts[c] === undefined) continue;
      counts[c] += 1;
      if (c === 'N') continue;
      const dv = FT.codec.unlevel(dStr[i]);
      if (dv > peakDepth) peakDepth = dv;
      const info = FT.CODES[c];

      if (c === 'K') {
        if (!kRun) kRun = { t0: i, dur: 0, cx: 0, cy: 0, na: 0 };
        kRun.dur += 1;
        const ka = FT.codec.unangle(aStr[i]);
        if (ka !== null) { kRun.cx += Math.cos(ka); kRun.cy += Math.sin(ka); kRun.na += 1; }
      } else {
        closeKRun();
      }

      if (info.held) {
        if (ep) {
          const done = finishEpisode(i);
          pendingMend = done; mendCount = 0;
        }
        if (aRun >= 10) absences.push({ t0: aRunStart, t1: i, dur: aRun });
        eRun = 0; aRun = 0;
        if (streak === 0) streakStart = i;
        streak += 1;
        if (streak > longest) longest = streak;
        if (timeToRoot === null && streak >= 300) timeToRoot = streakStart;
        if (pendingMend) {
          mendCount += 1;
          if (mendCount >= 60) { pendingMend.mended = true; pendingMend.mendAt = i; pendingMend = null; mendCount = 0; }
        }
        continue;
      }

      // Not held: E, A or away.
      mendCount = 0;
      if (info.away) {
        if (aRun >= 10) absences.push({ t0: aRunStart, t1: i, dur: aRun });
        eRun = 0; aRun = 0;
        if (!ep) openEpisode(i, 0);
        ep.dur += 1;
        ep.causeCount[info.cause] += 1;
        const a = FT.codec.unangle(aStr[i]);
        if (a !== null) { ep.cx += Math.cos(a); ep.cy += Math.sin(a); ep.na += 1; }
        if (ep.dur === 5) closeStreak();
      } else if (c === 'E') {
        if (aRun >= 10) absences.push({ t0: aRunStart, t1: i, dur: aRun });
        aRun = 0;
        if (eRun === 0) eRunStart = i;
        eRun += 1;
        if (ep) { ep.dur += 1; ep.causeCount.eyes += 1; }
        else if (eRun === 10) {
          openEpisode(eRunStart, 10);
          ep.causeCount.eyes += 10;
          closeStreak();
        }
      } else if (c === 'A') {
        eRun = 0;
        if (aRun === 0) aRunStart = i;
        aRun += 1;
        if (ep) ep.dur += 1;
        if (aRun === 10) closeStreak();
      }
    }
    closeKRun();
    if (aRun >= 10) absences.push({ t0: aRunStart, t1: n, dur: aRun });
    const openEp = ep ? finishEpisode(null) : null;
    const current = streak;
    closeStreak();

    const ended = episodes.filter((e) => e.t1 !== null);
    const recov = ended.map((e) => e.dur);
    const measuredSec = counts.F + counts.W + counts.K + counts.T + counts.G + counts.D + counts.U + counts.X + counts.E;
    const measuredHeld = counts.F + counts.W + counts.K;
    return {
      length: n,
      counts: counts,
      heldSec: counts.F + counts.W + counts.K + counts.M,
      measuredSec: measuredSec,
      measuredHeldSec: measuredHeld,
      unmeasuredSec: counts.M,
      unseenSec: counts.N,
      absentSec: counts.A,
      focusPct: measuredSec >= 30 ? measuredHeld / measuredSec : null,
      episodes: episodes,            // [{t0, t1|null, dur, cause, angle|null, mended, mendAt|null}]
      openEpisode: openEp,           // the last episode if still open at the end, else null
      forgiven: forgiven,            // [{t0, t1, dur, angle|null}]
      absences: absences,            // [{t0, t1, dur}]
      streaks: streaks,              // held streaks >= 60 s: [{t0, t1, dur}]
      longestStreak: longest,        // seconds
      currentStreak: current,        // seconds (0 if broken at the end)
      timeToRoot: timeToRoot,        // index where the first 300 s streak began, or null
      distractions: episodes.length,
      returns: ended.length,
      mended: episodes.filter((e) => e.mended).length,
      steppedAway: absences.length,
      byCause: byCause,
      byCauseSec: byCauseSec,
      dirs: dirs,                    // 8 sectors: 0 = right, 2 = down, 4 = left, 6 = up
      medianRecovery: recov.length ? U.median(recov) : null, // seconds
      peakDepth: peakDepth,
    };
  };

  /* =================================================================== *
   * 7. Heartbeat clock — Blob-Worker ticks survive background-tab        *
   *    throttling (~14 Hz visible, 4 Hz hidden). Emits 'clock:tick'.     *
   * =================================================================== */
  FT.clock = (function () {
    const VISIBLE_MS = 70, HIDDEN_MS = 250;
    let worker = null, timer = null, running = false, lastNow = 0, lastWall = 0;

    const rate = () => (document.hidden ? HIDDEN_MS : VISIBLE_MS);
    function tick() {
      const now = performance.now(), wall = Date.now();
      const dt = lastNow ? now - lastNow : 0, dtWall = lastWall ? wall - lastWall : 0;
      lastNow = now; lastWall = wall;
      FT.bus.emit('clock:tick', { now: now, wall: wall, dt: dt, dtWall: dtWall, hidden: document.hidden });
    }
    function apply() {
      if (!running) return;
      if (worker) { worker.postMessage(rate()); return; }
      if (timer) clearInterval(timer);
      timer = setInterval(tick, rate());
    }
    function start() {
      if (running) return;
      running = true; lastNow = 0; lastWall = 0;
      try {
        const src = 'var id=null;onmessage=function(e){clearInterval(id);id=null;if(e.data>0)id=setInterval(function(){postMessage(0);},e.data);};';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = tick;
        worker.onerror = function () { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; apply(); };
      } catch (e) { worker = null; }
      document.addEventListener('visibilitychange', apply);
      apply();
    }
    function stop() {
      if (!running) return;
      running = false;
      document.removeEventListener('visibilitychange', apply);
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
      if (timer) { clearInterval(timer); timer = null; }
    }
    return {
      start: start,
      stop: stop,
      get running() { return running; },
      get usingWorker() { return !!worker; },
      get intervalMs() { return rate(); },
    };
  })();

  /* =================================================================== *
   * 8. Environment                                                       *
   * =================================================================== */
  const mq = (q) => { try { return window.matchMedia(q).matches; } catch (e) { return false; } };
  let webgl2 = null;
  FT.env = {
    demo: U.param('demo') === '1',
    debug: U.param('debug') === '1',
    isFile: location.protocol === 'file:',
    secure: !!window.isSecureContext,
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasDocPiP: 'documentPictureInPicture' in window,
    hasNotifications: 'Notification' in window,
    coarse: mq('(pointer: coarse)'),
    hasWebGL2() {
      if (webgl2 === null) {
        try {
          const gl = document.createElement('canvas').getContext('webgl2');
          webgl2 = !!gl;
          const lose = gl && gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        } catch (e) { webgl2 = false; }
      }
      return webgl2;
    },
    reducedMotionSystem() { return mq('(prefers-reduced-motion: reduce)'); },
    narrow() { return window.innerWidth < 640; },
  };
})();
