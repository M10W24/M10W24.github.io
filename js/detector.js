/*!
 * Hypha — js/detector.js  (FT.Detector)
 * Camera + MediaPipe FaceLandmarker (classic IIFE bundle pinned with SRI), a clock-driven detection
 * loop, signal extraction (head pose, gaze, eyes, drowsiness), calibration ("germination"), the
 * attention state machine, preview drawing and the simulation source (demo mode + test harness).
 * Contracts: SPEC.md §4.0, §4.2, §4.3, §5, §2.5 and SPEC-ADDENDUM.md.
 * Classic script, loaded with `defer` after core.js. Never calls another module at load time.
 */
(function () {
  'use strict';

  const FT = window.FT, U = FT.util;
  const LOG = '[Focus:detector]';
  const TAU = U.TAU;
  const DEG = 180 / Math.PI;

  /* =================================================================== *
   * 1. Constants                                                         *
   * =================================================================== */
  const MP_VER = '1.0.1';
  const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VER;
  const BUNDLE_URL = MP_BASE + '/vision_bundle.js';      // classic IIFE -> window.Vision
  const BUNDLE_SRI = 'sha384-NY1RsoxtRJjOPYGZFV9VydB6bMby6CNoARVMBpVd28BEaPNSBkZJeYMXU7U9TQzN';
  const WASM_BASE = MP_BASE + '/wasm';                    // FilesetResolver.forVisionTasks(WASM_BASE)
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const MODEL_BYTES = 3758596;                           // fallback when Content-Length is missing

  /** Per-sensitivity constants (§5.7). Times in ms. */
  const SENS = {
    gentle:   { k: 1.2,  grace: { turned: 1600, glance: 2400, down: 2400, up: 1900 }, closedAfter: 2500 },
    standard: { k: 1.0,  grace: { turned: 1000, glance: 1500, down: 1500, up: 1200 }, closedAfter: 1500 },
    strict:   { k: 0.88, grace: { turned: 600,  glance: 900,  down: 900,  up: 700 },  closedAfter: 1200 },
  };
  const ABSENT_AFTER = 2000;          // no face -> absent
  const RETURN_AWAY_MS = 300;         // back from away / eyes-closed
  const RETURN_ABSENT_MS = 600;       // back from absent
  const F_ENTER = 0.72;               // focused-enter threshold
  const F_DRIFT = 0.55;               // drift-enter threshold ...
  const DRIFT_HOLD_MS = 500;          // ... held for this long
  const OFF_EXIT = 0.95;              // off-screen exit hysteresis
  const LOWCONF_MS = 1000;
  const STALL_MS = 2000;
  const CAUSE_SWITCH_MS = 1000;       // a new off-screen cause must persist this long while away
  const NOFACE_DOWN_MS = 1500, NOFACE_TURN_MS = 1000, NOFACE_ABSENT_MS = 20000, LASTGAZE_MS = 1000;

  const DEFAULT_BOX = Object.freeze({ left: 16, right: 16, up: 10, down: 14 });
  /** Used only until the running median of the first 2 s of present samples exists (§4.3.4). */
  const FALLBACK_BASE = Object.freeze({ yaw: 0, pitch: 0, roll: 0, eyeYaw: 0, eyePitch: 0, blinkOpen: 0.1, ear: 0.28, faceWidth: 0.2 });
  /** Calibration points as viewport fractions (§4.3.5). */
  const CAL_POINTS = [
    { x: 0.5, y: 0.5, name: 'C' },
    { x: 0.08, y: 0.12, name: 'TL' },
    { x: 0.92, y: 0.12, name: 'TR' },
    { x: 0.92, y: 0.88, name: 'BR' },
    { x: 0.08, y: 0.88, name: 'BL' },
  ];

  /** Reason copy, exact (§5.7). */
  const REASON = {
    focused: 'Focused: eyes on your work.',
    focusedEyes: 'Eyes closed. Counted as thinking.',
    drifting: 'Drifting: attention near the edge.',
    turned: 'Head turned to the {side}.',
    glance: 'Eyes wandered to the {side}.',
    down: 'Looking down. Phone check?',
    up: 'Looking up, off the screen.',
    tab: 'Another tab or window has focus.',
    eyes: 'Eyes closed. Focused time pauses.',
    eyesLong: 'Eyes closed for a while.',
    eyesDrowsy: 'Eyes are heavy. A break might help.',
    absent: 'No one at the desk.',
    stalled: 'Camera frames paused. Not counted.',
    muted: 'Camera paused by the system. Not counted.',
    'camera-off': 'Camera off. Timer only.',
    'low-confidence': "Can't see you clearly. Not counted.",
    recovering: 'Restarting face tracking…',
    calibrating: 'Calibrating: follow the dots.',
  };
  /** Unseen reasons, highest priority first. */
  const UNSEEN_ORDER = ['camera-off', 'recovering', 'muted', 'stalled', 'low-confidence'];

  const CAMERA_ERRORS = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'AbortError'];
  // SPEC-GAP: legacy/vendor getUserMedia error names are mapped onto their standard equivalents.
  const LEGACY_CAMERA_ERRORS = {
    PermissionDeniedError: 'NotAllowedError', PermissionDismissedError: 'NotAllowedError',
    DevicesNotFoundError: 'NotFoundError', TrackStartError: 'NotReadableError',
    ConstraintNotSatisfiedError: 'OverconstrainedError',
  };
  /** Codes whose error screen offers "Try again" (§2.5) are recoverable. */
  const UNRECOVERABLE = ['InsecureContext', 'Unsupported', 'NoWebGL2', 'SecurityError'];
  const MESSAGES = {
    InsecureContext: 'Camera needs a secure page.',
    Unsupported: "This browser can't use the camera.",
    NoWebGL2: 'Face tracking needs WebGL2.',
    NotAllowedError: 'Camera access is blocked.',
    NotFoundError: 'No camera found.',
    NotReadableError: 'Your camera is busy.',
    OverconstrainedError: 'Camera settings not supported.',
    SecurityError: 'Camera disabled by policy.',
    AbortError: "The camera couldn't start.",
    CameraFailed: "The camera couldn't start.",
    CameraLost: 'Camera disconnected.',
    ModelLoadFailed: "Couldn't download the face model.",
    ModelInitFailed: "Face tracking couldn't start here.",
    CalibrationFailed: "Couldn't find your face",
    CalibrationCancelled: 'Calibration cancelled.',
    NotRunning: 'The camera is not running.',
    Cancelled: 'Start cancelled.',
  };
  // SPEC-GAP: §5.1's pattern plus the wasm's close() line, so engine re-creation stays quiet too.
  const CONSOLE_NOISE = /^(INFO:|I0|W0)|Graph successfully started running|Created TensorFlow Lite XNNPACK|Graph finished closing/;

  /** MediaPipe's 52 blendshape names in model order; used by the worker engine until it reports its own. */
  const BLEND_NAMES = [
    '_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft',
    'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft',
    'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft',
    'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
    'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight',
    'mouthPucker', 'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
    'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft',
    'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight',
  ];

  const PREVIEW_MODES = ['mesh', 'video', 'off'];
  const ENGINES = ['auto', 'main', 'worker'];
  const PREVIEW_BG = '#0B1719';
  const TONES = [[0x0B, 0x17, 0x19], [0x4F, 0xA8, 0x93], [0xCF, 0xE6, 0xDF]]; // posterised video preview

  /* =================================================================== *
   * 2. Module state                                                      *
   * =================================================================== */
  let inited = false;
  let video = null;
  const previews = new Set();
  const ctxCache = new WeakMap();

  const options = {
    sensitivity: 'standard', deskOk: false, eyesClosedOk: false, strictTab: false,
    previewMode: 'mesh', deviceId: null, engine: 'auto',
  };
  const engineParam = U.param('engine');

  // Lifecycle
  let status = 'idle', source = null, delegate = null, engineKind = null;
  let startJob = null, startSeq = 0;

  // Camera
  let stream = null, track = null, trackHandlers = null;
  let camLabel = '', camId = null, reqDeviceId = null;

  // Main-thread engine
  let lm = null, mainDelegate = null, lastTs = 1;
  let fileset = null, filesetPromise = null, scriptPromise = null;
  let modelBuffer = null, modelPromise = null, enginePromise = null;
  let recreating = false;
  const recreations = [];        // performance.now() of each re-creation (5-min window)
  let quietDepth = 0, quietRestore = null;

  // Worker engine
  let worker = null, workerUrl = null, workerReady = false, workerBusy = false, workerFailed = false;
  let workerSentAt = 0, workerFrameT = 0, workerLastTs = 1, workerNames = null, workerDelegate = null;

  // Loop
  let tickCount = 0, divider = 1, inferEma = 0, inferLowSince = 0, lastInferT = 0, lastInferMs = 0;
  let lastMediaTime = -1, stalledSince = 0, lastHeartbeat = 0, hz = 0;
  const flags = { 'camera-off': true, recovering: false, muted: false, stalled: false, 'low-confidence': false };

  // Signals
  let lastSampleT = 0, sample = null;
  let F = 0.8;
  let closed = false, closedSince = 0, eyesClosedMs = 0, eyeOpen = 1, jawOpen = 0;
  let eyeRef = null;             // eye angles of the last open-eyed sample
  const win = [];                // 60 s of present samples: {t, w, low}
  let winObs = 0, winLow = 0;
  const blinks = [];             // {t, dur} within 60 s
  const yawns = [];              // t within 10 min
  let perclos = null, blinkRate = null, meanBlinkDur = null;
  let jawHighSince = 0, yawnArmed = false, lastYawnT = -1e9;
  let Z = 0, drowsy = false, zHighSince = 0, zLowSince = 0;
  let confidence = 0, lowConfSince = 0;

  // State machine
  let curState = 'unseen', curCause = null, curReason = REASON['camera-off'], stateSince = 0;
  let noFaceSince = 0, presentSince = 0, lastGaze = null;
  let offActive = false, offSince = 0, lastOffCause = null, candCause = null, candSince = 0;
  let onSince = 0, driftSince = 0;

  // Default base: running median of the first 2 s of present samples (no calibration yet)
  let dbSamples = [], dbStart = 0, dbValue = null, dbFrozen = false;

  // Calibration
  let calibration = null;        // camera calibration (persisted)
  let simCal = null;             // sim calibration (never persisted, never used for the camera)
  let calRun = null;

  // Simulation
  let sim = null;

  // Light hint
  let lumaCanvas = null, lumaCtx = null;
  let posterizeOk = true;

  /* =================================================================== *
   * 3. Small helpers                                                     *
   * =================================================================== */
  function mkErr(code, message) {
    const e = new Error(message || MESSAGES[code] || String(code));
    e.code = code;
    return e;
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const emit = (name, payload) => FT.bus.emit(name, payload);
  const sens = () => SENS[options.sensitivity] || SENS.standard;
  const isActive = () => status === 'running' || status === 'recovering';
  const progressOk = () => !!startJob && !startJob.cancelled;
  const neg = (v) => (v == null ? null : -v);
  const errText = (err) => String((err && err.message) || err || 'unknown error');

  function setStatus(s, message) {
    status = s;
    emit('detector:status', { status: s, source: source, delegate: delegate, message: message || '' });
  }
  function emitProgress(phase, progress, loadedBytes, totalBytes) {
    emit('detector:progress', {
      phase: phase, progress: U.clamp01(progress),
      loadedBytes: loadedBytes == null ? null : loadedBytes,
      totalBytes: totalBytes == null ? null : totalBytes,
    });
  }
  /** Progress that belongs to an in-flight start() only (a cancelled start goes quiet). */
  function prog(phase, progress, loadedBytes, totalBytes) {
    if (progressOk()) emitProgress(phase, progress, loadedBytes, totalBytes);
  }
  function emitCamera(live, muted) {
    emit('detector:camera', { live: !!live, muted: !!muted, label: camLabel || '', deviceId: camId || null });
  }
  function unseenReason() {
    for (let i = 0; i < UNSEEN_ORDER.length; i++) if (flags[UNSEEN_ORDER[i]]) return UNSEEN_ORDER[i];
    return null;
  }
  function wordFor(state, cause) {
    if (state === 'calibrating') return 'calibrating';
    const info = FT.CODES[FT.codeFor(state, cause)];
    return info ? info.word : 'not visible';
  }
  function videoAspect() {
    return video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
  }

  /* =================================================================== *
   * 4. check() and options                                               *
   * =================================================================== */
  function check(arg) {
    const src = typeof arg === 'string' ? arg : arg && arg.source;
    if (src === 'sim') return { ok: true };
    if (!window.isSecureContext) return { ok: false, code: 'InsecureContext' };
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return { ok: false, code: 'Unsupported' };
    if (!FT.env.hasWebGL2()) return { ok: false, code: 'NoWebGL2' };
    return { ok: true };
  }

  function setOptions(partial) {
    if (!partial || typeof partial !== 'object') return getOptions();
    const prevMode = options.previewMode;
    if ('sensitivity' in partial && SENS[partial.sensitivity]) options.sensitivity = partial.sensitivity;
    if ('deskOk' in partial) options.deskOk = !!partial.deskOk;
    if ('eyesClosedOk' in partial) options.eyesClosedOk = !!partial.eyesClosedOk;
    if ('strictTab' in partial) options.strictTab = !!partial.strictTab;
    if ('previewMode' in partial && PREVIEW_MODES.indexOf(partial.previewMode) >= 0) options.previewMode = partial.previewMode;
    // SPEC-GAP: a new deviceId is used by the next start(); start() with a different deviceId restarts the camera.
    if ('deviceId' in partial) options.deviceId = partial.deviceId || null;
    if ('engine' in partial && ENGINES.indexOf(partial.engine) >= 0) options.engine = partial.engine;
    if (options.previewMode !== prevMode && options.previewMode === 'off') clearPreviews();
    return getOptions();
  }
  function getOptions() { return Object.assign({}, options); }
  function engineChoice() { return ENGINES.indexOf(engineParam) >= 0 ? engineParam : options.engine; }

  /* =================================================================== *
   * 5. Camera (§5.2)                                                     *
   * =================================================================== */
  function mapCameraError(err) {
    if (err && err.code && MESSAGES[err.code]) return err;   // already one of ours (Cancelled, CameraFailed…)
    const name = err && err.name;
    if (CAMERA_ERRORS.indexOf(name) >= 0) return mkErr(name, MESSAGES[name]);
    if (name && LEGACY_CAMERA_ERRORS[name]) return mkErr(LEGACY_CAMERA_ERRORS[name], MESSAGES[LEGACY_CAMERA_ERRORS[name]]);
    return mkErr('CameraFailed', MESSAGES.CameraFailed + (err && err.message ? ' (' + err.message + ')' : ''));
  }

  async function getStream(deviceId) {
    const vc = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } };
    if (deviceId) vc.deviceId = { exact: deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: vc });
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true });
      }
      throw err;
    }
  }

  function stopStream(s) {
    if (!s) return;
    try { s.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
  }

  function stopCamera() {
    detachTrackEvents();
    if (stream) stopStream(stream);
    stream = null; track = null;
    if (video) {
      try { video.pause(); } catch (e) { /* ignore */ }
      try { video.srcObject = null; } catch (e) { /* ignore */ }
    }
    flags.muted = false; flags.stalled = false;
    stalledSince = 0; lastMediaTime = -1;
  }

  async function openCamera(job, deviceId) {
    if (!video) throw mkErr('CameraFailed', 'No video element was given to FT.Detector.init().');
    let s;
    try { s = await getStream(deviceId); }
    catch (err) { throw mapCameraError(err); }
    if (job.cancelled) { stopStream(s); throw mkErr('Cancelled'); }

    stream = s;
    track = s.getVideoTracks()[0] || null;
    let settings = {};
    try { settings = (track && track.getSettings && track.getSettings()) || {}; } catch (e) { settings = {}; }
    camLabel = (track && track.label) || '';
    camId = settings.deviceId || deviceId || null;
    reqDeviceId = deviceId || null;
    attachTrackEvents(track);

    try {
      video.muted = true;
      video.playsInline = true;
      video.srcObject = s;
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch((e) => console.warn(LOG, 'video.play() was rejected:', e && e.name));
    } catch (err) {
      throw mapCameraError(err);
    }

    const t0 = performance.now();
    while (!(video.readyState >= 2 && video.videoWidth > 0)) {
      if (job.cancelled) throw mkErr('Cancelled');
      if (job.lost) throw mkErr('CameraFailed', 'The camera disconnected while starting.');
      if (performance.now() - t0 > 8000) throw mkErr('CameraFailed', 'No frames arrived from the camera within 8 s.');
      await sleep(50);
    }
    if (job.cancelled) throw mkErr('Cancelled');
    lastMediaTime = -1; stalledSince = 0; flags.muted = false; flags.stalled = false;
    emitCamera(true, false);
  }

  function attachTrackEvents(t) {
    detachTrackEvents();
    if (!t) return;
    const onMute = () => {
      if (track !== t) return;
      flags.muted = true;
      emitCamera(true, true);
      if (isActive()) heartbeat(performance.now(), true);
    };
    const onUnmute = () => {
      if (track !== t) return;
      flags.muted = false;
      stalledSince = 0; flags.stalled = false;
      emitCamera(true, false);
    };
    const onEnded = () => { if (track === t) onTrackEnded(); };
    t.addEventListener('mute', onMute);
    t.addEventListener('unmute', onUnmute);
    t.addEventListener('ended', onEnded);
    trackHandlers = { t: t, onMute: onMute, onUnmute: onUnmute, onEnded: onEnded };
  }
  function detachTrackEvents() {
    const h = trackHandlers;
    trackHandlers = null;
    if (!h) return;
    try {
      h.t.removeEventListener('mute', h.onMute);
      h.t.removeEventListener('unmute', h.onUnmute);
      h.t.removeEventListener('ended', h.onEnded);
    } catch (e) { /* ignore */ }
  }

  /** The track ended on its own (unplugged, revoked, another app took it). */
  function onTrackEnded() {
    if (startJob && startJob.source === 'camera') { startJob.lost = true; return; }   // start() rejects with CameraFailed
    const wasActive = isActive() && source === 'camera';
    const now = performance.now();
    if (calRun) endCal(calRun, 'cancelled', mkErr('CalibrationCancelled', 'The camera disconnected.'));
    stopCamera();
    flags['camera-off'] = true; flags.recovering = false;
    workerBusy = false;
    if (wasActive) heartbeat(now, true);                  // state -> unseen (camera-off), plus a final sample
    emitCamera(false, false);
    if (wasActive) {
      emit('detector:error', { code: 'CameraLost', message: MESSAGES.CameraLost, recoverable: true, during: 'running' });
    }
    source = null;
    setStatus('stopped', MESSAGES.CameraLost);
    clearPreviews();
  }

  async function listCameras() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
    } catch (err) {
      console.warn(LOG, 'enumerateDevices failed:', errText(err));
      return [];
    }
  }

  /* =================================================================== *
   * 6. Loading MediaPipe (§5.1)                                          *
   * =================================================================== */
  /** Temporarily drop MediaPipe's chatty console lines. Nest-safe; returns the restore function. */
  function quietConsole() {
    if (quietDepth++ === 0) {
      const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
      const wrap = (fn) => function () {
        const a0 = arguments[0];
        if (typeof a0 === 'string' && CONSOLE_NOISE.test(a0)) return undefined;
        return fn.apply(console, arguments);
      };
      console.log = wrap(orig.log); console.info = wrap(orig.info);
      console.warn = wrap(orig.warn); console.error = wrap(orig.error);
      quietRestore = () => { console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error; };
    }
    let done = false;
    return function restore() {
      if (done) return;
      done = true;
      if (--quietDepth === 0 && quietRestore) { quietRestore(); quietRestore = null; }
    };
  }

  /** Close a main-thread landmarker without MediaPipe's shutdown chatter. Never throws. */
  function closeQuietly(inst) {
    if (!inst) return;
    const restore = quietConsole();
    try { inst.close(); } catch (e) { /* ignore */ } finally { restore(); }
  }

  /** Inject the IIFE bundle with Subresource Integrity. Resolves when window.Vision exists. */
  function loadScript() {
    if (window.Vision && window.Vision.FaceLandmarker) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BUNDLE_URL;
      s.integrity = BUNDLE_SRI;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = () => {
        if (window.Vision && window.Vision.FaceLandmarker) resolve();
        else { scriptPromise = null; reject(mkErr('ModelLoadFailed', 'The tracking engine loaded but did not initialise.')); }
      };
      s.onerror = () => {
        scriptPromise = null;
        try { s.remove(); } catch (e) { /* ignore */ }
        reject(mkErr('ModelLoadFailed', "Couldn't download the tracking engine (network, or an integrity mismatch)."));
      };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function ensureFileset() {
    if (fileset) return Promise.resolve(fileset);
    if (!filesetPromise) {
      filesetPromise = Promise.resolve()
        .then(() => window.Vision.FilesetResolver.forVisionTasks(WASM_BASE))
        .then((fs) => { fileset = fs; return fs; })
        .catch((err) => {
          filesetPromise = null;
          throw mkErr('ModelLoadFailed', "Couldn't prepare the tracking engine: " + errText(err));
        });
    }
    return filesetPromise;
  }

  /** Download the model once, streaming progress (0.05 → 0.80 overall). Kept for re-creations. */
  function fetchModel() {
    if (modelBuffer) return Promise.resolve(modelBuffer);
    if (modelPromise) return modelPromise;
    modelPromise = (async () => {
      let res;
      try { res = await fetch(MODEL_URL, { mode: 'cors', credentials: 'omit' }); }
      catch (err) { throw mkErr('ModelLoadFailed', 'Network error while fetching the face model.'); }
      if (!res.ok) throw mkErr('ModelLoadFailed', 'The face model request failed (HTTP ' + res.status + ').');
      let total = parseInt(res.headers.get('Content-Length') || '', 10);
      if (!(total > 0)) total = MODEL_BYTES;
      prog('model', 0.05, 0, total);
      let buf;
      try {
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const chunks = [];
          let loaded = 0, lastEmit = 0;
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
            loaded += r.value.byteLength;
            const t = performance.now();
            if (t - lastEmit >= 100) {
              lastEmit = t;
              prog('model', 0.05 + 0.75 * Math.min(1, loaded / total), loaded, Math.max(total, loaded));
            }
          }
          const out = new Uint8Array(loaded);
          let off = 0;
          for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].byteLength; }
          buf = out.buffer;
        } else {
          buf = await res.arrayBuffer();
        }
      } catch (err) {
        throw mkErr('ModelLoadFailed', 'The face model download was interrupted.');
      }
      if (!buf || buf.byteLength < 1024) throw mkErr('ModelLoadFailed', 'The face model download was empty.');
      prog('model', 0.8, buf.byteLength, buf.byteLength);
      modelBuffer = buf;
      return buf;
    })();
    modelPromise.catch(() => { modelPromise = null; });
    return modelPromise;
  }

  function landmarkerOptions(d) {
    return {
      baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer.slice(0)), delegate: d },
      runningMode: 'VIDEO', numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    };
  }

  /** Create + warm up a main-thread landmarker: preferred delegate first, then the other one. */
  async function createLandmarker(preferred) {
    const V = window.Vision;
    if (!V || !V.FaceLandmarker) throw mkErr('ModelInitFailed', 'The tracking engine is not loaded.');
    if (!modelBuffer) throw mkErr('ModelInitFailed', 'The face model is not loaded.');
    const fs = await ensureFileset();
    const order = preferred === 'CPU' ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
    const restore = quietConsole();
    let lastErr = null;
    try {
      for (let i = 0; i < order.length; i++) {
        const d = order[i];
        let inst = null;
        try {
          inst = await V.FaceLandmarker.createFromOptions(fs, landmarkerOptions(d));
          const warm = document.createElement('canvas');
          warm.width = warm.height = 64;
          const wctx = warm.getContext('2d');
          if (wctx) { wctx.fillStyle = '#000'; wctx.fillRect(0, 0, 64, 64); }
          inst.detectForVideo(warm, 1);          // throws if the delegate is broken
          return { inst: inst, delegate: d };
        } catch (err) {
          lastErr = err;
          if (inst) { try { inst.close(); } catch (e) { /* ignore */ } }
          console.warn(LOG, d + ' delegate unavailable:', errText(err));
        }
      }
    } finally {
      restore();
    }
    throw mkErr('ModelInitFailed', MESSAGES.ModelInitFailed + ' (' + errText(lastErr) + ')');
  }

  function warmupAnimator() {
    const t0 = performance.now();
    prog('warmup', 0.85, null, null);
    const id = setInterval(() => {
      prog('warmup', 0.85 + 0.13 * (1 - Math.exp(-(performance.now() - t0) / 2500)), null, null);
    }, 250);
    return () => clearInterval(id);
  }

  /** Loads script/model/wasm and builds an engine (worker when possible, else main thread). Shared. */
  function ensureEngine() {
    if (lm || (worker && workerReady)) return Promise.resolve();
    if (!enginePromise) {
      enginePromise = loadEngine().finally(() => { enginePromise = null; });
    }
    return enginePromise;
  }

  async function loadEngine() {
    if (progressOk()) setStatus('loading', 'Fetching the engine');
    prog('script', 0.03, null, null);

    let useWorker = workerAllowed();
    let bundleText = null;
    if (useWorker) {
      try { bundleText = await fetchBundleText(); }
      catch (err) {
        console.warn(LOG, 'Could not fetch the engine for a worker; using the main thread.', errText(err));
        useWorker = false;
      }
    }
    if (!useWorker) await loadScript();

    // Model file and wasm, in parallel.
    let wasmP = null;
    if (!useWorker) { wasmP = ensureFileset(); wasmP.catch(() => { /* awaited below */ }); }
    await fetchModel();
    if (wasmP) {
      let settled = false;
      wasmP.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      if (!settled) prog('wasm', 0.8, null, null);
      await wasmP;
    }

    // Create and warm up.
    if (progressOk()) setStatus('warming', 'Warming up');
    const stopAnim = warmupAnimator();
    try {
      if (useWorker) {
        try {
          await startWorker(bundleText);
        } catch (err) {
          console.warn(LOG, 'Worker engine unavailable (' + errText(err) + '); using the main thread.');
          workerFailed = true;
          terminateWorker();
          useWorker = false;
          await loadScript();
          await ensureFileset();
        }
      }
      if (!useWorker && !lm) {
        const r = await createLandmarker(null);
        if (lm) closeQuietly(r.inst);                     // a concurrent build won
        else { lm = r.inst; mainDelegate = r.delegate; lastTs = 1; }
      }
    } finally {
      stopAnim();
    }
    prog('warmup', 1, null, null);
  }

  /** Point engineKind/delegate at whichever engine exists (worker preferred). */
  function activateEngine() {
    if (worker && workerReady) { engineKind = 'worker'; delegate = workerDelegate; }
    else if (lm) { engineKind = 'main'; delegate = mainDelegate; }
    else { engineKind = null; delegate = null; }
  }

  /* =================================================================== *
   * 7. Worker engine (SHOULD, §5.1) and engine recovery                  *
   * =================================================================== */
  /**
   * Runs inside a Blob worker, concatenated after the SRI-checked MediaPipe bundle (which defines the
   * global `Vision`). Self-contained: it is serialised with Function.prototype.toString().
   * Protocol: init -> ready|error; detect(bitmap, ts) -> result|error. Every bitmap is closed.
   */
  function workerMain() {
    var lm = null, lastTs = 1, namesSent = false;
    var NOISE = /^(INFO:|I0|W0)|Graph successfully started running|Created TensorFlow Lite XNNPACK|Graph finished closing/;
    ['log', 'info', 'warn', 'error'].forEach(function (k) {
      var orig = console[k];
      if (typeof orig !== 'function') return;
      console[k] = function () {
        var a = arguments[0];
        if (typeof a === 'string' && NOISE.test(a)) return undefined;
        return orig.apply(console, arguments);
      };
    });
    function fail(code, err) {
      postMessage({ type: 'error', code: code, message: String((err && err.message) || err || code) });
    }
    async function init(m) {
      var fs = await Vision.FilesetResolver.forVisionTasks(m.wasmBase);
      var order = ['GPU', 'CPU'], lastErr = null;
      for (var i = 0; i < order.length; i++) {
        var inst = null;
        try {
          inst = await Vision.FaceLandmarker.createFromOptions(fs, {
            baseOptions: { modelAssetBuffer: new Uint8Array(m.model), delegate: order[i] },
            runningMode: 'VIDEO', numFaces: 1,
            outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
            minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
          });
          var oc = new OffscreenCanvas(64, 64);
          var c2 = oc.getContext('2d');
          if (c2) c2.fillRect(0, 0, 64, 64);
          inst.detectForVideo(oc, 1);
          lm = inst; lastTs = 1;
          postMessage({ type: 'ready', delegate: order[i], names: null });
          return;
        } catch (err) {
          lastErr = err;
          if (inst) { try { inst.close(); } catch (e) { /* ignore */ } }
        }
      }
      fail('ModelInitFailed', lastErr);
    }
    function detect(m) {
      var bmp = m.bitmap;
      try {
        if (!lm) { fail('NotReady', 'The worker has no landmarker.'); return; }
        var ts = Math.max(m.ts, lastTs + 1); lastTs = ts;
        var t0 = performance.now();
        var r = lm.detectForVideo(bmp, ts);
        var out = { type: 'result', ts: ts, inferMs: performance.now() - t0, landmarks: null, blend: null, matrix: null };
        var transfer = [];
        var face = r && r.faceLandmarks && r.faceLandmarks[0];
        if (face && face.length) {
          var L = new Float32Array(face.length * 3);
          for (var j = 0; j < face.length; j++) { L[j * 3] = face[j].x; L[j * 3 + 1] = face[j].y; L[j * 3 + 2] = face[j].z || 0; }
          out.landmarks = L; transfer.push(L.buffer);
          var cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories;
          if (cats && cats.length) {
            var B = new Float32Array(Math.max(52, cats.length));
            var names = namesSent ? null : [];
            for (var k = 0; k < cats.length; k++) { B[k] = cats[k].score; if (names) names.push(cats[k].categoryName || ''); }
            out.blend = B; transfer.push(B.buffer);
            if (names) { out.names = names; namesSent = true; }
          }
          var mx = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0] && r.facialTransformationMatrixes[0].data;
          if (mx && mx.length >= 16) {
            var M = new Float32Array(16);
            for (var q = 0; q < 16; q++) M[q] = mx[q];
            out.matrix = M; transfer.push(M.buffer);
          }
        }
        postMessage(out, transfer);
      } catch (err) {
        fail('DetectFailed', err);
      } finally {
        try { if (bmp && bmp.close) bmp.close(); } catch (e) { /* ignore */ }
      }
    }
    self.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'init') init(m).catch(function (err) { fail('ModelInitFailed', err); });
      else if (m.type === 'detect') detect(m);
      else if (m.type === 'close') {
        try { if (lm) lm.close(); } catch (err) { /* ignore */ }
        lm = null;
        self.close();
      }
    };
  }
  const WORKER_SRC = '(' + workerMain.toString() + ')();';

  function workerAllowed() {
    return engineChoice() !== 'main' && !workerFailed && typeof Worker === 'function' &&
      typeof OffscreenCanvas === 'function' && 'createImageBitmap' in window;
  }

  async function fetchBundleText() {
    const res = await fetch(BUNDLE_URL, { integrity: BUNDLE_SRI, mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  /** Boot a worker with the bundle + WORKER_SRC. Resolves on 'ready'; rejects on error or after 8 s. */
  function startWorker(text) {
    return new Promise((resolve, reject) => {
      let w = null, url = null, done = false, timer = 0;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          if (w) { try { w.terminate(); } catch (e) { /* ignore */ } }
          if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
          reject(err);
        } else {
          resolve();
        }
      };
      try {
        url = URL.createObjectURL(new Blob([text, '\n', WORKER_SRC], { type: 'text/javascript' }));
        w = new Worker(url);
      } catch (err) {
        finish(err);
        return;
      }
      timer = setTimeout(() => finish(new Error('the worker did not become ready within 8 s')), 8000);
      w.onmessage = (e) => {
        const m = e.data || {};
        if (done) return;
        if (m.type === 'ready') {
          if (worker) terminateWorker();                  // never keep two
          worker = w; workerUrl = url; workerReady = true; workerBusy = false;
          workerDelegate = m.delegate || 'GPU'; workerNames = m.names || null; workerLastTs = 1;
          w.onmessage = onWorkerMessage;
          w.onerror = onWorkerError;
          w.onmessageerror = onWorkerError;
          finish(null);
        } else if (m.type === 'error') {
          finish(new Error(m.message || m.code || 'worker init failed'));
        }
      };
      w.onerror = (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        finish(new Error((ev && ev.message) || 'worker error'));
      };
      try {
        const copy = modelBuffer.slice(0);
        w.postMessage({ type: 'init', wasmBase: WASM_BASE, model: copy }, [copy]);
      } catch (err) {
        finish(err);
      }
    });
  }

  function terminateWorker() {
    const w = worker;
    worker = null; workerReady = false; workerBusy = false;
    if (w) {
      try { w.postMessage({ type: 'close' }); } catch (e) { /* ignore */ }
      try { w.terminate(); } catch (e) { /* ignore */ }
    }
    if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (e) { /* ignore */ } workerUrl = null; }
  }

  function onWorkerMessage(e) {
    const m = e.data || {};
    if (m.type === 'result') {
      workerBusy = false;
      if (m.names && m.names.length) workerNames = m.names;
      if (!isActive() || source !== 'camera' || engineKind !== 'worker') return;   // stale result
      let raw = null;
      if (m.landmarks && m.landmarks.length >= 468 * 3) {
        const names = workerNames || BLEND_NAMES;
        let blend = null;
        if (m.blend) {
          blend = {};
          for (let i = 0; i < names.length && i < m.blend.length; i++) blend[names[i]] = m.blend[i];
        }
        raw = { pts: m.landmarks, blend: blend, matrix: m.matrix || null };
      }
      noteInfer(m.inferMs || 0, workerFrameT);
      handleRaw(raw, workerFrameT, m.inferMs || 0);
    } else if (m.type === 'error') {
      workerBusy = false;
      fallbackToMain('worker reported ' + (m.code || 'an error') + ': ' + (m.message || ''));
    }
  }
  function onWorkerError(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    fallbackToMain('worker error event' + (ev && ev.message ? ': ' + ev.message : ''));
  }

  function workerDetect(now) {
    if (!worker || !workerReady) return;
    if (workerBusy) {
      if (now - workerSentAt > 3000) fallbackToMain('a detection went unanswered for 3 s');
      return;                                             // at most one detect in flight
    }
    workerBusy = true;
    workerSentAt = now;
    const frameT = performance.now();
    let p;
    try { p = createImageBitmap(video); }
    catch (err) { workerBusy = false; return; }
    p.then((bmp) => {
      if (!worker || engineKind !== 'worker' || !isActive()) {
        try { bmp.close(); } catch (e) { /* ignore */ }
        workerBusy = false;
        return;
      }
      const ts = Math.max(performance.now(), workerLastTs + 1);
      workerLastTs = ts;
      workerFrameT = frameT;
      try {
        worker.postMessage({ type: 'detect', bitmap: bmp, ts: ts }, [bmp]);
      } catch (err) {
        try { bmp.close(); } catch (e) { /* ignore */ }
        workerBusy = false;
        fallbackToMain('postMessage failed: ' + errText(err));
      }
    }, () => { workerBusy = false; });                  // a frame that couldn't be grabbed is just skipped
  }

  /** Any worker failure: silently continue on the main thread. The camera stays on. */
  function fallbackToMain(reason) {
    if (!worker && engineKind !== 'worker') return;
    console.warn(LOG, 'Worker engine failed (' + reason + '); continuing on the main thread.');
    const pref = workerDelegate;
    workerFailed = true;
    terminateWorker();
    if (lm) { engineKind = 'main'; delegate = mainDelegate; return; }
    engineKind = 'main';
    if (isActive() && source === 'camera') rebuildMain(pref, false);
  }

  /** The main landmarker threw: it is permanently broken (§5.1 "Breakage and re-creation"). */
  function onEngineBroken(err) {
    console.warn(LOG, 'detectForVideo threw; re-creating the landmarker.', errText(err));
    const now = performance.now();
    while (recreations.length && now - recreations[0] > 300000) recreations.shift();
    flags.recovering = true;
    setStatus('recovering', 'Restarting face tracking');
    heartbeat(now, true);
    const broken = lm;
    lm = null;
    closeQuietly(broken);
    if (recreations.length >= 3) {
      giveUp('Face tracking failed repeatedly (' + errText(err) + ').');
      return;
    }
    recreations.push(now);
    rebuildMain(mainDelegate || delegate, true);
  }

  async function rebuildMain(preferred, announce) {
    if (recreating) return;
    recreating = true;
    flags.recovering = true;
    if (isActive()) heartbeat(performance.now(), true);
    try {
      await loadScript();
      await fetchModel();
      await ensureFileset();
      const r = await createLandmarker(preferred);
      if (lm) closeQuietly(r.inst);
      else { lm = r.inst; mainDelegate = r.delegate; lastTs = 1; }
      flags.recovering = false;
      if (isActive() && source === 'camera') {
        engineKind = 'main'; delegate = mainDelegate;
        if (status === 'recovering' || announce) setStatus('running', 'Face tracking on this device');
      }
    } catch (err) {
      flags.recovering = false;
      if (isActive() && source === 'camera') giveUp(errText(err));
      else console.warn(LOG, 'Could not rebuild the landmarker:', errText(err));
    } finally {
      recreating = false;
    }
  }

  /** Stop detecting, turn the camera off and tell the app (banner "Face tracking stopped…"). */
  function giveUp(message) {
    const now = performance.now();
    console.warn(LOG, 'Face tracking stopped:', message);
    if (calRun) endCal(calRun, 'cancelled', mkErr('CalibrationCancelled', 'Face tracking stopped.'));
    flags.recovering = false;
    stopCamera();
    flags['camera-off'] = true;
    heartbeat(now, true);
    emitCamera(false, false);
    source = null;
    setStatus('error', message);
    emit('detector:error', { code: 'ModelInitFailed', message: MESSAGES.ModelInitFailed + ' ' + message, recoverable: true, during: 'running' });
    clearPreviews();
  }

  /* =================================================================== *
   * 8. Detection loop (§5.3) — driven only by clock:tick                  *
   * =================================================================== */
  function onTick(e) {
    if (!isActive()) return;
    const now = (e && e.now) || performance.now();
    if (calRun) calTick(now);
    if (!isActive()) return;                              // calTick may have ended things
    tickCount++;
    if (!document.hidden) {                               // hidden: every tick (about 4 Hz)
      updateDivider(now);
      if (divider > 1 && tickCount % divider !== 0) return;
    }
    if (source === 'sim') simTick(now);
    else cameraTick(now);
  }

  function updateDivider(now) {
    if (FT.env.coarse && FT.env.narrow()) { divider = 2; return; }
    if (inferEma > 40) { divider = 2; inferLowSince = 0; return; }
    if (divider > 1) {
      if (inferEma < 25) {
        if (!inferLowSince) inferLowSince = now;
        else if (now - inferLowSince >= 10000) { divider = 1; inferLowSince = 0; }
      } else {
        inferLowSince = 0;
      }
    }
  }

  function noteInfer(ms, t) {
    lastInferMs = ms;
    if (!lastInferT) inferEma = ms;
    else inferEma = U.damp(inferEma, ms, 2000, U.clamp(t - lastInferT, 0, 2000));
    lastInferT = t;
  }

  function cameraTick(now) {
    if (!video) return;
    if (flags.recovering || flags.muted || recreating) { heartbeat(now, false); return; }
    // Readiness guard: detecting on a video that isn't ready breaks the instance.
    const ready = video.readyState >= 2 && video.videoWidth > 0;
    const mt = ready ? video.currentTime : lastMediaTime;
    // Stall detection: the same media time means no new frame.
    if (!ready || mt === lastMediaTime) {
      if (!stalledSince) stalledSince = now;
      if (now - stalledSince > STALL_MS) { flags.stalled = true; heartbeat(now, false); }
      return;
    }
    lastMediaTime = mt;
    stalledSince = 0;
    flags.stalled = false;
    if (engineKind === 'worker' && worker && workerReady) workerDetect(now);
    else if (lm) mainDetect();
    else if (!recreating) rebuildMain(mainDelegate || workerDelegate, false);   // engine vanished: rebuild
  }

  function mainDetect() {
    const ts = Math.max(performance.now(), lastTs + 1);  // strictly increasing, one source per instance
    lastTs = ts;
    const t0 = performance.now();
    let res;
    try { res = lm.detectForVideo(video, ts); }
    catch (err) { onEngineBroken(err); return; }
    const inferMs = performance.now() - t0;
    noteInfer(inferMs, t0);
    handleRaw(rawFromResult(res), t0, inferMs);
  }

  /** Either engine ends here with a RawResult ({pts, blend, matrix}) or null (no face). */
  function handleRaw(raw, t, inferMs) {
    let obs = null;
    if (raw) {
      try { obs = extract(raw); } catch (err) { console.warn(LOG, 'Could not read a result:', errText(err)); obs = null; }
    }
    processObservation(obs || NO_FACE, t, inferMs, obs ? raw.pts : null, false);
  }

  /** Emit an unseen/no-face sample at most every 250 ms while frames are not being processed. */
  function heartbeat(now, force) {
    if (!force && now - lastHeartbeat < 250) return;
    lastHeartbeat = now;
    processObservation(NO_FACE, now, 0, null, true);
  }
  const NO_FACE = Object.freeze({ present: false, faces: 0 });

  /* =================================================================== *
   * 9. Signal extraction (§5.4)                                          *
   * =================================================================== */
  function rawFromResult(res) {
    const face = res && res.faceLandmarks && res.faceLandmarks[0];
    if (!face || face.length < 468) return null;
    const pts = new Float32Array(face.length * 3);
    for (let i = 0; i < face.length; i++) {
      const p = face[i];
      pts[i * 3] = p.x; pts[i * 3 + 1] = p.y; pts[i * 3 + 2] = p.z || 0;
    }
    let blend = null;
    const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
    if (cats && cats.length) {
      blend = {};
      for (let i = 0; i < cats.length; i++) blend[cats[i].categoryName] = cats[i].score;
    }
    const m = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
    const matrix = m && m.data && m.data.length >= 16 ? m.data : null;
    return { pts: pts, blend: blend, matrix: matrix };
  }

  /** Research function, unchanged. d = matrix.data, COLUMN-MAJOR: R(r,c) = d[c*4 + r]. */
  function headPoseFromMatrix(d) {
    const R = (r, c) => d[c * 4 + r], DEG = 180 / Math.PI, cl = v => Math.max(-1, Math.min(1, v));
    const nx = Math.hypot(R(0,0), R(1,0), R(2,0)) || 1, ny = Math.hypot(R(0,1), R(1,1), R(2,1)) || 1,
          nz = Math.hypot(R(0,2), R(1,2), R(2,2)) || 1;
    return { yaw:   Math.atan2(R(0,2) / nz, R(2,2) / nz) * DEG,   // + = user's LEFT
             pitch: Math.asin(cl(-R(1,2) / nz)) * DEG,            // + = chin down
             roll:  Math.atan2(R(1,0) / nx, R(1,1) / ny) * DEG }; // + = toward user's right shoulder
  }

  /*
   * Landmark indices (MediaPipe FaceMesh, 478 points with irises). Coordinates are the RAW, unmirrored
   * image, so the subject's RIGHT eye appears on the image LEFT (smaller x):
   *   subject's right eye: 33 outer corner, 133 inner corner, 159 upper lid, 145 lower lid, 468 iris centre
   *   subject's left eye:  263 outer corner, 362 inner corner, 386 upper lid, 374 lower lid, 473 iris centre
   *   1 nose tip, 10 top of forehead, 152 chin, 234 face edge on the image left, 454 face edge on the image right
   */

  /** Landmark head-pose fallback with de-roll (§5.4). Aspect-correct points P(i) = {x·ar, y}. */
  function poseFromLandmarks(pts, ar) {
    const px = (i) => pts[i * 3] * ar, py = (i) => pts[i * 3 + 1];
    const ax = px(33), ay = py(33), bx = px(263), by = py(263);
    const ang = Math.atan2(by - ay, bx - ax);
    const roll = -ang * DEG;
    // De-roll: rotate about the midpoint of 33 and 263 by -ang so the 33→263 line is horizontal.
    const mx = (ax + bx) / 2, my = (ay + by) / 2, c = Math.cos(-ang), s = Math.sin(-ang);
    const rx = (i) => mx + (px(i) - mx) * c - (py(i) - my) * s;
    const ry = (i) => my + (px(i) - mx) * s + (py(i) - my) * c;
    const yawDen = rx(454) - rx(234), pitchDen = ry(152) - ry(10);
    const yawRatio = Math.abs(yawDen) > 1e-6 ? (rx(1) - rx(234)) / yawDen : 0.5;
    const pitchRatio = Math.abs(pitchDen) > 1e-6 ? (ry(1) - ry(10)) / pitchDen : 0.55;
    return { yaw: (yawRatio - 0.5) * 100, pitch: (pitchRatio - 0.55) * 110, roll: roll };
  }

  /**
   * Iris gaze ("research §2" irisGaze, reconstructed; the research file is not part of this build).
   * Per eye, the iris centre is projected onto the corner-to-corner axis, measured from the corner with
   * the smaller image x: 0 = image-left corner, 1 = image-right corner. The projection equals
   * (iris.x − minCornerX) / cornerSpan for a level eye and stays correct under head roll.
   * gx is the mean over both eyes. Image-right is the user's LEFT, so gx − 0.5 > 0 means looking to the
   * user's left (same sign as yaw). ear = mean over both eyes of (lid gap / corner span).
   */
  function irisGaze(pts, ar) {
    const n = (pts.length / 3) | 0;
    const px = (i) => pts[i * 3] * ar, py = (i) => pts[i * 3 + 1];
    const eye = (iris, c1, c2, up, lo) => {
      let ax = px(c1), ay = py(c1), bx = px(c2), by = py(c2);
      if (bx < ax) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; }
      const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
      const span = Math.sqrt(len2) || 1e-6;
      const ear = Math.hypot(px(up) - px(lo), py(up) - py(lo)) / span;
      let g = null;
      if (iris >= 0 && iris < n && len2 > 1e-12) g = ((px(iris) - ax) * vx + (py(iris) - ay) * vy) / len2;
      return { g: g, ear: ear };
    };
    const hasIris = n >= 478;
    const R = eye(hasIris ? 468 : -1, 33, 133, 159, 145);
    const L = eye(hasIris ? 473 : -1, 362, 263, 386, 374);
    const gx = R.g != null && L.g != null ? (R.g + L.g) / 2 : 0.5;
    return { gx: U.clamp(gx, -0.5, 1.5), ear: (R.ear + L.ear) / 2, hasIris: hasIris };
  }

  /** RawResult -> RawObservation {present, faces, yaw, pitch, roll, poseSource, eyeYaw, eyePitch, blink, ear, jawOpen, faceWidth}. */
  function extract(raw) {
    const pts = raw.pts;
    const ar = videoAspect();
    let pose = null, poseSource = 'matrix';
    if (raw.matrix && raw.matrix.length >= 16) pose = headPoseFromMatrix(raw.matrix);
    if (!pose || !isFinite(pose.yaw) || !isFinite(pose.pitch) || !isFinite(pose.roll)) {
      pose = poseFromLandmarks(pts, ar);
      poseSource = 'landmarks';
    }
    const iris = irisGaze(pts, ar);
    const irisX = iris.gx - 0.5;                          // + = user's left
    const bs = raw.blend;
    let eyeYaw, eyePitch, blink, jaw;
    if (bs && bs.eyeBlinkLeft != null && bs.eyeBlinkRight != null) {
      const g = (k) => +bs[k] || 0;
      const lookH = ((g('eyeLookOutLeft') + g('eyeLookInRight')) - (g('eyeLookInLeft') + g('eyeLookOutRight'))) / 2;
      const lookV = ((g('eyeLookDownLeft') + g('eyeLookDownRight')) - (g('eyeLookUpLeft') + g('eyeLookUpRight'))) / 2;
      eyeYaw = 0.75 * (lookH * 32) + 0.25 * (irisX * 110);
      eyePitch = lookV * 28;
      blink = (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2;
      jaw = g('jawOpen');
    } else {
      const base = currentBase();
      eyeYaw = irisX * 110;
      eyePitch = 0;
      blink = U.clamp01(1 - iris.ear / (base.ear || 0.28));
      jaw = 0;
    }
    const faceWidth = Math.abs(pts[454 * 3] - pts[234 * 3]);
    return {
      present: true, faces: 1,
      yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll, poseSource: poseSource,
      eyeYaw: eyeYaw, eyePitch: eyePitch, blink: U.clamp01(blink), ear: iris.ear, jawOpen: U.clamp01(jaw),
      faceWidth: faceWidth,
    };
  }

  /* =================================================================== *
   * 10. Base, box, combined gaze                                         *
   * =================================================================== */
  function activeCal() { return source === 'sim' ? simCal : calibration; }
  function currentBase() { const c = activeCal(); return (c && c.base) || dbValue || FALLBACK_BASE; }
  function currentBox() { const c = activeCal(); return (c && c.box) || DEFAULT_BOX; }

  function baseFrom(S) {
    const col = (k) => S.map((o) => o[k]);
    return {
      yaw: U.median(col('yaw')), pitch: U.median(col('pitch')), roll: U.median(col('roll')),
      eyeYaw: U.median(col('eyeYaw')), eyePitch: U.median(col('eyePitch')),
      blinkOpen: U.percentile(col('blink'), 0.3), ear: U.median(col('ear')), faceWidth: U.median(col('faceWidth')),
    };
  }

  /** Default base (before any calibration): running median of the first 2 s of present samples. */
  function noteDefaultBase(o, t) {
    if (activeCal() || dbFrozen) return;
    if (!dbStart) dbStart = t;
    dbSamples.push({ yaw: o.yaw, pitch: o.pitch, roll: o.roll, eyeYaw: o.eyeYaw, eyePitch: o.eyePitch, blink: o.blink, ear: o.ear, faceWidth: o.faceWidth });
    dbValue = baseFrom(dbSamples);
    if (t - dbStart >= 2000) { dbFrozen = true; dbSamples = []; }
  }
  function resetDefaultBase() { dbSamples = []; dbStart = 0; dbValue = null; dbFrozen = false; }

  /** Combined gaze in normalised screen space (§5.4). */
  function gazeOf(o, base, box, k, deskOk) {
    const hY = o.yaw - base.yaw, hP = o.pitch - base.pitch;
    const gYaw = hY + (o.eyeYaw - base.eyeYaw);           // + = user's left (screen-left)
    const gPitch = hP + (o.eyePitch - base.eyePitch);     // + = down
    const nx = (v) => (v > 0 ? -v / (box.left * k) : -v / (box.right * k));
    const ny = (v) => (v > 0 ? v / (box.down * k) : v / (box.up * k));
    const norm = (a, b) => (deskOk ? Math.max(Math.abs(a), Math.max(0, -b)) : Math.max(Math.abs(a), Math.abs(b)));
    const x = nx(gYaw), y = ny(gPitch);
    const gazeNorm = norm(x, y);
    const headNorm = norm(nx(hY), ny(hP));
    let offCause = null;
    if (gazeNorm > 1) {
      const eyeOnly = headNorm < 0.8;
      if (y > 1 && y >= Math.abs(x) && !deskOk) offCause = 'down';
      else if (y < -1 && -y >= Math.abs(x)) offCause = 'up';
      else if (eyeOnly) offCause = 'glance';
      else offCause = 'turned';
    }
    return { hY: hY, hP: hP, gYaw: gYaw, gPitch: gPitch, x: x, y: y, gazeNorm: gazeNorm, headNorm: headNorm, offCause: offCause };
  }

  /* =================================================================== *
   * 11. Per-sample processing: eyes, windows, drowsiness, confidence,    *
   *     attention a, focus F, state machine, Sample                      *
   * =================================================================== */
  function processObservation(obs, t, inferMs, pts, isHeartbeat) {
    const dt = lastSampleT ? U.clamp(t - lastSampleT, 0, 1000) : 0;
    lastSampleT = t;
    if (!isHeartbeat && dt > 0) hz = hz ? U.damp(hz, 1000 / dt, 2000, dt) : 1000 / dt;

    const S = sens(), opt = options;
    const present = !!obs.present;
    if (present) noteDefaultBase(obs, t);
    const base = currentBase(), box = currentBox();
    let g = null;

    if (present) {
      // Eyes: personal openness first; it decides whether the eye angles can be trusted.
      const range = Math.max(0.25, 0.92 - base.blinkOpen);
      eyeOpen = 1 - U.clamp01((obs.blink - base.blinkOpen) / range);

      // SPEC-GAP: while the lids are down (eyeOpen < 0.5) the eye-gaze blendshapes and iris are unreliable
      // (a blink reads as "looking down"), so the combined gaze uses the eye angles of the last open-eyed
      // sample; head pose stays live. Without this, blinks would trip the looking-down guard (no blink
      // events) and a long eye closure would read as away/down instead of eyes-closed.
      let go = obs;
      if (eyeOpen >= 0.5 || !eyeRef) eyeRef = { eyeYaw: obs.eyeYaw, eyePitch: obs.eyePitch };
      else go = { yaw: obs.yaw, pitch: obs.pitch, eyeYaw: eyeRef.eyeYaw, eyePitch: eyeRef.eyePitch };
      g = gazeOf(go, base, box, S.k, opt.deskOk);

      // Closure with hysteresis, blinks.
      let nowClosed = closed ? eyeOpen <= 0.5 : eyeOpen < 0.35;
      if (g.y > 0.8) nowClosed = false;                  // lids drop when you look down
      if (nowClosed && !closed) { closed = true; closedSince = t; }
      else if (!nowClosed && closed) {
        closed = false;
        const dur = t - closedSince;
        if (dur >= 50 && dur < 1500) {
          blinks.push({ t: t, dur: dur });
          emit('detector:blink', { t: t, durationMs: dur });
        }
      }
      eyesClosedMs = closed ? t - closedSince : 0;

      // 60 s window of present samples, time-weighted by dt.
      const w = Math.min(dt, 500);
      const low = eyeOpen < 0.2 && g.y <= 0.8;
      win.push({ t: t, w: w, low: low });
      winObs += w; if (low) winLow += w;
      const cut = t - 60000;
      while (win.length && win[0].t < cut) { const e = win.shift(); winObs -= e.w; if (e.low) winLow -= e.w; }
      if (winObs < 1e-6) { winObs = 0; winLow = 0; }
      while (blinks.length && blinks[0].t < cut) blinks.shift();
      perclos = winObs >= 20000 ? U.clamp01(winLow / winObs) : null;
      blinkRate = winObs >= 20000 ? (blinks.length * 60000) / winObs : null;
      if (blinks.length) { let s = 0; for (let i = 0; i < blinks.length; i++) s += blinks[i].dur; meanBlinkDur = s / blinks.length; }
      else meanBlinkDur = null;

      // Yawns: jawOpen > 0.55 for >= 1200 ms, then < 0.3 (5 s cooldown).
      jawOpen = U.clamp01(obs.jawOpen || 0);
      if (jawOpen > 0.55) {
        if (!jawHighSince) jawHighSince = t;
        if (t - jawHighSince >= 1200) yawnArmed = true;
      } else if (yawnArmed && jawOpen < 0.3) {
        yawnArmed = false; jawHighSince = 0;
        if (t - lastYawnT >= 5000) { lastYawnT = t; yawns.push(t); emit('detector:yawn', { t: t }); }
      } else if (!yawnArmed) {
        jawHighSince = 0;
      }
      while (yawns.length && yawns[0] < t - 600000) yawns.shift();

      // Drowsiness Z.
      Z = U.clamp01(U.smoothstep(0.06, 0.15, perclos == null ? 0 : perclos) +
        0.4 * Math.min(1, yawns.length / 2) +
        0.3 * U.smoothstep(400, 900, meanBlinkDur == null ? 0 : meanBlinkDur));
      if (!drowsy) {
        if (Z > 0.6) {
          if (!zHighSince) zHighSince = t;
          if (t - zHighSince >= 20000) { drowsy = true; zLowSince = 0; emit('detector:drowsy', { active: true, level: Z, t: t }); }
        } else zHighSince = 0;
      } else if (Z < 0.4) {
        if (!zLowSince) zLowSince = t;
        if (t - zLowSince >= 30000) { drowsy = false; zHighSince = 0; emit('detector:drowsy', { active: false, level: Z, t: t }); }
      } else zLowSince = 0;

      // Confidence.
      let c = 1;
      if (obs.faceWidth < 0.08) c = 0.3; else if (obs.faceWidth < 0.12) c = 0.6;
      if (obs.poseSource === 'landmarks') c *= 0.8;
      confidence = c;
      if (c < 0.5) {
        if (!lowConfSince) lowConfSince = t;
        if (t - lowConfSince >= LOWCONF_MS) flags['low-confidence'] = true;
      } else { lowConfSince = 0; flags['low-confidence'] = false; }

      lastGaze = { x: g.x, y: g.y, t: t };
      if (!presentSince) presentSince = t;
      noFaceSince = 0;
    } else {
      // No face: windowed values keep their last values.
      if (!noFaceSince) noFaceSince = t;
      presentSince = 0;
      confidence = 0;
      lowConfSince = 0;
      flags['low-confidence'] = false;
    }

    // Attention a and focus F (§5.6). F is frozen while unseen or calibrating.
    const eyesTerm = closed && eyesClosedMs >= S.closedAfter && !opt.eyesClosedOk ? 0 : 1;
    let a = present ? (1 - U.smoothstep(0.85, 1.25, g.gazeNorm)) * eyesTerm : 0;
    if (opt.strictTab && document.hidden) a = 0;
    const frozen = curState === 'unseen' || curState === 'calibrating' || !!calRun || !!unseenReason();
    if (!frozen && dt > 0) F = U.dampAsym(F, a, 3000, 1200, dt);

    // Calibration consumes the sample first; while it runs the state is 'calibrating'.
    if (calRun) calSample(obs, t, dt);
    if (calRun) setState('calibrating', null, REASON.calibrating, t, null);
    else evaluate(t, present, g);

    const mag = g ? Math.max(Math.abs(g.x), Math.abs(g.y)) : 0;
    sample = {
      t: t, dt: dt, source: source === 'sim' ? 'sim' : 'camera', hidden: document.hidden,
      present: present, faces: present ? 1 : 0, confidence: confidence,
      poseSource: present ? obs.poseSource : null,
      head: present ? { yaw: obs.yaw, pitch: obs.pitch, roll: obs.roll } : null,
      headRel: present ? { yaw: g.hY, pitch: g.hP } : null,
      gaze: present ? { x: g.x, y: g.y } : null,
      gazeNorm: present ? g.gazeNorm : 0,
      angle: present && mag >= 0.2 ? Math.atan2(g.y, g.x) : null,
      offScreen: present ? g.gazeNorm > 1 : false,
      offCause: present ? g.offCause : null,
      eyeOpen: eyeOpen, eyesClosedMs: eyesClosedMs, blinkRate: blinkRate, perclos: perclos,
      drowsiness: Z, jawOpen: jawOpen, attention: a, focus: F,
      state: curState, cause: curCause, reason: curReason, stateSince: stateSince,
      unseenReason: unseenReason(), inferMs: inferMs, hz: hz,
      // Optional extras (not in the §4.3.2 contract).
      closed: closed, drowsy: drowsy, meanBlinkDur: meanBlinkDur, yawns10: yawns.length,
      faceWidth: present ? obs.faceWidth : null, delegate: delegate, engine: engineKind,
    };
    emit('detector:sample', sample);
    if (!isHeartbeat && !document.hidden) drawPreviews(present ? obs : null, pts);
  }

  /* =================================================================== *
   * 12. State machine (§5.7)                                             *
   * =================================================================== */
  function sideReason(tpl, x) { return tpl.replace('{side}', x < 0 ? 'left' : 'right'); }
  function awayReason(cause, x) {
    if (cause === 'turned') return sideReason(REASON.turned, x);
    if (cause === 'glance') return sideReason(REASON.glance, x);
    return REASON[cause] || REASON.turned;
  }
  function resetMotionTimers() {
    offActive = false; offSince = 0; lastOffCause = null; candCause = null; candSince = 0;
    onSince = 0; driftSince = 0;
  }

  /** Emits detector:state only when the state or the cause changes; always refreshes the reason. */
  function setState(state, cause, reason, t, gv) {
    curReason = reason;
    if (state === curState && cause === curCause) return false;
    const prev = curState, prevCause = curCause;
    curState = state; curCause = cause; stateSince = t;
    if (state !== 'away') candCause = null;
    let dir = null, angle = null;
    if (gv && isFinite(gv.x) && isFinite(gv.y)) {
      const m = Math.hypot(gv.x, gv.y);
      if (m > 1e-3) { dir = { x: gv.x / m, y: gv.y / m }; angle = Math.atan2(gv.y, gv.x); }
    }
    emit('detector:state', {
      state: state, cause: cause, prev: prev, prevCause: prevCause, reason: reason,
      word: wordFor(state, cause), dir: dir, angle: angle, t: t,
    });
    return true;
  }

  function evaluate(t, present, g) {
    const S = sens(), opt = options;

    // 1. Unseen.
    const ur = unseenReason();
    if (ur) { resetMotionTimers(); setState('unseen', null, REASON[ur], t, null); return; }

    // 2. Strict tab.
    if (opt.strictTab && document.hidden) { resetMotionTimers(); setState('away', 'tab', REASON.tab, t, null); return; }

    // 3. No face.
    if (!present) {
      resetMotionTimers();
      const lost = t - noFaceSince;
      const lg = lastGaze && noFaceSince - lastGaze.t <= LASTGAZE_MS ? lastGaze : null;
      if (lost >= NOFACE_ABSENT_MS) { setState('absent', 'absent', REASON.absent, t, null); return; }
      // SPEC-GAP: in desk mode a downward last gaze is not treated as a phone check (desk work is allowed).
      if (lg && lg.y > 1 && !opt.deskOk) {
        if (lost >= NOFACE_DOWN_MS) setState('away', 'down', REASON.down, t, lg);
        return;
      }
      if (lg && Math.abs(lg.x) > 1) {
        if (lost >= NOFACE_TURN_MS) setState('away', 'turned', sideReason(REASON.turned, lg.x), t, lg);
        return;
      }
      if (lost >= ABSENT_AFTER) setState('absent', 'absent', REASON.absent, t, null);
      return;                                              // before any threshold: keep the state
    }

    // 4. Eyes closed.
    if (closed && eyesClosedMs >= S.closedAfter && g.y <= 0.8) {
      resetMotionTimers();
      if (opt.eyesClosedOk) { setState('focused', null, REASON.focusedEyes, t, null); return; }
      const r = drowsy ? REASON.eyesDrowsy : eyesClosedMs > 10000 ? REASON.eyesLong : REASON.eyes;
      setState('eyes-closed', 'eyes', r, t, null);
      return;
    }

    // 5. Off-screen (with exit hysteresis).
    const off = g.gazeNorm > 1 || (offActive && g.gazeNorm >= OFF_EXIT);
    if (off) {
      onSince = 0; driftSince = 0;
      if (!offActive) { offActive = true; offSince = t; }
      const oc = g.offCause || lastOffCause || 'turned';
      lastOffCause = oc;
      if (curState === 'away' && curCause !== 'tab') {
        if (oc !== curCause) {
          if (candCause !== oc) { candCause = oc; candSince = t; }
          else if (t - candSince >= CAUSE_SWITCH_MS) { candCause = null; setState('away', oc, awayReason(oc, g.x), t, g); return; }
        } else candCause = null;
        setState('away', curCause, awayReason(curCause, g.x), t, g);   // refresh the side in the reason
        return;
      }
      if (t - offSince >= (S.grace[oc] || S.grace.turned)) { candCause = null; setState('away', oc, awayReason(oc, g.x), t, g); }
      return;                                              // within grace: keep the state
    }
    offActive = false; offSince = 0; candCause = null; lastOffCause = null;

    // 6. On-screen.
    if (!closed) { if (!onSince) onSince = t; } else onSince = 0;
    const ret = () => {
      driftSince = 0;
      if (F >= F_ENTER) setState('focused', null, REASON.focused, t, null);
      else setState('drifting', null, REASON.drifting, t, null);
    };
    switch (curState) {
      case 'away':
      case 'eyes-closed':
        if (onSince && t - onSince >= RETURN_AWAY_MS) ret();
        return;
      case 'absent':
        if (presentSince && t - presentSince >= RETURN_ABSENT_MS) ret();
        return;
      case 'focused':
        if (F < F_DRIFT) {
          if (!driftSince) driftSince = t;
          if (t - driftSince >= DRIFT_HOLD_MS) { driftSince = 0; setState('drifting', null, REASON.drifting, t, null); return; }
        } else driftSince = 0;
        setState('focused', null, REASON.focused, t, null);   // e.g. leaves the "counted as thinking" reason
        return;
      case 'drifting':
        if (F >= F_ENTER) setState('focused', null, REASON.focused, t, null);
        return;
      default:                                             // unseen, calibrating: immediate
        ret();
    }
  }

  function onVisibility() {
    // A hidden tab is context, not a verdict; only strict mode reacts (rule 2).
    if (!isActive() || calRun || !options.strictTab || !document.hidden) return;
    resetMotionTimers();
    setState('away', 'tab', REASON.tab, performance.now(), null);
  }

  /* =================================================================== *
   * 13. Calibration ("germination", §5.5)                                *
   * =================================================================== */
  function loadSavedCalibration() {
    const c = FT.store.get('calibration', null);
    if (c && c.v === 1 && c.base && c.box) { calibration = c; return; }
    calibration = null;
    if (c != null) console.warn(LOG, 'Ignoring a saved calibration with an unknown version.');
  }

  function calibrate(opts) {
    const kind = opts && (opts.kind === 'quick' || opts.kind === 'center') ? opts.kind : 'full';
    if (!isActive()) return Promise.reject(mkErr('NotRunning'));
    if (calRun) endCal(calRun, 'cancelled', mkErr('CalibrationCancelled', 'A new calibration started.'));
    return new Promise((resolve, reject) => {
      const t = performance.now();
      const list = kind === 'full' ? CAL_POINTS : CAL_POINTS.slice(0, 1);
      const run = {
        kind: kind, resolve: resolve, reject: reject, t0: t,
        points: list.map((p, i) => ({ x: p.x, y: p.y, name: p.name, state: i === 0 ? 'active' : 'pending' })),
        index: 0, progress: 0, faceFound: false, steady: false, quality: 0, hint: null,
        lastFaceT: t, lastEmit: 0, lastLuma: 0, dark: false, skipped: false,
        prevCal: activeCal(),
        center: { t0: t, firstFaceT: 0, noFaceSince: 0, recent: [], all: [], steadySamples: [], steadyMs: 0, presentMs: 0 },
        corner: null, corners: {}, validCorners: 0,
        base: null, noise: null, steadiness: 1, fwRecent: [],
      };
      calRun = run;
      resetMotionTimers();
      setState('calibrating', null, REASON.calibrating, t, null);
      run.quality = runningQuality(run, t);
      emitCal(run, 'start');
      emitCal(run, 'point');
    });
  }

  function emitCal(run, phase, extra) {
    const ev = {
      phase: phase, kind: run.kind, index: run.index, total: run.points.length,
      points: run.points.map((p) => ({ x: p.x, y: p.y, state: p.state })),
      progress: U.clamp01(run.progress), faceFound: !!run.faceFound, steady: !!run.steady,
      quality: U.clamp01(run.quality), hint: run.hint,
    };
    if (extra) Object.assign(ev, extra);
    run.lastEmit = performance.now();
    emit('detector:calibration', ev);
  }

  /** Every processed sample while calibrating (heartbeats included, as "no face"). */
  function calSample(obs, t, dt) {
    const run = calRun;
    const step = Math.min(dt, 200);
    if (obs.present) {
      run.lastFaceT = t;
      run.faceFound = true;
      run.fwRecent.push(obs.faceWidth);
      if (run.fwRecent.length > 15) run.fwRecent.shift();
    } else {
      run.faceFound = false;
    }
    if (run.index === 0) centerStep(run, obs, t, step);
    else cornerStep(run, obs, t);
    if (calRun !== run) return;                           // finished (or failed) inside the step
    updateHints(run, t);
    run.quality = runningQuality(run, t);
    if (t - run.lastEmit >= 100) emitCal(run, 'progress');
  }

  /** Timeouts that must fire even when no samples arrive (stalled camera, hidden tab). */
  function calTick(now) {
    const run = calRun;
    if (!run) return;
    if (now - run.lastFaceT >= 20000) { failCal(run); return; }
    if (run.index > 0 && run.corner && now - run.corner.settleEnd >= 5000) { finishCorner(run, now, null); if (calRun !== run) return; }
    updateHints(run, now);
    if (now - run.lastEmit >= 250) { run.quality = runningQuality(run, now); emitCal(run, 'progress'); }
  }

  function centerStep(run, obs, t, step) {
    const c = run.center;
    if (!obs.present) {
      if (!c.noFaceSince) c.noFaceSince = t;
      if (t - c.noFaceSince > 500 && (c.steadyMs > 0 || c.steadySamples.length)) {
        c.steadyMs = 0; c.steadySamples = []; c.recent = [];
      }
      run.steady = false;
      run.progress = U.clamp01(c.steadyMs / 1500);
      return;
    }
    c.noFaceSince = 0;
    if (!c.firstFaceT) c.firstFaceT = t;
    c.presentMs += step;
    const o = { t: t, yaw: obs.yaw, pitch: obs.pitch, roll: obs.roll, eyeYaw: obs.eyeYaw, eyePitch: obs.eyePitch, blink: obs.blink, ear: obs.ear, faceWidth: obs.faceWidth };
    c.recent.push(o);
    while (c.recent.length && c.recent[0].t < t - 800) c.recent.shift();
    c.all.push(o);
    if (c.all.length > 240) c.all.shift();
    const steady = c.recent.length >= 3 &&
      U.mad(c.recent.map((s) => s.yaw)) < 2.5 && U.mad(c.recent.map((s) => s.pitch)) < 2.5;
    run.steady = steady;
    if (steady) { c.steadyMs += step; c.steadySamples.push(o); }
    run.progress = U.clamp01(c.steadyMs / 1500);
    if (c.steadyMs >= 1500) {
      finishCenter(run, t, c.steadySamples, t - c.firstFaceT > 3000 ? 0.7 : 1);
    } else if (c.presentMs >= 8000) {
      // Never steady: accept anyway, with steadiness quality scaled by 0.7.
      finishCenter(run, t, c.steadySamples.length >= 8 ? c.steadySamples : c.all.slice(-60), 0.7);
    }
  }

  function finishCenter(run, t, S, steadiness) {
    run.base = baseFrom(S);
    run.noise = { yaw: U.mad(S.map((s) => s.yaw)), pitch: U.mad(S.map((s) => s.pitch)) };
    run.steadiness = steadiness;
    run.progress = 1;
    run.points[0].state = 'done';
    emitCal(run, 'point-done');
    if (run.kind === 'full' && !run.skipped) startCorner(run, 1, t);
    else finalizeCal(run, t);
  }

  function startCorner(run, i, t) {
    run.index = i;
    run.points[i].state = 'active';
    run.progress = 0;
    run.steady = false;
    run.corner = { name: run.points[i].name, t0: t, settleEnd: t + 700, win: [], firstT: 0 };
    emitCal(run, 'point');
  }

  function cornerValid(name, gy, gp) {
    switch (name) {
      case 'TL': return gy > 3 && gp < -1.5;
      case 'TR': return gy < -3 && gp < -1.5;
      case 'BR': return gy < -3 && gp > 1.5;
      case 'BL': return gy > 3 && gp > 1.5;
      default: return false;
    }
  }

  function cornerStep(run, obs, t) {
    const c = run.corner;
    if (!c) return;
    if (t - c.settleEnd >= 5000) { finishCorner(run, t, null); return; }   // timeout: invalid, move on
    if (t < c.settleEnd) { run.progress = 0; run.steady = false; return; }  // the eyes are travelling
    if (!obs.present) return;
    const b = run.base;
    const gYaw = (obs.yaw - b.yaw) + (obs.eyeYaw - b.eyeYaw);
    const gPitch = (obs.pitch - b.pitch) + (obs.eyePitch - b.eyePitch);
    if (!c.firstT) c.firstT = t;
    c.win.push({ t: t, gYaw: gYaw, gPitch: gPitch });
    while (c.win.length && c.win[0].t < t - 900) c.win.shift();
    const mY = U.median(c.win.map((s) => s.gYaw)), mP = U.median(c.win.map((s) => s.gPitch));
    const valid = cornerValid(c.name, mY, mP);
    // SPEC-GAP: "done" also requires the 900 ms window to have filled once, so `progress` (the fill) reaches 1.
    const fill = U.clamp01((t - c.firstT) / 900);
    let pass = 0;
    for (let i = 0; i < c.win.length; i++) if (cornerValid(c.name, c.win[i].gYaw, c.win[i].gPitch)) pass++;
    run.steady = valid;
    run.progress = valid ? fill : fill * Math.min(0.5, pass / c.win.length);
    if (valid && fill >= 1 && c.win.length >= 5) finishCorner(run, t, { gYaw: mY, gPitch: mP });
  }

  function finishCorner(run, t, result) {
    const c = run.corner;
    if (!c) return;
    if (result) { run.corners[c.name] = result; run.validCorners++; run.progress = 1; }
    run.points[run.index].state = 'done';
    run.corner = null;
    emitCal(run, 'point-done', { valid: !!result });
    if (run.skipped || run.index >= run.points.length - 1) finalizeCal(run, t);
    else startCorner(run, run.index + 1, t);
  }

  function computeBox(K) {
    const side = (vals, lo, hi, def) => {
      const v = vals.filter((x) => x != null && isFinite(x));
      return v.length ? U.clamp(1.15 * Math.max.apply(null, v), lo, hi) : def;
    };
    const g = (n, k) => (K[n] ? K[n][k] : null);
    return {
      left: side([g('TL', 'gYaw'), g('BL', 'gYaw')], 8, 45, DEFAULT_BOX.left),
      right: side([neg(g('TR', 'gYaw')), neg(g('BR', 'gYaw'))], 8, 45, DEFAULT_BOX.right),
      up: side([neg(g('TL', 'gPitch')), neg(g('TR', 'gPitch'))], 6, 40, DEFAULT_BOX.up),
      down: side([g('BL', 'gPitch'), g('BR', 'gPitch')], 8, 45, DEFAULT_BOX.down),
    };
  }

  function runningQuality(run, t) {
    const fw = run.fwRecent.length ? U.median(run.fwRecent) : 0;
    let st = run.steadiness;
    if (run.index === 0) st = run.center.firstFaceT && t - run.center.firstFaceT > 3000 ? 0.7 : 1;
    let corner = 1;
    if (run.kind === 'full' && !run.skipped && run.index > 0) {
      corner = (run.validCorners + (run.points.length - run.index)) / 4;   // pending corners count as hopeful
    }
    return U.clamp01(0.4 * U.smoothstep(0.08, 0.2, fw) + 0.3 * st + 0.3 * corner);
  }

  function finalizeCal(run, t) {
    const prev = run.prevCal;
    let kind, box, cornerTerm, zones = [];
    if (run.kind === 'full') {
      box = computeBox(run.corners);
      // SPEC-GAP: a full calibration that ends with no valid corner (all skipped or timed out) is saved
      // as kind 'center' (default box). Skipping every corner scores the corner term like 'center'.
      kind = run.validCorners > 0 ? 'full' : 'center';
      cornerTerm = run.skipped && run.validCorners === 0 ? 1 : run.validCorners / 4;
    } else if (run.kind === 'quick') {
      box = prev && prev.box ? Object.assign({}, prev.box) : Object.assign({}, DEFAULT_BOX);
      kind = prev && prev.kind ? prev.kind : 'center';
      zones = prev && Array.isArray(prev.zones) ? prev.zones.slice() : [];
      cornerTerm = 1;
    } else {
      box = Object.assign({}, DEFAULT_BOX);
      kind = 'center';
      cornerTerm = 1;
    }
    const quality = U.clamp01(0.4 * U.smoothstep(0.08, 0.2, run.base.faceWidth) + 0.3 * run.steadiness + 0.3 * cornerTerm);
    const cal = {
      v: 1, at: Date.now(), kind: kind,
      deviceId: source === 'sim' ? null : camId || null,
      label: source === 'sim' ? 'Simulated camera' : camLabel || '',
      base: run.base, noise: run.noise, box: box, quality: quality, zones: zones,
    };
    if (source === 'sim') simCal = cal;
    else { calibration = cal; FT.store.set('calibration', cal); }

    calRun = null;
    F = 0.8;
    resetMotionTimers();
    setState('focused', null, REASON.focused, t, null);
    run.quality = quality;
    run.progress = 1;
    run.hint = null;
    emitCal(run, 'done', { calibration: cal });
    run.resolve(cal);
  }

  function failCal(run) {
    endCal(run, 'failed', mkErr('CalibrationFailed', "Couldn't find your face"), { message: "Couldn't find your face" });
  }

  /** Ends a run without saving: the previous calibration stays in effect (it was never replaced). */
  function endCal(run, phase, err, extra) {
    if (calRun === run) calRun = null;
    emitCal(run, phase, extra);
    leaveCalibratingState();
    run.reject(err);
  }

  function leaveCalibratingState() {
    if (curState !== 'calibrating') return;
    const t = performance.now();
    resetMotionTimers();
    const ur = unseenReason();
    if (ur) setState('unseen', null, REASON[ur], t, null);
    else if (F >= F_ENTER) setState('focused', null, REASON.focused, t, null);
    else setState('drifting', null, REASON.drifting, t, null);
  }

  function cancelCalibration() {
    if (calRun) endCal(calRun, 'cancelled', mkErr('CalibrationCancelled'));
  }

  function skipCorners() {
    const run = calRun;
    if (!run || run.kind !== 'full') return;
    run.skipped = true;
    if (run.index > 0) {                                  // a corner is in progress: finish now
      if (run.points[run.index].state === 'active') run.points[run.index].state = 'pending';
      run.corner = null;
      finalizeCal(run, performance.now());
    }
    // Otherwise finishCenter() finalises right after the center point.
  }

  function updateHints(run, t) {
    let hint = null;
    if (t - run.lastFaceT > 3000) hint = 'noface';
    else if (run.fwRecent.length && U.median(run.fwRecent) < 0.10) hint = 'closer';
    else {
      if (source === 'camera' && t - run.lastLuma >= 2000) {
        run.lastLuma = t;
        const l = measureLuma();
        if (l != null) run.dark = l < 0.18;
      }
      if (run.dark) hint = 'light';
    }
    run.hint = hint;
  }

  /** Mean luma (0..1) of the camera frame on a 32×24 canvas (light hint). */
  function measureLuma() {
    try {
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      if (!lumaCanvas) {
        lumaCanvas = document.createElement('canvas');
        lumaCanvas.width = 32; lumaCanvas.height = 24;
        lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!lumaCtx) return null;
      lumaCtx.drawImage(video, 0, 0, 32, 24);
      const d = lumaCtx.getImageData(0, 0, 32, 24).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return s / (d.length / 4) / 255;
    } catch (e) {
      return null;
    }
  }

  function getCalibration() {
    const c = activeCal();
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }
  function hasCalibration() { return !!activeCal(); }
  function forgetCalibration() {
    FT.store.remove('calibration');
    calibration = null;
    if (source === 'sim') simCal = null;
    resetDefaultBase();                                    // the default base re-measures from now
  }

  /* =================================================================== *
   * 14. Preview drawing (§5.9) — Eye and framing canvases                *
   * =================================================================== */
  function addPreview(cv) { if (cv && typeof cv.getContext === 'function') previews.add(cv); }
  function removePreview(cv) {
    if (!cv || !previews.has(cv)) return;
    previews.delete(cv);
    clearCanvas(cv);
  }
  function setPreviewMode(mode) { return setOptions({ previewMode: mode }); }

  function ctxFor(cv) {
    let c = ctxCache.get(cv);
    if (!c) {
      try { c = cv.getContext('2d', { willReadFrequently: true }); } catch (e) { c = null; }
      if (!c) { try { c = cv.getContext('2d'); } catch (e) { c = null; } }
      if (c) ctxCache.set(cv, c);
    }
    return c;
  }
  function clearCanvas(cv) {
    const c = ctxFor(cv);
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
  }
  function clearPreviews() { previews.forEach(clearCanvas); }

  function drawPreviews(obs, pts) {
    if (!previews.size) return;
    const mode = options.previewMode;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    previews.forEach((cv) => {
      const cw = cv.clientWidth;
      if (!(cw > 0)) return;
      const ch = cv.clientHeight || cw;
      const W = Math.max(1, Math.round(cw * dpr)), H = Math.max(1, Math.round(ch * dpr));
      if (cv.width !== W) cv.width = W;
      if (cv.height !== H) cv.height = H;
      const ctx = ctxFor(cv);
      if (!ctx) return;
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        if (mode === 'off') { ctx.clearRect(0, 0, W, H); return; }
        if (source === 'sim') drawSimFace(ctx, W, H, dpr, obs, mode);
        else if (mode === 'video') drawVideoPreview(ctx, W, H, dpr, pts);
        else drawMeshPreview(ctx, W, H, dpr, pts);
      } catch (e) { /* a preview must never break detection */ }
    });
  }

  function drawFaintRing(ctx, W, H, dpr) {
    ctx.strokeStyle = 'rgba(124,245,208,.18)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.3, 0, TAU);
    ctx.stroke();
  }

  /** Dots for every landmark (mirrored), mapped by `map(xNorm, yNorm) -> [X, Y]`, plus the iris centres. */
  function drawDots(ctx, dpr, pts, alpha, map) {
    const n = (pts.length / 3) | 0;
    const r = 0.9 * dpr, ri = 1.8 * dpr;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(124,245,208,.85)';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p = map(pts[i * 3], pts[i * 3 + 1]);
      ctx.moveTo(p[0] + r, p[1]);
      ctx.arc(p[0], p[1], r, 0, TAU);
    }
    ctx.fill();
    if (n >= 478) {
      ctx.fillStyle = '#EFFFF8';
      ctx.beginPath();
      [468, 473].forEach((i) => {
        const p = map(pts[i * 3], pts[i * 3 + 1]);
        ctx.moveTo(p[0] + ri, p[1]);
        ctx.arc(p[0], p[1], ri, 0, TAU);
      });
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawMeshPreview(ctx, W, H, dpr, pts) {
    ctx.fillStyle = PREVIEW_BG;
    ctx.fillRect(0, 0, W, H);
    if (!pts) { drawFaintRing(ctx, W, H, dpr); return; }
    // Fit the (aspect-correct, mirrored) landmark bounding box to 78% of the canvas, centred.
    const ar = videoAspect(), n = (pts.length / 3) | 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = (1 - pts[i * 3]) * ar, y = pts[i * 3 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const bw = maxX - minX, bh = maxY - minY;
    const s = (0.78 * Math.min(W, H)) / Math.max(bw, bh, 1e-6);
    const ox = W / 2 - (minX + bw / 2) * s, oy = H / 2 - (minY + bh / 2) * s;
    drawDots(ctx, dpr, pts, 1, (x, y) => [ox + (1 - x) * ar * s, oy + y * s]);
  }

  function drawVideoPreview(ctx, W, H, dpr, pts) {
    ctx.fillStyle = PREVIEW_BG;
    ctx.fillRect(0, 0, W, H);
    if (!video || video.readyState < 2 || !video.videoWidth) { drawFaintRing(ctx, W, H, dpr); return; }
    const vw = video.videoWidth, vh = video.videoHeight, ca = W / H;
    // Cover crop with the canvas aspect, centred on the face (or the frame centre).
    let sw = vw, sh = vw / ca;
    if (sh > vh) { sh = vh; sw = vh * ca; }
    let fx = vw / 2, fy = vh / 2;
    if (pts) {
      const n = (pts.length / 3) | 0;
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      for (let i = 0; i < n; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      fx = ((minX + maxX) / 2) * vw; fy = ((minY + maxY) / 2) * vh;
    }
    const sx = U.clamp(fx - sw / 2, 0, vw - sw), sy = U.clamp(fy - sh / 2, 0, vh - sh);
    const canPosterize = posterizeOk && W * H <= 48000;   // cheap at <= ~200 px
    const useFilter = !canPosterize && 'filter' in ctx;
    ctx.save();
    if (useFilter) ctx.filter = 'grayscale(1) contrast(1.2)';
    ctx.translate(W, 0);
    ctx.scale(-1, 1);                                      // mirror in code (x' = 1 - x)
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
    ctx.restore();
    if (useFilter) ctx.filter = 'none';
    if (canPosterize) posterize(ctx, W, H);
    if (pts) drawDots(ctx, dpr, pts, 0.35, (x, y) => [W - ((x * vw - sx) / sw) * W, ((y * vh - sy) / sh) * H]);
  }

  /** 3-tone posterisation by luma thresholds .33 / .66, after a gentle auto-level for dim rooms. */
  function posterize(ctx, W, H) {
    try {
      const img = ctx.getImageData(0, 0, W, H), d = img.data;
      let lo = 255, hi = 0;
      for (let i = 0; i < d.length; i += 16) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (l < lo) lo = l; if (l > hi) hi = l;
      }
      const span = Math.max(48, hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] - lo) / span;
        const c = l < 0.33 ? TONES[0] : l < 0.66 ? TONES[1] : TONES[2];
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    } catch (e) {
      posterizeOk = false;                                 // fall back to the grayscale filter from now on
    }
  }

  /** Sim preview (SHOULD): a stylised face of dots that moves with the simulated head and eyes. */
  function drawSimFace(ctx, W, H, dpr, obs, mode) {
    ctx.fillStyle = PREVIEW_BG;
    ctx.fillRect(0, 0, W, H);
    if (!obs || !obs.present) { drawFaintRing(ctx, W, H, dpr); return; }
    const S = Math.min(W, H);
    const yaw = U.clamp(obs.yaw, -60, 60) / DEG, pitch = U.clamp(obs.pitch - 12, -45, 45) / DEG;
    const eyeYaw = U.clamp(obs.eyeYaw, -40, 40), eyePitch = U.clamp(obs.eyePitch, -30, 30);
    // Mirrored: turning to the user's left (yaw +) moves the face toward the canvas left.
    const ox = W / 2 - Math.sin(yaw) * S * 0.07, oy = H / 2 + Math.sin(pitch) * S * 0.05;
    const fx = W / 2 - Math.sin(yaw) * S * 0.19, fy = H / 2 + Math.sin(pitch) * S * 0.17;
    const hr = S * 0.26 * (0.86 + 0.14 * Math.cos(yaw)), vr = S * 0.33;
    const dot = Math.max(1, S / 70);
    if (mode === 'video') {                                // "posterised" silhouette under the dots
      ctx.fillStyle = 'rgba(79,168,147,.28)';
      ctx.beginPath(); ctx.ellipse(ox, oy, hr, vr, 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = 'rgba(124,245,208,.85)';
    ctx.beginPath();
    for (let i = 0; i < 36; i++) {                         // outline: 36 dots
      const a = (i / 36) * TAU;
      const x = ox + Math.cos(a) * hr, y = oy + Math.sin(a) * vr;
      ctx.moveTo(x + dot, y); ctx.arc(x, y, dot, 0, TAU);
    }
    const open = 1 - U.clamp01((obs.blink - 0.08) / 0.84);
    const eyeW = S * 0.052 * (0.8 + 0.2 * Math.cos(yaw)), eyeH = S * 0.028 * open;
    const eyeDX = S * 0.105 * Math.cos(yaw), eyeY = fy - S * 0.06;
    const eyes = [fx - eyeDX, fx + eyeDX];
    eyes.forEach((ex) => {                                 // two eyes of 8 dots, flattened when closed
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const x = ex + Math.cos(a) * eyeW, y = eyeY + Math.sin(a) * eyeH;
        ctx.moveTo(x + dot, y); ctx.arc(x, y, dot, 0, TAU);
      }
    });
    const nx = fx, ny = fy + S * 0.05;                     // nose
    ctx.moveTo(nx + dot * 1.2, ny); ctx.arc(nx, ny, dot * 1.2, 0, TAU);
    const mouthOpen = S * 0.012 + S * 0.07 * U.clamp01((obs.jawOpen - 0.05) / 0.7);
    for (let i = 0; i < 6; i++) {                          // a small mouth that opens for yawns
      const a = (i / 6) * TAU;
      const x = fx + Math.cos(a) * S * 0.045, y = fy + S * 0.15 + Math.sin(a) * mouthOpen * 0.5;
      ctx.moveTo(x + dot * 0.8, y); ctx.arc(x, y, dot * 0.8, 0, TAU);
    }
    ctx.fill();
    if (open > 0.3) {                                      // pupils follow the simulated eye gaze (mirrored)
      ctx.fillStyle = '#EFFFF8';
      ctx.beginPath();
      eyes.forEach((ex) => {
        const px = ex - (eyeYaw / 30) * eyeW * 0.6, py = eyeY + (eyePitch / 25) * eyeH * 0.6;
        ctx.moveTo(px + dot * 1.6, py); ctx.arc(px, py, dot * 1.6, 0, TAU);
      });
      ctx.fill();
    }
  }

  /* =================================================================== *
   * 15. Simulation source (§5.10) — demo mode and test harness           *
   *     Produces RawObservations that run through the exact same         *
   *     pipeline (gaze, eyes, F, state machine, calibration) as camera   *
   *     results.                                                         *
   * =================================================================== */
  const SIM_WEIGHTS = [['drift', 20], ['glance', 20], ['turn', 15], ['phone', 20], ['closed', 10], ['absent', 10], ['drowsy', 5]];
  const SIM_DUR = {
    focus: [40000, 120000], drift: [6000, 10000], glance: [2500, 4000], turn: [4000, 12000],
    phone: [6000, 18000], closed: [3000, 14000], absent: [12000, 45000], drowsy: [45000, 45000],
  };
  // SPEC-GAP: a manually chosen "Leave" lasts 32–45 s (inside the 12–45 s range) so the 30 s auto-pause
  // is always demonstrable.
  const SIM_DUR_MANUAL_ABSENT = [32000, 45000];
  const SIM_BASE = { yaw: 0, pitch: 12, eyeYaw: 0, eyePitch: 0, blink: 0.08, jawOpen: 0.05, faceWidth: 0.22 };
  const uni = (rng, r) => r[0] + (r[1] - r[0]) * rng();

  function simCreate(now) {
    const seed = (+U.param('seed')) || Date.now();
    const rng = U.rng(seed);
    return {
      rng: rng, auto: true, kind: 'focus', start: now, end: now + uni(rng, SIM_DUR.focus), side: 1, spare: null,
      e: { yaw: 0, pitch: 0, eyeYaw: 0, eyePitch: 0, jaw: 0, read: 1, micro: 1 },   // eased channels
      lastT: now, blinkUntil: 0, nextBlink: now + uni(rng, [900, 2500]),
      dr: null, leaveAt: 0, closeAt: 0, yawnAt: 0, yawnUntil: 0, closureUntil: 0, nextClosure: 0,
    };
  }

  /** Box–Muller on the seeded rng. */
  function gauss(s) {
    if (s.spare != null) { const v = s.spare; s.spare = null; return v; }
    let u = 0;
    while (u <= 1e-12) u = s.rng();
    const v = s.rng();
    const m = Math.sqrt(-2 * Math.log(u));
    s.spare = m * Math.sin(TAU * v);
    return m * Math.cos(TAU * v);
  }

  function simEnter(kind, now, manual) {
    const s = sim, r = s.rng;
    const prev = s.kind;
    s.kind = kind;
    s.start = now;
    if (manual && kind === 'focus') s.end = Infinity;     // a chosen "Focus" stays until the next choice
    else s.end = now + uni(r, manual && kind === 'absent' ? SIM_DUR_MANUAL_ABSENT : SIM_DUR[kind]);
    s.side = r() < 0.5 ? -1 : 1;                           // +1 = toward the user's left (screen-left)
    s.dr = null;
    if (kind === 'absent') s.leaveAt = now + 400;          // settle back to centre, then leave
    // Settle back to centre, then close: the last open-eyed sample (processObservation's eyeRef) must look
    // at the screen, or a closure right after 'phone' keeps the eyes' downward angles and reads as away/down.
    if (kind === 'closed' && prev !== 'closed') s.closeAt = now + 400;
    if (kind === 'drowsy') {
      s.yawnAt = now + uni(r, [5000, 9000]);
      s.yawnUntil = s.yawnAt + 2000;
      s.nextClosure = now + uni(r, [2500, 5000]);
      s.closureUntil = 0;
      s.nextBlink = Math.max(now + 400, Math.min(s.nextBlink, now + uni(r, [600, 1500])));
    }
  }

  function simNext(now) {
    const s = sim;
    if (!s.auto) { simEnter('focus', now, true); return; }   // manual: settle into focus and stay
    if (s.kind !== 'focus') { simEnter('focus', now, false); return; }
    let total = 0;
    for (let i = 0; i < SIM_WEIGHTS.length; i++) total += SIM_WEIGHTS[i][1];
    let pick = s.rng() * total, kind = SIM_WEIGHTS[0][0];
    for (let i = 0; i < SIM_WEIGHTS.length; i++) {
      pick -= SIM_WEIGHTS[i][1];
      if (pick < 0) { kind = SIM_WEIGHTS[i][0]; break; }
    }
    simEnter(kind, now, false);
  }

  function simulate(kind) {
    if (source !== 'sim' || !sim) return;
    const now = performance.now();
    if (kind === 'auto') {
      sim.auto = true;
      if (!isFinite(sim.end)) sim.end = now + uni(sim.rng, SIM_DUR.focus);
      return;
    }
    if (!SIM_DUR[kind]) return;
    sim.auto = false;
    simEnter(kind, now, true);
  }

  /**
   * Drift: attention hovers near one edge (gazeNorm 0.85–0.92) with quick eye-only excursions just past
   * it (1.14–1.24 for 450–650 ms, always shorter than every glance grace and followed by a dip below the
   * 0.95 exit hysteresis). SPEC-GAP: the spec's 0.85–0.98 alone keeps a >= 0.68, so F could never fall
   * below 0.55; the sub-grace excursions make F sink and the state become 'drifting' without ever 'away'.
   * Returns the eyeYaw that puts the combined gaze exactly there, compensating the head's micro-motion.
   */
  function simDriftEyeYaw(now, yawNow) {
    const s = sim, r = s.rng;
    if (!s.dr || now >= s.dr.until) {
      const first = !s.dr;
      if (first || s.dr.mode === 'out') s.dr = { mode: 'dwell', until: now + (first ? uni(r, [900, 1400]) : uni(r, [250, 420])), g: uni(r, [0.85, 0.92]) };
      else s.dr = { mode: 'out', until: now + uni(r, [450, 650]), g: uni(r, [1.14, 1.24]) };
    }
    const base = currentBase(), box = currentBox(), k = sens().k;
    const span = (s.side > 0 ? box.left : box.right) * k;
    const gYaw = s.side * s.dr.g * span;
    return base.eyeYaw + gYaw - (yawNow - base.yaw);
  }

  function simObserve(now) {
    const s = sim, r = s.rng;
    const dt = U.clamp(now - s.lastT, 0, 250);
    s.lastT = now;
    if (!calRun && now >= s.end) simNext(now);

    const T = { yaw: 0, pitch: 0, eyeYaw: 0, eyePitch: 0, jaw: 0, read: 1, micro: 1 };
    let tau = 117;                                         // ~95% of a transition in 350 ms
    let present = true, drowsyBlinks = false, hold = null, heavy = 0;
    const kind = calRun ? 'cal' : s.kind;
    switch (kind) {
      case 'cal': {                                        // look at the active seed: 60% head, 40% eyes
        const p = calRun.points[calRun.index] || calRun.points[0];
        const gY = (0.5 - p.x) * 28, gP = (p.y - 0.5) * 20;
        T.yaw = 0.6 * gY; T.eyeYaw = 0.4 * gY; T.pitch = 0.6 * gP; T.eyePitch = 0.4 * gP;
        T.read = 0; tau = 133;                             // eases there over ~400 ms
        break;
      }
      case 'drift': T.read = 0; T.micro = 0.35; tau = 60; break;
      case 'glance': T.eyeYaw = s.side * 24; T.read = 0; break;
      case 'turn': T.yaw = s.side * 32; T.eyeYaw = s.side * 8; T.read = 0; break;
      case 'phone': T.pitch = 26; T.eyePitch = 12; T.read = 0.4; break;
      case 'closed':                                       // close only once the eyes are back on the screen
        if (now >= s.closeAt && Math.abs(s.e.eyePitch) < 1.5 && Math.abs(s.e.eyeYaw) < 3) hold = 0.96;
        T.read = 0; T.micro = 0.6;
        break;
      case 'absent': T.read = 0; if (now >= s.leaveAt) present = false; break;
      case 'drowsy':
        drowsyBlinks = true; heavy = 0.1; T.pitch = 2.5; T.micro = 0.7; T.read = 0.4;
        if (now >= s.yawnAt && now < s.yawnUntil) T.jaw = 0.7;
        break;
      default: break;                                      // focus: micro-motion and reading only
    }

    const e = s.e;
    e.yaw = U.damp(e.yaw, T.yaw, tau, dt);
    e.pitch = U.damp(e.pitch, T.pitch, tau, dt);
    e.eyePitch = U.damp(e.eyePitch, T.eyePitch, tau, dt);
    e.jaw = U.damp(e.jaw, T.jaw, 90, dt);
    e.read = U.damp(e.read, T.read, tau, dt);
    e.micro = U.damp(e.micro, T.micro, 300, dt);

    // Micro-motion, always applied.
    const microYaw = e.micro * (1.5 * Math.sin((TAU * now) / 4100) + 0.4 * gauss(s));
    const microPitch = e.micro * (1.0 * Math.sin((TAU * now) / 5300));
    const yaw = SIM_BASE.yaw + e.yaw + microYaw;
    const pitch = SIM_BASE.pitch + e.pitch + microPitch;
    if (kind === 'drift') T.eyeYaw = simDriftEyeYaw(now, yaw);
    e.eyeYaw = U.damp(e.eyeYaw, T.eyeYaw, tau, dt);
    // Reading: the eyes sweep screen-left -> screen-right (eyeYaw +6 -> -6) over ~2.75 s, then snap back.
    const ph = (now % 3000) / 3000;
    const saw = ph < 0.92 ? 6 - 12 * (ph / 0.92) : -6 + 12 * ((ph - 0.92) / 0.08);
    const eyeYaw = SIM_BASE.eyeYaw + e.eyeYaw + e.read * saw;
    const eyePitch = SIM_BASE.eyePitch + e.eyePitch;

    // Blinks: 120–220 ms every 3–5.5 s; drowsy: 500–900 ms every 1.5–3 s, plus longer closures.
    if (now >= s.nextBlink && now >= s.blinkUntil) {
      s.blinkUntil = now + (drowsyBlinks ? uni(r, [500, 900]) : uni(r, [120, 220]));
      s.nextBlink = now + (drowsyBlinks ? uni(r, [1500, 3000]) : uni(r, [3000, 5500]));
    }
    let blink = SIM_BASE.blink + heavy + 0.012 * gauss(s);
    if (now < s.blinkUntil) blink = 0.95;
    if (kind === 'drowsy') {
      if (now >= s.nextClosure && now >= s.closureUntil) {
        s.closureUntil = now + uni(r, [1400, 2200]);
        s.nextClosure = s.closureUntil + uni(r, [4500, 7000]);
      }
      if (now < s.closureUntil) blink = 0.95;
    }
    if (hold != null) blink = hold;
    blink = U.clamp01(blink);

    return {
      present: present, faces: present ? 1 : 0,
      yaw: yaw, pitch: pitch, roll: 0.8 * Math.sin((TAU * now) / 7300), poseSource: 'matrix',
      eyeYaw: eyeYaw, eyePitch: eyePitch, blink: blink,
      ear: 0.29 - 0.24 * U.clamp01((blink - 0.08) / 0.87),
      jawOpen: U.clamp01(SIM_BASE.jawOpen + e.jaw),
      faceWidth: SIM_BASE.faceWidth + 0.004 * Math.sin((TAU * now) / 9100),
    };
  }

  function simTick(now) {
    if (!sim) sim = simCreate(now);
    const obs = simObserve(now);
    const inferMs = 0.25 + 0.3 * Math.random();
    noteInfer(inferMs, now);
    processObservation(obs, now, inferMs, null, false);
  }

  /* =================================================================== *
   * 16. Lifecycle: start / cancelStart / stop / dispose                  *
   * =================================================================== */
  function startResult() { return { source: source, delegate: delegate, engine: engineKind, status: status }; }

  /** Per-run tracking reset (calibration, F and the 60 s windows survive a restart). */
  function resetRunState() {
    lastSampleT = 0; hz = 0; tickCount = 0;
    divider = FT.env.coarse && FT.env.narrow() ? 2 : 1;
    inferEma = 0; lastInferT = 0; inferLowSince = 0; lastInferMs = 0;
    lastMediaTime = -1; stalledSince = 0; lastHeartbeat = 0;
    noFaceSince = 0; presentSince = 0; lastGaze = null;
    closed = false; closedSince = 0; eyesClosedMs = 0; eyeRef = null;
    jawHighSince = 0; yawnArmed = false;
    lowConfSince = 0;
    flags['low-confidence'] = false; flags.stalled = false; flags.recovering = false;
    workerBusy = false;
    resetMotionTimers();
    if (!activeCal()) resetDefaultBase();
  }

  function start(opts) {
    opts = opts || {};
    const src = opts.source === 'sim' ? 'sim' : 'camera';
    const devId = opts.deviceId !== undefined ? opts.deviceId || null : options.deviceId;

    if (startJob && !startJob.cancelled) {
      if (startJob.source === src) return startJob.promise;
      cancelStart();
    }
    if (isActive()) {
      const sameCamera = src === 'camera' && (devId || null) === (reqDeviceId || null);
      if (source === src && (src === 'sim' || sameCamera)) return Promise.resolve(startResult());
      stop();                                              // switching source (or camera)
    }

    const job = { seq: ++startSeq, source: src, cancelled: false, lost: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    startJob = job;
    source = src;
    recreations.length = 0;
    const run = src === 'sim' ? runSimStart(job) : runCameraStart(job, devId);
    run.then(() => {
      if (job.cancelled || startJob !== job) return;
      startJob = null;
      job.resolve(startResult());
    }, (err) => {
      if (job.cancelled || startJob !== job) return;       // already rejected with 'Cancelled'
      startJob = null;
      failStart(job, err);
    });
    return job.promise;
  }

  async function runCameraStart(job, devId) {
    const cp = () => { if (job.cancelled) throw mkErr('Cancelled'); };
    delegate = null; engineKind = null;
    // DebugFail hook: ?debug=1&fail=<code> rejects with that code after 300 ms.
    const fail = FT.env.debug ? U.param('fail') : null;
    if (fail) {
      setStatus('starting', 'Simulated failure');
      await sleep(300);
      cp();
      throw mkErr(String(fail), (MESSAGES[fail] || String(fail)) + ' (simulated with ?fail=)');
    }
    const c = check('camera');
    if (!c.ok) throw mkErr(c.code);

    // 1. Camera first, so the permission prompt appears promptly.
    setStatus('starting', 'Opening the camera');
    prog('camera', 0.01, null, null);
    await openCamera(job, devId);
    cp();

    // 2. Model (skipped when a landmarker already exists).
    await ensureEngine();
    cp();
    if (job.lost || !stream) throw mkErr('CameraFailed', 'The camera disconnected while starting.');
    activateEngine();
    if (!engineKind) throw mkErr('ModelInitFailed');
    prog('warmup', 1, null, null);

    // 3. Running. The next clock:tick runs the first detection.
    resetRunState();
    flags['camera-off'] = false;
    setStatus('running', engineKind === 'worker' ? 'Face tracking in a worker on this device' : 'Face tracking on this device');
  }

  async function runSimStart(job) {
    const cp = () => { if (job.cancelled) throw mkErr('Cancelled'); };
    delegate = 'SIM'; engineKind = null;
    camLabel = 'Simulated camera'; camId = null; reqDeviceId = null;
    setStatus('starting', 'Starting the simulation');
    prog('camera', 0.05, null, null);
    await sleep(120);
    cp();
    emitCamera(false, false);
    setStatus('loading', 'Simulated model');
    for (let i = 1; i <= 5; i++) {
      prog('model', 0.1 + (0.7 * i) / 5, Math.round((MODEL_BYTES * i) / 5), MODEL_BYTES);
      await sleep(90);
      cp();
    }
    setStatus('warming', 'Warming up');
    prog('warmup', 0.9, null, null);
    await sleep(150);
    cp();
    prog('warmup', 1, null, null);
    sim = simCreate(performance.now());
    resetRunState();
    flags['camera-off'] = false;
    setStatus('running', 'Simulated signals');
  }

  function failStart(job, err) {
    const e = err && err.code ? err : mkErr('CameraFailed', errText(err));
    const hadStream = !!stream;
    stopCamera();
    if (hadStream) emitCamera(false, false);
    flags['camera-off'] = true;
    source = null;
    if (e.code === 'Cancelled') {
      setStatus('stopped', 'Cancelled');
    } else {
      if (e.code !== 'ModelLoadFailed' && e.code !== 'ModelInitFailed' && CAMERA_ERRORS.indexOf(e.code) < 0 && !MESSAGES[e.code]) {
        console.warn(LOG, 'Start failed:', e.code, e.message);
      }
      setStatus('error', e.message);
      emit('detector:error', { code: e.code, message: e.message, recoverable: UNRECOVERABLE.indexOf(e.code) < 0, during: 'start' });
    }
    job.reject(e);
  }

  /** Aborts an in-flight start(): stops the camera and rejects it with code 'Cancelled'. */
  function cancelStart() {
    const job = startJob;
    if (!job || job.cancelled) return;
    job.cancelled = true;
    startJob = null;
    const hadStream = !!stream;
    stopCamera();
    if (hadStream) emitCamera(false, false);
    flags['camera-off'] = true;
    source = null;
    setStatus('stopped', 'Cancelled');
    job.reject(mkErr('Cancelled'));
  }

  /** Stops all tracks (the camera light goes off); keeps the landmarker/worker for reuse. */
  function stop() {
    if (startJob) cancelStart();
    if (calRun) endCal(calRun, 'cancelled', mkErr('CalibrationCancelled', 'The camera stopped.'));
    const wasActive = isActive();
    const hadStream = !!stream;
    const src = source;
    stopCamera();
    workerBusy = false;
    flags['camera-off'] = true;
    flags.recovering = false;
    flags['low-confidence'] = false;
    if (wasActive || hadStream) {
      heartbeat(performance.now(), true);                  // state -> unseen (camera-off), plus a final sample
      if (src === 'sim') { camLabel = 'Simulated camera'; camId = null; }
      emitCamera(false, false);
      sim = null;
      source = null;
      setStatus('stopped', 'Camera off');
    } else {
      sim = null;
      source = null;
      if (curState !== 'unseen') setState('unseen', null, REASON['camera-off'], performance.now(), null);
    }
    clearPreviews();
  }

  /** stop(), then close the landmarker and terminate any worker. */
  function dispose() {
    stop();
    if (lm) { closeQuietly(lm); lm = null; }
    terminateWorker();
    engineKind = null;
    delegate = null;
  }

  /* =================================================================== *
   * 17. init and the public API                                          *
   * =================================================================== */
  function init(cfg) {
    cfg = cfg || {};
    if (cfg.video) video = cfg.video;
    if (Array.isArray(cfg.previews)) cfg.previews.forEach(addPreview);
    if (inited) return;
    inited = true;
    FT.bus.on('clock:tick', onTick);
    document.addEventListener('visibilitychange', onVisibility);
    loadSavedCalibration();
  }

  FT.Detector = {
    init: init,
    check: check,
    start: start,
    cancelStart: cancelStart,
    stop: stop,
    dispose: dispose,
    setOptions: setOptions,
    getOptions: getOptions,
    addPreview: addPreview,
    removePreview: removePreview,
    setPreviewMode: setPreviewMode,
    calibrate: calibrate,
    skipCorners: skipCorners,
    cancelCalibration: cancelCalibration,
    getCalibration: getCalibration,
    hasCalibration: hasCalibration,
    forgetCalibration: forgetCalibration,
    simulate: simulate,
    listCameras: listCameras,
    get status() { return status; },
    get source() { return source; },
    get running() { return isActive(); },
    get delegate() { return delegate; },
    get engine() { return engineKind; },
    get sample() { return sample; },
    get state() { return curState; },
    get cause() { return curCause; },
    get calibrating() { return !!calRun; },
    get hz() { return hz; },
    // Optional extras (debug panel / harness).
    get inferMs() { return lastInferMs; },
    get divider() { return divider; },
    get simScenario() { return sim ? (calRun ? 'calibration' : sim.kind) : null; },
    get simAuto() { return sim ? sim.auto : null; },
  };
})();

