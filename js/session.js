/*!
 * Focus Tracker — js/session.js  (SPEC.md §4.4 · FT.Session)
 * Session lifecycle (modes, rounds, breaks, pauses), the deterministic 1 Hz timeline recorder,
 * live stats, persistence (records, history index, drafts, quota trimming), history aggregation,
 * export / import / erase, and session naming (diagnosis, label).
 * Classic script, loaded with `defer` after core.js. Depends only on core.js and never references
 * FT.Detector: it listens to the detector's bus events (§4.2) instead.
 */
(function () {
  'use strict';
  const FT = window.FT, U = FT.util;
  const LOG = '[Focus:session]';

  /* =================================================================== *
   * 0. Constants                                                         *
   * =================================================================== */
  const SAVE_MIN_ACTIVE_MS = 30000;     // §2.4.8: sessions under 30 s of active time are not saved
  const DRAFT_EVERY_MS = 15000;         // §4.4.6: draft checkpoint cadence (wall time)
  const AUTO_PAUSE_ABSENT_MS = 30000;   // §4.4.6: auto-pause after 30 s absent
  const AUTO_RESUME_MS = 1500;          // §4.4.6: auto-resume after 1.5 s focused/drifting
  const SAMPLE_STALE_MS = 2000;         // currentCode(): 'N' when no sample arrived for 2 s
  const FORGIVE_WINDOW_MS = 300000;     // forgiveLast(): episode open or ended < 5 min ago
  const STEP_CAP_MS = 2000;             // §4.4.6 step 1
  const GAP_UNSEEN_MS = 3000;           // §4.4.6 step 2: gap logged as unseen
  const GAP_PAUSED_MS = 60000;          // §4.4.6 step 2: gap treated as a pause (sleep)
  const TIMER_F = 0.7;                  // F used for 'M' (timer-only) records
  const DEFAULT_F = 0.75;               // SPEC-GAP: F used for 'N' before any sample has ever arrived
  const DECAY_AWAY = Math.exp(-1 / 30); // depth decay per away second
  const DECAY_REST = Math.exp(-1 / 120);// depth decay per E / A second
  const EYE_REST_MS = 20000;            // break: 20 s of looking away = rested eyes
  const MILESTONES_SEC = [600, 1500, 3000, 4500, 6000];
  const MILESTONE_EVERY_SEC = 1500;     // SPEC-GAP: the catalogue says "10|25|50|75|100…"; after 100 min continue every 25 min
  const HISTORY_DAYS = 84, COMPASS_DAYS = 7, RECOVERY_WEEKS = 8;
  const QUOTA_TRIES = 20;

  const MODES = ['free', 'pomodoro', 'deep', 'custom'];
  const SENSITIVITIES = ['gentle', 'standard', 'strict'];
  const SOURCES = ['camera', 'sim', 'none'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  /* =================================================================== *
   * 1. Settings (§4.4.5) with the §3.4 ranges                            *
   * =================================================================== */
  function defaultSettings() {
    return {
      v: 1, onboarded: false, cameraGranted: false, lastIntention: '',
      mode: 'pomodoro',
      pomodoro: { workMin: 25, breakMin: 5, longBreakMin: 15, rounds: 4 },
      custom: { workMin: 45, breakMin: 10, rounds: 1 },
      sensitivity: 'standard', deskOk: false, eyesClosedOk: false, strictTab: false, autoPause: true,
      autoNext: true, recenterAfterBreak: true, goalMin: 50,
      sound: false, soundscape: true, chimes: true, volume: 0.6, nudgeSound: true,
      notify: false, liveTitle: true, forgiveToast: true,
      motion: 'system', eyeMode: 'mesh', fadeChrome: true, deviceId: null,
    };
  }

  const BOOL_KEYS = [
    'onboarded', 'cameraGranted', 'deskOk', 'eyesClosedOk', 'strictTab', 'autoPause', 'autoNext',
    'recenterAfterBreak', 'sound', 'soundscape', 'chimes', 'nudgeSound', 'notify', 'liveTitle',
    'forgiveToast', 'fadeChrome',
  ];
  const ENUM_KEYS = {
    mode: MODES,
    sensitivity: SENSITIVITIES,
    motion: ['system', 'reduced', 'full'],
    eyeMode: ['mesh', 'video', 'off'],
  };
  // [min, max, step]
  const NUM_KEYS = { goalMin: [10, 600, 5], volume: [0, 1, 0.05] };
  const NESTED_KEYS = {
    pomodoro: { workMin: [5, 90, 1], breakMin: [1, 30, 1], longBreakMin: [5, 60, 1], rounds: [1, 8, 1] },
    custom: { workMin: [1, 180, 1], breakMin: [0, 60, 1], rounds: [1, 8, 1] }, // the Setup ranges
  };

  /** Coerce + round to step + clamp. Invalid input keeps `fallback`. */
  function clampNum(v, spec, fallback) {
    if (v == null || typeof v === 'boolean' || (typeof v === 'string' && v.trim() === '')) return fallback;
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    const step = spec[2];
    let x = step ? Math.round(n / step) * step : n;
    x = U.clamp(x, spec[0], spec[1]);
    return +x.toFixed(4);
  }
  function toBool(v) {
    if (typeof v === 'string') return v === 'true' || v === '1' || v === 'on';
    return !!v;
  }

  /** Applies a partial settings object onto `target` in place. Returns the changed top-level keys. */
  function applyPatch(target, partial) {
    const changed = [];
    if (!partial || typeof partial !== 'object') return changed;
    for (const key of Object.keys(partial)) {
      if (key === 'v') continue;
      const val = partial[key];
      let next;
      if (BOOL_KEYS.indexOf(key) >= 0) {
        if (val == null) continue;
        next = toBool(val);
      } else if (ENUM_KEYS[key]) {
        if (ENUM_KEYS[key].indexOf(val) < 0) continue;
        next = val;
      } else if (NUM_KEYS[key]) {
        next = clampNum(val, NUM_KEYS[key], target[key]);
      } else if (NESTED_KEYS[key]) {
        if (!val || typeof val !== 'object') continue;
        const spec = NESTED_KEYS[key], cur = target[key];
        const merged = Object.assign({}, cur);
        for (const sub of Object.keys(spec)) {
          if (Object.prototype.hasOwnProperty.call(val, sub)) merged[sub] = clampNum(val[sub], spec[sub], cur[sub]);
        }
        let diff = false;
        for (const sub of Object.keys(spec)) if (merged[sub] !== cur[sub]) diff = true;
        if (diff) { target[key] = merged; changed.push(key); }
        continue;
      } else if (key === 'lastIntention') {
        next = String(val == null ? '' : val).slice(0, 80);
      } else if (key === 'deviceId') {
        // SPEC-GAP: the "Default camera" option has value "" → stored as null.
        next = typeof val === 'string' && val ? val : null;
      } else {
        continue; // unknown keys are ignored
      }
      if (next !== target[key]) { target[key] = next; changed.push(key); }
    }
    return changed;
  }

  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const numOrNull = (x) => (x == null || !isFinite(x) ? null : +x);

  /* =================================================================== *
   * 2. Persistent state + storage plumbing (§4.4.8)                      *
   * =================================================================== */
  let loaded = false, storeListening = false, subscribed = false;
  let settings = defaultSettings();
  let hadLocalSettings = false;
  let meta = { v: 1, nextNo: 1, created: 0 };
  let items = []; // SessionSummary[], newest first

  let lastStoreError = null; // the most recent store:error payload (set synchronously by core)
  let persistDepth = 0;      // > 0 while Session itself is writing (its own retry loop handles quota)

  /** Versioning hook (§4.4.8). v1 is the only version: identity. */
  function migrate(key, value) { return value; }

  /** Reads a versioned value. Missing → null. Unknown version → null + warning, value left untouched. */
  function readVersioned(key) {
    const raw = FT.store.get(key, null);
    if (raw == null) return null;
    let v = raw;
    try { v = migrate(key, raw); } catch (e) { v = null; }
    if (!v || typeof v !== 'object' || v.v !== 1) {
      console.warn(LOG, 'Ignoring stored "' + key + '": unknown version', raw && raw.v);
      return null;
    }
    return v;
  }

  function ensureStoreListener() {
    if (storeListening) return;
    storeListening = true;
    FT.bus.on('store:error', onStoreError);
  }

  /**
   * FT.store.set with quota handling (§4.4.6 "Quota failures"): on a quota error, archive the timeline of
   * the oldest specimen that still has one and retry, at most 20 times. Returns true when persisted to
   * localStorage (the value is always kept in core's in-memory map either way).
   */
  function persist(key, value, protectId) {
    ensureStoreListener();
    persistDepth++;
    try {
      for (let attempt = 0; attempt <= QUOTA_TRIES; attempt++) {
        lastStoreError = null;
        if (FT.store.set(key, value)) return true;
        if (!FT.store.available) return false;           // private mode: memory only
        const err = lastStoreError;
        if (!err || !err.quota) return false;
        if (attempt === QUOTA_TRIES || !trimOldestTimeline(protectId)) return false;
      }
      return false;
    } finally {
      persistDepth--;
    }
  }

  /** Deletes the timeline of the oldest stored record that still has one. Returns false if none is left. */
  function trimOldestTimeline(protectId) {
    persistDepth++;
    try {
      for (let i = items.length - 1; i >= 0; i--) {
        const s = items[i];
        if (!s || s.hasTimeline === false || s.id === protectId || (rec && s.id === rec.id && isActive())) continue;
        const key = 'session.' + s.id;
        const full = FT.store.get(key, null);
        s.hasTimeline = false;
        if (full && typeof full === 'object') {
          delete full.timeline;
          full.hasTimeline = false;
          FT.store.set(key, full);
        }
        FT.store.set('sessions', { v: 1, items: items });
        console.warn(LOG, 'Storage is full: archived the timeline of session #' + s.no + '.');
        return true;
      }
      return false;
    } finally {
      persistDepth--;
    }
  }

  function onStoreError(e) {
    lastStoreError = e || null;
    if (!e || !e.quota || persistDepth > 0) return;
    // Another module's write (e.g. the calibration) hit the quota: free space for the next write.
    trimOldestTimeline(rec && isActive() ? rec.id : null);
  }

  function validSummary(s) {
    return !!s && typeof s === 'object' && typeof s.id === 'string' && !!s.id && isFinite(s.startedAt);
  }
  function sortItems() { items.sort((a, b) => (+b.startedAt || 0) - (+a.startedAt || 0)); }

  /** When the index is missing but records exist (e.g. an index write was lost), rebuild it. */
  function rebuildIndex() {
    const out = [];
    let keys = [];
    try { keys = FT.store.keys(); } catch (e) { keys = []; }
    for (const k of keys) {
      if (k.indexOf('session.') !== 0) continue;
      const r = readVersioned(k);
      if (r && typeof r.id === 'string' && isFinite(r.startedAt)) out.push(summaryOf(r));
    }
    if (out.length) {
      out.sort((a, b) => b.startedAt - a.startedAt);
      console.warn(LOG, 'Rebuilt the history index from ' + out.length + ' stored sessions.');
      FT.store.set('sessions', { v: 1, items: out });
    }
    return out;
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    ensureStoreListener();

    // Settings: defaults, overlaid with a valid stored copy (sanitised through the same rules).
    hadLocalSettings = FT.store.get('settings', null) != null;
    settings = defaultSettings();
    const s = readVersioned('settings');
    if (s) applyPatch(settings, s);

    // Meta.
    const rawMeta = FT.store.get('meta', null);
    const m = readVersioned('meta');
    if (m && isFinite(m.nextNo)) {
      meta = { v: 1, nextNo: Math.max(1, Math.floor(m.nextNo)), created: isFinite(m.created) ? +m.created : Date.now() };
    } else {
      meta = { v: 1, nextNo: 1, created: Date.now() };
      if (rawMeta == null) persist('meta', meta); // never overwrite an unknown version on load
    }

    // History index.
    const idx = readVersioned('sessions');
    if (idx && Array.isArray(idx.items)) items = idx.items.filter(validSummary);
    else if (FT.store.get('sessions', null) == null) items = rebuildIndex();
    else items = []; // SPEC-GAP: an unknown-version index is left untouched until the next save
    sortItems();

    // The next specimen number must exceed every stored one.
    let maxNo = 0;
    for (const it of items) maxNo = Math.max(maxNo, +it.no || 0);
    if (meta.nextNo <= maxNo) { meta.nextNo = maxNo + 1; persist('meta', meta); }
  }

  /* =================================================================== *
   * 3. Live session state                                                *
   * =================================================================== */
  let phase = 'idle', prevPhase = null, pauseReason = null, resumeTo = null;
  let rec = null;            // the current (or last) SessionRecord
  let cfg = null;            // normalised SessionConfig of the current/last session
  let source = null;         // live source ('camera' | 'sim' | 'none')
  let round = 0, rounds = null;
  let workMs = null;         // work interval length in timed modes, null in free mode
  let phaseElapsed = 0;      // elapsed work in the current interval (frozen during breaks)
  let breakKind = null;      // 'scheduled' | 'adhoc' | null
  let breakElapsed = 0, breakTotal = 0, lookAwayMs = 0, breakAbsentMs = 0;
  let pauseMsThis = 0;       // length of the current pause (for its 'P' gap mark)
  let resumedAt = 0;         // performance.now() of the last entry into 'running'
  let bucket = newBucket();  // the second in progress
  let D = 0;                 // depth, unquantised
  let lastRec = null;        // {code, f} of the last finalised second
  let analysis = null;       // FT.analyze(rec.timeline), refreshed per second
  let milestonesDone = new Set();
  let forgiving = false;     // an open episode was forgiven: keep writing 'K' until the drift ends
  let forgiveRanges = [];    // [{t0, t1, cause, angle}] episodes forgiven in this session
  let hourlyIdx = new Map(); // 'YYYY-MM-DD|h' -> hourly entry of rec.hourly
  let counters = newCounters();
  let lastDraftWall = 0, draftRetryAt = 0;
  let live = null, liveDirty = true;

  // Mirror of the detector, fed by bus events only.
  const det = { sample: null, lastSampleAt: -Infinity, state: null, cause: null, stateSince: 0, goodSince: null, f: null };

  function newBucket() { return { ms: {}, seen: {}, seq: 0, total: 0, fSum: 0, vx: 0, vy: 0 }; }
  function newCounters() {
    return { blinks: 0, presentMs: 0, perclosPeak: null, drowsyFlags: 0, yawns: 0, breaksTaken: 0, eyeRests: 0, trueBreaks: 0, blinkPerMin: [] };
  }
  function countersFrom(c, st) {
    const out = newCounters();
    const src = c && typeof c === 'object' ? c : (st && typeof st === 'object' ? st : {});
    for (const k of ['blinks', 'presentMs', 'drowsyFlags', 'yawns', 'breaksTaken', 'eyeRests', 'trueBreaks']) out[k] = Math.max(0, +src[k] || 0);
    out.perclosPeak = numOrNull(src.perclosPeak);
    out.blinkPerMin = Array.isArray(src.blinkPerMin) ? src.blinkPerMin.map((x) => Math.max(0, +x || 0)) : [];
    return out;
  }

  const isActive = () => phase === 'running' || phase === 'paused' || phase === 'break';
  const tlLen = () => (rec && rec.timeline ? rec.timeline.s.length : 0);
  const inBreakNow = () => phase === 'break' || (phase === 'paused' && resumeTo === 'break');

  function setPhase(next, reason) {
    prevPhase = phase;
    phase = next;
    if (next !== 'paused') pauseReason = null;
    if (next === 'running') resumedAt = performance.now();
    liveDirty = true;
    refreshLive();
    FT.bus.emit('session:phase', {
      phase: next, prev: prevPhase, reason: reason, round: round, rounds: rounds,
      mode: rec ? rec.mode : null,
      // optional extras
      pauseReason: next === 'paused' ? pauseReason : null,
      breakKind: next === 'break' ? breakKind : null,
      breakTotalMs: next === 'break' ? breakTotal : null,
    });
  }

  /* =================================================================== *
   * 4. Recording algorithm (§4.4.6)                                      *
   * =================================================================== */
  function sampleFresh(now) { return det.sample !== null && now - det.lastSampleAt <= SAMPLE_STALE_MS; }
  function lastKnownF() { return det.f != null ? det.f : DEFAULT_F; }

  function currentCode() {
    if (source === 'none') return 'M';
    const now = performance.now();
    if (!sampleFresh(now)) return 'N';
    const st = det.state;
    if (!st || st === 'unseen' || st === 'calibrating') return 'N';
    return FT.codeFor(st, det.cause);
  }

  function lookingAway() {
    if (source === 'none' || !sampleFresh(performance.now())) return false;
    const st = det.state;
    if (st === 'away' || st === 'eyes-closed' || st === 'absent') return true;
    return !!(det.sample && det.sample.offScreen);
  }

  function addToBucket(code, F, ang, ms) {
    bucket.ms[code] = (bucket.ms[code] || 0) + ms;
    bucket.seen[code] = ++bucket.seq;
    bucket.total += ms;
    bucket.fSum += F * ms;
    if (ang !== null) { bucket.vx += Math.cos(ang) * ms; bucket.vy += Math.sin(ang) * ms; }
  }

  function accumulate(step) {
    const code = currentCode();
    const info = FT.CODES[code];
    const F = code === 'M' ? TIMER_F : lastKnownF(); // 'N' uses the last known F
    const smp = det.sample;
    const ang = info.away && smp && smp.angle != null && isFinite(smp.angle) ? +smp.angle : null;

    // Split the step at second boundaries so each second's bucket gets exactly its share.
    // In timed modes the work interval ends exactly on time (the < 1 tick overshoot is dropped).
    let remaining = workMs != null ? Math.min(step, Math.max(0, workMs - phaseElapsed)) : step;
    let guard = 0;
    while (remaining > 1e-9 && phase === 'running' && guard++ < 16) {
      const room = (tlLen() + 1) * 1000 - rec.activeMs;
      if (room <= 1e-6) { finalizeSecond(); continue; }
      const chunk = Math.min(remaining, room);
      addToBucket(code, F, ang, chunk);
      rec.activeMs += chunk;
      phaseElapsed += chunk;
      remaining -= chunk;
      if (rec.activeMs >= (tlLen() + 1) * 1000 - 1e-6) finalizeSecond();
    }
    if (phase !== 'running') return;

    if (workMs != null && phaseElapsed >= workMs - 1e-6) { // epsilon: the capped chunks may sum a hair short
      endWorkInterval();
      if (phase !== 'running') return;
    }

    // Auto-pause: absent for 30 s (measured from the later of the state start and the last resume).
    if (settings.autoPause && source !== 'none' && det.state === 'absent') {
      const now = performance.now();
      if (sampleFresh(now) && now - Math.max(det.stateSince, resumedAt) >= AUTO_PAUSE_ABSENT_MS) pause('away');
    }
  }

  function finalizeSecond() {
    let code = null, f = NaN;
    if (bucket.total > 0) {
      let best = -1, bestSeen = -1;
      for (const c in bucket.ms) {
        const ms = bucket.ms[c], seen = bucket.seen[c] || 0;
        if (ms > best || (ms === best && seen > bestSeen)) { best = ms; bestSeen = seen; code = c; }
      }
      f = bucket.fSum / bucket.total;
    }
    if (code === null) { // an empty bucket repeats the previous record
      code = lastRec ? lastRec.code : currentCode();
      f = lastRec ? lastRec.f : lastKnownF();
    }
    if (forgiving) {
      const inf = FT.CODES[code];
      if (inf.away || code === 'E') code = 'K';
      else if (code !== 'N') forgiving = false; // the forgiven drift has ended
    }
    let aChar = '.';
    if ((FT.CODES[code].away || code === 'K') && (bucket.vx !== 0 || bucket.vy !== 0)) {
      aChar = FT.codec.angle(Math.atan2(bucket.vy, bucket.vx));
    }
    bucket = newBucket();
    appendRecord(code, f, aChar);
  }

  function updateDepth(code, f) {
    const info = FT.CODES[code];
    if (info.held) D = Math.min(1, D + f / 1500);
    else if (info.away) D *= DECAY_AWAY;
    else if (code === 'E' || code === 'A') D *= DECAY_REST;
    // 'N': unchanged
  }

  /** Appends one active second and emits everything that follows from it (§4.4.6 finalizeSecond 3–9). */
  function appendRecord(code, f, aChar) {
    f = U.clamp01(isFinite(f) ? f : lastKnownF());
    updateDepth(code, f);
    const tl = rec.timeline;
    const index = tl.s.length;
    const fCh = FT.codec.level(f), dCh = FT.codec.level(D);
    tl.s += code; tl.f += fCh; tl.d += dCh; tl.a += aChar;
    lastRec = { code: code, f: f };
    if (FT.CODES[code].held) addHourly(1000);

    const prev = analysis;
    analysis = FT.analyze(tl);
    diffEpisodes(prev, analysis);
    checkMilestones(analysis);
    liveDirty = true;

    FT.bus.emit('session:second', {
      index: index, s: code, f: FT.codec.unlevel(fCh), d: FT.codec.unlevel(dCh), a: FT.codec.unangle(aChar),
    });
  }

  /** Wall-clock gap of 3–60 s while running: unobserved seconds, never distraction. */
  function fillUnseen(k) {
    const f = lastRec ? lastRec.f : lastKnownF(); // carry f (and, since 'N' leaves it, d) forward
    let added = 0;
    for (let i = 0; i < k && phase === 'running'; i++) { appendRecord('N', f, '.'); added++; }
    rec.activeMs += added * 1000;
    // SPEC-GAP: the unseen seconds are active time, so they also advance the work interval.
    phaseElapsed += added * 1000;
    if (workMs != null && phaseElapsed >= workMs - 1e-6 && phase === 'running') endWorkInterval();
  }

  function addHourly(ms) {
    if (!rec) return;
    const d = new Date(Date.now());
    const day = U.dayKey(d), hour = d.getHours(), key = day + '|' + hour;
    let entry = hourlyIdx.get(key);
    if (!entry) {
      entry = [day, hour, 0];
      hourlyIdx.set(key, entry);
      rec.hourly.push(entry);
    }
    entry[2] += ms;
  }

  function episodeOut(e) {
    return { t0: e.t0, t1: e.t1, dur: e.dur, cause: e.cause, angle: e.angle, mended: !!e.mended, mendAt: e.mendAt == null ? null : e.mendAt };
  }
  function emitEpisode(type, e) { FT.bus.emit('session:episode', { type: type, episode: episodeOut(e) }); }

  function diffEpisodes(prev, next) {
    const before = new Map();
    if (prev) for (const e of prev.episodes) before.set(e.t0, e);
    for (const e of next.episodes) {
      const p = before.get(e.t0);
      if (!p) {
        emitEpisode('start', e);
        if (e.t1 !== null) emitEpisode('end', e);
        if (e.mended) emitEpisode('mended', e);
        continue;
      }
      if (p.t1 === null && e.t1 !== null) emitEpisode('end', e);
      if (!p.mended && e.mended) emitEpisode('mended', e);
    }
  }

  function checkMilestones(an) {
    const cur = an.currentStreak;
    if (cur < MILESTONES_SEC[0]) return;
    const list = MILESTONES_SEC.slice();
    for (let t = MILESTONES_SEC[MILESTONES_SEC.length - 1] + MILESTONE_EVERY_SEC; t <= cur; t += MILESTONE_EVERY_SEC) list.push(t);
    let hit = 0;
    for (const th of list) {
      if (cur >= th && !milestonesDone.has(th)) { milestonesDone.add(th); hit = th; }
    }
    if (hit) FT.bus.emit('session:milestone', { kind: 'streak', minutes: Math.round(hit / 60) });
  }

  function breakMinAfter(k) {
    if (!cfg || cfg.rounds == null || k >= cfg.rounds) return 0;
    return cfg.longEvery > 0 && k % cfg.longEvery === 0 ? cfg.longBreakMin : cfg.breakMin;
  }

  function endWorkInterval() {
    if (workMs == null || rounds == null) return;
    if (round < rounds) {
      const bm = breakMinAfter(round);
      if (bm > 0) {
        breakKind = 'scheduled';
        breakTotal = bm * 60000;
        breakElapsed = 0; lookAwayMs = 0; breakAbsentMs = 0;
        setPhase('break', 'interval-end');
      } else {
        round += 1;
        phaseElapsed = 0;
        // SPEC-GAP: a round change without a break still emits session:phase (running → running) so the HUD updates.
        setPhase('running', 'interval-end');
      }
    } else {
      end({ save: true });
    }
  }

  /** how: 'auto' (timer ran out) | 'skip' | 'end' (session ending; no phase change). */
  function endBreak(how) {
    const elapsed = breakElapsed;
    // SPEC-GAP: breaks shorter than 1 s (skipped immediately) leave no mark and aren't counted.
    if (elapsed >= 1000) {
      rec.gaps.push({ at: tlLen(), kind: 'B', ms: Math.round(elapsed) });
      counters.breaksTaken += 1;
      if (lookAwayMs >= EYE_REST_MS) counters.eyeRests += 1;
      if (breakAbsentMs >= 0.6 * elapsed) counters.trueBreaks += 1;
    }
    rec.breakMs += elapsed;
    const scheduled = breakKind === 'scheduled';
    if (scheduled) { round += 1; phaseElapsed = 0; }
    breakKind = null; breakElapsed = 0; breakTotal = 0; lookAwayMs = 0; breakAbsentMs = 0;
    if (how === 'end') return;
    if (how === 'skip' || !scheduled || settings.autoNext) {
      setPhase('running', how === 'skip' ? 'skip' : 'break-end');
    } else {
      // pause('round'): the break is over, so resuming goes back to work.
      resumeTo = 'running';
      pauseReason = 'round';
      pauseMsThis = 0;
      setPhase('paused', 'round');
    }
  }

  function closePauseGap() {
    // SPEC-GAP: pauses are marked as 'P' gaps (summary strip ticks); sub-second pauses leave no mark.
    if (rec && pauseMsThis >= 1000) rec.gaps.push({ at: tlLen(), kind: 'P', ms: Math.round(pauseMsThis) });
    pauseMsThis = 0;
  }

  function tickBreak(step) {
    breakElapsed += step;
    if (lookingAway()) lookAwayMs += step;
    if (source !== 'none' && det.state === 'absent' && sampleFresh(performance.now())) breakAbsentMs += step;
    if (breakElapsed >= breakTotal) endBreak('auto');
  }

  function tickPaused(step) {
    rec.pausedMs += step;
    pauseMsThis += step;
    if (pauseReason === 'away' && source !== 'none' && det.goodSince !== null &&
        (det.state === 'focused' || det.state === 'drifting')) {
      const now = performance.now();
      if (sampleFresh(now) && now - det.goodSince >= AUTO_RESUME_MS) doResume('returned');
    }
  }

  function onTick(e) {
    if (!rec || !isActive()) return; // nothing (and no session:tick) while idle or complete
    const dt = Math.max(0, +(e && e.dt) || 0), dtWall = Math.max(0, +(e && e.dtWall) || 0);
    const step = Math.min(dt, STEP_CAP_MS);
    const gap = Math.max(dt, dtWall) - step;

    if (gap > GAP_PAUSED_MS && (phase === 'running' || phase === 'break')) {
      rec.gaps.push({ at: tlLen(), kind: 'P', ms: Math.round(gap) });
      rec.pausedMs += gap;
      FT.bus.emit('session:gap', { ms: Math.round(gap), treatedAs: 'paused' });
    } else if (gap > GAP_UNSEEN_MS && phase === 'running') {
      fillUnseen(Math.floor(gap / 1000));
      FT.bus.emit('session:gap', { ms: Math.round(gap), treatedAs: 'unseen' });
    } else if (gap > 0 && phase === 'paused') {
      rec.pausedMs += gap; // any gap while paused is simply more pause
      pauseMsThis += gap;
    } else if (gap > GAP_UNSEEN_MS && phase === 'break') {
      breakElapsed += gap; // SPEC-GAP: a break is wall time, so a short frozen-tab gap still counts toward it
    }
    if (!isActive()) return;

    if (phase === 'running') accumulate(step);
    else if (phase === 'break') tickBreak(step);
    else if (phase === 'paused') tickPaused(step);
    if (!isActive()) return;

    const wall = Date.now();
    if (wall - lastDraftWall >= DRAFT_EVERY_MS) checkpoint(wall);

    refreshLive();
    FT.bus.emit('session:tick', live);
  }

  /* =================================================================== *
   * 5. Detector listeners                                                *
   * =================================================================== */
  function noteState(state, cause, t) {
    if (state !== det.state) {
      det.stateSince = t;
      const good = state === 'focused' || state === 'drifting';
      const wasGood = det.state === 'focused' || det.state === 'drifting';
      if (good && !wasGood) det.goodSince = t;
      else if (!good) det.goodSince = null;
    }
    det.state = state;
    det.cause = cause;
  }

  function onSample(s) {
    if (!s || typeof s !== 'object') return;
    const now = performance.now();
    det.sample = s;
    det.lastSampleAt = now;
    if (typeof s.focus === 'number' && isFinite(s.focus)) det.f = U.clamp01(s.focus);
    if (typeof s.state === 'string' && s.state) {
      const since = typeof s.stateSince === 'number' && isFinite(s.stateSince) ? s.stateSince : now;
      noteState(s.state, s.cause || null, since);
      if (typeof s.stateSince === 'number' && isFinite(s.stateSince)) det.stateSince = s.stateSince;
      if ((s.state === 'focused' || s.state === 'drifting') && det.goodSince === null) det.goodSince = since;
    }
    if (phase === 'running' && source !== 'none') {
      if (s.present) counters.presentMs += U.clamp(+s.dt || 0, 0, 1000);
      if (s.perclos != null && isFinite(s.perclos)) {
        counters.perclosPeak = counters.perclosPeak == null ? +s.perclos : Math.max(counters.perclosPeak, +s.perclos);
      }
    }
  }

  function onState(e) {
    if (!e || typeof e.state !== 'string') return;
    noteState(e.state, e.cause || null, typeof e.t === 'number' && isFinite(e.t) ? e.t : performance.now());
    liveDirty = true;
  }

  function onBlink() {
    if (phase !== 'running' || !rec || source === 'none') return;
    counters.blinks += 1;
    const idx = Math.floor(rec.activeMs / 60000);
    while (counters.blinkPerMin.length <= idx) counters.blinkPerMin.push(0);
    counters.blinkPerMin[idx] += 1;
  }

  function onYawn() {
    if (isActive() && source !== 'none') counters.yawns += 1;
  }

  function onDrowsy(e) {
    if (phase === 'running' && source !== 'none' && e && e.active) counters.drowsyFlags += 1;
  }

  function onPageHide() { if (isActive()) checkpoint(Date.now()); }
  function onVisibility() { if (document.hidden && isActive()) checkpoint(Date.now()); }

  /* =================================================================== *
   * 6. Stats, naming, label (§4.4.4, §4.4.9, §2.4.8)                     *
   * =================================================================== */
  function buildStats(an, c) {
    c = c || newCounters();
    const ms = (x) => (x == null ? null : x * 1000);
    const byCauseMs = {};
    for (const k of FT.CAUSES) byCauseMs[k] = (an.byCauseSec[k] || 0) * 1000;
    return {
      heldMs: an.heldSec * 1000,
      focusPct: an.focusPct,
      longestStreakMs: an.longestStreak * 1000,
      timeToRootMs: ms(an.timeToRoot),
      distractions: an.distractions,
      returns: an.returns,
      mended: an.mended,
      forgiven: an.forgiven.length,
      steppedAway: an.steppedAway,
      byCause: Object.assign({}, an.byCause),
      byCauseMs: byCauseMs,
      dirs: an.dirs.slice(),
      medianRecoveryMs: ms(an.medianRecovery),
      peakDepth: an.peakDepth,
      blinkRate: c.presentMs >= 60000 ? Math.round((c.blinks / (c.presentMs / 60000)) * 10) / 10 : null,
      blinkPerMin: c.blinkPerMin.slice(),
      perclosPeak: c.perclosPeak,
      drowsyFlags: c.drowsyFlags,
      yawns: c.yawns,
      breaksTaken: c.breaksTaken,
      eyeRests: c.eyeRests,
      trueBreaks: c.trueBreaks,
      unseenMs: an.unseenSec * 1000,
      unmeasuredMs: an.unmeasuredSec * 1000,
      absentMs: an.absentSec * 1000,
      // optional extras
      blinks: c.blinks,
      presentMs: Math.round(c.presentMs),
    };
  }

  function speciesFor(r) {
    const st = (r && r.stats) || {};
    const bc = st.byCause || {};
    const fp = st.focusPct;
    const m = +st.distractions || 0;
    if ((+r.activeMs || 0) < 600000) return 'nascens';
    if (fp == null || !isFinite(fp)) return 'horologica';
    if ((+st.drowsyFlags || 0) >= 1 || (+bc.eyes || 0) >= 2) return 'somnians';
    if ((+st.peakDepth || 0) >= 0.9 && (+st.longestStreakMs || 0) >= 1500000) return 'profunda';
    if (fp >= 0.85) return 'lucida';
    if ((+st.returns || 0) >= 5 && fp >= 0.6) return 'tenax';
    if (m >= 4 && (+bc.glance || 0) + (+bc.turned || 0) >= 0.6 * m) return 'vagans';
    return 'communis';
  }

  function varietyFor(intention, startedAt) {
    const txt = String(intention == null ? '' : intention).trim();
    if (txt) return 'var. "' + U.truncate(txt.toLowerCase(), 28) + '"';
    const d = new Date(isFinite(startedAt) ? +startedAt : Date.now());
    const h = d.getHours();
    const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night';
    return 'var. "' + WEEKDAYS[d.getDay()] + ' ' + part + '"';
  }

  function diagnosisFor(st) {
    st = st || {};
    const fp = st.focusPct;
    if (fp == null || !isFinite(fp)) return 'Timer only. Nothing was measured, but the time was yours.';
    const m = +st.distractions || 0;
    if (m === 0) return fp >= 0.9 ? 'No distractions. Solid focus the whole way through.' : 'No distractions, just a little drifting at the edges.';
    const bc = st.byCause || {};
    let top = FT.CAUSES[0], n = -1;
    for (const c of FT.CAUSES) {
      const v = +bc[c] || 0;
      if (v > n) { n = v; top = c; } // strict '>' keeps the earlier cause on ties
    }
    const s = (k) => (k === 1 ? '' : 's');
    let text;
    switch (top) {
      case 'down':
        text = n + ' of ' + m + ' drifts pulled your gaze down. Phone within reach?';
        break;
      case 'turned': {
        const d = Array.isArray(st.dirs) ? st.dirs : [];
        const left = (+d[3] || 0) + (+d[4] || 0) + (+d[5] || 0);
        const right = (+d[7] || 0) + (+d[0] || 0) + (+d[1] || 0);
        const side = left > right ? 'left' : left < right ? 'right' : 'away';
        text = n + ' of ' + m + ' drifts turned you ' + side + '. Something over there?';
        break;
      }
      case 'glance':
        text = 'Mostly quick glances (' + n + ' of ' + m + '). Fewer open tabs may help.';
        break;
      case 'up':
        text = n + ' of ' + m + ' drifts looked up. Thinking, or a second screen?';
        break;
      case 'tab':
        text = 'Other tabs pulled you away ' + n + ' time' + s(n) + '.';
        break;
      default:
        text = 'Your eyes grew heavy ' + n + ' time' + s(n) + '. Water, light, or a walk may help.';
    }
    const ret = +st.returns || 0;
    if (ret === m) text += ' You came back every time (median ' + U.fmtDuration(st.medianRecoveryMs) + ').';
    else if (ret > 0) text += ' You came back ' + ret + ' time' + s(ret) + '.';
    return text;
  }

  /** Timeline → episodes, streaks, stats; then species, name, variety, diagnosis. Returns the analysis (or null). */
  function finalizeRecord(r, c) {
    let an = null;
    if (r.timeline && typeof r.timeline.s === 'string') {
      an = FT.analyze(r.timeline);
      r.episodes = an.episodes.map(episodeOut);
      r.streaks = an.streaks.map((x) => ({ t0: x.t0, t1: x.t1, dur: x.dur }));
      r.stats = buildStats(an, c);
    } else if (!r.stats || typeof r.stats !== 'object') {
      r.stats = buildStats(FT.analyze(null), c);
    }
    r.species = speciesFor(r);
    r.name = FT.sessionTitle(r);
    r.variety = '';
    r.diagnosis = diagnosisFor(r.stats);
    return an;
  }

  /** Keeps the live record's derived fields current (drafts, getRecord()). */
  function syncRecord() {
    if (!rec || !analysis) return;
    rec.episodes = analysis.episodes.map(episodeOut);
    rec.streaks = analysis.streaks.map((x) => ({ t0: x.t0, t1: x.t1, dur: x.dur }));
    rec.stats = buildStats(analysis, counters);
  }

  /** The label rule (§2.4.8). Accepts a SessionRecord or a SessionSummary. Matches keepsake.js's copy. */
  function labelFor(r) {
    if (!r || typeof r !== 'object') return '';
    const st = r.stats && typeof r.stats === 'object' ? r.stats : r;
    const parts = ['#' + Math.max(0, Math.floor(+r.no || 0)), Math.round((+r.activeMs || 0) / 60000) + ' min'];
    const fp = r.source === 'none' ? null : st.focusPct;
    if (fp != null && isFinite(fp)) {
      parts.push(U.fmtPercent(fp) + ' focused');
      const m = Math.max(0, Math.round(+st.distractions || 0));
      parts.push(m === 0 ? 'no distractions' : m === 1 ? '1 distraction' : m + ' distractions');
      const mended = Math.round(+st.mended || 0);
      if (mended > 0) parts.push(mended + ' recovered');
    } else {
      parts.push('timer only');
    }
    return (r.source === 'sim' ? 'DEMO · ' : '') + parts.join(' · ');
  }

  function summaryOf(r) {
    const st = r.stats && typeof r.stats === 'object' ? r.stats : {};
    const hasTl = !!(r.timeline && typeof r.timeline.s === 'string') && r.hasTimeline !== false;
    const dirs = [0, 0, 0, 0, 0, 0, 0, 0];
    if (Array.isArray(st.dirs)) for (let k = 0; k < 8; k++) dirs[k] = +st.dirs[k] || 0;
    const byCause = { down: 0, turned: 0, glance: 0, up: 0, tab: 0, eyes: 0 };
    if (st.byCause && typeof st.byCause === 'object') for (const k of FT.CAUSES) byCause[k] = +st.byCause[k] || 0;
    return {
      v: 1, id: r.id, no: Math.floor(+r.no || 0), seed: (+r.seed || 0) >>> 0,
      name: FT.sessionTitle(r), variety: '', intention: r.intention || '',
      mode: r.mode || 'free', source: r.source || 'camera',
      startedAt: +r.startedAt || 0, endedAt: r.endedAt == null ? null : +r.endedAt,
      activeMs: Math.round(+r.activeMs || 0),
      heldMs: Math.round(+st.heldMs || 0), focusPct: numOrNull(st.focusPct),
      longestStreakMs: Math.round(+st.longestStreakMs || 0),
      distractions: Math.floor(+st.distractions || 0), returns: Math.floor(+st.returns || 0),
      mended: Math.floor(+st.mended || 0), peakDepth: +st.peakDepth || 0,
      dirs: dirs, byCause: byCause, medianRecoveryMs: numOrNull(st.medianRecoveryMs),
      hourly: Array.isArray(r.hourly)
        ? r.hourly.filter(Array.isArray).map((h) => [String(h[0]), Math.floor(+h[1] || 0), Math.round(+h[2] || 0)])
        : [],
      rating: r.rating >= 1 && r.rating <= 5 ? Math.round(r.rating) : null,
      hasTimeline: hasTl,
      // optional extras
      species: r.species || '',
      forgiven: Math.floor(+st.forgiven || 0),
      steppedAway: Math.floor(+st.steppedAway || 0),
      timeToRootMs: numOrNull(st.timeToRootMs),
      demo: r.source === 'sim' || r.demo === true,
    };
  }

  const isDemo = (s) => !!s && (s.source === 'sim' || s.demo === true);

  /** Normalises a record from a draft or an import. Returns false when it is unusable. */
  function repairRecord(r) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) return false;
    const started = Number(r.startedAt);
    if (!isFinite(started) || started <= 0) return false;
    r.v = 1;
    r.startedAt = started;
    r.endedAt = r.endedAt == null || !isFinite(r.endedAt) ? null : +r.endedAt;
    r.no = Math.max(0, Math.floor(+r.no || 0));
    r.seed = r.seed != null && isFinite(r.seed) ? (+r.seed >>> 0) : U.hashString(r.id);
    r.intention = typeof r.intention === 'string' ? r.intention.slice(0, 80) : '';
    if (MODES.indexOf(r.mode) < 0) r.mode = 'free';
    if (SOURCES.indexOf(r.source) < 0 && r.source !== 'mixed') r.source = 'camera';
    if (SENSITIVITIES.indexOf(r.sensitivity) < 0) r.sensitivity = 'standard';
    if (typeof r.retract !== 'boolean') r.retract = r.sensitivity !== 'gentle';
    r.refActiveSec = isFinite(r.refActiveSec) && r.refActiveSec > 0 ? +r.refActiveSec : 3000;
    for (const k of ['activeMs', 'pausedMs', 'breakMs']) r[k] = Math.max(0, +r[k] || 0);
    if (!Array.isArray(r.gaps)) r.gaps = [];
    if (!Array.isArray(r.hourly)) r.hourly = [];
    if (!Array.isArray(r.episodes)) r.episodes = [];
    if (!Array.isArray(r.streaks)) r.streaks = [];
    if (!r.plan || typeof r.plan !== 'object') r.plan = null;
    r.rating = r.rating >= 1 && r.rating <= 5 ? Math.round(r.rating) : null;
    const tl = r.timeline;
    if (tl && typeof tl === 'object' && typeof tl.s === 'string' && r.hasTimeline !== false) {
      const n = tl.s.length;
      const bad = new RegExp('[^' + Object.keys(FT.CODES).join('') + ']', 'g');
      const fit = (str, fill) => {
        str = typeof str === 'string' ? str : '';
        return str.length >= n ? str.slice(0, n) : str + fill.repeat(n - str.length);
      };
      r.timeline = { s: tl.s.replace(bad, 'N'), f: fit(tl.f, FT.codec.level(TIMER_F)), d: fit(tl.d, 'A'), a: fit(tl.a, '.') };
      r.hasTimeline = true;
    } else {
      delete r.timeline;
      r.hasTimeline = false;
    }
    return true;
  }

  /* =================================================================== *
   * 7. Saving, drafts                                                    *
   * =================================================================== */
  function saveRecord(r) {
    ensureLoaded();
    r.no = Math.max(1, Math.floor(meta.nextNo) || 1); // numbers are assigned at save, so they never collide
    if (r.hasTimeline !== false) r.hasTimeline = !!r.timeline;
    persist('session.' + r.id, r, r.id);
    items = items.filter((s) => s.id !== r.id);
    items.unshift(summaryOf(r));
    sortItems();
    persist('sessions', { v: 1, items: items }, r.id);
    meta.nextNo = r.no + 1;
    persist('meta', meta, r.id);
    FT.bus.emit('history:change', { reason: 'saved' });
    return true;
  }

  function checkpoint(wall) {
    if (!rec || !isActive()) return;
    wall = wall || Date.now();
    lastDraftWall = wall;
    if (wall < draftRetryAt) return;
    syncRecord();
    const ok = persist('draft', {
      v: 1, savedAt: wall, phase: phase, record: rec,
      counters: Object.assign({}, counters, { blinkPerMin: counters.blinkPerMin.slice() }), // optional extra
    }, rec.id);
    // SPEC-GAP: when the browser refuses the draft (storage full even after trimming), back off for
    // 5 minutes instead of retrying (and raising store:error toasts) every 15 s.
    if (!ok && FT.store.available) draftRetryAt = wall + 300000;
  }

  function readDraft() {
    const d = readVersioned('draft');
    if (!d || !d.record || typeof d.record !== 'object' || typeof d.record.id !== 'string') return null;
    return d;
  }

  function removeDraft() { FT.store.remove('draft'); }

  function getDraft() {
    ensureLoaded();
    const d = readDraft();
    if (!d) return null;
    const r = d.record;
    if (rec && isActive() && r.id === rec.id) return null; // our own live checkpoint
    if (items.some((s) => s.id === r.id)) { removeDraft(); return null; } // already saved
    // SPEC-GAP: a draft too short to save (< 30 s active) is dropped instead of offered.
    if (!(+r.activeMs >= SAVE_MIN_ACTIVE_MS)) { removeDraft(); return null; }
    return { startedAt: +r.startedAt || null, activeMs: +r.activeMs || 0, intention: r.intention || '', savedAt: +d.savedAt || null, id: r.id };
  }

  function recoverDraft() {
    ensureLoaded();
    const d = readDraft();
    if (!d) return null;
    const r = d.record;
    if (rec && isActive() && r.id === rec.id) return null;
    if (items.some((s) => s.id === r.id)) { removeDraft(); return load(r.id); }
    if (!repairRecord(r)) { removeDraft(); return null; }
    r.activeMs = Math.round(r.activeMs);
    r.pausedMs = Math.round(r.pausedMs);
    r.breakMs = Math.round(r.breakMs);
    finalizeRecord(r, countersFrom(d.counters, r.stats));
    r.endedAt = isFinite(d.savedAt) ? +d.savedAt : Date.now();
    if (r.activeMs < SAVE_MIN_ACTIVE_MS) { removeDraft(); return null; }
    saveRecord(r);
    removeDraft();
    return r;
  }

  function discardDraft() {
    const d = readDraft();
    if (d && rec && isActive() && d.record.id === rec.id) return false; // never drop the live checkpoint
    removeDraft();
    return true;
  }

  /* =================================================================== *
   * 8. Live stats (§4.4.3)                                               *
   * =================================================================== */
  function idleLive() {
    return {
      phase: 'idle', prevPhase: prevPhase, pauseReason: null,
      mode: settings.mode, intention: '', source: null, measured: false,
      round: 0, rounds: null,
      activeMs: 0,
      phaseElapsedMs: 0, phaseTotalMs: null, phaseRemainingMs: null,
      sessionRemainingMs: null,
      progress: 0, rimProgress: null,
      depth: 0, focus: null,
      state: 'none', cause: null, word: FT.PHASE_WORDS.idle,
      heldMs: 0, focusPct: null, streakMs: 0, longestStreakMs: 0,
      distractions: 0, returns: 0, mended: 0, forgiven: 0, steppedAway: 0,
      medianRecoveryMs: null,
      lastEpisode: null,
      blinkRate: null, drowsyFlags: 0, perclosPeak: null,
      timeToRootMs: null,
      breakLookAwayMs: 0, breakEyeRested: false,
    };
  }

  function sessionRemaining() {
    if (workMs == null || rounds == null) return null;
    const brk = inBreakNow();
    let rem = 0;
    if (brk) rem += Math.max(0, breakTotal - breakElapsed);
    if (!(brk && breakKind === 'scheduled')) {
      rem += Math.max(0, workMs - phaseElapsed);
      rem += breakMinAfter(round) * 60000;
    }
    for (let r = round + 1; r <= rounds; r++) rem += workMs + breakMinAfter(r) * 60000;
    return rem;
  }

  function findForgiveRange(t0) {
    let best = null;
    for (const fr of forgiveRanges) if (fr.t0 <= t0 && (!best || fr.t0 >= best.t0)) best = fr;
    return best;
  }

  function lastEpisodeInfo(an) {
    const ep = an.episodes.length ? an.episodes[an.episodes.length - 1] : null;
    const fr = an.forgiven.length ? an.forgiven[an.forgiven.length - 1] : null;
    const ago = (t1) => (t1 == null ? null : Math.max(0, rec.activeMs - t1 * 1000));
    if (fr && (!ep || fr.t0 > ep.t0)) {
      const src = findForgiveRange(fr.t0);
      return {
        t0: src ? src.t0 : fr.t0, t1: fr.t1, cause: src ? src.cause : null,
        endedAgoMs: ago(fr.t1), forgiven: true,
        dur: fr.dur, angle: src && src.angle != null ? src.angle : fr.angle, mended: false,
      };
    }
    if (!ep) return null;
    return {
      t0: ep.t0, t1: ep.t1, cause: ep.cause, endedAgoMs: ago(ep.t1), forgiven: false,
      dur: ep.dur, angle: ep.angle, mended: ep.mended,
    };
  }

  function liveBlinkRate() {
    if (counters.presentMs >= 60000) return Math.round((counters.blinks / (counters.presentMs / 60000)) * 10) / 10;
    // SPEC-GAP: before a full minute of presence, show the detector's windowed rate (null until 20 s).
    const s = det.sample;
    return s && s.blinkRate != null && isFinite(s.blinkRate) && sampleFresh(performance.now()) ? +s.blinkRate : null;
  }

  function refreshLive() {
    liveDirty = false;
    if (!rec || phase === 'idle') { live = idleLive(); return live; }
    if (!analysis) analysis = FT.analyze(rec.timeline);
    const an = analysis;
    const brk = inBreakNow();
    const pe = brk ? breakElapsed : phaseElapsed;
    const pt = brk ? breakTotal : workMs;
    const refSec = rec.refActiveSec || 3000;
    let rim;
    if (pt != null && pt > 0) rim = U.clamp01(pe / pt);
    else rim = (rec.activeMs % 1500000) / 1500000;

    const code = currentCode();
    const fresh = sampleFresh(performance.now());
    let state, cause;
    if (source === 'none') { state = 'unmeasured'; cause = null; }
    else if (code === 'N') { state = fresh && det.state === 'calibrating' ? 'calibrating' : 'unseen'; cause = null; }
    else { state = det.state; cause = det.cause || null; }
    let word = FT.CODES[code].word; // 'M' → 'timer only', 'N' → 'not visible'
    if (phase === 'paused') word = 'paused';
    else if (phase === 'break') word = 'break';
    else if (phase === 'complete') word = FT.PHASE_WORDS.complete;

    live = {
      phase: phase, prevPhase: prevPhase, pauseReason: phase === 'paused' ? pauseReason : null,
      mode: rec.mode, intention: rec.intention, source: source, measured: source !== 'none',
      round: round, rounds: rounds,
      activeMs: rec.activeMs,
      phaseElapsedMs: pe, phaseTotalMs: pt == null ? null : pt,
      phaseRemainingMs: pt == null ? null : Math.max(0, pt - pe),
      sessionRemainingMs: sessionRemaining(),
      progress: U.clamp01(rec.activeMs / 1000 / refSec),
      rimProgress: rim,
      depth: D,
      focus: source === 'none' ? null : det.f,
      state: state, cause: cause, word: word,
      heldMs: an.heldSec * 1000,
      focusPct: an.focusPct,
      streakMs: an.currentStreak * 1000,
      longestStreakMs: an.longestStreak * 1000,
      distractions: an.distractions, returns: an.returns, mended: an.mended,
      forgiven: an.forgiven.length, steppedAway: an.steppedAway,
      medianRecoveryMs: an.medianRecovery == null ? null : an.medianRecovery * 1000,
      lastEpisode: lastEpisodeInfo(an),
      blinkRate: liveBlinkRate(),
      drowsyFlags: counters.drowsyFlags,
      perclosPeak: counters.perclosPeak,
      timeToRootMs: an.timeToRoot == null ? null : an.timeToRoot * 1000,
      breakLookAwayMs: brk ? lookAwayMs : 0,
      breakEyeRested: brk && lookAwayMs >= EYE_REST_MS,
      // optional extras
      id: rec.id, no: rec.no, seed: rec.seed, index: tlLen(), refActiveSec: refSec,
      breakKind: brk ? breakKind : null,
      reason: source !== 'none' && fresh && det.sample && typeof det.sample.reason === 'string' ? det.sample.reason : '',
    };
    return live;
  }

  function getLive() {
    if (!live || liveDirty) refreshLive();
    return live;
  }

  /* =================================================================== *
   * 9. Lifecycle API                                                     *
   * =================================================================== */
  function normalizeConfig(c) {
    const mode = MODES.indexOf(c.mode) >= 0 ? c.mode : 'free';
    const num = (v, lo, hi, dflt) => {
      if (v == null || v === '' || typeof v === 'boolean') return dflt;
      const n = Number(v);
      return isFinite(n) ? U.clamp(n, lo, hi) : dflt;
    };
    const p = settings.pomodoro, cu = settings.custom;
    let workMin = null, breakMin = 0, longBreakMin = 0, nRounds = null, longEvery = 0;
    // SPEC-GAP: config values are clamped generously (work ≥ 0.1 min) so short test sessions are possible.
    if (mode === 'pomodoro') {
      workMin = num(c.workMin, 0.1, 600, p.workMin);
      breakMin = num(c.breakMin, 0, 120, p.breakMin);
      longBreakMin = num(c.longBreakMin, 0, 120, p.longBreakMin);
      nRounds = Math.round(num(c.rounds, 1, 12, p.rounds));
      longEvery = Math.round(num(c.longEvery, 0, 12, 4));
    } else if (mode === 'deep') {
      workMin = num(c.workMin, 0.1, 600, 50);
      breakMin = num(c.breakMin, 0, 120, 10);
      longBreakMin = num(c.longBreakMin, 0, 120, 10);
      nRounds = Math.round(num(c.rounds, 1, 12, 2));
      longEvery = Math.round(num(c.longEvery, 0, 12, 0));
    } else if (mode === 'custom') {
      workMin = num(c.workMin, 0.1, 600, cu.workMin);
      breakMin = num(c.breakMin, 0, 120, cu.breakMin);
      longBreakMin = num(c.longBreakMin, 0, 120, breakMin);
      nRounds = Math.round(num(c.rounds, 1, 12, cu.rounds));
      longEvery = Math.round(num(c.longEvery, 0, 12, 0));
    }
    return {
      mode: mode, workMin: workMin, breakMin: breakMin, longBreakMin: longBreakMin,
      rounds: nRounds, longEvery: longEvery,
      intention: String(c.intention == null ? '' : c.intention).trim().slice(0, 80),
      source: SOURCES.indexOf(c.source) >= 0 ? c.source : 'camera',
      sensitivity: SENSITIVITIES.indexOf(c.sensitivity) >= 0 ? c.sensitivity : settings.sensitivity,
    };
  }

  function start(config) {
    ensureLoaded();
    if (phase !== 'idle' && phase !== 'complete') {
      const err = new Error('A session is already in progress.');
      err.code = 'SessionActive';
      throw err;
    }
    // SPEC-GAP: a leftover crash draft would be overwritten by this session's first checkpoint,
    // so it is kept (saved to the terrarium when ≥ 30 s, otherwise dropped) before starting.
    try { if (readDraft()) recoverDraft(); } catch (e) { console.warn(LOG, 'Could not keep the unfinished draft:', e); }

    cfg = normalizeConfig(config && typeof config === 'object' ? config : {});
    const timedMode = cfg.workMin != null && cfg.rounds != null;
    const id = U.uid();
    const startedAt = Date.now();

    // Runtime state.
    source = cfg.source;
    round = 1;
    rounds = timedMode ? cfg.rounds : null;
    workMs = timedMode ? cfg.workMin * 60000 : null;
    phaseElapsed = 0;
    breakKind = null; breakElapsed = 0; breakTotal = 0; lookAwayMs = 0; breakAbsentMs = 0;
    pauseReason = null; resumeTo = null; pauseMsThis = 0;
    bucket = newBucket();
    D = 0;
    lastRec = null;
    milestonesDone = new Set();
    forgiving = false;
    forgiveRanges = [];
    hourlyIdx = new Map();
    counters = newCounters();
    lastDraftWall = startedAt;
    draftRetryAt = 0;

    rec = {
      v: 1,
      id: id,
      no: Math.max(1, Math.floor(meta.nextNo) || 1),
      seed: U.hashString(id),
      name: 'Focus session', // provisional; set for real in end()
      species: 'nascens',
      variety: '',
      intention: cfg.intention,
      mode: cfg.mode,
      plan: timedMode
        ? { workMin: cfg.workMin, breakMin: cfg.breakMin, longBreakMin: cfg.longBreakMin, rounds: cfg.rounds, longEvery: cfg.longEvery }
        : null,
      sensitivity: cfg.sensitivity,
      retract: cfg.sensitivity !== 'gentle',
      source: cfg.source,
      startedAt: startedAt,
      endedAt: null,
      refActiveSec: timedMode ? Math.max(1, Math.round(cfg.workMin * 60 * cfg.rounds)) : 3000,
      activeMs: 0, pausedMs: 0, breakMs: 0,
      timeline: { s: '', f: '', d: '', a: '' },
      gaps: [],
      episodes: [],
      streaks: [],
      stats: null,
      diagnosis: '',
      rating: null,
      hourly: [],
      // optional extras
      hasTimeline: true,
      demo: cfg.source === 'sim',
    };
    analysis = FT.analyze(rec.timeline);
    rec.stats = buildStats(analysis, counters);

    setPhase('running', 'start');
    return rec;
  }

  function pause(reason) {
    if (!rec || (phase !== 'running' && phase !== 'break')) return false;
    reason = reason === 'away' || reason === 'round' ? reason : 'user';
    resumeTo = phase;
    pauseReason = reason;
    pauseMsThis = 0;
    setPhase('paused', reason);
    return true;
  }

  function doResume(reason) {
    if (phase !== 'paused') return false;
    closePauseGap();
    const to = resumeTo === 'break' ? 'break' : 'running';
    resumeTo = null;
    setPhase(to, reason === 'returned' ? 'returned' : 'user');
    return true;
  }

  function startBreak(ms) {
    if (!rec || phase !== 'running') return false;
    let total = Number(ms);
    if (!isFinite(total) || total <= 0) total = 300000;
    breakKind = 'adhoc';
    breakTotal = total;
    breakElapsed = 0; lookAwayMs = 0; breakAbsentMs = 0;
    setPhase('break', 'user');
    return true;
  }

  function skipBreak() {
    if (!rec) return false;
    if (phase === 'break') { endBreak('skip'); return true; }
    if (phase === 'paused' && resumeTo === 'break') {
      closePauseGap();
      resumeTo = null;
      endBreak('skip');
      return true;
    }
    return false;
  }

  function extendBreak(ms) {
    if (!rec || !inBreakNow()) return false;
    let add = Number(ms);
    if (!isFinite(add) || add <= 0) add = 300000;
    breakTotal += add;
    refreshLive();
    return true;
  }

  function end(opts) {
    if (phase === 'idle') return null;
    if (phase === 'complete') return rec;
    const save = !(opts && typeof opts === 'object' && opts.save === false);

    // Close whatever interval is open.
    if (phase === 'paused') {
      closePauseGap();
      if (resumeTo === 'break') endBreak('end');
      resumeTo = null;
    } else if (phase === 'break') {
      endBreak('end');
    }

    // 1. The second in progress counts if it holds at least half a second.
    if (bucket.total >= 500) finalizeSecond();
    bucket = newBucket();
    forgiving = false;

    rec.activeMs = Math.round(rec.activeMs);
    rec.pausedMs = Math.round(rec.pausedMs);
    rec.breakMs = Math.round(rec.breakMs);
    if (rec.source !== 'none') { // per-minute blink counts cover every minute of a measured session
      const minutes = Math.ceil(rec.activeMs / 60000);
      while (counters.blinkPerMin.length < minutes) counters.blinkPerMin.push(0);
    }

    // 2–4. Stats, naming, end time.
    analysis = finalizeRecord(rec, counters) || FT.analyze(rec.timeline);
    rec.endedAt = Date.now();

    // 5. Save if allowed. (Kept in memory for this page even if the browser refuses to persist.)
    const saved = save && rec.activeMs >= SAVE_MIN_ACTIVE_MS;
    if (saved) saveRecord(rec);
    removeDraft();

    // 6. Complete.
    pauseReason = null;
    setPhase('complete', 'end');
    FT.bus.emit('session:complete', { record: rec, saved: saved });
    return rec;
  }

  function reset() {
    if (phase !== 'complete') return false;
    setPhase('idle', 'reset');
    return true;
  }

  function setSource(src) {
    if (SOURCES.indexOf(src) < 0 || !rec || !isActive()) return false;
    if (src === source) return true;
    source = src;
    if (rec.source !== src) rec.source = 'mixed';
    if (src === 'sim') rec.demo = true;
    refreshLive();
    return true;
  }

  function forgiveLast() {
    if (!rec || !isActive() || !analysis) return false;
    const an = analysis;
    const ep = an.episodes.length ? an.episodes[an.episodes.length - 1] : null;
    if (!ep) return false;
    const fr = an.forgiven.length ? an.forgiven[an.forgiven.length - 1] : null;
    if (fr && fr.t0 > ep.t0) return false; // the latest drift is already forgiven
    if (ep.t1 !== null && rec.activeMs - ep.t1 * 1000 >= FORGIVE_WINDOW_MS) return false;

    const tl = rec.timeline, s = tl.s;
    const stop = ep.t1 === null ? s.length : ep.t1;
    let mid = '', n = 0;
    for (let i = ep.t0; i < stop; i++) {
      const c = s[i], info = FT.CODES[c];
      if (info && (info.away || c === 'E')) { mid += 'K'; n++; } else mid += c;
    }
    if (!n) return false;
    tl.s = s.slice(0, ep.t0) + mid + s.slice(stop);
    forgiveRanges.push({ t0: ep.t0, t1: ep.t1, cause: ep.cause, angle: ep.angle });
    // SPEC-GAP: forgiving a drift that is still open also forgives the rest of it (until the next held or 'A' second).
    if (ep.t1 === null) forgiving = true;
    // SPEC-GAP: forgiven seconds now count as held; credit them to the current hour.
    addHourly(n * 1000);

    const prev = analysis;
    analysis = FT.analyze(tl);
    FT.bus.emit('session:episode', { type: 'forgiven', episode: episodeOut(Object.assign({}, ep, { mended: false })) });
    diffEpisodes(prev, analysis); // an earlier scar may now be mended
    refreshLive();
    return true;
  }

  function getRecord() {
    if (rec && isActive()) syncRecord();
    return rec;
  }

  /* =================================================================== *
   * 10. History: list / load / remove / rate                             *
   * =================================================================== */
  function list(opts) {
    ensureLoaded();
    const includeDemo = !(opts && opts.includeDemo === false);
    const out = [];
    for (const s of items) if (includeDemo || !isDemo(s)) out.push(clone(s));
    return out;
  }

  function load(id) {
    ensureLoaded();
    if (typeof id !== 'string' || !id) return null;
    const r = readVersioned('session.' + id);
    if (r) return r;
    if (rec && rec.id === id) return rec; // the current/last (possibly unsaved) record
    return null;
  }

  function remove(id) {
    ensureLoaded();
    if (typeof id !== 'string' || !id) return false;
    const before = items.length;
    const existed = FT.store.get('session.' + id, null) != null;
    items = items.filter((s) => s.id !== id);
    FT.store.remove('session.' + id);
    if (items.length === before && !existed) return false;
    persist('sessions', { v: 1, items: items });
    FT.bus.emit('history:change', { reason: 'removed' });
    return true;
  }

  function rate(id, n) {
    ensureLoaded();
    const v = Math.round(Number(n));
    if (!(v >= 1 && v <= 5) || typeof id !== 'string') return false;
    let found = false;
    const s = items.find((x) => x.id === id);
    if (s) { s.rating = v; found = true; }
    const full = readVersioned('session.' + id);
    if (full) { full.rating = v; persist('session.' + id, full, id); found = true; }
    if (rec && rec.id === id) { rec.rating = v; found = true; }
    if (!found) return false;
    if (s) persist('sessions', { v: 1, items: items });
    FT.bus.emit('history:change', { reason: 'rated' });
    return true;
  }

  /* =================================================================== *
   * 11. Aggregate (§4.4.7)                                               *
   * =================================================================== */
  function aggregate(opts) {
    ensureLoaded();
    opts = opts || {};
    const now = opts.now != null && isFinite(opts.now) ? +opts.now : Date.now();
    const includeDemo = opts.includeDemo === true;
    const goalMin = settings.goalMin;
    const goalMs = Math.max(60000, goalMin * 60000);
    const pool = items.filter((s) => includeDemo || !isDemo(s));

    const today = U.dayKey(now);
    const firstDay = U.addDays(today, -(HISTORY_DAYS - 1));
    const compassFrom = U.addDays(today, -(COMPASS_DAYS - 1));
    const thisMonday = U.mondayOf(today);
    const weeks = [];
    for (let k = RECOVERY_WEEKS - 1; k >= 0; k--) weeks.push(U.addDays(thisMonday, -7 * k));
    const weekVals = new Map(weeks.map((w) => [w, []]));

    const dayHeld = new Map(), daySessions = new Map();
    const heat = [];
    for (let w = 0; w < 7; w++) heat.push(new Array(24).fill(0));
    const compass = [0, 0, 0, 0, 0, 0, 0, 0];
    let heldMs = 0, activeMs = 0, fpSum = 0, fpN = 0;

    for (const s of pool) {
      heldMs += +s.heldMs || 0;
      activeMs += +s.activeMs || 0;
      if (s.focusPct != null && isFinite(s.focusPct)) { fpSum += +s.focusPct; fpN++; }
      const sDay = U.dayKey(+s.startedAt || 0);
      daySessions.set(sDay, (daySessions.get(sDay) || 0) + 1);

      // Daily held time comes from `hourly` (splits sessions that cross midnight correctly).
      const hourly = Array.isArray(s.hourly) && s.hourly.length
        ? s.hourly
        : [[sDay, new Date(+s.startedAt || 0).getHours(), +s.heldMs || 0]]; // SPEC-GAP: fallback for summaries without hourly
      for (const h of hourly) {
        if (!Array.isArray(h)) continue;
        const day = String(h[0]), hour = Math.floor(+h[1]), ms = +h[2] || 0;
        if (ms <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        dayHeld.set(day, (dayHeld.get(day) || 0) + ms);
        if (day >= firstDay && day <= today && hour >= 0 && hour < 24) heat[U.weekday(U.parseDayKey(day))][hour] += ms;
      }

      if (sDay >= compassFrom && sDay <= today && Array.isArray(s.dirs)) {
        for (let k = 0; k < 8; k++) compass[k] += +s.dirs[k] || 0;
      }
      const wk = U.mondayOf(sDay);
      if (weekVals.has(wk) && s.medianRecoveryMs != null && isFinite(s.medianRecoveryMs)) weekVals.get(wk).push(+s.medianRecoveryMs);
    }

    const days = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const day = U.addDays(today, -i);
      const h = dayHeld.get(day) || 0;
      days.push({ day: day, heldMs: h, sessions: daySessions.get(day) || 0, goalMet: h >= goalMs });
    }

    // Day streaks.
    const met = (day) => (dayHeld.get(day) || 0) >= goalMs;
    let current = 0;
    let cursor = met(today) ? today : U.addDays(today, -1);
    for (let guard = dayHeld.size + 1; guard > 0 && met(cursor); guard--) { current++; cursor = U.addDays(cursor, -1); }
    let best = 0, run = 0, prevDay = null;
    const metDays = Array.from(dayHeld.keys()).filter(met).sort();
    for (const d of metDays) {
      run = prevDay && U.addDays(prevDay, 1) === d ? run + 1 : 1;
      if (run > best) best = run;
      prevDay = d;
    }
    best = Math.max(best, current);

    // Best 2-hour window.
    let bestHours = null;
    if (pool.length >= 5) {
      let bh = -1, bv = 0;
      for (let h = 0; h <= 22; h++) {
        let v = 0;
        for (let w = 0; w < 7; w++) v += heat[w][h] + heat[w][h + 1];
        if (v > bv) { bv = v; bh = h; }
      }
      if (bh >= 0) bestHours = { start: bh, end: bh + 2 };
    }

    const recovery = weeks.map((w) => {
      const v = weekVals.get(w);
      return { week: w, medianRecoveryMs: v.length ? U.median(v) : null };
    });

    const todayRow = days[days.length - 1];
    return {
      goalMin: goalMin,
      totals: { sessions: pool.length, heldMs: heldMs, activeMs: activeMs, avgFocusPct: fpN ? fpSum / fpN : null },
      today: { day: today, heldMs: todayRow.heldMs, sessions: todayRow.sessions, goalMet: todayRow.goalMet },
      days: days,
      dayStreak: { current: current, best: best },
      heat: heat,
      bestHours: bestHours,
      compass: compass,
      recovery: recovery,
      // optional extra
      demoSessions: items.filter(isDemo).length,
    };
  }

  /* =================================================================== *
   * 12. Export / import / erase (§4.4.8)                                 *
   * =================================================================== */
  function stubFromSummary(s) {
    return {
      v: 1, id: s.id, no: s.no, seed: s.seed, name: s.name, species: s.species || '', variety: s.variety,
      intention: s.intention, mode: s.mode, plan: null, sensitivity: 'standard', retract: true,
      source: s.source, startedAt: s.startedAt, endedAt: s.endedAt, refActiveSec: 3000,
      activeMs: s.activeMs, pausedMs: 0, breakMs: 0, gaps: [], episodes: [], streaks: [],
      stats: {
        heldMs: s.heldMs, focusPct: s.focusPct, longestStreakMs: s.longestStreakMs, timeToRootMs: s.timeToRootMs == null ? null : s.timeToRootMs,
        distractions: s.distractions, returns: s.returns, mended: s.mended, forgiven: s.forgiven || 0, steppedAway: s.steppedAway || 0,
        byCause: Object.assign({}, s.byCause), dirs: (s.dirs || []).slice(), medianRecoveryMs: s.medianRecoveryMs,
        peakDepth: s.peakDepth,
      },
      diagnosis: '', rating: s.rating, hourly: clone(s.hourly) || [], hasTimeline: false,
    };
  }

  function exportJSON() {
    ensureLoaded();
    const sessions = [];
    for (const s of items) {
      const full = readVersioned('session.' + s.id);
      sessions.push(full || stubFromSummary(s));
    }
    return JSON.stringify({
      app: 'hypha', v: 1, exportedAt: Date.now(),
      settings: clone(settings),
      calibration: FT.store.get('calibration', null),
      sessions: sessions,
    }, null, 2);
  }

  function importJSON(text) {
    ensureLoaded();
    const res = { added: 0, skipped: 0, errors: [], error: null };
    const fail = (msg) => { res.errors.push(msg); res.error = msg; return res; };
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return fail("That file isn't valid JSON."); }
    if (!data || typeof data !== 'object' || data.app !== 'hypha' || data.v !== 1) return fail("That file isn't a Focus Tracker export.");

    const incoming = Array.isArray(data.sessions) ? data.sessions : [];
    const have = new Set(items.map((s) => s.id));
    let maxNo = 0, bad = 0;
    for (const raw of incoming) {
      let r = raw;
      try { r = migrate('session', raw); } catch (e) { r = null; }
      if (!r || typeof r !== 'object' || r.v !== 1 || !repairRecord(r)) { bad++; continue; }
      maxNo = Math.max(maxNo, r.no);
      if (have.has(r.id)) { res.skipped++; continue; }
      if (!r.stats || typeof r.stats !== 'object') finalizeRecord(r, countersFrom(null, null));
      else {
        if (!r.species) r.species = speciesFor(r);
        if (!r.name) r.name = FT.sessionTitle(r);
        if (typeof r.diagnosis !== 'string' || !r.diagnosis) r.diagnosis = diagnosisFor(r.stats);
      }
      persist('session.' + r.id, r, r.id);
      items.push(summaryOf(r));
      have.add(r.id);
      res.added++;
    }
    for (let i = 0; i < bad; i++) res.errors.push('Skipped an unreadable session.'); // one entry per bad record
    sortItems();
    if (res.added) persist('sessions', { v: 1, items: items });
    if (maxNo + 1 > meta.nextNo) { meta.nextNo = maxNo + 1; persist('meta', meta); }

    // Settings are replaced only if this browser has none of its own.
    if (!hadLocalSettings && data.settings && typeof data.settings === 'object') {
      const next = defaultSettings();
      applyPatch(next, data.settings);
      const changed = [];
      for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify(settings[k])) changed.push(k);
      settings = next;
      hadLocalSettings = true;
      persist('settings', settings);
      if (changed.length) FT.bus.emit('settings:change', { settings: clone(settings), changed: changed });
    }
    // SPEC-GAP: the calibration is restored only when this browser has none (Detector reads it on next load).
    if (data.calibration && typeof data.calibration === 'object' && data.calibration.v === 1 &&
        FT.store.get('calibration', null) == null) {
      FT.store.set('calibration', data.calibration);
    }

    FT.bus.emit('history:change', { reason: 'imported' });
    return res;
  }

  function eraseAll() {
    FT.store.clearAll();
    settings = defaultSettings();
    hadLocalSettings = false;
    meta = { v: 1, nextNo: 1, created: Date.now() };
    items = [];
    loaded = true;
    FT.bus.emit('history:change', { reason: 'erased' });
    return true;
  }

  /* =================================================================== *
   * 13. Settings API + init                                              *
   * =================================================================== */
  function getSettings() {
    ensureLoaded();
    return clone(settings);
  }

  function setSettings(partial) {
    ensureLoaded();
    const changed = applyPatch(settings, partial);
    if (changed.length) {
      hadLocalSettings = true;
      persist('settings', settings);
      FT.bus.emit('settings:change', { settings: clone(settings), changed: changed });
    }
    return clone(settings);
  }

  function init() {
    ensureStoreListener();
    if (!subscribed) {
      subscribed = true;
      FT.bus.on('clock:tick', onTick);
      FT.bus.on('detector:sample', onSample);
      FT.bus.on('detector:state', onState);
      FT.bus.on('detector:blink', onBlink);
      FT.bus.on('detector:yawn', onYawn);
      FT.bus.on('detector:drowsy', onDrowsy);
      // Extra safety for drafts: checkpoint when the page is hidden or unloaded.
      try {
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibility);
      } catch (e) { /* ignore */ }
    }
    ensureLoaded();
    return getSettings();
  }

  /* =================================================================== *
   * 14. Public API                                                       *
   * =================================================================== */
  FT.Session = {
    init: init,
    getSettings: getSettings,
    setSettings: setSettings,
    start: start,
    pause: function (reason) { return pause(reason === undefined ? 'user' : reason); },
    resume: function () { return doResume('user'); },
    startBreak: function (ms) { return startBreak(ms === undefined ? 300000 : ms); },
    skipBreak: skipBreak,
    extendBreak: function (ms) { return extendBreak(ms === undefined ? 300000 : ms); },
    end: function (opts) { return end(opts); },
    reset: reset,
    setSource: setSource,
    forgiveLast: forgiveLast,
    getLive: getLive,
    getRecord: getRecord,
    get phase() { return phase; },
    list: list,
    load: load,
    remove: remove,
    rate: rate,
    aggregate: aggregate,
    exportJSON: exportJSON,
    importJSON: importJSON,
    eraseAll: eraseAll,
    getDraft: getDraft,
    recoverDraft: recoverDraft,
    discardDraft: discardDraft,
    labelFor: labelFor,
    // optional extras
    migrate: migrate,
    get source() { return source; },
    get round() { return round; },
    get rounds() { return rounds; },
    speciesFor: speciesFor,
    diagnosisFor: diagnosisFor,
    varietyFor: varietyFor,
  };
})();
