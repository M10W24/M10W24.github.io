/*!
 * Hypha — js/app.js  (SPEC.md §2, §3.2, §4.8, §7.2–7.6, §9, §10 + SPEC-ADDENDUM §D)
 * FT.App: the flow and all wiring. Screens, begin sequence, HUD, field notes, banners,
 * chrome fade, fruiting, title/favicon, nudges, PiP, privacy counter, settings dialog,
 * the Eye widget + lens cap, keyboard shortcuts, the render loop and the debug panel.
 * Classic script, loaded LAST with `defer`.
 */
(function () {
  'use strict';

  const FT = window.FT, U = FT.util;
  const LOG = '[Hypha:app]';

  /* =================================================================== *
   * 1. Small helpers — every DOM helper tolerates a missing element      *
   * =================================================================== */
  const $ = (id) => document.getElementById(id);
  const elOf = (t) => (typeof t === 'string' ? $(t) : t);
  const nowMs = () => performance.now();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const warned = new Set();
  function warnOnce(key, err) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(LOG, key, err || '');
  }

  /** True when FT[mod][fn] is callable. */
  function has(mod, fn) {
    const m = FT[mod];
    return !!m && typeof m[fn] === 'function';
  }
  /** Guarded cross-module call: missing module/function → undefined; a throw is logged once. */
  function call(mod, fn, ...args) {
    const m = FT[mod];
    if (!m || typeof m[fn] !== 'function') return undefined;
    try { return m[fn](...args); }
    catch (err) { warnOnce(mod + '.' + fn + ' threw', err); return undefined; }
  }
  /** Guarded getter read. */
  function get(mod, prop, fallback) {
    try {
      const m = FT[mod];
      const v = m ? m[prop] : undefined;
      return v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  function on(target, type, fn, opts) {
    const el = elOf(target);
    if (el) el.addEventListener(type, fn, opts);
    return el;
  }
  function click(target, fn) { return on(target, 'click', fn); }
  function show(target, visible) {
    const el = elOf(target);
    if (el && el.hidden === !!visible) el.hidden = !visible;
  }
  function isShown(target) {
    const el = elOf(target);
    return !!el && !el.hidden;
  }
  function setText(target, text) {
    const el = elOf(target);
    if (!el) return;
    text = text == null ? '' : String(text);
    if (el.textContent !== text) el.textContent = text;
  }
  function setAttr(target, name, value) {
    const el = elOf(target);
    if (!el) return;
    if (value == null || value === false) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else {
      value = value === true ? '' : String(value);
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    }
  }
  function bodyAttr(name, value) {
    const b = document.body;
    if (!b) return;
    if (value == null) { if (name in b.dataset) delete b.dataset[name]; return; }
    value = String(value);
    if (b.dataset[name] !== value) b.dataset[name] = value;
  }
  function setDisabled(target, disabled) {
    const el = elOf(target);
    if (el && el.disabled !== !!disabled) el.disabled = !!disabled;
  }
  function setBusy(target, busy) { setAttr(target, 'aria-busy', busy ? 'true' : null); }

  /**
   * Update a button's label (visible text span or text node, plus aria-label when the
   * button already has one or is icon-only) and optionally its sprite icon.
   */
  function setBtn(target, label, icon) {
    const el = elOf(target);
    if (!el) return;
    if (icon) {
      const use = el.querySelector('use');
      if (use) {
        const href = '#' + icon;
        if (use.getAttribute('href') !== href) use.setAttribute('href', href);
        if (use.hasAttribute('xlink:href')) use.setAttribute('xlink:href', href);
      }
    }
    if (label == null) return;
    const svg = el.querySelector('svg');
    // Prefer the explicit label span; never pick a wrapper that holds the icon (e.g. .ctrl-icon).
    const span = el.querySelector('.btn-label') || el.querySelector('.label') ||
      Array.from(el.querySelectorAll('span')).find((s) => !s.querySelector('svg') && !s.classList.contains('sr-only')) || null;
    let textNode = null;
    if (!span) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.nodeValue.trim()) { textNode = n; break; }
      }
    }
    if (span) setText(span, label);
    else if (textNode) { if (textNode.nodeValue.trim() !== label) textNode.nodeValue = (svg ? ' ' : '') + label; }
    else if (!svg) setText(el, label);
    if (el.hasAttribute('aria-label') || (svg && !span && !textNode)) setAttr(el, 'aria-label', label);
  }

  const fmtTime = (ms) => {
    try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
    catch (e) { const d = new Date(ms); return d.getHours() + ':' + U.pad2(d.getMinutes()); }
  };
  const fmtDayMonth = (ms) => {
    try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(ms)); }
    catch (e) { return U.dayKey(ms); }
  };
  const fmtMB = (bytes) => (bytes / 1e6).toFixed(1);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  /* =================================================================== *
   * 2. Tables (copy from the spec)                                       *
   * =================================================================== */
  const SCREENS = ['intro', 'setup', 'permission', 'loading', 'calibrate', 'session', 'summary', 'history', 'error'];
  const EYE_SCREENS = new Set(['setup', 'permission', 'loading', 'calibrate', 'session']);
  const SCREEN_PHASE = {
    intro: 'intro', setup: 'idle', permission: 'idle', error: 'idle', history: 'idle',
    loading: 'loading', calibrate: 'calibrating', summary: 'complete',
  };
  const TITLE_DEFAULT = 'Hypha — focus, grown in light';
  const TITLE_SHORT = 'Hypha';

  const GLYPH = {
    rooted: '◉', growing: '◉', wavering: '◎', shy: '○', sinking: '○', elsewhere: '○',
    asleep: '◡', dormant: '·', unseen: '◌', resting: '◠', paused: '‖',
  };
  const AWAY_WORDS = new Set(['shy', 'sinking', 'elsewhere']);

  const LOAD_PHASE_TEXT = {
    camera: 'Opening the camera…',
    script: 'Fetching the engine…',
    model: 'Growing the eye…',
    wasm: 'Preparing the engine…',
    warmup: 'Warming up. The first run takes a few seconds…',
  };

  const MODE_IDS = { free: 'modeFree', pomodoro: 'modePomodoro', deep: 'modeDeep', custom: 'modeCustom' };
  const SENS_IDS = { gentle: 'sensGentle', standard: 'sensStandard', strict: 'sensStrict' };
  const SENS_HELP = {
    gentle: 'Wider screen area and longer grace for glances. Growth never retracts.',
    standard: 'Balanced. Glances under about 1.5 s are free.',
    strict: 'Tighter area and shorter grace. For deep-work sprints.',
  };

  const CAL_TEXT = {
    centerFull: 'Sit as you usually work. Look at the glowing spore.',
    settling: 'Hold still… it\'s taking root.',
    quick: 'Look at the spore for a moment.',
    done: 'Rooted. Your screen is mapped.',
  };
  const CORNER_NAMES = ['', 'top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const CAL_HINTS = {
    closer: 'Move a little closer to the camera.',
    light: 'It\'s a bit dark. Face a window or a lamp.',
    noface: 'Can\'t see you yet. Check your lighting and that your face is in frame.',
  };

  /** §2.5 error table. Actions: retry, timer, demo, back. */
  const ERRORS = {
    InsecureContext: {
      title: 'Camera needs a secure page',
      body: () => 'Browsers only allow the camera on https://, on http://localhost, or for a file opened directly. This page is on ' +
        (location.origin && location.origin !== 'null' ? location.origin : location.protocol + '//' + location.host + location.pathname) + '.',
      actions: ['timer', 'demo', 'back'],
    },
    Unsupported: {
      title: 'This browser can\'t use the camera',
      body: 'Try a recent Chrome, Edge, Firefox or Safari. You can still use Hypha as a timer.',
      actions: ['timer', 'demo', 'back'],
    },
    NotAllowedError: {
      title: 'Camera access is blocked',
      body: 'Allow the camera from the icon in your address bar (or in site settings), then try again. Nothing is recorded either way.',
      actions: ['retry', 'timer', 'demo'],
    },
    NotFoundError: {
      title: 'No camera found',
      body: 'Plug in a webcam or enable it in your system settings, then try again.',
      actions: ['retry', 'timer', 'demo'],
    },
    NotReadableError: {
      title: 'Your camera is busy',
      body: 'Another app may be using it, such as Zoom, Teams or FaceTime. Close it, then try again.',
      actions: ['retry', 'timer', 'demo'],
    },
    OverconstrainedError: {
      title: 'Camera settings not supported',
      body: 'Your camera doesn\'t support the requested mode. Try another camera in Settings.',
      actions: ['retry', 'timer'],
    },
    SecurityError: {
      title: 'Camera disabled by policy',
      body: 'A browser or system policy blocks the camera on this page.',
      actions: ['timer', 'demo'],
    },
    CameraFailed: {
      title: 'The camera couldn\'t start',
      body: 'Something interrupted it. Try again, or restart your browser.',
      actions: ['retry', 'timer', 'demo'],
    },
    NoWebGL2: {
      title: 'Face tracking needs WebGL2',
      body: 'Turn on hardware acceleration in your browser settings, then reload. Hypha still works as a timer.',
      actions: ['timer', 'demo', 'back'],
    },
    ModelLoadFailed: {
      title: 'Couldn\'t download the face model',
      body: 'Hypha fetches about 7 MB once, then keeps it cached. Check your connection and try again.',
      actions: ['retry', 'timer', 'demo'],
    },
    ModelInitFailed: {
      title: 'Face tracking couldn\'t start here',
      body: 'Your browser or graphics driver refused the model. Try Chrome or Edge, or use timer mode.',
      actions: ['retry', 'timer', 'demo'],
    },
    CalibrationFailed: {
      title: 'Couldn\'t find your face',
      body: 'Make sure your face is lit and in frame, about an arm\'s length from the camera.',
      actions: ['retry', 'timer', 'back'],
    },
  };
  // SPEC-GAP: the "{short reason}" in the camera row is not specified; these are our short forms.
  const ERROR_SHORT = {
    InsecureContext: 'needs a secure page', Unsupported: 'not supported in this browser',
    NotAllowedError: 'access blocked', NotFoundError: 'no camera found', NotReadableError: 'busy in another app',
    OverconstrainedError: 'mode not supported', SecurityError: 'blocked by policy', CameraFailed: 'couldn\'t start',
    NoWebGL2: 'WebGL2 is off', ModelLoadFailed: 'model download failed', ModelInitFailed: 'tracking couldn\'t start',
    CalibrationFailed: 'couldn\'t find your face', CameraLost: 'disconnected',
  };
  const normErrorCode = (code) => (code && ERRORS[code] ? code : 'CameraFailed');

  // Lower-case phrases for "Last drift: looking down, 12s ago".
  const CAUSE_PHRASE = {
    down: 'looking down', turned: 'turned away', glance: 'a side glance', up: 'looking up',
    tab: 'another tab', eyes: 'eyes closed', absent: 'stepped away',
  };

  /** Intro step-2 scripted demo (§2.4.1, §6.7). Each state lasts 2.8 s. */
  const INTRO_DEMO = [
    { word: 'rooted', gloss: 'Eyes on your work, so it grows.', state: 'focused', cause: null, focus: 0.92, dir: { x: 0.06, y: 0.04 } },
    { word: 'wavering', gloss: 'Attention near the edge, so growth slows.', state: 'drifting', cause: null, focus: 0.6, dir: { x: 0.9, y: 0.12 }, sided: true },
    { word: 'shy', gloss: 'You turned away, so it flinches from that side.', state: 'away', cause: 'turned', focus: 0.35, dir: { x: 1.5, y: 0.05 }, sided: true, offScreen: true },
    { word: 'sinking', gloss: 'A phone check drains the light downward.', state: 'away', cause: 'down', focus: 0.3, dir: { x: 0.05, y: 1.6 }, offScreen: true },
    { word: 'asleep', gloss: 'Eyes closed: it rests with you. Thinking is allowed.', state: 'eyes-closed', cause: 'eyes', focus: 0.5, dir: null, eyeOpen: 0 },
    { word: 'dormant', gloss: 'You stepped away. It waits, and your timer can pause.', state: 'absent', cause: 'absent', focus: 0.2, dir: null, present: false },
  ];
  const INTRO_STEP_MS = 2800;

  const SIM_KINDS = ['focus', 'glance', 'turn', 'phone', 'closed', 'absent', 'drowsy'];
  const EYE_MODES = ['mesh', 'video', 'off'];
  const EYE_MODE_IDS = { mesh: 'eyeModeMesh', video: 'eyeModeVideo', off: 'eyeModeOff' };
  const EYE_MODE_NAMES = { mesh: 'dots', video: 'video', off: 'hidden' };

  const DEFAULT_SETTINGS = {
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
  function normSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    const out = Object.assign({}, DEFAULT_SETTINGS, s);
    out.pomodoro = Object.assign({}, DEFAULT_SETTINGS.pomodoro, s.pomodoro || {});
    out.custom = Object.assign({}, DEFAULT_SETTINGS.custom, s.custom || {});
    return out;
  }

  /* =================================================================== *
   * 3. App state                                                         *
   * =================================================================== */
  const S = {
    inited: false,
    screen: null,
    settings: normSettings(null),

    // begin flow
    flow: null,              // {token, source, context} while a begin/recalibrate flow runs
    flowSeq: 0,
    pendingAfterPermission: null, // 'begin' | 'check'
    lastSource: 'camera',
    errContext: null,        // {code, source, from}

    // camera / detector
    camStatus: 'idle',
    camSource: null,
    camInfo: null,           // last detector:camera payload
    camMuted: false,
    checking: false,         // "Check framing" start in flight
    checkPromise: null,      // its promise (never rejects), so Begin can wait for it
    checkTimer: 0,
    lensBusy: false,
    lastSampleAt: 0,
    stallSince: 0,
    lastCamError: null,      // {code, message}
    sample: null,
    detState: null, detCause: null, detReason: '', detStateAt: 0,
    loading: null,
    loadHintTimer: 0,

    // calibration
    calInput: null,          // VisualInput.calibration
    calKind: null,
    calBackground: false,
    calLastEvent: null,

    // session
    sessionSource: null,     // 'camera' | 'sim' | 'none' for the active session
    capSource: null,         // source to restore when the lens cap comes off
    live: null,              // latest LiveStats
    fruiting: false,
    fruitTitleUntil: 0,
    fruitNo: 0,
    discarding: false,
    word: 'none',
    wordSince: 0,
    lastRootedAt: 0,
    announcedWord: null,
    lastStateAnnounceAt: -1e12,
    pendingPhaseAnnounce: null,
    lastPauseReason: null,
    breakRestAnnounced: false,
    camBanner: null,         // 'lost' | 'muted' | 'stalled' | 'tracking'
    drowsyCooldownUntil: 0,
    lastForgiveToastAt: -1e12,
    simKind: null,

    // nudges (§7.2)
    away: { active: false, since: 0, sound: false, toast: false, notify: false },
    lastNudgeSoundAt: -1e12,
    lastNudgeToastAt: -1e12,
    lastNotifyAt: -1e12,

    // chrome fade
    chrome: 'full',
    lastActivity: 0,

    // field notes
    notesOpen: false,
    spark: new Float32Array(600).fill(NaN),
    sparkHead: 0,
    sparkLastAt: 0,

    // title / favicon / periodic
    lastTitle: '',
    lastTitleWord: null,
    titleWord: null,
    lastSecondKey: -1,
    favKey: '',
    favLastAt: -1e12,
    favIsDefault: true,
    faviconDefault: '',
    favCanvas: null,
    todayLastAt: -1e12,
    lastAudioAt: 0,
    lastHalfSecAt: 0,
    lastMinuteKey: -1,

    // privacy
    trackingSince: null,
    resEntries: [],
    blocked: 0,

    // pip
    pip: null,
    pipLastDraw: 0,

    // intro
    intro: { step: 0, demoIdx: 0, demoSince: 0, demoTimer: 0, blinkTimer: 0, side: -1 },

    // misc
    raf: 0,
    loopErrLogged: false,
    debugVisible: false,
    visualQuality: null,
    toastSeq: 0,
    eyeMenuOpen: false,
    dialogOpeners: new Map(),
  };

  const sessionPhase = () => get('Session', 'phase', 'idle') || 'idle';
  const sessionActive = () => {
    const p = sessionPhase();
    return p === 'running' || p === 'paused' || p === 'break';
  };
  const detRunning = () => !!get('Detector', 'running', false);
  const detStatus = () => get('Detector', 'status', 'idle') || 'idle';
  const detStarting = () => {
    const st = detStatus();
    return st === 'starting' || st === 'loading' || st === 'warming';
  };
  const cameraOn = () => detRunning() || detStarting();

  /* =================================================================== *
   * 4. Toasts and announcements (§2.3, §4.8.1, §10.4)                    *
   * =================================================================== */
  function toastEls(box) {
    if (box === undefined) box = $('toasts');
    if (!box) return [];
    return Array.from(box.children).filter((c) => c.classList && c.classList.contains('toast') && !c.classList.contains('is-leaving'));
  }
  /** #toasts plus every in-dialog host (see dialogToastHost). */
  function allToastEls() {
    let out = toastEls();
    for (const host of document.querySelectorAll('.toasts-dlg')) out = out.concat(toastEls(host));
    return out;
  }
  /**
   * An open modal dialog sits in the top layer and makes everything outside it inert, so the body-level
   * #toasts would be covered/blurred and dropped from the accessibility tree. Toasts raised while one is
   * open render into a host inside that dialog instead. (#toasts itself is not reparented: .dlg has
   * backdrop-filter and overflow:hidden, so its position:fixed would be clipped.)
   */
  function dialogToastHost(dlg) {
    let host = null;
    for (const c of dlg.children) if (c.classList.contains('toasts-dlg')) { host = c; break; }
    if (host) return host;
    host = document.createElement('div');
    host.className = 'toasts-dlg';
    host.setAttribute('aria-live', 'polite');
    host.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:5;display:flex;' +
      'flex-direction:column;align-items:center;gap:8px;pointer-events:none;width:min(560px,calc(100% - 32px))';
    dlg.insertBefore(host, dlg.firstChild);
    // Don't let a leftover toast (or its action button) reappear, or take autofocus, on the next showModal().
    dlg.addEventListener('close', () => {
      for (const el of Array.from(host.children)) { clearTimeout(el._toastTimer); el.remove(); }
    });
    return host;
  }
  /** A screen-reader live region inside an open modal dialog (created once per dialog and politeness). */
  function dialogLiveRegion(dlg, assertive) {
    const cls = assertive ? 'sr-dlg-alert' : 'sr-dlg-status';
    for (const c of dlg.children) if (c.classList.contains(cls)) return c;
    const el = document.createElement('div');
    el.className = 'sr-only ' + cls;
    if (assertive) el.setAttribute('role', 'alert');
    else el.setAttribute('aria-live', 'polite');
    dlg.insertBefore(el, dlg.firstChild);
    return el;
  }
  function armToast(el, ms) {
    clearTimeout(el._toastTimer);
    el._toastTimer = 0;
    el._toastPaused = false;
    if (!(ms > 0) || !isFinite(ms)) { el._toastRemaining = Infinity; return; }
    el._toastRemaining = ms;
    el._toastStart = Date.now();
    el._toastTimer = setTimeout(() => dismissToastEl(el), ms);
  }
  function pauseToast(el) {
    if (!el._toastTimer) return;
    clearTimeout(el._toastTimer);
    el._toastTimer = 0;
    el._toastRemaining = Math.max(0, el._toastRemaining - (Date.now() - el._toastStart));
    el._toastPaused = true;
  }
  function resumeToast(el) {
    if (!el._toastPaused || !isFinite(el._toastRemaining)) return;
    if (el.matches(':hover') || el.contains(document.activeElement)) return;
    armToast(el, Math.max(1500, el._toastRemaining));
  }
  function dismissToastEl(el) {
    if (!el || el.classList.contains('is-leaving')) return;
    clearTimeout(el._toastTimer);
    el._toastTimer = 0;
    el.classList.add('is-leaving');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
  }
  function dismissToast(id) {
    for (const el of allToastEls()) if (el.dataset.toastId === String(id)) dismissToastEl(el);
  }

  /** toast(text, {action: {label, onClick}, timeout = 6000, id}) → id. timeout <= 0 keeps it until dismissed. */
  function toast(text, opts) {
    opts = opts || {};
    const id = opts.id != null ? String(opts.id) : 't' + (++S.toastSeq);
    const timeout = opts.timeout == null ? 6000 : opts.timeout;
    const dlg = topDialog();
    const box = dlg ? dialogToastHost(dlg) : $('toasts');
    if (!box) { announce(text); return id; }

    let el = toastEls(box).find((t) => t.dataset.toastId === id) || null;
    if (el) {
      setText(el.querySelector('.toast-text'), text);
      armToast(el, timeout);
      return id;
    }
    const live = toastEls(box);
    while (live.length >= 2) dismissToastEl(live.shift());

    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.dataset.toastId = id;
    const span = document.createElement('span');
    span.className = 'toast-text';
    span.textContent = text;
    el.appendChild(span);
    if (opts.action && opts.action.label) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = opts.action.label;
      b.addEventListener('click', () => {
        try { if (typeof opts.action.onClick === 'function') opts.action.onClick(); }
        catch (err) { console.error(LOG, 'toast action threw', err); }
        dismissToastEl(el);
      });
      el.appendChild(b);
    }
    el.addEventListener('mouseenter', () => pauseToast(el));
    el.addEventListener('mouseleave', () => resumeToast(el));
    el.addEventListener('focusin', () => pauseToast(el));
    el.addEventListener('focusout', () => setTimeout(() => resumeToast(el), 0));
    box.appendChild(el);
    armToast(el, timeout);
    setChrome('full');
    return id;
  }

  /**
   * Writes to #srStatus (or #srAlert when assertive), clearing first so repeated text is re-read.
   * While a modal dialog is open those are inert, so a live region inside the dialog is used instead.
   */
  function announce(text, opts) {
    if (!text) return;
    const assertive = !!(opts && opts.assertive);
    const dlg = topDialog();
    const el = dlg ? dialogLiveRegion(dlg, assertive) : $(assertive ? 'srAlert' : 'srStatus');
    if (!el) return;
    clearTimeout(el._annTimer);
    el.textContent = '';
    el._annTimer = setTimeout(() => { el.textContent = String(text); }, 60);
  }

  /* =================================================================== *
   * 5. Dialogs                                                           *
   * =================================================================== */
  function openDialog(id) {
    const d = $(id);
    if (!d) return null;
    if (d.open) return d;
    closeEyeMenu(false);
    const opener = document.activeElement;
    try { d.showModal(); }
    catch (e) { d.setAttribute('open', ''); }
    S.dialogOpeners.set(d, opener);
    setChrome('full');
    if (id === 'dlgPrivacy') renderPrivacy(true);
    if (id === 'dlgSettings') fillSettingsDialog(true);
    return d;
  }
  function closeDialog(target) {
    const d = elOf(target);
    if (!d || !d.open) return;
    try { d.close(); }
    catch (e) { d.removeAttribute('open'); }
  }
  function topDialog() {
    const list = document.querySelectorAll('dialog[open]');
    return list.length ? list[list.length - 1] : null;
  }
  function wireDialog(id, closeBtnId, backdropClose) {
    const d = $(id);
    if (!d) return;
    d.addEventListener('close', () => {
      const opener = S.dialogOpeners.get(d);
      S.dialogOpeners.delete(d);
      if (opener && opener.isConnected && typeof opener.focus === 'function' && !opener.closest('[hidden]') && !topDialog()) {
        try { opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    });
    if (closeBtnId) click(closeBtnId, () => closeDialog(d));
    if (backdropClose) {
      d.addEventListener('click', (e) => {
        if (e.target !== d) return;
        const r = d.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) closeDialog(d);
      });
    }
  }

  /* =================================================================== *
   * 6. Screens (§3.2, §4.8.1, addendum §D)                               *
   * =================================================================== */
  function go(name) {
    if (SCREENS.indexOf(name) < 0) { warnOnce('unknown screen ' + name); return; }
    const prev = S.screen;
    const active = document.activeElement;
    for (const n of SCREENS) show('screen-' + n, n === name);
    S.screen = name;
    bodyAttr('screen', name);

    const eyeOn = EYE_SCREENS.has(name);
    show('eye', eyeOn);
    show('eyeLabel', eyeOn);
    if (!eyeOn) closeEyeMenu(false);

    if (prev !== name) onLeaveScreen(prev, name);
    onEnterScreen(name, prev);

    if (active && active !== document.body && typeof active.closest === 'function' && active.closest('[hidden]')) focusScreen(name);
    S.lastActivity = nowMs();
    setChrome('full');
    updateBrand();
    refreshTitle(true);
    ensureLoop();
  }

  function focusScreen(name) {
    const sec = $('screen-' + name);
    if (!sec) return;
    let target = sec.querySelector('[data-autofocus]') || sec.querySelector('h1, h2, h3');
    if (!target || target.closest('[hidden]')) target = name === 'session' ? $('hud') : null;
    if (!target || target.closest('[hidden]')) target = sec;
    if (!target.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function onLeaveScreen(prev, next) {
    if (prev === 'intro') stopIntroDemo();
    if (prev === 'loading') { clearTimeout(S.loadHintTimer); S.loadHintTimer = 0; }
    if (prev === 'calibrate' && next !== 'calibrate') S.calInput = null;
  }
  function onEnterScreen(name, prev) {
    switch (name) {
      case 'intro': enterIntro(prev !== 'intro'); break;
      case 'setup': enterSetup(); break;
      case 'loading': enterLoading(); break;
      case 'session': renderSessionStatic(); break;
      case 'history': call('History', 'renderTerrarium'); break;
      default: break;
    }
  }

  /** From history: back to the active session, else summary if complete, else setup. */
  function back() {
    // SPEC-GAP: addendum §D only covers complete → summary / else → setup; while a session is
    // active (the Terrarium was opened mid-session) we return to the session instead.
    if (sessionActive() || S.fruiting) go('session');
    else if (sessionPhase() === 'complete') go('summary');
    else go('setup');
  }

  function updateBrand() {
    const busy = sessionActive() || S.fruiting;
    setAttr('brand', 'aria-disabled', busy ? 'true' : null);
  }

  /* =================================================================== *
   * 7. Settings helpers                                                  *
   * =================================================================== */
  function setSetting(partial) {
    if (!has('Session', 'setSettings')) {
      S.settings = normSettings(Object.assign({}, S.settings, partial));
      return S.settings;
    }
    try {
      const next = FT.Session.setSettings(partial);
      if (next) S.settings = normSettings(next);
    } catch (err) { warnOnce('setSettings threw', err); }
    return S.settings;
  }
  function detectorOptions(s) {
    return {
      sensitivity: s.sensitivity || 'standard', deskOk: !!s.deskOk, eyesClosedOk: !!s.eyesClosedOk,
      strictTab: !!s.strictTab, previewMode: s.eyeMode || 'mesh', deviceId: s.deviceId || null,
    };
  }
  function audioOptions(s) {
    return {
      enabled: !!s.sound, soundscape: s.soundscape !== false, chimes: s.chimes !== false,
      volume: s.volume == null || !isFinite(+s.volume) ? 0.6 : +s.volume, nudge: s.nudgeSound !== false,
    };
  }
  function reducedMotion() {
    const m = S.settings.motion;
    return m === 'reduced' || (m !== 'full' && FT.env.reducedMotionSystem());
  }
  function applyMotion() {
    const r = reducedMotion();
    bodyAttr('motion', r ? 'reduced' : 'full');
    call('Visual', 'setReducedMotion', r);
  }
  /** Must run synchronously inside a user gesture. */
  function unlockAudio() {
    if (!S.settings.sound) return;
    const p = call('Audio', 'unlock');
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  /* =================================================================== *
   * 8. Intro (§2.4.1) + the step-2 scripted state demo (§6.7)            *
   * =================================================================== */
  function enterIntro(fresh) {
    if (fresh) {
      call('Visual', 'newOrganism', 7, { refActiveSec: 420, retract: false });
      call('Visual', 'prefill', 420, 0.9);
    }
    setIntroStep(0);
    clearInterval(S.intro.blinkTimer);
    S.intro.blinkTimer = setInterval(() => {
      if (S.screen !== 'intro' || document.hidden) return;
      const d = introDemoCurrent();
      if (d && (d.state === 'eyes-closed' || d.state === 'absent')) return;
      call('Visual', 'pulse', 'blink');
    }, 3500);
  }
  function setIntroStep(n) {
    n = U.clamp(n | 0, 0, 2);
    S.intro.step = n;
    for (let i = 0; i < 3; i++) show('introStep' + i, i === n);
    const dotsBox = $('introDots');
    if (dotsBox) {
      let dots = dotsBox.querySelectorAll('.dot');
      if (!dots.length) dots = dotsBox.children;
      Array.from(dots).forEach((d, i) => setAttr(d, 'aria-current', i === n ? 'step' : null));
    }
    show('btnIntroBack', n > 0);
    setBtn('btnIntroNext', n === 2 ? 'Let\'s grow something' : 'Next');
    if (n === 2) startIntroDemo();
    else stopIntroDemoScript();
  }
  function startIntroDemo() {
    stopIntroDemoScript();
    S.intro.demoIdx = -1;
    advanceIntroDemo();
    S.intro.demoTimer = setInterval(advanceIntroDemo, INTRO_STEP_MS);
  }
  function advanceIntroDemo() {
    const I = S.intro;
    I.demoIdx = (I.demoIdx + 1) % INTRO_DEMO.length;
    I.demoSince = nowMs();
    if (I.demoIdx === 0) I.side = -I.side; // shy alternates left and right each cycle
    const d = INTRO_DEMO[I.demoIdx];
    setText('introDemoWord', d.word);
    setAttr('introDemoWord', 'data-word', d.word);
    setText('introDemoGloss', d.gloss);
  }
  function stopIntroDemoScript() {
    clearInterval(S.intro.demoTimer);
    S.intro.demoTimer = 0;
    S.intro.demoIdx = -1;
  }
  function stopIntroDemo() {
    stopIntroDemoScript();
    clearInterval(S.intro.blinkTimer);
    S.intro.blinkTimer = 0;
  }
  function introDemoCurrent() {
    return S.screen === 'intro' && S.intro.step === 2 && S.intro.demoIdx >= 0 ? INTRO_DEMO[S.intro.demoIdx] : null;
  }
  function finishIntro() {
    if (!FT.env.demo) setSetting({ onboarded: true });
    go('setup');
  }

  /* =================================================================== *
   * 9. Setup (§2.4.2)                                                    *
   * =================================================================== */
  let setupFilled = false;
  function enterSetup() {
    fillSetupForm();
    updateModeUI();
    renderCameraState();
    renderRecoverBanner();
    applyDemoUI();
  }
  function setVal(id, v) {
    const el = $(id);
    if (el && document.activeElement !== el && v != null && String(el.value) !== String(v)) el.value = v;
  }
  function fillSetupForm() {
    const s = S.settings;
    if (!setupFilled) {
      const intention = $('intention');
      if (intention && !intention.value) intention.value = s.lastIntention || '';
      setupFilled = true;
    }
    const mode = MODE_IDS[s.mode] ? s.mode : 'pomodoro';
    for (const k in MODE_IDS) { const r = $(MODE_IDS[k]); if (r) r.checked = k === mode; }
    const sens = SENS_IDS[s.sensitivity] ? s.sensitivity : 'standard';
    for (const k in SENS_IDS) { const r = $(SENS_IDS[k]); if (r) r.checked = k === sens; }
    setVal('customWork', s.custom.workMin);
    setVal('customBreak', s.custom.breakMin);
    setVal('customRounds', s.custom.rounds);
  }
  function readMode() {
    for (const k in MODE_IDS) { const r = $(MODE_IDS[k]); if (r && r.checked) return k; }
    return MODE_IDS[S.settings.mode] ? S.settings.mode : 'pomodoro';
  }
  function readSens() {
    for (const k in SENS_IDS) { const r = $(SENS_IDS[k]); if (r && r.checked) return k; }
    return SENS_IDS[S.settings.sensitivity] ? S.settings.sensitivity : 'standard';
  }
  function readNum(id, lo, hi, fallback) {
    const el = $(id);
    if (!el) return fallback;
    const v = parseFloat(el.value);
    if (!isFinite(v)) return fallback;
    return U.clamp(Math.round(v), lo, hi);
  }
  function readCustom() {
    const c = S.settings.custom || DEFAULT_SETTINGS.custom;
    return {
      workMin: readNum('customWork', 1, 180, c.workMin),
      breakMin: readNum('customBreak', 0, 60, c.breakMin),
      rounds: readNum('customRounds', 1, 8, c.rounds),
    };
  }
  /** Mode presets (§4.4.2). */
  function planFor(mode) {
    const s = S.settings;
    switch (mode) {
      case 'free': return { workMin: null, breakMin: 0, longBreakMin: 0, rounds: null, longEvery: 0 };
      case 'deep': return { workMin: 50, breakMin: 10, longBreakMin: 10, rounds: 2, longEvery: 0 };
      case 'custom': {
        const c = readCustom();
        return { workMin: c.workMin, breakMin: c.breakMin, longBreakMin: c.breakMin, rounds: c.rounds, longEvery: 0 };
      }
      default: {
        const p = s.pomodoro || DEFAULT_SETTINGS.pomodoro;
        return {
          workMin: p.workMin != null ? p.workMin : 25, breakMin: p.breakMin != null ? p.breakMin : 5,
          longBreakMin: p.longBreakMin != null ? p.longBreakMin : 15, rounds: p.rounds != null ? p.rounds : 4, longEvery: 4,
        };
      }
    }
  }
  function planTotalMs(plan) {
    if (!plan.workMin || !plan.rounds) return null;
    let min = plan.workMin * plan.rounds;
    for (let k = 1; k < plan.rounds; k++) {
      min += plan.longEvery > 0 && k % plan.longEvery === 0 ? plan.longBreakMin : plan.breakMin;
    }
    return min * 60000;
  }
  function modeSummaryText(mode) {
    if (mode === 'free') return 'Count up. End when you\'re done.';
    const p = planFor(mode);
    const ends = ' · ends ≈ ' + fmtTime(Date.now() + (planTotalMs(p) || 0));
    if (p.rounds === 1) return 'One ' + p.workMin + '-minute block' + ends;
    let txt = p.rounds + ' × ' + p.workMin + ' min focus';
    if (p.breakMin > 0) txt += ', ' + p.breakMin + ' min break' + (p.rounds - 1 > 1 ? 's' : '');
    return txt + ends;
  }
  function updateModeUI() {
    const mode = readMode();
    show('customFields', mode === 'custom');
    setText('modeSummary', modeSummaryText(mode));
    setText('sensHelp', SENS_HELP[readSens()] || SENS_HELP.standard);
  }
  function saveSetupToSettings() {
    const input = $('intention');
    const intention = input ? String(input.value || '').trim().slice(0, 80) : (S.settings.lastIntention || '');
    setSetting({ lastIntention: intention, mode: readMode(), sensitivity: readSens(), custom: readCustom() });
  }

  function renderCameraState() {
    const src = get('Detector', 'source', null);
    const running = detRunning();
    let text, fix = false;
    if (FT.env.demo) text = 'Demo mode · no camera';
    else if (running && src === 'camera') text = 'Camera on · processed on this device';
    else if (S.checking || (detStarting() && src !== 'sim')) {
      // SPEC-GAP: an in-progress wording for "Check framing" while the model loads.
      text = 'Starting the camera…' + (S.loading != null && S.loading > 0.02 ? ' ' + Math.round(S.loading * 100) + '%' : '');
    } else if (S.lastCamError) {
      text = 'Camera unavailable · ' + (ERROR_SHORT[S.lastCamError.code] || ERROR_SHORT.CameraFailed);
      fix = true;
    } else text = 'Camera off · starts when you begin';
    setText('cameraState', text);
    show('btnCameraFix', fix);
    const btn = $('btnCameraCheck');
    if (btn) {
      show(btn, !FT.env.demo);
      // SPEC-GAP: the button toggles; while the camera is on it offers to stop it.
      setBtn(btn, running && src === 'camera' ? 'Stop camera' : 'Check framing');
      setBusy(btn, S.checking);
    }
  }

  function startDetector(source) {
    if (!has('Detector', 'start')) {
      const e = new Error('Face tracking module missing');
      e.code = 'CameraFailed';
      return Promise.reject(e);
    }
    try { return Promise.resolve(FT.Detector.start({ source: source, deviceId: S.settings.deviceId || null })); }
    catch (err) { return Promise.reject(err); }
  }
  function stopCamera() {
    clearCheckTimer();
    if (detStarting()) call('Detector', 'cancelStart');
    call('Detector', 'stop');
    renderCameraState();
  }
  async function cameraPermitted() {
    if (S.settings.cameraGranted) return true;
    try {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return false;
      const res = await Promise.race([navigator.permissions.query({ name: 'camera' }), delay(1500).then(() => null)]);
      return !!res && res.state === 'granted';
    } catch (e) { return false; }
  }

  async function onCheckFraming() {
    if (FT.env.demo || S.flow || sessionActive() || S.checking) return;
    if (detRunning() && get('Detector', 'source', null) === 'camera') {
      stopCamera();
      announce('Camera off.');
      return;
    }
    const chk = call('Detector', 'check') || { ok: true };
    if (!chk.ok) {
      S.lastCamError = { code: chk.code, message: '' };
      renderCameraState();
      announce('Camera unavailable. ' + (ERRORS[normErrorCode(chk.code)].title) + '.', { assertive: true });
      return;
    }
    if (!(await cameraPermitted())) {
      if (S.flow || sessionActive()) return;
      S.pendingAfterPermission = 'check';
      go('permission');
      return;
    }
    startCheckFraming();
  }
  function startCheckFraming() {
    if (S.checking || S.flow || sessionActive()) return S.checkPromise || Promise.resolve();
    const p = runCheckFraming();
    S.checkPromise = p;
    p.then(() => { if (S.checkPromise === p) S.checkPromise = null; });
    return p;
  }
  /** Never rejects (the begin flow may await it). */
  async function runCheckFraming() {
    S.checking = true;
    S.lastCamError = null;
    S.loading = 0;
    renderCameraState();
    try {
      await fontsReady();
      await startDetector('camera');
      setSetting({ cameraGranted: true });
      armCheckTimer();
      announce('Camera on. Processed on this device.');
    } catch (err) {
      const code = err && err.code;
      if (code !== 'Cancelled') {
        S.lastCamError = { code: code || 'CameraFailed', message: (err && err.message) || '' };
        announce('Camera unavailable. ' + ERRORS[normErrorCode(code)].title + '.', { assertive: true });
      }
    } finally {
      S.checking = false;
      renderCameraState();
    }
  }
  function armCheckTimer() {
    clearTimeout(S.checkTimer);
    S.checkTimer = setTimeout(checkTimeout, 60000);
  }
  function clearCheckTimer() {
    clearTimeout(S.checkTimer);
    S.checkTimer = 0;
  }
  /** "The camera auto-stops after 60 s if no session begins." */
  function checkTimeout() {
    S.checkTimer = 0;
    if (sessionActive() || S.flow || S.fruiting || S.screen === 'calibrate' || S.screen === 'loading') return;
    if (cameraOn()) {
      call('Detector', 'stop');
      toast('Camera off. It starts again when you begin.');
    }
    renderCameraState();
  }

  const pad3 = (n) => String(n == null ? 0 : n).padStart(3, '0');
  function renderRecoverBanner() {
    const draft = sessionActive() ? null : call('Session', 'getDraft');
    if (!draft) { show('recoverBanner', false); return; }
    let when = 'earlier';
    if (draft.startedAt) {
      when = U.dayKey(draft.startedAt) === U.dayKey(Date.now())
        ? fmtTime(draft.startedAt)
        : fmtDayMonth(draft.startedAt) + ', ' + fmtTime(draft.startedAt);
    }
    setText('recoverText', 'An unfinished session from ' + when + ' (' + U.fmtDuration(draft.activeMs || 0) + ') was found.');
    show('recoverBanner', true);
  }
  function onRecoverSave() {
    const rec = call('Session', 'recoverDraft');
    show('recoverBanner', false);
    if (rec) {
      toast('Saved to your terrarium as No. ' + pad3(rec.no) + '.', { action: { label: 'Terrarium', onClick: () => go('history') } });
    } else {
      toast('That session was too short to keep.');
    }
    refreshToday(true);
  }
  function onRecoverDiscard() {
    call('Session', 'discardDraft');
    show('recoverBanner', false);
    toast('Discarded. Nothing was saved.');
  }

  function renderSetupNote() {
    const el = $('setupNote');
    if (!el || el.dataset.ftNote) return;
    el.dataset.ftNote = '1';
    const base = 'First start downloads about 7 MB once (the face model), then it\'s cached. Everything runs on this device.';
    if (!el.textContent.trim()) el.textContent = base;
    const ua = navigator.userAgent || '';
    const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg\/|EdgiOS|OPR|Android|FxiOS)/.test(ua);
    if (FT.env.isFile && safari) {
      el.textContent = 'Safari may block the camera for local files. Use Chrome, Edge or Firefox, or serve over http://localhost. ' + el.textContent.trim();
    }
  }
  function applyDemoUI() {
    const demo = FT.env.demo;
    bodyAttr('demo', demo ? '1' : null);
    show('btnExitDemo', demo);
    show('btnDemo', !demo);
    if (demo) show('btnCameraCheck', false);
    if (demo) setBtn('btnBegin', 'Begin demo');
  }
  function navigateDemo(enable) {
    try {
      const u = new URL(location.href);
      if (enable) u.searchParams.set('demo', '1');
      else u.searchParams.delete('demo');
      location.href = u.toString();
    } catch (e) {
      location.search = enable ? '?demo=1' : '';
    }
  }

  /* =================================================================== *
   * 10. Begin flow (§4.8.3)                                              *
   * =================================================================== */
  let beginPending = false;

  function fontsReady() {
    try {
      if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
      const faces = [
        '300 1em Fraunces', 'italic 300 1em Fraunces', '400 1em "Instrument Sans"',
        '600 1em "Instrument Sans"', '400 1em "IBM Plex Mono"', '500 1em "IBM Plex Mono"',
      ];
      return Promise.race([
        Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null))),
        delay(1500),
      ]).catch(() => {});
    } catch (e) { return Promise.resolve(); }
  }

  /** begin(source): 'camera' | 'sim' | 'none'. Re-entrant-safe (double clicks are ignored). */
  function begin(source) {
    if (S.flow || S.fruiting || beginPending || sessionActive()) return;
    source = source === 'sim' || source === 'none' ? source : 'camera';
    // Step 1 — inside the gesture, before any await.
    unlockAudio();
    saveSetupToSettings();
    S.lastSource = source;
    if (source === 'none') {
      if (cameraOn()) stopCamera();
      startSession('none');
      return;
    }
    if (source === 'sim') { continueBegin('sim'); return; }
    const chk = call('Detector', 'check') || { ok: true };
    if (!chk.ok) { showError(chk.code, null, { from: 'begin', source: 'camera' }); return; }
    if (S.checking || detRunning()) { continueBegin('camera'); return; } // the browser prompt already happened or is showing
    beginPending = true;
    cameraPermitted().then((ok) => {
      beginPending = false;
      if (S.flow || sessionActive() || S.fruiting) return;
      if (!ok) { S.pendingAfterPermission = 'begin'; go('permission'); return; }
      continueBegin('camera');
    }, () => { beginPending = false; });
  }

  /** Steps 4–7 of §4.8.3. Also used by #btnAllowCamera and the error screen's Retry. */
  async function continueBegin(source) {
    if (S.flow || sessionActive() || S.fruiting) return;
    const token = ++S.flowSeq;
    S.flow = { token: token, source: source, context: 'begin' };
    S.lastSource = source;
    clearCheckTimer();
    const alive = () => !!S.flow && S.flow.token === token;
    try {
      go('loading');
      if (S.checkPromise) {
        // "Check framing" is still starting the camera: let it finish instead of racing it.
        try { await S.checkPromise; } catch (e) { /* never rejects */ }
        if (!alive()) return;
      }
      await fontsReady();
      if (!alive()) return;
      try {
        await startDetector(source);
      } catch (err) {
        if (!alive()) return;
        S.flow = null;
        const code = err && err.code;
        if (code === 'Cancelled') { go('setup'); return; }
        showError(code, err, { from: 'begin', source: source });
        return;
      }
      if (!alive()) return;
      if (source === 'camera') setSetting({ cameraGranted: true });
      S.lastCamError = null;
      const ok = await runCalibration(pickCalKind(), token, 'begin');
      if (!ok || !alive()) return;
      S.flow = null;
      startSession(source);
    } catch (err) {
      console.error(LOG, 'begin flow failed', err);
      if (alive()) { S.flow = null; showError('CameraFailed', err, { from: 'begin', source: source }); }
    } finally {
      if (alive()) S.flow = null;
    }
  }

  /** Cancel whatever flow is running (loading or calibration) — Cancel buttons, Esc, brand. */
  function cancelFlow() {
    const f = S.flow;
    S.flow = null;
    if (detStarting()) call('Detector', 'cancelStart');
    if (S.screen === 'calibrate' || get('Detector', 'calibrating', false)) call('Detector', 'cancelCalibration');
    const ctx = f ? f.context : 'begin';
    if (ctx === 'session' && (sessionActive() || S.fruiting)) {
      go('session');
      announce('Calibration cancelled. The previous calibration is kept.');
      return;
    }
    if (ctx === 'begin') call('Detector', 'stop');
    else if (cameraOn()) armCheckTimer();
    go('setup');
    announce('Cancelled.');
  }

  function pickCalKind() {
    if (window.innerWidth < 640) return 'center';
    const hasCal = !!call('Detector', 'hasCalibration');
    const cal = hasCal ? call('Detector', 'getCalibration') : null;
    const cur = (S.camInfo && S.camInfo.deviceId) || null;
    if (hasCal && cal && (cal.deviceId || null) === cur) return 'quick';
    return 'full';
  }

  /** Runs one calibration on the calibrate screen. Resolves true on success (after the 700 ms hold). */
  async function runCalibration(kind, token, context) {
    const alive = () => !!S.flow && S.flow.token === token;
    S.calKind = kind;
    S.calBackground = false;
    S.calInput = null;
    go('calibrate');
    resetCalUI(kind);
    try {
      if (!has('Detector', 'calibrate')) {
        const e = new Error('Calibration unavailable');
        e.code = 'CalibrationFailed';
        throw e;
      }
      await FT.Detector.calibrate({ kind: kind });
    } catch (err) {
      if (!alive()) return false;
      S.flow = null;
      handleCalFailure((err && err.code) || 'CalibrationFailed', context, err, kind);
      return false;
    }
    if (!alive()) return false;
    setText('calText', CAL_TEXT.done);
    show('btnCalSkip', false);
    renderCalInfo();
    await delay(700);
    return alive() && S.screen === 'calibrate';
  }

  function handleCalFailure(code, context, err, kind) {
    if (code === 'CalibrationCancelled' || code === 'Cancelled') {
      if (context === 'session' && sessionActive()) { go('session'); return; }
      if (context === 'begin') call('Detector', 'stop');
      go('setup');
      return;
    }
    if (context === 'session' && sessionActive()) {
      go('session');
      toast(code === 'NotRunning'
        ? 'The camera isn\'t running, so calibration was skipped.'
        : 'Couldn\'t find your face. The previous calibration is kept.');
      return;
    }
    if (code === 'NotRunning') { showError('CameraFailed', err, { from: context, source: S.lastSource }); return; }
    showError('CalibrationFailed', err, { from: context, source: S.lastSource, kind: kind });
  }

  /**
   * Recalibrate from the Settings button or R / Shift+R.
   * background=true (quick in session) runs without leaving the session screen.
   */
  async function recalibrate(kind, background) {
    if (S.flow || S.fruiting) return;
    if (get('Detector', 'calibrating', false)) { toast('Already re-centering. Glance at the spore.', { id: 'recenter', timeout: 3000 }); return; }
    const inSession = sessionActive();
    if (inSession && background && detRunning()) { backgroundRecenter('Re-centering. Glance at the spore.'); return; }
    const context = inSession ? 'session' : 'setup';
    const source = inSession && S.sessionSource && S.sessionSource !== 'none'
      ? S.sessionSource
      : (FT.env.demo ? 'sim' : 'camera');
    const token = ++S.flowSeq;
    S.flow = { token: token, source: source, context: context };
    S.lastSource = source;
    const alive = () => !!S.flow && S.flow.token === token;
    try {
      if (!detRunning()) {
        if (source === 'camera') {
          const chk = call('Detector', 'check') || { ok: true };
          if (!chk.ok) {
            S.flow = null;
            if (inSession) toast('The camera isn\'t available: ' + (ERROR_SHORT[chk.code] || 'couldn\'t start') + '.');
            else showError(chk.code, null, { from: 'setup', source: source });
            return;
          }
        }
        go('loading');
        await fontsReady();
        if (!alive()) return;
        try {
          await startDetector(source);
        } catch (err) {
          if (!alive()) return;
          S.flow = null;
          const code = err && err.code;
          if (code === 'Cancelled') { go(inSession ? 'session' : 'setup'); return; }
          if (inSession) { go('session'); toast('Couldn\'t start the camera: ' + (ERROR_SHORT[code] || 'couldn\'t start') + '.'); }
          else showError(code, err, { from: 'setup', source: source });
          return;
        }
        if (!alive()) return;
        if (source === 'camera') setSetting({ cameraGranted: true });
        if (inSession && S.sessionSource === 'none') {
          call('Session', 'setSource', source);
          S.sessionSource = source;
          S.capSource = null;
        }
      }
      const ok = await runCalibration(kind, token, context);
      if (!alive()) return;
      S.flow = null;
      if (!ok) return;
      if (context === 'session' && sessionActive()) {
        go('session');
        toast('Recalibrated. Your screen is mapped.');
      } else {
        go('setup');
        armCheckTimer();
        toast('Calibrated. Your screen is mapped.');
      }
    } catch (err) {
      console.error(LOG, 'recalibrate failed', err);
      if (alive()) { S.flow = null; go(inSession && sessionActive() ? 'session' : 'setup'); }
    } finally {
      if (alive()) S.flow = null;
    }
  }

  /** Quick re-center while the session keeps its screen (post-break, R in session). */
  function backgroundRecenter(message) {
    if (!detRunning() || get('Detector', 'calibrating', false) || !has('Detector', 'calibrate')) return;
    S.calBackground = true;
    toast(message, { id: 'recenter', timeout: 4000 });
    let p;
    try { p = Promise.resolve(FT.Detector.calibrate({ kind: 'quick' })); }
    catch (err) { p = Promise.reject(err); }
    p.then(() => {
      S.calBackground = false;
      renderCalInfo();
      announce('Re-centered.');
    }, () => { S.calBackground = false; });
  }

  /* =================================================================== *
   * 11. Loading (§2.4.4) and calibration UI (§2.4.5)                     *
   * =================================================================== */
  function enterLoading() {
    S.loading = 0;
    setText('loadPhase', FT.env.demo || (S.flow && S.flow.source === 'sim') ? 'Waking the simulator…' : LOAD_PHASE_TEXT.camera);
    setText('loadBytes', '');
    const p = $('loadProgress');
    if (p) p.value = 0;
    show('loadHint', false);
    clearTimeout(S.loadHintTimer);
    S.loadHintTimer = setTimeout(() => {
      S.loadHintTimer = 0;
      if (S.screen === 'loading') show('loadHint', true);
    }, 4000);
  }
  function onProgress(ev) {
    if (!ev) return;
    const prog = U.clamp01(+ev.progress || 0);
    S.loading = prog;
    // The simulator emits camera/model/warmup phases too (with fake byte counts); keep its own wording.
    const simFlow = FT.env.demo || (S.flow && S.flow.source === 'sim');
    const txt = simFlow ? null : LOAD_PHASE_TEXT[ev.phase];
    if (txt) setText('loadPhase', txt);
    if (simFlow) {
      setText('loadBytes', '');
    } else if (ev.phase === 'model' && ev.loadedBytes != null) {
      const total = ev.totalBytes || 3758596;
      setText('loadBytes', fmtMB(ev.loadedBytes) + ' of ' + fmtMB(total) + ' MB');
    } else if (ev.phase !== 'model') {
      setText('loadBytes', '');
    }
    const p = $('loadProgress');
    if (p) p.value = prog;
    if (S.screen === 'setup') renderCameraState();
  }

  function resetCalUI(kind) {
    setText('calStep', kind === 'quick' ? 'RE-CENTER' : kind === 'full' ? 'SEED 1 OF 5' : 'SEED 1 OF 1');
    setText('calText', kind === 'quick' ? CAL_TEXT.quick : CAL_TEXT.centerFull);
    show('calQuality', false);
    setText('calHint', '');
    show('calHint', false);
    show('btnCalSkip', kind === 'full');
    setDisabled('btnCalSkip', false);
    announce(kind === 'quick' ? CAL_TEXT.quick : CAL_TEXT.centerFull);
  }
  function setCalQuality(q) {
    const el = $('calQuality');
    if (!el) return;
    if (q == null || !isFinite(q)) { el.hidden = true; return; }
    const level = q >= 0.75 ? 'good' : q >= 0.45 ? 'fair' : 'poor';
    setText(el, 'Tracking: ' + level);
    setAttr(el, 'data-quality', level);
    el.hidden = false;
  }
  function onCalibration(ev) {
    if (!ev) return;
    const onScreen = S.screen === 'calibrate' && !S.calBackground;
    if (!onScreen) {
      if (ev.phase === 'done') renderCalInfo();
      return;
    }
    const pts = Array.isArray(ev.points) ? ev.points : [];
    const idx = ev.index | 0;
    S.calInput = {
      points: pts, activeIndex: idx,
      activeProgress: U.clamp01(+ev.progress || 0), faceFound: !!ev.faceFound,
    };
    const kind = ev.kind || S.calKind;
    const total = ev.total || pts.length || 1;
    setText('calStep', kind === 'quick' ? 'RE-CENTER' : 'SEED ' + Math.min(idx + 1, total) + ' OF ' + total);

    let text;
    if (ev.phase === 'done') text = CAL_TEXT.done;
    else if (ev.phase === 'failed') text = ev.message || 'Couldn\'t find your face';
    else if (idx === 0) text = ev.faceFound && ev.progress > 0 ? CAL_TEXT.settling : (kind === 'quick' ? CAL_TEXT.quick : CAL_TEXT.centerFull);
    else text = 'Now look at the seed in the ' + (CORNER_NAMES[idx] || 'next') + ' corner of your screen.';
    setText('calText', text);

    if (ev.faceFound || ev.phase === 'done') setCalQuality(ev.quality);
    const hint = ev.phase === 'done' ? null : ev.hint;
    const hintText = hint ? CAL_HINTS[hint] || '' : '';
    setText('calHint', hintText);
    show('calHint', !!hintText);

    if (ev.phase === 'point' && idx > 0) announce(text);
    if (ev.phase === 'point-done') {
      const p = pts[idx];
      if (p) call('Visual', 'pulse', 'seed', { x: p.x, y: p.y });
      call('Audio', 'play', 'seed', { index: idx });
    } else if (ev.phase === 'done') {
      call('Visual', 'pulse', 'calibrated', { points: pts });
      call('Audio', 'play', 'calibrated');
      show('btnCalSkip', false);
      renderCalInfo();
      announce(CAL_TEXT.done);
    }
  }
  function onCalSkip() {
    call('Detector', 'skipCorners');
    setDisabled('btnCalSkip', true);
  }

  /* =================================================================== *
   * 12. Error screen (§2.5)                                              *
   * =================================================================== */
  function showError(code, err, ctx) {
    const raw = code || (err && err.code) || 'CameraFailed';
    const key = normErrorCode(raw);
    const def = ERRORS[key];
    S.errContext = Object.assign({ code: key, raw: raw, source: S.lastSource, from: 'begin' }, ctx || {});
    if (key !== 'CalibrationFailed') S.lastCamError = { code: key, message: (err && err.message) || '' };
    const body = typeof def.body === 'function' ? def.body() : def.body;
    setText('errTitle', def.title);
    setText('errBody', body);
    const acts = def.actions;
    show('btnErrRetry', acts.indexOf('retry') >= 0);
    show('btnErrTimer', acts.indexOf('timer') >= 0);
    show('btnErrDemo', acts.indexOf('demo') >= 0);
    show('btnErrBack', acts.indexOf('back') >= 0);
    setText('errCode', raw + (err && err.message ? ': ' + err.message : ''));
    const det = $('errDetail');
    if (det) det.open = false;
    if (key === 'CalibrationFailed') { if (cameraOn()) armCheckTimer(); }
    else if (cameraOn()) stopCamera();
    go('error');
    announce(def.title + '. ' + body, { assertive: true });
    const first = ['btnErrRetry', 'btnErrTimer', 'btnErrDemo', 'btnErrBack'].map($).find((b) => b && !b.hidden);
    if (first) { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function onErrRetry() {
    const ctx = S.errContext || {};
    if (ctx.from === 'check') { go('setup'); startCheckFraming(); return; }
    if (ctx.from === 'setup') {
      // The error came from a recalibration started outside a session: retry that, not a session.
      recalibrate(ctx.kind || (window.innerWidth < 640 ? 'center' : 'full'), false);
      return;
    }
    const source = ctx.source && ctx.source !== 'none' ? ctx.source : 'camera';
    continueBegin(source);
  }
  function onErrTimer() {
    stopCamera();
    go('setup');
    begin('none');
  }
  function onErrDemo() {
    if (FT.env.demo) { stopCamera(); continueBegin('sim'); }
    else navigateDemo(true);
  }
  function onErrBack() {
    stopCamera();
    go('setup');
  }

  /* =================================================================== *
   * 13. Session start (§4.8.3 step 7)                                    *
   * =================================================================== */
  function startSession(source) {
    const mode = readMode();
    const plan = planFor(mode);
    const intention = String(S.settings.lastIntention || '').trim();
    const config = {
      mode: mode, workMin: plan.workMin, breakMin: plan.breakMin, longBreakMin: plan.longBreakMin,
      rounds: plan.rounds, longEvery: plan.longEvery, intention: intention, source: source, sensitivity: readSens(),
    };
    if (!has('Session', 'start')) {
      toast('Hypha couldn\'t start a session in this browser.');
      go('setup');
      return;
    }
    const prevSource = S.sessionSource;
    S.sessionSource = source;
    let rec;
    try {
      if (sessionPhase() === 'complete') FT.Session.reset();
      rec = FT.Session.start(config);
    } catch (err) {
      console.error(LOG, 'Session.start failed', err);
      S.sessionSource = prevSource;
      toast('Couldn\'t start the session. Try again.');
      go('setup');
      return;
    }
    clearCheckTimer();
    S.capSource = null;
    resetSessionUI();
    if (rec) call('Visual', 'newOrganism', rec.seed, { refActiveSec: rec.refActiveSec, retract: rec.retract });
    S.live = call('Session', 'getLive') || null;
    show('recoverBanner', false);
    go('session');
    let planTxt;
    if (mode === 'free') planTxt = 'Free flow, counting up';
    else if (plan.rounds > 1) planTxt = plural(plan.workMin, 'minute') + ', round 1 of ' + plan.rounds;
    else planTxt = plural(plan.workMin, 'minute');
    announce('Session started. ' + planTxt + '.' + (source === 'none' ? ' Timer only.' : ''));
    updateBrand();
  }

  function resetSessionUI() {
    S.spark.fill(NaN);
    S.sparkHead = 0;
    S.away = { active: S.detState === 'away', since: nowMs(), sound: false, toast: false, notify: false };
    S.camBanner = null;
    S.stallSince = 0;
    show('cameraBanner', false);
    show('drowsyBanner', false);
    S.drowsyCooldownUntil = 0;
    S.fruiting = false;
    S.fruitTitleUntil = 0;
    show('btnFruitSkip', false);
    S.word = 'none';
    S.wordSince = nowMs();
    S.titleWord = null;
    S.announcedWord = null;
    S.lastStateAnnounceAt = nowMs();
    S.pendingPhaseAnnounce = null;
    S.lastPauseReason = null;
    S.breakRestAnnounced = false;
    show('breakPanel', false);
    show('pausedPanel', false);
    closeNotes();
    renderDemoBar();
  }

  function renderSessionStatic() {
    const L = S.live || call('Session', 'getLive');
    if (L && L.phase && L.phase !== 'idle' && L.phase !== 'complete') {
      S.live = L;
      renderHud(L);
      renderControls(L.phase);
      show('breakPanel', L.phase === 'break' && !S.fruiting);
      show('pausedPanel', L.phase === 'paused' && !S.fruiting);
      if (L.phase === 'paused') setText('pausedText', pausedTextFor(L.pauseReason, L.round));
      renderNotes(L);
    }
    show('btnFruitSkip', S.fruiting);
    renderDemoBar();
  }

  /* =================================================================== *
   * 14. HUD, state word, announcements (§2.4.6, §10.4)                   *
   * =================================================================== */
  function timerValue(L) {
    if (L.phaseRemainingMs != null && isFinite(L.phaseRemainingMs)) return U.fmtClock(L.phaseRemainingMs, true);
    return U.fmtClock(L.activeMs || 0);
  }
  function renderHud(L) {
    if (!L) return;
    const phase = L.phase;
    let label;
    if (phase === 'break') label = 'BREAK';
    else if (phase === 'paused') label = 'PAUSED';
    else label = L.phaseRemainingMs != null ? 'REMAINING' : 'ELAPSED';
    setText('timerLabel', label);
    setText('timer', timerValue(L));
    const showRound = L.mode !== 'free' && L.rounds != null && L.rounds > 1;
    if (showRound) setText('roundText', 'Round ' + L.round + ' of ' + L.rounds);
    show('roundText', showRound);
    const intention = String(L.intention || '').trim();
    if (intention) {
      setText('intentionText', U.truncate(intention, 80));
      setAttr('intentionText', 'title', intention);
    }
    show('intentionText', !!intention && phase !== 'break');
  }
  function sessionWord(L) {
    if (!L) return 'none';
    if (L.phase === 'paused') return 'paused';
    if (L.phase === 'break') return 'resting';
    if (L.source === 'none' || L.measured === false) return 'growing';
    return L.word || 'unseen';
  }
  function pausedTextFor(reason, round) {
    if (reason === 'away') return 'Dormant. Resumes when you\'re back.';
    if (reason === 'round') return round ? 'Round ' + round + ' is ready.' : 'The next round is ready.';
    return 'Paused';
  }
  function currentReason(word, L) {
    if (word === 'paused') return pausedTextFor(L && L.pauseReason, L && L.round);
    if (word === 'resting') return 'Resting. Look at something far away.';
    if (word === 'growing') return 'Timer only. Nothing is measured; the time counts as held.';
    const sm = S.sample;
    if (sm && sm.reason && nowMs() - (sm.t || 0) < 2500) return sm.reason;
    if (S.detReason) return S.detReason;
    return word === 'unseen' ? 'Not observed. Not counted.' : '';
  }
  function applyWord(word, reason) {
    const t = nowMs();
    if (word !== S.word) { S.word = word; S.wordSince = t; }
    if (word === 'rooted') S.lastRootedAt = t;
    if (!AWAY_WORDS.has(word) && word !== 'none') S.titleWord = word;
    bodyAttr('state', word); // SPEC-GAP: also 'paused' / 'resting' so CSS can colour those words (§2.4.6).
    setText('stateWord', word === 'none' ? '' : word);
    setAttr('stateWord', 'title', reason || null);
    setText('stateReason', reason || '');
  }
  function maybeAnnounceState(t) {
    if (!sessionActive() || S.fruiting) return;
    const w = S.word;
    if (w === 'paused' || w === 'resting' || w === 'none') return; // phase announcements cover these
    if (S.announcedWord == null) { S.announcedWord = w; return; }
    if (w === S.announcedWord) return;
    if (t - S.wordSince < 3000 || t - S.lastStateAnnounceAt < 10000) return;
    S.announcedWord = w;
    S.lastStateAnnounceAt = t;
    announce(w === 'rooted' ? 'Focused.' : (currentReason(w, S.live) || w));
  }

  function onSessionTick(L) {
    if (!L) return;
    S.live = L;
    if (L.phase === 'idle' || L.phase === 'complete' || S.fruiting) return;
    const word = sessionWord(L);
    applyWord(word, currentReason(word, L));
    if (S.pendingPhaseAnnounce === 'break' && L.phase === 'break') {
      S.pendingPhaseAnnounce = null;
      const min = Math.max(1, Math.round((L.phaseTotalMs || 300000) / 60000));
      announce('Break. ' + plural(min, 'minute') + '. Look away from the screen to rest your eyes.');
    }
    if (document.hidden) return;
    renderHud(L);
    if (L.phase === 'break') renderBreakPanel(L);
  }

  /* =================================================================== *
   * 15. Phase changes, break / paused panels, controls                   *
   * =================================================================== */
  function renderControls(phase) {
    const paused = phase === 'paused';
    const pb = $('btnPause');
    if (pb) {
      setAttr(pb, 'aria-pressed', paused ? 'true' : 'false');
      setBtn(pb, paused ? 'Resume' : 'Pause', paused ? 'i-play' : 'i-pause');
    }
    setBtn('btnBreak', phase === 'break' ? 'Skip break' : 'Break');
    setDisabled('btnBreak', paused);
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function iconEl(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }
  function renderBreakPanel(L) {
    const rem = L.phaseRemainingMs;
    setText('breakText', rem != null && rem <= 5000
      ? 'Back to it in ' + Math.max(1, Math.ceil(rem / 1000)) + '…'
      : 'Look at something far away. The lid gathers dew while you do.');
    const el = $('breakRest');
    if (!el) return;
    if (S.sessionSource === 'none' || L.measured === false) {
      // SPEC-GAP: without a camera the look-away time can't be measured.
      setBreakRest(el, false, 'Look away from the screen for 20 seconds.');
      return;
    }
    const lookMs = L.breakLookAwayMs || 0;
    const rested = !!L.breakEyeRested || lookMs >= 20000;
    setBreakRest(el, rested, Math.min(20, Math.floor(lookMs / 1000)) + 's of 20s looking away');
    if (rested && !S.breakRestAnnounced) { S.breakRestAnnounced = true; announce('Eyes rested.'); }
  }
  function setBreakRest(el, rested, text) {
    if (rested) {
      if (el.dataset.rested === '1') return;
      el.dataset.rested = '1';
      el.textContent = '';
      el.appendChild(iconEl('i-check'));
      el.appendChild(document.createTextNode(' Eyes rested'));
      return;
    }
    if (el.dataset.rested === '1') { delete el.dataset.rested; el.textContent = ''; }
    setText(el, text);
  }

  function onSessionPhase(ev) {
    if (!ev) return;
    const phase = ev.phase, prev = ev.prev, reason = ev.reason;
    if (phase === 'complete') { updateBrand(); return; } // handled through session:complete
    if (phase === 'idle') {
      bodyAttr('phase', 'idle');
      bodyAttr('state', 'none');
      S.word = 'none';
      show('breakPanel', false);
      show('pausedPanel', false);
      hideCamBanner();
      hideDrowsy(false);
      closeNotes();
      closePip();
      if (!S.fruiting) S.sessionSource = null;
      renderDemoBar();
      updateBrand();
      refreshTitle(true);
      updateFavicon(true);
      return;
    }
    if (!S.fruiting) bodyAttr('phase', phase);
    show('breakPanel', phase === 'break');
    show('pausedPanel', phase === 'paused');
    if (phase === 'paused') {
      setText('pausedText', pausedTextFor(reason, ev.round));
      S.lastPauseReason = reason;
    }
    if (phase !== 'running') hideDrowsy(false);
    if (phase === 'break') { const br = $('breakRest'); if (br && br.dataset.rested) { delete br.dataset.rested; br.textContent = ''; } }
    renderControls(phase);

    // Announcements (§10.4) and audio.
    if (phase === 'running' && reason === 'start') {
      /* announced by startSession */
    } else if (phase === 'running' && prev === 'running' && reason === 'interval-end') {
      // A round change with no break between (break length 0).
      announce('Back to focus. Round ' + ev.round + ' of ' + ev.rounds + '.');
    } else if (phase === 'break' && prev !== 'paused') {
      S.pendingPhaseAnnounce = 'break';
      S.breakRestAnnounced = false;
      call('Audio', 'play', 'break-start');
    } else if (phase === 'break' && prev === 'paused') {
      announce('Resumed. Still on break.');
    } else if (phase === 'paused') {
      announce(reason === 'away' ? 'Paused. You stepped away; it resumes when you\'re back.'
        : reason === 'round' ? 'Paused. Round ' + ev.round + ' is ready.' : 'Paused.');
    } else if (phase === 'running' && (prev === 'break' || (prev === 'paused' && S.lastPauseReason === 'round'))) {
      announce(ev.rounds > 1 ? 'Back to focus. Round ' + ev.round + ' of ' + ev.rounds + '.' : 'Back to focus.');
    } else if (phase === 'running' && prev === 'paused') {
      announce(reason === 'returned' ? 'Welcome back. Resumed.' : 'Resumed.');
    }
    const breakEnded = prev === 'break' && (phase === 'running' || (phase === 'paused' && reason === 'round'));
    if (breakEnded) {
      call('Audio', 'play', 'break-end');
      if (S.settings.recenterAfterBreak && S.sessionSource === 'camera' && detRunning()) {
        backgroundRecenter('Re-centering. Glance at the spore.');
      }
    }
    setChrome('full');
    updateBrand();
    renderDemoBar();
    refreshTitle(true);
  }

  function togglePause() {
    const p = sessionPhase();
    if (p === 'running' || p === 'break') call('Session', 'pause', 'user');
    else if (p === 'paused') call('Session', 'resume');
  }
  function onBreakBtn() {
    const p = sessionPhase();
    if (p === 'running') call('Session', 'startBreak', 300000);
    else if (p === 'break') call('Session', 'skipBreak');
  }

  /* =================================================================== *
   * 16. Banners (camera, drowsy) and the demo bar                        *
   * =================================================================== */
  const CAM_BANNER = {
    lost: { text: 'Camera disconnected. Your session continues, and the network rests until it\'s back.', retry: true, timer: true },
    muted: { text: 'Camera paused by your system. That time isn\'t counted against you.', retry: false, timer: false },
    stalled: { text: 'Camera frames stopped. That time isn\'t counted against you.', retry: true, timer: false },
    tracking: { text: 'Face tracking stopped. Your session continues as a timer until it\'s back.', retry: true, timer: true },
  };
  function showCamBanner(kind) {
    const def = CAM_BANNER[kind];
    if (!def) return;
    const changed = S.camBanner !== kind;
    S.camBanner = kind;
    setText('cameraBannerText', def.text);
    show('btnCamRetry', def.retry);
    show('btnCamTimer', def.timer);
    setDisabled('btnCamRetry', false);
    setBusy('btnCamRetry', false);
    show('cameraBanner', true);
    show('drowsyBanner', false); // the camera banner wins
    setChrome('full');
    if (changed) announce(def.text, { assertive: kind !== 'muted' });
  }
  function hideCamBanner(kind) {
    if (kind && S.camBanner !== kind) return;
    S.camBanner = null;
    show('cameraBanner', false);
  }
  async function onCamRetry() {
    const btn = $('btnCamRetry');
    if (btn && btn.getAttribute('aria-busy') === 'true') return;
    setBusy(btn, true);
    setDisabled(btn, true);
    const src = S.sessionSource && S.sessionSource !== 'none' ? S.sessionSource : (S.capSource || (FT.env.demo ? 'sim' : 'camera'));
    try {
      if (cameraOn()) call('Detector', 'stop');
      await startDetector(src);
      if (sessionActive() && S.sessionSource !== src) {
        call('Session', 'setSource', src);
        S.sessionSource = src;
        S.capSource = null;
      }
      hideCamBanner();
      S.stallSince = 0;
      toast('Camera reconnected.', { id: 'camera' });
      renderDemoBar();
    } catch (err) {
      setText('cameraBannerText', 'Couldn\'t reconnect: ' + (ERROR_SHORT[err && err.code] || 'the camera didn\'t start') +
        '. Try again, or continue as a timer.');
      show('btnCamTimer', true);
      announce('Couldn\'t reconnect the camera.', { assertive: true });
    } finally {
      setBusy(btn, false);
      setDisabled(btn, false);
    }
  }
  function onCamTimer() {
    call('Detector', 'stop');
    call('Session', 'setSource', 'none');
    if (S.sessionSource && S.sessionSource !== 'none') S.capSource = S.sessionSource;
    S.sessionSource = 'none';
    hideCamBanner();
    renderDemoBar();
    toast('Continuing as a timer. Take the lens cap off to bring the camera back.', { id: 'camera' });
  }
  /** Stalled for more than 10 s (the detector flags unseen/stalled after 2 s). Checked at ~1 Hz. */
  function checkStall(t) {
    const relevant = sessionActive() && !S.fruiting && S.sessionSource === 'camera' && detRunning() && S.screen !== 'calibrate';
    const sm = get('Detector', 'sample', null) || S.sample;
    const stalled = relevant && !S.camMuted &&
      ((sm && sm.unseenReason === 'stalled') || (S.lastSampleAt > 0 && t - S.lastSampleAt > 4000));
    if (!stalled) {
      S.stallSince = 0;
      if (S.camBanner === 'stalled') hideCamBanner('stalled');
      return;
    }
    if (!S.stallSince) S.stallSince = t;
    if (t - S.stallSince >= 8000 && !S.camBanner) showCamBanner('stalled');
  }

  function onDrowsy(ev) {
    if (!ev || !ev.active) return;
    if (sessionPhase() !== 'running' || S.fruiting || S.sessionSource === 'none') return;
    if (Date.now() < S.drowsyCooldownUntil || S.camBanner || isShown('drowsyBanner')) return;
    show('drowsyBanner', true);
    setChrome('full');
    announce('Your eyes are getting heavy. A 5-minute break might help.');
  }
  function hideDrowsy(dismissed) {
    show('drowsyBanner', false);
    if (dismissed) S.drowsyCooldownUntil = Date.now() + 600000;
  }

  function renderDemoBar() {
    show('demoBar', S.sessionSource === 'sim' && sessionActive() && !S.fruiting);
  }
  function simulate(kind) {
    if (S.sessionSource !== 'sim' || !sessionActive() || SIM_KINDS.indexOf(kind) < 0) return;
    call('Detector', 'simulate', kind);
    // A manual scenario turns the Detector's autopilot off; resumeSimAuto() turns it back on once the
    // scenario has settled into focus. An explicit "Focus" choice stays put.
    S.simKind = kind === 'focus' ? null : kind;
    const chip = document.querySelector('#demoBar [data-sim="' + kind + '"]');
    announce('Demo: ' + (chip ? chip.textContent.trim() : kind) + '.');
  }
  /** 1 Hz: after a manual demo scenario ends (the sim settles into 'focus'), hand control back to autopilot. */
  function resumeSimAuto() {
    if (!S.simKind) return;
    if (S.sessionSource !== 'sim' || !sessionActive()) { S.simKind = null; return; }
    if (get('Detector', 'simScenario', null) !== 'focus' || get('Detector', 'simAuto', null) !== false) return;
    S.simKind = null;
    call('Detector', 'simulate', 'auto');
  }

  /* =================================================================== *
   * 17. Field notes: stats, last drift, forgive, sparkline               *
   * =================================================================== */
  function openNotes(open) {
    S.notesOpen = !!open;
    const n = $('notes');
    if (n) n.classList.toggle('is-open', S.notesOpen);
    setAttr('btnNotes', 'aria-expanded', S.notesOpen ? 'true' : 'false');
    show('notesBackdrop', S.notesOpen && FT.env.narrow());
    if (S.notesOpen) {
      renderNotes(S.live);
      drawSpark();
      setChrome('full');
    }
  }
  function closeNotes() {
    if (S.notesOpen) openNotes(false);
    else show('notesBackdrop', false);
  }
  function toggleNotes() { openNotes(!S.notesOpen); }

  function canForgive(L) {
    const e = L && L.lastEpisode;
    return !!e && !e.forgiven && (e.t1 == null || (e.endedAgoMs != null && e.endedAgoMs < 300000));
  }
  function renderNotes(L) {
    if (!L) return;
    const measured = L.measured !== false && L.source !== 'none';
    const dash = '—';
    setText('nHeld', measured ? U.fmtPercent(L.focusPct) : dash);
    setText('nHeldTime', U.fmtDuration(L.heldMs || 0));
    setText('nStreak', U.fmtDuration(L.streakMs || 0));
    setText('nLongest', U.fmtDuration(L.longestStreakMs || 0));
    const d = L.distractions || 0, m = L.mended || 0, r = L.returns || 0;
    setText('nScars', !measured && !d ? dash : d === 0 ? 'none' : d + (m > 0 ? ' · ' + m + ' mended' : ''));
    setText('nReturns', !measured && !r ? dash : r === 0 ? '0'
      : r + (L.medianRecoveryMs != null ? ' · median ' + U.fmtDuration(L.medianRecoveryMs) : ''));
    setText('nDepth', measured ? U.fmtPercent(L.depth || 0) : dash);
    setText('nBlink', L.blinkRate != null && isFinite(L.blinkRate) ? Math.round(L.blinkRate) + '/min' : dash);
    const df = L.drowsyFlags || 0;
    setText('nDrowsy', !measured ? dash : df === 0 ? 'none' : plural(df, 'moment'));

    const e = L.lastEpisode;
    let txt;
    if (!e) txt = measured ? 'No drifts yet.' : 'Timer only. Nothing is measured.';
    else if (e.forgiven) txt = 'Last drift: forgiven.';
    else if (e.t1 == null) txt = 'Drifting now: ' + (CAUSE_PHRASE[e.cause] || 'away') + '.';
    else txt = 'Last drift: ' + (CAUSE_PHRASE[e.cause] || 'away') + ', ' + U.fmtDuration(e.endedAgoMs || 0) + ' ago';
    setText('nLastDrift', txt);
    setDisabled('btnForgive', !canForgive(L));
  }
  function forgive() {
    if (!sessionActive()) return;
    const ok = call('Session', 'forgiveLast');
    if (ok) {
      dismissToast('drift');
      toast('Forgiven. That drift counts as held now.', { id: 'forgive', timeout: 4000 });
      announce('Forgiven.');
      renderNotes(call('Session', 'getLive') || S.live);
    } else {
      toast('Nothing recent to forgive.', { id: 'forgive', timeout: 3000 });
    }
  }

  function sampleSpark() {
    const L = S.live;
    if (!L || !sessionActive() || S.fruiting) return;
    let v = NaN;
    if (L.phase === 'running' && S.sessionSource !== 'none') {
      const f = S.sample && S.sample.focus;
      if (f != null && isFinite(f)) v = U.clamp01(f);
      else if (L.focus != null && isFinite(L.focus)) v = U.clamp01(L.focus);
    }
    S.spark[S.sparkHead] = v;
    S.sparkHead = (S.sparkHead + 1) % S.spark.length;
  }
  function drawSpark() {
    const c = $('notesSpark');
    if (!c || !c.clientWidth) return;
    const cssW = c.clientWidth, cssH = c.clientHeight || 56;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const P = FT.PALETTE, pad = 3, n = S.spark.length;
    const yOf = (v) => pad + (1 - v) * (cssH - 2 * pad);
    const xOf = (i) => (i / (n - 1)) * cssW;
    const bottom = cssH;

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(207,230,223,.22)';
    ctx.lineWidth = 1;
    const yh = Math.round(yOf(0.72)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, yh); ctx.lineTo(cssW, yh); ctx.stroke();
    ctx.restore();

    const rgb = U.hexToRgb(P.hypha);
    const fill = U.rgba(rgb, 0.12);
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      if (seg.length === 1) {
        ctx.fillStyle = P.hypha;
        ctx.beginPath(); ctx.arc(seg[0][0], seg[0][1], 1.2, 0, U.TAU); ctx.fill();
        seg = [];
        return;
      }
      ctx.beginPath();
      ctx.moveTo(seg[0][0], bottom);
      for (const p of seg) ctx.lineTo(p[0], p[1]);
      ctx.lineTo(seg[seg.length - 1][0], bottom);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(seg[0][0], seg[0][1]);
      for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i][0], seg[i][1]);
      ctx.strokeStyle = P.hypha;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      seg = [];
    };
    for (let k = 0; k < n; k++) {
      const v = S.spark[(S.sparkHead + k) % n];
      if (isNaN(v)) { flush(); continue; }
      seg.push([xOf(k), yOf(v)]);
    }
    flush();
  }

  /* =================================================================== *
   * 18. CRUISE chrome fade (§2.4.6)                                      *
   * =================================================================== */
  function setChrome(v) {
    if (S.chrome === v) return;
    S.chrome = v;
    bodyAttr('chrome', v);
  }
  function onActivity() {
    S.lastActivity = nowMs();
    if (S.chrome !== 'full') setChrome('full');
  }
  function overlayOpen() {
    return !!S.camBanner || isShown('cameraBanner') || isShown('drowsyBanner') || toastEls().length > 0 ||
      !!topDialog() || S.eyeMenuOpen || S.notesOpen;
  }
  function focusInChrome() {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    let keyboard = true;
    try { keyboard = a.matches(':focus-visible'); } catch (e) { keyboard = true; }
    if (!keyboard) return false;
    return ['controls', 'topbar', 'eye'].some((id) => { const el = $(id); return !!el && el.contains(a); });
  }
  function evalChrome(t) {
    const L = S.live;
    if (S.screen !== 'session' || S.fruiting || !S.settings.fadeChrome || !L || L.phase !== 'running') { setChrome('full'); return; }
    const rootedOk = S.word === 'rooted' || (S.chrome !== 'full' && t - S.lastRootedAt <= 2000);
    if (!rootedOk || t - S.lastActivity < 4000 || overlayOpen() || focusInChrome()) { setChrome('full'); return; }
    setChrome((L.depth || 0) >= 0.6 ? 'deep' : 'dim');
  }

  /* =================================================================== *
   * 19. End dialog, completion, fruiting (§2.4.7, §2.4.8, §4.8.4)        *
   * =================================================================== */
  function openEndDialog() {
    if (!sessionActive() || S.fruiting) return;
    const L = call('Session', 'getLive') || S.live;
    const short = !L || (L.activeMs || 0) < 30000;
    setText('endBody', short ? 'It\'s under 30 seconds, so it won\'t be saved.' : 'It will fruit and join your terrarium.');
    openDialog('dlgEnd');
  }
  function endSession(save) {
    closeDialog('dlgEnd');
    if (!sessionActive()) return;
    S.discarding = !save;
    call('Session', 'end', { save: !!save });
    S.discarding = false;
    if (sessionActive()) toast('Couldn\'t end the session. Try again.');
  }

  function onSessionComplete(ev) {
    const record = ev && ev.record;
    const saved = !!(ev && ev.saved);
    if (S.flow) { S.flow = null; call('Detector', 'cancelCalibration'); }
    closePip();
    hideCamBanner();
    hideDrowsy(false);
    closeNotes();
    closeDialog('dlgEnd');
    S.away = { active: false, since: 0, sound: false, toast: false, notify: false };
    dismissToast('nudge');
    if (saved && record) {
      runFruiting(record);
      return;
    }
    const msg = S.discarding
      ? 'Session discarded. Nothing was saved.'
      : 'Too short to keep. Sessions under 30 seconds aren\'t saved.';
    toast(msg);
    announce(msg);
    call('Detector', 'stop');
    call('Session', 'reset');
    S.sessionSource = null;
    renderDemoBar();
    go('setup');
  }

  async function runFruiting(record) {
    S.fruiting = true;
    bodyAttr('phase', 'fruiting');
    bodyAttr('state', 'none');
    show('breakPanel', false);
    show('pausedPanel', false);
    renderDemoBar();
    if (S.screen !== 'session') go('session');
    show('btnFruitSkip', true);
    setChrome('full');
    updateBrand();
    call('Detector', 'stop');
    closePip();
    call('Audio', 'play', 'complete');
    S.fruitNo = record.no;
    S.fruitTitleUntil = Date.now() + 10000;
    refreshTitle(true);
    updateFavicon(true);
    const pct = record.stats && record.stats.focusPct;
    announce(pct != null
      ? 'Session complete. Held ' + Math.round(pct * 100) + ' percent.'
      : 'Session complete. ' + U.fmtDuration(record.activeMs || 0) + ' grown.');
    const skip = $('btnFruitSkip');
    if (skip) { try { skip.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }

    let guard = 0;
    try {
      const p = has('Visual', 'startFruiting')
        ? Promise.resolve(FT.Visual.startFruiting(record))
        : delay(reducedMotion() ? 800 : 1500);
      await Promise.race([p, new Promise((resolve) => { guard = setTimeout(resolve, 12000); })]);
    } catch (err) {
      warnOnce('startFruiting failed', err);
    }
    clearTimeout(guard);
    S.fruiting = false;
    show('btnFruitSkip', false);
    fillSummary(record);
    if (S.screen === 'history') { /* the user is browsing; back() leads to the summary */ }
    else go('summary');
    bodyAttr('phase', 'complete');
    updateBrand();
    refreshTitle(true);
    updateFavicon(true);
    setTimeout(() => call('Audio', 'stopAll'), 4000);
  }
  function skipFruiting() {
    if (S.fruiting) call('Visual', 'skipFruiting');
  }
  function fillSummary(record) {
    if (has('History', 'fillSummary')) { call('History', 'fillSummary', record); return; }
    // SPEC-GAP: minimal fallback when history.js is unavailable.
    setText('specimenName', record.name || 'Hypha');
    setText('specimenVar', record.variety || '');
    const label = call('Session', 'labelFor', record) || ('No. ' + pad3(record.no));
    setText('specimenLabel', (record.source === 'sim' && label.indexOf('DEMO') !== 0 ? 'DEMO · ' : '') + label);
    setText('sumDiagnosis', record.diagnosis || '');
  }

  /* =================================================================== *
   * 20. Title (§7.3) and favicon (§7.4)                                  *
   * =================================================================== */
  function titleWordNow() {
    const w = S.word;
    if (AWAY_WORDS.has(w)) {
      if (S.away.active && nowMs() - S.away.since >= 2000) return w;
      return S.titleWord || 'rooted';
    }
    return w;
  }
  function refreshTitle(force) {
    let title;
    if (!S.settings.liveTitle) title = TITLE_SHORT;
    else if (S.fruiting || (Date.now() < S.fruitTitleUntil && (S.screen === 'summary' || S.screen === 'session'))) {
      title = '✺ No. ' + pad3(S.fruitNo) + ' · fruiting';
    } else if (S.screen === 'summary') title = TITLE_SHORT;
    else if (sessionActive() && S.live && S.live.phase !== 'complete' && S.live.phase !== 'idle') {
      const w = titleWordNow();
      title = (GLYPH[w] || '◉') + ' ' + timerValue(S.live) + ' · ' + (w === 'none' ? 'rooted' : w);
    } else title = TITLE_DEFAULT;
    if (force || title !== S.lastTitle) {
      S.lastTitle = title;
      if (document.title !== title) document.title = title;
    }
  }
  function faviconColor(word, D) {
    const P = FT.PALETTE, h = U.hexToRgb;
    switch (word) {
      case 'rooted': case 'growing': return U.mixRgb(h(P.hypha), h(P.flow), U.clamp01(D));
      case 'wavering': return h(P.hyphaDim);
      case 'shy': case 'sinking': case 'elsewhere': return h(P.scar);
      case 'asleep': return h(P.amber);
      case 'dormant': return h(P.frost);
      case 'resting': return h(P.core);
      default: return h(P.muted);
    }
  }
  function drawFavicon(link, word, F, D, rim) {
    const c = S.favCanvas || (S.favCanvas = document.createElement('canvas'));
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const P = FT.PALETTE;
    ctx.clearRect(0, 0, 32, 32);
    ctx.beginPath(); ctx.arc(16, 16, 14, 0, U.TAU); ctx.fillStyle = P.dish; ctx.fill();
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(16, 16, 12.5, 0, U.TAU); ctx.strokeStyle = 'rgba(207,230,223,.15)'; ctx.stroke();
    if (rim > 0) {
      ctx.beginPath();
      ctx.arc(16, 16, 12.5, -Math.PI / 2, -Math.PI / 2 + U.TAU * U.clamp01(rim));
      ctx.strokeStyle = P.hypha;
      ctx.stroke();
    }
    const rgb = faviconColor(word, D);
    const r = 3 + 7 * U.clamp01(F);
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, r);
    g.addColorStop(0, U.rgba(rgb, 1));
    g.addColorStop(0.45, U.rgba(rgb, 0.8));
    g.addColorStop(1, U.rgba(rgb, 0));
    ctx.beginPath(); ctx.arc(16, 16, r, 0, U.TAU); ctx.fillStyle = g; ctx.fill();
    try { link.href = c.toDataURL('image/png'); return true; }
    catch (err) { warnOnce('favicon toDataURL', err); return false; }
  }
  /** Key-based redraw, at most once per second; runs while hidden too (driven by clock:tick). */
  function updateFavicon(force) {
    const link = $('favicon');
    if (!link) return;
    const L = S.live;
    const useLive = S.settings.liveTitle && sessionActive() && L && !S.fruiting;
    if (!useLive) {
      if (!S.favIsDefault && S.faviconDefault) {
        link.href = S.faviconDefault;
        S.favIsDefault = true;
        S.favKey = '';
      }
      return;
    }
    const w = titleWordNow();
    const measured = S.sessionSource !== 'none' && L.measured !== false;
    const F = measured && L.focus != null && isFinite(L.focus) ? U.clamp01(L.focus) : 0.75;
    const rim = U.clamp01(L.rimProgress || 0);
    const key = w + Math.round(F * 10) + ':' + Math.round(rim * 24);
    if (key === S.favKey && !force) return;
    const t = nowMs();
    if (t - S.favLastAt < 1000) return; // the next tick picks the change up
    if (drawFavicon(link, w, F, U.clamp01(L.depth || 0), rim)) {
      S.favKey = key;
      S.favLastAt = t;
      S.favIsDefault = false;
    }
  }

  /* =================================================================== *
   * 21. Nudge ladder (§7.2)                                              *
   * =================================================================== */
  function runNudges(t) {
    const A = S.away;
    if (!A.active) return;
    if (sessionPhase() !== 'running' || S.sessionSource === 'none' || S.fruiting || S.screen === 'calibrate') return;
    if (get('Detector', 'calibrating', false)) return;
    const away = t - A.since;
    const s = S.settings;
    if (away >= 10000 && !A.sound && s.nudgeSound && s.sound && t - S.lastNudgeSoundAt >= 60000) {
      A.sound = true;
      S.lastNudgeSoundAt = t;
      call('Audio', 'play', 'nudge');
    }
    if (away >= 20000 && !A.toast && !document.hidden && t - S.lastNudgeToastAt >= 180000) {
      A.toast = true;
      S.lastNudgeToastAt = t;
      toast('The network is waiting.', { id: 'nudge', timeout: 5000 });
    }
    if (away >= 30000 && !A.notify && document.hidden && s.notify && FT.env.hasNotifications &&
        t - S.lastNotifyAt >= 300000) {
      let perm = 'default';
      try { perm = Notification.permission; } catch (e) { perm = 'denied'; }
      if (perm !== 'granted') return;
      A.notify = true;
      S.lastNotifyAt = t;
      try {
        const n = new Notification('Hypha is waiting', {
          body: 'You\'ve been away from your work for 30 seconds.', tag: 'hypha-nudge', silent: true,
        });
        n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } try { n.close(); } catch (e) { /* ignore */ } };
      } catch (err) { warnOnce('Notification failed', err); }
    }
  }

  /* =================================================================== *
   * 22. Pop-out mini window — Document Picture-in-Picture (§7.5)         *
   * =================================================================== */
  function copyStylesInto(pipWin) {
    for (const ss of Array.from(document.styleSheets)) {
      try {
        const css = Array.from(ss.cssRules).map((r) => r.cssText).join('\n');
        const style = pipWin.document.createElement('style');
        style.textContent = css;
        pipWin.document.head.appendChild(style);
      } catch (e) {
        if (!ss.href) continue;
        const link = pipWin.document.createElement('link');
        link.rel = 'stylesheet';
        link.type = ss.type || 'text/css';
        if (ss.media && ss.media.mediaText) link.media = ss.media.mediaText;
        link.href = ss.href;
        pipWin.document.head.appendChild(link);
      }
    }
  }
  async function openPip() {
    if (!FT.env.hasDocPiP || !window.documentPictureInPicture) return;
    if (S.pip) { try { S.pip.focus(); } catch (e) { /* ignore */ } return; }
    if (!sessionActive() || S.fruiting) { toast('The pop-out works during a session.', { id: 'pip', timeout: 3000 }); return; }
    let pipWin;
    try { pipWin = await window.documentPictureInPicture.requestWindow({ width: 320, height: 200 }); }
    catch (err) { warnOnce('PiP requestWindow failed', err); toast('Couldn\'t open the pop-out window.', { id: 'pip' }); return; }
    S.pip = pipWin;
    try {
      copyStylesInto(pipWin);
      const doc = pipWin.document;
      doc.title = 'Hypha';
      doc.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') || 'nocturne');
      doc.body.className = 'pip';
      const mk = (tag, id, cls, text) => {
        const el = doc.createElement(tag);
        if (id) el.id = id;
        if (cls) el.className = cls;
        if (text) el.textContent = text;
        return el;
      };
      const root = mk('div', null, 'pip-root');
      const canvas = mk('canvas', 'pipDish');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.width = '160px';
      canvas.style.height = '160px';
      const info = mk('div', null, 'pip-info');
      const timeEl = mk('div', 'pipTime', 'pip-time');
      const wordEl = mk('div', 'pipWord', 'pip-word');
      const actions = mk('div', null, 'pip-actions');
      const pauseBtn = mk('button', 'pipPause', 'btn btn-ghost btn-sm', 'Pause');
      pauseBtn.type = 'button';
      const backBtn = mk('button', 'pipBack', 'btn btn-text btn-sm', 'Back to Hypha');
      backBtn.type = 'button';
      pauseBtn.addEventListener('click', togglePause);
      backBtn.addEventListener('click', () => { try { window.focus(); } catch (e) { /* ignore */ } });
      actions.appendChild(pauseBtn);
      actions.appendChild(backBtn);
      info.appendChild(timeEl);
      info.appendChild(wordEl);
      info.appendChild(actions);
      root.appendChild(canvas);
      root.appendChild(info);
      doc.body.appendChild(root);
      pipWin.addEventListener('pagehide', () => cleanupPip(pipWin));
      setAttr('btnPip', 'aria-pressed', 'true');
      const loop = () => {
        if (S.pip !== pipWin) return;
        try { drawPip(pipWin, canvas, timeEl, wordEl, pauseBtn); }
        catch (err) { warnOnce('PiP frame failed', err); }
        pipWin.requestAnimationFrame(loop);
      };
      pipWin.requestAnimationFrame(loop);
    } catch (err) {
      warnOnce('PiP setup failed', err);
      closePip();
    }
  }
  function drawPip(pipWin, canvas, timeEl, wordEl, pauseBtn) {
    const t = nowMs();
    if (t - S.pipLastDraw < 66) return;
    S.pipLastDraw = t;
    const size = 160;
    const dpr = Math.min(3, pipWin.devicePixelRatio || 1);
    const W = Math.round(size * dpr);
    if (canvas.width !== W) { canvas.width = W; canvas.height = W; }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, W);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The main render loop stops while this tab is hidden, but drawMini only draws what update() has
      // advanced (grow-in, tint, lum), so drive it from here (~15 Hz via the throttle above).
      if (document.hidden && has('Visual', 'update')) {
        try { FT.Visual.update(buildInput(performance.now())); }
        catch (err) { warnOnce('PiP visual update failed', err); }
      }
      if (has('Visual', 'drawMini')) FT.Visual.drawMini(ctx, size);
    }
    const L = S.live;
    if (L && L.phase && L.phase !== 'idle' && L.phase !== 'complete') {
      const tv = timerValue(L);
      if (timeEl.textContent !== tv) timeEl.textContent = tv;
      const w = S.word === 'none' ? '' : S.word;
      if (wordEl.textContent !== w) wordEl.textContent = w;
      if (pipWin.document.body.dataset.state !== w) pipWin.document.body.dataset.state = w;
      const pl = L.phase === 'paused' ? 'Resume' : 'Pause';
      if (pauseBtn.textContent !== pl) pauseBtn.textContent = pl;
    }
  }
  function cleanupPip(pipWin) {
    if (S.pip && (!pipWin || S.pip === pipWin)) S.pip = null;
    setAttr('btnPip', 'aria-pressed', 'false');
  }
  function closePip() {
    const w = S.pip;
    if (!w) return;
    S.pip = null;
    try { w.close(); } catch (e) { /* ignore */ }
    setAttr('btnPip', 'aria-pressed', 'false');
  }

  /* =================================================================== *
   * 23. Privacy panel and request counter (§7.6)                         *
   * =================================================================== */
  function addResEntry(e) {
    const name = String(e.name || '');
    // SPEC-GAP: blob: and data: URLs are in-memory, not network requests; they are not counted or listed.
    if (/^(blob|data):/i.test(name)) return;
    if (S.resEntries.length >= 1000) S.resEntries.shift();
    S.resEntries.push({ name: name, startTime: e.startTime || 0, transferSize: e.transferSize, initiatorType: e.initiatorType || '' });
  }
  function initPrivacy() {
    try {
      if ('PerformanceObserver' in window) {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) addResEntry(e);
          onResChange();
        });
        try { po.observe({ type: 'resource', buffered: true }); }
        catch (e) {
          po.observe({ entryTypes: ['resource'] });
          if (performance.getEntriesByType) performance.getEntriesByType('resource').forEach(addResEntry);
        }
      } else if (performance.getEntriesByType) {
        performance.getEntriesByType('resource').forEach(addResEntry);
      }
    } catch (err) { warnOnce('PerformanceObserver unavailable', err); }
    document.addEventListener('securitypolicyviolation', () => {
      S.blocked += 1;
      renderPrivacyCounts();
    });
    renderCsp();
    renderEyeReq();
  }
  function onResChange() {
    renderEyeReq();
    if (isOpen('dlgPrivacy')) renderPrivacy(false);
  }
  function reqCount() {
    if (S.trackingSince == null) return null;
    let n = 0;
    for (const e of S.resEntries) if (e.startTime >= S.trackingSince) n++;
    return n;
  }
  function renderEyeReq() {
    const n = reqCount();
    setText('eyeReq', n == null ? 'camera off' : plural(n, 'request') + ' since tracking began');
  }
  function renderPrivacyCounts() {
    const n = reqCount();
    setText('privReqCount', 'Network requests since tracking began: ' + (n == null ? '0 (not tracking right now)' : n));
    setText('privBlocked', 'Blocked by policy: ' + S.blocked);
    renderEyeReq();
  }
  function renderPrivCam() {
    const st = S.camStatus;
    let txt;
    if (st === 'running' && S.camSource === 'sim') txt = 'Camera: simulated (demo) · no camera in use';
    else if (st === 'running') {
      if (S.camMuted) txt = 'Camera: paused by your system';
      else {
        const hz = get('Detector', 'hz', null);
        txt = 'Camera: live' + (hz && isFinite(hz) ? ' · ' + Math.round(hz) + ' checks/s' : '');
      }
    } else if (st === 'starting' || st === 'loading' || st === 'warming' || st === 'recovering') txt = 'Camera: starting…';
    else txt = 'Camera: off';
    setText('privCam', txt);
  }
  function renderCsp() {
    let meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!meta) meta = Array.from(document.querySelectorAll('meta[http-equiv]')).find((m) => /content-security-policy/i.test(m.httpEquiv || m.getAttribute('http-equiv')));
    const text = meta && meta.content
      ? meta.content.split(';').map((s) => s.trim()).filter(Boolean).join(';\n')
      : 'No policy found on this page.';
    setText('privCsp', text);
  }
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1e6 ? (n / 1e3).toFixed(1) + ' kB' : (n / 1e6).toFixed(1) + ' MB');
  function renderPrivacy(full) {
    renderPrivCam();
    renderPrivacyCounts();
    if (full) renderCsp();
    const ul = $('privReqList');
    if (!ul) return;
    const sig = S.resEntries.length + ':' + S.trackingSince;
    if (!full && ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    ul.textContent = '';
    const frag = document.createDocumentFragment();
    for (const e of S.resEntries) {
      let host = '', path = e.name;
      try {
        const u = new URL(e.name, location.href);
        host = u.host || (u.protocol === 'file:' ? 'this computer' : u.protocol.replace(':', ''));
        path = u.pathname || '/';
      } catch (err) { /* keep raw */ }
      const li = document.createElement('li');
      if (S.trackingSince != null && e.startTime >= S.trackingSince) li.dataset.since = '1';
      const h = document.createElement('span'); h.className = 'req-host'; h.textContent = host;
      const p = document.createElement('span'); p.className = 'req-path'; p.textContent = U.truncate(path, 48);
      const z = document.createElement('span'); z.className = 'req-size';
      z.textContent = !e.transferSize ? 'cached' : fmtBytes(e.transferSize);
      li.appendChild(h); li.appendChild(p); li.appendChild(z);
      frag.appendChild(li);
    }
    ul.appendChild(frag);
  }
  function isOpen(id) {
    const d = $(id);
    return !!d && !!d.open;
  }

  /* =================================================================== *
   * 24. Settings dialog (§3.4)                                           *
   * =================================================================== */
  // [id, settings key, type, min, max, step]
  const SET_CONTROLS = [
    ['setSensitivity', 'sensitivity', 'select'],
    ['setDesk', 'deskOk', 'check'],
    ['setEyesClosed', 'eyesClosedOk', 'check'],
    ['setStrictTab', 'strictTab', 'check'],
    ['setAutoPause', 'autoPause', 'check'],
    ['setWork', 'pomodoro.workMin', 'num', 5, 90, 1],
    ['setShort', 'pomodoro.breakMin', 'num', 1, 30, 1],
    ['setLong', 'pomodoro.longBreakMin', 'num', 5, 60, 1],
    ['setRounds', 'pomodoro.rounds', 'num', 1, 8, 1],
    ['setGoal', 'goalMin', 'num', 10, 600, 5],
    ['setAutoNext', 'autoNext', 'check'],
    ['setRecenter', 'recenterAfterBreak', 'check'],
    ['setSound', 'sound', 'check'],
    ['setSoundscape', 'soundscape', 'check'],
    ['setChimes', 'chimes', 'check'],
    ['setVolume', 'volume', 'range', 0, 1, 0.05],
    ['setNudgeSound', 'nudgeSound', 'check'],
    ['setNotify', 'notify', 'check'],
    ['setLiveTitle', 'liveTitle', 'check'],
    ['setForgiveToast', 'forgiveToast', 'check'],
    ['setMotion', 'motion', 'select'],
    ['setEyeMode', 'eyeMode', 'select'],
    ['setFadeChrome', 'fadeChrome', 'check'],
    ['setCamera', 'deviceId', 'camera'],
  ];
  function settingValue(key) {
    let v = S.settings;
    for (const p of key.split('.')) v = v == null ? undefined : v[p];
    return v;
  }
  function partialFor(key, value) {
    const parts = key.split('.');
    const out = {};
    if (parts.length === 1) out[key] = value;
    else { out[parts[0]] = {}; out[parts[0]][parts[1]] = value; }
    return out;
  }
  function fillSettingsDialog(full) {
    for (const row of SET_CONTROLS) {
      const id = row[0], key = row[1], type = row[2];
      const el = $(id);
      if (!el) continue;
      const v = settingValue(key);
      if (type === 'check') { if (el.checked !== !!v) el.checked = !!v; }
      else if (type === 'camera') { if (full) populateCameras(); else if (el.value !== (v || '') && document.activeElement !== el) el.value = v || ''; }
      else if (type === 'select' || document.activeElement !== el) {
        const sv = v == null ? '' : String(v);
        if (el.value !== sv) el.value = sv;
      }
    }
    renderCalInfo();
  }
  function onSettingControl(el, row) {
    const key = row[1], type = row[2], lo = row[3], hi = row[4], step = row[5];
    let value;
    switch (type) {
      case 'check': value = !!el.checked; break;
      case 'num': {
        let v = parseFloat(el.value);
        if (!isFinite(v)) { el.value = settingValue(key); return; }
        if (step && step > 1) v = Math.round(v / step) * step;
        v = U.clamp(Math.round(v), lo, hi);
        if (String(el.value) !== String(v)) el.value = v;
        value = v;
        break;
      }
      case 'range': {
        const v = parseFloat(el.value);
        if (!isFinite(v)) return;
        value = U.clamp(v, lo, hi);
        break;
      }
      case 'camera': value = el.value || null; break;
      default: value = el.value;
    }
    if (key === 'notify' && value) { requestNotify(el); return; }
    setSetting(partialFor(key, value));
    if (key === 'sound' && value) {
      const p = call('Audio', 'unlock'); // still inside the change gesture
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    if (key === 'deviceId') onCameraChanged();
  }
  function requestNotify(el) {
    const deny = () => {
      if (el) el.checked = false;
      setSetting({ notify: false });
      toast('Notifications are blocked for this page.', { id: 'notify' });
    };
    if (!FT.env.hasNotifications) { deny(); return; }
    let perm = 'default';
    try { perm = Notification.permission; } catch (e) { perm = 'denied'; }
    if (perm === 'granted') { setSetting({ notify: true }); return; }
    if (perm === 'denied') { deny(); return; }
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      if (res === 'granted') setSetting({ notify: true });
      else deny();
    };
    try {
      const p = Notification.requestPermission(done);
      if (p && typeof p.then === 'function') p.then(done, () => done('denied'));
    } catch (e) { deny(); }
  }
  function populateCameras() {
    const sel = $('setCamera');
    if (!sel) return;
    const fill = (list) => {
      const current = S.settings.deviceId || '';
      list = Array.isArray(list) ? list : [];
      sel.textContent = '';
      sel.appendChild(new Option('Default camera', ''));
      let found = current === '';
      list.forEach((c, i) => {
        if (!c || !c.deviceId) return;
        sel.appendChild(new Option(c.label || 'Camera ' + (i + 1), c.deviceId));
        if (c.deviceId === current) found = true;
      });
      if (!found) sel.appendChild(new Option('Saved camera (not connected)', current));
      sel.value = current;
    };
    const p = call('Detector', 'listCameras');
    if (p && typeof p.then === 'function') p.then(fill, () => fill([]));
    else fill([]);
  }
  async function onCameraChanged() {
    if (S.flow || !(detRunning() && get('Detector', 'source', null) === 'camera')) return;
    toast('Switching camera…', { id: 'camera', timeout: 3000 });
    try {
      call('Detector', 'stop');
      await startDetector('camera');
      if (!sessionActive()) armCheckTimer();
      toast('Camera switched. Recalibrate if tracking feels off.', {
        id: 'camera',
        action: { label: 'Recalibrate', onClick: () => recalibrate(window.innerWidth < 640 ? 'center' : 'full', false) },
      });
    } catch (err) {
      toast('Couldn\'t open that camera: ' + (ERROR_SHORT[err && err.code] || 'it didn\'t start') + '.', { id: 'camera' });
      if (sessionActive() && S.sessionSource === 'camera') showCamBanner('lost');
      renderCameraState();
    }
  }
  function renderCalInfo() {
    const cal = call('Detector', 'hasCalibration') ? call('Detector', 'getCalibration') : null;
    if (!cal || !cal.at) { setText('calInfo', 'Not calibrated yet'); return; }
    const q = cal.quality >= 0.75 ? 'good' : cal.quality >= 0.45 ? 'fair' : 'poor';
    setText('calInfo', 'Calibrated ' + fmtDayMonth(cal.at) + ' · quality ' + q);
  }
  function wireSettings() {
    for (const row of SET_CONTROLS) {
      const el = $(row[0]);
      if (!el) continue;
      el.addEventListener(row[2] === 'range' ? 'input' : 'change', () => onSettingControl(el, row));
    }
    click('btnRecalibrate', () => {
      closeDialog('dlgSettings');
      recalibrate(window.innerWidth < 640 ? 'quick' : 'full', false);
    });
    click('btnForgetCal', () => {
      call('Detector', 'forgetCalibration');
      renderCalInfo();
      toast('Calibration forgotten. The next start runs a full calibration.', { id: 'cal' });
    });
    click('btnSetExport', () => call('History', 'exportData'));
    click('btnSetImport', () => call('History', 'importData'));
    click('btnSetErase', () => call('History', 'confirmErase'));
  }

  function onSettingsChange(ev) {
    if (!ev || !ev.settings) return;
    S.settings = normSettings(ev.settings);
    const changed = Array.isArray(ev.changed) && ev.changed.length ? ev.changed : Object.keys(S.settings);
    const any = (...keys) => keys.some((k) => changed.indexOf(k) >= 0);
    if (any('sensitivity', 'deskOk', 'eyesClosedOk', 'strictTab', 'eyeMode', 'deviceId')) call('Detector', 'setOptions', detectorOptions(S.settings));
    if (any('sound', 'soundscape', 'chimes', 'volume', 'nudgeSound')) call('Audio', 'setOptions', audioOptions(S.settings));
    if (any('motion')) applyMotion();
    if (any('eyeMode')) renderEyeMode();
    if (any('sound')) renderSoundBtn();
    if (any('liveTitle')) { refreshTitle(true); updateFavicon(true); }
    if (any('fadeChrome')) evalChrome(nowMs());
    if (any('goalMin')) refreshToday(true);
    if (S.screen === 'setup' && any('sensitivity', 'mode', 'custom', 'pomodoro')) { fillSetupForm(); updateModeUI(); }
    if (isOpen('dlgSettings')) fillSettingsDialog(false);
  }

  /* =================================================================== *
   * 25. Sound toggle                                                     *
   * =================================================================== */
  function renderSoundBtn() {
    const b = $('btnSound');
    if (!b) return;
    setAttr(b, 'aria-pressed', S.settings.sound ? 'true' : 'false');
    setBtn(b, null, S.settings.sound ? 'i-sound-on' : 'i-sound-off');
  }
  function toggleSound() {
    const next = !S.settings.sound;
    setSetting({ sound: next });
    if (next) {
      const p = call('Audio', 'unlock');
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      call('Audio', 'stopAll');
    }
    renderSoundBtn();
    toast(next ? 'Sound on.' : 'Sound off.', { id: 'sound', timeout: 2500 });
  }

  /* =================================================================== *
   * 26. The Eye widget, its menu, the lens cap (§2.3, §4.8.4)            *
   * =================================================================== */
  function updateCamAttr() {
    const st = S.camStatus;
    let v = 'off';
    if (st === 'running') v = S.camSource === 'sim' ? 'sim' : (S.camMuted || S.stallSince ? 'muted' : 'live');
    else if (st === 'starting' || st === 'loading' || st === 'warming' || st === 'recovering') v = 'loading';
    bodyAttr('cam', v);
    return v;
  }
  const EYE_PIP_TITLE = {
    live: 'Camera live, processed on this device', muted: 'Camera paused or stalled',
    sim: 'Simulated camera (demo)', loading: 'Camera starting', off: 'Camera off',
  };
  function renderEyePip() {
    const v = updateCamAttr();
    setAttr('eyePip', 'data-state', v);
    setAttr('eyePip', 'title', EYE_PIP_TITLE[v] || null);
  }
  function renderEyeLid() {
    show('eyeLid', !(detRunning() && S.settings.eyeMode !== 'off'));
  }
  function renderEyeMode() {
    const mode = EYE_MODES.indexOf(S.settings.eyeMode) >= 0 ? S.settings.eyeMode : 'mesh';
    for (const m of EYE_MODES) setAttr(EYE_MODE_IDS[m], 'aria-checked', m === mode ? 'true' : 'false');
    renderEyeLid();
  }
  function renderLens() {
    setBtn('btnLens', cameraOn() ? 'Put the lens cap on' : 'Take the lens cap off');
  }
  function setEyeMode(mode) {
    if (EYE_MODES.indexOf(mode) < 0) return;
    setSetting({ eyeMode: mode });
    call('Detector', 'setPreviewMode', mode);
    renderEyeMode();
  }
  function cycleEyeMode() {
    const i = EYE_MODES.indexOf(S.settings.eyeMode);
    const next = EYE_MODES[(i + 1) % EYE_MODES.length];
    setEyeMode(next);
    toast('Preview: ' + EYE_MODE_NAMES[next] + '.', { id: 'eye', timeout: 2000 });
  }

  function menuItems() {
    const m = $('eyeMenu');
    if (!m) return [];
    return Array.from(m.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter((el) => !el.hidden && !el.disabled);
  }
  function openEyeMenu(focusItem) {
    const m = $('eyeMenu');
    if (!m) return;
    renderEyeMode();
    renderLens();
    m.hidden = false;
    S.eyeMenuOpen = true;
    setAttr('eye', 'aria-expanded', 'true');
    setChrome('full');
    if (focusItem !== false) {
      const items = menuItems();
      const target = items.find((i) => i.getAttribute('aria-checked') === 'true') || items[0];
      if (target) { try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }
  }
  function closeEyeMenu(returnFocus) {
    const m = $('eyeMenu');
    const wasOpen = S.eyeMenuOpen || (m && !m.hidden);
    if (m) m.hidden = true;
    S.eyeMenuOpen = false;
    setAttr('eye', 'aria-expanded', 'false');
    if (wasOpen && returnFocus) {
      const e = $('eye');
      if (e && !e.hidden) { try { e.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
    }
  }
  function toggleEyeMenu() {
    if (S.eyeMenuOpen) closeEyeMenu(true);
    else openEyeMenu(true);
  }
  function onEyeMenuKey(e) {
    const items = menuItems();
    if (!items.length) return;
    const n = items.length;
    const i = items.indexOf(document.activeElement);
    let next = null;
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': next = items[i < 0 ? 0 : (i + 1) % n]; break;
      case 'ArrowUp': case 'ArrowLeft': next = items[i < 0 ? n - 1 : (i - 1 + n) % n]; break;
      case 'Home': next = items[0]; break;
      case 'End': next = items[n - 1]; break;
      case 'Escape': case 'Esc':
        e.preventDefault();
        e.stopPropagation();
        closeEyeMenu(true);
        return;
      case 'Tab':
        closeEyeMenu(false);
        return;
      default: return;
    }
    e.preventDefault();
    try { next.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
  }

  /** Lens cap on/off (#btnLens or L). */
  async function toggleLens() {
    if (S.flow) {
      cancelFlow();
      call('Detector', 'stop');
      renderLens();
      toast('Lens cap on. The camera is off.', { id: 'lens', timeout: 3000 });
      return;
    }
    const active = sessionActive() && !S.fruiting;
    if (cameraOn()) {
      if (active && S.sessionSource && S.sessionSource !== 'none') S.capSource = S.sessionSource;
      clearCheckTimer();
      if (detStarting()) call('Detector', 'cancelStart');
      call('Detector', 'stop');
      if (active && S.sessionSource !== 'none') {
        call('Session', 'setSource', 'none');
        S.sessionSource = 'none';
      }
      hideCamBanner();
      renderDemoBar();
      renderCameraState();
      renderLens();
      toast('Lens cap on. The camera is off.', { id: 'lens', timeout: 3000 });
      announce('Lens cap on. The camera is off.');
      return;
    }
    if (S.lensBusy) return;
    if (active) {
      const src = S.capSource || (FT.env.demo ? 'sim' : 'camera');
      S.lensBusy = true;
      toast('Taking the lens cap off…', { id: 'lens', timeout: 3000 });
      try {
        await startDetector(src);
        if (sessionActive()) {
          call('Session', 'setSource', src);
          S.sessionSource = src;
          S.capSource = null;
        }
        if (src === 'camera') setSetting({ cameraGranted: true });
        renderDemoBar();
        toast('Lens cap off. Tracking again.', { id: 'lens', timeout: 3000 });
        announce('Lens cap off. Tracking again.');
      } catch (err) {
        toast('Couldn\'t start the camera: ' + (ERROR_SHORT[err && err.code] || 'it didn\'t start') + '.', { id: 'lens' });
      } finally {
        S.lensBusy = false;
        renderLens();
      }
      return;
    }
    if (S.screen === 'setup' && !FT.env.demo) { onCheckFraming(); return; }
    toast('The lens cap is on. The camera starts when you begin.', { id: 'lens', timeout: 3000 });
  }

  /* =================================================================== *
   * 27. Today stat (§2.3)                                                *
   * =================================================================== */
  function refreshToday(force) {
    const t = nowMs();
    if (!force && t - S.todayLastAt < 60000) return;
    S.todayLastAt = t;
    const agg = call('Session', 'aggregate');
    if (!agg) { setText('todayStat', 'Today —'); return; }
    const held = (agg.today && agg.today.heldMs) || 0;
    const streak = (agg.dayStreak && agg.dayStreak.current) || 0;
    let txt = 'Today ' + (held > 0 ? U.fmtDuration(held) : '—');
    if (streak > 0) txt += ' · ' + streak + '-day streak';
    setText('todayStat', txt);
  }

  /* =================================================================== *
   * 28. Keyboard shortcuts (§9)                                          *
   * =================================================================== */
  function isField(t) {
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  }
  function isActivatable(t) {
    return !!t && typeof t.closest === 'function' && !!t.closest(
      'button, a[href], summary, label, input, select, textarea, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="checkbox"], [role="tab"], [role="link"]');
  }
  function minutesLeftText(ms) {
    if (ms < 60000) return 'under a minute';
    return plural(Math.ceil(ms / 60000), 'minute');
  }
  function speakTime() {
    const L = call('Session', 'getLive') || S.live;
    if (!L) return;
    const parts = [];
    if (L.phase === 'break' && L.phaseRemainingMs != null) parts.push(minutesLeftText(L.phaseRemainingMs) + ' of break left');
    else {
      const rem = L.sessionRemainingMs != null ? L.sessionRemainingMs : L.phaseRemainingMs;
      parts.push(rem != null ? minutesLeftText(rem) + ' left' : U.fmtDuration(L.activeMs || 0) + ' grown');
    }
    if (L.focusPct != null) parts.push(U.fmtPercent(L.focusPct) + ' held');
    if (S.word && S.word !== 'none') parts.push(S.word);
    const text = parts.join(' · ');
    toast(text, { id: 'time', timeout: 5000 });
    announce(text);
  }
  function onEscape(e) {
    if (topDialog()) return; // the native dialog handles Esc itself
    if (S.eyeMenuOpen) { e.preventDefault(); closeEyeMenu(true); return; }
    if (S.notesOpen) {
      e.preventDefault();
      closeNotes();
      const b = $('btnNotes');
      if (b) { try { b.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
      return;
    }
    if (S.fruiting) { e.preventDefault(); skipFruiting(); return; }
    if (S.screen === 'calibrate' || S.screen === 'loading') { e.preventDefault(); cancelFlow(); return; }
    const ts = toastEls();
    if (ts.length) dismissToastEl(ts[ts.length - 1]);
  }
  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, key = e.key || '';
    if (key === 'Escape' || key === 'Esc') { onEscape(e); return; }
    if (isField(t)) return; // Enter in #intention submits the form natively
    if ((key === ' ' || key === 'Spacebar' || key === 'Enter') && isActivatable(t)) return;
    const dlg = topDialog();
    if (dlg) {
      if ((key === 'k' || key === 'K') && dlg.id === 'dlgJar' && !e.repeat) {
        e.preventDefault();
        call('History', 'saveKeepsake');
      }
      return;
    }
    if (key === 'Enter' || e.repeat) return;
    if (handleShortcut(key, e.shiftKey)) e.preventDefault();
  }
  function handleShortcut(key, shift) {
    const screen = S.screen;
    const inSession = screen === 'session' && sessionActive() && !S.fruiting;
    const fullKind = window.innerWidth < 640 ? 'center' : 'full';
    if (key === ' ' || key === 'Spacebar') {
      if (screen === 'setup' && !S.flow) { begin(FT.env.demo ? 'sim' : 'camera'); return true; }
      if (inSession) {
        const p = sessionPhase();
        if (p === 'running' || p === 'paused') { togglePause(); return true; }
      }
      return false;
    }
    if (key === '?') { openDialog('dlgHelp'); return true; }
    if (key === ',') { openDialog('dlgSettings'); return true; }
    if (/^[1-7]$/.test(key)) {
      if (inSession && S.sessionSource === 'sim') { simulate(SIM_KINDS[+key - 1]); return true; }
      return false;
    }
    switch (key.toLowerCase()) {
      case 'b': if (!inSession) return false; onBreakBtn(); return true;
      case 'e': if (!inSession) return false; openEndDialog(); return true;
      case 'r':
        if (inSession) { recalibrate(shift ? fullKind : 'quick', !shift); return true; }
        if (screen === 'setup' && detRunning() && !S.flow) { recalibrate(shift ? fullKind : 'quick', false); return true; }
        return false;
      case 'c': if (!detRunning()) return false; cycleEyeMode(); return true;
      case 'l': toggleLens(); return true;
      case 'm': toggleSound(); return true;
      case 'n': if (!inSession) return false; toggleNotes(); return true;
      case 'f': if (!inSession) return false; forgive(); return true;
      case 't': if (!inSession) return false; speakTime(); return true;
      case 'h': if (sessionActive() || S.fruiting || S.flow) return false; go('history'); return true;
      case 's': openDialog('dlgSettings'); return true;
      case 'p': if (!inSession) return false; openPip(); return true;
      case 'k': if (screen === 'summary') { call('History', 'saveKeepsake'); return true; } return false;
      case 'd': if (!FT.env.debug) return false; toggleDebug(); return true;
      default: return false;
    }
  }

  /* =================================================================== *
   * 29. Detector event handlers (§4.8.4)                                 *
   * =================================================================== */
  function onDetStatus(ev) {
    if (!ev) return;
    const prev = S.camStatus;
    S.camStatus = ev.status || 'idle';
    S.camSource = ev.source || get('Detector', 'source', null);
    if (S.camStatus === 'running') {
      if (prev !== 'running' || S.trackingSince == null) S.trackingSince = nowMs();
    } else if (S.camStatus === 'stopped' || S.camStatus === 'idle' || S.camStatus === 'error') {
      S.trackingSince = null;
      S.camMuted = false;
      S.lastSampleAt = 0;
      S.stallSince = 0;
    }
    renderEyePip();
    renderEyeLid();
    renderLens();
    renderEyeReq();
    renderCameraState();
    if (isOpen('dlgPrivacy')) renderPrivacy(false);
  }
  function onDetError(ev) {
    if (!ev || ev.during !== 'running') return;
    const code = ev.code || 'CameraFailed';
    if (sessionActive() && !S.fruiting && S.sessionSource && S.sessionSource !== 'none') {
      showCamBanner(code === 'ModelInitFailed' ? 'tracking' : 'lost');
    } else {
      S.lastCamError = { code: code, message: ev.message || '' };
      renderCameraState();
      if (S.screen === 'setup') toast('Camera ' + (ERROR_SHORT[code] || 'stopped') + '.', { id: 'camera' });
      announce('Camera ' + (ERROR_SHORT[code] || 'stopped') + '.', { assertive: true });
    }
    renderEyePip();
  }
  function onDetCamera(ev) {
    S.camInfo = ev || null;
    S.camMuted = !!(ev && ev.muted);
    const inCamSession = sessionActive() && !S.fruiting && S.sessionSource === 'camera';
    if (S.camMuted && inCamSession) showCamBanner('muted');
    else if (!S.camMuted && S.camBanner === 'muted') hideCamBanner('muted');
    renderEyePip();
    renderEyeLid();
    renderLens();
    renderPrivCam();
    renderCameraState();
  }
  function onDetSample(sm) {
    if (!sm) return;
    S.sample = sm;
    S.lastSampleAt = nowMs();
  }
  function onDetState(ev) {
    if (!ev) return;
    const t = nowMs();
    S.detState = ev.state || null;
    S.detCause = ev.cause || null;
    S.detReason = ev.reason || '';
    S.detStateAt = t;
    // Nudge ladder: timers start at the detector:state time; leaving `away` resets it.
    if (ev.state === 'away') {
      if (!S.away.active) S.away = { active: true, since: t, sound: false, toast: false, notify: false };
    } else if (S.away.active) {
      S.away = { active: false, since: 0, sound: false, toast: false, notify: false };
      dismissToast('nudge');
    }
    const active = sessionActive() && !S.fruiting;
    if (active && ev.prev === 'absent' && (ev.state === 'focused' || ev.state === 'drifting')) {
      call('Visual', 'pulse', 'welcome');
      call('Audio', 'play', 'return');
    }
    if (active) {
      const L = S.live;
      if (L && L.phase === 'running' && S.sessionSource !== 'none' && ev.state !== 'calibrating' && ev.word) {
        applyWord(ev.word, ev.reason || '');
      }
    } else if (!S.fruiting) {
      bodyAttr('state', 'none');
    }
  }
  function onBlink() {
    if ((sessionPhase() === 'running' && !S.fruiting) || S.screen === 'intro') {
      call('Visual', 'pulse', 'blink');
      call('Audio', 'play', 'blink');
    }
  }

  /* =================================================================== *
   * 30. Session / history / store event handlers                         *
   * =================================================================== */
  function onSecond(ev) {
    if (!ev) return;
    call('Visual', 'grow', { s: ev.s, f: ev.f, d: ev.d, a: ev.a }, ev.index);
  }
  function onSessionEpisode(ev) {
    if (!ev || !ev.episode) return;
    const e = ev.episode;
    if (ev.type === 'end') {
      call('Visual', 'pulse', 'return', { angle: e.angle });
      call('Audio', 'play', 'return');
      const t = nowMs();
      if (S.settings.forgiveToast && S.sessionSource !== 'none' && sessionPhase() === 'running' && t - S.lastForgiveToastAt > 300000) {
        S.lastForgiveToastAt = t;
        toast('Drift noted.', { id: 'drift', timeout: 6000, action: { label: 'That was fine', onClick: forgive } });
      }
    } else if (ev.type === 'mended') {
      call('Visual', 'pulse', 'mend', { t0: e.t0 });
    } else if (ev.type === 'forgiven') {
      call('Visual', 'forgive', e.t0);
    }
  }
  function onMilestone(ev) {
    if (!ev) return;
    call('Audio', 'play', 'milestone');
    call('Visual', 'pulse', 'milestone');
    if (ev.minutes) announce(ev.minutes + ' minutes rooted.');
  }
  function onGap(ev) {
    if (!ev) return;
    if (ev.treatedAs === 'paused') {
      toast('Welcome back. The ' + Math.max(1, Math.round((ev.ms || 0) / 60000)) + ' min your computer slept were paused.', { id: 'gap' });
    } else {
      toast('Some time wasn\'t observed and wasn\'t counted.', { id: 'gap' });
    }
  }
  function onHistoryChange() {
    if (S.screen === 'history') call('History', 'renderTerrarium');
    refreshToday(true);
  }
  let lastStoreToastAt = -1e12;
  function onStoreError(ev) {
    const t = nowMs();
    if (ev && ev.quota) {
      toast('Storage was full, so older specimens\' timelines were archived.', { id: 'store-quota' });
      return;
    }
    if (t - lastStoreToastAt < 300000) return;
    lastStoreToastAt = t;
    toast('Couldn\'t save to this browser\'s storage. Export your specimens to keep them.', { id: 'store-error', timeout: 8000 });
  }

  /* =================================================================== *
   * 31. Clock tick: title, favicon, nudges, audio, chrome, notes, debug  *
   * =================================================================== */
  function audioUpdate() {
    if (!S.settings.sound || !has('Audio', 'update')) return;
    const L = S.live;
    const active = sessionActive() && !S.fruiting;
    const sp = sessionPhase();
    const phase = S.fruiting || sp === 'complete' ? 'complete' : active ? ((L && L.phase) || sp) : 'idle';
    const measured = active && S.sessionSource !== 'none' && detRunning();
    const sm = S.sample;
    call('Audio', 'update', {
      phase: phase,
      state: measured ? (S.detState || 'unseen') : 'none',
      cause: measured ? S.detCause : null,
      focus: measured && sm && isFinite(sm.focus) ? U.clamp01(sm.focus) : 0.75,
      depth: active && L ? U.clamp01(L.depth || 0) : 0,
      drowsiness: measured && sm && isFinite(sm.drowsiness) ? U.clamp01(sm.drowsiness) : 0,
    });
  }
  function onClockTick(ev) {
    const t = nowMs();
    const wall = (ev && ev.wall) || Date.now();
    if (t - S.lastAudioAt >= 100) { S.lastAudioAt = t; audioUpdate(); }
    evalChrome(t);
    runNudges(t);

    const sec = Math.floor(wall / 1000);
    if (sec !== S.lastSecondKey || S.word !== S.lastTitleWord) {
      const newSecond = sec !== S.lastSecondKey;
      S.lastSecondKey = sec;
      S.lastTitleWord = S.word;
      refreshTitle(false);
      updateFavicon(false);
      if (newSecond) {
        maybeAnnounceState(t);
        checkStall(t);
        resumeSimAuto();
        renderEyePip();
        refreshToday(false);
        if (S.screen === 'setup') {
          const minute = Math.floor(wall / 60000);
          if (minute !== S.lastMinuteKey) { S.lastMinuteKey = minute; updateModeUI(); }
        }
        if (isOpen('dlgPrivacy')) renderPrivCam();
      }
    }

    if (t - S.lastHalfSecAt >= 500) {
      S.lastHalfSecAt = t;
      sampleSpark();
      if (S.notesOpen && !document.hidden) { renderNotes(S.live); drawSpark(); }
      if (S.debugVisible && !document.hidden) renderDebug();
    }
  }

  /* =================================================================== *
   * 32. Render loop + VisualInput (§4.5.2)                               *
   * =================================================================== */
  function ensureLoop() {
    if (S.raf || document.hidden || !S.screen || S.screen === 'history') return;
    if (!has('Visual', 'update')) return;
    S.raf = requestAnimationFrame(frame);
  }
  function frame() {
    S.raf = 0;
    if (document.hidden || S.screen === 'history') return; // restarted by visibilitychange / go()
    try {
      FT.Visual.update(buildInput(performance.now()));
    } catch (err) {
      if (!S.loopErrLogged) {
        S.loopErrLogged = true;
        console.error(LOG, 'render frame failed (logged once)', err);
      }
    }
    S.raf = requestAnimationFrame(frame);
  }
  function visualPhase() {
    const sc = S.screen;
    if (sc === 'session') {
      if (S.fruiting) return 'fruiting';
      const sp = sessionPhase();
      if (sp === 'paused' || sp === 'break' || sp === 'running') return sp;
      if (sp === 'complete') return 'complete';
      return 'running';
    }
    return SCREEN_PHASE[sc] || 'idle';
  }
  function buildInput(now) {
    const phase = visualPhase();
    const input = {
      now: now, phase: phase, state: 'none', cause: null, stateAgeMs: 0, focus: 0.75, depth: 0,
      dir: null, offScreen: false, offCause: null, eyeOpen: 1, drowsiness: 0, present: true,
      rimProgress: null, breakProgress: 0, lookAway: 0, loading: null, calibration: null,
      hidden: document.hidden,
    };
    if (phase === 'intro') {
      const d = introDemoCurrent();
      if (d) {
        input.state = d.state;
        input.cause = d.cause;
        input.focus = d.focus;
        input.stateAgeMs = Math.max(0, now - S.intro.demoSince);
        if (d.dir) input.dir = { x: d.sided ? d.dir.x * S.intro.side : d.dir.x, y: d.dir.y };
        input.offScreen = !!d.offScreen;
        input.offCause = d.offScreen ? d.cause : null;
        if (d.eyeOpen != null) input.eyeOpen = d.eyeOpen;
        if (d.present === false) input.present = false;
      } else {
        input.state = 'focused';
      }
      return input;
    }
    if (phase === 'fruiting' || phase === 'complete') {
      const L = S.live;
      if (L) input.depth = U.clamp01(L.depth || 0);
      return input;
    }
    const inSession = phase === 'running' || phase === 'paused' || phase === 'break' ||
      (phase === 'calibrating' && sessionActive());
    const timerOnly = inSession && S.sessionSource === 'none';
    const sm = S.sample;
    if (!timerOnly && detRunning() && sm) {
      input.state = sm.state || S.detState || 'unseen';
      input.cause = sm.cause || null;
      input.stateAgeMs = sm.stateSince != null && isFinite(sm.stateSince) ? Math.max(0, now - sm.stateSince) : 0;
      input.focus = phase === 'idle' ? 0.75 : (sm.focus != null && isFinite(sm.focus) ? U.clamp01(sm.focus) : 0.75);
      input.dir = sm.gaze || null;
      input.offScreen = !!sm.offScreen;
      input.offCause = sm.offCause || null;
      input.eyeOpen = sm.eyeOpen != null && isFinite(sm.eyeOpen) ? sm.eyeOpen : 1;
      input.drowsiness = sm.drowsiness != null && isFinite(sm.drowsiness) ? sm.drowsiness : 0;
      input.present = sm.present !== false;
    } else if (inSession && !timerOnly) {
      input.state = 'unseen'; // camera off or lost mid-session: nothing is observed
    }
    if (inSession && S.live) {
      const L = S.live;
      input.depth = U.clamp01(L.depth || 0);
      input.rimProgress = L.rimProgress != null && isFinite(L.rimProgress) ? L.rimProgress : null;
      if (L.phase === 'break') {
        input.breakProgress = L.phaseTotalMs ? U.clamp01((L.phaseElapsedMs || 0) / L.phaseTotalMs) : 0;
        input.lookAway = Math.min(1, (L.breakLookAwayMs || 0) / 20000);
      }
    }
    if (phase === 'loading') input.loading = S.loading != null ? S.loading : 0;
    if (phase === 'calibrating') input.calibration = S.calInput;
    return input;
  }

  /* =================================================================== *
   * 33. Debug panel (?debug=1, D) and the missing-id check               *
   * =================================================================== */
  function toggleDebug() {
    S.debugVisible = !S.debugVisible;
    show('debugPanel', S.debugVisible);
    if (S.debugVisible) renderDebug();
  }
  function renderDebug() {
    const el = $('debugPanel');
    if (!el) return;
    const sm = S.sample || {};
    const vs = call('Visual', 'getStats') || {};
    const L = S.live || {};
    const f1 = (v) => (v == null || !isFinite(v) ? '–' : (+v).toFixed(1));
    const f2 = (v) => (v == null || !isFinite(v) ? '–' : (+v).toFixed(2));
    const rec = call('Session', 'getRecord');
    const tlLen = rec && rec.timeline && rec.timeline.s ? rec.timeline.s.length : 0;
    const lines = [
      'detector ' + get('Detector', 'status', '–') + ' · src ' + (get('Detector', 'source', null) || '–') +
        ' · engine ' + (get('Detector', 'engine', null) || '–') + ' · ' + (get('Detector', 'delegate', null) || '–') +
        ' · ' + f1(get('Detector', 'hz', null)) + ' Hz · infer ' + f1(sm.inferMs) + ' ms',
      'signal   F ' + f2(sm.focus) + ' · a ' + f2(sm.attention) + ' · gazeNorm ' + f2(sm.gazeNorm) +
        ' · x ' + f2(sm.gaze && sm.gaze.x) + ' · y ' + f2(sm.gaze && sm.gaze.y) + ' · conf ' + f2(sm.confidence),
      'eyes     open ' + f2(sm.eyeOpen) + ' · perclos ' + f2(sm.perclos) + ' · drowsy ' + f2(sm.drowsiness) +
        ' · blinks ' + f1(sm.blinkRate) + '/min',
      'state    ' + (sm.state || S.detState || '–') + '/' + (sm.cause || S.detCause || '–') + ' · word ' + S.word +
        (sm.unseenReason ? ' · unseen:' + sm.unseenReason : ''),
      'visual   ' + f1(vs.fps) + ' fps · cpu ' + f2(vs.cpuMs) + ' ms · q ' + (vs.quality || S.visualQuality || '–') +
        ' · dpr ' + f2(vs.dpr) + ' · nodes ' + (vs.nodes != null ? vs.nodes : '–') + ' · fresh ' + (vs.fresh != null ? vs.fresh : '–') +
        ' · scars ' + (vs.scars != null ? vs.scars : '–'),
      'session  ' + sessionPhase() + ' · active ' + Math.floor((L.activeMs || 0) / 1000) + ' s · timeline ' + tlLen +
        ' · src ' + (S.sessionSource || '–') + ' · depth ' + f2(L.depth),
      'app      screen ' + S.screen + ' · chrome ' + S.chrome + ' · clock ' +
        (FT.clock.usingWorker ? 'worker' : 'timer') + ' ' + FT.clock.intervalMs + ' ms · req ' + (reqCount() == null ? '–' : reqCount()),
    ];
    el.textContent = lines.join('\n');
  }

  const REQUIRED_IDS = (
    'stage vignette grain camVideo topbar brand todayStat btnSound btnPip btnHistory btnSettings btnHelp ' +
    'eye eyeCanvas eyeLid eyePip eyeLabel eyeReq eyeMenu eyeModeMesh eyeModeVideo eyeModeOff btnLens btnPrivacy ' +
    'toasts srStatus srAlert debugPanel icons favicon ' +
    'screen-intro introCard introStep0 introStep1 introStep2 introDots introDemoWord introDemoGloss btnIntroSkip btnIntroBack btnIntroNext btnIntroPrivacy ' +
    'screen-setup recoverBanner recoverText btnRecoverSave btnRecoverDiscard setupCard setupForm intention modeFree modePomodoro modeDeep modeCustom ' +
    'customFields customWork customBreak customRounds modeSummary sensGentle sensStandard sensStrict sensHelp cameraRow framingCanvas cameraState ' +
    'btnCameraFix btnCameraCheck btnBegin btnTimerOnly btnDemo btnExitDemo setupNote setupLinks linkHistory linkPrivacy linkHelp ' +
    'screen-permission btnAllowCamera btnPermTimerOnly btnPermBack ' +
    'screen-loading loadPhase loadBytes loadProgress loadHint btnLoadCancel ' +
    'screen-calibrate calStep calText calQuality calHint btnCalSkip btnCalCancel ' +
    'screen-session hud timer timerLabel roundText intentionText stateWord stateReason controls btnBreak btnPause btnEnd notes btnNotes notesBackdrop ' +
    'notesSpark nHeld nHeldTime nStreak nLongest nScars nReturns nDepth nBlink nDrowsy nLastDrift btnForgive breakPanel breakText breakRest ' +
    'btnSkipBreak btnExtendBreak pausedPanel pausedText btnResume cameraBanner cameraBannerText btnCamRetry btnCamTimer drowsyBanner ' +
    'btnDrowsyBreak btnDrowsyDismiss demoBar btnFruitSkip ' +
    'screen-summary summarySheet specimenLabel specimenName specimenVar sumGrid sumHeld sumHeldOf sumPct sumLongest sumReturns sumRecovery ' +
    'sumDepth sumRoot sumBlink sumDrowsy sumUnmeasured sumTimeline sumCauses sumDiagnosis sumRating btnKeepsake btnToTerrarium btnAgain ' +
    'screen-history btnHistBack histTotals histStreak chartDays chartDaysText shelves chartHeat bestHours chartCompass compassText ' +
    'chartRecovery recoveryText btnExport btnImport importFile btnErase histEmpty btnHistStart ' +
    'screen-error errTitle errBody errActions btnErrRetry btnErrTimer btnErrDemo btnErrBack errDetail errCode ' +
    'dlgSettings btnSettingsClose setSensitivity setDesk setEyesClosed setStrictTab setAutoPause setWork setShort setLong setRounds setGoal ' +
    'setAutoNext setRecenter setSound setSoundscape setChimes setVolume setNudgeSound setNotify setLiveTitle setForgiveToast setMotion ' +
    'setEyeMode setFadeChrome setCamera btnRecalibrate btnForgetCal calInfo btnSetExport btnSetImport btnSetErase ' +
    'dlgPrivacy privCam privReqCount privReqList privBlocked privCsp btnPrivacyClose ' +
    'dlgHelp btnHelpClose dlgEnd endBody btnEndConfirm btnEndDiscard btnEndCancel ' +
    'dlgJar jarCanvas jarTitle jarMeta jarStats jarDiagnosis btnJarKeepsake btnJarDelete btnJarClose ' +
    'dlgErase btnEraseConfirm btnEraseCancel'
  ).split(/\s+/).filter(Boolean);
  function checkIds() {
    const missing = REQUIRED_IDS.filter((id) => !$(id));
    const dupes = REQUIRED_IDS.filter((id) => document.querySelectorAll('[id="' + id + '"]').length > 1);
    if (missing.length) console.warn(LOG, 'missing ids (' + missing.length + '):', missing.join(', '));
    if (dupes.length) console.warn(LOG, 'duplicate ids:', dupes.join(', '));
  }

  /* =================================================================== *
   * 34. DOM wiring                                                       *
   * =================================================================== */
  function wireDom() {
    // Top bar
    click('brand', () => {
      if (sessionActive() || S.fruiting) return; // aria-disabled while a session is active
      if (S.flow) { cancelFlow(); return; }
      go('setup');
    });
    click('btnSound', toggleSound);
    click('btnPip', () => openPip());
    click('btnHistory', () => {
      if (S.flow) cancelFlow();
      go('history');
    });
    click('btnSettings', () => openDialog('dlgSettings'));
    click('btnHelp', () => openDialog('dlgHelp'));

    // The Eye + menu
    const eye = $('eye');
    if (eye) {
      eye.addEventListener('click', (e) => {
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('#eyeMenu')) return;
        toggleEyeMenu();
      });
      eye.addEventListener('keydown', (e) => {
        if (e.target !== eye) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggleEyeMenu(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openEyeMenu(true); }
      });
    }
    on('eyeMenu', 'keydown', onEyeMenuKey);
    for (const m of EYE_MODES) {
      click(EYE_MODE_IDS[m], (e) => { e.stopPropagation(); setEyeMode(m); closeEyeMenu(true); });
    }
    click('btnLens', (e) => { e.stopPropagation(); closeEyeMenu(true); toggleLens(); });
    click('btnPrivacy', (e) => { e.stopPropagation(); closeEyeMenu(false); openDialog('dlgPrivacy'); });
    document.addEventListener('pointerdown', (e) => {
      if (!S.eyeMenuOpen) return;
      const t = e.target;
      const menu = $('eyeMenu'), eyeEl = $('eye');
      if ((menu && menu.contains(t)) || (eyeEl && eyeEl.contains(t))) return;
      closeEyeMenu(false);
    }, true);

    // Intro
    click('btnIntroSkip', finishIntro);
    click('btnIntroBack', () => setIntroStep(S.intro.step - 1));
    click('btnIntroNext', () => { if (S.intro.step < 2) setIntroStep(S.intro.step + 1); else finishIntro(); });
    click('btnIntroPrivacy', (e) => { e.preventDefault(); openDialog('dlgPrivacy'); });

    // Setup
    const form = $('setupForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        begin(FT.env.demo ? 'sim' : 'camera');
      });
    } else {
      click('btnBegin', (e) => { e.preventDefault(); begin(FT.env.demo ? 'sim' : 'camera'); });
    }
    for (const k in MODE_IDS) {
      on(MODE_IDS[k], 'change', () => { setSetting({ mode: readMode() }); updateModeUI(); });
    }
    for (const k in SENS_IDS) {
      // SPEC-GAP: sensitivity applies immediately (same key as the Settings dialog).
      on(SENS_IDS[k], 'change', () => { setSetting({ sensitivity: readSens() }); updateModeUI(); });
    }
    for (const id of ['customWork', 'customBreak', 'customRounds']) {
      on(id, 'input', updateModeUI);
      on(id, 'change', () => {
        const c = readCustom();
        setVal('customWork', c.workMin);
        setVal('customBreak', c.breakMin);
        setVal('customRounds', c.rounds);
        const el = $(id);
        if (el) el.value = id === 'customWork' ? c.workMin : id === 'customBreak' ? c.breakMin : c.rounds;
        setSetting({ custom: c });
        updateModeUI();
      });
    }
    click('btnCameraCheck', (e) => { e.preventDefault(); onCheckFraming(); });
    click('btnCameraFix', (e) => {
      e.preventDefault();
      const err = S.lastCamError || { code: 'CameraFailed', message: '' };
      showError(err.code, { message: err.message }, { from: 'check', source: 'camera' });
    });
    click('btnTimerOnly', (e) => { e.preventDefault(); begin('none'); });
    click('btnDemo', (e) => { e.preventDefault(); navigateDemo(true); });
    click('btnExitDemo', (e) => { e.preventDefault(); navigateDemo(false); });
    click('linkHistory', (e) => { e.preventDefault(); go('history'); });
    click('linkPrivacy', (e) => { e.preventDefault(); openDialog('dlgPrivacy'); });
    click('linkHelp', (e) => { e.preventDefault(); openDialog('dlgHelp'); });
    click('btnRecoverSave', onRecoverSave);
    click('btnRecoverDiscard', onRecoverDiscard);

    // Permission primer
    click('btnAllowCamera', () => {
      unlockAudio();
      const next = S.pendingAfterPermission || 'begin';
      S.pendingAfterPermission = null;
      if (next === 'check') { go('setup'); startCheckFraming(); }
      else continueBegin('camera');
    });
    click('btnPermTimerOnly', () => { S.pendingAfterPermission = null; go('setup'); begin('none'); });
    click('btnPermBack', () => { S.pendingAfterPermission = null; go('setup'); });

    // Loading + calibration
    click('btnLoadCancel', cancelFlow);
    click('btnCalSkip', onCalSkip);
    click('btnCalCancel', cancelFlow);

    // Session
    click('btnBreak', onBreakBtn);
    click('btnPause', togglePause);
    click('btnEnd', openEndDialog);
    click('btnNotes', toggleNotes);
    click('notesBackdrop', closeNotes);
    click('btnForgive', forgive);
    click('btnSkipBreak', () => call('Session', 'skipBreak'));
    click('btnExtendBreak', () => {
      call('Session', 'extendBreak', 300000);
      toast('Five more minutes of rest.', { id: 'break', timeout: 3000 });
    });
    click('btnResume', () => call('Session', 'resume'));
    click('btnCamRetry', onCamRetry);
    click('btnCamTimer', onCamTimer);
    click('btnDrowsyBreak', () => { hideDrowsy(true); if (sessionPhase() === 'running') call('Session', 'startBreak', 300000); });
    click('btnDrowsyDismiss', () => hideDrowsy(true));
    click('demoBar', (e) => {
      const chip = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-sim]') : null;
      if (chip) simulate(chip.getAttribute('data-sim'));
    });
    click('btnFruitSkip', skipFruiting);

    // Error screen
    click('btnErrRetry', onErrRetry);
    click('btnErrTimer', onErrTimer);
    click('btnErrDemo', onErrDemo);
    click('btnErrBack', onErrBack);

    // Dialogs
    wireDialog('dlgSettings', 'btnSettingsClose', true);
    wireDialog('dlgPrivacy', 'btnPrivacyClose', true);
    wireDialog('dlgHelp', 'btnHelpClose', true);
    wireDialog('dlgEnd', 'btnEndCancel', false);
    wireDialog('dlgJar', null, false);
    wireDialog('dlgErase', null, false);
    click('btnEndConfirm', () => endSession(true));
    click('btnEndDiscard', () => endSession(false));
    wireSettings();

    // Global input
    document.addEventListener('keydown', onKeyDown);
    const activity = () => onActivity();
    document.addEventListener('pointermove', activity, { passive: true });
    document.addEventListener('pointerdown', activity, { passive: true });
    document.addEventListener('keydown', activity, true);
    document.addEventListener('focusin', activity);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      ensureLoop();
      if (S.live && sessionActive()) renderHud(S.live);
      refreshTitle(true);
    });
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onMq = () => { if (S.settings.motion === 'system') applyMotion(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    } catch (e) { /* ignore */ }
    window.addEventListener('resize', U.throttle(() => {
      if (S.notesOpen) show('notesBackdrop', FT.env.narrow());
      if (S.notesOpen) drawSpark();
    }, 200));
    window.addEventListener('pagehide', closePip);
  }

  /* =================================================================== *
   * 35. Bus wiring                                                       *
   * =================================================================== */
  function wireBus() {
    const b = FT.bus;
    b.on('clock:tick', onClockTick);
    b.on('store:error', onStoreError);
    b.on('detector:status', onDetStatus);
    b.on('detector:progress', onProgress);
    b.on('detector:error', onDetError);
    b.on('detector:camera', onDetCamera);
    b.on('detector:sample', onDetSample);
    b.on('detector:state', onDetState);
    b.on('detector:blink', onBlink);
    b.on('detector:drowsy', onDrowsy);
    b.on('detector:calibration', onCalibration);
    b.on('session:phase', onSessionPhase);
    b.on('session:tick', onSessionTick);
    b.on('session:second', onSecond);
    b.on('session:episode', onSessionEpisode);
    b.on('session:milestone', onMilestone);
    b.on('session:gap', onGap);
    b.on('session:complete', onSessionComplete);
    b.on('settings:change', onSettingsChange);
    b.on('history:change', onHistoryChange);
    b.on('visual:quality', (ev) => { S.visualQuality = ev && ev.quality; });
  }

  /* =================================================================== *
   * 36. Boot (§4.8.2, exact order)                                       *
   * =================================================================== */
  function init() {
    if (S.inited) return;
    S.inited = true;

    // 1. Missing-id check.
    if (FT.env.debug) { try { checkIds(); } catch (e) { /* ignore */ } }

    // 2. Session.
    let settings = null;
    try { if (has('Session', 'init')) settings = FT.Session.init(); }
    catch (err) { console.error(LOG, 'Session.init failed', err); }
    if (!settings) settings = call('Session', 'getSettings');
    S.settings = normSettings(settings);

    // 3. Detector.
    try {
      if (has('Detector', 'init')) {
        FT.Detector.init({ video: $('camVideo'), previews: [$('eyeCanvas'), $('framingCanvas')].filter(Boolean) });
        call('Detector', 'setOptions', detectorOptions(S.settings));
      }
    } catch (err) { console.error(LOG, 'Detector.init failed', err); }

    // 4. Visual.
    try { if (has('Visual', 'init') && $('stage')) FT.Visual.init($('stage')); }
    catch (err) { console.error(LOG, 'Visual.init failed', err); }
    applyMotion();

    // 5. Audio.
    call('Audio', 'init');
    call('Audio', 'setOptions', audioOptions(S.settings));

    // 6. Bus listeners, DOM handlers, privacy observer, History.
    wireBus();
    try { wireDom(); } catch (err) { console.error(LOG, 'DOM wiring failed', err); }
    initPrivacy();
    call('History', 'init');

    // Body attributes and static chrome state.
    const fav = $('favicon');
    S.faviconDefault = fav ? fav.getAttribute('href') || '' : '';
    bodyAttr('phase', 'idle');
    bodyAttr('state', 'none');
    bodyAttr('chrome', 'full');
    bodyAttr('cam', 'off');
    applyDemoUI();
    show('btnPip', FT.env.hasDocPiP);
    S.debugVisible = FT.env.debug;
    show('debugPanel', S.debugVisible);
    renderSoundBtn();
    renderEyeMode();
    renderLens();
    renderEyePip();
    renderEyeReq();
    renderSetupNote();
    renderCalInfo();
    refreshToday(true);
    for (const n of SCREENS) show('screen-' + n, false);

    // 7. Clock, then the rAF loop (started by go()).
    try { FT.clock.start(); } catch (err) { console.error(LOG, 'clock failed to start', err); }

    // 8. First screen (setup shows the recovery banner when a draft exists).
    if (FT.env.demo) go('setup');
    else if (!S.settings.onboarded) go('intro');
    else go('setup');
    ensureLoop();

    // 9. Storage unavailable.
    if (!FT.store.available) {
      toast('Hypha can\'t save in this browser mode. Export your specimens to keep them.', { id: 'storage', timeout: 12000 });
    }

    // 10. One-shot audio unlock on the first gesture.
    const unlockOnce = () => {
      document.removeEventListener('pointerdown', unlockOnce, true);
      document.removeEventListener('keydown', unlockOnce, true);
      unlockAudio();
    };
    document.addEventListener('pointerdown', unlockOnce, true);
    document.addEventListener('keydown', unlockOnce, true);
  }

  /* =================================================================== *
   * 37. Public API                                                       *
   * =================================================================== */
  FT.App = {
    init: init,
    go: go,
    back: back,
    toast: toast,
    announce: announce,
    dismissToast: dismissToast,
    begin: begin,
    openDialog: openDialog,
    closeDialog: closeDialog,
    get screen() { return S.screen; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => FT.App.init());
  else FT.App.init();
})();
