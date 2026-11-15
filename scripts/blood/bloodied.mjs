/**
 * Token wound overlay ("Bloodied") — native Showstopper implementation.
 *
 * Architecture:
 *   1. Pool of 20 smooth vector liquid splatter stamps (448×448, 100% crisp
 *      silhouette built on C¹-continuous quadratic surface-tension splines):
 *      large impact splashes with rounded necks and bulbous droplets,
 *      directional elongated streaks, and teardrop comet sprays.
 *   2. Eight independent splat layers (acting like 8 separate sprites) packed
 *      into three 768×768 RGB textures over opaque #000000 (alpha=1) with
 *      even stratified placement across the token silhouette.
 *   3. Single-pass HLSL/ANGLE-friendly `WoundCoatFilter` shader:
 *      sequential reveal of the 8 splats one by one with true Porter-Duff
 *      (source-over) density accumulation on overlaps and deep arterial
 *      tinting driven by the portrait's luminance relief.
 */
import { MODULE_ID } from '../config.mjs';
import { hpShare } from './events.mjs';
import { hashStr, Rng } from './rng.mjs';
const STAMP_POOL_COUNT = 20;
const STAMP_DIM = 448;
const COAT_DIM = 768;
const COAT_CACHE_LIMIT = 36;
const TRANSITION_RATE_PER_SEC = 2.5; // full 0→1 sweep in 400 ms
const DEFAULT_BLOOD_OPACITY = 0.80;
const TAU = Math.PI * 2;
/* ------------------------ wound severity curve ------------------------ */
/**
 * S-shaped wound severity curve (0..1) from missing health fraction (0..1).
 */
export function computeWoundSeverity(damageShare) {
    const raw = Number(damageShare);
    if (!(raw > 0))
        return 0;
    if (raw >= 1)
        return 1;
    const smooth = raw * raw * (3 - 2 * raw);
    const blended = 0.20 * raw + 0.80 * Math.pow(smooth, 1.15);
    return blended < 0 ? 0 : blended > 1 ? 1 : blended;
}
let _stampPool = null;
let _stageScratchCanvas = null;
const _coatTripletCache = new Map();
function createCanvas2D(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    return cv;
}
function clampInStamp(v, pad = 12) {
    return Math.max(pad, Math.min(STAMP_DIM - pad, v));
}
/**
 * C¹-smooth closed contour through control-point midpoints (no sharp corners
 * or sawtooth jaggies — mimics real liquid surface tension).
 */
function traceSmoothLoop(ctx, pts) {
    const n = pts.length;
    if (n < 3)
        return;
    const mx0 = (pts[n - 1].x + pts[0].x) * 0.5;
    const my0 = (pts[n - 1].y + pts[0].y) * 0.5;
    ctx.moveTo(mx0, my0);
    for (let i = 0; i < n; i++) {
        const cur = pts[i];
        const nxt = pts[(i + 1) % n];
        ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) * 0.5, (cur.y + nxt.y) * 0.5);
    }
    ctx.closePath();
}
/**
 * Draws a cohesive organic splash blob with rounded finger projections,
 * smooth concave bays, and bulbous droplet tips at the ends of rays.
 */
function fillLiquidSplash(ctx, rng, cx, cy, baseR, fingerCount, stretchX = 1, stretchY = 1, tilt = 0, dirBiasAngle = null, dirBiasBoost = 0) {
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const mapPt = (lx, ly) => ({
        x: clampInStamp(cx + (lx * stretchX) * cosT - (ly * stretchY) * sinT, 14),
        y: clampInStamp(cy + (lx * stretchX) * sinT + (ly * stretchY) * cosT, 14)
    });
    // Non-uniform angular sectors
    const sectorWeights = [];
    let weightSum = 0;
    for (let i = 0; i < fingerCount; i++) {
        const w = rng.range(0.65, 1.55);
        sectorWeights.push(w);
        weightSum += w;
    }
    const pts = [];
    const bulbs = [];
    let phi = rng.angle();
    for (let i = 0; i < fingerCount; i++) {
        const span = (sectorWeights[i] / weightSum) * TAU;
        const tipA = phi + span * rng.range(0.32, 0.68);
        const bayA = phi + span;
        let bias = 1;
        if (dirBiasAngle !== null) {
            const align = Math.cos((tipA + tilt) - dirBiasAngle);
            bias = 1 + Math.max(0, align) * dirBiasBoost;
        }
        const isLongFinger = rng.chance(0.42);
        const tipR = baseR * bias * (isLongFinger ? rng.range(1.32, 2.25) : rng.range(0.84, 1.24));
        const bayR = baseR * rng.range(0.48, 0.78);
        const shoulderHalf = span * (isLongFinger ? rng.range(0.08, 0.14) : rng.range(0.14, 0.22));
        const shoulderR = tipR * (isLongFinger ? 0.86 : 0.94);
        // Three control points around the finger tip yield a smooth rounded head in the quadratic B-spline
        pts.push(mapPt(Math.cos(tipA - shoulderHalf) * shoulderR, Math.sin(tipA - shoulderHalf) * shoulderR));
        const tipWorld = mapPt(Math.cos(tipA) * tipR, Math.sin(tipA) * tipR);
        pts.push(tipWorld);
        pts.push(mapPt(Math.cos(tipA + shoulderHalf) * shoulderR, Math.sin(tipA + shoulderHalf) * shoulderR));
        // Two control points in the concave bay yield a broad smooth U-saddle
        const bayHalf = span * 0.11;
        pts.push(mapPt(Math.cos(bayA - bayHalf) * (bayR * 1.04), Math.sin(bayA - bayHalf) * (bayR * 1.04)));
        pts.push(mapPt(Math.cos(bayA + bayHalf) * (bayR * 1.04), Math.sin(bayA + bayHalf) * (bayR * 1.04)));
        if (isLongFinger && rng.chance(0.78)) {
            bulbs.push({ x: tipWorld.x, y: tipWorld.y, r: rng.range(3.2, 8.2) });
        }
        phi += span;
    }
    ctx.beginPath();
    traceSmoothLoop(ctx, pts);
    ctx.fill();
    if (bulbs.length) {
        ctx.beginPath();
        for (const b of bulbs) {
            ctx.moveTo(b.x + b.r, b.y);
            ctx.arc(b.x, b.y, b.r, 0, TAU);
        }
        ctx.fill();
    }
}
/**
 * Detached teardrop comet droplet with a thin rounded tail and bulbous head.
 */
function fillTeardropComet(ctx, x0, y0, angle, length, tailR, headR, bend) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const nx = -dy;
    const ny = dx;
    const sx = clampInStamp(x0, 14);
    const sy = clampInStamp(y0, 14);
    const hx = clampInStamp(sx + dx * length + nx * bend * length, 16);
    const hy = clampInStamp(sy + dy * length + ny * bend * length, 16);
    const adx = hx - sx;
    const ady = hy - sy;
    const dist = Math.hypot(adx, ady);
    if (dist < headR + 1.5) {
        ctx.beginPath();
        ctx.arc(hx, hy, headR, 0, TAU);
        ctx.fill();
        return;
    }
    const dir = Math.atan2(ady, adx);
    const cx = sx + adx * 0.52 + nx * bend * length * 0.38;
    const cy = sy + ady * 0.52 + ny * bend * length * 0.38;
    ctx.beginPath();
    ctx.arc(sx, sy, tailR, dir + Math.PI * 0.5, dir - Math.PI * 0.5, false);
    ctx.quadraticCurveTo(cx + Math.cos(dir - Math.PI * 0.5) * headR * 0.56, cy + Math.sin(dir - Math.PI * 0.5) * headR * 0.56, hx + Math.cos(dir - Math.PI * 0.5) * headR, hy + Math.sin(dir - Math.PI * 0.5) * headR);
    ctx.arc(hx, hy, headR, dir - Math.PI * 0.5, dir + Math.PI * 0.5, false);
    ctx.quadraticCurveTo(cx + Math.cos(dir + Math.PI * 0.5) * headR * 0.56, cy + Math.sin(dir + Math.PI * 0.5) * headR * 0.56, sx + Math.cos(dir + Math.PI * 0.5) * tailR, sy + Math.sin(dir + Math.PI * 0.5) * tailR);
    ctx.closePath();
    ctx.fill();
}
/**
 * Measured scatter of crisp circular and teardrop satellite droplets (no noisy camo).
 */
function fillSatelliteDrops(ctx, rng, cx, cy, minDist, maxDist, count, coneCenter = 0, coneHalf = Math.PI) {
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
        const phi = coneHalf >= Math.PI
            ? rng.angle()
            : coneCenter + (rng.next() * 2 - 1) * coneHalf;
        const u = Math.pow(rng.next(), 0.72);
        const dist = minDist + u * (maxDist - minDist);
        const px = cx + Math.cos(phi) * dist;
        const py = cy + Math.sin(phi) * dist;
        if (px < 12 || px > STAMP_DIM - 12 || py < 12 || py > STAMP_DIM - 12)
            continue;
        const roll = rng.next();
        let r;
        if (roll < 0.45)
            r = rng.range(1.6, 3.4);
        else if (roll < 0.82)
            r = rng.range(3.5, 6.8);
        else
            r = rng.range(6.9, 11.2) * (1 - u * 0.35);
        if (rng.chance(0.36) && r >= 2.8) {
            const stretch = rng.range(1.22, 1.72);
            ctx.moveTo(px + Math.cos(phi) * r * stretch, py + Math.sin(phi) * r * stretch);
            ctx.ellipse(px, py, r * stretch, r * 0.84, phi, 0, TAU);
        }
        else {
            ctx.moveTo(px + r, py);
            ctx.arc(px, py, r, 0, TAU);
        }
    }
    ctx.fill();
}
/** Bakes a single smooth vector blood stamp (448×448, pure white silhouette alpha=1). */
function bakeSmoothVectorStamp(index) {
    const cv = createCanvas2D(STAMP_DIM, STAMP_DIM);
    const ctx = cv.getContext('2d');
    if (!ctx)
        return cv;
    const rng = new Rng(hashStr(`ss-liquid-splat-v3:${index}`));
    const mid = STAMP_DIM * 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 1;
    if (index < 9) {
        // Type 1 (0..8): large classic splat with rounded fingers and flying droplets
        const coreR = rng.range(52, 78);
        const fingers = 9 + rng.int(6);
        const cx = mid + rng.range(-16, 16);
        const cy = mid + rng.range(-16, 16);
        fillLiquidSplash(ctx, rng, cx, cy, coreR, fingers, rng.range(0.86, 1.24), rng.range(0.86, 1.20), rng.angle());
        // Asymmetric lateral lobe merged into the main body
        if (rng.chance(0.70)) {
            const sideA = rng.angle();
            const sideD = coreR * rng.range(0.45, 0.82);
            fillLiquidSplash(ctx, rng, cx + Math.cos(sideA) * sideD, cy + Math.sin(sideA) * sideD, coreR * rng.range(0.46, 0.68), 6 + rng.int(4), rng.range(0.88, 1.18), rng.range(0.88, 1.18), rng.angle());
        }
        const comets = 5 + rng.int(6);
        for (let j = 0; j < comets; j++) {
            const ang = (j / comets) * TAU + rng.range(-0.32, 0.32);
            const startD = coreR * rng.range(0.75, 1.25);
            fillTeardropComet(ctx, cx + Math.cos(ang) * startD, cy + Math.sin(ang) * startD, ang, rng.range(26, 84), rng.range(1.1, 2.8), rng.range(3.0, 6.8), rng.range(-0.15, 0.15));
        }
        fillSatelliteDrops(ctx, rng, cx, cy, coreR * 0.85, STAMP_DIM * 0.45, 42 + rng.int(26));
    }
    else if (index < 15) {
        // Type 2 (9..14): directional oblique impact splash / streak with long tongues
        const dir = rng.angle();
        const coreR = rng.range(42, 64);
        const backX = mid - Math.cos(dir) * rng.range(22, 42);
        const backY = mid - Math.sin(dir) * rng.range(22, 42);
        fillLiquidSplash(ctx, rng, backX, backY, coreR, 8 + rng.int(5), rng.range(1.25, 1.62), rng.range(0.68, 0.88), dir, dir, 0.75);
        // Fan of long comets along the impact direction
        const streaks = 6 + rng.int(5);
        for (let s = 0; s < streaks; s++) {
            const a = dir + rng.range(-0.62, 0.62);
            const d0 = coreR * rng.range(0.55, 1.15);
            fillTeardropComet(ctx, backX + Math.cos(a) * d0, backY + Math.sin(a) * d0, a, rng.range(38, 112), rng.range(1.2, 2.8), rng.range(3.2, 7.4), rng.range(-0.14, 0.14));
        }
        fillSatelliteDrops(ctx, rng, backX, backY, coreR * 0.7, STAMP_DIM * 0.46, 48 + rng.int(24), dir, 0.95);
    }
    else {
        // Type 3 (15..19): pair of expressive medium splats + constellation of large drops
        const pairAng = rng.angle();
        const sep = rng.range(46, 78);
        for (let side = -1; side <= 1; side += 2) {
            const px = mid + Math.cos(pairAng) * sep * side * rng.range(0.7, 1.1);
            const py = mid + Math.sin(pairAng) * sep * side * rng.range(0.7, 1.1);
            const r = rng.range(28, 46);
            fillLiquidSplash(ctx, rng, px, py, r, 7 + rng.int(4), rng.range(0.88, 1.25), rng.range(0.88, 1.25), rng.angle());
            const mini = 2 + rng.int(3);
            for (let m = 0; m < mini; m++) {
                const ma = rng.angle();
                fillTeardropComet(ctx, px + Math.cos(ma) * r * 0.8, py + Math.sin(ma) * r * 0.8, ma, rng.range(22, 64), rng.range(1.0, 2.2), rng.range(2.6, 5.6), rng.range(-0.14, 0.14));
            }
        }
        fillSatelliteDrops(ctx, rng, mid, mid, 16, STAMP_DIM * 0.45, 58 + rng.int(28));
    }
    return cv;
}
function ensureStampPool() {
    if (_stampPool)
        return _stampPool;
    _stampPool = [];
    for (let i = 0; i < STAMP_POOL_COUNT; i++) {
        _stampPool.push(bakeSmoothVectorStamp(i));
    }
    return _stampPool;
}
/**
 * 8 stratified zones around the subject (head/hat, shoulders, chest, arms, hem) —
 * shuffled per token seed so splats never clump onto a single spot.
 */
const BODY_ANCHORS = [
    [0.00, -0.26], // head / upper portrait
    [-0.19, -0.14], // left shoulder
    [0.19, -0.14], // right shoulder
    [-0.08, 0.00], // left chest
    [0.10, 0.03], // right chest
    [-0.22, 0.14], // left arm / flank
    [0.22, 0.14], // right arm / flank
    [0.00, 0.24] // lower torso / hem
];
function bakeTripletMemberCanvas(placements, stamps) {
    if (!_stageScratchCanvas)
        _stageScratchCanvas = createCanvas2D(COAT_DIM, COAT_DIM);
    const outCv = createCanvas2D(COAT_DIM, COAT_DIM);
    const outCtx = outCv.getContext('2d');
    const scrCtx = _stageScratchCanvas.getContext('2d');
    if (!outCtx || !scrCtx)
        return outCv;
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.fillStyle = '#000000';
    outCtx.fillRect(0, 0, COAT_DIM, COAT_DIM);
    const channelHex = ['#ff0000', '#00ff00', '#0000ff'];
    for (let ch = 0; ch < 3; ch++) {
        const p = placements[ch];
        if (!p)
            continue;
        scrCtx.globalCompositeOperation = 'source-over';
        scrCtx.clearRect(0, 0, COAT_DIM, COAT_DIM);
        scrCtx.save();
        scrCtx.translate(p.px, p.py);
        scrCtx.rotate(p.rot);
        scrCtx.scale(p.sc * p.mirror, p.sc);
        scrCtx.globalAlpha = 1;
        scrCtx.drawImage(stamps[p.stampIdx], -STAMP_DIM * 0.5, -STAMP_DIM * 0.5);
        scrCtx.restore();
        scrCtx.globalCompositeOperation = 'source-in';
        scrCtx.fillStyle = channelHex[ch];
        scrCtx.fillRect(0, 0, COAT_DIM, COAT_DIM);
        outCtx.globalCompositeOperation = 'lighter';
        outCtx.drawImage(_stageScratchCanvas, 0, 0);
    }
    outCtx.globalCompositeOperation = 'source-over';
    return outCv;
}
function acquireWoundCoatTriplet(seedKey, focusSpan = 1) {
    const quantSpan = Math.round(Math.max(0.52, Math.min(1.0, focusSpan)) * 20) / 20;
    const cacheKey = `${String(seedKey || 'default')}@${quantSpan.toFixed(2)}`;
    const hit = _coatTripletCache.get(cacheKey);
    if (hit && hit.coat0?.valid !== false && hit.coat1?.valid !== false && hit.coat2?.valid !== false) {
        _coatTripletCache.delete(cacheKey);
        _coatTripletCache.set(cacheKey, hit);
        return hit;
    }
    const stamps = ensureStampPool();
    const rng = new Rng(hashStr(`ss-wound-triplet-v3:${cacheKey}`));
    // Fisher–Yates shuffle the 8 body zones so wound reveal order is unique per token
    const order = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
    // Shuffle stamp indices without replacement so all 8 splats on a token have distinct shapes
    const stampIndices = [];
    for (let i = 0; i < STAMP_POOL_COUNT; i++)
        stampIndices.push(i);
    for (let i = stampIndices.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const tmp = stampIndices[i];
        stampIndices[i] = stampIndices[j];
        stampIndices[j] = tmp;
    }
    const list = [];
    for (let k = 0; k < 8; k++) {
        const [ax, ay] = BODY_ANCHORS[order[k]];
        const jx = ax + rng.range(-0.08, 0.08);
        const jy = ay + rng.range(-0.08, 0.08);
        const px = (0.5 + jx * quantSpan) * COAT_DIM;
        const py = (0.49 + jy * quantSpan) * COAT_DIM;
        const baseScale = rng.range(0.68, 1.08);
        list.push({
            stampIdx: stampIndices[k],
            px,
            py,
            rot: rng.angle(),
            sc: (COAT_DIM / STAMP_DIM) * baseScale * quantSpan,
            mirror: rng.sign()
        });
    }
    const cv0 = bakeTripletMemberCanvas([list[0], list[1], list[2]], stamps);
    const cv1 = bakeTripletMemberCanvas([list[3], list[4], list[5]], stamps);
    const cv2 = bakeTripletMemberCanvas([list[6], list[7], null], stamps);
    const triplet = {
        coat0: PIXI.Texture.from(cv0),
        coat1: PIXI.Texture.from(cv1),
        coat2: PIXI.Texture.from(cv2)
    };
    _coatTripletCache.set(cacheKey, triplet);
    while (_coatTripletCache.size > COAT_CACHE_LIMIT) {
        const oldestKey = _coatTripletCache.keys().next().value;
        if (oldestKey === undefined)
            break;
        const evicted = _coatTripletCache.get(oldestKey);
        _coatTripletCache.delete(oldestKey);
        try {
            evicted?.coat0?.destroy?.(true);
        }
        catch { /* noop */ }
        try {
            evicted?.coat1?.destroy?.(true);
        }
        catch { /* noop */ }
        try {
            evicted?.coat2?.destroy?.(true);
        }
        catch { /* noop */ }
    }
    return triplet;
}
/**
 * Public accessor for a procedural wound map texture by seed (used by smoke tests).
 */
export function acquireWoundCoatTexture(seedKey) {
    return acquireWoundCoatTriplet(seedKey, 1).coat0;
}
/* --------------------- single-pass wound shader --------------------- */
const WOUND_COAT_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputClamp;
uniform mat3 uMapMatrix;
uniform vec4 uClipRect;
uniform sampler2D uCoat0;
uniform sampler2D uCoat1;
uniform sampler2D uCoat2;
uniform vec3 uPigment;
uniform float uCoatOpacity;
uniform float uSeverity;

void main() {
  vec2 mapUv = (uMapMatrix * vec3(vTextureCoord, 1.0)).xy;
  float inside = step(uClipRect.x, mapUv.x) * step(mapUv.x, uClipRect.z)
               * step(uClipRect.y, mapUv.y) * step(mapUv.y, uClipRect.w);

  vec4 portrait = texture2D(uSampler, clamp(vTextureCoord, inputClamp.xy, inputClamp.zw));
  vec2 uv = clamp(mapUv, 0.0, 1.0);
  vec3 c0 = texture2D(uCoat0, uv).rgb;
  vec3 c1 = texture2D(uCoat1, uv).rgb;
  vec2 c2 = texture2D(uCoat2, uv).rg;

  // Crisp anti-aliased cutoff along the token art silhouette (~0.73 threshold)
  float silhouette = smoothstep(0.65, 0.80, portrait.a) * inside;

  // Sequential reveal of all 8 independent spatters one by one (0..7)
  float scaled = uSeverity * 8.0;
  vec3 w0 = clamp(scaled - vec3(0.0, 1.0, 2.0), 0.0, 1.0);
  vec3 w1 = clamp(scaled - vec3(3.0, 4.0, 5.0), 0.0, 1.0);
  vec2 w2 = clamp(scaled - vec2(6.0, 7.0), 0.0, 1.0);

  // Porter-Duff (source-over) compositing of 8 spatters: 100% crisp edge + overlap buildup
  vec3 a0 = c0 * w0 * uCoatOpacity;
  vec3 a1 = c1 * w1 * uCoatOpacity;
  vec2 a2 = c2 * w2 * uCoatOpacity;

  float rem = (1.0 - a0.r) * (1.0 - a0.g) * (1.0 - a0.b)
            * (1.0 - a1.r) * (1.0 - a1.g) * (1.0 - a1.b)
            * (1.0 - a2.r) * (1.0 - a2.g);
  float coatAlpha = (1.0 - rem) * silhouette;

  // Arterial shading driven by portrait luminance: darker over lineart and shadows,
  // deep crimson on bright skin (without blowing out into neon orange)
  vec3 baseRgb = clamp(portrait.rgb / max(portrait.a, 0.001), 0.0, 1.0);
  float luma = dot(baseRgb, vec3(0.299, 0.587, 0.114));
  float relief = mix(0.46, 1.06, smoothstep(0.02, 0.86, luma));

  // Coagulated darkening where multiple spatters overlap
  float stackHits = (c0.r * w0.r + c0.g * w0.g + c0.b * w0.b)
                  + (c1.r * w1.r + c1.g * w1.g + c1.b * w1.b)
                  + (c2.r * w2.r + c2.g * w2.g);
  float stackShade = mix(1.0, 0.80, clamp((stackHits - 1.0) * 0.45, 0.0, 1.0));

  vec3 outRgb = clamp(uPigment * (relief * stackShade), 0.0, 1.0);
  gl_FragColor = vec4(outRgb * coatAlpha, coatAlpha);
}
`;
let _WoundCoatFilterClass = null;
function getWoundCoatFilterClass() {
    if (_WoundCoatFilterClass)
        return _WoundCoatFilterClass;
    class WoundCoatFilter extends PIXI.Filter {
        constructor(sprite, triplet) {
            let mat = null;
            try {
                mat = new PIXI.Matrix();
            }
            catch { /* smoke harness without Matrix */ }
            super(undefined, WOUND_COAT_FRAG, {
                uMapMatrix: mat,
                uClipRect: new Float32Array([0, 0, 1, 1]),
                uCoat0: triplet.coat0,
                uCoat1: triplet.coat1,
                uCoat2: triplet.coat2,
                uPigment: new Float32Array([0.66, 0.06, 0.09]),
                uCoatOpacity: DEFAULT_BLOOD_OPACITY,
                uSeverity: 0
            });
            this.targetSprite = sprite;
            this.padding = 0;
            const res = canvas?.app?.renderer?.resolution;
            if (res)
                this.resolution = res;
        }
        apply(filterManager, input, output, clearMode, state) {
            try {
                const m = this.uniforms?.uMapMatrix;
                if (m && this.targetSprite && !this.targetSprite.destroyed
                    && typeof filterManager?.calculateSpriteMatrix === 'function') {
                    filterManager.calculateSpriteMatrix(m, this.targetSprite);
                }
            }
            catch { /* sprite already detached from stage */ }
            super.apply(filterManager, input, output, clearMode, state);
        }
        destroy() {
            this.targetSprite = null;
            super.destroy();
        }
    }
    _WoundCoatFilterClass = WoundCoatFilter;
    return _WoundCoatFilterClass;
}
/* ----------------------- child sprite on token mesh ----------------------- */
function computeTokenFocusSpan(token) {
    const footW = Math.max(1, Number(token?.w) || 0);
    const meshW = Math.abs(Number(token?.mesh?.width) || 0);
    if (footW > 1 && meshW > footW * 1.12) {
        const zoomRatio = Math.min(3.0, meshW / footW);
        return Math.max(0.58, Math.min(1.0, 1 / Math.pow(zoomRatio, 0.58)));
    }
    return 1.0;
}
class WoundCoatSprite extends PIXI.Sprite {
    constructor(token) {
        super(PIXI.Texture.EMPTY);
        this.name = 'ssWoundCoat';
        this.eventMode = 'none';
        this.interactiveChildren = false;
        this.anchor.set(0.5, 0.5);
        this.tokenRef = token;
        this.currentSeverity = 0;
        this.goalSeverity = 0;
        this.geomSignature = '';
        const seedId = token?.document?.id ?? token?.id ?? 'token';
        const span = computeTokenFocusSpan(token);
        this.activeSpanKey = Math.round(span * 20);
        const triplet = acquireWoundCoatTriplet(seedId, span);
        const FilterCls = getWoundCoatFilterClass();
        this.coatFilter = new FilterCls(this, triplet);
        this.filters = [this.coatFilter];
        this._tickStep = () => this._advanceSeverity();
    }
    updatePigment(rgba) {
        const u = this.coatFilter?.uniforms;
        if (!u)
            return;
        u.uPigment[0] = Math.max(0, Math.min(1, (Number(rgba.r) || 0) / 255));
        u.uPigment[1] = Math.max(0, Math.min(1, (Number(rgba.g) || 0) / 255));
        u.uPigment[2] = Math.max(0, Math.min(1, (Number(rgba.b) || 0) / 255));
        const alpha = rgba.a !== undefined ? Number(rgba.a) : DEFAULT_BLOOD_OPACITY;
        u.uCoatOpacity = Math.max(0.15, Math.min(0.92, alpha * 0.94));
    }
    driveSeverity(goal, smoothTransition) {
        const clamped = goal < 0 ? 0 : goal > 1 ? 1 : goal;
        this.goalSeverity = clamped;
        canvas?.app?.ticker?.remove?.(this._tickStep);
        if (smoothTransition && Math.abs(clamped - this.currentSeverity) > 0.004 && canvas?.app?.ticker) {
            canvas.app.ticker.add(this._tickStep);
        }
        else {
            this.currentSeverity = clamped;
            this._commitSeverity();
        }
    }
    _advanceSeverity() {
        if (this.destroyed) {
            canvas?.app?.ticker?.remove?.(this._tickStep);
            return;
        }
        const dtSec = Math.min(Math.max((Number(canvas?.app?.ticker?.deltaMS) || 16.67) / 1000, 0), 0.1);
        const maxStep = TRANSITION_RATE_PER_SEC * dtSec;
        const diff = this.goalSeverity - this.currentSeverity;
        if (Math.abs(diff) <= maxStep) {
            this.currentSeverity = this.goalSeverity;
            canvas?.app?.ticker?.remove?.(this._tickStep);
        }
        else {
            this.currentSeverity += Math.sign(diff) * maxStep;
        }
        this._commitSeverity();
    }
    _commitSeverity() {
        const active = this.currentSeverity > 0.002;
        this.visible = active && this.texture !== PIXI.Texture.EMPTY;
        if (this.coatFilter?.uniforms) {
            this.coatFilter.uniforms.uSeverity = this.currentSeverity;
        }
    }
    render(renderer) {
        const hostMesh = this.parent;
        const eraseMode = PIXI.BLEND_MODES?.ERASE;
        if (eraseMode !== undefined) {
            if (hostMesh?.blendMode === eraseMode)
                return;
            const topFilter = renderer?.filter?.defaultFilterStack?.at?.(-1);
            if (topFilter?.target === hostMesh && topFilter?.filters?.at?.(-1)?.blendMode === eraseMode) {
                return;
            }
        }
        super.render(renderer);
    }
    alignWithHostMesh() {
        const token = this.tokenRef;
        const mesh = token?.mesh;
        if (!mesh || mesh.destroyed || this.destroyed)
            return;
        if (this.parent !== mesh) {
            mesh.addChild(this);
        }
        const artTex = mesh.texture;
        if (!artTex?.valid || artTex === PIXI.Texture.EMPTY) {
            this.visible = false;
            return;
        }
        if (this.texture !== artTex) {
            this.texture = artTex;
        }
        const span = computeTokenFocusSpan(token);
        const spanKey = Math.round(span * 20);
        if (spanKey !== this.activeSpanKey && this.coatFilter?.uniforms) {
            this.activeSpanKey = spanKey;
            const seedId = token?.document?.id ?? token?.id ?? 'token';
            const triplet = acquireWoundCoatTriplet(seedId, span);
            this.coatFilter.uniforms.uCoat0 = triplet.coat0;
            this.coatFilter.uniforms.uCoat1 = triplet.coat1;
            this.coatFilter.uniforms.uCoat2 = triplet.coat2;
        }
        const ringScaleAdj = (token.hasDynamicRing && Number(token.ring?.textureScaleAdjustment)) || 1;
        const origW = Number(artTex.orig?.width || artTex.width) || 1;
        const origH = Number(artTex.orig?.height || artTex.height) || 1;
        const ax = Number(mesh.anchor?.x ?? 0.5);
        const ay = Number(mesh.anchor?.y ?? 0.5);
        const padX = Number(mesh.paddingX) || 0;
        const padY = Number(mesh.paddingY) || 0;
        const texDoc = token.document?.texture ?? {};
        const meshMirX = (Number(mesh.scale?.x) || 1) < 0;
        const meshMirY = (Number(mesh.scale?.y) || 1) < 0;
        const docMirX = (Number(texDoc.scaleX) || 1) < 0;
        const docMirY = (Number(texDoc.scaleY) || 1) < 0;
        const flipX = docMirX !== meshMirX ? -1 : 1;
        const flipY = docMirY !== meshMirY ? -1 : 1;
        const sig = `${origW}|${origH}|${ax}|${ay}|${ringScaleAdj}|${padX}|${padY}|${flipX}|${flipY}`;
        if (sig !== this.geomSignature) {
            this.geomSignature = sig;
            const cx = (0.5 - ax) * origW;
            const cy = (0.5 - ay) * origH;
            this.position.set(cx, cy);
            this.scale.set(flipX / ringScaleAdj, flipY / ringScaleAdj);
            const spanW = origW / ringScaleAdj;
            const spanH = origH / ringScaleAdj;
            const meshL = -ax * origW - padX;
            const meshR = (1 - ax) * origW + padX;
            const meshT = -ay * origH - padY;
            const meshB = (1 - ay) * origH + padY;
            let u0 = Math.max(0, (meshL - (cx - spanW * 0.5)) / spanW);
            let u1 = Math.min(1, (meshR - (cx - spanW * 0.5)) / spanW);
            let v0 = Math.max(0, (meshT - (cy - spanH * 0.5)) / spanH);
            let v1 = Math.min(1, (meshB - (cy - spanH * 0.5)) / spanH);
            if (flipX < 0) {
                const tmp = 1 - u1;
                u1 = 1 - u0;
                u0 = tmp;
            }
            if (flipY < 0) {
                const tmp = 1 - v1;
                v1 = 1 - v0;
                v0 = tmp;
            }
            const clip = this.coatFilter?.uniforms?.uClipRect;
            if (clip) {
                clip[0] = u0;
                clip[1] = v0;
                clip[2] = u1;
                clip[3] = v1;
            }
        }
        this._commitSeverity();
    }
    destroy(options) {
        canvas?.app?.ticker?.remove?.(this._tickStep);
        this.texture = PIXI.Texture.EMPTY;
        if (this.coatFilter) {
            try {
                this.coatFilter.destroy();
            }
            catch { /* noop */ }
            this.coatFilter = null;
        }
        this.filters = null;
        this.tokenRef = null;
        super.destroy(options);
    }
}
/* ------------------------- scene overlay coordinator ------------------------- */
const _activeCoats = new WeakMap();
function isOverlaySettingEnabled() {
    try {
        return (game.settings.get(MODULE_ID, 'bloodEnabled') ?? true)
            && (game.settings.get(MODULE_ID, 'bloodBloodied') ?? true);
    }
    catch {
        return true;
    }
}
function isTokenBloodSuppressed(token) {
    try {
        return token?.document?.getFlag?.(MODULE_ID, 'bloodDisabled') === true;
    }
    catch {
        return false;
    }
}
function hasExternalTokenBlood() {
    try {
        if (!game.modules?.get?.('splatter')?.active)
            return false;
        if (game.settings.get('splatter', 'enableTokenBlood') === false)
            return false;
        const sub = game.settings.get('splatter', 'tokenBlood');
        if (sub && sub.enabled === false)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function resolvePigmentForToken(token) {
    try {
        const fn = globalThis.showstopper?.blood?.tokenColor;
        if (typeof fn === 'function') {
            const res = fn(token);
            if (res && typeof res === 'object')
                return res;
        }
    }
    catch { /* noop */ }
    return { r: 168, g: 16, b: 22, a: 0.85 };
}
function updateTokenWoundCoat(token, { animate = true } = {}) {
    if (!token?.mesh || token.destroyed)
        return;
    const allowed = isOverlaySettingEnabled()
        && !isTokenBloodSuppressed(token)
        && !token.document?.hidden
        && !hasExternalTokenBlood();
    const dmgShare = allowed ? hpShare(token) : null;
    const severity = dmgShare !== null ? computeWoundSeverity(dmgShare) : 0;
    let coat = _activeCoats.get(token);
    if (severity <= 0 && (!coat || coat.destroyed))
        return;
    if (!coat || coat.destroyed) {
        coat = new WoundCoatSprite(token);
        _activeCoats.set(token, coat);
    }
    coat.updatePigment(resolvePigmentForToken(token));
    coat.alignWithHostMesh();
    coat.driveSeverity(severity, animate);
}
function updateAllSceneCoats() {
    if (!canvas?.ready)
        return;
    for (const token of canvas.tokens?.placeables ?? []) {
        updateTokenWoundCoat(token, { animate: false });
    }
}
/* -------------------------------- public contract -------------------------------- */
export function syncBloodiedAll() {
    updateAllSceneCoats();
}
export function registerBloodiedOverlay() {
    Hooks.on('canvasReady', () => updateAllSceneCoats());
    Hooks.on('drawToken', (token) => updateTokenWoundCoat(token, { animate: false }));
    Hooks.on('refreshToken', (token) => _activeCoats.get(token)?.alignWithHostMesh());
    Hooks.on('destroyToken', (token) => {
        const coat = _activeCoats.get(token);
        if (coat) {
            try {
                coat.destroy({ children: true });
            }
            catch { /* noop */ }
            _activeCoats.delete(token);
        }
    });
    Hooks.on('updateActor', (actor) => {
        for (const token of actor?.getActiveTokens?.() ?? []) {
            updateTokenWoundCoat(token, { animate: true });
        }
    });
    Hooks.on('updateActorDelta', (delta) => {
        const tokObj = delta?.parent?.object ?? canvas?.tokens?.get?.(delta?.parent?.id);
        if (tokObj)
            updateTokenWoundCoat(tokObj, { animate: true });
    });
    Hooks.on('updateToken', (doc) => {
        const token = canvas?.tokens?.get?.(doc?.id);
        if (token)
            updateTokenWoundCoat(token, { animate: true });
    });
    Hooks.on('updateSetting', (setting) => {
        if (setting?.key === `${MODULE_ID}.bloodBloodied` || setting?.key === `${MODULE_ID}.bloodEnabled`) {
            updateAllSceneCoats();
        }
    });
    if (canvas?.ready) {
        updateAllSceneCoats();
    }
}
export function teardownBloodied() {
    for (const token of canvas?.tokens?.placeables ?? []) {
        const coat = _activeCoats.get(token);
        if (coat) {
            try {
                coat.destroy({ children: true });
            }
            catch { /* noop */ }
            _activeCoats.delete(token);
        }
    }
}
