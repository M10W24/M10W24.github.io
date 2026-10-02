/*!
 * Focus Tracker — js/history.js  (FT.History — SPEC-ADDENDUM §C; SPEC §2.4.8, §2.4.9, §2.4.10, §4.4.7, §4.4.10, §4.7)
 * The summary sheet, the history screen, the session detail dialog, the erase dialog,
 * and the data export / import UI.
 * Classic script, loaded with `defer` after keepsake.js and before app.js. Nothing runs at load
 * time: FT.App.init() calls FT.History.init() in boot step 6. Every cross-module call
 * (FT.Session, FT.Visual, FT.Keepsake, FT.Detector, FT.App) is guarded.
 */
(function () {
  'use strict';

  const FT = window.FT, U = FT.util;

  /* =================================================================== *
   * Constants                                                            *
   * =================================================================== */
  const $ = (id) => document.getElementById(id);
  const LOG = '[Focus:history]';
  const TAU = Math.PI * 2;
  const P = FT.PALETTE;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DASH = '—';            // "—" in tiles that timer-only sessions can't measure
  const JAR_CSS = 72;               // jar thumbnail canvas size, CSS px (§2.4.9)
  const TYPE_MS = 28;               // specimen label typing speed, ms per character (§2.4.8)
  const DELETE_WINDOW_MS = 3000;    // jar "Tap again to delete" window (§2.4.10)
  const THUMB_CACHE_MAX = 160;
  const RATING_WORDS = ['', 'Scattered', 'Uneven', 'Steady', 'Deep', 'Flow'];
  const EASE_ORGANIC = 'cubic-bezier(.22,.61,.36,1)';

  /** §4.4.10 lookups; index = sector k (0 = right, clockwise on screen). */
  const COMPASS = [
    { name: 'right', clock: '3' },
    { name: 'down-right', clock: '4–5' },
    { name: 'down', clock: '6' },
    { name: 'down-left', clock: '7–8' },
    { name: 'left', clock: '9' },
    { name: 'up-left', clock: '10–11' },
    { name: 'up', clock: '12' },
    { name: 'up-right', clock: '1–2' },
  ];

  /** Containers that are hidden (with their section) while the terrarium is completely empty. */
  const CHART_HOSTS = ['chartDays', 'shelves', 'chartHeat', 'chartCompass', 'chartRecovery'];
  /** Charts whose SVG is laid out 1:1 in CSS px and re-rendered when their width changes. */
  const WIDTH_CHARTS = ['chartDays', 'chartHeat', 'chartRecovery'];

  /** CSS token name -> canonical hex (fallback inside var() so charts render even without CSS). */
  const TOKEN_FALLBACK = {
    abyss: P.abyss, dish: P.dish, line: P.line, hypha: P.hypha, 'hypha-dim': P.hyphaDim,
    flow: P.flow, core: P.core, gold: P.gold, amber: P.amber, frost: P.frost, scar: P.scar,
    text: P.text, muted: P.muted, unseen: P.unseen,
  };
  const tok = (name) => 'var(--' + name + ',' + (TOKEN_FALLBACK[name] || '#888888') + ')';
  const FONT_UI = 'font-family:var(--font-ui,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)';
  const FONT_MONO = 'font-family:var(--font-mono,ui-monospace,"SF Mono",Consolas,monospace);font-variant-numeric:tabular-nums';
  const SR_ONLY = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';

  /* =================================================================== *
   * Private state                                                        *
   * =================================================================== */
  let inited = false;
  let currentRecord = null;        // the summary sheet's record (for #btnKeepsake and K)
  let currentRating = null;
  let jarRecord = null;            // the record shown in #dlgJar while it is open
  let jarOpener = null;            // element to refocus when #dlgJar closes
  let jarDrawToken = 0;
  let jarStrip = null;             // timeline strip canvas injected into #dlgJar
  let typeTimer = 0;
  let keepsakeBusy = false;
  let deleteArmed = false, deleteTimer = 0, delLabel = null;

  let renderGen = 0;               // bumps on every renderTerrarium(); stale thumbnail jobs are dropped
  let thumbQueue = [];
  let pumpHandle = null;           // {idle} | {timer}
  let thumbIO = null;
  const thumbCache = new Map();    // key "id@dpr" -> offscreen canvas (insertion order = LRU)

  let lastAgg = null;              // aggregate used by the last render (for width-only re-renders)
  let lastRealCount = 0;
  const chartWidths = { chartDays: 0, chartHeat: 0, chartRecovery: 0 };

  let resizeObs = null;
  const observedStrips = new WeakSet();
  const retrying = new WeakSet();
  const stripRecords = new WeakMap();   // strip canvas -> record it shows
  const pendingResize = new Set();
  let resizeRaf = 0;

  /* =================================================================== *
   * Small helpers                                                        *
   * =================================================================== */
  function warn(what, err) { console.warn(LOG, what, err); }
  // Matches Session.aggregate's isDemo: a 'mixed' session that used sim keeps `demo: true`.
  const isDemo = (s) => !!s && (s.source === 'sim' || s.demo === true);
  function errMsg(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    return String(err.message || err.code || '');
  }
  function guard(what, fn) {
    try { fn(); } catch (err) { console.error(LOG, what + ' failed:', err); }
  }
  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text == null ? '' : String(text);
    return el;
  }
  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }
  /** Creates an SVG element; attributes with null/undefined/false values are skipped. */
  function S(tag, attrs, parent) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v != null && v !== false) el.setAttribute(k, String(v));
      }
    }
    if (parent) parent.appendChild(el);
    return el;
  }
  function svgTitle(parent, text) {
    const t = S('title', null, parent);
    t.textContent = text;
    return t;
  }
  function svgText(parent, x, y, text, style, extra) {
    const attrs = { x: r1(x), y: r1(y), style: style };
    if (extra) for (const k in extra) attrs[k] = extra[k];
    const t = S('text', attrs, parent);
    t.textContent = text;
    return t;
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function num(v, fallback) { v = +v; return isFinite(v) ? v : (fallback === undefined ? 0 : fallback); }
  function dprCap(cap) { return Math.max(1, Math.min(cap, window.devicePixelRatio || 1)); }
  function sum(arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; }

  function reducedMotion() {
    const b = document.body, m = b && b.getAttribute('data-motion');
    if (m === 'reduced') return true;
    if (m === 'full') return false;
    return !!(FT.env && typeof FT.env.reducedMotionSystem === 'function' && FT.env.reducedMotionSystem());
  }
  function screenName() { const b = document.body; return b ? b.getAttribute('data-screen') : null; }

  function toast(text, opts) {
    try {
      if (FT.App && typeof FT.App.toast === 'function') return FT.App.toast(text, opts || {});
    } catch (err) { warn('toast failed', err); }
    console.info(LOG, text);
    return null;
  }
  function announce(text, opts) {
    try {
      if (FT.App && typeof FT.App.announce === 'function') FT.App.announce(text, opts || {});
    } catch (err) { warn('announce failed', err); }
  }
  function go(screen) {
    try {
      if (FT.App && typeof FT.App.go === 'function') { FT.App.go(screen); return; }
    } catch (err) { console.error(LOG, 'go(' + screen + ') failed:', err); return; }
    console.warn(LOG, 'FT.App.go is unavailable; cannot show', screen);
  }

  function showDialog(dlg) {
    if (!dlg || dlg.open) return;
    if (typeof dlg.showModal === 'function') {
      try { dlg.showModal(); return; } catch (err) { warn('showModal failed', err); }
    }
    dlg.setAttribute('open', '');
  }
  function closeDialog(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === 'function') {
      try { if (dlg.open) dlg.close(); return; } catch (err) { warn('dialog close failed', err); }
    }
    if (dlg.hasAttribute('open')) {
      dlg.removeAttribute('open');
      dlg.dispatchEvent(new Event('close'));
    }
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) { btn.setAttribute('aria-busy', 'true'); btn.setAttribute('aria-disabled', 'true'); }
    else { btn.removeAttribute('aria-busy'); btn.removeAttribute('aria-disabled'); }
  }

  /* ----- Dates (Intl formatters are created once, lazily) ----- */
  const fmtCache = {};
  function dtf(key, opts) {
    let f = fmtCache[key];
    if (!f) {
      try { f = new Intl.DateTimeFormat(undefined, opts); } catch (err) { f = new Intl.DateTimeFormat('en', opts); }
      fmtCache[key] = f;
    }
    return f;
  }
  const FMT = {
    narrowDay: () => dtf('narrowDay', { weekday: 'narrow' }),
    shortDay: () => dtf('shortDay', { weekday: 'short' }),
    dayMonth: () => dtf('dayMonth', { day: 'numeric', month: 'short' }),
    dayMonthYear: () => dtf('dayMonthYear', { day: 'numeric', month: 'short', year: 'numeric' }),
    longDay: () => dtf('longDay', { weekday: 'short', day: 'numeric', month: 'short' }),
    fullDay: () => dtf('fullDay', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    time: () => dtf('time', { hour: 'numeric', minute: '2-digit' }),
    clock: () => dtf('clock', { hour: '2-digit', minute: '2-digit' }),
    hour: () => dtf('hour', { hour: 'numeric' }),
  };
  function fmtDate(f, d) {
    try { return d instanceof Date && isFinite(d.getTime()) ? f.format(d) : ''; } catch (err) { return ''; }
  }
  /** Monday-based weekday name (0 = Monday). 2024-01-01 was a Monday. */
  function weekdayName(w, narrow) {
    return fmtDate(narrow ? FMT.narrowDay() : FMT.shortDay(), new Date(2024, 0, 1 + w));
  }
  function hourLabel(hr) { return fmtDate(FMT.hour(), new Date(2024, 0, 1, hr)); }
  /** "9 – 11 AM" (formatRange when available), else "9 AM–11 AM". `b` may be 24 (midnight). */
  function hourRange(a, b) {
    const f = FMT.hour();
    const d0 = new Date(2024, 0, 1, a), d1 = new Date(2024, 0, 1, b);
    if (typeof f.formatRange === 'function') {
      try { return f.formatRange(d0, d1); } catch (err) { /* fall through */ }
    }
    return fmtDate(f, d0) + '–' + fmtDate(f, d1);
  }
  /** "Mon 28 Sep 2026 · 9:14–10:06" (the keepsake footer style). */
  function dateRangeText(rec) {
    const start = new Date(num(rec.startedAt, Date.now()));
    const end = rec.endedAt ? new Date(num(rec.endedAt)) : null;
    const t = FMT.time();
    let time = fmtDate(t, start);
    if (end && isFinite(end.getTime())) {
      if (U.dayKey(start) === U.dayKey(end) && typeof t.formatRange === 'function') {
        try { time = t.formatRange(start, end); } catch (err) { time = fmtDate(t, start) + '–' + fmtDate(t, end); }
      } else {
        time = fmtDate(t, start) + '–' + fmtDate(t, end);
      }
    }
    return fmtDate(FMT.fullDay(), start) + ' · ' + time;
  }

  /* =================================================================== *
   * Record helpers: label rule, measured flag, tiles                     *
   * =================================================================== */
  /** Stats container for a SessionRecord (.stats) or a SessionSummary (top-level fields). */
  function statsOf(r) { return (r && r.stats) || r || {}; }
  function isMeasured(r) {
    const p = statsOf(r).focusPct;
    return p != null && isFinite(p);
  }
  function ratingWord(n) { return RATING_WORDS[n] || ''; }

  /** The label rule (§2.4.8). Prefers FT.Session.labelFor so every surface agrees. */
  function labelFor(r) {
    if (!r) return '';
    const S_ = FT.Session;
    if (S_ && typeof S_.labelFor === 'function') {
      try {
        const t = S_.labelFor(r);
        if (typeof t === 'string' && t) return t;
      } catch (err) { warn('Session.labelFor failed', err); }
    }
    return localLabel(r);
  }
  function localLabel(r) {
    const st = statsOf(r);
    const parts = ['#' + Math.max(0, Math.floor(num(r.no))), Math.round(num(r.activeMs) / 60000) + ' min'];
    if (isMeasured(r)) {
      parts.push(Math.round(st.focusPct * 100) + '% focused');
      const m = Math.max(0, num(st.distractions));
      parts.push(m === 0 ? 'no distractions' : m === 1 ? '1 distraction' : m + ' distractions');
      const mended = Math.max(0, num(st.mended));
      if (mended > 0) parts.push(mended + ' recovered');
    } else {
      parts.push('timer only');
    }
    return (isDemo(r) ? 'DEMO · ' : '') + parts.join(' · ');
  }

  /**
   * The 8 summary tiles (§2.4.8), shared by the summary sheet and the jar dialog.
   * `id`/`capId` are the summary sheet's element ids.
   */
  function tileData(rec) {
    const st = rec.stats || {};
    const measured = isMeasured(rec);
    const returns = Math.max(0, num(st.returns));
    const med = st.medianRecoveryMs;
    const retWord = returns === 1 ? 'refocus' : 'refocuses';
    return [
      { id: 'sumHeld', capId: 'sumHeldOf', v: U.fmtDuration(num(st.heldMs)), c: 'focused of ' + U.fmtDuration(num(rec.activeMs)) },
      { id: 'sumPct', v: measured ? U.fmtPercent(st.focusPct) : DASH, c: 'focus' },
      // SPEC-GAP: "longest streak" stays visible for timer-only sessions (timer time counts as focused),
      // matching the saved image's stats row, which dashes only REFOCUSES and PEAK DEPTH.
      { id: 'sumLongest', v: U.fmtDuration(num(st.longestStreakMs)), c: 'longest streak' },
      {
        id: 'sumReturns', capId: 'sumRecovery', gold: true,
        v: measured ? String(returns) : DASH,
        c: measured && returns > 0 && med != null && isFinite(med) ? retWord + ' · median ' + U.fmtDuration(med) : 'refocuses',
      },
      { id: 'sumDepth', v: measured ? U.fmtPercent(num(st.peakDepth)) : DASH, c: 'peak depth' },
      { id: 'sumRoot', v: measured && st.timeToRootMs != null && isFinite(st.timeToRootMs) ? U.fmtDuration(st.timeToRootMs) : DASH, c: 'time to focus' },
      { id: 'sumBlink', v: measured && st.blinkRate != null && isFinite(st.blinkRate) ? Math.round(st.blinkRate) + '/min' : DASH, c: 'blinks' },
      { id: 'sumDrowsy', v: measured ? String(Math.max(0, num(st.drowsyFlags))) : DASH, c: 'drowsy moments' },
    ];
  }
  function makeTile(t) {
    const d = mk('div', 'tile');
    const b = mk('b', 'tile-v', t.v);
    if (t.gold) b.style.color = tok('gold');
    d.append(b, mk('span', 'tile-c', t.c));
    return d;
  }

  /* =================================================================== *
   * Summary sheet (§2.4.8)                                               *
   * =================================================================== */
  function fillSummary(record) {
    if (!record) return;
    currentRecord = record;
    currentRating = record.rating >= 1 && record.rating <= 5 ? record.rating : null;
    const st = record.stats || {};
    const measured = isMeasured(record);
    const short = num(record.activeMs) < 30000;
    const analysis = record.timeline ? FT.analyze(record.timeline) : null;

    // 1. Label (typed), 2. name + variety
    guard('session label', () => typeLabel($('specimenLabel'), labelFor(record)));
    setText('specimenName', FT.sessionTitle(record));
    setText('specimenVar', '');

    // 3. Tiles
    guard('summary tiles', () => {
      for (const t of tileData(record)) {
        const el = setText(t.id, t.v);
        if (t.capId) setText(t.capId, t.c);
        if (el && t.gold) el.style.color = tok('gold');
      }
      const note = $('sumUnmeasured');
      if (note) {
        let msg = '';
        // SPEC-GAP: short sessions never reach the summary in the normal flow (app.js toasts and
        // returns to Setup); if one does, the note explains why it won't be kept.
        if (short) msg = "Too short to keep. Sessions under 30 seconds aren't saved.";
        else if (num(st.unmeasuredMs) >= 1000) msg = "Timer-only time isn't measured; it counts as focused.";
        // SPEC-GAP: a camera session with under 30 measured seconds gets its own honest note.
        else if (!measured) msg = 'Too little was observed to measure focus. Unseen time is never counted against you.';
        if (msg) note.textContent = msg;
        note.hidden = !msg;
      }
    });

    // 4. Timeline strip
    guard('summary timeline', () => {
      const strip = $('sumTimeline');
      if (strip) drawTimelineStrip(strip, record);
    });

    // 5. Causes, 6. diagnosis
    guard('summary causes', () => renderCauses(record, analysis));
    setText('sumDiagnosis', record.diagnosis || '');

    // 7. Rating
    guard('summary rating', () => {
      const group = $('sumRating');
      if (group) group.hidden = short;
      syncRating(currentRating);
    });

    // 8. Actions
    keepsakeBusy = false;
    setBusy($('btnKeepsake'), false);
    const sheet = $('summarySheet');
    if (sheet) sheet.scrollTop = 0;
  }

  /** Types the label at 28 ms/char; instant with reduced motion. Screen readers get the full text at once. */
  function typeLabel(el, text) {
    clearTimeout(typeTimer);
    typeTimer = 0;
    if (!el) return;
    text = String(text || '');
    el.textContent = '';
    const sr = document.createElement('span');
    sr.style.cssText = SR_ONLY;
    sr.textContent = text;
    const vis = document.createElement('span');
    vis.setAttribute('aria-hidden', 'true');
    el.append(sr, vis);
    if (!text || reducedMotion()) { vis.textContent = text; return; }

    vis.textContent = ' '; // keeps the line box while the sheet rises
    const caret = document.createElement('span');
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▍';
    caret.style.cssText = 'opacity:.5;margin-left:.08em';
    // Start once the sheet has begun to rise (fillSummary runs just before go('summary')).
    const delay = screenName() === 'summary' ? 120 : 520;
    let t0 = 0;
    const step = () => {
      if (!el.isConnected) { typeTimer = 0; return; }
      if (!t0) { t0 = performance.now(); el.appendChild(caret); }
      // Time-based, so a throttled timer catches up instead of slowing down.
      const k = Math.min(text.length, 1 + Math.floor((performance.now() - t0) / TYPE_MS));
      vis.textContent = text.slice(0, k);
      if (k < text.length) typeTimer = setTimeout(step, TYPE_MS);
      else { typeTimer = 0; caret.remove(); }
    };
    typeTimer = setTimeout(step, delay);
  }

  /** #sumCauses rows (§2.4.8 item 5 + addendum §E). */
  function renderCauses(record, analysis) {
    const host = $('sumCauses');
    if (!host) return;
    host.textContent = '';
    const st = record.stats || {};
    const byCause = st.byCause || {}, byMs = st.byCauseMs || {};
    const rows = [];
    for (const c of FT.CAUSES) {
      const n = Math.max(0, num(byCause[c]));
      if (n > 0) rows.push({ cause: c, label: FT.CAUSE_LABEL[c] || c, n: n, ms: Math.max(0, num(byMs[c])) });
    }
    const away = Math.max(0, num(st.steppedAway));
    if (away > 0) {
      let ms = num(st.absentMs);
      if (analysis && analysis.absences && analysis.absences.length) ms = sum(analysis.absences.map((a) => a.dur)) * 1000;
      rows.push({ cause: 'absent', label: 'Stepped away', n: away, ms: ms });
    }
    host.hidden = rows.length === 0;
    if (!rows.length) return;
    host.setAttribute('role', 'list');
    let maxMs = 1;
    for (const r of rows) if (r.ms > maxMs) maxMs = r.ms;
    const animate = !reducedMotion();
    rows.forEach((r, i) => {
      const row = mk('div', 'cause-row');
      row.setAttribute('data-cause', r.cause);
      row.setAttribute('role', 'listitem');
      const meta = mk('span', 'cause-meta', '×' + r.n + ' · ' + U.fmtDuration(r.ms));
      meta.setAttribute('aria-hidden', 'true');
      const sr = mk('span', null, ': ' + plural(r.n, 'time') + ', ' + U.fmtDuration(r.ms) + ' in total');
      sr.style.cssText = SR_ONLY;
      const bar = mk('span', 'cause-bar');
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i');
      // SPEC-GAP: bar length is the row's total time relative to the longest row.
      const pct = r.ms > 0 ? Math.max(4, Math.round((r.ms / maxMs) * 100)) : 0;
      fill.style.width = pct + '%';
      fill.style.display = 'block';
      // Colour also comes from CSS ([data-cause]); background-color keeps any CSS gradient image on top.
      fill.style.backgroundColor = tok(r.cause === 'eyes' ? 'amber' : r.cause === 'absent' ? 'frost' : 'scar');
      bar.appendChild(fill);
      row.append(mk('span', 'cause-label', r.label), meta, sr, bar);
      host.appendChild(row);
      if (animate && typeof fill.animate === 'function') {
        fill.style.transformOrigin = 'left center';
        try {
          fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
            { duration: 700, delay: 650 + i * 90, easing: EASE_ORGANIC, fill: 'backwards' });
        } catch (err) { /* decorative */ }
      }
    });
  }

  /* ----- Rating radiogroup (roving tabindex, arrow keys) ----- */
  function ratingButtons() {
    const g = $('sumRating');
    return g ? Array.from(g.querySelectorAll('button[data-rating]')) : [];
  }
  function syncRating(n) {
    const btns = ratingButtons();
    let focusIdx = -1;
    btns.forEach((b, i) => {
      const on = parseInt(b.getAttribute('data-rating'), 10) === n;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      if (on) focusIdx = i;
    });
    if (focusIdx < 0) focusIdx = 0;
    btns.forEach((b, i) => { b.tabIndex = i === focusIdx ? 0 : -1; });
  }
  function rate(n) {
    const rec = currentRecord;
    if (!rec || !(n >= 1 && n <= 5)) return;
    const changed = currentRating !== n;
    currentRating = n;
    syncRating(n);
    if (!changed) return;
    try {
      if (FT.Session && typeof FT.Session.rate === 'function') FT.Session.rate(rec.id, n);
    } catch (err) { warn('Session.rate failed', err); }
    announce('Rated ' + ratingWord(n) + '.');
  }
  function onRatingClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button[data-rating]') : null;
    if (!b) return;
    rate(parseInt(b.getAttribute('data-rating'), 10));
  }
  function onRatingKey(e) {
    const k = e.key;
    if (k !== 'ArrowRight' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
    const btns = ratingButtons();
    if (!btns.length) return;
    let i = btns.indexOf(document.activeElement);
    if (i < 0) i = Math.max(0, btns.findIndex((b) => b.getAttribute('aria-checked') === 'true'));
    if (k === 'Home') i = 0;
    else if (k === 'End') i = btns.length - 1;
    else if (k === 'ArrowRight' || k === 'ArrowDown') i = (i + 1) % btns.length;
    else i = (i - 1 + btns.length) % btns.length;
    e.preventDefault();
    btns[i].focus();
    rate(parseInt(btns[i].getAttribute('data-rating'), 10));
  }

  /* =================================================================== *
   * Timeline strip (§2.4.8 item 4)                                       *
   * =================================================================== */
  function rrPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Draws the session strip: one run per FT.codec.runs(s) in FT.PALETTE[FT.CODES[code].color],
   * 2px --core ticks at gaps[].at, 3px --gold dots above mended episodes. DPR-aware; redraws
   * itself when the canvas is resized (or first laid out).
   */
  function drawTimelineStrip(canvas, record) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    stripRecords.set(canvas, record || null);
    observeStrip(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const measuredW = Math.round(canvas.clientWidth);
    const parentW = canvas.parentElement ? Math.round(canvas.parentElement.clientWidth) : 0;
    const cssW = measuredW > 0 ? measuredW : (parentW > 0 ? parentW : 640);
    let cssH = Math.round(canvas.clientHeight);
    if (!(cssH >= 16 && cssH <= 64)) {
      // A canvas without a CSS height keeps its intrinsic 2:1 box; pin the contract's 28px.
      if (cssH > 64) canvas.style.height = '28px';
      cssH = 28;
    }
    const dpr = dprCap(3);
    const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    canvas.setAttribute('data-drawn-w', String(measuredW));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const DOT_ZONE = 7;                              // mended dots live above the strip
    const y0 = DOT_ZONE, h = Math.max(6, cssH - DOT_ZONE - 1);
    const radius = Math.min(4, h / 2);
    const tl = record && record.timeline;
    const s = tl && typeof tl.s === 'string' ? tl.s : '';
    const n = s.length;
    const snap = (x) => Math.round(x * dpr) / dpr;

    // Track
    rrPath(ctx, 0, y0, cssW, h, radius);
    ctx.fillStyle = P.line;
    ctx.fill();

    if (n > 0) {
      ctx.save();
      rrPath(ctx, 0, y0, cssW, h, radius);
      ctx.clip();
      for (const run of FT.codec.runs(s)) {
        const info = FT.CODES[run.code];
        const x0 = snap((run.start / n) * cssW), x1 = snap(((run.start + run.len) / n) * cssW);
        ctx.fillStyle = (info && P[info.color]) || P.unseen;
        ctx.fillRect(x0, y0, Math.max(x1 - x0, 1 / dpr), h);
      }
      ctx.fillStyle = 'rgba(239,255,248,0.10)';      // faint glass highlight along the top edge
      ctx.fillRect(0, y0, cssW, 1);
      ctx.restore();

      // Pauses and breaks
      const gaps = Array.isArray(record.gaps) ? record.gaps : [];
      ctx.fillStyle = P.core;
      for (const g of gaps) {
        const at = num(g && g.at, NaN);
        if (!isFinite(at)) continue;
        const x = U.clamp(snap((at / n) * cssW), 1, cssW - 1);
        ctx.fillRect(x - 1, y0 - 2, 2, h + 3);
      }

      // Mended episodes
      const eps = Array.isArray(record.episodes) ? record.episodes : FT.analyze(tl).episodes;
      ctx.fillStyle = P.gold;
      for (const e of eps) {
        if (!e || !e.mended) continue;
        const t1 = e.t1 == null ? n : e.t1;
        const x = U.clamp((((num(e.t0) + num(t1)) / 2) / n) * cssW, 2, cssW - 2);
        ctx.beginPath();
        ctx.arc(x, 3, 1.5, 0, TAU);
        ctx.fill();
      }
    }

    canvas.removeAttribute('aria-hidden');   // the markup hides it; the label below must reach AT (§10.5)
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', stripLabel(record, s));
    if (measuredW === 0 && !resizeObs) retryStrip(canvas);
  }

  function stripLabel(record, s) {
    const n = s.length;
    if (!record) return 'Session timeline.';
    if (!n) return record.timeline ? 'Session timeline: nothing recorded.' : 'Session timeline: archived to save space.';
    let held = 0, away = 0, eyes = 0, absent = 0, unseen = 0;
    for (let i = 0; i < n; i++) {
      const c = s[i], info = FT.CODES[c];
      if (!info) continue;
      if (info.held) held++;
      else if (info.away) away++;
      else if (c === 'E') eyes++;
      else if (c === 'A') absent++;
      else unseen++;
    }
    const parts = [U.fmtDuration(held * 1000) + ' focused'];
    if (away) parts.push(U.fmtDuration(away * 1000) + ' drifting');
    if (eyes) parts.push(U.fmtDuration(eyes * 1000) + ' with eyes closed');
    if (absent) parts.push(U.fmtDuration(absent * 1000) + ' away from the desk');
    if (unseen) parts.push(U.fmtDuration(unseen * 1000) + ' not observed');
    const gaps = Array.isArray(record.gaps) ? record.gaps.length : 0;
    if (gaps) parts.push(plural(gaps, 'pause or break', 'pauses or breaks'));
    const eps = Array.isArray(record.episodes) ? record.episodes : [];
    const mended = eps.filter((e) => e && e.mended).length;
    if (mended) parts.push(plural(mended, 'recovered distraction'));
    return 'Session timeline, ' + U.fmtDuration(n * 1000) + ': ' + parts.join(', ') + '.';
  }

  function observeStrip(canvas) {
    if (resizeObs && !observedStrips.has(canvas)) {
      observedStrips.add(canvas);
      try { resizeObs.observe(canvas); } catch (err) { /* ignore */ }
    }
  }
  /** Fallback without ResizeObserver: wait (up to ~2 s of frames) for the canvas to get a width. */
  function retryStrip(canvas) {
    if (retrying.has(canvas) || typeof requestAnimationFrame !== 'function') return;
    retrying.add(canvas);
    let tries = 0;
    const tick = () => {
      if (canvas.clientWidth > 0) {
        retrying.delete(canvas);
        drawTimelineStrip(canvas, stripRecords.get(canvas));
        return;
      }
      if (++tries > 120) { retrying.delete(canvas); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* =================================================================== *
   * Keepsake (§4.7)                                                      *
   * =================================================================== */
  /** K key (app.js): saves the open jar's record, else the current summary record. */
  function saveKeepsake() {
    const dlg = $('dlgJar');
    if (dlg && dlg.open && jarRecord) return keepsake(jarRecord, $('btnJarKeepsake'));
    const scr = screenName();
    if (currentRecord && (!scr || scr === 'summary')) return keepsake(currentRecord, $('btnKeepsake'));
    toast('Open a session to save its image.');
    return Promise.resolve(false);
  }

  async function keepsake(record, btn) {
    if (!record || keepsakeBusy) return false;
    const K = FT.Keepsake;
    if (!K || typeof K.download !== 'function') {
      toast("Images can't be made right now. Try reloading the page.");
      return false;
    }
    keepsakeBusy = true;
    setBusy(btn, true);
    try {
      await K.download(record);
      let name = '';
      try { name = typeof K.filename === 'function' ? String(K.filename(record) || '') : ''; } catch (err) { name = ''; }
      toast(name ? 'Image saved: ' + name : 'Image saved.');
      return true;
    } catch (err) {
      console.error(LOG, 'keepsake failed:', err);
      toast("Couldn't save the image. Please try again.", { timeout: 8000 });
      return false;
    } finally {
      keepsakeBusy = false;
      setBusy(btn, false);
    }
  }

  /* =================================================================== *
   * Terrarium (§2.4.9)                                                   *
   * =================================================================== */
  function renderTerrarium() {
    const gen = ++renderGen;
    cancelThumbs();

    const S_ = FT.Session;
    let all = [], agg = null;
    if (S_ && typeof S_.list === 'function') {
      try { all = (S_.list() || []).filter(Boolean); } catch (err) { console.error(LOG, 'Session.list failed:', err); }
    }
    if (S_ && typeof S_.aggregate === 'function') {
      try { agg = S_.aggregate() || null; } catch (err) { console.error(LOG, 'Session.aggregate failed:', err); }
    }
    const real = all.filter((s) => !isDemo(s));   // demo jars sit on shelves, never in numbers
    lastAgg = agg;
    lastRealCount = agg && agg.totals ? Math.max(0, num(agg.totals.sessions)) : real.length;

    const empty = all.length === 0;
    const emptyEl = $('histEmpty');
    if (emptyEl) emptyEl.hidden = !empty;
    guard('empty-state sections', () => toggleSections(empty));

    guard('header', () => renderHeader(agg, real, all));
    guard('14-day chart', () => renderDays(agg));
    guard('shelves', () => renderShelves(all, gen));
    guard('heatmap', () => renderHeat(agg, lastRealCount));
    guard('compass', () => renderCompass(agg));
    guard('recovery', () => renderRecovery(agg));
  }

  /* ----- Empty state: hide chart sections (never the data section) ----- */
  function sectionFor(id) {
    const node0 = $(id), screen = $('screen-history');
    if (!node0 || !screen) return null;
    const keep = ['histEmpty', 'btnExport', 'btnImport', 'btnErase', 'histTotals', 'btnHistBack'].map($).filter(Boolean);
    for (let n = node0.parentElement; n && n !== screen && n !== document.body; n = n.parentElement) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (n.tagName === 'SECTION' || n.tagName === 'ARTICLE' || /(^|[\s_-])(section|card|panel)([\s_-]|$)/.test(cls)) {
        for (const k of keep) if (n.contains(k)) return null;
        return n;
      }
    }
    return null;
  }
  // SPEC-GAP: the spec only says #histEmpty is shown; hiding the empty chart sections around it
  // (identified by their <section>/<article> wrapper) keeps the empty state calm. "Your data"
  // stays visible so an export can be imported into an empty terrarium.
  function toggleSections(empty) {
    const screen = $('screen-history');
    if (!screen) return;
    if (!empty) {
      screen.querySelectorAll('[data-hist-auto-hidden]').forEach((n) => {
        n.hidden = false;
        n.removeAttribute('data-hist-auto-hidden');
      });
      return;
    }
    for (const id of CHART_HOSTS) {
      const sec = sectionFor(id);
      if (sec && !sec.hidden) {
        sec.hidden = true;
        sec.setAttribute('data-hist-auto-hidden', '1');
      }
    }
  }

  /* ----- Header: totals + streak chip ----- */
  function renderHeader(agg, real, all) {
    const totalsEl = $('histTotals');
    if (totalsEl) {
      let t = agg && agg.totals;
      if (!t) {
        const measured = real.filter((s) => s.focusPct != null && isFinite(s.focusPct));
        t = {
          sessions: real.length,
          heldMs: sum(real.map((s) => num(s.heldMs))),
          avgFocusPct: measured.length ? sum(measured.map((s) => s.focusPct)) / measured.length : null,
        };
      }
      const n = Math.max(0, num(t.sessions));
      if (!all.length) totalsEl.textContent = 'No sessions yet.';
      else if (!n) totalsEl.textContent = 'Only demo sessions so far. Do a real one to start your record.';
      else {
        const parts = [plural(n, 'session'), U.fmtDuration(num(t.heldMs)) + ' focused'];
        let avg = t.avgFocusPct;
        if (avg != null && isFinite(avg)) {
          if (avg > 1.0001) avg /= 100; // tolerate a percentage instead of a fraction
          parts.push(Math.round(avg * 100) + '% average focus');
        }
        totalsEl.textContent = parts.join(' · ');
      }
    }

    const chip = $('histStreak');
    if (chip) {
      const ds = agg && agg.dayStreak;
      chip.hidden = !ds || real.length === 0;
      if (!chip.hidden) {
        const c = Math.max(0, num(ds.current)), b = Math.max(0, num(ds.best));
        const goal = Math.max(1, num(agg.goalMin, 50));
        chip.textContent = c + '-day streak · best ' + b;
        const note = mk('span', null, ' · a day counts at ' + goal + ' min');
        note.style.cssText = 'opacity:.72;font-weight:400';
        chip.appendChild(note);
        const todayMet = !!(agg.today && agg.today.goalMet);
        chip.title = 'A day counts toward your streak at ' + goal + ' minutes focused.' +
          (todayMet ? ' Today already counts.' : '');
      }
    }
  }

  /* ----- Shared SVG + layout helpers for the charts ----- */
  /** Inner (content-box) width of a chart container, or `fallback` while it isn't laid out. */
  function measure(host, fallback) {
    let w = host.clientWidth;
    if (w > 0) {
      const cs = getComputedStyle(host);
      w -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    }
    return w > 40 ? Math.round(w) : fallback;
  }
  /** Responsive root: the viewBox is laid out 1:1 in CSS px, and the height follows the aspect. */
  function svgRoot(W, H, label, extraStyle) {
    return S('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'aria-label': label,
      preserveAspectRatio: 'xMidYMid meet', focusable: 'false',
      style: 'display:block;height:auto;overflow:visible' + (extraStyle ? ';' + extraStyle : ''),
    });
  }
  function mount(host, node) {
    host.textContent = '';
    host.appendChild(node);
  }

  /* ----- 1. Last 14 days ----- */
  function renderDays(agg) {
    const host = $('chartDays');
    const listEl = $('chartDaysText');
    if (!host && !listEl) return;
    const goalMin = Math.max(1, num(agg && agg.goalMin, 50));
    const goalMs = goalMin * 60000;
    const todayKey = (agg && agg.today && agg.today.day) || U.dayKey();
    const byDay = new Map();
    if (agg && Array.isArray(agg.days)) for (const d of agg.days) if (d && d.day) byDay.set(d.day, d);
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const key = U.addDays(todayKey, -i);
      const d = byDay.get(key);
      const held = d ? Math.max(0, num(d.heldMs)) : 0;
      days.push({
        day: key, heldMs: held, sessions: d ? Math.max(0, num(d.sessions)) : 0,
        goalMet: d && d.goalMet != null ? !!d.goalMet : held >= goalMs, today: i === 0,
      });
    }
    const dayText = (d) => {
      const date = fmtDate(FMT.longDay(), U.parseDayKey(d.day));
      let t = date + (d.today ? ' (today)' : '') + ': ' + (d.heldMs > 0 ? U.fmtDuration(d.heldMs) + ' held' : 'nothing held');
      if (d.sessions) t += ' in ' + plural(d.sessions, 'session');
      if (d.goalMet) t += ', goal met';
      return t;
    };

    if (listEl) {
      listEl.textContent = '';
      for (const d of days) listEl.appendChild(mk('li', null, dayText(d)));
    }
    if (!host) return;

    const today = days[13];
    const metCount = days.filter((d) => d.goalMet).length;
    const aria = 'Held focus per day over the last 14 days. Today: ' + U.fmtDuration(today.heldMs) +
      ' of a ' + goalMin + '-minute goal. Goal met on ' + metCount + ' of 14 days.';

    const W = measure(host, 560);
    chartWidths.chartDays = W;
    const H = 140, padT = 18, padB = 22, padX = 2;
    const plotH = H - padT - padB, base = H - padB;
    let maxMs = goalMs * 1.25;
    for (const d of days) if (d.heldMs > maxMs) maxMs = d.heldMs;
    const slot = (W - padX * 2) / 14;
    const barW = U.clamp(Math.round(slot * 0.6), 4, 30);
    const yOf = (ms) => base - (ms / maxMs) * plotH;
    const svg = svgRoot(W, H, aria);

    S('line', { x1: padX, x2: W - padX, y1: base + 0.5, y2: base + 0.5, style: 'stroke:' + tok('line') + ';stroke-width:1' }, svg);

    days.forEach((d, i) => {
      const cx = padX + slot * (i + 0.5);
      const x = Math.round(cx - barW / 2);
      const g = S('g', null, svg);
      svgTitle(g, dayText(d));
      // Invisible hit area so the tooltip works on empty days too.
      S('rect', { x: r1(padX + slot * i), y: padT, width: r1(slot), height: plotH + padB, style: 'fill:transparent' }, g);
      let top = base;
      if (d.heldMs > 0) {
        top = Math.min(base - 2, Math.round(yOf(d.heldMs)));
        S('rect', {
          x: x, y: top, width: barW, height: base - top, rx: Math.min(3, barW / 2),
          style: 'fill:' + tok('hypha') + ';fill-opacity:' + (d.goalMet ? 1 : 0.55),
        }, g);
      } else {
        S('rect', { x: x, y: base - 2, width: barW, height: 2, rx: 1, style: 'fill:' + tok('line') }, g);
      }
      if (d.today) {
        const oTop = Math.min(top, base - 10) - 2.5;
        S('rect', {
          x: x - 2.5, y: oTop, width: barW + 5, height: base - oTop + 2, rx: 4,
          style: 'fill:none;stroke:' + tok('core') + ';stroke-width:1.25;stroke-opacity:.9' + (d.heldMs > 0 ? '' : ';stroke-dasharray:2 2'),
        }, g);
      }
      svgText(g, cx, H - 6, weekdayName(U.weekday(U.parseDayKey(d.day)), true),
        FONT_UI + ';font-size:11px;fill:' + tok(d.today ? 'text' : 'muted') + (d.today ? ';font-weight:600' : ''),
        { 'text-anchor': 'middle' });
    });

    // Daily goal: dashed gold line with a small label (drawn over the bars).
    const gy = Math.round(yOf(goalMs)) + 0.5;
    S('line', {
      x1: padX, x2: W - padX, y1: gy, y2: gy,
      style: 'stroke:' + tok('gold') + ';stroke-width:1.25;stroke-dasharray:5 4;stroke-opacity:.9',
    }, svg);
    svgText(svg, padX + 2, gy - 5, 'goal ' + U.fmtDuration(goalMs),
      FONT_MONO + ';font-size:10px;fill:' + tok('gold') + ';paint-order:stroke;stroke:' + tok('abyss') +
      ';stroke-width:3px;stroke-linejoin:round');

    mount(host, svg);
  }

  /* ----- 2. Shelves: one per ISO week, newest first, lazily drawn jars ----- */
  function weekLabel(mondayKey) {
    const d = U.parseDayKey(mondayKey);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return 'Week of ' + fmtDate(sameYear ? FMT.dayMonth() : FMT.dayMonthYear(), d);
  }
  function jarDateText(ts) {
    const d = new Date(num(ts, Date.now()));
    return fmtDate(FMT.shortDay(), d) + ' ' + fmtDate(FMT.clock(), d);
  }

  function renderShelves(all, gen) {
    const host = $('shelves');
    if (!host) return;
    host.textContent = '';
    if (!all.length) return;

    const groups = new Map();
    for (const s of all) {
      const key = U.mondayOf(U.dayKey(num(s.startedAt, 0) || num(s.endedAt, 0) || Date.now()));
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(s);
    }
    const keys = Array.from(groups.keys()).sort().reverse();   // "YYYY-MM-DD" sorts chronologically
    const dpr = dprCap(2);
    const frag = document.createDocumentFragment();
    const jobs = [];

    for (const key of keys) {
      const items = groups.get(key).sort((a, b) => num(b.startedAt) - num(a.startedAt));
      const shelf = mk('section', 'shelf');
      const head = mk('h3', 'shelf-head', weekLabel(key));
      const heldReal = sum(items.filter((s) => !isDemo(s)).map((s) => num(s.heldMs)));
      const extra = mk('span', null, ' · ' + plural(items.length, 'session') + (heldReal > 0 ? ' · ' + U.fmtDuration(heldReal) + ' focused' : ''));
      extra.style.cssText = 'font-weight:400;opacity:.7';
      head.appendChild(extra);
      const row = mk('div', 'shelf-row');
      for (const s of items) {
        const jar = makeJar(s, dpr);
        row.appendChild(jar.btn);
        if (jar.job) { jar.job.gen = gen; jobs.push(jar.job); }
      }
      shelf.append(head, row);
      frag.appendChild(shelf);
    }
    host.appendChild(frag);
    scheduleThumbs(jobs);
  }

  function makeJar(s, dpr) {
    const btn = mk('button', 'jar');
    btn.type = 'button';
    btn.setAttribute('data-id', String(s.id));
    const cv = mk('canvas', 'jar-canvas');
    const px = Math.round(JAR_CSS * dpr);
    cv.width = px;
    cv.height = px;
    cv.style.width = JAR_CSS + 'px';     // the contract size (72×72 CSS), whatever the backing store
    cv.style.height = JAR_CSS + 'px';
    cv.setAttribute('aria-hidden', 'true');
    const dateText = jarDateText(s.startedAt);
    // SPEC-GAP: .jar-min shows the session's active length (the label rule's "52 min"), not held time.
    const minText = U.fmtDuration(num(s.activeMs));
    btn.append(cv, mk('span', 'jar-date', dateText), mk('span', 'jar-min', minText));
    const demo = isDemo(s);
    if (demo) btn.appendChild(mk('span', 'jar-tag', 'demo'));
    const name = FT.sessionTitle(s);
    // The accessible name starts with the visible text (WCAG 2.5.3), then the full story.
    btn.setAttribute('aria-label', dateText + ', ' + minText + (demo ? ', demo' : '') + ': ' + name + '. ' +
      labelFor(s) + '. ' + fmtDate(FMT.fullDay(), new Date(num(s.startedAt, Date.now()))) + '.');
    btn.title = name;

    const key = thumbKey(s.id, dpr);
    const cached = thumbCache.get(key);
    if (cached) {
      cacheTouch(key, cached);
      blitThumb(cv, cached, false);
      return { btn: btn, job: null };
    }
    drawPlaceholderThumb(cv, s.id, dpr);
    return { btn: btn, job: { canvas: cv, id: s.id, gen: 0 } };
  }

  /* ----- Thumbnail pipeline: IntersectionObserver -> idle queue -> drawSpecimen ----- */
  function thumbKey(id, dpr) { return String(id) + '@' + dpr; }
  function cacheTouch(key, img) { thumbCache.delete(key); thumbCache.set(key, img); }
  function cachePut(key, img) {
    cacheTouch(key, img);
    while (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
  }
  function dropThumbs(id) {
    const prefix = String(id) + '@';
    for (const k of Array.from(thumbCache.keys())) if (k.indexOf(prefix) === 0) thumbCache.delete(k);
  }

  function cancelThumbs() {
    thumbQueue = [];
    if (pumpHandle) {
      if (pumpHandle.idle != null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(pumpHandle.idle);
      if (pumpHandle.timer != null) clearTimeout(pumpHandle.timer);
      pumpHandle = null;
    }
    if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
  }

  function scheduleThumbs(jobs) {
    if (!jobs.length) return;
    if (typeof window.IntersectionObserver === 'function') {
      const byCanvas = new Map(jobs.map((j) => [j.canvas, j]));
      const io = new IntersectionObserver((entries) => {
        let added = false;
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          io.unobserve(en.target);
          const job = byCanvas.get(en.target);
          if (job && job.gen === renderGen) { thumbQueue.push(job); added = true; }
        }
        if (added) pump();
      }, { rootMargin: '240px 0px 240px 0px' });
      thumbIO = io;
      for (const j of jobs) io.observe(j.canvas);
    } else {
      for (const j of jobs) thumbQueue.push(j);
      pump();
    }
  }

  function pump() {
    if (pumpHandle || !thumbQueue.length) return;
    if (typeof window.requestIdleCallback === 'function') {
      pumpHandle = { idle: window.requestIdleCallback(runThumbsIdle, { timeout: 700 }), timer: null };
    } else {
      pumpHandle = { idle: null, timer: setTimeout(runThumbsTimer, 50) };
    }
  }
  function runThumbsIdle(deadline) {
    pumpHandle = null;
    let done = 0;
    while (thumbQueue.length) {
      if (done > 0 && (deadline.didTimeout || deadline.timeRemaining() < 12)) break;
      runThumb(thumbQueue.shift());
      done++;
    }
    pump();
  }
  function runThumbsTimer() {
    pumpHandle = null;
    if (thumbQueue.length) runThumb(thumbQueue.shift());
    pump();
  }

  function runThumb(job) {
    if (!job || job.gen !== renderGen || !job.canvas.isConnected) return;
    const dpr = dprCap(2);
    const key = thumbKey(job.id, dpr);
    let img = thumbCache.get(key);
    if (img) cacheTouch(key, img);
    else {
      if (!FT.Visual || typeof FT.Visual.drawSpecimen !== 'function') return;  // the placeholder ring stays
      let rec = null;
      try { rec = FT.Session && typeof FT.Session.load === 'function' ? FT.Session.load(job.id) : null; }
      catch (err) { warn('Session.load failed for a jar', err); }
      if (!rec) { drawMissingThumb(job.canvas, dpr); return; }
      img = renderThumb(rec, dpr);
      if (!img) return;
      cachePut(key, img);
    }
    blitThumb(job.canvas, img, true);
  }

  function renderThumb(rec, dpr) {
    const px = Math.round(JAR_CSS * dpr);
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      FT.Visual.drawSpecimen(ctx, rec, JAR_CSS / 2, JAR_CSS / 2, 30, { quality: 'thumb', fruit: true });
    } catch (err) {
      warn('drawSpecimen (thumb) failed', err);
      return null;
    }
    return c;
  }

  function blitThumb(canvas, img, animate) {
    if (canvas.width !== img.width) canvas.width = img.width;
    if (canvas.height !== img.height) canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.classList.add('is-drawn');    // our pixels replace the CSS placeholder ring
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (animate && !reducedMotion() && typeof canvas.animate === 'function') {
      try { canvas.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 420, easing: EASE_ORGANIC }); } catch (err) { /* decorative */ }
    }
  }

  /** An empty ring track (placeholder art); `alpha` scales it. */
  function drawTrack(ctx, x, y, r, alpha) {
    const a = alpha == null ? 1 : alpha;
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.strokeStyle = 'rgba(207,230,223,' + (0.1 * a).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  }
  function prepThumbCtx(canvas, dpr) {
    const px = Math.round(JAR_CSS * dpr);
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    canvas.classList.add('is-drawn');    // the painted placeholder/missing art replaces the CSS ring
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  /** Placeholder: an empty ring, until the real session ring is drawn. */
  function drawPlaceholderThumb(canvas, id, dpr) {
    const ctx = prepThumbCtx(canvas, dpr);
    if (!ctx) return;
    const c = JAR_CSS / 2;
    drawTrack(ctx, c, c, 25, 1);
  }
  /** A record that can't be loaded: a frost dashed ring. */
  function drawMissingThumb(canvas, dpr) {
    const ctx = prepThumbCtx(canvas, dpr);
    if (!ctx) return;
    const c = JAR_CSS / 2;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(60,95,120,0.7)';
    ctx.beginPath();
    ctx.arc(c, c, 24, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ----- 3. When you focus: 7×24 heatmap + best hours ----- */
  function normHeat(heat) {
    const out = [];
    for (let w = 0; w < 7; w++) {
      const src = (Array.isArray(heat) && heat[w]) || [];
      const row = new Array(24);
      for (let hr = 0; hr < 24; hr++) {
        const v = +src[hr];
        row[hr] = isFinite(v) && v > 0 ? v : 0;
      }
      out.push(row);
    }
    return out;
  }

  function renderHeat(agg, realCount) {
    const heat = normHeat(agg && agg.heat);
    const bestEl = $('bestHours');
    const best = agg && agg.bestHours;
    // Number.isFinite: a null start/end must not coerce to hour 0.
    const hasBest = !!best && Number.isFinite(best.start) && realCount >= 5;
    const bestStart = hasBest ? U.clamp(Math.round(best.start), 0, 23) : 0;
    const bestEnd = hasBest
      ? U.clamp(Math.round(Number.isFinite(best.end) ? best.end : best.start + 2), bestStart + 1, 24)
      : 0;
    if (bestEl) {
      bestEl.textContent = hasBest
        ? 'Your best hours: ' + hourRange(bestStart, bestEnd)
        : 'Do a few more sessions to see your best hours.';
    }
    const host = $('chartHeat');
    if (!host) return;

    let max = 0, top = null;
    for (let w = 0; w < 7; w++) {
      for (let hr = 0; hr < 24; hr++) {
        if (heat[w][hr] > max) { max = heat[w][hr]; top = { w: w, hr: hr }; }
      }
    }
    const aria = 'Focused time by weekday and hour over the last 12 weeks. ' + (top
      ? 'Strongest: ' + weekdayName(top.w) + ' ' + hourLabel(top.hr) + ', ' + U.fmtDuration(max) + ' focused.'
      : 'Nothing recorded yet.');

    const W = measure(host, 560);
    chartWidths.chartHeat = W;
    const LW = 34, T = 8, LB = 18, R = 2;
    const cw = Math.max(4, (W - LW - R) / 24);
    const gap = cw >= 12 ? 2 : 1;
    const ch = U.clamp(cw, 11, 22);
    const H = Math.round(T + 7 * ch + LB);
    const svg = svgRoot(W, H, aria);
    const labelStyle = FONT_UI + ';font-size:10px;fill:' + tok('muted');

    for (let w = 0; w < 7; w++) {
      svgText(svg, LW - 6, T + w * ch + (ch - gap) / 2, weekdayName(w), labelStyle,
        { 'text-anchor': 'end', 'dominant-baseline': 'central' });
    }
    const rx = Math.min(3, (cw - gap) / 3);
    for (let w = 0; w < 7; w++) {
      for (let hr = 0; hr < 24; hr++) {
        const v = heat[w][hr];
        const rect = S('rect', {
          x: r1(LW + hr * cw), y: r1(T + w * ch), width: r1(cw - gap), height: r1(ch - gap), rx: r1(rx),
          style: v > 0
            ? 'fill:' + tok('hypha') + ';fill-opacity:' + (0.14 + 0.86 * (v / max)).toFixed(3)
            : 'fill:' + tok('line') + ';fill-opacity:.45',
        }, svg);
        svgTitle(rect, weekdayName(w) + ' ' + hourLabel(hr) + ': ' + (v > 0 ? U.fmtDuration(v) + ' focused' : 'nothing yet'));
      }
    }
    for (const hr of [0, 6, 12, 18]) {
      svgText(svg, LW + hr * cw, H - 4, hourLabel(hr), labelStyle);
    }
    if (hasBest) {
      const x0 = LW + bestStart * cw - 2, x1 = LW + bestEnd * cw - gap + 2;
      const outline = S('rect', {
        x: r1(x0), y: T - 3, width: r1(x1 - x0), height: r1(7 * ch - gap + 6), rx: 4,
        style: 'fill:none;stroke:' + tok('gold') + ';stroke-width:1.25;stroke-opacity:.75',
      }, svg);
      svgTitle(outline, 'Your best hours: ' + hourRange(bestStart, bestEnd));
    }
    mount(host, svg);
  }

  /* ----- 4. Where drifts go: 8-sector rose + §4.4.10 text ----- */
  function normCompass(c) {
    const out = [0, 0, 0, 0, 0, 0, 0, 0];
    if (c && typeof c.length === 'number') for (let k = 0; k < 8; k++) out[k] = Math.max(0, num(c[k]));
    return out;
  }
  /** §4.4.10 compass text rule. */
  function compassText(counts) {
    counts = normCompass(counts);
    if (sum(counts) < 3) return "Not enough drifts yet to see a pattern. That's a good thing.";
    let k = 0;
    for (let i = 1; i < 8; i++) if (counts[i] > counts[k]) k = i;
    const c = COMPASS[k];
    let t = 'Most drifts point ' + c.name + ' (' + c.clock + " o'clock).";
    if (k >= 1 && k <= 3) t += ' A phone within reach?';
    else if (k === 0 || k === 4) t += ' Something off to that side?';
    return t;
  }

  function renderCompass(agg) {
    const counts = normCompass(agg && agg.compass);
    const textEl = $('compassText');
    if (textEl) textEl.textContent = compassText(counts);
    const host = $('chartCompass');
    if (!host) return;

    const total = sum(counts);
    const nonzero = [];
    for (let k = 0; k < 8; k++) if (counts[k] > 0) nonzero.push(COMPASS[k].name + ' ' + counts[k]);
    const aria = total
      ? 'Drift directions over the last 7 days: ' + nonzero.join(', ') + '.'
      : 'Drift directions over the last 7 days: none.';

    const SZ = 220, C = SZ / 2, R0 = 16, R1 = 80;
    const svg = S('svg', {
      viewBox: '0 0 ' + SZ + ' ' + SZ, width: '100%', role: 'img', 'aria-label': aria,
      preserveAspectRatio: 'xMidYMid meet', focusable: 'false',
      style: 'display:block;height:auto;max-width:220px;margin:0 auto;overflow:visible',
    });
    const pt = (r, a) => r1(C + r * Math.cos(a)) + ' ' + r1(C + r * Math.sin(a));

    // Rings and spokes
    [1 / 3, 2 / 3, 1].forEach((f, i) => {
      S('circle', {
        cx: C, cy: C, r: r1(R0 + (R1 - R0) * f),
        style: 'fill:none;stroke:' + tok('line') + ';stroke-width:1' + (i < 2 ? ';stroke-dasharray:2 4' : ''),
      }, svg);
    });
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      S('line', {
        x1: r1(C + R0 * Math.cos(a)), y1: r1(C + R0 * Math.sin(a)),
        x2: r1(C + (R1 + 4) * Math.cos(a)), y2: r1(C + (R1 + 4) * Math.sin(a)),
        style: 'stroke:' + tok('line') + ';stroke-width:1;stroke-opacity:.7',
      }, svg);
    }

    // Petals: area-proportional radius; sector k is centred on k × 45° (0 = right, clockwise).
    if (total > 0) {
      let max = 0;
      for (const v of counts) if (v > max) max = v;
      const half = Math.PI / 8 - 0.05;
      for (let k = 0; k < 8; k++) {
        const v = counts[k];
        if (!v) continue;
        const f = v / max;
        const r = R0 + (R1 - R0) * Math.sqrt(f);
        const a = (k * Math.PI) / 4, a0 = a - half, a1 = a + half;
        const d = 'M' + pt(R0, a0) + ' L' + pt(r, a0) + ' A' + r1(r) + ' ' + r1(r) + ' 0 0 1 ' + pt(r, a1) +
          ' L' + pt(R0, a1) + ' A' + R0 + ' ' + R0 + ' 0 0 0 ' + pt(R0, a0) + ' Z';
        const petal = S('path', {
          d: d,
          style: 'fill:' + tok('scar') + ';fill-opacity:' + (0.28 + 0.55 * f).toFixed(3) +
            ';stroke:' + tok('scar') + ';stroke-width:1;stroke-linejoin:round;stroke-opacity:' + (v === max ? 1 : 0.6),
        }, svg);
        svgTitle(petal, COMPASS[k].name + ' (' + COMPASS[k].clock + " o'clock): " + plural(v, 'drift'));
        if (r - R0 > 24) {
          svgText(svg, C + (r - 11) * Math.cos(a), C + (r - 11) * Math.sin(a), String(v),
            FONT_MONO + ';font-size:10px;fill:' + tok('text'),
            { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        }
      }
    }

    // Hub: the spore your gaze returns to
    S('circle', { cx: C, cy: C, r: R0 - 4, style: 'fill:' + tok('dish') + ';stroke:' + tok('line') + ';stroke-width:1' }, svg);
    S('circle', { cx: C, cy: C, r: 7, style: 'fill:' + tok('hypha') + ';fill-opacity:.18' }, svg);
    S('circle', { cx: C, cy: C, r: 3, style: 'fill:' + tok('hypha') }, svg);

    // Clock labels
    const clockStyle = FONT_MONO + ';font-size:11px;fill:' + tok('muted');
    const LR = R1 + 16;
    [['12', -Math.PI / 2], ['3', 0], ['6', Math.PI / 2], ['9', Math.PI]].forEach((l) => {
      svgText(svg, C + LR * Math.cos(l[1]), C + LR * Math.sin(l[1]), l[0], clockStyle,
        { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    });

    mount(host, svg);
  }

  /* ----- 5. Coming back: weekly median recovery sparkline ----- */
  function normRecovery(rec) {
    if (Array.isArray(rec) && rec.length) {
      return rec.map((w) => {
        const v = w ? +w.medianRecoveryMs : NaN;
        return { week: (w && w.week) || '', medianRecoveryMs: w && w.medianRecoveryMs != null && isFinite(v) ? v : null };
      });
    }
    const mon = U.mondayOf(U.dayKey());
    const out = [];
    for (let i = 7; i >= 0; i--) out.push({ week: U.addDays(mon, -7 * i), medianRecoveryMs: null });
    return out;
  }
  function recoveryText(weeks) {
    const cur = weeks.length ? weeks[weeks.length - 1].medianRecoveryMs : null;
    let prev = null;
    for (let i = weeks.length - 2; i >= 0; i--) {
      if (weeks[i].medianRecoveryMs != null) { prev = weeks[i].medianRecoveryMs; break; }
    }
    if (cur != null && prev != null) return 'Median return this week: ' + U.fmtDuration(cur) + ' (was ' + U.fmtDuration(prev) + ')';
    if (cur != null) return 'Median return this week: ' + U.fmtDuration(cur);
    if (prev != null) return 'No returns this week yet. Your last weekly median was ' + U.fmtDuration(prev) + '.';
    return "Your return times will show here once you've drifted and come back.";
  }
  function weekText(key) {
    return key ? fmtDate(FMT.dayMonth(), U.parseDayKey(key)) : '';
  }

  function renderRecovery(agg) {
    const weeks = normRecovery(agg && agg.recovery);
    const textEl = $('recoveryText');
    if (textEl) textEl.textContent = recoveryText(weeks);
    const host = $('chartRecovery');
    if (!host) return;

    const pts = [];
    weeks.forEach((w, i) => { if (w.medianRecoveryMs != null) pts.push({ i: i, v: w.medianRecoveryMs, week: w.week }); });
    const aria = pts.length
      ? 'Weekly median return time over the last ' + weeks.length + ' weeks: ' +
        pts.map((p) => (weekText(p.week) ? 'week of ' + weekText(p.week) + ' ' : '') + U.fmtDuration(p.v)).join(', ') + '.'
      : 'Weekly median return time: no returns recorded yet.';

    const W = measure(host, 560);
    chartWidths.chartRecovery = W;
    const H = 64, padL = 6, padR = 46, padT = 10, padB = 16;
    const plotW = Math.max(40, W - padL - padR), plotH = H - padT - padB;
    const base = padT + plotH;
    const n = weeks.length;
    const xOf = (i) => padL + (n > 1 ? i / (n - 1) : 0.5) * plotW;
    let hi = 1;
    for (const p of pts) if (p.v > hi) hi = p.v;
    hi *= 1.15;
    const yOf = (v) => padT + (1 - v / hi) * plotH;
    const svg = svgRoot(W, H, aria);

    S('line', { x1: padL, x2: padL + plotW, y1: base + 0.5, y2: base + 0.5, style: 'stroke:' + tok('line') + ';stroke-width:1' }, svg);

    if (!pts.length) {
      S('line', {
        x1: padL, x2: padL + plotW, y1: padT + plotH / 2, y2: padT + plotH / 2,
        style: 'stroke:' + tok('muted') + ';stroke-width:1;stroke-dasharray:3 4;stroke-opacity:.5',
      }, svg);
      svgText(svg, padL + plotW / 2, padT + plotH / 2 - 6, 'no returns yet',
        FONT_UI + ';font-size:10px;fill:' + tok('muted'), { 'text-anchor': 'middle' });
    } else {
      for (const p of pts) { p.x = xOf(p.i); p.y = yOf(p.v); }
      if (pts.length > 1) {
        let d = 'M' + r1(pts[0].x) + ' ' + r1(base);
        for (const p of pts) d += ' L' + r1(p.x) + ' ' + r1(p.y);
        d += ' L' + r1(pts[pts.length - 1].x) + ' ' + r1(base) + ' Z';
        S('path', { d: d, style: 'fill:' + tok('gold') + ';fill-opacity:.09;stroke:none' }, svg);
      }
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        const contiguous = b.i - a.i === 1;
        S('line', {
          x1: r1(a.x), y1: r1(a.y), x2: r1(b.x), y2: r1(b.y),
          style: contiguous
            ? 'stroke:' + tok('gold') + ';stroke-width:1.6;stroke-linecap:round'
            : 'stroke:' + tok('muted') + ';stroke-width:1;stroke-dasharray:2 3;stroke-linecap:round',
        }, svg);
      }
      pts.forEach((p, k) => {
        const last = k === pts.length - 1;
        const dot = S('circle', {
          cx: r1(p.x), cy: r1(p.y), r: last ? 3.2 : 2,
          style: last
            ? 'fill:' + tok('core') + ';stroke:' + tok('gold') + ';stroke-width:1.5'
            : 'fill:' + tok('gold'),
        }, svg);
        svgTitle(dot, (weekText(p.week) ? 'Week of ' + weekText(p.week) + ': ' : '') + 'median return ' + U.fmtDuration(p.v));
      });
      const lp = pts[pts.length - 1];
      svgText(svg, lp.x + 7, lp.y, U.fmtDuration(lp.v),
        FONT_MONO + ';font-size:11px;fill:' + tok('gold'), { 'dominant-baseline': 'central' });
    }

    const axis = FONT_UI + ';font-size:10px;fill:' + tok('muted');
    const firstWeek = weekText(weeks[0] && weeks[0].week);
    if (firstWeek) svgText(svg, padL, H - 3, firstWeek, axis);
    svgText(svg, padL + plotW, H - 3, 'this week', axis, { 'text-anchor': 'end' });

    mount(host, svg);
  }

  /* ----- Width-driven re-rendering of the 1:1 charts and strips ----- */
  function rerenderChart(id) {
    if (id === 'chartDays') guard('14-day chart', () => renderDays(lastAgg));
    else if (id === 'chartHeat') guard('heatmap', () => renderHeat(lastAgg, lastRealCount));
    else if (id === 'chartRecovery') guard('recovery', () => renderRecovery(lastAgg));
  }
  function onResize(entries) {
    for (const en of entries) pendingResize.add(en.target);
    if (!resizeRaf && typeof requestAnimationFrame === 'function') resizeRaf = requestAnimationFrame(flushResize);
  }
  function flushResize() {
    resizeRaf = 0;
    const targets = Array.from(pendingResize);
    pendingResize.clear();
    for (const t of targets) {
      if (stripRecords.has(t)) {
        const w = Math.round(t.clientWidth);
        if (w > 0 && String(w) !== t.getAttribute('data-drawn-w')) drawTimelineStrip(t, stripRecords.get(t));
      } else if (t.id && WIDTH_CHARTS.indexOf(t.id) >= 0 && renderGen > 0) {
        const w = measure(t, 0);
        if (w > 0 && Math.abs(w - chartWidths[t.id]) >= 2) rerenderChart(t.id);
      }
    }
  }
  /** Fallback when ResizeObserver is missing. */
  function onWindowResize() {
    if (renderGen > 0 && screenName() === 'history') for (const id of WIDTH_CHARTS) rerenderChart(id);
    const st = $('sumTimeline');
    if (st && stripRecords.has(st)) drawTimelineStrip(st, stripRecords.get(st));
    if (jarStrip && stripRecords.has(jarStrip) && jarRecord) drawTimelineStrip(jarStrip, jarRecord);
  }

  /* =================================================================== *
   * Jar dialog (§2.4.10)                                                 *
   * =================================================================== */
  function openJar(id) {
    let rec = null;
    try { rec = FT.Session && typeof FT.Session.load === 'function' ? FT.Session.load(id) : null; }
    catch (err) { warn('Session.load failed', err); }
    if (!rec) {
      toast("That session couldn't be found. It may have been removed.");
      return false;
    }
    const dlg = $('dlgJar');
    jarRecord = rec;
    disarmDelete();
    keepsakeBusy = false;
    setBusy($('btnJarKeepsake'), false);
    guard('jar details', () => fillJar(rec));
    if (dlg) showDialog(dlg);
    guard('jar strip', () => {
      const strip = ensureJarStrip();
      if (strip) drawTimelineStrip(strip, rec);
    });
    guard('jar canvas', () => drawJarCanvas(rec));
    return true;
  }

  function fillJar(rec) {
    const title = $('jarTitle');
    if (title) {
      title.textContent = FT.sessionTitle(rec);
    }
    let meta = labelFor(rec) + ' · ' + dateRangeText(rec);
    if (rec.rating >= 1 && rec.rating <= 5) meta += ' · felt ' + ratingWord(rec.rating).toLowerCase();
    setText('jarMeta', meta);
    const stats = $('jarStats');
    if (stats) {
      stats.textContent = '';
      for (const t of tileData(rec)) stats.appendChild(makeTile(t));
    }
    setText('jarDiagnosis', rec.diagnosis || '');
  }

  /** SPEC-GAP: the jar dialog reuses the summary strip (addendum §C "reused by the jar dialog if
   *  desired"); it has no id in §3.4, so it is injected once, right after #jarStats. */
  function ensureJarStrip() {
    if (jarStrip && jarStrip.isConnected) return jarStrip;
    const stats = $('jarStats');
    if (!stats || !stats.parentNode) return null;
    const c = mk('canvas', 'jar-strip');
    c.style.cssText = 'display:block;width:100%;height:28px;margin:12px 0 4px';
    stats.insertAdjacentElement('afterend', c);
    jarStrip = c;
    observeStrip(c);
    return c;
  }

  function drawDishPlaceholder(ctx, c, R) {
    const g = ctx.createRadialGradient(c, c, 0, c, c, R * 1.06);
    g.addColorStop(0, '#0E1D20');
    g.addColorStop(1, '#0A1517');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, c, R * 1.06, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(207,230,223,0.12)';
    ctx.stroke();
    drawTrack(ctx, c, c, R * 0.84, 1);
  }

  /** #jarCanvas: 280×280 CSS at DPR; placeholder now, the session ring on the next frame. */
  function drawJarCanvas(rec) {
    const cv = $('jarCanvas');
    if (!cv || typeof cv.getContext !== 'function') return;
    const token = ++jarDrawToken;
    // Contract size is 280 CSS px; the clamp stops an unstyled canvas from growing with its own backing store.
    const css = U.clamp(Math.round(cv.clientWidth) || 280, 120, 280);
    const dpr = dprCap(2);
    const px = Math.max(1, Math.round(css * dpr));
    cv.width = px;
    cv.height = px;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = css / 2;
    // SPEC-GAP: specimen radius 0.88 × half the canvas, so drawSpecimen's glass (≈1.06 r) fits.
    const R = c * 0.88;
    drawDishPlaceholder(ctx, c, R);
    cv.removeAttribute('aria-hidden');       // the markup hides it; the label below must reach AT (§10.5)
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', FT.sessionTitle(rec) + ': focus ring for the session. ' + (rec.diagnosis || ''));
    if (!FT.Visual || typeof FT.Visual.drawSpecimen !== 'function') return;

    const run = () => {
      if (token !== jarDrawToken) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        FT.Visual.drawSpecimen(ctx, rec, c, c, R, { quality: 'full', fruit: true, background: true });
      } catch (err) {
        warn('drawSpecimen (jar) failed', err);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, px, px);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawDishPlaceholder(ctx, c, R);
        return;
      }
      if (!reducedMotion() && typeof cv.animate === 'function') {
        try { cv.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 520, easing: EASE_ORGANIC }); } catch (err) { /* decorative */ }
      }
    };
    // Let the dialog paint first (a full regrow can take a couple of hundred ms). rAF is raced
    // with a timeout because rAF is suspended while the tab is hidden.
    let ran = false;
    const once = () => { if (!ran) { ran = true; run(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(once, 0));
    setTimeout(once, 120);
  }

  /* ----- Two-step delete: "Tap again to delete" for 3 s ----- */
  function labelNode(btn) {
    const el = btn.querySelector('.btn-label, .label');
    if (el) return el;
    for (let n = btn.lastChild; n; n = n.previousSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return n;
    }
    return null;
  }
  function armLabel(btn, text) {
    const node = labelNode(btn);
    const aria = btn.getAttribute('aria-label');
    if (node) {
      delLabel = { btn: btn, node: node, original: node.nodeType === 3 ? node.nodeValue : node.textContent, added: false, aria: aria };
      if (node.nodeType === 3) node.nodeValue = ' ' + text + ' ';
      else node.textContent = text;
    } else {
      const t = document.createTextNode(text);
      btn.appendChild(t);
      delLabel = { btn: btn, node: t, original: null, added: true, aria: aria };
    }
    if (aria != null) btn.setAttribute('aria-label', text);
  }
  function restoreLabel() {
    if (!delLabel) return;
    const d = delLabel;
    delLabel = null;
    if (d.added) d.node.remove();
    else if (d.node.nodeType === 3) d.node.nodeValue = d.original;
    else d.node.textContent = d.original;
    if (d.aria != null) d.btn.setAttribute('aria-label', d.aria);
  }
  function disarmDelete() {
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = 0; }
    deleteArmed = false;
    const btn = $('btnJarDelete');
    if (btn) btn.removeAttribute('data-armed');
    restoreLabel();
  }
  function onJarDelete() {
    const btn = $('btnJarDelete');
    if (!btn || !jarRecord) return;
    if (!deleteArmed) {
      deleteArmed = true;
      btn.setAttribute('data-armed', 'true');
      armLabel(btn, 'Tap again to delete');
      announce('Press Delete again within 3 seconds to remove this session.');
      deleteTimer = setTimeout(disarmDelete, DELETE_WINDOW_MS);
      return;
    }
    disarmDelete();
    const rec = jarRecord;
    if (!FT.Session || typeof FT.Session.remove !== 'function') {
      toast("Sessions can't be removed right now.");
      return;
    }
    try { FT.Session.remove(rec.id); } catch (err) {
      console.error(LOG, 'remove failed:', err);
      toast("Couldn't remove that session. Please try again.");
      return;
    }
    dropThumbs(rec.id);
    // app.js usually re-renders the terrarium synchronously on history:change; either way, take
    // the jar off the shelf and hand focus to a neighbour.
    jarOpener = removeJarFromShelves(rec.id) || firstJar() || $('btnHistBack');
    closeDialog($('dlgJar'));
    toast('Session #' + rec.no + ' was removed from your history.');
  }
  function firstJar() {
    const host = $('shelves');
    return host ? host.querySelector('button.jar') : null;
  }
  function removeJarFromShelves(id) {
    const host = $('shelves');
    if (!host) return null;
    const target = Array.from(host.querySelectorAll('button.jar')).find((b) => b.getAttribute('data-id') === String(id));
    if (!target) return null;
    const next = target.nextElementSibling || target.previousElementSibling;
    const shelf = target.closest('.shelf');
    target.remove();
    if (shelf && !shelf.querySelector('button.jar')) shelf.remove();
    return next && next.isConnected ? next : null;
  }
  function onJarClosed() {
    disarmDelete();
    jarDrawToken++;
    jarRecord = null;
    const opener = jarOpener;
    jarOpener = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus({ preventScroll: false }); } catch (err) { /* ignore */ }
    }
  }
  function onShelvesClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('button.jar') : null;
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    jarOpener = btn;
    if (!openJar(id)) jarOpener = null;
  }

  /* =================================================================== *
   * Data: export / import / erase                                        *
   * =================================================================== */
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }, 10000);
  }

  function exportData() {
    const S_ = FT.Session;
    if (!S_ || typeof S_.exportJSON !== 'function') {
      toast("Export isn't available right now.");
      return false;
    }
    let data;
    try { data = S_.exportJSON(); } catch (err) {
      console.error(LOG, 'export failed:', err);
      toast("Couldn't export your data. " + errMsg(err));
      return false;
    }
    if (data && typeof data.then === 'function') {
      return data.then(finishExport, (err) => {
        console.error(LOG, 'export failed:', err);
        toast("Couldn't export your data. " + errMsg(err));
        return false;
      });
    }
    return finishExport(data);
  }
  function finishExport(data) {
    // SPEC-GAP: exportJSON() may return the JSON text or the export object; null means nothing to save.
    if (data == null) return false;
    let text;
    try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch (err) {
      console.error(LOG, 'export serialise failed:', err);
      toast("Couldn't export your data. " + errMsg(err));
      return false;
    }
    const name = 'focus-tracker-export-' + U.dayKey() + '.json';
    try { downloadBlob(new Blob([text], { type: 'application/json' }), name); } catch (err) {
      console.error(LOG, 'export download failed:', err);
      toast("Couldn't start the download. " + errMsg(err));
      return false;
    }
    let n = null;
    if (typeof data === 'object' && Array.isArray(data.sessions)) n = data.sessions.length;
    else {
      try { n = (FT.Session.list() || []).length; } catch (err) { n = null; }
    }
    toast(n == null ? 'Exported ' + name + '.' : 'Exported ' + plural(n, 'session') + ' to ' + name + '.');
    return true;
  }

  /** Opens the file picker (call synchronously from a click). The change handler does the rest. */
  function importData() {
    const input = $('importFile');
    if (!input) { toast("Import isn't available right now."); return; }
    try { input.value = ''; } catch (err) { /* ignore */ }
    try { lendImportInput(input); } catch (err) { warn('import picker relocation failed', err); }
    input.click();
  }
  /**
   * From Settings, #importFile sits in a hidden screen (display:none) behind a modal dialog (inert),
   * where some engines ignore .click(). Lend it to the top open dialog (or <body>) while the picker is
   * up, then put it back. The same element moves, so its change listener stays attached.
   */
  let importLoan = null;   // { input, parent, next, off } while #importFile is lent out
  function lendImportInput(input) {
    returnImportInput();
    const open = Array.from(document.querySelectorAll('dialog[open]'));
    let top = null;
    for (const d of open) {
      try { if (d.matches(':modal')) top = d; } catch (err) { /* no :modal support */ }
    }
    if (!top && open.length) top = open[open.length - 1];
    const blocked = !!input.closest('[hidden],[inert]') || input.getClientRects().length === 0 ||
      !!(top && !top.contains(input));
    if (!blocked) return;
    let timer = 0;
    const back = () => { setTimeout(returnImportInput, 0); };                   // after onImportChange read .files
    const onFocus = () => { clearTimeout(timer); timer = setTimeout(back, 1000); };  // picker closed, no change/cancel
    const off = () => {
      clearTimeout(timer);
      input.removeEventListener('change', back);
      input.removeEventListener('cancel', back);
      window.removeEventListener('focus', onFocus);
    };
    importLoan = { input: input, parent: input.parentNode, next: input.nextSibling, off: off };
    (top || document.body).appendChild(input);
    input.addEventListener('change', back);
    input.addEventListener('cancel', back);
    window.addEventListener('focus', onFocus);
  }
  function returnImportInput() {
    const loan = importLoan;
    if (!loan) return;
    importLoan = null;
    loan.off();
    if (!loan.parent || !loan.parent.isConnected) return;
    try {
      loan.parent.insertBefore(loan.input, loan.next && loan.next.parentNode === loan.parent ? loan.next : null);
    } catch (err) { /* ignore */ }
  }
  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error("The file couldn't be read."));
      fr.readAsText(file);
    });
  }
  async function onImportChange(ev) {
    const input = (ev && ev.currentTarget) || $('importFile');
    const file = input && input.files && input.files[0];
    if (!file) return;
    const S_ = FT.Session;
    try {
      if (!S_ || typeof S_.importJSON !== 'function') throw new Error("Import isn't available right now.");
      if (file.size > 32 * 1024 * 1024) throw new Error('That file is too large to be a Focus Tracker export.');
      const text = await readFileText(file);
      const res = await S_.importJSON(text);
      reportImport(res);
    } catch (err) {
      console.warn(LOG, 'import failed:', err);
      toast(err && err.name === 'SyntaxError'
        ? "That file isn't a Focus Tracker export (it isn't valid JSON)."
        : "Couldn't import that file. " + errMsg(err), { timeout: 9000 });
    } finally {
      try { input.value = ''; } catch (err) { /* ignore */ }
    }
  }
  function reportImport(res) {
    const added = Math.max(0, num(res && res.added)), skipped = Math.max(0, num(res && res.skipped));
    const errs = res ? res.errors : null;
    // SPEC-GAP: `errors` may be an array (of strings or Errors) or a count.
    const errCount = Array.isArray(errs) ? errs.length : typeof errs === 'number' ? Math.max(0, errs) : errs ? 1 : 0;
    const first = Array.isArray(errs) ? errs[0] : errs;
    const detail = typeof first === 'string' ? first : first && typeof first === 'object' ? errMsg(first) : '';
    if (!added && !skipped && errCount) {
      toast("Couldn't import that file." + (detail ? ' ' + detail : ''), { timeout: 9000 });
      return;
    }
    let text = 'Imported ' + plural(added, 'session') + ' (' + skipped + ' already here).';
    if (errCount) text += ' ' + plural(errCount, 'entry', 'entries') + " couldn't be read.";
    toast(text);
  }

  function confirmErase() {
    const dlg = $('dlgErase');
    if (!dlg) {
      // SPEC-GAP: without the dialog markup, fall back to a native confirm.
      if (window.confirm("Erase every session, setting and calibration? This can't be undone.")) doErase();
      return;
    }
    const btn = $('btnEraseConfirm');
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    showDialog(dlg);
    const cancel = $('btnEraseCancel');
    if (cancel) { try { cancel.focus(); } catch (err) { /* ignore */ } }   // safe default for a destructive dialog
  }
  function doErase() {
    const btn = $('btnEraseConfirm');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try {
      if (!FT.Session || typeof FT.Session.eraseAll !== 'function') throw new Error("Erase isn't available right now.");
      FT.Session.eraseAll();
    } catch (err) {
      console.error(LOG, 'erase failed:', err);
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      toast("Couldn't erase everything. " + errMsg(err));
      return;
    }
    try {
      if (FT.Detector && typeof FT.Detector.forgetCalibration === 'function') FT.Detector.forgetCalibration();
    } catch (err) { warn('forgetCalibration failed', err); }
    thumbCache.clear();
    closeDialog($('dlgErase'));
    location.reload();
  }

  /* =================================================================== *
   * Navigation buttons                                                   *
   * =================================================================== */
  function back() {
    try {
      if (FT.App && typeof FT.App.back === 'function') { FT.App.back(); return; }
    } catch (err) { console.error(LOG, 'App.back failed:', err); return; }
    go(FT.Session && FT.Session.phase === 'complete' ? 'summary' : 'setup');
  }
  function growAnother() {
    clearTimeout(typeTimer);
    typeTimer = 0;
    try {
      const S_ = FT.Session;
      if (S_ && typeof S_.reset === 'function' && (S_.phase === 'complete' || S_.phase === undefined)) S_.reset();
    } catch (err) { warn('Session.reset failed', err); }
    go('setup');
  }

  function onHistoryChange(ev) {
    const reason = ev && ev.reason;
    if (reason === 'erased') thumbCache.clear();
  }

  /* =================================================================== *
   * init — wires every DOM handler history.js owns (addendum §C)         *
   * =================================================================== */
  function on(id, type, fn) {
    const el = $(id);
    if (el) el.addEventListener(type, fn);
    else if (FT.env && FT.env.debug) console.warn(LOG, 'missing #' + id);
    return el;
  }

  function init() {
    if (inited) return FT.History;
    inited = true;

    if (typeof window.ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(onResize);
      for (const id of WIDTH_CHARTS) {
        const el = $(id);
        if (el) resizeObs.observe(el);
      }
      const st = $('sumTimeline');
      if (st && typeof st.getContext === 'function') observeStrip(st);
    } else {
      window.addEventListener('resize', U.throttle(onWindowResize, 150));
    }

    // Terrarium
    on('btnHistBack', 'click', back);
    on('btnHistStart', 'click', () => go('setup'));
    on('btnExport', 'click', () => { exportData(); });
    on('btnImport', 'click', importData);
    on('importFile', 'change', onImportChange);
    on('btnErase', 'click', confirmErase);
    on('shelves', 'click', onShelvesClick);

    // Erase dialog
    on('btnEraseConfirm', 'click', doErase);
    on('btnEraseCancel', 'click', () => closeDialog($('dlgErase')));

    // Jar dialog
    on('btnJarKeepsake', 'click', () => { if (jarRecord) keepsake(jarRecord, $('btnJarKeepsake')); });
    on('btnJarDelete', 'click', onJarDelete);
    on('btnJarClose', 'click', () => closeDialog($('dlgJar')));
    const jarDlg = $('dlgJar');
    if (jarDlg) {
      jarDlg.addEventListener('close', onJarClosed);
      // Clicking the backdrop (outside the dialog box) closes it.
      jarDlg.addEventListener('click', (e) => {
        if (e.target !== jarDlg) return;
        const r = jarDlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(jarDlg);
      });
    }

    // Summary sheet
    const rating = on('sumRating', 'click', onRatingClick);
    if (rating) rating.addEventListener('keydown', onRatingKey);
    on('btnKeepsake', 'click', () => {
      if (currentRecord) keepsake(currentRecord, $('btnKeepsake'));
      else toast('Nothing to save yet. Finish a session first.');
    });
    on('btnToTerrarium', 'click', () => go('history'));
    on('btnAgain', 'click', growAnother);
    syncRating(null);

    FT.bus.on('history:change', onHistoryChange);
    return FT.History;
  }

  /* =================================================================== *
   * Public API                                                           *
   * =================================================================== */
  FT.History = {
    init: init,
    renderTerrarium: renderTerrarium,
    fillSummary: fillSummary,
    openJar: openJar,
    drawTimelineStrip: drawTimelineStrip,
    exportData: exportData,
    importData: importData,
    confirmErase: confirmErase,
    saveKeepsake: saveKeepsake,
    // Optional extras (not in the contract)
    compassText: compassText,
    labelFor: labelFor,
    get currentRecord() { return currentRecord; },
    get jarOpen() { const d = $('dlgJar'); return !!(d && d.open && jarRecord); },
  };
})();
