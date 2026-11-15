/**
 * "Live state overlays" — persistent GLSL shaders on tokens.
 *
 * Supports two operating modes:
 *  1) Backwards compatibility with the "Freeze" finisher (`flags.showstopper.frozenTint`,
 *     written by `FinisherEffect.applyFrozenTint` alongside icy `texture.tint`).
 *  2) Universal token shader library (`flags.showstopper.shaderEffect` + saved original
 *     tint in `flags.showstopper.shaderTint`) and auto-detection from active token/actor
 *     statuses/effects (Petrified, Burning, Frozen, Shock, etc.).
 *
 * ARCHITECTURE & OPTIMIZATION (ZERO FIRST-RENDER HITCHES):
 *  - SEPARATE SHADERS PER EFFECT (`SHADER_FRAGS[effectId]`):
 *    Previously all 7 effects lived inside one monolithic uber-shader with
 *    `if (uMode < ...)` branches, multiple 3×3 Voronoi passes, and FBM calls. On Windows,
 *    the WebGL → ANGLE → HLSL translator (`D3DCompiler_47.dll` / `fxc`) unrolled every
 *    branch simultaneously into one giant graph, freezing Foundry VTT for 3–6 seconds
 *    on first compile. Each effect now has its own compact shader without `uMode`
 *    branching and includes only the noise primitives it actually uses.
 *  - UNIFORM CONTROL FLOW (HLSL GRADIENT-SAFE):
 *    In GLSL ES 1.00, `texture2D()` lookups rely on implicit 2×2 quad derivatives
 *    (`ddx`/`ddy`). An early exit `if (a < 0.01) return;` ahead of `texture2D()` calls
 *    violated HLSL rules (`error X4014: gradient operations inside flow control`) and
 *    forced ANGLE/fxc to `[flatten]` the entire shader. All `texture2D` and
 *    `sampleStraight()` lookups now run unconditionally without early `return`s, while
 *    transparent background pixels are masked out at the end via `step(0.01, a)`.
 *  - CPU PRECOMPUTATION OF `uFilterInv` & `PIXI.Program` CACHE RETENTION:
 *    The inverse linear 2×2 matrix `uFilterInv` is computed once per frame on the CPU
 *    in `TokenShaderFilter.apply()` rather than per pixel. When detaching an overlay,
 *    `filter.destroy()` leaves the shared `PIXI.Program` intact in `ProgramCache`.
 *    After `canvasReady`, shaders are precompiled smoothly in the background one per
 *    idle tick (`prewarmTokenShaders`).
 *
 * SHADER FAMILY (7 effects, each with unique procedural geometry, applied to both subject and ring):
 *  - `frozen`     — Frozen (static ice statue: 3D glacier facets, frost rime along edges, no drifting waves)
 *  - `petrified`  — Petrified (static stone statue: 3D bas-relief, quartz veins, granite & moss, unanimated)
 *  - `burning`    — Burning (volumetric fire: 3D flames and sparks inside and around token & ring silhouette)
 *  - `corrupted`  — Corrupted / Abyss (branching symbiotic dark veins, pulsing void rifts & miasma spores)
 *  - `gilded`     — Gilded statue (mirror-cast 24k gold with an occasional slow sheen and subtle sparkles)
 *  - `bloodrage`  — Bloodrage (double heartbeat pulse, radial rage spikes, claw slashes)
 *  - `glitch`     — Digital glitch (CRT scanline tears, RGB channel split, scanlines, block noise)
 */
import { MODULE_ID } from '../../config.mjs';
import { hashStr } from '../../blood/rng.mjs';
const _live = new Map(); // tokenId → { cont, filter, key, effect }
const _rechecks = new Map(); // tokenId → timeout id (deferred resync check)
const RESYNC_MS = 350;
/* ------------------------- effect catalog ------------------------- */
export const SHADER_EFFECTS = {
    frozen: {
        id: 'frozen',
        tint: '#bfe6ff',
        mode: 0,
        statuses: ['frozen']
    },
    petrified: {
        id: 'petrified',
        tint: '#a8a39d',
        mode: 1,
        statuses: ['petrified']
    },
    burning: {
        id: 'burning',
        tint: '#ffb37a',
        mode: 2,
        statuses: ['burning']
    },
    corrupted: {
        id: 'corrupted',
        tint: '#c9a6ff',
        mode: 3,
        statuses: ['corrupted']
    },
    gilded: {
        id: 'gilded',
        tint: '#ffe28a',
        mode: 4,
        statuses: ['gilded']
    },
    bloodrage: {
        id: 'bloodrage',
        tint: '#ff8a8a',
        mode: 5,
        statuses: ['bloodrage']
    },
    glitch: {
        id: 'glitch',
        tint: '#b8f8ff',
        mode: 6,
        statuses: ['glitch']
    }
};
export const SHADER_EFFECT_IDS = Object.keys(SHADER_EFFECTS);
/* -------------------- modular GLSL shader builder -------------------- */
const GLSL_HEADER = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputClamp;    // PIXI builtin: bounds of the active sub-region in the input texture
uniform mat3 uFilterMatrix; // calculateSpriteMatrix(): filter UVs -> local 0..1 sprite UVs
uniform vec4 uFilterInv;    // inverse linear 2x2 part of uFilterMatrix (computed on CPU once per frame)
uniform vec2 uTexSize;      // artwork dimensions in pixels (for canonical pattern-domain scaling)
uniform float uTime;
uniform float uSeed;

// Branchless read of straight (unpremultiplied) color from PIXI's premultiplied
// texture. Uniform control flow without if/return around texture2D spares
// ANGLE/D3DCompiler from flattening the entire shader graph.
vec4 sampleStraight(vec2 filterUV) {
  vec2 sprUV = (uFilterMatrix * vec3(filterUV, 1.0)).xy;
  float inBounds = step(0.0, sprUV.x) * step(sprUV.x, 1.0) * step(0.0, sprUV.y) * step(sprUV.y, 1.0);
  vec4 raw = texture2D(uSampler, clamp(filterUV, inputClamp.xy, inputClamp.zw)) * inBounds;
  float mask = step(0.001, raw.a);
  return vec4(clamp(raw.rgb / max(raw.a, 0.001), 0.0, 1.0) * mask, raw.a * mask);
}

// Convert a local sprite UV delta into a filter input UV delta
vec2 toFilter(vec2 d) {
  return vec2(uFilterInv.x * d.x + uFilterInv.z * d.y, uFilterInv.y * d.x + uFilterInv.w * d.y);
}
`;
const GLSL_HASH = `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;
const GLSL_HASH2 = `
vec2 hash2(vec2 p) {
  float n = hash(p);
  return vec2(n, hash(p + n + 17.13));
}
`;
const GLSL_FBM = `
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float fbm(vec2 p) {
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  float v = 0.5 * vnoise(p);
  p = rot * p * 2.03 + vec2(13.1, 7.7);
  v += 0.25 * vnoise(p);
  p = rot * p * 2.03 + vec2(13.1, 7.7);
  v += 0.125 * vnoise(p);
  return v;
}
`;
const GLSL_VORONOI = `
// Fast 2x2 Voronoi (4 iterations instead of 9):
//   x = F1 (distance to nearest seed),
//   y = F2 - F1 (distance to cell border: 0 on the edge),
//   zw = local vector from pixel to nearest seed (for 3D beveling),
//   outCellId = deterministic cell identifier.
vec4 voronoi(vec2 p, out vec2 outCellId) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  vec2 stepXY = step(vec2(0.5), fp) * 2.0 - 1.0;
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 r1 = vec2(0.0);
  vec2 g1 = vec2(0.0);
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 g = vec2(float(x) * stepXY.x, float(y) * stepXY.y);
      vec2 o = hash2(ip + g);
      vec2 r = g + o - fp;
      float d = dot(r, r);
      if (d < d1) {
        d2 = d1; d1 = d; r1 = r; g1 = ip + g;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  outCellId = g1;
  float s1 = sqrt(max(0.0, d1));
  float s2 = sqrt(max(0.0, d2));
  return vec4(s1, max(0.0, s2 - s1), r1.x, r1.y);
}
`;
const GLSL_VORONOI_EDGE2 = `
// Fast 2x2 Voronoi for secondary micro-cracks (4 iterations instead of 9):
// checks the 4 closest quadrants around the point and returns F2 - F1.
float voronoiEdge2(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  vec2 stepXY = step(vec2(0.5), fp) * 2.0 - 1.0;
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 g = vec2(float(x) * stepXY.x, float(y) * stepXY.y);
      vec2 o = hash2(ip + g);
      vec2 r = g + o - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; }
      else if (d < d2) { d2 = d; }
    }
  }
  return max(0.0, sqrt(max(0.0, d2)) - sqrt(max(0.0, d1)));
}
`;
const GLSL_MAIN_PROLOGUE = `
void main(void) {
  vec2 rawUV = (uFilterMatrix * vec3(vTextureCoord, 1.0)).xy;
  vec2 uv = clamp(rawUV, vec2(-0.18), vec2(1.18));
  vec4 art = sampleStraight(vTextureCoord);
  float a = art.a;

  vec2 rawTS = max(vec2(16.0), uTexSize);
  float maxRaw = max(rawTS.x, rawTS.y);
  vec2 ts = rawTS * (256.0 / maxRaw);
  vec2 pp = uv * ts;
  float unit = 256.0;
  vec2 texX = toFilter(vec2(1.0 / ts.x, 0.0));
  vec2 texY = toFilter(vec2(0.0, 1.0 / ts.y));

  float an = min(
    min(sampleStraight(vTextureCoord - texX * 1.5).a,
        sampleStraight(vTextureCoord + texX * 1.5).a),
    min(sampleStraight(vTextureCoord - texY * 1.5).a,
        sampleStraight(vTextureCoord + texY * 1.5).a)
  );
  float af = min(
    min(sampleStraight(vTextureCoord - (texX + texY) * 4.0).a,
        sampleStraight(vTextureCoord + (texX + texY) * 4.0).a),
    min(sampleStraight(vTextureCoord + (texX - texY) * 4.0).a,
        sampleStraight(vTextureCoord - (texX - texY) * 4.0).a)
  );
  float rim = clamp(1.0 - an / max(a, 0.001), 0.0, 1.0) * smoothstep(0.25, 0.85, a);
  float rimSoft = clamp(1.0 - af / max(a, 0.001), 0.0, 1.0) * smoothstep(0.25, 0.85, a);

  vec2 lightDir = normalize(vec2(-0.55, -0.83));
  vec3 col = art.rgb;
  float visMask = step(0.01, a);
  float outAlpha = a * visMask;
`;
const GLSL_MAIN_EPILOGUE = `
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col * outAlpha, outAlpha);
}
`;
function _buildEffectShader(flags, body) {
    let src = GLSL_HEADER + GLSL_HASH;
    if (flags.hash2 || flags.voronoi || flags.voronoiEdge2)
        src += GLSL_HASH2;
    if (flags.fbm)
        src += GLSL_FBM;
    if (flags.voronoi)
        src += GLSL_VORONOI;
    if (flags.voronoiEdge2)
        src += GLSL_VORONOI_EDGE2;
    src += GLSL_MAIN_PROLOGUE + body + GLSL_MAIN_EPILOGUE;
    return src;
}
export const SHADER_FRAGS = {
    /* ==================== 0: FROZEN (Static ice statue) ==================== */
    frozen: _buildEffectShader({ hash2: true, fbm: true, voronoi: true, voronoiEdge2: true }, `
  vec3 sL = sampleStraight(vTextureCoord - texX * 1.5).rgb;
  vec3 sR = sampleStraight(vTextureCoord + texX * 1.5).rgb;
  vec3 sU = sampleStraight(vTextureCoord - texY * 1.5).rgb;
  vec3 sD = sampleStraight(vTextureCoord + texY * 1.5).rgb;
  vec2 grad = vec2(dot(sR - sL, vec3(0.333)), dot(sD - sU, vec3(0.333))) * 3.8;

  float facet = unit / 7.2;
  vec2 warp = vec2(
    vnoise(pp * 6.0 / unit + uSeed) - 0.5,
    vnoise(pp * 6.0 / unit + uSeed + 31.7) - 0.5
  ) * unit * 0.045;

  vec2 cellId1;
  vec4 v1 = voronoi((pp + warp) / facet + uSeed, cellId1);
  float v2Edge = voronoiEdge2((pp + warp) / (facet * 0.42) + uSeed + 11.3);
  float crack = 1.0 - smoothstep(0.0, 0.12, v1.y);
  float crackIn = 1.0 - smoothstep(0.0, 0.08, v2Edge);

  vec2 shard = toFilter((hash2(cellId1 + uSeed) - 0.5) * 0.018);
  vec4 off = sampleStraight(vTextureCoord + shard);
  vec3 body = mix(art.rgb, off.rgb, smoothstep(0.2, 0.9, off.a));

  vec2 toBorder = -v1.zw / (length(v1.zw) + 1e-4);
  float edgeProx = 1.0 - smoothstep(0.0, 0.36, v1.y);
  vec3 N = normalize(vec3(grad + toBorder * edgeProx * 0.45, 1.0));
  vec3 L1 = normalize(vec3(-0.52, -0.72, 0.46));
  vec3 L2 = normalize(vec3(0.55, 0.35, 0.75));
  float spec1 = pow(max(0.0, dot(N, L1)), 9.0);
  float spec2 = pow(max(0.0, dot(N, L2)), 16.0);

  vec2 fromCenter = uv - vec2(0.5);
  float ang = atan(fromCenter.y, fromCenter.x);
  float needles = pow(0.5 + 0.5 * sin(ang * 36.0 + vnoise(pp * 10.0 / unit + uSeed) * 7.0), 3.0) * (rim * 0.85 + rimSoft * 0.75);

  float lum = dot(body, vec3(0.299, 0.587, 0.114));
  float iceLum = smoothstep(0.04, 0.96, lum);
  vec3 deepGlacier = vec3(0.16, 0.42, 0.76);
  vec3 midGlacier  = vec3(0.52, 0.80, 0.98);
  vec3 hiFrost     = vec3(0.94, 0.99, 1.00);
  vec3 glacierCol = mix(deepGlacier, midGlacier, iceLum);
  glacierCol = mix(glacierCol, hiFrost, smoothstep(0.58, 1.0, iceLum));
  vec3 coldDetail = mix(body, vec3(iceLum), 0.55) * vec3(0.76, 0.94, 1.16);
  col = mix(coldDetail, glacierCol, 0.62);

  float frost = fbm(pp / (unit / 28.0) + uSeed + 5.7);
  float rime = clamp(needles * 0.65 + frost * mix(0.12, 0.38, uv.y), 0.0, 1.0);
  col = mix(col, hiFrost, rime * 0.48);

  col += (spec1 * 0.48 + spec2 * 0.34) * hiFrost;
  col += crack * vec3(0.84, 0.95, 1.0) * 0.34;
  col += crackIn * vec3(0.30, 0.56, 0.90) * 0.18;
  col += (rim * 0.55 + rimSoft * 0.24) * vec3(0.82, 0.94, 1.0);
`),
    /* ==================== 1: PETRIFIED (Static stone statue) ==================== */
    petrified: _buildEffectShader({ fbm: true }, `
  vec3 sL = sampleStraight(vTextureCoord - texX).rgb;
  vec3 sR = sampleStraight(vTextureCoord + texX).rgb;
  vec3 sU = sampleStraight(vTextureCoord - texY).rgb;
  vec3 sD = sampleStraight(vTextureCoord + texY).rgb;
  float lumL = dot(sL, vec3(0.299, 0.587, 0.114));
  float lumR = dot(sR, vec3(0.299, 0.587, 0.114));
  float lumU = dot(sU, vec3(0.299, 0.587, 0.114));
  float lumD = dot(sD, vec3(0.299, 0.587, 0.114));
  float lum = dot(art.rgb, vec3(0.299, 0.587, 0.114));

  // Local unsharp mask and 3D bas-relief for crisp contours and surface detail
  float detail = (lum - 0.25 * (lumL + lumR + lumU + lumD)) * 0.95;
  float edgeMag = clamp(length(vec2(lumR - lumL, lumD - lumU)) * 2.2, 0.0, 1.0);
  float relief = clamp(((lumR - lumL) * lightDir.x + (lumD - lumU) * lightDir.y) * 1.55, -0.42, 0.42);
  float edgeCrease = edgeMag * (1.0 - lum) * 0.38;

  float stoneTone = clamp(smoothstep(0.03, 0.96, lum + detail) + relief * 0.42 - edgeCrease, 0.0, 1.0);

  float n1 = fbm(pp / (unit / 7.0) + uSeed);
  float n2 = fbm(pp / (unit / 16.0) + uSeed + 19.4);
  float grain = fbm(pp / (unit / 52.0) + uSeed * 1.7);
  float speckle = hash(floor(pp * 1.25 + uSeed));

  float strataCoord1 = uv.x * 5.2 + uv.y * 8.4 + n1 * 4.8 + n2 * 1.8;
  float strataCoord2 = uv.x * -6.5 + uv.y * 4.6 + n2 * 5.4 - n1 * 1.5;
  float detailGuard = 1.0 - edgeMag * 0.65;
  float quartzVein = smoothstep(0.075, 0.0, abs(sin(strataCoord1))) * detailGuard;
  float darkCrevice = smoothstep(0.045, 0.0, abs(sin(strataCoord2))) * smoothstep(0.38, 0.78, n1) * detailGuard;

  vec3 deepStone = vec3(0.09, 0.09, 0.08);
  vec3 midStone  = vec3(0.48, 0.46, 0.43);
  vec3 hiStone   = vec3(0.88, 0.86, 0.82);
  col = mix(deepStone, midStone, smoothstep(0.0, 0.56, stoneTone));
  col = mix(col, hiStone, smoothstep(0.50, 1.0, stoneTone));

  col *= 0.92 + (grain - 0.5) * 0.14 + (speckle - 0.5) * 0.07;
  col = mix(col, vec3(0.92, 0.90, 0.86), quartzVein * 0.24);
  col = mix(col, vec3(0.06, 0.06, 0.05), darkCrevice * 0.42);

  float mossMask = smoothstep(0.56, 0.96, uv.y) * smoothstep(0.50, 0.78, n1) * detailGuard;
  col = mix(col, vec3(0.26, 0.35, 0.20), mossMask * 0.26);

  // Crisp 3D silhouette contour: dark outer bevel + bright chipped stone inner rim
  float innerBevel = clamp(rimSoft - rim * 0.65, 0.0, 1.0);
  col += innerBevel * vec3(0.92, 0.90, 0.86) * 0.45;
  col = mix(col, vec3(0.07, 0.07, 0.06), rim * 0.55);
`),
    /* ==================== 2: BURNING (Volumetric fire around and over token) ==================== */
    burning: _buildEffectShader({ hash2: true, fbm: true }, `
  vec3 sL = sampleStraight(vTextureCoord - texX * 1.5).rgb;
  vec3 sR = sampleStraight(vTextureCoord + texX * 1.5).rgb;
  vec3 sU = sampleStraight(vTextureCoord - texY * 1.5).rgb;
  vec3 sD = sampleStraight(vTextureCoord + texY * 1.5).rgb;
  vec3 N = normalize(vec3(dot(sR - sL, vec3(0.333)) * 3.5, dot(sD - sU, vec3(0.333)) * 3.5, 1.0));
  float underLight = max(0.0, dot(N, normalize(vec3(0.0, 0.82, 0.57))));

  vec2 d = rawUV - vec2(0.5);
  float sway1 = sin(rawUV.y * 7.5 - uTime * 5.2 + uSeed) * 0.14;
  float sway2 = cos(rawUV.y * 13.0 - uTime * 7.6 + uSeed * 2.1) * 0.08;

  vec2 fuv1 = vec2(d.x * 4.5 + sway1 + uSeed, rawUV.y * 3.6 + uTime * 2.8);
  vec2 fuv2 = vec2(d.x * 8.2 + sway2 - uSeed * 1.3, rawUV.y * 6.2 + uTime * 4.3);
  vec2 fuv3 = vec2(d.x * 14.0 + uSeed * 0.7, rawUV.y * 10.5 + uTime * 6.2);
  float fn1 = fbm(fuv1);
  float fn2 = fbm(fuv2);
  float fn3 = vnoise(fuv3);
  float flameTurb = fn1 * 0.50 + fn2 * 0.35 + fn3 * 0.15;

  // Volumetric flame plume extending beyond the artwork silhouette
  vec2 plumeVec = vec2(d.x + sway1 * 0.18, d.y * 0.90);
  float plumeRad = length(plumeVec);
  float plumeMask = smoothstep(-0.08, 0.16, rawUV.y) * smoothstep(0.62, 0.36, plumeRad);
  float outerField = (0.49 - plumeRad) * 1.65 + (rawUV.y - 0.35) * 0.28 + (flameTurb - 0.44) * 0.95;
  float outerTongues = clamp(smoothstep(0.08, 0.66, outerField) * plumeMask, 0.0, 1.0);

  // 3D flames across the subject's own volume
  float surfaceFuel = pow(clamp(rawUV.y, 0.0, 1.0), 0.70) * 0.58
                    + (rimSoft * 0.85 + rim * 0.65)
                    + underLight * 0.55;
  float innerTongues = smoothstep(0.20, 0.86, flameTurb * 1.32 + surfaceFuel * 0.82 - 0.34);
  float tongues = mix(outerTongues, max(innerTongues, outerTongues * 0.85), a);
  float coreMask = smoothstep(0.58, 0.95, flameTurb * 1.25 + tongues * 0.65 - 0.24) * tongues;

  vec3 darkRed   = vec3(0.52, 0.03, 0.00);
  vec3 fireRed   = vec3(0.94, 0.16, 0.01);
  vec3 fireOrg   = vec3(1.00, 0.52, 0.03);
  vec3 fireYel   = vec3(1.00, 0.88, 0.24);
  vec3 fireWhite = vec3(1.00, 0.98, 0.84);
  vec3 flameCol = mix(darkRed, fireRed, smoothstep(0.0, 0.26, tongues));
  flameCol = mix(flameCol, fireOrg, smoothstep(0.24, 0.56, tongues));
  flameCol = mix(flameCol, fireYel, smoothstep(0.54, 0.84, tongues));
  flameCol = mix(flameCol, fireWhite, coreMask);

  float lum = dot(art.rgb, vec3(0.299, 0.587, 0.114));
  vec3 warmBody = art.rgb * vec3(1.26, 0.72, 0.42) + underLight * vec3(0.55, 0.20, 0.02);
  float soot = smoothstep(0.65, 0.12, rawUV.y) * (1.0 - tongues * 0.7);
  warmBody = mix(warmBody, vec3(0.12, 0.07, 0.05) * (0.45 + lum), soot * 0.55);
  vec3 innerCol = mix(warmBody, flameCol, clamp(tongues * 0.85, 0.0, 0.93)) + flameCol * pow(tongues, 2.0) * 0.42;

  vec2 sparkGrid = vec2(rawUV.x * 12.0 + sin(rawUV.y * 5.0 + uTime * 2.2) * 0.35, rawUV.y * 11.0 + uTime * 4.0);
  vec2 sId = floor(sparkGrid);
  vec2 sF = fract(sparkGrid) - 0.5 - (hash2(sId + floor(uSeed)) - 0.5) * 0.52;
  float sH = hash(sId + floor(uSeed));
  float spark = smoothstep(0.15, 0.0, length(sF * vec2(1.0, 0.65))) * (0.5 + 0.5 * sin(uTime * 10.0 + sH * 6.28)) * step(0.80, sH) * plumeMask;

  col = mix(flameCol, innerCol, a) + spark * vec3(1.0, 0.88, 0.38) * 1.25;
  float flameAlpha = smoothstep(0.05, 0.36, outerTongues) * (0.80 + 0.20 * coreMask);
  outAlpha = clamp(max(a, flameAlpha + spark), 0.0, 1.0);
`),
    /* ==================== 3: CORRUPTED (Symbiotic veins and Abyss rifts) ==================== */
    corrupted: _buildEffectShader({ hash2: true, fbm: true }, `
  vec2 q = vec2(
    fbm(uv * 4.2 + vec2(uSeed, uTime * 0.18)),
    fbm(uv * 4.2 + vec2(uSeed + 5.2, -uTime * 0.15))
  );
  vec4 warpedArt = sampleStraight(vTextureCoord + toFilter((q - 0.5) * 0.010));
  vec3 body = mix(art.rgb, warpedArt.rgb, smoothstep(0.2, 0.8, warpedArt.a));

  float lum = dot(body, vec3(0.299, 0.587, 0.114));
  vec3 drained = mix(body, vec3(lum * lum), 0.70) * vec3(0.80, 0.68, 0.96);

  // Domain-warped symbiotic shadow veins and bioluminescent Abyss filaments
  float wNoise = fbm(uv * 6.2 + q * 2.2 + vec2(0.0, -uTime * 0.22));
  float blackVeins = pow(1.0 - abs(wNoise * 2.0 - 1.0), 4.0);
  float voidFilaments = pow(1.0 - abs(fract(wNoise * 2.4 + q.x * 0.8) * 2.0 - 1.0), 6.5);

  // Pulsing Abyss rifts (black core + neon-magenta event horizon)
  vec2 riftUV = uv * 4.8 + (q - 0.5) * 0.55;
  vec2 riftId = floor(riftUV);
  vec2 riftRnd = hash2(riftId + floor(uSeed));
  vec2 riftLoc = fract(riftUV) - 0.5 - (riftRnd - 0.5) * 0.32;
  float riftDist = length(riftLoc * vec2(1.0, 1.45));
  float riftOpen = 0.08 + 0.07 * sin(uTime * 1.8 + riftRnd.x * 6.28);
  float riftExists = step(0.68, riftRnd.y);
  float riftCore = smoothstep(riftOpen, riftOpen * 0.35, riftDist) * riftExists;
  float riftRing = smoothstep(riftOpen + 0.06, riftOpen, riftDist) * smoothstep(riftOpen * 0.4, riftOpen, riftDist) * riftExists;

  // Upward-drifting dark purple miasma spores
  vec2 spGrid = vec2(uv.x * 9.0 + sin(uTime * 1.4 + uv.y * 4.0) * 0.25, uv.y * 9.0 + uTime * 1.1);
  vec2 spId = floor(spGrid);
  vec2 spLoc = fract(spGrid) - 0.5 - (hash2(spId + 3.7) - 0.5) * 0.45;
  float spH = hash(spId + floor(uSeed));
  float spore = smoothstep(0.14, 0.0, length(spLoc)) * step(0.76, spH) * (0.5 + 0.5 * sin(uTime * 3.0 + spH * 6.28));

  float pulse = 0.5 + 0.5 * sin(uTime * 2.6 - length(uv - vec2(0.5)) * 7.0 + uSeed);
  vec3 abyssBlack = vec3(0.02, 0.004, 0.04);
  vec3 voidGlow = mix(vec3(0.58, 0.10, 0.95), vec3(0.98, 0.14, 0.56), pulse);

  col = mix(drained, abyssBlack, clamp(blackVeins * 0.85 + riftCore * 0.95 + rimSoft * q.x * 0.65, 0.0, 0.95));
  col += (voidFilaments * 0.65 + riftRing * 1.15 + spore * 0.75) * voidGlow;
  col += rim * voidGlow * (0.72 + 0.28 * blackVeins);
`),
    /* ==================== 4: GILDED (Golden statue / Occasional slow sheen) ==================== */
    gilded: _buildEffectShader({ hash2: true }, `
  vec3 sL = sampleStraight(vTextureCoord - texX).rgb;
  vec3 sR = sampleStraight(vTextureCoord + texX).rgb;
  vec3 sU = sampleStraight(vTextureCoord - texY).rgb;
  vec3 sD = sampleStraight(vTextureCoord + texY).rgb;
  float lumL = dot(sL, vec3(0.299, 0.587, 0.114));
  float lumR = dot(sR, vec3(0.299, 0.587, 0.114));
  float lumU = dot(sU, vec3(0.299, 0.587, 0.114));
  float lumD = dot(sD, vec3(0.299, 0.587, 0.114));
  float lum = dot(art.rgb, vec3(0.299, 0.587, 0.114));

  // Monotonic metallic curve without highlight inversion + local facet sharpness
  float detail = (lum - 0.25 * (lumL + lumR + lumU + lumD)) * 0.95;
  vec2 grad = vec2(lumR - lumL, lumD - lumU);
  float edgeMag = clamp(length(grad) * 2.4, 0.0, 1.0);
  float relief = clamp(dot(grad, lightDir) * 1.65, -0.42, 0.42);
  float edgeCrease = edgeMag * (1.0 - lum) * 0.42;

  float goldTone = clamp(smoothstep(0.03, 0.96, lum + detail) + relief * 0.42 - edgeCrease, 0.0, 1.0);
  float spec = pow(max(0.0, goldTone * 0.72 + max(0.0, relief) * 0.65), 4.5);

  vec3 deepUmber    = vec3(0.12, 0.06, 0.01);
  vec3 warmBronze   = vec3(0.56, 0.35, 0.04);
  vec3 richGold     = vec3(0.96, 0.73, 0.15);
  vec3 specularGold = vec3(1.00, 0.97, 0.78);

  col = mix(deepUmber, warmBronze, smoothstep(0.0, 0.44, goldTone));
  col = mix(col, richGold, smoothstep(0.36, 0.84, goldTone));
  col = mix(col, specularGold, clamp(smoothstep(0.76, 1.0, goldTone) * 0.75 + spec * 0.55, 0.0, 1.0));

  // Occasional smooth diagonal sheen every ~8 seconds (with a long idle pause)
  float sheenCycle = fract(uTime * 0.125 + uSeed * 0.07);
  float sheenPos = sheenCycle / 0.24 * 2.4 - 1.2;
  float sheenDiag = (uv.x - 0.5) * 0.85 - (uv.y - 0.5) * 0.65;
  float sheen = smoothstep(0.22, 0.0, abs(sheenDiag - sheenPos)) * step(sheenCycle, 0.24);
  col += sheen * specularGold * (0.28 + 0.24 * goldTone);

  // Crisp 3D silhouette contour: dark bronze outer rim + bright gold inner bevel
  float innerBevel = clamp(rimSoft - rim * 0.65, 0.0, 1.0);
  col += innerBevel * specularGold * 0.62;
  col = mix(col, deepUmber, rim * 0.58);

  // Sparse slow 4-point star sparkles across the gold surface
  vec2 gGrid = uv * 6.0 + uSeed;
  vec2 gId = floor(gGrid);
  vec2 gF = fract(gGrid) - 0.5 - (hash2(gId) - 0.5) * 0.35;
  float gH = hash(gId + 5.1);
  float tw = pow(0.5 + 0.5 * sin(uTime * (0.38 + gH * 0.25) + gH * 6.28), 18.0) * step(0.82, gH);
  float star = max(0.0, 1.0 - abs(gF.x) * 14.0) * max(0.0, 1.0 - abs(gF.y) * 3.2)
             + max(0.0, 1.0 - abs(gF.y) * 14.0) * max(0.0, 1.0 - abs(gF.x) * 3.2);
  col += clamp(star, 0.0, 1.0) * tw * specularGold * 0.85;
`),
    /* ==================== 5: BLOODRAGE (Rage spikes and claw marks) ==================== */
    bloodrage: _buildEffectShader({ fbm: true }, `
  float beatPhase = fract(uTime * 1.35);
  float heartbeat = exp(-pow((beatPhase - 0.12) * 14.0, 2.0))
                  + 0.65 * exp(-pow((beatPhase - 0.28) * 18.0, 2.0));

  vec2 fromCenter = uv - vec2(0.5);
  vec4 pumped = sampleStraight(vTextureCoord - toFilter(fromCenter * heartbeat * 0.018));
  vec3 body = mix(art.rgb, pumped.rgb, smoothstep(0.2, 0.8, pumped.a));

  float lum = dot(body, vec3(0.299, 0.587, 0.114));
  float highContrast = smoothstep(0.14, 0.86, lum);
  float redness = max(0.0, body.r - max(body.g, body.b));
  vec3 grim = mix(vec3(0.05, 0.01, 0.02), vec3(0.86, 0.70, 0.70), highContrast);
  grim = mix(grim, vec3(0.96, 0.08, 0.10), clamp(redness * 2.4 + smoothstep(0.75, 0.96, lum) * 0.7, 0.0, 1.0));

  float distC = length(fromCenter);
  float ang = atan(fromCenter.y, fromCenter.x);
  float n1 = fbm(pp * 6.0 / unit + uSeed);
  float rageSpikes = pow(0.5 + 0.5 * sin(ang * 30.0 + n1 * 6.0 + floor(uTime * 10.0)), 4.0) * smoothstep(0.16, 0.48, distC);

  float slashCoord = (uv.x * 0.82 + uv.y * 0.57) * 11.0 + n1 * 1.4;
  float slashId = floor(slashCoord);
  float slash = smoothstep(0.07, 0.0, abs(fract(slashCoord) - 0.5)) * step(0.68, hash(vec2(slashId, floor(uSeed))));

  vec3 crimson = vec3(0.98, 0.06, 0.10);
  col = mix(grim, crimson * (0.85 + 0.45 * heartbeat), clamp(rageSpikes * 0.55 + slash * 0.75, 0.0, 1.0));
  col += (rim * 0.80 + rimSoft * 0.40) * crimson * (0.68 + 0.45 * heartbeat);
`),
    /* ==================== 6: GLITCH (Digital cyber-glitch) ==================== */
    glitch: _buildEffectShader({}, `
  float stepT = floor(uTime * 12.0);
  float band1 = floor(uv.y * 18.0);
  float band2 = floor(uv.y * 54.0);
  float rBand = hash(vec2(band1, stepT + floor(uSeed)));
  float tear = (rBand - 0.5) * 0.065 * step(0.76, rBand);
  float microTear = (hash(vec2(band2, stepT * 2.0)) - 0.5) * 0.014 * step(0.84, rBand);
  float dx = tear + microTear;

  float split = 0.008 + 0.014 * step(0.82, hash(vec2(stepT, uSeed)));
  vec4 sR = sampleStraight(vTextureCoord + toFilter(vec2(dx + split, 0.0)));
  vec4 sG = sampleStraight(vTextureCoord + toFilter(vec2(dx, 0.0)));
  vec4 sB = sampleStraight(vTextureCoord + toFilter(vec2(dx - split, 0.0)));

  col = vec3(sR.r, sG.g, sB.b);
  float maxA = max(max(sR.a, sG.a), sB.a);
  outAlpha = maxA * visMask * step(0.01, maxA);

  vec2 blockId = floor(uv * vec2(10.0, 14.0));
  float bHit = step(0.91, hash(blockId + vec2(stepT, floor(uSeed))));
  col = mix(col, vec3(0.0, 0.95, 1.0) - col * 0.5, bHit * 0.75);

  float scan = 0.90 + 0.10 * sin(pp.y * 3.14159);
  float roll = smoothstep(0.12, 0.0, abs(fract(uv.y - uTime * 0.45) - 0.5));
  col *= scan;
  col += roll * vec3(0.25, 0.90, 1.0) * 0.22;
  col += rim * vec3(0.0, 0.95, 1.0) * 0.45;
`)
};
/* ------------ Native TokenRing integration (ring.effects / processTokenColor) ------------ */
/**
 * Bit layout inside `TokenRing.effects` (`vStates` in the batch fragment shader):
 *  - Bits 0..5 (`0x01..0x20`) — core Foundry ring effects (`ENABLED`, `RING_PULSE`,
 *    `RING_GRADIENT`, `BKG_WAVE`, `INVISIBILITY` spectral pulse, `COLOR_OVER_SUBJECT`).
 *  - Bit 6 (`0x40`) — two-layer `multiple-rings` overlay (`STATE_TOP_LAYER`).
 *  - Bits 8..11 (`0x100..0x700`) — Showstopper shader mode (`mode + 1`, `1..7`, `0` = off).
 *  - Bits 12..19 (`0x0FF000`) — 8-bit deterministic per-token pattern seed (`0..255`).
 * Everything fits under `< 0x100000` (20 bits), well within `float32` mantissa precision
 * (24 bits) when passed through the `aStates` vertex attribute.
 */
export const RING_SHADER_MODE_SHIFT = 8;
export const RING_SHADER_SEED_SHIFT = 12;
export const RING_SHADER_STATE_MASK = 0xFFF00;
/**
 * Replacement `processTokenColor(in vec4 finalColor)` + post-blend hook for
 * `TokenRingSamplerShader` and `TopRingSamplerShader` (`multiple-rings`).
 *
 * Works just like Foundry's native spectral pulse (`STATE_INVISIBLE = 0x10`):
 *  - Runs inside the single ring batch shader alongside the ring band, background,
 *    `STATE_COLOR_OVER_SUBJECT`, `STATE_TOP_LAYER` (`multiple-rings`), and roof/fog
 *    occlusion masks.
 *  - Preserves native spectral pulse (`hasState(STATE_INVISIBLE)`) and allows combining
 *    it with any of the 7 Showstopper shaders without conflicts.
 *  - Computes `dFdx`/`dFdy`/`fwidth` derivatives up front in uniform control flow
 *    (avoiding HLSL `error X4014` and extra texture lookups).
 *  - Evaluates a SINGLE shared 2×2 Voronoi pass (4 iterations) and 3-octave FBM prior
 *    to `ssMode` branching, so the batch shader compiles once in < 10 ms at startup
 *    and switching between any of the 7 effects takes 0.0 ms (just toggling `vStates` bits).
 */
export const RING_PROCESS_TOKEN_COLOR_GLSL = `
      float ssHash(in vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      vec2 ssHash2(in vec2 p) {
        float n = ssHash(p);
        return vec2(n, ssHash(p + n + 17.13));
      }

      float ssVnoise(in vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(ssHash(i), ssHash(i + vec2(1.0, 0.0)), u.x),
          mix(ssHash(i + vec2(0.0, 1.0)), ssHash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float ssFbm(in vec2 p) {
        mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
        float v = 0.5 * ssVnoise(p);
        p = rot * p * 2.03 + vec2(13.1, 7.7);
        v += 0.25 * ssVnoise(p);
        p = rot * p * 2.03 + vec2(13.1, 7.7);
        v += 0.125 * ssVnoise(p);
        return v;
      }

      vec4 ssVoronoi(in vec2 p, out vec2 outCellId) {
        vec2 ip = floor(p);
        vec2 fp = fract(p);
        vec2 stepXY = step(vec2(0.5), fp) * 2.0 - 1.0;
        float d1 = 8.0;
        float d2 = 8.0;
        vec2 r1 = vec2(0.0);
        vec2 g1 = vec2(0.0);
        for (int y = 0; y <= 1; y++) {
          for (int x = 0; x <= 1; x++) {
            vec2 g = vec2(float(x) * stepXY.x, float(y) * stepXY.y);
            vec2 o = ssHash2(ip + g);
            vec2 r = g + o - fp;
            float d = dot(r, r);
            if (d < d1) {
              d2 = d1; d1 = d; r1 = r; g1 = ip + g;
            } else if (d < d2) {
              d2 = d;
            }
          }
        }
        outCellId = g1;
        float s1 = sqrt(max(0.0, d1));
        float s2 = sqrt(max(0.0, d2));
        return vec4(s1, max(0.0, s2 - s1), r1.x, r1.y);
      }

      vec4 ssApplyTokenShader(in vec4 finalColor, in float subjAlpha, in vec2 scaledDistVec, in float rectangularMask) {
        vec3 baseCol = unpremultiplySafe(finalColor);
        float baseLum = perceivedBrightness(baseCol);
        vec2 lumGrad = vec2(dFdx(baseLum), dFdy(baseLum));
        float alphaEdge = clamp(fwidth(finalColor.a) * 1.8, 0.0, 1.0);
        vec2 subjGrad = vec2(dFdx(subjAlpha), dFdy(subjAlpha));
        float subjEdge = clamp(fwidth(subjAlpha) * 1.6 + subjAlpha * (1.0 - subjAlpha) * 3.5, 0.0, 1.0);
        uint ssMode = (vStates >> 8U) & 0xFU;

        if ( ssMode == 0U ) return finalColor;
        if ( finalColor.a <= 0.001 && ssMode != 3U ) return finalColor;

        float uSeed = float((vStates >> 12U) & 0xFFU) * 0.39215686;
        vec2 rawUV = scaledDistVec * 0.5 + 0.5;
        vec2 uv = clamp(rawUV, -0.15, 1.15);
        float unit = 256.0;
        vec2 pp = uv * unit;
        float a = finalColor.a;

        float rim = clamp(alphaEdge * (1.2 - a * 0.5) + (1.0 - smoothstep(0.15, 0.92, a)) * 0.65, 0.0, 1.0) * smoothstep(0.05, 0.45, a);
        float rimSoft = clamp((1.0 - smoothstep(0.25, 0.98, a)) * 0.75 + alphaEdge * 0.5, 0.0, 1.0) * smoothstep(0.05, 0.45, a);
        vec2 lightDir = normalize(vec2(-0.55, -0.83));
        float ringDist = length(scaledDistVec);
        float innerRingRad = (vRingColorBand.x > 0.05) ? vRingColorBand.x : 0.68;
        float isInnerBg = clamp(a - subjAlpha, 0.0, 1.0) * (1.0 - smoothstep(innerRingRad - 0.04, innerRingRad + 0.02, ringDist));
        float subjBevel = clamp(dot(-subjGrad, lightDir) * 3.2, -1.0, 1.0) * subjEdge;
        vec3 col = baseCol;
        float outAlpha = a;

        // Static noise fields for statues (Frozen, Petrified, Bloodrage) — no time drift
        float n1 = ssFbm(pp * 6.0 / unit + vec2(uSeed, 0.0));
        float n2 = ssFbm(pp * 6.0 / unit + vec2(uSeed + 17.3, 4.1));
        vec2 warp = (vec2(n1, n2) - 0.5) * unit * 0.055;

        if ( ssMode == 1U ) {
          // 0: FROZEN (static ice statue across subject and ring, without drifting waves)
          vec2 cellId;
          vec4 v1 = ssVoronoi((pp + warp) / (unit / 7.2) + uSeed, cellId);
          vec2 toBorder = -v1.zw / (length(v1.zw) + 1e-4);
          float crack = 1.0 - smoothstep(0.0, 0.12, v1.y);
          float edgeProx = 1.0 - smoothstep(0.0, 0.36, v1.y);
          vec3 N = normalize(vec3(lumGrad * 18.0 + toBorder * edgeProx * 0.45, 1.0));
          vec3 L1 = normalize(vec3(-0.52, -0.72, 0.46));
          vec3 L2 = normalize(vec3(0.55, 0.35, 0.75));
          float spec1 = pow(max(0.0, dot(N, L1)), 9.0);
          float spec2 = pow(max(0.0, dot(N, L2)), 16.0);
          vec2 centered = uv - vec2(0.5);
          float ang = atan(centered.y, centered.x);
          float frostNeedles = pow(0.5 + 0.5 * sin(ang * 32.0 + n1 * 7.0), 3.0);
          float rime = clamp((rimSoft * 1.15 + smoothstep(0.28, 0.48, length(centered)) * 0.42) * (0.45 + 0.65 * frostNeedles), 0.0, 1.0);
          float iceLum = smoothstep(0.04, 0.96, baseLum);
          vec3 deepGlacier = vec3(0.16, 0.42, 0.76);
          vec3 midGlacier  = vec3(0.52, 0.80, 0.98);
          vec3 hiFrost     = vec3(0.94, 0.99, 1.00);
          vec3 glacierCol = mix(deepGlacier, midGlacier, iceLum);
          glacierCol = mix(glacierCol, hiFrost, smoothstep(0.58, 1.0, iceLum));
          vec3 coldDetail = mix(baseCol, vec3(iceLum), 0.55) * vec3(0.76, 0.94, 1.16);
          col = mix(coldDetail, glacierCol, 0.62);
          col = mix(col, hiFrost, (n2 * mix(0.10, 0.36, uv.y) + rime * 0.48));
          col += (spec1 * 0.48 + spec2 * 0.34) * hiFrost;
          col += crack * vec3(0.84, 0.95, 1.0) * 0.34;
          col *= mix(1.0, 0.72, isInnerBg);
          col += max(0.0, subjBevel) * hiFrost * 0.48;
          col += rim * vec3(0.82, 0.94, 1.0) * 0.52 + rimSoft * vec3(0.64, 0.84, 1.0) * 0.24;
        } else if ( ssMode == 2U ) {
          // 1: PETRIFIED (crisp stone statue with high-contrast bas-relief and silhouette)
          float edgeMag = clamp(length(lumGrad) * 4.5, 0.0, 1.0);
          float relief = clamp(dot(lumGrad, lightDir) * 5.2, -0.40, 0.40);
          float edgeCrease = edgeMag * (1.0 - baseLum) * 0.42;
          float stoneTone = clamp(smoothstep(0.03, 0.96, baseLum) + relief * 0.40 - edgeCrease, 0.0, 1.0);

          float detailGuard = (1.0 - edgeMag * 0.65) * (1.0 - subjEdge);
          float sCoord1 = (uv.x * 0.82 + uv.y * 0.57) * 16.0 + n1 * 4.8 + n2 * 2.1 + uSeed;
          float sCoord2 = (uv.x * -0.45 + uv.y * 0.89) * 11.0 + n2 * 4.2 - n1 * 1.7;
          float quartzVein = pow(1.0 - abs(sin(sCoord1)), 14.0) * detailGuard;
          float darkCrevice = pow(1.0 - abs(sin(sCoord2)), 22.0) * detailGuard;
          float speckle = ssHash(floor(pp * 0.65) + floor(uSeed));
          float grain = (speckle - 0.5) * 0.07;

          vec3 deepStone = vec3(0.09, 0.09, 0.08);
          vec3 midStone  = vec3(0.48, 0.46, 0.43);
          vec3 hiStone   = vec3(0.88, 0.86, 0.82);
          col = mix(deepStone, midStone, smoothstep(0.0, 0.56, stoneTone));
          col = mix(col, hiStone, smoothstep(0.50, 1.0, stoneTone));
          col *= 0.93 + (n1 - 0.5) * 0.14 + grain;
          col = mix(col, vec3(0.92, 0.90, 0.86), quartzVein * 0.25);
          col = mix(col, vec3(0.06, 0.06, 0.05), darkCrevice * 0.42);
          float mossMask = smoothstep(0.56, 0.96, uv.y) * smoothstep(0.50, 0.78, n1) * detailGuard;
          col = mix(col, vec3(0.26, 0.35, 0.20), mossMask * 0.26);

          // Recess the inner ring background and emphasize the 3D statue silhouette bevel
          col *= mix(1.0, 0.50, isInnerBg);
          col += max(0.0, subjBevel) * vec3(0.94, 0.92, 0.88) * 0.55;
          col = mix(col, vec3(0.06, 0.06, 0.05), subjEdge * (0.48 - max(0.0, subjBevel) * 0.30));
          col += rim * vec3(0.88, 0.86, 0.82) * 0.38 - rimSoft * 0.08;
        } else if ( ssMode == 3U ) {
          // 2: BURNING (volumetric 3D fire over and around the token silhouette and ring)
          vec3 N = normalize(vec3(lumGrad * 15.0, 1.0));
          float underLight = max(0.0, dot(N, normalize(vec3(0.0, 0.82, 0.57))));
          vec2 d = rawUV - vec2(0.5);
          float sway1 = sin(rawUV.y * 7.5 - time * 5.2 + uSeed) * 0.14;
          float sway2 = cos(rawUV.y * 13.0 - time * 7.6 + uSeed * 2.1) * 0.08;
          vec2 fuv1 = vec2(d.x * 4.5 + sway1 + uSeed, rawUV.y * 3.6 + time * 2.8);
          vec2 fuv2 = vec2(d.x * 8.2 + sway2 - uSeed * 1.3, rawUV.y * 6.2 + time * 4.3);
          vec2 fuv3 = vec2(d.x * 14.0 + uSeed * 0.7, rawUV.y * 10.5 + time * 6.2);
          float fn1 = ssFbm(fuv1);
          float fn2 = ssFbm(fuv2);
          float fn3 = ssVnoise(fuv3);
          float flameTurb = fn1 * 0.50 + fn2 * 0.35 + fn3 * 0.15;

          // Volumetric flame plume around subject and ring (extends into transparent a < 1.0 regions)
          vec2 plumeVec = vec2(d.x + sway1 * 0.18, d.y * 0.90);
          float plumeRad = length(plumeVec);
          float plumeMask = smoothstep(0.01, 0.18, rawUV.y) * smoothstep(0.52, 0.32, plumeRad) * rectangularMask;
          float outerField = (0.48 - plumeRad) * 1.65 + (rawUV.y - 0.35) * 0.28 + (flameTurb - 0.44) * 0.95;
          float outerTongues = clamp(smoothstep(0.08, 0.66, outerField) * plumeMask, 0.0, 1.0);

          float surfaceFuel = pow(clamp(rawUV.y, 0.0, 1.0), 0.70) * 0.58
                            + (rimSoft * 0.85 + rim * 0.65)
                            + underLight * 0.55;
          float innerTongues = smoothstep(0.20, 0.86, flameTurb * 1.32 + surfaceFuel * 0.82 - 0.34);
          float tongues = mix(outerTongues, max(innerTongues, outerTongues * 0.85), a);
          float coreMask = smoothstep(0.58, 0.95, flameTurb * 1.25 + tongues * 0.65 - 0.24) * tongues;

          vec3 darkRed   = vec3(0.52, 0.03, 0.00);
          vec3 fireRed   = vec3(0.94, 0.16, 0.01);
          vec3 fireOrg   = vec3(1.00, 0.52, 0.03);
          vec3 fireYel   = vec3(1.00, 0.88, 0.24);
          vec3 fireWhite = vec3(1.00, 0.98, 0.84);
          vec3 flameCol = mix(darkRed, fireRed, smoothstep(0.0, 0.26, tongues));
          flameCol = mix(flameCol, fireOrg, smoothstep(0.24, 0.56, tongues));
          flameCol = mix(flameCol, fireYel, smoothstep(0.54, 0.84, tongues));
          flameCol = mix(flameCol, fireWhite, coreMask);

          vec3 warmSubj = baseCol * vec3(1.26, 0.72, 0.42) + underLight * vec3(0.55, 0.20, 0.02);
          float soot = smoothstep(0.65, 0.12, rawUV.y) * (1.0 - tongues * 0.7);
          warmSubj = mix(warmSubj, vec3(0.12, 0.07, 0.05) * (0.45 + baseLum), soot * 0.55);
          vec3 innerCol = mix(warmSubj, flameCol, clamp(tongues * 0.85, 0.0, 0.93)) + flameCol * pow(tongues, 2.0) * 0.42;

          vec2 sparkUV = vec2(rawUV.x * 11.0 + sin(time * 2.3 + rawUV.y * 5.0) * 0.4, rawUV.y * 9.0 + time * 3.8);
          vec2 sparkCell = floor(sparkUV);
          vec2 sparkLocal = fract(sparkUV) - vec2(0.5);
          vec2 sparkRnd = ssHash2(sparkCell + floor(uSeed));
          sparkLocal += (sparkRnd - 0.5) * 0.55;
          float sparkDist = length(sparkLocal * vec2(1.0, 0.65));
          float sparkAlive = step(0.80, sparkRnd.x) * (0.5 + 0.5 * sin(time * 9.0 + sparkRnd.y * 6.28));
          float spark = smoothstep(0.14, 0.0, sparkDist) * sparkAlive * max(a, plumeMask);

          col = mix(flameCol, innerCol, a) + spark * vec3(1.0, 0.86, 0.36) * 1.25;
          float flameAlpha = smoothstep(0.05, 0.36, outerTongues) * (0.80 + 0.20 * coreMask);
          outAlpha = clamp(max(a, flameAlpha + spark), 0.0, 1.0);
        } else if ( ssMode == 4U ) {
          // 3: CORRUPTED (branching symbiotic veins, pulsing Abyss rifts, and miasma spores)
          vec2 q = vec2(
            ssFbm(uv * 4.2 + vec2(uSeed, time * 0.18)),
            ssFbm(uv * 4.2 + vec2(uSeed + 5.2, -time * 0.15))
          );
          float wNoise = ssFbm(uv * 6.2 + q * 2.2 + vec2(0.0, -time * 0.22));
          float blackVeins = pow(1.0 - abs(wNoise * 2.0 - 1.0), 4.0);
          float voidFilaments = pow(1.0 - abs(fract(wNoise * 2.4 + q.x * 0.8) * 2.0 - 1.0), 6.5);

          vec2 riftUV = uv * 4.8 + (q - 0.5) * 0.55;
          vec2 riftId = floor(riftUV);
          vec2 riftRnd = ssHash2(riftId + floor(uSeed));
          vec2 riftLoc = fract(riftUV) - 0.5 - (riftRnd - 0.5) * 0.32;
          float riftDist = length(riftLoc * vec2(1.0, 1.45));
          float riftOpen = 0.08 + 0.07 * sin(time * 1.8 + riftRnd.x * 6.28);
          float riftExists = step(0.68, riftRnd.y);
          float riftCore = smoothstep(riftOpen, riftOpen * 0.35, riftDist) * riftExists;
          float riftRing = smoothstep(riftOpen + 0.06, riftOpen, riftDist) * smoothstep(riftOpen * 0.4, riftOpen, riftDist) * riftExists;

          vec2 spGrid = vec2(uv.x * 9.0 + sin(time * 1.4 + uv.y * 4.0) * 0.25, uv.y * 9.0 + time * 1.1);
          vec2 spId = floor(spGrid);
          vec2 spLoc = fract(spGrid) - 0.5 - (ssHash2(spId + 3.7) - 0.5) * 0.45;
          float spH = ssHash(spId + floor(uSeed));
          float spore = smoothstep(0.14, 0.0, length(spLoc)) * step(0.76, spH) * (0.5 + 0.5 * sin(time * 3.0 + spH * 6.28));

          vec3 drained = mix(baseCol, vec3(baseLum * baseLum), 0.70) * vec3(0.80, 0.68, 0.96);
          float pulse = 0.5 + 0.5 * sin(time * 2.6 - length(uv - vec2(0.5)) * 7.0 + uSeed);
          vec3 abyssBlack = vec3(0.02, 0.004, 0.04);
          vec3 voidGlow = mix(vec3(0.58, 0.10, 0.95), vec3(0.98, 0.14, 0.56), pulse);

          col = mix(drained, abyssBlack, clamp(blackVeins * 0.85 + riftCore * 0.95 + rimSoft * q.x * 0.65, 0.0, 0.95));
          col += (voidFilaments * 0.65 + riftRing * 1.15 + spore * 0.75) * voidGlow;
          col += rim * voidGlow * (0.72 + 0.28 * blackVeins);
        } else if ( ssMode == 5U ) {
          // 4: GILDED (crisp cast 24k gold statue without tone inversion, diagonal sheen every ~8s)
          float edgeMag = clamp(length(lumGrad) * 4.5, 0.0, 1.0);
          float relief = clamp(dot(lumGrad, lightDir) * 5.6, -0.42, 0.42);
          float edgeCrease = edgeMag * (1.0 - baseLum) * 0.44;
          float goldTone = clamp(smoothstep(0.03, 0.96, baseLum) + relief * 0.42 - edgeCrease, 0.0, 1.0);
          float spec = pow(max(0.0, goldTone * 0.72 + max(0.0, relief) * 0.65), 4.5);

          vec3 deepUmber    = vec3(0.12, 0.06, 0.01);
          vec3 warmBronze   = vec3(0.56, 0.35, 0.04);
          vec3 richGold     = vec3(0.96, 0.73, 0.15);
          vec3 specularGold = vec3(1.00, 0.97, 0.78);
          col = mix(deepUmber, warmBronze, smoothstep(0.0, 0.44, goldTone));
          col = mix(col, richGold, smoothstep(0.36, 0.84, goldTone));
          col = mix(col, specularGold, clamp(smoothstep(0.76, 1.0, goldTone) * 0.75 + spec * 0.55, 0.0, 1.0));

          // Recess the inner ring background and highlight the 3D statue silhouette with gold bevel & bronze shadow
          col *= mix(1.0, 0.46, isInnerBg);
          col += max(0.0, subjBevel) * specularGold * 0.65;
          col = mix(col, deepUmber, subjEdge * (0.52 - max(0.0, subjBevel) * 0.32));

          float sheenCycle = fract(time * 0.125 + uSeed * 0.07);
          float sheenPos = sheenCycle / 0.24 * 2.4 - 1.2;
          float sheenDiag = (uv.x - 0.5) * 0.85 - (uv.y - 0.5) * 0.65;
          float sheen = smoothstep(0.22, 0.0, abs(sheenDiag - sheenPos)) * step(sheenCycle, 0.24);
          col += sheen * specularGold * (0.28 + 0.24 * goldTone) + rim * specularGold * 0.58;
          vec2 sUV = uv * 6.0;
          vec2 sCell = floor(sUV);
          vec2 sLoc = fract(sUV) - vec2(0.5);
          float sH = ssHash(sCell + floor(uSeed) + 5.1);
          float sPulse = pow(0.5 + 0.5 * sin(time * (0.38 + sH * 0.25) + sH * 6.28), 18.0);
          float starCross = (smoothstep(0.04, 0.0, abs(sLoc.x)) * smoothstep(0.42, 0.0, abs(sLoc.y))
                           + smoothstep(0.04, 0.0, abs(sLoc.y)) * smoothstep(0.42, 0.0, abs(sLoc.x)))
                           * step(0.82, sH) * sPulse;
          col += starCross * vec3(1.0, 0.98, 0.88) * 0.90;
        } else if ( ssMode == 6U ) {
          // 5: BLOODRAGE (double heartbeat pulse + radial rage spikes and claw slashes)
          float beatPhase = fract(time * 1.35);
          float heartbeat = exp(-pow((beatPhase - 0.12) * 14.0, 2.0))
                          + 0.65 * exp(-pow((beatPhase - 0.28) * 18.0, 2.0));
          float highContrast = smoothstep(0.12, 0.88, baseLum);
          float redness = max(0.0, baseCol.r - max(baseCol.g, baseCol.b));
          vec3 grim = mix(vec3(0.06, 0.015, 0.025), vec3(0.88, 0.72, 0.72), highContrast);
          grim = mix(grim, vec3(0.95, 0.08, 0.10), clamp(redness * 2.2, 0.0, 1.0));
          vec2 d = uv - vec2(0.5);
          float ang = atan(d.y, d.x);
          float rad = length(d);
          float spikeWave = abs(fract(ang * 7.64 + floor(time * 8.0) * 0.37 + uSeed) - 0.5) * 2.0;
          float rageSpikes = smoothstep(0.45, 0.95, spikeWave) * smoothstep(0.18, 0.48, rad);
          float slashCoord = (uv.x * 0.75 + uv.y * 0.66) * 11.0 + n1 * 0.8;
          float slashMarks = pow(1.0 - abs(sin(slashCoord)), 18.0) * smoothstep(0.25, 0.75, n2);
          vec3 crimson = vec3(0.98, 0.06, 0.10);
          col = mix(grim, crimson * (0.85 + 0.45 * heartbeat), clamp(rageSpikes * 0.55 + slashMarks * 0.65, 0.0, 0.9));
          col += (rim * (0.75 + 0.45 * spikeWave) + rimSoft * 0.42) * crimson * (0.70 + 0.50 * heartbeat);
        } else if ( ssMode == 7U ) {
          // 6: GLITCH (digital cyber-glitch)
          float stepT = floor(time * 12.0);
          float band1 = floor(uv.y * 18.0);
          float rBand = ssHash(vec2(band1, stepT + floor(uSeed)));
          float tear = step(0.74, rBand);
          vec3 shifted = vec3(
             clamp(baseCol.r + (lumGrad.x * 14.0 + tear * 0.28), 0.0, 1.0),
             baseCol.g,
             clamp(baseCol.b - (lumGrad.x * 14.0 - tear * 0.28), 0.0, 1.0)
          );
          col = mix(baseCol, shifted, 0.85);
          vec2 blockId = floor(uv * vec2(10.0, 14.0));
          float bHit = step(0.91, ssHash(blockId + vec2(stepT, floor(uSeed))));
          col = mix(col, vec3(0.0, 0.95, 1.0) - col * 0.5, bHit * 0.75);
          float scan = 0.90 + 0.10 * sin(pp.y * 3.14159);
          float roll = smoothstep(0.12, 0.0, abs(fract(uv.y - time * 0.45) - 0.5));
          col = col * scan + roll * vec3(0.25, 0.90, 1.0) * 0.22 + rim * vec3(0.0, 0.95, 1.0) * 0.45;
        }

        col = clamp(col, 0.0, 1.0);
        return vec4(col * outAlpha, outAlpha);
      }

      vec4 processTokenColor(in vec4 finalColor) {
        if ( !hasState(STATE_INVISIBLE) ) return finalColor;
        float lum = perceivedBrightness(unpremultiplySafe(finalColor));
        vec3 haloColor = vec3(lum) * vec3(0.5, 1.0, 1.0);
        return vec4(haloColor, 1.0) * finalColor.a
                     * (0.55 + normalizedCos(time * 2.0) * 0.25);
      }
`;
const PROCESS_TOKEN_COLOR_RE = /vec4\s+processTokenColor\s*\(\s*in\s+vec4\s+finalColor\s*\)\s*\{[\s\S]*?\n\s*\}/;
const BLENDED_RESULT_RE = /result\s*=\s*blendedResult\s*\*\s*vColor\.a\s*;/;
let _ringPrototypePatched = false;
let _ringConfigPatched = false;
/**
 * Patches `processTokenColor` and final `blendedResult` in a ring batch shader class
 * (`TokenRingSamplerShader` or `TopRingSamplerShader` from `multiple-rings`) so the
 * shader applies simultaneously to both the subject and the dynamic token ring.
 */
export function patchRingShaderClass(ShaderClass) {
    if (!ShaderClass || typeof ShaderClass._batchFragmentShader !== 'string')
        return false;
    if (Object.prototype.hasOwnProperty.call(ShaderClass, '__showstopperRingPatched'))
        return true;
    const frag = ShaderClass._batchFragmentShader;
    if (!PROCESS_TOKEN_COLOR_RE.test(frag))
        return false;
    let patched = frag.replace(PROCESS_TOKEN_COLOR_RE, RING_PROCESS_TOKEN_COLOR_GLSL.trim());
    if (BLENDED_RESULT_RE.test(patched)) {
        patched = patched.replace(BLENDED_RESULT_RE, 'result = ssApplyTokenShader(blendedResult, processedColor.a, scaledDistVec, rectangularMask) * vColor.a;');
    }
    ShaderClass._batchFragmentShader = patched;
    Object.defineProperty(ShaderClass, '__showstopperRingPatched', { value: true, configurable: true });
    // If this batch shader's plugin is already registered on the live PIXI.Renderer,
    // reinitialize its shader generator so the patched GLSL takes effect immediately.
    try {
        const pluginName = ShaderClass.classPluginName;
        const renderer = canvas?.app?.renderer;
        const plugin = pluginName ? renderer?.plugins?.[pluginName] : null;
        if (plugin && renderer?.gl && typeof plugin.contextChange === 'function') {
            plugin.contextChange();
        }
    }
    catch { /* noop */ }
    return true;
}
/**
 * Writes the active Showstopper shader bits (`8..11` = `mode + 1`, `12..19` = `seedByte`)
 * into `ring.effects` without disturbing low bits (`0..7`: `ENABLED`, `RING_PULSE`,
 * `RING_GRADIENT`, `BKG_WAVE`, `INVISIBILITY` spectral pulse, `COLOR_OVER_SUBJECT`,
 * and `TOP_LAYER_EFFECT = 0x40` from `multiple-rings`).
 */
function _applyRingShaderBits(ring) {
    if (!ring || typeof ring.effects !== 'number')
        return;
    ring.effects &= ~RING_SHADER_STATE_MASK;
    const token = ring.token;
    if (!token)
        return;
    const effectId = resolveTokenShaderEffect(token);
    const spec = effectId ? SHADER_EFFECTS[effectId] : null;
    if (!spec)
        return;
    const tokenId = token.id ?? token.document?.id ?? 'tok';
    const seedByte = (hashStr(`ss-shader-${spec.id}-${tokenId}`) >>> 0) & 0xFF;
    ring.effects |= ((spec.mode + 1) << RING_SHADER_MODE_SHIFT) | (seedByte << RING_SHADER_SEED_SHIFT);
}
/**
 * Installs shader integration into `TokenRing`, `TokenRingSamplerShader`, `TokenRingConfig`,
 * and `TopRingSamplerShader` (`multiple-rings`). Idempotent across repeated calls.
 */
export function installRingShaderIntegration() {
    try {
        const NativeShader = foundry?.canvas?.rendering?.shaders?.TokenRingSamplerShader;
        if (NativeShader)
            patchRingShaderClass(NativeShader);
    }
    catch { /* noop */ }
    try {
        const ringCfg = globalThis.CONFIG?.Token?.ring;
        if (ringCfg) {
            if (ringCfg.shaderClass)
                patchRingShaderClass(ringCfg.shaderClass);
            const proto = Object.getPrototypeOf(ringCfg);
            if (proto && !proto.__showstopperRingConfigPatched) {
                proto.__showstopperRingConfigPatched = true;
                if (typeof proto.addConfig === 'function') {
                    const origAddConfig = proto.addConfig;
                    proto.addConfig = function (id, config, ...rest) {
                        try {
                            const sc = config?.framework?.shaderClass ?? config?.shaderClass;
                            if (sc)
                                patchRingShaderClass(sc);
                        }
                        catch { /* noop */ }
                        return origAddConfig.call(this, id, config, ...rest);
                    };
                }
                if (typeof proto.useConfig === 'function') {
                    const origUseConfig = proto.useConfig;
                    proto.useConfig = function (id, ...rest) {
                        const res = origUseConfig.call(this, id, ...rest);
                        try {
                            if (this.shaderClass)
                                patchRingShaderClass(this.shaderClass);
                        }
                        catch { /* noop */ }
                        return res;
                    };
                }
            }
            // In case custom ring configs (e.g. `mringsCombinedRings`) were already added earlier:
            if (typeof ringCfg.getConfig === 'function') {
                const mrCfg = ringCfg.getConfig('mringsCombinedRings');
                const mrShader = mrCfg?.framework?.shaderClass ?? mrCfg?.shaderClass;
                if (mrShader)
                    patchRingShaderClass(mrShader);
            }
            _ringConfigPatched = true;
        }
    }
    catch { /* noop */ }
    try {
        const TokenRing = foundry?.canvas?.placeables?.tokens?.TokenRing;
        if (TokenRing?.prototype && !_ringPrototypePatched && !TokenRing.prototype.__showstopperShaderPatched) {
            TokenRing.prototype.__showstopperShaderPatched = true;
            _ringPrototypePatched = true;
            const target = 'foundry.canvas.placeables.tokens.TokenRing.prototype.configureVisuals';
            let registeredViaLibWrapper = false;
            if (globalThis.libWrapper?.register && globalThis.game?.modules?.get?.('lib-wrapper')?.active) {
                try {
                    globalThis.libWrapper.register(MODULE_ID, target, function (wrapped, ...args) {
                        const res = wrapped(...args);
                        _applyRingShaderBits(this);
                        return res;
                    }, 'WRAPPER');
                    registeredViaLibWrapper = true;
                }
                catch {
                    registeredViaLibWrapper = false;
                }
            }
            if (!registeredViaLibWrapper) {
                const origConfigureVisuals = TokenRing.prototype.configureVisuals;
                if (typeof origConfigureVisuals === 'function') {
                    TokenRing.prototype.configureVisuals = function (...args) {
                        const res = origConfigureVisuals.apply(this, args);
                        _applyRingShaderBits(this);
                        return res;
                    };
                }
            }
        }
    }
    catch { /* noop */ }
}
/** Checks whether a token can render its shader natively via `TokenRingSamplerShader`. */
function _canUseNativeRingShader(token) {
    if (!token?.hasDynamicRing || !token?.ring)
        return false;
    const activeShader = globalThis.CONFIG?.Token?.ring?.shaderClass
        ?? foundry?.canvas?.rendering?.shaders?.TokenRingSamplerShader;
    if (!activeShader)
        return false;
    if (!Object.prototype.hasOwnProperty.call(activeShader, '__showstopperRingPatched')) {
        patchRingShaderClass(activeShader);
    }
    return Boolean(Object.prototype.hasOwnProperty.call(activeShader, '__showstopperRingPatched'));
}
let _tickerFn = null;
/**
 * Token state filter: follows the same official pattern as `PIXI.SpriteMaskFilter` —
 * `uFilterMatrix` is updated EVERY frame inside `apply()` via native
 * `filterManager.calculateSpriteMatrix()` (derived from the sprite's current
 * `worldTransform` to map normalized filter input UVs into local 0..1 sprite UVs).
 * Simultaneously precomputes the 2×2 inverse linear matrix `uFilterInv` on the CPU
 * so per-pixel determinant and division are avoided.
 *
 * `destroy()` is overridden NOT to destroy `this.program` (the shared compiled
 * `PIXI.Program` in `ProgramCache`); otherwise removing or switching an effect on a
 * single token would tear down the `WebGLProgram` and force shader recompilation.
 */
let _TokenShaderFilterClass = null;
function _getTokenShaderFilterClass() {
    if (_TokenShaderFilterClass)
        return _TokenShaderFilterClass;
    class TokenShaderFilter extends PIXI.Filter {
        constructor(sprite, effectId, uniforms) {
            const frag = SHADER_FRAGS[effectId] ?? SHADER_FRAGS.frozen;
            super(undefined, frag, uniforms);
            this.sprite = sprite;
            this.effectId = effectId;
            this.padding = effectId === 'burning' ? 24 : 0;
            this.autoFit = false;
        }
        apply(filterManager, input, output, clearMode, state) {
            try {
                const m = this.uniforms?.uFilterMatrix;
                if (m && this.sprite && !this.sprite.destroyed
                    && typeof filterManager.calculateSpriteMatrix === 'function') {
                    filterManager.calculateSpriteMatrix(m, this.sprite);
                    const inv = this.uniforms.uFilterInv;
                    if (inv) {
                        const det = m.a * m.d - m.b * m.c;
                        const s = Math.abs(det) > 1e-9 ? (1.0 / det) : 1e9;
                        inv[0] = m.d * s;
                        inv[1] = -m.b * s;
                        inv[2] = -m.c * s;
                        inv[3] = m.a * s;
                    }
                }
            }
            catch { /* keep previous frame's matrix if sprite was destroyed mid-frame */ }
            super.apply(filterManager, input, output, clearMode, state);
        }
        destroy() {
            this.sprite = null;
            this.destroyed = true;
        }
    }
    _TokenShaderFilterClass = TokenShaderFilter;
    return _TokenShaderFilterClass;
}
function _makeShaderFilter(token, sprite, effectId) {
    const tex = token?.mesh?.texture;
    const f = tex?.frame;
    const tw = Math.max(1, f ? f.width : (tex?.width ?? 256));
    const th = Math.max(1, f ? f.height : (tex?.height ?? 256));
    const spec = SHADER_EFFECTS[effectId] ?? SHADER_EFFECTS.frozen;
    const tokenId = token?.id ?? 'prewarm';
    const seed = ((hashStr(`ss-shader-${spec.id}-${tokenId}`) >>> 0) / 4294967295) * 100.0;
    let matrix = null;
    try {
        matrix = new PIXI.Matrix();
    }
    catch { /* smoke-test stub without PIXI.Matrix */ }
    return new (_getTokenShaderFilterClass())(sprite, spec.id, {
        uTime: 0,
        uSeed: seed,
        uTexSize: [tw, th],
        uMode: spec.mode,
        uFilterMatrix: matrix,
        uFilterInv: new Float32Array([1, 0, 0, 1])
    });
}
/* --------------------- background shader precompilation --------------------- */
let _prewarmHandle = null;
let _prewarmUseIdle = false;
let _prewarmIndex = 0;
let _prewarmed = false;
function _cancelPrewarm() {
    if (_prewarmHandle === null)
        return;
    try {
        if (_prewarmUseIdle && typeof cancelIdleCallback === 'function')
            cancelIdleCallback(_prewarmHandle);
        else
            clearTimeout(_prewarmHandle);
    }
    catch { /* noop */ }
    _prewarmHandle = null;
}
/**
 * Smoothly precompiles all separate effect shaders one per idle tick after
 * `canvasReady`. Each individual shader compiles in ~5–15 ms, so background
 * warm-up causes zero FPS drops and makes the first in-combat trigger instant (0 ms).
 */
export function prewarmTokenShaders() {
    if (_prewarmed || _prewarmHandle !== null)
        return;
    if (!canvas?.app?.renderer?.shader?.bind)
        return;
    _prewarmIndex = 0;
    const scheduleNext = (fn) => {
        if (typeof requestIdleCallback === 'function') {
            _prewarmUseIdle = true;
            _prewarmHandle = requestIdleCallback(() => { _prewarmHandle = null; fn(); }, { timeout: 120 });
        }
        else {
            _prewarmUseIdle = false;
            _prewarmHandle = setTimeout(() => { _prewarmHandle = null; fn(); }, 32);
        }
    };
    const step = () => {
        const renderer = canvas?.app?.renderer;
        if (!renderer?.shader?.bind)
            return;
        if (_prewarmIndex >= SHADER_EFFECT_IDS.length) {
            _prewarmed = true;
            return;
        }
        const effectId = SHADER_EFFECT_IDS[_prewarmIndex++];
        try {
            const prevShader = renderer.shader.shader;
            const dummy = _makeShaderFilter(null, null, effectId);
            renderer.shader.bind(dummy, true);
            if (prevShader) {
                try {
                    renderer.shader.bind(prevShader, true);
                }
                catch { /* noop */ }
            }
            dummy.destroy();
        }
        catch { /* noop */ }
        if (_prewarmIndex < SHADER_EFFECT_IDS.length) {
            scheduleNext(step);
        }
        else {
            _prewarmed = true;
        }
    };
    scheduleNext(step);
}
/** Shared time ticker driving `uTime` across all live filter instances. */
function _startTicker() {
    if (_tickerFn || !canvas?.app?.ticker)
        return;
    _tickerFn = () => {
        const t = performance.now() / 1000;
        for (const e of _live.values()) {
            if (e.filter)
                e.filter.uniforms.uTime = t;
        }
    };
    canvas.app.ticker.add(_tickerFn);
}
function _stopTicker() {
    if (!_tickerFn)
        return;
    try {
        canvas?.app?.ticker?.remove(_tickerFn);
    }
    catch { /* noop */ }
    _tickerFn = null;
}
/* ------------------------------- geometry ------------------------------- */
/**
 * Subject rectangle in px: document footprint × artwork scale.
 * Independent of current mesh state.
 */
function _subjectSize(token) {
    const doc = token?.document;
    const g = canvas?.grid;
    const gx = g?.sizeX ?? g?.size ?? 100;
    const gy = g?.sizeY ?? g?.size ?? 100;
    const td = doc?.texture ?? {};
    const sx = Math.abs(Number(td.scaleX) || 1);
    const sy = Math.abs(Number(td.scaleY) || 1);
    return {
        w: Math.max(8, (Number(doc?.width) || 1) * gx * sx),
        h: Math.max(8, (Number(doc?.height) || 1) * gy * sy)
    };
}
/** Checks whether the artwork source is ready to render/sample (avoids garbage mask & `uTexSize`). */
function _sourceReady(tex) {
    if (!tex)
        return false;
    const f = tex.frame;
    if (!f || !(f.width > 1) || !(f.height > 1))
        return false;
    const bt = tex.baseTexture;
    if (!bt)
        return true; // smoke-test stub without baseTexture — treat as ready
    const img = bt.resource?.source;
    if (!img)
        return false;
    if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
        return img.complete && img.naturalWidth > 0;
    }
    if (typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement) {
        return img.readyState >= 2;
    }
    return true; // ImageBitmap / OffscreenCanvas — already materialized
}
function _plateKey(token, effectId) {
    const tex = token?.mesh?.texture;
    const uuid = tex?.baseTexture?.uuid ?? 'na';
    const f = tex?.frame;
    const fw = Math.round(f?.width ?? 0), fh = Math.round(f?.height ?? 0);
    const { w, h } = _subjectSize(token);
    const td = token?.document?.texture ?? {};
    const flipX = (td.scaleX ?? 1) < 0 ? -1 : 1;
    const flipY = (td.scaleY ?? 1) < 0 ? -1 : 1;
    return `${effectId}|${uuid}|${fw}x${fh}|${Math.round(w)}x${Math.round(h)}|${flipX}:${flipY}`;
}
/** Deferred resync check: mesh/artwork may finish loading after the initial update. */
function _scheduleResync(id) {
    if (_rechecks.has(id))
        return;
    _rechecks.set(id, setTimeout(() => {
        _rechecks.delete(id);
        const token = canvas.tokens?.get(id);
        if (token) {
            try {
                syncToken(token);
            }
            catch { /* noop */ }
        }
    }, RESYNC_MS));
}
function _cancelResync(id) {
    const t = _rechecks.get(id);
    if (t !== undefined) {
        clearTimeout(t);
        _rechecks.delete(id);
    }
}
/* --------------------- active shader effect resolution --------------------- */
/**
 * Resolves which shader effect should be active on a token:
 *  1) explicit flag `flags.showstopper.shaderEffect` ('petrified', 'burning', ...);
 *  2) flag `flags.showstopper.frozenTint` ("Freeze" finisher → 'frozen');
 *  3) active effects / status IDs on the actor or token (`petrified` → 'petrified',
 *     `burning` → 'burning', etc.).
 */
export function resolveTokenShaderEffect(token) {
    try {
        const doc = token?.document;
        if (!doc)
            return null;
        const explicit = doc.getFlag?.(MODULE_ID, 'shaderEffect') ?? doc.flags?.[MODULE_ID]?.shaderEffect;
        if (typeof explicit === 'string' && SHADER_EFFECTS[explicit])
            return explicit;
        const frozen = doc.getFlag?.(MODULE_ID, 'frozenTint') ?? doc.flags?.[MODULE_ID]?.frozenTint;
        if (frozen !== undefined && frozen !== null)
            return 'frozen';
        // Auto-detect strictly by status ID in the actor's active effects (never by localized effect name)
        const actor = token?.actor ?? doc?.actor;
        const effects = actor?.effects ?? doc?.effects;
        if (effects) {
            const list = typeof effects.values === 'function' ? [...effects.values()] : (Array.isArray(effects) ? effects : []);
            for (const ef of list) {
                if (!ef || ef.disabled || ef.isSuppressed)
                    continue;
                const statuses = ef.statuses ? [...ef.statuses] : [];
                const legacyStatusId = ef.flags?.core?.statusId;
                if (typeof legacyStatusId === 'string' && legacyStatusId)
                    statuses.push(legacyStatusId);
                for (const statusId of statuses) {
                    const key = String(statusId).trim().toLowerCase();
                    if (SHADER_EFFECTS[key])
                        return key;
                    for (const spec of Object.values(SHADER_EFFECTS)) {
                        if (spec.statuses.includes(key))
                            return spec.id;
                    }
                }
            }
        }
    }
    catch { /* noop */ }
    return null;
}
/* ---------------------------------- sync ---------------------------------- */
/** Rebuild or remove the shader overlay on a single token. */
export function syncToken(token) {
    const id = token?.id;
    if (!id)
        return;
    const mesh = token?.mesh;
    const detach = () => {
        const e = _live.get(id);
        if (!e)
            return;
        try {
            e.cont.destroy({ children: true });
        }
        catch { /* already destroyed with mesh */ }
        try {
            e.filter?.destroy();
        }
        catch { /* repeated destroy is safe */ }
        _live.delete(id);
    };
    // Native path for tokens with a dynamic ring (analogous to spectral pulse in `ring.effects`):
    // the shader executes directly inside `TokenRingSamplerShader` without a child sprite or
    // `PIXI.Filter`, so it never occludes the ring, `multiple-rings` top layer, or `ring.effects`.
    if (_canUseNativeRingShader(token)) {
        detach();
        _cancelResync(id);
        if (!_live.size)
            _stopTicker();
        try {
            if (typeof token.ring?.configureVisuals === 'function') {
                token.ring.configureVisuals();
            }
            _applyRingShaderBits(token.ring);
            token.renderFlags?.set?.({ refreshRingVisuals: true, refreshMesh: true });
        }
        catch { /* noop */ }
        return;
    }
    const effectId = resolveTokenShaderEffect(token);
    if (!effectId || !mesh || mesh.destroyed) {
        detach();
        _cancelResync(id);
        if (!_live.size)
            _stopTicker();
        return;
    }
    // Artwork not ready yet (mesh recreation / async webp decode / placeholder):
    // wait rather than building with garbage `uTexSize` & texture; resync will retry once ready
    if (!_sourceReady(mesh.texture)) {
        detach();
        _scheduleResync(id);
        return;
    }
    const key = _plateKey(token, effectId);
    const existing = _live.get(id);
    if (existing && existing.key === key && existing.cont?.parent === mesh && !existing.cont?.destroyed) {
        return; // already up to date and parented to the live mesh
    }
    detach();
    const cont = new PIXI.Container();
    cont.name = 'showstopperShader';
    cont.eventMode = 'none';
    cont.interactiveChildren = false;
    // Shared live artwork texture: sprite does NOT own it, so `cont.destroy` leaves the base texture intact
    const spr = new PIXI.Sprite(mesh.texture);
    spr.anchor.set(0.5);
    const { w: sw, h: sh } = _subjectSize(token);
    // Local mesh space: divide out mesh scale if artwork zoom is carried on `mesh.scale`
    const kx = Math.abs(Number(mesh.scale?.x)) || 1;
    const ky = Math.abs(Number(mesh.scale?.y)) || 1;
    spr.width = sw / kx;
    spr.height = sh / ky;
    // Artwork mirroring: if the mesh itself is NOT sign-flipped on `scale`, but the document
    // specifies negative `texture.scaleX/scaleY` (dynamic ring token), flip the child sprite;
    // if `mesh.scale.x < 0` already (standard token), the child inherits the flip from the
    // mesh automatically — flipping again would cancel it out!
    const td = token?.document?.texture ?? {};
    const meshFlipX = (Number(mesh.scale?.x) || 1) < 0;
    const meshFlipY = (Number(mesh.scale?.y) || 1) < 0;
    const docFlipX = (td.scaleX ?? 1) < 0;
    const docFlipY = (td.scaleY ?? 1) < 0;
    if (docFlipX !== meshFlipX)
        spr.scale.x *= -1;
    if (docFlipY !== meshFlipY)
        spr.scale.y *= -1;
    // Filter requires the live sprite (`calculateSpriteMatrix` reads its `worldTransform`),
    // so instantiate it AFTER creating the sprite
    const filter = _makeShaderFilter(token, spr, effectId);
    spr.filters = [filter];
    cont.addChild(spr);
    mesh.addChild(cont);
    _live.set(id, { cont, filter, key, effect: effectId });
    _startTicker();
    // Mesh/artwork may finish loading slightly later — schedule a quick resync;
    // `_plateKey` encodes texture UUID and frame size so placeholder-to-art swaps rebuild cleanly
    _scheduleResync(id);
}
/** Resynchronize all scene tokens (`canvasReady`). */
export function syncAllTokenShaders() {
    installRingShaderIntegration();
    prewarmTokenShaders();
    for (const token of canvas.tokens?.placeables ?? []) {
        try {
            syncToken(token);
        }
        catch { /* one broken token must not abort the rest */ }
    }
}
/* ---------------- Shader selector UI in Token Config Ring tab ---------------- */
const SHADER_SELECT_ID = 'showstopper-ring-shader-select';
const SHADER_FLAG_PATH = `flags.${MODULE_ID}.shaderEffect`;
const SHADER_FALLBACK_LABELS = {
    frozen: 'Заморозка',
    petrified: 'Окаменение',
    burning: 'Горение',
    corrupted: 'Порча',
    gilded: 'Золотая статуя',
    bloodrage: 'Кровавая ярость',
    glitch: 'Цифровой сбой'
};
function _locOrFallback(key, fallback) {
    try {
        if (game?.i18n?.has?.(key))
            return game.i18n.localize(key);
        const val = game?.i18n?.localize?.(key);
        if (val && val !== key)
            return val;
    }
    catch { /* noop */ }
    return fallback;
}
function _injectShaderSelect(app, element) {
    try {
        const root = (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement)
            ? element
            : (element?.[0] ?? app?.element ?? null);
        if (!root?.querySelector)
            return false;
        if (root.querySelector(`#${SHADER_SELECT_ID}`))
            return true;
        let ringFieldset = null;
        const ringLegend = _locOrFallback('TOKEN.RING.SHEET.legend', 'Dynamic Ring');
        for (const fs of root.querySelectorAll('fieldset')) {
            const legend = fs.querySelector('legend');
            if ((legend && legend.textContent?.trim() === ringLegend)
                || fs.querySelector('[name="ring.enabled"], [name="ring.subject.scale"], [name^="ring.effects"]')) {
                ringFieldset = fs;
                break;
            }
        }
        if (!ringFieldset) {
            ringFieldset = root.querySelector('.tab[data-tab="appearance"]')
                ?? root.querySelector('[data-tab="appearance"]')
                ?? null;
            if (!ringFieldset)
                return false;
        }
        const doc = app?.document ?? app?.object ?? app?.token ?? null;
        const explicit = doc?.getFlag?.(MODULE_ID, 'shaderEffect') ?? doc?.flags?.[MODULE_ID]?.shaderEffect ?? '';
        const frozen = doc?.getFlag?.(MODULE_ID, 'frozenTint') ?? doc?.flags?.[MODULE_ID]?.frozenTint;
        const currentValue = explicit || (frozen !== undefined && frozen !== null ? 'frozen' : '');
        const row = document.createElement('div');
        row.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = _locOrFallback(`${MODULE_ID}.cut-ins.finisher.shaders.label`, 'Шейдер субъекта');
        label.htmlFor = SHADER_SELECT_ID;
        const fields = document.createElement('div');
        fields.className = 'form-fields';
        const select = document.createElement('select');
        select.id = SHADER_SELECT_ID;
        select.name = SHADER_FLAG_PATH;
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = _locOrFallback(`${MODULE_ID}.cut-ins.finisher.shaders.none`, 'Авто');
        select.appendChild(blank);
        for (const id of SHADER_EFFECT_IDS) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = _locOrFallback(`${MODULE_ID}.cut-ins.finisher.shaders.${id}`, SHADER_FALLBACK_LABELS[id] ?? id);
            if (id === currentValue)
                opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            const val = select.value || '';
            setTimeout(() => {
                try {
                    for (const clone of canvas?.tokens?._configPreview?.children ?? []) {
                        if (clone?.document) {
                            clone.document.flags ??= {};
                            clone.document.flags[MODULE_ID] ??= {};
                            clone.document.flags[MODULE_ID].shaderEffect = val || undefined;
                            if (!val)
                                delete clone.document.flags[MODULE_ID].frozenTint;
                        }
                        syncToken(clone);
                    }
                }
                catch { /* noop */ }
            }, 0);
        });
        fields.appendChild(select);
        row.append(label, fields);
        ringFieldset.appendChild(row);
        return true;
    }
    catch {
        return false;
    }
}
function _retryInjectShaderSelect(app, element) {
    if (_injectShaderSelect(app, element))
        return;
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            if (_injectShaderSelect(app, element))
                return;
            setTimeout(() => _injectShaderSelect(app, element), 200);
        });
    }
}
/**
 * Lifecycle hooks: flags are set/cleared via document updates (`updateToken`),
 * active effects change on the actor, meshes can be recreated during `refreshToken`,
 * and the scene initializes on `canvasReady`. Registered once from `finishers/index.mjs`.
 */
export function registerTokenShaders() {
    installRingShaderIntegration();
    Hooks.once('init', () => installRingShaderIntegration());
    Hooks.on('initializeDynamicTokenRingConfig', (ringConfig) => {
        installRingShaderIntegration();
        try {
            if (ringConfig?.shaderClass)
                patchRingShaderClass(ringConfig.shaderClass);
        }
        catch { /* noop */ }
    });
    Hooks.once('setup', () => installRingShaderIntegration());
    Hooks.on('canvasReady', () => syncAllTokenShaders());
    Hooks.on('renderTokenConfig', _retryInjectShaderSelect);
    Hooks.on('renderPrototypeTokenConfig', _retryInjectShaderSelect);
    Hooks.on('updateToken', (doc, changes) => {
        // If the user reset the shader dropdown in TokenConfig ("None"), also clear legacy `frozenTint`
        try {
            const ssChanges = changes?.flags?.[MODULE_ID];
            if (ssChanges && 'shaderEffect' in ssChanges && !ssChanges.shaderEffect
                && doc?.flags?.[MODULE_ID]?.frozenTint !== undefined && game?.user?.isGM) {
                doc.update?.({ [`flags.${MODULE_ID}.-=frozenTint`]: null });
            }
        }
        catch { /* noop */ }
        const token = canvas.tokens?.get(doc?.id);
        if (token) {
            try {
                syncToken(token);
            }
            catch { /* noop */ }
        }
    });
    Hooks.on('refreshToken', (token) => {
        if (_canUseNativeRingShader(token)) {
            try {
                _applyRingShaderBits(token.ring);
            }
            catch { /* noop */ }
            return;
        }
        // If core recreated `token.mesh`, the old overlay container is stranded on the
        // destroyed mesh — checking `existing.cont.parent === token.mesh` reattaches it
        const e = _live.get(token?.id);
        if (e && (e.cont?.destroyed || e.cont?.parent !== token?.mesh)) {
            try {
                syncToken(token);
            }
            catch { /* noop */ }
        }
    });
    const syncActorTokens = (actor) => {
        // Call with no options: across all Foundry versions `getActiveTokens()` returns
        // `Token` placeables (we need `.mesh`); option key names vary across core versions
        // (`document`/`documented`), and requesting documents would return meshless objects
        for (const token of actor?.getActiveTokens?.() ?? []) {
            try {
                syncToken(token);
            }
            catch { /* noop */ }
        }
    };
    Hooks.on('createActiveEffect', (ef) => syncActorTokens(ef?.parent));
    Hooks.on('updateActiveEffect', (ef) => syncActorTokens(ef?.parent));
    Hooks.on('deleteActiveEffect', (ef) => syncActorTokens(ef?.parent));
    Hooks.on('deleteToken', (doc) => {
        const id = doc?.id;
        _cancelResync(id);
        const e = _live.get(id);
        if (e) {
            // Same order as `detach()`: remove container from display tree first, then release filter
            try {
                e.cont.destroy({ children: true });
            }
            catch { /* already destroyed with mesh */ }
            try {
                e.filter?.destroy();
            }
            catch { /* noop */ }
            _live.delete(id);
            if (!_live.size)
                _stopTicker();
        }
    });
    Hooks.on('canvasTearDown', () => {
        _cancelPrewarm();
        for (const t of _rechecks.values())
            clearTimeout(t);
        _rechecks.clear();
        for (const e of _live.values()) {
            try {
                e.filter?.destroy();
            }
            catch { /* noop */ }
        }
        _live.clear();
        _stopTicker();
    });
}
