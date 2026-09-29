/*!
 * Hypha — js/visual.js  (SPEC.md §4.5, §6)
 * FT.Organism: the deterministic growth model (space colonisation, seeded).
 * FT.Visual:   the living dish on #stage — layers, frame pipeline, pulses, scars, the Fruiting,
 *              specimen regrowth for jars and keepsakes.
 * Classic script (defer). Never touches the DOM except the canvases handed to it.
 * Determinism: FT.Organism and drawSpecimen never read Math.random, Date or performance.
 */
(function () {
  'use strict';
  const FT = window.FT, U = FT.util;

  const TAU = Math.PI * 2, DEG = Math.PI / 180;
  const LOG = '[Hypha:visual]';
  const RGB = {};
  for (const k in FT.PALETTE) RGB[k] = U.hexToRgb(FT.PALETTE[k]);
  const WHITE = [255, 255, 255];
  const clamp01 = U.clamp01, lerp = U.lerp, smoothstep = U.smoothstep, mix = U.mixRgb;
  const rgbaStr = (c, a) => U.rgba(c, a);
  const rgbStr = (c) => 'rgb(' + ((c[0] + 0.5) | 0) + ',' + ((c[1] + 0.5) | 0) + ',' + ((c[2] + 0.5) | 0) + ')';
  const easeOut = (t) => { t = clamp01(t); const u = 1 - t; return 1 - u * u * u; };
  const easeInOut = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  /** The only overshoot in the app (§6.8 cap unfurl). */
  const easeOutBack = (t) => { t = clamp01(t); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const fin = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function ctx2d(c) { return c.getContext('2d'); }

  /* ------------------------------------------------------------------ *
   * Sprites: soft radial dots, pre-rendered once per colour (lazy).      *
   * ------------------------------------------------------------------ */
  const SPRITE = 32;
  const spriteCache = new Map();
  function getSprite(rgb) {
    const key = ((rgb[0] + 0.5) | 0) + ',' + ((rgb[1] + 0.5) | 0) + ',' + ((rgb[2] + 0.5) | 0);
    let c = spriteCache.get(key);
    if (c) return c;
    if (spriteCache.size > 96) spriteCache.delete(spriteCache.keys().next().value); // safety bound
    c = mkCanvas(SPRITE, SPRITE);
    const g = ctx2d(c), h = SPRITE / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, rgbaStr(mix(rgb, WHITE, 0.55), 1));
    grad.addColorStop(0.16, rgbaStr(rgb, 0.85));
    grad.addColorStop(0.42, rgbaStr(rgb, 0.24));
    grad.addColorStop(0.7, rgbaStr(rgb, 0.06));
    grad.addColorStop(1, rgbaStr(rgb, 0));
    g.fillStyle = grad; g.fillRect(0, 0, SPRITE, SPRITE);
    spriteCache.set(key, c);
    return c;
  }
  /** Gold -> core ramp (4 steps) for spores that fade toward white. */
  const RAMPS = [];
  function ramp(id, t) {
    if (!RAMPS.length) {
      const pairs = [[RGB.gold, RGB.core], [RGB.hypha, RGB.core], [RGB.gold, RGB.gold], [RGB.core, RGB.core], [RGB.frost, RGB.core]];
      for (const p of pairs) RAMPS.push([0, 1, 2, 3].map((k) => getSprite(mix(p[0], p[1], k / 3))));
    }
    const r = RAMPS[id] || RAMPS[0];
    return r[Math.max(0, Math.min(3, Math.floor(clamp01(t) * 3.999)))];
  }

  /* Cheap 1-D value noise (decorative only). */
  function hash1(n) {
    let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    const a = hash1(i), b = hash1(i + 1);
    return a + (b - a) * u;
  }

  /* =================================================================== *
   * FT.Organism — deterministic space colonisation (§6.2)               *
   * =================================================================== */
  const ORG = {
    L: 0.016, DI: 0.14, DK: 0.03, RATE: 1.2, BUDGET_CAP: 8,
    NA: 1400, NC: 40, GAUSS: 0.3, SIGMA: 0.05,
    G: 25, CELL: 0.08,
    LINK_D: 0.022, LINK_MAX: 400, LINK_GEN: 12, LINK_COUSIN: 6,
    RETRACT_RUN: 4, RETRACT_AGE: 60, RETRACT_MAX: 2,
  };
  const DI2 = ORG.DI * ORG.DI, DK2 = ORG.DK * ORG.DK, LD2 = ORG.LINK_D * ORG.LINK_D;
  const GRID = ORG.G, NCELL = GRID * GRID;
  const gcell = (v) => { const c = Math.floor((v + 1) / ORG.CELL); return c < 0 ? 0 : c >= GRID ? GRID - 1 : c; };
  const AWAY_CH = 'TGDUX';
  const frontOf = (index, ref) => 0.07 + 0.91 * Math.sqrt(clamp01((index + 1) / ref));
  const validCode = (s) => (typeof s === 'string' && s.length === 1 && FT.CODES[s] ? s : 'N');
  const num01 = (v, d) => { v = +v; return isFinite(v) ? clamp01(v) : d; };

  function createOrganism(seed, opts) {
    opts = opts || {};
    seed = (+seed >>> 0);
    const ref = +opts.refActiveSec > 0 ? +opts.refActiveSec : 3000;
    const retract = !!opts.retract;
    const cap = Math.max(16, Math.min(20000, Math.floor(+opts.maxNodes || 6000)));
    const rng = U.rng(seed);
    const NA = ORG.NA, NC = ORG.NC, L = ORG.L;

    /* ---- Attractors (fixed rng call order: centres, then attractors, then theta0) ---- */
    const ccx = new Float64Array(NC), ccy = new Float64Array(NC);
    for (let k = 0; k < NC; k++) {
      const r = 0.1 + 0.85 * Math.sqrt(rng()), th = TAU * rng();
      ccx[k] = r * Math.cos(th); ccy[k] = r * Math.sin(th);
    }
    const nGauss = Math.round(NA * ORG.GAUSS);
    const rx = new Float64Array(NA), ry = new Float64Array(NA), rr = new Float64Array(NA);
    for (let i = 0; i < NA; i++) {
      let x, y;
      if (i < nGauss) {
        const k = Math.min(NC - 1, Math.floor(rng() * NC));
        const u1 = rng(), u2 = rng();
        const mag = Math.sqrt(-2 * Math.log(u1 > 1e-12 ? u1 : 1e-12)) * ORG.SIGMA;
        x = ccx[k] + mag * Math.cos(TAU * u2); y = ccy[k] + mag * Math.sin(TAU * u2);
      } else {
        const r = 0.04 + 0.96 * Math.sqrt(rng()), th = TAU * rng();
        x = r * Math.cos(th); y = r * Math.sin(th);
      }
      let r = Math.sqrt(x * x + y * y);
      if (r > 0.98) { x *= 0.98 / r; y *= 0.98 / r; r = 0.98; }
      rx[i] = x; ry[i] = y; rr[i] = r;
    }
    // Sorted by radius so "active = ar <= front" is a prefix (total order: radius, then index).
    const order = new Array(NA);
    for (let i = 0; i < NA; i++) order[i] = i;
    order.sort((a, b) => (rr[a] - rr[b]) || (a - b));
    const ax = new Float32Array(NA), ay = new Float32Array(NA), ar = new Float32Array(NA), dead = new Uint8Array(NA);
    for (let j = 0; j < NA; j++) { const i = order[j]; ax[j] = rx[i]; ay[j] = ry[i]; ar[j] = rr[i]; }
    // Attractor grid (CSR, static).
    const aStart = new Int32Array(NCELL + 1), aItems = new Int32Array(NA), aCell = new Int32Array(NA);
    for (let j = 0; j < NA; j++) { const c = gcell(ay[j]) * GRID + gcell(ax[j]); aCell[j] = c; aStart[c + 1]++; }
    for (let c = 0; c < NCELL; c++) aStart[c + 1] += aStart[c];
    const fillPos = aStart.slice(0, NCELL);
    for (let j = 0; j < NA; j++) aItems[fillPos[aCell[j]]++] = j;

    /* ---- Nodes ---- */
    const nx = new Float32Array(cap), ny = new Float32Array(cap);
    const parent = new Int32Array(cap), dist = new Float32Array(cap), born = new Int32Array(cap);
    const alive = new Uint8Array(cap), children = new Uint16Array(cap);
    const accX = new Float64Array(cap), accY = new Float64Array(cap), infl = new Uint16Array(cap);
    const nHead = new Int32Array(NCELL).fill(-1), nNext = new Int32Array(cap);
    // Incrementally maintained nearest alive node (within di) for every attractor.
    const near = new Int32Array(NA).fill(-1), nearD2 = new Float64Array(NA).fill(Infinity);
    const linkBuf = new Int32Array(ORG.LINK_MAX * 2);
    const ancBuf = new Int32Array(ORG.LINK_GEN);
    const cand = [];
    const removedLast = [];
    const nodes = { count: 0, x: nx, y: ny, parent: parent, dist: dist, born: born, alive: alive, children: children };
    const tl = { s: '', f: '', d: '', a: '' };
    let linkCount = 0, aliveCount = 0, maxDist = 0, budget = 0, dRun = 0;
    let analysis = null, anDirty = true;
    // Set once forgive() rewrites tl.s: the nodes were grown from the original codes, so the
    // timeline no longer describes this growth and a regrow from it would differ.
    let edited = false;

    function fullNearest(j) {
      const x = ax[j], y = ay[j], gx = gcell(x), gy = gcell(y);
      let best = -1, bd = Infinity;
      for (let cy = Math.max(0, gy - 2), cyE = Math.min(GRID - 1, gy + 2); cy <= cyE; cy++) {
        for (let cx = Math.max(0, gx - 2), cxE = Math.min(GRID - 1, gx + 2); cx <= cxE; cx++) {
          for (let i = nHead[cy * GRID + cx]; i >= 0; i = nNext[i]) {
            if (!alive[i]) continue;
            const dx = nx[i] - x, dy = ny[i] - y, d2 = dx * dx + dy * dy;
            if (d2 <= DI2 && (d2 < bd || (d2 === bd && i < best))) { bd = d2; best = i; }
          }
        }
      }
      near[j] = best; nearD2[j] = best >= 0 ? bd : Infinity;
    }

    function addNode(px, py, par, b) {
      const i = nodes.count;
      if (i >= cap) return -1;
      nx[i] = px; ny[i] = py;
      const x = nx[i], y = ny[i];
      parent[i] = par; born[i] = b; alive[i] = 1; children[i] = 0;
      dist[i] = par >= 0 ? dist[par] + L : 0;
      if (dist[i] > maxDist) maxDist = dist[i];
      if (par >= 0 && children[par] < 65535) children[par]++;
      const gx = gcell(x), gy = gcell(y), c = gy * GRID + gx;
      nNext[i] = nHead[c]; nHead[c] = i;
      nodes.count = i + 1; aliveCount++;
      // Kill attractors within dk; the new node may become the nearest for others within di.
      for (let cy = Math.max(0, gy - 2), cyE = Math.min(GRID - 1, gy + 2); cy <= cyE; cy++) {
        for (let cx = Math.max(0, gx - 2), cxE = Math.min(GRID - 1, gx + 2); cx <= cxE; cx++) {
          const cc = cy * GRID + cx;
          for (let k = aStart[cc], e = aStart[cc + 1]; k < e; k++) {
            const j = aItems[k];
            if (dead[j]) continue;
            const dx = ax[j] - x, dy = ay[j] - y, d2 = dx * dx + dy * dy;
            if (d2 <= DK2) { dead[j] = 1; continue; }
            if (d2 <= DI2 && d2 < nearD2[j]) { nearD2[j] = d2; near[j] = i; }
          }
        }
      }
      return i;
    }

    /** Anastomosis (SHOULD): fuse the new node with a close node of another branch. */
    function tryLink(i) {
      if (linkCount >= ORG.LINK_MAX) return;
      let na = 0;
      for (let p = parent[i]; p >= 0 && na < ORG.LINK_GEN; p = parent[p]) ancBuf[na++] = p;
      const x = nx[i], y = ny[i], gx = gcell(x), gy = gcell(y);
      let best = -1, bd = Infinity;
      for (let cy = Math.max(0, gy - 1), cyE = Math.min(GRID - 1, gy + 1); cy <= cyE; cy++) {
        for (let cx = Math.max(0, gx - 1), cxE = Math.min(GRID - 1, gx + 1); cx <= cxE; cx++) {
          for (let k = nHead[cy * GRID + cx]; k >= 0; k = nNext[k]) {
            if (k === i || !alive[k]) continue;
            const dx = nx[k] - x, dy = ny[k] - y, d2 = dx * dx + dy * dy;
            if (d2 > LD2 || d2 > bd || (d2 === bd && k > best)) continue;
            let related = false;
            for (let m = 0; m < na; m++) if (ancBuf[m] === k) { related = true; break; }
            // SPEC-GAP: also skip close cousins (a shared ancestor within 6 generations of both),
            // so links fuse genuinely separate branches instead of siblings.
            if (!related) {
              const nc = Math.min(na, ORG.LINK_COUSIN);
              let q = parent[k];
              for (let g = 0; q >= 0 && g < ORG.LINK_COUSIN && !related; g++, q = parent[q]) {
                for (let m = 0; m < nc; m++) if (ancBuf[m] === q) { related = true; break; }
              }
            }
            if (related) continue;
            best = k; bd = d2;
          }
        }
      }
      if (best >= 0) { linkBuf[linkCount * 2] = i; linkBuf[linkCount * 2 + 1] = best; linkCount++; }
    }

    /** One colonisation pass. Returns the number of nodes created. */
    function pass(front, index, dq) {
      let nc = 0;
      for (let j = 0; j < NA; j++) {
        if (ar[j] > front) break;
        if (dead[j]) continue;
        const n = near[j];
        if (n < 0) continue;
        const dx = ax[j] - nx[n], dy = ay[j] - ny[n], d = Math.sqrt(dx * dx + dy * dy);
        if (d > 1e-9) { accX[n] += dx / d; accY[n] += dy / d; }
        if (infl[n] === 0) cand[nc++] = n;
        if (infl[n] < 65535) infl[n]++;
      }
      let made = 0;
      if (nc > 0) {
        cand.length = nc;
        cand.sort((a, b) => (infl[b] - infl[a]) || (a - b));
        const toMake = Math.min(Math.floor(budget), nc, cap - nodes.count);
        for (let k = 0; k < toMake; k++) {
          const n = cand[k];
          let gx = accX[n], gy = accY[n], gl = Math.sqrt(gx * gx + gy * gy);
          if (gl > 1e-9) { gx /= gl; gy /= gl; } else { gx = 0; gy = 0; }
          const p = parent[n];
          if (p >= 0) {
            const hx = nx[n] - nx[p], hy = ny[n] - ny[p], hl = Math.sqrt(hx * hx + hy * hy);
            if (hl > 1e-9) { gx += 0.15 * hx / hl; gy += 0.15 * hy / hl; }
          }
          gl = Math.sqrt(gx * gx + gy * gy);
          if (gl < 1e-9) continue;
          const i = addNode(nx[n] + L * gx / gl, ny[n] + L * gy / gl, n, index);
          if (i < 0) break;
          made++;
          if (dq > 0.5) tryLink(i);
        }
        for (let k = 0; k < nc; k++) { const n = cand[k]; accX[n] = 0; accY[n] = 0; infl[n] = 0; }
        return made;
      }
      // Reach fallback: extend the newest alive leaf that is still inside the front.
      const lim = front - L;
      if (lim <= 0) return 0;
      const lim2 = lim * lim;
      let leaf = -1;
      for (let i = nodes.count - 1; i >= 1; i--) {
        if (!alive[i] || children[i] !== 0) continue;
        if (nx[i] * nx[i] + ny[i] * ny[i] < lim2) { leaf = i; break; }
      }
      if (leaf < 0) return 0;
      const p = parent[leaf];
      let hx = nx[leaf] - (p >= 0 ? nx[p] : 0), hy = ny[leaf] - (p >= 0 ? ny[p] : 0);
      const hl = Math.sqrt(hx * hx + hy * hy);
      if (hl > 1e-9) { hx /= hl; hy /= hl; } else { hx = 1; hy = 0; }
      const rot = (rng() - 0.5) * 0.6, c = Math.cos(rot), s = Math.sin(rot);
      const dx = hx * c - hy * s, dy = hx * s + hy * c;
      const i = addNode(nx[leaf] + L * dx, ny[leaf] + L * dy, leaf, index);
      if (i < 0) return 0;
      if (dq > 0.5) tryLink(i);
      return 1;
    }

    function retractLeaves(index) {
      const minBorn = index - ORG.RETRACT_AGE;
      let killed = 0;
      // SPEC-GAP: the root and the 5 seed arms (born -1, indices 0..5) never retract.
      for (let i = nodes.count - 1; i >= 6 && killed < ORG.RETRACT_MAX; i--) {
        if (born[i] < minBorn) break; // born is non-decreasing with the node index
        if (!alive[i] || children[i] !== 0) continue;
        alive[i] = 0; aliveCount--; killed++;
        removedLast.push(i);
        const p = parent[i];
        if (p >= 0 && children[p] > 0) children[p]--;
      }
      if (killed) {
        for (let j = 0; j < NA; j++) {
          const n = near[j];
          if (!dead[j] && n >= 0 && !alive[n]) fullNearest(j);
        }
      }
      return killed;
    }

    // Seed star: node 0 at the centre plus 5 arms (born -1).
    addNode(0, 0, -1, -1);
    const th0 = TAU * rng();
    for (let k = 0; k < 5; k++) {
      const a = th0 + (k * TAU) / 5;
      addNode(L * Math.cos(a), L * Math.sin(a), 0, -1);
    }

    const org = {
      seed: seed,
      refActiveSec: ref,
      retract: retract,
      maxNodes: cap,
      nodes: nodes,
      /** Int32Array pairs [newNode, otherNode, …] (a view; length = 2 × linkCount). */
      get links() { return linkBuf.subarray(0, linkCount * 2); },
      get linkCount() { return linkCount; },
      get timeline() { return tl; },
      get analysis() {
        if (anDirty || !analysis) { analysis = FT.analyze(tl); anDirty = false; }
        return analysis;
      },
      get length() { return tl.s.length; },
      get aliveCount() { return aliveCount; },
      get maxDist() { return maxDist; },
      /** True once forgive() has rewritten the timeline this organism grew from. */
      get edited() { return edited; },
      /** Node indices retracted by the latest step(). */
      lastRemoved: removedLast,
      front(index) { return frontOf(index, ref); },
      step(rec, index) {
        removedLast.length = 0;
        rec = rec || {};
        const s = validCode(rec.s);
        // Quantise exactly like the stored timeline so live growth == regrowth.
        const fch = FT.codec.level(num01(rec.f, 0)), dch = FT.codec.level(num01(rec.d, 0));
        const fq = FT.codec.unlevel(fch), dq = FT.codec.unlevel(dch);
        const a = rec.a == null ? null : +rec.a;
        tl.s += s; tl.f += fch; tl.d += dch; tl.a += FT.codec.angle(a);
        anDirty = true;
        if (!(typeof index === 'number' && isFinite(index))) index = tl.s.length - 1;
        if (s === 'D') dRun++; else if (s !== 'N') dRun = 0;
        let added = 0, removed = 0;
        if (FT.CODES[s].held) {
          budget = Math.min(ORG.BUDGET_CAP, budget + ORG.RATE * fq * fq * (1 + dq));
          const front = frontOf(index, ref);
          for (let guard = 0; budget >= 1 && nodes.count < cap && guard < 16; guard++) {
            const made = pass(front, index, dq);
            if (made <= 0) break;
            budget -= made; added += made;
          }
        }
        if (retract && s === 'D' && dRun >= ORG.RETRACT_RUN) removed = retractLeaves(index);
        return { added: added, removed: removed };
      },
      /** Rewrites one episode's away/E chars to 'K' (mirrors Session.forgiveLast). */
      forgive(t0) {
        const an = org.analysis;
        let ep = null;
        for (const e of an.episodes) if (e.t0 === t0) { ep = e; break; }
        if (!ep) return false;
        const s = tl.s, end = Math.min(s.length, ep.t1 == null ? s.length : ep.t1);
        let out = s.slice(0, ep.t0);
        for (let i = ep.t0; i < end; i++) { const ch = s[i]; out += (AWAY_CH.indexOf(ch) >= 0 || ch === 'E') ? 'K' : ch; }
        tl.s = out + s.slice(end);
        if (tl.s !== s) edited = true;
        anDirty = true;
        return true;
      },
    };
    return org;
  }

  FT.Organism = { create: createOrganism };

  /* =================================================================== *
   * Shared drawing (live layers, drawSpecimen, drawMini)                *
   * =================================================================== */

  /* Segment widths (§6.3): w = max(0.6, 2.2(1 - dist/1.6)) × scale; baked alpha by width. */
  const NWB = 9;                     // width buckets: factor 0.6 .. 2.2 in 0.2 steps
  const NBAND = 12;                  // radius bands for the tint colour of live strokes
  const WB_WF = new Float64Array(NWB), WB_ALPHA = new Float64Array(NWB);
  for (let b = 0; b < NWB; b++) { WB_WF[b] = 0.6 + 0.2 * b; WB_ALPHA[b] = 0.55 + 0.45 * WB_WF[b] / 2.2; }
  const wfOf = (d) => Math.max(0.6, 2.2 * (1 - d / 1.6));
  const wBucket = (d) => { const b = Math.round((wfOf(d) - 0.6) / 0.2); return b < 0 ? 0 : b >= NWB ? NWB - 1 : b; };
  const bandOf = (r) => { const b = Math.floor(r * NBAND); return b < 0 ? 0 : b >= NBAND ? NBAND - 1 : b; };

  /** Batches line segments by key so each colour/width bucket is one path. */
  class SegBatch {
    constructor(n) { this.a = []; for (let i = 0; i < n; i++) this.a.push([]); this.used = []; }
    add(k, x0, y0, x1, y1) {
      const arr = this.a[k];
      if (arr.length === 0) this.used.push(k);
      arr.push(x0, y0, x1, y1);
    }
    /** style(ctx, key) sets strokeStyle/lineWidth/globalAlpha; keep=true keeps the segments. */
    flush(ctx, style, keep) {
      for (let u = 0; u < this.used.length; u++) {
        const k = this.used[u], arr = this.a[k];
        if (style(ctx, k) === false) continue;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += 4) { ctx.moveTo(arr[i], arr[i + 1]); ctx.lineTo(arr[i + 2], arr[i + 3]); }
        ctx.stroke();
      }
      if (!keep) this.clear();
    }
    clear() { for (let u = 0; u < this.used.length; u++) this.a[this.used[u]].length = 0; this.used.length = 0; }
    get empty() { return this.used.length === 0; }
  }

  /** The tint gradient model (§6.4): centre/edge colours + stop, then blended to the state tint. */
  function tintModel(D, stateRgb, k, out) {
    const c = mix(RGB.hypha, RGB.flow, smoothstep(0.2, 0.9, D));
    const e = RGB.hypha;
    out.c = k > 0 && stateRgb ? mix(c, stateRgb, k) : c;
    out.e = k > 0 && stateRgb ? mix(e, stateRgb, k) : e.slice();
    out.stop = 0.25 + 0.4 * clamp01(D);
    return out;
  }
  function tintAt(tm, r) {
    if (r <= tm.stop) return tm.c;
    return mix(tm.c, tm.e, clamp01((r - tm.stop) / Math.max(1e-6, 1 - tm.stop)));
  }

  /** The glass dish (§6.1 dish layer; keepsake/jar backgrounds). */
  function drawGlass(ctx, x, y, R, lw, caustSeed) {
    const rr = 1.06 * R;
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, '#0E1D20'); g.addColorStop(1, '#0A1517');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    // Meniscus: the glass wall darkens slightly toward the rim.
    const m = ctx.createRadialGradient(x, y, 0.82 * rr, x, y, rr);
    m.addColorStop(0, 'rgba(4,8,10,0)'); m.addColorStop(1, 'rgba(4,8,10,.32)');
    ctx.fillStyle = m;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    if (caustSeed != null) drawCaustics(ctx, x, y, R, caustSeed, 1);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(207,230,223,.035)'; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(x, y, 0.985 * rr, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(207,230,223,.12)'; ctx.lineWidth = 1.5 * lw;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(239,255,248,.22)'; ctx.lineWidth = 2 * lw;
    ctx.beginPath(); ctx.arc(x, y, rr, -150 * DEG, -100 * DEG); ctx.stroke();
    ctx.restore();
  }
  /** Three faint agar caustic blobs, seeded (§6.1). */
  function drawCaustics(ctx, x, y, R, seed, alphaMul) {
    const rng = U.rng(U.hashString('caustic:' + seed));
    for (let k = 0; k < 3; k++) {
      const r = (0.15 + 0.45 * rng()) * R, a = TAU * rng(), rad = (0.28 + 0.24 * rng()) * R;
      const bx = x + Math.cos(a) * r, by = y + Math.sin(a) * r;
      const col = k === 1 ? RGB.flow : RGB.hypha;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
      g.addColorStop(0, rgbaStr(col, 0.03 * alphaMul)); g.addColorStop(0.6, rgbaStr(col, 0.012 * alphaMul)); g.addColorStop(1, rgbaStr(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(bx, by, rad, 0, TAU); ctx.fill();
    }
  }

  /* ---------------- Marks: scars, mends, forgiven washes, absences (§6.6) ---------------- */
  const scarSpan = (dur) => Math.min(70, 16 + 3 * (dur || 0)) * DEG;
  const seededAngle = (seed, t0) => U.rng(U.hashString(seed + ':' + t0))() * TAU;
  function scarGeom(e, seed) {
    if (e.cause === 'eyes') return { a: -Math.PI / 2, span: TAU, full: true };
    if (e.cause === 'tab') return { a: -Math.PI / 2, span: 40 * DEG, full: false };
    const a = typeof e.angle === 'number' && isFinite(e.angle) ? e.angle : seededAngle(seed, e.t0);
    return { a: a, span: e.cause === 'glance' ? 14 * DEG : scarSpan(e.dur), full: false };
  }
  function arcStroke(ctx, x, y, r, a0, a1) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.01, r), a0, a1); ctx.stroke(); }
  function dotArc(ctx, x, y, r, a0, a1, stepA, dotR, full) {
    ctx.beginPath();
    const n = full ? Math.round(TAU / stepA) : Math.max(1, Math.floor((a1 - a0) / stepA + 1e-6)) + 1;
    for (let k = 0; k < n; k++) {
      const a = full ? a0 + k * stepA : a0 + ((a1 - a0) * k) / Math.max(1, n - 1);
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      ctx.moveTo(px + dotR, py); ctx.arc(px, py, dotR, 0, TAU);
    }
    ctx.fill();
  }

  function drawScar(ctx, e, seed, rhoU, ox, oy, R, W, simple, alphaMul) {
    const g = scarGeom(e, seed), rho = rhoU * R, a0 = g.a - g.span / 2, a1 = g.a + g.span / 2;
    const cause = e.cause, am = alphaMul == null ? 1 : alphaMul;
    if (cause === 'eyes') {
      if (simple) { ctx.strokeStyle = rgbaStr(RGB.amber, 0.45 * am); ctx.lineWidth = W(1); arcStroke(ctx, ox, oy, rho, 0, TAU); return; }
      ctx.fillStyle = rgbaStr(RGB.amber, 0.5 * am);
      dotArc(ctx, ox, oy, rho, 0, TAU, 3 * DEG, W(1.25), true);
      return;
    }
    if (cause === 'tab') {
      if (simple) { ctx.strokeStyle = rgbaStr(RGB.scar, 0.7 * am); ctx.lineWidth = W(1); arcStroke(ctx, ox, oy, rho, a0, a1); return; }
      ctx.fillStyle = rgbaStr(RGB.scar, 0.8 * am);
      dotArc(ctx, ox, oy, rho, a0, a1, 4 * DEG, W(1.4), false);
      return;
    }
    if (cause === 'glance') {
      ctx.strokeStyle = rgbaStr(RGB.scar, 0.55 * am); ctx.lineWidth = W(1);
      arcStroke(ctx, ox, oy, rho, a0, a1);
      if (!simple) {
        ctx.strokeStyle = rgbaStr(RGB.scar, 0.2 * am);
        arcStroke(ctx, ox, oy, rho + 0.004 * R, a0, a1);
        arcStroke(ctx, ox, oy, rho - 0.004 * R, a0, a1);
      }
      return;
    }
    // turned, down, up: a 2 px arc plus cause detail.
    ctx.strokeStyle = rgbaStr(RGB.scar, 0.85 * am); ctx.lineWidth = W(2);
    arcStroke(ctx, ox, oy, rho, a0, a1);
    if (simple) return;
    if (cause === 'turned') {
      const rng = U.rng(U.hashString(seed + ':' + e.t0 + ':wick'));
      const n = Math.max(1, Math.round(g.span / (6 * DEG)));
      ctx.lineWidth = W(1.1); ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const a = a0 + (g.span * k) / n, len = (0.012 + 0.018 * rng()) * R, c = Math.cos(a), s = Math.sin(a);
        ctx.moveTo(ox + c * rho, oy + s * rho); ctx.lineTo(ox + c * (rho + len), oy + s * (rho + len));
      }
      ctx.stroke();
    } else if (cause === 'up') {
      const n = Math.max(1, Math.round(g.span / (8 * DEG))), len = 0.014 * R;
      ctx.lineWidth = W(1.1); ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const a = a0 + (g.span * k) / n, c = Math.cos(a), s = Math.sin(a);
        ctx.moveTo(ox + c * rho, oy + s * rho); ctx.lineTo(ox + c * (rho - len), oy + s * (rho - len));
      }
      ctx.stroke();
    } else if (cause === 'down') {
      const n = Math.min(5, 1 + Math.floor((e.dur || 0) / 4));
      const len = Math.min(0.12, 0.02 + 0.006 * (e.dur || 0)) * R, dotR = 0.006 * R;
      ctx.lineWidth = W(1.2); ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = a0 + (g.span * (k + 0.5)) / n, px = ox + Math.cos(a) * rho, py = oy + Math.sin(a) * rho;
        ctx.moveTo(px, py); ctx.lineTo(px, py + len);
      }
      ctx.stroke();
      ctx.fillStyle = rgbaStr(RGB.scar, 0.85 * am); ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = a0 + (g.span * (k + 0.5)) / n, px = ox + Math.cos(a) * rho, py = oy + Math.sin(a) * rho + len;
        ctx.moveTo(px + dotR, py); ctx.arc(px, py, dotR, 0, TAU);
      }
      ctx.fill();
    }
  }

  /** Kintsugi: a gold seam over the scar plus 3 small crack branches. */
  function drawSeam(ctx, e, seed, rhoU, ox, oy, R, W, simple, alpha) {
    const g = scarGeom(e, seed), rho = (rhoU + 0.006) * R;
    const a0 = g.a - g.span / 2, a1 = g.a + g.span / 2;
    if (g.full) {
      ctx.fillStyle = rgbaStr(RGB.gold, 0.9 * alpha);
      if (simple) { ctx.strokeStyle = rgbaStr(RGB.gold, 0.8 * alpha); ctx.lineWidth = W(1.2); arcStroke(ctx, ox, oy, rho, 0, TAU); }
      else dotArc(ctx, ox, oy, rho, 0, TAU, 6 * DEG, W(1.3), true);
    } else {
      ctx.strokeStyle = rgbaStr(RGB.gold, 0.95 * alpha); ctx.lineWidth = W(1.6);
      arcStroke(ctx, ox, oy, rho, a0, a1);
    }
    if (simple) return;
    const rng = U.rng(U.hashString(seed + ':' + e.t0 + ':mend'));
    ctx.strokeStyle = rgbaStr(RGB.gold, 0.8 * alpha); ctx.lineWidth = W(0.9);
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = g.full ? rng() * TAU : a0 + g.span * (0.15 + 0.7 * rng());
      const dev = (rng() < 0.5 ? -1 : 1) * (0.45 + 0.6 * rng()) + (rng() < 0.5 ? 0 : Math.PI);
      const px = ox + Math.cos(a) * rho, py = oy + Math.sin(a) * rho, len = 0.015 * R;
      ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a + dev) * len, py + Math.sin(a + dev) * len);
    }
    ctx.stroke();
  }

  /**
   * All marks from organism.analysis. ls = line scale (px per "spec px"), minW = min stroke.
   * Returns the number of scars (episodes).
   */
  function drawMarks(ctx, org, seed, ox, oy, R, ls, simple, minW, opt) {
    const an = org.analysis;
    if (!an) return 0;
    const W = (v) => Math.max(minW || 0, v * ls);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const ab of an.absences) {
      const rho = org.front(ab.t0) * R;
      ctx.strokeStyle = rgbaStr(RGB.frost, 0.45); ctx.lineWidth = W(1.4);
      if (!simple) ctx.setLineDash([Math.max(0.5, rho * 2 * DEG), Math.max(1, rho * 4 * DEG)]);
      arcStroke(ctx, ox, oy, rho, 0, TAU);
      ctx.setLineDash([]);
    }
    for (const f of an.forgiven) {
      const rho = org.front(f.t0) * R;
      const a = typeof f.angle === 'number' && isFinite(f.angle) ? f.angle : seededAngle(seed, f.t0);
      const sp = scarSpan(f.dur);
      ctx.strokeStyle = rgbaStr(RGB.hypha, 0.18); ctx.lineWidth = W(6);
      arcStroke(ctx, ox, oy, rho, a - sp / 2, a + sp / 2);
    }
    for (const e of an.episodes) drawScar(ctx, e, seed, org.front(e.t0), ox, oy, R, W, simple, 1);
    const seamAlpha = opt && opt.seamAlpha != null ? opt.seamAlpha : 1;
    if (seamAlpha > 0) for (const e of an.episodes) if (e.mended) drawSeam(ctx, e, seed, org.front(e.t0), ox, oy, R, W, simple, seamAlpha);
    ctx.restore();
    return an.episodes.length;
  }

  /* ---------------- Caps (§6.8) ---------------- */
  function computeCaps(org, record) {
    const out = [];
    if (!org) return out;
    const an = org.analysis;
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const ok = (s) => s && isNum(s.t0) && isNum(s.dur);
    let pool = record && Array.isArray(record.streaks) && record.streaks.length ? record.streaks.filter(ok) : [];
    if (!pool.length && an) pool = an.streaks.filter(ok);
    let chosen = pool.filter((s) => s.dur >= 600).sort((a, b) => (b.dur - a.dur) || (a.t0 - b.t0)).slice(0, 6);
    if (!chosen.length) {
      const st = record && record.stats;
      const lms = st && isNum(st.longestStreakMs) ? st.longestStreakMs : (an ? an.longestStreak * 1000 : 0);
      if (lms >= 180000) {
        let best = null;
        for (const s of pool) if (!best || s.dur > best.dur) best = s;
        if (best) chosen = [best];
      }
    }
    const N = org.nodes;
    for (const st of chosen) {
      const t0 = st.t0, t1 = isNum(st.t1) ? st.t1 : st.t0 + st.dur;
      let bi = -1, br = -1;
      for (let i = 0; i < N.count; i++) {
        if (!N.alive[i]) continue;
        const b = N.born[i];
        if (b < t0) continue;
        if (b >= t1) break; // born is non-decreasing with the index
        const r2 = N.x[i] * N.x[i] + N.y[i] * N.y[i];
        if (r2 > br) { br = r2; bi = i; }
      }
      if (bi < 0) continue;
      const x = N.x[bi], y = N.y[bi], p = N.parent[bi], r = Math.sqrt(br) || 1;
      let hx = p >= 0 ? x - N.x[p] : x, hy = p >= 0 ? y - N.y[p] : y;
      const hl = Math.sqrt(hx * hx + hy * hy) || 1;
      hx = hx / hl + x / r; hy = hy / hl + y / r; // heading, pulled outward
      out.push({
        node: bi, x: x, y: y, theta: Math.atan2(hy, hx),
        size: 0.035 + 0.05 * Math.min(1, st.dur / 2700), dist: N.dist[bi], t0: t0, dur: st.dur,
      });
    }
    return out;
  }

  /** One cap: stipe, half-ellipse cap with a core→gold gradient, 7 gills, sprite glow. */
  function drawCap(ctx, x, y, theta, size, sc, alpha, ls) {
    if (!(sc > 0.001) || !(alpha > 0.001) || !(size > 0)) return;
    const s = size * sc, lw = Math.max(0.5, ls);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(theta);
    // Glow first, additive.
    const spr = getSprite(RGB.gold), gr = size * 2.8 * Math.min(1.2, sc);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 * alpha * clamp01(sc);
    ctx.drawImage(spr, 0.25 * s - gr, -gr, gr * 2, gr * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    const u = 0.12 * s; // underside sits just outward of the node
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgbaStr(RGB.core, 0.75); ctx.lineWidth = 2 * lw;
    ctx.beginPath(); ctx.moveTo(-0.6 * s, 0); ctx.lineTo(u, 0); ctx.stroke();
    // Cap dome facing outward (+x).
    ctx.beginPath();
    ctx.ellipse(u, 0, 0.6 * s, s, 0, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    const g = ctx.createRadialGradient(u, 0, 0, u, 0, s);
    g.addColorStop(0, rgbaStr(RGB.core, 0.95)); g.addColorStop(1, rgbaStr(RGB.gold, 0.45));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = rgbaStr(RGB.gold, 0.55); ctx.lineWidth = 0.8 * lw; ctx.stroke();
    // Gills: from the underside toward the stipe top.
    ctx.strokeStyle = rgbaStr(RGB.gold, 0.5); ctx.lineWidth = 0.6 * lw;
    ctx.beginPath();
    for (let k = 0; k < 7; k++) {
      const yy = s * (-0.86 + (1.72 * k) / 6);
      ctx.moveTo(u + 0.02 * s, yy); ctx.lineTo(u - 0.16 * s, yy * 0.28);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- drawSpecimen (§6.9) ---------------- */
  const specCache = new Map(); // LRU of 8 regrown organisms
  const specBatch = new SegBatch(NWB);

  function recordSeed(record) {
    const s = +record.seed;
    return isFinite(s) && record.seed != null ? (s >>> 0) : U.hashString(String(record.id || 'hypha'));
  }
  function regrow(record) {
    const t = record.timeline;
    const str = (v) => (typeof v === 'string' ? v : '');
    const tlr = { s: str(t.s), f: str(t.f), d: str(t.d), a: str(t.a) }; // tolerate damaged imports
    const org = createOrganism(recordSeed(record), {
      refActiveSec: record.refActiveSec,
      retract: record.retract != null ? !!record.retract : record.sensitivity !== 'gentle',
    });
    const len = tlr.s.length;
    for (let i = 0; i < len; i++) org.step(FT.codec.rec(tlr, i), i);
    return org;
  }
  function specimenEntry(record) {
    const tlr = record.timeline, len = tlr.s.length;
    const key = (record.id != null ? record.id : 's' + recordSeed(record)) + ':' + len;
    let entry = specCache.get(key);
    if (entry && entry.s !== tlr.s) entry = null; // forgiven edits keep the length; regrow then
    if (entry) { specCache.delete(key); specCache.set(key, entry); return entry; }
    entry = { org: regrow(record), s: tlr.s, caps: null };
    specCache.set(key, entry);
    while (specCache.size > 8) specCache.delete(specCache.keys().next().value);
    return entry;
  }

  function drawSporeStatic(ctx, x, y, R, rgb, alpha) {
    const spr = getSprite(rgb || RGB.core);
    const gr = 0.035 * R * 5;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 * alpha;
    ctx.drawImage(spr, x - gr, y - gr, gr * 2, gr * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgbStr(RGB.core);
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, 0.035 * R), 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawSpecimen(ctx, record, cx, cy, radius, opts) {
    const o = Object.assign({ quality: 'full', fruit: true, background: false }, opts || {});
    const zero = { nodes: 0, scars: 0, caps: 0 };
    if (!ctx || !record) return zero;
    const R = +radius > 0 ? +radius : 1;
    cx = fin(+cx, 0); cy = fin(+cy, 0);
    const thumb = o.quality === 'thumb';
    const ls = R / 380;
    const minW = thumb ? 0.5 : 0;
    ctx.save();
    try {
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const tlr = record.timeline;
      if (o.background) drawGlass(ctx, cx, cy, R, Math.max(0.5, ls), thumb ? null : recordSeed(record));
      if (!tlr || typeof tlr.s !== 'string' || !tlr.s.length) {
        drawSporeStatic(ctx, cx, cy, R, RGB.core, 1);
        ctx.strokeStyle = rgbaStr(RGB.frost, 0.6); ctx.lineWidth = Math.max(0.5, 1.4 * ls);
        ctx.setLineDash([Math.max(1, 0.02 * R), Math.max(1.5, 0.04 * R)]);
        arcStroke(ctx, cx, cy, 0.62 * R, 0, TAU);
        ctx.setLineDash([]);
        return zero;
      }
      const entry = specimenEntry(record);
      const org = entry.org, N = org.nodes, seed = org.seed;
      const an = org.analysis;
      const st = record.stats || {};
      const pd = clamp01(fin(st.peakDepth, an.peakDepth || 0));
      const tm = tintModel(pd, null, 0, {});
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      grad.addColorStop(0, rgbStr(tm.c)); grad.addColorStop(tm.stop, rgbStr(tm.c)); grad.addColorStop(1, rgbStr(tm.e));

      for (let i = 1; i < N.count; i++) {
        if (!N.alive[i]) continue;
        const p = N.parent[i];
        if (p < 0) continue;
        specBatch.add(wBucket(N.dist[i]), cx + N.x[p] * R, cy + N.y[p] * R, cx + N.x[i] * R, cy + N.y[i] * R);
      }
      ctx.strokeStyle = grad;
      if (!thumb) {
        ctx.globalCompositeOperation = 'lighter';
        specBatch.flush(ctx, (c, k) => { c.lineWidth = Math.max(minW, WB_WF[k] * ls) * 3; c.globalAlpha = 0.12; }, true);
        ctx.globalCompositeOperation = 'source-over';
      }
      specBatch.flush(ctx, (c, k) => { c.lineWidth = Math.max(minW, WB_WF[k] * ls); c.globalAlpha = WB_ALPHA[k]; }, false);
      // Anastomosis links.
      const lk = org.links;
      if (lk.length) {
        ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(minW || 0.3, 0.6 * ls);
        ctx.beginPath();
        for (let k = 0; k < lk.length; k += 2) {
          const a = lk[k], b = lk[k + 1];
          if (!N.alive[a] || !N.alive[b]) continue;
          ctx.moveTo(cx + N.x[a] * R, cy + N.y[a] * R); ctx.lineTo(cx + N.x[b] * R, cy + N.y[b] * R);
        }
        ctx.stroke();
      }
      // Core glow.
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'lighter';
      const rc = Math.max(1, (0.04 + 0.1 * pd) * R * 1.8);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rc);
      cg.addColorStop(0, 'rgba(239,255,248,.85)'); cg.addColorStop(0.3, 'rgba(239,255,248,.32)'); cg.addColorStop(1, 'rgba(239,255,248,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(cx, cy, rc, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // Marks (no front hairline).
      const scars = drawMarks(ctx, org, seed, cx, cy, R, ls, thumb && R < 60, minW);
      let caps = 0;
      if (o.fruit) {
        if (!entry.caps) entry.caps = computeCaps(org, record);
        for (const c of entry.caps) drawCap(ctx, cx + c.x * R, cy + c.y * R, c.theta, c.size * R, 1, 1, Math.max(ls, thumb ? 0.25 : 0));
        caps = entry.caps.length;
      }
      return { nodes: org.aliveCount, scars: scars, caps: caps };
    } catch (err) {
      specBatch.clear();
      console.warn(LOG, 'drawSpecimen failed', err);
      return zero;
    } finally {
      ctx.restore();
    }
  }

  /* =================================================================== *
   * FT.Visual — state                                                    *
   * =================================================================== */
  const QUALITY = {
    high:   { dpr: 2,    bloom: 2, spores: 400, tips: 60, pulses: 3, growIn: true,  caustics: true },
    medium: { dpr: 1.25, bloom: 3, spores: 200, tips: 40, pulses: 2, growIn: true,  caustics: true },
    low:    { dpr: 1,    bloom: 0, spores: 80,  tips: 24, pulses: 1, growIn: false, caustics: false },
  };
  const QORDER = ['low', 'medium', 'high'];
  const PHASES = ['intro', 'idle', 'loading', 'calibrating', 'running', 'paused', 'break', 'fruiting', 'complete'];
  // [desktop cy/H, desktop r/R_full, phone cy/H, phone r/R_full]  (§2.2)
  const LAYOUT = {
    intro:       [0.40, 0.80, 0.30, 0.80],
    idle:        [0.24, 0.50, 0.18, 0.50],
    loading:     [0.40, 0.60, 0.32, 0.60],
    calibrating: [0.50, 0.90, 0.50, 0.90],
    running:     [0.44, 1.00, 0.36, 1.00],
    complete:    [0.26, 0.60, 0.20, 0.52],
  };
  const GROW_MS = 1000, FRESH_SEC = 60, BAKE_PER_FRAME = 50, BUCKET = 0.02;
  const DEFAULT_CORNERS = [[0.08, 0.12], [0.92, 0.12], [0.92, 0.88], [0.08, 0.88]];
  const ORG_PHASES = { intro: 1, running: 1, paused: 1, break: 1, fruiting: 1, complete: 1 };

  let canvas = null, ctx = null, initialised = false, errLogged = false;
  let W = 0, H = 0, dpr = 1, BW = 0, BH = 0, phone = false, Rfull = 0, RfullDev = 0, S = 0, sized = false;
  let resizeTimer = 0;
  let level = 'high', autoQ = true, Q = QUALITY.high;
  let rm = false;

  // Layers (§6.1)
  let Ldish = null, Lcaustic = null, Lgrown = null, Ltinted = null, Lmarks = null;
  let LbloomQ = null, LbloomE = null, Lfog = null, Lhalo = null;
  let gGrown = null, gTinted = null, gMarks = null, gBloomQ = null, gBloomE = null;

  // Organism + renderer bookkeeping
  let org = null;
  let appearAt = new Float64Array(0), baked = new Uint8Array(0);
  let seen = 0, bakePtr = 0, lastAppear = -1e12, maxDistSeen = 0;
  let buckets = [];
  const dying = [];          // {i, at}
  const bakeList = [];
  const bakeBatchW = new SegBatch(NWB), bakeBatchT = new SegBatch(NBAND * NWB);
  const liveBatch = new SegBatch(NBAND * NWB);

  // Tint
  const tintCur = { c: RGB.hypha.slice(), e: RGB.hypha.slice(), stop: 0.25 };
  const tintApplied = { c: [-9, -9, -9], e: [-9, -9, -9], stop: -1 };
  const bandApplied = new Array(NBAND).fill('#7CF5D0'), bandCur = new Array(NBAND).fill('#7CF5D0');
  let tintBuiltAt = -1e9, tintDirty = true;

  // Marks
  let marksKey = '', marksAt = -1e9, marksLen = -1, marksDirty = true;

  // Input (normalised) and smoothed channels (§4.5.2)
  const I = {
    now: 0, phase: 'idle', state: 'none', cause: null, stateAgeMs: 0, focus: 0.75, depth: 0,
    hasDir: false, dx: 0, dy: 0, offScreen: false, offCause: null, eyeOpen: 1, drowsiness: 0, present: true,
    rimProgress: null, breakProgress: 0, lookAway: 0, loading: null, calibration: null, hidden: false,
  };
  let Fs = 0.75, Ds = 0, dirX = 0, dirY = 0, ux = 0, uy = 1, eo = 1, Zs = 0;
  let kState = 0, lumMul = 1, kSleep = 0, kAbs = 0, kDrift = 0, kUnseen = 0;
  const tintRgb = RGB.muted.slice();
  let tintPal = RGB.muted;   // the palette colour the state tint is heading to (sprites use it)
  let flinch = 0, flinchUx = 1, flinchUy = 0, sink = 0, aperture = 0;
  let shiverOn = false, shiverAt = 0;
  let orgVis = 0, sporeVis = 1, dishAlpha = 0.5, fogA = 0, dewFade = 0, rimVis = 0;
  const lay = { cx: 0, cy: 0, r: 0 };
  let laySnapped = false;

  // Time
  let lastNow = 0, flickT = 0, curPhase = 'idle', phaseSince = 0, frameNo = 0, bloomValid = false;
  // Per-frame derived (shared by draw helpers)
  let NOW = 0, DX = 0, DY = 0, RP = 1, LS = 1, lum = 1, netA = 1;

  // Stats / auto quality
  let emaInt = 16.7, emaCpu = 2, badMs = 0, goodMs = 0, qGraceUntil = 0, lastCpu = 0;

  // Effects
  const pulses = [];         // blink wavefronts {t0}
  const rings = [];          // {kind: 'welcome'|'return', t0, angle}
  const glints = [];         // kintsugi glints {t0, dur, e}
  let flashStart = -1e9, flashAmt = 0, flashDur = 1;
  let calFrame = null;       // {t0, pts}
  const sproutAt = [];
  const litAt = new Float64Array(48).fill(-1);
  const beadAt = new Float64Array(36).fill(-1);
  let pendingBurst = false;
  const pendingSeeds = [];

  // Particles (screen space, device px)
  const PMAX = 1200;
  const pX = new Float32Array(PMAX), pY = new Float32Array(PMAX), pVX = new Float32Array(PMAX), pVY = new Float32Array(PMAX);
  const pAge = new Float32Array(PMAX), pLife = new Float32Array(PMAX), pSize = new Float32Array(PMAX);
  const pX0 = new Float32Array(PMAX), pPh = new Float32Array(PMAX);
  const pKind = new Uint8Array(PMAX), pRamp = new Uint8Array(PMAX);
  let pN = 0, sporeCount = 0, sporeAcc = 0, capSporeAcc = 0;

  // Fruiting
  let fruit = null;          // active timeline
  let finalCaps = null, lidAmt = 0, fruitLum = 1, capsAlpha = 1;

  // Decorative seeded tables (built lazily)
  let idleMotes = null, dormantMotes = null, dewBeads = null, sproutShapes = [];

  /* =================================================================== *
   * Layers and sizing                                                    *
   * =================================================================== */
  function sizeLayer(c, w, h) {
    w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
    if (!c) return mkCanvas(w, h);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }
  function measure() {
    let w = canvas ? canvas.clientWidth : 0, h = canvas ? canvas.clientHeight : 0;
    if (!(w > 0) || !(h > 0)) { w = window.innerWidth || 800; h = window.innerHeight || 600; }
    return [Math.max(1, w), Math.max(1, h)];
  }
  function currentDpr() { return Math.max(0.5, Math.min(window.devicePixelRatio || 1, Q.dpr)); }

  function resize(force) {
    if (!canvas || !ctx) return;
    const m = measure(), d = currentDpr();
    if (!force && sized && m[0] === W && m[1] === H && d === dpr) return;
    W = m[0]; H = m[1]; dpr = d;
    BW = Math.max(1, Math.round(W * dpr)); BH = Math.max(1, Math.round(H * dpr));
    canvas.width = BW; canvas.height = BH; // also resets the context state
    try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch (e) { /* optional */ }
    phone = W < 640;
    Rfull = Math.max(8, phone ? Math.min(0.44 * W, 0.27 * H) : Math.min(0.34 * H, 0.3 * W));
    RfullDev = Rfull * dpr;
    S = Math.max(16, Math.ceil(2.2 * RfullDev));
    Ldish = sizeLayer(Ldish, S, S);
    Lcaustic = sizeLayer(Lcaustic, S / 2, S / 2);
    Lgrown = sizeLayer(Lgrown, S, S); gGrown = ctx2d(Lgrown);
    Ltinted = sizeLayer(Ltinted, S, S); gTinted = ctx2d(Ltinted);
    Lmarks = sizeLayer(Lmarks, S, S); gMarks = ctx2d(Lmarks);
    LbloomQ = sizeLayer(LbloomQ, BW / 4, BH / 4); gBloomQ = ctx2d(LbloomQ);
    LbloomE = sizeLayer(LbloomE, BW / 8, BH / 8); gBloomE = ctx2d(LbloomE);
    try { gBloomQ.imageSmoothingQuality = 'high'; gBloomE.imageSmoothingQuality = 'high'; } catch (e) { /* optional */ }
    if (!Lfog) buildFog();
    if (!Lhalo) buildHalo();
    buildDish();
    rebakeAll();
    rebuildTinted(NOW);
    marksDirty = true;
    rebuildMarks(NOW, true);
    sized = true;
    laySnapped = false;
    pN = 0; sporeCount = 0;
    bloomValid = false;
  }
  function scheduleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = 0; try { resize(false); } catch (e) { console.warn(LOG, 'resize failed', e); } }, 100);
  }

  function buildDish() {
    const g = ctx2d(Ldish);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    drawGlass(g, S / 2, S / 2, RfullDev, dpr, null);
    const c = ctx2d(Lcaustic);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, Lcaustic.width, Lcaustic.height);
    drawCaustics(c, Lcaustic.width / 2, Lcaustic.height / 2, RfullDev / 2, org ? org.seed : 1, 1);
  }
  function buildFog() {
    Lfog = mkCanvas(256, 256);
    const g = ctx2d(Lfog), rng = U.rng(0xF06F06);
    for (let k = 0; k < 60; k++) {
      const a = TAU * rng(), r = 100 * Math.sqrt(rng()), x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
      const rad = 22 + 46 * rng();
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(207,230,223,.05)'); gr.addColorStop(1, 'rgba(207,230,223,0)');
      g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }
  function buildHalo() {
    Lhalo = mkCanvas(128, 128);
    const g = ctx2d(Lhalo), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(124,245,208,.04)'); gr.addColorStop(0.55, 'rgba(124,245,208,.018)'); gr.addColorStop(1, 'rgba(124,245,208,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }

  /* =================================================================== *
   * Organism bookkeeping: registration (grow-in), baking, tint, marks    *
   * =================================================================== */
  function allocRender() {
    const cap = org ? org.maxNodes : 0;
    appearAt = new Float64Array(cap);
    baked = new Uint8Array(cap);
    seen = 0; bakePtr = 0; lastAppear = -1e12; maxDistSeen = 0;
    buckets = [];
    dying.length = 0;
  }
  function registerNode(i, a) {
    const N = org.nodes;
    appearAt[i] = N.alive[i] ? a : Infinity;
    const b = Math.floor(N.dist[i] / BUCKET);
    (buckets[b] || (buckets[b] = [])).push(i);
    if (N.dist[i] > maxDistSeen) maxDistSeen = N.dist[i];
  }
  /** Assigns appearAt to nodes the renderer hasn't seen (catch-up is staggered, ≤ 3 s). */
  function syncNodes(now) {
    if (!org) return;
    const N = org.nodes, n = N.count;
    if (seen >= n) return;
    const k = n - seen;
    if (rm) {
      const batchAt = Math.ceil(now / 10000) * 10000; // reduced motion: batches every 10 s
      for (let j = 0; j < k; j++) registerNode(seen + j, batchAt);
    } else if (!Q.growIn) {
      for (let j = 0; j < k; j++) registerNode(seen + j, now);
    } else {
      const stagger = k > 1 ? Math.min(40, 3000 / k) : 0;
      const base = Math.max(now, Math.min(lastAppear, now + 3000));
      for (let j = 0; j < k; j++) {
        const i = seen + j;
        let a = base + j * stagger;
        const p = N.parent[i];
        if (k <= 8 && p >= 0) { // a child starts once its parent is mostly grown
          const pa = appearAt[p] + GROW_MS * 0.6;
          if (pa > a && pa < now + 4000) a = pa;
        }
        registerNode(i, a);
        if (a > lastAppear) lastAppear = a;
      }
    }
    seen = n;
  }
  function segEnds(i, R, ox, oy, g, out) {
    const N = org.nodes, p = N.parent[i];
    const x0 = ox + N.x[p] * R, y0 = oy + N.y[p] * R;
    out[0] = x0; out[1] = y0;
    out[2] = x0 + (ox + N.x[i] * R - x0) * g; out[3] = y0 + (oy + N.y[i] * R - y0) * g;
    return out;
  }
  const SEG = [0, 0, 0, 0];

  function strokeBake(list, grownOnly) {
    if (!gGrown || !list.length) return;
    const N = org.nodes, h = S / 2, R = RfullDev, lsL = R / 380;
    for (let q = 0; q < list.length; q++) {
      const i = list[q];
      segEnds(i, R, h, h, 1, SEG);
      const wb = wBucket(N.dist[i]);
      bakeBatchW.add(wb, SEG[0], SEG[1], SEG[2], SEG[3]);
      if (!grownOnly) {
        const r = Math.sqrt(N.x[i] * N.x[i] + N.y[i] * N.y[i]);
        bakeBatchT.add(bandOf(r) * NWB + wb, SEG[0], SEG[1], SEG[2], SEG[3]);
      }
    }
    gGrown.lineCap = 'round'; gGrown.strokeStyle = '#FFFFFF';
    bakeBatchW.flush(gGrown, (c, k) => { c.lineWidth = WB_WF[k] * lsL; c.globalAlpha = WB_ALPHA[k]; });
    gGrown.globalAlpha = 1;
    if (!grownOnly) {
      gTinted.lineCap = 'round';
      bakeBatchT.flush(gTinted, (c, k) => {
        const wb = k % NWB;
        c.strokeStyle = bandApplied[(k / NWB) | 0]; c.lineWidth = WB_WF[wb] * lsL; c.globalAlpha = WB_ALPHA[wb];
      });
      gTinted.globalAlpha = 1;
    }
  }
  /** Consolidates nodes older than 60 s whose grow-in has finished (≤ limit per frame). */
  function bakeStep(now, limit) {
    if (!org) return;
    const N = org.nodes, cur = org.length - 1;
    const need = rm ? 400 : Q.growIn ? GROW_MS : 0;
    bakeList.length = 0;
    while (bakePtr < seen && bakeList.length < limit) {
      const i = bakePtr;
      if (!N.alive[i]) { bakePtr++; continue; }
      if (cur - N.born[i] <= FRESH_SEC) break;
      if (now < appearAt[i] + need) break;
      baked[i] = 1; bakePtr++;
      if (N.parent[i] >= 0) bakeList.push(i);
    }
    if (bakeList.length) strokeBake(bakeList, false);
  }
  /** Marks everything as grown and consolidated at once (prefill, regrowth). */
  function bakeAll() {
    if (!org) return;
    const N = org.nodes;
    for (let i = seen; i < N.count; i++) registerNode(i, -1e12);
    seen = N.count;
    bakeList.length = 0;
    for (let i = bakePtr; i < N.count; i++) {
      if (!N.alive[i]) continue;
      appearAt[i] = -1e12; baked[i] = 1;
      if (N.parent[i] >= 0) bakeList.push(i);
    }
    bakePtr = N.count;
    dying.length = 0;
    lastAppear = -1e12;
    if (bakeList.length) strokeBake(bakeList, false);
  }
  /** Re-strokes every consolidated node (resize / DPR change). */
  function rebakeAll() {
    if (!gGrown) return;
    gGrown.setTransform(1, 0, 0, 1, 0, 0); gGrown.clearRect(0, 0, S, S);
    gTinted.setTransform(1, 0, 0, 1, 0, 0); gTinted.clearRect(0, 0, S, S);
    if (!org) return;
    const N = org.nodes;
    bakeList.length = 0;
    for (let i = 0; i < bakePtr && i < N.count; i++) if (baked[i] && N.alive[i] && N.parent[i] >= 0) bakeList.push(i);
    strokeBake(bakeList, true);
    tintDirty = true;
  }

  function bandStrings(tm, out) {
    for (let b = 0; b < NBAND; b++) out[b] = rgbStr(tintAt(tm, (b + 0.5) / NBAND));
  }
  function tintDiffers() {
    const a = tintCur, b = tintApplied;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(a.c[k] - b.c[k]) > 1 || Math.abs(a.e[k] - b.e[k]) > 1) return true;
    }
    return Math.abs(a.stop - b.stop) > 0.004;
  }
  function rebuildTinted(now) {
    if (!gTinted) return;
    const g = gTinted, h = S / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, S, S);
    g.drawImage(Lgrown, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    const gr = g.createRadialGradient(h, h, 0, h, h, RfullDev);
    gr.addColorStop(0, rgbStr(tintCur.c));
    gr.addColorStop(U.clamp(tintCur.stop, 0.01, 0.99), rgbStr(tintCur.c));
    gr.addColorStop(1, rgbStr(tintCur.e));
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 3; k++) { tintApplied.c[k] = tintCur.c[k]; tintApplied.e[k] = tintCur.e[k]; }
    tintApplied.stop = tintCur.stop;
    bandStrings(tintApplied, bandApplied);
    tintBuiltAt = now; tintDirty = false;
  }
  /** Re-tints the consolidated network when a channel moved > 1/255 (at most every 100 ms). */
  function maybeTint(now) {
    if (!gTinted) return;
    if (now - tintBuiltAt < 100 && now >= tintBuiltAt) return;
    if (tintDirty || tintDiffers()) rebuildTinted(now);
  }

  function marksKeyOf(an) {
    let k = '';
    for (const e of an.episodes) k += e.t0 + ',' + e.t1 + ',' + e.dur + ',' + e.cause + (e.mended ? 'm' : '') + ';';
    k += '|';
    for (const f of an.forgiven) k += f.t0 + ',' + f.dur + ';';
    k += '|';
    for (const a of an.absences) k += a.t0 + ';';
    return k;
  }
  function rebuildMarks(now, force) {
    if (!gMarks || !org) return;
    const len = org.length;
    if (!force && !marksDirty && (len === marksLen || now - marksAt < 1000)) return;
    marksAt = now; marksLen = len;
    const an = org.analysis;
    const key = marksKeyOf(an);
    if (!force && !marksDirty && key === marksKey) return;
    marksKey = key; marksDirty = false;
    gMarks.setTransform(1, 0, 0, 1, 0, 0);
    gMarks.clearRect(0, 0, S, S);
    drawMarks(gMarks, org, org.seed, S / 2, S / 2, RfullDev, RfullDev / 380, false, 0.5);
  }

  /* =================================================================== *
   * Input, smoothing, layout                                             *
   * =================================================================== */
  function readInput(inp) {
    inp = inp && typeof inp === 'object' ? inp : {};
    I.now = fin(inp.now, performance.now());
    I.phase = PHASES.indexOf(inp.phase) >= 0 ? inp.phase : 'idle';
    I.state = typeof inp.state === 'string' ? inp.state : 'none';
    I.cause = typeof inp.cause === 'string' ? inp.cause : null;
    I.stateAgeMs = Math.max(0, fin(inp.stateAgeMs, 0));
    I.focus = clamp01(fin(inp.focus, 0.75));
    I.depth = clamp01(fin(inp.depth, 0));
    const d = inp.dir;
    I.hasDir = !!(d && typeof d === 'object' && isFinite(d.x) && isFinite(d.y));
    I.dx = I.hasDir ? U.clamp(+d.x, -4, 4) : 0;
    I.dy = I.hasDir ? U.clamp(+d.y, -4, 4) : 0;
    I.offScreen = !!inp.offScreen;
    I.offCause = typeof inp.offCause === 'string' ? inp.offCause : null;
    I.eyeOpen = clamp01(fin(inp.eyeOpen, 1));
    I.drowsiness = clamp01(fin(inp.drowsiness, 0));
    I.present = inp.present !== false;
    I.rimProgress = typeof inp.rimProgress === 'number' && isFinite(inp.rimProgress) ? clamp01(inp.rimProgress) : null;
    I.breakProgress = clamp01(fin(inp.breakProgress, 0));
    I.lookAway = clamp01(fin(inp.lookAway, 0));
    I.loading = typeof inp.loading === 'number' && isFinite(inp.loading) ? clamp01(inp.loading) : null;
    const cal = inp.calibration;
    I.calibration = cal && typeof cal === 'object' && Array.isArray(cal.points) ? cal : null;
    I.hidden = !!inp.hidden;
  }

  function reacts() { return I.phase === 'running' || I.phase === 'intro'; }

  function smoothInputs(now, dt) {
    const tauS = rm ? 150 : 800, tauV = rm ? 150 : 600;
    Fs = U.damp(Fs, I.focus, 250, dt);
    Ds = U.damp(Ds, I.depth, 1000, dt);
    if (I.hasDir) { dirX = U.damp(dirX, I.dx, 180, dt); dirY = U.damp(dirY, I.dy, 180, dt); }
    const dl = Math.sqrt(dirX * dirX + dirY * dirY);
    if (dl > 0.05) { ux = dirX / dl; uy = dirY / dl; }
    eo = U.damp(eo, I.eyeOpen, 120, dt);
    Zs = U.damp(Zs, I.drowsiness, 2000, dt);

    // State tint / luminance targets (§6.4 table). The phase has precedence.
    const ph = I.phase, react = reacts(), st = I.state;
    let tRgb = null, tk = 0, tl = 1;
    if (ph === 'paused') { tRgb = RGB.muted; tk = 0.4; tl = 0.55; }
    else if (ph === 'break') { tRgb = RGB.core; tk = 0.25; tl = 0.7; }
    else if (react) {
      if (st === 'eyes-closed') { tRgb = RGB.amber; tk = 0.85; tl = 0.8; }
      else if (st === 'absent') { tRgb = RGB.frost; tk = 0.9; tl = 0.25; }
      else if (st === 'unseen') { tRgb = RGB.muted; tk = 0.6; tl = 0.6; }
      else if (st === 'away' && I.cause === 'tab') { tl = 0.75; } // "a quiet dim; no direction"
      else if (st === 'away') { tRgb = RGB.muted; tk = 0.3; tl = 0.75; }
    }
    if (tRgb) {
      tintPal = tRgb;
      if (kState < 0.02) { tintRgb[0] = tRgb[0]; tintRgb[1] = tRgb[1]; tintRgb[2] = tRgb[2]; }
      else for (let k = 0; k < 3; k++) tintRgb[k] = U.damp(tintRgb[k], tRgb[k], tauS, dt);
    }
    kState = U.damp(kState, tk, tauS, dt);
    lumMul = U.damp(lumMul, tl, tauS, dt);
    kSleep = U.damp(kSleep, react && st === 'eyes-closed' ? 1 : 0, tauS, dt);
    kAbs = U.damp(kAbs, (react || ph === 'paused') && st === 'absent' ? 1 : 0, tauS, dt);
    kUnseen = U.damp(kUnseen, react && st === 'unseen' ? 1 : 0, tauS, dt);
    kDrift = U.damp(kDrift, react && st === 'drifting' ? 1 : 0, 800, dt);

    // Mimosa flinch (turned/up = 1, glance = 0.4), sinking light (down), sleep aperture.
    let fT = 0;
    if (react && st === 'away') {
      if (I.cause === 'turned' || I.cause === 'up') fT = 1;
      else if (I.cause === 'glance') fT = 0.4;
      if (fT > 0) {
        if (I.cause === 'up' && !(dl > 0.15)) { flinchUx = 0; flinchUy = -1; }
        else if (dl > 0.15) { flinchUx = ux; flinchUy = uy; }
      }
    }
    flinch = U.dampAsym(flinch, fT, 300, 900, dt);
    sink = U.dampAsym(sink, react && st === 'away' && I.cause === 'down' ? 1 : 0, 300, 900, dt);
    aperture = U.damp(aperture, react && st === 'eyes-closed' && I.stateAgeMs >= 600 ? 1 : 0, rm ? 150 : 400, dt);

    // Shiver: off-screen before the detector's debounce (≤ 400 ms per event).
    if (react && I.offScreen && st !== 'away' && st !== 'none') {
      if (!shiverOn) { shiverOn = true; shiverAt = now; }
    } else shiverOn = false;

    // Visibility blends.
    const showOrg = ORG_PHASES[ph] === 1;
    orgVis = U.damp(orgVis, showOrg ? 1 : 0, tauV, dt);
    sporeVis = U.damp(sporeVis, showOrg ? 0 : 1, tauV, dt);
    const dishT = ph === 'idle' ? 0.5 : ph === 'loading' ? 0.6 : ph === 'calibrating' ? 0.35 : 1;
    dishAlpha = U.damp(dishAlpha, dishT, tauV, dt);
    if (ph === 'break') { fogA = 0.5 * clamp01((now - phaseSince) / 2000); dewFade = 1; }
    else { fogA = U.damp(fogA, 0, tauV, dt); dewFade = U.damp(dewFade, 0, tauV, dt); }
    const rimOn = I.rimProgress != null && (ph === 'running' || ph === 'paused' || ph === 'break');
    rimVis = U.damp(rimVis, rimOn ? 1 : 0, tauV, dt);

    if (!(react && st === 'unseen')) flickT += dt; // tips freeze while unseen
  }

  function layoutTarget() {
    let key = I.phase;
    if (key === 'paused' || key === 'break') key = 'running';
    // "running … fruiting (until pullback)", then "complete".
    if (fruit) key = fruit.pullback ? 'complete' : 'running';
    else if (key === 'fruiting') key = fruitDone ? 'complete' : 'running';
    const row = LAYOUT[key] || LAYOUT.idle;
    return [(phone ? row[2] : row[0]) * H, (phone ? row[3] : row[1]) * Rfull];
  }
  function updateLayout(dt) {
    const t = layoutTarget();
    lay.cx = 0.5 * W;
    if (!laySnapped) { lay.cy = t[0]; lay.r = t[1]; laySnapped = true; return; }
    const tau = rm ? 150 : fruit && fruit.pullback ? 500 : 600;
    lay.cy = U.damp(lay.cy, t[0], tau, dt);
    lay.r = U.damp(lay.r, t[1], tau, dt);
  }

  /* =================================================================== *
   * Frame drawing — dish space (ctx translated to the dish centre)       *
   * =================================================================== */
  const CORE_STR = rgbStr(RGB.core);
  let idleMoteA = 0, lastRim = 0;

  function flash(amt, dur) {
    const now = performance.now();
    flashAmt = Math.max(flashValue(now), amt); flashStart = now; flashDur = Math.max(1, dur);
  }
  function flashValue(now) { return flashAmt * clamp01(1 - (now - flashStart) / flashDur); }
  function layerRect() { const k = RP / RfullDev; return [-(S / 2) * k, S * k]; }

  function drawDish(now) {
    if (!Ldish || dishAlpha < 0.004) return;
    const lr = layerRect();
    ctx.globalAlpha = dishAlpha;
    ctx.drawImage(Ldish, lr[0], lr[0], lr[1], lr[1]);
    if (Q.caustics && Lcaustic) {
      ctx.save();
      if (!rm) ctx.rotate((now * TAU / 420000) % TAU); // slow caustic drift
      ctx.drawImage(Lcaustic, lr[0], lr[0], lr[1], lr[1]);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function freshProgress(i, now) {
    // returns grow-in fraction (g) and fade (a) through FP
    const ap = appearAt[i];
    FP[0] = 1; FP[1] = 1;
    if (rm) FP[1] = clamp01((now - ap) / 400);
    else if (Q.growIn) FP[0] = clamp01((now - ap) / GROW_MS);
    return FP;
  }
  const FP = [1, 1];

  function drawNetwork(now) {
    if (!org || orgVis < 0.004) return;
    const N = org.nodes, lr = layerRect();
    netA = clamp01(lum) * orgVis;
    if (Ltinted && netA > 0.002) {
      ctx.globalAlpha = netA;
      ctx.drawImage(Ltinted, lr[0], lr[0], lr[1], lr[1]);
      if (lum > 1.03) { // lum above 1 (fruiting, breath peaks) adds light
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, lum - 1) * orgVis;
        ctx.drawImage(Ltinted, lr[0], lr[0], lr[1], lr[1]);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    bandStrings(tintCur, bandCur);
    ctx.lineCap = 'round';
    // Fresh segments: drawn live in the tint colour at their radius, with grow-in.
    for (let i = bakePtr; i < seen; i++) {
      if (!N.alive[i] || N.parent[i] < 0) continue;
      if (appearAt[i] > now) continue;
      const fp = freshProgress(i, now), g = fp[0], fa = fp[1];
      if (g <= 0 || fa <= 0) continue;
      segEnds(i, RP, 0, 0, g, SEG);
      const r = Math.sqrt(N.x[i] * N.x[i] + N.y[i] * N.y[i]);
      const band = bandOf(r), wb = wBucket(N.dist[i]);
      if (fa < 1) {
        ctx.strokeStyle = bandCur[band]; ctx.lineWidth = WB_WF[wb] * LS; ctx.globalAlpha = WB_ALPHA[wb] * netA * fa;
        ctx.beginPath(); ctx.moveTo(SEG[0], SEG[1]); ctx.lineTo(SEG[2], SEG[3]); ctx.stroke();
      } else liveBatch.add(band * NWB + wb, SEG[0], SEG[1], SEG[2], SEG[3]);
    }
    liveBatch.flush(ctx, (c, k) => {
      const wb = k % NWB;
      c.strokeStyle = bandCur[(k / NWB) | 0]; c.lineWidth = WB_WF[wb] * LS; c.globalAlpha = WB_ALPHA[wb] * netA;
    });
    // Retracted segments fade out over 1.2 s, then are skipped (never baked).
    for (let q = dying.length - 1; q >= 0; q--) {
      const d = dying[q], i = d.i;
      if (i >= seen || !(appearAt[i] <= now) || N.parent[i] < 0) { dying.splice(q, 1); continue; }
      if (d.at < 0) d.at = now;
      const fa = 1 - (now - d.at) / 1200;
      if (fa <= 0) { dying.splice(q, 1); continue; }
      segEnds(i, RP, 0, 0, 1, SEG);
      const wb = wBucket(N.dist[i]);
      ctx.strokeStyle = rgbStr(mix(tintCur.e, RGB.scar, 0.35 * (1 - fa)));
      ctx.lineWidth = WB_WF[wb] * LS; ctx.globalAlpha = WB_ALPHA[wb] * netA * fa;
      ctx.beginPath(); ctx.moveTo(SEG[0], SEG[1]); ctx.lineTo(SEG[2], SEG[3]); ctx.stroke();
    }
    // Anastomosis links (thin).
    const lk = org.links;
    if (lk.length) {
      ctx.beginPath();
      let any = false;
      for (let q = 0; q < lk.length; q += 2) {
        const a = lk[q], b = lk[q + 1];
        if (a >= seen || b >= seen || !N.alive[a] || !N.alive[b]) continue;
        if (appearAt[a] + GROW_MS > now || appearAt[b] > now) continue;
        ctx.moveTo(N.x[a] * RP, N.y[a] * RP); ctx.lineTo(N.x[b] * RP, N.y[b] * RP); any = true;
      }
      if (any) {
        ctx.strokeStyle = rgbStr(tintCur.e); ctx.lineWidth = Math.max(0.5, 0.6 * LS); ctx.globalAlpha = 0.4 * netA;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Path of segments whose graph distance lies in [lo, hi] (via distance buckets). */
  function bandPath(lo, hi, now) {
    const N = org.nodes;
    const b0 = Math.max(0, Math.floor(lo / BUCKET)), b1 = Math.floor(hi / BUCKET);
    let any = false;
    ctx.beginPath();
    for (let b = b0; b <= b1; b++) {
      const arr = buckets[b];
      if (!arr) continue;
      for (let q = 0; q < arr.length; q++) {
        const i = arr[q], d = N.dist[i];
        if (d < lo || d > hi || !N.alive[i] || N.parent[i] < 0) continue;
        const ap = appearAt[i];
        if (ap > now) continue;
        const g = !rm && Q.growIn ? clamp01((now - ap) / GROW_MS) : 1;
        segEnds(i, RP, 0, 0, g, SEG);
        ctx.moveTo(SEG[0], SEG[1]); ctx.lineTo(SEG[2], SEG[3]);
        any = true;
      }
    }
    return any;
  }

  /** Blink heartbeat: a wavefront through graph distance at 1.1 units/s (§6.6). */
  function drawPulses(now) {
    if (!pulses.length || !org) return;
    const md = Math.max(0.05, maxDistSeen);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.strokeStyle = CORE_STR;
    for (let q = pulses.length - 1; q >= 0; q--) {
      const el = (now - pulses[q].t0) / 1000;
      if (el < 0) continue;
      const w = 1.1 * el;
      if (w - 0.07 > md) { pulses.splice(q, 1); continue; }
      const a = 0.9 * (0.35 + 0.65 * Fs) * (1 - w / md) * orgVis;
      if (a <= 0.004) continue;
      const lw = wfOf(Math.max(0, w)) * LS;
      if (bandPath(w - 0.07, w - 0.024, now)) { ctx.lineWidth = lw * 1.1; ctx.globalAlpha = clamp01(a * 0.4); ctx.stroke(); }
      if (bandPath(w - 0.024, w, now)) { ctx.lineWidth = lw * 1.35; ctx.globalAlpha = clamp01(a); ctx.stroke(); }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  function drawFruitWave(now) {
    if (!fruit || !(fruit.wave >= 0) || !org) return;
    const w = fruit.wave, lw = wfOf(w) * LS;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.strokeStyle = CORE_STR;
    if (bandPath(w - 0.06, w, now)) {
      ctx.globalAlpha = 0.28 * orgVis; ctx.lineWidth = lw * 4; ctx.stroke();
      ctx.globalAlpha = orgVis; ctx.lineWidth = lw * 1.5; ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  /** Growing tips: the newest alive leaves (< 120 s), core sprites with flicker and drain. */
  function drawTips(now) {
    if (!org || orgVis < 0.02) return;
    const N = org.nodes, cur = org.length - 1, max = Q.tips, spr = getSprite(RGB.core);
    const base = (0.6 + 0.4 * Fs) * orgVis * Math.min(1, lumMul * 1.05);
    const k = Math.max(0.55, RP / RfullDev);
    let n = 0;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = seen - 1; i >= 1 && n < max; i--) {
      if (N.born[i] < cur - 120 && N.born[i] >= 0) break;
      if (!N.alive[i] || N.children[i] !== 0 || appearAt[i] > now) continue;
      const fp = freshProgress(i, now);
      if (fp[1] <= 0) continue;
      segEnds(i, RP, 0, 0, fp[0], SEG);
      const flick = vnoise(flickT * 0.006 + i * 7.31);
      let a = base * (1 - 0.6 * (1 - Fs) * flick) * fp[1];
      if (flinch > 0.01) {
        const r = Math.sqrt(N.x[i] * N.x[i] + N.y[i] * N.y[i]) || 1;
        if ((N.x[i] * flinchUx + N.y[i] * flinchUy) / r > 0.3) a *= 1 - 0.8 * flinch;
      }
      if (a <= 0.01) { n++; continue; }
      const age = Math.max(0, cur - N.born[i]);
      const gr = (3 - 1.5 * clamp01(age / 120)) * dpr * k * 2.4;
      ctx.globalAlpha = clamp01(a);
      ctx.drawImage(spr, SEG[2] - gr, SEG[3] - gr, gr * 2, gr * 2);
      n++;
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  /** The white-hot core, violet depth halo and state tint (§6.1 step 5). */
  function drawCore(now) {
    if (!org || orgVis < 0.01) return;
    const fl = flashValue(now);
    const rc = Math.max(1, (0.04 + 0.1 * Ds) * RP * (1 - 0.45 * kAbs) * (1 + 0.5 * fl));
    const a = clamp01((0.5 + 0.5 * Fs) * orgVis * (0.7 + 0.3 * Math.min(1, lumMul)) + fl);
    ctx.globalCompositeOperation = 'lighter';
    if (Ds > 0.2) {
      const vr = RP * (0.12 + 0.2 * Ds);
      ctx.globalAlpha = 0.22 * smoothstep(0.2, 1, Ds) * orgVis * Math.min(1, lumMul);
      ctx.drawImage(getSprite(RGB.flow), -vr, -vr, vr * 2, vr * 2);
    }
    const gr = rc * 2.5;
    ctx.globalAlpha = a * (1 - 0.6 * kState);
    ctx.drawImage(getSprite(RGB.core), -gr, -gr, gr * 2, gr * 2);
    if (kState > 0.03) {
      ctx.globalAlpha = a * kState * 0.85;
      ctx.drawImage(getSprite(tintPal), -gr * 1.2, -gr * 1.2, gr * 2.4, gr * 2.4);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = clamp01(a * 0.9);
    ctx.fillStyle = kAbs > 0.5 ? rgbStr(mix(RGB.core, RGB.frost, 0.5)) : CORE_STR;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.8, 0.012 * RP), 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** The lone breathing spore (idle, loading, calibrating). */
  let sporeFil = null;
  function drawSpore(now) {
    if (sporeVis < 0.01) return;
    const br = rm ? 1 : 1 + 0.06 * Math.sin((TAU * now) / 5000);
    const r = Math.max(1.2, 0.035 * RP * br), fl = flashValue(now);
    const a = clamp01(sporeVis);
    ctx.globalCompositeOperation = 'lighter';
    let g = r * 7;
    ctx.globalAlpha = 0.32 * a;
    ctx.drawImage(getSprite(RGB.hypha), -g, -g, g * 2, g * 2);
    g = r * 3.2;
    ctx.globalAlpha = clamp01((0.75 + fl) * a);
    ctx.drawImage(getSprite(RGB.core), -g, -g, g * 2, g * 2);
    ctx.globalCompositeOperation = 'source-over';
    // Five faint curved hyphae: the i-spore motif.
    if (!sporeFil) {
      const rng = U.rng(5), th0 = TAU * rng();
      sporeFil = [];
      for (let k = 0; k < 5; k++) sporeFil.push({ a: th0 + (k * TAU) / 5 + (rng() - 0.5) * 0.3, len: 0.06 + 0.03 * rng(), curl: (rng() < 0.5 ? -1 : 1) * (0.35 + 0.35 * rng()) });
    }
    const sway = rm ? 0 : 0.05 * Math.sin((TAU * now) / 7000);
    ctx.strokeStyle = rgbaStr(RGB.hypha, 0.38 * a); ctx.lineWidth = Math.max(0.7, 1.1 * dpr * Math.min(1, RP / RfullDev + 0.3));
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const f of sporeFil) {
      const a0 = f.a + sway, L0 = r * 1.3, L1 = f.len * RP * br;
      const mx = Math.cos(a0 + f.curl * 0.5) * (L0 + L1) * 0.55, my = Math.sin(a0 + f.curl * 0.5) * (L0 + L1) * 0.55;
      ctx.moveTo(Math.cos(a0) * L0, Math.sin(a0) * L0);
      ctx.quadraticCurveTo(mx, my, Math.cos(a0 + f.curl) * (L0 + L1), Math.sin(a0 + f.curl) * (L0 + L1));
    }
    ctx.stroke();
    ctx.globalAlpha = a;
    ctx.fillStyle = CORE_STR;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawIdleMotes(now, dt) {
    idleMoteA = U.damp(idleMoteA, I.phase === 'idle' ? 1 : 0, 600, dt);
    if (idleMoteA < 0.01) return;
    if (!idleMotes) {
      const rng = U.rng(0x1d1e);
      idleMotes = [];
      for (let k = 0; k < 8; k++) idleMotes.push({ r: 0.3 + 0.65 * rng(), a: TAU * rng(), sp: (rng() < 0.5 ? -1 : 1) * (0.00004 + 0.00007 * rng()), bob: 0.02 + 0.04 * rng(), ph: TAU * rng(), size: 1 + 0.8 * rng() });
    }
    const t = rm ? 0 : now, spr = getSprite(RGB.hypha);
    ctx.globalCompositeOperation = 'lighter';
    for (const m of idleMotes) {
      const ang = m.a + m.sp * t, rr = (m.r + m.bob * Math.sin(t * 0.0004 + m.ph)) * RP;
      const gr = m.size * dpr * 2.6;
      ctx.globalAlpha = 0.5 * idleMoteA;
      ctx.drawImage(spr, Math.cos(ang) * rr - gr, Math.sin(ang) * rr - gr, gr * 2, gr * 2);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  function drawMarksLayer() {
    if (!org || !Lmarks || orgVis < 0.01) return;
    const lr = layerRect();
    ctx.globalAlpha = orgVis * (0.72 + 0.28 * Math.min(1, lumMul));
    ctx.drawImage(Lmarks, lr[0], lr[0], lr[1], lr[1]);
    ctx.globalAlpha = 1;
  }

  function drawHairline() {
    const ph = I.phase;
    if (!org || orgVis < 0.05 || !(ph === 'running' || ph === 'paused' || ph === 'break')) return;
    const r = org.front(org.length - 1) * RP;
    ctx.strokeStyle = rgbaStr(RGB.hypha, 0.06 * orgVis); ctx.lineWidth = Math.max(0.6, dpr);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  }

  /** Drain (flinch), sink (phone), aperture (eyes closed), dormant motes. */
  function drawOverlays(now) {
    const RR = 1.06 * RP;
    if (flinch > 0.005) {
      const cx = flinchUx * RP, cy = flinchUy * RP;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1.2 * RP);
      g.addColorStop(0, rgbaStr(RGB.abyss, 0.6 * flinch)); g.addColorStop(1, rgbaStr(RGB.abyss, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, RR, 0, TAU); ctx.fill();
    }
    if (sink > 0.005) {
      const g = ctx.createLinearGradient(0, -RR, 0, -RR + 1.2 * RR);
      g.addColorStop(0, rgbaStr(RGB.abyss, 0.7 * sink)); g.addColorStop(1, rgbaStr(RGB.abyss, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, RR, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      const gr = 0.55 * RP;
      ctx.globalAlpha = 0.16 * sink;
      ctx.drawImage(getSprite(RGB.hypha), -gr, 0.92 * RP - gr * 0.6, gr * 2, gr * 1.2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgbaStr(RGB.hypha, 0.35 * sink); ctx.lineWidth = 3 * dpr; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, RR, 20 * DEG, 160 * DEG); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (aperture > 0.005) {
      const ar = Math.max(0.3, 1.1 - 0.3 * (1 - eo)) * RP;
      const g = ctx.createRadialGradient(0, 0, ar * 0.55, 0, 0, ar);
      g.addColorStop(0, rgbaStr(RGB.abyss, 0)); g.addColorStop(1, rgbaStr(RGB.abyss, 0.72 * aperture));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, RR, 0, TAU); ctx.fill();
    }
    if (kAbs > 0.01) drawDormantMotes(now);
  }

  function drawDormantMotes(now) {
    if (!dormantMotes) {
      const rng = U.rng(0xd0a7);
      dormantMotes = [];
      for (let k = 0; k < 12; k++) dormantMotes.push({ r: 0.2 + 0.7 * rng(), a: TAU * rng(), sp: 0.02 * (0.8 + 0.45 * rng()) });
    }
    const t = rm ? 0 : now / 1000, col = mix(RGB.frost, RGB.core, 0.35), spr = getSprite(col);
    ctx.lineCap = 'round'; ctx.lineWidth = Math.max(0.6, dpr);
    for (const m of dormantMotes) {
      const ang = m.a + m.sp * t, rr = m.r * RP;
      for (let s = 0; s < 3; s++) {
        ctx.strokeStyle = rgbaStr(col, kAbs * 0.34 * (1 - s / 3));
        ctx.beginPath(); ctx.arc(0, 0, rr, ang - (25 * DEG * (s + 1)) / 3, ang - (25 * DEG * s) / 3); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const m of dormantMotes) {
      const ang = m.a + m.sp * t, rr = m.r * RP, gr = 2.2 * dpr * 2.4;
      ctx.globalAlpha = 0.75 * kAbs;
      ctx.drawImage(spr, Math.cos(ang) * rr - gr, Math.sin(ang) * rr - gr, gr * 2, gr * 2);
    }
    // The glow collapses into a frost-blue spore.
    const sr = 0.07 * RP;
    ctx.globalAlpha = 0.7 * kAbs;
    ctx.drawImage(getSprite(RGB.frost), -sr, -sr, sr * 2, sr * 2);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  /* ---------------- Break: lid fog + dew (§6.7) ---------------- */
  function drawFog(now) {
    if (fogA < 0.004 || !Lfog) return;
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, 1.02 * RP, 0, TAU); ctx.clip();
    if (!rm) ctx.rotate(now * 0.00003);
    const s = 1.3 * RP;
    ctx.globalAlpha = fogA;
    ctx.drawImage(Lfog, -s, -s, s * 2, s * 2);
    ctx.restore();
  }
  function drawDew(now) {
    if (dewFade < 0.01) return;
    if (!dewBeads) {
      const rng = U.rng(U.hashString('dew:' + (org ? org.seed : 1)));
      dewBeads = [];
      while (dewBeads.length < 36) {
        const x = (rng() * 2 - 1) * 0.9, y = (rng() * 2 - 1) * 0.9;
        if (x * x + y * y > 0.81) continue;
        dewBeads.push({ x: x, y: y, r: 0.012 + 0.016 * rng() });
      }
    }
    if (I.phase === 'break') {
      const vis = Math.round(36 * I.lookAway);
      for (let k = 0; k < vis; k++) if (beadAt[k] < 0) beadAt[k] = now;
    }
    const lw = Math.max(0.6, dpr);
    for (let k = 0; k < 36; k++) {
      if (beadAt[k] < 0) continue;
      const t = clamp01((now - beadAt[k]) / 400);
      const sc = rm ? 1 : easeOut(t), fa = (rm ? t : Math.min(1, t * 2)) * dewFade;
      const b = dewBeads[k], r = Math.max(0.5, b.r * RP * sc), x = b.x * RP, y = b.y * RP;
      ctx.fillStyle = 'rgba(239,255,248,' + (0.08 * fa).toFixed(3) + ')';
      ctx.strokeStyle = 'rgba(239,255,248,' + (0.35 * fa).toFixed(3) + ')';
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(239,255,248,' + (0.7 * fa).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x - 0.38 * r, y - 0.38 * r, Math.max(0.4, 0.25 * r), 0, TAU); ctx.fill();
    }
  }

  function drawRim(now) {
    if (rimVis < 0.01) return;
    if (I.rimProgress != null) lastRim = I.rimProgress;
    const r = 1.045 * RP, brk = I.phase === 'break';
    ctx.lineCap = 'round'; ctx.lineWidth = 2 * dpr;
    ctx.globalAlpha = rimVis;
    ctx.strokeStyle = 'rgba(207,230,223,.06)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    const p = lastRim;
    if (p > 0.0005) {
      const end = -Math.PI / 2 + TAU * p;
      ctx.strokeStyle = brk ? rgbaStr(RGB.core, 0.45) : rgbaStr(RGB.hypha, 0.55);
      ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, end); ctx.stroke();
      const gr = 5 * dpr;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * rimVis;
      ctx.drawImage(getSprite(brk ? RGB.core : RGB.hypha), Math.cos(end) * r - gr, Math.sin(end) * r - gr, gr * 2, gr * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- Fruiting art: caps, lid, kintsugi glints ---------------- */
  function capScale(c, now) {
    if (c.openAt == null) return 0;
    return easeOutBack((now - c.openAt) / 800);
  }
  function drawFruitArt(now) {
    const caps = fruit ? fruit.caps : finalCaps;
    if (caps && caps.length && org && orgVis > 0.01) {
      for (const c of caps) {
        const sc = fruit ? capScale(c, now) : 1;
        drawCap(ctx, c.x * RP, c.y * RP, c.theta, c.size * RP, sc, capsAlpha * orgVis, Math.max(0.35, LS));
      }
    }
    if (lidAmt > 0.001 && orgVis > 0.01) drawLid(lidAmt * orgVis);
  }
  function drawLid(a) {
    const r = 1.06 * RP;
    ctx.save();
    const sh = ctx.createRadialGradient(-0.35 * r, -0.45 * r, 0, -0.35 * r, -0.45 * r, 0.95 * r);
    sh.addColorStop(0, 'rgba(239,255,248,' + (0.045 * a).toFixed(3) + ')'); sh.addColorStop(1, 'rgba(239,255,248,0)');
    ctx.fillStyle = sh;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgbaStr(RGB.text, 0.1 + 0.16 * a); ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    const end = -160 * DEG + 140 * DEG * easeOut(a);
    ctx.globalAlpha = Math.min(1, a * 1.5);
    ctx.strokeStyle = 'rgba(239,255,248,.35)'; ctx.lineWidth = 3 * dpr;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.965, -160 * DEG, end); ctx.stroke();
    ctx.restore();
  }
  function drawGlints(now) {
    if (!glints.length || !org) return;
    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    for (let q = glints.length - 1; q >= 0; q--) {
      const gl = glints[q], t = (now - gl.t0) / gl.dur;
      if (t < 0) continue;
      if (t > 1) { glints.splice(q, 1); continue; }
      const geo = scarGeom(gl.e, org.seed), rho = (org.front(gl.e.t0) + 0.006) * RP;
      const a0 = geo.full ? -Math.PI / 2 : geo.a - geo.span / 2, span = geo.full ? TAU : geo.span;
      const pos = a0 + span * easeInOut(t), from = Math.max(a0, pos - 0.35 * span);
      const fade = t < 0.85 ? 1 : (1 - t) / 0.15;
      ctx.strokeStyle = rgbaStr(RGB.gold, 0.9 * fade); ctx.lineWidth = Math.max(1.4 * dpr, 2.4 * LS);
      ctx.globalAlpha = 1;
      if (pos > from) { ctx.beginPath(); ctx.arc(0, 0, rho, from, pos); ctx.stroke(); }
      const hx = Math.cos(pos) * rho, hy = Math.sin(pos) * rho;
      let gr = 11 * dpr;
      ctx.globalAlpha = 0.9 * fade; ctx.drawImage(getSprite(RGB.gold), hx - gr, hy - gr, gr * 2, gr * 2);
      gr = 5 * dpr;
      ctx.globalAlpha = fade; ctx.drawImage(getSprite(RGB.core), hx - gr, hy - gr, gr * 2, gr * 2);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  /* =================================================================== *
   * Screen-space UI art (after bloom): loading ring, rings, calibration  *
   * =================================================================== */
  function drawLoadingRing(now) {
    if (I.phase !== 'loading') return;
    const lit = Math.floor(48 * (I.loading || 0));
    for (let k = 0; k < 48; k++) if (k < lit && litAt[k] < 0) litAt[k] = now;
    const r0 = 0.55 * RP, dotR = Math.max(0.8, 1.3 * dpr);
    ctx.fillStyle = 'rgba(207,230,223,.13)';
    ctx.beginPath();
    for (let k = 0; k < 48; k++) {
      if (litAt[k] >= 0) continue;
      const a = -Math.PI / 2 + (k * TAU) / 48, x = Math.cos(a) * r0, y = Math.sin(a) * r0;
      ctx.moveTo(x + dotR, y); ctx.arc(x, y, dotR, 0, TAU);
    }
    ctx.fill();
    const sprH = getSprite(RGB.hypha);
    ctx.fillStyle = CORE_STR;
    for (let k = 0; k < 48; k++) {
      if (litAt[k] < 0) continue;
      const e = rm ? 1 : easeOut((now - litAt[k]) / 600);
      const a = -Math.PI / 2 + (k * TAU) / 48, rr = lerp(0.8, 0.55, e) * RP;
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr, al = 0.35 + 0.65 * e;
      const gr = 7 * dpr;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * al;
      ctx.drawImage(sprH, x - gr, y - gr, gr * 2, gr * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = al;
      ctx.beginPath(); ctx.arc(x, y, (1.2 + 0.8 * e) * dpr, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawRings(now) {
    if (!rings.length) return;
    ctx.lineCap = 'round';
    for (let q = rings.length - 1; q >= 0; q--) {
      const rg = rings[q];
      if (rg.kind === 'welcome') {
        const t = (now - rg.t0) / 1200;
        if (t > 1) { rings.splice(q, 1); continue; }
        if (t < 0) continue;
        const r = (rm ? 0.6 : 1.1 * easeOut(t)) * RP, a = 0.5 * (1 - t);
        ctx.strokeStyle = rgbaStr(RGB.core, 0.15 * (1 - t)); ctx.lineWidth = 7 * dpr;
        ctx.beginPath(); ctx.arc(0, 0, Math.max(1, r), 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgbaStr(RGB.core, a); ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(0, 0, Math.max(1, r), 0, TAU); ctx.stroke();
      } else {
        const t = (now - rg.t0) / 900;
        if (t > 1) { rings.splice(q, 1); continue; }
        if (t < 0) continue;
        const rho = rg.angle == null || !org ? 0 : org.front(org.length - 1) * RP;
        const px = rg.angle == null ? 0 : Math.cos(rg.angle) * rho, py = rg.angle == null ? 0 : Math.sin(rg.angle) * rho;
        const e = rm ? 1 : easeOut(t), a = 0.7 * (1 - t);
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, 1.06 * RP, 0, TAU); ctx.clip();
        ctx.strokeStyle = rgbaStr(RGB.gold, a); ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath(); ctx.arc(px, py, Math.max(1, (0.04 + 0.34 * e) * RP), 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgbaStr(RGB.gold, a * 0.45); ctx.lineWidth = 1.1 * dpr;
        ctx.beginPath(); ctx.arc(px, py, Math.max(1, (0.02 + 0.2 * e) * RP), 0, TAU); ctx.stroke();
        const gr = (18 + 10 * e) * dpr;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5 * (1 - t);
        ctx.drawImage(getSprite(RGB.gold), px - gr, py - gr, gr * 2, gr * 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function sproutShape(k) {
    if (!sproutShapes[k]) {
      const rng = U.rng(0x5900 + k), th0 = TAU * rng(), out = [];
      for (let j = 0; j < 5; j++) out.push({ a: th0 + (j * TAU) / 5 + (rng() - 0.5) * 0.5, len: 10 + 8 * rng(), curl: (rng() < 0.5 ? -1 : 1) * (0.3 + 0.6 * rng()) });
      sproutShapes[k] = out;
    }
    return sproutShapes[k];
  }
  function drawSprout(x, y, k, el) {
    const g = rm ? 1 : easeOut(el / 500);
    const shape = sproutShape(k);
    ctx.strokeStyle = rgbaStr(RGB.hypha, 0.85); ctx.lineWidth = 1.3 * dpr; ctx.lineCap = 'round';
    ctx.beginPath();
    const tips = [];
    for (const f of shape) {
      let px = x + Math.cos(f.a) * 3 * dpr, py = y + Math.sin(f.a) * 3 * dpr;
      ctx.moveTo(px, py);
      const steps = 8, total = f.len * dpr * g;
      for (let s = 1; s <= steps; s++) {
        const ang = f.a + f.curl * (s / steps) * g;
        px += Math.cos(ang) * (total / steps); py += Math.sin(ang) * (total / steps);
        ctx.lineTo(px, py);
      }
      tips.push(px, py);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    const sc = getSprite(RGB.core);
    let gr = 12 * dpr;
    ctx.globalAlpha = 0.55; ctx.drawImage(getSprite(RGB.hypha), x - gr, y - gr, gr * 2, gr * 2);
    gr = 2.6 * dpr;
    ctx.globalAlpha = 0.8 * g;
    for (let q = 0; q < tips.length; q += 2) ctx.drawImage(sc, tips[q] - gr, tips[q + 1] - gr, gr * 2, gr * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.95; ctx.fillStyle = CORE_STR;
    ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  function drawCalibration(now) {
    const cal = I.calibration;
    if (I.phase !== 'calibrating' || !cal) return;
    const pts = cal.points;
    const activeIndex = fin(+cal.activeIndex, -1);
    const prog = clamp01(fin(+cal.activeProgress, 0));
    const dim = cal.faceFound === false ? 0.4 : 1;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (!p) continue;
      const x = clamp01(fin(+p.x, 0.5)) * BW, y = clamp01(fin(+p.y, 0.5)) * BH;
      const centre = Math.abs(fin(+p.x, 0) - 0.5) < 0.02 && Math.abs(fin(+p.y, 0) - 0.5) < 0.02;
      if (p.state === 'done') {
        if (!(sproutAt[k] > 0)) sproutAt[k] = now;
        drawSprout(x, y, k, now - sproutAt[k]);
        continue;
      }
      sproutAt[k] = 0;
      if (p.state === 'active' || k === activeIndex) {
        const pr = rm ? 1 : 1 + 0.15 * Math.sin((TAU * now) / 900);
        if (!centre) {
          const gr = 20 * dpr;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.4 * dim;
          ctx.drawImage(getSprite(RGB.hypha), x - gr, y - gr, gr * 2, gr * 2);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = dim; ctx.fillStyle = CORE_STR;
          ctx.beginPath(); ctx.arc(x, y, 6 * dpr * pr, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = dim; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(207,230,223,.14)'; ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.arc(x, y, 18 * dpr, 0, TAU); ctx.stroke();
        if (prog > 0.001) {
          ctx.strokeStyle = rgbStr(RGB.hypha); ctx.lineWidth = 2 * dpr;
          ctx.beginPath(); ctx.arc(x, y, 18 * dpr, -Math.PI / 2, -Math.PI / 2 + TAU * prog); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (!centre) {
        ctx.globalAlpha = 0.35; ctx.fillStyle = CORE_STR;
        ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
  function cornersFrom(points) {
    let src = DEFAULT_CORNERS; // SPEC-GAP: centre-only calibrations draw the default box as the frame
    if (Array.isArray(points) && points.length >= 5) {
      const c = points.slice(1, 5).map((p) => [clamp01(fin(+(p && p.x), 0)), clamp01(fin(+(p && p.y), 0))]);
      if (c.every((q) => isFinite(q[0]) && isFinite(q[1]))) src = c;
    }
    return src;
  }
  function drawCalFrame(now) {
    if (!calFrame) return;
    const el = now - calFrame.t0;
    if (el > 2000) { calFrame = null; return; }
    if (el < 0) return;
    const alpha = 0.5 * (el < 1200 ? 1 : 1 - (el - 1200) / 800);
    const prog = (rm ? 1 : clamp01(el / 700)) * 4;
    const c = calFrame.pts;
    const P = (k) => [c[k % 4][0] * BW, c[k % 4][1] * BH];
    ctx.strokeStyle = rgbaStr(RGB.hypha, alpha); ctx.lineWidth = 1.5 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    let p0 = P(0), head = p0;
    ctx.moveTo(p0[0], p0[1]);
    for (let s = 0; s < 4; s++) {
      const a = P(s), b = P(s + 1);
      if (prog >= s + 1) { ctx.lineTo(b[0], b[1]); head = b; }
      else if (prog > s) { const f = prog - s; head = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; ctx.lineTo(head[0], head[1]); break; }
      else break;
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    const gr = 9 * dpr;
    ctx.globalAlpha = clamp01(alpha * 1.6);
    if (prog < 4) ctx.drawImage(getSprite(RGB.core), head[0] - gr, head[1] - gr, gr * 2, gr * 2);
    for (let k = 0; k < 4; k++) { const q = P(k); ctx.drawImage(getSprite(RGB.hypha), q[0] - gr, q[1] - gr, gr * 2, gr * 2); }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  /* =================================================================== *
   * Particles (spores, bursts) — decorative, Math.random allowed        *
   * =================================================================== */
  function spawnParticle(x, y, vx, vy, life, size, kind, rampId) {
    if (pN >= PMAX) return;
    const i = pN++;
    pX[i] = x; pY[i] = y; pX0[i] = x; pVX[i] = vx; pVY[i] = vy;
    pAge[i] = 0; pLife[i] = life; pSize[i] = size; pKind[i] = kind; pRamp[i] = rampId;
    pPh[i] = Math.random() * TAU;
    if (kind === 0) sporeCount++;
  }
  function removeParticle(i) {
    if (pKind[i] === 0) sporeCount--;
    const j = --pN;
    if (i !== j) {
      pX[i] = pX[j]; pY[i] = pY[j]; pX0[i] = pX0[j]; pVX[i] = pVX[j]; pVY[i] = pVY[j];
      pAge[i] = pAge[j]; pLife[i] = pLife[j]; pSize[i] = pSize[j]; pKind[i] = pKind[j]; pRamp[i] = pRamp[j]; pPh[i] = pPh[j];
    }
  }
  function updateParticles(dt) {
    const s = dt / 1000, drag = Math.exp(-s * 1.2), sway = 6 * dpr;
    for (let i = 0; i < pN;) {
      pAge[i] += dt;
      if (pAge[i] >= pLife[i]) { removeParticle(i); continue; }
      if (pKind[i] === 0) {
        pY[i] += pVY[i] * s;
        pX[i] = pX0[i] + sway * Math.sin(pPh[i] + pAge[i] * 0.0016);
      } else {
        pVX[i] *= drag; pVY[i] *= drag;
        pX[i] += pVX[i] * s; pY[i] += pVY[i] * s;
      }
      i++;
    }
  }
  function drawParticles() {
    if (!pN) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pN; i++) {
      const age = pAge[i], life = pLife[i];
      const env = Math.min(1, age / 400) * Math.min(1, (life - age) / (pKind[i] === 0 ? 1500 : 450));
      if (env <= 0.005) continue;
      const gr = pSize[i] * 2.4;
      ctx.globalAlpha = clamp01(env * (pKind[i] === 0 ? 0.8 : 1));
      ctx.drawImage(ramp(pRamp[i], age / life), pX[i] - gr, pY[i] - gr, gr * 2, gr * 2);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  function burst(x, y, n, vmin, vmax, life, rampId, size) {
    if (rm) return;
    for (let k = 0; k < n; k++) {
      const a = TAU * Math.random(), v = (vmin + (vmax - vmin) * Math.random()) * dpr;
      spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.7 + 0.6 * Math.random()), size * dpr * (0.7 + 0.6 * Math.random()), 1, rampId);
    }
  }
  function spawnSpores(now, dt) {
    if (rm || !org) { sporeAcc = 0; return; }
    if (I.phase === 'running' && !fruit && Fs > 0.7 && orgVis > 0.5 && kUnseen < 0.5) {
      sporeAcc += (6 * smoothstep(0.3, 1, Ds) * dt) / 1000;
      const N = org.nodes, lim = 0.8 * org.front(org.length - 1), lim2 = lim * lim;
      while (sporeAcc >= 1) {
        sporeAcc -= 1;
        if (sporeCount >= Q.spores || seen < 2) continue;
        for (let tries = 0; tries < 8; tries++) {
          const i = Math.floor(Math.random() * seen);
          if (!N.alive[i] || appearAt[i] > now) continue;
          const x = N.x[i], y = N.y[i];
          if (x * x + y * y > lim2) continue;
          spawnParticle(DX + x * RP, DY + y * RP, 0, -(8 + 8 * Math.random()) * dpr, 4000 + 4000 * Math.random(), (1.5 + 1.5 * Math.random()) * dpr, 0, 0);
          break;
        }
      }
    } else sporeAcc = 0;
    // A fruited specimen keeps shedding a few gold spores from its caps.
    const caps = fruit ? null : finalCaps;
    if (caps && caps.length && orgVis > 0.5 && (I.phase === 'complete' || I.phase === 'fruiting')) {
      capSporeAcc += (1.4 * dt) / 1000;
      while (capSporeAcc >= 1) {
        capSporeAcc -= 1;
        if (sporeCount >= Q.spores) continue;
        const c = caps[Math.floor(Math.random() * caps.length)];
        const off = c.size * 0.4;
        spawnParticle(DX + (c.x + Math.cos(c.theta) * off) * RP, DY + (c.y + Math.sin(c.theta) * off) * RP, 0, -(6 + 8 * Math.random()) * dpr, 3500 + 3000 * Math.random(), (1.2 + 1.3 * Math.random()) * dpr, 0, 2);
      }
    } else capSporeAcc = 0;
  }

  /* ---------------- Bloom (§6.1 step 9): downsample ¼ → ⅛, add back ---------------- */
  function doBloom() {
    if (!Q.bloom || !gBloomQ || !gBloomE) return;
    frameNo++;
    const qw = LbloomQ.width, qh = LbloomQ.height, ew = LbloomE.width, eh = LbloomE.height;
    if (!bloomValid || frameNo % Q.bloom === 0) {
      gBloomQ.globalCompositeOperation = 'source-over'; gBloomQ.globalAlpha = 1;
      gBloomQ.drawImage(canvas, 0, 0, BW, BH, 0, 0, qw, qh);
      gBloomE.globalCompositeOperation = 'source-over'; gBloomE.globalAlpha = 1;
      gBloomE.drawImage(LbloomQ, 0, 0, qw, qh, 0, 0, ew, eh);
      bloomValid = true;
    }
    const a = 0.18 + 0.3 * Fs;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.drawImage(LbloomE, 0, 0, ew, eh, 0, 0, BW, BH);
    if (level === 'high') { ctx.globalAlpha = a * 0.3; ctx.drawImage(LbloomQ, 0, 0, qw, qh, 0, 0, BW, BH); }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  /* =================================================================== *
   * The Fruiting (§6.8)                                                  *
   * =================================================================== */
  let fruitDone = false;
  function finishFruit() {
    const f = fruit;
    if (!f) return;
    fruit = null;
    if (f.timer) clearTimeout(f.timer);
    for (const c of f.caps) c.openAt = -1e12;
    finalCaps = f.caps; fruitDone = true;
    lidAmt = 1; capsAlpha = 1; fruitLum = 1.15;
    if (typeof f.resolve === 'function') { try { f.resolve(); } catch (e) { /* ignore */ } }
  }
  function resetFruit() {
    if (fruit) finishFruit();
    fruitDone = false; finalCaps = null; lidAmt = 0; capsAlpha = 1; fruitLum = 1;
    glints.length = 0;
  }
  function runFruit(now) {
    const f = fruit;
    if (!f) return;
    if (f.t0 == null) {
      f.t0 = now;
      pulses.length = 0;
      for (let i = 0; i < pN; i++) if (pKind[i] === 0) pLife[i] = Math.min(pLife[i], pAge[i] + 400);
      if (!f.rm && org) {
        const mends = org.analysis.episodes.filter((e) => e.mended).sort((a, b) => a.t0 - b.t0);
        // 250 ms apart, compressed so the last glint (700 ms) still ends by 4200 ms.
        const n = mends.length, spacing = n > 1 ? Math.min(250, 1100 / (n - 1)) : 0;
        mends.forEach((e, k) => glints.push({ t0: now + 2400 + k * spacing, dur: 700, e: e }));
      }
    }
    const t = now - f.t0;
    if (f.rm) {
      const k = clamp01(t / 800);
      capsAlpha = k; lidAmt = k; fruitLum = 1 + 0.15 * k;
      if (!f.pullback) { f.pullback = true; laySnapped = false; }
      for (const c of f.caps) c.openAt = -1e12;
      if (t >= 800) finishFruit();
      return;
    }
    const wp = clamp01((t - 400) / 2800), w = easeInOut(wp) * f.maxDist;
    f.wave = t >= 400 && t <= 3200 ? w : -1;
    fruitLum = 1 + 0.15 * easeInOut(wp);
    if (t >= 400) {
      for (const c of f.caps) {
        if (c.openAt != null || (w < c.dist && wp < 1)) continue;
        c.openAt = now;
        const sx = DX + c.x * RP, sy = DY + c.y * RP;
        burst(sx, sy, 24, 20, 60, 1500, 2, 1.8);
      }
    }
    if (t >= 4400) f.pullback = true;
    lidAmt = clamp01((t - 4400) / 1000);
    if (t >= 6000) finishFruit();
  }

  /* =================================================================== *
   * Frame                                                                *
   * =================================================================== */
  let rawDt = 16.7, pendingPuff = false, growWarns = 0;

  function onPhase(ph, now) {
    const prev = curPhase;
    curPhase = ph; phaseSince = now;
    if (ph === 'break') beadAt.fill(-1);
    if (prev === 'loading' || ph === 'loading') litAt.fill(-1);
    if (ph === 'calibrating') sproutAt.length = 0;
    if (fruit && ph !== 'fruiting' && ph !== 'complete') finishFruit();
  }

  function handlePending() {
    if (pendingBurst) {
      pendingBurst = false;
      flash(0.5, 800);
      burst(DX, DY, 22, 18, 70, 1600, 1, 1.8);
    }
    if (pendingPuff) { pendingPuff = false; burst(DX, DY, 30, 20, 60, 1800, 0, 2); }
    while (pendingSeeds.length) {
      const s = pendingSeeds.shift();
      burst(s.x * BW, s.y * BH, 8, 15, 45, 1200, 1, 1.6);
    }
  }

  function frame(input) {
    readInput(input);
    const now = I.now;
    let dt = lastNow ? now - lastNow : 16.7;
    if (!(dt >= 0)) dt = 0;
    rawDt = dt;
    dt = Math.min(dt, 100);
    lastNow = now; NOW = now;
    if (!sized || currentDpr() !== dpr || canvas.width !== BW || canvas.height !== BH) resize(true);
    if (I.phase !== curPhase) onPhase(I.phase, now);

    smoothInputs(now, dt);
    if (fruit) runFruit(now);
    updateLayout(dt);

    let breath = 1;
    if (!rm && kUnseen < 0.5) {
      const period = I.phase === 'paused' ? 9000 : 5000;
      const normal = 1 + 0.04 * Math.sin((TAU * now) / period), slow = 0.9 + 0.1 * Math.sin((TAU * now) / 8000);
      breath = lerp(normal, slow, kSleep);
    }
    lum = lumMul * (0.55 + 0.45 * Fs) * breath * fruitLum;

    let ox = 0, oy = 0, fscale = 1;
    if (!rm) {
      ox -= flinchUx * 8 * flinch; oy -= flinchUy * 8 * flinch;
      fscale = 1 - 0.015 * flinch;
      if (kDrift > 0.01) {
        const sw = -4 * (1 - Fs) * kDrift * Math.sin((TAU * now) / 3300);
        ox += ux * sw; oy += uy * sw;
      }
      if (shiverOn && now - shiverAt < 400) {
        ox += 1.2 * Math.sin((TAU * 18 * now) / 1000);
        oy += 0.7 * Math.cos((TAU * 13 * now) / 1000);
      }
    }
    DX = (lay.cx + ox) * dpr; DY = (lay.cy + oy) * dpr;
    RP = Math.max(1, lay.r * dpr * fscale); LS = RP / 380;

    tintModel(Ds, tintRgb, kState, tintCur);
    syncNodes(now);
    bakeStep(now, BAKE_PER_FRAME);
    maybeTint(now);
    rebuildMarks(now, false);
    updateParticles(dt);
    handlePending();
    spawnSpores(now, dt);

    const c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.fillStyle = FT.PALETTE.abyss;
    c.fillRect(0, 0, BW, BH);
    if (Lhalo) {
      const hr = 2.1 * RP;
      c.globalAlpha = 0.55 + 0.45 * Fs * orgVis;
      c.drawImage(Lhalo, DX - hr, DY - hr, hr * 2, hr * 2);
      c.globalAlpha = 1;
    }
    c.setTransform(1, 0, 0, 1, DX, DY);
    drawDish(now);
    drawNetwork(now);
    drawPulses(now);
    drawFruitWave(now);
    drawTips(now);
    drawCore(now);
    drawSpore(now);
    drawIdleMotes(now, dt);
    drawMarksLayer();
    drawHairline();
    drawOverlays(now);
    drawFog(now);
    drawDew(now);
    drawGlints(now);
    drawFruitArt(now);
    drawRim(now);
    c.setTransform(1, 0, 0, 1, 0, 0);
    drawParticles();
    doBloom();
    c.setTransform(1, 0, 0, 1, DX, DY);
    drawLoadingRing(now);
    drawRings(now);
    c.setTransform(1, 0, 0, 1, 0, 0);
    drawCalibration(now);
    drawCalFrame(now);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }

  function setLevel(lv) {
    if (!QUALITY[lv] || lv === level) return;
    level = lv; Q = QUALITY[lv];
    if (canvas && ctx) resize(true);
    badMs = 0; goodMs = 0; emaInt = 16.7; emaCpu = Math.min(emaCpu, 4);
    qGraceUntil = NOW + 2000;
    FT.bus.emit('visual:quality', { quality: level, dpr: dpr });
  }
  function trackPerf(cpu) {
    lastCpu = cpu;
    const iv = rawDt;
    if (!(iv > 0) || iv > 250) return;
    const w = 1 - Math.exp(-iv / 1000);
    emaInt += (iv - emaInt) * w;
    emaCpu += (cpu - emaCpu) * w;
    if (!autoQ || NOW < qGraceUntil) return;
    if (emaInt > 20 || emaCpu > 10) { badMs += iv; goodMs = 0; }
    else { badMs = 0; if (emaInt < 17.5 && emaCpu < 5) goodMs += iv; else goodMs = 0; }
    const idx = QORDER.indexOf(level);
    if (badMs > 2000 && idx > 0) setLevel(QORDER[idx - 1]);
    else if (goodMs > 10000 && idx < QORDER.length - 1) setLevel(QORDER[idx + 1]);
  }

  function adoptOrganism(o) {
    org = o;
    allocRender();
    if (gGrown) { gGrown.clearRect(0, 0, S, S); gTinted.clearRect(0, 0, S, S); gMarks.clearRect(0, 0, S, S); }
    if (Ldish && sized) buildDish();
    dewBeads = null;
    tintDirty = true; marksDirty = true; marksKey = ''; marksLen = -1;
  }

  /* =================================================================== *
   * Public API (§4.5.1)                                                  *
   * =================================================================== */
  FT.Visual = {
    init(cv) {
      if (!cv || typeof cv.getContext !== 'function') { console.warn(LOG, 'init(): no canvas'); return; }
      if (initialised && cv === canvas) return;
      const c = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      if (!c) { console.warn(LOG, 'init(): no 2d context'); return; }
      canvas = cv; ctx = c;
      const narrow = (window.innerWidth || 1024) < 640;
      level = (FT.env && FT.env.coarse) || narrow ? 'medium' : 'high';
      Q = QUALITY[level];
      if (!org) adoptOrganism(createOrganism(1, { refActiveSec: 3000, retract: false }));
      curPhase = 'idle'; I.phase = 'idle';
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
      const t0 = performance.now();
      try { frame(input); }
      catch (err) {
        if (!errLogged) { errLogged = true; console.error(LOG, 'frame failed', err); }
        try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; } catch (e) { /* ignore */ }
      }
      trackPerf(performance.now() - t0);
    },

    newOrganism(seed, opts) {
      opts = opts || {};
      const s = +seed;
      adoptOrganism(createOrganism(isFinite(s) ? s : 1, { refActiveSec: opts.refActiveSec, retract: !!opts.retract }));
      resetFruit();
      pulses.length = 0; rings.length = 0;
      pendingBurst = true;
    },

    grow(rec, index) {
      if (!org) return;
      const want = org.length;
      if (index !== want) {
        if (growWarns++ < 5) console.warn(LOG, 'grow(): index ' + index + ' does not match grown length ' + want + '; ignored');
        return;
      }
      try {
        org.step(rec, index);
        const rem = org.lastRemoved;
        for (let k = 0; k < rem.length; k++) dying.push({ i: rem[k], at: -1 });
      } catch (err) { console.warn(LOG, 'grow() failed', err); }
    },

    prefill(steps, focus) {
      if (!org) adoptOrganism(createOrganism(1, { refActiveSec: 3000, retract: false }));
      const n = Math.max(0, Math.min(20000, Math.floor(+steps || 0)));
      const f = focus == null || !isFinite(+focus) ? 0.9 : clamp01(+focus);
      const start = org.length;
      for (let k = 0; k < n; k++) org.step({ s: 'F', f: f, d: n > 1 ? (0.8 * k) / (n - 1) : 0, a: null }, start + k);
      bakeAll();
      tintDirty = true; marksDirty = true;
    },

    pulse(kind, opts) {
      opts = opts || {};
      const now = performance.now();
      switch (kind) {
        case 'blink': {
          const ph = curPhase;
          if (ph === 'paused' || ph === 'break') { flash(0.1, 150); break; }
          if (rm) { flash(0.15, 200); break; }
          if (!(ph === 'running' || ph === 'intro')) { flash(0.1, 150); break; }
          pulses.push({ t0: now });
          while (pulses.length > Q.pulses) pulses.shift();
          flash(0.06, 220); // SPEC-GAP: a faint core tick with each wave, so the heartbeat reads on a young network
          break;
        }
        case 'milestone':
          if (rm) { flash(0.2, 300); break; }
          pulses.push({ t0: now }, { t0: now + 250 });
          while (pulses.length > Math.max(Q.pulses, 2)) pulses.shift();
          pendingPuff = true;
          break;
        case 'return': {
          const a = opts.angle;
          rings.push({ kind: 'return', t0: now, angle: typeof a === 'number' && isFinite(a) ? a : null });
          if (rm) flash(0.12, 300);
          break;
        }
        case 'welcome':
          rings.push({ kind: 'welcome', t0: now });
          flash(0.2, 500);
          break;
        case 'seed':
          pendingSeeds.push({ x: clamp01(fin(+opts.x, 0.5)), y: clamp01(fin(+opts.y, 0.5)) });
          break;
        case 'calibrated':
          calFrame = { t0: now, pts: cornersFrom(opts.points) };
          break;
        case 'mend': {
          marksDirty = true;
          if (!org || rm) break;
          const t0 = +opts.t0;
          const e = org.analysis.episodes.find((x) => x.t0 === t0);
          if (e) glints.push({ t0: now, dur: 900, e: e });
          break;
        }
        default: break;
      }
    },

    forgive(t0) {
      if (!org) return;
      try { if (org.forgive(+t0)) marksDirty = true; } catch (err) { console.warn(LOG, 'forgive() failed', err); }
    },

    startFruiting(record) {
      if (fruit) finishFruit();
      return new Promise((resolve) => {
        try {
          const tlr = record && record.timeline;
          if (tlr && typeof tlr.s === 'string') {
            const seed = recordSeed(record);
            // A forgiven organism grew from the pre-forgiveness codes; regrow so it matches drawSpecimen.
            if (!org || org.seed !== seed || org.edited || org.timeline.s !== tlr.s) {
              adoptOrganism(regrow(record));
              bakeAll();
            }
          }
          let caps = [];
          try { caps = computeCaps(org, record); } catch (e) { caps = []; }
          fruitDone = false; finalCaps = null; lidAmt = 0; fruitLum = 1;
          capsAlpha = rm ? 0 : 1;
          fruit = {
            t0: null, rm: rm, pullback: false, wave: -1, resolve: resolve, timer: 0,
            maxDist: Math.max(0.05, org ? org.maxDist : 0.05),
            caps: caps.map((c) => Object.assign({ openAt: null }, c)),
          };
          const f = fruit;
          // Safety net: resolve even if frames stop (hidden tab).
          f.timer = setTimeout(() => { if (fruit === f) finishFruit(); }, rm ? 1600 : 7500);
        } catch (err) {
          console.warn(LOG, 'startFruiting() failed', err);
          resolve();
        }
      });
    },

    skipFruiting() {
      if (!fruit) return;
      if (!fruit.pullback) laySnapped = false;
      glints.length = 0;
      finishFruit();
    },

    setReducedMotion(b) {
      rm = !!b;
      if (rm) { pN = 0; sporeCount = 0; pulses.length = 0; }
    },

    setQuality(q) {
      if (q === 'auto') { autoQ = true; badMs = 0; goodMs = 0; return; }
      if (!QUALITY[q]) return;
      autoQ = false;
      setLevel(q);
    },

    getDish() { return { cx: lay.cx, cy: lay.cy, r: lay.r }; },

    getStats() {
      let fresh = 0;
      if (org) { const N = org.nodes; for (let i = bakePtr; i < N.count; i++) if (N.alive[i]) fresh++; }
      return {
        fps: emaInt > 0 ? Math.round(1000 / emaInt) : 0,
        frameMs: Math.round(emaInt * 100) / 100,
        cpuMs: Math.round(emaCpu * 100) / 100,
        dpr: dpr,
        quality: level,
        nodes: org ? org.aliveCount : 0,
        fresh: fresh,
        scars: org ? org.analysis.episodes.length : 0,
      };
    },

    drawMini(c2, size) {
      if (!c2 || !(size > 0)) return;
      c2.save();
      try {
        c2.globalAlpha = 1; c2.globalCompositeOperation = 'source-over';
        const h = size / 2, R = size * 0.44;
        c2.fillStyle = FT.PALETTE.abyss; c2.fillRect(0, 0, size, size);
        const ready = sized && Ldish && Ltinted && Lmarks && RfullDev > 0;
        const k = ready ? R / RfullDev : 1, o = ready ? h - (S / 2) * k : 0, sz = ready ? S * k : 0;
        if (ready) c2.drawImage(Ldish, o, o, sz, sz); else drawGlass(c2, h, h, R, 1, null);
        const showOrg = ready && org && ORG_PHASES[curPhase] === 1;
        if (!showOrg) { drawSporeStatic(c2, h, h, R, RGB.core, 1); return; }
        c2.globalAlpha = clamp01(lum);
        c2.drawImage(Ltinted, o, o, sz, sz);
        const N = org.nodes;
        c2.beginPath();
        let any = false;
        for (let i = bakePtr; i < seen; i++) {
          if (!N.alive[i] || N.parent[i] < 0 || appearAt[i] > NOW) continue;
          const p = N.parent[i];
          c2.moveTo(h + N.x[p] * R, h + N.y[p] * R); c2.lineTo(h + N.x[i] * R, h + N.y[i] * R); any = true;
        }
        if (any) {
          c2.lineCap = 'round'; c2.strokeStyle = rgbStr(tintCur.e);
          c2.lineWidth = Math.max(0.6, (1.4 * R) / 380); c2.globalAlpha = 0.85 * clamp01(lum);
          c2.stroke();
        }
        c2.globalCompositeOperation = 'lighter';
        const gr = Math.max(2, (0.04 + 0.1 * Ds) * R * 2.5);
        const ca = clamp01(0.5 + 0.5 * Fs);
        c2.globalAlpha = ca * (1 - 0.6 * kState);
        c2.drawImage(getSprite(RGB.core), h - gr, h - gr, gr * 2, gr * 2);
        if (kState > 0.03) {
          c2.globalAlpha = ca * kState * 0.85;
          c2.drawImage(getSprite(tintPal), h - gr, h - gr, gr * 2, gr * 2);
        }
        c2.globalCompositeOperation = 'source-over';
        c2.globalAlpha = 1;
        c2.drawImage(Lmarks, o, o, sz, sz);
        const caps = fruit ? fruit.caps : finalCaps;
        if (caps) for (const cp of caps) drawCap(c2, h + cp.x * R, h + cp.y * R, cp.theta, cp.size * R, fruit ? capScale(cp, NOW) : 1, capsAlpha, Math.max(0.3, R / 380));
      } catch (err) {
        console.warn(LOG, 'drawMini failed', err);
      } finally {
        c2.restore();
      }
    },

    drawSpecimen: drawSpecimen,
  };
})();
