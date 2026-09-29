/*!
 * Hypha — js/audio.js  (FT.Audio)
 * SPEC §4.6 (API) and §7.1 (sound design). Web Audio only, strictly opt-in:
 * no AudioContext exists until unlock() is called from inside a user gesture.
 *
 * Graph (built lazily, on first unlock / first use):
 *
 *   chime voices ─┬─► [pan] ─► chimeBus ─────────────────────────┐
 *                 ├─► space (soft convolver send) ──────────────┤
 *                 └─► echo (feedback delay; 'complete' only) ───┤
 *   drones + brown-noise air ─► lowpass ─► scapeGain ───────────┤
 *                                                               └─► master ─► compressor ─► destination
 *
 * Every start and stop is ramped (no clicks); finished voices disconnect themselves.
 */
(function () {
  'use strict';
  const FT = window.FT, U = FT.util;
  const LOG = '[Hypha:audio]';

  /* ------------------------------------------------------------------ *
   * Constants (§7.1)                                                    *
   * ------------------------------------------------------------------ */
  const MASTER_CAP = 0.125;          // master = 0.125 × volume (≈ −18 dBFS at full volume)
  const MASTER_TAU = 0.3;            // s
  const RAMP_TAU = 0.8;              // "other ramps"
  const AWAY_TAU = 1.5;              // cutoff drop when away: "the silence is the nudge"
  const STOP_TAU = 0.075;            // stopAll(): ≈ 98 % faded after 300 ms
  const REVIVE_TAU = 0.05;           // a play() after stopAll() brings the master back quickly
  const SCAPE_IN_TAU = 1.2;          // soundscape fade-in when (re)built
  const SCAPE_OUT_TAU = 0.25;        // soundscape fade-out before teardown
  const LOOKAHEAD = 0.015;           // s; never schedule in the past (that clicks)

  const DRONE_GAIN = 0.10, NOISE_GAIN = 0.06;
  const BREAK_DRONE_GAIN = 0.05, BREAK_NOISE_GAIN = 0.08;

  // D-major pentatonic (§7.1 blink / seed)
  const PENTA = [293.66, 329.63, 369.99, 440, 493.88, 587.33];
  // Calibration seeds come from where they sit on screen: centre, TL, TR, BR, BL (§4.3.5).
  const SEED_PAN = [0, -0.45, 0.45, 0.45, -0.45];

  const BLINK_MIN_GAP_MS = 4000;
  const RETURN_MIN_GAP_MS = 30000;
  const MAX_VOICES = 24;             // hard safety cap; beyond it play() is treated as rate-limited

  const PARAM_KEYS = ['phase', 'state', 'cause', 'focus', 'depth', 'drowsiness'];
  const ACTIVE_PHASES = new Set(['running', 'paused', 'break']);

  /**
   * Chime sequences. `peak` is the per-note envelope peak (§7.1 "Peak gain").
   * `gap` is the onset spacing in seconds. Decay times are not in the spec for these;
   * glass notes ring for ~2 s.
   * SPEC-GAP: §7.1 gives decay only for blink (1.6 s) and nudge (2.5 s); the others use 1.8–2.8 s.
   * SPEC-GAP: for the 'calibrated' dyad, "peak gain 0.04" is applied per note (like every other chime).
   */
  const CHIMES = {
    return:        { notes: [440, 587.33],                                   gap: 0.12, peak: 0.04,  decay: 1.8 },
    milestone:     { notes: [587.33, 739.99, 880],                           gap: 0.11, peak: 0.035, decay: 2.0 },
    calibrated:    { notes: [587.33, 880],                                   gap: 0,    peak: 0.04,  decay: 2.2 },
    'break-start': { notes: [880, 739.99, 587.33],                           gap: 0.18, peak: 0.035, decay: 2.2 },
    'break-end':   { notes: [659.25, 554.37],                                gap: 0.30, peak: 0.04,  decay: 2.6 },
    complete:      { notes: [293.66, 369.99, 440, 587.33, 659.25, 880],      gap: 0.38, peak: 0.05,  decay: 2.8, echo: true },
  };

  /* ------------------------------------------------------------------ *
   * State                                                               *
   * ------------------------------------------------------------------ */
  const opts = { enabled: false, soundscape: true, chimes: true, volume: 0.6, nudge: true };
  const params = { phase: 'idle', state: 'none', cause: null, focus: 0.75, depth: 0, drowsiness: 0 };

  let ctx = null;                    // AudioContext (created only in unlock())
  let g = null;                      // { master, comp, chimeBus }
  let everRunning = false;
  let initDone = false;

  let stopped = false;               // stopAll() in effect
  let stopGroup = null;              // phase group at the time of stopAll()

  let scape = null;                  // live soundscape nodes, or null
  let scapeKill = 0;                 // teardown timer id
  let lastScape = null;              // last soundscape targets (for 'unseen' = unchanged)
  let noiseBuf = null;               // cached 2 s brown-noise loop (per context)

  let space = null;                  // shared soft room (convolver) send
  let echo = null;                   // shared feedback delay for 'complete'

  const voices = new Set();          // live one-shot voices
  const lastTarget = new WeakMap();  // AudioParam -> last target set (dedupes 10 Hz updates)

  let pentaIdx = 2;                  // blink random walk position
  let lastPluckAt = -Infinity;       // performance.now() of the last blink pluck
  let lastReturnAt = -Infinity;      // performance.now() of the last 'return' chime

  /* ------------------------------------------------------------------ *
   * Small helpers                                                       *
   * ------------------------------------------------------------------ */
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const num01 = (v, fallback) => (isNum(v) ? U.clamp01(v) : fallback);
  const phaseGroup = (ph) => (ph === 'fruiting' || ph === 'complete' ? 'post' : ph);
  const cents = (spread) => (Math.random() - 0.5) * spread;
  const Ctor = () => window.AudioContext || window.webkitAudioContext || null;

  /** Ramp an AudioParam toward `target` with setTargetAtTime (τ in seconds). Deduped by target. */
  function glide(param, target, tau) {
    if (!ctx || !param || !isFinite(target)) return;
    const prev = lastTarget.get(param);
    if (prev !== undefined && Math.abs(prev - target) <= Math.max(1e-6, Math.abs(target) * 0.003)) return;
    lastTarget.set(param, target);
    try { param.setTargetAtTime(target, ctx.currentTime, Math.max(0.005, tau)); }
    catch (e) { try { param.value = target; } catch (e2) { /* ignore */ } }
  }
  /** Set an AudioParam's intrinsic value at build time (before anything is audible). */
  function preset(param, v) {
    try { param.value = v; } catch (e) { /* ignore */ }
    lastTarget.set(param, v);
  }
  function safeDisconnect(node) { try { node.disconnect(); } catch (e) { /* ignore */ } }
  function makePan(value) {
    if (!value || typeof ctx.createStereoPanner !== 'function') return null;
    const p = ctx.createStereoPanner();
    p.pan.value = U.clamp(value, -1, 1);
    return p;
  }

  /* ------------------------------------------------------------------ *
   * Master chain                                                        *
   * ------------------------------------------------------------------ */
  function buildMaster() {
    const master = ctx.createGain();
    preset(master.gain, 0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    const chimeBus = ctx.createGain();
    chimeBus.gain.value = 1;
    chimeBus.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);
    g = { master: master, comp: comp, chimeBus: chimeBus };
  }

  function masterTarget() {
    return opts.enabled && !stopped ? MASTER_CAP * num01(+opts.volume, 0) : 0;
  }
  function applyMaster(tau) {
    if (g) glide(g.master.gain, masterTarget(), tau == null ? MASTER_TAU : tau);
  }

  /* ------------------------------------------------------------------ *
   * Soundscape: "wet cave air"                                          *
   * ------------------------------------------------------------------ */
  function wantScape() { return !!(ctx && g) && opts.enabled && opts.soundscape && !stopped; }

  /** Targets from the latest update() params (§7.1 cutoff table). */
  function scapeTargets() {
    const ph = params.phase, st = params.state;
    const F = num01(params.focus, 0.75), D = num01(params.depth, 0);
    const t = {
      cutoff: 220 + 1400 * Math.pow(F, 1.5) + 600 * D,
      cutTau: RAMP_TAU, level: 1, drone: DRONE_GAIN, noise: NOISE_GAIN,
    };
    // SPEC-GAP: the soundscape gain's base level is unspecified; it is 1 (the sources carry the §7.1 gains).
    // SPEC-GAP: phases other than break/paused (idle, intro, calibrating, fruiting, complete…) use the cutoff formula.
    if (ph === 'break') {
      t.cutoff = 1800; t.drone = BREAK_DRONE_GAIN; t.noise = BREAK_NOISE_GAIN;
    } else if (ph === 'paused') {
      t.cutoff = 260; t.level = 0.5;
    } else if (st === 'away') {
      t.cutoff = 180; t.cutTau = AWAY_TAU;
    } else if (st === 'eyes-closed' || st === 'absent') {
      t.cutoff = 260; t.level = 0.5;
    } else if (st === 'unseen' && lastScape) {
      return lastScape; // "Unchanged"
    }
    lastScape = t;
    return t;
  }

  /** A 2 s stereo loop of seeded brown noise with a seamless (crossfaded) loop point. */
  function makeBrownNoise() {
    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.round(sr * 2));
    const fade = Math.max(1, Math.round(sr * 0.08));
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const rnd = U.rng(0x48797068 + ch * 7919);       // seeded: the air is the same every time
      const tmp = new Float32Array(n + fade);
      let last = 0, sum = 0;
      for (let i = 0; i < tmp.length; i++) {
        last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02;  // leaky "brown" integrator
        tmp[i] = last; sum += last;
      }
      const mean = sum / tmp.length;
      for (let i = 0; i < tmp.length; i++) tmp[i] -= mean;
      const out = buf.getChannelData(ch);
      out.set(tmp.subarray(0, n));
      // Equal-power crossfade of the pre-roll into the head: sample n-1 flows into tmp[n] at the wrap.
      for (let i = 0; i < fade; i++) {
        const x = (i / fade) * (Math.PI / 2);
        out[i] = tmp[i] * Math.sin(x) + tmp[n + i] * Math.cos(x);
      }
      let peak = 0;
      for (let i = 0; i < n; i++) { const v = Math.abs(out[i]); if (v > peak) peak = v; }
      if (peak > 0) { const k = 0.9 / peak; for (let i = 0; i < n; i++) out[i] *= k; }
    }
    return buf;
  }

  function ensureScape(tg) {
    if (scape) {
      if (scapeKill) { clearTimeout(scapeKill); scapeKill = 0; }
      return scape;
    }
    const t = ctx.currentTime + LOOKAHEAD;

    const out = ctx.createGain();
    preset(out.gain, 0);
    out.connect(g.master);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    preset(lp.frequency, tg.cutoff);
    lp.connect(out);

    // Drone 1: triangle D2, −4 cents.  Drone 2: sine A2, +3 cents.
    const d1 = ctx.createOscillator();
    d1.type = 'triangle'; d1.frequency.value = 73.42; d1.detune.value = -4;
    const d1g = ctx.createGain(); preset(d1g.gain, tg.drone);
    const d2 = ctx.createOscillator();
    d2.type = 'sine'; d2.frequency.value = 110; d2.detune.value = 3;
    const d2g = ctx.createGain(); preset(d2g.gain, tg.drone);

    // Air: looped seeded brown noise.
    if (!noiseBuf) noiseBuf = makeBrownNoise();
    const nz = ctx.createBufferSource();
    nz.buffer = noiseBuf; nz.loop = true;
    const nzg = ctx.createGain(); preset(nzg.gain, tg.noise);

    const made = [out, lp, d1, d1g, d2, d2g, nz, nzg];
    d1.connect(d1g); d2.connect(d2g); nz.connect(nzg);
    // A little width: the two drones sit slightly apart (StereoPanner where available).
    const p1 = makePan(-0.2), p2 = makePan(0.2);
    if (p1) { d1g.connect(p1); p1.connect(lp); made.push(p1); } else d1g.connect(lp);
    if (p2) { d2g.connect(p2); p2.connect(lp); made.push(p2); } else d2g.connect(lp);
    nzg.connect(lp);

    // Addition (not in §7.1, inaudible as "motion"): the cave breathes. A very slow LFO sways the
    // filter by ±70 cents and the A2 drone by ±0.012 so the air is never static.
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.047;
    const lfoG = ctx.createGain(); lfoG.gain.value = 70;
    lfo.connect(lfoG); lfoG.connect(lp.detune);
    const swell = ctx.createOscillator(); swell.type = 'sine'; swell.frequency.value = 0.031;
    const swellG = ctx.createGain(); swellG.gain.value = 0.012;
    swell.connect(swellG); swellG.connect(d2g.gain);
    made.push(lfo, lfoG, swell, swellG);

    const sources = [d1, d2, nz, lfo, swell];
    d1.start(t); d2.start(t); lfo.start(t); swell.start(t);
    nz.start(t, Math.random() * 1.9);

    scape = { out: out, lp: lp, d1g: d1g, d2g: d2g, nzg: nzg, sources: sources, nodes: made };
    glide(out.gain, tg.level, SCAPE_IN_TAU);       // gentle entrance
    return scape;
  }

  /** Fade the soundscape out, then stop and disconnect it (saves CPU while silent). */
  function releaseScape() {
    if (!scape || scapeKill) return;
    const s = scape;
    glide(s.out.gain, 0, SCAPE_OUT_TAU);
    scapeKill = setTimeout(function () {
      scapeKill = 0;
      if (scape !== s) return;
      if (wantScape()) { applyScape(); return; }
      scape = null;
      const t = ctx ? ctx.currentTime + 0.05 : 0;
      for (const src of s.sources) { try { src.stop(t); } catch (e) { /* ignore */ } }
      setTimeout(function () { for (const n of s.nodes) safeDisconnect(n); }, 300);
    }, 1600);
  }

  function applyScape() {
    if (!ctx || !g) return;
    if (!wantScape()) { releaseScape(); return; }
    const tg = scapeTargets();
    const s = ensureScape(tg);
    glide(s.lp.frequency, tg.cutoff, tg.cutTau);
    glide(s.out.gain, tg.level, RAMP_TAU);        // deduped while the fade-in target is unchanged
    glide(s.d1g.gain, tg.drone, RAMP_TAU);
    glide(s.d2g.gain, tg.drone, RAMP_TAU);
    glide(s.nzg.gain, tg.noise, RAMP_TAU);
  }

  function applyAll() {
    applyMaster(MASTER_TAU);
    applyScape();
  }

  /* ------------------------------------------------------------------ *
   * Shared effect sends (lazy)                                          *
   * ------------------------------------------------------------------ */
  /** A short, dark, seeded room impulse: glass ringing in a damp cave. */
  function makeImpulse() {
    const sr = ctx.sampleRate;
    const len = Math.max(2, Math.round(sr * 2.6));
    const pre = Math.round(sr * 0.015);
    const tail = Math.round(sr * 0.12);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const rnd = U.rng(0x5ca7e + ch * 104729);
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const k = 0.35 + 0.55 * Math.min(1, t / 2.2);          // the tail darkens as it decays
        lp = lp * k + (rnd() * 2 - 1) * (1 - k);
        let env = Math.exp(-t / 0.55) * Math.min(1, t / 0.008);
        if (i > len - tail) env *= (len - i) / tail;            // land exactly on zero
        d[i] = lp * env;
      }
    }
    return buf;
  }

  // Addition (not in §7.1): a subtle shared room so the glass notes bloom instead of ending dry.
  function ensureSpace() {
    if (space) return space;
    try {
      const conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = makeImpulse();
      const wet = ctx.createGain();
      wet.gain.value = 0.2;
      conv.connect(wet);
      wet.connect(g.master);
      space = { input: conv, wet: wet };
    } catch (e) {
      console.warn(LOG, 'room send unavailable:', e);
      space = false; // do not retry every note
    }
    return space;
  }

  /** §7.1 'complete': feedback delay 0.28 s, feedback .35, wet .3. */
  function ensureEcho() {
    if (echo) return echo;
    try {
      const input = ctx.createGain();
      const dl = ctx.createDelay(1.0);
      dl.delayTime.value = 0.28;
      const fb = ctx.createGain();
      fb.gain.value = 0.35;
      // Addition: a soft lowpass inside the loop so repeats darken instead of piling up brightness.
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass'; tone.frequency.value = 3400; tone.Q.value = 0.5;
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      input.connect(dl);
      dl.connect(tone);
      tone.connect(fb);
      fb.connect(dl);
      tone.connect(wet);
      wet.connect(g.master);
      const sp = ensureSpace();
      if (sp) wet.connect(sp.input);
      echo = { input: input };
    } catch (e) {
      console.warn(LOG, 'echo unavailable:', e);
      echo = false;
    }
    return echo;
  }

  /* ------------------------------------------------------------------ *
   * Voices                                                              *
   * ------------------------------------------------------------------ */
  /** Connect a voice's output to the chime bus (+ room, + echo). Returns extra nodes it created. */
  function route(node, o) {
    const made = [];
    let out = node;
    const pan = makePan(o && isNum(o.pan) ? o.pan : 0);
    if (pan) { node.connect(pan); out = pan; made.push(pan); }
    out.connect(g.chimeBus);
    const sp = ensureSpace();
    if (sp) out.connect(sp.input);
    if (o && o.echo) {
      const e = ensureEcho();
      if (e) out.connect(e.input);
    }
    return made;
  }

  function track(sources, nodes) {
    const v = { sources: sources, nodes: nodes, born: performance.now(), done: false };
    voices.add(v);
    sources[0].onended = function () { freeVoice(v); };
    return v;
  }
  function freeVoice(v) {
    if (v.done) return;
    v.done = true;
    voices.delete(v);
    for (const n of v.nodes) safeDisconnect(n);
  }
  /** Stop a voice now (only used once the master is already silent). */
  function killVoice(v) {
    if (v.done || !ctx) return;
    const t = ctx.currentTime + 0.02;
    for (const s of v.sources) { try { s.stop(t); } catch (e) { /* ignore */ } }
  }

  /**
   * The "pluck": an FM glass tone (§7.1). Carrier sine at f; modulator sine at 2.01 f with index
   * gain 1.2 f decaying to 0 over 0.9 s. Envelope: 5 ms attack, exponential decay to 0.0001.
   */
  function pluck(freq, peak, decay, offset, o) {
    const t = ctx.currentTime + LOOKAHEAD + (offset || 0);
    const f = freq * Math.pow(2, ((o && o.cents) || 0) / 1200);

    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * 2.01;

    const index = ctx.createGain();
    const I = 1.2 * f;
    index.gain.value = 0;
    index.gain.setValueAtTime(I, t);
    index.gain.exponentialRampToValueAtTime(I * 0.001, t + 0.9);
    index.gain.setValueAtTime(0, t + 0.9);

    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.005 + decay);
    env.gain.linearRampToValueAtTime(0, t + 0.025 + decay);

    mod.connect(index);
    index.connect(car.frequency);
    car.connect(env);
    const extra = route(env, o);

    const end = t + decay + 0.06;
    car.start(t); mod.start(t);
    car.stop(end); mod.stop(end);
    track([car, mod], [car, mod, index, env].concat(extra));
  }

  /** §7.1 nudge: 880 Hz sine + 1320 Hz partial at 0.3×, 30 ms attack, 2.5 s decay, peak 0.03. */
  function nudgeTone() {
    const t = ctx.currentTime + LOOKAHEAD;
    const o1 = ctx.createOscillator();
    o1.type = 'sine'; o1.frequency.value = 880;
    const o2 = ctx.createOscillator();
    o2.type = 'sine'; o2.frequency.value = 1320;
    const partial = ctx.createGain();
    partial.gain.value = 0.3;
    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.03, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.03 + 2.5);
    env.gain.linearRampToValueAtTime(0, t + 0.05 + 2.5);
    o1.connect(env);
    o2.connect(partial);
    partial.connect(env);
    const extra = route(env, null);
    const end = t + 2.62;
    o1.start(t); o2.start(t);
    o1.stop(end); o2.stop(end);
    track([o1, o2], [o1, o2, partial, env].concat(extra));
  }

  function sequence(def) {
    const n = def.notes.length;
    for (let i = 0; i < n; i++) {
      const pan = n > 1 ? (i / (n - 1) - 0.5) * 0.5 : 0;   // notes drift gently across the stereo field
      pluck(def.notes[i], def.peak, def.decay, i * def.gap, { pan: pan, cents: cents(4), echo: !!def.echo });
    }
  }

  /** §7.1 blink gate: running, focused, F > 0.7, ≥ 4 s since the last pluck, P = 0.35 + 0.5 D. */
  function blinkAllowed(nowMs) {
    if (params.phase !== 'running' || params.state !== 'focused') return false;
    const F = num01(params.focus, 0), D = num01(params.depth, 0);
    if (!(F > 0.7)) return false;
    if (nowMs - lastPluckAt < BLINK_MIN_GAP_MS) return false;
    return Math.random() < 0.35 + 0.5 * D;
  }

  function revive(tau) {
    stopped = false;
    stopGroup = null;
    applyMaster(tau);
    applyScape();
  }

  /* ------------------------------------------------------------------ *
   * Context lifecycle                                                   *
   * ------------------------------------------------------------------ */
  function resetGraphRefs() {
    g = null; scape = null; space = null; echo = null; noiseBuf = null; lastScape = null;
    if (scapeKill) { clearTimeout(scapeKill); scapeKill = 0; }
    voices.clear();
  }

  function onStateChange() {
    if (ctx && ctx.state === 'running') {
      everRunning = true;
      applyAll();
    }
  }

  /** iOS / older Safari only fully unlock after something is started inside the gesture. */
  function primeSilence() {
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.onended = function () { safeDisconnect(src); };
      src.start(0);
    } catch (e) { /* ignore */ }
  }

  function unlock() {
    const C = Ctor();
    if (!C) return Promise.resolve(false);
    try {
      if (ctx && ctx.state === 'closed') { ctx = null; resetGraphRefs(); }
      if (!ctx) {
        try { ctx = new C({ latencyHint: 'interactive' }); }
        catch (e) { ctx = new C(); }
        buildMaster();
        try { ctx.onstatechange = onStateChange; } catch (e) { /* ignore */ }
      }
      primeSilence();
      let p = null;
      if (ctx.state !== 'running') {
        try { p = ctx.resume(); } catch (e) { p = null; }
      }
      applyAll(); // schedule targets now; they take effect as soon as the context runs

      const settle = function () {
        const ok = !!ctx && ctx.state === 'running';
        if (ok && !everRunning) { everRunning = true; applyAll(); }
        return ok;
      };
      if (!p || typeof p.then !== 'function') return Promise.resolve(settle());
      const timeout = new Promise(function (resolve) { setTimeout(resolve, 1500); });
      return Promise.race([p.then(settle, settle), timeout.then(settle)]);
    } catch (e) {
      console.warn(LOG, 'unlock failed:', e);
      return Promise.resolve(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * Public API (§4.6)                                                   *
   * ------------------------------------------------------------------ */
  FT.Audio = {
    /** Creates no AudioContext. Idempotent. */
    init() {
      initDone = true;
    },

    /** Call synchronously inside a user-gesture handler. Resolves true when the context runs. */
    unlock: unlock,

    /** {enabled, soundscape, chimes, volume, nudge} — any subset. */
    setOptions(o) {
      if (!o || typeof o !== 'object') return;
      const wasEnabled = opts.enabled;
      if (o.enabled !== undefined) opts.enabled = !!o.enabled;
      if (o.soundscape !== undefined) opts.soundscape = !!o.soundscape;
      if (o.chimes !== undefined) opts.chimes = !!o.chimes;
      if (o.nudge !== undefined) opts.nudge = !!o.nudge;
      if (o.volume !== undefined && isFinite(+o.volume)) opts.volume = U.clamp01(+o.volume);
      if (opts.enabled && !wasEnabled) { stopped = false; stopGroup = null; }
      if (!ctx || !g) return;
      if (opts.enabled && ctx.state === 'suspended' && everRunning) {
        // Best effort; a gesture-bound unlock() from app.js is the reliable path.
        try { const r = ctx.resume(); if (r && r.catch) r.catch(function () { /* ignore */ }); } catch (e) { /* ignore */ }
      }
      applyAll();
    },

    /** {phase, state, cause, focus, depth, drowsiness}; called at most 10 Hz. */
    update(p) {
      if (p && typeof p === 'object') {
        for (const k of PARAM_KEYS) if (p[k] !== undefined) params[k] = p[k];
        // SPEC-GAP: "the next update() brings it back" — interpreted as: an update in an active
        // phase (running/paused/break), or in a different phase group than the one stopAll() ran in.
        // This keeps the summary quiet after the Fruiting (§4.8.4 step 7) even if app.js keeps updating.
        if (stopped && p.phase !== undefined &&
            (ACTIVE_PHASES.has(p.phase) || phaseGroup(p.phase) !== stopGroup)) {
          stopped = false;
          stopGroup = null;
        }
      }
      if (!ctx || !g) return;
      applyMaster(MASTER_TAU);
      applyScape();
    },

    /** One-shot sounds (§7.1). Silently ignored when disabled, not running, or rate-limited. */
    play(name, o) {
      if (!ctx || !g || ctx.state !== 'running' || !opts.enabled) return;
      const isNudge = name === 'nudge';
      if (isNudge ? !opts.nudge : !opts.chimes) return;
      const def = Object.prototype.hasOwnProperty.call(CHIMES, name) ? CHIMES[name] : null;
      if (!isNudge && name !== 'blink' && name !== 'seed' && !def) return;
      if (voices.size >= MAX_VOICES) return;

      const nowMs = performance.now();
      if (name === 'blink') {
        if (!blinkAllowed(nowMs)) return;
      } else if (name === 'return') {
        if (nowMs - lastReturnAt < RETURN_MIN_GAP_MS) return;
      }

      if (stopped) revive(REVIVE_TAU);

      try {
        if (name === 'blink') {
          // Random walk of ±1 step, reflected at the ends of the scale.
          pentaIdx += Math.random() < 0.5 ? -1 : 1;
          if (pentaIdx < 0) pentaIdx = 1;
          if (pentaIdx > PENTA.length - 1) pentaIdx = PENTA.length - 2;
          lastPluckAt = nowMs;
          pluck(PENTA[pentaIdx], 0.05, 1.6, 0, { pan: (Math.random() - 0.5) * 0.7, cents: cents(3) });
        } else if (name === 'seed') {
          const raw = o && isNum(+o.index) ? Math.floor(+o.index) : 0;
          const i = ((raw % PENTA.length) + PENTA.length) % PENTA.length;
          pluck(PENTA[i], 0.04, 1.8, 0, { pan: SEED_PAN[raw] || 0, cents: cents(2) });
        } else if (isNudge) {
          nudgeTone();
        } else {
          if (name === 'return') lastReturnAt = nowMs;
          sequence(def);
        }
      } catch (e) {
        console.warn(LOG, 'play("' + name + '") failed:', e);
      }
    },

    /** Fade the master to 0 over ~300 ms. The next qualifying update() or play() brings it back. */
    stopAll() {
      stopped = true;
      stopGroup = phaseGroup(params.phase);
      if (!ctx || !g) return;
      glide(g.master.gain, 0, STOP_TAU);
      releaseScape();
      const mark = performance.now();
      setTimeout(function () {
        if (!stopped) return;
        for (const v of Array.from(voices)) if (v.born <= mark) killVoice(v);
      }, 400);
    },

    /** True once the context has run at least once. */
    get unlocked() { return !!ctx && everRunning; },
    /** True while the AudioContext is running. */
    get running() { return !!ctx && ctx.state === 'running'; },
    /** Optional (debug): whether init() ran and how many voices are live. */
    get initialized() { return initDone; },
    get voices() { return voices.size; },
  };
})();
