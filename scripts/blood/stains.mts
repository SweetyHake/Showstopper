/**
 * Blood stain model and persistence in scene flags.
 *
 * A stain is a compact record that completely describes rendering:
 *   i — id (int, monotonic within the scene)
 *   t — type: 0 impact splat, 1 directional splash, 2 smear, 3 pool, 4 droplets,
 *       5 footprint (token interaction with trails)
 *   x, y — center in scene coordinates
 *   s — primary body diameter (scene px)
 *   r — rotation (rad)
 *   a — alpha (0..1)
 *   c — color '#rrggbbaa' (snapshot of the token's blood color at impact)
 *   seed — PRNG seed: the entire shape is derived deterministically from it
 *   w — optional wall profile (16 hex chars, per-sector droplet clipping)
 *   d/f — optional appear animation: delay ms and fade-in duration ms
 *   g — optional growth flag (pool expands over `f` ms)
 *   m — optional material (0/omitted = blood, 2 = snow)
 *   T — optional creation time (worldTime): used to derive stain age
 *       (drying blood). Legacy records without `T` do not age — otherwise all
 *       accumulated blood would abruptly dry out on the first update
 *
 * Only the GM writes scene flags (3s debounce); instant sync is provided by the
 * `blood:apply` socket. Other clients reconcile against the flag via `reconcile`.
 *
 * Persist v2 — BUCKETS: flag `blood = { v: 2, nextId, b0: {stains}, b1: ... }`,
 * 2000 IDs per bucket; `flush` writes only DIRTY buckets so flag string
 * serialization does not scale with total stain count (cap removed). Legacy v1
 * (`blood.stains` array) is still read and migrated on the first flush.
 */

import { MODULE_ID } from '../config.mjs';
import { emitAll } from '../core/socket-manager.mjs';

export const STAIN = Object.freeze({
  SPLAT: 0, SPLASH: 1, SMEAR: 2, POOL: 3, DROPLETS: 4, FOOTPRINT: 5,
  // APPEND-ONLY: kind indices are tied to saved stain seeds;
  // new kinds must only be appended at the end (renderer: KIND_BY_TYPE + LAYOUT)
  DRIP: 6,        // drip down a wall/support (drawn "downward" in local space)
  HANDPRINT: 7    // handprint (fingertips point along +X in local space)
});
export const MAX_STAIN_T = 7;
/** Footprint shape subtypes (for STAIN.FOOTPRINT, `fp` field):
 *  0 (omitted) — boot/foot (`footprint`), 1 — animal paw (`pawprint`),
 *  2 — clawed foot (`clawprint`), 3 — hoof (`hoofprint`). */
export const FOOTPRINT_SUBTYPE = Object.freeze({
  BOOT: 0,
  PAW: 1,
  CLAW: 2,
  HOOF: 3
});
export const FP_KIND_BY_SUBTYPE = Object.freeze(['footprint', 'pawprint', 'clawprint', 'hoofprint']);
/** Materials: 0 blood, 2 snow. */
export const MATERIAL_MAX = 2;

const FLAG_KEY = 'blood';
const MAX_REMOTE_ADD = 25000;  // per-op remote add ceiling (accommodates instant multi-day snowfall up to _cap = 25000)
const MAX_REMOTE_REMOVE = 25000;
const MAX_APPEAR_MS = 60000;   // d/f ceiling: a stain that "never appears" (1e15) is unacceptable
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6,8}$/;
const PERSIST_DEBOUNCE_MS = 3000;
const BUCKET_SIZE = 2000; // stains per flag bucket (v2): flush writes only dirty buckets
const GRID_CELL = 256; // spatial index cell size (scene px)
// Fast stain-size threshold for queryCircle: stains with s <= FAST_MAX_S are indexed
// only in their center cell, and queryCircle expands its scan by at most
// 0.35 * FAST_MAX_S (89.6 px = 1–4 cells). Oversized stains (s > FAST_MAX_S) are
// registered across all overlapping grid cells on insertion, so even a giant
// s=8192 pool never bloats every token step into a 169-cell scan.
const FAST_MAX_S = 256;
// upper bound on stain size (scene px): an unsanitized flag record
// (load/reconcile bypass createStain) with a huge `s` would otherwise bloat
// queryCircle/_touch cell scans into minute-long freezes per call
const MAX_STAIN_S = 8192;
const FLUSH_MAX_RETRIES = 3; // automatic retries for a failed flag write
const _querySeen = new Set();

const bucketOf = (id) => Math.floor(id / BUCKET_SIZE);

/**
 * Public scene blood change event (for macros / third-party modules):
 * Hooks.callAll('showstopperBloodChanged', { sceneId, kind, ids? }).
 * kind: 'add' | 'remove' | 'clear' | 'applyRemote'. Silenced in tests without Hooks.
 * Walking through snow mutates the store 3+ times per move: when there are no
 * listeners, the event (and its copied `ids` payload) is not built at all.
 */
function _bloodChanged(sceneId, kind, ids) {
  try {
    const H = globalThis.Hooks;
    if (!H?.callAll) return;
    const listeners = H.events?.showstopperBloodChanged;
    if (listeners && !listeners.length) return; // nobody listening — skip payload allocation
    H.callAll('showstopperBloodChanged', { sceneId, kind, ids: ids ? [...ids] : null });
  } catch { /* listener errors must not break the mutation */ }
}

/**
 * Unified view of the scene blood flag: merges v2 buckets (blood.b0, b1, …)
 * and legacy v1 (`blood.stains`) into a single list deduplicated by id. Returns
 * null if no flag exists. Used by the load()/reconcile path (entry.updateScene).
 */
export function readBloodFlag(scene) {
  const B: any = scene?.flags?.[MODULE_ID]?.[FLAG_KEY];
  if (!B || typeof B !== 'object') return null;
  const stains = [];
  const seen = new Set();
  const push = (list) => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (s && !seen.has(s.i)) { seen.add(s.i); stains.push(s); }
    }
  };
  for (const [key, val] of Object.entries(B) as any[]) {
    if (key[0] === 'b' && /^\d+$/.test(key.slice(1))) push(val?.stains);
  }
  const legacy = Array.isArray(B.stains) && B.stains.length > 0;
  push(B.stains);
  // nextId: 0 = "missing from flag" (legacy v1) — load() computes max(i)+1 and writes it
  const nextId = B.nextId != null ? (Number(B.nextId) || 1) : 0;
  const v = Number(B.v) || 1;
  return { v, nextId, stains, legacy, newer: v > 2 };
}

const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Shallow field-by-field stain comparison. Do NOT use JSON.stringify here:
 * reconcile compares EVERY stain in the scene after every flag write —
 * stringifying thousands of records caused regular hitches.
 */
function stainEquals(a, b) {
  for (const k in a) if (a[k] !== b[k]) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
}

export class BloodStore {
  declare sceneId; declare stains; declare nextId; declare _renderer; declare _persistTimer; declare _persisting; declare _ids; declare _idxById; declare _buckets; declare _grid; declare _oversizedCount; declare _snowCountNoFp; declare _snowCountAll; declare _dirtyBuckets; declare _knownBuckets; declare _legacyFlag; declare _persisted; declare _maxS; declare _readOnly; declare _warnedReadOnly; declare _pristine; declare _flushRetries;
  /** @param {Scene} scene active scene */
  constructor(scene) {
    this.sceneId = scene?.id ?? null;
    this.stains = [];
    this.nextId = 1;
    this._renderer = null;
    this._persistTimer = null;
    this._persisting = Promise.resolve();
    this._ids = new Set(); // fast O(1) id dedup for add/applyRemote instead of linear scan
    this._idxById = new Map(); // id → index in this.stains (O(1) for in-place replacements and targeted removals)
    this._buckets = new Map(); // bucketId → Set<stain> (O(1) dirty-bucket assembly on flush without scanning 100k stains)
    this._grid = new Map(); // spatial index: numeric cell key → Set<stain>
    this._oversizedCount = 0; // count of stains with s > FAST_MAX_S (multi-cell registration)
    this._snowCountNoFp = 0;  // live O(1) counter of snow stains excluding footprints
    this._snowCountAll = 0;   // live O(1) counter of all snow stains
    this._dirtyBuckets = new Set(); // flag buckets pending write
    this._knownBuckets = new Set(); // buckets currently persisted in the scene flag
    this._legacyFlag = false; // legacy v1 array found in flag — migrate on first flush
    this._persisted = { v: 0, nextId: 0 }; // already persisted metadata — skip redundant writes
    this._maxS = 0;      // maximum stain size: queryCircle expands its cell scan accordingly
    this._readOnly = false; // scene flag version is NEWER than ours — read-only, do not write
    this._warnedReadOnly = false;
    this._pristine = false;    // scene had no blood flag: stamp `v` on the first real write
    this._flushRetries = 0;    // retry counter for failed flushes
  }

  setRenderer(r) { this._renderer = r; }

  get count() { return this.stains.length; }

  /** Fast O(1) count of snow stains on the scene (without iterating `this.stains`). */
  snowCount(includeFootprints = false) {
    return includeFootprints ? this._snowCountAll : this._snowCountNoFp;
  }

  /** Emit public change event (see _bloodChanged). */
  _changed(kind, ids?) { _bloodChanged(this.sceneId, kind, ids); }

  /** Scene flag has a newer version: local edits last until reload — warn once. */
  _warnReadOnly() {
    if (!this._readOnly || this._warnedReadOnly) return;
    this._warnedReadOnly = true;
    console.warn(`${MODULE_ID} | blood scene flag is a newer version — local edits render but will NOT persist until the module is updated`);
  }

  /* --------------------- spatial index --------------------- */

  _gridKey(x, y) {
    // numeric cell key (bijective for |cell| < 32768 — scenes up to ±8.3M px):
    // Map<number> avoids string concatenation; queryCircle touches up to ~9 cells
    // on EVERY snow footstep, where template strings were an allocation hotspot
    return (Math.floor(x / GRID_CELL) + 0x8000) * 0x10000 + (Math.floor(y / GRID_CELL) + 0x8000);
  }

  _bucketAdd(st) {
    const b = bucketOf(st.i);
    let bset = this._buckets.get(b);
    if (!bset) { bset = new Set(); this._buckets.set(b, bset); }
    bset.add(st);
    if (st.m === 2) {
      this._snowCountAll++;
      if (st.t !== STAIN.FOOTPRINT) this._snowCountNoFp++;
    }
  }

  _bucketRemove(st) {
    const b = bucketOf(st.i);
    const bset = this._buckets.get(b);
    if (bset) {
      bset.delete(st);
      if (!bset.size) this._buckets.delete(b);
    }
    if (st.m === 2) {
      this._snowCountAll = Math.max(0, this._snowCountAll - 1);
      if (st.t !== STAIN.FOOTPRINT) this._snowCountNoFp = Math.max(0, this._snowCountNoFp - 1);
    }
  }

  _gridAdd(st) {
    const s = Math.min(Number(st.s) || 0, MAX_STAIN_S);
    // choke point for all insertion paths (add/applyRemote/load/reconcile) —
    // grows _maxS here too. Clamped to MAX_STAIN_S so a raw flag record with a
    // huge `s` cannot blow up the query radius indefinitely
    if (s > this._maxS) this._maxS = s;
    if (s <= FAST_MAX_S) {
      const key = this._gridKey(st.x, st.y);
      let set = this._grid.get(key);
      if (!set) { set = new Set(); this._grid.set(key, set); }
      set.add(st);
    } else {
      // Oversized stain (s > 256): register in every cell reached by its excess
      // radius (s - FAST_MAX_S) * 0.35 so queryCircle always scans only the
      // compact FAST_MAX_S neighborhood (1–4 cells instead of hundreds)
      this._oversizedCount++;
      const extraR = (s - FAST_MAX_S) * 0.35;
      const cx0 = Math.floor((st.x - extraR) / GRID_CELL), cx1 = Math.floor((st.x + extraR) / GRID_CELL);
      const cy0 = Math.floor((st.y - extraR) / GRID_CELL), cy1 = Math.floor((st.y + extraR) / GRID_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = (cx + 0x8000) * 0x10000 + (cy + 0x8000);
          let set = this._grid.get(key);
          if (!set) { set = new Set(); this._grid.set(key, set); }
          set.add(st);
        }
      }
    }
  }

  _gridRemove(st) {
    const s = Math.min(Number(st.s) || 0, MAX_STAIN_S);
    if (s <= FAST_MAX_S) {
      const key = this._gridKey(st.x, st.y);
      const set = this._grid.get(key);
      if (!set) return;
      set.delete(st);
      if (!set.size) this._grid.delete(key);
    } else {
      this._oversizedCount = Math.max(0, this._oversizedCount - 1);
      const extraR = (s - FAST_MAX_S) * 0.35;
      const cx0 = Math.floor((st.x - extraR) / GRID_CELL), cx1 = Math.floor((st.x + extraR) / GRID_CELL);
      const cy0 = Math.floor((st.y - extraR) / GRID_CELL), cy1 = Math.floor((st.y + extraR) / GRID_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = (cx + 0x8000) * 0x10000 + (cy + 0x8000);
          const set = this._grid.get(key);
          if (!set) continue;
          set.delete(st);
          if (!set.size) this._grid.delete(key);
        }
      }
    }
  }

  _recalcMaxS() {
    let maxS = 0;
    for (let i = 0; i < this.stains.length; i++) {
      const s = Math.min(Number(this.stains[i].s) || 0, MAX_STAIN_S);
      if (s > maxS) maxS = s;
    }
    this._maxS = maxS;
  }

  _gridRebuild() {
    this._grid.clear();
    this._buckets.clear();
    this._oversizedCount = 0;
    this._snowCountNoFp = 0;
    this._snowCountAll = 0;
    // reset the _maxS ratchet: an erased giant stain must not keep queryCircle's
    // reach inflated for the rest of the session
    this._maxS = 0;
    for (let i = 0; i < this.stains.length; i++) {
      const st = this.stains[i];
      this._gridAdd(st);
      this._bucketAdd(st);
    }
  }

  _idsRebuild() {
    this._ids.clear();
    this._idxById.clear();
    for (let i = 0; i < this.stains.length; i++) {
      const id = this.stains[i].i;
      this._ids.add(id);
      this._idxById.set(id, i);
    }
  }

  /** Mark all known + occupied buckets dirty for writing (clear/reconcile/migration). */
  _markAllBucketsDirty() {
    for (const b of this._knownBuckets) this._dirtyBuckets.add(b);
    for (const b of this._buckets.keys()) this._dirtyBuckets.add(b);
  }

  /**
   * Stains intersecting a circle (centers within `r` + roughly a third of stain
   * size so stepping on an edge counts too). Strictly O(1) in grid cells (1–4 cells),
   * cheap for token steps. Supports an optional reusable `out` array for zero
   * allocations inside step loops.
   */
  queryCircle(x, y, r, out = []) {
    out.length = 0;
    if (!this._grid.size) return out;
    // reach is bounded by FAST_MAX_S (256px → +89.6px): oversized stains (s > 256)
    // are already spread across overlapping cells in _gridAdd, so the scan window stays compact!
    const reach = Math.min(r + Math.min(this._maxS, FAST_MAX_S) * 0.35, MAX_STAIN_S);
    const cx0 = Math.floor((x - reach) / GRID_CELL), cx1 = Math.floor((x + reach) / GRID_CELL);
    const cy0 = Math.floor((y - reach) / GRID_CELL), cy1 = Math.floor((y + reach) / GRID_CELL);
    const checkDedup = this._oversizedCount > 0 && (cx1 > cx0 || cy1 > cy0);
    if (checkDedup) _querySeen.clear();
    for (let cx = cx0; cx <= cx1; cx++) {
      const rowBase = (cx + 0x8000) * 0x10000;
      for (let cy = cy0; cy <= cy1; cy++) {
        const set = this._grid.get(rowBase + (cy + 0x8000));
        if (!set) continue;
        for (const st of set) {
          if (checkDedup && st.s > FAST_MAX_S) {
            if (_querySeen.has(st.i)) continue;
            _querySeen.add(st.i);
          }
          // squared distance instead of hypot: both sides are non-negative, result
          // is identical, and filtering is 4.5x cheaper (called on every token step)
          const dx = st.x - x, dy = st.y - y;
          const rr = r + st.s * 0.35;
          if (dx * dx + dy * dy <= rr * rr) out.push(st);
        }
      }
    }
    if (checkDedup) _querySeen.clear();
    return out;
  }

  /* -------------------------------- creation -------------------------------- */

  createStain(p: any = {}) {
    // id/type are validated strictly: createStain also sanitizes remote records
    // (applyRemote) — a garbage id would corrupt buckets/indices, and an unknown
    // type would fall back to "splat" at render time, so normalize up front
    const id = Number.isInteger(p.i) && p.i >= 0 && p.i <= 1e7 ? p.i : this.nextId++;
    const stain: any = {
      i: id,
      t: Number.isInteger(p.t) && p.t >= 0 && p.t <= MAX_STAIN_T ? p.t : STAIN.SPLAT,
      // Number.isFinite is REQUIRED: Infinity passes `Number(v) || 0` (truthy) —
      // an unsanitized record with x=Infinity drove chunk keys to NaN
      x: round1(Number.isFinite(p.x) ? Number(p.x) : 0),
      y: round1(Number.isFinite(p.y) ? Number(p.y) : 0),
      s: round1(clamp(Number(p.s) || 100, 4, MAX_STAIN_S)),
      r: Math.round((Number(p.r) || 0) * 1000) / 1000,
      a: clamp(Number(p.a ?? 0.85), 0.05, 1),
      // color was previously the only unclamped string: a spoofed '#' + 10MB
      // would persist into the scene document verbatim. Strict #rgb[a] format
      c: HEX_COLOR_RE.test(p.c ?? '') ? p.c.slice(0, 9) : '#a51414d8',
      // default seed is DETERMINISTIC from id, not mintSeed(): a remote op
      // missing a seed would otherwise render differently on each client (and the
      // GM would persist its own roll). Math.random stays restricted to explicit
      // minters (events/brush pass their own seed)
      seed: p.seed == null ? (Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0) : (p.seed | 0)
    };
    if (p.i != null && id >= this.nextId) this.nextId = id + 1;
    if (typeof p.w === 'string' && p.w.length) stain.w = p.w.slice(0, 16);
    // surface elevation: omitted = floor (0). Additive field —
    // flag version stays unchanged and older records remain valid
    const e = round1(clamp(Number(p.e) || 0, -1000, 1000));
    if (e) stain.e = e;
    // surface tile id to which the stain is attached (follows tile movement
    // and is removed when the tile is deleted). Named `tid` because `t` is stain type
    if (typeof p.tid === 'string' && p.tid) stain.tid = p.tid.slice(0, 64);
    // Scene Level ID (Foundry v14 multi-level scenes): isolates stains per floor/level
    if (typeof p.lvl === 'string' && p.lvl) stain.lvl = p.lvl.slice(0, 64);
    // IMPORTANT: blood resolves elevation ONLY when spawned (surfaceAt at
    // creation time). Ceiling memory (`h` field) is intentionally unused: a tile
    // moved underneath floor blood later does NOT lift it — the blood stays on
    // the floor and is occluded by that tile
    // appear animation: d = delay ms, f = fade-in duration, g = grow.
    // Clamped: a spoofed d=1e15 produced a stain that "never appears"
    if (Number(p.d) > 0) stain.d = Math.min(MAX_APPEAR_MS, Math.round(Number(p.d)));
    if (Number(p.f) > 0) stain.f = Math.min(MAX_APPEAR_MS, Math.round(Number(p.f)));
    if (p.g) stain.g = 1;
    // creation timestamp (worldTime) — renderer derives stain age (drying) from it.
    // Fractional/negative values are omitted: a "future age" would dim the stain
    if (Number.isFinite(p.T) && p.T >= 0) stain.T = Math.round(p.T);
    // no-wash: stain spawned inside a `tracked` Blood Zone — rain will not wash it away
    // (decided by the GM minter at generation time; rendering pays 0)
    if (p.nw) stain.nw = 1;
    // material: only blood (0/omitted) and snow (2) are supported
    const m = Number(p.m) === 2 ? 2 : 0;
    if (m === 2) stain.m = 2;
    // snow level (1 light frost, 2 medium cover, 3..5 low/high/deep 3D drift): only for m=2
    if (m === 2 && Number.isInteger(p.lv) && p.lv >= 1 && p.lv <= 5) stain.lv = p.lv;
    // footprint subtype (1 animal paw, 2 claws, 3 hoof; 0/omitted = boot/foot): only for STAIN.FOOTPRINT
    if (stain.t === STAIN.FOOTPRINT && Number.isInteger(p.fp) && p.fp >= 1 && p.fp <= 3) stain.fp = p.fp;
    return stain;
  }

  /* ------------------------------- mutations ------------------------------- */

  /**
   * Add stains (already created via createStain). Returns the actually added
   * records. Applied locally right away, broadcast via socket for instant
   * feedback on other clients, and asynchronously persisted by the GM. Uncapped:
   * chunked rendering does not scale with total stain count.
   */
  add(stains, { broadcast = true, persist = true } = {}) {
    this._warnReadOnly();
    const fresh = [];
    for (let i = 0; i < stains.length; i++) {
      const s = stains[i];
      if (!s || this._ids.has(s.i)) continue;
      this._ids.add(s.i);
      this._idxById.set(s.i, this.stains.length);
      this.stains.push(s);
      this._gridAdd(s);
      this._bucketAdd(s);
      this._dirtyBuckets.add(bucketOf(s.i));
      fresh.push(s);
    }
    if (!fresh.length) return [];

    this._renderer?.addStains(fresh);

    if (broadcast) {
      emitAll('blood:apply', { from: game.user.id, sceneId: this.sceneId, add: fresh });
    }
    if (persist && game.user.isGM) this._schedulePersist();
    this._changed('add', fresh.map(s => s.i));
    return fresh;
  }

  /**
   * Batched atomic mutation (trampling snowdrifts + adding footprints/trenches in one pass):
   *  - `replace`: updates existing stains in-place in O(1) via `_idxById` without `this.stains.filter()` over 100k items;
   *  - `remove`: removes completely trampled stains;
   *  - `add`: appends new footprints/trenches;
   *  - emits a SINGLE combined `blood:apply` socket packet instead of 2–3 separate packets per token move.
   */
  applyBatch({ replace = null, remove = null, add = null }: any = {}, { broadcast = true, persist = true } = {}) {
    this._warnReadOnly();
    const replacedPrev = [];
    const replacedNext = [];
    const replacedIds = [];
    let needRecalcMaxS = false;

    if (Array.isArray(replace) && replace.length) {
      for (let i = 0; i < replace.length; i++) {
        const next = replace[i];
        if (!next) continue;
        const idx = this._idxById.get(next.i);
        if (idx === undefined) continue;
        const prev = this.stains[idx];
        this.stains[idx] = next;
        this._gridRemove(prev);
        this._bucketRemove(prev);
        this._gridAdd(next);
        this._bucketAdd(next);
        this._dirtyBuckets.add(bucketOf(next.i));
        if (Math.min(Number(prev.s) || 0, MAX_STAIN_S) >= this._maxS && (Number(next.s) || 0) < (Number(prev.s) || 0)) {
          needRecalcMaxS = true;
        }
        replacedPrev.push(prev);
        replacedNext.push(next);
        replacedIds.push(next.i);
      }
    }

    const removedIds = [];
    if (Array.isArray(remove) && remove.length) {
      let minIdx = Infinity;
      const killSet = new Set();
      for (let i = 0; i < remove.length; i++) {
        const id = remove[i];
        const idx = this._idxById.get(id);
        if (idx === undefined || killSet.has(id)) continue;
        killSet.add(id);
        if (idx < minIdx) minIdx = idx;
        const st = this.stains[idx];
        this._ids.delete(id);
        this._idxById.delete(id);
        this._gridRemove(st);
        this._bucketRemove(st);
        this._dirtyBuckets.add(bucketOf(id));
        if (Math.min(Number(st.s) || 0, MAX_STAIN_S) >= this._maxS) needRecalcMaxS = true;
        removedIds.push(id);
      }
      if (minIdx < Infinity) {
        let w = minIdx;
        for (let r = minIdx; r < this.stains.length; r++) {
          const st = this.stains[r];
          if (!killSet.has(st.i)) {
            this.stains[w] = st;
            this._idxById.set(st.i, w);
            w++;
          }
        }
        this.stains.length = w;
      }
    }

    const fresh = [];
    if (Array.isArray(add) && add.length) {
      for (let i = 0; i < add.length; i++) {
        const s = add[i];
        if (!s || this._ids.has(s.i)) continue;
        this._ids.add(s.i);
        this._idxById.set(s.i, this.stains.length);
        this.stains.push(s);
        this._gridAdd(s);
        this._bucketAdd(s);
        this._dirtyBuckets.add(bucketOf(s.i));
        fresh.push(s);
      }
    }

    if (needRecalcMaxS) this._recalcMaxS();

    if (!replacedNext.length && !removedIds.length && !fresh.length) return;

    if (this._renderer) {
      if (typeof this._renderer.applyBatch === 'function') {
        this._renderer.applyBatch({ replacedPrev, replacedNext, removedIds, added: fresh });
      } else {
        if (replacedIds.length || removedIds.length) {
          this._renderer.removeStains([...replacedIds, ...removedIds]);
        }
        if (replacedNext.length || fresh.length) {
          this._renderer.addStains([...replacedNext, ...fresh]);
        }
      }
    }

    if (broadcast) {
      const sockRemove = replacedIds.length && removedIds.length
        ? [...replacedIds, ...removedIds]
        : (replacedIds.length ? replacedIds : removedIds);
      const sockAdd = replacedNext.length && fresh.length
        ? [...replacedNext, ...fresh]
        : (replacedNext.length ? replacedNext : fresh);
      const payload: any = { from: game.user.id, sceneId: this.sceneId };
      if (replacedNext.length) payload.replace = replacedNext;
      if (sockRemove.length) payload.remove = sockRemove;
      if (sockAdd.length) payload.add = sockAdd;
      emitAll('blood:apply', payload);
    }
    if (persist && game.user.isGM) this._schedulePersist();
    if (removedIds.length) this._changed('remove', removedIds);
    if (replacedIds.length || fresh.length) {
      this._changed('add', [...replacedIds, ...fresh.map(s => s.i)]);
    }
  }

  remove(ids, { broadcast = true, persist = true } = {}) {
    this._warnReadOnly();
    if (!ids?.length || !this.stains.length) return;
    const removed = [];
    let minIdx = Infinity;
    const kill = new Set();
    let needRecalcMaxS = false;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const idx = this._idxById.get(id);
      if (idx === undefined || kill.has(id)) continue;
      kill.add(id);
      if (idx < minIdx) minIdx = idx;
      const st = this.stains[idx];
      this._ids.delete(id);
      this._idxById.delete(id);
      this._gridRemove(st);
      this._bucketRemove(st);
      this._dirtyBuckets.add(bucketOf(id));
      if (Math.min(Number(st.s) || 0, MAX_STAIN_S) >= this._maxS) needRecalcMaxS = true;
      removed.push(id);
    }
    if (!removed.length) return;
    // Compact only starting from the first removed index `minIdx` (instead of a full filter from 0):
    // removing recent stains near the tail of a 100k-element array runs in O(1)
    let w = minIdx;
    for (let r = minIdx; r < this.stains.length; r++) {
      const st = this.stains[r];
      if (!kill.has(st.i)) {
        this.stains[w] = st;
        this._idxById.set(st.i, w);
        w++;
      }
    }
    this.stains.length = w;
    if (needRecalcMaxS) this._recalcMaxS();

    this._renderer?.removeStains(removed);
    if (broadcast) emitAll('blood:apply', { from: game.user.id, sceneId: this.sceneId, remove: removed });
    if (persist && game.user.isGM) this._schedulePersist();
    this._changed('remove', removed);
    return removed;
  }

  clear({ broadcast = true, persist = true } = {}) {
    this._warnReadOnly();
    if (!this.stains.length) return;
    // BEFORE emptying: buckets are collected from LIVE stains (+ _knownBuckets, which
    // is populated on load/flush). Once `stains = []`, live buckets are gone —
    // clearing a fresh session (before any flush) used to mark NOTHING dirty,
    // flush returned early, and cleared blood resurrected from the flag on reload.
    // Marking first also cleans up bucket tails left behind after reconcile/applyRemote
    this._markAllBucketsDirty();
    this.stains = [];
    this._ids.clear();
    this._idxById.clear();
    this._buckets.clear();
    this._grid.clear();
    this._oversizedCount = 0;
    this._snowCountNoFp = 0;
    this._snowCountAll = 0;
    this._maxS = 0; // see _gridRebuild: reach is computed over LIVE stains
    this._renderer?.clear();
    if (broadcast) emitAll('blood:apply', { from: game.user.id, sceneId: this.sceneId, clear: true });
    if (persist && game.user.isGM) this._schedulePersist();
    this._changed('clear');
  }

  /* ------------------------------ remote clients ------------------------------ */

  /** Socket handler: apply operations idempotently (persisted by receiving GM). */
  applyRemote(ops: any = {}) {
    if (ops.from && ops.from === game.user?.id) return;
    if (ops.sceneId && ops.sceneId !== this.sceneId) return;
    // per-op size cap: a spoofed `add` with 100k records would otherwise flood
    // millions of index entries on every client and hundreds of flag buckets.
    // The cap trims the TAIL (legitimate generators send at most hundreds per op)
    const replaceList = Array.isArray(ops.replace) ? ops.replace.slice(0, MAX_REMOTE_ADD) : null;
    const addList = Array.isArray(ops.add) ? ops.add.slice(0, MAX_REMOTE_ADD) : null;
    const removeList = Array.isArray(ops.remove) ? ops.remove.slice(0, MAX_REMOTE_REMOVE) : null;
    if (replaceList?.length && !ops.clear) {
      const sanitizedReplace = replaceList
        .filter(s => s && Number.isInteger(s.i) && s.i >= 0 && s.i <= 1e7 && this._ids.has(s.i))
        .map(s => this.createStain(s));
      const replacedSet = new Set(sanitizedReplace.map(s => s.i));
      const pureRemove = removeList ? removeList.filter(id => !replacedSet.has(id)) : null;
      const pureAdd = addList
        ? addList
            .filter(s => s && Number.isInteger(s.i) && s.i >= 0 && s.i <= 1e7 && !replacedSet.has(s.i))
            .map(s => this.createStain(s))
            .filter(s => !this._ids.has(s.i))
        : null;
      if (pureAdd?.length) {
        for (const s of pureAdd) if (s.i >= this.nextId) this.nextId = s.i + 1;
      }
      this.applyBatch(
        { replace: sanitizedReplace, remove: pureRemove, add: pureAdd },
        { broadcast: false, persist: Boolean(game.user?.isGM && !this._readOnly) }
      );
      return;
    }
    if (ops.clear) {
      this._markAllBucketsDirty(); // BEFORE emptying — same reason as in clear()
      this.stains = [];
      this._ids.clear();
      this._idxById.clear();
      this._buckets.clear();
      this._grid.clear();
      this._oversizedCount = 0;
      this._snowCountNoFp = 0;
      this._snowCountAll = 0;
      this._maxS = 0;
      this._renderer?.clear();
    }
    let needRecalcMaxS = false;
    if (removeList?.length) {
      let minIdx = Infinity;
      const kill = new Set();
      for (let i = 0; i < removeList.length; i++) {
        const id = removeList[i];
        const idx = this._idxById.get(id);
        if (idx === undefined || kill.has(id)) continue;
        kill.add(id);
        if (idx < minIdx) minIdx = idx;
        const st = this.stains[idx];
        this._ids.delete(id);
        this._idxById.delete(id);
        this._gridRemove(st);
        this._bucketRemove(st);
        this._dirtyBuckets.add(bucketOf(id));
        if (Math.min(Number(st.s) || 0, MAX_STAIN_S) >= this._maxS) needRecalcMaxS = true;
      }
      if (minIdx < Infinity) {
        let w = minIdx;
        for (let r = minIdx; r < this.stains.length; r++) {
          const st = this.stains[r];
          if (!kill.has(st.i)) {
            this.stains[w] = st;
            this._idxById.set(st.i, w);
            w++;
          }
        }
        this.stains.length = w;
      }
      this._renderer?.removeStains(removeList);
    }
    if (addList?.length) {
      // sanitize via createStain: socket records must not sneak garbage
      // id/type/size into indices and flags; records without a valid id are
      // dropped (never mint a new id here — the id space belongs to the GM)
      const fresh = addList
        .filter(s => s && Number.isInteger(s.i) && s.i >= 0 && s.i <= 1e7)
        .map(s => this.createStain(s))
        .filter(s => !this._ids.has(s.i));
      for (const s of fresh) {
        if (s.i >= this.nextId) this.nextId = s.i + 1;
        this._ids.add(s.i);
        this._idxById.set(s.i, this.stains.length);
        this.stains.push(s);
        this._gridAdd(s);
        this._bucketAdd(s);
        this._dirtyBuckets.add(bucketOf(s.i));
      }
      this._renderer?.addStains(fresh);
    }
    if (needRecalcMaxS) this._recalcMaxS();
    // co-GM convergence: peer socket ops are also valid for the flag — a receiving
    // GM persists them (dirty-bucket dedup makes this idempotent)
    if (game.user.isGM && !this._readOnly) this._schedulePersist();
    if (ops.clear) this._changed('clear');
    else if (ops.add?.length || ops.remove?.length) this._changed('applyRemote', [...(ops.remove ?? [])]);
  }

  /** Reconcile against the scene flag (`updateScene`): diff by id and rebuild only affected chunks. */
  reconcile(data) {
    if (!data || !Array.isArray(data.stains)) return;
    const remote = data.stains;
    const remoteMap = new Map(remote.map(s => [s.i, s]));
    const localMap = new Map(this.stains.map(s => [s.i, s]));

    const added = remote.filter(s => !localMap.has(s.i));
    const removedIds = [];
    for (const id of localMap.keys()) if (!remoteMap.has(id)) removedIds.push(id);
    const changed = remote.filter(s => {
      const l = localMap.get(s.i);
      return l !== undefined && l !== s && !stainEquals(l, s);
    });

    if (added.length || removedIds.length || changed.length) {
      // "Young" IDs: socket ops minted AFTER the flag snapshot (`id >= flag.nextId`)
      // already exist on clients via socket, but haven't been flushed to the flag yet.
      // Without this guard, reconcile put them in removedIds — making stains flicker
      // away for ~3s on all clients until the next flush. Guard applies to REMOVALS
      // only: changed/added flag records are applied normally, while an erased young
      // stain survives until its removal flushes (<= PERSIST_DEBOUNCE_MS).
      const watermark = Number(data.nextId);
      const young = Number.isFinite(watermark) && watermark > 0
        ? (id) => id >= watermark
        : () => false;
      const aliveRemoved = removedIds.filter(id => !young(id));
      const changedIds = changed.map(s => s.i);
      const removeIds = [...aliveRemoved, ...changedIds];
      // mark BEFORE replacing: outgoing IDs may belong to buckets absent from
      // the new set — flush must explicitly DELETE those buckets from the flag
      // rather than only rewriting surviving ones
      this._markAllBucketsDirty();
      // carry surviving young stains over into the new set: the rebuild below
      // replaces `this.stains` with the flag contents, where they don't exist yet
      const youngLocal = removedIds.length > aliveRemoved.length
        ? this.stains.filter(s => young(s.i))
        : [];
      this.stains = [...remote.map(s => ({ ...s })), ...youngLocal];
      this._idsRebuild();
      this._gridRebuild();
      this._renderer?.removeStains(removeIds);
      // flag reconciliation = existing blood: no delayed appear animation;
      // invalidate = true because stains may have moved, so incremental overdraw is invalid
      this._renderer?.addStains([...changed, ...added], { defer: false, invalidate: true });
    }
    const nextId = Number(data.nextId) || 1;
    for (const s of this.stains) if (s.i >= this.nextId) this.nextId = s.i + 1;
    if (nextId > this.nextId) this.nextId = nextId;
  }

  /* ------------------------------ persistence ------------------------------ */

  load() {
    const scene = game.scenes.get(this.sceneId);
    const data = readBloodFlag(scene);
    if (!data) {
      // pristine: treat v2/nextId as already persisted so flushing an empty
      // store never stamps metadata onto scenes that never had blood.
      // `_pristine` repays that debt on the FIRST real write (stamping `v`)
      this._persisted = { v: 2, nextId: this.nextId };
      this._pristine = true;
      return;
    }
    if (data.newer) {
      // flag was written by a NEWER module version: read and render, but do not
      // write — otherwise the first flush would silently downgrade v3+ to v2 semantics
      this._readOnly = true;
      console.warn(`${MODULE_ID} | blood flag version ${data.v} is newer than supported (2) — blood is read-only until the module is updated`);
    }
    this.stains = data.stains.map(s => ({ ...s }));
    // spreading a huge legacy v1 flag overflowed the call stack (argument count
    // limit) — use the same loop pattern as reconcile/applyRemote
    let maxId = 0;
    for (const s of this.stains) if (s.i > maxId) maxId = s.i;
    // MAX of flag's nextId and maxId+1: a GM crash between writing a bucket
    // (id >= 7500) and writing nextId (stale 5000 — buckets write before metadata)
    // would otherwise leave the stale nextId authoritative, causing createStain
    // to mint EXISTING IDs and silently drop new stains
    this.nextId = Math.max(data.nextId || 0, maxId + 1) || 1;
    this._idsRebuild();
    this._gridRebuild();
    // buckets ALREADY present in the flag (keys b0, b1, … = bucketOf(id)): without
    // this, clear() before the first flush wouldn't know about some existing buckets
    // and they would remain in the flag forever
    const raw = scene?.flags?.[MODULE_ID]?.[FLAG_KEY];
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        if (key[0] === 'b' && /^\d+$/.test(key.slice(1))) this._knownBuckets.add(Number(key.slice(1)));
      }
    }
    this._persisted.v = data.v;
    this._persisted.nextId = data.nextId; // 0 = absent in flag → flush will write the computed value
    if (data.legacy) {
      // legacy v1: records are loaded into `this.stains` and migrate to buckets on first flush
      this._legacyFlag = true;
      this._markAllBucketsDirty();
    }
  }

  _schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.flush(); }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Immediately persist dirty state to scene flags (chained so writes never race).
   * Returns the tail of the persistence promise chain (`await blood.flush()`
   * guarantees everything queued so far has been written).
   * v2: writes only DIRTY 2000-id buckets (deleting emptied ones), then writes
   * `nextId`/`v` metadata last and only when changed. If nothing is dirty, the
   * scene flag is untouched (bloodless scenes receive no metadata). A failed
   * write puts buckets back into `_dirtyBuckets` for retry rather than losing data.
   */
  flush() {
    if (!game.user.isGM || this._readOnly) return;
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    const scene = game.scenes.get(this.sceneId);
    if (!scene) return;

    const dirty = [...this._dirtyBuckets].sort((a, b) => a - b);
    const legacy = this._legacyFlag;
    const persisted = this._persisted;
    const writeNextId = persisted.nextId !== this.nextId;
    // a pristine store owes a `v` stamp: the first real write stamps our flag
    // version (otherwise the flag would live without `v` until the next session)
    const writeVersion = persisted.v !== 2 || (this._pristine && dirty.length > 0);
    if (!dirty.length && !legacy && !writeNextId && !writeVersion) return this._persisting;
    this._pristine = false;

    this._dirtyBuckets.clear();
    this._legacyFlag = false;
    const nextId = this.nextId;
    const byBucket = new Map();
    if (dirty.length) {
      for (const b of dirty) {
        const bset = this._buckets.get(b);
        if (bset && bset.size) {
          byBucket.set(b, [...bset]);
        }
      }
    }

    this._persisting = this._persisting.then(async () => {
      try {
        for (const b of dirty) {
          const list = byBucket.get(b);
          if (list) {
            await scene.setFlag(MODULE_ID, `${FLAG_KEY}.b${b}`, { stains: list });
            this._knownBuckets.add(b);
          } else {
            await scene.setFlag(MODULE_ID, `${FLAG_KEY}.b${b}`, null); // empty bucket — delete key
            this._knownBuckets.delete(b);
          }
        }
        if (legacy) await scene.setFlag(MODULE_ID, `${FLAG_KEY}.stains`, null); // legacy array migrated into buckets
        if (writeNextId) {
          await scene.setFlag(MODULE_ID, `${FLAG_KEY}.nextId`, nextId);
          persisted.nextId = nextId;
        }
        if (writeVersion) {
          await scene.setFlag(MODULE_ID, `${FLAG_KEY}.v`, 2);
          persisted.v = 2;
        }
        this._flushRetries = 0;
      } catch (e) {
        console.warn(`${MODULE_ID} | blood persist failed`, e);
        // restore unwritten state: retry on next mutation instead of losing data
        for (const b of dirty) this._dirtyBuckets.add(b);
        if (legacy) this._legacyFlag = true;
        // bounded self-retry: a transient failure (network, DB) won't leave
        // trailing changes unsaved until an arbitrary future mutation
        if (this._flushRetries < FLUSH_MAX_RETRIES) {
          this._flushRetries++;
          this._schedulePersist();
        }
      }
    });
    return this._persisting;
  }

  destroy() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this.flush();
  }
}
