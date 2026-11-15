/**
 * Token movement and 2.5D animation system (`walk`, `fly` / `hover`, `jump`) for Foundry VTT v14 (`token-movement.mts`):
 *  - grounded stride (`walk`), clean aerodynamic flight and hovering (`fly` / `hover`), and parabolic arc jumps (`jump`);
 *  - controlled, distance-invariant movement speed scaled from the actor sheet's movement speeds (`actor.system.attributes.movement`);
 *  - ultra-responsive WASD movement without the OS 500 ms key-repeat delay or queued step overshoot after key release.
 *
 * Animation architecture & principles (Disney's 12 principles of animation):
 *  1. Jump (`movementAction: 'jump'`):
 *     - Phase 1 — Anticipation (launch crouch in place, `u ∈ [0..0.13]`): the token stays anchored at the takeoff point,
 *       elastically crouching and gathering momentum instead of immediately sliding linearly along the ground.
 *     - Phase 2 — Airborne Arc & Hang-Time (parabolic arc with apex hang-time, `u ∈ [0.13..0.84]`):
 *       explosive takeoff with vertical stretch, smooth hang-time at the apex with perspective scale growth
 *       toward the camera, and accelerated descent into the landing cell.
 *     - Phase 3 — Landing Impact & Elastic Settle (in-place impact cushion and rebound, `u ∈ [0.84..1.0]`):
 *       by `u = 0.84` the token has already touched down in the target cell and plays out an in-place shock-absorbing
 *       crouch (`landing squash` → subtle elastic `overshoot` → smooth settle back to `1.0`).
 *  2. Flight & Hover (`movementAction: 'fly' | 'hover'`):
 *     - Smooth S-curve aerodynamic acceleration and deceleration (`flightProgress`), elevated hover lift above the ground
 *       with gentle sinusoidal levitation/wingbeat modulation (`wingbeatWave`), perspective scale toward the camera
 *       (`scale ~ 1.12..1.22`), aerodynamic banking/pitch along the heading (`tiltAngle`), and a diffused ground shadow.
 *     - Continuous `Idle Hover`: while a token's movement action is `fly` / `hover`, it floats smoothly above its ground shadow
 *       with gentle sinusoidal vertical breathing and transitions seamlessly into and out of active flight without altitude pops.
 *  3. C²-continuous keyframe interpolation (`_smootherstep`):
 *     - All scale (`scaleX`, `scaleY`) and banking (`tiltAngle`) transitions are stitched with quintic polynomials
 *       ($6t^5 - 15t^4 + 10t^3$) with zero velocity or acceleration discontinuities.
 *  4. Soft radial-gradient ground shadow (`_ssJumpShadow`):
 *     - A cached radial-gradient shadow sprite glides strictly along the ground line via `flightProgress`,
 *       shrinking and softening as the token gains altitude.
 *  5. Native protection against `RenderFlags` overwrites:
 *     - Applied at the very end of `_refreshPosition`, `_refreshMeshSizeAndScale`, and `_refreshRotation` with
 *       re-entrancy guards around `super.*()` calls (fully compatible with `Token5e` and Dynamic Token Rings).
 */

import { registerAPI } from '../core/runtime.mjs';

const MODULE_ID = 'showstopper';
const SETTING_NS = 'tokenMovement';

export interface TokenMovementSettings {
  walk: boolean;
  jump: boolean;
  fly: boolean;
  fall: boolean;
  vertical: boolean;
  verticalBlur: boolean;
  verticalCameraZoom: boolean;
}

export type TokenMovementSettingKey = keyof TokenMovementSettings;

export const TOKEN_MOVEMENT_DEFAULTS: Readonly<TokenMovementSettings> = {
  walk: true,
  jump: true,
  fly: true,
  fall: true,
  vertical: true,
  verticalBlur: true,
  verticalCameraZoom: true
};

/** Read a single token-movement setting safely, falling back to `true` when unregistered (e.g. headless tests). */
export function getTokenMovementSetting(key: TokenMovementSettingKey): boolean {
  try {
    const val = (globalThis as any).game?.settings?.get?.(MODULE_ID, `${SETTING_NS}.${key}`);
    if (typeof val === 'boolean') return val;
  } catch { /* fallback to default in headless/unregistered contexts */ }
  return TOKEN_MOVEMENT_DEFAULTS[key];
}

/** Return the full snapshot of token-movement animation toggles. */
export function getTokenMovementSettings(): TokenMovementSettings {
  return {
    walk: getTokenMovementSetting('walk'),
    jump: getTokenMovementSetting('jump'),
    fly: getTokenMovementSetting('fly'),
    fall: getTokenMovementSetting('fall'),
    vertical: getTokenMovementSetting('vertical'),
    verticalBlur: getTokenMovementSetting('verticalBlur'),
    verticalCameraZoom: getTokenMovementSetting('verticalCameraZoom')
  };
}

const JUMP_ACTION_RE = /^(jump|leap|hop|vault|bound|прыж|прыжок)$/i;
const FLY_ACTION_RE = /^(fly|hover|flight|glide|soar|полёт|полет|парение)$/i;
const FALL_ACTION_RE = /^(fall|falling|plummet|drop|падение|падать)$/i;
const WALK_ACTION_RE = /^(walk|run|step|stride|march|crawl|climb|swim|burrow|ходьба|шаг|бег|ползти|лазание|плавание)$/i;
const CLIMB_ACTION_RE = /^(climb|лазание|карабкаться)$/i;
const GROUND_DEFAULT_ACTION_RE = /^(walk|run|step|stride|march|move|ходьба|шаг|бег)$/i;
const TELEPORT_ACTION_RE = /^(blink|teleport|displace|телепорт|телепортация)$/i;
const INPUT_METHOD_RE = /^(dragging|keyboard|api|hud|config|paste|undo)$/i;

/** Check whether a movement action name represents teleportation (without calling deprecated operation getters). */
function _isTeleportActionName(raw: any): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const act = raw.trim();
  if (!act || INPUT_METHOD_RE.test(act)) return false;
  if (TELEPORT_ACTION_RE.test(act)) return true;
  try {
    return (globalThis as any).CONFIG?.Token?.movement?.actions?.[act]?.teleport === true;
  } catch {
    return false;
  }
}

/**
 * Determine whether a Foundry v14 movement / DatabaseUpdateOperation represents teleportation
 * without reading the deprecated `DatabaseUpdateOperation#teleport` getter.
 */
function _isTeleportOperation(options: any, movement?: any, docId?: string): boolean {
  if (movement) {
    const wpAction = movement?.passed?.waypoints?.at?.(-1)?.action;
    if (_isTeleportActionName(wpAction)) return true;
  }
  if (!options || typeof options !== 'object') return false;
  const moveMap = options._movement;
  if (moveMap && typeof moveMap === 'object') {
    if (docId && moveMap[docId]) {
      if (_isTeleportActionName(moveMap[docId]?.passed?.waypoints?.at?.(-1)?.action)) return true;
    } else if (moveMap.passed) {
      if (_isTeleportActionName(moveMap.passed?.waypoints?.at?.(-1)?.action)) return true;
    } else {
      const moves = Object.values(moveMap);
      if (moves.length > 0 && moves.every((m: any) => _isTeleportActionName(m?.passed?.waypoints?.at?.(-1)?.action))) {
        return true;
      }
    }
  }
  const desc = Object.getOwnPropertyDescriptor(options, 'teleport');
  if (desc && 'value' in desc && desc.value === true) return true;
  return _isTeleportActionName(options.action) || _isTeleportActionName(options.movementAction);
}

/** Fraction of jump animation duration at which takeoff occurs after the anticipation crouch. */
export const JUMP_LAUNCH_T = 0.13;
/** Fraction of jump animation duration at which the token touches down at the landing point. */
export const JUMP_LAND_T = 0.84;

/** Perlin's C²-continuous quintic S-step: zero 1st and 2nd derivatives at both endpoints of [0, 1]. */
function _smootherstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** C²-continuous piecewise interpolation across keyframe pairs `[[u0, v0], [u1, v1], ...]`. */
function _evalKeyframes(u: number, keys: ReadonlyArray<readonly [number, number]>): number {
  if (u <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (u >= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [u0, v0] = keys[i];
    const [u1, v1] = keys[i + 1];
    if (u >= u0 && u <= u1) {
      const span = u1 - u0;
      if (span <= 1e-6) return v1;
      const s = _smootherstep((u - u0) / span);
      return v0 + (v1 - v0) * s;
    }
  }
  return last[1];
}

/** Check whether a string identifies a jump movement action. */
export function isJumpActionName(raw: any): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || INPUT_METHOD_RE.test(s)) return false;
  return JUMP_ACTION_RE.test(s);
}

/** Check whether a string identifies a fly/hover movement action. */
export function isFlyActionName(raw: any): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || INPUT_METHOD_RE.test(s)) return false;
  return FLY_ACTION_RE.test(s);
}

/** Check whether a string identifies a falling state or movement action (`fall` / `falling` / `plummet`). */
export function isFallActionName(raw: any): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || INPUT_METHOD_RE.test(s)) return false;
  return FALL_ACTION_RE.test(s);
}

/** Check whether a string identifies a grounded walk/stride movement action. */
export function isWalkActionName(raw: any): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || INPUT_METHOD_RE.test(s)) return false;
  return WALK_ACTION_RE.test(s);
}

/** Check whether a string identifies a deliberate climb movement action (`climb`). */
export function isClimbActionName(raw: any): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || INPUT_METHOD_RE.test(s)) return false;
  return CLIMB_ACTION_RE.test(s);
}

/**
 * Whether the token currently occupies (or `positionOverride` lies inside) a Foundry v14 `changeLevel` region
 * (stairs, ladder, elevator, shaft) where level/elevation transitions are deliberate relocations rather than mid-air jumps or falls.
 */
export function isTokenInLevelChangeRegion(tokenOrDoc: any, positionOverride?: any): boolean {
  if (!tokenOrDoc) return false;
  try {
    const doc = tokenOrDoc.document ?? tokenOrDoc;
    const baseSrc = doc?._source ?? doc;
    const hasCustomPos = Boolean(
      positionOverride &&
      positionOverride !== baseSrc &&
      (
        (positionOverride.x !== undefined && positionOverride.x !== baseSrc?.x) ||
        (positionOverride.y !== undefined && positionOverride.y !== baseSrc?.y) ||
        (positionOverride.elevation !== undefined && positionOverride.elevation !== baseSrc?.elevation) ||
        (positionOverride.level !== undefined && positionOverride.level !== baseSrc?.level)
      )
    );
    if (!hasCustomPos) {
      const regions = doc?.regions;
      if (regions) {
        for (const region of regions) {
          const behaviors = region?.behaviors;
          if (!behaviors) continue;
          for (const behavior of behaviors) {
            if (!behavior?.disabled && behavior?.type === 'changeLevel') return true;
          }
        }
      }
    }
    const sceneRegions = doc?.parent?.regions;
    if (!sceneRegions) return false;
    const gridSize = Number((globalThis as any).canvas?.grid?.size ?? (globalThis as any).canvas?.dimensions?.size) || 100;
    const wG = Math.abs(Number(positionOverride?.width ?? baseSrc?.width ?? doc?.width ?? 1)) || 1;
    const hG = Math.abs(Number(positionOverride?.height ?? baseSrc?.height ?? doc?.height ?? 1)) || 1;
    const cx = (Number(positionOverride?.x ?? baseSrc?.x ?? doc?.x ?? 0) || 0) + wG * gridSize * 0.5;
    const cy = (Number(positionOverride?.y ?? baseSrc?.y ?? doc?.y ?? 0) || 0) + hG * gridSize * 0.5;
    const elev = Number(positionOverride?.elevation ?? baseSrc?.elevation ?? doc?.elevation ?? 0) || 0;
    const lvl = positionOverride?.level ?? baseSrc?.level ?? doc?.level ?? null;
    for (const region of sceneRegions) {
      const behaviors = region?.behaviors;
      if (!behaviors) continue;
      let hasChangeLevel = false;
      for (const behavior of behaviors) {
        if (!behavior?.disabled && behavior?.type === 'changeLevel') {
          hasChangeLevel = true;
          break;
        }
      }
      if (!hasChangeLevel) continue;
      if (lvl && typeof region.includedInLevel === 'function') {
        try {
          if (!region.includedInLevel(lvl)) continue;
        } catch { /* ignore */ }
      }
      if (typeof region.testPoint === 'function' && region.testPoint({ x: cx, y: cy, elevation: elev })) {
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Base floor elevation of the currently viewed scene level (`canvas.level.elevation.base` in Foundry VTT v14):
 *  - `0` on standard single-level scenes and in headless unit tests;
 *  - e.g. `-20` on a Dungeon level, `20` on a Second Floor level, `40` on a Third Floor level.
 */
export function getViewedLevelBaseElevation(): number {
  const cv = (globalThis as any).canvas;
  const lvlElev = cv?.level?.elevation;
  if (lvlElev) {
    const base = Number(lvlElev.base);
    if (Number.isFinite(base)) return base;
    const bottom = Number(lvlElev.bottom);
    if (Number.isFinite(bottom)) return bottom;
  }
  const bgElev = Number(cv?.primary?.background?.elevation);
  if (Number.isFinite(bgElev)) return bgElev;
  return 0;
}

/**
 * Whether the token is currently in a falling state (`Falling` / `statusId: "falling"` or `movementAction === 'fall'`).
 * Checks:
 *  - `actor.statuses.has('falling')` (standard D&D 5e / Foundry v14 status set);
 *  - `document.hasStatusEffect('falling')` and `document.statuses.has('falling')`;
 *  - active `actor.effects` carrying the `'falling'` status;
 *  - selected movement action `document.movementAction === 'fall'` (when `elevation > 0`, on multi-level scenes, or when a fall flag is present).
 */
export function isTokenFalling(token: any): boolean {
  if (!token) return false;
  try {
    const doc = token.document ?? token;
    const actor = token.actor ?? doc?.actor;
    if (actor?.statuses?.has?.('falling')) return true;
    if (doc?.statuses?.has?.('falling')) return true;
    if (typeof doc?.hasStatusEffect === 'function' && doc.hasStatusEffect('falling')) return true;
    const effects = actor?.effects;
    if (effects) {
      const iter = typeof effects.values === 'function' ? effects.values() : (Array.isArray(effects) ? effects : []);
      for (const eff of iter) {
        if (!eff || eff.disabled || eff.isSuppressed) continue;
        if (eff.statuses?.has?.('falling') || eff._id === 'dnd5efalling0000') return true;
      }
    }
    const docAction = doc?.movementAction ?? doc?._source?.movementAction;
    if (isFallActionName(docAction)) {
      const srcElev = Number(doc?._source?.elevation);
      const docElev = Number(doc?.elevation ?? token?.elevation ?? 0);
      const elev = Number.isFinite(srcElev) ? srcElev : (Number.isFinite(docElev) ? docElev : 0);
      if (elev > 0 || token._ssFallingExplicit === true || (doc?.parent?.levels?.size > 1)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Extract the token's fly speed from the actor sheet (`actor.system.attributes.movement`),
 * normalized to feet (where `1.5 m` = `5 ft`).
 */
export function getActorSheetFlySpeedFt(token: any): number {
  if (!token) return 0;
  try {
    const doc = token.document ?? token;
    const actor = token.actor ?? doc?.actor;
    const mov = actor?.system?.attributes?.movement;
    if (!mov) return 0;
    const speeds = mov.speeds ?? mov;
    const rawFly = Number(speeds?.fly ?? mov.fly) || 0;
    if (!(rawFly > 0)) return 0;
    const units = String(mov.units ?? (globalThis as any).canvas?.scene?.grid?.units ?? 'ft').trim().toLowerCase();
    if (units === 'm' || units.startsWith('met') || units === 'м' || units.startsWith('мет')) {
      return rawFly * (5 / 1.5);
    }
    return rawFly;
  } catch {
    return 0;
  }
}

/**
 * Whether the token has an active fly speed `> 1` ft on its actor sheet
 * (accounting for `incapacitated`, or `prone` without `hover`, stripping the ability to stay aloft).
 */
export function hasActorSheetFlySpeed(token: any): boolean {
  if (!token) return false;
  try {
    const doc = token.document ?? token;
    const actor = token.actor ?? doc?.actor;
    if (!actor) return false;
    const mov = actor?.system?.attributes?.movement;
    const canHover = Boolean(mov?.hover);
    if (actor.statuses?.has?.('incapacitated')) return false;
    if (actor.statuses?.has?.('prone') && !canHover) return false;
    return getActorSheetFlySpeedFt(token) > 1;
  } catch {
    return false;
  }
}

export interface SupportingSurfaceInfo {
  elevation: number;
  level: any;
  region: any;
  sourceType: 'scene' | 'tile' | 'token';
  sourceId: string | null;
  isLargePlatform?: boolean;
}

let _surfaceWorldVersion = 1;
let _origFindSupportingSurface: ((opts?: any) => any) | null = null;
let _inSupportingSurfaceLookup = false;
const _tmpCanvasPt = { x: 0, y: 0 };

/* --------------------- Supporting Surface Resolution --------------------- */

/** Invalidate the supporting-surface cache across all tokens (on tile, region, or token changes). */
export function invalidateSupportingSurfaces(): number {
  _surfaceWorldVersion = (_surfaceWorldVersion + 1) | 0;
  return _surfaceWorldVersion;
}

/**
 * Vertical height of a token in scene units (feet) used to compute its upper supporting platform (`topElevation`):
 *  - prefers an explicit `document.flags.showstopper.platformHeight` override;
 *  - defaults to `min(width, height) * gridDistance` (`5 ft` for `1x1` Medium/crate, `10 ft` for `2x2` Large, `15 ft` for `3x3` Huge, etc.).
 */
export function getTokenVerticalHeightFt(tokenOrDoc: any, gridDistOverride?: number): number {
  const doc = tokenOrDoc?.document ?? tokenOrDoc;
  if (!doc) return 0;
  const explicitH = Number(doc.flags?.showstopper?.platformHeight);
  if (Number.isFinite(explicitH) && explicitH >= 0) return explicitH;
  const gridDist = Number(gridDistOverride) > 0
    ? Number(gridDistOverride)
    : (Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5);
  const wG = Math.abs(Number(doc._source?.width ?? doc.width ?? 1)) || 1;
  const hG = Math.abs(Number(doc._source?.height ?? doc.height ?? 1)) || 1;
  return Math.max(0.5, Math.min(wG, hG)) * gridDist;
}

/**
 * Pixel-perfect hit test checking whether scene point `(px, py)` lands on an opaque pixel of a `Tile`:
 * uses Foundry VTT v14's native `PrimarySpriteMesh#containsCanvasPoint(pt, alphaThreshold)`
 * (which accounts for `canvasBounds`, `rotation`, flip/scale, and `TextureLoader.getTextureAlphaData`)
 * so transparent bridge edges, floor holes, and empty alpha padding around PNGs never count as solid floor.
 */
function _tileContainsPointPixelPerfect(tile: any, px: number, py: number, alphaThreshold = 0.25): boolean {
  if (!tile || tile.destroyed) return false;
  if (typeof tile._ssTestAlpha === 'function') {
    return Number(tile._ssTestAlpha(px, py)) >= alphaThreshold;
  }
  const mesh = tile.mesh;
  if (mesh && !mesh.destroyed && typeof mesh.containsCanvasPoint === 'function') {
    if (!mesh._texture?.valid) return false;
    _tmpCanvasPt.x = px;
    _tmpCanvasPt.y = py;
    try {
      return Boolean(mesh.containsCanvasPoint(_tmpCanvasPt, alphaThreshold));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check whether scene point `(px, py)` falls inside another token's (`otherTok` / `otherDoc`) logical footprint,
 * respecting its actual texture alpha mask (evaluated in unshifted `TokenDocument` coordinates, unaffected by mesh parallax or hover lift).
 */
function _tokenContainsPointPixelPerfect(
  otherTokOrDoc: any,
  px: number,
  py: number,
  gridSize: number,
  alphaThreshold = 0.20
): boolean {
  const otherDoc = otherTokOrDoc?.document ?? otherTokOrDoc;
  const otherTok = otherTokOrDoc?.document ? otherTokOrDoc : otherDoc?.object;
  if (!otherDoc) return false;

  if (typeof otherTok?._ssTestAlpha === 'function') {
    return Number(otherTok._ssTestAlpha(px, py)) >= alphaThreshold;
  }
  if (typeof otherDoc?._ssTestAlpha === 'function') {
    return Number(otherDoc._ssTestAlpha(px, py)) >= alphaThreshold;
  }

  const ox = Number(otherDoc._source?.x ?? otherDoc.x ?? 0);
  const oy = Number(otherDoc._source?.y ?? otherDoc.y ?? 0);
  const ow = (Math.abs(Number(otherDoc._source?.width ?? otherDoc.width ?? 1)) || 1) * gridSize;
  const oh = (Math.abs(Number(otherDoc._source?.height ?? otherDoc.height ?? 1)) || 1) * gridSize;
  if (!(ow > 0 && oh > 0)) return false;

  const ocx = ox + ow * 0.5;
  const ocy = oy + oh * 0.5;
  let dx = px - ocx;
  let dy = py - ocy;

  // Account for token rotation (unless a circular Dynamic Token Ring is active)
  const rotDeg = Number(otherDoc._source?.rotation ?? otherDoc.rotation ?? 0) || 0;
  if (rotDeg && !otherTok?.ring?.enabled) {
    const rad = (-rotDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    dx = rx;
    dy = ry;
  }

  const scaleX = Number(otherDoc.texture?.scaleX ?? 1) || 1;
  const scaleY = Number(otherDoc.texture?.scaleY ?? 1) || 1;
  const effW = ow * Math.abs(scaleX);
  const effH = oh * Math.abs(scaleY);
  if (Math.abs(dx) > effW * 0.5 || Math.abs(dy) > effH * 0.5) return false;

  // For tokens with a Dynamic Token Ring, the supporting footprint is the ring's inscribed circle/ellipse
  if (otherTok?.ring?.enabled) {
    const nx = dx / (ow * 0.48);
    const ny = dy / (oh * 0.48);
    return (nx * nx + ny * ny) <= 1.0;
  }

  // When a valid mesh texture is available, sample its actual opacity map via `TextureLoader.getTextureAlphaData`
  const tex = otherTok?.mesh?._texture;
  const TL = (globalThis as any).foundry?.canvas?.TextureLoader ?? (globalThis as any).TextureLoader;
  if (tex?.valid && tex.width > 0 && tex.height > 0 && typeof TL?.getTextureAlphaData === 'function') {
    try {
      let alphaData = otherTok.mesh._textureAlphaData;
      if (!alphaData) {
        alphaData = TL.getTextureAlphaData(tex, 0.25);
        if (alphaData) otherTok.mesh._textureAlphaData = alphaData;
      }
      if (alphaData?.data && alphaData.width > 0 && alphaData.height > 0) {
        let u = (dx / effW) * (scaleX < 0 ? -1 : 1) + 0.5;
        let v = (dy / effH) * (scaleY < 0 ? -1 : 1) + 0.5;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
        const ax = u * alphaData.width;
        const ay = v * alphaData.height;
        const { minX, minY, maxX, maxY } = alphaData;
        if (ax < minX || ax >= maxX || ay < minY || ay >= maxY) return false;
        const alpha = alphaData.data[((maxX - minX) * ((ay | 0) - minY)) + ((ax | 0) - minX)] / 255;
        return alpha >= alphaThreshold;
      }
    } catch { /* fallback to ellipse below */ }
  }

  // Geometric fallback (inscribed token ellipse)
  const nx = dx / (ow * 0.48);
  const ny = dy / (oh * 0.48);
  return (nx * nx + ny * ny) <= 1.04;
}

// Offsets of the 9 token-sole sample points as fractions of `rCore` (`[dxFactor, dyFactor, weight]`, total weight = 10; support threshold = 5)
const SOLE_KERNEL: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 2],
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [0.7071, 0.7071, 1],
  [-0.7071, 0.7071, 1],
  [0.7071, -0.7071, 1],
  [-0.7071, -0.7071, 1]
];

/**
 * Resolve the resting `Level` document for a given `elevation` on multi-level Foundry v14 scenes
 * (mirroring `TokenDocument5e##findRestingLevel` for custom tile/token platforms).
 */
function _resolveRestingLevelForElevation(
  scene: any,
  elevation: number,
  candidateLevelIds?: Iterable<string> | null,
  currentLevelId?: string | null
): any {
  const levels = scene?.levels;
  if (!levels) return null;
  const current = currentLevelId && typeof levels.get === 'function' ? (levels.get(currentLevelId) ?? null) : null;
  const candidates: any[] = [];
  if (candidateLevelIds && typeof levels.get === 'function') {
    for (const id of candidateLevelIds) {
      const l = levels.get(id);
      if (l) candidates.push(l);
    }
  }
  const allLevels: any[] = candidates.length > 0
    ? candidates
    : (Array.isArray(levels.contents) ? levels.contents : Array.from(levels.values?.() ?? []));
  let home: any = null;
  for (let i = 0; i < allLevels.length; i++) {
    const lvl = allLevels[i];
    const bot = Number(lvl?.elevation?.bottom);
    const top = Number(lvl?.elevation?.top);
    if (Number.isFinite(bot) && Number.isFinite(top) && elevation >= bot && elevation < top) {
      if (home) return current;
      home = lvl;
    }
  }
  return home ?? current;
}

/**
 * Find the highest solid supporting surface beneath a token at `positionOverride` (`<= elevation + 0.05`):
 *  1) Scene levels and `Surface` regions (`TokenDocument5e#_findSupportingSurface`, with lower-level fallback across multi-level holes/balconies);
 *  2) Floor/bridge tiles (`canvas.tiles.placeables`) via **pixel-perfect** alpha testing (`PrimarySpriteMesh#containsCanvasPoint` on PNG/WebP alpha),
 *     excluding overhead canopy/fade occlusion tiles (`occlusion.mode > 0`) on scenes that define explicit movement surfaces;
 *  3) Other tokens (`canvas.tokens.placeables`) at their upper face (`other.elevation + getTokenVerticalHeightFt(other)`).
 */
export function resolveSupportingSurface(
  tokenOrDoc: any,
  positionOverride?: any,
  origSceneFn?: ((opts?: any) => any) | null,
  { ignoreTokens = false }: { ignoreTokens?: boolean } = {}
): SupportingSurfaceInfo | null {
  const doc = tokenOrDoc?.document ?? tokenOrDoc;
  if (!doc) return null;

  const baseSrc = doc._source ?? doc;
  const x = Number(positionOverride?.x ?? baseSrc?.x ?? doc.x ?? 0) || 0;
  const y = Number(positionOverride?.y ?? baseSrc?.y ?? doc.y ?? 0) || 0;
  const rawElev = positionOverride?.elevation !== undefined
    ? Number(positionOverride.elevation)
    : _readTokenRawElevation(tokenOrDoc);
  const elev = Number.isFinite(rawElev) ? rawElev : 0;
  const level = positionOverride?.level ?? baseSrc?.level ?? doc.level ?? null;
  const scene = doc.parent ?? (globalThis as any).canvas?.scene ?? null;

  const gridSize = Number((globalThis as any).canvas?.grid?.size ?? (globalThis as any).canvas?.dimensions?.size) || 100;
  const gridDist = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
  const wGrids = Math.abs(Number(positionOverride?.width ?? baseSrc?.width ?? doc.width ?? 1)) || 1;
  const hGrids = Math.abs(Number(positionOverride?.height ?? baseSrc?.height ?? doc.height ?? 1)) || 1;
  const tokW = wGrids * gridSize;
  const tokH = hGrids * gridSize;
  const cx = x + tokW * 0.5;
  const cy = y + tokH * 0.5;
  const rCore = Math.max(4, Math.min(tokW, tokH) * 0.22);

  // 1) Base scene / region floor (via original `_findSupportingSurface` with re-entrancy guard)
  let bestSurface: SupportingSurfaceInfo | null = null;
  let bestElev = -Infinity;

  const sceneSurfaceFn = origSceneFn
    ?? ((typeof doc._findSupportingSurface === 'function' && !doc._findSupportingSurface._ssWrapped)
      ? doc._findSupportingSurface
      : _origFindSupportingSurface);

  if (typeof sceneSurfaceFn === 'function' && doc.parent && !_inSupportingSurfaceLookup) {
    _inSupportingSurfaceLookup = true;
    try {
      let baseRes = sceneSurfaceFn.call(doc, {
        position: {
          ...baseSrc,
          x,
          y,
          width: wGrids,
          height: hGrids,
          elevation: elev,
          level
        }
      });
      // Fallback for multi-level scenes when a lower level's `defineSurface` region omits the upper level ID in `region.levels`
      // (or when a token drops into a shaft/pit below its current level's floor): search lower levels below `elev`
      // while clamping below each lower level's ceiling (`top - 0.01`) so ceilings (`placement: "top" | "both"`) don't act as floors.
      if (!baseRes && level && (doc.parent.levels?.size ?? 0) > 1) {
        const lvlList: any[] = Array.isArray(doc.parent.levels.contents)
          ? doc.parent.levels.contents
          : Array.from(doc.parent.levels.values?.() ?? []);
        let bestFallback: any = null;
        for (let li = 0; li < lvlList.length; li++) {
          const candLvl = lvlList[li];
          if (!candLvl || candLvl.id === level) continue;
          const cBot = Number(candLvl.elevation?.bottom);
          const cTop = Number(candLvl.elevation?.top);
          if (!Number.isFinite(cBot) || cBot > elev) continue;
          const probeElev = Number.isFinite(cTop) ? Math.min(elev, cTop - 0.01) : elev;
          if (probeElev < cBot) continue;
          const candRes = sceneSurfaceFn.call(doc, {
            position: {
              ...baseSrc,
              x,
              y,
              width: wGrids,
              height: hGrids,
              elevation: probeElev,
              level: candLvl.id
            }
          });
          if (
            candRes &&
            Number.isFinite(Number(candRes.elevation)) &&
            Number(candRes.elevation) <= elev &&
            (!bestFallback || Number(candRes.elevation) > Number(bestFallback.elevation))
          ) {
            bestFallback = candRes;
          }
        }
        if (bestFallback) baseRes = bestFallback;
      }
      if (baseRes && Number.isFinite(Number(baseRes.elevation))) {
        bestElev = Number(baseRes.elevation);
        bestSurface = {
          elevation: bestElev,
          level: baseRes.level ?? null,
          region: baseRes.region ?? null,
          sourceType: 'scene',
          sourceId: baseRes.region?.id ?? baseRes.level?.id ?? null
        };
      }
    } catch { /* ignore */ } finally {
      _inSupportingSurfaceLookup = false;
    }
  } else if (!doc.parent || typeof sceneSurfaceFn !== 'function') {
    if (elev >= -0.05) {
      bestElev = 0;
      bestSurface = { elevation: 0, level: null, region: null, sourceType: 'scene', sourceId: null };
    }
  }

  // On Foundry v14 scenes that author explicit movement surfaces (`defineSurface` with `move: true`),
  // overhead occlusion tiles (`occlusion.mode > 0`, e.g. `FADE` tree canopies, awnings, cranes) are visual roofs/foliage
  // rather than walkable platforms unless explicitly opted in via `flags.showstopper.surfaceMode === 'solid'` or `walkable === true`.
  let hasSceneMoveSurfaces = false;
  try {
    hasSceneMoveSurfaces = Boolean(scene?.getSurfaces?.({ type: 'move' })?.length > 0);
  } catch { /* ignore */ }

  // 2) Tiles (`canvas.tiles.placeables`) — pixel-perfect against texture alpha (tokens cannot stand on transparent air)
  const tiles: any[] | undefined = (globalThis as any).canvas?.tiles?.placeables;
  if (Array.isArray(tiles) && tiles.length > 0) {
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const tileDoc = tile?.document;
      if (!tile || tile.destroyed || !tileDoc || tileDoc.hidden) continue;
      const surfMode = tileDoc.flags?.showstopper?.surfaceMode;
      const explicitWalkable = tileDoc.flags?.showstopper?.walkable;
      if (surfMode === 'ignore' || explicitWalkable === false) continue;

      if (hasSceneMoveSurfaces && surfMode !== 'solid' && explicitWalkable !== true) {
        const occMode = Number(tileDoc.occlusion?.mode) || Number(tileDoc.occlusion?.modes?.size) || 0;
        if (occMode > 0) continue;
      }

      const tileAlpha = Number(tileDoc.alpha ?? 1);
      if (surfMode !== 'solid' && !(tileAlpha >= 0.35)) continue;

      const tileElev = Number(tileDoc._source?.elevation ?? tileDoc.elevation ?? 0);
      if (!Number.isFinite(tileElev) || tileElev > elev + 0.05 || tileElev <= bestElev + 0.001) continue;

      if (level && typeof tileDoc.includedInLevel === 'function') {
        try {
          if (!tileDoc.includedInLevel(level)) continue;
        } catch { /* ignore */ }
      }

      // Fast `canvasBounds` AABB rejection (`PIXI.Rectangle` in Foundry v14 or `{ minX, maxX }`) before per-pixel alpha lookup
      const bounds = tile.mesh?.canvasBounds;
      if (bounds) {
        const bMinX = Number.isFinite(bounds.x) ? bounds.x : bounds.minX;
        const bMinY = Number.isFinite(bounds.y) ? bounds.y : bounds.minY;
        const bMaxX = Number.isFinite(bounds.x) && Number.isFinite(bounds.width) ? (bounds.x + bounds.width) : bounds.maxX;
        const bMaxY = Number.isFinite(bounds.y) && Number.isFinite(bounds.height) ? (bounds.y + bounds.height) : bounds.maxY;
        if (
          Number.isFinite(bMinX) &&
          (cx + rCore < bMinX || cx - rCore > bMaxX || cy + rCore < bMinY || cy - rCore > bMaxY)
        ) {
          continue;
        }
      }

      const alphaThr = surfMode === 'solid' ? 0.05 : Math.min(0.85, 0.25 / Math.max(0.35, tileAlpha));
      let hitWeight = 0;
      let remainingWeight = 10;
      for (let k = 0; k < SOLE_KERNEL.length; k++) {
        const [kx, ky, w] = SOLE_KERNEL[k];
        if (_tileContainsPointPixelPerfect(tile, cx + kx * rCore, cy + ky * rCore, alphaThr)) {
          hitWeight += w;
          if (hitWeight >= 5) break;
        }
        remainingWeight -= w;
        if (hitWeight + remainingWeight < 5) break;
      }

      if (hitWeight >= 5) {
        bestElev = tileElev;
        const tileLvl = _resolveRestingLevelForElevation(scene, tileElev, tileDoc.levels, level) ?? bestSurface?.level ?? null;
        bestSurface = {
          elevation: tileElev,
          level: tileLvl,
          region: null,
          sourceType: 'tile',
          sourceId: tileDoc.id ?? null,
          isLargePlatform: true
        };
      }
    }
  }

  // 3) Other tokens (`canvas.tokens.placeables`) — support on their top surface (`other.elevation + verticalHeight`)
  const tokens: any[] | undefined = ignoreTokens ? undefined : (globalThis as any).canvas?.tokens?.placeables;
  if (Array.isArray(tokens) && tokens.length > 0) {
    const selfId = doc.id ?? null;
    const selfArea = tokW * tokH;
    for (let i = 0; i < tokens.length; i++) {
      const otherTok = tokens[i];
      const otherDoc = otherTok?.document ?? otherTok;
      if (!otherDoc || otherTok?.destroyed || otherTok?.isPreview || otherDoc.hidden) continue;
      if (otherDoc === doc || (selfId && otherDoc.id === selfId)) continue;
      const surfMode = otherDoc.flags?.showstopper?.surfaceMode;
      if (surfMode === 'ignore' || otherDoc.flags?.showstopper?.walkable === false) continue;
      if (isTokenFalling(otherTok)) continue;
      // Guard against mutual A <-> B support cycles
      if (selfId && otherTok?._ssSupportCache?.sourceType === 'token' && otherTok._ssSupportCache.sourceId === selfId) continue;

      if (level && typeof otherDoc.includedInLevel === 'function') {
        try {
          if (!otherDoc.includedInLevel(level)) continue;
        } catch { /* ignore */ }
      }

      const otherBaseElev = _readTokenRawElevation(otherTok);
      const otherVertH = getTokenVerticalHeightFt(otherTok, gridDist);
      const topElev = otherBaseElev + otherVertH;
      if (!Number.isFinite(topElev) || topElev > elev + 0.05 || topElev <= bestElev + 0.001) continue;

      const owG = Math.abs(Number(otherDoc._source?.width ?? otherDoc.width ?? 1)) || 1;
      const ohG = Math.abs(Number(otherDoc._source?.height ?? otherDoc.height ?? 1)) || 1;
      const owPx = owG * gridSize;
      const ohPx = ohG * gridSize;
      const otherArea = owPx * ohPx;
      if (surfMode !== 'solid' && otherArea < selfArea * 0.49) continue;

      const ox = Number(otherDoc._source?.x ?? otherDoc.x ?? 0);
      const oy = Number(otherDoc._source?.y ?? otherDoc.y ?? 0);
      if (cx + rCore < ox || cx - rCore > ox + owPx || cy + rCore < oy || cy - rCore > oy + ohPx) continue;

      let hitWeight = 0;
      let remainingWeight = 10;
      for (let k = 0; k < SOLE_KERNEL.length; k++) {
        const [kx, ky, w] = SOLE_KERNEL[k];
        if (_tokenContainsPointPixelPerfect(otherTok, cx + kx * rCore, cy + ky * rCore, gridSize, 0.20)) {
          hitWeight += w;
          if (hitWeight >= 5) break;
        }
        remainingWeight -= w;
        if (hitWeight + remainingWeight < 5) break;
      }

      if (hitWeight >= 5) {
        bestElev = topElev;
        const otherLvlId = otherDoc._source?.level ?? otherDoc.level ?? null;
        const tokLvl = _resolveRestingLevelForElevation(scene, topElev, otherLvlId ? [otherLvlId] : null, level)
          ?? (otherLvlId ? scene?.levels?.get?.(otherLvlId) : null)
          ?? bestSurface?.level
          ?? null;
        bestSurface = {
          elevation: topElev,
          level: tokLvl,
          region: null,
          sourceType: 'token',
          sourceId: otherDoc.id ?? null,
          isLargePlatform: surfMode === 'solid' || otherArea > selfArea * 1.1
        };
      }
    }
  }

  return bestSurface;
}

/**
 * Fast solid-floor elevation lookup beneath a token with O(1) per-frame caching (`token._ssSupportCache`).
 * When `forFlySuppression = true`, standing over an equal-sized ally (`1x1` beneath `1x1`) does not suppress a flyer's hover,
 * whereas tiles, scene levels, and larger tokens/platforms (`2x2+`) act as full landing surfaces.
 */
export function getTokenSupportElevation(
  token: any,
  elevOverride?: number,
  { forFlySuppression = false, levelOverride }: { forFlySuppression?: boolean; levelOverride?: string | null } = {}
): number {
  if (!token) return 0;
  const doc = token.document ?? token;
  const baseSrc = doc?._source ?? doc;
  const x = Number(baseSrc?.x ?? doc?.x ?? 0) || 0;
  const y = Number(baseSrc?.y ?? doc?.y ?? 0) || 0;
  const elev = Number.isFinite(Number(elevOverride)) ? Number(elevOverride) : _readTokenRawElevation(token);
  const level = levelOverride !== undefined ? levelOverride : (baseSrc?.level ?? doc?.level ?? null);

  const cache = token._ssSupportCache;
  if (
    cache &&
    cache.ver === _surfaceWorldVersion &&
    cache.level === level &&
    Math.abs(cache.x - x) < 0.5 &&
    Math.abs(cache.y - y) < 0.5 &&
    Math.abs(cache.elev - elev) < 0.05
  ) {
    if (forFlySuppression && cache.sourceType === 'token' && !cache.isLargePlatform) {
      return cache.sceneFloorElev;
    }
    return cache.floorElev;
  }

  const surf = resolveSupportingSurface(token, { x, y, elevation: elev, level });
  const floorElev = surf && Number.isFinite(Number(surf.elevation)) ? Number(surf.elevation) : -Infinity;
  let sceneFloorElev = floorElev;
  if (surf?.sourceType === 'token' && !surf.isLargePlatform) {
    // Preserve the non-token floor elevation in case a flyer hovers above an equal-sized token
    const tilesOrScene = resolveSupportingSurface(token, { x, y, elevation: elev, level }, null, { ignoreTokens: true });
    sceneFloorElev = tilesOrScene && Number.isFinite(Number(tilesOrScene.elevation))
      ? Number(tilesOrScene.elevation)
      : -Infinity;
  }

  if (typeof token === 'object') {
    token._ssSupportCache = {
      ver: _surfaceWorldVersion,
      x,
      y,
      elev,
      level,
      floorElev,
      sceneFloorElev,
      sourceType: surf?.sourceType ?? 'scene',
      sourceId: surf?.sourceId ?? null,
      isLargePlatform: Boolean(surf?.isLargePlatform)
    };
  }

  if (forFlySuppression && surf?.sourceType === 'token' && !surf.isLargePlatform) {
    return sceneFloorElev;
  }
  return floorElev;
}

/**
 * Check whether the token is supported by a solid surface at elevation `elev`
 * (at its current position or explicit `xOverride`, `yOverride`, `levelOverride` coordinates).
 * Returns `false` (airborne) if there is empty air beneath `elev` (`surface.elevation < elev - 0.05` or `surface === null`).
 */
function _isSupportedAtElevation(
  token: any,
  elev: number,
  xOverride?: number,
  yOverride?: number,
  levelOverride?: string | null
): boolean {
  const e = Number(elev);
  if (!Number.isFinite(e)) return false;
  const doc = token?.document ?? token;
  const basePos = doc?._source ?? doc;
  const px = Number.isFinite(Number(xOverride)) ? Number(xOverride) : Number(basePos?.x ?? doc?.x ?? 0);
  const py = Number.isFinite(Number(yOverride)) ? Number(yOverride) : Number(basePos?.y ?? doc?.y ?? 0);
  const lvl = levelOverride !== undefined ? levelOverride : (basePos?.level ?? doc?.level ?? null);
  const surf = resolveSupportingSurface(token, {
    ...basePos,
    x: px,
    y: py,
    elevation: e,
    level: lvl
  });
  if (!surf) return false;
  const surfElev = Number(surf.elevation);
  return Number.isFinite(surfElev) && surfElev >= e - 0.05;
}

/**
 * Pure logical check for whether a token is currently in active flight/hover mode
 * (used both by visual gating and by falling/jump classifiers so disabling visual flight
 * never causes a flying creature to trigger an upward jump or ground footsteps).
 */
function _isLogicalTokenInFlyMode(token: any, targetElevOverride?: number, levelOverride?: string | null): boolean {
  if (isTokenFalling(token)) return false;
  let elev = Number(targetElevOverride);
  if (!Number.isFinite(elev)) {
    const srcElev = Number(token?.document?._source?.elevation);
    const docElev = Number(token?.document?.elevation ?? token?.elevation ?? 0);
    elev = Number.isFinite(srcElev) ? srcElev : (Number.isFinite(docElev) ? docElev : 0);
  }
  const floorElev = getTokenSupportElevation(token, elev, { forFlySuppression: true, levelOverride });
  if (!(elev > floorElev + 0.05)) return false;
  const docAction = String(token?.document?.movementAction ?? token?.document?._source?.movementAction ?? '').trim();
  if (isFlyActionName(docAction)) return true;
  if ((!docAction || GROUND_DEFAULT_ACTION_RE.test(docAction)) && hasActorSheetFlySpeed(token)) {
    return true;
  }
  return false;
}

/**
 * Whether the token is currently in active flight/hover mode (`document.movementAction === 'fly' | 'hover'`
 * or has an actor-sheet fly speed `> 1` ft)
 * AND has clearance above its supporting surface (`elevation > floorElevation`, rather than standing on a level floor/tile/platform),
 * while NOT in the `Falling` state and when Flight & Hover animations are enabled.
 */
export function isTokenInFlyMode(token: any, targetElevOverride?: number, levelOverride?: string | null): boolean {
  return getTokenMovementSetting('fly') && _isLogicalTokenInFlyMode(token, targetElevOverride, levelOverride);
}

/* --------------------- Movement Segment Classification --------------------- */

function _isLogicalFallSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  if (!changes || (!('x' in changes) && !('y' in changes) && !('elevation' in changes))) return false;
  if (_isTeleportOperation(options, undefined, token?.document?.id) || options?.jump === true || options?.fly === true) return false;

  const srcElev = Number(token?.document?._source?.elevation);
  const docElev = Number.isFinite(srcElev) ? srcElev : (Number(token?.document?.elevation ?? token?.elevation ?? 0) || 0);
  const fromElev = Number.isFinite(Number(from?.elevation)) ? Number(from.elevation) : docElev;
  const toElev = Number.isFinite(Number(changes?.elevation)) ? Number(changes.elevation) : docElev;
  const dElev = toElev - fromElev;

  const x0 = Number(from?.x ?? token?.document?.x ?? 0);
  const y0 = Number(from?.y ?? token?.document?.y ?? 0);
  const x1 = Number(changes.x ?? x0);
  const y1 = Number(changes.y ?? y0);
  const distXY = Math.hypot(x1 - x0, y1 - y0);

  if (distXY < 4 && Math.abs(dElev) < 0.05) return false;

  const optAct = typeof options?.action === 'string' ? options.action.trim() : '';
  if (options?.fall === true || Number(options?.dnd5e?.fall?.distance) > 0) return true;
  if (optAct && !INPUT_METHOD_RE.test(optAct) && isFallActionName(optAct)) return true;

  if (isTokenFalling(token)) {
    // While the `Falling` status is active, any horizontal or vertical shift stays in the isolated falling state
    // (an already-falling token never plays a takeoff jump animation when raising or lowering elevation)
    return true;
  }
  return false;
}

/**
 * Determine whether a `Token#animate` movement segment represents a rapid fall (`Falling` / `action: 'fall'`).
 */
export function isFallAnimationSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  return getTokenMovementSetting('fall') && _isLogicalFallSegment(token, from, changes, options);
}

function _isLogicalJumpSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  if (!changes || (!('x' in changes) && !('y' in changes))) return false;
  const x0 = Number(from?.x ?? token?.document?.x ?? 0);
  const y0 = Number(from?.y ?? token?.document?.y ?? 0);
  const x1 = Number(changes.x ?? x0);
  const y1 = Number(changes.y ?? y0);
  if (Math.hypot(x1 - x0, y1 - y0) < 4) return false;

  if (options?.jump === true) return true;
  if (options?.jump === false || _isTeleportOperation(options, undefined, token?.document?.id) || options?.fly === true || options?.fall === true) return false;
  if (_isLogicalFallSegment(token, from, changes, options)) return false;

  const optAct = typeof options?.action === 'string' && !INPUT_METHOD_RE.test(options.action.trim())
    ? options.action.trim()
    : '';
  const docAction = String(token?.document?.movementAction ?? token?.document?._source?.movementAction ?? '').trim();
  if ((optAct && TELEPORT_ACTION_RE.test(optAct)) || (docAction && TELEPORT_ACTION_RE.test(docAction))) return false;
  if (optAct && isJumpActionName(optAct)) return true;
  if (!optAct && isJumpActionName(docAction)) return true;

  // Deliberate `climb` or transiting a `changeLevel` region (stairs/ladder) is never an automatic mid-air jump
  const activeAct = optAct || docAction;
  if (isClimbActionName(activeAct) || isTokenInLevelChangeRegion(token)) return false;

  // Automatic upward jump when elevation increases (`toElev > fromElev`) on the same level and the token ends up airborne
  // (not supported by a level floor/tile/platform/other token) outside of normal `fly` mode:
  if ('elevation' in changes) {
    const doc = token?.document ?? token;
    const origLvl = from?.level ?? doc?._source?.level ?? doc?.level ?? null;
    const destLvl = changes.level !== undefined ? changes.level : origLvl;
    if (changes.level !== undefined && destLvl !== origLvl) return false;

    const srcElev = Number(doc?._source?.elevation);
    const docElev = Number.isFinite(srcElev) ? srcElev : (Number(doc?.elevation ?? token?.elevation ?? 0) || 0);
    const fromElev = Number.isFinite(Number(from?.elevation)) ? Number(from.elevation) : docElev;
    const toElev = Number(changes.elevation);
    if (
      Number.isFinite(toElev) &&
      (toElev - fromElev) > 0.05 &&
      !isTokenFalling(token) &&
      !isTokenInLevelChangeRegion(token, { x: x1, y: y1, elevation: toElev, level: destLvl }) &&
      !_isLogicalFlySegment(token, from, changes, options) &&
      _isSupportedAtElevation(token, fromElev, x0, y0, origLvl) &&
      !_isSupportedAtElevation(token, toElev, x1, y1, destLvl)
    ) {
      return true;
    }
  }
  return false;
}

/** Determine whether a `Token#animate` movement segment represents a jump. */
export function isJumpAnimationSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  return getTokenMovementSetting('jump') && _isLogicalJumpSegment(token, from, changes, options);
}

function _isLogicalFlySegment(token: any, from: any, changes: any, options: any = {}): boolean {
  if (!changes || (!('x' in changes) && !('y' in changes) && !('elevation' in changes))) return false;
  if (_isLogicalFallSegment(token, from, changes, options)) return false;
  const x0 = Number(from?.x ?? token?.document?.x ?? 0);
  const y0 = Number(from?.y ?? token?.document?.y ?? 0);
  const x1 = Number(changes.x ?? x0);
  const y1 = Number(changes.y ?? y0);
  const distXY = Math.hypot(x1 - x0, y1 - y0);

  const doc = token?.document ?? token;
  const srcElev = Number(doc?._source?.elevation);
  const docElev = Number.isFinite(srcElev) ? srcElev : (Number(doc?.elevation ?? token?.elevation ?? 0) || 0);
  const fromElev = Number.isFinite(Number(from?.elevation)) ? Number(from.elevation) : docElev;
  const toElev = Number.isFinite(Number(changes?.elevation)) ? Number(changes.elevation) : docElev;
  const dElev = toElev - fromElev;

  if (distXY < 4 && Math.abs(dElev) < 0.05) return false;

  const origLvl = from?.level ?? doc?._source?.level ?? doc?.level ?? null;
  const destLvl = changes.level !== undefined ? changes.level : origLvl;

  // Check clearance above the supporting surface at both segment endpoints:
  // if the token is walking on solid footing along a scene level, tile, bridge, or platform (`clearance <= 0.05` at both ends),
  // treat it as regular grounded walking (`isWalkAnimationSegment`) rather than airborne flight!
  const startSurf = resolveSupportingSurface(token, { x: x0, y: y0, elevation: fromElev, level: origLvl });
  const endSurf = resolveSupportingSurface(token, { x: x1, y: y1, elevation: toElev, level: destLvl });
  const startFloor = startSurf && (startSurf.sourceType !== 'token' || startSurf.isLargePlatform)
    ? Number(startSurf.elevation)
    : (startSurf ? Number(resolveSupportingSurface(token, { x: x0, y: y0, elevation: fromElev, level: origLvl }, null, { ignoreTokens: true })?.elevation ?? -Infinity) : -Infinity);
  const endFloor = endSurf && (endSurf.sourceType !== 'token' || endSurf.isLargePlatform)
    ? Number(endSurf.elevation)
    : (endSurf ? Number(resolveSupportingSurface(token, { x: x1, y: y1, elevation: toElev, level: destLvl }, null, { ignoreTokens: true })?.elevation ?? -Infinity) : -Infinity);
  if ((fromElev - startFloor) <= 0.05 && (toElev - endFloor) <= 0.05) return false;

  if (options?.fly === true) return true;
  if (_isTeleportOperation(options, undefined, token?.document?.id) || options?.jump === true || options?.fall === true) return false;
  // Token was already hovering aloft and is descending smoothly to the ground (without the Falling status)
  if (dElev < -0.05 && (token?._ssHoverBlend ?? 0) > 0.05) {
    return true;
  }
  if (options?.action && typeof options.action === 'string' && !INPUT_METHOD_RE.test(options.action.trim())) {
    const optAct = options.action.trim();
    if (isFlyActionName(optAct)) return true;
    return GROUND_DEFAULT_ACTION_RE.test(optAct) && hasActorSheetFlySpeed(token);
  }
  const docAction = String(doc?.movementAction ?? doc?._source?.movementAction ?? '').trim();
  if (isFlyActionName(docAction)) return true;
  return (!docAction || GROUND_DEFAULT_ACTION_RE.test(docAction)) && hasActorSheetFlySpeed(token);
}

/**
 * Determine whether a `Token#animate` movement segment represents flight (`fly` / `hover`):
 *  - horizontal/diagonal flight while aloft above the supporting floor (`clearance > 0`, across both negative and positive levels);
 *  - vertical takeoff from a floor, altitude changes in mid-air, or a soft landing onto a floor.
 */
export function isFlyAnimationSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  return getTokenMovementSetting('fly') && _isLogicalFlySegment(token, from, changes, options);
}

function _isLogicalWalkSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  if (!changes || (!('x' in changes) && !('y' in changes))) return false;
  const x0 = Number(from?.x ?? token?.document?.x ?? 0);
  const y0 = Number(from?.y ?? token?.document?.y ?? 0);
  const x1 = Number(changes.x ?? x0);
  const y1 = Number(changes.y ?? y0);
  if (Math.hypot(x1 - x0, y1 - y0) < 4) return false;

  if (options?.walk === false || _isTeleportOperation(options, undefined, token?.document?.id) || options?.jump === true || options?.fly === true || options?.fall === true) return false;
  if (_isLogicalFallSegment(token, from, changes, options)) return false;
  const optAct = typeof options?.action === 'string' ? options.action.trim() : '';
  if (optAct && !INPUT_METHOD_RE.test(optAct)) {
    if (TELEPORT_ACTION_RE.test(optAct) || isFallActionName(optAct)) return false;
    try {
      const cfgAct = (globalThis as any).CONFIG?.Token?.movement?.actions?.[optAct];
      if (cfgAct?.teleport) return false;
    } catch { /* ignore */ }
  }
  const docAct = String(token?.document?.movementAction ?? token?.document?._source?.movementAction ?? '').trim();
  if (docAct && TELEPORT_ACTION_RE.test(docAct)) return false;

  if (_isLogicalJumpSegment(token, from, changes, options)) return false;
  if (_isLogicalFlySegment(token, from, changes, options)) return false;

  if (options?.walk === true) return true;
  if (optAct && !INPUT_METHOD_RE.test(optAct)) {
    if (isWalkActionName(optAct)) return true;
    // When on the ground (`elevation <= 0`), even `action === 'fly'` walks along the surface
    if (isFlyActionName(optAct)) return true;
  }
  if (!docAct || isWalkActionName(docAct) || isFlyActionName(docAct)) return true;
  return true;
}

/**
 * Determine whether a `Token#animate` movement segment represents grounded walking (`walk` / surface stride):
 *  - any horizontal/diagonal movement (`distXY >= 4`) that is not a jump (`jump`),
 *    airborne flight (`fly` at `elevation > 0`), a fall (`fall`), or a teleport (`blink` / `displace` / `teleport`);
 *  - also applies when a token with `movementAction: 'fly'` moves along the ground (`elevation === 0`).
 */
export function isWalkAnimationSegment(token: any, from: any, changes: any, options: any = {}): boolean {
  return getTokenMovementSetting('walk') && _isLogicalWalkSegment(token, from, changes, options);
}

/* --------------------- Sheet-Driven Speed & Duration Scaling --------------------- */

/**
 * Standard D&D 5e reference creature speed (`30` ft, or `6` five-foot grid cells).
 */
export const REFERENCE_ACTOR_SPEED_FT = 30;
export const REFERENCE_ACTOR_SPEED_CELLS = 6;

const _movementSpeedConfig = {
  /** Base animation speed for a 30-ft reference creature (in grid cells per second). */
  baseCellsPerSecond: 2.6,
  /** Exponent controlling how strongly sheet movement speed scales animation speed (`0` = uniform, `1` = linear). */
  sheetSpeedInfluence: 0.65
};

/**
 * Extract the token's movement speed from its actor sheet (`actor.system.attributes.movement`)
 * for the active movement mode (`walk`, `fly`, `swim`, `climb`, `burrow`, `crawl`),
 * converted to grid cells per round (where the `30 ft` reference equals `6 cells`).
 */
export function getActorSheetMovementCells(token: any, actionOverride?: string): number {
  const mov = token?.actor?.system?.attributes?.movement ?? token?.document?.actor?.system?.attributes?.movement;
  if (!mov) return REFERENCE_ACTOR_SPEED_CELLS;

  const rawAct = String(actionOverride ?? token?.document?.movementAction ?? token?.document?._source?.movementAction ?? 'walk')
    .trim()
    .toLowerCase();

  const speeds = mov.speeds ?? mov;
  let rawSpeed = 0;
  const srcElev = Number(token?.document?._source?.elevation);
  const docElev = Number(token?.document?.elevation ?? token?.elevation ?? 0);
  const curElev = Number.isFinite(srcElev) ? srcElev : (Number.isFinite(docElev) ? docElev : 0);
  const floorElev = getTokenSupportElevation(token, curElev, { forFlySuppression: true });
  const effectiveFly = FLY_ACTION_RE.test(rawAct)
    ? (curElev > floorElev + 0.05)
    : (curElev > floorElev + 0.05 && (!rawAct || GROUND_DEFAULT_ACTION_RE.test(rawAct)) && hasActorSheetFlySpeed(token));

  if (effectiveFly) {
    rawSpeed = Number(speeds.fly ?? mov.fly) || Number(speeds.walk ?? mov.walk) || Number(mov.max) || Number(mov.speed) || 0;
  } else if (/^swim$/i.test(rawAct)) {
    rawSpeed = Number(speeds.swim ?? mov.swim) || (Number(speeds.walk ?? mov.walk) * 0.5) || 0;
  } else if (/^climb$/i.test(rawAct)) {
    rawSpeed = Number(speeds.climb ?? mov.climb) || (Number(speeds.walk ?? mov.walk) * 0.5) || 0;
  } else if (/^burrow$/i.test(rawAct)) {
    rawSpeed = Number(speeds.burrow ?? mov.burrow) || (Number(speeds.walk ?? mov.walk) * 0.5) || 0;
  } else if (/^crawl$/i.test(rawAct)) {
    rawSpeed = (Number(speeds.walk ?? mov.walk) * 0.5) || 0;
  } else {
    rawSpeed = Number(speeds.walk ?? mov.walk) || Number(mov.speed) || Number(mov.max) || 0;
  }

  if (!(rawSpeed > 0)) return REFERENCE_ACTOR_SPEED_CELLS;

  const sceneDist = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
  const units = String(mov.units ?? (globalThis as any).canvas?.scene?.grid?.units ?? 'ft').trim().toLowerCase();

  // On a standard 5-ft (or 1.5-m) scene grid, convert sheet feet/meters into grid cells;
  // otherwise compare directly against the 30 ft = 6 cells reference
  let cellsPerRound: number;
  if (sceneDist > 0 && ((units.startsWith('ft') && sceneDist <= 10) || (units.startsWith('m') && sceneDist <= 3))) {
    cellsPerRound = rawSpeed / sceneDist;
  } else {
    cellsPerRound = (rawSpeed / REFERENCE_ACTOR_SPEED_FT) * REFERENCE_ACTOR_SPEED_CELLS;
  }

  return Math.max(1, Math.min(24, cellsPerRound));
}

/**
 * Compute the token's relative animation speed factor (`speedFactor`) from its actor sheet:
 *  - returns `1.0` for a standard `30 ft` (`6 cells`) character;
 *  - returns `~1.38..1.55` for fast creatures (`50 ft` such as a Hell Hound, or `60 ft`) so they move noticeably swifter;
 *  - returns `~0.64..0.77` for slow creatures (`15..20 ft`) so they feel heavier and more deliberate;
 *  - the `sheetSpeedInfluence = 0.65` exponent keeps animations readable even at extreme speeds (`80+ ft` or `10 ft`).
 */
export function resolveTokenSpeedFactor(token?: any, actionOverride?: string): number {
  if (!token) return 1.0;
  const actorCells = getActorSheetMovementCells(token, actionOverride);
  const ratio = Math.max(0.25, Math.min(3.5, actorCells / REFERENCE_ACTOR_SPEED_CELLS));
  const sheetFactor = Math.pow(ratio, _movementSpeedConfig.sheetSpeedInfluence);
  return Math.max(0.25, Math.min(4.0, sheetFactor));
}

/**
 * Compute token movement animation speed (in grid cells per second) for `Token#_getAnimationMovementSpeed`:
 * replaces Foundry's fixed `CONFIG.Token.movement.defaultSpeed = 6` constant with a controlled speed
 * scaled from the character's sheet movement speed.
 */
export function computeTokenAnimationSpeed(token?: any, options: any = {}): number {
  if (Number.isFinite(Number(options?.movementSpeed)) && Number(options.movementSpeed) > 0) {
    return Number(options.movementSpeed);
  }
  const act = typeof options?.action === 'string' ? options.action : undefined;
  const factor = resolveTokenSpeedFactor(token, act);
  return Math.max(0.6, Math.min(14, (1000 / 310) * factor));
}

/**
 * Compute jump animation duration (ms) from `distPx`, `gridSize`, and token speed:
 *  - fixed takeoff-crouch and landing-settle phases (`160 ms`) + strictly constant airborne cruise speed (`~195 ms` per cell at 30 ft),
 *    keeping mid-air travel speed consistent across any jump distance;
 *  - scaled by the character's movement speed (`token` / `speedFactor`) and the global speed multiplier.
 */
export function computeJumpDurationMs(
  distPx: number,
  gridSize = 100,
  explicitDuration?: number,
  { token = null, speedFactor }: { token?: any; speedFactor?: number } = {}
): number {
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) return explicitDuration;
  const g = Math.max(20, Number(gridSize) || 100);
  const dist = Math.max(0, Number(distPx) || 0);
  if (dist < 4) return 0;
  const cells = dist / g;
  const factor = Number.isFinite(Number(speedFactor)) && Number(speedFactor) > 0
    ? Number(speedFactor)
    : resolveTokenSpeedFactor(token, 'jump');
  const ms = (160 + cells * 195) / factor;
  return Math.max(120, Math.min(30000, Math.round(ms)));
}

/**
 * Compute flight animation duration (ms) from `distPx`, `gridSize`, and actor-sheet fly speed:
 *  - strictly linear in distance (`320 ms` per cell at the 30-ft reference):
 *    pixel/cell velocity per second stays completely constant regardless of distance (1, 5, or 20 cells)
 *    and matches identically between mouse drag and WASD movement.
 */
export function computeFlyDurationMs(
  distPx: number,
  gridSize = 100,
  explicitDuration?: number,
  { token = null, speedFactor }: { keyboard?: boolean; token?: any; speedFactor?: number } = {}
): number {
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) return explicitDuration;
  const g = Math.max(20, Number(gridSize) || 100);
  const dist = Math.max(0, Number(distPx) || 0);
  if (dist < 4) return 0;
  const cells = dist / g;
  const factor = Number.isFinite(Number(speedFactor)) && Number(speedFactor) > 0
    ? Number(speedFactor)
    : resolveTokenSpeedFactor(token, 'fly');
  const ms = (cells * 320) / factor;
  return Math.max(40, Math.min(60000, Math.round(ms)));
}

/**
 * Compute grounded walk animation duration (`walk`, ms) from `distPx`, `gridSize`,
 * and actor-sheet walk speed (`actor.system.attributes.movement`):
 *  - strictly linear in distance (`310 ms` per cell at the 30-ft reference):
 *    pixel/cell velocity per second stays completely constant regardless of distance (1, 5, or 20 cells)
 *    and matches identically between mouse drag and WASD movement.
 */
export function computeWalkDurationMs(
  distPx: number,
  gridSize = 100,
  explicitDuration?: number,
  { token = null, action = 'walk', speedFactor }: { keyboard?: boolean; token?: any; action?: string; speedFactor?: number } = {}
): number {
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) return explicitDuration;
  const g = Math.max(20, Number(gridSize) || 100);
  const dist = Math.max(0, Number(distPx) || 0);
  if (dist < 4) return 0;
  const cells = dist / g;
  const factor = Number.isFinite(Number(speedFactor)) && Number(speedFactor) > 0
    ? Number(speedFactor)
    : resolveTokenSpeedFactor(token, action);
  const ms = (cells * 310) / factor;
  return Math.max(40, Math.min(60000, Math.round(ms)));
}

/**
 * Compute fall-and-impact animation duration (`Falling`, ms) from `dropElevation`
 * (in scene elevation units, typically feet) and `gridDistance` (typically 5 ft):
 *  - gravitational free-fall time scales with the square root of drop height ($\sqrt{h}$) + a heavy ground-impact and elastic settle phase (`~340 ms`);
 *  - takes `~580 ms` from 10 ft (`2 cells`), `~720 ms` from 30 ft (`6 cells`), `~860 ms` from 60 ft (`12 cells`), and `~1050 ms` from 120 ft.
 */
export function computeFallDurationMs(
  dropElevation = 30,
  gridDistance = 5,
  explicitDuration?: number
): number {
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) return explicitDuration;
  const gDist = Math.max(0.5, Number(gridDistance) || 5);
  const drop = Math.max(gDist, Math.abs(Number(dropElevation) || 0));
  const cells = Math.max(1, drop / gDist);
  const freeFallMs = 210 + Math.sqrt(cells) * 145;
  const impactSettleMs = 340;
  return Math.max(480, Math.min(2200, Math.round(freeFallMs + impactSettleMs)));
}

/**
 * Compute in-place vertical upward jump duration (`_ssAirJump`, ms) when gaining elevation into mid-air:
 *  - from solid support (`startedGrounded = true`): crouch phase (~85 ms) + ballistic ascent + apex hang-time (~535 ms at +5 ft, ~595 ms at +10 ft);
 *  - mid-air boost (`startedGrounded = false`): brisk upward hop (~445 ms at +5 ft).
 */
export function computeAirJumpDurationMs(
  riseElevation = 5,
  gridDistance = 5,
  explicitDuration?: number,
  { token = null, startedGrounded = true }: { token?: any; startedGrounded?: boolean } = {}
): number {
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) return explicitDuration;
  const gDist = Math.max(0.5, Number(gridDistance) || 5);
  const rise = Math.max(gDist, Math.abs(Number(riseElevation) || 0));
  const cells = Math.max(1, rise / gDist);
  const factor = Math.max(0.5, Math.min(2.0, resolveTokenSpeedFactor(token, 'jump')));
  const baseMs = startedGrounded ? 390 : 300;
  const climbMs = Math.sqrt(cells) * 145;
  return Math.max(360, Math.min(1400, Math.round((baseMs + climbMs) / Math.pow(factor, 0.35))));
}

const MOVE_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const _rawHeldMoveCodes = new Set<string>();
let _keyboardListenersInstalled = false;
let _lastMoveKeyReleaseMs = 0;
let _wasdRepeatTimer: any = null;
let _wasdFirstStepTimer: any = null;
let _lastWasdDispatchMs = 0;
let _wasdMoveManyInFlight = false;
let _coreMoveKeybindsPatched = false;

const DEFAULT_MOVE_KEY_CODES = new Set<string>([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9'
]);

const DEFAULT_CODE_TO_DIRS: Record<string, string[]> = {
  KeyW: ['up'],
  KeyA: ['left'],
  KeyS: ['down'],
  KeyD: ['right']
};

function _getConfiguredDirsForCode(code: string): string[] {
  if (!code) return [];
  const dirs: string[] = [];
  try {
    const actions = (globalThis as any).game?.keybindings?.actions;
    const bindings = (globalThis as any).game?.keybindings?.bindings;
    const actionMap: Array<[string, string[]]> = [
      ['core.moveUp', ['up']],
      ['core.moveDown', ['down']],
      ['core.moveLeft', ['left']],
      ['core.moveRight', ['right']],
      ['core.moveUpLeft', ['up', 'left']],
      ['core.moveUpRight', ['up', 'right']],
      ['core.moveDownLeft', ['down', 'left']],
      ['core.moveDownRight', ['down', 'right']],
      ['core.movementUp', ['up']],
      ['core.movementDown', ['down']],
      ['core.movementLeft', ['left']],
      ['core.movementRight', ['right']]
    ];
    for (const [id, mapped] of actionMap) {
      const list = bindings?.get?.(id) ?? actions?.get?.(id)?.editable ?? [];
      if (Array.isArray(list) && list.some((b: any) => b?.key === code)) {
        for (const d of mapped) {
          if (!dirs.includes(d)) dirs.push(d);
        }
      }
    }
  } catch { /* ignore */ }
  if (dirs.length === 0 && DEFAULT_CODE_TO_DIRS[code]) {
    return DEFAULT_CODE_TO_DIRS[code];
  }
  return dirs;
}

function _isConfiguredMoveKeyCode(code: string): boolean {
  if (!code) return false;
  if (_getConfiguredDirsForCode(code).length > 0) return true;
  if (DEFAULT_MOVE_KEY_CODES.has(code)) return true;
  return false;
}

/* --------------------- Responsive WASD Input Pump --------------------- */

/**
 * Compute the current movement direction vector `(dx, dy)` from physically held WASD keys and `game.keyboard.moveKeys`.
 */
export function getActiveMoveDirectionVector(): { dx: number; dy: number } {
  const activeDirs = new Set<string>();
  try {
    const moveKeys = (globalThis as any).game?.keyboard?.moveKeys;
    if (moveKeys && typeof moveKeys.size === 'number') {
      for (const dir of MOVE_DIRECTIONS) {
        if (moveKeys.has(dir)) activeDirs.add(dir);
      }
    }
  } catch { /* ignore */ }
  for (const code of _rawHeldMoveCodes) {
    for (const d of _getConfiguredDirsForCode(code)) activeDirs.add(d);
  }
  let dx = 0;
  let dy = 0;
  if (activeDirs.has('left')) dx -= 1;
  if (activeDirs.has('right')) dx += 1;
  if (activeDirs.has('up')) dy -= 1;
  if (activeDirs.has('down')) dy += 1;
  return { dx, dy };
}

function _stopWasdRepeatPump() {
  if (_wasdRepeatTimer !== null) {
    clearInterval(_wasdRepeatTimer);
    _wasdRepeatTimer = null;
  }
  if (_wasdFirstStepTimer !== null) {
    clearTimeout(_wasdFirstStepTimer);
    _wasdFirstStepTimer = null;
  }
}

function _hasActiveRegionFloorTransition(region: any): boolean {
  const behaviors = region?.behaviors;
  if (!behaviors) return false;
  for (const behavior of behaviors) {
    if (behavior?.disabled) continue;
    const t = behavior?.type;
    if (t === 'teleportToken' || t === 'changeLevel') return true;
  }
  return false;
}

function _isTokenBlockedByRegionTransition(tok: any): boolean {
  if (!tok) return false;
  try {
    const doc = tok.document ?? tok;
    if (doc?.movement?.state === 'paused') return true;
    if (doc?.movement?.method === 'api' && (tok._ssActiveMoveAnim || tok.movementAnimationPromise)) {
      return true;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const lockUntil = Number(tok._ssRegionTransitionUntil) || 0;
    if (lockUntil > 0) {
      if (tok._ssActiveMoveAnim || tok.movementAnimationPromise || now < lockUntil) return true;
      tok._ssRegionTransitionUntil = 0;
    }
    const regions = doc?.regions;
    const instances = (globalThis as any).foundry?.applications?.instances;
    if (regions && instances && typeof instances.has === 'function' && doc?.id) {
      for (const region of regions) {
        const behaviors = region?.behaviors;
        if (!behaviors) continue;
        for (const behavior of behaviors) {
          if (behavior?.disabled) continue;
          if (behavior?.type !== 'teleportToken' && behavior?.type !== 'changeLevel') continue;
          if (behavior.uuid && instances.has(`dialog-${behavior.uuid}-${doc.id}`)) {
            return true;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Check whether a token is ready to accept the next WASD step:
 *  - for an explicit single tap (`isExplicitTap = true`), allow chaining/redirecting much earlier (`u >= 0.35`)
 *    so rapid key taps are never dropped;
 *  - for held-key auto-repeat (`isExplicitTap = false`), feed the next step at `u >= 0.76`
 *    so it arrives right as the current cell finishes without queuing extra steps after key release.
 */
function _isTokenReadyForNextWasdStep(tok: any, isExplicitTap = false): boolean {
  if (!tok) return false;
  if (_isTokenBlockedByRegionTransition(tok)) return false;
  if (!isExplicitTap && tok._preventKeyboardMovement) return false;
  const hasTrackU = tok._ssMoveTrackU !== undefined && tok._ssMoveTrackU !== null;
  if (!tok._ssActiveMoveAnim && !hasTrackU) return true;
  const u = hasTrackU ? Number(tok._ssMoveTrackU) : Number(tok._ssJumpState?.u ?? 1);
  return u >= (isExplicitTap ? 0.35 : 0.76);
}

/**
 * Dispatch a single movement step for controlled tokens along the currently held WASD direction vector.
 */
function _dispatchWasdStepNow(explicitDirs?: string[], isExplicitTap = false): boolean {
  if (_wasdMoveManyInFlight && !isExplicitTap) return false;
  try {
    const g = (globalThis as any).game;
    const c = (globalThis as any).canvas;
    if (!c?.ready || g?.keyboard?.hasFocus) return false;
    const layer = c.activeLayer;
    if (!layer || !layer.options?.keyboardMovableObjects || typeof layer.moveMany !== 'function') return false;
    if (c.controls?.ruler?.active || layer._draggedToken) return false;

    let { dx, dy } = getActiveMoveDirectionVector();
    if (!dx && !dy && Array.isArray(explicitDirs) && explicitDirs.length > 0) {
      if (explicitDirs.includes('left')) dx -= 1;
      if (explicitDirs.includes('right')) dx += 1;
      if (explicitDirs.includes('up')) dy -= 1;
      if (explicitDirs.includes('down')) dy += 1;
    }
    if (!dx && !dy) return false;

    const controlled = Array.isArray(layer.controlled) ? layer.controlled : [];
    if (!controlled.length) return false;
    if (!controlled.some((t: any) => _isTokenReadyForNextWasdStep(t, isExplicitTap))) return false;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const sampleTok = controlled[0];
    const grid = c?.dimensions?.size ?? c?.grid?.size ?? 100;
    const stepDur = isTokenInFlyMode(sampleTok)
      ? computeFlyDurationMs(grid, grid, undefined, { token: sampleTok, keyboard: true })
      : computeWalkDurationMs(grid, grid, undefined, { token: sampleTok, keyboard: true });
    // Minimal debounce for explicit taps (55 ms), or 65% of single-cell duration for held auto-repeat
    const minInterval = isExplicitTap ? 55 : Math.max(110, Math.round(stepDur * 0.65));
    if (_lastWasdDispatchMs > 0 && (now - _lastWasdDispatchMs) < minInterval) return false;

    if (isExplicitTap) {
      for (const t of controlled) {
        if (t && !_isTokenBlockedByRegionTransition(t)) {
          t._preventKeyboardMovement = false;
        }
      }
    }

    // Synchronize `game.keyboard.moveKeys` so core Foundry sees the active movement directions
    const moveKeys = g?.keyboard?.moveKeys;
    if (moveKeys && typeof moveKeys.add === 'function') {
      if (dx < 0) moveKeys.add('left'); else moveKeys.delete?.('left');
      if (dx > 0) moveKeys.add('right'); else moveKeys.delete?.('right');
      if (dy < 0) moveKeys.add('up'); else moveKeys.delete?.('up');
      if (dy > 0) moveKeys.add('down'); else moveKeys.delete?.('down');
    }

    const isShift = Boolean(g?.keyboard?.isModifierActive?.('Shift'));
    _lastWasdDispatchMs = now;
    _wasdMoveManyInFlight = true;
    Promise.resolve(layer.moveMany({ dx, dy, dz: 0, rotate: isShift }))
      .catch(() => {})
      .finally(() => {
        _wasdMoveManyInFlight = false;
      });
    return true;
  } catch {
    _wasdMoveManyInFlight = false;
    return false;
  }
}

/**
 * Continuous high-responsiveness WASD hold pump (bypasses the OS 500 ms key-repeat delay
 * and avoids queuing extra steps after key release).
 */
function _tickWasdRepeatPump() {
  if (!isMoveKeyHeld()) {
    _stopWasdRepeatPump();
    return;
  }
  _dispatchWasdStepNow();
}

function _ensureWasdRepeatPump() {
  if (_wasdRepeatTimer !== null || typeof setInterval !== 'function') return;
  _wasdRepeatTimer = setInterval(_tickWasdRepeatPump, 20);
}

/**
 * Wrap core `core.moveUp` / `core.moveDown` / `core.moveLeft` / `core.moveRight` handlers in `game.keybindings.activeKeys`
 * to replace Foundry v14's built-in `setTimeout(..., 50)` per-keypress delay with `12 ms`
 * (wide enough to coalesce simultaneous `W+D` diagonal presses while being 4x more responsive).
 */
function _patchCoreMoveKeybindings() {
  if (_coreMoveKeybindsPatched) return;
  try {
    const activeKeys = (globalThis as any).game?.keybindings?.activeKeys;
    if (!activeKeys || typeof activeKeys.values !== 'function') return;
    const moveActionDirs: Record<string, string[]> = {
      'core.moveUp': ['up'],
      'core.moveDown': ['down'],
      'core.moveLeft': ['left'],
      'core.moveRight': ['right'],
      'core.moveUpLeft': ['up', 'left'],
      'core.moveUpRight': ['up', 'right'],
      'core.moveDownLeft': ['down', 'left'],
      'core.moveDownRight': ['down', 'right']
    };
    let patchedCount = 0;
    for (const actionList of activeKeys.values()) {
      if (!Array.isArray(actionList)) continue;
      for (const entry of actionList) {
        const dirs = moveActionDirs[entry?.action];
        if (!dirs || entry._ssFastMovePatched) continue;
        const origOnDown = entry.onDown;
        const origOnUp = entry.onUp;
        entry._ssFastMovePatched = true;
        entry.onDown = (context: any) => {
          const g = (globalThis as any).game;
          const c = (globalThis as any).canvas;
          if (g?.foundry?.nue?.Tour?.tourInProgress || !c?.ready) {
            return typeof origOnDown === 'function' ? origOnDown(context) : false;
          }
          const layer = c.activeLayer;
          if (!layer?.options?.keyboardMovableObjects || c.controls?.ruler?.active || layer._draggedToken) {
            return typeof origOnDown === 'function' ? origOnDown(context) : false;
          }
          const moveKeys = g?.keyboard?.moveKeys;
          if (moveKeys && typeof moveKeys.add === 'function') {
            for (const d of dirs) moveKeys.add(d);
          }
          // OS auto-repeat events (`context.repeat`) are driven entirely by our smooth `_tickWasdRepeatPump`
          if (context?.repeat) {
            _ensureWasdRepeatPump();
            return true;
          }
          // Initial keypress: wait just 12 ms to coalesce diagonals (e.g. W+D) instead of core Foundry's 50 ms
          if (_wasdFirstStepTimer === null) {
            _wasdFirstStepTimer = setTimeout(() => {
              _wasdFirstStepTimer = null;
              _dispatchWasdStepNow(dirs, true);
            }, 12);
          }
          _ensureWasdRepeatPump();
          return true;
        };
        entry.onUp = (context: any) => {
          const moveKeys = (globalThis as any).game?.keyboard?.moveKeys;
          if (moveKeys && typeof moveKeys.delete === 'function') {
            for (const d of dirs) moveKeys.delete(d);
          }
          return typeof origOnUp === 'function' ? origOnUp(context) : true;
        };
        patchedCount++;
      }
    }
    if (patchedCount > 0) _coreMoveKeybindsPatched = true;
  } catch { /* ignore */ }
}

function _installMoveKeyListeners() {
  _patchCoreMoveKeybindings();
  if (_keyboardListenersInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  _keyboardListenersInstalled = true;
  window.addEventListener('keydown', (ev: any) => {
    const tag = String(ev?.target?.tagName ?? '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev?.target?.isContentEditable) return;
    const code = String(ev?.code ?? '');
    if (_isConfiguredMoveKeyCode(code)) {
      _patchCoreMoveKeybindings();
      const wasEmpty = _rawHeldMoveCodes.size === 0;
      _rawHeldMoveCodes.add(code);
      if (wasEmpty && !ev?.repeat && !_coreMoveKeybindsPatched) {
        _lastWasdDispatchMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
      _ensureWasdRepeatPump();
    }
  }, { capture: true, passive: true });

  window.addEventListener('keyup', (ev: any) => {
    const code = String(ev?.code ?? '');
    if (_rawHeldMoveCodes.delete(code)) {
      const moveKeys = (globalThis as any).game?.keyboard?.moveKeys;
      if (moveKeys && typeof moveKeys.delete === 'function') {
        for (const d of _getConfiguredDirsForCode(code)) moveKeys.delete(d);
      }
      if (_rawHeldMoveCodes.size === 0) {
        _lastMoveKeyReleaseMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        _stopWasdRepeatPump();
      }
    }
  }, { capture: true, passive: true });

  window.addEventListener('blur', () => {
    if (_rawHeldMoveCodes.size > 0) {
      _rawHeldMoveCodes.clear();
      _lastMoveKeyReleaseMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
    _stopWasdRepeatPump();
  }, { passive: true });
}

/**
 * Check whether the user is currently holding any movement keys (WASD / arrow keys).
 * Inspects both Foundry v14's `game.keyboard.moveKeys` and our own capture-phase `keydown`/`keyup` listeners.
 */
export function isMoveKeyHeld(): boolean {
  try {
    const moveKeys = (globalThis as any).game?.keyboard?.moveKeys;
    if (moveKeys && typeof moveKeys.size === 'number') {
      for (const dir of MOVE_DIRECTIONS) {
        if (moveKeys.has(dir)) return true;
      }
    }
    const downKeys = (globalThis as any).game?.keyboard?.downKeys;
    if (downKeys && typeof downKeys.size === 'number' && downKeys.size > 0) {
      for (const code of downKeys) {
        if (_isConfiguredMoveKeyCode(String(code))) return true;
      }
    }
  } catch { /* ignore */ }
  return _rawHeldMoveCodes.size > 0;
}

/** Check whether a movement operation originated from keyboard input (WASD / arrow keys). */
export function isKeyboardMovement(token: any, options: any = {}): boolean {
  if (options?.keyboard === true || /^keyboard$/i.test(String(options?.method ?? ''))) return true;
  const docMethod = token?.document?.movement?.method ?? token?.document?._source?.movement?.method;
  if (/^keyboard$/i.test(String(docMethod ?? ''))) return true;
  if (isMoveKeyHeld()) return true;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (_lastMoveKeyReleaseMs > 0 && (now - _lastMoveKeyReleaseMs) < 180) return true;
  return false;
}

/**
 * Smooth calibrated progress curve `p(u)` over `u ∈ [0..1]` with boundary velocities `v0` (at `u = 0`), `v1` (at `u = 1`),
 * and path length in grid cells `cells`:
 *  - `v0 = 0, v1 = 0`: C²-smoothed trapezoidal velocity profile where ease-in and ease-out ramps
 *    span a fixed physical distance (`rampCells`, ~0.22–0.32 cells at start and end)
 *    while the main cruise segment runs at nearly constant velocity (`dp/du ≈ 1`),
 *    avoiding the 1.77x mid-drag speed spike of a naive ease-in-out curve;
 *  - `v0 = 0, v1 = 1`: smooth acceleration from rest up to cruise velocity `1.0` by the end of the cell (first WASD step);
 *  - `v0 = 1, v1 = 1`: seamless constant-speed glide (`p(u) === u`, `paceOffset === 0`) while WASD remains held;
 *  - `v0 = 1, v1 = 0`: smooth inertial deceleration from `1.0` to a full stop when WASD is released.
 */
function _hermiteProgress(u: number, v0: number, v1: number, cells = 1, rampCells = 0.28): number {
  const s0 = Math.max(0, Math.min(1.6, Number(v0) || 0));
  const s1 = Math.max(0, Math.min(1.6, Number(v1) || 0));
  if (s0 < 1e-4 && s1 < 1e-4) {
    const c = Math.max(0.5, Number(cells) || 1);
    const r = Math.max(0.02, Math.min(0.32, rampCells / c));
    const vCruise = 1 / (1 - r);
    if (u <= r) {
      const t = u / r;
      const t3 = t * t * t;
      const t4 = t3 * t;
      return r * vCruise * (t3 - 0.5 * t4);
    }
    if (u >= 1 - r) {
      const w = (1 - u) / r;
      const w3 = w * w * w;
      const w4 = w3 * w;
      return 1 - r * vCruise * (w3 - 0.5 * w4);
    }
    return vCruise * (u - 0.5 * r);
  }
  if (Math.abs(s0 - 1) < 1e-4 && Math.abs(s1 - 1) < 1e-4) {
    return u;
  }
  // Instant first-frame response on the initial WASD step (`v0 < 0.35, v1 >= 0.8`):
  // launch with a brisk initial slope (`minStart = 0.42`) instead of a zero Hermite derivative
  // so the token visibly moves on the very first frame after pressing a key
  const effS0 = (s0 < 0.42 && s1 >= 0.8) ? 0.42 : s0;
  const u2 = u * u;
  const u3 = u2 * u;
  // h10(u)*v0 + h01(u)*1 + h11(u)*v1
  const h = (u3 - 2 * u2 + u) * effS0 + (-2 * u3 + 3 * u2) + (u3 - u2) * s1;
  return Math.max(0, Math.min(1, h));
}

/** Derivative `dp/du` of the calibrated progress curve at `u ∈ [0..1]`. */
function _hermiteVelocity(u: number, v0: number, v1: number, cells = 1, rampCells = 0.28): number {
  const s0 = Math.max(0, Math.min(1.6, Number(v0) || 0));
  const s1 = Math.max(0, Math.min(1.6, Number(v1) || 0));
  if (s0 < 1e-4 && s1 < 1e-4) {
    const c = Math.max(0.5, Number(cells) || 1);
    const r = Math.max(0.02, Math.min(0.32, rampCells / c));
    const vCruise = 1 / (1 - r);
    if (u <= r) {
      const t = u / r;
      return vCruise * (3 * t * t - 2 * t * t * t);
    }
    if (u >= 1 - r) {
      const w = (1 - u) / r;
      return vCruise * (3 * w * w - 2 * w * w * w);
    }
    return vCruise;
  }
  if (Math.abs(s0 - 1) < 1e-4 && Math.abs(s1 - 1) < 1e-4) {
    return 1;
  }
  const effS0 = (s0 < 0.42 && s1 >= 0.8) ? 0.42 : s0;
  const u2 = u * u;
  return (3 * u2 - 4 * u + 1) * effS0 + (-6 * u2 + 6 * u) + (3 * u2 - 2 * u) * s1;
}

export interface JumpFrameState {
  u: number;
  flightProgress: number;
  arcFactor: number;
  paceOffsetX: number;
  paceOffsetY: number;
  offsetX: number;
  offsetY: number;
  steadyLiftY?: number;
  steadyCenterY?: number;
  steadyScale?: number;
  scaleX: number;
  scaleY: number;
  tiltAngle: number;
  shadowScale: number;
  shadowAlpha: number;
}

/* --------------------- Frame Curves: Jump, Air-Jump, Fly, Hover, Fall & Walk --------------------- */

/**
 * Pure frame evaluator for a jump arc (`u` ∈ [0..1]).
 * Returns:
 *  - `flightProgress` — ground-line travel progress (accounting for launch crouch hold and landing lock);
 *  - `paceOffsetX`, `paceOffsetY` — correction relative to core's linearly interpolated `token.center` to anchor start/end;
 *  - `offsetX`, `offsetY` — combined mesh offset (ground pacing + parabolic jump arc);
 *  - `scaleX`, `scaleY` — C²-smooth Squash & Stretch + airborne perspective growth;
 *  - `tiltAngle` — smooth body pitch/lean;
 *  - `shadowScale`, `shadowAlpha` — ground shadow scale and opacity.
 */
export function computeJumpFrame(
  uRaw: number,
  {
    dx = 100,
    dy = 0,
    gridSize = 100,
    tokenSize = 100,
    endInAir = false,
    endInFalling = false
  }: {
    dx?: number;
    dy?: number;
    gridSize?: number;
    tokenSize?: number;
    endInAir?: boolean;
    endInFalling?: boolean;
  } = {}
): JumpFrameState {
  const u = Math.max(0, Math.min(1, Number(uRaw) || 0));
  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const endAirLift = endInAir && endInFalling ? Math.min(g * 0.23, tsize * 0.20) : 0;

  if (u <= 0 || u >= 1) {
    const isEnd = u >= 1;
    const endFall = isEnd && endInAir && endInFalling;
    return {
      u,
      flightProgress: isEnd ? 1 : 0,
      arcFactor: endFall ? 0.55 : 0,
      paceOffsetX: 0,
      paceOffsetY: 0,
      offsetX: 0,
      offsetY: endFall ? -endAirLift : 0,
      steadyLiftY: endFall ? -(endAirLift + tsize * 0.035) : undefined,
      steadyCenterY: endFall ? -endAirLift : undefined,
      steadyScale: endFall ? 1 : undefined,
      scaleX: endFall ? (1 - 0.056 * 0.65) : 1,
      scaleY: endFall ? (1 + 0.056) : 1,
      tiltAngle: 0,
      shadowScale: endFall ? 0.76 : 1,
      shadowAlpha: endFall ? 0.26 : 0
    };
  }

  const dist = Math.hypot(dx, dy);

  // 1) Non-linear horizontal `flightProgress` and airborne phase `w ∈ [0..1]`
  let w = 0;
  let flightProgress = 0;
  const landT = endInAir ? 0.94 : JUMP_LAND_T;
  if (u <= JUMP_LAUNCH_T) {
    // During the anticipation crouch the token stays nearly anchored at takeoff, leaning forward up to 2.5% of the path
    const p = _smootherstep(u / JUMP_LAUNCH_T);
    flightProgress = 0.025 * p;
    w = 0;
  } else if (u < landT) {
    // While airborne: energetic push-off, smooth glide over the apex, and arrival at the landing point
    w = (u - JUMP_LAUNCH_T) / (landT - JUMP_LAUNCH_T);
    const smoothW = _smootherstep(w);
    const impulseW = 1 - Math.pow(1 - w, 1.45);
    const airProgress = 0.58 * smoothW + 0.42 * impulseW;
    flightProgress = 0.025 + 0.975 * airProgress;
  } else {
    w = 1;
    flightProgress = 1;
  }

  // Offset relative to core Foundry's linearly interpolated `token.center`
  const paceDelta = flightProgress - u;
  const paceOffsetX = dx * paceDelta;
  const paceOffsetY = dy * paceDelta;

  // 2) Parabolic flight arc
  let arcFactor = 0;
  if (w > 0 && w < 1) {
    const parabola = 4 * w * (1 - w);
    const envelope = Math.sin(w * Math.PI);
    arcFactor = Math.pow(parabola, 0.82) * (0.85 + 0.15 * envelope);
  }

  const arcHeight = Math.min(
    Math.max(g * 0.44, tsize * 0.36, dist * 0.32),
    Math.max(g * 1.55, tsize * 1.25)
  );

  const horizRatio = dist > 1 ? Math.abs(dx) / dist : 1;
  const vertRatio = dist > 1 ? Math.abs(dy) / dist : 0;
  const airHoldBlend = endInAir ? _smootherstep(Math.max(0, Math.min(1, (u - 0.52) / 0.48))) : 0;
  const arcLiftY = -arcHeight * arcFactor * (1 - vertRatio * 0.20) - endAirLift * airHoldBlend;
  const sideSign = dx >= 0 ? 1 : -1;
  const arcLiftX = -sideSign * arcHeight * 0.25 * arcFactor * (1 - horizRatio);

  const offsetX = paceOffsetX + arcLiftX;
  const offsetY = paceOffsetY + arcLiftY;

  // 3) C²-smooth Squash & Stretch + airborne altitude perspective scale
  //    (when a jump ends in mid-air `endInAir = true`, settle weightlessly at the apex instead of slamming into an invisible floor)
  const peakBoost = Math.min(0.32, Math.max(0.18, 0.15 + (dist / (g * 4.8)) * 0.15));
  const airScaleX = 1 + peakBoost;
  const airScaleY = (1 + peakBoost) * 1.04;
  const finalScaleX = endInAir && endInFalling ? (1 - 0.056 * 0.65) : 1.00;
  const finalScaleY = endInAir && endInFalling ? (1 + 0.056) : 1.00;

  const scaleX = endInAir
    ? _evalKeyframes(u, [
        [0.00, 1.00],
        [0.08, 1.13],
        [0.19, 0.91],
        [0.52, airScaleX],
        [0.82, 0.97],
        [1.00, finalScaleX]
      ])
    : _evalKeyframes(u, [
        [0.00, 1.00],
        [0.08, 1.13],                      // deep pre-jump crouch (squash)
        [0.19, 0.91],                      // upward takeoff stretch
        [0.48, airScaleX],                 // arc apex — closest perspective approach to camera
        [0.77, 0.93],                      // pre-touchdown stretch
        [0.89, 1.15],                      // shock-absorbing landing squash
        [0.95, 0.97],                      // subtle elastic rebound overshoot
        [1.00, 1.00]
      ]);

  const scaleY = endInAir
    ? _evalKeyframes(u, [
        [0.00, 1.00],
        [0.08, 0.86],
        [0.19, 1.13 + peakBoost * 0.30],
        [0.52, airScaleY],
        [0.82, 1.05],
        [1.00, finalScaleY]
      ])
    : _evalKeyframes(u, [
        [0.00, 1.00],
        [0.08, 0.86],                      // deep pre-jump crouch
        [0.19, 1.13 + peakBoost * 0.30],   // upward takeoff stretch
        [0.48, airScaleY],                 // arc apex
        [0.77, 1.09 + peakBoost * 0.15],   // stretch along descent trajectory
        [0.89, 0.85],                      // touchdown compression
        [0.95, 1.04],                      // elastic upward rebound
        [1.00, 1.00]
      ]);

  // 4) Smooth dynamic body pitch/lean
  const dirSign = Math.abs(dx) > 2 ? Math.sign(dx) : (dy < 0 ? 1 : -1);
  const maxTiltDeg = Math.min(11.0, Math.max(5.5, (dist / g) * 2.5));
  const tiltAngle = endInAir
    ? _evalKeyframes(u, [
        [0.00, 0],
        [0.08, -3.5 * dirSign],
        [0.26, maxTiltDeg * dirSign],
        [0.62, maxTiltDeg * 0.25 * dirSign],
        [1.00, 0]
      ])
    : _evalKeyframes(u, [
        [0.00, 0],
        [0.08, -3.5 * dirSign],            // slight wind-up lean back during crouch
        [0.24, maxTiltDeg * dirSign],      // forward-upward lean on takeoff
        [0.49, 0],                         // level out across the apex
        [0.75, -maxTiltDeg * 0.85 * dirSign], // forward pitch during descent
        [0.89, 2.8 * dirSign],             // absorb forward momentum on touchdown
        [1.00, 0]
      ]);

  // 5) Ground shadow
  const shadowScale = endInAir
    ? _smootherstep(Math.max(0, (u - 0.55) / 0.45)) * ((endInFalling ? 0.76 : 1) - Math.max(0.52, 1 - 0.38 * arcFactor)) + Math.max(0.52, 1 - 0.38 * arcFactor)
    : Math.max(0.52, 1 - 0.38 * arcFactor);
  const fadeIn = _smootherstep(Math.min(1, u / 0.10));
  const fadeOut = endInAir
    ? (endInFalling ? 1 : (1 - _smootherstep(Math.max(0, (u - 0.82) / 0.18))))
    : (1 - _smootherstep(Math.max(0, (u - 0.85) / 0.15)));
  const rawShadowAlpha = 0.42 * (1 - 0.46 * arcFactor) * fadeIn * fadeOut;
  const shadowAlpha = endInAir && endInFalling
    ? rawShadowAlpha * (1 - airHoldBlend) + 0.26 * airHoldBlend
    : rawShadowAlpha;

  return {
    u,
    flightProgress,
    arcFactor,
    paceOffsetX,
    paceOffsetY,
    offsetX,
    offsetY,
    steadyLiftY: endInAir ? (paceOffsetY - endAirLift * airHoldBlend) : undefined,
    scaleX,
    scaleY,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/** Fraction of vertical upward jump (`computeAirJumpFrame`) at which liftoff occurs after the crouch (`u = 0.16`). */
export const AIR_JUMP_LAUNCH_T = 0.16;
/** Fraction of vertical upward jump (`computeAirJumpFrame`) at which the jump reaches its apex (`u = 0.74`). */
export const AIR_JUMP_APEX_T = 0.74;

export interface AirJumpFrameState extends JumpFrameState {
  /** Current visual token elevation in scene units (feet) for perspective scale and DoF blur. */
  visualElevation: number;
  /** Altitude gain progress (`0` at takeoff → `1` at the apex for `u >= AIR_JUMP_APEX_T`). */
  climbProgress: number;
}

/**
 * Pure frame evaluator for an in-place vertical jump into mid-air (`u` ∈ [0..1]):
 *  - Phase 1 (`u ∈ [0 .. launchT]`): elastic pre-jump crouch (`squash: 1.14×0.85`, slight press into the support surface);
 *  - Phase 2 (`u ∈ [launchT .. AIR_JUMP_APEX_T]`): explosive upward launch with gravitational deceleration toward the apex ($1 - (1-t)^{2.05}$),
 *    vertical body stretch (`stretch: 0.89×1.18`), ballistic `offsetY` arc, and rising `visualElevation`;
 *  - Phase 3 (`u ∈ [AIR_JUMP_APEX_T .. 1.0]`): weightless apex `hang-time` and seamless C¹ blend
 *    into `computeFallingLoopFrame(1, 0)` (when `endInFalling = true`) or stationary elevation perspective (no fake mid-air floor slam).
 */
export function computeAirJumpFrame(
  uRaw: number,
  {
    fromElevation = 0,
    toElevation = 10,
    gridSize = 100,
    tokenSize = 100,
    gridDistance = 5,
    startedGrounded = true,
    endInFalling = false,
    startOffsetX = 0,
    startOffsetY = 0,
    startTilt = 0,
    startScaleX = 1,
    startScaleY = 1
  }: {
    fromElevation?: number;
    toElevation?: number;
    gridSize?: number;
    tokenSize?: number;
    gridDistance?: number;
    startedGrounded?: boolean;
    endInFalling?: boolean;
    startOffsetX?: number;
    startOffsetY?: number;
    startTilt?: number;
    startScaleX?: number;
    startScaleY?: number;
  } = {}
): AirJumpFrameState {
  const u = Math.max(0, Math.min(1, Number(uRaw) || 0));
  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const gDist = Math.max(0.5, Number(gridDistance) || 5);
  const elev0 = Number.isFinite(Number(fromElevation)) ? Number(fromElevation) : 0;
  const elev1 = Number.isFinite(Number(toElevation)) ? Number(toElevation) : 10;
  const riseElev = Math.max(0, elev1 - elev0);
  const riseCells = Math.max(1, riseElev / gDist);

  const jumpPower = Math.max(0.88, Math.min(1.30, 0.78 + Math.sqrt(riseCells) * 0.16));
  const baseAirLift = elev1 > 0
    ? Math.min(g * 0.23, tsize * 0.20)
    : Math.min(g * 0.15, tsize * 0.13);
  const apexLiftPx = Math.max(
    baseAirLift * 1.48,
    Math.min(g * 0.48, tsize * 0.40) * jumpPower
  );

  const launchT = startedGrounded ? AIR_JUMP_LAUNCH_T : 0.10;
  const initOffX = Number.isFinite(Number(startOffsetX)) ? Number(startOffsetX) : 0;
  const initOffY = Number.isFinite(Number(startOffsetY)) ? Number(startOffsetY) : 0;
  const initT = Number.isFinite(Number(startTilt)) ? Number(startTilt) : 0;
  const initScX = Number.isFinite(Number(startScaleX)) && Number(startScaleX) > 0.2 ? Number(startScaleX) : 1;
  const initScY = Number.isFinite(Number(startScaleY)) && Number(startScaleY) > 0.2 ? Number(startScaleY) : 1;

  // 1) Logical `visualElevation` gain progress (gentle 0..2.5% ramp during crouch -> 1.0 at `AIR_JUMP_APEX_T`)
  let climbProgress = 0;
  if (u > 0) {
    if (u <= launchT) {
      climbProgress = 0.025 * _smootherstep(u / Math.max(1e-4, launchT));
    } else if (u >= AIR_JUMP_APEX_T) {
      climbProgress = 1;
    } else {
      const tAir = (u - launchT) / (AIR_JUMP_APEX_T - launchT);
      climbProgress = 0.025 + 0.975 * (1 - Math.pow(1 - tAir, 2.05));
    }
  }
  const visualElevation = elev0 + (elev1 - elev0) * climbProgress;

  // 2) Screen-space jump trajectory `offsetY`:
  //    Up through `u = AIR_JUMP_APEX_T (0.74)` the curve does NOT depend on `endInFalling`,
  //    so activating the `falling` status at the apex causes zero position or scale discontinuity!
  const endOffY = endInFalling ? -baseAirLift : 0;
  const endSteadyY = endInFalling ? -(baseAirLift + tsize * 0.035) : 0;
  let offsetY: number;
  if (u <= launchT) {
    const tCrouch = u / Math.max(1e-4, launchT);
    const crouchPulse = Math.sin(tCrouch * Math.PI);
    const crouchDipPx = (startedGrounded ? tsize * 0.068 : tsize * 0.032) * jumpPower;
    const baseStart = startedGrounded ? 0 : initOffY;
    offsetY = baseStart + crouchDipPx * crouchPulse;
  } else if (u <= AIR_JUMP_APEX_T) {
    const tAsc = (u - launchT) / (AIR_JUMP_APEX_T - launchT);
    const ballisticLift = 1 - Math.pow(1 - tAsc, 2.15);
    const baseStart = startedGrounded ? 0 : initOffY * (1 - _smootherstep(Math.min(1, tAsc / 0.45)));
    offsetY = baseStart * (1 - ballisticLift) - apexLiftPx * ballisticLift;
  } else {
    const tSettle = _smootherstep((u - AIR_JUMP_APEX_T) / (1 - AIR_JUMP_APEX_T));
    offsetY = -apexLiftPx + (endOffY - (-apexLiftPx)) * tSettle;
  }

  const initFade = startedGrounded ? 0 : (1 - _smootherstep(Math.min(1, u / 0.35)));
  const offsetX = initOffX * initFade;

  let steadyLiftY: number;
  if (u <= launchT) {
    steadyLiftY = startedGrounded ? 0 : initOffY;
  } else if (u <= AIR_JUMP_APEX_T) {
    const sAsc = _smootherstep((u - launchT) / (AIR_JUMP_APEX_T - launchT));
    const apexSteady = -(apexLiftPx * 0.92);
    const baseSt = startedGrounded ? 0 : initOffY;
    steadyLiftY = baseSt + (apexSteady - baseSt) * sAsc;
  } else {
    const tSettle = _smootherstep((u - AIR_JUMP_APEX_T) / (1 - AIR_JUMP_APEX_T));
    const apexSteady = -(apexLiftPx * 0.92);
    steadyLiftY = apexSteady + (endSteadyY - apexSteady) * tSettle;
  }

  // 3) Squash & Stretch: crouch -> explosive upward stretch -> apex hang-time -> smooth blend into air/falling
  const apexScaleX = 1 - 0.036;
  const apexScaleY = 1 + 0.068;
  const endScX = endInFalling ? (1 - 0.056 * 0.65) : 1.00;
  const endScY = endInFalling ? (1 + 0.056) : 1.00;

  let scaleX: number;
  let scaleY: number;
  if (u <= AIR_JUMP_APEX_T) {
    const crouchX = startedGrounded ? (1 + 0.14 * jumpPower) : Math.max(initScX, 1.07);
    const crouchY = startedGrounded ? Math.max(0.80, 1 - 0.15 * jumpPower) : Math.min(initScY, 0.92);
    const stretchX = Math.max(0.84, 1 - 0.11 * jumpPower);
    const stretchY = 1 + 0.175 * jumpPower;
    const startScX0 = startedGrounded ? 1.00 : initScX;
    const startScY0 = startedGrounded ? 1.00 : initScY;
    const crouchPeakT = launchT * 0.58;
    const stretchPeakT = launchT + (AIR_JUMP_APEX_T - launchT) * 0.24;
    scaleX = _evalKeyframes(u, [
      [0.00, startScX0],
      [crouchPeakT, crouchX],
      [stretchPeakT, stretchX],
      [AIR_JUMP_APEX_T, apexScaleX]
    ]);
    scaleY = _evalKeyframes(u, [
      [0.00, startScY0],
      [crouchPeakT, crouchY],
      [stretchPeakT, stretchY],
      [AIR_JUMP_APEX_T, apexScaleY]
    ]);
  } else {
    const tSettle = _smootherstep((u - AIR_JUMP_APEX_T) / (1 - AIR_JUMP_APEX_T));
    scaleX = apexScaleX + (endScX - apexScaleX) * tSettle;
    scaleY = apexScaleY + (endScY - apexScaleY) * tSettle;
  }

  // 4) Subtle body impulse on push-off and leveling at the apex
  const startTilt0 = startedGrounded ? 0 : initT;
  const tiltAngle = u <= AIR_JUMP_APEX_T
    ? _evalKeyframes(u, [
        [0.00, startTilt0],
        [launchT * 0.60, -2.8 * jumpPower],
        [launchT + (AIR_JUMP_APEX_T - launchT) * 0.28, 4.2 * jumpPower],
        [AIR_JUMP_APEX_T, 0]
      ])
    : 0;

  // 5) Ground shadow: dense beneath the crouch, shrinking and softening as the token rises
  const apexShadowScale = 0.68;
  const apexShadowAlpha = 0.24;
  let shadowScale: number;
  let shadowAlpha: number;
  if (u <= AIR_JUMP_APEX_T) {
    const liftFrac = _smootherstep(climbProgress);
    const fadeIn = startedGrounded ? _smootherstep(Math.min(1, u / 0.08)) : 1;
    shadowScale = 1 + (apexShadowScale - 1) * liftFrac;
    shadowAlpha = (0.40 + (apexShadowAlpha - 0.40) * liftFrac) * fadeIn;
  } else {
    const tSettle = _smootherstep((u - AIR_JUMP_APEX_T) / (1 - AIR_JUMP_APEX_T));
    const targetShScale = endInFalling ? 0.76 : 0.86;
    const targetShAlpha = endInFalling ? 0.26 : 0;
    shadowScale = apexShadowScale + (targetShScale - apexShadowScale) * tSettle;
    shadowAlpha = apexShadowAlpha + (targetShAlpha - apexShadowAlpha) * tSettle;
  }

  const arcFactor = Math.min(1, Math.max(0, (-offsetY) / Math.max(1, apexLiftPx)) * 0.65);

  return {
    u,
    visualElevation,
    climbProgress,
    flightProgress: climbProgress,
    arcFactor,
    paceOffsetX: 0,
    paceOffsetY: 0,
    offsetX,
    offsetY,
    steadyLiftY,
    steadyCenterY: offsetY,
    steadyScale: 1,
    scaleX,
    scaleY,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/**
 * Pure frame evaluator for airborne flight (`u` ∈ [0..1]):
 *  - smooth aerodynamic acceleration, cruise glide, and deceleration (`flightProgress`) with boundary
 *    velocities `startSpeed` / `endSpeed` for continuous WASD flight;
 *  - clean glide at hover altitude (`baseHoverHeight` + gentle `soarHeight` arc)
 *    WITHOUT high-frequency stepping bob or lateral X wobble;
 *  - uniform perspective scale (`scaleX === scaleY`);
 *  - smooth aerodynamic bank/lean along the flight heading (`tiltAngle`), preserved seamlessly while WASD is held;
 *  - soft diffused ground shadow beneath the airborne token;
 *  - `startHover` / `endHover` ∈ [0..1] blending for seamless transitions between idle hover and active flight.
 */
export function computeFlyFrame(
  uRaw: number,
  {
    dx = 100,
    dy = 0,
    gridSize = 100,
    tokenSize = 100,
    startHover = 0,
    endHover = 0,
    startSpeed = 0,
    endSpeed = 0,
    startTilt,
    endTilt,
    startLiftOffset = 0,
    releaseU = -1,
    releaseProgress = 0,
    releaseVelocity = 1,
    releaseTilt
  }: {
    dx?: number;
    dy?: number;
    gridSize?: number;
    tokenSize?: number;
    startHover?: number;
    endHover?: number;
    startSpeed?: number;
    endSpeed?: number;
    startTilt?: number;
    endTilt?: number;
    startLiftOffset?: number;
    releaseU?: number;
    releaseProgress?: number;
    releaseVelocity?: number;
    releaseTilt?: number;
  } = {}
): JumpFrameState {
  const u = Math.max(0, Math.min(1, Number(uRaw) || 0));
  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const sh = Math.max(0, Math.min(1, Number(startHover) || 0));
  const eh = Math.max(0, Math.min(1, Number(endHover) || 0));
  const v0 = Math.max(0, Math.min(1.5, Number(startSpeed) || 0));
  const v1 = Math.max(0, Math.min(1.5, Number(endSpeed) || 0));
  const initLiftOff = Number(startLiftOffset) || 0;

  const baseHoverHeight = Math.min(g * 0.28, tsize * 0.24);
  const steadyTooltipHoverLift = baseHoverHeight + tsize * 0.05;
  const dist = Math.hypot(dx, dy);
  const cells = Math.max(1, dist / g);

  const dirSign = Math.abs(dx) > 2 ? Math.sign(dx) : (dy < 0 ? 1 : -1);
  // Distance-invariant bank angle (5.8° peak, ~4.76° during cruise) regardless of flight span
  const maxBankDeg = dist >= 4 ? 5.8 : 0;
  const cruiseTilt = maxBankDeg * 0.82 * dirSign;
  const tilt0 = Number.isFinite(Number(startTilt)) ? Number(startTilt) : (v0 * cruiseTilt);
  const tilt1 = Number.isFinite(Number(endTilt)) ? Number(endTilt) : (v1 * cruiseTilt);

  if (u <= 0 || u >= 1) {
    const isEnd = u >= 1;
    const hEnd = isEnd ? eh : sh;
    const extraStartLift = isEnd ? 0 : initLiftOff;
    const endTiltVal = isEnd ? (releaseU >= 0 ? 0 : tilt1) : tilt0;
    return {
      u,
      flightProgress: isEnd ? 1 : 0,
      arcFactor: hEnd * 0.45,
      paceOffsetX: 0,
      paceOffsetY: 0,
      offsetX: 0,
      offsetY: -baseHoverHeight * hEnd + extraStartLift,
      steadyLiftY: -steadyTooltipHoverLift * hEnd,
      steadyCenterY: -baseHoverHeight * hEnd + extraStartLift,
      steadyScale: 1 + 0.10 * hEnd,
      scaleX: 1 + 0.10 * hEnd,
      scaleY: 1 + 0.10 * hEnd,
      tiltAngle: endTiltVal,
      shadowScale: 1 - 0.24 * hEnd,
      shadowAlpha: 0.32 * hEnd
    };
  }

  // Dedicated in-place vertical takeoff / altitude change / landing mode (dist < 4):
  if (dist < 4) {
    const isTakeoff = sh < 0.25 && eh >= 0.5;
    const isLanding = sh >= 0.5 && eh < 0.25;
    if (isTakeoff) {
      const liftNorm = _evalKeyframes(u, [
        [0.00, 0.00],
        [0.58, 1.18],
        [1.00, 1.00]
      ]);
      const offsetY = -baseHoverHeight * liftNorm;
      const scale = 1 + 0.10 * Math.min(1.15, Math.max(0, liftNorm));
      const airClamped = Math.max(0, liftNorm);
      const shadowScale = Math.max(0.50, 1 - 0.24 * Math.min(1.3, airClamped));
      const shadowAlpha = Math.max(0, Math.min(0.36, 0.32 * Math.min(1.1, airClamped)));
      return {
        u,
        flightProgress: _smootherstep(u),
        arcFactor: Math.min(1, airClamped * 0.50),
        paceOffsetX: 0,
        paceOffsetY: 0,
        offsetX: 0,
        offsetY,
        scaleX: scale,
        scaleY: scale,
        tiltAngle: 0,
        shadowScale,
        shadowAlpha
      };
    }
    if (isLanding) {
      const liftNorm = _evalKeyframes(u, [
        [0.00, 1.00],
        [0.88, 0.00],
        [1.00, 0.00]
      ]);
      const offsetY = -baseHoverHeight * liftNorm;
      const scale = 1 + 0.10 * Math.max(0, liftNorm);
      const airClamped = Math.max(0, liftNorm);
      const shadowScale = Math.max(0.55, 1 - 0.24 * airClamped);
      const shadowAlpha = 0.32 * airClamped;
      return {
        u,
        flightProgress: _smootherstep(u),
        arcFactor: Math.min(1, airClamped * 0.45),
        paceOffsetX: 0,
        paceOffsetY: 0,
        offsetX: 0,
        offsetY,
        scaleX: scale,
        scaleY: scale,
        tiltAngle: 0,
        shadowScale,
        shadowAlpha
      };
    }
    return computeIdleHoverFrame(eh, 0, { gridSize: g, tokenSize: tsize });
  }

  // 1) Aerodynamic horizontal progress:
  //    - point-to-point flight (`v0 = 0, v1 = 0`): gentle liftoff, brisk cruise, and smooth braking;
  //    - continuous WASD flight (`v1 = 1`): smooth ramp-up on the first cell and constant glide across cell boundaries;
  //    - mid-segment WASD release (`releaseU >= 0 && u > releaseU`):
  //      smooth braking from `(releaseU, releaseProgress, releaseVelocity)` to a full stop at `u = 1`.
  let flightProgress: number;
  if (releaseU >= 0 && releaseU < 0.98 && u > releaseU) {
    const span = Math.max(1e-4, 1 - releaseU);
    const remP = Math.max(0, 1 - releaseProgress);
    if (remP <= 1e-4) {
      flightProgress = 1;
    } else {
      const t = Math.max(0, Math.min(1, (u - releaseU) / span));
      const scaledV0 = Math.max(0.15, Math.min(1.6, (releaseVelocity * span) / remP));
      flightProgress = releaseProgress + remP * _hermiteProgress(t, scaledV0, 0);
    }
  } else {
    flightProgress = _hermiteProgress(u, v0, v1, cells, 0.28);
  }

  const paceDelta = flightProgress - u;
  const paceOffsetX = dx * paceDelta;
  const paceOffsetY = dy * paceDelta;

  // 2) Hover altitude and clean aerodynamic glide envelope (no multi-wave stepping `wingWave` or X sway):
  const sU = _smootherstep(u);
  const sinEnv = Math.sin(u * Math.PI);
  const hoverBaseline = sh * (1 - sU) + eh * sU;
  const hoverFactor = sh > 0.05 || eh > 0.05 ? hoverBaseline : Math.pow(sinEnv, 0.55);
  const soarEnv = sinEnv * sinEnv;
  // When already cruising aloft (`sh >= 0.85 && eh >= 0.85`), glide level at altitude
  // instead of bobbing up and down on every grid cell.
  const isContinuousStep = (v0 > 0.4 || v1 > 0.4) && sh >= 0.8 && eh >= 0.8;
  const airTransitionFactor = isContinuousStep
    ? 0
    : Math.max(0, 1 - Math.min(sh, eh) * 0.82);

  // Distance-invariant `soarHeight` independent of total flight `dist`
  const soarHeight = Math.min(g * 0.34, tsize * 0.30) * airTransitionFactor;

  // Smoothly decay initial idle-hover phase offset `startLiftOffset` to zero without a startup pop
  const startLiftDecay = initLiftOff * (1 - sU);
  const totalLift = baseHoverHeight * hoverFactor + soarHeight * soarEnv - startLiftDecay;
  const arcFactor = Math.max(0, Math.min(1, 0.42 * hoverFactor + 0.32 * soarEnv * airTransitionFactor));

  const offsetX = paceOffsetX;
  const offsetY = paceOffsetY - totalLift;
  const steadyLiftY = paceOffsetY - (steadyTooltipHoverLift * hoverFactor + soarHeight * soarEnv);

  // 3) Clean uniform perspective scale (`scaleX === scaleY`, no squash-and-stretch wobble)
  const hoverBoost = 0.10 * hoverFactor;
  const soarBoost = 0.045 * soarEnv * airTransitionFactor;
  const uniformScale = 1 + hoverBoost + soarBoost;
  const scaleX = uniformScale;
  const scaleY = uniformScale;

  // 4) Smooth aerodynamic bank/lean along the flight heading:
  //    - if WASD is released mid-step (`releaseU >= 0 && u > releaseU`), smoothly return bank from `releaseTilt` to `0`;
  //    - if movement continues (`v1 > 0`), ease into `tilt1` and hold it across cell boundaries without resetting to 0;
  //    - for a standalone flight (`v0 = 0, v1 = 0`), lean in over the first ~0.35 cells,
  //      hold a steady cruise bank along the path, and level out smoothly on arrival.
  let tiltAngle: number;
  if (releaseU >= 0 && releaseU < 0.98 && u > releaseU) {
    const tRel = Math.max(0, Math.min(1, (u - releaseU) / Math.max(1e-4, 1 - releaseU)));
    const rTilt = Number.isFinite(Number(releaseTilt)) ? Number(releaseTilt) : cruiseTilt;
    tiltAngle = rTilt * (1 - _smootherstep(tRel));
  } else if (v0 > 0.05 || v1 > 0.05) {
    if (v0 < 0.2 && v1 >= 0.5) {
      // WASD launch from rest: ease smoothly into cruise bank `tilt1`
      tiltAngle = tilt0 + (tilt1 - tilt0) * _smootherstep(Math.min(1, u / 0.65));
    } else if (v0 >= 0.5 && v1 < 0.2) {
      // Smooth braking at end of step (key was already released before the step began)
      tiltAngle = tilt0 * (1 - _smootherstep(u));
    } else {
      // Continuous inter-cell cruise glide (including smooth heading transitions when turning with WASD)
      tiltAngle = tilt0 + (tilt1 - tilt0) * sU;
    }
  } else {
    const tIn = Math.min(0.26, 0.35 / cells);
    const tOut = Math.max(0.68, 1 - 0.35 / cells);
    tiltAngle = _evalKeyframes(u, [
      [0.00, tilt0],
      [tIn, maxBankDeg * dirSign],
      [Math.min(tOut - 0.02, tIn + 0.14), cruiseTilt],
      [tOut, cruiseTilt],
      [1.00, tilt1]
    ]);
  }

  // 5) Diffused ground shadow beneath the flying token
  const shadowScale = Math.max(0.48, 1 - 0.24 * hoverFactor - 0.10 * soarEnv * airTransitionFactor);
  const shadowAlpha = Math.max(0, (0.32 * hoverFactor + 0.04 * sinEnv) * (1 - 0.16 * soarEnv * airTransitionFactor));

  return {
    u,
    flightProgress,
    arcFactor,
    paceOffsetX,
    paceOffsetY,
    offsetX,
    offsetY,
    steadyLiftY,
    steadyCenterY: offsetY,
    steadyScale: scaleX,
    scaleX,
    scaleY,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/**
 * Stationary `Idle Hover` frame for a token with active `movementAction: 'fly' | 'hover'`.
 * Pure, smooth vertical breathing with zero lateral X yaw or angular wobble
 * so a hovering token feels weightless and stable.
 */
export function computeIdleHoverFrame(
  blendRaw: number,
  phaseRad = 0,
  {
    gridSize = 100,
    tokenSize = 100,
    verticalBoost = 0
  }: { gridSize?: number; tokenSize?: number; verticalBoost?: number } = {}
): JumpFrameState {
  const b = _smootherstep(Math.max(0, Math.min(1, Number(blendRaw) || 0)));
  const boost = Number(verticalBoost) || 0;
  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const bob = Math.sin(phaseRad); // [-1..1], equals 0 when phaseRad === 0

  const baseHoverHeight = Math.min(g * 0.28, tsize * 0.24);
  const totalFactor = Math.max(0, b * (1 + 0.09 * bob) + boost);
  const liftY = baseHoverHeight * totalFactor;
  // Steady lift for the `+5ft` elevation label (`steadyLiftY`): depends ONLY on `b` (takeoff/landing blend),
  // NOT on `bob` (`phaseRad`), so UI badges rise with the token without bobbing in mid-air
  const steadyLiftY = -(baseHoverHeight + tsize * 0.05) * b;
  const steadyCenterY = -(baseHoverHeight * (b + boost));
  const steadyScale = 1 + 0.10 * b + boost * 0.12;

  const uniformScale = 1 + (0.10 + 0.008 * bob) * b + boost * 0.12;
  const tiltAngle = boost * 3.5;
  const shadowScale = Math.max(0.48, 1 - (0.24 + 0.022 * bob) * b - boost * 0.16);
  const shadowAlpha = Math.max(0, Math.min(0.38, 0.32 * b * (1 - 0.07 * bob)));

  return {
    u: b,
    flightProgress: 0,
    arcFactor: Math.min(1, b * (0.45 + 0.04 * bob) + boost * 0.4),
    paceOffsetX: 0,
    paceOffsetY: 0,
    offsetX: 0,
    offsetY: -liftY,
    steadyLiftY,
    steadyCenterY,
    steadyScale,
    scaleX: uniformScale,
    scaleY: uniformScale,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/**
 * Continuous free-fall loop frame (`Falling`, while the `falling` status is active on a token):
 *  - incommensurate golden-ratio harmonics (`ω₁ = 2.45`, `ω₂ = 3.96`, `ω₃ = 6.18`) prevent mechanical loop repetition;
 *  - quadrature phase offset between body bank (`tiltAngle`) and lateral drift (`swayX`) traces a natural
 *    figure-eight `falling-leaf` air-current glide rather than a rigid pendulum swing;
 *  - asymmetric air-pocket drops with soft updraft catches (`bobY`) and subtle depth scale breathing
 *    convey weightlessness and rushing upward airflow;
 *  - `steadyLiftY` stays completely independent of `phaseRad` so the clickable `falling.svg` status icon
 *    (`TokenDocument5e#plummet`) inside `token.effects` remains easy to click.
 */
export function computeFallingLoopFrame(
  blendRaw: number,
  phaseRad = 0,
  {
    gridSize = 100,
    tokenSize = 100,
    elevation = 30
  }: { gridSize?: number; tokenSize?: number; elevation?: number } = {}
): JumpFrameState {
  const b = _smootherstep(Math.max(0, Math.min(1, Number(blendRaw) || 0)));
  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const elev = Math.max(0, Number(elevation) || 0);

  // Base separation from the ground shadow (keeps the token lifted into the airstream even if Falling is toggled at 0 ft)
  const baseAirLift = elev > 0
    ? Math.min(g * 0.23, tsize * 0.20)
    : Math.min(g * 0.15, tsize * 0.13);

  // Incommensurate free-fall harmonics (starts smoothly with zero position jump at phaseRad === 0)
  const p = Number(phaseRad) || 0;
  const startEnv = p >= 0 && p < 0.35 ? _smootherstep(p / 0.35) : 1;

  // 1) Restrained body bank trying to catch balance in the airstream (~±11°)
  const bankPrimary = Math.sin(p * 2.45);
  const bankSecondary = Math.sin(p * 3.96);
  const tiltAngle = (8.2 * bankPrimary + 3.1 * bankSecondary) * b;

  // 2) Quadrature lateral slip (figure-eight / falling-leaf: lateral drift lags body bank instead of swinging like a pendulum)
  const slipLag = Math.sin(p * 2.45 - 0.82) * startEnv;
  const slipCross = Math.sin(p * 3.96 + 0.55) * startEnv;
  const swayX = tsize * (0.034 * slipLag + 0.013 * slipCross) * b;

  // 3) Soft air-pocket drops and elastic updraft catches (without harsh jitter)
  const pocketDrop = Math.sin(p * 3.10) * 0.72 + Math.sin(p * 4.90 - 0.60) * startEnv * 0.28;
  const bobY = tsize * 0.034 * pocketDrop * b;
  const liftY = baseAirLift * b + bobY;

  // Phase-independent steady lift for UI overlays (`token.effects` and `token.tooltip`)
  const steadyLiftY = -(baseAirLift + tsize * 0.035) * b;

  // 4) Subtle silhouette elongation in the rushing airflow + gentle 3D depth pulse
  const gustWave = Math.sin(p * 4.65) * 0.65 + Math.sin(p * 6.18) * 0.35;
  const depthPulse = -0.010 * pocketDrop * b;
  const baseStretch = 0.056 * b;
  const flutter = 0.015 * gustWave * b;
  const scaleX = Math.max(0.84, (1 + depthPulse) * (1 - baseStretch * 0.65 - flutter * 0.50));
  const scaleY = Math.max(0.88, (1 + depthPulse) * (1 + baseStretch + flutter));

  const shadowScale = Math.max(0.46, 1 - (0.24 + 0.024 * pocketDrop) * b);
  const shadowAlpha = Math.max(0, Math.min(0.34, 0.26 * b * (1 - 0.07 * pocketDrop)));

  return {
    u: b,
    flightProgress: 0,
    arcFactor: Math.min(1, b * 0.55),
    paceOffsetX: 0,
    paceOffsetY: 0,
    offsetX: swayX,
    offsetY: -liftY,
    steadyLiftY,
    steadyCenterY: -baseAirLift * b,
    steadyScale: 1,
    scaleX,
    scaleY,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/**
 * Fraction of `computeFallPlungeFrame` duration at which the falling token slams into the ground (`u = 0.56`).
 * `[0..0.56]` runs accelerated gravitational free-fall dive, while `[0.56..1.0]` plays out
 * heavy ground `impact squash`, elastic rebound, and settle.
 */
export const FALL_IMPACT_T = 0.56;

export interface FallPlungeFrameState extends JumpFrameState {
  /** Current visual token elevation in scene units (feet) for perspective scale and DoF blur. */
  visualElevation: number;
  /** Free-fall progress up to ground impact (`0` at drop start → `1` upon impact for `u >= FALL_IMPACT_T`). */
  fallProgress: number;
}

/**
 * Pure frame evaluator for a high-speed plunge from altitude and ground impact (`u` ∈ [0..1]):
 *  - Phase 1 (`u ∈ [0 .. FALL_IMPACT_T]`): gravitational dive with power-law acceleration ($t^{2.15}$),
 *    seamless pickup of initial `startOffsetX/Y`, `startTilt`, and `startScaleX/Y` from the falling loop,
 *    progressive vertical stretch (`scaleX ~ 0.76..0.82`, `scaleY ~ 1.24..1.35`), and collapsing `visualElevation`;
 *  - Phase 2 (`u ∈ [FALL_IMPACT_T .. 1.0]`): C⁰-continuous transition at `FALL_IMPACT_T` into heavy ground impact
 *    (`scaleX ~ 1.28`, `scaleY ~ 0.72`), downward sole press, elastic `rebound hop`, and settle back to `1.0x, 0px, 0°`.
 */
export function computeFallPlungeFrame(
  uRaw: number,
  {
    fromElevation = 30,
    toElevation = 0,
    gridSize = 100,
    tokenSize = 100,
    gridDistance = 5,
    dx = 0,
    dy = 0,
    startOffsetX = 0,
    startOffsetY = 0,
    startTilt = 0,
    startScaleX = 1,
    startScaleY = 1
  }: {
    fromElevation?: number;
    toElevation?: number;
    gridSize?: number;
    tokenSize?: number;
    gridDistance?: number;
    dx?: number;
    dy?: number;
    startOffsetX?: number;
    startOffsetY?: number;
    startTilt?: number;
    startScaleX?: number;
    startScaleY?: number;
  } = {}
): FallPlungeFrameState {
  const u = Math.max(0, Math.min(1, Number(uRaw) || 0));
  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const gDist = Math.max(0.5, Number(gridDistance) || 5);
  const elev0 = Number.isFinite(Number(fromElevation)) ? Number(fromElevation) : 30;
  const elev1 = Number.isFinite(Number(toElevation)) ? Number(toElevation) : 0;
  const dropElev = Math.max(0, elev0 - elev1);
  const dropCells = Math.max(1, dropElev / gDist);

  // Drop-severity factor scaled by height (`0.9` for 10–15 ft, up to `1.25` for 60+ ft)
  const severity = Math.max(0.82, Math.min(1.25, 0.74 + Math.sqrt(dropCells) * 0.17));

  // Extra screen-space starting dive height so even modest elevation drops read clearly
  const minScreenDropPx = Math.min(g * 1.15, tsize * (0.38 + 0.13 * Math.min(6, Math.sqrt(dropCells))));
  const initDropY = Math.min(-minScreenDropPx, Number(startOffsetY) || 0);
  const initOffX = Number.isFinite(Number(startOffsetX)) ? Number(startOffsetX) : 0;
  const initT = Number.isFinite(Number(startTilt)) ? Number(startTilt) : 0;
  const initScX = Number.isFinite(Number(startScaleX)) && Number(startScaleX) > 0.2 ? Number(startScaleX) : 1;
  const initScY = Number.isFinite(Number(startScaleY)) && Number(startScaleY) > 0.2 ? Number(startScaleY) : 1;

  // Exact terminal values at touchdown (`tFall = 1.0`, `u = FALL_IMPACT_T`) for a zero-pop C⁰ seam
  const terminalStretch = (0.065 + 0.135) * severity;
  const impactEntryScaleX = Math.max(0.75, 1 - terminalStretch * 0.68);
  const impactEntryScaleY = Math.min(1.32, 1 + terminalStretch);
  const impactEntryTilt = 14 * severity * 0.35; // sin(2.5 * pi) * (1 - 0.65) === +0.35

  let fallProgress: number;
  let visualElevation: number;
  let offsetX = 0;
  let offsetY = 0;
  let steadyLiftY = 0;
  let scaleX = 1;
  let scaleY = 1;
  let tiltAngle = 0;
  let shadowScale = 1;
  let shadowAlpha = 0;
  let arcFactor = 0;

  if (u < FALL_IMPACT_T) {
    // Phase 1: Gravitationally accelerated free-fall
    const tFall = Math.max(0, Math.min(1, u / FALL_IMPACT_T));
    // Power-law downward acceleration (brief initial drop-off -> rapid terminal dive toward the ground)
    fallProgress = Math.pow(tFall, 2.15);
    visualElevation = elev0 + (elev1 - elev0) * fallProgress;

    const rem = 1 - fallProgress;
    const initBlend = 1 - _smootherstep(Math.min(1, tFall / 0.45));
    // Turbulent descent yaw that damps cleanly to zero right at impact (`rem -> 0`)
    const tumbleWave = Math.sin(tFall * Math.PI * 2.5) * (1 - tFall * 0.65);
    offsetX = initOffX * initBlend + tsize * 0.032 * severity * tumbleWave * rem * (1 - initBlend * 0.6);
    offsetY = initDropY * rem;
    steadyLiftY = offsetY;

    // Silhouette stretches progressively along the fall vector while blending smoothly from initial scale
    const velStretch = (0.065 + 0.135 * Math.pow(tFall, 1.35)) * severity;
    const targetScX = Math.max(0.75, 1 - velStretch * 0.68);
    const targetScY = Math.min(1.32, 1 + velStretch);
    scaleX = initScX * initBlend + targetScX * (1 - initBlend);
    scaleY = initScY * initBlend + targetScY * (1 - initBlend);

    tiltAngle = initT * (1 - _smootherstep(tFall)) + (14 * severity * tumbleWave);

    arcFactor = Math.max(0, Math.min(1, rem * 0.85));
    shadowScale = Math.max(0.40, 0.48 + 0.52 * fallProgress);
    shadowAlpha = Math.max(0.12, Math.min(0.50, 0.18 + 0.30 * fallProgress));
  } else {
    // Phase 2: Ground `impact squash`, elastic `rebound`, and settle
    fallProgress = 1;
    visualElevation = elev1;
    const tImp = Math.max(0, Math.min(1, (u - FALL_IMPACT_T) / (1 - FALL_IMPACT_T)));

    const maxSquashX = 1 + 0.22 * severity;
    const minSquashY = Math.max(0.70, 1 - 0.20 * severity);
    const reboundScaleX = Math.max(0.92, 1 - 0.055 * severity);
    const reboundScaleY = 1 + 0.070 * severity;

    scaleX = _evalKeyframes(tImp, [
      [0.00, impactEntryScaleX],
      [0.18, maxSquashX],
      [0.50, reboundScaleX],
      [0.78, 1 + 0.020 * severity],
      [1.00, 1.00]
    ]);
    scaleY = _evalKeyframes(tImp, [
      [0.00, impactEntryScaleY],
      [0.18, minSquashY],
      [0.50, reboundScaleY],
      [0.78, 1 - 0.016 * severity],
      [1.00, 1.00]
    ]);

    // Press center slightly toward the sole at peak squash (`tImp = 0.18`), followed by a subtle upward rebound (`tImp = 0.50`)
    const slamDownPx = tsize * 0.085 * severity;
    const reboundUpPx = -tsize * 0.052 * severity;
    offsetY = _evalKeyframes(tImp, [
      [0.00, 0],
      [0.18, slamDownPx],
      [0.50, reboundUpPx],
      [0.78, slamDownPx * 0.12],
      [1.00, 0]
    ]);
    steadyLiftY = 0;
    offsetX = 0;

    tiltAngle = _evalKeyframes(tImp, [
      [0.00, impactEntryTilt],
      [0.20, -4.4 * severity],
      [0.52, 1.9 * severity],
      [0.80, -0.6 * severity],
      [1.00, 0]
    ]);

    arcFactor = 0;
    shadowScale = _evalKeyframes(tImp, [
      [0.00, 1.00],
      [0.18, 1.18],
      [0.50, 0.94],
      [1.00, 1.00]
    ]);
    shadowAlpha = _evalKeyframes(tImp, [
      [0.00, 0.48],
      [0.20, 0.52],
      [0.65, 0.18],
      [1.00, 0.00]
    ]);
  }

  const dX = Number(dx) || 0;
  const dY = Number(dy) || 0;
  const flightProgress = fallProgress;
  const linearX = dX * u;
  const linearY = dY * u;
  const groundX = dX * flightProgress;
  const groundY = dY * flightProgress;
  const paceOffsetX = groundX - linearX;
  const paceOffsetY = groundY - linearY;

  return {
    u,
    flightProgress,
    fallProgress,
    visualElevation,
    arcFactor,
    paceOffsetX,
    paceOffsetY,
    offsetX: paceOffsetX + offsetX,
    offsetY: paceOffsetY + offsetY,
    steadyLiftY: paceOffsetY + steadyLiftY,
    scaleX,
    scaleY,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/**
 * Pure frame evaluator for grounded walking (`walk`, `u` ∈ [0..1]):
 *  - lively elastic gait with per-step foot lift (`stepLift`), left/right foot alternation (`stepSign`),
 *    natural Squash & Stretch on push-off and foot plant, and subtle lateral body sway (`strideTilt`);
 *  - supports boundary velocities `startSpeed` / `endSpeed` and alternating `stepParity` (`1` or `-1`)
 *    so continuous WASD strides flow seamlessly across grid cells without per-cell stops,
 *    while releasing WASD (`releaseU >= 0` or `endSpeed = 0`) gently absorbs momentum into a soft plant crouch.
 */
export function computeWalkFrame(
  uRaw: number,
  {
    dx = 100,
    dy = 0,
    gridSize = 100,
    tokenSize = 100,
    startSpeed = 0,
    endSpeed = 0,
    stepParity = 1,
    releaseU = -1,
    releaseProgress = 0,
    releaseVelocity = 1
  }: {
    dx?: number;
    dy?: number;
    gridSize?: number;
    tokenSize?: number;
    startSpeed?: number;
    endSpeed?: number;
    stepParity?: number;
    releaseU?: number;
    releaseProgress?: number;
    releaseVelocity?: number;
  } = {}
): JumpFrameState {
  const u = Math.max(0, Math.min(1, Number(uRaw) || 0));
  if (u <= 0 || u >= 1) {
    return {
      u,
      flightProgress: u >= 1 ? 1 : 0,
      arcFactor: 0,
      paceOffsetX: 0,
      paceOffsetY: 0,
      offsetX: 0,
      offsetY: 0,
      steadyLiftY: 0,
      scaleX: 1,
      scaleY: 1,
      tiltAngle: 0,
      shadowScale: 1,
      shadowAlpha: 0
    };
  }

  const g = Math.max(20, Number(gridSize) || 100);
  const tsize = Math.max(20, Number(tokenSize) || g);
  const dist = Math.hypot(dx, dy);
  if (dist < 4) {
    return {
      u,
      flightProgress: u,
      arcFactor: 0,
      paceOffsetX: 0,
      paceOffsetY: 0,
      offsetX: 0,
      offsetY: 0,
      steadyLiftY: 0,
      scaleX: 1,
      scaleY: 1,
      tiltAngle: 0,
      shadowScale: 1,
      shadowAlpha: 0
    };
  }

  const v0 = Math.max(0, Math.min(1.5, Number(startSpeed) || 0));
  const v1 = Math.max(0, Math.min(1.5, Number(endSpeed) || 0));
  const parity = (Number(stepParity) || 1) >= 0 ? 1 : -1;
  const cells = Math.max(1, dist / g);

  // 1) Horizontal progress:
  //    - single move (mouse drag / click): short smooth ramps (`rampCells = 0.16`) with strictly constant cruise speed between them;
  //    - continuous WASD stride (`v1 = 1`): ramp into steady pace with zero micro-braking at cell borders;
  //    - mid-cell WASD release (`releaseU >= 0 && u > releaseU`): smooth deceleration to 0 by cell end.
  let flightProgress: number;
  if (releaseU >= 0 && releaseU < 0.98 && u > releaseU) {
    const span = Math.max(1e-4, 1 - releaseU);
    const remP = Math.max(0, 1 - releaseProgress);
    if (remP <= 1e-4) {
      flightProgress = 1;
    } else {
      const t = Math.max(0, Math.min(1, (u - releaseU) / span));
      const scaledV0 = Math.max(0.15, Math.min(1.6, (releaseVelocity * span) / remP));
      flightProgress = releaseProgress + remP * _hermiteProgress(t, scaledV0, 0);
    }
  } else {
    flightProgress = _hermiteProgress(u, v0, v1, cells, 0.16);
  }

  const paceDelta = flightProgress - u;
  const paceOffsetX = dx * paceDelta;
  const paceOffsetY = dy * paceDelta;

  // 2) Step count per segment (strictly 1 step per grid cell regardless of total distance):
  const steps = Math.max(1, Math.round(dist / g));
  // Time-uniform step phase (`u * steps`) so stride cadence stays steady over the entire path
  const stepPhase = u * steps;
  const stepIdx = Math.min(steps - 1, Math.floor(stepPhase));
  const localU = stepPhase - stepIdx; // [0..1] within the current step
  const footSign = ((stepIdx % 2 === 0) ? 1 : -1) * parity;

  // Single-step foot-lift envelope: smooth `sin(pi * localU)` arch with gentle ground contact at both ends
  const stepSin = Math.sin(localU * Math.PI);
  const stepArch = stepSin * (0.85 + 0.15 * stepSin);
  const stepHeight = Math.min(g * 0.088, tsize * 0.078);

  // Soft shock-absorbing `settle dip` on initial push-off (`v0 === 0`) and final foot plant (`v1 === 0`),
  // scaled by `cells` so it spans a fixed ~55 ms duration rather than stretching across long drags
  const dipStartSpan = Math.min(0.18, 0.18 / cells);
  const dipEndSpan = Math.min(0.20, 0.20 / cells);
  const startDipEnv = (1 - Math.min(1, v0)) * Math.sin(Math.min(1, u / dipStartSpan) * Math.PI) * (u < dipStartSpan ? 1 : 0);
  const endStopped = releaseU >= 0 ? 1 : (1 - Math.min(1, v1));
  const endDipEnv = endStopped * Math.sin(Math.max(0, (u - (1 - dipEndSpan)) / dipEndSpan) * Math.PI) * (u > (1 - dipEndSpan) ? 1 : 0);

  const liftY = stepHeight * stepArch - stepHeight * 0.16 * (startDipEnv + endDipEnv);
  const offsetX = paceOffsetX;
  const offsetY = paceOffsetY - liftY;
  const steadyLiftY = paceOffsetY;

  // 3) Elastic gait Squash & Stretch:
  //    slight vertical stretch (`+2.2%`) at mid-step peak, and a soft horizontal cushion (`+1.8%` wide) on foot plant
  const contactWave = Math.cos(localU * Math.PI * 2); // +1 on ground contact (0 and 1), -1 at mid-step apex (0.5)
  const edgeFade = Math.sin(u * Math.PI); // guarantees exact return to `scale = 1.0` at `u = 0` and `u = 1`
  const stepSquash = contactWave * 0.016 * edgeFade + (startDipEnv + endDipEnv) * 0.014;
  const scaleX = 1 + stepSquash - stepArch * 0.008;
  const scaleY = 1 - stepSquash * 0.90 + stepArch * 0.022;

  // 4) Lively body sway (waddle / stride lean):
  //    rocks in rhythm with weight transfer from foot to foot + subtle forward lean along heading
  const dirSign = Math.abs(dx) > 2 ? Math.sign(dx) : (dy < 0 ? 1 : -1);
  const forwardLean = dirSign * 1.8 * Math.sin(u * Math.PI);
  const strideSway = footSign * 2.8 * stepSin;
  const tiltAngle = forwardLean + strideSway;

  // 5) Subtle contact shadow beneath the walking token (tightens slightly as the foot lifts)
  const shadowScale = 1 - 0.10 * stepArch;
  const shadowAlpha = 0.22 * Math.sin(u * Math.PI) * (1 - 0.25 * stepArch);

  return {
    u,
    flightProgress,
    arcFactor: stepArch * 0.22,
    paceOffsetX,
    paceOffsetY,
    offsetX,
    offsetY,
    steadyLiftY,
    scaleX,
    scaleY,
    tiltAngle,
    shadowScale,
    shadowAlpha
  };
}

/* --------------------- Relative Elevation Perspective --------------------- */

export interface ElevationPerspectiveOptions {
  gridSize?: number;
  gridDistance?: number;
  tokenSize?: number;
  /** Base elevation of the currently viewed scene level (`canvas.level.elevation.base`, default `0` on single-level scenes) */
  baseElevation?: number;
  /** Solid surface elevation directly beneath the token (used to size/fade the ground shadow relative to roof/floor clearance) */
  surfaceElevation?: number;
  /** Whether the token is standing grounded on a solid surface (`clearance <= 0`), keeping `worldScale === 1.0` and `0` parallax */
  isGroundedOnSurface?: boolean;
  /** Airborne hover blend (`0..1`): scales additional altitude lift above the ground shadow */
  hoverBlend?: number;
  /** Current camera zoom scale (`canvas.stage.scale.x`) used to detect when the camera descends below a high-altitude token */
  cameraScale?: number;
  /** Token center position in world coordinates (for 3D radial parallax relative to the camera) */
  tokenCenter?: { x: number; y: number } | null;
  /** Camera pivot center `canvas.stage.pivot` (for 3D radial parallax relative to the background map) */
  cameraCenter?: { x: number; y: number } | null;
}

export interface ElevationPerspectiveState {
  /** Signed elevation delta between token and observer (`tokenElevation - observerElevation`) in scene units (feet) */
  deltaElevation: number;
  /** Signed elevation delta in grid cells (`deltaElevation / gridDistance`) */
  deltaCells: number;
  /** Token height above ground level (`max(0, tokenElevation) / gridDistance`) in grid cells */
  groundCells: number;
  /**
   * World scale of the token relative to the ground plane (`0 ft`):
   *  - at ground level (`0 ft`) ALWAYS equals `1.0` (grounded tokens always match scene grid cells `1:1`!);
   *  - at low elevations (`10 ft = 3 m`) remains subtle (`~1.02x`);
   *  - at high altitudes (`60..135 ft`) grows smoothly (`~1.28x..1.40x`) because the token sits closer to the camera than the map.
   */
  worldScale: number;
  /**
   * Scene camera zoom multiplier (`canvas.stage.scale`) when viewing from `observerElevation`:
   *  - equals `1.0` at ground level (`0 ft`);
   *  - barely shifts at `10 ft` (`3 m`, `~0.98x`);
   *  - when controlling a high-altitude token (`60..135 ft`), zooms the camera smoothly out (`~0.78x..0.71x`),
   *    shrinking **the scene background and grounded tokens together** while keeping the elevated observer (`worldScale * cameraZoom === 1.0`)
   *    at natural foreground scale.
   */
  cameraZoom: number;
  /**
   * Screen-space scale relative to the observer (`worldScale * cameraZoom`):
   * `> 1` when the token is above the observer; `< 1` when the token (along with the ground map) lies far below; `1.0` at observer altitude.
   */
  perspectiveScale: number;
  /** Vertical Y lift of the token above its ground shadow (`<= 0`) */
  perspectiveOffsetY: number;
  /** 3D X parallax relative to the camera center (elevated tokens glide above the 2D map as the camera pans) */
  parallaxOffsetX: number;
  /** 3D Y parallax relative to the camera center */
  parallaxOffsetY: number;
  /** Depth-of-Field blur radius (in pixels) for layers/tokens far from the observer's focal plane */
  dofBlurPx: number;
  /** Extra downward Y offset applied to the ground shadow when the observer is high in the air (`>= 0`) */
  shadowOffsetY: number;
  /** Ground shadow size multiplier from high altitude above ground (`0.52..1.0`) */
  shadowScaleMult: number;
  /** Ground shadow opacity multiplier from high altitude above ground (`0.46..1.0`) */
  shadowAlphaMult: number;
  /** Virtual camera altitude above the ground (in scene units / feet) at the current `cameraScale` zoom */
  cameraAltitudeFt: number;
  /**
   * High-altitude token opacity as the camera zooms in (`0..1`):
   * fully visible (`1.0`) when zoomed out; when zooming deeply in so the camera descends below the token's altitude,
   * smoothly fades out (`1.0 -> 0.0`), leaving only its ground shadow below.
   */
  cameraOcclusionAlpha: number;
}

/**
 * C²-smooth altitude normalization (in grid cells) with zero derivative at `0`:
 *  - strictly `0` on the ground (`0 ft`);
 *  - gentle, organic onset at low elevations (`5..10 ft` = `1.5..3 m`) with no dead step or exaggeration (`~0.014..0.050`);
 *  - smoothly expands depth at mid altitudes (`20..45 ft` = `6..13.5 m`, `~0.16..0.48`);
 *  - approaches soft optical saturation at high altitudes (`60..120+ ft` = `18..36+ m`, `~0.65..0.95`).
 */
function _altitudeNorm(cells: number): number {
  if (cells <= 0) return 0;
  const q = cells / 12; // 1.0 at 12 grid cells of altitude (60 ft on a 5-ft grid)
  const u = (q * q * 1.12) / (0.46 + q);
  return Math.tanh(u);
}

/** Virtual camera lens altitude (in scene units / feet) at zoom `camScale` and focal altitude `obsElevFt`. */
function _computeCameraAltitudeFt(camScale: number, obsElevFt: number, gridDist: number): number {
  const clamped = Math.max(0.22, Math.min(4.0, camScale));
  const lensDistFt = (92 / Math.pow(clamped, 1.30)) * (gridDist / 5);
  return lensDistFt + Math.max(0, obsElevFt) * 0.48;
}

/**
 * Optical world scale of a token relative to the ground plane (`0 ft`):
 * combines base altitude magnification (readable even when zoomed out) with continuous 3D `Looming`
 * so zooming the camera toward an airborne token makes it grow noticeably faster than the flat map beneath it.
 */
function _computeWorldScaleAtAltitude(groundCells: number, tokElevFt: number, camAltFt: number): {
  worldScale: number;
  loomCurve: number;
  loomGate: number;
} {
  if (groundCells <= 0 || tokElevFt <= 0) {
    return { worldScale: 1, loomCurve: 0, loomGate: 0 };
  }
  const highNorm = _altitudeNorm(groundCells);
  const baseScale = 1 + 0.25 * highNorm;
  const rho = Math.min(1.18, Math.max(0, tokElevFt) / Math.max(1e-3, camAltFt));
  const loomGate = _smootherstep(Math.min(1, groundCells / 3.2));
  const loomCurve = (rho * rho) / (0.38 + rho * rho);
  const worldScale = baseScale * (1 + 0.40 * loomCurve * loomGate);
  return { worldScale, loomCurve, loomGate };
}

/**
 * Compute optically grounded 3D elevation perspective for a token and the scene.
 *
 * Key optical principles:
 *  - Grounded tokens (`0 ft`) lie directly on the map plane (`canvas.primary.background`), so `worldScale === 1.0` at every zoom level.
 *  - C²-smooth onset for both scale and Depth of Field without hard thresholds: subtle at `5..10 ft` (`1.5..3 m`, `+0.4%..+2.1%`, `0px` blur),
 *    gradually building aerial perspective as altitude increases.
 *  - **3D depth illusion under camera zoom and pan** (`cameraScale`, `cameraCenter`):
 *    1) Zooming toward a flying token increases its `worldScale` faster than the floor (`3D Looming`),
 *       while radial 3D parallax (`parallaxOffsetX/Y`) smoothly separates the token from its ground shadow.
 *    2) As the camera lens enters the near zone of a foreground hovering token, soft optical bokeh (`nearLensBlurPx`) blooms
 *       alongside a smooth fade-out (`cameraOcclusionAlpha: 1 -> 0`) once the camera drops below the token's altitude.
 *    3) Viewing from a high-altitude token (`observerElevation = 30..135 ft`) zooms the scene out (`cameraZoom < 1`) and applies
 *       smooth Depth-of-Field defocus to the map and lower tokens scaled by `zoomAperture`.
 */
export function computeElevationPerspective(
  tokenElevation: number,
  observerElevation: number = 0,
  options: ElevationPerspectiveOptions = {}
): ElevationPerspectiveState {
  const g = Math.max(16, Number(options.gridSize) || (globalThis as any).canvas?.grid?.size || 100);
  const tsize = Math.max(16, Number(options.tokenSize) || g);
  const sceneDist = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.grid?.distance) || 5;
  const gridDist = Math.max(0.5, Number(options.gridDistance) || sceneDist);

  const tokElev = Number(tokenElevation) || 0;
  const obsElev = Number(observerElevation) || 0;
  const baseElev = Number.isFinite(Number(options.baseElevation))
    ? Number(options.baseElevation)
    : getViewedLevelBaseElevation();
  const surfElev = Number.isFinite(Number(options.surfaceElevation))
    ? Number(options.surfaceElevation)
    : baseElev;
  const relTokElev = tokElev - baseElev;
  const relObsElev = obsElev - baseElev;
  const hoverBlend = options.hoverBlend !== undefined
    ? Math.max(0, Math.min(1, Number(options.hoverBlend) || 0))
    : (relTokElev > 0 ? 1 : 0);

  const deltaElevation = tokElev - obsElev;
  const deltaCells = deltaElevation / gridDist;
  const groundCells = options.isGroundedOnSurface ? 0 : (Math.max(0, relTokElev) / gridDist);
  const shadowCells = options.isGroundedOnSurface ? 0 : (Math.max(0, tokElev - surfElev) / gridDist);
  const obsCells = Math.max(0, relObsElev) / gridDist;

  // 1) Virtual camera lens altitude (`cameraAltitudeFt`) and normalized token-to-lens proximity (`rho`)
  const rawCamScale = Number(options.cameraScale) || Number((globalThis as any).canvas?.stage?.scale?.x) || 1;
  const clampedCamScale = Math.max(0.22, Math.min(4.0, rawCamScale));
  const cameraAltitudeFt = _computeCameraAltitudeFt(clampedCamScale, relObsElev, gridDist);
  const rho = groundCells > 0 ? (Math.max(0, relTokElev) / Math.max(1e-3, cameraAltitudeFt)) : 0;

  // Smoothly fade out an elevated token as the camera lens drops below its flight level (`rho: 0.80 -> 1.06`)
  const occHeightGate = _smootherstep(Math.max(0, Math.min(1, (groundCells - 2.0) / 2.0)));
  let cameraOcclusionAlpha = 1;
  if (rho > 0.80 && occHeightGate > 0) {
    const tOcc = _smootherstep(Math.min(1, (rho - 0.80) / (1.06 - 0.80)));
    cameraOcclusionAlpha = 1 - tOcc * occHeightGate;
  }

  // 2) `worldScale` with dynamic 3D camera looming, lift above the shadow, and ground-shadow perspective
  const groundHighNorm = _altitudeNorm(groundCells);
  const shadowHighNorm = shadowCells === groundCells ? groundHighNorm : _altitudeNorm(shadowCells);
  const { worldScale, loomCurve, loomGate } = _computeWorldScaleAtAltitude(groundCells, relTokElev, cameraAltitudeFt);
  const shadowScaleMult = 1 - 0.48 * shadowHighNorm;
  const shadowAlphaMult = 1 - 0.54 * shadowHighNorm;

  const liftFactor = (0.55 + 0.45 * hoverBlend) * (1 + 0.16 * loomCurve * loomGate);
  const perspectiveOffsetY = -Math.min(g * 0.60, tsize * 0.56) * groundHighNorm * liftFactor;

  // 3) Scene camera zoom from observer altitude (`obsCells`, evaluated at reference `cameraScale = 1.0` to avoid feedback loops)
  const refObsCamAltFt = _computeCameraAltitudeFt(1.0, relObsElev, gridDist);
  const { worldScale: observerWorldScale } = _computeWorldScaleAtAltitude(obsCells, relObsElev, refObsCamAltFt);
  const cameraZoom = 1 / observerWorldScale;

  // Screen-space object scale relative to the observer's focal plane:
  const perspectiveScale = worldScale * cameraZoom;

  // 4) Optical `Depth of Field` (background + foreground + near-lens bokeh):
  //    scaled by `zoomAperture` along a C² curve without a harsh turn-on threshold.
  const zoomAperture = Math.max(0.68, Math.min(1.48, Math.pow(clampedCamScale, 0.42)));
  let bgDofBlurPx = 0;
  if (deltaCells < 0) {
    const dShift = Math.max(0, -deltaCells - 2.0);
    if (dShift > 0) {
      const dq = dShift / 10;
      bgDofBlurPx = 2.85 * Math.tanh((dq * dq * 1.35) / (0.48 + dq)) * zoomAperture;
    }
  }
  let fgPlaneBlurPx = 0;
  if (deltaCells > 0) {
    const uShift = Math.max(0, deltaCells - 5.5);
    if (uShift > 0) {
      const uq = uShift / 12;
      fgPlaneBlurPx = 0.95 * Math.tanh((uq * uq * 1.05) / (0.58 + uq)) * zoomAperture;
    }
  }
  let nearLensBlurPx = 0;
  if (rho > 0.68 && occHeightGate > 0) {
    const tBokeh = _smootherstep(Math.min(1, (rho - 0.68) / (1.05 - 0.68)));
    nearLensBlurPx = 4.0 * (tBokeh * tBokeh * 0.35 + tBokeh * 0.65) * occHeightGate;
  }
  const dofBlurPx = Math.max(bgDofBlurPx, fgPlaneBlurPx + nearLensBlurPx);

  // 5) Live radial 3D parallax relative to `cameraCenter`, intensifying as the camera zooms toward an airborne token
  let parallaxOffsetX = 0;
  let parallaxOffsetY = 0;
  if (groundCells > 0 && options.tokenCenter && options.cameraCenter) {
    const relX = (Number(options.tokenCenter.x) || 0) - (Number(options.cameraCenter.x) || 0);
    const relY = (Number(options.tokenCenter.y) || 0) - (Number(options.cameraCenter.y) || 0);
    const relDist = Math.hypot(relX, relY);
    if (relDist > 0.5) {
      const zoomParallaxGain = 0.65 + 0.85 * loomCurve;
      const pStrength = 0.14 * groundHighNorm * zoomParallaxGain;
      const maxShift = g * (0.08 + 0.54 * groundHighNorm);
      const rawShift = relDist * pStrength;
      const clampedShift = maxShift * Math.tanh(rawShift / Math.max(1, maxShift));
      parallaxOffsetX = (relX / relDist) * clampedShift;
      const rawPy = (relY / relDist) * clampedShift;
      const maxDownY = Math.max(0, -perspectiveOffsetY * 0.65 + hoverBlend * g * 0.14);
      parallaxOffsetY = rawPy <= 0
        ? rawPy
        : (maxDownY > 0 ? maxDownY * Math.tanh(rawPy / maxDownY) : 0);
    }
  }

  // 6) Extra downward Y shift for the ground shadow when the observer is high in the air
  const sharedHighCells = Math.min(shadowCells, obsCells);
  const shadowDepthNorm = _altitudeNorm(sharedHighCells);
  const shadowOffsetY = Math.min(g * 0.38, tsize * 0.34) * shadowDepthNorm;

  return {
    deltaElevation,
    deltaCells,
    groundCells,
    worldScale,
    cameraZoom,
    perspectiveScale,
    perspectiveOffsetY,
    parallaxOffsetX,
    parallaxOffsetY,
    dofBlurPx,
    shadowOffsetY,
    shadowScaleMult,
    shadowAlphaMult,
    cameraAltitudeFt,
    cameraOcclusionAlpha
  };
}

/* --------------------- Soft Ground Shadow & Token State Management --------------------- */

const _activeJumpTokens = new Set<any>();
const _hoveringTokens = new Set<any>();
const _elevAnimatingTokens = new Set<any>();
const _perspectiveTokens = new Set<any>();
const _dofFilteredObjects = new Set<any>();
let _hoverTickerAttached = false;
let _lastHoverTickMs = 0;
let _softShadowTex: any = null;
let _currentObserverElevation = 0;
let _targetObserverElevation = 0;
let _appliedAltitudeCameraZoom = 1;
let _primaryObserverToken: any = null;
let _observerElevationOverride: number | null = null;

function _readTokenRawElevation(token: any): number {
  if (!token) return 0;
  const srcElev = Number(token?.document?._source?.elevation);
  if (Number.isFinite(srcElev)) return srcElev;
  const docElev = Number(token?.document?.elevation ?? token?.elevation ?? 0);
  return Number.isFinite(docElev) ? docElev : 0;
}

function _getTokenVisualElevation(token: any): number {
  if (!token) return 0;
  if (Number.isFinite(token._ssJumpState?.elevation)) return Number(token._ssJumpState.elevation);
  if (Number.isFinite(token._ssVisualElevation)) return Number(token._ssVisualElevation);
  return _readTokenRawElevation(token);
}

function _getActiveObserverToken(): any | null {
  const controlled: any[] | undefined = (globalThis as any).canvas?.tokens?.controlled;
  if (!Array.isArray(controlled) || controlled.length === 0) return null;
  return (_primaryObserverToken && !_primaryObserverToken.destroyed && controlled.includes(_primaryObserverToken))
    ? _primaryObserverToken
    : controlled[controlled.length - 1];
}

function _resolveBaseScale(token: any): { x: number; y: number } {
  if (token?._ssJumpState?.baseScaleX != null && token?._ssJumpState?.baseScaleY != null) {
    return { x: token._ssJumpState.baseScaleX, y: token._ssJumpState.baseScaleY };
  }
  if (token?._ssPerspState?.baseScaleX != null && token?._ssPerspState?.baseScaleY != null) {
    return { x: token._ssPerspState.baseScaleX, y: token._ssPerspState.baseScaleY };
  }
  if (token?._ssBaseScaleX != null && token?._ssBaseScaleY != null) {
    return { x: token._ssBaseScaleX, y: token._ssBaseScaleY };
  }
  const sx = token?.mesh?.scale?.x ?? 1;
  const sy = token?.mesh?.scale?.y ?? 1;
  if (token) {
    token._ssBaseScaleX = sx;
    token._ssBaseScaleY = sy;
  }
  return { x: sx, y: sy };
}

/**
 * Resolve the target viewpoint altitude (`observerElevation`):
 * equals the elevation of the currently controlled token (`canvas.tokens.controlled`),
 * or the base floor elevation of the currently viewed scene level (`getViewedLevelBaseElevation()`) when none is selected.
 */
export function getTargetObserverElevation(): number {
  if (_observerElevationOverride !== null && Number.isFinite(_observerElevationOverride)) {
    return _observerElevationOverride;
  }
  const tok = _getActiveObserverToken();
  return tok ? _readTokenRawElevation(tok) : getViewedLevelBaseElevation();
}

/** Get the current (smoothly interpolated) observer viewpoint elevation in scene units (feet). */
export function getObserverElevation(): number {
  return _currentObserverElevation;
}

/** Set an explicit observer elevation override (or `null` to automatically track the controlled token). */
export function setObserverElevation(elevation: number | null, { immediate = true }: { immediate?: boolean } = {}): number {
  _observerElevationOverride = (elevation !== null && Number.isFinite(Number(elevation))) ? Number(elevation) : null;
  syncElevationPerspective({ immediate });
  return _currentObserverElevation;
}

function _getSoftShadowTexture() {
  if (_softShadowTex) return _softShadowTex;
  try {
    if (typeof document === 'undefined' || typeof PIXI === 'undefined') return null;
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    const r = size * 0.5;
    const grad = ctx.createRadialGradient(r, r, r * 0.08, r, r, r);
    grad.addColorStop(0.0, 'rgba(0, 0, 0, 0.78)');
    grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.48)');
    grad.addColorStop(0.78, 'rgba(0, 0, 0, 0.14)');
    grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    _softShadowTex = PIXI.Texture.from(cv);
    return _softShadowTex;
  } catch {
    return null;
  }
}

function _ensureJumpShadow(token: any) {
  if (!canvas?.primary || typeof PIXI === 'undefined') return null;
  let shadow = token._ssJumpShadow;
  if (shadow && !shadow.destroyed) return shadow;

  const grid = canvas?.grid?.size ?? 100;
  const w = Math.max(24, (token.document?.width ?? 1) * grid);
  const h = Math.max(24, (token.document?.height ?? 1) * grid);

  const tex = _getSoftShadowTexture();
  if (tex && typeof PIXI.Sprite === 'function') {
    shadow = new PIXI.Sprite(tex);
    shadow.anchor?.set?.(0.5, 0.5);
    shadow._ssBaseW = w * 0.86;
    shadow._ssBaseH = h * 0.46;
    shadow.width = shadow._ssBaseW;
    shadow.height = shadow._ssBaseH;
  } else {
    shadow = new PIXI.Graphics();
    const rx = w * 0.38;
    const ry = h * 0.21;
    shadow.beginFill(0x000000, 0.45);
    if (typeof shadow.drawEllipse === 'function') shadow.drawEllipse(0, 0, rx * 1.18, ry * 1.18);
    else shadow.drawRect?.(-rx * 1.18, -ry * 1.18, rx * 2.36, ry * 2.36);
    shadow.endFill();
    shadow.beginFill(0x000000, 0.65);
    if (typeof shadow.drawEllipse === 'function') shadow.drawEllipse(0, 0, rx * 0.82, ry * 0.82);
    else shadow.drawRect?.(-rx * 0.82, -ry * 0.82, rx * 1.64, ry * 1.64);
    shadow.endFill();
  }

  shadow.eventMode = 'none';
  shadow.interactiveChildren = false;
  try {
    const layers = foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS;
    if (layers) shadow.sortLayer = layers.TOKENS;
  } catch { /* fallback */ }
  shadow.elevation = getViewedLevelBaseElevation();
  shadow.sort = (token.document?.sort ?? 0) - 1;
  shadow.zIndex = (token.zIndex ?? 0) - 1;

  canvas.primary.addChild(shadow);
  token._ssJumpShadow = shadow;
  return shadow;
}

function _syncJumpShadowElevation(shadow: any, token: any, floorElev: number) {
  if (!shadow || shadow.destroyed) return;
  const targetElev = Number.isFinite(floorElev) ? floorElev : getViewedLevelBaseElevation();
  if (shadow.elevation !== targetElev) {
    shadow.elevation = targetElev;
    if (shadow.parent && 'sortDirty' in shadow.parent) {
      shadow.parent.sortDirty = true;
    }
  }
  const targetSort = (token?.document?.sort ?? 0) - 1;
  if (shadow.sort !== targetSort) {
    shadow.sort = targetSort;
    if (shadow.parent && 'sortDirty' in shadow.parent) {
      shadow.parent.sortDirty = true;
    }
  }
  shadow.zIndex = (token?.zIndex ?? 0) - 1;
}

function _hideJumpShadow(token: any) {
  const shadow = token?._ssJumpShadow;
  if (!shadow || shadow.destroyed) return;
  shadow.visible = false;
  shadow.alpha = 0;
}

function _destroyJumpShadow(token: any) {
  const shadow = token?._ssJumpShadow;
  if (!shadow) return;
  token._ssJumpShadow = null;
  try {
    if (!shadow.destroyed) {
      shadow.removeFromParent?.();
      shadow.parent?.removeChild?.(shadow);
      shadow.destroy?.();
      shadow.destroyed = true;
    }
  } catch { /* ignore */ }
}

function _getCameraCenter(): { x: number; y: number } | null {
  const pivot = (globalThis as any).canvas?.stage?.pivot;
  if (pivot && Number.isFinite(pivot.x) && Number.isFinite(pivot.y)) {
    return { x: Number(pivot.x), y: Number(pivot.y) };
  }
  return null;
}

const _dofBlurFilterPool: any[] = [];
const _dofProxyTarget: any = {
  filterArea: null,
  getBounds() { return this.filterArea; }
};

function _resolveDofFilterResolution(nativeRes: number): number {
  const r = Number(nativeRes) || 1;
  return Math.min(1, Math.max(0.5, r));
}

function _isFullScreenDofLayer(obj: any, primary: any): boolean {
  if (!obj) return false;
  if (obj === primary?.background || obj === primary?.foreground) return true;
  const name = String(obj.name || '');
  return name.startsWith('Level.');
}

function _canUseGroupedPrimaryDof(obj: any): boolean {
  const primary = (globalThis as any).canvas?.primary;
  if (!primary || obj?.parent !== primary) return false;
  const proto = Object.getPrototypeOf(primary);
  if (!proto?._ssGroupedDofPatched) return false;
  if (primary._mask) return true;
  return Array.isArray(primary.filters) && primary.filters.some((f: any) => Boolean(f?.enabled));
}

function _clearIndividualDofFilter(obj: any) {
  const existing = obj._ssDofBlurFilter;
  if (existing) {
    existing.blur = 0;
    if (Array.isArray(obj.filters)) {
      const next = obj.filters.filter((f: any) => f !== existing);
      obj.filters = next.length > 0 ? next : null;
    }
  }
  if (obj._ssSetFilterArea) {
    obj.filterArea = null;
    obj._ssSetFilterArea = false;
  }
}

function _getPooledDofBlurFilter(poolIdx: number, blurPx: number, nativeRes: number): any | null {
  const BlurCls = (globalThis as any).PIXI?.BlurFilter ?? (globalThis as any).PIXI?.filters?.BlurFilter;
  if (!BlurCls) return null;
  let filter = _dofBlurFilterPool[poolIdx];
  if (!filter) {
    try {
      filter = new BlurCls();
      filter.quality = 2;
      _dofBlurFilterPool[poolIdx] = filter;
    } catch {
      return null;
    }
  }
  const targetRes = _resolveDofFilterResolution(nativeRes);
  if (filter.resolution !== targetRes) filter.resolution = targetRes;
  if (filter.quality !== 2) filter.quality = 2;
  if (Math.abs((Number(filter.blur) || 0) - blurPx) > 0.02) {
    filter.blur = blurPx;
  }
  return filter;
}

function _renderPrimaryChildrenWithGroupedDof(primary: any, renderer: any) {
  const children: any[] = primary.children;
  const len = children.length;
  const screenRect = renderer?.screen;
  const nativeRes = Number(renderer?.resolution) || 1;
  const sw = Number(screenRect?.width) || 0;
  const sh = Number(screenRect?.height) || 0;
  let poolIdx = 0;
  let i = 0;

  while (i < len) {
    const ch = children[i];
    if (!ch || !ch.visible || !ch.renderable || ch.worldAlpha <= 0) {
      i++;
      continue;
    }
    const blur = Number(ch._ssDofBlurPx) || 0;
    if (blur <= 0.10) {
      ch.render(renderer);
      i++;
      continue;
    }

    const qBlur = Math.round(blur * 10) / 10;
    let visibleCount = 1;
    let j = i + 1;
    while (j < len) {
      const nch = children[j];
      if (!nch || !nch.visible || !nch.renderable || nch.worldAlpha <= 0) {
        j++;
        continue;
      }
      const nb = Number(nch._ssDofBlurPx) || 0;
      if (nb <= 0.10 || Math.abs(nb - qBlur) > 0.08) break;
      visibleCount++;
      j++;
    }

    let filterArea = screenRect;
    let offscreenSingle = false;
    if (visibleCount === 1 && !_isFullScreenDofLayer(ch, primary) && typeof ch.getBounds === 'function') {
      const bounds = ch.getBounds(true);
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        if (sw > 0 && sh > 0 && (bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0 || bounds.x >= sw || bounds.y >= sh)) {
          offscreenSingle = true;
        } else {
          filterArea = bounds;
        }
      }
    }

    const filter = (!offscreenSingle && filterArea)
      ? _getPooledDofBlurFilter(poolIdx++, qBlur, nativeRes)
      : null;

    if (!filter) {
      for (let k = i; k < j; k++) {
        const child = children[k];
        if (child && child.visible && child.renderable && child.worldAlpha > 0) {
          child.render(renderer);
        }
      }
      i = j;
      continue;
    }

    _dofProxyTarget.filterArea = filterArea;
    renderer.batch.flush();
    renderer.filter.push(_dofProxyTarget, [filter]);
    try {
      for (let k = i; k < j; k++) {
        const child = children[k];
        if (child && child.visible && child.renderable && child.worldAlpha > 0) {
          child.render(renderer);
        }
      }
    } finally {
      renderer.batch.flush();
      renderer.filter.pop();
    }
    i = j;
  }
}

function _setObjectDofBlur(obj: any, blurPx: number, useScreenFilterArea: boolean = false) {
  if (!obj) return;
  if (obj.destroyed) {
    _dofFilteredObjects.delete(obj);
    return;
  }
  const BlurCls = (globalThis as any).PIXI?.BlurFilter ?? (globalThis as any).PIXI?.filters?.BlurFilter;
  if (blurPx <= 0.10 || !BlurCls) {
    obj._ssDofBlurPx = 0;
    _clearIndividualDofFilter(obj);
    _dofFilteredObjects.delete(obj);
    return;
  }

  obj._ssDofBlurPx = blurPx;
  _dofFilteredObjects.add(obj);

  if (_canUseGroupedPrimaryDof(obj)) {
    if (obj._ssDofBlurFilter || obj._ssSetFilterArea) {
      _clearIndividualDofFilter(obj);
    }
    return;
  }

  const nativeRes = Number((globalThis as any).canvas?.app?.renderer?.resolution) || 1;
  const targetRes = _resolveDofFilterResolution(nativeRes);
  let filter = obj._ssDofBlurFilter;
  if (!filter) {
    try {
      filter = new BlurCls();
      filter.quality = 2;
      filter.resolution = targetRes;
      obj._ssDofBlurFilter = filter;
    } catch {
      return;
    }
  } else {
    if (filter.resolution !== targetRes) filter.resolution = targetRes;
    if (filter.quality !== 2) filter.quality = 2;
  }
  if (Math.abs((Number(filter.blur) || 0) - blurPx) > 0.02) {
    filter.blur = blurPx;
  }
  if (!Array.isArray(obj.filters)) {
    obj.filters = [filter];
  } else if (!obj.filters.includes(filter)) {
    obj.filters = [...obj.filters, filter];
  }
  if (useScreenFilterArea) {
    const screenRect = (globalThis as any).canvas?.app?.renderer?.screen;
    if (screenRect && !obj.filterArea) {
      obj.filterArea = screenRect;
      obj._ssSetFilterArea = true;
    }
  }
}

function _clearAllDofFilters() {
  for (const obj of Array.from(_dofFilteredObjects)) {
    _setObjectDofBlur(obj, 0, false);
  }
  _dofFilteredObjects.clear();
  for (const f of _dofBlurFilterPool) {
    try { f?.destroy?.(); } catch { /* ignore */ }
  }
  _dofBlurFilterPool.length = 0;
}

let _emptyHitAreaSingleton: any = null;

function _getEmptyHitArea(): any {
  if (_emptyHitAreaSingleton) return _emptyHitAreaSingleton;
  const RectCls = (globalThis as any).PIXI?.Rectangle;
  _emptyHitAreaSingleton = RectCls
    ? new RectCls(0, 0, 0, 0)
    : { x: 0, y: 0, width: 0, height: 0, contains() { return false; } };
  return _emptyHitAreaSingleton;
}

function _setSubContainerBoxTransform(sub: any, x: number, y: number, scale: number) {
  if (!sub || sub.destroyed) return;
  sub.position?.set?.(x, y);
  sub.x = x;
  sub.y = y;
  sub.scale?.set?.(scale, scale);
}

/**
 * Check whether point `(px, py)` (in `Token`-local coordinates) hits a clickable icon inside `token.effects`
 * (e.g. `dnd5e`'s native `falling.svg` icon from `Token5e#_drawEffect` -> `plummet()`),
 * preventing `PIXI.EventBoundary.hitPruneFn` from pruning clicks on status icons even on circular/hex tokens.
 */
function _effectsInteractiveIconContainsLocal(token: any, px: number, py: number): boolean {
  const eff = token?.effects;
  if (!eff || eff.destroyed || eff.visible === false || (eff.alpha ?? 1) <= 0.01) return false;
  const kids: any[] | undefined = eff.children;
  if (!Array.isArray(kids) || kids.length === 0) return false;
  const ex = Number(eff.x) || 0;
  const ey = Number(eff.y) || 0;
  const esx = Number(eff.scale?.x) || 1;
  const esy = Number(eff.scale?.y) || 1;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k || k.destroyed || k.visible === false) continue;
    if (k.eventMode !== 'static' && k.eventMode !== 'dynamic') continue;
    const kw = (Number(k.width) || 24) * esx;
    const kh = (Number(k.height) || 24) * esy;
    const kx = ex + (Number(k.x) || 0) * esx - (Number(k.anchor?.x) || 0) * kw;
    const ky = ey + (Number(k.y) || 0) * esy - (Number(k.anchor?.y) || 0) * kh;
    if (px >= kx - 2 && px <= kx + kw + 2 && py >= ky - 2 && py <= ky + kh + 2) {
      return true;
    }
  }
  return false;
}

function _attachEffectsAwareContains(hitShape: any, token: any): any {
  if (!hitShape || hitShape._ssEffectsAwareToken === token) return hitShape;
  const protoContains = hitShape._ssRawContains
    ?? Object.getPrototypeOf(hitShape)?.contains
    ?? hitShape.contains;
  if (typeof protoContains !== 'function') return hitShape;
  hitShape._ssRawContains = protoContains;
  hitShape._ssEffectsAwareToken = token;
  hitShape.contains = function (px: number, py: number) {
    return Boolean(protoContains.call(this, px, py)) || _effectsInteractiveIconContainsLocal(token, px, py);
  };
  return hitShape;
}

/**
 * Synchronize the token's interactive PIXI `token.hitArea` (without mutating logical `token.shape`)
 * with its rendered screen offset `(localX, localY)` and elevation-perspective `boxScale`.
 */
function _syncTokenVisualHitbox(
  token: any,
  localX: number,
  localY: number,
  boxScale: number,
  tokenW: number,
  tokenH: number,
  occlusionAlpha: number
) {
  if (!token || token.destroyed) return;
  if (occlusionAlpha <= 0.01) {
    if (token._ssOrigHitArea === undefined && !token.shape && token.hitArea) {
      token._ssOrigHitArea = token.hitArea;
    }
    token._ssHitboxOffset = null;
    token._ssHitboxRect = { x: localX, y: localY, width: 0, height: 0, scale: boxScale, occluded: true };
    token.hitArea = _getEmptyHitArea();
    return;
  }

  const isNeutral = Math.abs(localX) <= 0.05 && Math.abs(localY) <= 0.05 && Math.abs(boxScale - 1) <= 0.001;
  if (isNeutral) {
    token._ssHitboxOffset = null;
    token._ssHitboxRect = null;
    if (token.shape) {
      token.hitArea = token.shape;
    } else if (token._ssOrigHitArea !== undefined) {
      token.hitArea = token._ssOrigHitArea;
      token._ssOrigHitArea = undefined;
    }
    return;
  }

  if (token._ssOrigHitArea === undefined && !token.shape && token.hitArea) {
    token._ssOrigHitArea = token.hitArea;
  }
  const scaledW = tokenW * boxScale;
  const scaledH = tokenH * boxScale;
  token._ssHitboxOffset = {
    x: localX + (scaledW - tokenW) * 0.5,
    y: localY + (scaledH - tokenH) * 0.5
  };
  token._ssHitboxRect = {
    x: localX,
    y: localY,
    width: scaledW,
    height: scaledH,
    scale: boxScale,
    occluded: false
  };

  const baseShape = token.shape;
  if (baseShape && Array.isArray(baseShape.points)) {
    const srcPts: number[] = baseShape.points;
    let poly = token._ssHitPolygon;
    if (!poly || poly.constructor !== baseShape.constructor) {
      poly = new baseShape.constructor(new Array(srcPts.length).fill(0));
      token._ssHitPolygon = poly;
    }
    const pts: number[] = poly.points;
    pts.length = srcPts.length;
    for (let i = 0; i < srcPts.length; i += 2) {
      pts[i] = localX + srcPts[i] * boxScale;
      pts[i + 1] = localY + srcPts[i + 1] * boxScale;
    }
    poly.clearCache?.();
    token.hitArea = _attachEffectsAwareContains(poly, token);
    return;
  }

  if (baseShape && typeof baseShape.radius === 'number') {
    let circle = token._ssHitCircle;
    if (!circle || circle.constructor !== baseShape.constructor) {
      circle = new baseShape.constructor(0, 0, 1);
      token._ssHitCircle = circle;
    }
    circle.x = localX + (Number(baseShape.x) || 0) * boxScale;
    circle.y = localY + (Number(baseShape.y) || 0) * boxScale;
    circle.radius = baseShape.radius * boxScale;
    token.hitArea = _attachEffectsAwareContains(circle, token);
    return;
  }

  if (baseShape && typeof baseShape.width === 'number' && typeof baseShape.height === 'number') {
    let box = token._ssHitBox;
    if (!box || box.constructor !== baseShape.constructor) {
      box = new baseShape.constructor(0, 0, 1, 1);
      token._ssHitBox = box;
    }
    box.x = localX + (Number(baseShape.x) || 0) * boxScale;
    box.y = localY + (Number(baseShape.y) || 0) * boxScale;
    box.width = baseShape.width * boxScale;
    box.height = baseShape.height * boxScale;
    token.hitArea = _attachEffectsAwareContains(box, token);
    return;
  }

  let fb = token._ssHitFallbackRect;
  if (!fb) {
    const RectCls = (globalThis as any).PIXI?.Rectangle;
    fb = RectCls
      ? new RectCls(0, 0, 1, 1)
      : {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          contains(px: number, py: number) {
            return px >= this.x && px <= this.x + this.width && py >= this.y && py <= this.y + this.height;
          }
        };
    token._ssHitFallbackRect = fb;
  }
  fb.x = localX;
  fb.y = localY;
  fb.width = scaledW;
  fb.height = scaledH;
  token.hitArea = _attachEffectsAwareContains(fb, token);
}

/**
 * Get the current world-space bounds of the token's visual hitbox on the canvas (accounting for elevation, hover/fall lift,
 * 3D camera parallax, and `worldScale` elevation scaling).
 */
export function getTokenVisualBounds(token: any): {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  scale: number;
  occluded: boolean;
} {
  const grid = (globalThis as any).canvas?.grid?.size ?? 100;
  const docX = Number(token?.position?.x ?? token?.document?.x) || 0;
  const docY = Number(token?.position?.y ?? token?.document?.y) || 0;
  const w = Number(token?.w) || ((Math.abs(token?.document?.width ?? 1) || 1) * grid);
  const h = Number(token?.h) || ((Math.abs(token?.document?.height ?? 1) || 1) * grid);
  const hb = token?._ssHitboxRect;
  if (!hb) {
    return {
      x: docX,
      y: docY,
      width: w,
      height: h,
      centerX: docX + w * 0.5,
      centerY: docY + h * 0.5,
      scale: 1,
      occluded: false
    };
  }
  const vx = docX + hb.x;
  const vy = docY + hb.y;
  return {
    x: vx,
    y: vy,
    width: hb.width,
    height: hb.height,
    centerX: vx + hb.width * 0.5,
    centerY: vy + hb.height * 0.5,
    scale: hb.scale,
    occluded: Boolean(hb.occluded)
  };
}

function _applyTokenOcclusionAlpha(
  token: any,
  occlusionAlpha: number,
  centerOffX: number = 0,
  centerOffY: number = 0,
  boxScale: number = 1
) {
  if (!token || token.destroyed) return;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(occlusionAlpha) ? occlusionAlpha : 1));
  token._ssOcclusionAlpha = clamped;
  const docAlpha = Number.isFinite(Number(token.document?.alpha)) ? Number(token.document.alpha) : 1;
  const mesh = token.mesh;
  if (mesh && !mesh.destroyed) {
    mesh.alpha = docAlpha * clamped;
    mesh.visible = clamped > 0.01 && (token.visible ?? true) && !token.document?.hidden;
  }

  const cv = (globalThis as any).canvas;
  const grid = cv?.grid?.size ?? 100;
  const tokenW = Number(token.w) || ((Math.abs(token.document?.width ?? 1) || 1) * grid);
  const tokenH = Number(token.h) || ((Math.abs(token.document?.height ?? 1) || 1) * grid);
  const s = Math.max(0.1, Number.isFinite(boxScale) ? boxScale : 1);
  const localX = tokenW * 0.5 * (1 - s) + centerOffX;
  const localY = tokenH * 0.5 * (1 - s) + centerOffY;

  _syncTokenVisualHitbox(token, localX, localY, s, tokenW, tokenH, clamped);

  const subVisible = clamped > 0.01;
  const borderThickness = (globalThis as any).CONFIG?.Canvas?.objectBorderThickness ?? 4;
  const uiScale = cv?.dimensions?.uiScale ?? 1;
  const labelMargin = borderThickness * 0.75 * uiScale;
  const centerLocalX = tokenW * 0.5 + centerOffX;

  if (token.tooltip && !token.tooltip.destroyed) {
    token.tooltip.alpha = clamped;
    const tooltipY = localY - labelMargin;
    token.tooltip.position?.set?.(centerLocalX, tooltipY);
    token.tooltip.x = centerLocalX;
    token.tooltip.y = tooltipY;
    if (token.levelIndicator && !token.levelIndicator.destroyed) {
      token.levelIndicator.alpha = clamped;
      token.levelIndicator.x = centerLocalX;
      token.levelIndicator.y = tooltipY - (token.tooltip.text ? (token.tooltip.height || 0) : 0);
    }
  } else if (token.levelIndicator && !token.levelIndicator.destroyed) {
    token.levelIndicator.alpha = clamped;
  }

  if (token.nameplate && !token.nameplate.destroyed) {
    token.nameplate.alpha = clamped;
    const nameplateY = localY + tokenH * s + labelMargin;
    token.nameplate.position?.set?.(centerLocalX, nameplateY);
    token.nameplate.x = centerLocalX;
    token.nameplate.y = nameplateY;
  }

  if (token.effects && !token.effects.destroyed) {
    token.effects.alpha = clamped;
    token.effects.visible = subVisible;
    _setSubContainerBoxTransform(token.effects, localX, localY, s);
  }
  if (token.border && !token.border.destroyed) {
    token.border.alpha = clamped;
    _setSubContainerBoxTransform(token.border, localX, localY, s);
  }
  if (token.bars && !token.bars.destroyed) {
    token.bars.alpha = clamped;
    _setSubContainerBoxTransform(token.bars, localX, localY, s);
  }
  if (token.targetArrows && !token.targetArrows.destroyed) {
    token.targetArrows.alpha = clamped;
    _setSubContainerBoxTransform(token.targetArrows, localX, localY, s);
  }
  if (token.targetPips && !token.targetPips.destroyed) {
    token.targetPips.alpha = clamped;
    _setSubContainerBoxTransform(token.targetPips, localX, localY, s);
  }

  const tokenHud = cv?.hud?.token;
  if (tokenHud?.rendered && tokenHud.object === token && typeof tokenHud.setPosition === 'function') {
    const lastHud = token._ssLastHudSync;
    if (
      !lastHud ||
      Math.abs(lastHud.x - localX) > 0.35 ||
      Math.abs(lastHud.y - localY) > 0.35 ||
      Math.abs(lastHud.s - s) > 0.003
    ) {
      token._ssLastHudSync = { x: localX, y: localY, s };
      try {
        tokenHud.setPosition();
      } catch { /* ignore */ }
    }
  }
}

let _inInternalAltitudePan = false;

function _neutralElevationPerspective(tokElev: number, obsElev: number, gridDistance: number): ElevationPerspectiveState {
  const gridDist = Math.max(0.5, Number(gridDistance) || 5);
  const deltaElevation = (Number(tokElev) || 0) - (Number(obsElev) || 0);
  return {
    deltaElevation,
    deltaCells: deltaElevation / gridDist,
    groundCells: 0,
    worldScale: 1,
    cameraZoom: 1,
    perspectiveScale: 1,
    perspectiveOffsetY: 0,
    parallaxOffsetX: 0,
    parallaxOffsetY: 0,
    dofBlurPx: 0,
    shadowOffsetY: 0,
    shadowScaleMult: 1,
    shadowAlphaMult: 1,
    cameraAltitudeFt: 92,
    cameraOcclusionAlpha: 1
  };
}

/**
 * Update elevation-driven camera zoom (`canvas.stage.scale`) and scene background `Depth of Field`.
 * Selecting a high-altitude token (`60..135 ft`) smoothly zooms the camera out (`cameraZoom < 1`)
 * and applies soft depth defocus to the map below (`canvas.primary.background`, tiles, and ground-level objects).
 * If the user manually zooms the camera in below the observer's altitude (`observerPersp.cameraOcclusionAlpha -> 0`),
 * ground defocus smoothly clears because the camera has descended to ground level.
 */
function _updateSceneCameraAndDepthOfField(observerElevation: number, applyCameraZoom: boolean = true) {
  const vertEnabled = getTokenMovementSetting('vertical');
  const zoomEnabled = vertEnabled && getTokenMovementSetting('verticalCameraZoom');
  const blurEnabled = vertEnabled && getTokenMovementSetting('verticalBlur');
  const cv = (globalThis as any).canvas;
  const grid = cv?.grid?.size ?? 100;
  const sceneDist = Number(cv?.scene?.grid?.distance ?? cv?.grid?.distance) || 5;
  const baseElev = getViewedLevelBaseElevation();
  const primary = cv?.primary;
  const bgElev = Number.isFinite(Number(primary?.background?.elevation))
    ? Number(primary.background.elevation)
    : baseElev;
  const groundPersp = computeElevationPerspective(bgElev, observerElevation, {
    gridSize: grid,
    gridDistance: sceneDist,
    tokenSize: grid,
    hoverBlend: 0,
    baseElevation: baseElev
  });
  const observerPersp = observerElevation > baseElev + 0.05
    ? computeElevationPerspective(observerElevation, observerElevation, {
        gridSize: grid,
        gridDistance: sceneDist,
        tokenSize: grid,
        hoverBlend: 1,
        baseElevation: baseElev
      })
    : null;
  const dofAttenuation = observerPersp ? observerPersp.cameraOcclusionAlpha : 1;

  // 1) Smooth camera zoom scaling (`canvas.stage.scale`) relative to observer altitude
  if (applyCameraZoom || (!zoomEnabled && Math.abs((_appliedAltitudeCameraZoom || 1) - 1) > 0.0004)) {
    const desiredCamZoom = zoomEnabled ? groundPersp.cameraZoom : 1;
    if (canZoomZoomStage(cv)) {
      const prevApplied = _appliedAltitudeCameraZoom || 1;
      const ratio = desiredCamZoom / prevApplied;
      if (Math.abs(ratio - 1) > 0.0004) {
        const curScale = Number(cv.stage.scale.x) || 1;
        const nextScale = curScale * ratio;
        if (typeof window !== 'undefined' && (window as any).__sstTargetScale !== undefined) {
          (window as any).__sstTargetScale *= ratio;
        }
        _inInternalAltitudePan = true;
        try {
          cv.pan({
            x: cv.stage.pivot.x,
            y: cv.stage.pivot.y,
            scale: nextScale,
            __sstInternal: true
          });
        } catch { /* ignore */ } finally {
          _inInternalAltitudePan = false;
        }
        const actualScale = Number(cv.stage.scale.x) || curScale;
        _appliedAltitudeCameraZoom = prevApplied * (actualScale / curScale);
      }
    } else {
      _appliedAltitudeCameraZoom = 1;
    }
  }

  // 2) `Depth of Field` blur for the scene background (`canvas.primary.background`), level backgrounds/foregrounds, doors, and tiles
  if (!blurEnabled) {
    if (_dofFilteredObjects.size > 0) _clearAllDofFilters();
    return;
  }
  if (!primary) return;

  if (primary.background && !primary.background.destroyed && primary.background.visible !== false) {
    _setObjectDofBlur(primary.background, groundPersp.dofBlurPx * dofAttenuation, true);
  }
  if (primary.foreground && !primary.foreground.destroyed && primary.foreground.visible) {
    const fgElev = Number.isFinite(Number(primary.foreground.elevation)) ? Number(primary.foreground.elevation) : baseElev;
    const fgPersp = computeElevationPerspective(fgElev, observerElevation, {
      gridSize: grid,
      gridDistance: sceneDist,
      tokenSize: grid,
      hoverBlend: 0,
      baseElevation: baseElev
    });
    _setObjectDofBlur(primary.foreground, fgPersp.dofBlurPx * dofAttenuation, true);
  } else if (primary.foreground && (primary.foreground._ssDofBlurFilter || primary.foreground._ssDofBlurPx)) {
    _setObjectDofBlur(primary.foreground, 0, false);
  }
  const children: any[] | undefined = primary.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const ch = children[i];
      if (!ch || ch.destroyed || ch === primary.background || ch === primary.foreground) continue;
      if (ch.visible === false) {
        if (ch._ssDofBlurFilter || ch._ssDofBlurPx) _setObjectDofBlur(ch, 0, false);
        continue;
      }
      const chName = String(ch.name || '');
      if (
        chName.startsWith('Tile.') ||
        chName.startsWith('Level.') ||
        chName.startsWith('Door.') ||
        chName.startsWith('showstopperBlood')
      ) {
        const chElev = Number.isFinite(Number(ch.elevation)) ? Number(ch.elevation) : baseElev;
        const chPersp = Math.abs(chElev - bgElev) < 0.01
          ? groundPersp
          : computeElevationPerspective(chElev, observerElevation, {
              gridSize: grid,
              gridDistance: sceneDist,
              tokenSize: grid,
              hoverBlend: 0,
              baseElevation: baseElev
            });
        _setObjectDofBlur(ch, chPersp.dofBlurPx * dofAttenuation, true);
      }
    }
  }
  if (_dofFilteredObjects.size > 0) {
    for (const obj of Array.from(_dofFilteredObjects)) {
      if (!obj || obj.destroyed) _dofFilteredObjects.delete(obj);
    }
  }
}

function canZoomZoomStage(cv: any): boolean {
  return Boolean(cv?.stage?.scale && cv?.stage?.pivot && typeof cv?.pan === 'function');
}

/** Apply stationary elevation perspective to a token that does NOT currently have an active jump/fly/walk state (`!token._ssJumpState`). */
function _applyStationaryPerspectiveToToken(token: any, persp?: ElevationPerspectiveState) {
  const mesh = token?.mesh;
  if (!token || token.destroyed || token.isPreview || !mesh || mesh.destroyed) return;
  if (token._ssJumpState) return;
  if (!getTokenMovementSetting('vertical')) {
    if (token._ssPerspState || token._ssJumpShadow || mesh._ssDofBlurFilter || mesh._ssDofBlurPx) {
      _clearStationaryPerspectiveForToken(token);
    }
    return;
  }

  const cv = (globalThis as any).canvas;
  const grid = cv?.grid?.size ?? 100;
  const sceneDist = Number(cv?.scene?.grid?.distance ?? cv?.grid?.distance) || 5;
  const wGrids = Math.abs(token.document?.width ?? 1);
  const hGrids = Math.abs(token.document?.height ?? 1);
  const tokenSize = Math.max(wGrids, hGrids) * grid;
  const tokElev = _getTokenVisualElevation(token);
  const baseElev = getViewedLevelBaseElevation();
  const rawFloorElev = getTokenSupportElevation(token, tokElev);
  const surfElev = Number.isFinite(rawFloorElev) ? rawFloorElev : baseElev;
  const clearance = tokElev - surfElev;
  const isGrounded = clearance <= 0.05 && (Number(token._ssHoverBlend) || 0) <= 0.01;
  const linearCenter = token.center ?? {
    x: (token.document?.x ?? 0) + ((token.w ?? 100) * 0.5),
    y: (token.document?.y ?? 0) + ((token.h ?? 100) * 0.5)
  };
  const hasLiveStage = canZoomZoomStage(cv);
  const liveCamCenter = hasLiveStage ? _getCameraCenter() : null;
  const p = persp ?? computeElevationPerspective(tokElev, _currentObserverElevation, {
    gridSize: grid,
    gridDistance: sceneDist,
    tokenSize,
    baseElevation: baseElev,
    surfaceElevation: surfElev,
    isGroundedOnSurface: isGrounded,
    hoverBlend: clearance > 0.05 ? 1 : 0,
    tokenCenter: liveCamCenter ? linearCenter : null,
    cameraCenter: liveCamCenter
  });

  // When the scene supports live camera zoom (`canvas.pan`), scale the mesh by `worldScale`
  // (keeping grounded tokens `1.0x` aligned with map cells while `cameraZoom` scales the stage together).
  // In headless tests without `canvas.pan`, fall back to composite `perspectiveScale`.
  const effectiveMeshScale = hasLiveStage ? p.worldScale : p.perspectiveScale;
  const totalOffX = p.parallaxOffsetX;
  const totalOffY = p.perspectiveOffsetY + p.parallaxOffsetY;
  const isObserverSelf = Boolean(token.controlled || token === _primaryObserverToken);

  const obsOccAlpha = _currentObserverElevation > baseElev + 0.05
    ? computeElevationPerspective(_currentObserverElevation, _currentObserverElevation, {
        gridSize: grid,
        gridDistance: sceneDist,
        tokenSize,
        hoverBlend: 1,
        baseElevation: baseElev
      }).cameraOcclusionAlpha
    : 1;
  const blurEnabled = getTokenMovementSetting('verticalBlur');
  const meshBlurPx = !blurEnabled || p.cameraOcclusionAlpha <= 0.01
    ? 0
    : (isObserverSelf
        ? (p.cameraOcclusionAlpha < 0.99 ? p.dofBlurPx : 0)
        : (p.deltaElevation > 0 ? p.dofBlurPx : p.dofBlurPx * obsOccAlpha));
  _setObjectDofBlur(mesh, meshBlurPx, false);

  if (
    Math.abs(effectiveMeshScale - 1) <= 0.001 &&
    Math.abs(totalOffX) <= 0.05 &&
    Math.abs(totalOffY) <= 0.05 &&
    p.cameraOcclusionAlpha >= 0.999 &&
    meshBlurPx <= 0.10 &&
    clearance <= 0.05
  ) {
    if (token._ssPerspState) _clearStationaryPerspectiveForToken(token);
    return;
  }

  const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);
  token._ssPerspState = {
    baseScaleX,
    baseScaleY,
    scale: effectiveMeshScale,
    offsetX: totalOffX,
    offsetY: totalOffY,
    occlusionAlpha: p.cameraOcclusionAlpha
  };
  token._ssPerspScale = effectiveMeshScale;
  token._ssPerspOffset = { x: totalOffX, y: totalOffY };
  _perspectiveTokens.add(token);

  const meshAnimOffX = Number(token._ssMeshAnimOffset?.x) || 0;
  const meshAnimOffY = Number(token._ssMeshAnimOffset?.y) || 0;
  const meshScaleX = Math.max(0.15, 1 + (Number(token._ssMeshAnimOffset?.scaleX) || 0));
  const meshScaleY = Math.max(0.15, 1 + (Number(token._ssMeshAnimOffset?.scaleY) || 0));
  const meshAngle = Number(token._ssMeshAnimOffset?.angle) || 0;
  mesh.position?.set?.(
    linearCenter.x + totalOffX + meshAnimOffX,
    linearCenter.y + totalOffY + meshAnimOffY
  );
  mesh.scale?.set?.(
    baseScaleX * effectiveMeshScale * meshScaleX,
    baseScaleY * effectiveMeshScale * meshScaleY
  );
  if (meshAngle !== 0) {
    const baseAngle = token.document?.lockRotation ? 0 : (token.document?.rotation ?? 0);
    mesh.angle = baseAngle + meshAngle;
  }
  _applyTokenOcclusionAlpha(token, p.cameraOcclusionAlpha, totalOffX, totalOffY, effectiveMeshScale);

  // When elevated above its supporting surface (`clearance > 0.05`), render its ground shadow on that floor below even in `'walk'` mode
  if (clearance > 0.05) {
    const shadow = _ensureJumpShadow(token);
    if (shadow && !shadow.destroyed) {
      _syncJumpShadowElevation(shadow, token, Math.min(tokElev, surfElev));
      const tokenH = token.h ?? ((token.document?.height ?? 1) * grid);
      const groundX = linearCenter.x;
      const groundY = linearCenter.y + tokenH * 0.25 + p.shadowOffsetY;
      shadow.position.set(groundX, groundY);
      const sc = 0.72 * p.shadowScaleMult;
      if (shadow._ssBaseW && shadow._ssBaseH) {
        shadow.width = shadow._ssBaseW * sc;
        shadow.height = shadow._ssBaseH * sc;
      } else {
        shadow.scale.set(sc, sc);
      }
      const shadowCells = Math.max(0, clearance) / Math.max(0.5, sceneDist);
      const lowAltShadowFade = Math.min(1, Math.max(0, shadowCells / 1.5));
      const shAlpha = 0.25 * p.shadowAlphaMult * lowAltShadowFade;
      shadow.alpha = shAlpha;
      shadow.visible = shAlpha > 0.01 && (token.visible ?? true) && !token.document?.hidden;
    }
  } else {
    _hideJumpShadow(token);
  }

  try {
    (globalThis as any).showstopper?.dynamicItems?.manager?._updateTokenDisplayPositions?.(token);
  } catch { /* ignore */ }

  _syncDragPreviewFromToken(token);
}

function _clearStationaryPerspectiveForToken(token: any) {
  if (!token) return;
  const prev = token._ssPerspState;
  token._ssPerspState = null;
  if (!token._ssJumpState) {
    token._ssPerspScale = undefined;
    token._ssPerspOffset = undefined;
  }
  _perspectiveTokens.delete(token);
  if (token.mesh) _setObjectDofBlur(token.mesh, 0, false);
  if (!token._ssJumpState) {
    _hideJumpShadow(token);
    _applyTokenOcclusionAlpha(token, 1, 0, 0, 1);
    token._ssOcclusionAlpha = undefined;
  }
  if (!prev || token._ssJumpState) return;

  if (token.mesh && !token.mesh.destroyed) {
    const linearCenter = token.center ?? {
      x: (token.document?.x ?? 0) + ((token.w ?? 100) * 0.5),
      y: (token.document?.y ?? 0) + ((token.h ?? 100) * 0.5)
    };
    const meshAnimOffX = Number(token._ssMeshAnimOffset?.x) || 0;
    const meshAnimOffY = Number(token._ssMeshAnimOffset?.y) || 0;
    token.mesh.position?.set?.(linearCenter.x + meshAnimOffX, linearCenter.y + meshAnimOffY);
    if (prev.baseScaleX != null && prev.baseScaleY != null) {
      token.mesh.scale?.set?.(prev.baseScaleX, prev.baseScaleY);
    }
  }
  try {
    (globalThis as any).showstopper?.dynamicItems?.manager?._updateTokenDisplayPositions?.(token);
  } catch { /* ignore */ }
}

function _updateSceneTokensPerspective(applyCameraZoom: boolean = true) {
  _updateSceneCameraAndDepthOfField(_currentObserverElevation, applyCameraZoom);
  const placeables: any[] | undefined = (globalThis as any).canvas?.tokens?.placeables;
  if (Array.isArray(placeables)) {
    for (const tok of placeables) {
      if (!tok || tok.destroyed || tok.isPreview || !tok.mesh || tok.mesh.destroyed) continue;
      if (tok._ssJumpState) {
        applyJumpStateToToken(tok);
      } else {
        _applyStationaryPerspectiveToToken(tok);
      }
    }
  }
  for (const tok of Array.from(_perspectiveTokens)) {
    if (!tok || tok.destroyed || tok._ssJumpState) {
      _perspectiveTokens.delete(tok);
      continue;
    }
    if (!Array.isArray(placeables) || !placeables.includes(tok)) {
      _applyStationaryPerspectiveToToken(tok);
    }
  }
}

/** On camera pan/zoom (`canvasPan`), refresh 3D looming (`worldScale`), bokeh, altitude fade (`cameraOcclusionAlpha`), and 3D parallax. */
function _onCanvasPanPerspective() {
  if (_inInternalAltitudePan) return;
  if (Math.abs(_currentObserverElevation - getViewedLevelBaseElevation()) > 0.05 || _dofFilteredObjects.size > 0) {
    _updateSceneTokensPerspective(false);
    return;
  }
  for (const tok of _hoveringTokens) {
    if (tok && !tok.destroyed && tok._ssJumpState) applyJumpStateToToken(tok);
  }
  for (const tok of _activeJumpTokens) {
    if (tok && !tok.destroyed && tok._ssJumpState && !_hoveringTokens.has(tok)) {
      applyJumpStateToToken(tok);
    }
  }
  for (const tok of _perspectiveTokens) {
    if (tok && !tok.destroyed && !tok._ssJumpState) _applyStationaryPerspectiveToToken(tok);
  }
}

/**
 * Synchronize relative elevation perspective across all tokens and the scene relative to the currently controlled token.
 * Selecting an elevated token (e.g. `60 ft`) or changing elevation smoothly zooms the camera out and updates scene Depth of Field.
 */
export function syncElevationPerspective({ immediate = false }: { immediate?: boolean } = {}) {
  _targetObserverElevation = getTargetObserverElevation();
  const ticker = _getTicker();
  if (immediate || !ticker || typeof ticker.add !== 'function') {
    for (const tok of Array.from(_elevAnimatingTokens)) {
      if (tok && !tok.destroyed) {
        const raw = _readTokenRawElevation(tok);
        tok._ssVisualElevation = raw;
        tok._ssTargetElevation = raw;
      }
    }
    _elevAnimatingTokens.clear();
    _currentObserverElevation = _targetObserverElevation;
    _updateSceneTokensPerspective(true);
    return;
  }
  if (Math.abs(_targetObserverElevation - _currentObserverElevation) > 0.01 || _elevAnimatingTokens.size > 0) {
    _ensureHoverTicker();
  } else {
    _currentObserverElevation = _targetObserverElevation;
    _updateSceneTokensPerspective(true);
  }
}

/** Apply the token's active jump/flight state and elevation perspective to `token.mesh` and its ground shadow. */
export function applyJumpStateToToken(token: any) {
  const state = token?._ssJumpState;
  const mesh = token?.mesh;
  if (!state || !mesh || mesh.destroyed) return;
  if (token._ssPerspState) {
    token._ssPerspState = null;
    _perspectiveTokens.delete(token);
  }

  const cv = (globalThis as any).canvas;
  const grid = cv?.grid?.size ?? 100;
  const sceneDist = Number(cv?.scene?.grid?.distance ?? cv?.grid?.distance) || 5;
  const wGrids = Math.abs(token.document?.width ?? 1);
  const hGrids = Math.abs(token.document?.height ?? 1);
  const tokenSize = Math.max(wGrids, hGrids) * grid;
  const tokElev = _getTokenVisualElevation(token);
  const baseElev = getViewedLevelBaseElevation();
  const rawFloorElev = getTokenSupportElevation(token, tokElev);
  const surfElev = Number.isFinite(rawFloorElev) ? rawFloorElev : baseElev;
  const clearance = tokElev - surfElev;
  const hoverBlend = token._ssHoverBlend !== undefined ? Number(token._ssHoverBlend) : (clearance > 0.05 ? 1 : 0);
  const isGrounded = clearance <= 0.05 && hoverBlend <= 0.01 && !token._ssAirJump && !token._ssFallPlunge;
  const linearCenter = token.center ?? {
    x: (token.document?.x ?? 0) + ((token.w ?? 100) * 0.5),
    y: (token.document?.y ?? 0) + ((token.h ?? 100) * 0.5)
  };
  const hasLiveStage = canZoomZoomStage(cv);
  const liveCamCenter = hasLiveStage ? _getCameraCenter() : null;
  const pacedTokenCenter = liveCamCenter
    ? { x: linearCenter.x + (state.paceOffsetX || 0), y: linearCenter.y + (state.paceOffsetY || 0) }
    : null;
  const vertEnabled = getTokenMovementSetting('vertical');
  const blurEnabled = vertEnabled && getTokenMovementSetting('verticalBlur');
  const persp = vertEnabled
    ? computeElevationPerspective(tokElev, _currentObserverElevation, {
        gridSize: grid,
        gridDistance: sceneDist,
        tokenSize,
        baseElevation: baseElev,
        surfaceElevation: surfElev,
        isGroundedOnSurface: isGrounded,
        hoverBlend,
        tokenCenter: pacedTokenCenter,
        cameraCenter: liveCamCenter
      })
    : _neutralElevationPerspective(tokElev, _currentObserverElevation, sceneDist);

  const effectivePerspScale = hasLiveStage ? persp.worldScale : persp.perspectiveScale;
  const isObserverSelf = Boolean(token.controlled || token === _primaryObserverToken);
  const obsOccAlpha = vertEnabled && _currentObserverElevation > baseElev + 0.05
    ? computeElevationPerspective(_currentObserverElevation, _currentObserverElevation, {
        gridSize: grid,
        gridDistance: sceneDist,
        tokenSize,
        hoverBlend: 1,
        baseElevation: baseElev
      }).cameraOcclusionAlpha
    : 1;
  const meshBlurPx = !blurEnabled || persp.cameraOcclusionAlpha <= 0.01
    ? 0
    : (isObserverSelf
        ? (persp.cameraOcclusionAlpha < 0.99 ? persp.dofBlurPx : 0)
        : (persp.deltaElevation > 0 ? persp.dofBlurPx : persp.dofBlurPx * obsOccAlpha));
  _setObjectDofBlur(mesh, meshBlurPx, false);

  // 1) Position: `token.center` is core's linear center; `offsetX/Y` combines non-linear pacing, arc/hover lift, altitude lift, and 3D parallax
  token._ssPerspScale = effectivePerspScale;
  token._ssPerspOffset = {
    x: persp.parallaxOffsetX,
    y: persp.perspectiveOffsetY + persp.parallaxOffsetY
  };
  const meshAnimOffX = Number(token._ssMeshAnimOffset?.x) || 0;
  const meshAnimOffY = Number(token._ssMeshAnimOffset?.y) || 0;
  const meshScaleX = Math.max(0.15, 1 + (Number(token._ssMeshAnimOffset?.scaleX) || 0));
  const meshScaleY = Math.max(0.15, 1 + (Number(token._ssMeshAnimOffset?.scaleY) || 0));
  const meshAngle = Number(token._ssMeshAnimOffset?.angle) || 0;
  const totalOffX = (state.offsetX || 0) + persp.parallaxOffsetX;
  const totalOffY = (state.offsetY || 0) + persp.perspectiveOffsetY + persp.parallaxOffsetY;
  mesh.position.set(
    linearCenter.x + totalOffX + meshAnimOffX,
    linearCenter.y + totalOffY + meshAnimOffY
  );

  // 2) Scale: multiply base mesh scale by `scaleX/scaleY`, elevation scale, and combat deformation
  if (state.baseScaleX != null && state.baseScaleY != null) {
    mesh.scale.set(
      state.baseScaleX * (state.scaleX ?? 1) * effectivePerspScale * meshScaleX,
      state.baseScaleY * (state.scaleY ?? 1) * effectivePerspScale * meshScaleY
    );
  }

  // 3) Rotation: add `tiltAngle` and combat tilt to the token's base rotation
  const baseAngle = token.document?.lockRotation ? 0 : (token.document?.rotation ?? 0);
  mesh.angle = baseAngle + (state.tiltAngle || 0) + meshAngle;

  // 4) Interactive `token.hitArea`, `border`, resource `bars`, status `effects` (`falling.svg`),
  //    elevation `tooltip`, and `nameplate` track the steady center and scale without high-frequency step jitter
  const steadyCenterOffX = (state.paceOffsetX || 0) + persp.parallaxOffsetX;
  const rawSteadyCenterY = state.steadyCenterY !== undefined
    ? state.steadyCenterY
    : (state.steadyLiftY !== undefined ? state.steadyLiftY : (state.offsetY || 0));
  const steadyCenterOffY = rawSteadyCenterY + persp.perspectiveOffsetY + persp.parallaxOffsetY;
  const steadyStateScale = state.steadyScale !== undefined
    ? state.steadyScale
    : (((state.scaleX ?? 1) + (state.scaleY ?? 1)) * 0.5);
  const steadyBoxScale = steadyStateScale * effectivePerspScale;
  _applyTokenOcclusionAlpha(token, persp.cameraOcclusionAlpha, steadyCenterOffX, steadyCenterOffY, steadyBoxScale);

  // 5) Ground shadow tracks the supporting floor line (`surfElev`) with non-linear pacing `(paceOffsetX, paceOffsetY)`
  //    and altitude compression/diffusion (`shadowScaleMult`, `shadowAlphaMult`, `shadowOffsetY`)
  const shadow = _ensureJumpShadow(token);
  if (shadow && !shadow.destroyed) {
    _syncJumpShadowElevation(shadow, token, Math.min(tokElev, surfElev));
    const tokenH = token.h ?? ((token.document?.height ?? 1) * grid);
    const groundX = linearCenter.x + (state.paceOffsetX || 0);
    const groundY = linearCenter.y + (state.paceOffsetY || 0) + tokenH * 0.25 + persp.shadowOffsetY;
    shadow.position.set(groundX, groundY);
    const sc = (state.shadowScale ?? 1) * persp.shadowScaleMult;
    if (shadow._ssBaseW && shadow._ssBaseH) {
      shadow.width = shadow._ssBaseW * sc;
      shadow.height = shadow._ssBaseH * sc;
    } else {
      shadow.scale.set(sc, sc);
    }
    const shAlpha = (state.shadowAlpha ?? 0) * persp.shadowAlphaMult;
    shadow.alpha = shAlpha;
    shadow.visible = shAlpha > 0.01 && (token.visible ?? true) && !token.document?.hidden;
  }

  try {
    (globalThis as any).showstopper?.dynamicItems?.manager?._updateTokenDisplayPositions?.(token);
  } catch { /* ignore */ }

  _syncDragPreviewFromToken(token);
}

/**
 * Synchronize the live drag preview clone (`token._preview`, spawned by Foundry v14 on left-button drag)
 * so dragging an elevated, falling, or hovering token preserves its perspective and live animation under the cursor.
 */
function _syncDragPreviewFromToken(token: any) {
  const state = token?._ssJumpState;
  const perspState = token?._ssPerspState;
  const preview = token?._preview;
  const pMesh = preview?.mesh;
  if ((!state && !perspState) || !preview || !preview.isPreview || preview.destroyed || !pMesh || pMesh.destroyed) return;

  preview._ssPreviewSourceToken = token;
  if (preview._ssPreviewBaseScaleX == null || preview._ssPreviewBaseScaleY == null) {
    preview._ssPreviewBaseScaleX = state?.baseScaleX ?? perspState?.baseScaleX ?? pMesh.scale?.x ?? 1;
    preview._ssPreviewBaseScaleY = state?.baseScaleY ?? perspState?.baseScaleY ?? pMesh.scale?.y ?? 1;
  }

  const cv = (globalThis as any).canvas;
  const grid = cv?.grid?.size ?? 100;
  const sceneDist = Number(cv?.scene?.grid?.distance ?? cv?.grid?.distance) || 5;
  const wGrids = Math.abs(preview.document?.width ?? token.document?.width ?? 1);
  const hGrids = Math.abs(preview.document?.height ?? token.document?.height ?? 1);
  const tokenSize = Math.max(wGrids, hGrids) * grid;
  const tokElev = _getTokenVisualElevation(token);
  const baseElev = getViewedLevelBaseElevation();
  const rawFloorElev = getTokenSupportElevation(token, tokElev);
  const surfElev = Number.isFinite(rawFloorElev) ? rawFloorElev : baseElev;
  const clearance = tokElev - surfElev;
  const hoverBlend = token._ssHoverBlend !== undefined ? Number(token._ssHoverBlend) : (clearance > 0.05 ? 1 : 0);
  const isGrounded = clearance <= 0.05 && hoverBlend <= 0.01 && !token._ssAirJump && !token._ssFallPlunge;
  const pCenter = preview.center ?? {
    x: (preview.document?.x ?? 0) + ((preview.w ?? 100) * 0.5),
    y: (preview.document?.y ?? 0) + ((preview.h ?? 100) * 0.5)
  };
  const hasLiveStage = canZoomZoomStage(cv);
  const liveCamCenter = hasLiveStage ? _getCameraCenter() : null;
  const vertEnabled = getTokenMovementSetting('vertical');
  const persp = vertEnabled
    ? computeElevationPerspective(tokElev, _currentObserverElevation, {
        gridSize: grid,
        gridDistance: sceneDist,
        tokenSize,
        baseElevation: baseElev,
        surfaceElevation: surfElev,
        isGroundedOnSurface: isGrounded,
        hoverBlend,
        tokenCenter: liveCamCenter ? pCenter : null,
        cameraCenter: liveCamCenter
      })
    : _neutralElevationPerspective(tokElev, _currentObserverElevation, sceneDist);
  const effectivePerspScale = hasLiveStage ? persp.worldScale : persp.perspectiveScale;

  const offX = (state?.offsetX || 0) + persp.parallaxOffsetX;
  const offY = (state?.offsetY || 0) + persp.perspectiveOffsetY + persp.parallaxOffsetY;
  pMesh.position?.set?.(pCenter.x + offX, pCenter.y + offY);
  pMesh.scale?.set?.(
    preview._ssPreviewBaseScaleX * (state?.scaleX ?? 1) * effectivePerspScale,
    preview._ssPreviewBaseScaleY * (state?.scaleY ?? 1) * effectivePerspScale
  );
  const baseAngle = preview.document?.lockRotation ? 0 : (preview.document?.rotation ?? 0);
  pMesh.angle = baseAngle + (state?.tiltAngle || 0);
  if (preview.border && !preview.border.destroyed) {
    const pw = Number(preview.w) || wGrids * grid;
    const ph = Number(preview.h) || hGrids * grid;
    const steadyScale = (state?.steadyScale ?? 1) * effectivePerspScale;
    const steadyY = (state?.steadyCenterY ?? state?.offsetY ?? 0) + persp.perspectiveOffsetY + persp.parallaxOffsetY;
    const steadyX = (state?.paceOffsetX || 0) + persp.parallaxOffsetX;
    _setSubContainerBoxTransform(
      preview.border,
      pw * 0.5 * (1 - steadyScale) + steadyX,
      ph * 0.5 * (1 - steadyScale) + steadyY,
      steadyScale
    );
  }
}

/**
 * Reset a token's jump/flight state and restore its mesh to baseline transforms without rebuilding `DynamicTokenRing` / `PrimaryCanvasGroup`.
 * Keeps the shadow sprite pooled on the token (`visible = false`), destroying it only when `destroyShadow = true`
 * (token `_onDelete` or scene `canvasTearDown`).
 */
export function clearJumpStateForToken(token: any, { destroyShadow = false }: { destroyShadow?: boolean } = {}) {
  if (!token) return;
  const prevState = token._ssJumpState;
  const hadState = Boolean(prevState || token._ssJumpShadow || token._ssPerspState);
  token._ssJumpState = null;
  token._ssActiveMoveAnim = false;
  token._ssMoveTrackU = undefined;
  token._ssVerticalFlight = null;
  token._ssFallPlunge = null;
  token._ssAirJump = null;
  token._ssWasFalling = false;
  token._ssHoverBlend = 0;
  token._ssHoverTarget = 0;
  token._ssLastElevation = _readTokenRawElevation(token);
  token._ssLastLevel = token.document?._source?.level ?? token.document?.level ?? undefined;
  token._ssPrevAnimElevation = undefined;
  token._ssVisualElevation = undefined;
  token._ssTargetElevation = undefined;
  token._ssFlyCruiseSpeed = 0;
  token._ssFlyTilt = 0;
  token._ssFlyDecel = null;
  token._ssWalkCruiseSpeed = 0;
  if (destroyShadow) {
    token._ssPerspState = null;
    _perspectiveTokens.delete(token);
    if (token.mesh) _setObjectDofBlur(token.mesh, 0, false);
    _destroyJumpShadow(token);
  } else {
    _hideJumpShadow(token);
  }
  _activeJumpTokens.delete(token);
  _hoveringTokens.delete(token);
  _elevAnimatingTokens.delete(token);
  token._ssPerspScale = undefined;
  token._ssPerspOffset = undefined;
  _applyTokenOcclusionAlpha(token, 1, 0, 0, 1);
  token._ssOcclusionAlpha = undefined;

  if (hadState && token.mesh && !token.mesh.destroyed) {
    const linearCenter = token.center ?? {
      x: (token.document?.x ?? 0) + ((token.w ?? 100) * 0.5),
      y: (token.document?.y ?? 0) + ((token.h ?? 100) * 0.5)
    };
    const meshAnimOffX = Number(token._ssMeshAnimOffset?.x) || 0;
    const meshAnimOffY = Number(token._ssMeshAnimOffset?.y) || 0;
    token.mesh.position?.set?.(linearCenter.x + meshAnimOffX, linearCenter.y + meshAnimOffY);
    const restoreX = prevState?.baseScaleX ?? token._ssPerspState?.baseScaleX ?? token._ssBaseScaleX;
    const restoreY = prevState?.baseScaleY ?? token._ssPerspState?.baseScaleY ?? token._ssBaseScaleY;
    if (restoreX != null && restoreY != null) {
      token.mesh.scale?.set?.(restoreX, restoreY);
    }
    const baseAngle = token.document?.lockRotation ? 0 : (token.document?.rotation ?? 0);
    token.mesh.angle = baseAngle;
  }
  if (!destroyShadow) {
    _applyStationaryPerspectiveToToken(token);
  }
  if (hadState) {
    try {
      (globalThis as any).showstopper?.dynamicItems?.manager?._updateTokenDisplayPositions?.(token);
    } catch { /* ignore */ }
  }
}

/* --------------------- Continuous `Idle Hover` & Vertical Ticker (`fly` / `fall` / `airJump`) --------------------- */

function _getTicker(): any {
  return (globalThis as any).canvas?.app?.ticker ?? (globalThis as any).PIXI?.Ticker?.shared ?? null;
}

function _tokenPhaseOffset(token: any): number {
  const id = String(token?.document?.id ?? token?.id ?? '');
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 628) * 0.01;
}

function _stepElevationValue(current: number, target: number, dtSec: number): { value: number; moving: boolean } {
  const diff = target - current;
  if (Math.abs(diff) <= 0.2) {
    return { value: target, moving: false };
  }
  const step = diff * Math.min(1, dtSec * 11.5) + (diff > 0 ? 1 : -1) * Math.min(Math.abs(diff), dtSec * 18.0);
  if (Math.abs(step) >= Math.abs(diff) || Math.abs(target - (current + step)) <= 0.2) {
    return { value: target, moving: false };
  }
  return { value: current + step, moving: true };
}

function _tickHoverTokens() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // Clamp timestep `dtSec <= 0.025` (25 ms) so a heavy synchronous `updateToken` frame in Foundry v14
  // (`initializeSources` + `canvas.perception` vision/lighting rebuild) never jumps `vf.u` ahead by 5–6 frames.
  const rawElapsedMs = _lastHoverTickMs ? (now - _lastHoverTickMs) : 16.67;
  const effectiveElapsedMs = rawElapsedMs < 2.0 ? 16.67 : rawElapsedMs;
  const dtSec = Math.min(0.025, Math.max(0.004, effectiveElapsedMs * 0.001));
  _lastHoverTickMs = now;
  const grid = (globalThis as any).canvas?.grid?.size ?? 100;

  // 1) Smoothly interpolate visual elevation across all tokens changing altitude (`_elevAnimatingTokens`),
  //    covering both `'fly'` and `'walk'` movement modes
  for (const token of Array.from(_elevAnimatingTokens)) {
    if (!token || token.destroyed || token.isPreview || !token.mesh || token.mesh.destroyed) {
      _elevAnimatingTokens.delete(token);
      continue;
    }
    if (token._ssFallPlunge || token._ssAirJump) {
      _elevAnimatingTokens.delete(token);
      continue;
    }
    const rawElev = _readTokenRawElevation(token);
    token._ssTargetElevation = rawElev;
    if (Number.isFinite(token._ssVisualElevation)) {
      const stepped = _stepElevationValue(Number(token._ssVisualElevation), rawElev, dtSec);
      token._ssVisualElevation = stepped.value;
      if (!stepped.moving) _elevAnimatingTokens.delete(token);
    } else {
      token._ssVisualElevation = rawElev;
      _elevAnimatingTokens.delete(token);
    }
    if (!token._ssJumpState && !_hoveringTokens.has(token)) {
      _applyStationaryPerspectiveToToken(token);
    }
  }

  // 2) Smoothly interpolate viewpoint altitude (`_currentObserverElevation -> _targetObserverElevation`).
  //    When the controlled token itself is actively animating its elevation (`obsTok._ssVisualElevation`),
  //    lock camera altitude to its instantaneous elevation frame-for-frame so `deltaElevation === 0` with zero lag.
  _targetObserverElevation = getTargetObserverElevation();
  const obsTok = _observerElevationOverride === null ? _getActiveObserverToken() : null;
  let obsChangedThisTick = false;
  let obsStillMoving = false;
  if (
    obsTok &&
    Number.isFinite(obsTok._ssVisualElevation) &&
    (_elevAnimatingTokens.has(obsTok) || Boolean(obsTok._ssFallPlunge) || Boolean(obsTok._ssAirJump))
  ) {
    if (Math.abs(_currentObserverElevation - obsTok._ssVisualElevation) > 0.001) {
      _currentObserverElevation = Number(obsTok._ssVisualElevation);
      obsChangedThisTick = true;
    }
    obsStillMoving = true;
  } else {
    const steppedObs = _stepElevationValue(_currentObserverElevation, _targetObserverElevation, dtSec);
    if (steppedObs.value !== _currentObserverElevation) {
      _currentObserverElevation = steppedObs.value;
      obsChangedThisTick = true;
    }
    obsStillMoving = steppedObs.moving;
  }

  for (const token of Array.from(_hoveringTokens)) {
    if (!token || token.destroyed || token.isPreview || !token.mesh || token.mesh.destroyed) {
      _hoveringTokens.delete(token);
      continue;
    }
    const rawElev = _readTokenRawElevation(token);
    token._ssTargetElevation = rawElev;
    if (!_elevAnimatingTokens.has(token) && !token._ssFallPlunge && !token._ssAirJump) {
      token._ssVisualElevation = rawElev;
    }

    // While active horizontal `jump` or `fly` movement is running, `onAnimate` drives the frames;
    // however, falling (`_ssFallPlunge` and `isTokenFalling`) and vertical jumps (`_ssAirJump`) are ALWAYS clocked by `_tickHoverTokens` via real `dtSec`!
    if (token._ssActiveMoveAnim && !token._ssFallPlunge && !token._ssAirJump && !isTokenFalling(token)) continue;

    const wGrids = Math.abs(token.document?.width ?? 1);
    const hGrids = Math.abs(token.document?.height ?? 1);
    const tokenSize = Math.max(wGrids, hGrids) * grid;
    const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);

    // 2a) High-speed gravitational plunge and ground impact (`_ssFallPlunge`, including clicking `Falling` / `plummet()`)
    const plunge = token._ssFallPlunge;
    if (plunge && !getTokenMovementSetting('fall')) {
      token._ssFallPlunge = null;
      const savedElev = rawElev;
      clearJumpStateForToken(token);
      token._ssLastElevation = savedElev;
      token._ssVisualElevation = savedElev;
      token._ssTargetElevation = savedElev;
      continue;
    }
    if (plunge) {
      plunge.elapsed = (Number(plunge.elapsed) || 0) + dtSec * 1000;
      const durMs = Math.max(120, Number(plunge.durationMs) || 700);
      const u = Math.max(0, Math.min(1, plunge.elapsed / durMs));
      const frame = computeFallPlungeFrame(u, {
        fromElevation: plunge.fromElevation,
        toElevation: plunge.toElevation,
        gridSize: grid,
        tokenSize,
        gridDistance: plunge.gridDistance,
        startOffsetX: plunge.startOffsetX,
        startOffsetY: plunge.startOffsetY,
        startTilt: plunge.startTilt,
        startScaleX: plunge.startScaleX,
        startScaleY: plunge.startScaleY
      });
      token._ssVisualElevation = frame.visualElevation;
      token._ssHoverBlend = Math.max(0, 1 - frame.fallProgress);
      if (token === obsTok) {
        if (Math.abs(_currentObserverElevation - frame.visualElevation) > 1e-7) {
          _currentObserverElevation = frame.visualElevation;
          obsChangedThisTick = true;
        }
        obsStillMoving = u < 1;
      }
      if (u >= 1) {
        token._ssFallPlunge = null;
        token._ssVisualElevation = rawElev;
        const stillFalling = isTokenFalling(token) && !token.document?.hidden;
        const stillFlying = !stillFalling && isTokenInFlyMode(token) && !token.document?.hidden;
        if (stillFalling || stillFlying) {
          token._ssHoverBlend = 1;
          token._ssHoverTarget = 1;
          token._ssWasFalling = stillFalling;
        } else {
          const savedElev = rawElev;
          clearJumpStateForToken(token);
          token._ssLastElevation = savedElev;
          token._ssVisualElevation = savedElev;
          token._ssTargetElevation = savedElev;
          continue;
        }
      } else {
        token._ssJumpState = {
          ...frame,
          elevation: frame.visualElevation,
          baseScaleX,
          baseScaleY
        };
        _activeJumpTokens.add(token);
        applyJumpStateToToken(token);
        continue;
      }
    }

    // 2a-up) In-place vertical jump into mid-air (`_ssAirJump`) when elevation increases into unsupported air:
    const airJump = token._ssAirJump;
    if (airJump && !getTokenMovementSetting('jump')) {
      token._ssAirJump = null;
      const savedElev = rawElev;
      clearJumpStateForToken(token);
      token._ssLastElevation = savedElev;
      token._ssVisualElevation = savedElev;
      token._ssTargetElevation = savedElev;
      continue;
    }
    if (airJump) {
      airJump.elapsed = (Number(airJump.elapsed) || 0) + dtSec * 1000;
      const durMs = Math.max(120, Number(airJump.durationMs) || 535);
      const u = Math.max(0, Math.min(1, airJump.elapsed / durMs));
      const fallingNowForJump = isTokenFalling(token) && !token.document?.hidden;
      const frame = computeAirJumpFrame(u, {
        fromElevation: airJump.fromElevation,
        toElevation: airJump.toElevation,
        gridSize: grid,
        tokenSize,
        gridDistance: airJump.gridDistance,
        startedGrounded: airJump.startedGrounded,
        endInFalling: fallingNowForJump,
        startOffsetX: airJump.startOffsetX,
        startOffsetY: airJump.startOffsetY,
        startTilt: airJump.startTilt,
        startScaleX: airJump.startScaleX,
        startScaleY: airJump.startScaleY
      });
      token._ssVisualElevation = frame.visualElevation;
      token._ssHoverBlend = frame.climbProgress;
      if (token === obsTok) {
        if (Math.abs(_currentObserverElevation - frame.visualElevation) > 1e-7) {
          _currentObserverElevation = frame.visualElevation;
          obsChangedThisTick = true;
        }
        obsStillMoving = u < 1;
      }
      if (u >= 1) {
        token._ssAirJump = null;
        token._ssVisualElevation = rawElev;
        const stillFalling = isTokenFalling(token) && !token.document?.hidden;
        const stillFlying = !stillFalling && isTokenInFlyMode(token) && !token.document?.hidden;
        if (stillFalling) {
          token._ssHoverBlend = 1;
          token._ssHoverTarget = 1;
          token._ssHoverPhase = 0;
          token._ssWasFalling = true;
          const nextFallFrame = computeFallingLoopFrame(1, 0, {
            gridSize: grid,
            tokenSize,
            elevation: rawElev
          });
          token._ssJumpState = {
            ...nextFallFrame,
            baseScaleX,
            baseScaleY
          };
          _activeJumpTokens.add(token);
          applyJumpStateToToken(token);
          continue;
        } else if (stillFlying) {
          token._ssHoverBlend = 1;
          token._ssHoverTarget = 1;
          token._ssHoverPhase = 0;
          token._ssWasFalling = false;
        } else {
          const savedElev = rawElev;
          clearJumpStateForToken(token);
          token._ssLastElevation = savedElev;
          token._ssVisualElevation = savedElev;
          token._ssTargetElevation = savedElev;
          continue;
        }
      } else {
        token._ssJumpState = {
          ...frame,
          elevation: frame.visualElevation,
          baseScaleX,
          baseScaleY
        };
        _activeJumpTokens.add(token);
        applyJumpStateToToken(token);
        continue;
      }
    }

    // 2b) Continuous free-fall animation while the `Falling` status (`statusId: "falling"`) is active
    const isFallingNow = getTokenMovementSetting('fall') && isTokenFalling(token) && !token.document?.hidden;
    if (isFallingNow) {
      token._ssWasFalling = true;
      token._ssHoverTarget = 1;
      if (token._ssHoverPhase == null) token._ssHoverPhase = _tokenPhaseOffset(token);
      token._ssHoverPhase = (token._ssHoverPhase + dtSec * 1.90) % (Math.PI * 200);

      let blend = Number(token._ssHoverBlend) || 0;
      const rate = dtSec / 0.22;
      if (blend < 1) blend = Math.min(1, blend + rate);
      token._ssHoverBlend = blend;
      token._ssVerticalFlight = null;
      token._ssFlyDecel = null;

      const fallFrame = computeFallingLoopFrame(blend, token._ssHoverPhase, {
        gridSize: grid,
        tokenSize,
        elevation: _getTokenVisualElevation(token)
      });
      token._ssJumpState = {
        ...fallFrame,
        baseScaleX,
        baseScaleY
      };
      _activeJumpTokens.add(token);
      applyJumpStateToToken(token);
      continue;
    }
    token._ssWasFalling = false;

    // IMPORTANT: Do NOT check `token.visible` in `wantFly`!
    // In Foundry VTT v14, `PlaceableObject#draw()` temporarily sets `this.visible = false` BEFORE `Hooks.callAll("drawToken")`
    // and across `await this._draw()`. Checking `token.visible` would trigger a bogus landing on every mid-air token redraw!
    const wantFly = isTokenInFlyMode(token) && !token.document?.hidden;
    const target = wantFly ? 1 : 0;
    token._ssHoverTarget = target;

    if (token._ssHoverPhase == null) token._ssHoverPhase = _tokenPhaseOffset(token);
    token._ssHoverPhase = (token._ssHoverPhase + dtSec * 2.35) % (Math.PI * 200);

    let blend = Number(token._ssHoverBlend) || 0;
    const rate = dtSec / (target > blend ? 0.44 : 0.38);
    if (blend < target) blend = Math.min(target, blend + rate);
    else if (blend > target) blend = Math.max(target, blend - rate);
    token._ssHoverBlend = blend;
    token._ssVerticalFlight = null;

    if (blend <= 0.001 && target === 0) {
      const savedElev = token._ssLastElevation;
      clearJumpStateForToken(token);
      token._ssLastElevation = savedElev;
      continue;
    }

    const frame = computeIdleHoverFrame(blend, token._ssHoverPhase, { gridSize: grid, tokenSize, verticalBoost: 0 });
    // When WASD flight ends right after key release, smoothly finish inertial braking and bank recovery
    const decel = token._ssFlyDecel;
    if (decel && decel.duration > 0) {
      decel.elapsed = (Number(decel.elapsed) || 0) + dtSec;
      const tDecel = Math.min(1, decel.elapsed / decel.duration);
      const decay = 1 - _smootherstep(tDecel);
      frame.paceOffsetX = (decel.offsetX || 0) * decay;
      frame.paceOffsetY = (decel.offsetY || 0) * decay;
      frame.offsetX = (frame.offsetX || 0) + frame.paceOffsetX;
      frame.offsetY = (frame.offsetY || 0) + frame.paceOffsetY;
      frame.steadyLiftY = (frame.steadyLiftY || 0) + frame.paceOffsetY;
      frame.tiltAngle = (frame.tiltAngle || 0) + (decel.tilt || 0) * decay;
      token._ssFlyTilt = frame.tiltAngle;
      token._ssFlyCruiseSpeed = (decel.speed || 0) * decay;
      if (tDecel >= 1) {
        token._ssFlyDecel = null;
        token._ssFlyTilt = 0;
        token._ssFlyCruiseSpeed = 0;
      }
    }
    token._ssJumpState = {
      ...frame,
      baseScaleX,
      baseScaleY
    };
    _activeJumpTokens.add(token);
    applyJumpStateToToken(token);
  }

  if (obsChangedThisTick) {
    _updateSceneTokensPerspective();
  }

  if (!_hoveringTokens.size && !_elevAnimatingTokens.size && !obsStillMoving) _stopHoverTicker();
}

let _attachedTickerInstance: any = null;

function _ensureHoverTicker() {
  const ticker = _getTicker();
  if (!ticker || typeof ticker.add !== 'function') return;
  if (_hoverTickerAttached && _attachedTickerInstance === ticker) return;
  if (_attachedTickerInstance && _attachedTickerInstance !== ticker) {
    try { _attachedTickerInstance.remove?.(_tickHoverTokens); } catch { /* ignore */ }
  }
  _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  ticker.add(_tickHoverTokens);
  _attachedTickerInstance = ticker;
  _hoverTickerAttached = true;
}

function _stopHoverTicker() {
  if (!_hoverTickerAttached && !_attachedTickerInstance) return;
  const ticker = _attachedTickerInstance ?? _getTicker();
  try { ticker?.remove?.(_tickHoverTokens); } catch { /* ignore */ }
  _attachedTickerInstance = null;
  _hoverTickerAttached = false;
  _lastHoverTickMs = 0;
}

/**
 * Synchronize a token's `Idle Hover`, `Falling`, vertical air-jump (`_ssAirJump`), and takeoff/landing state.
 * Takeoff (`blend: 0 -> 1`) plays ONLY when lifting off from support (`prevElev <= 0` -> `curElev > 0`),
 * and landing (`blend: 1 -> 0`) plays ONLY when touching down (`curElev <= 0`) or leaving `fly` mode.
 * When a non-flying token gains elevation into unsupported air (`!hasLandingSurface`),
 * triggers a ballistic upward air-jump (`_ssAirJump`).
 * While `Falling` (`isTokenFalling(token)`) is active, enters the continuous falling loop,
 * and upon reaching a solid surface (`_isSupportedAtElevation`) or calling `plummet()`, plays the dive-and-impact (`_ssFallPlunge`).
 * Stepwise descent via `Q` (`core.descend`) while still over open air (`!hasLandingSurface`) does NOT trigger a premature landing.
 */
export function syncTokenFlyHover(token: any, changed?: any, options?: any): boolean {
  if (!token || token.destroyed || token.isPreview || !token.mesh || token.mesh.destroyed) return false;
  const curElev = _readTokenRawElevation(token);
  const curLevel = token.document?._source?.level ?? token.document?.level ?? null;

  const hadLastElev = Number.isFinite(token._ssLastElevation);
  const prevElev = Number.isFinite(token._ssPrevAnimElevation)
    ? token._ssPrevAnimElevation
    : (hadLastElev ? token._ssLastElevation : curElev);
  const prevLevel = token._ssLastLevel !== undefined ? token._ssLastLevel : curLevel;
  const levelChanged = Boolean(changed && ('level' in changed) && changed.level !== prevLevel);

  const ticker = _getTicker();
  const hasTicker = Boolean(ticker && typeof ticker.add === 'function');
  const fallAnimEnabled = getTokenMovementSetting('fall');
  const jumpAnimEnabled = getTokenMovementSetting('jump');
  const isFallingLogical = isTokenFalling(token) && !token.document?.hidden;
  const isFallingNow = fallAnimEnabled && isFallingLogical;
  const wasFalling = Boolean(token._ssWasFalling);
  const dndFallDist = Number(options?.dnd5e?.fall?.distance) || 0;
  const isExplicitFallOpt = options?.fall === true || dndFallDist > 0 || isFallActionName(options?.action);
  const elevDrop = Math.max(0, prevElev - curElev);
  const elevGain = Math.max(0, curElev - prevElev);
  const hasLandingSurface = _isSupportedAtElevation(token, curElev, undefined, undefined, curLevel);

  // Clear `_ssPrevAnimElevation` and update `_ssLastElevation` / `_ssLastLevel` when processing an actual state update
  if (!changed || ('elevation' in changed) || !hadLastElev) {
    token._ssPrevAnimElevation = undefined;
    token._ssLastElevation = curElev;
  }
  if (!changed || ('level' in changed) || token._ssLastLevel === undefined) {
    token._ssLastLevel = curLevel;
  }

  // 1) Check whether to trigger a gravitational plunge and ground impact (`_ssFallPlunge`):
  //    - explicit fall invocation via `plummet()` / `options.dnd5e.fall.distance` / `action: 'fall'`;
  //    - falling token descending ALL THE WAY onto a solid surface (`hasLandingSurface === true` — never fires on mid-air `Q` steps!);
  //    - `Falling` status removed while already resting on a solid surface (`hasLandingSurface && wasFalling && !isFallingNow`).
  const shouldStartPlunge = fallAnimEnabled && !token._ssActiveMoveAnim && hasTicker && (
    (isExplicitFallOpt && (elevDrop > 0.5 || dndFallDist > 0)) ||
    (hasLandingSurface && elevDrop > 0.5 && (isFallingNow || wasFalling)) ||
    (hasLandingSurface && wasFalling && !isFallingNow && !_isLogicalTokenInFlyMode(token) && !token._ssFallPlunge)
  );

  if (shouldStartPlunge) {
    const grid = (globalThis as any).canvas?.grid?.size ?? 100;
    const wGrids = Math.abs(token.document?.width ?? 1);
    const hGrids = Math.abs(token.document?.height ?? 1);
    const tokenSize = Math.max(wGrids, hGrids) * grid;
    const gridDistance = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
    const fromElevation = dndFallDist > 0
      ? Math.max(prevElev, curElev + dndFallDist)
      : (elevDrop > 0.5
          ? prevElev
          : (Number.isFinite(token._ssVisualElevation)
              ? Math.max(curElev + gridDistance, Number(token._ssVisualElevation))
              : (curElev + gridDistance * 2)));
    const toElevation = curElev;
    const durationMs = computeFallDurationMs(fromElevation - toElevation, gridDistance);
    const startOffsetX = Number(token._ssJumpState?.offsetX) || 0;
    const startOffsetY = Number(token._ssJumpState?.offsetY) || 0;
    const startTilt = Number(token._ssJumpState?.tiltAngle) || 0;
    const startScaleX = Number(token._ssJumpState?.scaleX) || 1;
    const startScaleY = Number(token._ssJumpState?.scaleY) || 1;

    token._ssFallPlunge = {
      elapsed: 0,
      durationMs,
      fromElevation,
      toElevation,
      gridSize: grid,
      tokenSize,
      gridDistance,
      startOffsetX,
      startOffsetY,
      startTilt,
      startScaleX,
      startScaleY
    };
    token._ssAirJump = null;
    token._ssWasFalling = isFallingNow;
    token._ssVisualElevation = fromElevation;
    token._ssVerticalFlight = null;
    token._ssTargetElevation = toElevation;
    token._ssFlyDecel = null;
    _elevAnimatingTokens.delete(token);

    const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);
    const initFrame = computeFallPlungeFrame(0, token._ssFallPlunge);
    token._ssJumpState = {
      ...initFrame,
      elevation: initFrame.visualElevation,
      baseScaleX,
      baseScaleY
    };
    _activeJumpTokens.add(token);
    _hoveringTokens.add(token);
    applyJumpStateToToken(token);
    if (_hoverTickerAttached) _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    _ensureHoverTicker();
    return true;
  }

  // If `_ssFallPlunge` is already running (e.g. `deleteActiveEffect` fires right after `plummet()`),
  // let it finish its ground impact (`u = 1`) uninterrupted unless a new upward elevation step occurs.
  if (token._ssFallPlunge && !fallAnimEnabled) {
    token._ssFallPlunge = null;
  }
  if (token._ssFallPlunge && hasTicker) {
    if (changed && ('elevation' in changed) && elevGain > 0.5) {
      token._ssFallPlunge = null;
    } else {
      token._ssWasFalling = isFallingNow;
      _hoveringTokens.add(token);
      _ensureHoverTicker();
      return true;
    }
  }

  // 1b) Vertical upward jump into mid-air (`_ssAirJump`):
  //     triggers ONLY when jumping up off solid support (`wasSupportedAtOrigin`) while NOT already falling (`!isFallingLogical && !wasFalling`),
  //     leaving the token unsupported in mid-air (`!hasLandingSurface`) outside normal flight mode (`!logicalFlyAtTarget`), `climb`, or `changeLevel` regions.
  const logicalFlyAtTarget = _isLogicalTokenInFlyMode(token, curElev, curLevel) && !token.document?.hidden;
  const optActStr = typeof options?.action === 'string' ? options.action.trim() : '';
  const docActStr = String(token.document?.movementAction ?? token.document?._source?.movementAction ?? '').trim();
  const isTeleportOpt = _isTeleportOperation(options, undefined, token.document?.id) || Boolean(optActStr && TELEPORT_ACTION_RE.test(optActStr));
  const isClimbOrStairs = options?.jump !== true && (
    levelChanged ||
    isClimbActionName(optActStr || docActStr) ||
    isTokenInLevelChangeRegion(token)
  );
  const wasSupportedAtOrigin = _isSupportedAtElevation(token, prevElev, undefined, undefined, prevLevel);
  const hasActiveGroundedJump = Boolean(token._ssAirJump?.startedGrounded) &&
    (Number(token._ssAirJump?.elapsed) || 0) < (Number(token._ssAirJump?.durationMs) || 500) * AIR_JUMP_APEX_T;
  const canLaunchAirJump = options?.jump === true || wasSupportedAtOrigin || hasActiveGroundedJump;
  const shouldStartAirJump = Boolean(
    jumpAnimEnabled &&
    !token._ssActiveMoveAnim &&
    hasTicker &&
    !token.document?.hidden &&
    !isFallingLogical &&
    !wasFalling &&
    !isTeleportOpt &&
    !isExplicitFallOpt &&
    !isClimbOrStairs &&
    options?.animate !== false &&
    options?.jump !== false &&
    elevGain > 0.5 &&
    canLaunchAirJump &&
    !hasLandingSurface &&
    !logicalFlyAtTarget
  );

  if (shouldStartAirJump) {
    const grid = (globalThis as any).canvas?.grid?.size ?? 100;
    const wGrids = Math.abs(token.document?.width ?? 1);
    const hGrids = Math.abs(token.document?.height ?? 1);
    const tokenSize = Math.max(wGrids, hGrids) * grid;
    const gridDistance = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
    const startedGrounded = !token._ssAirJump && !((token._ssHoverBlend ?? 0) > 0.1) && wasSupportedAtOrigin;
    const fromElevation = Number.isFinite(token._ssVisualElevation) ? Number(token._ssVisualElevation) : prevElev;
    const toElevation = curElev;
    const durationMs = computeAirJumpDurationMs(Math.max(gridDistance, toElevation - fromElevation), gridDistance, undefined, {
      token,
      startedGrounded
    });
    const startOffsetX = Number(token._ssJumpState?.offsetX) || 0;
    const startOffsetY = Number(token._ssJumpState?.offsetY) || 0;
    const startTilt = Number(token._ssJumpState?.tiltAngle) || 0;
    const startScaleX = Number(token._ssJumpState?.scaleX) || 1;
    const startScaleY = Number(token._ssJumpState?.scaleY) || 1;

    token._ssAirJump = {
      elapsed: 0,
      durationMs,
      fromElevation,
      toElevation,
      gridSize: grid,
      tokenSize,
      gridDistance,
      startedGrounded,
      startOffsetX,
      startOffsetY,
      startTilt,
      startScaleX,
      startScaleY
    };
    token._ssWasFalling = isFallingNow;
    token._ssVisualElevation = fromElevation;
    token._ssTargetElevation = toElevation;
    token._ssVerticalFlight = null;
    token._ssFlyDecel = null;
    _elevAnimatingTokens.delete(token);

    const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);
    const initFrame = computeAirJumpFrame(0, { ...token._ssAirJump, endInFalling: isFallingNow });
    token._ssJumpState = {
      ...initFrame,
      elevation: initFrame.visualElevation,
      baseScaleX,
      baseScaleY
    };
    _activeJumpTokens.add(token);
    _hoveringTokens.add(token);
    applyJumpStateToToken(token);
    if (_hoverTickerAttached) _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    _ensureHoverTicker();
    return true;
  }

  // Once `_ssAirJump` is running, do not abort it when `falling` or `drawToken` arrives at the apex
  // (cancel on a new explicit elevation change while falling/descending, landing on support, or entering flight mode).
  if (token._ssAirJump && !jumpAnimEnabled) {
    token._ssAirJump = null;
  }
  if (token._ssAirJump && hasTicker) {
    if (changed && ('elevation' in changed) && (elevDrop > 0.5 || hasLandingSurface || logicalFlyAtTarget || isFallingLogical)) {
      token._ssAirJump = null;
    } else {
      token._ssWasFalling = isFallingNow;
      if (token._ssJumpState) {
        const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);
        token._ssJumpState.baseScaleX = baseScaleX;
        token._ssJumpState.baseScaleY = baseScaleY;
        applyJumpStateToToken(token);
      }
      _hoveringTokens.add(token);
      _ensureHoverTicker();
      return true;
    }
  }

  if (getTokenMovementSetting('vertical') && changed && ('elevation' in changed) && hasTicker && Number.isFinite(prevElev) && Math.abs(curElev - prevElev) > 0.05) {
    token._ssVisualElevation = Number.isFinite(token._ssVisualElevation) ? token._ssVisualElevation : prevElev;
    token._ssTargetElevation = curElev;
    _elevAnimatingTokens.add(token);
    _ensureHoverTicker();
  } else {
    _elevAnimatingTokens.delete(token);
    if (!getTokenMovementSetting('vertical') || !_elevAnimatingTokens.has(token) || !Number.isFinite(token._ssVisualElevation)) {
      token._ssVisualElevation = curElev;
      token._ssTargetElevation = curElev;
    } else {
      token._ssTargetElevation = curElev;
    }
  }

  // 2) When the `Falling` status (`statusId: "falling"`) is active, engage the continuous falling loop
  //    IMMEDIATELY as soon as the effect appears (even if the token is finishing a `walk` step off another token or ledge!)
  if (isFallingLogical && !fallAnimEnabled) {
    token._ssWasFalling = false;
    if (_hoveringTokens.has(token) || token._ssJumpState) {
      const savedElev = token._ssLastElevation;
      clearJumpStateForToken(token);
      token._ssLastElevation = savedElev;
    } else {
      _applyStationaryPerspectiveToToken(token);
    }
    return false;
  }
  if (isFallingNow) {
    token._ssWasFalling = true;
    const prevBlend = Number(token._ssHoverBlend) || 0;
    if (token._ssActiveMoveAnim && hasTicker) {
      // Take over immediately from any grounded walk step as soon as the Falling effect appears
      token._ssActiveMoveAnim = false;
      if (prevBlend <= 0.001) {
        token._ssHoverBlend = 0.35;
        if (token._ssHoverPhase == null) token._ssHoverPhase = 0;
        if (_hoverTickerAttached) _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
    } else if (!token._ssActiveMoveAnim) {
      if (!hasLandingSurface && !hadLastElev && !changed) {
        token._ssHoverBlend = 1;
      } else if (prevBlend <= 0.001) {
        token._ssHoverBlend = !hasLandingSurface ? 0.35 : 0.25;
        if (token._ssHoverPhase == null) token._ssHoverPhase = 0;
        if (_hoverTickerAttached) _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
    }
    token._ssVerticalFlight = null;
    token._ssHoverTarget = 1;
    _hoveringTokens.add(token);
    _ensureHoverTicker();

    if (!token._ssActiveMoveAnim && (token._ssHoverBlend ?? 0) > 0) {
      const grid = (globalThis as any).canvas?.grid?.size ?? 100;
      const wGrids = Math.abs(token.document?.width ?? 1);
      const hGrids = Math.abs(token.document?.height ?? 1);
      const tokenSize = Math.max(wGrids, hGrids) * grid;
      const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);
      if (token._ssHoverPhase == null) token._ssHoverPhase = _tokenPhaseOffset(token);
      const frame = computeFallingLoopFrame(token._ssHoverBlend, token._ssHoverPhase, {
        gridSize: grid,
        tokenSize,
        elevation: _getTokenVisualElevation(token)
      });
      token._ssJumpState = {
        ...frame,
        baseScaleX,
        baseScaleY
      };
      _activeJumpTokens.add(token);
      applyJumpStateToToken(token);
    }
    return true;
  }
  token._ssWasFalling = false;

  // IMPORTANT: Do NOT check `token.visible` in `inFly`!
  // During `PlaceableObject#draw()`, Foundry v14 sets `this.visible = false` before firing `drawToken`
  // and restores `this.visible = wasVisible` only after `drawToken` returns.
  const inFly = isTokenInFlyMode(token, curElev, curLevel) && !token.document?.hidden;
  const rawSupportElev = getTokenSupportElevation(token, curElev, { forFlySuppression: true, levelOverride: curLevel });
  const curSupportElev = Number.isFinite(rawSupportElev) ? rawSupportElev : (curElev - 100);
  const curClearance = curElev - curSupportElev;
  const prevClearance = Number.isFinite(token._ssLastClearance)
    ? Number(token._ssLastClearance)
    : (prevElev - curSupportElev);
  if (!changed || ('elevation' in changed) || ('level' in (changed ?? {})) || ('x' in (changed ?? {})) || ('y' in (changed ?? {})) || !hadLastElev) {
    token._ssLastClearance = curClearance;
  }

  if (inFly) {
    const prevBlend = Number(token._ssHoverBlend) || 0;
    if (!token._ssActiveMoveAnim) {
      // If the token was already above support (`prevClearance > 0.05`) and remains above support (`curClearance > 0.05`),
      // or this is the initial scene draw (`!changed && !hadLastElev`) of an already airborne token:
      // skip the takeoff animation — keep `blend = 1` unless a smooth floor takeoff is already in progress.
      if (prevClearance > 0.05 && curClearance > 0.05 && (!hadLastElev || prevBlend <= 0.001 || prevBlend >= 0.99)) {
        token._ssHoverBlend = 1;
      } else if (prevClearance <= 0.05 && curClearance > 0.05 && prevBlend <= 0.001) {
        // True liftoff from floor/tile/platform (`clearance: 0 -> >0`): ramp `blend: 0 -> 1` smoothly in `_tickHoverTokens`
        if (token._ssHoverPhase == null) token._ssHoverPhase = 0;
        if (_hoverTickerAttached) _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
    }
    token._ssVerticalFlight = null;
    token._ssHoverTarget = 1;
    _hoveringTokens.add(token);
    _ensureHoverTicker();

    // When `drawToken` fires after `PlaceableObject#draw()` recreates `token.mesh`,
    // immediately refresh the new mesh's base scale and re-apply hover so it never drops to the floor for 1 frame
    if (!token._ssActiveMoveAnim && (token._ssHoverBlend ?? 0) > 0) {
      const grid = (globalThis as any).canvas?.grid?.size ?? 100;
      const wGrids = Math.abs(token.document?.width ?? 1);
      const hGrids = Math.abs(token.document?.height ?? 1);
      const tokenSize = Math.max(wGrids, hGrids) * grid;
      const { x: baseScaleX, y: baseScaleY } = _resolveBaseScale(token);
      if (token._ssHoverPhase == null) token._ssHoverPhase = _tokenPhaseOffset(token);
      const frame = computeIdleHoverFrame(token._ssHoverBlend, token._ssHoverPhase, { gridSize: grid, tokenSize, verticalBoost: 0 });
      token._ssJumpState = {
        ...frame,
        baseScaleX,
        baseScaleY
      };
      _activeJumpTokens.add(token);
      applyJumpStateToToken(token);
    }
    return true;
  }
  if (_hoveringTokens.has(token) || (token._ssHoverBlend ?? 0) > 0) {
    token._ssVerticalFlight = null;
    token._ssHoverTarget = 0;
    if (hasTicker) {
      if (_hoverTickerAttached) _lastHoverTickMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      _hoveringTokens.add(token);
      _ensureHoverTicker();
    } else {
      const savedElev = token._ssLastElevation;
      clearJumpStateForToken(token);
      token._ssLastElevation = savedElev;
    }
  } else if (!token._ssJumpState) {
    _applyStationaryPerspectiveToToken(token);
  }
  return false;
}

/** Tear down all active jumps, hover loops, and elevation perspective states (on `canvasTearDown`). */
export function clearAllJumpAnimations() {
  _stopHoverTicker();
  const baseElev = getViewedLevelBaseElevation();
  _currentObserverElevation = baseElev;
  _targetObserverElevation = baseElev;
  _appliedAltitudeCameraZoom = 1;
  _primaryObserverToken = null;
  _observerElevationOverride = null;
  _clearAllDofFilters();
  _elevAnimatingTokens.clear();
  for (const token of Array.from(_hoveringTokens)) {
    clearJumpStateForToken(token, { destroyShadow: true });
  }
  _hoveringTokens.clear();
  for (const token of Array.from(_activeJumpTokens)) {
    clearJumpStateForToken(token, { destroyShadow: true });
  }
  _activeJumpTokens.clear();
  for (const token of Array.from(_perspectiveTokens)) {
    _clearStationaryPerspectiveForToken(token);
  }
  _perspectiveTokens.clear();
}

/**
 * Attach jump (`jump`), flight (`fly` / `hover`), or walk (`walk`) lifecycle hooks onto `Token#_prepareAnimation`'s `context`.
 */
export function attachJumpAnimationToContext(
  token: any,
  from: any,
  changes: any,
  context: any,
  options: any = {}
): boolean {
  if (!token || token.isPreview || !context || context._ssJumpAttached) return false;
  const hasActivePlunge = Boolean(token._ssFallPlunge);
  const isFall = hasActivePlunge || isFallAnimationSegment(token, from, changes, options);
  const isJump = !isFall && isJumpAnimationSegment(token, from, changes, options);
  const isFly = !isFall && !isJump && isFlyAnimationSegment(token, from, changes, options);
  const isWalk = !isFall && !isJump && !isFly && isWalkAnimationSegment(token, from, changes, options);
  if (!isFall && !isJump && !isFly && !isWalk) return false;
  const x0 = Number(from?.x ?? token.document?.x ?? 0);
  const y0 = Number(from?.y ?? token.document?.y ?? 0);
  const x1 = Number(changes.x ?? x0);
  const y1 = Number(changes.y ?? y0);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const distXY = Math.hypot(dx, dy);

  // For purely vertical in-place elevation changes (`distXY < 4`),
  // takeoff (`0 -> >0`), landing (`>0 -> 0`), and vertical falls are driven exclusively by `syncTokenFlyHover` (`_tickHoverTokens`).
  if (distXY < 4) return false;

  const grid = canvas?.grid?.size ?? 100;
  const gridDistance = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
  const wGrids = Math.abs(changes.width ?? from?.width ?? token.document?.width ?? 1);
  const hGrids = Math.abs(changes.height ?? from?.height ?? token.document?.height ?? 1);
  const tokenSize = Math.max(wGrids, hGrids) * grid;

  const docElev = _readTokenRawElevation(token);
  const fromElev = Number.isFinite(Number(from?.elevation)) ? Number(from.elevation) : docElev;
  const toElev = Number.isFinite(Number(changes?.elevation))
    ? Number(changes.elevation)
    : (Number.isFinite(Number(context?.to?.elevation)) ? Number(context.to.elevation) : docElev);
  const origLevel = from?.level ?? token.document?._source?.level ?? token.document?.level ?? null;
  const destLevel = changes?.level !== undefined ? changes.level : origLevel;
  const isExplicitFallMove = options?.fall === true || Number(options?.dnd5e?.fall?.distance) > 0 || isFallActionName(options?.action);
  const isFallPlunge = isFall && (
    (isExplicitFallMove && (fromElev - toElev > 0.5 || Number(options?.dnd5e?.fall?.distance) > 0)) ||
    ((fromElev - toElev > 0.5) && _isSupportedAtElevation(token, toElev, x1, y1, destLevel))
  );
  const hasLiveTicker = Boolean(_getTicker()?.add);

  // Complete isolation of falling animations (`Falling` and `_ssFallPlunge`) from WASD and mouse drag:
  // horizontal movement updates only token `(x, y)` coordinates, while fall phase, cadence, scale, and bank
  // run continuously in `_tickHoverTokens` on real `dtSec` with zero WASD speedups, long-drag slowdowns, or resets!
  if (isFall && hasLiveTicker) {
    context._ssJumpAttached = true;
    if (isFallPlunge && !token._ssFallPlunge) {
      token._ssPrevAnimElevation = fromElev;
      syncTokenFlyHover(token, { ...changes, elevation: toElev }, options);
    } else if (!token._ssFallPlunge && isTokenFalling(token)) {
      if (Math.abs(fromElev - toElev) > 0.05) {
        token._ssPrevAnimElevation = fromElev;
        syncTokenFlyHover(token, { elevation: toElev }, options);
      } else {
        syncTokenFlyHover(token);
      }
    }
    token._ssMoveTrackU = 0;
    context.onAnimate ??= [];
    context.postAnimate ??= [];
    context.onAnimate.push((ctx: any) => {
      if (!token.mesh || token.mesh.destroyed) return;
      const dur = Number(ctx?.duration ?? context.duration) || 1;
      const elapsed = Number(ctx?.time ?? context.time) || 0;
      token._ssMoveTrackU = Math.max(0, Math.min(1, elapsed / dur));
      if (token._ssJumpState) applyJumpStateToToken(token);
    });
    context.postAnimate.push(() => {
      token._ssMoveTrackU = undefined;
      if (!token._ssFallPlunge) {
        token._ssVisualElevation = toElev;
        token._ssTargetElevation = toElev;
      }
      if (token._ssJumpState) applyJumpStateToToken(token);
    });
    return true;
  }

  context._ssJumpAttached = true;
  token._ssActiveMoveAnim = true;
  token._ssVerticalFlight = null;
  token._ssFallPlunge = null;
  token._ssAirJump = null;
  const jumpEndsInAir = isJump && !_isSupportedAtElevation(token, toElev, x1, y1, destLevel);
  const isUpwardJump = isJump && (toElev - fromElev) > 0.05;
  const fallStartOffsetX = Number(token._ssJumpState?.offsetX) || 0;
  const fallStartOffsetY = Number(token._ssJumpState?.offsetY) || 0;
  const fallStartTilt = Number(token._ssJumpState?.tiltAngle) || 0;
  const fallStartScaleX = Number(token._ssJumpState?.scaleX) || 1;
  const fallStartScaleY = Number(token._ssJumpState?.scaleY) || 1;
  const fallBasePhase = Number(token._ssHoverPhase) || 0;

  let startHover = 0;
  let startLiftOffset = 0;
  let startSpeed = 0;
  let startTilt = 0;
  let stepParity = 1;
  const isKbMove = (isFly || isWalk) && isKeyboardMovement(token, options);

  if (isFly) {
    const prevBlend = Number(token._ssHoverBlend);
    startHover = (Number.isFinite(prevBlend) && prevBlend > 0)
      ? Math.min(1, prevBlend)
      : (!_isSupportedAtElevation(token, fromElev, x0, y0, origLevel) ? 1 : 0);
    const baseHoverHeight = Math.min(grid * 0.28, tokenSize * 0.24);
    const liveOffsetY = Number(token._ssJumpState?.offsetY);
    if (Number.isFinite(liveOffsetY) && startHover > 0.05) {
      startLiftOffset = Math.max(-baseHoverHeight * 0.35, Math.min(baseHoverHeight * 0.35, liveOffsetY - (-baseHoverHeight * startHover)));
    }
    const prevCruise = Number(token._ssFlyCruiseSpeed) || 0;
    const prevTilt = Number(token._ssFlyTilt ?? token._ssJumpState?.tiltAngle) || 0;
    startSpeed = isKbMove ? Math.max(0, Math.min(1, prevCruise)) : 0;
    startTilt = prevTilt;
    token._ssFlyDecel = null;
  } else if (isWalk) {
    stepParity = (token._ssWalkStepParity === -1) ? -1 : 1;
    token._ssWalkStepParity = -stepParity;
    const prevWalkCruise = Number(token._ssWalkCruiseSpeed) || 0;
    startSpeed = isKbMove ? Math.max(0, Math.min(1, prevWalkCruise)) : 0;
  }

  let releaseU = -1;
  let releaseProgress = 0;
  let releaseVelocity = 1;
  let releaseTilt = 0;
  let lastProgress = 0;
  let lastVel = startSpeed;
  let lastTilt = startTilt;
  let wasContinual = isKbMove && (isMoveKeyHeld() || (Array.isArray(context.chain) && context.chain.length > 0));

  const { x: initBaseX, y: initBaseY } = _resolveBaseScale(token);

  // Initialize the starting frame synchronously (without pushing onto `context.preAnimate`,
  // avoiding an extra async `wait = Promise.all(...)` microtask inside `CanvasAnimation.animate`)
  if (token.mesh && !token.mesh.destroyed) {
    const initEndHover = isFly && isTokenInFlyMode(token, toElev, destLevel) ? 1 : 0;
    const initEndSpeed = wasContinual ? 1 : 0;
    const initFrame = isFall
        ? (isFallPlunge
          ? computeFallPlungeFrame(0, {
              fromElevation: fromElev,
              toElevation: toElev,
              gridSize: grid,
              tokenSize,
              gridDistance,
              dx,
              dy,
              startOffsetX: fallStartOffsetX,
              startOffsetY: fallStartOffsetY,
              startTilt: fallStartTilt,
              startScaleX: fallStartScaleX,
              startScaleY: fallStartScaleY
            })
          : computeFallingLoopFrame(Number(token._ssHoverBlend) || 1, fallBasePhase, { gridSize: grid, tokenSize, elevation: fromElev }))
      : (isFly
          ? computeFlyFrame(0, {
              dx,
              dy,
              gridSize: grid,
              tokenSize,
              startHover,
              endHover: initEndHover,
              startSpeed,
              endSpeed: initEndSpeed,
              startTilt,
              startLiftOffset
            })
          : (isWalk
              ? computeWalkFrame(0, {
                  dx,
                  dy,
                  gridSize: grid,
                  tokenSize,
                  startSpeed,
                  endSpeed: initEndSpeed,
                  stepParity
                })
              : computeJumpFrame(0, {
                  dx,
                  dy,
                  gridSize: grid,
                  tokenSize,
                  endInAir: jumpEndsInAir,
                  endInFalling: jumpEndsInAir && isTokenFalling(token)
                })));
    token._ssJumpState = {
      ...initFrame,
      elevation: fromElev,
      baseScaleX: initBaseX,
      baseScaleY: initBaseY
    };
    _activeJumpTokens.add(token);
  }

  context.preAnimate ??= [];
  context.onAnimate ??= [];
  context.postAnimate ??= [];
  let handedOffToFalling = false;

  context.onAnimate.push((ctx: any) => {
    if (!token.mesh || token.mesh.destroyed) return;
    const dur = Number(ctx?.duration ?? context.duration) || 1;
    const elapsed = Number(ctx?.time ?? context.time) || 0;
    const u = Math.max(0, Math.min(1, elapsed / dur));

    // If the `Falling` effect appears mid-step (`walk` / `fly` / horizontal `jump`) as the token steps off another token, tile, or ledge,
    // hand off immediately to `_tickHoverTokens` without waiting for step completion or resetting in `postAnimate`
    // (for an UPWARD jump `isUpwardJump`, let the jump arc reach its apex first!).
    if (!isFall && !isUpwardJump && hasLiveTicker && (handedOffToFalling || Boolean(token._ssFallPlunge) || isTokenFalling(token))) {
      handedOffToFalling = true;
      token._ssActiveMoveAnim = false;
      token._ssMoveTrackU = u;
      if (!_hoveringTokens.has(token) || (token._ssHoverBlend ?? 0) <= 0.001) {
        syncTokenFlyHover(token);
      }
      if (token._ssJumpState) applyJumpStateToToken(token);
      return;
    }

    token._ssActiveMoveAnim = true;

    const endHover = isFly && isTokenInFlyMode(token, toElev, destLevel) && Boolean(_getTicker()?.add) ? 1 : 0;
    let frame: JumpFrameState;

    const segCells = Math.max(1, distXY / grid);
    if (isFall) {
      if (isFallPlunge) {
        frame = computeFallPlungeFrame(u, {
          fromElevation: fromElev,
          toElevation: toElev,
          gridSize: grid,
          tokenSize,
          gridDistance,
          dx,
          dy,
          startOffsetX: fallStartOffsetX,
          startOffsetY: fallStartOffsetY,
          startTilt: fallStartTilt,
          startScaleX: fallStartScaleX,
          startScaleY: fallStartScaleY
        });
      } else {
        const phase = fallBasePhase + (elapsed * 0.001) * 1.90;
        token._ssHoverPhase = phase;
        frame = computeFallingLoopFrame(Number(token._ssHoverBlend) || 1, phase, { gridSize: grid, tokenSize, elevation: toElev });
        frame.flightProgress = u;
      }
    } else if (isFly) {
      const hasChain = Array.isArray(context.chain) && context.chain.length > 0;
      const continualNow = hasChain || (isKbMove && isMoveKeyHeld());

      if (continualNow) {
        wasContinual = true;
        releaseU = -1;
      } else if (wasContinual && releaseU < 0) {
        // User released WASD mid-flight:
        // if enough room remains in the current segment (`u < 0.72`), brake smoothly within this segment;
        // if released near the end of the cell (`u >= 0.72`), carry cruise speed into `postAnimate`
        // where the inertial `_ssFlyDecel` cushion brings the token to a smooth stop.
        wasContinual = false;
        if (u < 0.72) {
          const dirSign = Math.abs(dx) > 2 ? Math.sign(dx) : (dy < 0 ? 1 : -1);
          const maxBankDeg = distXY >= 4 ? 5.8 : 0;
          releaseU = u;
          releaseProgress = lastProgress > 0 ? lastProgress : _hermiteProgress(u, startSpeed, 1, segCells, 0.28);
          releaseVelocity = Math.max(0.25, lastVel);
          releaseTilt = Math.abs(lastTilt) > 0.1 ? lastTilt : (maxBankDeg * 0.82 * dirSign);
        }
      }

      const endSpeed = (continualNow || (isKbMove && releaseU < 0 && lastVel > 0.35 && u >= 0.72)) ? 1 : 0;
      const curVel = releaseU >= 0
        ? (releaseVelocity * (1 - _smootherstep(Math.min(1, (u - releaseU) / Math.max(1e-4, 1 - releaseU)))))
        : _hermiteVelocity(u, startSpeed, endSpeed, segCells, 0.28);
      frame = computeFlyFrame(u, {
        dx,
        dy,
        gridSize: grid,
        tokenSize,
        startHover,
        endHover,
        startSpeed,
        endSpeed,
        startTilt,
        startLiftOffset,
        releaseU,
        releaseProgress,
        releaseVelocity,
        releaseTilt
      });

      lastProgress = frame.flightProgress;
      lastVel = curVel;
      lastTilt = frame.tiltAngle;
      token._ssFlyCruiseSpeed = continualNow ? Math.max(0.35, Math.min(1, curVel)) : Math.max(0, curVel);
      token._ssFlyTilt = frame.tiltAngle;
    } else if (isWalk) {
      const hasChain = Array.isArray(context.chain) && context.chain.length > 0;
      const continualNow = hasChain || (isKbMove && isMoveKeyHeld());

      if (continualNow) {
        wasContinual = true;
        releaseU = -1;
      } else if (wasContinual && releaseU < 0) {
        wasContinual = false;
        if (u < 0.78) {
          releaseU = u;
          releaseProgress = lastProgress > 0 ? lastProgress : _hermiteProgress(u, startSpeed, 1, segCells, 0.16);
          releaseVelocity = Math.max(0.25, lastVel);
        }
      }

      const endSpeed = continualNow ? 1 : 0;
      const curVel = releaseU >= 0
        ? (releaseVelocity * (1 - _smootherstep(Math.min(1, (u - releaseU) / Math.max(1e-4, 1 - releaseU)))))
        : _hermiteVelocity(u, startSpeed, endSpeed, segCells, 0.16);
      frame = computeWalkFrame(u, {
        dx,
        dy,
        gridSize: grid,
        tokenSize,
        startSpeed,
        endSpeed,
        stepParity,
        releaseU,
        releaseProgress,
        releaseVelocity
      });

      lastProgress = frame.flightProgress;
      lastVel = curVel;
      token._ssWalkCruiseSpeed = continualNow ? Math.max(0.35, Math.min(1, curVel)) : 0;
    } else {
      frame = computeJumpFrame(u, {
        dx,
        dy,
        gridSize: grid,
        tokenSize,
        endInAir: jumpEndsInAir,
        endInFalling: jumpEndsInAir && (isTokenFalling(token) || !isTokenInFlyMode(token, toElev, destLevel))
      });
    }

    const prevBaseX = token._ssJumpState?.baseScaleX ?? initBaseX;
    const prevBaseY = token._ssJumpState?.baseScaleY ?? initBaseY;
    const liveElev = fromElev + (toElev - fromElev) * frame.flightProgress;
    token._ssVisualElevation = liveElev;

    token._ssJumpState = {
      ...frame,
      elevation: liveElev,
      baseScaleX: prevBaseX,
      baseScaleY: prevBaseY
    };
    _activeJumpTokens.add(token);

    applyJumpStateToToken(token);
  });

  context.postAnimate.push(() => {
    token._ssActiveMoveAnim = false;
    token._ssMoveTrackU = undefined;
    if (!token._ssFallPlunge) {
      token._ssVisualElevation = toElev;
      token._ssTargetElevation = toElev;
    }
    if (handedOffToFalling || token._ssFallPlunge) {
      token._ssLastElevation = toElev;
      if (!token._ssFallPlunge && isTokenFalling(token)) {
        syncTokenFlyHover(token);
      }
      if (token._ssJumpState) applyJumpStateToToken(token);
      return;
    }

    const hasChain = Array.isArray(context.chain) && context.chain.length > 0;
    const stillHoldingKb = (isFly || isWalk) && (hasChain || (isKbMove && isMoveKeyHeld()));

    const ticker = _getTicker();
    const keepFalling = isTokenFalling(token) && Boolean(ticker && typeof ticker.add === 'function');
    const keepHovering = !keepFalling && isTokenInFlyMode(token, toElev, destLevel) && Boolean(ticker && typeof ticker.add === 'function');
    if (keepFalling) {
      token._ssHoverBlend = 1;
      token._ssHoverTarget = 1;
      if (jumpEndsInAir) token._ssHoverPhase = 0;
      token._ssLastElevation = toElev;
      token._ssWasFalling = true;
      syncTokenFlyHover(token);
    } else if (keepHovering) {
      token._ssHoverBlend = 1;
      token._ssHoverTarget = 1;
      token._ssLastElevation = toElev;
      // Anchor hover phase at `0` (`Math.sin(0) === 0`) so transitioning from horizontal flight
      // into `Idle Hover` produces zero altitude discontinuity (`offsetY === -baseHoverHeight`)
      token._ssHoverPhase = 0;

      if (stillHoldingKb) {
        token._ssFlyCruiseSpeed = 1;
        token._ssFlyTilt = lastTilt;
        token._ssFlyDecel = null;
      } else if (isKbMove && releaseU < 0 && (lastVel > 0.25 || Math.abs(lastTilt) > 0.4)) {
        // WASD was released late in the step (u >= 0.72): engage soft `_ssFlyDecel` inertial coast and bank return to 0
        const dirX = distXY > 1 ? dx / distXY : 0;
        const dirY = distXY > 1 ? dy / distXY : 0;
        const cushionDist = Math.min(grid * 0.14, distXY * 0.14) * Math.min(1, lastVel);
        token._ssFlyDecel = {
          elapsed: 0,
          duration: 0.24,
          offsetX: -dirX * cushionDist,
          offsetY: -dirY * cushionDist,
          tilt: lastTilt,
          speed: lastVel
        };
      } else {
        token._ssFlyCruiseSpeed = 0;
        token._ssFlyTilt = 0;
        token._ssFlyDecel = null;
      }

      const endFrame = computeIdleHoverFrame(1, token._ssHoverPhase, { gridSize: grid, tokenSize, verticalBoost: 0 });
      if (stillHoldingKb) {
        endFrame.tiltAngle = lastTilt;
      } else if (token._ssFlyDecel) {
        endFrame.paceOffsetX = token._ssFlyDecel.offsetX;
        endFrame.paceOffsetY = token._ssFlyDecel.offsetY;
        endFrame.offsetX = (endFrame.offsetX || 0) + endFrame.paceOffsetX;
        endFrame.offsetY = (endFrame.offsetY || 0) + endFrame.paceOffsetY;
        endFrame.steadyLiftY = (endFrame.steadyLiftY || 0) + endFrame.paceOffsetY;
        endFrame.tiltAngle = token._ssFlyDecel.tilt;
      }
      const prevBaseX = token._ssJumpState?.baseScaleX ?? initBaseX;
      const prevBaseY = token._ssJumpState?.baseScaleY ?? initBaseY;
      token._ssJumpState = {
        ...endFrame,
        elevation: toElev,
        baseScaleX: prevBaseX,
        baseScaleY: prevBaseY
      };
      applyJumpStateToToken(token);
      syncTokenFlyHover(token);
    } else {
      const savedWalkParity = token._ssWalkStepParity;
      const savedWalkCruise = (isWalk && stillHoldingKb) ? 1 : 0;
      clearJumpStateForToken(token);
      token._ssLastElevation = toElev;
      token._ssWalkStepParity = savedWalkParity;
      token._ssWalkCruiseSpeed = savedWalkCruise;
    }
  });

  return true;
}

/* --------------------- Token Prototype Patching (Foundry v14) --------------------- */

const _patchedPrototypes = new WeakSet<object>();

export function installJumpAnimationPatch(TokenClass?: any) {
  _installMoveKeyListeners();
  const candidates = [
    TokenClass,
    (globalThis as any).CONFIG?.Token?.objectClass,
    (globalThis as any).foundry?.canvas?.placeables?.Token
  ].filter(c => c?.prototype);

  let patchedAny = false;
  for (const Cls of candidates) {
    const proto = Cls.prototype;
    if (_patchedPrototypes.has(proto)) continue;
    _patchedPrototypes.add(proto);
    patchedAny = true;

    // 1) Controlled token movement speed (`_getAnimationMovementSpeed` and `_getAnimationDuration`),
    //    scaled from the character's sheet movement speed (`actor.system.attributes.movement`) and global setting
    if (Object.prototype.hasOwnProperty.call(proto, '_getAnimationMovementSpeed') || Cls === candidates[candidates.length - 1]) {
      const origGetAnimationMovementSpeed = proto._getAnimationMovementSpeed;
      if (typeof origGetAnimationMovementSpeed === 'function' || Cls === candidates[candidates.length - 1]) {
        proto._getAnimationMovementSpeed = function (options: any = {}) {
          if (!getTokenMovementSetting('walk') && !_isLogicalTokenInFlyMode(this) && typeof origGetAnimationMovementSpeed === 'function') {
            return origGetAnimationMovementSpeed.call(this, options);
          }
          return computeTokenAnimationSpeed(this, options);
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_getAnimationDuration') || Cls === candidates[candidates.length - 1]) {
      const origGetAnimationDuration = proto._getAnimationDuration;
      if (typeof origGetAnimationDuration === 'function') {
        proto._getAnimationDuration = function (from: any, to: any, options: any = {}) {
          if (options?.duration !== undefined) return options.duration;
          const dx0 = (to?.x ?? from?.x ?? 0) - (from?.x ?? 0);
          const dy0 = (to?.y ?? from?.y ?? 0) - (from?.y ?? 0);
          const distXY0 = Math.hypot(dx0, dy0);
          // For any purely vertical in-place elevation change (`distXY < 4`: takeoff / climb / drop to 0),
          // return `0` so Foundry v14 does NOT run a per-frame `CanvasAnimation` on `#animationData.elevation`
          // (which in `Token5e` triggers per-frame `_refreshTooltip` + `PreciseText` rasterization,
          // `_refreshMeshSizeAndScale`, `initializeSources`, and `canvas.perception.update`),
          // letting our lightweight 60 FPS `_tickHoverTokens` ticker drive the visual transition instead.
          if (distXY0 < 4 && to && ('elevation' in to) && Boolean(_getTicker()?.add)) return 0;

          if (isFallAnimationSegment(this, from, to, options)) {
            const dx = (to?.x ?? from?.x ?? 0) - (from?.x ?? 0);
            const dy = (to?.y ?? from?.y ?? 0) - (from?.y ?? 0);
            const distXY = Math.hypot(dx, dy);
            if (distXY < 4 && Boolean(_getTicker()?.add)) return 0;
            const grid = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
            const gridDistance = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
            const fromElev = Number(from?.elevation ?? 0) || 0;
            const toElev = Number(to?.elevation ?? fromElev) || 0;
            const dropElev = Math.max(0, fromElev - toElev);
            if (dropElev > 0.5) {
              return computeFallDurationMs(dropElev, gridDistance);
            }
            const kb = isKeyboardMovement(this, options);
            return computeWalkDurationMs(distXY, grid, undefined, { keyboard: kb, token: this });
          }
          if (isJumpAnimationSegment(this, from, to, options)) {
            const dx = (to.x ?? from.x) - from.x;
            const dy = (to.y ?? from.y) - from.y;
            const dist = Math.hypot(dx, dy);
            const grid = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
            const fromElev = Number(from?.elevation ?? 0) || 0;
            const toElev = Number(to?.elevation ?? fromElev) || 0;
            const riseElev = Math.max(0, toElev - fromElev);
            const gridDist = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
            const distPixels = (globalThis as any).canvas?.dimensions?.distancePixels ?? (grid / gridDist);
            const effectiveDist = riseElev > gridDist
              ? Math.hypot(dist, (riseElev - gridDist) * distPixels * 0.45)
              : dist;
            return computeJumpDurationMs(effectiveDist, grid, undefined, { token: this });
          }
          if (isFlyAnimationSegment(this, from, to, options)) {
            const dx = (to.x ?? from.x ?? 0) - (from.x ?? 0);
            const dy = (to.y ?? from.y ?? 0) - (from.y ?? 0);
            const distXY = Math.hypot(dx, dy);
            if (distXY < 4 && Boolean(_getTicker()?.add)) return 0;
            const grid = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
            const fromElev = Number(from?.elevation ?? 0) || 0;
            const toElev = Number(to?.elevation ?? fromElev) || 0;
            const dElev = Math.abs(toElev - fromElev);
            const distPixels = (globalThis as any).canvas?.dimensions?.distancePixels ?? (grid / 5);
            const effectiveDist = distXY >= 4
              ? Math.hypot(distXY, dElev * distPixels * 0.5)
              : Math.max(grid * 1.6, dElev * distPixels);
            const kb = isKeyboardMovement(this, options);
            return computeFlyDurationMs(effectiveDist, grid, undefined, { keyboard: kb, token: this });
          }
          if (isWalkAnimationSegment(this, from, to, options)) {
            const dx = (to?.x ?? from?.x ?? 0) - (from?.x ?? 0);
            const dy = (to?.y ?? from?.y ?? 0) - (from?.y ?? 0);
            const distXY = Math.hypot(dx, dy);
            if (distXY >= 4) {
              const grid = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
              const kb = isKeyboardMovement(this, options);
              const act = typeof options?.action === 'string' ? options.action : undefined;
              return computeWalkDurationMs(distXY, grid, undefined, { keyboard: kb, token: this, action: act });
            }
          }
          return origGetAnimationDuration.call(this, from, to, options);
        };
      }
    }

    // 2) Prepare animation attributes and per-frame hooks inside `_prepareAnimation`
    if (Object.prototype.hasOwnProperty.call(proto, '_prepareAnimation') || Cls === candidates[candidates.length - 1]) {
      const origPrepareAnimation = proto._prepareAnimation;
      if (typeof origPrepareAnimation === 'function') {
        proto._prepareAnimation = function (from: any, changes: any, context: any, options: any = {}) {
          if (changes && ('elevation' in changes) && from && Number.isFinite(Number(from.elevation))) {
            this._ssPrevAnimElevation = Number(from.elevation);
          }
          const attrs = origPrepareAnimation.call(this, from, changes, context, options);
          const attached = attachJumpAnimationToContext(this, from, changes, context, options);
          // Strip per-frame `this.#animationData.elevation` interpolation out of `CanvasAnimation`:
          // in Foundry VTT v14 (`token.mjs` line 2640: `recur(changes, this.#animationData)`),
          // the `elevation` entry in `attrs` has `a.parent === this.#animationData` (a private `Token` field),
          // NOT `this.document`! Interpolating `a.parent.elevation` at 60 FPS causes `_onAnimationUpdate`
          // to set `refreshElevation: true` every frame, which in `Token5e` (`dnd5e.mjs` line 82276)
          // cascades into:
          //  - `_refreshTooltip()`: `new PIXI.TextStyle` allocation, CPU `PreciseText` rasterization, and GPU texture upload;
          //  - `_refreshMesh()` -> `_refreshMeshSizeAndScale()`: `this.ring.configureSize()` and `this.mesh.resize()`;
          //  - `this.initializeSources()` + `canvas.perception.update()`: full 3D light, vision, and occlusion polygon rebuilds.
          // Snap `a.parent.elevation = a.to` and `a.from = a.to` immediately for EVERY segment touching `elevation`
          // so `this.#animationData.elevation` updates once and `CanvasAnimation.animate` (`a.delta === 0`)
          // skips per-frame `elevation` interpolation altogether.
          if (Array.isArray(attrs)) {
            let hasNonZeroAttr = false;
            for (let i = 0; i < attrs.length; i++) {
              const a = attrs[i];
              if (!a) continue;
              if (a.attribute === 'elevation' && a.parent) {
                a.parent.elevation = a.to;
                a.from = a.to;
              } else if (a.from !== a.to) {
                hasNonZeroAttr = true;
              }
            }
            if (attached && !hasNonZeroAttr) {
              this._ssElevProgress = 0;
              attrs.push({ attribute: '_ssElevProgress', parent: this, from: 0, to: 1 });
            }
          }
          return attrs;
        };
      }
    }

    // 3) Re-apply jump arc, scale, bank, and elevation perspective after `_refreshPosition`, `_refreshElevation`, `_refreshMeshSizeAndScale`, and `_refreshRotation`
    if (Object.prototype.hasOwnProperty.call(proto, '_refreshPosition') || Cls === candidates[candidates.length - 1]) {
      const origRefreshPosition = proto._refreshPosition;
      if (typeof origRefreshPosition === 'function') {
        proto._refreshPosition = function (...args: any[]) {
          const outer = !this._ssInRefreshPos;
          this._ssInRefreshPos = true;
          try {
            const res = origRefreshPosition.apply(this, args);
            if (outer) {
              const previewSrc = this.isPreview ? (this._ssPreviewSourceToken ?? this._original) : null;
              if (previewSrc && (previewSrc._ssJumpState || previewSrc._ssPerspState)) {
                _syncDragPreviewFromToken(previewSrc);
              } else if (this._ssJumpState) {
                applyJumpStateToToken(this);
              } else if (this._ssPerspState) {
                _applyStationaryPerspectiveToToken(this);
              } else if (
                this._ssMeshAnimOffset
                && (this._ssMeshAnimOffset.x || this._ssMeshAnimOffset.y)
                && !this._animation
                && this.mesh
                && !this.mesh.destroyed
              ) {
                const c = this.center;
                if (c) {
                  this.mesh.position.set(c.x + this._ssMeshAnimOffset.x, c.y + this._ssMeshAnimOffset.y);
                }
              }
            }
            return res;
          } finally {
            if (outer) this._ssInRefreshPos = false;
          }
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_refreshElevation') || Cls === candidates[candidates.length - 1]) {
      const origRefreshElevation = proto._refreshElevation;
      if (typeof origRefreshElevation === 'function') {
        proto._refreshElevation = function (...args: any[]) {
          const outer = !this._ssInRefreshElev;
          this._ssInRefreshElev = true;
          try {
            const res = origRefreshElevation.apply(this, args);
            if (outer) {
              if (this._ssJumpState) applyJumpStateToToken(this);
              else if (this._ssPerspState) _applyStationaryPerspectiveToToken(this);
            }
            return res;
          } finally {
            if (outer) this._ssInRefreshElev = false;
          }
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_refreshSize') || Cls === candidates[candidates.length - 1]) {
      const origRefreshSize = proto._refreshSize;
      if (typeof origRefreshSize === 'function') {
        proto._refreshSize = function (...args: any[]) {
          const outer = !this._ssInRefreshSize;
          this._ssInRefreshSize = true;
          try {
            const res = origRefreshSize.apply(this, args);
            if (outer) {
              if (this._ssJumpState) applyJumpStateToToken(this);
              else if (this._ssPerspState) _applyStationaryPerspectiveToToken(this);
            }
            return res;
          } finally {
            if (outer) this._ssInRefreshSize = false;
          }
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_refreshTooltip') || Cls === candidates[candidates.length - 1]) {
      const origRefreshTooltip = proto._refreshTooltip;
      if (typeof origRefreshTooltip === 'function') {
        proto._refreshTooltip = function (...args: any[]) {
          const outer = !this._ssInRefreshTooltip;
          this._ssInRefreshTooltip = true;
          try {
            const res = origRefreshTooltip.apply(this, args);
            if (outer) {
              if (this._ssJumpState) applyJumpStateToToken(this);
              else if (this._ssPerspState) _applyStationaryPerspectiveToToken(this);
            }
            return res;
          } finally {
            if (outer) this._ssInRefreshTooltip = false;
          }
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_refreshMeshSizeAndScale') || Cls === candidates[candidates.length - 1]) {
      const origRefreshMeshSizeAndScale = proto._refreshMeshSizeAndScale;
      if (typeof origRefreshMeshSizeAndScale === 'function') {
        proto._refreshMeshSizeAndScale = function (...args: any[]) {
          const outer = !this._ssInRefreshMesh;
          this._ssInRefreshMesh = true;
          try {
            const preBaseX = this._ssJumpState?.baseScaleX ?? this._ssPerspState?.baseScaleX;
            const preBaseY = this._ssJumpState?.baseScaleY ?? this._ssPerspState?.baseScaleY;
            if (outer && this.mesh && preBaseX != null && preBaseY != null) {
              this.mesh.scale.set(preBaseX, preBaseY);
            }
            const res = origRefreshMeshSizeAndScale.apply(this, args);
            if (outer && this.mesh) {
              this._ssBaseScaleX = this.mesh.scale.x;
              this._ssBaseScaleY = this.mesh.scale.y;
              if (this._ssJumpState) {
                this._ssJumpState.baseScaleX = this.mesh.scale.x;
                this._ssJumpState.baseScaleY = this.mesh.scale.y;
                applyJumpStateToToken(this);
              } else if (this._ssPerspState) {
                this._ssPerspState.baseScaleX = this.mesh.scale.x;
                this._ssPerspState.baseScaleY = this.mesh.scale.y;
                _applyStationaryPerspectiveToToken(this);
              } else if (this._ssMeshAnimOffset && (this._ssMeshAnimOffset.scaleX || this._ssMeshAnimOffset.scaleY)) {
                const msx = Math.max(0.15, 1 + (Number(this._ssMeshAnimOffset.scaleX) || 0));
                const msy = Math.max(0.15, 1 + (Number(this._ssMeshAnimOffset.scaleY) || 0));
                this.mesh.scale.set(this.mesh.scale.x * msx, this.mesh.scale.y * msy);
              }
            }
            return res;
          } finally {
            if (outer) this._ssInRefreshMesh = false;
          }
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_refreshRotation') || Cls === candidates[candidates.length - 1]) {
      const origRefreshRotation = proto._refreshRotation;
      if (typeof origRefreshRotation === 'function') {
        proto._refreshRotation = function (...args: any[]) {
          const outer = !this._ssInRefreshRot;
          this._ssInRefreshRot = true;
          try {
            const res = origRefreshRotation.apply(this, args);
            if (outer && this.mesh) {
              if (this._ssJumpState) {
                const baseAngle = this.document?.lockRotation ? 0 : (this.document?.rotation ?? 0);
                this.mesh.angle = baseAngle + (this._ssJumpState.tiltAngle || 0) + (Number(this._ssMeshAnimOffset?.angle) || 0);
              } else if (this._ssMeshAnimOffset?.angle) {
                const baseAngle = this.document?.lockRotation ? 0 : (this.document?.rotation ?? 0);
                this.mesh.angle = baseAngle + (Number(this._ssMeshAnimOffset.angle) || 0);
              }
            }
            return res;
          } finally {
            if (outer) this._ssInRefreshRot = false;
          }
        };
      }
    }

    for (const refreshMethod of ['_refreshState', '_refreshVisibility', '_refreshShape', '_refreshNameplate']) {
      if (Object.prototype.hasOwnProperty.call(proto, refreshMethod) || Cls === candidates[candidates.length - 1]) {
        const origFn = proto[refreshMethod];
        if (typeof origFn === 'function') {
          proto[refreshMethod] = function (...args: any[]) {
            const res = origFn.apply(this, args);
            if (this._ssJumpState) applyJumpStateToToken(this);
            else if (this._ssPerspState) _applyStationaryPerspectiveToToken(this);
            return res;
          };
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_overlapsSelection') || Cls === candidates[candidates.length - 1]) {
      const origOverlapsSelection = proto._overlapsSelection;
      if (typeof origOverlapsSelection === 'function') {
        proto._overlapsSelection = function (rectangle: any, ...rest: any[]) {
          const hb = this._ssHitboxRect;
          if (hb?.occluded) return false;
          if (hb && rectangle && typeof rectangle.x === 'number') {
            const RectCls = rectangle.constructor ?? (globalThis as any).PIXI?.Rectangle;
            if (typeof RectCls === 'function') {
              const posX = Number(this.position?.x ?? this.document?.x) || 0;
              const posY = Number(this.position?.y ?? this.document?.y) || 0;
              const sc = Math.max(0.1, Number(hb.scale) || 1);
              const invRect = new RectCls(
                posX + (rectangle.x - posX - hb.x) / sc,
                posY + (rectangle.y - posY - hb.y) / sc,
                rectangle.width / sc,
                rectangle.height / sc
              );
              return origOverlapsSelection.call(this, invRect, ...rest);
            }
          }
          return origOverlapsSelection.call(this, rectangle, ...rest);
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_getDragOrigin') || Cls === candidates[candidates.length - 1]) {
      const origGetDragOrigin = proto._getDragOrigin;
      if (typeof origGetDragOrigin === 'function') {
        proto._getDragOrigin = function (...args: any[]) {
          const pt = origGetDragOrigin.apply(this, args);
          const off = this._ssHitboxOffset;
          if (pt && off && (off.x || off.y)) {
            return {
              ...pt,
              x: (Number(pt.x) || 0) + (Number(off.x) || 0),
              y: (Number(pt.y) || 0) + (Number(off.y) || 0)
            };
          }
          return pt;
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(proto, '_onDelete') || Cls === candidates[candidates.length - 1]) {
      const origOnDelete = proto._onDelete;
      if (typeof origOnDelete === 'function') {
        proto._onDelete = function (...args: any[]) {
          clearJumpStateForToken(this, { destroyShadow: true });
          return origOnDelete.apply(this, args);
        };
      }
    }
  }

  // Patch `TokenHUD` / `BasePlaceableHUD` positioning so the right-click HUD aligns cleanly around the token's visual hitbox
  const hudCandidates = [
    (globalThis as any).CONFIG?.Token?.hudClass?.prototype,
    (globalThis as any).foundry?.applications?.hud?.TokenHUD?.prototype,
    (globalThis as any).foundry?.applications?.hud?.BasePlaceableHUD?.prototype
  ].filter(Boolean);
  for (const hudProto of hudCandidates) {
    if (_patchedPrototypes.has(hudProto)) continue;
    if (!Object.prototype.hasOwnProperty.call(hudProto, '_updatePosition')) continue;
    const origHudUpdatePos = hudProto._updatePosition;
    if (typeof origHudUpdatePos !== 'function') continue;
    _patchedPrototypes.add(hudProto);
    hudProto._updatePosition = function (position: any, ...rest: any[]) {
      const updated = origHudUpdatePos.call(this, position, ...rest);
      const tok = this.object;
      const hb = tok?._ssHitboxRect;
      if (updated && hb && !hb.occluded && tok?.document) {
        const uiS = (globalThis as any).canvas?.dimensions?.uiScale || 1;
        updated.left = (Number(tok.document.x) || 0) + hb.x;
        updated.top = (Number(tok.document.y) || 0) + hb.y;
        updated.width = hb.width / uiS;
        updated.height = hb.height / uiS;
      }
      return updated;
    };
    patchedAny = true;
    break;
  }

  // 4) Patch `TokenDocument5e.prototype._isFalling` and `_onUpdateMovement` (dnd5e 6.0.0, `dnd5e.mjs` lines 93294, 93502):
  // In dnd5e 6.0.0, `_isFalling()` checks only innate `actor.system.attributes.movement.speeds.fly`,
  // ignoring the token's selected `movementAction === 'fly' | 'hover'`.
  // Consequently, every takeoff (`0 -> 5` ft), altitude step (`5 -> 10` ft), and landing (`5 -> 0` ft) in `'fly'` mode
  // for an actor without a permanent sheet fly speed caused `TokenDocument5e#_onUpdateMovement`
  // to fire asynchronously right in the middle of the animation (~40 ms after start):
  //   1) `await this.actor.setFlag("dnd5e", "lastMovedToken", this.uuid)` (on unlinked tokens triggers a `delta` update -> `redraw: true`)
  //   2) `await this.actor.toggleStatusEffect("falling", { active: true / false })`
  // Creating/deleting the `falling` ActiveEffect plus `setFlag` triggered full actor `prepareData`,
  // `token.mesh` recreation (`PlaceableObject#draw`), and a visible hitch on takeoff and landing.
  let dndDocProto = (globalThis as any).dnd5e?.documents?.TokenDocument5e?.prototype ?? null;
  if (!dndDocProto) {
    let cur = (globalThis as any).CONFIG?.Token?.documentClass?.prototype;
    while (cur && cur !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(cur, '_isFalling')) {
        dndDocProto = cur;
        break;
      }
      cur = Object.getPrototypeOf(cur);
    }
  }
  if (dndDocProto && !_patchedPrototypes.has(dndDocProto) && typeof dndDocProto._isFalling === 'function') {
    _patchedPrototypes.add(dndDocProto);
    const origFindSurf = dndDocProto._findSupportingSurface;
    if (typeof origFindSurf === 'function') {
      _origFindSupportingSurface = origFindSurf;
      const wrappedFindSurf: any = function (opts: any = {}) {
        return resolveSupportingSurface(this, opts?.position, origFindSurf);
      };
      wrappedFindSurf._ssWrapped = true;
      dndDocProto._findSupportingSurface = wrappedFindSurf;
    }
    const origIsFalling = dndDocProto._isFalling;
    dndDocProto._isFalling = function (...args: any[]) {
      const posArg = args[0]?.position;
      if (isTokenInLevelChangeRegion(this, posArg)) {
        return false;
      }
      const act = String(this.movementAction ?? this._source?.movementAction ?? '').trim();
      const canHover = Boolean(this.actor?.system?.attributes?.movement?.hover);
      const canFlyByAction = isFlyActionName(act) && (!this.actor?.statuses?.has?.('prone') || canHover) && !this.actor?.statuses?.has?.('incapacitated');
      const canFlyBySheet = (!act || GROUND_DEFAULT_ACTION_RE.test(act)) && hasActorSheetFlySpeed(this);
      if ((canFlyByAction || canFlyBySheet) && !this.actor?.statuses?.has?.('falling')) {
        return false;
      }
      // A nominal sheet fly speed <= 1 ft (insufficient for true flight > 1 ft) without `hover` or active `fly` mode
      // does not grant flight — check solid surface support beneath the token just like a grounded creature
      const sheetFlyFt = getActorSheetFlySpeedFt(this);
      if (sheetFlyFt > 0 && sheetFlyFt <= 1 && !canHover && !isFlyActionName(act)) {
        const ciFalling = Boolean((globalThis as any).foundry?.utils?.getProperty?.(this.actor, 'system.traits.ci.value')?.has?.('falling'));
        if (!ciFalling && typeof this._findSupportingSurface === 'function') {
          const pos = posArg ?? this._source;
          const surface = this._findSupportingSurface({ position: pos });
          return Boolean(surface && surface.elevation < pos.elevation);
        }
      }
      return origIsFalling.apply(this, args);
    };
    const origUpdateFalling = dndDocProto.updateFalling;
    if (typeof origUpdateFalling === 'function') {
      dndDocProto.updateFalling = function (movement: any, ...rest: any[]) {
        // When `Falling` is ALREADY active on a token, purely horizontal WASD or mouse-drag movement
        // (without changing `elevation` or `level`) must NOT clear `Falling` inside `dnd5e.updateFalling`
        // (including falls at `elevation = 0` or on creatures with a fly speed), while still running all `MidiQOL` / `Regions` hooks.
        if (this.actor?.statuses?.has?.('falling') && movement?.origin && movement?.destination) {
          const origElev = Number(movement.origin.elevation ?? this.elevation ?? 0);
          const destElev = Number(movement.destination.elevation ?? this.elevation ?? 0);
          const origLevel = movement.origin.level ?? this._source?.level;
          const destLevel = movement.destination.level ?? this._source?.level;
          const isExplicitFall = movement?.passed?.waypoints?.some?.((wp: any) => wp?.action === 'fall');
          if (!isExplicitFall && Math.abs(destElev - origElev) < 0.05 && origLevel === destLevel) {
            // Exception: if an unsupported mid-air falling token steps horizontally onto a solid floor/tile/balcony at its elevation
            // (across any negative, zero, or positive level), allow native `updateFalling` to clear the `Falling` status!
            const origSurfElev = resolveSupportingSurface(this, movement.origin, _origFindSupportingSurface)?.elevation ?? -Infinity;
            const destSurfElev = resolveSupportingSurface(this, movement.destination, _origFindSupportingSurface)?.elevation ?? -Infinity;
            const wasSupportedAtOrig = origSurfElev >= origElev - 0.05;
            const isSupportedAtDest = destSurfElev >= destElev - 0.05;
            const landedOnSolidFloor = !wasSupportedAtOrig && isSupportedAtDest;
            if (!landedOnSolidFloor) {
              return Promise.resolve();
            }
          }
        }
        return origUpdateFalling.call(this, movement, ...rest);
      };
    }
    const parentDocProto = Object.getPrototypeOf(dndDocProto);
    const origOnUpdateMovement = dndDocProto._onUpdateMovement;
    if (typeof origOnUpdateMovement === 'function') {
      dndDocProto._onUpdateMovement = async function (movement: any, operation: any, user: any) {
        const act = String(this.movementAction ?? this._source?.movementAction ?? '').trim();
        const canHover = Boolean(this.actor?.system?.attributes?.movement?.hover);
        const canFlyByAction = isFlyActionName(act) && (!this.actor?.statuses?.has?.('prone') || canHover) && !this.actor?.statuses?.has?.('incapacitated');
        const canFlyBySheet = (!act || GROUND_DEFAULT_ACTION_RE.test(act)) && hasActorSheetFlySpeed(this);
        if (
          (canFlyByAction || canFlyBySheet) &&
          !this.actor?.statuses?.has?.('falling') &&
          !operation?.dnd5e?.fall?.distance
        ) {
          if (typeof parentDocProto?._onUpdateMovement === 'function') {
            return parentDocProto._onUpdateMovement.call(this, movement, operation, user);
          }
          return;
        }
        // Wait for the token's visual step/movement animation to finish (`movement.animation.ended` / `movementAnimationPromise`)
        // so the `Falling` status (`falling.svg`) and falling loop engage right as the token steps off support into empty air,
        // rather than snapping on at `t = 0 ms` mid-stride across a roof, bridge, or supporting token
        // (including when the designated GM client has the token off-screen and skips local animation).
        if (operation?.animate !== false && !_isTeleportOperation(operation, movement, this.id)) {
          const tMoveStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
          await Promise.resolve();
          const segProm = movement?.animation?.ended;
          const objProm = this.object && !this.object.destroyed ? this.object.movementAnimationPromise : null;
          if (segProm && typeof segProm.then === 'function') {
            try { await segProm; } catch { /* ignore */ }
          }
          if (objProm && objProm !== segProm && typeof objProm.then === 'function') {
            try { await objProm; } catch { /* ignore */ }
          }
          // When the token performs an upward air-jump (`_ssAirJump`, e.g. pressing `E`),
          // wait until the arc reaches its apex (`AIR_JUMP_APEX_T`) so `Falling` engages right at the peak of the jump!
          while (this.object && !this.object.destroyed && this.object._ssAirJump) {
            const aj = this.object._ssAirJump;
            const remApexMs = Math.round((Number(aj.durationMs) || 0) * AIR_JUMP_APEX_T - (Number(aj.elapsed) || 0));
            if (remApexMs <= 16) break;
            await new Promise((r) => setTimeout(r, remApexMs));
          }
          if (
            movement?.origin &&
            movement?.destination &&
            !movement?.passed?.waypoints?.some?.((wp: any) => wp?.action === 'fall' || wp?.action === 'blink')
          ) {
            const dx = (Number(movement.destination.x) || 0) - (Number(movement.origin.x) || 0);
            const dy = (Number(movement.destination.y) || 0) - (Number(movement.origin.y) || 0);
            const distPx = Math.hypot(dx, dy);
            const origElev = Number(movement.origin.elevation ?? 0) || 0;
            const destElev = Number(movement.destination.elevation ?? origElev) || 0;
            const riseElev = Math.max(0, destElev - origElev);
            const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tMoveStart;
            if (getTokenMovementSetting('walk') && distPx > 2 && elapsedMs < 40) {
              const grid = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
              const expectedMs = computeWalkDurationMs(distPx, grid, undefined, { token: this.object ?? this });
              const remainMs = Math.round(expectedMs - elapsedMs);
              if (remainMs > 24) {
                await new Promise((r) => setTimeout(r, remainMs));
              }
            } else if (
              getTokenMovementSetting('jump') &&
              distPx <= 2 &&
              riseElev > 0.5 &&
              elapsedMs < 40 &&
              !isTokenFalling(this.object ?? this) &&
              !_isLogicalTokenInFlyMode(this.object ?? this, destElev, movement.destination.level) &&
              (movement.origin.level ?? null) === (movement.destination.level ?? null) &&
              !isClimbActionName(movement?.passed?.waypoints?.at?.(-1)?.action) &&
              !isTokenInLevelChangeRegion(this) &&
              _isSupportedAtElevation(
                this.object ?? this,
                origElev,
                movement.origin.x,
                movement.origin.y,
                movement.origin.level
              ) &&
              !_isSupportedAtElevation(
                this.object ?? this,
                destElev,
                movement.destination.x,
                movement.destination.y,
                movement.destination.level
              )
            ) {
              const gridDist = Number((globalThis as any).canvas?.scene?.grid?.distance ?? (globalThis as any).canvas?.dimensions?.distance) || 5;
              const expectedApexMs = Math.round(
                computeAirJumpDurationMs(riseElev, gridDist, undefined, { token: this.object ?? this }) * AIR_JUMP_APEX_T
              );
              const remainMs = Math.round(expectedApexMs - elapsedMs);
              if (remainMs > 24) {
                await new Promise((r) => setTimeout(r, remainMs));
              }
            }
          }
        }
        return origOnUpdateMovement.call(this, movement, operation, user);
      };
    }

    // Synchronize native `plummet()` and `playLandingVfx` (dust burst + screen shake + fall damage roll)
    // with the actual ground-impact instant (`FALL_IMPACT_T * durationMs`) of the `_ssFallPlunge` dive
    // so landing VFX never fire prematurely at `t = 0 ms` before the token finishes falling.
    const origDocOnUpdate = dndDocProto._onUpdate;
    if (
      typeof origDocOnUpdate === 'function' &&
      Object.prototype.hasOwnProperty.call(dndDocProto, '_onUpdate') &&
      parentDocProto &&
      typeof parentDocProto._onUpdate === 'function'
    ) {
      if (!(parentDocProto._onUpdate as any)._ssLandingGuardWrapped) {
        const origParentOnUpdate = parentDocProto._onUpdate;
        const guardedParentOnUpdate: any = function (...pArgs: any[]) {
          if (this._ssOnlyLandingVfx) return;
          return origParentOnUpdate.apply(this, pArgs);
        };
        guardedParentOnUpdate._ssLandingGuardWrapped = true;
        parentDocProto._onUpdate = guardedParentOnUpdate;
      }

      dndDocProto._onUpdate = function (changed: any, options: any, userId: any) {
        if (this._ssOnlyLandingVfx) {
          return origDocOnUpdate.call(this, changed, options, userId);
        }
        const fallDist = Number(options?.dnd5e?.fall?.distance) || 0;
        const ticker = _getTicker();
        if (fallDist > 0 && ticker && typeof ticker.add === 'function') {
          parentDocProto._onUpdate.call(this, changed, options, userId);
          const plunge = this.object?._ssFallPlunge;
          const impactDelayMs = plunge ? Math.max(0, Math.round(plunge.durationMs * FALL_IMPACT_T)) : 0;
          const runLandingVfx = () => {
            if (!this.parent || this.object?.destroyed) return;
            this._ssOnlyLandingVfx = true;
            try {
              origDocOnUpdate.call(this, {}, { dnd5e: { fall: { distance: fallDist } } }, userId);
            } finally {
              this._ssOnlyLandingVfx = false;
            }
          };
          if (impactDelayMs > 16) {
            setTimeout(runLandingVfx, impactDelayMs);
          } else {
            runLandingVfx();
          }
          return;
        }
        return origDocOnUpdate.call(this, changed, options, userId);
      };
    }

    const origDocMove = dndDocProto.move;
    if (typeof origDocMove === 'function' && !(origDocMove as any)._ssPlummetImpactWrapped) {
      const wrappedDocMove: any = async function (waypoints: any, options?: any) {
        const res = await origDocMove.call(this, waypoints, options);
        const fallDist = Number(options?.dnd5e?.fall?.distance) || 0;
        if (fallDist > 0 && options?.animate === false) {
          const plunge = this.object?._ssFallPlunge;
          const impactDelayMs = plunge ? Math.max(0, Math.round(plunge.durationMs * FALL_IMPACT_T)) : 0;
          if (impactDelayMs > 16) {
            await new Promise((r) => setTimeout(r, impactDelayMs));
          }
        }
        return res;
      };
      wrappedDocMove._ssPlummetImpactWrapped = true;
      dndDocProto.move = wrappedDocMove;
    }

    patchedAny = true;
  }

  // 5) Patch `TokenLayer.prototype.moveMany` and `TokenLayer.prototype._prepareKeyboardMovementUpdates`:
  //    - synchronizes the WASD hold-repeat timer;
  //    - eliminates sub-pixel float drift (`3789.6072072080665` when shifting odd-width tokens in `Token5e`),
  //      which caused `PlaceableObject._getShiftedPosition` (`position.x >= snapped.x - 1.5`) to burn 2 separate WASD steps
  //      inside the same grid cell (first re-centering within the cell, and only then stepping into the adjacent cell).
  const layerProto = (globalThis as any).foundry?.canvas?.layers?.TokenLayer?.prototype
    ?? Object.getPrototypeOf((globalThis as any).canvas?.tokens ?? {});
  if (layerProto && typeof layerProto.moveMany === 'function' && !_patchedPrototypes.has(layerProto)) {
    _patchedPrototypes.add(layerProto);
    const origMoveMany = layerProto.moveMany;
    layerProto.moveMany = function (...args: any[]) {
      _lastWasdDispatchMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return origMoveMany.apply(this, args);
    };
    const origPrepKbMove = layerProto._prepareKeyboardMovementUpdates;
    if (typeof origPrepKbMove === 'function') {
      layerProto._prepareKeyboardMovementUpdates = function (objects: any[], dx: number, dy: number, dz: number) {
        const restores: Array<{ src: any; x: number; y: number }> = [];
        if (Array.isArray(objects) && !(globalThis as any).canvas?.grid?.isGridless && (dx || dy)) {
          for (const obj of objects) {
            const doc = obj?.document;
            const src = doc?._source;
            if (!doc || !src || typeof doc.getSnappedPosition !== 'function') continue;
            const snapped = doc.getSnappedPosition({
              x: src.x,
              y: src.y,
              elevation: src.elevation,
              width: src.width,
              height: src.height,
              shape: src.shape
            });
            if (snapped && Number.isFinite(snapped.x) && Number.isFinite(snapped.y)) {
              const gridSz = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
              // Temporarily snap `doc._source` only during synchronous `_getShiftedPosition` so WASD steps straight
              // into the neighbor cell, then immediately restore `doc._source` so `#preUpdateMovement` preserves
              // the true movement origin and region boundary crossings.
              if (
                (src.x !== snapped.x || src.y !== snapped.y) &&
                Math.abs(src.x - snapped.x) < gridSz * 0.45 &&
                Math.abs(src.y - snapped.y) < gridSz * 0.45
              ) {
                restores.push({ src, x: src.x, y: src.y });
                src.x = snapped.x;
                src.y = snapped.y;
              }
            }
          }
        }
        try {
          return origPrepKbMove.call(this, objects, dx, dy, dz);
        } finally {
          for (let i = 0; i < restores.length; i++) {
            const r = restores[i];
            r.src.x = r.x;
            r.src.y = r.y;
          }
        }
      };
    }
    patchedAny = true;
  }

  // 6) Patch `PrimaryCanvasGroup.prototype.renderAdvanced` to batch consecutive DoF-blurred children
  //    into 1-3 shared layer passes instead of running a separate full-screen BlurFilter per tile/door.
  const primaryGroupProto = (globalThis as any).foundry?.canvas?.groups?.PrimaryCanvasGroup?.prototype
    ?? ((globalThis as any).canvas?.primary ? Object.getPrototypeOf((globalThis as any).canvas.primary) : null);
  if (primaryGroupProto && typeof primaryGroupProto.renderAdvanced === 'function' && !_patchedPrototypes.has(primaryGroupProto)) {
    _patchedPrototypes.add(primaryGroupProto);
    const origPrimaryRenderAdvanced = primaryGroupProto.renderAdvanced;
    primaryGroupProto._ssGroupedDofPatched = true;
    primaryGroupProto.renderAdvanced = function (renderer: any) {
      const activePrimary = (globalThis as any).canvas?.primary;
      if (this !== activePrimary || _dofFilteredObjects.size === 0 || this.cullable) {
        return origPrimaryRenderAdvanced.call(this, renderer);
      }
      const filters = this.filters;
      const mask = this._mask;
      if (filters) {
        this._enabledFilters || (this._enabledFilters = []);
        this._enabledFilters.length = 0;
        for (let h = 0; h < filters.length; h++) {
          if (filters[h]?.enabled) this._enabledFilters.push(filters[h]);
        }
      }
      const maskNone = (globalThis as any).PIXI?.MASK_TYPES?.NONE ?? 0;
      const hasEnabledFilters = Boolean(filters && this._enabledFilters?.length);
      const hasActiveMask = Boolean(mask && (!mask.isMaskData || (mask.enabled && (mask.autoDetect || mask.type !== maskNone))));
      const needFlush = hasEnabledFilters || hasActiveMask;
      if (needFlush) renderer.batch.flush();
      if (hasEnabledFilters) renderer.filter.push(this, this._enabledFilters);
      if (hasActiveMask) renderer.mask.push(this, mask);

      this._render(renderer);
      _renderPrimaryChildrenWithGroupedDof(this, renderer);

      if (needFlush) renderer.batch.flush();
      if (hasActiveMask) renderer.mask.pop(this);
      if (hasEnabledFilters) renderer.filter.pop();
    };
    patchedAny = true;
  }

  return patchedAny;
}

function _syncActorOrTokenFallingState(target: any) {
  if (!target) return;
  try {
    // 1) Direct token reference (synthetic unlinked Actor `target.token.object` or `ActorDelta.parent.object`)
    const directTokenObj = target.object
      ?? target.token?.object
      ?? (target.documentName === 'ActorDelta' ? target.parent?.object : null)
      ?? (target.mesh ? target : null);
    if (directTokenObj && !directTokenObj.destroyed) {
      syncTokenFlyHover(directTokenObj);
      return;
    }
    // 2) Linked Actor — synchronize all of its tokens on the active scene
    const placeables: any[] | undefined = (globalThis as any).canvas?.tokens?.placeables;
    if (!Array.isArray(placeables)) return;
    const targetActor = target.actor ?? (target.documentName === 'Actor' ? target : target.parent);
    for (const tok of placeables) {
      if (!tok || tok.destroyed) continue;
      if (targetActor && (tok.actor === targetActor || tok.actor?.id === targetActor.id)) {
        syncTokenFlyHover(tok);
      }
    }
  } catch { /* ignore */ }
}

let _pendingSupportReevalTimer: any = null;
let _pendingMovedTokenId: string | null = null;

/* --------------------- Foundry Lifecycle & Document Hooks --------------------- */

/**
 * Re-evaluate solid support beneath all elevated tokens (`elevation > 0`) whenever a tile or another token
 * moves, resizes, hides, or is deleted from underneath them.
 */
function _scheduleSupportReeval(movedTokenId?: string | null) {
  invalidateSupportingSurfaces();
  if (movedTokenId !== undefined) {
    // When triggered by a tile/region (`null`), re-check every token; when triggered by a token, skip only that token itself
    _pendingMovedTokenId = _pendingMovedTokenId === null ? null : (movedTokenId ?? null);
  } else {
    _pendingMovedTokenId = null;
  }
  if (_pendingSupportReevalTimer !== null) return;
  _pendingSupportReevalTimer = setTimeout(() => {
    const skipId = _pendingMovedTokenId;
    _pendingSupportReevalTimer = null;
    _pendingMovedTokenId = undefined as any;
    try {
      const placeables: any[] | undefined = (globalThis as any).canvas?.tokens?.placeables;
      if (!Array.isArray(placeables)) return;
      const g = (globalThis as any).game;
      const disableFalling = Boolean((globalThis as any).dnd5e?.settings?.disableFalling);
      for (const tok of placeables) {
        if (!tok || tok.destroyed || tok.isPreview) continue;
        const doc = tok.document;
        const actor = tok.actor ?? doc?.actor;
        if (
          doc &&
          actor &&
          !disableFalling &&
          (!skipId || doc.id !== skipId) &&
          !tok._ssActiveMoveAnim &&
          !tok._ssAirJump &&
          typeof doc._isFalling === 'function'
        ) {
          const canUpdate = Boolean(
            g?.user?.isActiveGM
            || (typeof g?.user?.isDesignated === 'function'
              ? g.user.isDesignated((u: any) => u.active && actor.canUserModify?.(u, 'update'))
              : g?.user?.isGM)
          );
          if (canUpdate) {
            const shouldFall = !isTokenInLevelChangeRegion(tok) && Boolean(doc._isFalling());
            const hasFall = Boolean(actor.statuses?.has?.('falling'));
            if (shouldFall !== hasFall) {
              actor.toggleStatusEffect?.('falling', { active: shouldFall });
            }
          }
        }
        if (!tok._ssActiveMoveAnim) {
          syncTokenFlyHover(tok);
        }
      }
    } catch { /* ignore */ }
  }, 35);
}

/** Reconcile live tokens, DoF blur, and altitude camera zoom after any setting changes. */
export function refreshTokenMovementSettings() {
  const cfg = getTokenMovementSettings();
  if (!cfg.vertical || !cfg.verticalBlur) {
    _clearAllDofFilters();
  }
  if (!cfg.vertical) {
    _elevAnimatingTokens.clear();
    for (const tok of Array.from(_perspectiveTokens)) {
      _clearStationaryPerspectiveForToken(tok);
    }
  }
  const placeables: any[] | undefined = (globalThis as any).canvas?.tokens?.placeables;
  if (Array.isArray(placeables)) {
    for (const tok of placeables) {
      if (!tok || tok.destroyed || tok.isPreview) continue;
      if (!cfg.jump && tok._ssAirJump) {
        tok._ssAirJump = null;
        clearJumpStateForToken(tok);
      }
      if (!cfg.fall && (tok._ssFallPlunge || tok._ssWasFalling)) {
        tok._ssFallPlunge = null;
        tok._ssWasFalling = false;
        clearJumpStateForToken(tok);
      }
      if (!cfg.fly && !tok._ssActiveMoveAnim && (_hoveringTokens.has(tok) || (tok._ssHoverBlend ?? 0) > 0) && !isTokenFalling(tok)) {
        clearJumpStateForToken(tok);
        _hoveringTokens.delete(tok);
      }
      syncTokenFlyHover(tok);
    }
  }
  syncElevationPerspective({ immediate: true });
}

const _appApi = (globalThis as any).foundry?.applications?.api;
const _BaseSettingsApp = (_appApi && typeof _appApi.HandlebarsApplicationMixin === 'function' && _appApi.ApplicationV2)
  ? _appApi.HandlebarsApplicationMixin(_appApi.ApplicationV2)
  : class {};

/** Client-scoped settings dialog for token movement animations and vertical display options. */
class TokenMovementSettingsApp extends _BaseSettingsApp {
  static DEFAULT_OPTIONS = {
    id: 'ss-token-movement-settings',
    classes: ['showstopper-app', 'effect-settings-dialog'],
    tag: 'form',
    form: {
      handler: TokenMovementSettingsApp._onSubmitForm,
      closeOnSubmit: true
    },
    window: {
      title: `${MODULE_ID}.tokenMovement.ConfigTitle`,
      icon: 'fas fa-person-running'
    },
    position: {
      width: 460
    }
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/token-movement-config.hbs`
    }
  };

  async _prepareContext(): Promise<TokenMovementSettings> {
    return getTokenMovementSettings();
  }

  _onRender(context: any, options: any): void {
    super._onRender?.(context, options);
    const root: any = (this as any).element;
    const vertCheckbox = root?.querySelector?.('input[name="vertical"]');
    if (!vertCheckbox) return;
    const syncSubRows = () => {
      const enabled = Boolean(vertCheckbox.checked);
      const subRows = root.querySelectorAll?.('[data-vertical-sub="true"]');
      if (!subRows) return;
      for (let i = 0; i < subRows.length; i++) {
        subRows[i]?.classList?.toggle?.('is-sub-disabled', !enabled);
      }
    };
    syncSubRows();
    vertCheckbox.addEventListener?.('change', syncSubRows);
  }

  static async _onSubmitForm(_event: any, form: any, formData: any): Promise<void> {
    const raw = formData?.object ?? {};
    const keys: TokenMovementSettingKey[] = ['walk', 'jump', 'fly', 'fall', 'vertical', 'verticalBlur', 'verticalCameraZoom'];
    const gSettings = (globalThis as any).game?.settings;
    for (const k of keys) {
      const domInput = form?.querySelector?.(`input[name="${k}"]`);
      const nextVal = domInput && typeof domInput.checked === 'boolean'
        ? Boolean(domInput.checked)
        : Boolean(raw[k]);
      await gSettings?.set?.(MODULE_ID, `${SETTING_NS}.${k}`, nextVal);
    }
    refreshTokenMovementSettings();
  }
}

if (typeof Hooks !== 'undefined') {
  Hooks.once('init', () => {
    const gSettings = (globalThis as any).game?.settings;
    if (typeof gSettings?.register === 'function') {
      const keys: TokenMovementSettingKey[] = ['walk', 'jump', 'fly', 'fall', 'vertical', 'verticalBlur', 'verticalCameraZoom'];
      for (const k of keys) {
        gSettings.register(MODULE_ID, `${SETTING_NS}.${k}`, {
          scope: 'client',
          config: false,
          type: Boolean,
          default: TOKEN_MOVEMENT_DEFAULTS[k],
          onChange: () => refreshTokenMovementSettings()
        });
      }
    }
    if (typeof gSettings?.registerMenu === 'function') {
      gSettings.registerMenu(MODULE_ID, `${SETTING_NS}.menu`, {
        name: `${MODULE_ID}.tokenMovement.MenuName`,
        label: `${MODULE_ID}.tokenMovement.MenuLabel`,
        hint: `${MODULE_ID}.tokenMovement.MenuHint`,
        icon: 'fas fa-person-running',
        type: TokenMovementSettingsApp,
        restricted: false
      });
    }
    installJumpAnimationPatch();
    const apiPayload = {
      isJumpActionName,
      isFlyActionName,
      isFallActionName,
      isWalkActionName,
      isClimbActionName,
      isTokenInLevelChangeRegion,
      getViewedLevelBaseElevation,
      getActorSheetFlySpeedFt,
      hasActorSheetFlySpeed,
      getTokenVerticalHeightFt,
      resolveSupportingSurface,
      getTokenSupportElevation,
      invalidateSupportingSurfaces,
      isTokenFalling,
      isTokenInFlyMode,
      isFallAnimationSegment,
      isJumpAnimationSegment,
      isFlyAnimationSegment,
      isWalkAnimationSegment,
      isMoveKeyHeld,
      getActiveMoveDirectionVector,
      isKeyboardMovement,
      getActorSheetMovementCells,
      resolveTokenSpeedFactor,
      computeTokenAnimationSpeed,
      computeJumpDurationMs,
      computeFlyDurationMs,
      computeWalkDurationMs,
      computeFallDurationMs,
      computeAirJumpDurationMs,
      computeJumpFrame,
      computeAirJumpFrame,
      computeFlyFrame,
      computeWalkFrame,
      computeIdleHoverFrame,
      computeFallingLoopFrame,
      computeFallPlungeFrame,
      computeElevationPerspective,
      getTokenVisualBounds,
      getObserverElevation,
      getTargetObserverElevation,
      setObserverElevation,
      syncElevationPerspective,
      syncTokenFlyHover,
      getTokenMovementSetting,
      getTokenMovementSettings,
      refreshTokenMovementSettings,
      clearJumpStateForToken,
      clearAllJumpAnimations
    };
    registerAPI('tokenMovement', apiPayload);
    registerAPI('jumpAnimation', apiPayload);
  });

  Hooks.once('setup', () => {
    installJumpAnimationPatch();
  });

  Hooks.once('ready', () => {
    installJumpAnimationPatch();
    _patchCoreMoveKeybindings();
  });

  Hooks.on('canvasReady', () => {
    invalidateSupportingSurfaces();
    installJumpAnimationPatch();
    _patchCoreMoveKeybindings();
    _getSoftShadowTexture();
    _targetObserverElevation = getTargetObserverElevation();
    _currentObserverElevation = _targetObserverElevation;
    const placeables = (globalThis as any).canvas?.tokens?.placeables;
    if (Array.isArray(placeables)) {
      for (const tok of placeables) syncTokenFlyHover(tok);
    }
    syncElevationPerspective({ immediate: true });
  });

  Hooks.on('drawToken', (token: any) => {
    if (token && !token.isPreview && token.mesh && !token.mesh.destroyed) {
      if (!token._ssJumpState && !token._ssPerspState) {
        token._ssBaseScaleX = token.mesh.scale?.x ?? 1;
        token._ssBaseScaleY = token.mesh.scale?.y ?? 1;
      } else {
        const base = _resolveBaseScale(token);
        if (token._ssJumpState) {
          token._ssJumpState.baseScaleX = base.x;
          token._ssJumpState.baseScaleY = base.y;
        }
        if (token._ssPerspState) {
          token._ssPerspState.baseScaleX = base.x;
          token._ssPerspState.baseScaleY = base.y;
        }
      }
    }
    syncTokenFlyHover(token);
  });

  Hooks.on('controlToken', (token: any, controlled: boolean) => {
    if (controlled && token && !token.destroyed) {
      _primaryObserverToken = token;
    } else if (_primaryObserverToken === token && !controlled) {
      _primaryObserverToken = null;
    }
    syncElevationPerspective();
  });

  Hooks.on('createToken', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('updateToken', (doc: any, changed: any, options: any) => {
    const geomChanged = Boolean(
      changed && ('x' in changed || 'y' in changed || 'elevation' in changed || 'level' in changed || 'width' in changed || 'height' in changed || 'hidden' in changed || 'rotation' in changed)
    );
    if (geomChanged) invalidateSupportingSurfaces();
    const token = doc?.object;
    if (token?.controlled) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (changed && 'level' in changed) {
        _rawHeldMoveCodes.clear();
        (globalThis as any).game?.keyboard?.moveKeys?.clear?.();
        _stopWasdRepeatPump();
        token._ssRegionTransitionUntil = Math.max(Number(token._ssRegionTransitionUntil) || 0, now + 250);
      } else {
        const priorIds: any[] | undefined = options?._priorRegions?.[doc?.id];
        const mov = options?._movement?.[doc?.id];
        const waypoints = mov?.passed?.waypoints;
        const lastAction = waypoints?.at?.(-1)?.action;
        if (Array.isArray(priorIds) && Array.isArray(waypoints) && waypoints.length > 0 && lastAction !== 'displace' && doc?.regions) {
          let enteredTransitionRegion = false;
          for (const reg of doc.regions) {
            if (reg?.id && !priorIds.includes(reg.id) && _hasActiveRegionFloorTransition(reg)) {
              enteredTransitionRegion = true;
              break;
            }
          }
          if (enteredTransitionRegion) {
            const grid = (globalThis as any).canvas?.dimensions?.size ?? (globalThis as any).canvas?.grid?.size ?? 100;
            const fallbackStepDur = isTokenInFlyMode(token)
              ? computeFlyDurationMs(grid, grid, undefined, { token, keyboard: true })
              : computeWalkDurationMs(grid, grid, undefined, { token, keyboard: true });
            const animDur = Math.max(Number(mov?.animation?.duration) || 0, fallbackStepDur, 240);
            token._ssRegionTransitionUntil = Math.max(Number(token._ssRegionTransitionUntil) || 0, now + animDur + 320);
            _stopWasdRepeatPump();
          }
        }
      }
    }
    if (token) syncTokenFlyHover(token, changed, options);
    if (changed && ('elevation' in changed || 'level' in changed)) {
      syncElevationPerspective();
    }
    if (geomChanged) {
      _scheduleSupportReeval(doc?.id ?? null);
    }
  });

  Hooks.on('deleteToken', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('createTile', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('updateTile', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('deleteTile', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('drawTile', () => {
    invalidateSupportingSurfaces();
  });

  Hooks.on('createRegion', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('updateRegion', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('deleteRegion', () => {
    _scheduleSupportReeval(null);
  });

  Hooks.on('createLevel', () => {
    _scheduleSupportReeval(null);
    syncElevationPerspective();
  });

  Hooks.on('updateLevel', () => {
    _scheduleSupportReeval(null);
    syncElevationPerspective();
  });

  Hooks.on('deleteLevel', () => {
    _scheduleSupportReeval(null);
    syncElevationPerspective();
  });

  Hooks.on('applyTokenStatusEffect', (token: any) => {
    if (token) syncTokenFlyHover(token);
  });

  Hooks.on('createActiveEffect', (effect: any) => {
    _syncActorOrTokenFallingState(effect?.parent);
  });

  Hooks.on('deleteActiveEffect', (effect: any) => {
    _syncActorOrTokenFallingState(effect?.parent);
  });

  Hooks.on('updateActiveEffect', (effect: any) => {
    _syncActorOrTokenFallingState(effect?.parent);
  });

  Hooks.on('updateActorDelta', (delta: any) => {
    _syncActorOrTokenFallingState(delta);
  });

  Hooks.on('updateActor', (actor: any, changed: any) => {
    if (changed?.system?.attributes?.movement) {
      _syncActorOrTokenFallingState(actor);
    }
  });

  Hooks.on('canvasPan', () => {
    _onCanvasPanPerspective();
  });

  Hooks.on('canvasTearDown', () => {
    clearAllJumpAnimations();
  });
}
