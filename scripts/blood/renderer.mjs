/**
 * Blood renderer: chunked Canvas2D baking + one PIXI sprite per chunk.
 *
 * Optimized for thousands of stains: each stain is drawn into its chunk's
 * offscreen canvas (1024 scene px) ONCE when it appears; only a handful of
 * static chunk sprites participate in each canvas frame. Render cost is
 * independent of blood volume — 10 or 1000 stains run at the same FPS.
 *
 * Layers live in canvas.primary (sortLayer TILES+1): ONE container per
 * distinct elevation. The primary group's native comparator sorts them by
 * elevation (`elevation || sortLayer || …`): blood renders ABOVE its surface
 * tile and BELOW tokens standing at that elevation; elevation 0 behaves
 * identically to the legacy single container. Mutations coalesce into a single
 * flush per frame (ticker). Empty chunks are destroyed to reclaim memory.
 *
 * Determinism: the entire stain shape is derived from st.seed via Rng; draw
 * order is ascending by id. Identical inputs yield pixel-identical output on
 * every client.
 */
import { MODULE_ID } from '../config.mjs';
import { BloodAtlas } from './textures.mjs';
import { Rng } from './rng.mjs';
import { STAIN, FP_KIND_BY_SUBTYPE } from './stains.mjs';
import { spawnStepPuff } from './particles.mjs';
import { parseColor, shadeHex } from './colors.mjs';
import { sceneWeatherInfo } from './util.mjs';
import { isStainVisibleOnLevel } from './elevation.mjs';
const CHUNK = 1024;
const KIND_BY_TYPE = ['splat', 'splash', 'smear', 'pool', 'droplet', 'footprint', 'drip', 'handprint'];
const FLUSH_BUDGET = 8; // max redrawn chunks per frame (remainder rolls over to next frame)
const FLUSH_TIME_BUDGET_MS = 8; // wall-clock cap: a dense full bake takes 0.3–4+ ms, so 8 per frame blew the frame budget
const OVERLAY_FLUSH_BUDGET = 2; // overlays cost far more than chunks (full bake + GPU texture upload)
const OVERLAY_MAX_PX = 2048; // pixel cap for an overlay's longest side (memory/upload)
const OVERLAY_UPLOAD_MS = 66; // GPU texture upload throttle for overlays (~15/s)
const FADE_STEPS = 16; // fade-in quantization steps (floor chunks): ~16 redraws
const FADE_STEPS_OVERLAY = 8; // tile overlays: full-area rebake — half as many steps
// clamp sample span radius: an unsanitized `s` from a flag would blow up grid
// iteration loops into a minute-long freeze
const MAX_SPAN_R = 8192;
// tile overlay: margin past the tile bounds for satellite droplets (clipped afterward)
const OVERLAY_PAD = 256;
const TAU = Math.PI * 2;
const SNOW_TONE_FAMILIES = Object.freeze([
    { flatEdge: '#8e98a6', frost: '#bcc4d0', flat: '#ccd4e0' },
    { flatEdge: '#8a94a2', frost: '#b6beca', flat: '#c8d0dc' },
    { flatEdge: '#92969e', frost: '#c0c4cc', flat: '#d0d4dc' },
    { flatEdge: '#8892a0', frost: '#b4bcc8', flat: '#c6ceda' },
    { flatEdge: '#909aa8', frost: '#bec6d2', flat: '#ced6e2' },
    { flatEdge: '#8c96a4', frost: '#b8c0cc', flat: '#cad2de' }
]);
const _key = (e, cx, cy, lvl = '') => (lvl ? `${e}|${cx},${cy}|${lvl}` : `${e}|${cx},${cy}`);
const _elevKey = (e, lvl = '') => (lvl ? `${e}|${lvl}` : (Number(e) || 0));
/** Step puff toggle (separate from hit bursts so walking noise can be muted independently). */
const _stepPuffsOn = () => {
    try {
        return game.settings.get(MODULE_ID, 'bloodStepPuffs') ?? true;
    }
    catch {
        return true;
    }
};
/* ----------------------- aging (drying) and weather ----------------------- */
const _worldTime = () => {
    try {
        return Number(game.time?.worldTime) || 0;
    }
    catch {
        return 0;
    }
};
/** In-game hours until blood dries completely (0 = aging disabled). */
const _dryHours = () => {
    try {
        return Number(game.settings.get(MODULE_ID, 'bloodDryHours')) || 0;
    }
    catch {
        return 0;
    }
};
const _agingOn = () => {
    try {
        return game.settings.get(MODULE_ID, 'bloodAging') ?? true;
    }
    catch {
        return true;
    }
};
/**
 * Stain dryness factor 0..1: fresh → dried over world time elapsed since record T.
 * Blood only (m 0/unset); snow does not "dry". Records without T (legacy) do not
 * age — otherwise all accumulated blood would snap-dry at once.
 * Paused world time → blood does not age (just as snow stops accumulating).
 * Context ({on, hours, wt}) is snapshotted ONCE per flush (see flush()): three
 * settings.get/worldTime calls per stain were noticeable on a 10k full bake.
 */
function _dryK(renderer, st) {
    const age = renderer._age;
    if (!age.on || age.hours <= 0)
        return 0;
    if (!Number.isFinite(st.T))
        return 0;
    const mat = Number(st.m) || 0;
    if (mat !== 0)
        return 0;
    const dt = age.wt - st.T;
    if (dt <= 0)
        return 0;
    return Math.min(1, dt / (age.hours * 3600));
}
/**
 * Rain washout multiplier 0.45..1 (blood pales in a downpour). Purely a RENDERING
 * multiplier, not stored data: once rain stops, blood is permanently "washed away"
 * only via data deletion, while surviving stains regain contrast — a pragmatic
 * decal trade-off versus rewriting thousands of records.
 * Evaluated once per full chunk bake (cached on `this._wash`), not per stain.
 */
const RAIN_WASH_HOURS = 4; // hours of rain until minimum contrast
const RAIN_WASH_MIN = 0.45;
function _washK() {
    try {
        if (!sceneWeatherInfo(canvas.scene).rain)
            return 1;
        if (!(game.settings.get(MODULE_ID, 'bloodRainWash') ?? true))
            return 1;
        const t0 = canvas.scene?.getFlag?.(MODULE_ID, 'bloodRain')?.t;
        if (!Number.isFinite(t0))
            return 1;
        const dt = Math.max(0, _worldTime() - t0);
        return Math.max(RAIN_WASH_MIN, 1 - 0.55 * Math.min(1, dt / (RAIN_WASH_HOURS * 3600)));
    }
    catch {
        return 1;
    }
}
// Scratch RNG: allocation-free mulberry32 per stain (a full bake of 5-10k
// stains previously allocated as many objects — causing GC sawtooth on scene load).
// Reentrancy-safe: _drawStain is non-recursive.
const _scratchRng = new Rng(1);
/**
 * Binary search for a stain by id inside a chunk's sorted member array (`_sorted`).
 * Returns index `>= 0` if found, or `~lo` (`-(lo + 1) < 0`) for the insertion point.
 * Enables O(log M) (~12 comparisons) deletion/update/insertion of non-monotonic IDs
 * without invalidating the cache to null or running `[...set].sort()` over thousands of elements per step.
 */
function _bsearchId(arr, id) {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const midId = arr[mid].i;
        if (midId < id)
            lo = mid + 1;
        else if (midId > id)
            hi = mid - 1;
        else
            return mid;
    }
    return ~lo;
}
/**
 * Quantize deferred step wake-up time (d) onto a 32 ms grid:
 * adjacent sub-steps wake synchronously on a SINGLE tick and coalesce
 * into one chunk bake and one GPU texture upload.
 */
function _quantizeDue(now, delay) {
    return delay >= 32 ? Math.ceil((now + delay) / 32) * 32 : now + delay;
}
export class BloodRenderer {
    /** @param {{scale?: number}} opts bake resolution scale (0.25..1) */
    constructor({ scale = 0.5 } = {}) {
        this.scale = Math.min(1, Math.max(0.25, Number(scale) || 0.5));
        this.stains = [];
        this.chunks = new Map();
        this._dirty = new Set();
        this._dirtyRects = new Map(); // chunkKey → { x0, y0, x1, y1 } | null (null = full chunk)
        this._flushScheduled = false;
        this._destroyed = false;
        this._deferred = []; // stains awaiting delayed spawn (d): { st, due, replacePrev? }
        this._deferredIds = new Set();
        this._replacedHold = new Map(); // id → snapshot of removed stain during two-step replacement (removeStains + addStains with d > 0)
        this._fading = new Map(); // i → { start, ms, grow, st } (st is a direct reference, avoiding O(N) lookup)
        this._clock = null; // ticker callback for deferred/fading stains
        this._ids = new Set(); // activated IDs — O(1) dedup in addStains
        this._stainIdx = new Map(); // id → index in this.stains (O(1) removal/replacement without indexOf/filter)
        this._stainById = new Map(); // id → stain object
        this._members = new Map(); // chunkKey → Set<stain>: flush touches only that chunk's OWN members
        // sorted array cache of the same set: maintained in O(1) on append
        // and O(log M) via binary search on removals/replacements without re-sorting
        this._sorted = new Map();
        this._carveMembers = new Map(); // chunkKey → Set<stain>: depressed snow footprints/trenches only (O(1) lookup without scanning all 2000 drifts in a chunk!)
        this._bloodCounts = new Map(); // chunkKey → count of blood stains (m === 0) in chunk (for targeted refreshAging without touching snow)
        this._nonSnowCounts = new Map(); // chunkKey → count of non-snow stains (m !== 2) in chunk
        this._lowSnowCounts = new Map(); // chunkKey → count of light/medium snow cover stains (m === 2, lv <= 2) in chunk
        this._driftCounts = new Map(); // chunkKey → count of snowdrift stains (m === 2, lv >= 3) in chunk
        this._currentDriftPass = null; // active topographic snowdrift pass ('ao' | 'bank' | 'terrace' | 'plateau' | 'crest' | 'mask' | null)
        this._fullRedraw = new Set(); // chunks requiring redraw (localized via _dirtyRects or full-chunk)
        this._opaqueTex = new Map(); // texture.uuid → true: fully opaque textures (alpha mask is a no-op)
        this._scratchCarve = null; // lazy offscreen canvas for pixel-perfect, non-self-overlapping depressed snow rendering
        this._scratchMask = null; // lazy offscreen canvas for existing snow alpha mask
        this._scratchOverlayCarve = null; // lazy offscreen canvas for 3D snow trenches on tiles (st.tid)
        this._scratchOverlayMask = null; // lazy offscreen canvas for snow alpha mask on tiles
        this._lastSnowPuffAt = 0; // throttle timestamp for snow puffs while carving trenches
        this._flushOnce = () => this.flush();
        // elevation layers: ONE direct child of canvas.primary per distinct elevation
        // value (created lazily). The primary-group comparator compares elevation FIRST —
        // an elevation-10 container renders above everything at 0 (tiles, floor, floor blood)
        // and beneath tokens at elevation 10
        this._elevContainers = new Map(); // elevation → PIXI.Container
        this._sortLayer = null; // TILES+1; null = primary sort unavailable, falls back to zIndex
        this._sort = 1e100;
        this._wash = 1; // rain washout multiplier (recomputed in flush())
        this._age = { on: true, hours: 12, wt: 0 }; // aging snapshot (updated in flush())
        // tile-attached blood (st.tid): baked into an OVERLAY LAYER parented directly
        // to the tile's own mesh — dragging/rotating/hiding the tile moves the blood
        // instantaneously with zero debounce. tid → record
        this._overlays = new Map();
        try {
            const layers = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS;
            this._sortLayer = layers.TILES + 1;
        }
        catch (e) {
            console.debug(`${MODULE_ID} | blood layer sort fallback:`, e?.message ?? e);
        }
    }
    /** Direct child container of canvas.primary at elevation `e` (lazy). */
    _elevContainer(e, lvl = '') {
        const key = _elevKey(e, lvl);
        let c = this._elevContainers.get(key);
        if (c)
            return c;
        c = new PIXI.Container();
        c.name = lvl ? `showstopperBlood@${e}@${lvl}` : `showstopperBlood@${e}`;
        c.interactiveChildren = false;
        try {
            canvas.primary.addChild(c);
        }
        catch { /* empty */ }
        if (this._sortLayer != null) {
            c.sortLayer = this._sortLayer;
            c.sort = this._sort;
            c.elevation = e; // keep 0 explicit so blood neither sinks nor floats in the comparator
        }
        else {
            c.zIndex = 1e8; // fallback if the primary-group sorting API changes
        }
        this._elevContainers.set(key, c);
        return c;
    }
    get chunkPixelSize() { return Math.round(CHUNK * this.scale); }
    get stats() {
        return { stains: this.stains.length, chunks: this.chunks.size, scale: this.scale, overlays: this._overlays.size };
    }
    /** Stains awaiting delayed appearance (`d` field) — the eraser must reach
     *  them too, even though they enter `this.stains` only once due. */
    get deferredStains() {
        return this._deferred.map(e => e.st);
    }
    /* --------------------- tile overlays (tile-attached blood) --------------------- */
    _overlayKey(tid) { return `o:${tid}`; }
    _findTile(tid) {
        try {
            return canvas.tiles?.placeables?.find(p => p.document?.id === tid) ?? null;
        }
        catch {
            return null;
        }
    }
    _overlayRecord(tid) {
        let rec = this._overlays.get(tid);
        if (!rec) {
            rec = {
                tid,
                tile: this._findTile(tid),
                stains: new Set(), // stain record objects belonging to this tile
                canvas: null, ctx: null, tex: null, sprite: null,
                k: 0, lx0: 0, ly0: 0, lw: 0, lh: 0,
                maxId: 0, needFull: true
            };
            this._overlays.set(tid, rec);
        }
        return rec;
    }
    /** Stain influence radius in scene coordinates (accounting for the wide 1.38× / 1.24× snow trench berm and lv=2..5 drift offsets). */
    _stainSpanRadius(st) {
        const s = Number(st?.s) || 0;
        if (Number(st?.m) === 2) {
            if (st.t === STAIN.SMEAR && !(st.lv >= 3) && st.c !== '#e8ecf2e0') {
                return Math.min(s * 1.26 + 18, MAX_SPAN_R);
            }
            if (st.lv >= 3) {
                const tier = Math.min(5, st.lv) - 2; // 1 (lv=3), 2 (lv=4), 3 (lv=5)
                return Math.min(s * (0.98 + tier * 0.15) + 14 + tier * 4, MAX_SPAN_R);
            }
            if (st.lv === 2) {
                return Math.min(s * 1.02 + 14, MAX_SPAN_R);
            }
        }
        return Math.min(s * 0.92 + 12, MAX_SPAN_R);
    }
    /** Dirty routing: tile-attached blood marks the overlay key; floor blood marks chunks. */
    _touchStain(st) {
        if (st.tid)
            this._dirty.add(this._overlayKey(st.tid));
        else
            this._touch(st.x, st.y, this._stainSpanRadius(st), Number(st.e) || 0, st.lvl || '');
    }
    /**
     * Record a localized redraw rectangle (dirty-rect) for stain `st` in all affected chunks.
     * If `_dirtyRects` already holds `null` for a chunk (full-chunk rebake required),
     * it stays `null`. Otherwise the bbox expands to cover the stain's span (including 1.38× snow trench berms).
     */
    _markDirtyStain(st, keys = null) {
        if (!st || st.tid)
            return;
        const r = this._stainSpanRadius(st);
        const x0 = st.x - r, y0 = st.y - r, x1 = st.x + r, y1 = st.y + r;
        for (const key of keys ?? this._memberKeys(st)) {
            this._fullRedraw.add(key);
            if (this._dirtyRects.has(key)) {
                const cur = this._dirtyRects.get(key);
                if (cur === null)
                    continue; // already marked for full-chunk redraw
                if (x0 < cur.x0)
                    cur.x0 = x0;
                if (y0 < cur.y0)
                    cur.y0 = y0;
                if (x1 > cur.x1)
                    cur.x1 = x1;
                if (y1 > cur.y1)
                    cur.y1 = y1;
            }
            else {
                this._dirtyRects.set(key, { x0, y0, x1, y1 });
            }
        }
    }
    /** Unconditionally mark a chunk for a full-area rebake (1024×1024). */
    _markFullChunk(key) {
        this._fullRedraw.add(key);
        this._dirtyRects.set(key, null);
        const chunk = this.chunks.get(key);
        if (chunk) {
            chunk.base = null;
            chunk.baseMinFade = 0;
            chunk.snowBaseValid = false;
            chunk.snowBaseDirty = true;
            chunk.snowBaseDirtyRect = null;
        }
    }
    /** Invalidate a chunk's cached non-carved snow base layer when a base stain is removed or replaced. */
    _invalidateSnowBaseForStain(st, keys = null) {
        if (!st || st.tid || this._isSnowCarveStain(st))
            return;
        const r = this._stainSpanRadius(st);
        const x0 = st.x - r, y0 = st.y - r, x1 = st.x + r, y1 = st.y + r;
        for (const key of keys ?? this._memberKeys(st)) {
            const chunk = this.chunks.get(key);
            if (chunk) {
                if (chunk.snowBaseValid && chunk.snowBase) {
                    const cur = chunk.snowBaseDirtyRect;
                    if (cur) {
                        if (x0 < cur.x0)
                            cur.x0 = x0;
                        if (y0 < cur.y0)
                            cur.y0 = y0;
                        if (x1 > cur.x1)
                            cur.x1 = x1;
                        if (y1 > cur.y1)
                            cur.y1 = y1;
                    }
                    else {
                        chunk.snowBaseDirtyRect = { x0, y0, x1, y1 };
                    }
                }
                else {
                    chunk.snowBaseValid = false;
                    chunk.snowBaseDirty = true;
                    chunk.snowBaseDirtyRect = null;
                }
            }
        }
    }
    /** Force-upload dirty overlay textures (end of brush stroke — ensures exact state). */
    flushOverlays() {
        if (this._destroyed)
            return;
        for (const rec of this._overlays.values()) {
            if (rec.texDirty && rec.tex) {
                this._updateTex(rec.tex);
                rec.texDirty = false;
                clearTimeout(rec.uploadTimer);
                rec.uploadTimer = null;
            }
        }
    }
    /** Rebake a tile overlay layer: its mesh may have been recreated (texture/document change). */
    touchOverlay(tid) {
        if (this._destroyed)
            return;
        const rec = this._overlays.get(tid);
        if (!rec)
            return;
        rec.needFull = true; // mesh may have been recreated/resized — full bake required
        this._dirty.add(this._overlayKey(tid));
        this._requestFlush();
    }
    /* --------------------- O(1) management of this.stains --------------------- */
    _pushStain(st) {
        this._stainIdx.set(st.i, this.stains.length);
        this._stainById.set(st.i, st);
        this.stains.push(st);
    }
    _replaceStainInPlace(prev, next) {
        const idx = this._stainIdx.get(prev.i);
        if (idx !== undefined) {
            this.stains[idx] = next;
            this._stainById.set(next.i, next);
        }
        else {
            this._pushStain(next);
        }
    }
    _removeSingleStain(st) {
        const idx = this._stainIdx.get(st.i);
        if (idx === undefined)
            return;
        const lastIdx = this.stains.length - 1;
        if (idx !== lastIdx) {
            const tailSt = this.stains[lastIdx];
            this.stains[idx] = tailSt;
            this._stainIdx.set(tailSt.i, idx);
        }
        this.stains.pop();
        this._stainIdx.delete(st.i);
        this._stainById.delete(st.i);
    }
    /* -------------------------------- mutations -------------------------------- */
    /**
     * Batched atomic mutation from `BloodStore.applyBatch`:
     *  - `replacedPrev` / `replacedNext`: same-id stains (trampled snow):
     *    - if `next.d > 0` (progressive step): the old stain `prev` stays in place until `due`
     *      WITHOUT spuriously rebaking all route chunks on frame 0!
     *    - if `next.d` is absent: replaced in-place in O(1) in `this.stains` and O(log M) in `_sorted`,
     *      confining redraw to the stain's localized `dirtyRect`.
     *  - `removedIds`: stain IDs to remove;
     *  - `added`: newly minted stains (footprints, trenches).
     */
    applyBatch({ replacedPrev = [], replacedNext = [], removedIds = [], added = [] } = {}) {
        if (this._destroyed)
            return;
        const now = performance.now();
        for (let i = 0; i < replacedNext.length; i++) {
            const prev = replacedPrev[i];
            const next = replacedNext[i];
            if (!prev || !next)
                continue;
            if (!isStainVisibleOnLevel(next)) {
                if (this._ids.has(prev.i) || this._deferredIds.has(prev.i))
                    this.removeStains([prev.i]);
                continue;
            }
            const delay = Number(next.d) || 0;
            if (delay > 0) {
                // If a deferred replacement is already pending for this ID, update its target state in place
                if (this._deferredIds.has(next.i)) {
                    for (let d = this._deferred.length - 1; d >= 0; d--) {
                        if (this._deferred[d].st.i === next.i) {
                            this._deferred[d].st = next;
                            if (now + delay < this._deferred[d].due) {
                                this._deferred[d].due = _quantizeDue(now, delay);
                            }
                            break;
                        }
                    }
                }
                else {
                    this._deferred.push({ st: next, due: _quantizeDue(now, delay), replacePrev: prev });
                    this._deferredIds.add(next.i);
                }
            }
            else {
                this._replaceStainInPlace(prev, next);
                if (prev.tid || next.tid) {
                    if (prev.tid) {
                        const rec = this._overlays.get(prev.tid);
                        if (rec) {
                            rec.stains.delete(prev);
                            rec.needFull = true;
                        }
                        this._dirty.add(this._overlayKey(prev.tid));
                    }
                    if (next.tid) {
                        this._overlayRecord(next.tid).stains.add(next);
                        this._dirty.add(this._overlayKey(next.tid));
                    }
                }
                else {
                    this._replaceIndexedStain(prev, next);
                    this._invalidateSnowBaseForStain(prev);
                    this._invalidateSnowBaseForStain(next);
                    this._markDirtyStain(prev);
                    this._markDirtyStain(next);
                    this._touchStain(prev);
                    this._touchStain(next);
                }
            }
        }
        if (removedIds.length) {
            this.removeStains(removedIds);
            this._replacedHold.clear();
        }
        if (added.length) {
            this.addStains(added, { defer: true });
        }
        else {
            this._ensureClock();
            this._requestFlush();
        }
    }
    /**
     * Add stains. `defer=true` (live stream) schedules stains carrying `d` (ms delay);
     * the rebuild path passes `defer=false` (old blood draws immediately).
     * `invalidate=true` (reconcile: stains may be MOVES sharing the same ID) forces
     * full chunk redraws and disables the tail-append fast path for affected chunks.
     */
    addStains(list, { defer = true, invalidate = false } = {}) {
        if (this._destroyed || !Array.isArray(list))
            return;
        const now = performance.now();
        for (const st of list) {
            if (!st || !isStainVisibleOnLevel(st) || this._ids.has(st.i) || this._deferredIds.has(st.i))
                continue;
            if (invalidate) {
                if (st.tid) {
                    const rec = this._overlays.get(st.tid);
                    if (rec)
                        rec.needFull = true;
                    this._dirty.add(this._overlayKey(st.tid));
                }
                else {
                    for (const key of this._memberKeys(st))
                        this._markFullChunk(key);
                }
            }
            const delay = defer ? Number(st.d) : 0;
            if (delay > 0) {
                const hold = this._replacedHold.get(st.i);
                if (hold) {
                    this._replacedHold.delete(st.i);
                    const prevSt = hold.st;
                    // Restore the old stain without marking chunks dirty on frame 0:
                    // visually nothing has changed yet, and it will be swapped only once `due` arrives!
                    this._pushStain(prevSt);
                    this._ids.add(prevSt.i);
                    if (prevSt.tid) {
                        const rec = this._overlayRecord(prevSt.tid);
                        rec.stains.add(prevSt);
                        rec.needFull = hold.wasNeedFull;
                        if (!hold.wasDirty)
                            this._dirty.delete(this._overlayKey(prevSt.tid));
                    }
                    else {
                        this._indexStain(prevSt);
                        for (const snap of hold.chunkSnaps) {
                            if (!snap.wasFull)
                                this._fullRedraw.delete(snap.key);
                            if (!snap.wasDirty)
                                this._dirty.delete(snap.key);
                            if (snap.hadRect) {
                                this._dirtyRects.set(snap.key, snap.prevRect ? { ...snap.prevRect } : null);
                            }
                            else {
                                this._dirtyRects.delete(snap.key);
                            }
                            const ch = this.chunks.get(snap.key);
                            if (ch)
                                ch.snowBaseValid = snap.wasSnowBaseValid;
                        }
                    }
                    this._deferred.push({ st, due: _quantizeDue(now, delay), replacePrev: prevSt });
                    this._deferredIds.add(st.i);
                }
                else {
                    this._deferred.push({ st, due: _quantizeDue(now, delay) });
                    this._deferredIds.add(st.i);
                }
            }
            else {
                this._replacedHold.delete(st.i);
                this._activate(st, now, defer);
            }
        }
        this._replacedHold.clear();
        this._ensureClock();
        this._requestFlush();
    }
    /* --------------------- chunk → members index --------------------- */
    /** Chunks whose bake overlaps the stain (same grid span formula as `_touch`). */
    _memberKeys(st) {
        const r = this._stainSpanRadius(st);
        const e = Number(st.e) || 0;
        const lvl = st.lvl || '';
        const keys = [];
        const cx0 = Math.floor((st.x - r) / CHUNK), cx1 = Math.floor((st.x + r) / CHUNK);
        const cy0 = Math.floor((st.y - r) / CHUNK), cy1 = Math.floor((st.y + r) / CHUNK);
        for (let cx = cx0; cx <= cx1; cx++) {
            for (let cy = cy0; cy <= cy1; cy++)
                keys.push(_key(e, cx, cy, lvl));
        }
        return keys;
    }
    _indexStain(st) {
        const isCarve = this._isSnowCarveStain(st);
        const mat = Number(st.m) || 0;
        const isBlood = mat === 0;
        const isNonSnow = mat !== 2;
        const isLowSnow = !isCarve && mat === 2 && (st.lv || 1) <= 2;
        const isDrift = !isCarve && mat === 2 && (st.lv || 1) >= 3;
        for (const key of this._memberKeys(st)) {
            let set = this._members.get(key);
            if (!set) {
                set = new Set();
                this._members.set(key, set);
            }
            const added = !set.has(st);
            set.add(st);
            if (added) {
                if (isBlood)
                    this._bloodCounts.set(key, (this._bloodCounts.get(key) || 0) + 1);
                if (isNonSnow)
                    this._nonSnowCounts.set(key, (this._nonSnowCounts.get(key) || 0) + 1);
                if (isLowSnow)
                    this._lowSnowCounts.set(key, (this._lowSnowCounts.get(key) || 0) + 1);
                if (isDrift)
                    this._driftCounts.set(key, (this._driftCounts.get(key) || 0) + 1);
            }
            if (isCarve) {
                let cset = this._carveMembers.get(key);
                if (!cset) {
                    cset = new Set();
                    this._carveMembers.set(key, cset);
                }
                cset.add(st);
            }
            const arr = this._sorted.get(key);
            if (arr) {
                // append keeps the array sorted in O(1); out-of-order IDs insert via
                // binary search in O(log M) without invalidating the cache to null
                if (!arr.length || st.i > arr[arr.length - 1].i) {
                    arr.push(st);
                }
                else {
                    const pos = _bsearchId(arr, st.i);
                    if (pos >= 0)
                        arr[pos] = st;
                    else
                        arr.splice(~pos, 0, st);
                }
            }
        }
    }
    _unindexStain(st, keys = null) {
        const isCarve = this._isSnowCarveStain(st);
        const mat = Number(st.m) || 0;
        const isBlood = mat === 0;
        const isNonSnow = mat !== 2;
        const isLowSnow = !isCarve && mat === 2 && (st.lv || 1) <= 2;
        const isDrift = !isCarve && mat === 2 && (st.lv || 1) >= 3;
        for (const key of keys ?? this._memberKeys(st)) {
            if (isCarve) {
                const cset = this._carveMembers.get(key);
                if (cset) {
                    cset.delete(st);
                    if (!cset.size)
                        this._carveMembers.delete(key);
                }
            }
            const set = this._members.get(key);
            if (!set || !set.delete(st))
                continue;
            if (isBlood) {
                const bc = (this._bloodCounts.get(key) || 1) - 1;
                if (bc > 0)
                    this._bloodCounts.set(key, bc);
                else
                    this._bloodCounts.delete(key);
            }
            if (isNonSnow) {
                const nsc = (this._nonSnowCounts.get(key) || 1) - 1;
                if (nsc > 0)
                    this._nonSnowCounts.set(key, nsc);
                else
                    this._nonSnowCounts.delete(key);
            }
            if (isLowSnow) {
                const lsc = (this._lowSnowCounts.get(key) || 1) - 1;
                if (lsc > 0)
                    this._lowSnowCounts.set(key, lsc);
                else
                    this._lowSnowCounts.delete(key);
            }
            if (isDrift) {
                const dc = (this._driftCounts.get(key) || 1) - 1;
                if (dc > 0)
                    this._driftCounts.set(key, dc);
                else
                    this._driftCounts.delete(key);
            }
            if (!set.size) {
                this._members.delete(key);
                this._sorted.delete(key);
                continue;
            }
            const arr = this._sorted.get(key);
            if (arr) {
                const pos = _bsearchId(arr, st.i);
                if (pos >= 0)
                    arr.splice(pos, 1);
            }
        }
    }
    /** Fast O(log M) replacement of a same-ID stain inside chunk member indices. */
    _replaceIndexedStain(prev, next) {
        const prevKeys = this._memberKeys(prev);
        const nextKeys = this._memberKeys(next);
        const prevCarve = this._isSnowCarveStain(prev);
        const nextCarve = this._isSnowCarveStain(next);
        const prevMat = Number(prev.m) || 0;
        const nextMat = Number(next.m) || 0;
        const prevLv = prev.lv || 1;
        const nextLv = next.lv || 1;
        if (prevCarve === nextCarve &&
            prevMat === nextMat &&
            prevLv === nextLv &&
            prevKeys.length === nextKeys.length &&
            prevKeys.every((k, i) => k === nextKeys[i])) {
            for (const key of prevKeys) {
                const set = this._members.get(key);
                if (set) {
                    set.delete(prev);
                    set.add(next);
                }
                if (prevCarve) {
                    const cset = this._carveMembers.get(key);
                    if (cset) {
                        cset.delete(prev);
                        cset.add(next);
                    }
                }
                const arr = this._sorted.get(key);
                if (arr) {
                    const pos = _bsearchId(arr, prev.i);
                    if (pos >= 0)
                        arr[pos] = next;
                    else
                        arr.splice(~pos, 0, next);
                }
            }
        }
        else {
            this._unindexStain(prev, prevKeys);
            this._indexStain(next);
        }
    }
    /** Chunk members sorted ascending by id (cached; Set remains the source of truth). */
    _membersSorted(key) {
        const set = this._members.get(key);
        if (!set)
            return [];
        let arr = this._sorted.get(key);
        if (!arr) {
            arr = [...set].sort((a, b) => a.i - b.i);
            this._sorted.set(key, arr);
        }
        return arr;
    }
    /** @param {boolean} live live stream (not rebuild): footprints spawn step puffs,
     *  and stains with `f`/`g` play fade/grow animations. Rebuild/reconcile (`live=false`)
     *  renders existing blood INSTANTLY without re-fading on every scene load. */
    _activate(st, now, live = false) {
        this._pushStain(st);
        this._ids.add(st.i);
        this._deferredIds.delete(st.i);
        const keys = st.tid ? null : this._memberKeys(st);
        if (st.tid) {
            const rec = this._overlayRecord(st.tid);
            rec.stains.add(st);
            if (rec.maxId > 0 && st.i <= rec.maxId)
                rec.needFull = true;
        }
        else
            this._indexStain(st);
        if (live && Number(st.f) > 0) {
            this._fading.set(st.i, { start: now, ms: Number(st.f), grow: !!st.g, st, step: -1 });
        }
        if (live && st.t === STAIN.FOOTPRINT && (Number(st.a) || 0) >= 0.55 && _stepPuffsOn()) {
            // step puff only on FRESH footprints (alpha 0.55–0.7): fading sole wear-off
            // (a ≤ 0.5) spawning full-color clouds on every step is visual noise;
            // also gated by the step-puff setting (separate from hit bursts)
            try {
                spawnStepPuff({ x: st.x, y: st.y, color: st.c, material: st.m, seed: st.seed ^ 0x5eed, size: st.s * 1.6, dir: st.r, elevation: Number(st.e) || 0, level: st.lvl ?? null });
            }
            catch { /* cosmetics must never crash rendering */ }
        }
        else if (live && Number(st.m) === 2 && st.t === STAIN.SMEAR && !(st.lv >= 3) && st.c !== '#e8ecf2e0' && _stepPuffsOn()) {
            if (now - this._lastSnowPuffAt >= 85) {
                this._lastSnowPuffAt = now;
                try {
                    spawnStepPuff({ x: st.x, y: st.y, color: '#e8ecf2e0', material: 2, seed: st.seed ^ 0x5eed, size: st.s * 0.95, dir: st.r, elevation: Number(st.e) || 0, level: st.lvl ?? null });
                }
                catch { /* cosmetics must never crash rendering */ }
            }
        }
        if (!st.tid && keys) {
            const isCarve = this._isSnowCarveStain(st);
            if (isCarve) {
                this._markDirtyStain(st, keys);
            }
            else {
                for (const key of keys) {
                    const ch = this.chunks.get(key);
                    const hasCarve = Boolean(ch?.hasCarve || (this._carveMembers.get(key)?.size ?? 0) > 0);
                    const outOfOrder = Boolean(ch && st.i <= ch.maxId);
                    const hasDrifts = (this._driftCounts.get(key) || 0) > 0;
                    const hasLowSnow = (this._lowSnowCounts.get(key) || 0) > 0;
                    const hasSnowInChunk = hasLowSnow || hasDrifts;
                    const hasNonSnow = (this._nonSnowCounts.get(key) || 0) > 0;
                    // Route any incremental addition of snow (m === 2) into an already baked chunk (or blood over snow)
                    // through a localized dirtyRect so layered rendering (_renderBaseMembersLayered) seamlessly merges
                    // all tiers (lv=1..5: slope/ao → bank → terrace → body/plateau → crest) and the world-space pattern!
                    const needLayeredDirtyRect = Boolean(ch?.baked && (Number(st.m) === 2 || (hasSnowInChunk && hasNonSnow)));
                    if (outOfOrder || hasCarve || needLayeredDirtyRect) {
                        this._invalidateSnowBaseForStain(st, [key]);
                        this._markDirtyStain(st, [key]);
                    }
                    else if (this._fullRedraw.has(key)) {
                        this._markDirtyStain(st, [key]);
                    }
                }
            }
        }
        this._touchStain(st);
    }
    removeStains(ids) {
        if (this._destroyed || !Array.isArray(ids) || !ids.length)
            return;
        this._replacedHold.clear();
        let minIdx = Infinity;
        const kill = new Set();
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (kill.has(id))
                continue;
            kill.add(id);
            this._fading.delete(id);
            const idx = this._stainIdx.get(id);
            if (idx === undefined)
                continue;
            if (idx < minIdx)
                minIdx = idx;
            const st = this.stains[idx];
            this._ids.delete(id);
            this._stainIdx.delete(id);
            this._stainById.delete(id);
            if (st.tid) {
                const oKey = this._overlayKey(st.tid);
                const rec = this._overlays.get(st.tid);
                const wasNeedFull = rec ? rec.needFull : false;
                const wasDirty = this._dirty.has(oKey);
                this._replacedHold.set(id, { st, wasNeedFull, wasDirty, chunkSnaps: null });
                if (rec) {
                    rec.stains.delete(st);
                    rec.needFull = true;
                }
                this._dirty.add(oKey);
            }
            else {
                const keys = this._memberKeys(st);
                const chunkSnaps = [];
                for (const key of keys) {
                    const curRect = this._dirtyRects.get(key);
                    const ch = this.chunks.get(key);
                    chunkSnaps.push({
                        key,
                        wasFull: this._fullRedraw.has(key),
                        wasDirty: this._dirty.has(key),
                        hadRect: this._dirtyRects.has(key),
                        prevRect: curRect ? { ...curRect } : null,
                        wasSnowBaseValid: ch ? ch.snowBaseValid : false
                    });
                }
                this._replacedHold.set(id, { st, wasNeedFull: false, wasDirty: false, chunkSnaps });
                this._invalidateSnowBaseForStain(st, keys);
                this._markDirtyStain(st, keys);
                this._unindexStain(st, keys);
                this._touchStain(st);
            }
        }
        if (minIdx < Infinity) {
            let w = minIdx;
            for (let r = minIdx; r < this.stains.length; r++) {
                const st = this.stains[r];
                if (!kill.has(st.i)) {
                    this.stains[w] = st;
                    this._stainIdx.set(st.i, w);
                    w++;
                }
            }
            this.stains.length = w;
        }
        if (this._deferred.length) {
            let w = 0;
            for (let i = 0; i < this._deferred.length; i++) {
                const e = this._deferred[i];
                if (kill.has(e.st.i))
                    this._deferredIds.delete(e.st.i);
                else
                    this._deferred[w++] = e;
            }
            this._deferred.length = w;
        }
        this._requestFlush();
    }
    clear() {
        if (this._destroyed)
            return;
        this.stains = [];
        this._ids.clear();
        this._stainIdx.clear();
        this._stainById.clear();
        this._members.clear();
        this._sorted.clear();
        this._carveMembers.clear();
        this._bloodCounts.clear();
        this._nonSnowCounts.clear();
        this._lowSnowCounts.clear();
        this._driftCounts.clear();
        this._fullRedraw.clear();
        this._dirtyRects.clear();
        this._deferred = [];
        this._deferredIds.clear();
        this._replacedHold.clear();
        this._fading.clear();
        this._stopClock();
        for (const key of [...this.chunks.keys()])
            this._destroyChunk(key);
        this._dirty.clear();
        // elevation layers die alongside their chunks (sprites were already destroyed above)
        for (const c of this._elevContainers.values()) {
            try {
                c.destroy({ children: true });
            }
            catch { /* empty */ }
        }
        this._elevContainers.clear();
        // tile overlays (child sprites parented to external tile meshes) take their textures with them
        for (const tid of [...this._overlays.keys()])
            this._destroyOverlay(tid);
    }
    rebuildFrom(stains) {
        this.clear();
        this.addStains(stains, { defer: false });
    }
    destroy() {
        // CLEAR BEFORE setting the flag: clear() bails early on the `_destroyed` guard,
        // so reversing the order leaked all chunks/overlays/elevation layers (and their
        // textures in PIXI's global TextureCache) — ~1 MB per chunk accumulating on every scene switch.
        this.clear();
        this._destroyed = true;
        this._stopClock();
        // explicitly detach any pending addOnce flush: it would bail early on
        // `_destroyed` anyway, but avoid leaving dead callbacks on the persistent canvas ticker
        try {
            canvas.app?.ticker?.remove(this._flushOnce);
        }
        catch { /* empty */ }
    }
    /* -------------------------------- rendering -------------------------------- */
    _touch(x, y, r, e = 0, lvl = '') {
        r = Math.min(r, MAX_SPAN_R);
        const cx0 = Math.floor((x - r) / CHUNK), cx1 = Math.floor((x + r) / CHUNK);
        const cy0 = Math.floor((y - r) / CHUNK), cy1 = Math.floor((y + r) / CHUNK);
        for (let cx = cx0; cx <= cx1; cx++) {
            for (let cy = cy0; cy <= cy1; cy++)
                this._dirty.add(_key(e, cx, cy, lvl));
        }
    }
    _requestFlush() {
        if (this._flushScheduled || this._destroyed)
            return;
        this._flushScheduled = true;
        try {
            canvas.app.ticker.addOnce(this._flushOnce);
        }
        catch (e) {
            this._flushScheduled = false;
            console.error(`${MODULE_ID} | blood flush scheduling failed`, e);
        }
    }
    /**
     * Full rebake of ALL live chunks and overlays (via `_fullRedraw` — otherwise
     * the fast path would only append tails, leaving aging/washout invisible).
     */
    refreshAll() {
        if (this._destroyed || !this.stains.length)
            return;
        for (const key of this.chunks.keys()) {
            this._markFullChunk(key);
            this._dirty.add(key);
        }
        for (const tid of this._overlays.keys()) {
            const rec = this._overlays.get(tid);
            if (rec)
                rec.needFull = true;
            this._dirty.add(this._overlayKey(tid));
        }
        this._requestFlush();
    }
    /**
     * Targeted rebake of ONLY chunks and overlays containing blood stains (`m === 0`).
     * Invoked on hourly world-time jumps (`updateWorldTime`) and rain weather transitions:
     * snow-only chunks (`m === 2`) neither dry nor wash away like blood, so advancing time
     * never rebakes their `snowBase` caches or `1024×1024` textures (0 ms frame hit)!
     */
    refreshAging() {
        if (this._destroyed || !this.stains.length)
            return;
        for (const key of this.chunks.keys()) {
            if ((this._bloodCounts.get(key) || 0) > 0) {
                this._markFullChunk(key);
                this._dirty.add(key);
            }
        }
        for (const [tid, rec] of this._overlays) {
            if (!rec)
                continue;
            let hasBlood = false;
            for (const st of rec.stains) {
                if ((Number(st.m) || 0) === 0) {
                    hasBlood = true;
                    break;
                }
            }
            if (hasBlood) {
                rec.needFull = true;
                this._dirty.add(this._overlayKey(tid));
            }
        }
        if (this._dirty.size)
            this._requestFlush();
    }
    /**
     * Redraw dirty chunks — at most FLUSH_BUDGET per frame, rolling the remainder
     * over to the next frame (a long trail must not swallow an entire frame).
     */
    flush() {
        this._flushScheduled = false;
        if (this._destroyed || !this._dirty.size)
            return;
        // snapshot weather/aging context ONCE per flush (per-stain settings.get
        // across a 5-10k stain bake was a measurable bottleneck)
        this._wash = _washK();
        this._age = { on: _agingOn(), hours: _dryHours(), wt: _worldTime() };
        const keys = [...this._dirty];
        // start the wall-clock deadline AFTER the first bake: the first bake may
        // trigger lazy atlas generation (a one-off cost, not a per-frame cost), which
        // should not starve the budget of remaining chunks
        let deadline = Infinity;
        let done = 0, overlays = 0;
        for (let i = 0; i < keys.length && done < FLUSH_BUDGET; i++) {
            const key = keys[i];
            const isOverlay = key.startsWith('o:');
            // 'o:<tileId>' is a tile overlay; otherwise 'e|cx,cy' chunk. Overlays
            // cost far more (full bake + texture upload) — allow fewer per frame
            if (isOverlay && overlays >= OVERLAY_FLUSH_BUDGET)
                continue;
            // time-budget guard: eraser/reconcile can queue up to 8 DENSE bakes in one frame —
            // defer the rest while preserving key order
            if (done > 0 && performance.now() > deadline)
                break;
            this._dirty.delete(key);
            if (isOverlay) {
                overlays++;
                this._flushOverlay(key.slice(2));
            }
            else {
                try {
                    this._flushChunk(key);
                }
                catch (e) {
                    console.error(`${MODULE_ID} | blood chunk bake failed (${key})`, e);
                }
            }
            done++;
            if (deadline === Infinity)
                deadline = performance.now() + FLUSH_TIME_BUDGET_MS;
        }
        if (this._dirty.size)
            this._requestFlush();
    }
    /* --------------------- deferred and fading stains --------------------- */
    _ensureClock() {
        if (this._clock || this._destroyed || !canvas?.app?.ticker)
            return;
        if (!this._deferred.length && !this._fading.size)
            return;
        this._clock = () => this._tickClock();
        canvas.app.ticker.add(this._clock);
    }
    _stopClock() {
        if (!this._clock)
            return;
        try {
            canvas.app?.ticker?.remove(this._clock);
        }
        catch { /* empty */ }
        this._clock = null;
    }
    /** Activate due deferred stains and advance active fade animations. */
    _tickClock() {
        if (this._destroyed) {
            this._stopClock();
            return;
        }
        const now = performance.now();
        if (this._deferred.length) {
            // single-pass in-place compaction: running two filter() calls per frame during a
            // deferred cascade (staggered burst `d`) previously churned O(D) garbage every frame
            const due = [];
            let w = 0;
            for (let i = 0; i < this._deferred.length; i++) {
                const e = this._deferred[i];
                if (e.due <= now)
                    due.push(e);
                else
                    this._deferred[w++] = e;
            }
            this._deferred.length = w;
            if (due.length) {
                for (const e of due) {
                    if (e.replacePrev) {
                        const prev = e.replacePrev;
                        this._removeSingleStain(prev);
                        this._ids.delete(prev.i);
                        if (prev.tid) {
                            const rec = this._overlays.get(prev.tid);
                            if (rec) {
                                rec.stains.delete(prev);
                                rec.needFull = true;
                            }
                        }
                        else {
                            const keys = this._memberKeys(prev);
                            this._invalidateSnowBaseForStain(prev, keys);
                            this._markDirtyStain(prev, keys);
                            this._unindexStain(prev, keys);
                        }
                    }
                    this._activate(e.st, now, !e.replacePrev); // replacing an existing stain (trampled snow) must not dip to 0 alpha at fade start
                }
            }
        }
        if (this._fading.size) {
            // deleting the CURRENT entry during Map iteration is spec-legal — no spread copy needed
            for (const [, f] of this._fading) {
                const p = Math.min(1, (now - f.start) / Math.max(1, f.ms));
                if (p >= 1) {
                    this._fading.delete(f.st.i);
                    // stain is now static: if the chunk contains snow trenches (hasCarve) or snow,
                    // update only its local rectangle in snowBase and dirtyRect without resetting the whole chunk;
                    // otherwise mark the full chunk for redraw (flattening the two-layer animation base)
                    if (!f.st.tid) {
                        for (const mk of this._memberKeys(f.st)) {
                            const ch = this.chunks.get(mk);
                            const hasCarve = Boolean(ch?.hasCarve || (this._carveMembers.get(mk)?.size ?? 0) > 0);
                            const hasSnow = (this._lowSnowCounts.get(mk) || 0) > 0 || (this._driftCounts.get(mk) || 0) > 0;
                            if ((hasCarve || hasSnow) && ch?.baked) {
                                this._invalidateSnowBaseForStain(f.st, [mk]);
                                this._markDirtyStain(f.st, [mk]);
                            }
                            else if (!ch?.base) {
                                this._markFullChunk(mk);
                            }
                        }
                    }
                    // tile overlay: without this, coalescing with a newly activated stain would take
                    // the fast path, drawing only the TAIL (id > maxId) and leaving the finished stain
                    // permanently stuck at its last quantized fade step (up to −12.5% alpha) — force a full rebake
                    else {
                        const rec = this._overlays.get(f.st.tid);
                        if (rec)
                            rec.needFull = true;
                    }
                    this._touchStain(f.st);
                }
                else {
                    // quantization: redraw only when crossing a progress step boundary. Tile overlays
                    // rebake their ENTIRE area — so they use half as many steps
                    const steps = f.st.tid ? FADE_STEPS_OVERLAY : FADE_STEPS;
                    const step = Math.floor(p * steps);
                    if (step > f.step) {
                        f.step = step;
                        if (!f.st.tid) {
                            for (const mk of this._memberKeys(f.st)) {
                                const ch = this.chunks.get(mk);
                                const hasCarve = Boolean(ch?.hasCarve || (this._carveMembers.get(mk)?.size ?? 0) > 0);
                                const hasSnow = (this._lowSnowCounts.get(mk) || 0) > 0 || (this._driftCounts.get(mk) || 0) > 0;
                                if ((hasCarve || hasSnow) && ch?.baked) {
                                    this._invalidateSnowBaseForStain(f.st, [mk]);
                                    this._markDirtyStain(f.st, [mk]);
                                }
                            }
                        }
                        this._touchStain(f.st);
                    }
                }
            }
        }
        // schedule flush via addOnce: repainting continues WHILE animations are running,
        // not just at the end — otherwise fade renders once at 3% alpha and pops straight
        // to 100% (and stains with distinct `d` delays appear all at once)
        this._requestFlush();
        if (!this._deferred.length && !this._fading.size)
            this._stopClock();
    }
    _flushChunk(key) {
        const parts = key.split('|');
        const e = Number(parts[0]);
        const [cx, cy] = parts[1].split(',').map(Number);
        const lvl = parts[2] || '';
        const elevKey = _elevKey(e, lvl);
        const ox = cx * CHUNK, oy = cy * CHUNK;
        // members from sorted array cache (avoiding `[...set].sort()` on every
        // flush — which previously allocated + ran O(N log N) on EVERY brush-stroke frame)
        const members = this._membersSorted(key);
        let chunk = this.chunks.get(key);
        if (!members.length) {
            this._members.delete(key);
            this._sorted.delete(key);
            this._carveMembers.delete(key);
            this._bloodCounts.delete(key);
            this._nonSnowCounts.delete(key);
            this._lowSnowCounts.delete(key);
            this._driftCounts.delete(key);
            this._fullRedraw.delete(key);
            this._dirtyRects.delete(key);
            if (chunk)
                this._destroyChunk(key);
            // tear down empty elevation container so only occupied elevations live on the scene
            const cont = this._elevContainers.get(elevKey);
            if (cont && !cont.children.length) {
                this._elevContainers.delete(elevKey);
                try {
                    cont.destroy({ children: true });
                }
                catch { /* empty */ }
            }
            return;
        }
        const lastId = members[members.length - 1].i;
        // FAST PATH (brush stroke / fresh trail): chunk exists and has no removals,
        // animations, snow, or carved snow footprints/trenches — new stains are simply
        // APPENDED on top (IDs are monotonic, so appending the tail preserves draw order).
        // IMPORTANT: if the chunk contains or gains carved snow footprints/trenches (`hasCarve`),
        // the fast path with `this._drawStain` is FORBIDDEN — otherwise a trench would draw as
        // a dull gray smudge over snow without 3D relief or pixel-perfect masking, and then
        // snap to a different appearance on the next `dirtyRect` redraw!
        const animated = this._fading.size > 0 && members.some(m => this._fading.has(m.i));
        const hasCarveInChunk = Boolean(chunk?.hasCarve || (this._carveMembers.get(key)?.size ?? 0) > 0);
        const hasSnowInChunk = (this._lowSnowCounts.get(key) || 0) > 0 || (this._driftCounts.get(key) || 0) > 0;
        if (chunk && !this._fullRedraw.has(key) && !animated && !hasCarveInChunk && !hasSnowInChunk && lastId > chunk.maxId) {
            const tail = [];
            for (let i = members.length - 1; i >= 0; i--) {
                if (members[i].i <= chunk.maxId)
                    break;
                tail.push(members[i]);
            }
            tail.reverse();
            const { ctx } = chunk;
            ctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            this._renderBaseMembersLayered(ctx, tail, null);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            chunk.maxId = lastId;
            this._updateTex(chunk.tex);
            return;
        }
        if (!chunk) {
            const px = this.chunkPixelSize;
            const canvasEl = document.createElement('canvas');
            canvasEl.width = canvasEl.height = px;
            const tex = PIXI.Texture.from(canvasEl);
            const sprite = new PIXI.Sprite(tex);
            sprite.position.set(ox, oy);
            sprite.width = CHUNK;
            sprite.height = CHUNK;
            sprite.eventMode = 'none';
            this._elevContainer(e, lvl).addChild(sprite);
            chunk = {
                canvas: canvasEl,
                ctx: canvasEl.getContext('2d'),
                tex,
                sprite,
                px,
                maxId: 0,
                base: null,
                baseMinFade: 0,
                baked: false,
                snowBase: null,
                snowMask: null,
                snowBaseValid: false,
                snowBaseDirty: false,
                snowBaseDirtyRect: null,
                snowBaseMaxId: 0,
                hasCarve: false,
            };
            this.chunks.set(key, chunk);
        }
        // TWO-LAYER animation baking (for blood-only chunks without snow): the static BASE
        // is baked ONCE, and each animation step recomposites only the active fading layer.
        // Snow chunks (`hasSnowInChunk`) use the localized `dirtyRect` path below instead so
        // shadow passes (`ao`/`bank`/`slope`) of new drifts never composite on top of white base crests!
        if (animated && !this._fullRedraw.has(key) && !hasCarveInChunk && !hasSnowInChunk) {
            let minFade = Infinity;
            for (const m of members)
                if (this._fading.has(m.i) && m.i < minFade)
                    minFade = m.i;
            if (!chunk.base || minFade < chunk.baseMinFade) {
                const bcv = document.createElement('canvas');
                bcv.width = bcv.height = chunk.px;
                const bctx = bcv.getContext('2d');
                if (chunk.baked && chunk.maxId > 0 && !chunk.base && minFade > chunk.maxId) {
                    bctx.drawImage(chunk.canvas, 0, 0);
                    const gapTail = [];
                    for (const st of members) {
                        if (st.i > chunk.maxId && st.i < minFade)
                            gapTail.push(st);
                    }
                    if (gapTail.length) {
                        bctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                        this._renderBaseMembersLayered(bctx, gapTail, null);
                        bctx.setTransform(1, 0, 0, 1, 0, 0);
                    }
                }
                else {
                    bctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                    const staticBase = [];
                    for (const st of members) {
                        if (st.i < minFade)
                            staticBase.push(st);
                    }
                    this._renderBaseMembersLayered(bctx, staticBase, null);
                    bctx.setTransform(1, 0, 0, 1, 0, 0);
                }
                chunk.base = bcv;
                chunk.baseMinFade = minFade;
            }
            else if (minFade > chunk.baseMinFade) {
                const settled = [];
                for (const st of members) {
                    if (st.i >= chunk.baseMinFade && st.i < minFade)
                        settled.push(st);
                }
                if (settled.length) {
                    const bctx = chunk.base.getContext('2d');
                    bctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                    this._renderBaseMembersLayered(bctx, settled, null);
                    bctx.setTransform(1, 0, 0, 1, 0, 0);
                }
                chunk.baseMinFade = minFade;
            }
            const { ctx } = chunk;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, chunk.px, chunk.px);
            ctx.drawImage(chunk.base, 0, 0);
            ctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            const activeFade = [];
            for (const st of members) {
                if (st.i >= minFade)
                    activeFade.push(st);
            }
            this._renderBaseMembersLayered(ctx, activeFade, null);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            chunk.maxId = lastId;
            this._updateTex(chunk.tex);
            return;
        }
        if (chunk.base && !animated && !this._fullRedraw.has(key) && !hasCarveInChunk && !hasSnowInChunk) {
            const { ctx } = chunk;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, chunk.px, chunk.px);
            ctx.drawImage(chunk.base, 0, 0);
            ctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            const tailSettled = [];
            for (const st of members) {
                if (st.i >= chunk.baseMinFade)
                    tailSettled.push(st);
            }
            if (tailSettled.length)
                this._renderBaseMembersLayered(ctx, tailSettled, null);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            chunk.base = null;
            chunk.baseMinFade = 0;
            chunk.maxId = lastId;
            chunk.baked = true;
            this._updateTex(chunk.tex);
            return;
        }
        // LOCALIZED DIRTY-RECT BAKE (stepping in snow / snow brush stroke / eraser inside an already baked chunk):
        // when the chunk is already baked (`chunk.baked`) and `drect` is valid, redraw ONLY
        // the pixel sub-rectangle `(rx0, ry0, rw, rh)` in strict topographic order!
        const drect = this._dirtyRects.get(key);
        this._dirtyRects.delete(key);
        if (chunk.baked && (!animated || hasCarveInChunk || hasSnowInChunk) && drect) {
            if (chunk.snowBaseDirtyRect) {
                const sdr = chunk.snowBaseDirtyRect;
                if (sdr.x0 < drect.x0)
                    drect.x0 = sdr.x0;
                if (sdr.y0 < drect.y0)
                    drect.y0 = sdr.y0;
                if (sdr.x1 > drect.x1)
                    drect.x1 = sdr.x1;
                if (sdr.y1 > drect.y1)
                    drect.y1 = sdr.y1;
            }
            // If tail stains (id > chunk.maxId) were added on the same frame prior to `_fullRedraw` being set,
            // expand `drect` by their bounds so they are guaranteed to be rendered as well
            for (let i = members.length - 1; i >= 0; i--) {
                const m = members[i];
                if (m.i <= chunk.maxId)
                    break;
                const mr = this._stainSpanRadius(m);
                if (m.x - mr < drect.x0)
                    drect.x0 = m.x - mr;
                if (m.y - mr < drect.y0)
                    drect.y0 = m.y - mr;
                if (m.x + mr > drect.x1)
                    drect.x1 = m.x + mr;
                if (m.y + mr > drect.y1)
                    drect.y1 = m.y + mr;
            }
            const { ctx, px } = chunk;
            const rx0 = Math.max(0, Math.floor((drect.x0 - ox) * this.scale) - 4);
            const ry0 = Math.max(0, Math.floor((drect.y0 - oy) * this.scale) - 4);
            const rx1 = Math.min(px, Math.ceil((drect.x1 - ox) * this.scale) + 4);
            const ry1 = Math.min(px, Math.ceil((drect.y1 - oy) * this.scale) + 4);
            const rw = rx1 - rx0, rh = ry1 - ry0;
            if (rw > 0 && rh > 0 && (hasCarveInChunk || rw * rh < px * px * 0.72)) {
                const sx0 = ox + rx0 / this.scale, sy0 = oy + ry0 / this.scale;
                const sx1 = ox + rx1 / this.scale, sy1 = oy + ry1 / this.scale;
                let subMembers;
                // Ultra-fast O(carveCount) path: if the chunk's base snow cache is already built (`snowBaseValid`)
                // or the chunk was baked without carves and contains only snow (`!chunk.hasCarve && !chunk.snowBaseDirty && !hasNonSnow`),
                // we can skip scanning thousands of base snowdrifts in `members` altogether —
                // filtering ONLY intersecting footprint/trench stamps from `this._carveMembers.get(key)`!
                const cset = this._carveMembers.get(key);
                const canSkipNonCarveScan = Boolean(cset && cset.size > 0 && !chunk.snowBaseDirty && !chunk.snowBaseDirtyRect &&
                    (chunk.snowBaseValid || (!chunk.hasCarve && (this._nonSnowCounts.get(key) || 0) === 0)));
                if (canSkipNonCarveScan) {
                    subMembers = [];
                    for (const st of cset) {
                        const sr = this._stainSpanRadius(st);
                        if (st.x + sr >= sx0 && st.x - sr <= sx1 && st.y + sr >= sy0 && st.y - sr <= sy1) {
                            subMembers.push(st);
                        }
                    }
                    if (subMembers.length > 1)
                        subMembers.sort((a, b) => a.i - b.i);
                }
                else {
                    subMembers = [];
                    for (let i = 0; i < members.length; i++) {
                        const st = members[i];
                        const sr = this._stainSpanRadius(st);
                        if (st.x + sr >= sx0 && st.x - sr <= sx1 && st.y + sr >= sy0 && st.y - sr <= sy1) {
                            subMembers.push(st);
                        }
                    }
                }
                chunk.base = null;
                chunk.baseMinFade = 0;
                this._renderMembersWithSnowCarve(ctx, px, ox, oy, subMembers, { rx0, ry0, rw, rh }, chunk, members, key, !animated);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                if (lastId > chunk.maxId)
                    chunk.maxId = lastId;
                this._updateTex(chunk.tex);
                this._fullRedraw.delete(key);
                return;
            }
        }
        // Full bake (chunk creation / reconcile / fade completion / large-area edit):
        // invalidate the two-layer animation base — rebuilt lazily if another animation is active.
        // Do NOT clear `ctx` before calling `_renderMembersWithSnowCarve`, otherwise `_ensureChunkSnowBase`
        // could copy a blank canvas; `_renderMembersWithSnowCarve` clears `ctx` itself!
        chunk.base = null;
        chunk.baseMinFade = 0;
        const { ctx, px } = chunk;
        this._renderMembersWithSnowCarve(ctx, px, ox, oy, members, null, chunk, members, key, false);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        chunk.maxId = lastId;
        chunk.baked = true;
        this._updateTex(chunk.tex);
        this._fullRedraw.delete(key);
    }
    /** Whether a stain is a depressed snow footprint/furrow (`m === 2`) that must
     *  apply ONLY over existing snow pixels without self-overlapping. */
    _isSnowCarveStain(st) {
        if (!st || Number(st.m) !== 2)
            return false;
        if (st.t === STAIN.FOOTPRINT && st.c !== '#e8ecf2e0')
            return true;
        if (st.t === STAIN.SMEAR && !(st.lv >= 3) && st.c !== '#e8ecf2e0')
            return true;
        return false;
    }
    /**
     * Layered topographic rendering of base (non-carved) stains:
     *  - Tier 0 (m === 2, lv <= 2): Light/medium snow cover (translucent frost veil over map floor);
     *  - Tier 1 (m === 2, lv === 3): Small snowdrift (global passes: ao → bank → plateau);
     *  - Tier 2 (m === 2, lv === 4): Medium snowdrift (ao → bank → plateau → crest);
     *  - Tier 3 (m === 2, lv >= 5): Tall barchan drift (ao → bank → terrace → plateau → crest);
     *  - Tier 4 (m !== 2): Surface decals (blood, mud, oil) — rendered atop all snow tiers.
     * When `mctx` (separate `snowMask` canvas) is provided, all snow stains (`m === 2`)
     * are additionally stamped into `mctx` in `'mask'` mode (dense blood-free alpha mask).
     */
    _renderBaseMembersLayered(ctx, list, mctx = null) {
        let hasSnow = false;
        for (let i = 0; i < list.length; i++) {
            const st = list[i];
            if (!this._isSnowCarveStain(st) && Number(st.m) === 2) {
                hasSnow = true;
                break;
            }
        }
        if (!hasSnow) {
            this._currentDriftPass = null;
            for (let i = 0; i < list.length; i++) {
                const st = list[i];
                if (this._isSnowCarveStain(st))
                    continue;
                try {
                    this._drawStain(ctx, st);
                }
                catch (e) {
                    console.error(`${MODULE_ID} | blood stain draw failed (id=${st.i})`, e);
                }
            }
            return;
        }
        const tier0Light = [];
        const tier0Med = [];
        const tier1 = [];
        const tier2 = [];
        const tier3 = [];
        const tier4 = [];
        let snowMinX = Infinity, snowMinY = Infinity, snowMaxX = -Infinity, snowMaxY = -Infinity;
        for (let i = 0; i < list.length; i++) {
            const st = list[i];
            if (this._isSnowCarveStain(st))
                continue;
            if (Number(st.m) !== 2) {
                tier4.push(st);
            }
            else {
                const sr = this._stainSpanRadius(st);
                if (st.x - sr < snowMinX)
                    snowMinX = st.x - sr;
                if (st.y - sr < snowMinY)
                    snowMinY = st.y - sr;
                if (st.x + sr > snowMaxX)
                    snowMaxX = st.x + sr;
                if (st.y + sr > snowMaxY)
                    snowMaxY = st.y + sr;
                const lv = st.lv || 1;
                if (lv <= 1)
                    tier0Light.push(st);
                else if (lv === 2)
                    tier0Med.push(st);
                else if (lv === 3)
                    tier1.push(st);
                else if (lv === 4)
                    tier2.push(st);
                else
                    tier3.push(st);
            }
        }
        const prevPass = this._currentDriftPass;
        try {
            // Tier 0a: Light snow dusting (lv = 1)
            this._currentDriftPass = null;
            for (let i = 0; i < tier0Light.length; i++) {
                const st = tier0Light[i];
                try {
                    this._drawStain(ctx, st);
                    if (mctx)
                        this._drawSnowMaskStain(mctx, st);
                }
                catch (e) {
                    this._currentDriftPass = null;
                    console.error(`${MODULE_ID} | blood stain draw failed (id=${st.i})`, e);
                }
            }
            // Tier 0b: Dense snow cover (lv = 2) — 2 global passes (slope → body),
            // so adjacent stamps merge into a continuous snow blanket without internal edge rings!
            if (tier0Med.length) {
                const passes0 = ['slope', 'body'];
                for (let p = 0; p < passes0.length; p++) {
                    this._currentDriftPass = passes0[p];
                    for (let i = 0; i < tier0Med.length; i++) {
                        try {
                            this._drawStain(ctx, tier0Med[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier0Med[i].i})`, e);
                        }
                    }
                }
                if (mctx) {
                    for (let i = 0; i < tier0Med.length; i++) {
                        try {
                            this._drawSnowMaskStain(mctx, tier0Med[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier0Med[i].i})`, e);
                        }
                    }
                }
            }
            // Tier 1: Small snowdrift (lv = 3) — 3 passes (ao → bank → plateau)
            if (tier1.length) {
                const passes1 = ['ao', 'bank', 'plateau'];
                for (let p = 0; p < passes1.length; p++) {
                    this._currentDriftPass = passes1[p];
                    for (let i = 0; i < tier1.length; i++) {
                        try {
                            this._drawStain(ctx, tier1[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier1[i].i})`, e);
                        }
                    }
                }
                if (mctx) {
                    for (let i = 0; i < tier1.length; i++) {
                        try {
                            this._drawSnowMaskStain(mctx, tier1[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier1[i].i})`, e);
                        }
                    }
                }
            }
            // Tier 2: Medium snowdrift (lv = 4) — 4 passes (ao → bank → plateau → crest)
            if (tier2.length) {
                const passes2 = ['ao', 'bank', 'plateau', 'crest'];
                for (let p = 0; p < passes2.length; p++) {
                    this._currentDriftPass = passes2[p];
                    for (let i = 0; i < tier2.length; i++) {
                        try {
                            this._drawStain(ctx, tier2[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier2[i].i})`, e);
                        }
                    }
                }
                if (mctx) {
                    for (let i = 0; i < tier2.length; i++) {
                        try {
                            this._drawSnowMaskStain(mctx, tier2[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier2[i].i})`, e);
                        }
                    }
                }
            }
            // Tier 3: Tall barchan drift (lv >= 5) — 5 passes (ao → bank → terrace → plateau → crest)
            if (tier3.length) {
                const passes3 = ['ao', 'bank', 'terrace', 'plateau', 'crest'];
                for (let p = 0; p < passes3.length; p++) {
                    this._currentDriftPass = passes3[p];
                    for (let i = 0; i < tier3.length; i++) {
                        try {
                            this._drawStain(ctx, tier3[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier3[i].i})`, e);
                        }
                    }
                }
                if (mctx) {
                    for (let i = 0; i < tier3.length; i++) {
                        try {
                            this._drawSnowMaskStain(mctx, tier3[i]);
                        }
                        catch (e) {
                            console.error(`${MODULE_ID} | blood stain draw failed (id=${tier3[i].i})`, e);
                        }
                    }
                }
            }
            // Seamless world-space snow micro-texture (1:1 scale in scene coordinates):
            // sparkling ice facets and soft wind-ripple waves stitch all stamps and chunks together without stretching on giant drifts,
            // leaving the transparent background untouched (`source-atop` preserves snow alpha) and sparing Tier 4 blood below!
            if (snowMaxX > snowMinX && typeof ctx.createPattern === 'function') {
                const snowPat = BloodAtlas.snowWorldPattern(ctx);
                if (snowPat) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-atop';
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = snowPat;
                    ctx.fillRect(snowMinX, snowMinY, snowMaxX - snowMinX, snowMaxY - snowMinY);
                    ctx.restore();
                }
            }
            // Tier 4: Surface decals (blood) — atop all snow tiers
            this._currentDriftPass = null;
            for (let i = 0; i < tier4.length; i++) {
                const st = tier4[i];
                try {
                    this._drawStain(ctx, st);
                }
                catch (e) {
                    console.error(`${MODULE_ID} | blood stain draw failed (id=${st.i})`, e);
                }
            }
        }
        finally {
            this._currentDriftPass = prevPass;
        }
    }
    /**
     * Maintains the cached non-trench stain base (`chunk.snowBase`) and snow alpha mask (`chunk.snowMask`)
     * for a chunk. When a token walks/drags across snowdrifts, the snowdrifts themselves are NOT redrawn at all:
     *  1) when the first footprint/furrow enters an already-baked snow chunk, the base is copied from `chunk.canvas`
     *     via a single `drawImage` call with 0 `_drawStain` invocations;
     *  2) on every subsequent step, the base is already valid (`snowBaseValid = true`) and is simply blitted into `drect`
     *     with one `drawImage`, redrawing only the 1–4 new trench stamps intersecting `drect`!
     */
    _ensureChunkSnowBase(chunk, ox, oy, allMembers, key = '', canCopyCanvas = false) {
        const px = chunk.px;
        if (!chunk.snowBase || chunk.snowBase.width !== px) {
            chunk.snowBase = document.createElement('canvas');
            chunk.snowBase.width = chunk.snowBase.height = px;
            chunk.snowBaseValid = false;
            chunk.snowBaseMaxId = 0;
        }
        const hasNonSnow = key
            ? (this._nonSnowCounts.get(key) || 0) > 0
            : allMembers.some(s => !this._isSnowCarveStain(s) && Number(s.m) !== 2);
        const hasLowSnow = key
            ? (this._lowSnowCounts.get(key) || 0) > 0
            : allMembers.some(s => !this._isSnowCarveStain(s) && Number(s.m) === 2 && (s.lv || 1) <= 2);
        const needSeparateMask = hasNonSnow || hasLowSnow;
        let maxNonCarveId = 0;
        for (let i = allMembers.length - 1; i >= 0; i--) {
            const st = allMembers[i];
            if (!this._isSnowCarveStain(st)) {
                maxNonCarveId = st.i;
                break;
            }
        }
        if (chunk.snowBaseValid) {
            // When a non-trench stain in a chunk with a valid `snowBase` was locally replaced, added, or removed
            // (e.g. raising snow level with the Droplets brush or tinting a snowdrift with blood),
            // redraw ONLY `snowBaseDirtyRect` directly onto `chunk.snowBase` (and `chunk.snowMask`),
            // preserving `snowBaseValid = true` and exact visual parity with neighboring chunks!
            if (chunk.snowBaseDirtyRect) {
                const dr = chunk.snowBaseDirtyRect;
                chunk.snowBaseDirtyRect = null;
                chunk.snowBaseDirty = false;
                const limitId = Math.max(chunk.snowBaseMaxId, maxNonCarveId);
                const brx0 = Math.max(0, Math.floor((dr.x0 - ox) * this.scale) - 4);
                const bry0 = Math.max(0, Math.floor((dr.y0 - oy) * this.scale) - 4);
                const brx1 = Math.min(px, Math.ceil((dr.x1 - ox) * this.scale) + 4);
                const bry1 = Math.min(px, Math.ceil((dr.y1 - oy) * this.scale) + 4);
                const brw = brx1 - brx0, brh = bry1 - bry0;
                if (brw > 0 && brh > 0) {
                    const bsx0 = ox + brx0 / this.scale, bsy0 = oy + bry0 / this.scale;
                    const bsx1 = ox + brx1 / this.scale, bsy1 = oy + bry1 / this.scale;
                    const bctx = chunk.snowBase.getContext('2d');
                    bctx.save();
                    bctx.setTransform(1, 0, 0, 1, 0, 0);
                    bctx.beginPath();
                    bctx.rect(brx0, bry0, brw, brh);
                    bctx.clip();
                    bctx.clearRect(brx0, bry0, brw, brh);
                    bctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                    let mctx = null;
                    if (needSeparateMask && (!chunk.snowMask || chunk.snowMask === chunk.snowBase)) {
                        const mcv = document.createElement('canvas');
                        mcv.width = mcv.height = px;
                        const initMctx = mcv.getContext('2d');
                        initMctx.drawImage(chunk.snowBase, 0, 0);
                        if (hasLowSnow && !hasNonSnow) {
                            initMctx.drawImage(chunk.snowBase, 0, 0);
                            initMctx.drawImage(chunk.snowBase, 0, 0);
                        }
                        chunk.snowMask = mcv;
                    }
                    if (chunk.snowMask && chunk.snowMask !== chunk.snowBase) {
                        mctx = chunk.snowMask.getContext('2d');
                        mctx.save();
                        mctx.setTransform(1, 0, 0, 1, 0, 0);
                        mctx.beginPath();
                        mctx.rect(brx0, bry0, brw, brh);
                        mctx.clip();
                        mctx.clearRect(brx0, bry0, brw, brh);
                        mctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                    }
                    const subBase = [];
                    for (let i = 0; i < allMembers.length; i++) {
                        const st = allMembers[i];
                        if (st.i > limitId)
                            break;
                        if (this._isSnowCarveStain(st))
                            continue;
                        const sr = this._stainSpanRadius(st);
                        if (st.x + sr < bsx0 || st.x - sr > bsx1 || st.y + sr < bsy0 || st.y - sr > bsy1)
                            continue;
                        subBase.push(st);
                    }
                    this._renderBaseMembersLayered(bctx, subBase, mctx);
                    bctx.restore();
                    bctx.setTransform(1, 0, 0, 1, 0, 0);
                    if (mctx) {
                        mctx.restore();
                        mctx.setTransform(1, 0, 0, 1, 0, 0);
                    }
                }
                chunk.snowBaseMaxId = limitId;
            }
            if (maxNonCarveId > chunk.snowBaseMaxId) {
                const bctx = chunk.snowBase.getContext('2d');
                bctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                let mctx = null;
                let startIdx = allMembers.length;
                while (startIdx > 0 && allMembers[startIdx - 1].i > chunk.snowBaseMaxId)
                    startIdx--;
                const tailBase = [];
                for (let i = startIdx; i < allMembers.length; i++) {
                    const st = allMembers[i];
                    if (st.i <= chunk.snowBaseMaxId || this._isSnowCarveStain(st))
                        continue;
                    if ((Number(st.m) !== 2 || (st.lv || 1) <= 2) && (!chunk.snowMask || chunk.snowMask === chunk.snowBase)) {
                        const mcv = document.createElement('canvas');
                        mcv.width = mcv.height = px;
                        const initMctx = mcv.getContext('2d');
                        initMctx.drawImage(chunk.snowBase, 0, 0);
                        if (hasLowSnow && !hasNonSnow) {
                            initMctx.drawImage(chunk.snowBase, 0, 0);
                            initMctx.drawImage(chunk.snowBase, 0, 0);
                        }
                        chunk.snowMask = mcv;
                    }
                    tailBase.push(st);
                }
                if (chunk.snowMask && chunk.snowMask !== chunk.snowBase) {
                    mctx = chunk.snowMask.getContext('2d');
                    mctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                }
                this._renderBaseMembersLayered(bctx, tailBase, mctx);
                bctx.setTransform(1, 0, 0, 1, 0, 0);
                if (mctx)
                    mctx.setTransform(1, 0, 0, 1, 0, 0);
                chunk.snowBaseMaxId = maxNonCarveId;
            }
            chunk.snowBaseMaxId = maxNonCarveId;
            return;
        }
        // Fast path: if the chunk is already baked WITHOUT carves and contains only snow (no blood on top),
        // and `canCopyCanvas` is true (`chunk.canvas` is guaranteed intact),
        // `chunk.canvas` already holds the finished image of all drifts in the chunk — copy it in O(1)!
        if (canCopyCanvas && chunk.baked && !chunk.hasCarve && !chunk.snowBaseDirty && !hasNonSnow && maxNonCarveId <= chunk.maxId) {
            const bctx = chunk.snowBase.getContext('2d');
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            bctx.clearRect(0, 0, px, px);
            bctx.drawImage(chunk.canvas, 0, 0);
            if (hasLowSnow) {
                if (!chunk.snowMask || chunk.snowMask === chunk.snowBase || chunk.snowMask.width !== px) {
                    chunk.snowMask = document.createElement('canvas');
                    chunk.snowMask.width = chunk.snowMask.height = px;
                }
                const mctx = chunk.snowMask.getContext('2d');
                mctx.setTransform(1, 0, 0, 1, 0, 0);
                mctx.clearRect(0, 0, px, px);
                // Triple GPU blit boosts translucent snow-dusting alpha (0.45..0.65) into a dense mask (0.84..0.96)
                // with 0 `_drawStain` calls so boot prints (`FOOTPRINT`) on light snow do not fade out after `destination-in`!
                mctx.drawImage(chunk.snowBase, 0, 0);
                mctx.drawImage(chunk.snowBase, 0, 0);
                mctx.drawImage(chunk.snowBase, 0, 0);
            }
            else {
                chunk.snowMask = chunk.snowBase;
            }
            chunk.snowBaseValid = true;
            chunk.snowBaseDirty = false;
            chunk.snowBaseMaxId = maxNonCarveId;
            return;
        }
        const bctx = chunk.snowBase.getContext('2d');
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.clearRect(0, 0, px, px);
        bctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
        let mctx = null;
        if (needSeparateMask) {
            if (!chunk.snowMask || chunk.snowMask === chunk.snowBase || chunk.snowMask.width !== px) {
                chunk.snowMask = document.createElement('canvas');
                chunk.snowMask.width = chunk.snowMask.height = px;
            }
            mctx = chunk.snowMask.getContext('2d');
            mctx.setTransform(1, 0, 0, 1, 0, 0);
            mctx.clearRect(0, 0, px, px);
            mctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
        }
        else {
            chunk.snowMask = chunk.snowBase;
        }
        this._renderBaseMembersLayered(bctx, allMembers, mctx);
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        if (mctx)
            mctx.setTransform(1, 0, 0, 1, 0, 0);
        chunk.snowBaseValid = true;
        chunk.snowBaseDirty = false;
        chunk.snowBaseMaxId = maxNonCarveId;
    }
    /**
     * Render a chunk's stain list with pixel-perfect clipping of depressed snow footprints/trenches.
     * Supports an optional `clip = { rx0, ry0, rw, rh }` (in chunk canvas pixels) and the `chunk.snowBase` cache.
     */
    _renderMembersWithSnowCarve(ctx, px, ox, oy, members, clip = null, chunk = null, allMembers = null, key = '', canCopyCanvas = false) {
        const rx0 = clip ? clip.rx0 : 0;
        const ry0 = clip ? clip.ry0 : 0;
        const rw = clip ? clip.rw : px;
        const rh = clip ? clip.rh : px;
        let hasSnowCarve = Boolean(chunk?.hasCarve ||
            chunk?.snowBaseValid ||
            (key && (this._carveMembers.get(key)?.size ?? 0) > 0));
        if (!hasSnowCarve) {
            for (let i = 0; i < members.length; i++) {
                if (this._isSnowCarveStain(members[i])) {
                    hasSnowCarve = true;
                    break;
                }
            }
        }
        if (!hasSnowCarve) {
            if (!clip && chunk) {
                chunk.hasCarve = false;
                chunk.snowBaseDirty = false;
            }
            if (clip) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.beginPath();
                ctx.rect(rx0, ry0, rw, rh);
                ctx.clip();
                ctx.clearRect(rx0, ry0, rw, rh);
            }
            else {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, px, px);
            }
            ctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            this._renderBaseMembersLayered(ctx, members, null);
            if (clip)
                ctx.restore();
            return;
        }
        if (!this._scratchCarve || this._scratchCarve.width !== px) {
            this._scratchCarve = document.createElement('canvas');
            this._scratchCarve.width = this._scratchCarve.height = px;
        }
        const cctx = this._scratchCarve.getContext('2d');
        // UNIFIED pipeline via the `chunk.snowBase` / `chunk.snowMask` cache:
        // both full chunk rebakes (`clip == null`) and partial `dirtyRect` updates (`clip != null`),
        // for snow-only chunks and snow + blood chunks alike, pass through the EXACT SAME
        // compositing branch so neighboring 1024×1024 chunks never diverge in brightness or opacity across seams!
        if (chunk && allMembers) {
            this._ensureChunkSnowBase(chunk, ox, oy, allMembers, key, Boolean(clip && canCopyCanvas));
            chunk.hasCarve = true;
            if (clip) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.beginPath();
                ctx.rect(rx0, ry0, rw, rh);
                ctx.clip();
                ctx.clearRect(rx0, ry0, rw, rh);
                cctx.save();
                cctx.setTransform(1, 0, 0, 1, 0, 0);
                cctx.beginPath();
                cctx.rect(rx0, ry0, rw, rh);
                cctx.clip();
            }
            else {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, px, px);
            }
            try {
                // 1. Blit the prebaked snow and base-stain layer into `drect` with a single `drawImage` call
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
                ctx.drawImage(chunk.snowBase, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
                const carveList = [];
                for (let i = 0; i < members.length; i++) {
                    const st = members[i];
                    if (this._isSnowCarveStain(st))
                        carveList.push(st);
                }
                if (!carveList.length)
                    return;
                // 2. Assemble trampled rut/footprint relief pass by pass (berm → rim → lip → wall → bed) into a single buffer
                cctx.setTransform(1, 0, 0, 1, 0, 0);
                cctx.globalCompositeOperation = 'source-over';
                cctx.globalAlpha = 1;
                cctx.clearRect(rx0, ry0, rw, rh);
                cctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'berm');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'rim');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'lip');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'wall');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'bed');
                // 3. UNIFIED pixel-perfect compositing for ALL chunks (both pure snow and bloodied snow):
                //    clip the furrow relief against the snow alpha mask `maskCanvas` (`destination-in`), then slightly
                //    attenuate the base drift gloss (`destination-out`, alpha=0.18) and composite the rut relief
                //    on top (`source-over`, alpha=0.88). This yields a dense opaque furrow (~0.98) without dark map
                //    floor bleed-through and guarantees 100% brightness parity across chunk boundaries!
                const maskCanvas = chunk.snowMask || chunk.snowBase;
                cctx.setTransform(1, 0, 0, 1, 0, 0);
                cctx.save();
                cctx.globalAlpha = 1;
                cctx.globalCompositeOperation = 'destination-in';
                cctx.drawImage(maskCanvas, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
                cctx.globalCompositeOperation = 'source-over';
                cctx.restore();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.save();
                ctx.globalAlpha = 0.18;
                ctx.globalCompositeOperation = 'destination-out';
                ctx.drawImage(this._scratchCarve, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
                ctx.globalAlpha = 0.88;
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(this._scratchCarve, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
                ctx.globalAlpha = 1;
                ctx.restore();
            }
            finally {
                if (clip) {
                    cctx.restore();
                    ctx.restore();
                }
            }
            return;
        }
        if (!this._scratchMask || this._scratchMask.width !== px) {
            this._scratchMask = document.createElement('canvas');
            this._scratchMask.width = this._scratchMask.height = px;
        }
        const mctx = this._scratchMask.getContext('2d');
        if (clip) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.beginPath();
            ctx.rect(rx0, ry0, rw, rh);
            ctx.clip();
            ctx.clearRect(rx0, ry0, rw, rh);
            mctx.save();
            mctx.setTransform(1, 0, 0, 1, 0, 0);
            mctx.beginPath();
            mctx.rect(rx0, ry0, rw, rh);
            mctx.clip();
            cctx.save();
            cctx.setTransform(1, 0, 0, 1, 0, 0);
            cctx.beginPath();
            cctx.rect(rx0, ry0, rw, rh);
            cctx.clip();
        }
        try {
            // 1. Render non-snow stains and existing snow into the main chunk canvas,
            //    while stamping a pure snow mask into `mctx` (for pixel-perfect clipping of tracks along snow edges)
            mctx.setTransform(1, 0, 0, 1, 0, 0);
            mctx.clearRect(rx0, ry0, rw, rh);
            mctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            ctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            const carveList = [];
            for (let i = 0; i < members.length; i++) {
                if (this._isSnowCarveStain(members[i]))
                    carveList.push(members[i]);
            }
            this._renderBaseMembersLayered(ctx, members, mctx);
            if (!carveList.length)
                return;
            // 2. Pass A: carve away the fluffy white cap of existing snow (`destination-out`) in a unified non-accumulating mask
            cctx.setTransform(1, 0, 0, 1, 0, 0);
            cctx.globalCompositeOperation = 'source-over';
            cctx.globalAlpha = 1;
            cctx.clearRect(rx0, ry0, rw, rh);
            cctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            for (let i = 0; i < carveList.length; i++) {
                this._drawSnowCarvePass(cctx, carveList[i], 'carve');
            }
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = 0.46;
            ctx.drawImage(this._scratchCarve, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
            ctx.restore();
            // 3. Pass B: assemble trampled rut/footprint relief pass by pass (berm → rim → lip → wall → bed) with `globalAlpha = 1`
            //    so overlapping stamps merge into a monolithic trough WITHOUT alpha stacking
            cctx.setTransform(1, 0, 0, 1, 0, 0);
            cctx.globalCompositeOperation = 'source-over';
            cctx.globalAlpha = 1;
            cctx.clearRect(rx0, ry0, rw, rh);
            cctx.setTransform(this.scale, 0, 0, this.scale, -ox * this.scale, -oy * this.scale);
            for (let i = 0; i < carveList.length; i++)
                this._drawSnowCarvePass(cctx, carveList[i], 'berm');
            for (let i = 0; i < carveList.length; i++)
                this._drawSnowCarvePass(cctx, carveList[i], 'rim');
            for (let i = 0; i < carveList.length; i++)
                this._drawSnowCarvePass(cctx, carveList[i], 'lip');
            for (let i = 0; i < carveList.length; i++)
                this._drawSnowCarvePass(cctx, carveList[i], 'wall');
            for (let i = 0; i < carveList.length; i++)
                this._drawSnowCarvePass(cctx, carveList[i], 'bed');
            // 4. Pixel-perfect clipping: keep the trampled rut/footprints ONLY where snow actually exists (`mctx`)
            cctx.setTransform(1, 0, 0, 1, 0, 0);
            cctx.save();
            cctx.globalAlpha = 1;
            cctx.globalCompositeOperation = 'destination-in';
            cctx.drawImage(this._scratchMask, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
            cctx.restore();
            // 5. Composite the snow-clipped rut over the chunk canvas
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.save();
            ctx.globalAlpha = 0.92;
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(this._scratchCarve, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
            ctx.restore();
        }
        finally {
            if (clip) {
                cctx.restore();
                mctx.restore();
                ctx.restore();
            }
        }
    }
    /**
     * Individual rendering pass for a depressed snow footprint/trench:
     *  - 'carve': carves away the top layer of the snowdrift (`destination-out`);
     *  - 'berm' : outer cool ambient occlusion shadow of the displaced snow berm;
     *  - 'rim'  : raised sunlit snow ridge along both edges of the trench/print;
     *  - 'lip'  : soft bevel transitioning from the white ridge into the trough;
     *  - 'wall' : deep slate-blue inner shadow on the NW wall of the trench or toes/heel;
     *  - 'bed'  : compacted floor of the trench or boot/paw/hoof print.
     */
    _drawSnowCarvePass(ctx, st, pass) {
        const rng = _scratchRng.reset(st.seed);
        const kind = st.t === STAIN.FOOTPRINT
            ? (FP_KIND_BY_SUBTYPE[st.fp] ?? 'footprint')
            : (KIND_BY_TYPE[st.t] ?? 'splat');
        const variant = rng.int(BloodAtlas.kindCount(kind));
        const size = st.s * rng.range(0.94, 1.06);
        let grow = 1;
        const fade = this._fading.get(st.i);
        if (fade && fade.grow) {
            const p = Math.min(1, Math.max(0, (performance.now() - fade.start) / Math.max(1, fade.ms)));
            grow = 1 - Math.pow(1 - p, 3);
        }
        rng.range(0.92, 1); // preserve deterministic RNG advance for `rot`
        const rot = st.r + rng.range(-0.05, 0.05);
        const isTrench = st.t === STAIN.SMEAR;
        const isFootprint = st.t === STAIN.FOOTPRINT;
        const wideY = isTrench ? 1.38 : 1;
        // Consistent deterministic reflection (flipX, flipY) across ALL passes of a trench stamp:
        // guarantees 100% alignment of jagged snow clumps across berm → rim → lip → wall → bed
        // (disabled for footprints/paws so left/right chirality is never inverted)
        const flipX = (isTrench && (st.seed & 2)) ? -1 : 1;
        const flipY = (isTrench && (st.seed & 4)) ? -1 : 1;
        // Fresh trenches/prints (a >= 0.72) draw at alpha = 1 with seamless overlap;
        // tracks partially buried by fresh snowfall (a < 0.72) smoothly dissolve beneath the snow
        const carveAlpha = Math.min(1, (Number(st.a) || 0.75) / 0.72);
        ctx.save();
        ctx.globalAlpha = carveAlpha;
        if (pass === 'carve') {
            const img = BloodAtlas.tinted(kind, variant, st.c, 2);
            const sx = size * (isTrench ? 0.94 : 0.96);
            const sy = size * (isTrench ? 0.84 : 0.96);
            ctx.translate(st.x, st.y);
            ctx.rotate(rot);
            ctx.scale(grow * flipX, grow * wideY * flipY);
            ctx.drawImage(img, -sx / 2, -sy / 2, sx, sy);
        }
        else if (pass === 'berm') {
            const bermImg = BloodAtlas.tinted(kind, variant, '#6e88aa', 2);
            const sx = size * (isTrench ? 1.07 : 1.05);
            const sy = size * (isTrench ? 1.25 : 1.05);
            const ox = size * (isTrench ? 0.018 : 0.016);
            const oy = size * (isTrench ? 0.020 : 0.018);
            ctx.translate(st.x + ox, st.y + oy);
            ctx.rotate(rot);
            ctx.scale(grow * flipX, grow * wideY * flipY);
            ctx.globalAlpha = carveAlpha * (isTrench ? 0.38 : 0.36);
            ctx.drawImage(bermImg, -sx / 2, -sy / 2, sx, sy);
        }
        else if (pass === 'rim') {
            const rimImg = BloodAtlas.tinted(kind, variant, '#ffffff', 2);
            if (isFootprint) {
                // Morphological dilation in world coordinates (±d) around every toe/pad/heel:
                // builds a uniform white rim of displaced snow around each anatomical feature
                // without radial inflation from the stamp center!
                const sx = size * 1.02;
                const sy = size * 1.02;
                const d = size * 0.020;
                const offsets = [[-d, -d], [d, -d], [-d, d], [d, d]];
                ctx.globalAlpha = carveAlpha * 0.82;
                for (let k = 0; k < offsets.length; k++) {
                    ctx.save();
                    ctx.translate(st.x + offsets[k][0], st.y + offsets[k][1]);
                    ctx.rotate(rot);
                    ctx.scale(grow, grow);
                    ctx.drawImage(rimImg, -sx / 2, -sy / 2, sx, sy);
                    ctx.restore();
                }
            }
            else {
                const sx = size * (isTrench ? 1.05 : 1.08);
                const sy = size * (isTrench ? 1.22 : 1.08);
                const ox = -size * (isTrench ? 0.003 : -0.010);
                const oy = -size * (isTrench ? 0.004 : -0.012);
                ctx.translate(st.x + ox, st.y + oy);
                ctx.rotate(rot);
                ctx.scale(grow * flipX, grow * wideY * flipY);
                ctx.globalAlpha = carveAlpha * (isTrench ? 0.98 : 0.86);
                ctx.drawImage(rimImg, -sx / 2, -sy / 2, sx, sy);
            }
        }
        else if (pass === 'lip') {
            const lipImg = BloodAtlas.tinted(kind, variant, '#94a8c0', 2);
            const sx = size * (isTrench ? 0.99 : 1.00);
            const sy = size * (isTrench ? 0.96 : 1.00);
            const ox = size * (isTrench ? 0.006 : 0.008);
            const oy = size * (isTrench ? 0.007 : 0.010);
            ctx.translate(st.x + ox, st.y + oy);
            ctx.rotate(rot);
            ctx.scale(grow * flipX, grow * wideY * flipY);
            ctx.globalAlpha = carveAlpha * (isTrench ? 0.92 : 0.88);
            ctx.drawImage(lipImg, -sx / 2, -sy / 2, sx, sy);
        }
        else if (pass === 'wall') {
            const wallCol = isFootprint ? '#647a96' : '#7c8ea8';
            const wallImg = BloodAtlas.tinted(kind, variant, wallCol, 2);
            const sx = size * (isTrench ? 0.96 : 0.98);
            const sy = size * (isTrench ? 0.88 : 0.98);
            const ox = -size * (isTrench ? 0.015 : 0.012);
            const oy = -size * (isTrench ? 0.018 : 0.014);
            ctx.translate(st.x + ox, st.y + oy);
            ctx.rotate(rot);
            ctx.scale(grow * flipX, grow * wideY * flipY);
            ctx.globalAlpha = carveAlpha * 0.96;
            ctx.drawImage(wallImg, -sx / 2, -sy / 2, sx, sy);
        }
        else if (pass === 'bed') {
            const col = parseColor(st.c);
            const isBloody = Boolean(col && (col.r > col.b + 16 || col.g > col.b + 16));
            const bedColor = isBloody ? st.c : '#b4c2d4';
            const bedImg = BloodAtlas.tinted(kind, variant, bedColor, 2);
            const sx = size * (isTrench ? 0.94 : 0.94);
            const sy = size * (isTrench ? 0.72 : 0.94);
            const ox = size * (isTrench ? 0.014 : 0.016);
            const oy = size * (isTrench ? 0.016 : 0.018);
            ctx.translate(st.x + ox, st.y + oy);
            ctx.rotate(rot);
            ctx.scale(grow * flipX, grow * wideY * flipY);
            ctx.globalAlpha = carveAlpha * (isTrench ? 0.96 : 0.95);
            ctx.drawImage(bedImg, -sx / 2, -sy / 2, sx, sy);
        }
        ctx.restore();
    }
    _destroyChunk(key) {
        const chunk = this.chunks.get(key);
        this.chunks.delete(key);
        if (!chunk)
            return;
        chunk.base = null;
        chunk.snowBase = null;
        chunk.snowMask = null;
        // baseTexture: true is mandatory — without it, an orphaned GL texture
        // (1-4 MB per chunk) lingers until PIXI's texture GC collects it (~60-70 s)
        try {
            chunk.sprite.destroy({ texture: true, baseTexture: true });
        }
        catch { /* empty */ }
    }
    /* --------------------- tile overlay baking --------------------- */
    /**
     * Tile-attached blood (`st.tid`) is baked into a canvas in the tile's LOCAL
     * coordinate space, while its carrier sprite is parented directly to the tile's
     * MESH: dragging, rotating, or hiding the tile moves the blood instantaneously
     * as part of the tile. Scene → local transforms go through the mesh's pose
     * (handling rotation and scale). After baking, a `destination-in` mask from the
     * tile texture's alpha channel clips blood away from transparent pixels (pixel-perfect).
     */
    _flushOverlay(tid) {
        try {
            this.__flushOverlay(tid);
        }
        catch (e) {
            // baking must NEVER crash Foundry's ticker: skip quietly so the layer
            // rebakes on the next stroke/tick
            console.warn(`${MODULE_ID} | blood overlay bake skipped (tile=${tid})`, e);
        }
    }
    __flushOverlay(tid) {
        const rec = this._overlays.get(tid);
        if (!rec)
            return;
        if (!rec.stains.size) {
            this._destroyOverlay(tid);
            return;
        }
        // sprite may have been destroyed along with the mesh (texture cleared → removeTile)
        // — recreate it, otherwise a destroyed transform breaks baking forever
        if (rec.sprite?.destroyed) {
            rec.sprite = null;
            rec.tex = null;
        }
        const tile = rec.tile && !rec.tile.destroyed ? rec.tile : (rec.tile = this._findTile(tid));
        const mesh = tile?.mesh;
        const doc = tile?.document;
        // tile is not on the canvas yet — blood awaits its return (data in store stays alive).
        // The key was already consumed by flush — schedule a bounded self-retry so the
        // overlay catches up once the mesh appears
        if (!mesh || !Number.isFinite(doc?.x)) {
            if ((rec.missed ?? 0) < 10) {
                rec.missed = (rec.missed ?? 0) + 1;
                setTimeout(() => {
                    if (!this._destroyed && this._overlays.get(tid) === rec) {
                        this._dirty.add(this._overlayKey(tid));
                        this._requestFlush();
                    }
                }, 250);
            }
            return;
        }
        let animated = false;
        if (this._fading.size > 0) {
            for (const m of rec.stains)
                if (this._fading.has(m.i)) {
                    animated = true;
                    break;
                }
        }
        let lastId = 0;
        let hasOverlayCarve = false;
        let hasOverlaySnow = false;
        for (const m of rec.stains) {
            if (m.i > lastId)
                lastId = m.i;
            if (Number(m.m) === 2)
                hasOverlaySnow = true;
            if (this._isSnowCarveStain(m))
                hasOverlayCarve = true;
        }
        const k = this.scale;
        const pad = OVERLAY_PAD;
        // FAST PATH: no removals, animations, snow, or 3D trenches — new blood stains are
        // APPENDED into the existing canvas (monotonic IDs preserve order), followed by
        // MANDATORY alpha masking and texture upload (see mask comment below)
        const fast = rec.sprite && !rec.sprite.destroyed && !rec.needFull && !animated && !hasOverlayCarve && !hasOverlaySnow && lastId > rec.maxId;
        // GEOMETRY. The tile mesh's local space is texture TEXELS:
        // the mesh is authored at texture dimensions and scaled to `doc.width`
        // (sprite-mesh resize), and child display objects inherit that scale. Baking
        // therefore runs in "scene pixels relative to the MESH PIVOT" (`doc.x`/`doc.y` =
        // `mesh.position`; matching `shape.center` at anchor 0.5), while the carrier sprite
        // compensates for both mesh scale and canvas bake resolution:
        //   position = l0 / meshScale,  scale = 1 / (meshScale · kk)
        const px0 = doc.x, py0 = doc.y;
        const ang = (Number(doc?.rotation) || 0) * Math.PI / 180;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const ctx = rec.ctx;
        if (fast) {
            // tail scale must match the scale used to build the canvas (`rec.k`): using `this.scale`
            // on tiles clamped by `OVERLAY_MAX_PX` produced shifted, oversized tails
            const fk = rec.k || k;
            const tail = [];
            for (const st of rec.stains)
                if (st.i > rec.maxId)
                    tail.push(st);
            // tail OUTSIDE the current canvas bbox would silently clip: force a full rebake
            // with an expanded bbox BEFORE drawing so the canvas stays consistent and no stains are clipped
            let outside = false;
            for (const st of tail) {
                const lx = cos * (st.x - px0) + sin * (st.y - py0) - rec.lx0;
                const ly = -sin * (st.x - px0) + cos * (st.y - py0) - rec.ly0;
                const r = this._stainSpanRadius(st);
                if (lx - r < 0 || ly - r < 0 || lx + r > rec.lw || ly + r > rec.lh) {
                    outside = true;
                    break;
                }
            }
            if (!outside) {
                ctx.setTransform(cos * fk, -sin * fk, sin * fk, cos * fk, fk * (-cos * px0 - sin * py0 - rec.lx0), fk * (sin * px0 - cos * py0 - rec.ly0));
                // union bbox of tail stains in canvas px — used as the mask clip region
                // (only the small TAIL is sorted; sorting all overlay members is unnecessary)
                tail.sort((a, b) => a.i - b.i);
                let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
                for (const st of tail) {
                    try {
                        this._drawStain(ctx, st);
                        const px = (cos * (st.x - px0) + sin * (st.y - py0) - rec.lx0) * fk;
                        const py = (-sin * (st.x - px0) + cos * (st.y - py0) - rec.ly0) * fk;
                        // margin matches the chunk span formula (s·0.8+8): the farthest satellite droplet
                        // on a footprint reaches ~0.7575·s — a smaller radius would clip its rim via `destination-in` on transparent tile textures
                        const rr = st.s * 0.8 * fk + 8;
                        if (px - rr < mnX)
                            mnX = px - rr;
                        if (py - rr < mnY)
                            mnY = py - rr;
                        if (px + rr > mxX)
                            mxX = px + rr;
                        if (py + rr > mxY)
                            mxY = py + rr;
                    }
                    catch (e) {
                        console.error(`${MODULE_ID} | blood overlay stain draw failed (id=${st.i})`, e);
                    }
                }
                // masking is mandatory on the tail too: without it, appended stains float
                // over transparent tile pixels. Fully opaque textures make masking a no-op so we skip it;
                // otherwise clip `destination-in` to the tail bbox (far cheaper than a full pass per brush tick)
                if (rec.allOpaque !== true) {
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    const cx0 = Math.max(0, Math.floor(mnX)), cy0 = Math.max(0, Math.floor(mnY));
                    const cw = Math.min(rec.canvas.width - cx0, Math.ceil(mxX) - cx0);
                    const chh = Math.min(rec.canvas.height - cy0, Math.ceil(mxY) - cy0);
                    this._maskOverlay(rec, mesh, cw > 0 && chh > 0 ? { x: cx0, y: cy0, w: cw, h: chh } : null);
                }
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                if (rec.sprite.parent !== mesh)
                    mesh.addChild(rec.sprite); // mesh recreated — re-parent layer
                rec.sprite.alpha = this._computeOverlayAlpha(mesh, doc);
                // GPU texture upload is the most expensive part of tail appending: throttle it,
                // guaranteeing the trailing upload arrives via timer
                const now = performance.now();
                if (rec.texDirty || now - (rec.lastUpload ?? -1e9) >= OVERLAY_UPLOAD_MS) {
                    this._updateTex(rec.tex);
                    rec.lastUpload = now;
                    rec.texDirty = false;
                    clearTimeout(rec.uploadTimer);
                    rec.uploadTimer = null;
                }
                else {
                    rec.texDirty = true;
                    if (!rec.uploadTimer) {
                        rec.uploadTimer = setTimeout(() => {
                            rec.uploadTimer = null;
                            if (!this._destroyed && rec.tex && rec.texDirty) {
                                this._updateTex(rec.tex);
                                rec.texDirty = false;
                            }
                        }, OVERLAY_UPLOAD_MS + 1);
                    }
                }
                rec.maxId = lastId;
                return;
            }
            rec.needFull = true; // expand bbox — fall through to full bake below
        }
        // full bake: canvas = LOCAL bbox of stains (scene px from mesh pivot) + margin
        // for satellite droplets and stroke growth, clamped to the texture frame ± pad
        // (beyond the frame, blood is masked out by transparency anyway).
        // Previously the ENTIRE mesh was baked: on giant tiles with blood in one corner,
        // that meant up to a 25 MB canvas and full upload on every bake event. The longest
        // side remains capped at `OVERLAY_MAX_PX` (bounding memory and upload cost)
        const w = mesh.width || doc?.width || 128, h = mesh.height || doc?.height || 128;
        const msx = mesh.scale?.x || 1, msy = mesh.scale?.y || 1;
        const ax = mesh.anchor?.x ?? 0.5, ay = mesh.anchor?.y ?? 0.5;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const st of rec.stains) {
            const X = st.x - px0, Y = st.y - py0;
            const lx = cos * X + sin * Y, ly = -sin * X + cos * Y;
            const r = this._stainSpanRadius(st) + pad;
            if (lx - r < bx0)
                bx0 = lx - r;
            if (ly - r < by0)
                by0 = ly - r;
            if (lx + r > bx1)
                bx1 = lx + r;
            if (ly + r > by1)
                by1 = ly + r;
        }
        // texture frame in local coordinates ± pad — blood beyond this is invisible
        const mnx = -ax * w - pad, mxx = (1 - ax) * w + pad;
        const mny = -ay * h - pad, mxy = (1 - ay) * h + pad;
        if (bx0 < mnx)
            bx0 = mnx;
        if (by0 < mny)
            by0 = mny;
        if (bx1 > mxx)
            bx1 = mxx;
        if (by1 > mxy)
            by1 = mxy;
        if (!Number.isFinite(bx0) || !(bx1 > bx0)) {
            bx0 = mnx;
            bx1 = Math.min(mxx, mnx + 128);
        }
        if (!Number.isFinite(by0) || !(by1 > by0)) {
            by0 = mny;
            by1 = Math.min(mxy, mny + 128);
        }
        const lw = Math.ceil(bx1 - bx0), lh = Math.ceil(by1 - by0);
        const kk = Math.min(k, OVERLAY_MAX_PX / Math.max(lw, lh));
        const lx0 = bx0, ly0 = by0;
        const needCanvas = !rec.canvas || rec.k !== kk || rec.lw !== lw || rec.lh !== lh;
        if (needCanvas) {
            try {
                rec.sprite?.destroy({ texture: true, baseTexture: true });
            }
            catch { /* empty */ }
            rec.sprite = null;
            rec.tex = null;
            rec.canvas = document.createElement('canvas');
            rec.canvas.width = Math.max(1, Math.round(lw * kk));
            rec.canvas.height = Math.max(1, Math.round(lh * kk));
            rec.ctx = rec.canvas.getContext('2d');
        }
        const octx = rec.ctx;
        const cw = rec.canvas.width, ch = rec.canvas.height;
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, cw, ch);
        const sorted = [...rec.stains].sort((a, b) => a.i - b.i);
        if (!hasOverlayCarve) {
            octx.setTransform(cos * kk, -sin * kk, sin * kk, cos * kk, kk * (-cos * px0 - sin * py0 - lx0), kk * (sin * px0 - cos * py0 - ly0));
            this._renderBaseMembersLayered(octx, sorted, null);
        }
        else {
            const carveList = [];
            const baseList = [];
            let hasNonSnow = false;
            let hasLowSnow = false;
            for (let i = 0; i < sorted.length; i++) {
                const st = sorted[i];
                if (this._isSnowCarveStain(st))
                    carveList.push(st);
                else {
                    baseList.push(st);
                    if (Number(st.m) !== 2)
                        hasNonSnow = true;
                    else if ((st.lv || 1) <= 2)
                        hasLowSnow = true;
                }
            }
            const needOverlayMask = hasNonSnow || hasLowSnow;
            if (!this._scratchOverlayCarve || this._scratchOverlayCarve.width < cw || this._scratchOverlayCarve.height < ch) {
                this._scratchOverlayCarve = document.createElement('canvas');
                this._scratchOverlayCarve.width = Math.max(cw, this._scratchOverlayCarve.width || 0);
                this._scratchOverlayCarve.height = Math.max(ch, this._scratchOverlayCarve.height || 0);
            }
            const cctx = this._scratchOverlayCarve.getContext('2d');
            let mctx = null;
            if (needOverlayMask) {
                if (!this._scratchOverlayMask || this._scratchOverlayMask.width < cw || this._scratchOverlayMask.height < ch) {
                    this._scratchOverlayMask = document.createElement('canvas');
                    this._scratchOverlayMask.width = Math.max(cw, this._scratchOverlayMask.width || 0);
                    this._scratchOverlayMask.height = Math.max(ch, this._scratchOverlayMask.height || 0);
                }
                mctx = this._scratchOverlayMask.getContext('2d');
                mctx.setTransform(1, 0, 0, 1, 0, 0);
                mctx.clearRect(0, 0, cw, ch);
                mctx.setTransform(cos * kk, -sin * kk, sin * kk, cos * kk, kk * (-cos * px0 - sin * py0 - lx0), kk * (sin * px0 - cos * py0 - ly0));
            }
            octx.setTransform(cos * kk, -sin * kk, sin * kk, cos * kk, kk * (-cos * px0 - sin * py0 - lx0), kk * (sin * px0 - cos * py0 - ly0));
            this._renderBaseMembersLayered(octx, baseList, mctx);
            if (carveList.length) {
                cctx.setTransform(1, 0, 0, 1, 0, 0);
                cctx.globalCompositeOperation = 'source-over';
                cctx.globalAlpha = 1;
                cctx.clearRect(0, 0, cw, ch);
                cctx.setTransform(cos * kk, -sin * kk, sin * kk, cos * kk, kk * (-cos * px0 - sin * py0 - lx0), kk * (sin * px0 - cos * py0 - ly0));
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'berm');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'rim');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'lip');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'wall');
                for (let i = 0; i < carveList.length; i++)
                    this._drawSnowCarvePass(cctx, carveList[i], 'bed');
                const maskCv = needOverlayMask ? this._scratchOverlayMask : rec.canvas;
                cctx.setTransform(1, 0, 0, 1, 0, 0);
                cctx.save();
                cctx.globalAlpha = 1;
                cctx.globalCompositeOperation = 'destination-in';
                cctx.drawImage(maskCv, 0, 0, cw, ch, 0, 0, cw, ch);
                cctx.globalCompositeOperation = 'source-over';
                cctx.restore();
                octx.setTransform(1, 0, 0, 1, 0, 0);
                octx.save();
                octx.globalAlpha = 0.18;
                octx.globalCompositeOperation = 'destination-out';
                octx.drawImage(this._scratchOverlayCarve, 0, 0, cw, ch, 0, 0, cw, ch);
                octx.globalAlpha = 0.88;
                octx.globalCompositeOperation = 'source-over';
                octx.drawImage(this._scratchOverlayCarve, 0, 0, cw, ch, 0, 0, cw, ch);
                octx.globalAlpha = 1;
                octx.restore();
            }
        }
        // tile texture alpha mask: wherever the tile texture is transparent, blood is erased.
        // The texture occupies the mesh's local frame [−ax·w .. (1−ax)·w] (anchor read from mesh;
        // `w` is the actual fitted width). On a fully opaque texture (JPEG map tiles), masking is a no-op
        rec.w = w;
        rec.h = h;
        rec.ax = ax;
        rec.ay = ay;
        rec.k = kk;
        rec.lx0 = lx0;
        rec.ly0 = ly0;
        rec.lw = lw;
        rec.lh = lh;
        rec.allOpaque = this._allOpaque(mesh);
        if (!rec.allOpaque)
            this._maskOverlay(rec, mesh);
        octx.setTransform(1, 0, 0, 1, 0, 0);
        if (!rec.sprite) {
            rec.tex = PIXI.Texture.from(rec.canvas);
            rec.sprite = new PIXI.Sprite(rec.tex);
            rec.sprite.eventMode = 'none';
            const rendererSelf = this;
            const origUpdateTransform = rec.sprite.updateTransform;
            if (typeof origUpdateTransform === 'function') {
                rec.sprite.updateTransform = function () {
                    if (this.parent) {
                        this.alpha = rendererSelf._computeOverlayAlpha(this.parent);
                    }
                    return origUpdateTransform.call(this);
                };
            }
            const origRender = rec.sprite._render;
            if (typeof origRender === 'function') {
                rec.sprite._ssFadeWrapped = true;
                rec.sprite._render = function (pixiRenderer) {
                    const parentMesh = this.parent;
                    const nextAlpha = rendererSelf._computeOverlayAlpha(parentMesh);
                    this.alpha = nextAlpha;
                    this.worldAlpha = nextAlpha * (parentMesh?.worldAlpha ?? 1);
                    if (this.worldAlpha <= 0.001)
                        return;
                    return origRender.call(this, pixiRenderer);
                };
            }
        }
        else {
            this._updateTex(rec.tex);
            rec.texDirty = false;
            rec.lastUpload = performance.now();
        }
        // canvas in scene px from pivot → mesh texel space
        rec.sprite.position.set(lx0 / msx, ly0 / msy);
        rec.sprite.scale.set(1 / (msx * kk), 1 / (msy * kk));
        if (rec.sprite.parent !== mesh)
            mesh.addChild(rec.sprite);
        rec.sprite.alpha = this._computeOverlayAlpha(mesh, doc);
        rec.maxId = lastId;
        rec.missed = 0;
        rec.needFull = false;
    }
    /**
     * Pixel-level alpha mask of the overlay using the tile texture's alpha channel: `destination-in`
     * draw of the source image inside the mesh's local frame [−ax·w .. (1−ax)·w]. Mandatory AFTER
     * EVERY bake (both full and tail) — without it, appended stains float over transparent pixels.
     * Transient failures (unready video, broken source) do not permanently drop the mask: the layer
     * remains marked for a full rebake.
     */
    _maskOverlay(rec, mesh, clip = null) {
        const octx = rec.ctx;
        const tex = mesh?.texture;
        const src = tex?.baseTexture?.resource?.source;
        if (!octx || !src)
            return;
        // save/restore are MANDATORY: clip() narrows the drawing region and persists
        // on the context until restore() — omitting the pair permanently poisons the tile canvas
        // (including full bakes) so the tile stops accepting blood
        octx.save();
        octx.globalAlpha = 1; // alpha left over from stain drawing MUST NOT multiply
        // into `destination-in` — otherwise all blood on the tile dims out
        octx.setTransform(1, 0, 0, 1, 0, 0);
        if (clip) {
            // clip in canvas px (identity): mask only the tail stains' region
            octx.beginPath();
            octx.rect(clip.x, clip.y, clip.w, clip.h);
            octx.clip();
        }
        // source texels → canvas: canvas = kk·(S·(texel − A·orig) − l0)
        const fw = tex.width || 1, fh = tex.height || 1;
        const msx = mesh.scale?.x || 1, msy = mesh.scale?.y || 1;
        const origW = tex.orig?.width || fw, origH = tex.orig?.height || fh;
        const ax = mesh.anchor?.x ?? 0.5, ay = mesh.anchor?.y ?? 0.5;
        octx.setTransform(rec.k * msx, 0, 0, rec.k * msy, rec.k * (msx * ((tex.frame?.x ?? 0) - ax * origW) - rec.lx0), rec.k * (msy * ((tex.frame?.y ?? 0) - ay * origH) - rec.ly0));
        octx.globalCompositeOperation = 'destination-in';
        try {
            octx.drawImage(src, tex.frame?.x ?? 0, tex.frame?.y ?? 0, fw, fh, 0, 0, fw, fh);
            rec.maskFails = 0;
        }
        catch {
            // unready video / broken source: leave unmasked for this frame only, then retry full bake
            rec.maskFails = (rec.maskFails ?? 0) + 1;
            if (rec.maskFails <= 5)
                rec.needFull = true;
        }
        octx.globalCompositeOperation = 'source-over';
        octx.restore();
    }
    /**
     * Is the texture completely opaque? Checked via Foundry's 0.25-scale alpha cache:
     * the bbox covers the full dimensions AND no pixel has alpha below 250. For such
     * textures (alpha-free JPEG maps — a common case), `destination-in` is a mathematical
     * no-op so masking is skipped entirely. Missing data → false (apply mask).
     * POSITIVE verdicts are cached per texture UUID (scanning a 1 MB alpha cache takes up to
     * 654 µs and should not repeat on every full bake); negative verdicts are NOT cached
     * because alpha data may finish loading later and flip the verdict.
     */
    _allOpaque(mesh) {
        const tex = mesh?.texture;
        if (tex?.uuid && this._opaqueTex.has(tex.uuid))
            return true;
        const ok = this._scanOpaque(mesh);
        if (ok && tex?.uuid)
            this._opaqueTex.set(tex.uuid, true);
        return ok;
    }
    _scanOpaque(mesh) {
        const ad = mesh?._textureAlphaData;
        if (!ad || !ad.data || !(ad.maxX > 0) || !(ad.maxY > 0))
            return false;
        // core fields are width/height (NOT w/h): maxX/maxY are exclusive, so a fully
        // opaque texture's bbox spans the entire dimensions
        if (ad.minX !== 0 || ad.minY !== 0 || ad.maxX !== ad.width || ad.maxY !== ad.height)
            return false;
        for (let i = 0; i < ad.data.length; i++)
            if (ad.data[i] < 250)
                return false;
        return true;
    }
    /** Compute the effective tile overlay opacity synced with Foundry v14 hover-fade and occlusion state. */
    _computeOverlayAlpha(mesh, doc = mesh?.object?.document) {
        const unocc = Number.isFinite(mesh?.unoccludedAlpha)
            ? Number(mesh.unoccludedAlpha)
            : (Number.isFinite(doc?.alpha) ? Number(doc.alpha) : 1);
        const occA = Number.isFinite(mesh?.occludedAlpha)
            ? Number(mesh.occludedAlpha)
            : (Number.isFinite(doc?.occlusion?.alpha) ? Number(doc.occlusion.alpha) : 0);
        const hoverOcc = Number(mesh?._hoverFadeState?.occlusion) || 0;
        const fadeOcc = Number(mesh?._occlusionState?.fade) || 0;
        const occ = Math.max(0, Math.min(1, Math.max(hoverOcc, fadeOcc, mesh?.occluded ? 1 : 0)));
        return Math.max(0, Math.min(1, unocc + (occA - unocc) * occ));
    }
    _destroyOverlay(tid) {
        const rec = this._overlays.get(tid);
        this._overlays.delete(tid);
        if (!rec)
            return;
        clearTimeout(rec.uploadTimer);
        rec.uploadTimer = null;
        try {
            rec.sprite?.destroy({ texture: true, baseTexture: true });
        }
        catch { /* empty */ }
        rec.sprite = null;
        rec.tex = null;
        rec.canvas = null;
        rec.ctx = null;
    }
    _updateTex(tex) {
        try {
            if (tex.source?.update)
                tex.source.update();
            else
                tex.baseTexture?.update();
        }
        catch { /* empty */ }
    }
    /* ------------------------------ stain shape ------------------------------ */
    /** Render a dense alpha silhouette of a snow stain into the separate mask buffer (`snowMask` / `mctx`). */
    _drawSnowMaskStain(ctx, st) {
        if ((Number(st.m) || 0) !== 2)
            return;
        const rng = _scratchRng.reset(st.seed);
        const kind = st.t === STAIN.FOOTPRINT
            ? (FP_KIND_BY_SUBTYPE[st.fp] ?? 'footprint')
            : (KIND_BY_TYPE[st.t] ?? 'splat');
        const kindN = Math.max(1, BloodAtlas.kindCount(kind));
        const variant = rng.int(kindN);
        const col = parseColor(st.c);
        const colA = col ? (col.a ?? 1) : 1;
        const size = st.s * rng.range(0.94, 1.06);
        let alphaMul = 1, grow = 1;
        const fade = this._fading.get(st.i);
        if (fade) {
            const p = Math.min(1, Math.max(0, (performance.now() - fade.start) / Math.max(1, fade.ms)));
            alphaMul = p;
            if (fade.grow)
                grow = 1 - Math.pow(1 - p, 3);
        }
        const baseAlpha = st.a * colA * rng.range(0.92, 1) * alphaMul;
        const rot = st.r + rng.range(-0.05, 0.05);
        const snowRot = rot;
        const lv = st.lv || 1;
        const maskScale = lv >= 5 ? 1.15 : lv === 4 ? 1.11 : lv === 3 ? 1.07 : lv === 2 ? 1.03 : 1.0;
        const maskOx = lv >= 5 ? size * 0.048 : lv === 4 ? size * 0.036 : lv === 3 ? size * 0.024 : 0;
        const maskOy = lv >= 5 ? size * 0.055 : lv === 4 ? size * 0.042 : lv === 3 ? size * 0.028 : 0;
        const mSize = size * maskScale;
        const maskImg = BloodAtlas.tinted(kind, variant, '#d8e0ec', 2);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, baseAlpha * (lv >= 3 ? 0.98 : 0.94));
        ctx.translate(st.x + maskOx, st.y + maskOy);
        ctx.rotate(snowRot);
        if (grow !== 1)
            ctx.scale(grow, grow);
        ctx.drawImage(maskImg, -mSize / 2, -mSize / 2, mSize, mSize);
        ctx.restore();
        ctx.globalAlpha = 1;
    }
    _drawStain(ctx, st) {
        // scratch RNG: identical sequence to `new Rng(seed)` without allocating
        // a new object per stain on every bake
        const rng = _scratchRng.reset(st.seed);
        const kind = st.t === STAIN.FOOTPRINT
            ? (FP_KIND_BY_SUBTYPE[st.fp] ?? 'footprint')
            : (KIND_BY_TYPE[st.t] ?? 'splat');
        const kindN = Math.max(1, BloodAtlas.kindCount(kind));
        const variant = rng.int(kindN);
        const material = Number(st.m) || 0;
        // COLOR alpha (#rrggbbaa): atlas tiles are cached by rgb (see `tinted`), while
        // color alpha is applied here — algebraically identical to pre-multiplying it into the tile
        const col = parseColor(st.c);
        const colA = col ? (col.a ?? 1) : 1;
        // aging (drying): old blood darkens and fades. `dry` is QUANTIZED (8 steps)
        // for COLOR — continuous `dry` produced a unique RGB per stain (each with its own `T`),
        // thrashing the tinted-tile LRU cache during a single dense chunk bake;
        // alpha stays continuous (does not touch the cache key)
        const dry = _dryK(this, st);
        const dryQ = Math.round(dry * 8) / 8;
        const drawColor = dryQ > 0 ? shadeHex(st.c, -0.45 * dryQ) : st.c;
        const wash = (material === 0 && !st.nw) ? this._wash : 1;
        let size = st.s * rng.range(0.94, 1.06);
        // fade-in (f) and grow (g): progress-driven alpha and scale
        let alphaMul = 1, grow = 1;
        const fade = this._fading.get(st.i);
        if (fade) {
            const p = Math.min(1, Math.max(0, (performance.now() - fade.start) / Math.max(1, fade.ms)));
            alphaMul = p;
            if (fade.grow)
                grow = 1 - Math.pow(1 - p, 3); // easeOutCubic
        }
        const stainA = st.a * colA;
        const dryFade = st.t === STAIN.FOOTPRINT ? 0.48 : 0.22;
        const baseAlpha = stainA * rng.range(0.92, 1) * alphaMul * (1 - dryFade * dry) * wash;
        const rot = st.r + rng.range(-0.05, 0.05);
        const isPureSnow = material === 2 && !(col && (col.r > col.b + 16 || col.g > col.b + 16));
        const toneIdx = ((st.seed >>> 3) + (st.seed >>> 11) + variant) % 6;
        const snowTone = SNOW_TONE_FAMILIES[toneIdx];
        // Full arbitrary rotation of the snow silhouette (`st.r`): because all 3D shading offsets (ao/bank/terrace/plateau/crest)
        // are applied via `ctx.translate` IN WORLD COORDINATES BEFORE `ctx.rotate` and micro-grain is applied in world space,
        // lighting stays strictly NW→SE while stamps never repeat identical silhouettes ("caterpillar" tracks)!
        const snowRot = rot;
        const driftPass = this._currentDriftPass;
        // When writing into the separate snow mask canvas (`snowMask` / `mctx`),
        // stamp a dense single-pass snow alpha silhouette (0.94..0.98) in `source-over`
        // so boot prints (`FOOTPRINT`) retain crisp relief on both light snow (`lv<=2`) and drifts (`lv>=3`)!
        if (material === 2 && driftPass === 'mask') {
            const lv = st.lv || 1;
            const maskScale = lv >= 5 ? 1.15 : lv === 4 ? 1.11 : lv === 3 ? 1.07 : lv === 2 ? 1.03 : 1.0;
            const maskOx = lv >= 5 ? size * 0.048 : lv === 4 ? size * 0.036 : lv === 3 ? size * 0.024 : 0;
            const maskOy = lv >= 5 ? size * 0.055 : lv === 4 ? size * 0.042 : lv === 3 ? size * 0.028 : 0;
            const mSize = size * maskScale;
            const maskImg = BloodAtlas.tinted(kind, variant, '#d8e0ec', 2);
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = Math.min(1, baseAlpha * (lv >= 3 ? 0.98 : 0.94));
            ctx.translate(st.x + maskOx, st.y + maskOy);
            ctx.rotate(snowRot);
            if (grow !== 1)
                ctx.scale(grow, grow);
            ctx.drawImage(maskImg, -mSize / 2, -mSize / 2, mSize, mSize);
            ctx.restore();
            ctx.globalAlpha = 1;
            return;
        }
        if (material === 2 && st.lv >= 2) {
            const driftAlpha = alphaMul * (1 - 0.22 * dry) * wash;
            const wx = st.x + Math.sin(st.y * 0.0075 + 0.8) * 54 + Math.cos(st.x * 0.0058 - 1.2) * 38;
            const wy = st.y + Math.cos(st.x * 0.0072 - 0.5) * 54 + Math.sin(st.y * 0.0062 + 1.7) * 38;
            const uWind = (wx * 0.72 + wy * 0.69) * 0.0165 + 1.35;
            const vWind = (wx * 0.69 - wy * 0.72) * 0.0145;
            const phaseU = uWind + Math.cos(vWind * 1.05) * 1.05 + Math.sin(vWind * 0.62 + 0.9) * 0.45;
            const phi = ((phaseU / (Math.PI * 2)) % 1 + 1) % 1;
            const crossLobe = 0.5 + 0.5 * Math.cos(vWind * 0.92 + Math.sin(uWind * 0.68) * 0.70);
            let barchan = 0;
            if (phi < 0.58) {
                const tUp = phi / 0.58;
                barchan = tUp * tUp * (3 - 2 * tUp);
            }
            else if (phi < 0.82) {
                const tDown = (phi - 0.58) / 0.24;
                barchan = 1 - tDown * tDown * (3 - 2 * tDown);
            }
            const crestWave = barchan * (0.28 + 0.72 * crossLobe);
            if (st.lv === 2) {
                // Level 2 (Snow cover): dense fluffy snow blanket with a soft SE shadow rim (holds footprints)
                if (!driftPass || driftPass === 'slope') {
                    const slopeSize = size * 0.99;
                    const slopeImg = BloodAtlas.tinted(kind, variant, isPureSnow ? snowTone.flatEdge : '#666a72', 2);
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.56);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.translate(st.x + size * 0.028, st.y + size * 0.032);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(slopeImg, -slopeSize / 2, -slopeSize / 2, slopeSize, slopeSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'body') {
                    const bodySize = size * 0.98;
                    const flatColor = isPureSnow ? snowTone.flat : drawColor;
                    const img = BloodAtlas.tinted(kind, variant, flatColor, 2);
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.99);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.translate(st.x - size * 0.008, st.y - size * 0.009);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(img, -bodySize / 2, -bodySize / 2, bodySize, bodySize);
                    ctx.restore();
                }
            }
            else if (st.lv === 3) {
                // Level 3 (Small snowdrift): 3 passes (ao → bank → plateau).
                // `plateau` (0.95x @ -2.2%) completely covers `bank` on the sunlit NW side (eliminating dark halos around stamps!),
                // exposing the volumetric leeward slope and cast shadow exclusively on the SE side.
                if (!driftPass || driftPass === 'ao') {
                    const aoSize = size * 1.01;
                    const aoCol = isPureSnow ? '#3e4856' : shadeHex(drawColor, -0.45);
                    const aoImg = BloodAtlas.tinted(kind, variant, aoCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.34);
                    ctx.translate(st.x + size * 0.055, st.y + size * 0.064);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(aoImg, -aoSize / 2, -aoSize / 2, aoSize, aoSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'bank') {
                    const bankSize = size * 0.98;
                    const bankCol = isPureSnow ? '#7c8a9c' : shadeHex(drawColor, -0.28);
                    const bankImg = BloodAtlas.tinted(kind, variant, bankCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.96);
                    ctx.translate(st.x + size * 0.030, st.y + size * 0.035);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(bankImg, -bankSize / 2, -bankSize / 2, bankSize, bankSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'plateau') {
                    const plateauSize = size * 0.95;
                    const plateauCol = isPureSnow ? '#d8e0ec' : drawColor;
                    const plateauImg = BloodAtlas.tinted(kind, variant, plateauCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha);
                    ctx.translate(st.x - size * 0.022, st.y - size * 0.025);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(plateauImg, -plateauSize / 2, -plateauSize / 2, plateauSize, plateauSize);
                    ctx.restore();
                }
            }
            else if (st.lv === 4) {
                // Level 4 (Deep snowdrift): 4 passes (ao → bank → plateau → crest) with a tall SE slope and sunlit NW cornice
                if (!driftPass || driftPass === 'ao') {
                    const aoSize = size * 1.03;
                    const aoCol = isPureSnow ? '#3e4856' : shadeHex(drawColor, -0.45);
                    const aoImg = BloodAtlas.tinted(kind, variant, aoCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.42);
                    ctx.translate(st.x + size * 0.082, st.y + size * 0.094);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(aoImg, -aoSize / 2, -aoSize / 2, aoSize, aoSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'bank') {
                    const bankSize = size * 0.99;
                    const bankCol = isPureSnow ? '#768496' : shadeHex(drawColor, -0.28);
                    const bankImg = BloodAtlas.tinted(kind, variant, bankCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.98);
                    ctx.translate(st.x + size * 0.044, st.y + size * 0.050);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(bankImg, -bankSize / 2, -bankSize / 2, bankSize, bankSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'plateau') {
                    const plateauSize = size * 0.94;
                    const plateauCol = isPureSnow ? '#e4ebf4' : drawColor;
                    const plateauImg = BloodAtlas.tinted(kind, variant, plateauCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha);
                    ctx.translate(st.x - size * 0.030, st.y - size * 0.034);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(plateauImg, -plateauSize / 2, -plateauSize / 2, plateauSize, plateauSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'crest') {
                    const crestSize = size * 0.72;
                    const crestCol = isPureSnow ? '#ffffff' : shadeHex(drawColor, 0.18);
                    const crestImg = BloodAtlas.tinted(kind, variant, crestCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * (0.68 + 0.32 * Math.pow(crestWave, 0.80)));
                    ctx.translate(st.x - size * 0.054, st.y - size * 0.062);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(crestImg, -crestSize / 2, -crestSize / 2, crestSize, crestSize);
                    ctx.restore();
                }
            }
            else {
                // Level 5 (Tall barchan drift): 5 passes (ao → bank → terrace → plateau → crest) — monumental drift with terrace and cornice
                if (!driftPass || driftPass === 'ao') {
                    const aoSize = size * 1.05;
                    const aoCol = isPureSnow ? '#3e4856' : shadeHex(drawColor, -0.45);
                    const aoImg = BloodAtlas.tinted(kind, variant, aoCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.48);
                    ctx.translate(st.x + size * 0.110, st.y + size * 0.125);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(aoImg, -aoSize / 2, -aoSize / 2, aoSize, aoSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'bank') {
                    const bankSize = size * 1.01;
                    const bankCol = isPureSnow ? '#707e90' : shadeHex(drawColor, -0.28);
                    const bankImg = BloodAtlas.tinted(kind, variant, bankCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.98);
                    ctx.translate(st.x + size * 0.060, st.y + size * 0.068);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(bankImg, -bankSize / 2, -bankSize / 2, bankSize, bankSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'terrace') {
                    const terraceSize = size * 0.96;
                    const terraceCol = isPureSnow ? '#a8b4c4' : shadeHex(drawColor, -0.14);
                    const terraceImg = BloodAtlas.tinted(kind, variant, terraceCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * 0.98);
                    ctx.translate(st.x + size * 0.024, st.y + size * 0.028);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(terraceImg, -terraceSize / 2, -terraceSize / 2, terraceSize, terraceSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'plateau') {
                    const plateauSize = size * 0.93;
                    const plateauCol = isPureSnow ? '#eef3fa' : drawColor;
                    const plateauImg = BloodAtlas.tinted(kind, variant, plateauCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha);
                    ctx.translate(st.x - size * 0.036, st.y - size * 0.042);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(plateauImg, -plateauSize / 2, -plateauSize / 2, plateauSize, plateauSize);
                    ctx.restore();
                }
                if (!driftPass || driftPass === 'crest') {
                    const crestSize = size * 0.68;
                    const crestCol = isPureSnow ? '#ffffff' : shadeHex(drawColor, 0.18);
                    const crestImg = BloodAtlas.tinted(kind, variant, crestCol, 2);
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = Math.min(1, driftAlpha * (0.76 + 0.24 * Math.pow(crestWave, 0.78)));
                    ctx.translate(st.x - size * 0.066, st.y - size * 0.075);
                    ctx.rotate(snowRot);
                    if (grow !== 1)
                        ctx.scale(grow, grow);
                    ctx.drawImage(crestImg, -crestSize / 2, -crestSize / 2, crestSize, crestSize);
                    ctx.restore();
                }
            }
        }
        else {
            // Level 1 (Light snow dusting): airy lace-like frost veil with natural floor gaps showing through
            const effectiveColor = isPureSnow ? snowTone.frost : drawColor;
            const img = BloodAtlas.tinted(kind, variant, effectiveColor, material);
            ctx.globalAlpha = material === 2 ? Math.min(1, baseAlpha * 0.84) : baseAlpha;
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.translate(st.x, st.y);
            ctx.rotate(snowRot);
            if (grow !== 1)
                ctx.scale(grow, grow);
            ctx.drawImage(img, -size / 2, -size / 2, size, size);
            ctx.restore();
        }
        ctx.globalAlpha = 1; // RESET IS MANDATORY before the early return below: smears/droplets/
        // snow/mud prints get no satellites, and leaving `globalAlpha < 1` would leak into the
        // overlay's `destination-in` mask, dimming ALL blood on the tile with every bake
        // satellite droplets; droplets, smears, drips, handprints, snow (material === 2), and
        // snow/mud footprints do not get them (snow frost is already baked into the atlas mask).
        // Bloody footprints ("wet step") get 1–2 sparse droplets near the boot
        const isPrint = st.t === STAIN.FOOTPRINT;
        const nDrops = material === 2 ? 0
            : isPrint ? ((material === 0 && stainA >= 0.48) ? 1 + rng.int(2) : 0)
                : st.t === STAIN.POOL ? 2 + rng.int(4)
                    : st.t === STAIN.SPLASH ? 5 + rng.int(9)
                        : st.t === STAIN.SPLAT ? 4 + rng.int(8)
                            : 0;
        if (!nDrops)
            return;
        const dropCount = BloodAtlas.kindCount('droplet');
        ctx.globalAlpha = stainA * 0.9 * alphaMul * (1 - dryFade * dry) * wash;
        for (let i = 0; i < nDrops; i++) {
            const angle = isPrint ? st.r + rng.range(-0.9, 0.9)
                : st.t === STAIN.SPLASH
                    ? st.r + rng.range(-0.55, 0.55)
                    : rng.angle();
            const distFrac = isPrint ? rng.range(0.5, 0.72) : rng.range(0.35, 0.62);
            if (!this._sectorAllowed(st, angle, distFrac))
                continue;
            const ds = st.s * (isPrint ? rng.range(0.035, 0.075) : rng.range(0.05, 0.14)) * grow;
            const d = distFrac * st.s * grow;
            const img2 = BloodAtlas.tinted('droplet', rng.int(dropCount), drawColor, material);
            ctx.save();
            ctx.translate(st.x + Math.cos(angle) * d, st.y + Math.sin(angle) * d);
            ctx.rotate(angle);
            ctx.drawImage(img2, -ds / 2, -ds / 2, ds, ds);
            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }
    /**
     * Wall profile: 16 sectors, each hex digit = allowed distance fraction
     * (`f` = unobstructed). Any droplet beyond the sector's allowed fraction is skipped.
     */
    _sectorAllowed(st, angle, distFrac) {
        if (!st.w || st.w.length < 16)
            return true;
        let a = angle % TAU;
        if (a < 0)
            a += TAU;
        const sector = Math.min(15, Math.floor((a / TAU) * 16));
        const allowed = parseInt(st.w[sector], 16) / 15;
        return distFrac <= allowed;
    }
}
