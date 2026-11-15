/**
 * "Blood Zone" region behavior (showstopper.bloodZone) — modeled after
 * "Snow Zone": v14 TypeDataModel pattern (class = model, form is built
 * from defineSchema for free); the engine reads data directly with no region events.
 *
 * Modes:
 *   none    — automatic blood generation in the region is SUPPRESSED (interiors,
 *             altars, "bloodless" scenes); the GM's manual brush is not gated.
 *   tracked — "hunting grounds": stains spawned inside carry nw (no-wash)
 *             and are not washed away by rain; generation works as normal.
 *
 * Point testing is O(regions) against polygonTrees with a lazy cache (invalidated
 * immediately on region/behavior CRUD hooks; calls are infrequent — GM generation
 * points only). The "tracked" decision is baked AT GENERATION TIME (`nw` field on
 * the stain record), so rendering pays zero cost.
 */
import { MODULE_ID } from '../config.mjs';
import { currentLevelId } from './elevation.mjs';
export const BLOOD_ZONE_TYPE = `${MODULE_ID}.bloodZone`;
let _cache = null;
let _cacheScene = null;
let _cacheRegions = null;
let _hooksOn = false;
/** Single authoritative writer (deterministic first active GM). */
export function isBloodZoneWriter() {
    try {
        const gms = game.users
            .filter(u => u?.active && u?.isGM)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return gms.length ? gms[0].id === game.user.id : false;
    }
    catch {
        return game.user.isGM;
    }
}
function _invalidate() {
    _cache = null;
    _cacheScene = null;
    _cacheRegions = null;
}
/** Cached polygonTrees grouped by mode (none/tracked) with owning region for level checks. */
function _sets() {
    const sc = canvas.scene ?? null;
    const regs = sc?.regions ?? null;
    if (_cache && _cacheScene === sc && _cacheRegions === regs)
        return _cache;
    const sets = { none: [], tracked: [] };
    for (const region of regs ?? []) {
        try {
            const modes = new Set();
            for (const b of region.behaviors ?? []) {
                if (!b || b.disabled || b.type !== BLOOD_ZONE_TYPE)
                    continue;
                const mode = b.system?.mode;
                if (mode in sets)
                    modes.add(mode);
            }
            if (!modes.size)
                continue;
            const tree = region.polygonTree;
            if (!tree?.testPoint)
                continue;
            for (const m of modes)
                sets[m].push({ tree, region });
        }
        catch { /* malformed region must not break generation */ }
    }
    _cache = sets;
    _cacheScene = sc;
    _cacheRegions = regs;
    return sets;
}
/**
 * Blood zone mode at a point: priority is none (suppress) > tracked.
 * Returns null if no blood zone covers the point on `levelId` (normal generation rules apply).
 */
export function bloodZoneModeAt(x, y, levelId = currentLevelId()) {
    const s = _sets();
    const inLevel = (entry) => !levelId || typeof entry.region?.includedInLevel !== 'function' || entry.region.includedInLevel(levelId);
    for (const e of s.none)
        if (inLevel(e) && e.tree.testPoint({ x, y }))
            return 'none';
    for (const e of s.tracked)
        if (inLevel(e) && e.tree.testPoint({ x, y }))
            return 'tracked';
    return null;
}
/** Register behavior type (on init) + invalidate cache on region CRUD hooks. */
export function registerBloodZoneBehavior() {
    const cfg = globalThis.CONFIG?.RegionBehavior;
    const fields = globalThis.foundry?.data?.fields;
    const base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType
        ?? globalThis.foundry?.data?.RegionBehaviorType;
    if (!cfg?.dataModels || !fields?.StringField || !base) {
        console.warn(`${MODULE_ID} | RegionBehavior API unavailable — blood zones disabled`);
        return;
    }
    if (!cfg.dataModels[BLOOD_ZONE_TYPE]) {
        const L = (key) => game.i18n.localize(`${MODULE_ID}.regionBehaviors.bloodZone.${key}`);
        class BloodZoneBehaviorType extends base {
            static LOCALIZATION_PREFIXES = [`showstopper.regionBehaviors.bloodZone`, 'BEHAVIOR.TYPES.base'];
            static defineSchema() {
                return {
                    mode: new fields.StringField({
                        required: true,
                        initial: 'none',
                        blank: false,
                        choices: {
                            none: L('modes.none'),
                            tracked: L('modes.tracked')
                        }
                    })
                };
            }
        }
        cfg.dataModels[BLOOD_ZONE_TYPE] = BloodZoneBehaviorType;
        try {
            cfg.typeLabels ??= {};
            cfg.typeLabels[BLOOD_ZONE_TYPE] = L('label');
            cfg.typeIcons ??= {};
            cfg.typeIcons[BLOOD_ZONE_TYPE] = 'fas fa-droplet';
            cfg.typeHints ??= {};
            cfg.typeHints[BLOOD_ZONE_TYPE] = L('labelHint');
        }
        catch { /* cosmetic — non-critical */ }
    }
    if (_hooksOn)
        return;
    _hooksOn = true;
    for (const hook of ['createRegion', 'updateRegion', 'deleteRegion', 'createRegionBehavior', 'updateRegionBehavior', 'deleteRegionBehavior']) {
        Hooks.on(hook, _invalidate);
    }
    Hooks.on('canvasReady', _invalidate);
}
