/*!
 * Hypha — js/keepsake.js  (FT.Keepsake)
 * SPEC §4.7 (API) and §8 (composition). Renders a 1080×1350 specimen poster on an offscreen
 * canvas from numbers only (seed + timeline): it never contains camera pixels.
 *
 * Depends on core (FT.util, FT.codec, FT.analyze, FT.PALETTE) and, guarded, on
 * FT.Visual.drawSpecimen. Does not depend on FT.Session (it keeps its own copy of the label rule).
 */
(function () {
  'use strict';
  const FT = window.FT, U = FT.util;
  const P = FT.PALETTE;
  const LOG = '[Hypha:keepsake]';

  /* ------------------------------------------------------------------ *
   * Constants (§8)                                                      *
   * ------------------------------------------------------------------ */
  const W0 = 1080, H0 = 1350;          // design size; other sizes scale uniformly
  const CX = 540, CY = 590;            // dish centre
  const TAU = Math.PI * 2;
  const TOP = -Math.PI / 2;            // 12 o'clock
  const DEG = Math.PI / 180;
  // Non-ASCII glyphs built from code points so the file is encoding-proof.
  const DASH = String.fromCharCode(0x2014);            // em dash
  const DOT = ' ' + String.fromCharCode(0x00B7) + ' '; // " middle-dot "
  const EN = String.fromCharCode(0x2013);              // en dash (time ranges)

  const DISPLAY = '"Fraunces", "Iowan Old Style", Georgia, serif';
  const UI = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace';

  const FONT_FACES = [
    'italic 300 60px Fraunces',
    '500 20px "IBM Plex Mono"',
    '400 22px "IBM Plex Mono"',
    '600 14px "Instrument Sans"',
    '400 16px "Instrument Sans"',
  ];
  const FONT_TIMEOUT_MS = 1500;
  const REVOKE_MS = 10000;

  // Timeline ring colours (§8.4): code -> [palette key, alpha]
  const RING_STYLE = {
    F: ['hypha', 0.95], W: ['hyphaDim', 0.9], K: ['hyphaDim', 0.6], M: ['hyphaDim', 0.8],
    T: ['scar', 1], G: ['scar', 1], D: ['scar', 1], U: ['scar', 1], X: ['scar', 1],
    E: ['amber', 1], A: ['frost', 1], N: ['unseen', 1],
  };
  const RING_R = 417, RING_W = 14;

  /* ------------------------------------------------------------------ *
   * Helpers                                                             *
   * ------------------------------------------------------------------ */
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const col = (name, a) => U.rgba(U.hexToRgb(P[name] || name), a == null ? 1 : a);
  const pad3 = (n) => {
    const v = +n;
    return String(isNum(v) ? Math.max(0, Math.floor(v)) : 0).padStart(3, '0');
  };
  const dur = (ms) => (isNum(ms) ? U.fmtDuration(ms) : DASH);
  const pct = (x) => (isNum(x) ? U.fmtPercent(x) : DASH);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function mkErr(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function timelineOf(record) {
    const tl = record && record.timeline;
    return tl && typeof tl.s === 'string' ? tl : null;
  }

  function seedOf(record) {
    return isNum(record.seed) ? record.seed >>> 0 : U.hashString(String(record.id || 'hypha'));
  }

  /**
   * Everything the poster prints, preferring the saved `stats` and falling back to
   * FT.analyze(timeline) for older or partial records.
   * SPEC-GAP: "measured" (label rule, §2.4.8) is taken as `stats.focusPct !== null`, which the spec
   * defines as "nothing is measured" (timer-only, or fewer than 30 measured seconds).
   */
  function metricsOf(record) {
    const st = (record && record.stats) || {};
    const tl = timelineOf(record);
    let an; // lazily computed fallback analysis
    const analysis = () => {
      if (an === undefined) {
        an = null;
        if (tl) { try { an = FT.analyze(tl); } catch (e) { an = null; } }
      }
      return an;
    };
    const pick = (v, fromAnalysis) => {
      if (isNum(v)) return v;
      const a = analysis();
      return a ? fromAnalysis(a) : null;
    };

    let focusPct;
    if (Object.prototype.hasOwnProperty.call(st, 'focusPct')) focusPct = isNum(st.focusPct) ? st.focusPct : null;
    else focusPct = analysis() ? analysis().focusPct : null;
    if (record && record.source === 'none') focusPct = null;

    const activeMs = isNum(record && record.activeMs) ? record.activeMs : (tl ? tl.s.length * 1000 : 0);
    return {
      measured: isNum(focusPct),
      focusPct: focusPct,
      activeMs: activeMs,
      heldMs: pick(st.heldMs, (a) => a.heldSec * 1000),
      longestStreakMs: pick(st.longestStreakMs, (a) => a.longestStreak * 1000),
      returns: pick(st.returns, (a) => a.returns),
      distractions: pick(st.distractions, (a) => a.distractions) || 0,
      mended: pick(st.mended, (a) => a.mended) || 0,
      peakDepth: pick(st.peakDepth, (a) => a.peakDepth),
      analysis: analysis,
    };
  }

  /**
   * The label rule (§2.4.8) — Keepsake's own copy (it must not depend on Session).
   * "No. 047 · 52 min · 91% held · 3 scars · 3 mended", or "… · timer only"; prefix "DEMO · " for sim.
   */
  function labelParts(record, m) {
    m = m || metricsOf(record);
    const parts = ['No. ' + pad3(record.no), Math.round(m.activeMs / 60000) + ' min'];
    if (m.measured) {
      parts.push(U.fmtPercent(m.focusPct) + ' held');
      const d = Math.max(0, Math.round(m.distractions));
      parts.push(d === 0 ? 'no scars' : d === 1 ? '1 scar' : d + ' scars');
      if (m.mended > 0) parts.push(Math.round(m.mended) + ' mended');
    } else {
      parts.push('timer only');
    }
    return { demo: record.source === 'sim', text: parts.join(DOT) };
  }
  function labelFor(record) {
    record = record || {};
    const l = labelParts(record);
    return (l.demo ? 'DEMO' + DOT : '') + l.text;
  }

  /** Shrink a font (in px) until `text` fits `maxW`. `make(px)` returns the font string. */
  function fitFont(ctx, text, maxW, make, size, minSize) {
    ctx.font = make(size);
    const w = ctx.measureText(text).width;
    if (w > maxW && w > 0) {
      const px = Math.max(minSize, Math.floor(size * maxW / w));
      ctx.font = make(px);
    }
  }

  /**
   * Letter-spaced text. Uses ctx.letterSpacing where supported (compensating the trailing
   * spacing so alignment is exact), otherwise draws character by character.
   */
  function spaced(ctx, text, x, y, spacing, align) {
    if (!spacing) { ctx.textAlign = align; ctx.fillText(text, x, y); return; }
    if ('letterSpacing' in ctx) {
      const prev = ctx.letterSpacing;
      ctx.letterSpacing = spacing + 'px';
      if (ctx.letterSpacing && ctx.letterSpacing !== '0px') {
        ctx.textAlign = align;
        const shift = align === 'center' ? spacing / 2 : align === 'right' ? spacing : 0;
        ctx.fillText(text, x + shift, y);
        ctx.letterSpacing = prev || '0px';
        return;
      }
      ctx.letterSpacing = prev || '0px';
    }
    const chars = Array.from(text);
    const widths = chars.map((c) => ctx.measureText(c).width);
    let total = spacing * Math.max(0, chars.length - 1);
    for (const w of widths) total += w;
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    ctx.textAlign = 'left';
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], cx, y);
      cx += widths[i] + spacing;
    }
  }

  function dateLine(record) {
    const s = record.startedAt;
    if (!isNum(s)) return '';
    const start = new Date(s);
    let day, range;
    try {
      day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(start);
    } catch (e) { day = U.dayKey(start); }
    try {
      const tf = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
      if (isNum(record.endedAt) && record.endedAt > s) {
        const end = new Date(record.endedAt);
        const a = tf.format(start), b = tf.format(end);
        range = a + EN + b;
        // "9:14 AM–10:06 AM" -> "9:14–10:06 AM" when the locale repeats the same suffix.
        const sa = a.match(/\s*\D+$/), sb = b.match(/\s*\D+$/);
        if (sa && sb && sa[0] === sb[0] && U.dayKey(start) === U.dayKey(end)) {
          range = a.slice(0, a.length - sa[0].length) + EN + b;
        }
      } else {
        range = tf.format(start);
      }
    } catch (e) {
      range = U.pad2(start.getHours()) + ':' + U.pad2(start.getMinutes());
    }
    return day + DOT + range;
  }

  /* ------------------------------------------------------------------ *
   * Composition (§8, drawn in design space 1080×1350)                   *
   * ------------------------------------------------------------------ */
  function drawBackground(ctx, seed, view) {
    ctx.save();
    // Glow behind the dish.
    let gr = ctx.createRadialGradient(CX, CY, 0, CX, CY, 620);
    gr.addColorStop(0, 'rgba(124,245,208,0.07)');
    gr.addColorStop(0.5, 'rgba(124,245,208,0.03)');
    gr.addColorStop(1, 'rgba(124,245,208,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(CX - 620, CY - 620, 1240, 1240);

    // Vignette: transparent inside r 520 around the centre, rgba(0,0,0,.6) at the corners.
    // Extended so that letterboxed (non-4:5) renders stay seamless to the canvas edge.
    const vx = W0 / 2, vy = H0 / 2, dc = Math.hypot(vx, vy);
    let far = dc;
    for (const px of [view.x, view.x + view.w]) {
      for (const py of [view.y, view.y + view.h]) far = Math.max(far, Math.hypot(px - vx, py - vy));
    }
    gr = ctx.createRadialGradient(vx, vy, 520, vx, vy, far);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(U.clamp01((dc - 520) / (far - 520)), 'rgba(0,0,0,0.6)');
    gr.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = gr;
    ctx.fillRect(view.x, view.y, view.w, view.h);

    // Grain: 3500 seeded 1 px dots.
    const rnd = U.rng(seed);
    ctx.fillStyle = 'rgba(207,230,223,0.035)';
    ctx.beginPath();
    for (let i = 0; i < 3500; i++) ctx.rect(Math.floor(rnd() * W0), Math.floor(rnd() * H0), 1, 1);
    ctx.fill();
    ctx.restore();
  }

  function drawHeader(ctx, record) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.font = '500 20px ' + MONO;
    ctx.fillStyle = P.muted;
    spaced(ctx, 'HYPHA' + DOT + 'SPECIMEN', 80, 92, 4, 'left');

    const no = 'No. ' + pad3(record.no);
    ctx.textAlign = 'right';
    ctx.fillStyle = P.text;
    ctx.fillText(no, 1000, 92);
    if (record.source === 'sim') {
      const w = ctx.measureText(no).width;
      ctx.fillStyle = P.amber;
      ctx.fillText('DEMO' + DOT, 1000 - w, 92);
    }

    ctx.fillStyle = 'rgba(207,230,223,0.12)';
    ctx.fillRect(80, 116, 920, 1);
    ctx.restore();
  }

  /** Fallback when FT.Visual is unavailable: a lone glowing spore. */
  function drawSpore(ctx) {
    const gr = ctx.createRadialGradient(CX, CY, 0, CX, CY, 80);
    gr.addColorStop(0, 'rgba(239,255,248,0.85)');
    gr.addColorStop(0.12, 'rgba(124,245,208,0.5)');
    gr.addColorStop(0.45, 'rgba(124,245,208,0.1)');
    gr.addColorStop(1, 'rgba(124,245,208,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(CX, CY, 80, 0, TAU); ctx.fill();
    ctx.fillStyle = P.core;
    ctx.beginPath(); ctx.arc(CX, CY, 12, 0, TAU); ctx.fill();
  }

  function drawDish(ctx, record) {
    ctx.save();
    // Glass disk.
    const gr = ctx.createRadialGradient(CX, CY, 0, CX, CY, 392);
    gr.addColorStop(0, '#0E1D20');
    gr.addColorStop(1, '#0A1517');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(CX, CY, 392, 0, TAU); ctx.fill();
    // Rim.
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(207,230,223,0.14)';
    ctx.stroke();
    // Glint (−150° → −100°), with a slightly brighter core.
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(239,255,248,0.25)';
    ctx.beginPath(); ctx.arc(CX, CY, 392, -150 * DEG, -100 * DEG); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(239,255,248,0.18)';
    ctx.beginPath(); ctx.arc(CX, CY, 392, -138 * DEG, -114 * DEG); ctx.stroke();
    ctx.restore();

    // The specimen itself, regrown deterministically from the record.
    let drew = false;
    if (FT.Visual && FT.Visual.drawSpecimen) {
      ctx.save();
      try {
        FT.Visual.drawSpecimen(ctx, record, CX, CY, 360, { quality: 'full', fruit: true, background: false });
        drew = true;
      } catch (e) {
        console.warn(LOG, 'drawSpecimen failed; drawing a spore instead.', e);
      }
      ctx.restore();
    }
    if (!drew) {
      ctx.save();
      drawSpore(ctx);
      ctx.restore();
    }
  }

  /** The session as a radial barcode: 360° = the whole session, clockwise from 12 o'clock. */
  function drawRing(ctx, record, m) {
    const tl = timelineOf(record);
    const s = tl ? tl.s : '';
    const n = s.length;
    ctx.save();
    ctx.lineCap = 'butt';

    // Track (always).
    ctx.lineWidth = RING_W;
    ctx.strokeStyle = col('line', 0.7);
    ctx.beginPath(); ctx.arc(CX, CY, RING_R, 0, TAU); ctx.stroke();
    if (n === 0) { ctx.restore(); return; }

    const k = TAU / n;
    const eps = n > 1 ? Math.min(0.0008, k * 0.25) : 0; // hide anti-aliasing seams between runs
    const runs = FT.codec.runs(s);
    // Group runs by code so each colour is one path (same-code runs are never adjacent).
    const byCode = new Map();
    for (const r of runs) {
      const code = RING_STYLE[r.code] ? r.code : 'N';
      let list = byCode.get(code);
      if (!list) { list = []; byCode.set(code, list); }
      list.push(r);
    }
    const arcPath = (list, radius, overlap) => {
      ctx.beginPath();
      for (const r of list) {
        const a0 = TOP + k * r.start;
        const a1 = TOP + k * (r.start + r.len) + (overlap && r.start + r.len < n ? eps : 0);
        ctx.moveTo(CX + radius * Math.cos(a0), CY + radius * Math.sin(a0));
        ctx.arc(CX, CY, radius, a0, a1);
      }
    };

    // Addition (not in §8): a faint luminous halo under held time, so focus reads as light.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 30;
    for (const code of ['F', 'W', 'K', 'M']) {
      const list = byCode.get(code);
      if (!list) continue;
      ctx.strokeStyle = col(RING_STYLE[code][0], code === 'F' ? 0.07 : 0.045);
      arcPath(list, RING_R, false);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Runs.
    ctx.lineWidth = RING_W;
    for (const [code, list] of byCode) {
      const st = RING_STYLE[code];
      ctx.strokeStyle = col(st[0], st[1]);
      arcPath(list, RING_R, true);
      ctx.stroke();
    }

    // Gaps (pauses and breaks): 2 px core radial ticks, r 404 → 430.
    const gaps = Array.isArray(record.gaps) ? record.gaps : [];
    if (gaps.length) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = P.core;
      ctx.beginPath();
      for (const gp of gaps) {
        if (!gp || !isNum(gp.at)) continue;
        const a = TOP + k * U.clamp(gp.at, 0, n);
        const c = Math.cos(a), si = Math.sin(a);
        ctx.moveTo(CX + 404 * c, CY + 404 * si);
        ctx.lineTo(CX + 430 * c, CY + 430 * si);
      }
      ctx.stroke();
    }

    // Addition (mirrors the summary strip, §2.4.8 item 4): a gold dot inside the ring for every
    // mended episode, centred on the scar it healed.
    let an = null;
    try { an = m && m.analysis ? m.analysis() : FT.analyze(tl); } catch (e) { an = null; }
    if (an && an.episodes && an.mended > 0) {
      ctx.fillStyle = col('gold', 0.95);
      ctx.beginPath();
      for (const e of an.episodes) {
        if (!e.mended) continue;
        const mid = (e.t0 + (e.t1 == null ? n : e.t1)) / 2;
        const a = TOP + k * mid;
        const x = CX + 400 * Math.cos(a), y = CY + 400 * Math.sin(a);
        ctx.moveTo(x + 2.5, y);
        ctx.arc(x, y, 2.5, 0, TAU);
      }
      ctx.fill();
    }

    // Minute ticks: every 300 s (r 432 → 438); every 1500 s the tick runs to r 444.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(207,230,223,0.25)';
    ctx.beginPath();
    for (let i = 0; i < n; i += 300) {
      const a = TOP + k * i;
      const r1 = i % 1500 === 0 ? 444 : 438;
      const c = Math.cos(a), si = Math.sin(a);
      ctx.moveTo(CX + 432 * c, CY + 432 * si);
      ctx.lineTo(CX + r1 * c, CY + r1 * si);
    }
    ctx.stroke();

    // Start marker: a small core triangle at the top, r 446–456, pointing at the ring.
    ctx.fillStyle = P.core;
    ctx.beginPath();
    ctx.moveTo(CX, CY - 446);
    ctx.lineTo(CX - 6, CY - 456);
    ctx.lineTo(CX + 6, CY - 456);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawTitle(ctx, record) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const name = String(record.name || 'Hypha');
    ctx.fillStyle = P.text;
    fitFont(ctx, name, 920, (px) => 'italic 300 ' + px + 'px ' + DISPLAY, 60, 34);
    ctx.fillText(name, CX, 1080);
    if (record.variety) {
      const variety = String(record.variety);
      ctx.fillStyle = P.muted;
      fitFont(ctx, variety, 920, (px) => 'italic 300 ' + px + 'px ' + DISPLAY, 30, 18);
      ctx.fillText(variety, CX, 1128);
    }
    ctx.restore();
  }

  function drawLabel(ctx, record, m) {
    const l = labelParts(record, m);
    const pre = l.demo ? 'DEMO' + DOT : '';
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    fitFont(ctx, pre + l.text, 920, (px) => '400 ' + px + 'px ' + MONO, 22, 13);
    if (!pre) {
      ctx.textAlign = 'center';
      ctx.fillStyle = P.text;
      ctx.fillText(l.text, CX, 1180);
    } else {
      // "DEMO · " in amber, the rest in text colour, centred together.
      const wPre = ctx.measureText(pre).width, wTxt = ctx.measureText(l.text).width;
      const x = CX - (wPre + wTxt) / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = P.amber;
      ctx.fillText(pre, x, 1180);
      ctx.fillStyle = P.text;
      ctx.fillText(l.text, x + wPre, 1180);
    }
    ctx.restore();
  }

  function drawStats(ctx, m) {
    const timerOnly = !m.measured;
    const cols = [
      { x: 180, cap: 'HELD', val: dur(m.heldMs), color: P.hypha },
      { x: 420, cap: 'LONGEST ROOT', val: dur(m.longestStreakMs), color: P.hypha },
      { x: 660, cap: 'RETURNS', val: !timerOnly && isNum(m.returns) ? String(Math.round(m.returns)) : DASH, color: P.gold },
      { x: 900, cap: 'PEAK DEPTH', val: timerOnly ? DASH : pct(m.peakDepth), color: P.hypha },
    ];
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    for (const c of cols) {
      ctx.font = '500 36px ' + MONO;
      ctx.textAlign = 'center';
      // SPEC-GAP: the colour of an unmeasured "—" value is unspecified; it is drawn muted.
      ctx.fillStyle = c.val === DASH ? P.muted : c.color;
      ctx.fillText(c.val, c.x, 1252);
      ctx.font = '600 14px ' + UI;
      ctx.fillStyle = P.muted;
      spaced(ctx, c.cap, c.x, 1282, 2, 'center');
    }
    ctx.restore();
  }

  function drawFooter(ctx, record) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = P.muted;
    const line = dateLine(record);
    if (line) {
      ctx.textAlign = 'left';
      fitFont(ctx, line, 560, (px) => '400 ' + px + 'px ' + MONO, 16, 11);
      ctx.fillText(line, 80, 1322);
    }
    ctx.textAlign = 'right';
    ctx.font = '400 16px ' + UI;
    ctx.fillText('grown on-device' + DOT + 'no images recorded', 1000, 1322);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * Public operations                                                   *
   * ------------------------------------------------------------------ */
  let fontsSettled = false;

  /** Resolves once the §8 faces have loaded, or after 1500 ms. Never rejects. */
  function ready() {
    if (fontsSettled) return Promise.resolve();
    const fonts = document.fonts;
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
    let all;
    try {
      all = Promise.all(FONT_FACES.map((f) => fonts.load(f).then((r) => r, () => null)));
    } catch (e) {
      return Promise.resolve();
    }
    const done = all.then((res) => {
      if (res.every((r) => r && r.length)) fontsSettled = true;
    });
    return Promise.race([done, sleep(FONT_TIMEOUT_MS)]).then(() => undefined, () => undefined);
  }

  /** Synchronous. Returns a canvas with the full composition, scaled uniformly for other sizes. */
  function render(record, o) {
    record = record || {};
    const width = Math.max(1, Math.round((o && +o.width) || W0));
    const height = Math.max(1, Math.round((o && +o.height) || H0));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw mkErr('NoCanvas', 'This browser cannot draw the keepsake.');

    const s = Math.min(width / W0, height / H0);
    const ox = (width - W0 * s) / 2, oy = (height - H0 * s) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = P.abyss;
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(s, 0, 0, s, ox, oy);
    const view = { x: -ox / s, y: -oy / s, w: width / s, h: height / s };

    const m = metricsOf(record);
    drawBackground(ctx, seedOf(record), view);
    drawHeader(ctx, record);
    drawDish(ctx, record);
    drawRing(ctx, record, m);
    drawTitle(ctx, record);
    drawLabel(ctx, record, m);
    drawStats(ctx, m);
    drawFooter(ctx, record);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  function dataUrlToBlob(url) {
    const comma = url.indexOf(',');
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  /** Promise<Blob> of type image/png. */
  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(mkErr('EncodeFailed', 'The keepsake image could not be encoded.'));
          }, 'image/png');
          return;
        }
        resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
      } catch (e) {
        reject(e);
      }
    });
  }

  /** e.g. "hypha-no047-2026-09-28.png" (local day of startedAt). */
  function filename(record) {
    record = record || {};
    const day = U.dayKey(isNum(record.startedAt) ? record.startedAt : Date.now());
    return 'hypha-no' + pad3(record.no) + '-' + day + '.png';
  }

  function release(canvas) {
    // Free the backing store promptly (Safari caps total canvas memory).
    try { canvas.width = 0; canvas.height = 0; } catch (e) { /* ignore */ }
  }

  /** ready → render → toBlob → temporary <a download> click; the object URL is revoked after 10 s. */
  async function download(record) {
    await ready();
    const canvas = render(record);
    let blob;
    try { blob = await toBlob(canvas); }
    finally { release(canvas); }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename(record);
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    try {
      a.click();
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
    }
  }

  /** COULD: Web Share with the PNG attached. Resolves false when unsupported or cancelled. */
  async function share(record) {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' ||
          typeof navigator.canShare !== 'function' || typeof File !== 'function') return false;
      record = record || {};
      await ready();
      const canvas = render(record);
      let blob;
      try { blob = await toBlob(canvas); }
      finally { release(canvas); }
      const file = new File([blob], filename(record), { type: 'image/png' });
      const data = { files: [file], title: String(record.name || 'Hypha'), text: labelFor(record) };
      if (!navigator.canShare(data)) return false;
      await navigator.share(data);
      return true;
    } catch (e) {
      if (!e || e.name !== 'AbortError') console.warn(LOG, 'share failed:', e);
      return false;
    }
  }

  FT.Keepsake = {
    ready: ready,
    render: render,
    toBlob: toBlob,
    download: download,
    share: share,
    filename: filename,
    /** Optional: the label rule text used on the poster (§2.4.8). */
    label: labelFor,
  };
})();
