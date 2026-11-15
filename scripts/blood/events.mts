/**
 * Game events → blood stains. Generated ONLY on the GM client:
 * the GM creates records (positions, seeds — pure data), while the socket and
 * scene flag distribute them to other clients where shapes reproduce deterministically.
 *
 * This module is the combat/death COORDINATOR (HP deltas, death pools, hit splats
 * styled by damage type, wall drips, stationary dripping). Subsystems live in
 * their own modules (previously a single 1150-line file where adding a subsystem
 * required edits in four places):
 *   vitals.mjs     — HP/wound reading, bleeding thresholds (SYSTEM_HP_PATHS);
 *   trail.mjs      — footprints, bleeding trail, movement CTRL+Z;
 *   walls.mjs      — wall profile revalidation;
 *   tile-stick.mjs — blood sticking to tiles;
 *   util.mjs       — shared helpers (wallProfile, hexOf, worldTime...).
 *
 * Hit direction comes from midi-qol.isDamaged (workflow.token = attacker), or falls
 * back to the active combat tracker combatant without midi. On midi-qol 12+, the
 * DamageApplied hook is not emitted at all and is kept only as a legacy fallback.
 */

import { STAIN } from './stains.mjs';
import { playBurst } from './particles.mjs';
import { mintSeed } from './rng.mjs';
import { mixHex } from './colors.mjs';
import { surfaceAt, currentLevelId } from './elevation.mjs';
import { pushBloodOp } from './undo.mjs';
import { bloodZoneModeAt } from './zones.mjs';
import { maybeCorpseImprint } from './corpse.mjs';
import {
  SYSTEM_HP_PATHS, hpShare, deathFailsPath, hpPaths, prop, num, getHp, getHpMax,
  bloodEnabled, bloodDisabled, hasBleedStatus, statusBleedOn, isBleeding, isDeadDoc,
  PRONE_RE, isCrawlingOrDragged, resolveToken, woundDepth
} from './vitals.mjs';
import { TAU, settingGet, elevOf, tsizeOf, worldTime, hexOf, wallProfile, wallRayHit, WALL_RADIUS_K } from './util.mjs';
import { WallProfiles } from './walls.mjs';
import { TileSticker } from './tile-stick.mjs';
import { TrailEngine, resolveMoveAction } from './trail.mjs';
import { meltSnowAt, blastSnowAt, freezeSnowAt, absorbBloodIntoSnow, trampleSnowStains } from './snow-bridge.mjs';

const MELT_DAMAGE_RE = /fire|flame|flaming|burn|scorch|blaze|inferno|meteor|lava|magma|radiant|acid|огн|огонь|плам|пыла|палящ|жар|лава|магм|метеор|испепел|излучен|свет|кислот/i;
const BLAST_DAMAGE_RE = /thunder|force|bludgeon|гром|звук|силов|дробящ/i;
const COLD_DAMAGE_RE = /cold|frost|ice|freeze|холод|мороз|лед|лёд|стуж/i;

// backward compatibility: entry.mjs and bloodied.mjs import these from here
export { SYSTEM_HP_PATHS, hpShare };

const HIT_DELAY_MS = 300;
const DRIP_TICK_MS = 2000;         // periodic emission poll interval (GM)
const BLEED_STAND_MS = 3000;       // "standing still" threshold for status bleeding
const WOUND_STAND_MS = 12000;      // "standing long enough" threshold for deep wounds
const WOUND_DRIP_EVERY_MS = 20000; // deep-wound drip cadence (legacy semantics)

/**
 * Damage type profiles → blood character: fire/radiant/force CAUTERIZE
 * (far less blood as the wound is seared), necrotic yields black withering
 * blood, cold "freezes" (thickens, larger pool), poison/acid tint the blood.
 * Blood remains an informative clue about the WEAPON, not just a generic decal.
 */
const DAMAGE_PROFILES = {
  fire: { vol: 0.3, burst: 0.4, mix: ['#2a120a', 0.35] },
  radiant: { vol: 0.25, burst: 0.35, mix: ['#3a2a10', 0.4] },
  force: { vol: 0.5, burst: 0.5 },
  psychic: { vol: 0.45, burst: 0.5 },
  necrotic: { vol: 1, burst: 0.9, mix: ['#160b14', 0.62] },
  cold: { vol: 1.1, burst: 0.8, mix: ['#bcd8e8', 0.2] },
  poison: { vol: 0.9, burst: 0.9, mix: ['#3f7d2c', 0.28] },
  acid: { vol: 0.9, burst: 0.9, mix: ['#6fae2c', 0.24] },
  lightning: { vol: 0.85, burst: 1.1 }
};
const PROFILE_DEFAULT = { vol: 1, burst: 1 };

/** Blood character profile by damage type (unknown/none → neutral). */
function _damageProfile(type) {
  return (type && DAMAGE_PROFILES[type]) || PROFILE_DEFAULT;
}

/** Blood color adjusted by damage profile (necrotic darkens, cold chills...). */
function _bloodHex(token, profile) {
  const hex = hexOf(token);
  if (!profile.mix) return hex;
  return mixHex(hex, profile.mix[0], profile.mix[1]);
}

/** Scene tone preset: grimdark is gorier, family is more restrained. */
function _tonePreset() {
  const t = settingGet('bloodTone', 'default');
  if (t === 'grimdark') return { violenceK: 2, dropletGate: 4 };
  if (t === 'family') return { violenceK: -2, dropletGate: 9 };
  return { violenceK: 0, dropletGate: 6 };
}

/**
 * Decorate declarative stain defs (finishers, third-party API) with surface
 * elevation/tile and wall profile — matching the auto-generation contract:
 * each stain gets e/tid of the surface beneath its point (upTo = ceiling,
 * usually the victim's elevation) and w at the canonical WALL_RADIUS_K·s radius.
 * Without this, finisher blood falls onto the floor layer (victim on a roof →
 * pool under furniture) and passes through walls. Call on the GM side: reads
 * canvas/settings; does not mint seeds.
 */
function _docLevelId(doc: any): string | null {
  const cur = currentLevelId();
  if (!doc) return cur;
  if (typeof doc.level === 'string' && doc.level) return doc.level;
  if (doc.levels?.size) {
    if (cur && doc.levels.has(cur)) return cur;
    return doc.levels.values().next().value ?? cur;
  }
  return cur;
}

export function groundStainDefs(defs, upTo = Number.POSITIVE_INFINITY, levelOrId: any = null) {
  if (!Array.isArray(defs)) return defs;
  for (const d of defs) {
    if (!d || typeof d !== 'object') continue;
    const x = Number(d.x) || 0, y = Number(d.y) || 0;
    const targetLvl = d.lvl ?? levelOrId ?? currentLevelId();
    const surf = surfaceAt(x, y, upTo, targetLvl);
    if (d.e === undefined) d.e = surf.e;
    if (d.tid === undefined && surf.tid) d.tid = surf.tid;
    const activeLvl = surf.lvl ?? targetLvl;
    if (d.lvl === undefined && activeLvl) d.lvl = activeLvl;
    if (d.w === undefined) d.w = wallProfile({ x, y }, (Number(d.s) || 100) * WALL_RADIUS_K, activeLvl);
  }
  return defs;
}

/**
 * Impact circles derived from AoE region geometry (scene pixels): circle/ellipse —
 * exact radius, other types — circumscribed bbox circle; elongated shapes (wall of
 * fire, ray) — a chain of circles along the major axis instead of one giant circle.
 * Polygon points are in absolute scene coordinates (same convention as
 * polygonTree.testPoint); rectangle uses top-left origin (PIXI convention).
 */
function regionSnowCircles(shapes) {
  const circles = [];
  for (const sh of shapes ?? []) {
    if (!sh) continue;
    let cx, cy, w = 0, h = 0;
    if (sh.type === 'circle' && !Array.isArray(sh.points)) {
      const r = Number(sh.radius) || (Math.max(Number(sh.width) || 0, Number(sh.height) || 0) / 2);
      if (r > 0) circles.push({ x: Number(sh.x) || 0, y: Number(sh.y) || 0, r });
      continue;
    }
    if (sh.type === 'ring' && !Array.isArray(sh.points)) {
      const r = Number(sh.outerRadius) || Number(sh.radius) || Number(sh.innerRadius) || 0;
      if (r > 0) circles.push({ x: Number(sh.x) || 0, y: Number(sh.y) || 0, r });
      continue;
    }
    if (sh.type === 'emanation' && !Array.isArray(sh.points)) {
      const base = sh.base;
      if (base && typeof base === 'object') {
        const gridSize = Number((globalThis as any).canvas?.grid?.size) || 100;
        const isTok = base.type === 'token';
        const bw = isTok ? (Number(base.width) || 1) * gridSize : (Number(base.width) || 0);
        const bh = isTok ? (Number(base.height) || 1) * gridSize : (Number(base.height) || 0);
        const ax = base.anchorX !== undefined && base.anchorX !== null ? Number(base.anchorX) : (isTok ? 0.5 : 0);
        const ay = base.anchorY !== undefined && base.anchorY !== null ? Number(base.anchorY) : (isTok ? 0.5 : 0);
        const bx = (Number(base.x) || 0) + (0.5 - ax) * bw;
        const by = (Number(base.y) || 0) + (0.5 - ay) * bh;
        const r = (Number(sh.radius) || 0) + Math.max(bw, bh) * 0.5;
        if (r > 0) circles.push({ x: bx, y: by, r });
      } else {
        const r = Number(sh.radius) || 0;
        if (r > 0) circles.push({ x: Number(sh.x) || 0, y: Number(sh.y) || 0, r });
      }
      continue;
    }
    if (sh.type === 'ellipse' && !Array.isArray(sh.points)) {
      const rx = Number(sh.radiusX) || (Number(sh.width) ? Number(sh.width) / 2 : 0) || Number(sh.radius) || 0;
      const ry = Number(sh.radiusY) || (Number(sh.height) ? Number(sh.height) / 2 : 0) || Number(sh.radius) || rx;
      const r = Math.max(rx, ry);
      if (r > 0) circles.push({ x: Number(sh.x) || 0, y: Number(sh.y) || 0, r });
      continue;
    }
    if (sh.type === 'cone' && !Array.isArray(sh.points)) {
      const ox = Number(sh.x) || 0, oy = Number(sh.y) || 0;
      const len = Number(sh.radius) || Math.max(Number(sh.width) || 0, Number(sh.height) || 0);
      if (len <= 0) continue;
      if (sh.rotation !== undefined && sh.rotation !== null) {
        const rad = (Number(sh.rotation) || 0) * (Math.PI / 180);
        const halfAngle = ((Number(sh.angle) || 53.13) * 0.5) * (Math.PI / 180);
        const steps = 4;
        for (let s = 1; s <= steps; s++) {
          const frac = s / steps;
          const dist = len * frac * 0.82;
          const r = Math.max(len * 0.28, dist * Math.sin(halfAngle) * 1.15);
          circles.push({ x: ox + Math.cos(rad) * dist, y: oy + Math.sin(rad) * dist, r });
        }
      } else {
        circles.push({ x: ox, y: oy, r: len });
      }
      continue;
    }
    if ((sh.type === 'line' || sh.type === 'ray') && !Array.isArray(sh.points) && Number(sh.length) > 0 && !(Number(sh.height) > 0)) {
      // Foundry v14 LineShapeData: (x, y) is the ray origin, length is distance along rotation, width is thickness
      const ox = Number(sh.x) || 0, oy = Number(sh.y) || 0;
      const len = Number(sh.length) || 0;
      const thick = Number(sh.width) || Number(sh.thickness) || (Number((globalThis as any).canvas?.grid?.size) || 100);
      const rotRad = (Number(sh.rotation) || 0) * (Math.PI / 180);
      const dx = Math.cos(rotRad), dy = Math.sin(rotRad);
      const n = Math.min(24, Math.max(2, Math.round(len / Math.max(1, thick))));
      const r = Math.max(48, thick * 0.75);
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        circles.push({ x: ox + dx * len * f, y: oy + dy * len * f, r });
      }
      continue;
    }
    if (Array.isArray(sh.points) && sh.points.length >= 4) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i + 1 < sh.points.length; i += 2) {
        const px = Number(sh.points[i]) || 0, py = Number(sh.points[i + 1]) || 0;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      cx = (minX + maxX) / 2;
      cy = (minY + maxY) / 2;
      w = maxX - minX;
      h = maxY - minY;
    } else if (sh.type === 'rectangle' || sh.type === 'line' || sh.type === 'ray') {
      w = Number(sh.width) || Number(sh.length) || 0;
      h = Number(sh.height) || Number(sh.thickness) || 0;
      const ax = Number(sh.anchorX) || 0;
      const ay = Number(sh.anchorY) || 0;
      const ox = (0.5 - ax) * w;
      const oy = (0.5 - ay) * h;
      const rotRad = (Number(sh.rotation) || 0) * (Math.PI / 180);
      cx = (Number(sh.x) || 0) + (rotRad ? (ox * Math.cos(rotRad) - oy * Math.sin(rotRad)) : ox);
      cy = (Number(sh.y) || 0) + (rotRad ? (ox * Math.sin(rotRad) + oy * Math.cos(rotRad)) : oy);
    } else {
      // unknown shape type: center + declared radius as upper bound
      const r = Number(sh.radius) || (Math.max(Number(sh.width) || 0, Number(sh.height) || 0) / 2);
      if (r > 0) circles.push({ x: Number(sh.x) || 0, y: Number(sh.y) || 0, r });
      continue;
    }
    if (w <= 0 || h <= 0) continue;
    const long = Math.max(w, h), short = Math.min(w, h);
    if (long > short * 2.5) {
      const n = Math.min(24, Math.max(2, Math.round(long / Math.max(1, short))));
      const r = short * 0.75;
      const rotRad = (Number(sh.rotation) || 0) * (Math.PI / 180);
      const baseDx = w >= h ? 1 : 0, baseDy = h > w ? 1 : 0;
      const dx = rotRad ? (baseDx * Math.cos(rotRad) - baseDy * Math.sin(rotRad)) : baseDx;
      const dy = rotRad ? (baseDx * Math.sin(rotRad) + baseDy * Math.cos(rotRad)) : baseDy;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1) - 0.5;
        circles.push({ x: cx + t * long * dx, y: cy + t * long * dy, r });
      }
    } else {
      circles.push({ x: cx, y: cy, r: Math.hypot(w, h) / 2 });
    }
  }
  return circles;
}

/**
 * Extract a damage type string from a DamageDescription array in dnd5e 6.0.0:
 * supports both `d.type` (string) and `d.types` (`Set<string>` or `string[]`),
 * prioritizing damage types that interact with snow (fire/radiant/acid/thunder/cold).
 */
function _extractDamageTypeFromList(damages) {
  if (!Array.isArray(damages) || !damages.length) return null;
  const candidates = [];
  const collectFrom = (onlyPositive) => {
    for (const d of damages) {
      if (!d || typeof d !== 'object') continue;
      if (onlyPositive && !(Number(d.value ?? d.amount ?? 1) > 0)) continue;
      if (typeof d.type === 'string' && d.type && d.type !== 'healing') candidates.push(d.type);
      if (d.types && (d.types instanceof Set || Array.isArray(d.types) || typeof d.types[Symbol.iterator] === 'function')) {
        for (const t of d.types) {
          if (typeof t === 'string' && t && t !== 'healing') candidates.push(t);
        }
      }
    }
  };
  collectFrom(true);
  if (!candidates.length) collectFrom(false);
  if (!candidates.length) return null;
  const snowMatch = candidates.find(t => MELT_DAMAGE_RE.test(t) || BLAST_DAMAGE_RE.test(t) || COLD_DAMAGE_RE.test(t));
  return snowMatch ?? candidates[0];
}

/**
 * Extract a damage type string from a `DamageRoll[]` array in dnd5e 6.0.0:
 * checks `roll.options.type`, `roll.options.types` (`Set` / array), `roll.type`, and `flavor`.
 */
function _extractDamageTypeFromRolls(rolls) {
  if (!Array.isArray(rolls) || !rolls.length) return null;
  const candidates = [];
  for (const r of rolls) {
    if (!r || typeof r !== 'object') continue;
    const opts = r.options ?? {};
    if (typeof opts.type === 'string' && opts.type && opts.type !== 'healing') candidates.push(opts.type);
    if (opts.types && (opts.types instanceof Set || Array.isArray(opts.types) || typeof opts.types[Symbol.iterator] === 'function')) {
      for (const t of opts.types) {
        if (typeof t === 'string' && t && t !== 'healing') candidates.push(t);
      }
    }
    if (typeof r.type === 'string' && r.type && r.type !== 'healing') candidates.push(r.type);
    if (typeof opts.flavor === 'string' && opts.flavor) candidates.push(opts.flavor);
    if (typeof r.flavor === 'string' && r.flavor) candidates.push(r.flavor);
  }
  if (!candidates.length) return null;
  const snowMatch = candidates.find(t => MELT_DAMAGE_RE.test(t) || BLAST_DAMAGE_RE.test(t) || COLD_DAMAGE_RE.test(t));
  return snowMatch ?? candidates[0];
}

/**
 * Reliably resolve spell/ability damage type for Foundry VTT v14 + dnd5e 6.0.0:
 * checks explicit module flags, dnd5e 6.0.0 flags (`activity`, `item`, `origin`),
 * midi-qol flags, `activity.damage.parts` (`Set` / `types` array),
 * `item.system.activities` (Collection or plain object), `item.system.damage.base.types`,
 * as well as the names of the activity, item, and region/template itself.
 */
function _resolveSpellDamageType(docOrItem, activityOverride = null) {
  if (!docOrItem) return null;
  const flags = docOrItem.flags ?? {};
  if (flags?.showstopper?.damageType) return String(flags.showstopper.damageType);
  if (flags?.dnd5e?.damageType) return String(flags.dnd5e.damageType);

  const candidates = [];
  const pushTypes = (val) => {
    if (!val) return;
    if (typeof val === 'string') {
      if (val && val !== 'healing') candidates.push(val);
      return;
    }
    if (val instanceof Set || Array.isArray(val) || typeof val[Symbol.iterator] === 'function') {
      for (const v of val) {
        if (typeof v === 'string' && v && v !== 'healing') candidates.push(v);
      }
    }
  };
  const inspectActivity = (act) => {
    if (!act || typeof act !== 'object') return;
    if (act.damageType) pushTypes(act.damageType);
    const parts = act.damage?.parts;
    if (parts) {
      const list = Array.isArray(parts) ? parts : (typeof parts.values === 'function' ? [...parts.values()] : Object.values(parts));
      for (const p of list) {
        if (!p) continue;
        if (Array.isArray(p)) pushTypes(p[1]);
        else {
          pushTypes(p.types);
          pushTypes(p.type);
        }
      }
    }
    if (act.cachedSpell && typeof act.cachedSpell === 'object') {
      inspectItem(act.cachedSpell);
    }
    if (act.name) pushTypes(act.name);
  };
  const inspectItem = (it) => {
    if (!it || typeof it !== 'object') return;
    // Handle case where the passed object is itself a dnd5e 6.0.0 Activity (has damage.parts or item)
    if (it.damage?.parts) inspectActivity(it);
    const sys = it.system ?? {};
    pushTypes(sys.damage?.base?.types);
    pushTypes(sys.damage?.base?.type);
    if (Array.isArray(sys.damage?.parts)) {
      for (const p of sys.damage.parts) {
        if (Array.isArray(p)) pushTypes(p[1]);
        else if (p) { pushTypes(p.types); pushTypes(p.type); }
      }
    }
    const acts = sys.activities;
    if (acts) {
      const actList = typeof acts.values === 'function'
        ? [...acts.values()]
        : (Array.isArray(acts) ? acts : Object.values(acts));
      for (const a of actList) inspectActivity(a);
    }
    if (it.name) pushTypes(it.name);
  };

  // Safe synchronous UUID resolution (in Foundry v14, fromUuidSync with strict=true throws
  // on nested compendium documents like Compendium.pack.Item.id.Activity.actId — catch
  // selectively and fall back to the parent Item UUID when needed)
  const safeResolve = (u) => {
    if (!u || typeof u !== 'string' || typeof globalThis.fromUuidSync !== 'function') return null;
    try {
      const doc = globalThis.fromUuidSync(u, { strict: false });
      if (doc && typeof doc === 'object') return doc;
    } catch { /* fallback below */ }
    const actIdx = u.indexOf('.Activity.');
    if (actIdx > 0) {
      try {
        const parentDoc = globalThis.fromUuidSync(u.slice(0, actIdx), { strict: false });
        if (parentDoc && typeof parentDoc === 'object') return parentDoc;
      } catch { /* empty */ }
    }
    return null;
  };

  const act = activityOverride
    ?? (typeof flags?.dnd5e?.activity === 'object' ? flags.dnd5e.activity : safeResolve(flags?.dnd5e?.activity))
    ?? safeResolve(flags?.dnd5e?.origin);
  if (act) {
    inspectActivity(act);
    if (act.spell?.uuid) {
      const castSpell = safeResolve(act.spell.uuid);
      if (castSpell) inspectItem(castSpell);
    }
  }
  const item = act?.item
    ?? (docOrItem.system ? docOrItem : null)
    ?? (typeof flags?.dnd5e?.item === 'object' ? flags.dnd5e.item : null)
    ?? safeResolve(flags?.['midi-qol']?.itemUuid)
    ?? safeResolve(flags?.dnd5e?.item)
    ?? safeResolve(flags?.dnd5e?.origin);
  if (item) inspectItem(item);

  if (docOrItem.name) pushTypes(docOrItem.name);
  if (!candidates.length) return null;

  // Prioritize damage types or names that trigger snow melting, blasting, or freezing
  const match = candidates.find(c => MELT_DAMAGE_RE.test(c) || BLAST_DAMAGE_RE.test(c) || COLD_DAMAGE_RE.test(c));
  return match ?? candidates[0];
}

/* --------------------------------- context --------------------------------- */

export class BloodEventHooks {
  declare getStore; declare getRenderer; declare _oldHp; declare _oldDeathFails; declare _lastHitDir; declare _lastDamageType; declare _lastSnowDmgAt; declare _processedRegionIds; declare _pendingAoETemplates; declare _aoeSeq; declare _seenDamageRollArrays; declare _hitTimers; declare _lastPos; declare _lastDrip; declare _stationaryTimer; declare _trail; declare _walls; declare _tiles;
  /** @param {() => import('./stains.mjs').BloodStore} getStore
   *  @param {() => import('./renderer.mjs').BloodRenderer} [getRenderer] */
  constructor(getStore, getRenderer = null) {
    this.getStore = getStore;
    this.getRenderer = getRenderer;
    this._oldHp = new Map();
    this._oldDeathFails = new Map(); // actor uuid → death save failures BEFORE update
    this._lastHitDir = new Map();     // tokenId → {x, y, at}
    this._lastDamageType = new Map(); // tokenId → damage type (midi workflow) for blood profile
    this._lastSnowDmgAt = new Map();  // tokenId → last snow damage reaction timestamp (dedup)
    this._processedRegionIds = new Set(); // IDs of already queued AoE regions (guards against createRegion + postCreateMeasuredTemplate duplicates)
    this._pendingAoETemplates = new Map(); // key → pending AoE template awaiting damage roll
    this._aoeSeq = 0;
    this._seenDamageRollArrays = new WeakSet(); // guards against duplicate dnd5e.rollDamage + dnd5e.rollDamageV2 invocations
    this._hitTimers = new Set();      // delayed _spawnHit timers: cancelled in dispose
    this._lastPos = new Map();        // tokenId → {x, y, at} — stationarity tracking for drips
    this._lastDrip = new Map();       // tokenId → last drip timestamp (status bleed cadence)
    this._stationaryTimer = null;     // periodic emission interval (GM)
    // subsystems: each owns its own state, hooks, and dispose
    this._trail = new TrailEngine(getStore);
    this._walls = new WallProfiles(getStore);
    this._tiles = new TileSticker(getStore, getRenderer);
  }

  register() {
    Hooks.on('preUpdateActor', (actor) => this._onPreUpdateActor(actor));
    Hooks.on('updateActor', (actor, updates) => this._onUpdateActor(actor, updates));
    Hooks.on('preUpdateToken', (doc, changes, options) => this._onPreUpdateToken(doc, changes, options));
    Hooks.on('preDeleteToken', (doc) => this._onDeleteToken(doc));
    Hooks.on('createActiveEffect', (effect) => this._onCreateActiveEffect(effect));
    Hooks.on('dnd5e.createMeasuredTemplate', (activity, regionData) => this._onPreCreateActivityTemplate(activity, regionData));
    Hooks.on('createRegion', (region) => this._onCreateRegion(region));
    Hooks.on('dnd5e.postCreateMeasuredTemplate', (activity, regionDoc) => this._onCreateRegion(regionDoc, activity));
    Hooks.on('createMeasuredTemplate', (template) => this._onCreateMeasuredTemplate(template));
    Hooks.on('preDeleteRegion', (region) => this._onDeleteAoETemplate(region));
    Hooks.on('preDeleteMeasuredTemplate', (template) => this._onDeleteAoETemplate(template));
    Hooks.on('dnd5e.postUseActivity', (activity, usageConfig, results) => this._onPostUseActivity(activity, usageConfig, results));
    Hooks.on('dnd5e.rollDamageV2', (rolls, data) => this._onRollDamage(rolls, data));
    Hooks.on('dnd5e.rollDamage', (rolls, data) => this._onRollDamage(rolls, data));
    Hooks.on('createChatMessage', (message) => this._onCreateChatMessage(message));
    Hooks.on('updateChatMessage', (message, changes) => this._onUpdateChatMessage(message, changes));
    this._registerMidiDirection();
    this._trail.register();
    this._walls.register();
    this._tiles.register();
    if (game.user.isGM) {
      this._stationaryTimer = setInterval(() => this._stationaryDrip(), DRIP_TICK_MS);
    }
  }

  /** Tear down per-token state (canvasTearDown / scene switch). */
  dispose() {
    // pending hit timers die here: their callbacks would otherwise see the NEW store
    // (already on another scene) paired with old-scene token coordinates
    for (const tm of this._hitTimers) clearTimeout(tm);
    this._hitTimers.clear();
    // Stationary drip interval is DELIBERATELY left running: it lives at module
    // scope rather than scene scope and is fully self-gating (GM/enabled/store/
    // current scene tokens via getter). Previously dispose() killed it on EVERY
    // scene switch without re-arming — silently breaking drips until F5.
    this._lastPos.clear();
    this._lastDrip.clear();
    this._oldHp.clear();
    this._oldDeathFails.clear();
    this._lastHitDir.clear();
    this._lastDamageType.clear();
    this._lastSnowDmgAt.clear();
    this._processedRegionIds.clear();
    this._pendingAoETemplates.clear();
    this._trail.dispose();
    this._walls.dispose();
    this._tiles.dispose();
  }

  _onDeleteToken(doc) {
    // per-token maps must not outlive deleted tokens (unbounded growth in long sessions)
    this._lastHitDir.delete(doc.id);
    this._lastDamageType.delete(doc.id);
    this._lastSnowDmgAt.delete(doc.id);
    this._lastPos.delete(doc.id);
    this._lastDrip.delete(doc.id);
    this._trail.forget(doc.id);
    if (doc.actor) {
      this._oldHp.delete(doc.actor.uuid); // keyed by actor uuid
      this._oldDeathFails.delete(doc.actor.uuid);
    }
  }

  /* ------------------------------ damage and death ------------------------------ */

  /** Manual splat on a token (scene control button, API). */
  splat(token, { impact = 0.5, dead = false, dir = null } = {}) {
    if (!game.user.isGM || !bloodEnabled()) return;
    if (!token?.center) return;
    if (bloodDisabled(token)) return; // ghosts/constructs: per-token config flag
    this._spawnHit(token, Math.min(1, Math.max(0.05, impact)), dead, dir);
  }

  _onPreUpdateActor(actor) {
    if (!game.user.isGM || !bloodEnabled()) return;
    this._oldHp.set(actor.uuid, getHp(actor));
    // previous death save failure count: pool grows only when the counter INCREASES
    // (clearing a failure or resetting on stabilization must not add blood). Path comes
    // from the system table (dnd5e/sw5e attributes.death.failure, pf2e dying.value);
    // systems without this mechanic have an empty path so the counter is skipped
    const failPath = deathFailsPath();
    this._oldDeathFails.set(actor.uuid, (failPath && num(prop(actor?.system, failPath))) ?? 0);
  }

  _onUpdateActor(actor, updates = {}) {
    // pop cached HP BEFORE gates: an early gated exit must not leave stale
    // entries lingering until the actor's next update
    const old = this._oldHp.get(actor.uuid);
    this._oldHp.delete(actor.uuid);
    const oldFails = this._oldDeathFails.get(actor.uuid) ?? 0;
    this._oldDeathFails.delete(actor.uuid);
    if (!game.user.isGM) {
      // on player clients, local midi hooks write to _lastHitDir/_lastDamageType,
      // while only the GM path pops them — clean up on actor update so entries
      // do not accumulate (each client has its own map)
      if (this._lastHitDir.size || this._lastDamageType.size) {
        const t = resolveToken(actor);
        if (t) {
          this._lastHitDir.delete(t.id);
          this._lastDamageType.delete(t.id);
        }
      }
      return;
    }
    if (!bloodEnabled()) return;
    if (settingGet('bloodOnlyInCombat', false) && !game.combat?.started) return;
    if (old === undefined) return;

    const token = resolveToken(actor);
    if (!token?.center) return;

    const hp = getHp(actor), max = getHpMax(actor);
    if (hp === undefined || !max || max <= 0) return;

    const { wounds } = hpPaths();
    const threshold = settingGet('bloodThreshold', 50);
    const delta = wounds ? hp - old : old - hp; // >0 = got worse
    const dead = wounds ? hp >= max : hp <= 0;
    // unified pct: in HP systems it is health percentage; in wound systems (hp = wound count)
    // it is wound percentage. Previously `100*(max-hp)/max` computed HEALTH share for wounds,
    // inverting every threshold comparison
    const pct = (100 * hp) / max;
    const prevPct = (100 * old) / max;
    const wounded = wounds ? pct >= threshold : pct <= threshold;
    const prevWounded = wounds ? prevPct >= threshold : prevPct <= threshold;

    const dir = delta > 0 ? (this._popHitDirection(token.id) ?? this._combatantDirection(token)) : null;
    const dmgType = delta > 0 ? this._popDamageType(token.id) : null;
    if (delta > 0 && dmgType) {
      this._interactSnowOnDamage(token, dmgType, Math.min(1, Math.abs(delta) / max), dir);
    }

    if (bloodDisabled(token)) return; // ghosts/constructs never bleed at all

    // death saving throw failures (path from system table: dnd5e
    // attributes.death.failure, pf2e dying): a dying creature bleeds out —
    // the pool beneath it grows with each failure. Only on counter INCREASE (e.g. 2 → 3):
    // removing a failure via module or resetting on stabilization must not add blood.
    // Check `dead` (not hp<=0): for wound systems, death is hp >= max
    const failPath = deathFailsPath();
    // in `updates` the path is prefixed with `system.` (update diff object); in `actor.system` it is not
    const fails = failPath ? num(prop(updates, `system.${failPath}`)) : undefined;
    if (Number.isFinite(fails) && fails > oldFails && fails > 0 && dead && settingGet('bloodDeathPool', true)) {
      this._deathPoolGrowth(token, fails);
    }

    if (delta <= 0 || !wounded) return;

    let impact = Math.min(1, Math.abs(delta) / max);
    // CROSSING the bleeding threshold on this hit (was unbloodied → now bleeding)
    // gets a dramatic accent boost
    if (wounded && !prevWounded) impact = Math.max(impact, 0.5);
    const tm = setTimeout(() => {
      this._hitTimers.delete(tm);
      if (!bloodEnabled()) return;
      // the scene could have changed during the delay: the store would be NEW while
      // coordinates belong to the old scene's token; stains must not migrate across scenes
      const sid = token?.document?.scene?.id;
      if (!sid || sid !== canvas.scene?.id) return;
      this._spawnHit(token, impact, dead, dir, dmgType ?? null);
    }, HIT_DELAY_MS);
    this._hitTimers.add(tm);
  }

  /**
   * Snow reaction beneath a token based on damage character:
   *  - fire/radiant/acid melt snowbanks with steam;
   *  - thunder/force/bludgeoning kick up snow spray;
   *  - cold freezes a frost patch.
   */
  _interactSnowOnDamage(token, dmgType, impact = 0.5, dir = null) {
    if (!dmgType || !token?.center || token.document?.hidden) return;
    const store = this.getStore();
    if (!store) return;
    const tokId = token.id ?? token.document?.id;
    const now = Date.now();
    if (tokId) {
      const prevAt = this._lastSnowDmgAt.get(tokId) ?? 0;
      if (now - prevAt < 250) return;
      this._lastSnowDmgAt.set(tokId, now);
    }
    const doc = token.document;
    const tLevel = doc?.level ?? currentLevelId();
    const tsize = tsizeOf(doc);
    const cx = token.center.x, cy = token.center.y;
    const elev = elevOf(doc);
    const t = String(dmgType);
    if (MELT_DAMAGE_RE.test(t)) {
      meltSnowAt(store, cx, cy, tsize * (0.85 + impact * 0.65), 0.65 + impact * 0.5, { surface: elev, level: tLevel });
    } else if (BLAST_DAMAGE_RE.test(t)) {
      const blastDir = dir ? Math.atan2(cy - dir.y, cx - dir.x) : null;
      blastSnowAt(store, cx, cy, tsize * (0.8 + impact * 0.6), 0.55 + impact * 0.5, blastDir, elev, { level: tLevel });
    } else if (COLD_DAMAGE_RE.test(t)) {
      freezeSnowAt(store, cx, cy, tsize * (0.7 + impact * 0.45), elev, tLevel);
    }
  }

  /** Falling prone into snow: body imprint + flying snow clumps. */
  _onCreateActiveEffect(effect) {
    if (!game.user.isGM || !bloodEnabled() || !effect || effect.disabled) return;
    let isProne = PRONE_RE.test(effect.name ?? '');
    if (!isProne && effect.statuses?.size) {
      for (const s of effect.statuses) if (typeof s === 'string' && PRONE_RE.test(s)) { isProne = true; break; }
    }
    if (!isProne) return;
    const actor = effect.parent;
    const token = actor ? resolveToken(actor) : null;
    if (!token?.center || token.document?.hidden) return;
    if (token.document?.scene && token.document.scene.id !== canvas.scene?.id) return;
    const store = this.getStore();
    if (!store) return;
    const doc = token.document;
    blastSnowAt(store, token.center.x, token.center.y, tsizeOf(doc) * 0.85, 0.8, null, elevOf(doc), { proneImprint: true, level: doc?.level ?? currentLevelId() });
  }

  /** Apply an AoE spell effect (fire/thunder/cold) to a set of impact circles on the scene. */
  _applyAoESnowEffect(store, circles, dmgType, elev = null, levelId = null) {
    if (!store || !circles?.length || !dmgType) return 0;
    const targetLvl = levelId ?? currentLevelId();
    let affected = 0;
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (MELT_DAMAGE_RE.test(dmgType)) {
        // spawn steam only over the first circle so a wall-of-fire chain does not spawn 20 clouds
        affected += meltSnowAt(store, c.x, c.y, c.r, 0.9, { ...(elev !== null ? { surface: elev } : {}), level: targetLvl, spawnSteam: i === 0 });
      } else if (BLAST_DAMAGE_RE.test(dmgType)) {
        affected += blastSnowAt(store, c.x, c.y, c.r, 0.85, null, elev ?? 0, { level: targetLvl });
      } else if (COLD_DAMAGE_RE.test(dmgType)) {
        if (freezeSnowAt(store, c.x, c.y, c.r * 0.8, elev ?? 0, targetLvl)) affected++;
      }
    }
    return affected;
  }

  /**
   * Pre-creation of a spell template region in dnd5e 6.0.0 (`dnd5e.createMeasuredTemplate`):
   * runs on the caster's client BEFORE `RegionDocument.create()`, stamping the resolved
   * damage type onto `regionData.flags.showstopper.damageType` up front so the GM client is
   * guaranteed to see it in `createRegion` even when the item/activity lives in a locked compendium or sheet.
   */
  _onPreCreateActivityTemplate(activity, regionData) {
    if (!activity || !regionData || typeof regionData !== 'object') return;
    const dmgType = _resolveSpellDamageType(activity?.item ?? activity, activity);
    if (!dmgType) return;
    regionData.flags = regionData.flags ?? {};
    regionData.flags.showstopper = { ...(regionData.flags.showstopper ?? {}), damageType: String(dmgType) };
  }

  /**
   * Enqueue a placed AoE template (RegionDocument or MeasuredTemplateDocument) to await
   * its damage roll: snow inside the template area is NOT cleared during aiming/placement,
   * waiting instead for an actual damage roll (`dnd5e.rollDamageV2`, `midi-qol.DamageRollComplete`, `ChatMessage`).
   */
  _queueAoETemplate(doc, circles, elev, dmgType = null, activityOverride = null, levelId = null) {
    if (!doc || !circles?.length) return null;
    const flags = doc.flags ?? {};
    const docId = doc.id ?? doc._id ?? null;
    const docUuid = doc.uuid ?? null;
    const activityUuid = typeof flags?.dnd5e?.activity === 'string'
      ? flags.dnd5e.activity
      : (activityOverride?.uuid ?? flags?.dnd5e?.activity?.uuid ?? null);
    const itemUuid = typeof flags?.dnd5e?.item === 'string'
      ? flags.dnd5e.item
      : (flags?.['midi-qol']?.itemUuid ?? activityOverride?.item?.uuid ?? flags?.dnd5e?.item?.uuid ?? (activityUuid && activityUuid.includes('.Activity.') ? activityUuid.slice(0, activityUuid.indexOf('.Activity.')) : null));
    const originUuid = typeof flags?.dnd5e?.origin === 'string' ? flags.dnd5e.origin : null;
    const spellName = String(doc.name || activityOverride?.item?.name || activityOverride?.name || '').trim().toLowerCase();
    const key = docUuid || docId || `aoe-${++this._aoeSeq}`;
    const entry = {
      key,
      docId,
      docUuid,
      activityUuid,
      itemUuid,
      originUuid,
      spellName,
      circles,
      elev,
      levelId: levelId ?? _docLevelId(doc),
      dmgType,
      sceneId: doc.parent?.id ?? canvas?.scene?.id ?? null,
      at: Date.now()
    };
    this._pendingAoETemplates.set(key, entry);
    return entry;
  }

  /**
   * If a template/region is deleted BEFORE its damage roll (player cancelled the cast or repositioned the template),
   * evict it from the pending queue so the cancelled template will not melt snow later.
   */
  _onDeleteAoETemplate(doc) {
    if (!doc || !this._pendingAoETemplates.size) return;
    const docId = doc.id ?? doc._id ?? null;
    const docUuid = doc.uuid ?? null;
    for (const [k, entry] of this._pendingAoETemplates) {
      if ((docUuid && entry.docUuid === docUuid) || (docId && entry.docId === docId)) {
        this._pendingAoETemplates.delete(k);
      }
    }
  }

  /**
   * Spell area of effect (fireball, cone, wall of fire). In Foundry VTT v14 + dnd5e 6.0.0,
   * AoEs are placed as RegionDocuments (carrying `flags.dnd5e` / `flags.core.MeasuredTemplate` /
   * `flags['midi-qol']`). When the region is created, its geometry and 3D elevation range are
   * recorded in `_pendingAoETemplates`, while actual snow melting/blasting/freezing runs ONLY after the damage roll.
   */
  _onCreateRegion(region, activityOverride = null, { immediate = false } = {}) {
    if (!game.user.isGM || !bloodEnabled() || !region) return;
    if (region.parent && region.parent.id !== canvas.scene?.id) return;
    const regId = region.id ?? region._id;
    if (regId && !immediate) {
      if (this._processedRegionIds.has(regId)) return;
      this._processedRegionIds.add(regId);
    }
    const store = this.getStore();
    if (!store) return;
    const flags = region.flags ?? {};
    // Regions hosting our own behaviors (snow/blood zones) are not spells
    const behaviors = region.behaviors ? (typeof region.behaviors.values === 'function' ? [...region.behaviors.values()] : (Array.isArray(region.behaviors) ? region.behaviors : [])) : [];
    const isShowstopperZone = behaviors.some(b => !b?.disabled && String(b?.type ?? '').startsWith('showstopper.'));
    if (isShowstopperZone && !flags?.showstopper?.damageType) return;

    const nameHasAoEDamage = Boolean(
      region.name && (MELT_DAMAGE_RE.test(region.name) || BLAST_DAMAGE_RE.test(region.name) || COLD_DAMAGE_RE.test(region.name))
    );
    // In dnd5e 6.0.0, AoE regions carry `flags.dnd5e` (`activity`, `item`, `origin`, `spellLevel`),
    // and may also carry `flags.core.MeasuredTemplate`, `flags['midi-qol']`, or `flags.showstopper.damageType`
    const isSpell = Boolean(
      activityOverride
      || flags?.showstopper?.damageType
      || flags?.core?.MeasuredTemplate
      || flags?.['midi-qol']?.activityTemplate
      || flags?.['midi-qol']?.itemUuid
      || flags?.dnd5e?.activity
      || flags?.dnd5e?.item
      || flags?.dnd5e?.origin
      || flags?.dnd5e?.spellLevel !== undefined
      || nameHasAoEDamage
    );
    if (!isSpell) return;
    const circles = regionSnowCircles(region.shapes);
    if (!circles.length) return;

    const dmgType = _resolveSpellDamageType(region, activityOverride);

    // In Foundry v14, RegionDocument.elevation has the shape `{ bottom, top }` (defaulting to `{ bottom: null, top: null }`).
    // Caution: `Number(null) === 0` in JS! Also, midi-qol assigns a 3D interval like `{ bottom: -20, top: 20 }` for
    // spherical templates (Fireball, r=20 ft), or `{ bottom: 10, top: 50 }` for a caster flying at 30 ft.
    // Pass the full vertical `{ bottom, top }` range clamped to include the ground/surface level beneath the template center,
    // or `null` when elevation bounds are unspecified (unbounded).
    const regLvl = _docLevelId(region);
    const rawB = region.elevation?.bottom;
    const rawT = region.elevation?.top;
    const hasB = rawB !== null && rawB !== undefined && rawB !== '' && Number.isFinite(Number(rawB));
    const hasT = rawT !== null && rawT !== undefined && rawT !== '' && Number.isFinite(Number(rawT));
    let elev: any = null;
    if (hasB || hasT) {
      const surfE = surfaceAt(circles[0].x, circles[0].y, Number.POSITIVE_INFINITY, regLvl).e;
      const bVal = hasB ? Number(rawB) : Number.NEGATIVE_INFINITY;
      const tVal = hasT ? Number(rawT) : Number.POSITIVE_INFINITY;
      elev = {
        bottom: hasB ? Math.min(bVal, surfE) : null,
        top: hasT ? Math.max(tVal, surfE) : null
      };
    }
    if (immediate) {
      if (dmgType) this._applyAoESnowEffect(store, circles, dmgType, elev, regLvl);
      return;
    }
    this._queueAoETemplate(region, circles, elev, dmgType, activityOverride, regLvl);
  }

  /**
   * Classic spell area template (MeasuredTemplateDocument in Foundry VTT v14 / dnd5e 6.0.0):
   * converts distance into scene pixels and queues the template to await its damage roll.
   */
  _onCreateMeasuredTemplate(template, { immediate = false } = {}) {
    if (!game.user.isGM || !bloodEnabled() || !template) return;
    if (template.parent && template.parent.id !== canvas.scene?.id) return;
    const store = this.getStore();
    if (!store) return;
    const dmgType = _resolveSpellDamageType(template);

    const gridSize = Number(canvas?.grid?.size) || 100;
    const gridDist = Number(canvas?.scene?.grid?.distance) || Number(canvas?.grid?.distance) || 5;
    const pxPerUnit = gridSize / Math.max(0.01, gridDist);
    const rawR = Number(template.radius) || ((Number(template.distance) || 0) * pxPerUnit);
    if (!(rawR > 0)) return;

    const tx = Number(template.x) || 0;
    const ty = Number(template.y) || 0;
    const tType = String(template.t || template.type || 'circle').toLowerCase();
    let circles = [];
    if (tType === 'cone') {
      circles = regionSnowCircles([{
        type: 'cone',
        x: tx,
        y: ty,
        radius: rawR,
        angle: Number(template.angle) || 53.13,
        rotation: Number(template.direction) || 0
      }]);
    } else if (tType === 'ray' || tType === 'line') {
      const widthPx = ((Number(template.width) || gridDist) * pxPerUnit);
      const dirRad = (Number(template.direction) || 0) * (Math.PI / 180);
      const n = Math.min(24, Math.max(2, Math.round(rawR / Math.max(1, widthPx))));
      const r = Math.max(48, widthPx * 0.65);
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        circles.push({ x: tx + Math.cos(dirRad) * rawR * f, y: ty + Math.sin(dirRad) * rawR * f, r });
      }
    } else if (tType === 'rect' || tType === 'rectangle') {
      const dirRad = (Number(template.direction) || 0) * (Math.PI / 180);
      const dx = Math.cos(dirRad) * rawR;
      const dy = Math.sin(dirRad) * rawR;
      circles.push({ x: tx + dx / 2, y: ty + dy / 2, r: Math.hypot(dx, dy) / 2 });
    } else {
      circles.push({ x: tx, y: ty, r: rawR });
    }

    const tmplLvl = _docLevelId(template);
    const rawElev = template.elevation;
    const hasElev = rawElev !== null && rawElev !== undefined && rawElev !== '' && Number.isFinite(Number(rawElev));
    let elev: any = null;
    if (hasElev) {
      const eNum = Number(rawElev);
      const surfE = surfaceAt(tx, ty, Number.POSITIVE_INFINITY, tmplLvl).e;
      elev = { bottom: Math.min(eNum, surfE), top: Math.max(eNum, surfE) };
    }
    if (immediate) {
      if (dmgType) this._applyAoESnowEffect(store, circles, dmgType, elev, tmplLvl);
      return;
    }
    this._queueAoETemplate(template, circles, elev, dmgType, null, tmplLvl);
  }

  /**
   * Activity/spell usage in dnd5e 6.0.0 (`dnd5e.postUseActivity`):
   *  - registers created AoE templates/regions in the pending damage-roll queue;
   *  - records damage type on targeted tokens (`game.user.targets`), WITHOUT clearing snow prior to the damage roll.
   */
  _onPostUseActivity(activity, usageConfig: any = {}, results: any = {}) {
    if (!game.user.isGM || !bloodEnabled() || !activity) return;
    const dmgType = _resolveSpellDamageType(activity?.item ?? activity, activity);

    const templates = Array.isArray(results?.templates) ? results.templates : [];
    for (const tmpl of templates) {
      const doc = tmpl?.document ?? tmpl;
      if (!doc) continue;
      if (doc.shapes) this._onCreateRegion(doc, activity);
      else if (doc.distance || doc.t) this._onCreateMeasuredTemplate(doc);
    }

    if (!dmgType) return;
    const targets = game?.user?.targets ? [...game.user.targets] : [];
    for (const tok of targets) {
      if (!tok?.center) continue;
      if (tok.id) this._lastDamageType.set(tok.id, { type: String(dmgType), at: Date.now() });
    }
  }

  /**
   * Damage roll completion hook in dnd5e 6.0.0 (`dnd5e.rollDamageV2` / `dnd5e.rollDamage`).
   */
  _onRollDamage(rolls, data: any = {}) {
    if (!game.user?.isGM || !bloodEnabled()) return;
    if (rolls && typeof rolls === 'object') {
      if (this._seenDamageRollArrays.has(rolls)) return;
      this._seenDamageRollArrays.add(rolls);
    }
    const rollList = Array.isArray(rolls) ? rolls : (rolls ? [rolls] : []);
    if (!rollList.length) return;
    const subject = data?.subject ?? null;
    this._onDamageRolled({
      rolls: rollList,
      activity: subject,
      item: subject?.item ?? null
    });
  }

  /**
   * Damage roll completion hook in midi-qol (`midi-qol.DamageRollComplete`).
   */
  _onMidiDamageRollComplete(workflow) {
    if (!game.user?.isGM || !bloodEnabled() || !workflow) return;
    const templateUuids = Array.isArray(workflow.templateUuids) && workflow.templateUuids.length
      ? [...workflow.templateUuids]
      : (workflow.templateUuid ? [workflow.templateUuid] : []);
    const damages = [
      ...(Array.isArray(workflow.damageDetail) ? workflow.damageDetail : []),
      ...(Array.isArray(workflow.rawDamageDetail) ? workflow.rawDamageDetail : []),
      ...(Array.isArray(workflow.otherDamageDetail) ? workflow.otherDamageDetail : []),
      ...(Array.isArray(workflow.rawOtherDamageDetail) ? workflow.rawOtherDamageDetail : []),
      ...(Array.isArray(workflow.bonusDamageDetail) ? workflow.bonusDamageDetail : []),
      ...(Array.isArray(workflow.rawBonusDamageDetail) ? workflow.rawBonusDamageDetail : [])
    ];
    const rolls = Array.isArray(workflow.damageRolls)
      ? workflow.damageRolls
      : (workflow.damageRoll ? [workflow.damageRoll] : []);
    const targets = workflow.hitTargets?.size
      ? [...workflow.hitTargets]
      : (workflow.targets?.size ? [...workflow.targets] : null);
    this._onDamageRolled({
      rolls,
      damages,
      activity: workflow.activity ?? null,
      item: workflow.item ?? null,
      activityUuid: workflow.activity?.uuid ?? null,
      itemUuid: workflow.item?.uuid ?? workflow.itemUuid ?? null,
      templateUuids,
      targets
    });
  }

  /**
   * Intercept ChatMessage creation carrying a damage roll (crucial when a player rolls damage
   * while snow clearing runs on the GM client). Triggers ONLY on `damage` messages.
   */
  _onCreateChatMessage(message) {
    if (!game.user?.isGM || !bloodEnabled() || !message) return;
    const flags = message.flags ?? {};
    const midiFlags = flags['midi-qol'] ?? {};
    const isDnd5eDamageMsg = message.type === 'damage' || flags?.dnd5e?.roll?.type === 'damage';
    const isMidiDamageMsg = midiFlags?.type === 3
      || (Array.isArray(midiFlags?.damageDetail) && midiFlags.damageDetail.length > 0);
    if (!isDnd5eDamageMsg && !isMidiDamageMsg) return;

    const sys = message.system ?? {};
    const activityUuid = sys.activity?.uuid
      ?? (typeof flags?.dnd5e?.activity === 'string' ? flags.dnd5e.activity : flags?.dnd5e?.activity?.uuid)
      ?? midiFlags?.activityUuid
      ?? null;
    const itemUuid = sys.item?.uuid
      ?? (typeof flags?.dnd5e?.item === 'string' ? flags.dnd5e.item : flags?.dnd5e?.item?.uuid)
      ?? midiFlags?.itemUuid
      ?? null;
    const templateUuids = Array.isArray(midiFlags?.templateUuids) && midiFlags.templateUuids.length
      ? [...midiFlags.templateUuids]
      : (midiFlags?.templateUuid ? [midiFlags.templateUuid] : []);
    const damages = [
      ...(Array.isArray(midiFlags?.damageDetail) ? midiFlags.damageDetail : []),
      ...(Array.isArray(midiFlags?.otherDamageDetail) ? midiFlags.otherDamageDetail : []),
      ...(Array.isArray(midiFlags?.bonusDamageDetail) ? midiFlags.bonusDamageDetail : [])
    ];
    this._onDamageRolled({
      rolls: Array.isArray(message.rolls) ? message.rolls : [],
      damages,
      activityUuid,
      itemUuid,
      templateUuids,
      spellName: sys.item?.name ?? message.flavor ?? null
    });
  }

  /**
   * Intercept ChatMessage updates when midi-qol appends damage roll results
   * (`displayDamageRolls` → `flags['midi-qol'].type = 3`, `damageDetail`, `system.midi.damageRollCount`).
   */
  _onUpdateChatMessage(message, changes: any = {}) {
    if (!game.user?.isGM || !bloodEnabled() || !message || !changes) return;
    const chMidi = changes?.flags?.['midi-qol'];
    const chSysMidi = changes?.system?.midi;
    const hasDamageUpdate = Boolean(
      chMidi?.type === 3
      || (Array.isArray(chMidi?.damageDetail) && chMidi.damageDetail.length > 0)
      || (Array.isArray(chMidi?.otherDamageDetail) && chMidi.otherDamageDetail.length > 0)
      || (Number(chSysMidi?.damageRollCount) > 0)
      || chSysMidi?.sections?.damage
      || chSysMidi?.sections?.otherDamage
    );
    if (!hasDamageUpdate) return;

    const flags = message.flags ?? {};
    const midiFlags = { ...(flags['midi-qol'] ?? {}), ...(chMidi ?? {}) };
    const sys = message.system ?? {};
    const activityUuid = sys.activity?.uuid
      ?? (typeof flags?.dnd5e?.activity === 'string' ? flags.dnd5e.activity : flags?.dnd5e?.activity?.uuid)
      ?? midiFlags?.activityUuid
      ?? null;
    const itemUuid = sys.item?.uuid
      ?? (typeof flags?.dnd5e?.item === 'string' ? flags.dnd5e.item : flags?.dnd5e?.item?.uuid)
      ?? midiFlags?.itemUuid
      ?? null;
    const templateUuids = Array.isArray(midiFlags?.templateUuids) && midiFlags.templateUuids.length
      ? [...midiFlags.templateUuids]
      : (midiFlags?.templateUuid ? [midiFlags.templateUuid] : []);
    const damages = [
      ...(Array.isArray(midiFlags?.damageDetail) ? midiFlags.damageDetail : []),
      ...(Array.isArray(midiFlags?.otherDamageDetail) ? midiFlags.otherDamageDetail : []),
      ...(Array.isArray(midiFlags?.bonusDamageDetail) ? midiFlags.bonusDamageDetail : [])
    ];
    this._onDamageRolled({
      rolls: Array.isArray(changes.rolls) ? changes.rolls : (Array.isArray(message.rolls) ? message.rolls : []),
      damages,
      activityUuid,
      itemUuid,
      templateUuids,
      spellName: sys.item?.name ?? message.flavor ?? null
    });
  }

  /**
   * Central handler for completed damage rolls:
   *  1) finds all pending AoE templates (`_pendingAoETemplates`) matching this activity/item/template,
   *     dequeues them, and applies snow melting/blasting/freezing;
   *  2) if no pending templates exist, checks whether the scene still has an active AoE region for the same spell
   *     (e.g. recurring Wall of Fire damage on a subsequent turn) and applies the effect there;
   *  3) if the spell is single-target (no AoE template), applies the effect to the targeted tokens.
   */
  _onDamageRolled({
    rolls = null,
    damages = null,
    activity = null,
    item = null,
    activityUuid = null,
    itemUuid = null,
    originUuid = null,
    templateUuids = null,
    spellName = null,
    targets = null
  }: any = {}) {
    if (!game.user?.isGM || !bloodEnabled()) return 0;
    const store = this.getStore();
    if (!store) return 0;

    const actUuid = activityUuid ?? activity?.uuid ?? null;
    const itmUuid = itemUuid
      ?? item?.uuid
      ?? activity?.item?.uuid
      ?? (actUuid && actUuid.includes('.Activity.') ? actUuid.slice(0, actUuid.indexOf('.Activity.')) : null);
    const origUuid = originUuid ?? actUuid ?? itmUuid ?? null;
    const nameNorm = String(spellName || item?.name || activity?.item?.name || activity?.name || '').trim().toLowerCase();
    const tmplSet = new Set(Array.isArray(templateUuids) ? templateUuids.filter(Boolean) : []);

    const rollDmgType = _extractDamageTypeFromRolls(rolls)
      ?? _extractDamageTypeFromList(damages)
      ?? _resolveSpellDamageType(item ?? activity, activity)
      ?? (nameNorm ? _resolveSpellDamageType({ name: nameNorm }) : null);

    const now = Date.now();
    const curSceneId = canvas?.scene?.id ?? null;
    for (const [k, e] of this._pendingAoETemplates) {
      if (now - e.at > 600000) this._pendingAoETemplates.delete(k);
    }

    const matched = [];
    for (const e of this._pendingAoETemplates.values()) {
      if (e.sceneId && curSceneId && e.sceneId !== curSceneId) continue;
      let isMatch = false;
      if (tmplSet.size > 0) {
        if (e.docUuid && tmplSet.has(e.docUuid)) isMatch = true;
        else if (e.docId && [...tmplSet].some(u => u === e.docId || String(u).endsWith(`.${e.docId}`))) isMatch = true;
      }
      if (!isMatch && actUuid && (e.activityUuid === actUuid || e.originUuid === actUuid)) isMatch = true;
      if (!isMatch && itmUuid && (e.itemUuid === itmUuid || e.originUuid === itmUuid || (e.activityUuid && e.activityUuid.startsWith(`${itmUuid}.`)))) isMatch = true;
      if (!isMatch && origUuid && (e.originUuid === origUuid || e.activityUuid === origUuid || e.itemUuid === origUuid)) isMatch = true;
      if (!isMatch && nameNorm && e.spellName && (e.spellName === nameNorm || nameNorm.includes(e.spellName) || e.spellName.includes(nameNorm))) isMatch = true;
      if (isMatch) matched.push(e);
    }

    // If the damage roll carries no UUIDs (or a freshly placed template lacked an item UUID binding),
    // match fresh pending templates on the current scene
    if (!matched.length && this._pendingAoETemplates.size > 0) {
      for (const e of this._pendingAoETemplates.values()) {
        if (e.sceneId && curSceneId && e.sceneId !== curSceneId) continue;
        if (now - e.at > 120000) continue;
        const noRollIds = !actUuid && !itmUuid && !tmplSet.size && !nameNorm;
        const noEntryIds = !e.activityUuid && !e.itemUuid && !e.originUuid;
        if (noRollIds || noEntryIds) {
          if (!rollDmgType || !e.dmgType || e.dmgType === rollDmgType
            || (MELT_DAMAGE_RE.test(rollDmgType) && MELT_DAMAGE_RE.test(e.dmgType))
            || (BLAST_DAMAGE_RE.test(rollDmgType) && BLAST_DAMAGE_RE.test(e.dmgType))
            || (COLD_DAMAGE_RE.test(rollDmgType) && COLD_DAMAGE_RE.test(e.dmgType))) {
            matched.push(e);
          }
        }
      }
    }

    let affected = 0;
    let handledAoE = false;
    for (const e of matched) {
      this._pendingAoETemplates.delete(e.key);
      const finalDmg = rollDmgType ?? e.dmgType;
      if (finalDmg) {
        handledAoE = true;
        affected += this._applyAoESnowEffect(store, e.circles, finalDmg, e.elev, e.levelId ?? null);
      }
    }

    // If no pending templates remain, check whether the scene still has an active region for this spell (e.g. Wall of Fire)
    if (!handledAoE && (tmplSet.size > 0 || actUuid || itmUuid)) {
      const sceneRegions = canvas?.scene?.regions;
      const regList = sceneRegions
        ? (typeof sceneRegions.values === 'function' ? [...sceneRegions.values()] : (Array.isArray(sceneRegions) ? sceneRegions : []))
        : [];
      for (const reg of regList) {
        if (!reg) continue;
        const rf = reg.flags ?? {};
        const rAct = typeof rf?.dnd5e?.activity === 'string' ? rf.dnd5e.activity : rf?.dnd5e?.activity?.uuid;
        const rItm = typeof rf?.dnd5e?.item === 'string' ? rf.dnd5e.item : (rf?.['midi-qol']?.itemUuid ?? rf?.dnd5e?.item?.uuid);
        const rOrig = typeof rf?.dnd5e?.origin === 'string' ? rf.dnd5e.origin : null;
        const hit = (reg.uuid && tmplSet.has(reg.uuid))
          || (reg.id && [...tmplSet].some(u => u === reg.id || String(u).endsWith(`.${reg.id}`)))
          || (actUuid && (rAct === actUuid || rOrig === actUuid))
          || (itmUuid && (rItm === itmUuid || rOrig === itmUuid || (rAct && String(rAct).startsWith(`${itmUuid}.`))));
        if (!hit) continue;
        const circles = regionSnowCircles(reg.shapes);
        const finalDmg = rollDmgType ?? _resolveSpellDamageType(reg, activity);
        if (circles.length && finalDmg) {
          handledAoE = true;
          const regLvl = _docLevelId(reg);
          const rawB = reg.elevation?.bottom;
          const rawT = reg.elevation?.top;
          const hasB = rawB !== null && rawB !== undefined && rawB !== '' && Number.isFinite(Number(rawB));
          const hasT = rawT !== null && rawT !== undefined && rawT !== '' && Number.isFinite(Number(rawT));
          let elev: any = null;
          if (hasB || hasT) {
            const surfE = surfaceAt(circles[0].x, circles[0].y, Number.POSITIVE_INFINITY, regLvl).e;
            elev = {
              bottom: hasB ? Math.min(Number(rawB), surfE) : null,
              top: hasT ? Math.max(Number(rawT), surfE) : null
            };
          }
          affected += this._applyAoESnowEffect(store, circles, finalDmg, elev, regLvl);
        }
      }
    }

    // If the spell has no AoE template (single-target), interact with snow beneath the targets after the damage roll
    if (!handledAoE && rollDmgType && (MELT_DAMAGE_RE.test(rollDmgType) || BLAST_DAMAGE_RE.test(rollDmgType) || COLD_DAMAGE_RE.test(rollDmgType))) {
      const targetList = Array.isArray(targets) && targets.length
        ? targets
        : (game?.user?.targets ? [...game.user.targets] : []);
      for (const tok of targetList) {
        if (!tok?.center) continue;
        if (tok.id) this._lastDamageType.set(tok.id, { type: String(rollDmgType), at: Date.now() });
        this._interactSnowOnDamage(tok, rollDmgType, 0.65);
      }
    }

    return affected;
  }

  /** Pool grows beneath a dying creature (failed death saving throw). */
  _deathPoolGrowth(token, fails) {
    const store = this.getStore();
    if (!store || !token?.center) return;
    // stealth gate: a hidden dying creature must not give away its position via a pool
    // (trails/drips already had this gate, whereas this path was missing it)
    if (token.document?.hidden) return;
    const doc = token.document;
    const tLevel = doc?.level ?? currentLevelId();
    const zoneMode = bloodZoneModeAt(token.center.x, token.center.y, tLevel);
    if (zoneMode === 'none') return; // no-blood zone
    const zoneNw = zoneMode === 'tracked' ? { nw: 1 } : {};
    const tsize = tsizeOf(doc);
    const surf = surfaceAt(token.center.x, token.center.y, elevOf(doc), tLevel);
    const activeLvl = surf.lvl ?? tLevel;
    const tintedSnow = new Map();
    const rawHex = hexOf(token);
    const absorbed = absorbBloodIntoSnow(store, token.center.x, token.center.y, tsize * 0.7, surf.e, rawHex, tintedSnow, activeLvl);
    const poolS = tsize * (0.55 + Math.min(3, fails) * 0.18) * (absorbed ? absorbed.sizeK : 1);
    if (tintedSnow.size) trampleSnowStains(store, tintedSnow);
    const st = store.add([store.createStain({
      t: STAIN.POOL,
      x: token.center.x, y: token.center.y,
      s: poolS,
      r: Math.random() * Math.PI * 2,
      a: 0.9,
      c: absorbed ? absorbed.color : rawHex,
      d: 500,
      f: 450,
      g: 1,
      T: worldTime(),
      ...zoneNw,
      w: wallProfile(token.center, poolS * 1.3, activeLvl), // canonical radius matching wall revalidation
      ...(surf.tid ? { e: surf.e, tid: surf.tid } : { e: surf.e }),
      ...(activeLvl ? { lvl: activeLvl } : {})
    })]);
    // push auto-blood onto the brush undo stack: CTRL+Z on a layer without native undo
    // history removes the pool (in combat, native history is usually non-empty so undo
    // bypasses us — a deliberate scope limit of this feature)
    if (st.length) pushBloodOp('remove', st);
  }

  _spawnHit(token, impact, dead, dir, explicitDmgType = undefined) {
    const store = this.getStore();
    if (!store) return;
    // stealth gate: hitting an invisible creature must not reveal its exact coordinates
    // and nature (blood color = creature type) via splats and bursts —
    // trails/drips already had this gate, whereas this path was missing it
    if (token.document?.hidden) return;
    const doc = token.document;
    const tLevel = doc?.level ?? currentLevelId();
    const tsize = tsizeOf(doc);
    // zone: none suppresses generation; tracked marks stains rain-proof (nw)
    const zoneMode = bloodZoneModeAt(token.center.x, token.center.y, tLevel);
    if (zoneMode === 'none') return;
    const zoneNw = zoneMode === 'tracked' ? { nw: 1 } : {};
    // damage type → blood character (cauterization/necrosis/frostbite): type comes
    // from midi workflow while fresh (same TTL as hit direction), otherwise falls back
    // to the neutral profile so stale "fire" never sticks to a token forever
    const dmgType = explicitDmgType !== undefined ? explicitDmgType : this._popDamageType(token.id);
    if (explicitDmgType === undefined && dmgType) {
      this._interactSnowOnDamage(token, dmgType, impact, dir);
    }
    const profile = settingGet('bloodDamageProfiles', true) ? _damageProfile(dmgType) : PROFILE_DEFAULT;
    const rawHex = _bloodHex(token, profile);

    // tone preset: grimdark is gorier, family is more restrained
    const tone = _tonePreset();
    const violence = Math.max(1, Math.min(10, settingGet('bloodViolence', 3) + tone.violenceK));
    const scale = settingGet('bloodScale', 1);
    const cx = token.center.x, cy = token.center.y;
    // blood lands on the surface BENEATH the token: onto a tile below its elevation
    // (sticking to that elevation's layer), or onto the floor if no tile is present
    const surf = surfaceAt(cx, cy, elevOf(doc), tLevel);
    const surface = surf.e;
    const activeLvl = surf.lvl ?? tLevel;
    const lvlProp = activeLvl ? { lvl: activeLvl } : {};
    const tid = surf.tid ? { tid: surf.tid } : {};
    const tintedSnow = new Map();
    const absorbed = absorbBloodIntoSnow(store, cx, cy, tsize * 0.65, surface, rawHex, tintedSnow, activeLvl);
    const hex = absorbed ? absorbed.color : rawHex;
    const snowSizeK = absorbed ? absorbed.sizeK : 1;
    const baseSize = tsize * (0.5 + impact * 0.8) * scale * profile.vol * snowSizeK;
    // a cauterized body barely splatters: cap splat count tightly
    const splatsCap = profile.vol < 0.6 ? 2 : 99;

    const stains = [];
    const scatter = tsize * 0.22;
    const splats = Math.min(splatsCap, 1 + Math.round((violence / 3) * (0.5 + impact)) + (dead ? 1 : 0));
    // all splats of a single hit share ONE wall profile (center + radius) —
    // the move polygon is built once instead of 2–5 times per hit (each build runs a
    // full scene wall polygon computation costing milliseconds on wall-heavy maps)
    const wSplat = wallProfile(token.center, baseSize * 1.4, activeLvl);
    // spawn schedule: synchronized with particle burst flight
    let d = 200 + Math.random() * 120;
    const wt = worldTime();
    for (let i = 0; i < splats; i++) {
      stains.push(store.createStain({
        t: STAIN.SPLAT,
        x: cx + (Math.random() - 0.5) * 2 * scatter,
        y: cy + (Math.random() - 0.5) * 2 * scatter,
        s: baseSize * (0.7 + Math.random() * 0.55),
        r: Math.random() * TAU,
        a: Math.min(0.95, 0.7 + impact * 0.25),
        c: hex,
        d: Math.round(d),
        f: 120,
        T: wt,
        ...zoneNw,
        e: surface,
        ...tid,
        ...lvlProp,
        w: wSplat
      }));
      d += 60 + Math.random() * 140;
    }

    if (dir) {
      stains.push(store.createStain({
        t: STAIN.SPLASH,
        x: cx, y: cy,
        s: baseSize * 1.5,
        r: Math.atan2(cy - dir.y, cx - dir.x),
        a: 0.9,
        c: hex,
        d: Math.round(300 + Math.random() * 120),
        f: 150,
        T: wt,
        ...zoneNw,
        e: surface,
        ...tid,
        ...lvlProp,
        w: wallProfile(token.center, baseSize * 1.9, activeLvl)
      }));
      // back-splatter: spray rebounds toward the attacker — a small cone facing them
      // right AT THE VICTIM (fixed offset from the body rather than attack distance,
      // otherwise a sniper 20 squares away would paint empty space behind the corpse)
      if (settingGet('bloodBackSplash', true)) {
        const ddx = dir.x - cx, ddy = dir.y - cy;
        const dl = Math.hypot(ddx, ddy) || 1;
        stains.push(store.createStain({
          t: STAIN.SPLASH,
          x: cx + (ddx / dl) * tsize * 0.18,
          y: cy + (ddy / dl) * tsize * 0.18,
          s: baseSize * 0.7,
          r: Math.atan2(ddy, ddx), // toward the attacker
          a: 0.72,
          c: hex,
          d: Math.round(160 + Math.random() * 100),
          f: 120,
          T: wt,
          ...zoneNw,
          e: surface,
          ...tid,
          ...lvlProp,
          w: wallProfile(token.center, baseSize * 1.1, activeLvl)
        }));
      }
      // cast-off: droplet chain along the weapon SWING arc on a killing blow —
      // tracing the strike trajectory, not just the point of impact
      if (dead && settingGet('bloodCastOff', true) && profile.vol >= 0.6) {
        const swingBase = Math.atan2(cy - dir.y, cx - dir.x) + Math.PI / 2;
        const arcN = 3 + Math.round(Math.random() * 2);
        for (let i = 0; i < arcN; i++) {
          const a = swingBase + (i / arcN) * Math.PI * (Math.random() < 0.5 ? 1 : -1);
          const dist = tsize * (0.75 + Math.random() * 0.5);
          stains.push(store.createStain({
            t: STAIN.DROPLETS,
            x: cx + Math.cos(a) * dist,
            y: cy + Math.sin(a) * dist,
            s: baseSize * (0.22 + Math.random() * 0.14),
            r: a,
            a: 0.7,
            c: hex,
            d: Math.round(340 + i * 60 + Math.random() * 90),
            f: 120,
            T: wt,
            ...zoneNw,
            e: surface,
            ...tid,
            ...lvlProp
          }));
        }
      }
    }

    if (violence >= (tone.dropletGate ?? 6) && !dead) {
      const dropS = baseSize * 0.7;
      stains.push(store.createStain({
        t: STAIN.DROPLETS,
        x: cx + (Math.random() - 0.5) * scatter,
        y: cy + (Math.random() - 0.5) * scatter,
        s: dropS,
        r: Math.random() * TAU,
        a: 0.8,
        c: hex,
        d: Math.round(380 + Math.random() * 250),
        f: 120,
        T: wt,
        ...zoneNw,
        e: surface,
        ...tid,
        ...lvlProp,
        w: wallProfile(token.center, dropS * 1.3, activeLvl) // droplets also respect walls
      }));
    }

    if (dead && settingGet('bloodDeathPool', true)) {
      const poolS = tsize * (1.25 + Math.random() * 0.5) * scale * (profile.vol >= 1 ? 1 : 0.7);
      stains.push(store.createStain({
        t: STAIN.POOL,
        x: cx, y: cy,
        s: poolS,
        r: Math.random() * TAU,
        a: 0.95,
        c: hex,
        d: Math.round(420 + Math.random() * 220),
        f: 550,
        g: 1,
        T: wt,
        ...zoneNw,
        e: surface,
        ...tid,
        ...lvlProp,
        w: wallProfile(token.center, poolS * 1.3, activeLvl)
      }));
    }

    // wall drips: spray rays probe for the nearest wall — placing a vertical DRIP
    // right on the wall line (top-down walls are lines, so blood ON a wall renders directly along it)
    if (settingGet('bloodWallDrips', true) && profile.vol >= 0.6 && (violence >= 4 || dead)) {
      this._wallDrips(store, stains, token, { cx, cy, baseSize, dir, dead, hex, wt, zoneNw, levelId: activeLvl });
    }

    // cosmetic spray burst — played locally on each client; density scales with
    // both violence and hit impact (previously scaled only with violence)
    if (settingGet('bloodParticles', true)) {
      playBurst({
        sceneId: store.sceneId,
        x: cx, y: cy,
        dir: dir ? Math.atan2(cy - dir.y, cx - dir.x) : null,
        color: hex,
        size: baseSize,
        count: Math.round((36 + violence * 9) * (0.55 + impact * 0.9) * profile.burst),
        seed: mintSeed(),
        elevation: surface,
        level: activeLvl
      });
    }

    if (tintedSnow.size) trampleSnowStains(store, tintedSnow);
    store.add(stains);
    // push auto-blood onto the undo stack (see _deathPoolGrowth — same scope limit)
    if (stains.length) pushBloodOp('remove', stains);
    // corpse imprint: opt-in silhouette tile decal beneath the slain token (GM side)
    if (dead) maybeCorpseImprint(token);
  }

  /**
   * Wall drips: up to 3 rays from the impact center (toward the attacker / along a cone)
   * probe for the nearest wall; at each hit point a DRIP is minted — an elongated
   * vertical streak (local +Y points down, r=0).
   */
  _wallDrips(store, out, token, { cx, cy, baseSize, dir, dead, hex, wt, zoneNw = {}, levelId = null }: any) {
    const targetLvl = levelId ?? token?.document?.level ?? currentLevelId();
    const maxD = baseSize * 2.4;
    const angles = [];
    if (dir) {
      const back = Math.atan2(dir.y - cy, dir.x - cx); // spray flies TOWARD the attacker
      angles.push(back, back + 0.6, back - 0.6);
    } else {
      for (let i = 0; i < 3; i++) angles.push(Math.random() * TAU);
    }
    let minted = 0;
    for (const a of angles) {
      if (minted >= (dead ? 3 : 2)) break;
      const hit = wallRayHit(cx, cy, a, maxD, targetLvl);
      if (!hit) continue;
      // drip starts slightly in front of the wall (2-3 px toward the victim) and runs DOWNWARD
      const surf2 = surfaceAt(hit.x, hit.y, elevOf(token.document), targetLvl);
      const activeLvl = surf2.lvl ?? targetLvl;
      out.push(store.createStain({
        t: STAIN.DRIP,
        x: hit.x - Math.cos(a) * 3,
        y: hit.y - Math.sin(a) * 3 + baseSize * 0.06,
        s: Math.max(40, baseSize * (0.5 + Math.random() * 0.3)),
        r: 0, // local +Y = down: gravity
        a: 0.85,
        c: hex,
        d: Math.round(420 + minted * 120 + Math.random() * 140),
        f: 200,
        T: wt,
        ...zoneNw,
        e: surf2.e,
        ...(surf2.tid ? { tid: surf2.tid } : {}),
        ...(activeLvl ? { lvl: activeLvl } : {})
      }));
      minted++;
    }
  }

  /* ------------------------------ movement ------------------------------ */

  _onPreUpdateToken(doc, changes, options: any = {}) {
    if (!game.user.isGM || !bloodEnabled()) return;
    // hook is global: tokens may move in ANY loaded scene (automation, co-GM) —
    // footprints from another scene must not stamp onto the active canvas
    if (doc.scene && doc.scene.id !== canvas.scene?.id) return;
    const crossLevel = Boolean(changes.level && doc.level && changes.level !== doc.level);
    if (crossLevel) {
      this._lastPos.delete(doc.id);
      if (doc.hidden) return;
      if (resolveMoveAction(doc, changes, options) === 'teleport') {
        this._trail.snowTeleportDents(doc, changes, options);
      }
      return;
    }
    if (changes.x === undefined && changes.y === undefined) return;
    if (Math.abs((changes.x ?? doc.x) - doc.x) < 0.5 && Math.abs((changes.y ?? doc.y) - doc.y) < 0.5) return;
    // hidden tokens leave no player-visible tracks: footprints/smears are synced
    // while puffs are client-side — an invisible creature would reveal itself out of thin air
    // (if an invisible trail is desired, the GM can paint it with the brush)
    if (doc.hidden) return;
    // stationary bleeding checks whether the token is standing still: record pose on every move
    this._lastPos.set(doc.id, { x: changes.x ?? doc.x, y: changes.y ?? doc.y, at: Date.now() });
    // a bleeding token does not need footprints: the bleeding trail already marks its path,
    // and per-step puffs made wounded movement visually noisy (smears + prints + fountains).
    // However, if a wounded creature crawls or is dragged through snow, its snow furrow still carves.
    const moveAction = resolveMoveAction(doc, changes, options);
    if (!isBleeding(doc.object) || moveAction === 'teleport' || moveAction === 'jump') {
      this._trail.footprints(doc, changes, options);
    } else if (isCrawlingOrDragged(doc)) {
      this._trail.snowDragFurrow(doc, changes, options);
    }
    this._trail.bleedingTrail(doc, changes, options); // bleeding trail of wounded tokens
  }

  /* --------------------- periodic blood emission --------------------- */

  /**
   * A bleeding token periodically emits blood while standing still:
   * status bleeding drips at its own cadence (bloodBleedInterval, after standing
   * at least BLEED_STAND_MS — moving tokens already leave a trail, so dripping while
   * moving would double-emit), while deep wounds follow legacy semantics (standing
   * WOUND_STAND_MS, droplets/small pool every WOUND_DRIP_EVERY_MS). GM-side poll
   * every DRIP_TICK_MS; writes go through the standard store pipeline.
   */
  _stationaryDrip() {
    if (!game.user.isGM || !bloodEnabled() || !settingGet('bloodStationary', true)) return;
    if (settingGet('bloodOnlyInCombat', false) && !game.combat?.started) return;
    const store = this.getStore();
    if (!store) return;
    const now = Date.now();
    const grid = canvas.grid?.size ?? 100;
    const statusOn = statusBleedOn();
    const statusEvery = Math.max(3, Number(settingGet('bloodBleedInterval', 6)) || 6) * 1000;
    for (const token of canvas.tokens?.placeables ?? []) {
      const doc = token?.document;
      if (!doc || doc.hidden || bloodDisabled(token)) continue;
      if (isDeadDoc(doc)) continue; // corpses do not drip forever: their terminal state is the death pool
      const hasStatus = statusOn && hasBleedStatus(token);
      const depth = woundDepth(token);
      // barely-bloodied tokens without a bleed status do not drip — only status-bleeding or deeply wounded
      if (!hasStatus && depth < 0.5) continue;
      const every = hasStatus ? statusEvery : WOUND_DRIP_EVERY_MS;
      if (now - (this._lastDrip.get(doc.id) ?? 0) < every) continue;
      const last = this._lastPos.get(doc.id);
      if (!last || Math.abs(last.x - doc.x) > 1 || Math.abs(last.y - doc.y) > 1) {
        this._lastPos.set(doc.id, { x: doc.x, y: doc.y, at: now }); // new position — reset stationarity timer
        continue;
      }
      if (now - last.at < (hasStatus ? BLEED_STAND_MS : WOUND_STAND_MS)) continue;
      const tLevel = doc?.level ?? currentLevelId();
      const tsize = tsizeOf(doc, grid);
      // zone: none suppresses generation; tracked marks drips rain-proof (nw)
      const zoneMode = bloodZoneModeAt(token.center.x, token.center.y, tLevel);
      if (zoneMode === 'none') continue;
      const surf = surfaceAt(token.center.x, token.center.y, elevOf(doc), tLevel);
      const activeLvl = surf.lvl ?? tLevel;
      const dx = token.center.x + (Math.random() - 0.5) * tsize * 0.35;
      const dy = token.center.y + (Math.random() - 0.5) * tsize * 0.35;
      const rawHex = hexOf(token);
      const tintedSnow = new Map();
      const absorbed = absorbBloodIntoSnow(store, dx, dy, tsize * 0.5, surf.e, rawHex, tintedSnow, activeLvl);
      if (tintedSnow.size) trampleSnowStains(store, tintedSnow);
      store.add([store.createStain({
        t: Math.random() < 0.35 ? STAIN.POOL : STAIN.DROPLETS,
        x: dx,
        y: dy,
        s: tsize * (0.16 + depth * 0.2 + Math.random() * 0.08) * (absorbed ? absorbed.sizeK : 1),
        r: Math.random() * TAU,
        a: Math.min(0.85, (0.4 + depth * 0.35) * (absorbed ? absorbed.alphaK : 1)),
        c: absorbed ? absorbed.color : rawHex,
        d: Math.round(200 + Math.random() * 400),
        f: 400,
        ...(Math.random() < 0.5 ? { g: 1 } : {}),
        T: worldTime(),
        ...(zoneMode === 'tracked' ? { nw: 1 } : {}),
        e: surf.e,
        ...(surf.tid ? { tid: surf.tid } : {}),
        ...(activeLvl ? { lvl: activeLvl } : {})
      })]);
      this._lastDrip.set(doc.id, now);
      this._lastPos.set(doc.id, { x: doc.x, y: doc.y, at: now }); // next drip after another full interval
    }
  }

  /* ---------------------- hit direction (best effort) ---------------------- */

  _registerMidiDirection() {
    const record = (target, source, type = null) => {
      if (!target?.id) return;
      if (source?.center && target.id !== source.id) {
        this._lastHitDir.set(target.id, { x: source.center.x, y: source.center.y, at: Date.now() });
      }
      if (type) this._lastDamageType.set(target.id, { type: String(type), at: Date.now() });
    };
    try {
      // built-in dnd5e 6.0.0 hooks (also work without midi-qol): pass damages array [{value, type, types: Set}]
      const onDnd5eDamage = (actor, damages) => {
        if (!actor) return;
        const dmgType = _extractDamageTypeFromList(damages);
        if (!dmgType) return;
        const tok = resolveToken(actor);
        if (!tok?.id) return;
        this._lastDamageType.set(tok.id, { type: String(dmgType), at: Date.now() });
        // When fire/thunder/cold damage is dealt on the GM client, immediately interact with snow beneath the target
        // (even if the damage is absorbed by temp HP hp.temp so updateActor never changes hp.value)
        if (game.user?.isGM && bloodEnabled()) {
          this._interactSnowOnDamage(tok, dmgType, 0.65);
        }
      };
      Hooks.on('dnd5e.preCalculateDamage', onDnd5eDamage);
      Hooks.on('dnd5e.calculateDamage', onDnd5eDamage);
      Hooks.on('midi-qol.DamageRollComplete', (workflow) => this._onMidiDamageRollComplete(workflow));
    } catch { /* empty */ }
    if (!game.modules.get('midi-qol')?.active) return;
    // damage type from workflow: damageDetail (aggregate) → damageList (per-target) →
    // item's first damage part. Strictly best-effort: unknown → neutral profile
    const sniffType = (wf, target) => {
      const d = wf?.damageDetail?.find?.(x => Number(x?.value) > 0) ?? wf?.damageDetail?.[0];
      if (d?.type) return d.type;
      const item = target?.id ? wf?.damageList?.find?.(x => x?.tokenId === target.id || x?.targetUuid?.includes?.(target.id)) : null;
      const dd = item?.damageDetail?.find?.(x => Number(x?.value) > 0) ?? item?.damageDetail?.[0];
      if (dd?.type) return dd.type;
      const part = wf?.item?.system?.damage?.parts?.[0]?.[1];
      return typeof part === 'string' && part && part !== 'healing' ? part : null;
    };
    try {
      // midi-qol 12+ (14.x installed): DamageApplied is NOT emitted at all — active
      // per-target damage hooks take (token, { item, workflow, damageItem }).
      // workflow.token is the attacker; directional SPLASH and bursts are driven by these.
      Hooks.on('midi-qol.isDamaged', (token, opts: any = {}) => {
        const wf = opts?.workflow;
        record(token, wf?.token ?? null, sniffType(wf, token));
      });
      // legacy fallback for older midi versions: scan hook arguments for a token pair
      Hooks.on('midi-qol.DamageApplied', (...args) => {
        const tokens = [];
        for (const a of args) {
          if (a?.document?.center || (a?.center && a?.document)) tokens.push(a);
        }
        if (tokens.length < 2) return;
        const [target, source] = tokens;
        record(target, source);
      });
    } catch { /* empty */ }
  }

  _popHitDirection(tokenId) {
    const d = this._lastHitDir.get(tokenId);
    if (!d) return null;
    this._lastHitDir.delete(tokenId);
    return Date.now() - d.at < 10000 ? d : null;
  }

  /** Fresh (≤10 s) damage type for a token — or null (neutral profile). */
  _popDamageType(tokenId) {
    const d = this._lastDamageType.get(tokenId);
    if (!d) return null;
    this._lastDamageType.delete(tokenId);
    return Date.now() - d.at < 10000 ? d.type : null;
  }

  /**
   * Hit direction WITHOUT midi: the active combatant in the tracker, provided it is not
   * the victim itself (1-on-1 melee heuristic: "whoever's turn it is dealt the blow").
   * Cheap fallback restoring directional splashes for ~90% of unautomated tables.
   */
  _combatantDirection(token) {
    try {
      const combat = game.combat;
      if (!combat?.started) return null;
      const cur = combat.current?.tokenId;
      if (!cur || cur === token.id) return null;
      const c = canvas.tokens?.get?.(cur);
      return c?.center ?? null;
    } catch { return null; }
  }
}
