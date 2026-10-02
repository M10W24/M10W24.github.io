/*!
 * Focus Tracker — js/visual.js  (FT.Visual)
 * Draws the progress ring on #stage: round progress, the current focus state as colour, and the
 * session's focus % in the middle. Also draws calibration targets, the loading ring, the
 * pop-out mini ring and the per-session timeline ring used by history and saved images.
 * Classic script (defer). Never touches the DOM except the canvases handed to it.
 * drawSpecimen never reads Math.random, Date or performance, so a record always draws the same.
 */
(function () {
  'use strict';
  const FT = window.FT, U = FT.util;

  const TAU = Math.PI * 2, TOP = -Math.PI / 2;
  const LOG = '[Focus:visual]';
  const P = FT.PALETTE;
  const RGB = {};
  for (const k in P) RGB[k] = U.hexToRgb(P[k]);
  const clamp01 = U.clamp01;
  const fin = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const easeOut = (t) => { t = clamp01(t); const u = 1 - t; return 1 - u * u * u; };
  const UI_FONT = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // [desktop cy/H, desktop r/R_full, phone cy/H, phone r/R_full]. Panels in style.css are placed
  // with the same formulas, so the ring always sits in the space they leave free.
  const LAYOUT = {
    intro:       [0.40, 0.80, 0.30, 0.80],
    idle:        [0.24, 0.50, 0.18, 0.50],
    loading:     [0.40, 0.60, 0.32, 0.60],
    calibrating: [0.50, 0.90, 0.50, 0.90],
    running:     [0.44, 1.00, 0.36, 1.00],
    complete:    [0.26, 0.60, 0.20, 0.52],
  };

  /** Ring colour for each timeline code (history thumbnails, summary ring, saved images). */
  const CODE_COLOR = {
    F: 'hypha', W: 'hyphaDim', K: 'hyphaDim', M: 'hyphaDim',
    T: 'scar', G: 'scar', D: 'scar', U: 'scar', X: 'scar',
    E: 'amber', A: 'frost', N: 'unseen',
  };

  let canvas = null, ctx = null, initialised = false, errLogged = false;
  let W = 0, H = 0, dpr = 1, BW = 0, BH = 0, phone = false, Rfull = 0, sized = false;
  let resizeTimer = 0;
  let rm = false;

  const I = {
    now: 0, phase: 'idle', state: 'none', focus: 0.75, rimProgress: null, breakProgress: 0,
    loading: null, calibration: null, sessionFocus: null, measured: true, today: null, demo: false,
  };
  const lay = { cx: 0, cy: 0, r: 0 };
  let laySnapped = false;
  let lastNow = 0;
  let col = RGB.hypha.slice();     // smoothed ring colour
  let prog = 0;                    // smoothed arc progress
  let flashes = [];                // {t0, rgb}
  let fruit = null;                // { t0, resolve, timer, record }
  let doneRecord = null;           // the last finished session, drawn on the summary screen
  let fps = 0, lastFrameAt = 0;

  /* ------------------------------------------------------------------ *
   * Sizing                                                              *
   * ------------------------------------------------------------------ */
  function measure() {
    let w = canvas ? canvas.clientWidth : 0, h = canvas ? canvas.clientHeight : 0;
    if (!(w > 0) || !(h > 0)) { w = window.innerWidth || 800; h = window.innerHeight || 600; }
    return [Math.max(1, w), Math.max(1, h)];
  }
  function resize(force) {
    if (!canvas || !ctx) return;
    const m = measure(), d = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    if (!force && sized && m[0] === W && m[1] === H && d === dpr) return;
    W = m[0]; H = m[1]; dpr = d;
    BW = Math.max(1, Math.round(W * dpr)); BH = Math.max(1, Math.round(H * dpr));
    canvas.width = BW; canvas.height = BH;
    phone = W < 640;
    Rfull = Math.max(8, phone ? Math.min(0.44 * W, 0.27 * H) : Math.min(0.34 * H, 0.3 * W));
    sized = true;
    laySnapped = false;
  }
  function scheduleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = 0; try { resize(false); } catch (e) { console.warn(LOG, 'resize failed', e); } }, 100);
  }
  function layoutKey() {
    const ph = I.phase;
    if (ph === 'paused' || ph === 'break' || ph === 'fruiting') return 'running';
    return LAYOUT[ph] ? ph : 'idle';
  }
  function updateLayout(dt) {
    const row = LAYOUT[layoutKey()];
    const ty = (phone ? row[2] : row[0]) * H, tr = (phone ? row[3] : row[1]) * Rfull;
    lay.cx = 0.5 * W;
    if (!laySnapped || rm) { lay.cy = ty; lay.r = tr; laySnapped = true; return; }
    lay.cy = U.damp(lay.cy, ty, 450, dt);
    lay.r = U.damp(lay.r, tr, 450, dt);
  }

  /* ------------------------------------------------------------------ *
   * State → colour, progress and centre text                            *
   * ------------------------------------------------------------------ */
  function stateColor(phase, state) {
    if (phase === 'paused') return RGB.muted;
    if (phase === 'break') return RGB.flow;
    if (phase === 'loading' || phase === 'calibrating') return RGB.hyphaDim;
    switch (state) {
      case 'focused': case 'forgiven': case 'unmeasured': case 'none': return RGB.hypha;
      case 'drifting': return RGB.hyphaDim;
      case 'away': return RGB.scar;
      case 'eyes-closed': return RGB.amber;
      case 'absent': return RGB.frost;
      case 'unseen': case 'calibrating': return RGB.muted;
      default: return RGB.hypha;
    }
  }
  function targetProgress() {
    switch (I.phase) {
      case 'running': case 'paused': return I.rimProgress == null ? 0 : clamp01(I.rimProgress);
      case 'break': return clamp01(I.breakProgress);
      case 'loading': return clamp01(fin(I.loading, 0));
      case 'intro': return I.demo ? 0.25 + 0.6 * clamp01(I.focus) : 0.7;
      case 'idle': {
        const t = I.today;
        return t && t.goalMs > 0 ? clamp01(t.heldMs / t.goalMs) : 0;
      }
      default: return 0;
    }
  }
  const pctText = (x) => Math.round(clamp01(x) * 100) + '%';
  function minutesText(ms) {
    const m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  /** [big, caption] for the middle of the ring, or null. */
  function centreText() {
    switch (I.phase) {
      case 'running':
        if (!I.measured) return ['Timer', 'tracking off'];
        return I.sessionFocus == null ? ['—', 'measuring…'] : [pctText(I.sessionFocus), 'focused'];
      case 'paused': return ['Paused', I.measured && I.sessionFocus != null ? pctText(I.sessionFocus) + ' focused' : ''];
      case 'break': return ['Break', 'rest your eyes'];
      case 'loading': return [pctText(fin(I.loading, 0)), 'loading'];
      case 'intro': return I.demo ? [pctText(I.focus), 'focus level'] : ['25:00', 'focus round'];
      case 'idle': {
        const t = I.today;
        if (!t) return null;
        return [minutesText(t.heldMs), 'of ' + minutesText(t.goalMs) + ' today'];
      }
      default: return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Drawing helpers                                                     *
   * ------------------------------------------------------------------ */
  function arc(g, x, y, r, a0, a1, width, style) {
    g.lineWidth = width;
    g.strokeStyle = style;
    g.beginPath();
    g.arc(x, y, Math.max(0.5, r), a0, a1);
    g.stroke();
  }
  function fitText(g, text, maxW, size, weight) {
    g.font = weight + ' ' + size + 'px ' + UI_FONT;
    const w = g.measureText(text).width;
    if (w > maxW && w > 0) g.font = weight + ' ' + Math.max(8, Math.floor(size * maxW / w)) + 'px ' + UI_FONT;
  }
  function drawCentre(g, x, y, r, big, cap, scale) {
    if (!big) return;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = P.text;
    fitText(g, big, r * 1.3, Math.round(r * 0.36), 600);
    g.fillText(big, x, y - (cap ? r * 0.06 : 0));
    if (cap && r >= 40 * scale) {
      g.fillStyle = P.muted;
      fitText(g, cap, r * 1.4, Math.max(10 * scale, Math.round(r * 0.11)), 500);
      g.fillText(cap, x, y + r * 0.26);
    }
  }
  /** The ring: track, progress arc and centre text. Shared by the stage and the pop-out. */
  function drawRing(g, x, y, r, p, rgb, text, scale) {
    const w = Math.max(3 * scale, r * 0.075);
    g.lineCap = 'round';
    arc(g, x, y, r, 0, TAU, w, 'rgba(207,230,223,0.08)');
    if (p > 0.002) {
      g.save();
      if (!rm) { g.shadowColor = U.rgba(rgb, 0.45); g.shadowBlur = 14 * scale; }
      arc(g, x, y, r, TOP, TOP + TAU * Math.min(p, 0.9999), w, U.rgba(rgb, 1));
      g.restore();
    }
    if (text) drawCentre(g, x, y, r, text[0], text[1], scale);
  }

  function drawFlashes(now) {
    for (let k = flashes.length - 1; k >= 0; k--) {
      const f = flashes[k], t = (now - f.t0) / 800;
      if (t >= 1 || t < 0) { if (t >= 1) flashes.splice(k, 1); continue; }
      const r = lay.r * 0.86 * (1 + 0.12 * easeOut(t));
      ctx.lineCap = 'round';
      arc(ctx, lay.cx * dpr, lay.cy * dpr, r * dpr, 0, TAU, 2 * dpr, U.rgba(f.rgb, 0.5 * (1 - t)));
    }
  }

  function drawCalibration(now) {
    const cal = I.calibration;
    if (!cal || !Array.isArray(cal.points)) return;
    const activeIndex = fin(+cal.activeIndex, -1);
    const progress = clamp01(fin(+cal.activeProgress, 0));
    const dim = cal.faceFound === false ? 0.45 : 1;
    ctx.lineCap = 'round';
    for (let k = 0; k < cal.points.length; k++) {
      const p = cal.points[k];
      if (!p) continue;
      const x = clamp01(fin(+p.x, 0.5)) * BW, y = clamp01(fin(+p.y, 0.5)) * BH;
      if (p.state === 'done') {
        ctx.fillStyle = U.rgba(RGB.hypha, 0.9);
        ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, TAU); ctx.fill();
        ctx.strokeStyle = P.abyss; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x - 3.2 * dpr, y + 0.2 * dpr); ctx.lineTo(x - 0.8 * dpr, y + 2.6 * dpr); ctx.lineTo(x + 3.4 * dpr, y - 2.4 * dpr);
        ctx.stroke();
      } else if (p.state === 'active' || k === activeIndex) {
        const pulse = rm ? 1 : 1 + 0.12 * Math.sin((TAU * now) / 1000);
        ctx.globalAlpha = dim;
        ctx.fillStyle = P.core;
        ctx.beginPath(); ctx.arc(x, y, 6 * dpr * pulse, 0, TAU); ctx.fill();
        arc(ctx, x, y, 18 * dpr, 0, TAU, 1.5 * dpr, 'rgba(207,230,223,0.18)');
        if (progress > 0.001) arc(ctx, x, y, 18 * dpr, TOP, TOP + TAU * progress, 2.5 * dpr, P.hypha);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = 'rgba(207,230,223,0.3)';
        ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, TAU); ctx.fill();
      }
    }
  }

  function finishFruit() {
    const f = fruit;
    if (!f) return;
    fruit = null;
    clearTimeout(f.timer);
    try { f.resolve(); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Frame                                                               *
   * ------------------------------------------------------------------ */
  function readInput(inp) {
    inp = inp || {};
    I.now = fin(inp.now, performance.now());
    I.phase = typeof inp.phase === 'string' ? inp.phase : 'idle';
    I.state = typeof inp.state === 'string' ? inp.state : 'none';
    I.focus = clamp01(fin(inp.focus, 0.75));
    I.rimProgress = inp.rimProgress == null ? null : clamp01(fin(+inp.rimProgress, 0));
    I.breakProgress = clamp01(fin(+inp.breakProgress, 0));
    I.loading = inp.loading == null ? null : clamp01(fin(+inp.loading, 0));
    I.calibration = inp.calibration && typeof inp.calibration === 'object' ? inp.calibration : null;
    I.sessionFocus = inp.sessionFocus == null || !isFinite(+inp.sessionFocus) ? null : clamp01(+inp.sessionFocus);
    I.measured = inp.measured !== false;
    I.today = inp.today && typeof inp.today === 'object' ? inp.today : null;
    I.demo = !!inp.demo;
  }

  function frame(inp) {
    readInput(inp);
    const now = I.now;
    const dt = lastNow ? Math.min(1000, Math.max(0, now - lastNow)) : 16; // real dt, so damping holds at low frame rates
    lastNow = now;
    if (lastFrameAt) fps = U.damp(fps, 1000 / Math.max(1, now - lastFrameAt), 500, dt);
    lastFrameAt = now;
    if (!sized) resize(true);
    updateLayout(dt);

    // Smooth colour and progress (snap when a new round restarts the arc).
    const tc = stateColor(I.phase, I.state);
    for (let k = 0; k < 3; k++) col[k] = rm ? tc[k] : U.damp(col[k], tc[k], 350, dt);
    const tp = targetProgress();
    prog = rm || tp < prog - 0.3 ? tp : U.damp(prog, tp, 400, dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = P.abyss;
    ctx.fillRect(0, 0, BW, BH);

    const x = lay.cx * dpr, y = lay.cy * dpr, r = lay.r * 0.86 * dpr;
    const ph = I.phase;

    if (ph === 'calibrating') { drawCalibration(now); return; }

    // Soft glow behind the ring in the current state colour.
    if (r > 4) {
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.5);
      g.addColorStop(0, U.rgba(col, 0.07));
      g.addColorStop(1, U.rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 1.5, y - r * 1.5, r * 3, r * 3);
    }

    if (ph === 'fruiting' && fruit) {
      if (fruit.t0 == null) fruit.t0 = now;
      const t = rm ? 1 : clamp01((now - fruit.t0) / 1100);
      const st = (fruit.record && fruit.record.stats) || {};
      const fp = fruit.record && fruit.record.source !== 'none' ? st.focusPct : null;
      drawRing(ctx, x, y, r, prog + (1 - prog) * easeOut(t), RGB.hypha,
        [fp == null || !isFinite(fp) ? 'Done' : pctText(fp), fp == null || !isFinite(fp) ? 'session complete' : 'focused'], dpr);
      if (t >= 1 && now - fruit.t0 > (rm ? 200 : 1500)) finishFruit();
      return;
    }
    if (ph === 'complete' || ph === 'fruiting') {
      if (doneRecord) drawSpecimen(ctx, doneRecord, x, y, r * 1.08, { quality: 'full', background: false });
      return;
    }

    drawRing(ctx, x, y, r, prog, col, centreText(), dpr);
    drawFlashes(now);
  }

  /* ------------------------------------------------------------------ *
   * Session ring for a saved record (history, summary, images)          *
   * ------------------------------------------------------------------ */
  /**
   * The session as a ring: 360° = the whole session, clockwise from 12 o'clock, each second
   * coloured by what attention was doing. The session's focus % sits in the middle.
   */
  function drawSpecimen(g, record, cx, cy, R, opts) {
    if (!g || !(R > 0)) return;
    opts = opts || {};
    record = record || {};
    const thumb = opts.quality === 'thumb';
    const tl = record.timeline && typeof record.timeline.s === 'string' ? record.timeline : null;
    const s = tl ? tl.s : '';
    const n = s.length;
    const rr = R * 0.84, w = Math.max(2, R * (thumb ? 0.2 : 0.11));
    g.save();
    try {
      if (opts.background) {
        g.fillStyle = P.dish;
        g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
      }
      g.lineCap = 'butt';
      arc(g, cx, cy, rr, 0, TAU, w, U.rgba(RGB.line, 0.9));
      if (n > 0) {
        const k = TAU / n;
        const eps = n > 1 ? Math.min(0.004, k * 0.25) : 0;
        const byColor = new Map();
        for (const run of FT.codec.runs(s)) {
          const key = CODE_COLOR[run.code] || 'unseen';
          let list = byColor.get(key);
          if (!list) { list = []; byColor.set(key, list); }
          list.push(run);
        }
        g.lineWidth = w;
        for (const [key, list] of byColor) {
          g.strokeStyle = P[key] || P.unseen;
          g.beginPath();
          for (const run of list) {
            const a0 = TOP + k * run.start;
            const a1 = TOP + k * (run.start + run.len) + (run.start + run.len < n ? eps : 0);
            g.moveTo(cx + rr * Math.cos(a0), cy + rr * Math.sin(a0));
            g.arc(cx, cy, rr, a0, a1);
          }
          g.stroke();
        }
      }
      if (opts.label !== false) {
        const st = record.stats || {};
        const fp = record.source === 'none' ? null : st.focusPct;
        const measured = fp != null && isFinite(fp);
        const big = measured ? pctText(fp) : (thumb ? '—' : 'Timer');
        const cap = thumb ? '' : measured ? 'focused' : 'timer only';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = P.text;
        fitText(g, big, rr * 1.3, Math.round(R * (thumb ? 0.4 : 0.32)), 600);
        g.fillText(big, cx, cy - (cap ? R * 0.05 : 0));
        if (cap && R >= 50) {
          g.fillStyle = P.muted;
          fitText(g, cap, rr * 1.4, Math.max(10, Math.round(R * 0.1)), 500);
          g.fillText(cap, cx, cy + R * 0.22);
        }
      }
    } finally {
      g.restore();
    }
  }

  /* =================================================================== *
   * Public API                                                           *
   * =================================================================== */
  FT.Visual = {
    init(cv) {
      if (!cv || typeof cv.getContext !== 'function') { console.warn(LOG, 'init(): no canvas'); return; }
      if (initialised && cv === canvas) return;
      const c = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      if (!c) { console.warn(LOG, 'init(): no 2d context'); return; }
      canvas = cv; ctx = c;
      if (!initialised) {
        window.addEventListener('resize', scheduleResize);
        window.addEventListener('orientationchange', scheduleResize);
      }
      initialised = true;
      sized = false;
      try { resize(true); } catch (err) { console.warn(LOG, 'initial sizing failed', err); }
    },

    update(input) {
      if (!ctx) return;
      try { frame(input); }
      catch (err) {
        if (!errLogged) { errLogged = true; console.error(LOG, 'frame failed', err); }
        try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; } catch (e) { /* ignore */ }
      }
    },

    pulse(kind) {
      const now = performance.now();
      if (rm) return;
      if (kind === 'return' || kind === 'welcome') flashes.push({ t0: now, rgb: RGB.hypha });
      else if (kind === 'milestone' || kind === 'calibrated') flashes.push({ t0: now, rgb: RGB.gold });
      while (flashes.length > 3) flashes.shift();
    },

    startFruiting(record) {
      finishFruit();
      doneRecord = record || null;
      return new Promise((resolve) => {
        const f = { t0: null, resolve: resolve, timer: 0, record: record || null };
        fruit = f;
        // Resolve even if frames stop (hidden tab).
        f.timer = setTimeout(() => { if (fruit === f) finishFruit(); }, rm ? 600 : 2500);
      });
    },
    skipFruiting() { finishFruit(); },

    setReducedMotion(b) { rm = !!b; if (rm) flashes = []; },
    setQuality() { /* one quality level */ },

    // Kept for app.js compatibility; the ring has no organism to grow.
    newOrganism() { flashes = []; },
    grow() {},
    prefill() {},
    forgive() {},

    getDish() { return { cx: lay.cx, cy: lay.cy, r: lay.r }; },
    getStats() { return { fps: Math.round(fps), dpr: dpr, quality: 'ring', nodes: 0, scars: 0 }; },

    drawMini(c2, size) {
      if (!c2 || !(size > 0)) return;
      c2.save();
      try {
        c2.setTransform(1, 0, 0, 1, 0, 0);
        c2.fillStyle = P.abyss;
        c2.fillRect(0, 0, size, size);
        const scale = size / 200;
        drawRing(c2, size / 2, size / 2, size * 0.4, prog, col, centreText(), Math.max(0.5, scale));
      } catch (err) {
        console.warn(LOG, 'drawMini failed', err);
      } finally {
        c2.restore();
      }
    },

    drawSpecimen: drawSpecimen,
  };
})();
