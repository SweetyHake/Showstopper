/**
 * Movement trails (extracted verbatim from events.mjs): footprints
 * (interacting with stains via the spatial index), snowdrift trampling,
 * furrows when crawling/dragging through snow, and wounded bleeding trails
 * (with blood absorption into snow). Also handles per-token correlation with
 * native CTRL+Z movement undo (`options.isUndo`): stains spawned by a move
 * are removed when that move is undone.
 */

import { STAIN } from './stains.mjs';
import { Rng, mintSeed } from './rng.mjs';
import { surfaceAt, elevationMatches, currentLevelId, levelBaseElevation, stainMatchesLevel } from './elevation.mjs';
import { settingGet, elevOf, hexOf, shadeHex8, worldTime, tsizeOf } from './util.mjs';
import { bloodEnabled, bloodDisabled, isBleeding, isDeadDoc, isCrawlingOrDragged, woundDepth } from './vitals.mjs';
import { bloodZoneModeAt } from './zones.mjs';
import { mixHex } from './colors.mjs';
import { spawnStepPuff } from './particles.mjs';
import { trampleSnowStains, absorbBloodIntoSnow, snowLevelAt, snowLevelFromNear, SNOW_LEVEL, SNOW_COLOR, SNOW_SHADOW_COLOR } from './snow-bridge.mjs';
import { resolveTokenFootprintStyle, footprintSubtypeOfStyle } from './token-color.mjs';
import { computeJumpDurationMs, computeWalkDurationMs, getTokenMovementSetting, JUMP_LAUNCH_T, JUMP_LAND_T } from '../animations/token-movement.mjs';

const TRAIL_COOLDOWN_MS = 350;
const DEFAULT_MOVE_SPACES_PER_SEC = 6; // standard Foundry token movement animation speed (grid spaces/s)
const _nearScratch = []; // reusable queryCircle candidate buffer in step loops (0 allocations per step)

const TELEPORT_ACTION_RE = /^(teleport|blink|displace|warp|dimension|farstep|mistystep|portal|телепорт|скачок|перемещение)$/i;
const JUMP_ACTION_RE = /^(jump|leap|hop|vault|bound|прыж|прыжок)$/i;
const FLY_ACTION_RE = /^(fly|hover|flight|glide|soar|полёт|полет|парение)$/i;
const CRAWL_ACTION_RE = /^(crawl|prone|ползти|ползком)$/i;
const WALK_ACTION_RE = /^(walk|run|stride|step|burrow|climb|swim|travel|ходьба|шаг|бег)$/i;
const INPUT_METHOD_RE = /^(dragging|keyboard|api|hud|config|paste|undo)$/i;

function _classifyMoveActionString(raw: any): 'teleport' | 'jump' | 'fly' | 'crawl' | 'walk' | null {
  if (!raw || typeof raw !== 'string') return null;
  const act = raw.trim();
  if (!act || INPUT_METHOD_RE.test(act)) return null;
  if (TELEPORT_ACTION_RE.test(act)) return 'teleport';
  if (JUMP_ACTION_RE.test(act)) return 'jump';
  if (FLY_ACTION_RE.test(act)) return 'fly';
  if (CRAWL_ACTION_RE.test(act)) return 'crawl';
  const cfgAction = (globalThis as any).CONFIG?.Token?.movement?.actions?.[act];
  if (cfgAction?.teleport === true) return 'teleport';
  if (WALK_ACTION_RE.test(act) || cfgAction) return 'walk';
  return null;
}

function _classifyWaypoints(waypoints: any, onlyLast = false): 'teleport' | 'jump' | 'fly' | 'crawl' | 'walk' | null {
  if (!Array.isArray(waypoints) || !waypoints.length) return null;
  let sawWalk = false;
  const minIdx = onlyLast ? waypoints.length - 1 : 0;
  for (let i = waypoints.length - 1; i >= minIdx; i--) {
    const wp = waypoints[i];
    if (!wp) continue;
    if (wp.teleport === true) return 'teleport';
    const cls = _classifyMoveActionString(wp.action);
    if (cls === 'teleport' || cls === 'jump' || cls === 'fly' || cls === 'crawl') return cls;
    if (cls === 'walk') sawWalk = true;
  }
  return sawWalk ? 'walk' : null;
}

function _hasInnateSheetFlySpeed(doc: any): boolean {
  try {
    const actor = doc?.actor ?? doc?.object?.actor;
    const mov = actor?.system?.attributes?.movement;
    if (!mov) return false;
    if (actor?.statuses?.has?.('incapacitated')) return false;
    if (actor?.statuses?.has?.('prone') && !mov.hover) return false;
    const speeds = mov.speeds ?? mov;
    const rawFly = Number(speeds?.fly ?? mov.fly) || 0;
    if (!(rawFly > 0)) return false;
    const units = String(mov.units ?? (globalThis as any).canvas?.scene?.grid?.units ?? 'ft').trim().toLowerCase();
    const flyFt = (units === 'm' || units.startsWith('met') || units === 'м' || units.startsWith('мет'))
      ? rawFly * (5 / 1.5)
      : rawFly;
    return flyFt > 1;
  } catch {
    return false;
  }
}

/**
 * Determine token movement action type (`movementAction` in Foundry VTT v13/v14):
 *  - `'teleport'` — teleportation (`movementAction: 'teleport' | 'blink' | 'displace'`, `options.teleport`, `options.animate === false`);
 *  - `'jump'`     — jump (`movementAction: 'jump' | 'leap'`, `options.jump`);
 *  - `'fly'`      — flight / hover (`movementAction: 'fly' | 'hover'` or sheet fly speed `> 1` ft at `elevation > 0`);
 *  - `'crawl'`    — crawling (`movementAction: 'crawl'`);
 *  - `'walk'`     — standard ground movement.
 */
export function resolveMoveAction(doc: any, changes: any = {}, options: any = {}): 'teleport' | 'jump' | 'fly' | 'crawl' | 'walk' {
  if (!options && !changes && !doc) return 'walk';
  const teleportDesc = options && typeof options === 'object'
    ? Object.getOwnPropertyDescriptor(options, 'teleport')
    : undefined;
  if ((teleportDesc && 'value' in teleportDesc && teleportDesc.value === true) || options?.animate === false) return 'teleport';
  if (options?.jump === true) return 'jump';
  if (
    options?.fall === true
    || doc?.actor?.statuses?.has?.('falling')
    || doc?.statuses?.has?.('falling')
    || (typeof doc?.hasStatusEffect === 'function' && doc.hasStatusEffect('falling'))
  ) {
    return 'fly';
  }

  const elev0 = Number(doc?.elevation ?? doc?._source?.elevation ?? 0) || 0;
  const elev1 = Number.isFinite(Number(changes?.elevation)) ? Number(changes.elevation) : elev0;
  const lvl1 = changes?.level ?? doc?.level ?? null;
  const baseElev1 = levelBaseElevation(lvl1);
  const maxElev = Math.max(elev0, elev1);
  let isAirborne = maxElev > baseElev1;
  if (isAirborne && doc) {
    const resolveSurf = (globalThis as any).showstopper?.tokenMovement?.resolveSupportingSurface;
    if (typeof resolveSurf === 'function') {
      try {
        const x0 = Number(doc?.x ?? doc?._source?.x ?? 0);
        const y0 = Number(doc?.y ?? doc?._source?.y ?? 0);
        const x1 = Number.isFinite(Number(changes?.x)) ? Number(changes.x) : x0;
        const y1 = Number.isFinite(Number(changes?.y)) ? Number(changes.y) : y0;
        const s0 = resolveSurf(doc, { x: x0, y: y0, elevation: elev0, level: doc?.level ?? null });
        const s1 = resolveSurf(doc, { x: x1, y: y1, elevation: elev1, level: lvl1 });
        const supported0 = Boolean(s0 && Number.isFinite(Number(s0.elevation)) && (elev0 - Number(s0.elevation)) <= 0.05);
        const supported1 = Boolean(s1 && Number.isFinite(Number(s1.elevation)) && (elev1 - Number(s1.elevation)) <= 0.05);
        if (supported0 && supported1) {
          isAirborne = false;
        }
      } catch { /* ignore */ }
    }
  }
  const promoteAirborneWalk = isAirborne && _hasInnateSheetFlySpeed(doc);
  const normalizeFly = (cls: 'teleport' | 'jump' | 'fly' | 'crawl' | 'walk'): 'teleport' | 'jump' | 'fly' | 'crawl' | 'walk' => {
    if (cls === 'fly' && !isAirborne) return 'walk';
    if (cls === 'walk' && promoteAirborneWalk) return 'fly';
    return cls;
  };

  if (options?.fly === true) return normalizeFly('fly');

  const docId = doc?.id;
  const underMove = docId ? options?._movement?.[docId] : null;
  const tokenMove = docId ? options?.movement?.[docId] : null;

  // 1) Explicit movementAction / action passed in changes or options
  const directCandidates = [
    changes?.movementAction,
    options?.movementAction,
    options?.action,
    underMove?.action,
    tokenMove?.action,
    options?._movement?.action,
    options?.movement?.action
  ];
  for (const cand of directCandidates) {
    const cls = _classifyMoveActionString(cand);
    if (cls) return normalizeFly(cls);
  }

  // 2) Waypoints of the current Foundry v14 movement (`options._movement[id].passed.waypoints`,
  //    `options.movement[id].waypoints`, `options._movement[id].pending.waypoints`, and tail of `changes._movementHistory`)
  const wpLists: Array<[any, boolean]> = [
    [underMove?.passed?.waypoints, false],
    [tokenMove?.waypoints, false],
    [tokenMove?.passed?.waypoints, false],
    [underMove?.pending?.waypoints, false],
    [tokenMove?.pending?.waypoints, false],
    [options?._movement?.passed?.waypoints, false],
    [options?.movement?.waypoints, false],
    [changes?._movementHistory, true]
  ];
  for (const [list, onlyLast] of wpLists) {
    const cls = _classifyWaypoints(list, onlyLast);
    if (cls) return normalizeFly(cls);
  }

  // 3) Active drag override on the tokens layer (when dragging this exact token)
  const tokensLayer = (globalThis as any).canvas?.tokens;
  if (tokensLayer?._dragMovementAction && (!tokensLayer._draggedToken || tokensLayer._draggedToken?.document?.id === docId)) {
    const dragCls = _classifyMoveActionString(tokensLayer._dragMovementAction);
    if (dragCls) return normalizeFly(dragCls);
  }

  // 4) Selected movement mode on the TokenDocument itself (`doc.movementAction`)
  const docCls = _classifyMoveActionString(doc?.movementAction ?? doc?._source?.movementAction);
  if (docCls) return normalizeFly(docCls);

  // 5) Fallback check on `method` (only if given a custom action name rather than 'dragging'/'keyboard'/'api')
  const methodCandidates = [
    underMove?.method,
    tokenMove?.method,
    options?.movement?.method,
    options?.method
  ];
  for (const cand of methodCandidates) {
    const cls = _classifyMoveActionString(cand);
    if (cls) return normalizeFly(cls);
  }

  return promoteAirborneWalk ? 'fly' : 'walk';
}

function _isTeleportMove(doc: any, changes: any = {}, options: any = {}) {
  return resolveMoveAction(doc, changes, options) === 'teleport';
}

/**
 * Synchronize snow trampling with token movement (for both short and long moves):
 * returns the total token movement duration (ms) so each step and snow compression
 * beneath it fires progressively right as the token passes through that point.
 */
function _smartMoveDurationMs(dist: number, grid: number, options: any = {}, doc?: any) {
  if (!dist || !(grid > 0) || options?.animate === false) return 0;
  const explicitDuration = Number(options?.animation?.duration);
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) return explicitDuration;
  try {
    if (typeof getTokenMovementSetting === 'function' && getTokenMovementSetting('walk')) {
      const walkMs = computeWalkDurationMs(dist, grid, undefined, { token: doc?.object ?? doc });
      if (Number.isFinite(walkMs) && walkMs > 0) return Math.round(walkMs);
    }
  } catch { /* fallback below */ }
  const gridsMoved = dist / grid;
  const movementSpeed = Number(options?.animation?.movementSpeed) || DEFAULT_MOVE_SPACES_PER_SEC;
  return Math.round((gridsMoved / Math.max(1, movementSpeed)) * 1000);
}

/** Reusable PRNG: minting left/right foot seeds avoids allocating Rng per probe (~2/footprint). */
const _sideRng = new Rng(0);

/** Mint a seed whose atlas variant matches the requested foot & wear state (0/1 = wet, 2/3 = depleted). */
function _mintSeedForSide(left, worn = false) {
  const target = (worn ? 2 : 0) + (left ? 0 : 1);
  for (let i = 0; i < 64; i++) {
    const s = mintSeed();
    if (_sideRng.reset(s).int(4) === target) return s;
  }
  return mintSeed();
}

/** Pick what lies underfoot: the most prominent stain ON THIS SURFACE (footprints
 *  themselves do not count as ground). Blood at another elevation does not stain
 *  soles: a token on a roof won't track blood from the floor below, and vice versa.
 *  A single pass over candidates returns BOTH results (snow allowed / disallowed)
 *  plus `sawSnow` — replacing what used to be two full passes plus `near.some` per step. */
const _nearLevelScratch = [];

function _filterNearLevel(near, levelId) {
  if (!levelId) return near;
  _nearLevelScratch.length = 0;
  for (let i = 0; i < near.length; i++) {
    const st = near[i];
    if (st && stainMatchesLevel(st, levelId)) _nearLevelScratch.push(st);
  }
  return _nearLevelScratch;
}

function _hasCandidateInNear(list, tsize) {
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (!st) continue;
    if (st.m === 2) {
      if (st.t === STAIN.FOOTPRINT || st.c === SNOW_SHADOW_COLOR) continue;
      if (st.t === STAIN.SMEAR && !(st.lv >= SNOW_LEVEL.DRIFT)) continue;
    } else if (
      st.t === STAIN.FOOTPRINT ||
      st.t === STAIN.DROPLETS ||
      st.t === STAIN.DRIP ||
      st.t === STAIN.HANDPRINT
    ) {
      continue;
    }
    if ((Number(st.a) || 0) < 0.3) continue;
    if (st.m !== 2) {
      const minPoolS = st.t === STAIN.SPLASH ? tsize * 0.75 : tsize * 0.52;
      if ((Number(st.s) || 0) < minPoolS) continue;
    }
    return true;
  }
  return false;
}

function _pickGround(list, tsize, surface, cx = 0, cy = 0, maxR = Infinity, levelId = null, hasDirtySoles = false) {
  let any = null, anyScore = 0;        // best candidate when snow is allowed
  let bloodOnly = null, bloodScore = 0; // best candidate excluding snow
  let sawSnow = false;
  const checkR = Number.isFinite(maxR);
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (!stainMatchesLevel(st, levelId)) continue;
    if (st.m === 2) {
      sawSnow = true;
      if (st.t === STAIN.FOOTPRINT) continue;
      if (st.c === SNOW_SHADOW_COLOR) continue;
      // A carved snow rut/trench (SMEAR without lv >= 3) is not treated as fresh snow
      if (st.t === STAIN.SMEAR && !(st.lv >= SNOW_LEVEL.DRIFT)) continue;
    } else if (
      st.t === STAIN.FOOTPRINT ||
      st.t === STAIN.DROPLETS ||
      st.t === STAIN.DRIP ||
      st.t === STAIN.HANDPRINT
    ) {
      continue;
    }
    if (!elevationMatches(st.e, surface)) continue;
    const a = Number(st.a) || 0;
    if (a < 0.3) continue;
    const s = Number(st.s) || 0;
    if (st.m !== 2) {
      const minPoolS = st.t === STAIN.SPLASH ? tsize * 0.75 : tsize * 0.52;
      if (s < minPoolS) continue;
    }
    if (checkR) {
      const dx = st.x - cx, dy = st.y - cy;
      const rr = st.m === 2
        ? maxR + s * 0.35
        : (hasDirtySoles ? Math.min(maxR, tsize * 0.12) + s * 0.36 : tsize * 0.12 + s * 0.34);
      if (dx * dx + dy * dy > rr * rr) continue;
    }
    const score = a * Math.min(1, s / tsize);
    if (st.m === 2) {
      if (score > anyScore) { anyScore = score; any = st; }
    } else {
      if (score > anyScore) { anyScore = score; any = st; }
      if (score > bloodScore) { bloodScore = score; bloodOnly = st; }
    }
  }
  return { any, bloodOnly, sawSnow };
}

export class TrailEngine {
  declare getStore; declare _lastTrail; declare _footSide; declare _soles; declare _trailOps;
  /** @param {() => import('./stains.mjs').BloodStore} getStore */
  constructor(getStore) {
    this.getStore = getStore;
    this._lastTrail = new Map(); // tokenId → timestamp of last bleeding smear (cooldown)
    this._footSide = new Map();  // tokenId → ±1 (alternates left/right foot across steps)
    this._soles = new Map();     // tokenId → { m, c, steps, total } — material picked up on soles
    this._trailOps = new Map();  // tokenId → [{x, y, ids}] move ops undoable via native CTRL+Z
  }

  register() {
    Hooks.on('updateToken', (doc, changes, options) => this._onUpdateTokenUndo(doc, changes, options));
  }

  dispose() {
    this._lastTrail.clear();
    this._footSide.clear();
    this._soles.clear();
    this._trailOps.clear();
  }

  /** Per-token maps must not outlive deleted tokens. */
  forget(tokenId) {
    this._footSide.delete(tokenId);
    this._soles.delete(tokenId);
    this._lastTrail.delete(tokenId);
    this._trailOps.delete(tokenId);
  }

  /**
   * Record stains spawned by a SINGLE token move for native CTRL+Z undo.
   * `fromX`/`fromY` are where the token departed from (`doc.x`/`doc.y` in the
   * pre-hook): undo restores those exact origin coordinates, so matching them
   * identifies the undone move.
   */
  _pushTrailOp(tokenId, fromX, fromY, stains) {
    if (!stains.length) return;
    let stack = this._trailOps.get(tokenId);
    if (!stack) { stack = []; this._trailOps.set(tokenId, stack); }
    stack.push({ x: fromX, y: fromY, ids: stains.map(st => st.i) });
    if (stack.length > 20) stack.shift(); // cap history length
  }

  /**
   * Native CTRL+Z token movement undo (v14: undo only, no redo).
   * `updateEmbeddedDocuments` with `isUndo: true` runs through standard hooks
   * with `changes` carrying the ORIGIN coordinates — if they match the top op's
   * origin for that token, that move is being undone and its stains are removed.
   * Moves that left no stains pushed no op, so undo passes right by when empty.
   */
  _onUpdateTokenUndo(doc, changes, options) {
    if (!options?.isUndo) return;
    if (!game.user.isGM || !bloodEnabled()) return;
    if (doc.scene && doc.scene.id !== canvas.scene?.id) return;
    if (changes.x === undefined && changes.y === undefined) return;
    const stack = this._trailOps.get(doc.id);
    if (!stack?.length) return;
    const top = stack[stack.length - 1];
    const cx = changes.x ?? doc.x, cy = changes.y ?? doc.y;
    if (Math.abs(cx - top.x) > 0.51 || Math.abs(cy - top.y) > 0.51) return;
    stack.pop();
    if (!stack.length) this._trailOps.delete(doc.id);
    this.getStore()?.remove(top.ids);
  }

  /**
   * Helper to stamp a localized snow dent at `(px, py)`:
   * verifies that snow actually covers `(px, py)` directly (within `effR`),
   * and creates a pixel-perfect `STAIN.SMEAR` dent (plus boot prints on medium snow `lv === 2`),
   * spawning nothing outside existing snow.
   */
  _stampSnowDentAt(
    store,
    doc,
    px: number,
    py: number,
    {
      grid,
      tsize,
      tElev,
      tLevel = doc?.level ?? currentLevelId(),
      rot,
      sizeK = 1.28,
      alpha = 0.76,
      delayMs = 0,
      dedupR = 18,
      addFootprints = false,
      spawnPuff = false,
      puffsOn = false,
      stains,
      trampledSnow
    }: any
  ) {
    const queryR = Math.max(tsize * 0.5, grid * 0.55);
    const near = store.queryCircle(px, py, queryR, _nearScratch);
    if (!near.length) return false;

    const surf = surfaceAt(px, py, tElev, tLevel);
    const surface = surf.e;
    if (tElev > surface + 0.51) return false;
    const activeLvl = surf.lvl ?? tLevel;

    // Keep only snow stains that directly cover (px, py)
    // (so a drift midway along a teleport/jump doesn't trigger at fringes beyond its effR)
    const localSnow = [];
    for (let i = 0; i < near.length; i++) {
      const st = near[i];
      if (!st || st.m !== 2 || st.t === STAIN.FOOTPRINT || st.c === SNOW_SHADOW_COLOR) continue;
      if (!stainMatchesLevel(st, activeLvl)) continue;
      if (st.t === STAIN.SMEAR && !(st.lv >= SNOW_LEVEL.DRIFT) && st.c !== SNOW_COLOR) continue;
      if (!elevationMatches(st.e, surface)) continue;
      const effR = Math.max(grid * 0.48, (Number(st.s) || 60) * 0.45);
      const ddx = st.x - px, ddy = st.y - py;
      if (ddx * ddx + ddy * ddy <= effR * effR) localSnow.push(st);
    }
    if (!localSnow.length) return false;

    const snowLv = snowLevelFromNear(_filterNearLevel(near, activeLvl), px, py, grid, surface);
    if (snowLv < SNOW_LEVEL.MEDIUM) return false;
    const ground = _pickGround(localSnow, tsize, surface, px, py, tsize * 0.48, activeLvl).any;
    if (!ground || Number(ground.m) !== 2) return false;

    const soles = this._soles.get(doc.id) ?? null;
    let bloodySnowColor = null;
    if (soles && (soles.m || 0) === 0 && soles.steps > 0) {
      bloodySnowColor = mixHex(shadeHex8(ground.c, -0.35), soles.c, 0.58);
    }

    if (bloodySnowColor || !ground.lv) {
      const hitWeight = snowLv >= SNOW_LEVEL.DRIFT ? 0.5 : 1;
      const tint = bloodySnowColor ? soles.c : undefined;
      const prevT = trampledSnow.get(ground.i);
      if (prevT) {
        prevT.hits += hitWeight;
        if (tint) prevT.tintColor = tint;
        if (delayMs < (prevT.delayMs ?? Infinity)) prevT.delayMs = delayMs;
      } else {
        trampledSnow.set(ground.i, { stain: ground, hits: hitWeight, tintColor: tint, delayMs });
      }
    }

    const dedupR2 = dedupR * dedupR;
    let alreadyCarved = near.some(st => {
      if (st.m !== 2 || st.t !== STAIN.SMEAR || st.lv >= SNOW_LEVEL.DRIFT || st.c === SNOW_COLOR) return false;
      if (!stainMatchesLevel(st, activeLvl) || !elevationMatches(st.e, surface)) return false;
      const ddx = st.x - px, ddy = st.y - py;
      return ddx * ddx + ddy * ddy < dedupR2;
    });
    for (let i = 0; !alreadyCarved && i < stains.length; i++) {
      const st = stains[i];
      if (st.t !== STAIN.SMEAR) continue;
      const ddx = st.x - px, ddy = st.y - py;
      if (ddx * ddx + ddy * ddy < dedupR2) alreadyCarved = true;
    }

    const tidProp = surf.tid ? { tid: surf.tid } : {};
    const lvlProp = activeLvl ? { lvl: activeLvl } : {};
    const fpStyle = resolveTokenFootprintStyle(doc);
    if (fpStyle === 'none') return false;
    const fpSub = footprintSubtypeOfStyle(fpStyle);
    if (!alreadyCarved || bloodySnowColor) {
      stains.push(store.createStain({
        t: STAIN.SMEAR,
        x: Math.round(px),
        y: Math.round(py),
        s: Math.round(tsize * sizeK),
        r: rot + (Math.random() - 0.5) * 0.06,
        a: alpha,
        c: bloodySnowColor ? bloodySnowColor : SNOW_SHADOW_COLOR,
        m: 2,
        e: surface,
        ...(delayMs > 0 ? { d: delayMs } : {}),
        ...tidProp,
        ...lvlProp
      }));
    }

    if (addFootprints && snowLv === SNOW_LEVEL.MEDIUM && fpStyle !== 'slither') {
      const nx = -Math.sin(rot), ny = Math.cos(rot);
      const footOff = Math.max(grid * 0.12, tsize * 0.14);
      for (const side of [-1, 1]) {
        const fx = px + nx * footOff * side;
        const fy = py + ny * footOff * side;
        stains.push(store.createStain({
          t: STAIN.FOOTPRINT,
          x: Math.round(fx),
          y: Math.round(fy),
          s: tsize * 0.46,
          r: rot + side * 0.06,
          a: 0.72,
          c: bloodySnowColor ? bloodySnowColor : shadeHex8(ground.c, -0.42),
          seed: _mintSeedForSide(side < 0),
          m: 2,
          e: surface,
          ...(fpSub > 0 ? { fp: fpSub } : {}),
          ...(delayMs > 0 ? { d: delayMs } : {}),
          ...tidProp,
          ...lvlProp
        }));
      }
    }

    if (spawnPuff && puffsOn && delayMs === 0) {
      spawnStepPuff({ x: px, y: py, dir: rot, material: 2, color: ground.c || SNOW_COLOR, elevation: surface, level: activeLvl });
    }
    return true;
  }

  /**
   * Snow dents on TELEPORT (`movementAction === 'teleport'`):
   * created ONLY at the departure point before teleporting and at the arrival point
   * (the space in between remains untouched).
   */
  snowTeleportDents(doc, changes, options: any = {}) {
    if (!settingGet('bloodFootprints', true)) return;
    if (resolveTokenFootprintStyle(doc) === 'none') return;
    const store = this.getStore();
    if (!store || !store.stains.length) return;
    const grid = canvas.grid?.size ?? 100;
    const tsize = tsizeOf(doc, grid);
    const hw = (Math.abs(doc.width ?? 1) * grid) / 2;
    const hh = (Math.abs(doc.height ?? 1) * grid) / 2;
    const tLevel = doc?.level ?? currentLevelId();
    const x0 = doc.x, y0 = doc.y;
    const x1 = changes.x ?? x0, y1 = changes.y ?? y0;
    const lvl1 = changes?.level ?? tLevel;
    const crossLevel = Boolean(changes?.level && doc?.level && changes.level !== doc.level);
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1 && !crossLevel) return;

    const cx0 = x0 + hw, cy0 = y0 + hh;
    const cx1 = x1 + hw, cy1 = y1 + hh;
    const rot = dist >= 1 ? Math.atan2(dy, dx) : 0;
    const tElev0 = elevOf(doc);
    const tElev1 = Number.isFinite(Number(changes?.elevation)) ? Number(changes.elevation) : (crossLevel ? levelBaseElevation(lvl1) : tElev0);
    const puffsOn = settingGet('bloodStepPuffs', true);
    const arrivalDelayMs = (crossLevel || options?.animate === false)
      ? 0
      : Math.min(180, _smartMoveDurationMs(dist, grid, options, doc));
    const dedupR = Math.max(12, tsize * 0.22);

    const stains = [];
    const trampledSnow = new Map();

    // 1) Dent where the token was standing
    this._stampSnowDentAt(store, doc, cx0, cy0, {
      grid, tsize, tElev: tElev0, tLevel, rot,
      sizeK: 1.26, alpha: 0.76, delayMs: 0, dedupR,
      addFootprints: true, spawnPuff: true, puffsOn,
      stains, trampledSnow
    });

    // 2) Dent where the token arrived
    this._stampSnowDentAt(store, doc, cx1, cy1, {
      grid, tsize, tElev: tElev1, tLevel: lvl1, rot,
      sizeK: 1.32, alpha: 0.78, delayMs: arrivalDelayMs, dedupR,
      addFootprints: true, spawnPuff: true, puffsOn,
      stains, trampledSnow
    });

    if (trampledSnow.size) {
      trampleSnowStains(store, trampledSnow, stains);
      if (stains.length) this._pushTrailOp(doc.id, x0, y0, stains);
    } else if (stains.length) {
      store.add(stains);
      this._pushTrailOp(doc.id, x0, y0, stains);
    }
  }

  /**
   * Snow dents on JUMP (`movementAction === 'jump'`):
   *  1) at the takeoff point + slightly forward along the jump direction (push-off);
   *  2) at the landing point + slightly back toward the approach direction (landing skid);
   *  the mid-air span remains untouched.
   */
  snowJumpDents(doc, changes, options: any = {}) {
    if (!settingGet('bloodFootprints', true)) return;
    if (resolveTokenFootprintStyle(doc) === 'none') return;
    const store = this.getStore();
    if (!store || !store.stains.length) return;
    const grid = canvas.grid?.size ?? 100;
    const tsize = tsizeOf(doc, grid);
    const hw = (Math.abs(doc.width ?? 1) * grid) / 2;
    const hh = (Math.abs(doc.height ?? 1) * grid) / 2;
    const x0 = doc.x, y0 = doc.y;
    const x1 = changes.x ?? x0, y1 = changes.y ?? y0;
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const stride = Math.max(grid * 0.4, tsize * 0.5);
    if (dist < stride * 0.55) return;

    const cx0 = x0 + hw, cy0 = y0 + hh;
    const cx1 = x1 + hw, cy1 = y1 + hh;
    const rot = Math.atan2(dy, dx);
    const ux = Math.cos(rot), uy = Math.sin(rot);
    const tLevel = doc?.level ?? currentLevelId();
    const tElev = elevOf(doc);
    const tLevel1 = changes?.level ?? tLevel;
    const tElev1 = Number.isFinite(Number(changes?.elevation)) ? Number(changes.elevation) : (tLevel1 !== tLevel ? levelBaseElevation(tLevel1) : tElev);
    const puffsOn = settingGet('bloodStepPuffs', true);
    const moveDurationMs = options?.animate === false
      ? 0
      : computeJumpDurationMs(dist, grid, Number(options?.animation?.duration));

    // Forward push-off shift along jump direction and approach skid shift on landing
    const pushShift = Math.min(dist * 0.22, Math.max(grid * 0.28, tsize * 0.34));
    const skidShift = Math.min(dist * 0.24, Math.max(grid * 0.30, tsize * 0.36));
    const dedupR = Math.max(10, Math.min(tsize * 0.18, pushShift * 0.55));

    const stains = [];
    const trampledSnow = new Map();

    // 1a) Takeoff point (where the character stood)
    this._stampSnowDentAt(store, doc, cx0, cy0, {
      grid, tsize, tElev, tLevel, rot,
      sizeK: 1.28, alpha: 0.76, delayMs: 0, dedupR,
      addFootprints: true, spawnPuff: true, puffsOn,
      stains, trampledSnow
    });
    // 1b) Elongated push-off mark slightly forward along jump direction (at launch after crouch)
    this._stampSnowDentAt(store, doc, cx0 + ux * pushShift, cy0 + uy * pushShift, {
      grid, tsize, tElev, tLevel, rot,
      sizeK: 1.12, alpha: 0.74,
      delayMs: moveDurationMs > 0 ? Math.max(1, Math.round(moveDurationMs * JUMP_LAUNCH_T)) : 0,
      dedupR,
      addFootprints: false, spawnPuff: false, puffsOn,
      stains, trampledSnow
    });

    // 2a) Entry skid into snow on landing slightly toward the approach direction
    this._stampSnowDentAt(store, doc, cx1 - ux * skidShift, cy1 - uy * skidShift, {
      grid, tsize, tElev: tElev1, tLevel: tLevel1, rot,
      sizeK: 1.16, alpha: 0.75,
      delayMs: moveDurationMs > 0 ? Math.max(1, Math.round(moveDurationMs * (JUMP_LAND_T - 0.04))) : 0,
      dedupR,
      addFootprints: false, spawnPuff: false, puffsOn,
      stains, trampledSnow
    });
    // 2b) Primary landing dent (right at ground impact before recovery crouch)
    this._stampSnowDentAt(store, doc, cx1, cy1, {
      grid, tsize, tElev: tElev1, tLevel: tLevel1, rot,
      sizeK: 1.38, alpha: 0.78,
      delayMs: moveDurationMs > 0 ? Math.max(1, Math.round(moveDurationMs * JUMP_LAND_T)) : 0,
      dedupR,
      addFootprints: true, spawnPuff: true, puffsOn,
      stains, trampledSnow
    });

    if (trampledSnow.size) {
      trampleSnowStains(store, trampledSnow, stains);
      if (stains.length) this._pushTrailOp(doc.id, x0, y0, stains);
    } else if (stains.length) {
      store.add(stains);
      this._pushTrailOp(doc.id, x0, y0, stains);
    }
  }

  /**
   * Snow furrow when crawling (prone) or dragging (corpse / unconscious):
   * instead of paired footprints, the body plows a wide cleared rut
   * (`STAIN.SMEAR` with `m: 2`) and compresses snowdrifts underneath more heavily.
   */
  snowDragFurrow(doc, changes, options: any = {}) {
    if (!settingGet('bloodFootprints', true)) return;
    if (resolveTokenFootprintStyle(doc) === 'none') return;
    const moveAction = resolveMoveAction(doc, changes, options);
    if (moveAction === 'teleport') {
      this.snowTeleportDents(doc, changes, options);
      return;
    }
    if (moveAction === 'jump') {
      this.snowJumpDents(doc, changes, options);
      return;
    }
    // While flying, the token is airborne and leaves no footprints or snow trenches on the ground
    if (moveAction === 'fly') return;
    const store = this.getStore();
    if (!store || !store.stains.length) return;
    const grid = canvas.grid?.size ?? 100;
    const tsize = tsizeOf(doc, grid);
    const hw = (Math.abs(doc.width ?? 1) * grid) / 2;
    const hh = (Math.abs(doc.height ?? 1) * grid) / 2;
    const x0 = doc.x, y0 = doc.y;
    const x1 = changes.x ?? x0, y1 = changes.y ?? y0;
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(grid * 0.45, tsize * 0.5);
    if (dist < step * 0.5) return;

    if (changes?.level && doc?.level && changes.level !== doc.level) return;
    const tLevel = doc?.level ?? currentLevelId();
    const moveDurationMs = _smartMoveDurationMs(dist, grid, options, doc);
    const rot = Math.atan2(dy, dx);
    const n = Math.min(72, Math.max(1, Math.round(dist / step)));
    const tElev = elevOf(doc);
    const puffsOn = settingGet('bloodStepPuffs', true); // read setting once per move
    const furrowR2 = (step * 0.65) * (step * 0.65);
    const stains = [];
    const trampledSnow = new Map();

    const pickR = tsize * 0.55;
    const queryR = Math.max(pickR, grid * 0.55);

    for (let i = 1; i <= n; i++) {
      const f = i / (n + 0.5);
      const stepDelayMs = moveDurationMs > 0 ? Math.round(f * moveDurationMs) : 0;
      const sx = x0 + hw + dx * f;
      const sy = y0 + hh + dy * f;
      const near = store.queryCircle(sx, sy, queryR, _nearScratch);
      if (!near.length) continue;
      const surf = surfaceAt(sx, sy, tElev, tLevel);
      const surface = surf.e;
      if (tElev > surface + 0.51) continue;
      const activeLvl = surf.lvl ?? tLevel;
      const snowLv = snowLevelFromNear(_filterNearLevel(near, activeLvl), sx, sy, grid, surface);
      if (snowLv < SNOW_LEVEL.MEDIUM) continue; // level 1 (light frost) — no trampling interaction
      const ground = _pickGround(near, tsize, surface, sx, sy, pickR, activeLvl).any;
      if (!ground || Number(ground.m) !== 2) continue;

      // Regular fallen snow (with explicit lv >= 1) is carved via a 3D furrow in the renderer
      // without mutating the base snow stains — keeping the chunk's `snowBase` cache intact!
      // `ground` mutation applies only to standalone non-leveled snow stains (legacy SPLAT in tests).
      if (!ground.lv) {
        const prev = trampledSnow.get(ground.i);
        if (prev) {
          prev.hits += 1.6;
          if (stepDelayMs < (prev.delayMs ?? Infinity)) prev.delayMs = stepDelayMs;
        } else {
          trampledSnow.set(ground.i, { stain: ground, hits: 1.6, delayMs: stepDelayMs });
        }
      }

      // Deduplication: if a carved snow furrow already exists at this point, don't stack a duplicate
      const hasExistingFurrow = near.some(
        st => {
          if (st.m !== 2 || st.t !== STAIN.SMEAR || st.lv >= SNOW_LEVEL.DRIFT || st.c === SNOW_COLOR) return false;
          if (!stainMatchesLevel(st, activeLvl) || !elevationMatches(st.e, surface)) return false;
          const ddx = st.x - sx, ddy = st.y - sy;
          return ddx * ddx + ddy * ddy < furrowR2;
        }
      );
      if (!hasExistingFurrow) {
        // Only carve existing snow (pixel-perfect clip against the snow mask in the renderer),
        // WITHOUT spawning new drifts or clods outside existing snow
        stains.push(store.createStain({
          t: STAIN.SMEAR,
          x: Math.round(sx + (Math.random() - 0.5) * grid * 0.03),
          y: Math.round(sy + (Math.random() - 0.5) * grid * 0.03),
          s: Math.round(tsize * (1.32 + Math.random() * 0.10)),
          r: rot + (Math.random() - 0.5) * 0.05,
          a: 0.72,
          c: shadeHex8(ground.c, -0.38),
          m: 2,
          e: surface,
          ...(stepDelayMs > 0 ? { d: stepDelayMs } : {}),
          ...(surf.tid ? { tid: surf.tid } : {}),
          ...(activeLvl ? { lvl: activeLvl } : {})
        }));
      }

      if (puffsOn && stepDelayMs === 0) {
        spawnStepPuff({ x: sx, y: sy, dir: rot, material: 2, color: ground.c, elevation: surface, level: activeLvl });
      }
    }

    if (trampledSnow.size) {
      trampleSnowStains(store, trampledSnow, stains);
      if (stains.length) this._pushTrailOp(doc.id, x0, y0, stains);
    } else if (stains.length) {
      store.add(stains);
      this._pushTrailOp(doc.id, x0, y0, stains);
    }
  }

  /**
   * Footprints: step along the movement path at stride intervals and query for
   * stains underfoot (store spatial index — O(1)). Stepping on a stain stamps a
   * print in that stain's color and coats the soles; stepping onto clean ground
   * leaves fading prints until the soles wear clean.
   * On snow (`m: 2`), footsteps progressively press and carve snowdrifts in sync
   * with token movement (for both short and long moves; teleports leave no trail).
   */
  footprints(doc, changes, options: any = {}) {
    if (!settingGet('bloodFootprints', true)) return;
    const fpStyle = resolveTokenFootprintStyle(doc);
    if (fpStyle === 'none') return;
    const fpSub = footprintSubtypeOfStyle(fpStyle);
    const isSlither = fpStyle === 'slither';
    const moveAction = resolveMoveAction(doc, changes, options);
    if (moveAction === 'teleport') {
      this.snowTeleportDents(doc, changes, options);
      return;
    }
    if (moveAction === 'jump') {
      this.snowJumpDents(doc, changes, options);
      return;
    }
    // While flying, the token is airborne and leaves no footprints or snow trenches on the ground
    if (moveAction === 'fly') return;
    // A corpse or crawling token (prone / unconscious / movementAction === 'crawl') doesn't "step":
    // on snow, it drags a wide cleared furrow behind it
    if (moveAction === 'crawl' || isDeadDoc(doc) || isCrawlingOrDragged(doc)) {
      this.snowDragFurrow(doc, changes, options);
      return;
    }
    const grid = canvas.grid?.size ?? 100;
    const tsize = tsizeOf(doc, grid);
    // center per document AXIS (doc.x/y is top-left): using max(w,h)/2 on both
    // axes shifted footprints of non-square tokens away from the true center
    const hw = (Math.abs(doc.width ?? 1) * grid) / 2;
    const hh = (Math.abs(doc.height ?? 1) * grid) / 2;
    const x0 = doc.x, y0 = doc.y;
    const x1 = changes.x ?? x0, y1 = changes.y ?? y0;
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const stride = Math.max(grid * 0.4, tsize * 0.5);
    if (dist < stride * 0.55) return; // micro-nudge — not a step

    if (changes?.level && doc?.level && changes.level !== doc.level) return;
    const tLevel = doc?.level ?? currentLevelId();
    const store = this.getStore();
    if (!store) return;
    let soles = this._soles.get(doc.id) ?? null;
    // MOST COMMON case — clean ground: with no stains on the scene and clean
    // soles, footprints are impossible
    if (!store.stains.length && !soles) return;

    const moveDurationMs = _smartMoveDurationMs(dist, grid, options, doc);
    const rot = Math.atan2(dy, dx);
    const ux = Math.cos(rot), uy = Math.sin(rot); // forward along movement
    const nx = -uy, ny = ux;                      // lateral normal (left/right)
    const n = Math.min(96, Math.max(1, Math.round(dist / stride)));
    const puffsOn = settingGet('bloodStepPuffs', true); // read setting once per move
    const stains = [];
    const driftTrenches = [];
    const trampledSnow = new Map();
    let side = this._footSide.get(doc.id) ?? (Math.random() < 0.5 ? -1 : 1);
    let lastDriftLv = 0;
    const tElev = elevOf(doc); // surface ceiling: token cannot stand on a surface above its elevation
    const pickR = tsize * 0.45;
    const queryR = Math.max(pickR, grid * 0.55);
    const wt = Math.round(worldTime());

    for (let i = 1; i <= n; i++) {
      const f = i / (n + 0.5);
      const stepDelayMs = moveDurationMs > 0 ? Math.round(f * moveDurationMs) : 0;
      const sx = x0 + hw + dx * f; // step along the token's per-axis center
      const sy = y0 + hh + dy * f;
      side = -side;

      // CHEAP check first: a single spatial-index queryCircle (radius covers both pickR and grid * 0.55 for snowLevelFromNear).
      // Pixel-level surfaceAt is the most expensive part of a step, and with no valid pool/snow candidates underfoot
      // plus clean soles, no footprint can be produced
      const near = store.queryCircle(sx, sy, queryR, _nearScratch);
      const soleWear = soles && soles.steps > 0;
      if (!near.length && !soleWear) continue;
      if (!soleWear && !_hasCandidateInNear(near, tsize)) continue;

      // step surface: tile beneath the point (at or below the token) or the floor —
      // footprints are placed ON it (and stick to it), even if blood "falls" from token height
      const surf = surfaceAt(sx, sy, tElev, tLevel);
      const surface = surf.e;
      // flying/hovering tokens do NOT "step" on surfaces far below them: stamping requires
      // token elevation to match the step surface (with small tolerance for raised art)
      if (tElev > surface + 0.51) continue;
      const activeLvl = surf.lvl ?? tLevel;
      // single pass over `near` yields both the best stain (snow allowed/disallowed) and
      // `sawSnow` — gating snowLevelFromNear without a second queryCircle!
      const picked = _pickGround(near, tsize, surface, sx, sy, pickR, activeLvl, Boolean(soleWear));
      const rawSnowLv = picked.sawSnow
        ? snowLevelFromNear(_filterNearLevel(near, activeLvl), sx, sy, grid, surface)
        : SNOW_LEVEL.NONE;
      const snowLv = (rawSnowLv === SNOW_LEVEL.MEDIUM && lastDriftLv >= SNOW_LEVEL.DRIFT)
        ? lastDriftLv
        : rawSnowLv;
      lastDriftLv = rawSnowLv >= SNOW_LEVEL.DRIFT ? rawSnowLv : 0;
      const ground = snowLv >= SNOW_LEVEL.LIGHT ? picked.any : picked.bloodOnly;

      let sole;
      let fresh = false;
      let bloodySnowColor = null;
      let stepWear = 1;
      if (ground) {
        const m = Number(ground.m) || 0;
        const steps = 4 + Math.min(6, Math.round((ground.s / tsize) * 3)); // larger pools coat soles longer
        // when a token with bloody soles steps into snow, blood from the soles
        // soaks into the snow (crimson footprint + tinting the snowdrift itself)
        if (m === 2 && soles && (soles.m || 0) === 0 && soles.steps > 0) {
          bloodySnowColor = mixHex(shadeHex8(ground.c, -0.35), soles.c, 0.58);
        }
        // On snow (lv >= 2), step and drift relief is carved via 3D footprints (FOOTPRINT)
        // and 3D trenches (SMEAR) in the renderer WITHOUT mutating/shrinking the base snow stains
        // (except when tinting with bloody soles or hitting standalone non-leveled stains `!ground.lv`):
        // this keeps each chunk's `snowBase` layer cache 100% valid and avoids redrawing
        // the base snow cover when tokens walk or get dragged!
        if (m === 2 && (bloodySnowColor || !ground.lv)) {
          const hitWeight = snowLv >= SNOW_LEVEL.DRIFT ? 0.5 : 1;
          const tint = bloodySnowColor ? soles.c : undefined;
          const prevT = trampledSnow.get(ground.i);
          if (prevT) {
            prevT.hits += hitWeight;
            if (tint) prevT.tintColor = tint;
            if (stepDelayMs < (prevT.delayMs ?? Infinity)) prevT.delayMs = stepDelayMs;
          } else {
            trampledSnow.set(ground.i, { stain: ground, hits: hitWeight, tintColor: tint, delayMs: stepDelayMs });
          }
        }
        // Level 3+ (waist-deep snowdrift) or slithering creature/ooze/swarm (`isSlither` on snow lv >= 2):
        // instead of individual footprints, leave a carved body trench that affects ONLY existing snow
        // (pixel-perfect clip against the snow mask in the renderer) and NEVER spawns new drifts outside it
        if (m === 2 && (snowLv >= SNOW_LEVEL.DRIFT || isSlither)) {
          this._soles.delete(doc.id);
          soles = null;
          const tidProp = surf.tid ? { tid: surf.tid } : {};
          const snowBaseCol = ground.c || SNOW_COLOR;
          // Stamp 2 sub-stamps per stride (on both short and long paths)
          // so stamps overlap >75% and don't break into separate dents on long moves
          const shiftIdx = [-stride * 0.24, stride * 0.12];
          const carveNearR2 = (stride * 0.46) * (stride * 0.46);
          const carveSelfR2 = (stride * 0.28) * (stride * 0.28);
          const trenchSizeBase = snowLv >= SNOW_LEVEL.DRIFT_DEEP
            ? 1.44
            : snowLv >= SNOW_LEVEL.DRIFT_HIGH
              ? 1.40
              : snowLv >= SNOW_LEVEL.DRIFT
                ? 1.36
                : 0.92;
          const trenchAlpha = snowLv >= SNOW_LEVEL.DRIFT_DEEP
            ? 0.84
            : snowLv >= SNOW_LEVEL.DRIFT_HIGH
              ? 0.81
              : snowLv >= SNOW_LEVEL.DRIFT
                ? 0.78
                : 0.72;
          for (let sIdx = 0; sIdx < shiftIdx.length; sIdx++) {
            const alongShift = shiftIdx[sIdx];
            const waveOff = isSlither && snowLv < SNOW_LEVEL.DRIFT
              ? Math.sin((i + sIdx * 0.5) * 1.3) * tsize * 0.08
              : Math.sin((i + sIdx * 0.5) * 1.55) * tsize * 0.045;
            const tx = Math.round(sx + ux * alongShift + nx * waveOff + (Math.random() - 0.5) * grid * 0.035);
            const ty = Math.round(sy + uy * alongShift + ny * waveOff + (Math.random() - 0.5) * grid * 0.035);
            // Overdraw guard: skip if a trench stamp already sits here.
            // Stamps of the current move advance along a STRAIGHT line spaced ~stride apart,
            // so a new stamp can only overlap the last few (window of 4 has plenty of margin)
            // rather than the entire accumulated list
            let alreadyCarved = near.some(
              st => {
                if (st.m !== 2 || st.t !== STAIN.SMEAR || st.lv >= SNOW_LEVEL.DRIFT || st.c === SNOW_COLOR) return false;
                if (!stainMatchesLevel(st, activeLvl) || !elevationMatches(st.e, surface)) return false;
                const ddx = st.x - tx, ddy = st.y - ty;
                return ddx * ddx + ddy * ddy < carveNearR2;
              }
            );
            for (let ti = Math.max(0, driftTrenches.length - 4); !alreadyCarved && ti < driftTrenches.length; ti++) {
              const st = driftTrenches[ti];
              const ddx = st.x - tx, ddy = st.y - ty;
              if (ddx * ddx + ddy * ddy < carveSelfR2) alreadyCarved = true;
            }
            if (alreadyCarved) {
              // Allow bloody soles to tint an existing dent; otherwise skip
              if (!bloodySnowColor) continue;
            }
            const subDelayMs = stepDelayMs > 0
              ? Math.max(1, stepDelayMs + (shiftIdx.length > 1 && sIdx === 1 ? 4 : 0))
              : 0;
            driftTrenches.push(store.createStain({
              t: STAIN.SMEAR,
              x: tx,
              y: ty,
              s: Math.round(tsize * (trenchSizeBase + Math.random() * 0.08)),
              r: rot + (Math.random() - 0.5) * 0.04,
              a: trenchAlpha,
              c: bloodySnowColor ? bloodySnowColor : SNOW_SHADOW_COLOR,
              m: 2,
              e: surface,
              ...(subDelayMs > 0 ? { d: subDelayMs } : {}),
              ...tidProp,
              ...(activeLvl ? { lvl: activeLvl } : {})
            }));
          }
          if (puffsOn && stepDelayMs === 0) {
            spawnStepPuff({ x: sx, y: sy, dir: rot, material: 2, color: snowBaseCol, elevation: surface, level: activeLvl });
          }
          continue;
        }
        // On snow (`m === 2`), soles do NOT track snow onto bare snowless floors:
        // snow boot prints appear ONLY where snow actually lies
        if (m === 2) {
          this._soles.delete(doc.id);
          soles = null;
          sole = { m: 2, c: ground.c, steps: 1, total: 1 };
          fresh = true;
        } else {
          sole = { m, c: ground.c, steps, total: steps };
          this._soles.set(doc.id, sole);
          soles = sole;
          fresh = true;
        }
      } else if (soles && soles.steps > 0 && soles.m !== 2) {
        stepWear = soles.steps / Math.max(1, soles.total);
        soles.steps--;
        sole = soles;
        if (!soles.steps) this._soles.delete(doc.id); // soles worn clean
      } else {
        continue; // clean soles (or snow mode with no snow underfoot) — no print
      }

      const fadeCurve = Math.pow(stepWear, 1.35);
      // For slithering creatures/oozes/snakes/swarms (`isSlither`), trail a wavy SMEAR instead of boot prints
      if (isSlither) {
        const wave = Math.sin(i * 1.25) * stride * 0.14;
        const sxWave = sx + nx * wave;
        const syWave = sy + ny * wave;
        stains.push(store.createStain({
          t: STAIN.SMEAR,
          x: sxWave,
          y: syWave,
          s: tsize * 0.52 * (0.82 + 0.18 * stepWear) * (0.94 + Math.random() * 0.12),
          r: rot + Math.cos(i * 1.25) * 0.16,
          a: fresh ? (0.78 + Math.random() * 0.10) : Math.max(0.10, 0.08 + 0.74 * fadeCurve),
          c: fresh ? shadeHex8(sole.c, -0.22) : sole.c,
          m: sole.m,
          e: surface,
          ...(sole.m !== 2 ? { T: wt } : {}),
          ...(stepDelayMs > 0 ? { d: stepDelayMs } : {}),
          ...(surf.tid ? { tid: surf.tid } : {}),
          ...(activeLvl ? { lvl: activeLvl } : {})
        }));
        continue;
      }

      const latK = fpSub === 3 ? 0.22 : (fpSub === 1 || fpSub === 2 ? 0.32 : 0.06);
      const sizeK = fpSub === 3 ? 0.40 : (fpSub === 1 ? 0.42 : (fpSub === 2 ? 0.48 : 0.62));
      if (!soleWear && fresh && sole.m !== 2 && ground) {
        const offCur = stride * latK * side;
        const d2Cur = (sx + nx * offCur - ground.x) ** 2 + (sy + ny * offCur - ground.y) ** 2;
        const offOpp = stride * latK * (-side);
        const d2Opp = (sx + nx * offOpp - ground.x) ** 2 + (sy + ny * offOpp - ground.y) ** 2;
        const inFootR = (Number(ground.s) || 0) * 0.30;
        if (d2Cur > inFootR * inFootR && d2Opp < d2Cur) {
          side = -side;
        }
      }
      const off = stride * latK * side;
      const jit = fpSub === 0 ? grid * 0.14 : grid * 0.06;
      const fx = sx + nx * off + (Math.random() - 0.5) * jit;
      const fy = sy + ny * off + (Math.random() - 0.5) * jit;
      // For a snow boot print: verify that snow lies directly beneath the boot `(fx, fy)`
      // and that no snow print is already stamped right there (avoiding overstacking).
      // Candidates come from the ALREADY queried `near` in a single pass: the circle
      // `(fx, fy, tsize * 0.22 + 0.35 * s)` is guaranteed to lie inside `near`
      // (foot offset <= 0.21 * tsize < (0.45 - 0.22) * tsize) — no third queryCircle per print needed
      if (sole.m === 2) {
        const rU = tsize * 0.22;
        const rU2 = rU * rU;
        let hasSnowUnderFoot = false;
        let hasPrintHere = false;
        for (const st of near) {
          const rr = rU + st.s * 0.35;
          const ddx = st.x - fx, ddy = st.y - fy;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > rr * rr) continue;
          if (st.m !== 2) continue;
          if (stainMatchesLevel(st, activeLvl) && elevationMatches(st.e, surface)) {
            if (st.t !== STAIN.FOOTPRINT && st.c !== SNOW_SHADOW_COLOR
              && (Number(st.a) || 0) >= 0.25) hasSnowUnderFoot = true;
            if (st.t === STAIN.FOOTPRINT && d2 < rU2) hasPrintHere = true;
          }
        }
        if (!hasSnowUnderFoot) continue;
        if (hasPrintHere && !bloodySnowColor) continue;
      } else {
        // Guard against unbounded invisible footprint stacking when pacing a narrow corridor:
        // if >= 3 bright prints of the same material already sit right under the boot (within 0.16 * tsize), skip the 4th+
        const dupR2 = (tsize * 0.16) * (tsize * 0.16);
        let stackedPrints = 0;
        for (let ni = 0; ni < near.length; ni++) {
          const st = near[ni];
          if (st.t !== STAIN.FOOTPRINT || (Number(st.m) || 0) !== (sole.m || 0)) continue;
          if ((Number(st.a) || 0) < 0.35 || !stainMatchesLevel(st, activeLvl) || !elevationMatches(st.e, surface)) continue;
          const ddx = st.x - fx, ddy = st.y - fy;
          if (ddx * ddx + ddy * ddy < dupR2 && ++stackedPrints >= 3) break;
        }
        if (stackedPrints >= 3) continue;
      }

      const wearSizeMul = sole.m === 2 ? 1 : (0.60 + 0.40 * stepWear);
      const useWornVariant = !fresh && sole.m !== 2 && stepWear <= 0.52;
      stains.push(store.createStain({
        t: STAIN.FOOTPRINT,
        x: fx,
        y: fy,
        s: tsize * sizeK * wearSizeMul * (0.95 + Math.random() * 0.1),
        r: rot + (Math.random() - 0.5) * 0.36, // subtle scatter around movement direction
        a: sole.m === 2
          ? (fresh ? Math.min(0.85, 0.55 + Math.random() * 0.15) : Math.max(0.14, 0.5 * stepWear))
          : (fresh ? (0.82 + Math.random() * 0.10) : Math.max(0.09, 0.06 + 0.84 * fadeCurve)),
        // fresh bloody footprint is DARKER than the stain (pressed, coagulated
        // blood) — otherwise red-on-red is unreadable; prints tracked onto
        // clean ground keep the pure blood color
        c: bloodySnowColor ? bloodySnowColor
          : sole.m === 2 ? shadeHex8(sole.c, -0.42) // print in snow — shadow shade
            : fresh ? shadeHex8(sole.c, -0.22)      // bloody print on blood — darker
              : sole.c,                             // bloody print on clean floor — base color
        seed: _mintSeedForSide(side < 0, useWornVariant),
        m: sole.m,
        e: surface, // print lives on the step surface (when fresh: blood.e ≈ surface)
        ...(sole.m !== 2 ? { T: wt } : {}),
        ...(fpSub > 0 ? { fp: fpSub } : {}),
        ...(stepDelayMs > 0 ? { d: stepDelayMs } : {}),
        ...(surf.tid ? { tid: surf.tid } : {}),
        ...(activeLvl ? { lvl: activeLvl } : {})
      }));
    }

    this._footSide.set(doc.id, side);
    if (driftTrenches.length) stains.push(...driftTrenches);
    if (trampledSnow.size) {
      trampleSnowStains(store, trampledSnow, stains);
      if (stains.length) this._pushTrailOp(doc.id, x0, y0, stains);
    } else if (stains.length) {
      store.add(stains);
      this._pushTrailOp(doc.id, x0, y0, stains);
    }
  }

  /** Bleeding trail for wounded tokens (smears + droplets along the path; wound depth drives density). */
  bleedingTrail(doc, changes, options: any = {}) {
    if (changes?.level && doc?.level && changes.level !== doc.level) return;
    if (!settingGet('bloodTrail', true)) return;
    const moveAction = resolveMoveAction(doc, changes, options);
    if (moveAction === 'teleport' || moveAction === 'jump') return; // no mid-air blood trail during teleports or jumps
    const token = doc.object;
    if (!token?.center || !doc.actor) return;
    if (bloodDisabled(token)) return;
    if (settingGet('bloodOnlyInCombat', false) && !game.combat?.started) return;
    if (!isBleeding(token)) return;
    // wound depth 0..1: trail intensity scales with it — a token barely past
    // threshold leaves sparse drops, while a near-death token leaves a thick trail
    const depth = woundDepth(token);

    const now = Date.now();
    const last = this._lastTrail.get(token.id) ?? 0;
    if (now - last < TRAIL_COOLDOWN_MS) return;

    const grid = canvas.grid?.size ?? 100;
    const x0 = doc.x, y0 = doc.y;
    const x1 = changes.x ?? x0, y1 = changes.y ?? y0;
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < grid * 0.5) return;

    const store = this.getStore();
    if (!store) return;

    // zone: `none` suppresses generation (checked BEFORE consuming cooldown so a
    // blocked move doesn't waste the 350 ms window); `tracked` sets no-wash (`nw`)
    const tLevel = doc?.level ?? currentLevelId();
    const zoneMode = bloodZoneModeAt(token.center.x, token.center.y, tLevel);
    if (zoneMode === 'none') return;
    const zoneNw = zoneMode === 'tracked' ? { nw: 1 } : {};
    this._lastTrail.set(token.id, now); // after guards: a null store must not consume cooldown

    const hex = hexOf(token);
    const rot = Math.atan2(dy, dx);
    const tsize = tsizeOf(doc, grid);
    // doc.x/y is top-left; sample along the token's per-AXIS center
    const hw = (Math.abs(doc.width ?? 1) * grid) / 2;
    const hh = (Math.abs(doc.height ?? 1) * grid) / 2;
    const tElev = elevOf(doc);
    const scale = settingGet('bloodScale', 1);
    const moveDurationMs = _smartMoveDurationMs(dist, grid, options, doc);
    const step = grid * 0.75;
    const n = Math.min(12, Math.max(1, Math.round((dist / step) * (0.55 + depth * 0.45))));
    const stains = [];
    const tintedSnow = new Map();
    const wt = worldTime();
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 0.5);
      const stepDelayMs = moveDurationMs > 0 ? Math.round(t * moveDurationMs) : 0;
      const x = hw + x0 + dx * t + (Math.random() - 0.5) * grid * 0.2;
      const y = hh + y0 + dy * t + (Math.random() - 0.5) * grid * 0.2;
      // resolve surface PER SAMPLE (just like footprints): a trail crossing a tile
      // edge or elevation change must not carry the departure point's `e`/`tid`
      const surf = surfaceAt(x, y, tElev, tLevel);
      const activeLvl = surf.lvl ?? tLevel;
      const absorbed = absorbBloodIntoSnow(store, x, y, tsize * 0.5, surf.e, hex, tintedSnow, activeLvl);
      const sizeK = absorbed ? absorbed.sizeK : 1;
      const alphaK = absorbed ? absorbed.alphaK : 1;
      const stainColor = absorbed ? absorbed.color : hex;
      stains.push(store.createStain({
        t: i % 3 === 0 ? STAIN.DROPLETS : STAIN.SMEAR,
        x, y,
        s: tsize * (0.3 + Math.random() * 0.2 + depth * 0.12) * scale * sizeK,
        r: rot + (Math.random() - 0.5) * 0.2,
        a: Math.min(0.95, (0.35 + depth * 0.3 + Math.random() * 0.15) * alphaK),
        c: stainColor,
        T: wt,
        ...(stepDelayMs > 0 ? { d: stepDelayMs } : {}),
        ...zoneNw,
        e: surf.e,
        ...(surf.tid ? { tid: surf.tid } : {}),
        ...(activeLvl ? { lvl: activeLvl } : {})
      }));
    }
    if (tintedSnow.size) {
      trampleSnowStains(store, tintedSnow, stains);
      if (stains.length) this._pushTrailOp(doc.id, x0, y0, stains);
    } else if (stains.length) {
      store.add(stains);
      this._pushTrailOp(doc.id, x0, y0, stains);
    }
  }
}
