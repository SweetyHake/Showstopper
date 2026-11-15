/**
 * Procedural blood texture atlas — granular micro-grain technique.
 *
 * Key distinction from "shapes + gradient": each stain is built from THOUSANDS
 * of micro-droplet grains sampled over a density field. The solid core is only
 * a faint backing (alpha ~0.3) for readability at distance; edges dissolve into
 * spray with no hard silhouettes or outlines:
 *   • density field = lobes (angular noise) × radial falloff × fine noise —
 *     grain is denser in the core and sparser toward the edges;
 *   • grain — dots of r 0.5–2.6 with alpha driven by local density,
 *     batched into alpha buckets (8 fills per stain);
 *   • fibrous strands — thin curved grain filaments with a droplet at the tip
 *     (fan of strands on splashes, viscous drips on pools);
 *   • smear — S-curved grain spine with longitudinal streak gaps
 *     (noise suppresses density in bands) and comets at the leading end;
 *   • pool — dense grain + viscous drips with bulbous tips.
 *
 * Tinting (`tinted`): mask (carries ALL relief) → soft "wet center → dried rim"
 * gradient (`source-in`) → subtle dark clots (`source-atop`) → faint wet specular
 * highlights (seeded per variant, light from top-left) → color alpha. There is
 * NO dark dilated outline — on micro-grain it looks cartoonish.
 *
 * Cells are drawn in a 256 logical space and scaled to CELL (384) to give
 * headroom for micro-grain. Variant counts MUST NOT change: they are tied to
 * seeds of already persisted stains.
 */

import { hashStr, Rng } from './rng.mjs';
import { parseColor, shadeHex } from './colors.mjs';

export const CELL = 384;
const BASE = 256;      // logical drawing space
const K = CELL / BASE; // scale factor to device pixels
const COLS = 6;

/**
 * Atlas layout: base cell indices per stain kind. Counts of existing kinds
 * MUST NOT be changed (indices are tied to saved stain seeds); new kinds may
 * only be appended AT THE END of the list.
 */
const LAYOUT: [string, number][] = [
  ['splat', 12],
  ['splash', 4],
  ['smear', 5],
  ['pool', 4],
  ['droplet', 6],
  ['footprint', 4],
  // APPEND-ONLY: new kinds go at the end only (indices of existing kinds are
  // tied to saved stain seeds)
  ['drip', 3],       // wall drip: LOCAL +Y = "downward" (gravity carried by stain rotation)
  ['handprint', 2],  // handprint: fingers point along +X
  ['pawprint', 4],   // padded animal paw (0/2 = left, 1/3 = right)
  ['clawprint', 4],  // three-toed reptile/monstrosity/bird claw print (0/2 = left, 1/3 = right)
  ['hoofprint', 4]   // cloven hoof / horseshoe print (0/2 = left, 1/3 = right)
];

const KIND_BASE = (() => {
  const bases: any = {};
  let at = 0;
  for (const [kind, n] of LAYOUT) { bases[kind] = at; at += n; }
  return bases;
})();

const TOTAL = LAYOUT.reduce((s, [, n]) => s + n, 0);
const ATLAS_W = COLS * CELL;
const ATLAS_H = Math.ceil(TOTAL / COLS) * CELL;
const TAU = Math.PI * 2;

let _maskAtlas = null;
let _detailAtlas = null;
const _tintCache = new Map(); // packed idx|rgb|mat (int) → canvas (LRU)

function cellOrigin(idx) {
  return { sx: (idx % COLS) * CELL, sy: Math.floor(idx / COLS) * CELL };
}

/* --------------------------- drawing primitives --------------------------- */

function cellCtx(canvas, idx) {
  const { sx, sy } = cellOrigin(idx);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx, sy, CELL, CELL);
  ctx.clip();
  ctx.translate(sx, sy);
  ctx.scale(K, K); // draw in 0..256 logical coordinates from here on
  return { ctx, done: () => ctx.restore() };
}

/** Smooth closed contour through segment midpoints (quadratic curves). */
function traceSmooth(ctx, pts) {
  const n = pts.length;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const m0 = mid(pts[n - 1], pts[0]);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const m = mid(p, pts[(i + 1) % n]);
    ctx.quadraticCurveTo(p.x, p.y, m.x, m.y);
  }
  ctx.closePath();
}

/** Multi-octave noise: raw sum of harmonics (for density fields). */
function makeNoise(rng, octaves) {
  const ph = octaves.map(() => rng.angle());
  return (x) => octaves.reduce((s, [f, a], i) => s + a * Math.sin(f * x + ph[i]), 0);
}

/** Wobble multiplier centered around 1 (for contours). */
function makeWobble(rng, octaves) {
  const noise = makeNoise(rng, octaves);
  return (x) => 1 + noise(x);
}

/** Pseudo-Gaussian: sum of three uniforms, σ ≈ 0.5. */
const gauss = (rng) => (rng.next() + rng.next() + rng.next() - 1.5) * 0.82;

/** Circle subpath. */
function circleSubpath(ctx, x, y, r) {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, TAU);
}

/** Smooth polygon blob contour as a subpath. */
function blobSubpath(ctx, cx, cy, radius, wob, { points = 40, jitter = 0.03, jitRng = null } = {}) {
  const pts = [];
  for (let i = 0; i < points; i++) {
    const phi = (i / points) * TAU;
    const jit = jitRng ? 1 + (jitRng.next() * 2 - 1) * jitter : 1;
    const r = radius * wob(phi) * jit;
    pts.push({ x: cx + Math.cos(phi) * r, y: cy + Math.sin(phi) * r });
  }
  traceSmooth(ctx, pts);
}

/**
 * "Comet" droplet: teardrop head + curved tail OPPOSITE the flight direction
 * (`moveAng` = travel direction). Winding matches the circle so nonzero fill
 * doesn't subtract the overlap and leave a hole.
 */
function cometSubpath(ctx, x, y, r, tail, moveAng, curve) {
  const bx = Math.cos(moveAng + Math.PI), by = Math.sin(moveAng + Math.PI);
  const nx = -by, ny = bx;
  circleSubpath(ctx, x, y, r);
  if (tail <= 0.5) return;
  const tipx = x + bx * (r + tail) + nx * curve * tail * 0.6;
  const tipy = y + by * (r + tail) + ny * curve * tail * 0.6;
  const m = r + tail * 0.45;
  ctx.moveTo(x - nx * r * 0.75, y - ny * r * 0.75);
  ctx.quadraticCurveTo(x + bx * m - nx * (r * 0.5 - curve * tail * 0.35), y + by * m - ny * (r * 0.5 - curve * tail * 0.35), tipx, tipy);
  ctx.quadraticCurveTo(x + bx * m + nx * (r * 0.5 + curve * tail * 0.35), y + by * m + ny * (r * 0.5 + curve * tail * 0.35),
    x + nx * r * 0.75, y + ny * r * 0.75);
  ctx.closePath();
}

/* ------------------------------ grain and strands ------------------------------ */

/**
 * Grain: draws batches of dots grouped into 8 alpha buckets
 * (one fill per bucket — fast without losing granularity).
 * pts: [{x, y, r, a}]
 */
function drawGrain(ctx, pts) {
  const LEVELS = 8;
  const buckets = new Array(LEVELS).fill(null);
  for (const p of pts) {
    const b = Math.max(0, Math.min(LEVELS - 1, (p.a * LEVELS) | 0));
    (buckets[b] ??= []).push(p);
  }
  ctx.fillStyle = '#ffffff';
  for (let b = 0; b < LEVELS; b++) {
    const list = buckets[b];
    if (!list) continue;
    ctx.globalAlpha = (b + 0.5) / LEVELS;
    ctx.beginPath();
    for (const p of list) {
      ctx.moveTo(p.x + p.r, p.y);
      ctx.arc(p.x, p.y, p.r, 0, TAU);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * Thin fibrous filament: grain scattered along a bowed axis with density and
 * width tapering toward the tip. Returns the tip position.
 */
function filament(ctx, rng, x0, y0, ang, len, bow, w, grain) {
  const px = Math.cos(ang), py = Math.sin(ang);
  const nx = -py, ny = px;
  const pts = [];
  for (let i = 0; i < grain; i++) {
    const t = rng.next();
    const d = t * len;
    const lat = bow * d * t * 0.8 + gauss(rng) * w * (1 - t * 0.7);
    const dens = (1 - t) * (0.55 + 0.45 * rng.next());
    if (rng.next() > dens) continue;
    pts.push({
      x: x0 + px * d + nx * lat,
      y: y0 + py * d + ny * lat,
      r: 0.5 + rng.next() * 1.1 * (1 - t * 0.5),
      a: Math.min(0.95, 0.25 + dens * 0.7)
    });
  }
  drawGrain(ctx, pts);
  return {
    x: x0 + px * len + nx * bow * len * 0.8,
    y: y0 + py * len + ny * bow * len * 0.8
  };
}

/** Single droplet dot (for filament tips). */
function dot(ctx, x, y, r, a) {
  ctx.globalAlpha = a;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  circleSubpath(ctx, x, y, r);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* ------------------------------ cell generation ------------------------------ */

/** Impact splat: faint core + density grain + strands + comets + mist. */
function drawSplat(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const r0 = rng.range(52, 66);

  // 1) faint solid backing (readability at distance)
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  const wob = makeWobble(rng, [[2, 0.16], [3, 0.1], [5, 0.06], [8, 0.03]]);
  blobSubpath(ctx, cx, cy, r0 * 0.72, wob, { jitter: 0.04, jitRng: rng });
  const lobes = rng.int(4) + 3;
  for (let i = 0; i < lobes; i++) {
    const a = rng.angle();
    const d = rng.range(0.2, 0.6) * r0;
    circleSubpath(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(0.16, 0.4) * r0);
  }
  ctx.fill();

  // 2) grain: density = lobes (angular noise) × radial falloff × fine noise
  const nAng = makeNoise(rng, [[2, 0.3], [3, 0.22], [5, 0.14], [9, 0.07]]);
  const nFine = makeNoise(rng, [[4, 0.25], [7, 0.18], [11, 0.1]]);
  const grainN = 1900 + rng.int(700);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    const phi = rng.angle();
    const u = rng.next();
    const d = r0 * 1.15 * Math.pow(u, 0.6);
    const fall = Math.pow(1 - u, 1.25);
    const dens = fall * Math.max(0, 0.5 + nAng(phi) + nFine(u * TAU) * 0.5);
    if (rng.next() > dens * 1.6) continue;
    pts.push({
      x: cx + Math.cos(phi) * d + gauss(rng) * 1.5,
      y: cy + Math.sin(phi) * d + gauss(rng) * 1.5,
      r: 0.55 + rng.next() * rng.next() * 2.4 * (0.5 + dens),
      a: Math.min(0.95, 0.22 + dens * 0.85 * (0.5 + rng.next() * 0.5))
    });
  }
  drawGrain(ctx, pts);

  // 3) fibrous spray strands with tip droplets
  const strands = rng.int(4) + 5;
  for (let i = 0; i < strands; i++) {
    const a = rng.angle();
    const sx = cx + Math.cos(a) * r0 * 0.45, sy = cy + Math.sin(a) * r0 * 0.45;
    const len = Math.min(r0 * rng.range(0.5, 1.05), 62);
    const tip = filament(ctx, rng, sx, sy, a + rng.range(-0.3, 0.3), len,
      rng.range(-0.5, 0.5), rng.range(1.8, 4), 55 + rng.int(45));
    if (rng.chance(0.4)) dot(ctx, tip.x, tip.y, rng.range(1.8, 4.2), rng.range(0.5, 0.85));
  }

  // 4) larger satellite comet droplets
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  const sats = rng.int(5) + 7;
  for (let i = 0; i < sats; i++) {
    const a = rng.angle();
    const d = r0 * rng.range(1.05, Math.min(1.7, 100 / r0));
    const r = r0 * rng.range(0.05, 0.1);
    cometSubpath(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, r * rng.range(1.4, 2.8), a, rng.range(-0.5, 0.5));
  }
  ctx.fill();

  // 5) fine mist spray around the perimeter
  const mistN = 80 + rng.int(50);
  for (let i = 0; i < mistN; i++) {
    const a = rng.angle();
    const d = r0 * rng.range(0.95, 1.5);
    dot(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.4 + rng.next() * 0.9, rng.range(0.15, 0.5));
  }
  done();

  // detail pass: dark internal mottling + clots
  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  const mottle = 40 + rng.int(30);
  for (let i = 0; i < mottle; i++) {
    const a = rng.angle();
    const d = rng.range(0, r0 * 0.85);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.12, 0.3).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(0.5, 1.6));
    dctx.fill();
  }
  dctx.fillStyle = 'rgba(0,0,0,0.32)';
  dctx.beginPath();
  const clots = rng.int(3) + 3;
  for (let i = 0; i < clots; i++) {
    const a = rng.angle();
    const d = rng.range(0.05, 0.55) * r0;
    circleSubpath(dctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(1.5, 3.5));
  }
  dctx.fill();
  d2.done();
}

/** Directional splash (+X): grain core, fan of filaments, cone of comets and mist. */
function drawSplash(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const ox = 64, oy = 128;
  const spread = rng.range(0.4, 0.6);

  // faint core
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  const wob = makeWobble(rng, [[2, 0.14], [3, 0.08], [5, 0.05]]);
  blobSubpath(ctx, ox + 8, oy, rng.range(16, 24), wob, { jitter: 0.03, jitRng: rng });
  blobSubpath(ctx, ox + rng.range(16, 26), oy + rng.range(-6, 6), rng.range(11, 17), wob, { jitter: 0.03, jitRng: rng });
  ctx.fill();

  // cone grain: density falls off with distance and toward cone edges
  const nCone = 1500 + rng.int(500);
  const pts = [];
  for (let i = 0; i < nCone; i++) {
    const t = Math.pow(rng.next(), 0.85);
    const d = 12 + t * 128;
    const lat = gauss(rng) * (5 + 30 * t);
    const dens = Math.pow(1 - t, 1.05) * Math.max(0, 0.6 + gauss(rng) * 0.25);
    if (rng.next() > dens * 1.5) continue;
    pts.push({
      x: ox + d + Math.abs(lat) * 0.3,
      y: oy + lat,
      r: 0.55 + rng.next() * rng.next() * 2.2 * (0.5 + dens),
      a: Math.min(0.95, 0.22 + dens * 0.85 * (0.5 + rng.next() * 0.5))
    });
  }
  drawGrain(ctx, pts);

  // fan of fibrous filaments across the cone
  const strands = rng.int(3) + 4;
  for (let i = 0; i < strands; i++) {
    const a = rng.range(-spread, spread);
    const tip = filament(ctx, rng, ox + Math.cos(a) * 14, oy + Math.sin(a) * 14, a,
      rng.range(45, 95), rng.range(-0.4, 0.4), rng.range(1.6, 3.4), 50 + rng.int(40));
    if (rng.chance(0.5)) dot(ctx, tip.x, tip.y, rng.range(1.6, 3.6), rng.range(0.5, 0.85));
  }

  // comets across the cone
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  const drops = rng.int(6) + 7;
  for (let i = 0; i < drops; i++) {
    const a = rng.range(-spread * 1.25, spread * 1.25);
    const d = rng.range(40, 140);
    const r = rng.range(2, 6.5);
    cometSubpath(ctx, ox + Math.cos(a) * d, oy + Math.sin(a) * d, r, r * rng.range(1.4, 2.8), a, rng.range(-0.4, 0.4));
  }
  ctx.fill();

  // mist across the cone
  for (let i = 0, n = 70 + rng.int(40); i < n; i++) {
    const a = rng.range(-spread * 1.4, spread * 1.4);
    const d = rng.range(30, 148);
    dot(ctx, ox + Math.cos(a) * d, oy + Math.sin(a) * d, 0.4 + rng.next() * 0.9, rng.range(0.12, 0.45));
  }
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  dctx.fillStyle = 'rgba(0,0,0,0.32)';
  dctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = rng.range(-spread, spread);
    circleSubpath(dctx, ox + Math.cos(a) * rng.range(8, 26), oy + Math.sin(a) * rng.range(8, 26), rng.range(1.5, 3.5));
  }
  dctx.fill();
  d2.done();
}

/**
 * Smear: S-curved spine — faint backing ribbon + grain with longitudinal
 * streak gaps (noise suppresses density), comets at the leading end, and skip
 * marks at the trailing end. Raggedness comes directly from grain without destination-out.
 */
function drawSmear(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cy0 = 128 + rng.range(-16, 16);
  const cy1 = 128 + rng.range(-16, 16);
  const bend = rng.range(-22, 22);
  const half = rng.range(18, 28);
  const spine = (t) => {
    const it = 1 - t;
    const cxp = 130 + bend;
    return {
      x: it * it * 28 + 2 * it * t * cxp + t * t * 232,
      y: it * it * cy0 + 2 * it * t * (128 + bend * 0.5) + t * t * cy1
    };
  };
  const prof = (t) => half * Math.pow(Math.sin(Math.PI * (0.03 + t * 0.94)), 0.7) * (0.7 + 0.55 * t);

  // backing ribbon — barely visible; the body is built from grain
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.14;
  ctx.beginPath();
  const N = 26;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = spine(t);
    pts.push({ p, w: prof(t) * 0.7 });
  }
  ctx.moveTo(pts[0].p.x, pts[0].p.y - pts[0].w);
  for (let i = 1; i <= N; i++) ctx.lineTo(pts[i].p.x, pts[i].p.y - pts[i].w);
  for (let i = N; i >= 0; i--) ctx.lineTo(pts[i].p.x, pts[i].p.y + pts[i].w);
  ctx.closePath();
  ctx.fill();

  // grain: transverse Gaussian profile (wider than the backing for a ragged edge),
  // longitudinal streak gaps driven by noise
  const nLon = makeNoise(rng, [[3, 0.4], [6, 0.3], [11, 0.2]]);
  const grainN = 2100 + rng.int(600);
  const grains = [];
  for (let i = 0; i < grainN; i++) {
    const t = rng.next();
    const p = spine(t);
    const bell = prof(t) / half;
    const band = nLon(t * TAU);
    let dens = bell * (0.55 + 0.45 * rng.next());
    if (band < -0.18) dens *= 0.12; // streak gap
    if (rng.next() > dens * 1.4) continue;
    const lat = gauss(rng) * half * bell * 1.25 * (1 + 0.25 * band);
    grains.push({
      x: p.x + gauss(rng) * 1.4,
      y: p.y + lat,
      r: 0.5 + rng.next() * rng.next() * 2 * (0.5 + dens),
      a: Math.min(0.95, 0.2 + dens * 0.8 * (0.5 + rng.next() * 0.5))
    });
  }
  drawGrain(ctx, grains);

  // leading comets and trailing skip droplets
  const dirAng = Math.atan2(spine(1).y - spine(0.94).y, spine(1).x - spine(0.94).x);
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  const drops = rng.int(3) + 2;
  for (let i = 0; i < drops; i++) {
    const p = spine(1.04 + rng.range(0, 0.12));
    // spline extrapolation past t>1 pushes comets beyond 256 logical px, while
    // cell clip allows slight bleed — clamp inside the cell so a white tail
    // never bakes into an ADJACENT atlas cell and shows through its tinting
    const px = Math.max(6, Math.min(250, p.x));
    const py = Math.max(6, Math.min(250, p.y));
    cometSubpath(ctx, px, py, rng.range(3.5, 8), rng.range(6, 16), dirAng, rng.range(-0.3, 0.3));
  }
  const skips = rng.int(4) + 3;
  for (let i = 0; i < skips; i++) {
    const back = rng.range(4, 20);
    const a = dirAng + Math.PI + rng.range(-0.5, 0.5);
    const p = spine(0);
    circleSubpath(ctx, Math.max(6, p.x + Math.cos(a) * back), p.y + Math.sin(a) * back, rng.range(1.5, 4.5));
  }
  ctx.fill();
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  const mottle = 20 + rng.int(16);
  for (let i = 0; i < mottle; i++) {
    const t = rng.next();
    const p = spine(t);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.26).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, p.x, p.y + gauss(rng) * half * 0.6, rng.range(0.5, 1.4));
    dctx.fill();
  }
  d2.done();
}

/** Pool: dense grain over a soft field + viscous drips with bulbous tips. */
function drawPool(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const r0 = rng.range(62, 76);

  // slightly denser backing (a pool is thick)
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.42;
  ctx.beginPath();
  const wob = makeWobble(rng, [[2, 0.08], [3, 0.05], [5, 0.025]]);
  blobSubpath(ctx, cx, cy, r0 * 0.86, wob, { jitter: 0.015, jitRng: rng });
  const lobes = rng.int(4) + 3;
  for (let i = 0; i < lobes; i++) {
    const a = rng.angle();
    circleSubpath(ctx, cx + Math.cos(a) * r0 * 0.55, cy + Math.sin(a) * r0 * 0.55, rng.range(0.26, 0.46) * r0);
  }
  ctx.fill();

  // grain: gentle falloff, dissolving rim
  const nAng = makeNoise(rng, [[2, 0.18], [3, 0.12], [6, 0.07]]);
  const grainN = 2100 + rng.int(700);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    const phi = rng.angle();
    const u = Math.pow(rng.next(), 0.8);
    const d = r0 * 1.12 * u;
    const dens = Math.pow(1 - u, 0.75) * Math.max(0, 0.6 + nAng(phi));
    if (rng.next() > dens * 1.5) continue;
    pts.push({
      x: cx + Math.cos(phi) * d + gauss(rng) * 1.4,
      y: cy + Math.sin(phi) * d + gauss(rng) * 1.4,
      r: 0.55 + rng.next() * rng.next() * 2.2 * (0.5 + dens),
      a: Math.min(0.95, 0.22 + dens * 0.8 * (0.5 + rng.next() * 0.5))
    });
  }
  drawGrain(ctx, pts);

  // viscous drips: outward filament + chain of bulbs
  const drips = rng.int(3) + 2;
  for (let i = 0; i < drips; i++) {
    const a = rng.angle();
    const sx = cx + Math.cos(a) * r0 * 0.7, sy = cy + Math.sin(a) * r0 * 0.7;
    const tip = filament(ctx, rng, sx, sy, a + rng.range(-0.15, 0.15), rng.range(24, 48),
      rng.range(-0.25, 0.25), rng.range(2, 3.6), 40 + rng.int(30));
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    let d = r0 * 0.7 + rng.range(14, 30);
    let r = rng.range(3, 5.5);
    for (let k = 0; k < 3; k++) {
      circleSubpath(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r);
      d += r * rng.range(1.1, 1.5);
      r *= rng.range(0.65, 0.85);
    }
    circleSubpath(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * rng.range(1.3, 1.6));
    ctx.fill();
    if (rng.chance(0.5)) dot(ctx, tip.x, tip.y, rng.range(1.5, 3), rng.range(0.45, 0.75));
  }
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  dctx.fillStyle = 'rgba(0,0,0,0.32)';
  dctx.beginPath();
  const clots = rng.int(4) + 5;
  for (let i = 0; i < clots; i++) {
    const a = rng.angle();
    const d = rng.range(0.05, 0.6) * r0;
    circleSubpath(dctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(2, 6));
  }
  dctx.fill();
  const mottle = 25 + rng.int(15);
  for (let i = 0; i < mottle; i++) {
    const a = rng.angle();
    const d = rng.range(0, r0 * 0.9);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.26).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(0.5, 1.6));
    dctx.fill();
  }
  d2.done();
}

/** Comet droplet cluster: grain tail + irregular head + micro-mist. */
function drawDroplet(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const moveAng = rng.angle();

  const comet = (x, y, r, curve) => {
    // grain tail
    const bx = Math.cos(moveAng + Math.PI), by = Math.sin(moveAng + Math.PI);
    const nx = -by, ny = bx;
    const pts = [];
    const tail = r * rng.range(1.8, 3);
    for (let i = 0, n = 16 + rng.int(12); i < n; i++) {
      const t = rng.next();
      const dens = 1 - t;
      if (rng.next() > dens) continue;
      pts.push({
        x: x + bx * (r + t * tail) + nx * (curve * t * tail * 0.5 + gauss(rng) * r * 0.35 * (1 - t)),
        y: y + by * (r + t * tail) + ny * (curve * t * tail * 0.5 + gauss(rng) * r * 0.35 * (1 - t)),
        r: 0.5 + rng.next() * 1.3,
        a: 0.3 + dens * 0.6
      });
    }
    drawGrain(ctx, pts);
    // head — irregular blotch of overlapping circles rather than a perfect circle
    ctx.globalAlpha = rng.range(0.4, 0.6);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    circleSubpath(ctx, x, y, r * 0.8);
    circleSubpath(ctx, x + gauss(rng) * r * 0.35, y + gauss(rng) * r * 0.35, r * 0.55);
    circleSubpath(ctx, x + gauss(rng) * r * 0.4, y + gauss(rng) * r * 0.4, r * 0.38);
    ctx.fill();
    ctx.globalAlpha = 1; // head sets 0.4–0.6 — reset so it doesn't leak into the next primitive
  };

  const r0 = rng.range(14, 22);
  comet(cx, cy, r0, rng.range(-0.35, 0.35));
  const n = rng.int(4) + 2;
  for (let i = 0; i < n; i++) {
    const a = moveAng + rng.range(-0.9, 0.9);
    const d = rng.range(18, 58);
    comet(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(3, 8), rng.range(-0.4, 0.4));
  }
  for (let i = 0, n2 = 14 + rng.int(10); i < n2; i++) {
    const a = moveAng + rng.range(-1.1, 1.1);
    const d = rng.range(20, 66);
    dot(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.4 + rng.next() * 0.8, rng.range(0.15, 0.45));
  }
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  dctx.fillStyle = 'rgba(0,0,0,0.3)';
  dctx.beginPath();
  circleSubpath(dctx, cx + rng.range(-4, 4), cy + rng.range(-4, 4), rng.range(2, 4.5));
  dctx.fill();
  d2.done();
}

/**
 * Wall/support drip: contact blotch at the top + vertical downward strands
 * with beaded droplets at their tips. In local space "down" = +Y: the stain is
 * placed with r=0 on vertical surfaces, and stain rotation carries gravity.
 * Grain gives ragged edges; comets depict detaching drops.
 */
function drawDrip(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 92 + rng.range(-6, 6); // contact sits in the upper third of the cell

  // contact blotch (where blood struck the surface)
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.34;
  ctx.beginPath();
  const wob = makeWobble(rng, [[2, 0.12], [4, 0.06]]);
  blobSubpath(ctx, cx, cy, rng.range(14, 20), wob, { jitter: 0.05, jitRng: rng });
  ctx.fill();

  // 2–3 primary drips: vertical grain + beads
  const nDrip = 2 + rng.int(2);
  for (let i = 0; i < nDrip; i++) {
    const x0 = cx + (i - (nDrip - 1) / 2) * rng.range(14, 26) + gauss(rng) * 3;
    const len = rng.range(70, 120);
    const pts = [];
    for (let k = 0, n = 60 + rng.int(30); k < n; k++) {
      const t = rng.next();
      const dens = Math.pow(1 - t, 0.8) * (0.55 + 0.45 * rng.next());
      if (rng.next() > dens * 1.4) continue;
      pts.push({
        x: x0 + gauss(rng) * (1.4 + t * 0.8),
        y: cy + t * len,
        r: 0.5 + rng.next() * rng.next() * 1.9 * (1 - t * 0.4),
        a: Math.min(0.95, 0.3 + dens * 0.7)
      });
    }
    drawGrain(ctx, pts);
    // beads along and at the tip: heavy drop pulling downward
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    let dy = cy + len * rng.range(0.55, 0.85);
    let r = rng.range(2.6, 5);
    for (let k = 0; k < 3; k++) {
      circleSubpath(ctx, x0 + gauss(rng) * 1.6, dy, r);
      dy += r * rng.range(1.4, 2);
      r *= rng.range(0.55, 0.8);
    }
    ctx.fill();
    if (rng.chance(0.6)) {
      // detached comet drop below the drip
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      cometSubpath(ctx, x0 + gauss(rng) * 2, Math.min(246, dy + rng.range(8, 26)), rng.range(2.2, 4.4), rng.range(4, 9), Math.PI / 2, rng.range(-0.2, 0.2));
      ctx.fill();
    }
  }
  // fine mist around the contact point
  for (let i = 0, n = 40 + rng.int(24); i < n; i++) {
    const a = rng.angle();
    const d = rng.range(6, 30);
    dot(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, 0.4 + rng.next() * 0.8, rng.range(0.12, 0.4));
  }
  done();

  // detail pass: dark mottling along the drips
  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  for (let i = 0, n = 24 + rng.int(16); i < n; i++) {
    const t = rng.next();
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.26).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, cx + (rng.next() - 0.5) * 52, cy + t * 130, rng.range(0.5, 1.5));
    dctx.fill();
  }
  d2.done();
}

/**
 * Handprint: elongated palm blotch + five comet-streak fingers along +X
 * (stain rotation carries orientation: "fingers up" = r = -90°). Grain
 * pressure is heavier in the palm center, edges dissolve, with smudging between fingers.
 */
function drawHandprint(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 108, cy = 128;
  const palmW = rng.range(30, 36);  // across fingers
  const palmH = rng.range(40, 48);  // along fingers
  const spread = rng.range(0.16, 0.3);

  // palm: soft backing blotch + grain
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  const wob = makeWobble(rng, [[2, 0.1], [3, 0.07], [5, 0.04]]);
  blobSubpath(ctx, cx, cy, palmH * 0.5, wob, { points: 34, jitter: 0.05, jitRng: rng });
  ctx.fill();

  const grainN = 1500 + rng.int(400);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    // palm grain: denser toward center, elongated along +X
    const t = Math.pow(rng.next(), 0.7);
    const a = rng.angle();
    const px = cx + Math.cos(a) * t * palmH * 0.62;
    const py = cy + Math.sin(a) * t * palmW * 0.62;
    const dens = Math.pow(1 - t, 0.9) * (0.5 + 0.5 * rng.next());
    if (rng.next() > dens * 1.6) continue;
    pts.push({ x: px, y: py, r: 0.5 + rng.next() * rng.next() * 2 * (0.5 + dens), a: Math.min(0.95, 0.26 + dens * 0.8) });
  }
  // fingers: five splayed comet streaks along +X
  const fingerBase = cx + palmH * 0.32;
  for (let f = 0; f < 5; f++) {
    const fa = (f - 2) * spread + gauss(rng) * 0.04;
    const flen = (f === 0 || f === 4 ? rng.range(0.55, 0.7) : rng.range(0.85, 1.05)) * palmH * 0.9;
    const fx = fingerBase + Math.cos(fa) * palmH * 0.18;
    const fy = cy + Math.sin(fa) * palmW * 0.42;
    for (let k = 0, n = 24 + rng.int(14); k < n; k++) {
      const t = rng.next();
      const dens = (1 - t) * (0.5 + 0.5 * rng.next());
      if (rng.next() > dens * 1.5) continue;
      pts.push({
        x: fx + Math.cos(fa) * t * flen + gauss(rng) * (2.6 - t * 1.4),
        y: fy + Math.sin(fa) * t * flen + gauss(rng) * (2.6 - t * 1.4),
        r: 0.5 + rng.next() * 1.5 * (1 - t * 0.4),
        a: Math.min(0.95, 0.3 + dens * 0.7)
      });
    }
    // fingertip pad
    ctx.globalAlpha = rng.range(0.4, 0.55);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const tx = fx + Math.cos(fa) * flen * 0.92;
    const ty = fy + Math.sin(fa) * flen * 0.92;
    circleSubpath(ctx, tx, ty, rng.range(3.2, 5.2));
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawGrain(ctx, pts);

  // thumb angled sideways (perpendicular to fingers)
  const ta = rng.chance(0.5) ? Math.PI / 2 + rng.range(-0.25, 0.25) : -Math.PI / 2 + rng.range(-0.25, 0.25);
  ctx.globalAlpha = rng.range(0.4, 0.55);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  const thx = cx - palmH * 0.18, thy = cy + (ta > 0 ? 1 : -1) * palmW * 0.5;
  for (let k = 0; k < 4; k++) {
    circleSubpath(ctx, thx + Math.cos(ta) * k * 7, thy + Math.sin(ta) * k * 7, rng.range(3.4, 5) * (1 - k * 0.13));
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  done();

  // detail pass: dark palm crease dots
  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  for (let i = 0, n = 16 + rng.int(10); i < n; i++) {
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.24).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, cx + gauss(rng) * palmH * 0.3, cy + gauss(rng) * palmW * 0.4, rng.range(0.5, 1.4));
    dctx.fill();
  }
  d2.done();
}

/* ----------------------------------- snow -----------------------------------
 * Dedicated granular mask: not a liquid shape, but ACCUMULATION — soft clumps
 * (radially blurred stamp), powder, and sparkles. Without a solid base coat,
 * filaments, or comets. Lazily built into a separate atlas (v6).
 */

let _maskSnowAtlas = null;
let _snowStamp = null;

/** Soft diffuse snow-puff stamp (no dense central core), shared per client. */
function snowStamp() {
  if (!_snowStamp) {
    _snowStamp = document.createElement('canvas');
    _snowStamp.width = _snowStamp.height = 64;
    const g = _snowStamp.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.54)');
    grd.addColorStop(0.26, 'rgba(255,255,255,0.42)');
    grd.addColorStop(0.52, 'rgba(255,255,255,0.25)');
    grd.addColorStop(0.74, 'rgba(255,255,255,0.10)');
    grd.addColorStop(0.90, 'rgba(255,255,255,0.025)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }
  return _snowStamp;
}

/** Soft snow clump. */
function snowDot(ctx, x, y, r, a) {
  ctx.globalAlpha = a;
  ctx.drawImage(snowStamp(), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1; // alpha leak would bleed into the next fill/drawImage
}

/**
 * Wide fluffy snow sheet (for Blanket lv=2 and 3D snowbanks lv=3..5):
 * smooth aerodynamic contour without tiny bumps + wide dome-shaped density
 * falloff (0.54..1.00 * radius), allowing adjacent stamps to merge seamlessly
 * into a continuous snow mass without "scalloping", while the edge scatters into fluffy powder.
 */
function snowPillow(ctx, rng, cx, cy, radius, _lobes = 5, _baseAlpha = 0.48) {
  const stretchA = rng.angle();
  const stretchK = rng.range(0.055, 0.095);
  // Smooth wind-shaped drift contour (low harmonics k=2..5 without fine jagged "cauliflower"),
  // shared across all concentric layers — prevents double edges on 3D ao/bank/plateau slopes!
  const baseWob = makeWobble(rng, [[2, 0.075], [3, 0.048], [4, 0.026], [5, 0.012]]);
  const sharedWob = (a: number) => baseWob(a) + Math.cos(2 * (a - stretchA)) * stretchK;

  // 18 smooth concentric steps from 1.00 down to 0.54 * radius form a wide velvety
  // dome slope (Partition of Unity): overlapping stamps sum smoothly without hard steps,
  // while the outer 0.72..1.00 * radius band undergoes powdery erosion in applySnowSurfaceTexture.
  ctx.fillStyle = '#ffffff';
  const steps = 18;
  for (let s = 0; s < steps; s++) {
    const t = s / (steps - 1); // 0 (outer fluff 1.00) -> 1 (inner core 0.72)
    const rMul = 1.00 - t * 0.28;
    ctx.globalAlpha = 0.05 + t * t * 0.175;
    ctx.beginPath();
    blobSubpath(ctx, cx, cy, radius * rMul, sharedWob, { points: 96, jitter: 0 });
    ctx.fill();
  }

  // Wide 100%-opaque snow core (0..0.73 * radius):
  // neighboring snowbank domes overlap via solid white cores without gray rings ("cauliflower"),
  // while the fluffy powder shoulder at 0.73..1.00 * radius dissolves smoothly along the outer rim.
  ctx.globalAlpha = 1;
  ctx.beginPath();
  blobSubpath(ctx, cx, cy, radius * 0.73, sharedWob, { points: 96, jitter: 0 });
  ctx.fill();
}

/** Protective radial fade-out of the farthest corners of the 256×256 cell (r = 118..126) beyond the stamp. */
function clipSnowCellRadius(ctx, cx = 128, cy = 128) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.globalAlpha = 1;
  const g = ctx.createRadialGradient(cx, cy, 118, cx, cy, 126);
  g.addColorStop(0.00, 'rgba(0,0,0,1)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.restore();
}

/**
 * Ragged sheets and granular crust patches
 * inside the body of a snowbank.
 */
function snowDrift(ctx, rng, cx, cy, radius, n) {
  ctx.fillStyle = '#ffffff';
  const patches = Math.max(10, (n * 0.90) | 0);
  for (let i = 0; i < patches; i++) {
    const a = rng.angle();
    const d = radius * (0.15 + 0.62 * Math.sqrt(rng.next()));
    const wx = cx + Math.cos(a) * d;
    const wy = cy + Math.sin(a) * d;
    const pr = rng.range(5.5, 13.5);
    const wob = makeWobble(rng, [[2, 0.14], [3, 0.11], [5, 0.07]]);
    ctx.globalAlpha = rng.range(0.38, 0.65);
    ctx.beginPath();
    blobSubpath(ctx, wx, wy, pr, wob, { points: 28, jitter: 0.02, jitRng: rng });
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Cluster of small crisp snow clumps. */
function snowClump(ctx, rng, x, y, spread, n) {
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.62;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x + gauss(rng) * spread;
    const py = y + gauss(rng) * spread;
    const wob = makeWobble(rng, [[2, 0.16], [4, 0.11], [7, 0.06]]);
    blobSubpath(ctx, px, py, rng.range(2.8, 6.8), wob, { points: 20, jitter: 0.02, jitRng: rng });
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * Crystalline snow pellets and powder:
 * crisp, high-contrast firn grains along the transition rim and inside the sheet.
 */
function snowPowder(ctx, rng, cx, cy, radius, n) {
  const nAng = makeNoise(rng, [[2, 0.16], [3, 0.12], [5, 0.08]]);
  const grainCount = Math.max(640, (n * 3.2) | 0);
  const pts = [];
  for (let i = 0; i < grainCount; i++) {
    const phi = rng.angle();
    const u = Math.pow(rng.next(), 0.58);
    const d = radius * u * (0.92 + nAng(phi) * 0.06);
    const rimWeight = 0.50 + 0.50 * Math.sin(Math.min(1, Math.max(0, (u - 0.15) / 0.85)) * Math.PI);
    const dens = Math.max(0.35, rimWeight * (0.76 + nAng(phi) * 0.30));
    if (rng.next() > dens * 1.35) continue;
    pts.push({
      x: cx + Math.cos(phi) * d + gauss(rng) * 0.8,
      y: cy + Math.sin(phi) * d + gauss(rng) * 0.8,
      r: 0.55 + rng.next() * 1.20 * (0.55 + dens * 0.45),
      a: Math.min(0.98, 0.58 + dens * 0.42 * (0.70 + rng.next() * 0.30))
    });
  }
  drawGrain(ctx, pts);
}

/** Sparkles: crisp ice crystals and frost glints atop the snow crust. */
function snowSparkle(ctx, rng, cx, cy, radius, n) {
  ctx.fillStyle = '#ffffff';
  const count = Math.max(28, n * 2);
  for (let i = 0; i < count; i++) {
    const a = rng.angle();
    const d = radius * Math.sqrt(rng.next());
    ctx.globalAlpha = rng.range(0.72, 0.98);
    ctx.beginPath();
    circleSubpath(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(0.55, 1.30));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Snow burst (splat): smooth aerodynamic snowbank contour + crisp crystalline rim without mushy blur. */
function drawSnowSplat(mask, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const r0 = rng.range(96, 102);

  snowPillow(ctx, rng, cx, cy, r0, 6, 0.52);
  clipSnowCellRadius(ctx, cx, cy);
  done();
}

/** Snow spray: cone of clumps + powder along the cone. */
function drawSnowSplash(mask, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const ox = 64, oy = 128;
  const spread = rng.range(0.4, 0.6);

  const clumps = 14 + rng.int(8);
  for (let i = 0; i < clumps; i++) {
    const t = Math.pow(rng.next(), 0.8);
    const a = rng.range(-spread, spread);
    const d = 12 + t * 120;
    snowClump(ctx, rng, ox + Math.cos(a) * d, oy + Math.sin(a) * d,
      rng.range(4.0, 8.5), 4 + rng.int(4));
  }
  for (let i = 0, n = 450 + rng.int(200); i < n; i++) {
    const t = Math.pow(rng.next(), 0.85);
    const a = rng.range(-spread * 1.3, spread * 1.3);
    const d = 12 + t * 132;
    snowDot(ctx, ox + Math.cos(a) * d, oy + Math.sin(a) * d,
      0.5 + rng.next() * 1.4, rng.range(0.12, 0.38));
  }
  snowSparkle(ctx, rng, ox + 40, oy, 70, 12 + rng.int(10));
  done();
}

/** Snow smear (furrow/rut in snow): dense trampled trough with a crisp lumpy berm contour and no mushy edge blur. */
function drawSnowSmear(mask, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cy0 = 128 + rng.range(-2.5, 2.5);
  const cy1 = 128 + rng.range(-2.5, 2.5);
  const bend = rng.range(-3.5, 3.5);
  const half = rng.range(32, 35);
  const spine = (t) => {
    const it = 1 - t;
    const cxp = 128 + bend;
    return {
      x: it * it * 22 + 2 * it * t * cxp + t * t * 234,
      y: it * it * cy0 + 2 * it * t * (128 + bend * 0.6) + t * t * cy1
    };
  };
  // Oval furrow-width profile: smoothly rounds both ends (t=0 and t=1) while keeping full width along the run
  const prof = (t) => Math.pow(Math.sin(Math.PI * (0.06 + t * 0.88)), 0.36);
  // Smooth billowing waves of the displaced snow berm without fine sawtooth jaggies
  const nTop = makeNoise(rng, [[1, 0.10], [2, 0.08], [3, 0.05], [5, 0.03]]);
  const nBot = makeNoise(rng, [[1, 0.10], [2, 0.08], [3, 0.05], [5, 0.03]]);

  const N = 48;
  const basePts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = spine(t);
    const pr = prof(t);
    const wModTop = Math.max(0.82, 1 + nTop(t * TAU) * 0.22);
    const wModBot = Math.max(0.82, 1 + nBot(t * TAU) * 0.22);
    basePts.push({
      p,
      wTop: half * pr * 0.98 * wModTop,
      wBot: half * pr * 0.98 * wModBot
    });
  }

  const traceCapsule = (wMul: number) => {
    ctx.beginPath();
    const p0 = basePts[0].p, pN = basePts[N].p;
    ctx.moveTo(p0.x, p0.y - basePts[0].wTop * wMul);
    for (let i = 1; i <= N; i++) ctx.lineTo(basePts[i].p.x, basePts[i].p.y - basePts[i].wTop * wMul);
    const rCapN = (basePts[N].wTop + basePts[N].wBot) * 0.5 * wMul;
    const cyN = pN.y + (basePts[N].wBot - basePts[N].wTop) * 0.5 * wMul;
    for (let k = 1; k <= 14; k++) {
      const a = -Math.PI * 0.5 + (k / 14) * Math.PI;
      ctx.lineTo(pN.x + Math.cos(a) * rCapN * 0.95, cyN + Math.sin(a) * rCapN);
    }
    for (let i = N - 1; i >= 0; i--) ctx.lineTo(basePts[i].p.x, basePts[i].p.y + basePts[i].wBot * wMul);
    const rCap0 = (basePts[0].wTop + basePts[0].wBot) * 0.5 * wMul;
    const cy0Cap = p0.y + (basePts[0].wBot - basePts[0].wTop) * 0.5 * wMul;
    for (let k = 1; k < 14; k++) {
      const a = Math.PI * 0.5 + (k / 14) * Math.PI;
      ctx.lineTo(p0.x + Math.cos(a) * rCap0 * 0.95, cy0Cap + Math.sin(a) * rCap0);
    }
    ctx.closePath();
    ctx.fill();
  };

  // Dense volumetric snow-trough profile with a smooth berm
  ctx.fillStyle = '#ffffff';
  for (const [wMul, alpha] of [
    [1.02, 0.24],
    [0.96, 0.50],
    [0.91, 0.78],
    [0.86, 0.95],
    [0.78, 1.00]
  ]) {
    ctx.globalAlpha = alpha;
    traceCapsule(wMul);
  }

  // Large pillow-like swells of displaced snow along both berm crests (without fine teeth)
  const flankSwells = 14 + rng.int(4);
  for (let i = 0; i < flankSwells; i++) {
    const t = 0.12 + ((i + rng.next() * 0.65) / flankSwells) * 0.76;
    const endFade = Math.sin(t * Math.PI);
    const idxPt = Math.min(N, Math.max(0, Math.round(t * N)));
    const bp = basePts[idxPt];
    const side = (i & 1) ? 1 : -1;
    const wSide = side < 0 ? bp.wTop : bp.wBot;
    const cxClump = bp.p.x + rng.range(-3.0, 3.0);
    const cyClump = bp.p.y + side * wSide * rng.range(0.70, 0.86);
    const rClump = rng.range(11.5, 17.5) * (0.70 + 0.30 * endFade);
    const wob = makeWobble(rng, [[2, 0.12], [3, 0.07]]);
    ctx.globalAlpha = 0.78 * Math.pow(endFade, 0.45);
    ctx.beginPath();
    blobSubpath(ctx, cxClump, cyClump, rClump, wob, { points: 18, jitter: 0.02, jitRng: rng });
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Elliptical feathering of the capsule ends for seamless stitching across consecutive trench steps
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.translate(128, 128);
  ctx.scale(1.0, 0.60);
  const ovalGrad = ctx.createRadialGradient(0, 0, 80, 0, 0, 118);
  ovalGrad.addColorStop(0.00, 'rgba(0,0,0,1)');
  ovalGrad.addColorStop(0.72, 'rgba(0,0,0,0.96)');
  ovalGrad.addColorStop(0.90, 'rgba(0,0,0,0.54)');
  ovalGrad.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = ovalGrad;
  ctx.fillRect(-128, -228, 256, 456);
  ctx.restore();

  // Subtle snow grains along the outer berm crests
  const grainPts = [];
  const grainN = 180 + rng.int(60);
  for (let i = 0; i < grainN; i++) {
    const t = 0.12 + rng.next() * 0.76;
    const p = spine(t);
    const w = half * prof(t);
    const side = rng.next() < 0.5 ? -1 : 1;
    const lat = side * w * (0.72 + 0.24 * Math.sqrt(rng.next()));
    const a = rng.range(0.18, 0.42) * Math.sin(t * Math.PI);
    grainPts.push({
      x: p.x + (rng.next() - 0.5) * 8,
      y: p.y + lat,
      r: 0.65 + rng.next() * 1.10,
      a
    });
  }
  drawGrain(ctx, grainPts);
  done();
}

/** Snowdrift (pool): smooth aerodynamic snow blanket + crisp crystalline rim without mushy blur. */
function drawSnowPool(mask, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const r0 = rng.range(97, 103);

  snowPillow(ctx, rng, cx, cy, r0, 6, 0.54);
  clipSnowCellRadius(ctx, cx, cy);
  done();
}

/**
 * Light snow dusting (droplet): wide airy veil of fresh snow with a soft density dome,
 * free of sharp edges or rings; at lv=1 (isLightFrost) it erodes into crumbly patches
 * of fluffy snow and frost, and as snowfall accumulates to lv>=2 it merges smoothly into a snowbank.
 */
function drawSnowDroplet(mask, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const baseR = rng.range(98, 104);
  const stretchA = rng.angle();
  const stretchK = rng.range(0.05, 0.09);
  const baseWob = makeWobble(rng, [[2, 0.08], [3, 0.052], [4, 0.03], [5, 0.015]]);
  const sharedWob = (a: number) => baseWob(a) + Math.cos(2 * (a - stretchA)) * stretchK;

  ctx.fillStyle = '#ffffff';
  const steps = 16;
  for (let s = 0; s < steps; s++) {
    const t = s / (steps - 1);
    const rMul = 1.00 - t * 0.56;
    ctx.globalAlpha = 0.05 + t * 0.115;
    ctx.beginPath();
    blobSubpath(ctx, cx, cy, baseR * rMul, sharedWob, { points: 88, jitter: 0 });
    ctx.fill();
  }
  ctx.globalAlpha = 0.96;
  ctx.beginPath();
  blobSubpath(ctx, cx, cy, baseR * 0.44, sharedWob, { points: 88, jitter: 0 });
  ctx.fill();
  ctx.globalAlpha = 1;
  clipSnowCellRadius(ctx, cx, cy);
  done();
}

const SNOW_GENS = {
  splat: drawSnowSplat,
  splash: drawSnowSplash,
  smear: drawSnowSmear,
  pool: drawSnowPool,
  droplet: drawSnowDroplet
};

/** Stain kinds using the snow mask (footprint uses the regular mask: a track in snow is a shadow). */
const SNOW_KINDS = new Set(Object.keys(SNOW_GENS));

/** Lazy construction of the snow atlas (distinct seeds; shared detail atlas untouched). */
function ensureSnowMask() {
  if (_maskSnowAtlas) return _maskSnowAtlas;
  _maskSnowAtlas = document.createElement('canvas');
  _maskSnowAtlas.width = ATLAS_W;
  _maskSnowAtlas.height = ATLAS_H;
  for (const [kind, n] of LAYOUT) {
    if (!SNOW_GENS[kind]) continue; // kind uses the shared mask even in snow
    for (let i = 0; i < n; i++) {
      const rng = new Rng(hashStr(`ss-blood-v6-snow-${kind}-${i}`));
      SNOW_GENS[kind](_maskSnowAtlas, KIND_BASE[kind] + i, rng);
    }
  }
  return _maskSnowAtlas;
}

/**
 * Footprint (interactive token tracks), v2 — anatomical
 * silhouette: smooth half-width profile "ball → arch → heel" (smoothstep
 * between zones, elliptical rounding at toe and heel), contour via
 * traceSmooth, NO polygonal chamfers or straight bridges. Transverse
 * tread is carved out of the base coat (destination-out) and dampens grain;
 * pressure gradient (ball/heel denser than arch), soft edge, squeezed-out
 * rim, toe smear. Oriented toe-forward ALONG +X (stain rotation =
 * movement direction). Variants: 0/2 — left (toe angled outward toward −Y),
 * 1/3 — right (+Y); second pair is "worn" (fainter grooves, sparser grain).
 */
function drawFootprint(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const i0 = idx - KIND_BASE.footprint;
  const left = i0 % 2 === 0;
  const worn = i0 < 2 ? 0 : 1;
  const side = left ? -1 : 1;

  // ---- geometry: sole half-width along the axis (logical 256, toe toward +X) ----
  const halfBall = rng.range(19, 22);     // ball of the foot — widest part
  const halfWaist = rng.range(10, 12);    // arch waist narrowing
  const halfHeel = rng.range(13, 15);     // heel
  const ballX = 10, waistX = -12, heelX = -36;
  const toeR = rng.range(24, 27);
  const heelR = rng.range(16, 19);
  const tilt = side * rng.range(0.10, 0.18); // toe angled outward
  const tip = ballX + toeR * 1.75;
  const back = heelX - heelR;
  // cell scale: track fills ~90% of the atlas cell (otherwise in-game the boot
  // comes out half the stain size and reads as a generic blotch)
  const G = 2.0;
  const smooth = (t) => t * t * (3 - 2 * t);
  const halfAt = (x) => {
    if (x >= ballX) return halfBall * Math.sqrt(Math.max(0, 1 - Math.pow((x - ballX) / (tip - ballX), 2)));
    if (x >= waistX) return halfWaist + (halfBall - halfWaist) * smooth((x - waistX) / (ballX - waistX));
    if (x >= heelX) return halfHeel + (halfWaist - halfHeel) * smooth((x - heelX) / (waistX - heelX));
    return halfHeel * Math.sqrt(Math.max(0, 1 - Math.pow((heelX - x) / heelR, 2)));
  };
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const rot = (x, y) => ({ x: cx + (x * cosT - y * sinT) * G, y: cy + (x * sinT + y * cosT) * G });
  const unrot = (px, py) => {
    const dx = (px - cx) / G, dy = (py - cy) / G;
    return { x: dx * cosT + dy * sinT, y: -dx * sinT + dy * cosT };
  };

  // ---- 1) base coat: single smooth closed contour ----
  const N = 40;
  const outline = [];
  for (let i = 0; i <= N; i++) {
    const x = back + (tip - back) * (i / N);
    outline.push(rot(x, -halfAt(x)));
  }
  for (let i = N; i >= 0; i--) {
    const x = back + (tip - back) * (i / N);
    outline.push(rot(x, halfAt(x)));
  }
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.32;
  ctx.beginPath();
  traceSmooth(ctx, outline);
  ctx.fill();

  // ---- 2) foot arch: natural recess between forefoot sole and heel
  //         (no modern rubber tread bars, so the track reads as a
  //         fantasy boot/shoe or pressed bare/soft-soled foot) ----
  const grooves = [
    { x: -10 + rng.range(-1.5, 1.5), hw: 3.2, w: rng.range(5.2, 6.8), a: 0.72 }
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out'; // cell clip keeps cutout local
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  for (const g of grooves) {
    const h = halfAt(g.x) * 0.85 * G;
    const gx = g.x * G, bend = side * 2.2 * G;
    ctx.globalAlpha = g.a;
    ctx.lineWidth = g.w;
    ctx.beginPath();
    ctx.moveTo(cx + gx - bend, cy - h);
    ctx.quadraticCurveTo(cx + gx + bend, cy, cx + gx - bend, cy + h);
    ctx.stroke();
  }
  ctx.restore();

  // ---- 3) grain: pressure (ball/heel denser than arch), soft edge,
  //         grooves dampen density ----
  const grooveMul = (x) => {
    for (const g of grooves) {
      const d = Math.abs(x - g.x);
      if (d < g.hw * 2.2) return 0.12 + 0.88 * (d / (g.hw * 2.2));
    }
    return 1;
  };
  const nFine = makeNoise(rng, [[3, 0.12], [7, 0.07]]);
  const grainN = 2200 + rng.int(500);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    const x = rng.range(back - 2, tip + 2), y = rng.range(-26, 26);
    const u = unrot(x, y);
    if (u.x < back || u.x > tip || Math.abs(u.y) > halfAt(u.x)) continue;
    const edge = Math.abs(u.y) / halfAt(u.x); // 0 — axis, 1 — edge
    if (rng.next() < edge * edge * 0.85) continue; // edge dissolves
    const pressure = u.x > waistX + 8 || u.x < heelX + 6 ? 1 : 0.6; // arch is lighter
    const dens = (0.55 + 0.45 * rng.next()) * grooveMul(u.x) * pressure
      * (worn ? 0.75 : 1) * (0.75 + 0.25 * nFine(u.x));
    if (rng.next() > dens * 1.8) continue;
    const p = rot(x + gauss(rng) * 0.8, y + gauss(rng) * 0.8);
    pts.push({
      x: p.x, y: p.y,
      r: 0.55 + rng.next() * rng.next() * 2.1,
      a: Math.min(0.95, 0.34 + dens * 0.66 * (1 - edge * 0.35))
    });
  }
  drawGrain(ctx, pts);

  // ---- 4) squeezed-out rim along the contour + smear at the toe ----
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  for (let i = 0; i < 18; i++) {
    const x = rng.range(back + 4, tip - 4);
    const h = halfAt(x);
    if (h < 3) continue;
    const p = rot(x, (rng.chance(0.5) ? -1 : 1) * h * rng.range(1.0, 1.07));
    circleSubpath(ctx, p.x, p.y, 0.5 + rng.next() * 1.1);
  }
  ctx.fill();
  for (let i = 0, n = rng.int(2) + 1; i < n; i++) {
    const sy = toeR * gauss(rng) * 0.4;
    const p = rot(tip - 6, sy);
    filament(ctx, rng, p.x, p.y, tilt + rng.range(-0.35, 0.35), rng.range(7, 13),
      side * rng.range(0.2, 0.6), rng.range(1.2, 2.4), 18 + rng.int(12));
  }
  done();

  // ---- detail: dark wear specks inside the sole ----
  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  for (let i = 0, n = 20 + rng.int(16); i < n; i++) {
    const x = rng.range(back, tip), y = rng.range(-22, 22);
    const u = unrot(x, y);
    if (u.x < back + 2 || u.x > tip - 2 || Math.abs(u.y) > halfAt(u.x) * 0.9) continue;
    const p = rot(x, y);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.24).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, p.x, p.y, rng.range(0.6, 1.6) * G * 0.6);
    dctx.fill();
  }
  d2.done();
}

/**
 * Beast pawprint (wolves, hounds, bears, big cats):
 * wide three-lobed heel pad (metacarpal pad) + 4 digital
 * toe pads fanned out in front + short claw marks.
 * 0/2 — left paw, 1/3 — right paw; 2/3 — more smudged/worn print.
 */
function drawPawprint(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const i0 = idx - KIND_BASE.pawprint;
  const left = i0 % 2 === 0;
  const worn = i0 < 2 ? 0 : 1;
  const side = left ? -1 : 1;
  const tilt = side * rng.range(0.06, 0.14);
  const G = 1.95;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const rot = (x, y) => ({ x: cx + (x * cosT - y * sinT) * G, y: cy + (x * sinT + y * cosT) * G });

  // Paw pads in local coordinates (toes toward +X):
  // central three-lobed heel + 4 oval toes fanned out
  const heelLobes = [
    { x: -13, y: 0, rx: 14.5, ry: 17.5 },
    { x: -18, y: -11, rx: 10.5, ry: 11.5 },
    { x: -18, y: 11, rx: 10.5, ry: 11.5 },
    { x: -5, y: 0, rx: 11.5, ry: 12.5 }
  ];
  const toes = [
    { x: 14, y: -23, rx: 10.5, ry: 7.2, a: -0.42 },
    { x: 24, y: -8.5, rx: 11.8, ry: 7.6, a: -0.14 },
    { x: 24, y: 8.5, rx: 11.8, ry: 7.6, a: 0.14 },
    { x: 14, y: 23, rx: 10.5, ry: 7.2, a: 0.42 }
  ];

  // Point-in-pad density test for (lx, ly) across paw pads (returns density 0..1)
  const padDensity = (lx, ly) => {
    let best = 0;
    for (const h of heelLobes) {
      const dx = (lx - h.x) / h.rx, dy = (ly - h.y) / h.ry;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        const v = 1 - Math.sqrt(d2);
        if (v > best) best = v;
      }
    }
    for (const t of toes) {
      const ca = Math.cos(-t.a), sa = Math.sin(-t.a);
      const tx = (lx - t.x) * ca - (ly - t.y) * sa;
      const ty = (lx - t.x) * sa + (ly - t.y) * ca;
      const d2 = (tx / t.rx) * (tx / t.rx) + (ty / t.ry) * (ty / t.ry);
      if (d2 < 1) {
        const v = (1 - Math.sqrt(d2)) * 1.1;
        if (v > best) best = v;
      }
    }
    return Math.min(1, best);
  };

  // 1) Soft pad base coat and short claws ahead of the toes
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.34;
  for (const h of heelLobes) {
    const p = rot(h.x, h.y);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, h.rx * G * 0.94, h.ry * G * 0.94, tilt, 0, TAU);
    ctx.fill();
  }
  for (const t of toes) {
    const p = rot(t.x, t.y);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, t.rx * G * 0.94, t.ry * G * 0.94, tilt + t.a, 0, TAU);
    ctx.fill();
    // Short claw ahead of each toe
    const clawBase = rot(t.x + Math.cos(t.a) * (t.rx + 2.5), t.y + Math.sin(t.a) * (t.rx + 2.5));
    const clawTip = rot(t.x + Math.cos(t.a) * (t.rx + 9.5), t.y + Math.sin(t.a) * (t.rx + 9.5));
    const clawL = rot(t.x + Math.cos(t.a) * (t.rx + 2.2) - Math.sin(t.a) * 2.4, t.y + Math.sin(t.a) * (t.rx + 2.2) + Math.cos(t.a) * 2.4);
    const clawR = rot(t.x + Math.cos(t.a) * (t.rx + 2.2) + Math.sin(t.a) * 2.4, t.y + Math.sin(t.a) * (t.rx + 2.2) - Math.cos(t.a) * 2.4);
    ctx.globalAlpha = worn ? 0.45 : 0.68;
    ctx.beginPath();
    ctx.moveTo(clawL.x, clawL.y);
    ctx.quadraticCurveTo(clawBase.x, clawBase.y, clawTip.x, clawTip.y);
    ctx.lineTo(clawR.x, clawR.y);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.34;
  }

  // 2) Granular pressure grain inside the pads
  const grainN = 2100 + rng.int(450);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    const lx = rng.range(-34, 42), ly = rng.range(-36, 36);
    const d = padDensity(lx, ly);
    if (d <= 0.04) continue;
    const edge = 1 - d;
    if (rng.next() < edge * edge * 0.78) continue;
    const dens = (0.55 + 0.45 * rng.next()) * (0.4 + 0.6 * d) * (worn ? 0.76 : 1);
    const p = rot(lx + gauss(rng) * 0.7, ly + gauss(rng) * 0.7);
    pts.push({
      x: p.x, y: p.y,
      r: 0.55 + rng.next() * rng.next() * 2.0,
      a: Math.min(0.95, 0.36 + dens * 0.62)
    });
  }
  drawGrain(ctx, pts);
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  for (let i = 0, n = 16 + rng.int(12); i < n; i++) {
    const lx = rng.range(-28, 34), ly = rng.range(-30, 30);
    if (padDensity(lx, ly) < 0.25) continue;
    const p = rot(lx, ly);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.22).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, p.x, p.y, rng.range(0.6, 1.5) * G * 0.6);
    dctx.fill();
  }
  d2.done();
}

/**
 * Three-toed clawed print (dragons, monsters, reptiles, birds, ghouls, skeletons):
 * narrow heel pad + 3 long splayed digits tipped with heavy sharp talons + rear hallux spur.
 */
function drawClawprint(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const i0 = idx - KIND_BASE.clawprint;
  const left = i0 % 2 === 0;
  const worn = i0 < 2 ? 0 : 1;
  const side = left ? -1 : 1;
  const tilt = side * rng.range(0.08, 0.16);
  const G = 1.95;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const rot = (x, y) => ({ x: cx + (x * cosT - y * sinT) * G, y: cy + (x * sinT + y * cosT) * G });

  const digits = [
    { ax: -10, ay: -4, bx: 24, by: -24, tx: 37, ty: -31, w0: 7.5, w1: 3.4 },
    { ax: -8, ay: 0, bx: 31, by: 0, tx: 46, ty: 0, w0: 8.5, w1: 3.8 },
    { ax: -10, ay: 4, bx: 24, by: 24, tx: 37, ty: 31, w0: 7.5, w1: 3.4 },
    // rear dewclaw / hallux spur
    { ax: -14, ay: 0, bx: -30, by: side * 4, tx: -39, ty: side * 6, w0: 5.8, w1: 2.4 }
  ];

  const distToSeg = (px, py, x0, y0, x1, y1) => {
    const dx = x1 - x0, dy = y1 - y0;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2));
    return { d: Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)), t };
  };

  const clawDensity = (lx, ly) => {
    let best = 0;
    // Central palm/heel hub
    const hDist = Math.hypot((lx + 12) / 12, ly / 11);
    if (hDist < 1) best = 1 - hDist;
    for (const dg of digits) {
      const { d, t } = distToSeg(lx, ly, dg.ax, dg.ay, dg.bx, dg.by);
      // phalanges swell slightly at knuckle nodes along the digit
      const phalanx = 1 + 0.16 * Math.sin(t * Math.PI * 2.5);
      const w = (dg.w0 * (1 - t) + dg.w1 * t) * phalanx;
      if (d < w) {
        const v = 1 - d / w;
        if (v > best) best = v;
      }
      // sharp talon at digit tip
      const cSeg = distToSeg(lx, ly, dg.bx, dg.by, dg.tx, dg.ty);
      const cw = dg.w1 * 0.85 * (1 - cSeg.t * 0.88);
      if (cSeg.d < cw) {
        const v = (1 - cSeg.d / Math.max(0.4, cw)) * 1.15;
        if (v > best) best = v;
      }
    }
    return Math.min(1, best);
  };

  // 1) Solid base coat for phalanges and sharp talons
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  for (const dg of digits) {
    const pA = rot(dg.ax, dg.ay);
    const pB = rot(dg.bx, dg.by);
    const pT = rot(dg.tx, dg.ty);
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = ((dg.w0 + dg.w1) * 0.5) * G * 1.5;
    ctx.beginPath();
    ctx.moveTo(pA.x, pA.y);
    ctx.lineTo(pB.x, pB.y);
    ctx.stroke();

    // Talon tip
    const ang = Math.atan2(pT.y - pB.y, pT.x - pB.x);
    const nx = -Math.sin(ang) * dg.w1 * G * 0.75;
    const ny = Math.cos(ang) * dg.w1 * G * 0.75;
    ctx.globalAlpha = worn ? 0.58 : 0.82;
    ctx.beginPath();
    ctx.moveTo(pB.x + nx, pB.y + ny);
    ctx.lineTo(pT.x, pT.y);
    ctx.lineTo(pB.x - nx, pB.y - ny);
    ctx.closePath();
    ctx.fill();
  }

  // 2) Granular grain along digits and talons
  const grainN = 2000 + rng.int(450);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    const lx = rng.range(-42, 48), ly = rng.range(-36, 36);
    const d = clawDensity(lx, ly);
    if (d <= 0.04) continue;
    const edge = 1 - d;
    if (rng.next() < edge * edge * 0.75) continue;
    const dens = (0.55 + 0.45 * rng.next()) * (0.42 + 0.58 * d) * (worn ? 0.76 : 1);
    const p = rot(lx + gauss(rng) * 0.6, ly + gauss(rng) * 0.6);
    pts.push({
      x: p.x, y: p.y,
      r: 0.55 + rng.next() * rng.next() * 1.95,
      a: Math.min(0.96, 0.38 + dens * 0.6)
    });
  }
  drawGrain(ctx, pts);
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  for (let i = 0, n = 14 + rng.int(10); i < n; i++) {
    const lx = rng.range(-32, 40), ly = rng.range(-30, 30);
    if (clawDensity(lx, ly) < 0.25) continue;
    const p = rot(lx, ly);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.22).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, p.x, p.y, rng.range(0.6, 1.4) * G * 0.6);
    dctx.fill();
  }
  d2.done();
}

/**
 * Cloven hoof / horseshoe print (horses, boars, deer, minotaurs, centaurs):
 * two crescent halves separated by a sharp longitudinal cleft down the middle and a dense outer weight-bearing rim.
 */
function drawHoofprint(mask, detail, idx, rng) {
  const { ctx, done } = cellCtx(mask, idx);
  const cx = 128, cy = 128;
  const i0 = idx - KIND_BASE.hoofprint;
  const left = i0 % 2 === 0;
  const worn = i0 < 2 ? 0 : 1;
  const side = left ? -1 : 1;
  const tilt = side * rng.range(0.04, 0.10);
  const G = 2.0;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const rot = (x, y) => ({ x: cx + (x * cosT - y * sinT) * G, y: cy + (x * sinT + y * cosT) * G });

  // Density function for the paired hoof halves (lx in [-28..30], ly in [-24..24])
  const hoofDensity = (lx, ly) => {
    const nx = lx / 28;
    const ay = Math.abs(ly);
    // Taper toward the toe (+X) and round off the heel (-X)
    const maxW = 22 * (1 - 0.24 * nx) * Math.sqrt(Math.max(0, 1 - nx * nx * 0.88));
    if (ay > maxW || lx < -28 || lx > 30) return 0;
    // Longitudinal hoof cleft (wider at the front and around the central frog)
    const cleftW = lx > -6 ? 2.4 + Math.max(0, (lx + 6) / 36) * 4.8 : 1.8;
    if (ay < cleftW) return 0;
    // Central sole hollow (frog) so the outer wall rim stays denser than the interior
    const frogDist = Math.hypot((lx + 4) / 14, (ay - 9) / 6.5);
    const rimBoost = frogDist < 0.85 ? 0.55 + 0.45 * frogDist : 1;
    const outerEdge = (maxW - ay) / Math.max(1, maxW - cleftW);
    const innerEdge = (ay - cleftW) / Math.max(1, maxW - cleftW);
    const edgeFactor = Math.min(1, Math.min(outerEdge, innerEdge) * 2.8);
    return edgeFactor * rimBoost;
  };

  // 1) Base coat for both hoof halves
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.36;
  for (const sgn of [-1, 1]) {
    const pts = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lx = -25 + t * 53;
      const nx = lx / 28;
      const outerY = sgn * 21 * (1 - 0.24 * nx) * Math.sqrt(Math.max(0.02, 1 - nx * nx * 0.88));
      pts.push(rot(lx, outerY));
    }
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const lx = -25 + t * 53;
      const cleftW = lx > -6 ? 2.6 + Math.max(0, (lx + 6) / 36) * 4.5 : 2.0;
      pts.push(rot(lx, sgn * cleftW));
    }
    ctx.beginPath();
    traceSmooth(ctx, pts);
    ctx.fill();
  }

  // 2) Granular grain emphasizing the weight-bearing outer wall and hoof tips
  const grainN = 2100 + rng.int(450);
  const pts = [];
  for (let i = 0; i < grainN; i++) {
    const lx = rng.range(-28, 31), ly = rng.range(-24, 24);
    const d = hoofDensity(lx, ly);
    if (d <= 0.05) continue;
    const dens = (0.58 + 0.42 * rng.next()) * d * (worn ? 0.76 : 1);
    if (rng.next() > dens * 1.65) continue;
    const p = rot(lx + gauss(rng) * 0.6, ly + gauss(rng) * 0.6);
    pts.push({
      x: p.x, y: p.y,
      r: 0.55 + rng.next() * rng.next() * 2.0,
      a: Math.min(0.96, 0.40 + dens * 0.58)
    });
  }
  drawGrain(ctx, pts);
  done();

  const d2 = cellCtx(detail, idx);
  const dctx = d2.ctx;
  for (let i = 0, n = 14 + rng.int(10); i < n; i++) {
    const lx = rng.range(-24, 26), ly = rng.range(-20, 20);
    if (hoofDensity(lx, ly) < 0.3) continue;
    const p = rot(lx, ly);
    dctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.24).toFixed(2)})`;
    dctx.beginPath();
    circleSubpath(dctx, p.x, p.y, rng.range(0.6, 1.5) * G * 0.6);
    dctx.fill();
  }
  d2.done();
}

/* ----------------------------------- API ----------------------------------- */

/**
 * Material profiles: shading a shape for a specific substance.
 * 0 blood — wet, specular; 2 snow — crisp white, cool, minimal gloss.
 */
const BLOOD_PROFILE = {
  id: 0,
  stops: [[0.0, 0.14], [0.5, 0], [1.0, -0.34]] as [number, number][],
  detailAlpha: 0.18,
  gloss: { patchA: 0.06, patchR: [16, 34] as [number, number], specA: [0.35, 0.7] as [number, number], specR: [0.9, 2] as [number, number] }
};

const SNOW_PROFILE = {
  id: 2,
  stops: [[0.0, 0.03], [0.55, 0.0], [1.0, -0.02]] as [number, number][],
  detailAlpha: 0,
  gloss: { patchA: 0.03, patchR: [32, 56] as [number, number], specA: [0.28, 0.55] as [number, number], specR: [0.4, 0.9] as [number, number] }
};

export const MATERIAL_PROFILES = [BLOOD_PROFILE, SNOW_PROFILE];

export const MATERIAL_COUNT = MATERIAL_PROFILES.length;

let _snowSurfaceMaps: {
  uPillow: Float32Array;
  uSastrugi: Float32Array;
  uPowder: Float32Array;
  uVeil: Float32Array;
  uSparkle: Float32Array;
  dHeight: Float32Array;
  dPocket: Float32Array;
  dClod: Float32Array;
} | null = null;

let _snowWorldTile: any = null;
let _snowWorldPatCache = new WeakMap<any, any>();

/**
 * Precompute seamless 512×512 micro- and meso-relief maps for natural snow (NO cellular F2−F1 ridges):
 *  - uPillow   : soft fluffy snow pillows and drifts (multi-octave C²-smooth FBM on rotated axes);
 *  - uSastrugi : smooth wind-blown sastrugi and spindrift waves along NW→SE wind;
 *  - uPowder   : powdery crystalline fresh-snow grain and frost powder (convex micro-crystals without "worms");
 *  - uVeil     : lacy wind-powder veil field (0..1) for airy ground gaps on light snow (`lv = 1`);
 *  - uSparkle  : glinting ice facets ("diamond dust") on sunlit slopes;
 *  - dHeight / dPocket / dClod : loose upturned snow clods and pockets inside trampled footprints and trenches.
 */
function ensureSnowSurfaceMaps() {
  if (_snowSurfaceMaps) return _snowSurfaceMaps;
  const S = 512;
  const MASK = S - 1;
  const rng = new Rng(hashStr('ss-crisp-snow-surface-v14'));
  const g0 = new Float32Array(S * S);
  const g1 = new Float32Array(S * S);
  const g2 = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    g0[i] = rng.next() * 2 - 1;
    g1[i] = rng.next() * 2 - 1;
    g2[i] = rng.next() * 2 - 1;
  }

  // C²-smooth quintic interpolation on a periodic lattice with period mask pMask = (512 / scale) - 1:
  // integer-matrix axis rotation preserves exact 512×512 seamless tiling with zero 0°/90° grid artifacts.
  const sampleQuintic = (grid: Float32Array, pMask: number, fx: number, fy: number) => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const ix0 = x0 & pMask, ix1 = (x0 + 1) & pMask;
    const iy0 = (y0 & pMask) << 9, iy1 = ((y0 + 1) & pMask) << 9;
    const v00 = grid[iy0 | ix0], v10 = grid[iy0 | ix1];
    const v01 = grid[iy1 | ix0], v11 = grid[iy1 | ix1];
    const a = v00 + sx * (v10 - v00);
    const b = v01 + sx * (v11 - v01);
    return a + sy * (b - a);
  };

  // Random centers of soft crystalline grains (convex F1 distance ONLY, no F2−F1 cell walls!)
  const CM = 128;
  const featX = new Float32Array(CM * CM);
  const featY = new Float32Array(CM * CM);
  const featV = new Float32Array(CM * CM);
  for (let i = 0; i < CM * CM; i++) {
    featX[i] = 0.12 + rng.next() * 0.76;
    featY[i] = 0.12 + rng.next() * 0.76;
    featV[i] = rng.next();
  }

  let wD1 = 0, wVal = 0;
  const evalGrain = (cMask: number, shift: number, fx: number, fy: number) => {
    const cx0 = Math.floor(fx);
    const cy0 = Math.floor(fy);
    let d1Sq = 1e9;
    let bestV = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ncy = ((cy0 + dy + shift) & cMask) << 7;
      const basePy = cy0 + dy;
      for (let dx = -1; dx <= 1; dx++) {
        const ncx = (cx0 + dx + shift) & cMask;
        const idxC = ncy | ncx;
        const ox = cx0 + dx + featX[idxC] - fx;
        const oy = basePy + featY[idxC] - fy;
        const dSq = ox * ox + oy * oy;
        if (dSq < d1Sq) {
          d1Sq = dSq;
          bestV = featV[idxC];
        }
      }
    }
    wD1 = Math.sqrt(d1Sq);
    wVal = bestV;
  };

  const uPillow = new Float32Array(S * S);
  const uSastrugi = new Float32Array(S * S);
  const uPowder = new Float32Array(S * S);
  const uVeil = new Float32Array(S * S);
  const uSparkle = new Float32Array(S * S);
  const dHeight = new Float32Array(S * S);
  const dPocket = new Float32Array(S * S);
  const dClod = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    const row = y << 9;
    for (let x = 0; x < S; x++) {
      const idx = row | x;

      // Rotated toroidal coordinates (completely eliminate 0°/90° axial banding)
      const rx1 = 2 * x + y, ry1 = 2 * y - x;
      const rx2 = x + 2 * y, ry2 = y - 2 * x;
      const rx3 = 3 * x + y, ry3 = 3 * y - x;

      const warpX = 14.0 * sampleQuintic(g0, 7, rx1 / 64, ry1 / 64)
        + 6.0 * sampleQuintic(g1, 15, (rx2 + 113) / 32, (ry2 + 59) / 32);
      const warpY = 14.0 * sampleQuintic(g1, 7, (rx1 + 71) / 64, (ry1 + 43) / 64)
        + 6.0 * sampleQuintic(g0, 15, (rx2 + 29) / 32, (ry2 + 97) / 32);
      const wx = x + warpX;
      const wy = y + warpY;

      // 1) Soft fluffy snow pillows (no cellular rings):
      //    sum of smooth FBM domes (scales 64, 32, 16) with a convex snow-cap profile
      const billow64 = sampleQuintic(g0, 7, (wx * 1.0 + wy * 0.5) / 64, (wy * 1.0 - wx * 0.5) / 64);
      const billow32 = sampleQuintic(g1, 15, (wx * 1.0 - wy * 0.5 + 37) / 32, (wy * 1.0 + wx * 0.5 + 91) / 32);
      const billow16 = sampleQuintic(g2, 31, (rx3 + warpX * 0.7) / 16, (ry3 + warpY * 0.7) / 16);
      // Soft convex transform: broad fluffy crowns and gentle hollows
      const softDome64 = 1.0 - Math.abs(billow64) * 0.55 + billow64 * 0.45 - 0.55;
      const softDome32 = 1.0 - Math.abs(billow32) * 0.48 + billow32 * 0.52 - 0.55;
      uPillow[idx] = 0.52 * softDome64 + 0.34 * softDome32 + 0.18 * billow16;

      // 2) Smooth wind sastrugi (NW→SE): streamlined spindrift waves without harsh steps
      const wAlong = (wx * 1.18 + wy * 0.96) / 52.0
        + 0.42 * sampleQuintic(g2, 15, (rx2 + 19) / 32, (ry2 + 83) / 32);
      const wCross = (wx * 0.96 - wy * 1.18) / 40.0
        + 0.38 * sampleQuintic(g1, 15, (rx1 + 53) / 32, (ry1 + 17) / 32);
      const sWave1 = Math.sin(wAlong * TAU + 0.32 * Math.sin(wAlong * TAU));
      const sWave2 = Math.sin((wAlong * 1.9 + 0.35 * Math.cos(wCross * Math.PI)) * TAU);
      const crossFade = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos(wCross * Math.PI * 1.3));
      uSastrugi[idx] = (0.34 * sWave1 + 0.16 * sWave2) * crossFade;

      // 3) Velvety snow powder and crystalline grain (12px, 6px, 3px scales + micro-noise):
      //    uses convex crystal micro-peaks only, with zero polygonal cell walls!
      const oct12 = sampleQuintic(g1, 31, rx1 / 16, ry1 / 16);
      const oct8 = sampleQuintic(g0, 63, rx2 / 8, ry2 / 8);
      const oct4 = sampleQuintic(g2, 127, rx3 / 4, ry3 / 4);
      const fineFrost = g0[idx] * 0.42
        + g1[((y + 1) & MASK) << 9 | ((x + 2) & MASK)] * 0.33
        + g2[((y + 3) & MASK) << 9 | ((x + 5) & MASK)] * 0.25;

      evalGrain(63, 43, (x + warpX * 0.28) / 8, (y + warpY * 0.28) / 8);
      const crystalD1 = wD1, crystalV = wVal;
      const crystalPeak = crystalD1 < 0.48
        ? Math.pow((0.48 - crystalD1) / 0.48, 1.6) * (0.35 + 0.65 * crystalV)
        : 0;

      uPowder[idx] = 0.30 * oct12 + 0.30 * oct8 + 0.24 * oct4 + 0.22 * crystalPeak + 0.16 * fineFrost;

      // 4) Lacy powder veil (0..1): airy frost islands and ground gaps for light snow (`lv = 1`)
      const veilMacro = 0.5 + 0.5 * sampleQuintic(g2, 15, (wx + 61) / 32, (wy + 23) / 32);
      const veilMid = 0.5 + 0.5 * oct12;
      const veilFine = 0.5 + 0.5 * oct8;
      uVeil[idx] = Math.max(0, Math.min(1, 0.46 * veilMacro + 0.34 * veilMid + 0.20 * veilFine));

      // 5) Glinting "diamond dust" — pinpoint ice facets catching sunlight
      const glintNoise = g2[idx] * 0.6 + g0[((y + 7) & MASK) << 9 | ((x + 11) & MASK)] * 0.4;
      const crystalSpark = (crystalD1 < 0.24 && crystalV > 0.74)
        ? Math.min(1, (0.24 - crystalD1) * 4.2 * (crystalV - 0.50))
        : 0;
      const microSpark = glintNoise > 0.74 ? Math.min(1, (glintNoise - 0.74) * 3.4) : 0;
      uSparkle[idx] = Math.max(crystalSpark, microSpark * 0.85);

      // 6) Trampled snow in trenches and footprints: loose clods and soft pockets (no cracked "cobwebs")
      const dwx = x + 8.5 * sampleQuintic(g1, 15, (rx2 + 41) / 32, (ry2 + 89) / 32);
      const dwy = y + 8.5 * sampleQuintic(g0, 15, (rx1 + 107) / 32, (ry1 + 23) / 32);
      evalGrain(31, 89, dwx / 16, dwy / 16);
      const pD1 = wD1, pV = wVal;
      evalGrain(63, 103, (dwx + 17) / 8, (dwy + 29) / 8);
      const sD1 = wD1, sV = wVal;

      const isPocket = pV > 0.46;
      const pit = isPocket ? Math.pow(Math.max(0, 1 - pD1 * 1.48), 1.5) * (0.55 + 0.45 * pV) : 0;
      const microPit = sV > 0.58 ? Math.pow(Math.max(0, 1 - sD1 * 1.55), 1.6) * 0.48 : 0;
      const pocket = Math.min(1, pit * 0.88 + microPit * 0.45);

      const clodMain = !isPocket
        ? Math.pow(Math.max(0, 1 - pD1 * 1.30), 1.25) * 0.82
        : Math.max(0, 1 - Math.abs(pD1 - 0.64) * 3.2) * 0.48;
      const microClod = sV <= 0.58 ? Math.max(0, 0.66 - sD1) * 0.62 : 0;
      const clod = Math.min(1, clodMain + microClod + Math.max(0, oct8) * 0.25);

      dPocket[idx] = pocket;
      dClod[idx] = clod;
      dHeight[idx] = 0.76 * clod - 0.82 * pocket + 0.22 * oct12 + 0.14 * oct8;
    }
  }

  _snowSurfaceMaps = { uPillow, uSastrugi, uPowder, uVeil, uSparkle, dHeight, dPocket, dClod };
  return _snowSurfaceMaps;
}

/**
 * Seamless 512×512 world-space snow micro-texture tile:
 * composited via `source-atop` across all snow tiers in world scene coordinates (1:1 scale,
 * never stretched on giant 800px drifts or compressed on tiny frost patches).
 * Sunlit facets and snow crystals add radiant `#ffffff`, while micro-hollows add a delicate
 * cool sky-blue bounce (`rgb(184, 204, 230)`), eliminating any "gray concrete" look.
 */
function ensureSnowWorldTile() {
  if (_snowWorldTile) return _snowWorldTile;
  if (typeof document === 'undefined') return null;
  const S = 512;
  const MASK = S - 1;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const img = ctx.getImageData(0, 0, S, S);
  const d = img?.data;
  if (!d || d.length < S * S * 4) return null;

  const { uPillow, uSastrugi, uPowder, uSparkle } = ensureSnowSurfaceMaps();
  const sampleH = (k: number) => 0.44 * uPillow[k] + 0.28 * uSastrugi[k] + 0.52 * uPowder[k];

  for (let y = 0; y < S; y++) {
    const row = y << 9;
    const ym6 = ((y - 6) & MASK) << 9, yp6 = ((y + 6) & MASK) << 9;
    const ym2 = ((y - 2) & MASK) << 9, yp2 = ((y + 2) & MASK) << 9;
    const ym1 = ((y - 1) & MASK) << 9, yp1 = ((y + 1) & MASK) << 9;
    let p = y * S * 4;
    for (let x = 0; x < S; x++, p += 4) {
      const k = row | x;
      const h = sampleH(k);
      // NW→SE shading across three scales: soft snow swells (±6px), velvety powder (±2px), and micro-crystals (±1px)
      const slope6 = sampleH(ym6 | ((x - 6) & MASK)) - sampleH(yp6 | ((x + 6) & MASK));
      const slope2 = sampleH(ym2 | ((x - 2) & MASK)) - sampleH(yp2 | ((x + 2) & MASK));
      const slope1 = uPowder[ym1 | ((x - 1) & MASK)] - uPowder[yp1 | ((x + 1) & MASK)];
      const spark = uSparkle[k];

      const shade = (h - 0.34) * 0.45 + slope6 * 0.85 + slope2 * 0.95 + slope1 * 0.82 + spark * 1.15;
      if (shade >= -0.04) {
        // Sunlit snowflakes, fluffy crests, and icy glints -> pure dazzling white
        const sPos = Math.max(0, shade + 0.04);
        const a = Math.min(0.68, Math.tanh(sPos * 1.28) * 0.52 + spark * 0.32);
        d[p] = 255;
        d[p + 1] = 255;
        d[p + 2] = 255;
        d[p + 3] = Math.round(a * 255);
      } else {
        // Airy subsurface scattering in snow micro-hollows (translucent glacial sky bounce)
        const a = Math.min(0.13, Math.tanh((-shade - 0.04) * 1.0) * 0.13);
        d[p] = 184;
        d[p + 1] = 204;
        d[p + 2] = 230;
        d[p + 3] = Math.round(a * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  _snowWorldTile = canvas;
  return canvas;
}

/**
 * Per-pixel shaping of the fluffy snow stamp rim and footprint/trench relief.
 * CRITICAL INVARIANT: `(ox, oy)` depends ONLY on `idx` (stamp cell index) so all
 * 3D passes of the same snowdrift (`ao`, `bank`, `terrace`, `plateau`, `crest`)
 * share an identical powder rim contour!
 * In the Node test harness (`_smoke.mjs`), where `getImageData` returns a zeroed
 * buffer, this exits immediately in O(1) with no side effects.
 */
function applySnowSurfaceTexture(
  ctx: any,
  parsed: { r: number; g: number; b: number; a?: number },
  rawLum: number,
  idx: number,
  isSnowTrench: boolean,
  isSnowPrint: boolean,
  texStyle = 0
) {
  const imgData = ctx.getImageData(0, 0, CELL, CELL);
  const d = imgData?.data;
  if (!d || d.length < CELL * CELL * 4) return;

  // Fast exit on zeroed FakeCanvas stub buffers in _smoke.mjs
  let hasPixels = false;
  const midRow = (CELL >> 1) * CELL * 4;
  for (let x = 16; x < CELL; x += 24) {
    if (d[midRow + (x << 2) + 3] > 0) { hasPixels = true; break; }
  }
  if (!hasPixels) return;

  const maps = ensureSnowSurfaceMaps();
  const MASK = 511;
  const posSeed = hashStr(`ss-snow-pos-v14-${idx}`);
  const ox = posSeed & MASK;
  const oy = (posSeed >>> 9) & MASK;
  const isDisturbed = isSnowTrench || isSnowPrint;

  if (!isDisturbed) {
    const { uPillow, uSastrugi, uPowder, uVeil, uSparkle } = maps;
    const wPil = texStyle === 0 ? 0.62 : texStyle === 2 ? 0.58 : 0.50;
    const wSas = texStyle === 1 ? 0.52 : texStyle === 4 ? 0.42 : 0.24;
    const wPow = texStyle === 3 ? 0.56 : 0.46;

    const isAoPass = rawLum < 95;
    const isSlopePass = rawLum >= 95 && rawLum < 185;
    const isLightFrost = rawLum >= 185 && rawLum < 203;
    const reliefMul = isAoPass ? 0.24 : isSlopePass ? 0.52 : 0.68;

    const sampleH = (k: number) => wPil * uPillow[k] + wSas * uSastrugi[k] + wPow * uPowder[k];

    for (let y = 0; y < CELL; y++) {
      const v = (y + oy) & MASK;
      const vRow = v << 9;
      const vm6 = ((v - 6) & MASK) << 9;
      const vp6 = ((v + 6) & MASK) << 9;
      const vm2 = ((v - 2) & MASK) << 9;
      const vp2 = ((v + 2) & MASK) << 9;
      let p = y * CELL * 4;
      for (let x = 0; x < CELL; x++, p += 4) {
        const a = d[p + 3];
        if (a === 0) continue;
        const u = (x + ox) & MASK;
        const k = vRow | u;

        const h = sampleH(k);
        const pow = uPowder[k];
        const veil = uVeil[k];
        const spark = uSparkle[k];

        const mesoSlope = sampleH(vm6 | ((u - 6) & MASK)) - sampleH(vp6 | ((u + 6) & MASK));
        const fineSlope = sampleH(vm2 | ((u - 2) & MASK)) - sampleH(vp2 | ((u + 2) & MASK));

        const linDelta = (
          h * 11.0
          + mesoSlope * 26.0
          + fineSlope * 18.0
          + spark * 16.0
        ) * reliefMul;

        // Subtle pillow shading: shadows shift toward translucent glacial blue (blue channel dips less than red!),
        // while highlights resolve to clean snow-white with no muddy gray.
        const rawDelta = linDelta >= 0
          ? 16.0 * Math.tanh(linDelta / 16.0)
          : 9.5 * Math.tanh(linDelta / 9.5);

        const dr = rawDelta < 0 ? rawDelta * 1.24 : rawDelta;
        const dg = rawDelta < 0 ? rawDelta * 0.96 : rawDelta;
        const db = rawDelta < 0 ? rawDelta * 0.58 : rawDelta;

        const r = d[p] + dr;
        const g = d[p + 1] + dg;
        const b = d[p + 2] + db;
        d[p] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;

        if (isLightFrost) {
          // Light frost (`lv = 1`): airy lacy veil of fresh snow with soft ground peek-through
          // and powdery frost edges (monotonic across all 0 < a <= 255 with no harsh halos).
          const an = a / 255;
          const env = Math.sin(an * Math.PI);
          const lace = (veil - 0.42) * 0.65 + pow * 0.48;
          const shifted = Math.max(0, Math.min(1, an * 0.94 + lace * (0.32 + 0.34 * env)));
          const soft = shifted * shifted * (3 - 2 * shifted);
          const veilAlpha = Math.max(0.18, Math.min(1.0, 0.34 + veil * 0.72 + pow * 0.28));
          d[p + 3] = Math.round(soft * veilAlpha * 255);
        } else if (a > 0 && a < 248) {
          // Fluffy powder fringe along snow cover and snowdrift borders (`lv >= 2`):
          // solid core (`a >= 248`) stays 100% opaque while the wide bell slope (`0.54..1.00*R`)
          // breaks up into soft fluffy snow powder without felt-like discs or blurry fog.
          const an = a / 248;
          const env = Math.sin(an * Math.PI);
          const powderJitter = pow * 0.64 + (veil - 0.5) * 0.46 + fineSlope * 0.22;
          const amp = isAoPass ? 0.22 : isSlopePass ? 0.30 : 0.36;
          const shifted = Math.max(0, Math.min(1, an + powderJitter * env * amp));
          const fluffy = shifted * shifted * (3 - 2 * shifted);
          d[p + 3] = Math.round(fluffy * 255);
        }
      }
    }
  } else {
    // Trampled snow / trench / print: crumbly snow clods and cool ice-blue pockets without dark sootiness
    const { dHeight, dPocket, dClod, uSparkle } = maps;
    const isRim = parsed.r >= 245 && parsed.g >= 245 && parsed.b >= 245;
    const isWall = parsed.r < 170;
    const baseContrast = isRim ? 0.42 : isWall ? 0.65 : 0.88;
    for (let y = 0; y < CELL; y++) {
      const v = (y + oy) & MASK;
      const vRow = v << 9;
      const vm3 = ((v - 3) & MASK) << 9;
      const vp3 = ((v + 3) & MASK) << 9;
      let p = y * CELL * 4;
      for (let x = 0; x < CELL; x++, p += 4) {
        const a = d[p + 3];
        if (a === 0) continue;
        const u = (x + ox) & MASK;
        const k = vRow | u;
        const pocket = dPocket[k];
        const clod = dClod[k];
        const spark = uSparkle[k];
        const dSlope = dHeight[vm3 | ((u - 3) & MASK)] - dHeight[vp3 | ((u + 3) & MASK)];

        const an = a / 255;
        const contrast = baseContrast * (0.62 + 0.38 * an);
        const net = (clod * 26.0 + Math.max(0, dSlope) * 22.0 + spark * 16.0 - pocket * 22.0 - Math.max(0, -dSlope) * 16.0) * contrast;
        const dVal = net >= 0
          ? 22.0 * Math.tanh(net / 22.0)
          : 13.0 * Math.tanh(net / 13.0);

        const dr = dVal < 0 ? dVal * 1.22 : dVal;
        const dg = dVal < 0 ? dVal * 0.96 : dVal;
        const db = dVal < 0 ? dVal * 0.60 : dVal;

        const r = d[p] + dr;
        const g = d[p + 1] + dg;
        const b = d[p + 2] + db;
        d[p] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;

        if (a > 2 && a < 242) {
          const env = Math.sin(an * Math.PI);
          const clodRelief = clod * 0.58 - pocket * 0.45;
          const eroded = Math.max(0, Math.min(1, an + clodRelief * env * 0.30));
          d[p + 3] = Math.round(eroded * eroded * (3 - 2 * eroded) * 255);
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export const BloodAtlas = {
  indexOf(kind, i) { return KIND_BASE[kind] + i; },

  // LAYOUT is immutable — prebuild Map once instead of calling find() every time
  // (kindCount is called by _drawStain for EVERY stain during a full bake)
  _kindCounts: new Map(LAYOUT.map(([k, n]) => [k, n])),

  kindCount(kind) { return this._kindCounts.get(kind) ?? 0; },

  /** Build the atlases (once per client). Call in browser context only. */
  ensure() {
    if (_maskAtlas) return { mask: _maskAtlas, detail: _detailAtlas };
    _maskAtlas = document.createElement('canvas');
    _maskAtlas.width = ATLAS_W;
    _maskAtlas.height = ATLAS_H;
    _detailAtlas = document.createElement('canvas');
    _detailAtlas.width = ATLAS_W;
    _detailAtlas.height = ATLAS_H;
    const gens = {
      splat: drawSplat,
      splash: drawSplash,
      smear: drawSmear,
      pool: drawPool,
      droplet: drawDroplet,
      footprint: drawFootprint,
      drip: drawDrip,
      handprint: drawHandprint,
      pawprint: drawPawprint,
      clawprint: drawClawprint,
      hoofprint: drawHoofprint
    };
    for (const [kind, n] of LAYOUT) {
      for (let i = 0; i < n; i++) {
        const rng = new Rng(hashStr(`ss-blood-v5-grain-${kind}-${i}`));
        gens[kind](_maskAtlas, _detailAtlas, KIND_BASE[kind] + i, rng);
      }
    }
    return { mask: _maskAtlas, detail: _detailAtlas };
  },

  /** Reset cached atlases/patterns (for tests). */
  reset() {
    _maskAtlas = _detailAtlas = _maskSnowAtlas = null;
    _snowStamp = null;
    _snowWorldTile = null;
    _snowWorldPatCache = new WeakMap();
    _tintCache.clear();
  },

  /**
   * Return the world-space CanvasPattern of snow micro-relief (1:1 in scene pixels) for the given 2D context.
   * Safely returns `null` in test stubs without `createPattern`.
   */
  snowWorldPattern(ctx: any) {
    if (!ctx || typeof ctx.createPattern !== 'function') return null;
    let pat = _snowWorldPatCache.get(ctx);
    if (pat !== undefined) return pat;
    const tile = ensureSnowWorldTile();
    if (!tile) return null;
    pat = ctx.createPattern(tile, 'repeat');
    if (pat && typeof pat.setTransform === 'function' && typeof globalThis.DOMMatrix === 'function') {
      // 0.65 world px per texel (~333 px period): crisp sparkling snow grain at both 100% and 200% zoom!
      pat.setTransform(new globalThis.DOMMatrix().scale(0.65, 0.65));
    }
    _snowWorldPatCache.set(ctx, pat);
    return pat;
  },

  /** Tests/debugging: expose mask canvases (blood; snow if built). */
  maskCanvases() {
    return { blood: _maskAtlas, snow: _maskSnowAtlas };
  },

  /**
   * Tinted variant tile for a material: mask (all relief comes from grain) →
   * material profile gradient (`source-in`) → clots (`source-atop`) →
   * profile specular highlights. Color ALPHA (`#rrggbbaa`) is NOT baked into
   * the tile — it is applied via `globalAlpha` at `drawImage` time (renderer),
   * eliminating a 576 KB / 147k-pixel `getImageData` pass per tile and allowing
   * tiles of the same RGB with different alphas to share cache entries. Key = variant|rgb|material.
   */
  tinted(kind, variant, colorHex8, material = 0) {
    // normalize up front: only blood (0) and snow (2) are supported
    material = (material | 0) === 2 ? 2 : 0;
    const mat = material === 2 ? SNOW_PROFILE : BLOOD_PROFILE;
    const idx = KIND_BASE[kind] + variant;
    const parsed = parseColor(colorHex8) ?? { r: 165, g: 20, b: 20, a: 0.85 };
    // Numeric key instead of string: snow baking calls `tinted` up to 4 times
    // per stain, where building a string (map/padStart/join + template) on EVERY
    // lookup was a noticeable allocation hotspot while walking through snow;
    // packing idx * 2^24 | rgb | mat <= 2^34 gives an exact integer Map key
    const key = (idx * 0x1000000 + (parsed.r << 16) + (parsed.g << 8) + parsed.b) * 8 + mat.id;
    const cached = _tintCache.get(key);
    if (cached !== undefined) return cached;
    this.ensure();
    const { sx, sy } = cellOrigin(idx);
    // snow uses its OWN mask (clumps/powder);
    // kinds without a specialized snow generator (footprint/drip/handprint) always use the shared mask
    const maskAtlas = material === 2 && SNOW_KINDS.has(kind) ? ensureSnowMask() : _maskAtlas;

    const isSnowTrench = material === 2 && kind === 'smear';
    const isSnowPrint = material === 2 && (kind === 'footprint' || kind === 'pawprint' || kind === 'clawprint' || kind === 'hoofprint');
    const isSnowMound = material === 2 && !isSnowTrench && !isSnowPrint;

    // Natural snow palette: crisp sunlit snow-white albedo (RGB 242..255) on crowns and cover
    // + cool glacial silver-blue half-shadows (scattered sky light within snow) on leeward slopes,
    // free of gray "concrete" or garish cyan.
    const isWarmBloody = parsed.r > parsed.b + 16 || parsed.g > parsed.b + 16;
    let snowParsed = parsed;
    let texStyle = 0;
    const rawLum = Math.max(0, Math.min(255, Math.round(0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b)));
    if (material === 2 && !isWarmBloody) {
      texStyle = idx % 5;
      if (isSnowMound) {
        if (rawLum >= 250) {
          // crest (#ffffff): dazzling sunlit cornice crest of the snowdrift
          snowParsed = { r: 255, g: 255, b: 255, a: parsed.a };
        } else if (rawLum < 95) {
          // ao (#3e4856): cool winter ambient shadow at the base of the drift
          snowParsed = { r: 130, g: 150, b: 182, a: parsed.a };
        } else if (rawLum < 155) {
          // bank / slope (#707e90..#7c8a9c): sculpted leeward drift slope (cool glacial bounce)
          const t = Math.max(0, Math.min(1, (rawLum - 120) / 20));
          snowParsed = {
            r: Math.round(178 + t * 14),
            g: Math.round(198 + t * 12),
            b: Math.round(224 + t * 6),
            a: parsed.a
          };
        } else if (rawLum < 185) {
          // terrace (#a8b4c4): intermediate wind terrace of a deep drift (lv = 5)
          snowParsed = { r: 216, g: 230, b: 246, a: parsed.a };
        } else if (rawLum < 203) {
          // lv = 1 (Light frost, #bcc6d4): fresh sparkling frosty snow
          snowParsed = { r: 248, g: 251, b: 255, a: parsed.a };
        } else if (rawLum < 218) {
          // lv = 2 (Medium cover, #ccd6e4): clean fluffy snow blanket
          snowParsed = { r: 250, g: 253, b: 255, a: parsed.a };
        } else if (rawLum < 229) {
          // lv = 3 (Low drift, #d8e0ec): bright snow plateau of a low drift
          snowParsed = { r: 252, g: 254, b: 255, a: parsed.a };
        } else if (rawLum < 238) {
          // lv = 4 (High drift, #e2eaf4): sunlit dome of a high drift
          snowParsed = { r: 254, g: 255, b: 255, a: parsed.a };
        } else {
          // lv = 5 (Deep drift, #ecf2fa): radiant peak of a deep snow dune
          snowParsed = { r: 255, g: 255, b: 255, a: parsed.a };
        }
      } else {
        // Snow trenches and footprints: bright berm and cool silvery-ice walls/bed without dark grime
        if (parsed.r >= 240) {
          snowParsed = { r: 253, g: 254, b: 255, a: parsed.a };
        } else if (parsed.r < 135) {
          // wall (#7c8ea8): shaded NW wall of the rut/print
          snowParsed = { r: 160, g: 180, b: 208, a: parsed.a };
        } else if (parsed.r < 165) {
          // lip (#96a6bc): soft beveled rim of the print
          snowParsed = { r: 186, g: 203, b: 225, a: parsed.a };
        } else {
          // bed (#b4c2d4): compressed snow on the floor of the trench or footprint
          snowParsed = { r: 206, g: 220, b: 238, a: parsed.a };
        }
      }
    }

    const body = document.createElement('canvas');
    body.width = body.height = CELL;
    const bctx = body.getContext('2d');
    bctx.drawImage(maskAtlas, sx, sy, CELL, CELL, 0, 0, CELL, CELL);
    if (isSnowPrint) {
      // Densify the anatomical sole/paw/hoof impression in snow (0.34 -> 0.82..1.0)
      // while preserving the arch cutout and individual toe shapes
      bctx.drawImage(body, 0, 0);
      bctx.drawImage(body, 0, 0);
    }
    bctx.globalCompositeOperation = 'source-in';
    if (isSnowTrench || isSnowPrint) {
      const isWall = !isWarmBloody && parsed.r >= 95 && parsed.r < 135;
      const isLip = !isWarmBloody && parsed.r >= 135 && parsed.r < 165;
      const isBed = !isWarmBloody && parsed.r >= 165 && parsed.r <= 215;
      if (isWall || isLip) {
        bctx.fillStyle = shadeHex(snowParsed, 0.00);
      } else if (isBed) {
        // Isotropic concave bowl for the compressed snow bed of a trench/print (rotation-invariant across 0..360°!)
        const cavGrd = bctx.createRadialGradient(CELL * 0.50, CELL * 0.50, CELL * 0.05, CELL * 0.50, CELL * 0.50, CELL * 0.44);
        cavGrd.addColorStop(0.00, shadeHex(snowParsed, -0.02));
        cavGrd.addColorStop(0.65, shadeHex(snowParsed, 0.02));
        cavGrd.addColorStop(1.00, shadeHex(snowParsed, 0.06));
        bctx.fillStyle = cavGrd;
      } else {
        bctx.fillStyle = shadeHex(snowParsed, 0.00);
      }
    } else if (isSnowMound) {
      // Strictly uniform flat fill for snow mound tiles so overlapping stamps on the same tier
      // stitch into a seamless snow sheet without circular "scale" outlines.
      bctx.fillStyle = shadeHex(snowParsed, 0.00);
    } else {
      const grd = bctx.createRadialGradient(CELL / 2, CELL / 2, CELL * 0.03, CELL / 2, CELL / 2, CELL * 0.49);
      for (const [o, k] of mat.stops) grd.addColorStop(o, shadeHex(parsed, k));
      bctx.fillStyle = grd;
    }
    bctx.fillRect(0, 0, CELL, CELL);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = CELL;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(body, 0, 0);

    ctx.globalCompositeOperation = 'source-atop';

    if (material !== 2 && mat.detailAlpha > 0) {
      ctx.globalAlpha = mat.detailAlpha;
      ctx.drawImage(_detailAtlas, sx, sy, CELL, CELL, 0, 0, CELL, CELL);
    } else if (isSnowMound || isSnowTrench || isSnowPrint) {
      applySnowSurfaceTexture(ctx, snowParsed, rawLum, idx, isSnowTrench, isSnowPrint, texStyle);
    }

    // Wet specular highlights — only for glossy non-snow materials (blood)
    if (mat.gloss && material !== 2) {
      const gr = new Rng(hashStr(`gloss-${idx}`));
      const patches = 1 + gr.int(2);
      const offMin = -70;
      const offMax = -6;
      for (let i = 0; i < patches; i++) {
        const px = CELL / 2 + gr.range(offMin, offMax) * K;
        const py = CELL / 2 + gr.range(offMin, offMax) * K;
        const pr = gr.range(mat.gloss.patchR[0], mat.gloss.patchR[1]) * K;
        const g2 = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g2.addColorStop(0, `rgba(255,255,255,${mat.gloss.patchA})`);
        g2.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g2;
        ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      }
      const specs = 1 + gr.int(4);
      ctx.fillStyle = '#ffffff';
      const specMin = -58;
      const specMax = -6;
      for (let i = 0; i < specs; i++) {
        const px = CELL / 2 + gr.range(specMin, specMax) * K;
        const py = CELL / 2 + gr.range(specMin, specMax) * K;
        ctx.globalAlpha = gr.range(mat.gloss.specA[0], mat.gloss.specA[1]);
        ctx.beginPath();
        ctx.arc(px, py, gr.range(mat.gloss.specR[0], mat.gloss.specR[1]) * K, 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (_tintCache.size > 768) {
      const oldest = _tintCache.keys().next().value;
      _tintCache.delete(oldest);
    }
    _tintCache.set(key, canvas);
    return canvas;
  }
};
