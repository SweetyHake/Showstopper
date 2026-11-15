/**
 * Scene surfaces: resolving where blood "lands" — PIXEL-ACCURATE via core's
 * native hit-testing mechanism.
 *
 * Surface sources are tiles on `canvas.tiles` (in v14 this covers ALL scene tiles:
 * `canvas.background`/`canvas.foreground` are scene background image sprites with
 * no placeables). Each tile has `document.elevation` (0 by default). The floor (0)
 * always exists.
 *
 * `surfaceAt` iterates tiles TOP-TO-BOTTOM by elevation: the highest tile whose
 * texture is opaque at the point catches the blood; transparent pixels let it pass
 * through to a lower tile or the floor. Pixel hit-testing is delegated to CORE —
 * `mesh.containsCanvasPoint(point, threshold)`: the same mechanism used for roof
 * occlusion (`TextureLoader.getTextureAlphaData` cache + the tile's configured
 * `texture.alphaThreshold`), accounting for rotation, scale, and texture fit mode.
 * Our floor threshold is alpha 10/255 so invisible PNG halos do not catch blood.
 */
const EPSILON = 0.51; // elevation comparison tolerance (tiles typically use integer elevations)
const BLOOD_ALPHA_MIN = 10 / 255; // minimum alpha for a pixel to count as solid
// Manual brush elevation bounds: shared between Q/E hotkeys and the HUD input field (BrushElevation)
export const BRUSH_ELEV_MIN = -100;
export const BRUSH_ELEV_MAX = 500;
/** Resolve a Scene Level document from an ID, Level object, or the active `canvas.level`. */
export function resolveLevel(levelOrId = null, scene = null) {
    const cv = globalThis.canvas;
    const sc = scene ?? cv?.scene ?? null;
    if (levelOrId && typeof levelOrId === 'object')
        return levelOrId;
    if (typeof levelOrId === 'string' && levelOrId) {
        const found = sc?.levels?.get?.(levelOrId);
        if (found)
            return found;
    }
    return cv?.level ?? null;
}
/** Active viewed Level ID on the canvas (`null` on single-level / headless scenes). */
export function currentLevelId() {
    return globalThis.canvas?.level?.id ?? null;
}
/**
 * Base floor elevation for a Scene Level (Foundry VTT v14):
 * returns `level.elevation.base` / `bottom`, falling back to `canvas.primary.background.elevation` or `0`.
 */
export function levelBaseElevation(levelOrId = null, scene = null) {
    const lvl = resolveLevel(levelOrId, scene);
    const elev = lvl?.elevation;
    if (elev) {
        const base = Number(elev.base);
        if (Number.isFinite(base))
            return base;
        const bottom = Number(elev.bottom);
        if (Number.isFinite(bottom))
            return bottom;
    }
    const bgElev = Number(globalThis.canvas?.primary?.background?.elevation);
    if (Number.isFinite(bgElev))
        return bgElev;
    return 0;
}
function _levelElevationRange(lvl) {
    const rawB = lvl?.elevation?.bottom;
    const rawT = lvl?.elevation?.top;
    const bottom = (rawB !== null && rawB !== undefined && rawB !== '' && Number.isFinite(Number(rawB)))
        ? Number(rawB)
        : levelBaseElevation(lvl);
    const top = (rawT !== null && rawT !== undefined && rawT !== '' && Number.isFinite(Number(rawT)))
        ? Number(rawT)
        : Infinity;
    return { bottom, top };
}
/** Whether `levelId` is currently visible when viewing `viewedLevel` (self or in `visibility.levels`). */
export function isLevelVisible(levelId, viewedLevel = null) {
    if (!levelId)
        return true;
    const cv = globalThis.canvas;
    const viewed = viewedLevel ?? cv?.level ?? null;
    if (!viewed)
        return true;
    if (viewed.id === levelId)
        return true;
    if (viewed.visibility?.levels?.has?.(levelId))
        return true;
    const lvl = cv?.scene?.levels?.get?.(levelId);
    if (lvl && typeof lvl.isVisible === 'boolean')
        return lvl.isVisible;
    return false;
}
function _elevInVisibleLevels(e, viewed, scene) {
    const checkLvl = (lvl) => {
        if (!lvl)
            return false;
        const { bottom, top } = _levelElevationRange(lvl);
        if (bottom === top)
            return Math.abs(e - bottom) < EPSILON;
        return e >= bottom - EPSILON && e < top;
    };
    if (checkLvl(viewed))
        return true;
    const visIds = viewed?.visibility?.levels;
    if (visIds && scene?.levels?.get) {
        for (const id of visIds) {
            if (checkLvl(scene.levels.get(id)))
                return true;
        }
    }
    return false;
}
/** Whether a stain record should be rendered when viewing `viewedLevel` (defaults to `canvas.level`). */
export function isStainVisibleOnLevel(st, viewedLevel = null) {
    if (!st)
        return false;
    const cv = globalThis.canvas;
    const viewed = viewedLevel ?? cv?.level ?? null;
    if (!viewed)
        return true;
    const scene = cv?.scene ?? null;
    const levels = scene?.levels;
    if (st.lvl) {
        if (!levels || !levels.size || levels.has(st.lvl)) {
            return isLevelVisible(st.lvl, viewed);
        }
        // Deleted level ID on an existing stain — fall back to elevation matching
    }
    if (!levels || levels.size <= 1)
        return true;
    return _elevInVisibleLevels(Number(st.e) || 0, viewed, scene);
}
/**
 * Whether a stain belongs to `levelId` for physical ground interactions
 * (footprints, snow trampling, brush lower-sculpt).
 */
export function stainMatchesLevel(st, levelId = currentLevelId()) {
    if (!st)
        return false;
    if (!levelId)
        return true;
    if (st.lvl)
        return st.lvl === levelId;
    // Legacy stains without `lvl`: on multi-level scenes, only match if visible on that level
    const cv = globalThis.canvas;
    const levels = cv?.scene?.levels;
    if (!levels || levels.size <= 1)
        return true;
    const lvl = resolveLevel(levelId);
    return lvl ? _elevInVisibleLevels(Number(st.e) || 0, lvl, cv?.scene) : true;
}
/**
 * Find a lower visible Level beneath `lvl` when the viewed level's background texture
 * has a genuinely transparent hole (balcony / stairwell opening) at `(x, y)`.
 */
function _lowerVisibleLevelAt(lvl, x, y, upTo) {
    const cv = globalThis.canvas;
    if (!lvl || lvl !== cv?.level)
        return null;
    if (!lvl.background?.src)
        return null;
    const bgMesh = cv?.primary?.background;
    if (!bgMesh || typeof bgMesh.containsCanvasPoint !== 'function')
        return null;
    const visIds = lvl.visibility?.levels;
    const sceneLevels = cv?.scene?.levels;
    if (!visIds?.size || !sceneLevels?.get)
        return null;
    const floorE = levelBaseElevation(lvl);
    let best = null;
    let bestE = -Infinity;
    for (const id of visIds) {
        if (id === lvl.id)
            continue;
        const cand = sceneLevels.get(id);
        if (!cand)
            continue;
        const ce = levelBaseElevation(cand);
        if (ce < floorE && ce <= upTo && ce > bestE) {
            bestE = ce;
            best = cand;
        }
    }
    if (!best)
        return null;
    // Fail-closed in favor of solid floor: only drop through when alpha data is built and pixel is transparent
    try {
        const threshold = Math.max(BLOOD_ALPHA_MIN, Number(lvl.background?.alphaThreshold) || 0);
        const hit = bgMesh.containsCanvasPoint({ x, y }, threshold) !== false;
        if (hit || bgMesh._textureAlphaData == null)
            return null;
    }
    catch {
        return null;
    }
    return best;
}
function _resolveTileLevelId(tile, fallbackLvl) {
    const tLevels = tile?.document?.levels;
    if (fallbackLvl && (!tLevels?.size || tLevels.has(fallbackLvl.id)))
        return fallbackLvl.id;
    if (tLevels?.size) {
        for (const id of tLevels)
            return id;
    }
    return fallbackLvl?.id ?? null;
}
/**
 * Resolve the surface at scene point (x, y) no higher than `upTo`.
 * @param {number} x scene X coordinate
 * @param {number} y scene Y coordinate
 * @param {number} [upTo] ceiling (brush/token): surfaces above this do NOT catch blood
 * @param {string|object|null} [levelOrId] owning Level or ID (defaults to `canvas.level`)
 * @returns {{e: number, tid: string|null, lvl?: string|null}} e — surface elevation,
 *  tid — surface TileDocument ID or null (floor), lvl — resolved Level ID (if any).
 */
// Reusable query rectangle and frozen floor constant: surfaceAt runs on every footprint
// step / trail sample, so allocating a Rectangle + `{ e: 0, tid: null }` per call creates GC churn
let _surfRect = null;
const FLOOR_SURFACE = Object.freeze({ e: 0, tid: null });
export function surfaceAt(x, y, upTo = Number.POSITIVE_INFINITY, levelOrId = null) {
    const lvl = resolveLevel(levelOrId);
    const floorE = levelBaseElevation(lvl);
    const floorId = lvl?.id ?? null;
    // Tileless scene: always floor (quadtree would return empty) — exit with zero
    // allocations; typical for snow combat on a tileless map
    const layer = canvas.tiles;
    if (!layer?.placeables?.length) {
        const dropLvl = _lowerVisibleLevelAt(lvl, x, y, upTo);
        if (dropLvl) {
            return { e: levelBaseElevation(dropLvl), tid: null, lvl: dropLvl.id };
        }
        return floorId ? { e: floorE, tid: null, lvl: floorId } : (floorE === 0 ? FLOOR_SURFACE : { e: floorE, tid: null });
    }
    // Layer quadtree — O(log N) candidates instead of scanning all tiles
    // (on large scenes with 800+ tiles, a linear scan cost ~ms per footprint step)
    let cands = null;
    try {
        const qt = layer.quadtree;
        // getObjects expects a REAL PIXI.Rectangle (`rect.overlaps` internally) —
        // a plain object threw, causing the prefilter to silently fail; iterate the
        // returned Set directly without copying to an array
        if (qt?.getObjects && PIXI?.Rectangle) {
            if (!_surfRect)
                _surfRect = new PIXI.Rectangle(x - 1, y - 1, 2, 2);
            else {
                _surfRect.x = x - 1;
                _surfRect.y = y - 1;
                _surfRect.width = 2;
                _surfRect.height = 2;
            }
            cands = qt.getObjects(_surfRect);
        }
    }
    catch {
        cands = null;
    }
    if (!cands)
        cands = layer.placeables; // non-empty here: tileless scenes returned above
    let firstTile = null;
    let firstE = 0;
    let hits = null;
    if (cands) {
        for (const tile of cands) {
            if (tile.document?.hidden || tile.visible === false || tile.mesh?.visible === false)
                continue; // hidden tile is not part of the visible scene
            const e = Number(tile.document?.elevation) || 0;
            if (e > upTo)
                continue;
            if (lvl && typeof tile.document?.includedInLevel === 'function' && !tile.document.includedInLevel(lvl)) {
                // Ignore tiles from foreign levels unless they lie below our level (potential hole fallback)
                if (e >= floorE)
                    continue;
            }
            // Coarse AABB prefilter; exact pixel test follows below
            try {
                if (tile.bounds && !tile.bounds.contains(x, y))
                    continue;
            }
            catch { /* no bounds — defer to exact pixel test */ }
            if (!firstTile) {
                firstTile = tile;
                firstE = e;
            }
            else {
                if (!hits)
                    hits = [{ tile: firstTile, e: firstE }];
                hits.push({ tile, e });
            }
        }
    }
    let dropLvlChecked = false;
    let dropLvl = null;
    const getDropLvl = () => {
        if (!dropLvlChecked) {
            dropLvlChecked = true;
            dropLvl = _lowerVisibleLevelAt(lvl, x, y, upTo);
        }
        return dropLvl;
    };
    if (firstTile) {
        if (!hits) {
            if ((firstE >= floorE || upTo < floorE || getDropLvl()) && _isOpaque(firstTile, x, y)) {
                const tileLvl = _resolveTileLevelId(firstTile, firstE < floorE ? (getDropLvl() ?? lvl) : lvl);
                return tileLvl
                    ? { e: firstE, tid: firstTile.document?.id ?? null, lvl: tileLvl }
                    : { e: firstE, tid: firstTile.document?.id ?? null };
            }
        }
        else {
            // Top-to-bottom; break elevation ties by highest `sort` (stick to the topmost visible tile)
            hits.sort((a, b) => (b.e - a.e) || ((b.tile.document?.sort || 0) - (a.tile.document?.sort || 0)));
            for (const { tile, e } of hits) {
                if (e < floorE && upTo >= floorE && !getDropLvl())
                    break; // solid floor of current level stops drops above lower tiles
                if (!_isOpaque(tile, x, y))
                    continue;
                const tileLvl = _resolveTileLevelId(tile, e < floorE ? (getDropLvl() ?? lvl) : lvl);
                return tileLvl
                    ? { e, tid: tile.document?.id ?? null, lvl: tileLvl }
                    : { e, tid: tile.document?.id ?? null };
            }
        }
    }
    const lower = getDropLvl();
    if (lower) {
        return { e: levelBaseElevation(lower), tid: null, lvl: lower.id };
    }
    return floorId ? { e: floorE, tid: null, lvl: floorId } : (floorE === 0 ? FLOOR_SURFACE : { e: floorE, tid: null });
}
/**
 * Whether the tile texture is opaque at the scene point using core's native test
 * (matching the silhouette used for roof occlusion and light blocking on this tile).
 *
 * Fail-closed IN FAVOR OF THE TILE: if the test returns "transparent" while alpha
 * data was never built or is missing (CORS, texture still loading, extraction error),
 * treat transparency as indeterminate and assume solid — blood should never silently
 * fall through to the floor due to environment quirks. Only pixels backed by valid
 * alpha data count as genuinely transparent.
 */
function _isOpaque(tile, x, y) {
    const mesh = tile.mesh;
    const test = mesh?.containsCanvasPoint;
    if (typeof test !== 'function')
        return true;
    try {
        // Threshold: our minimum, or higher if the tile defines a stricter occlusion threshold
        const own = Number(tile.document?.texture?.alphaThreshold) || 0;
        const threshold = Math.max(BLOOD_ALPHA_MIN, own);
        const hit = test.call(mesh, { x, y }, threshold) !== false;
        if (hit)
            return true;
        // "Transparent" with BUILT alpha data is a genuine pixel verdict (core builds
        // it lazily during this test): a hole in a roof lets blood fall to the floor.
        // Missing alpha data altogether (CORS/failure) is indeterminate — treat tile as solid
        return mesh._textureAlphaData == null;
    }
    catch {
        return true; // tainted canvas / corrupted data — treat as solid
    }
}
/** Surface elevation convenience wrapper over `surfaceAt`. */
export function surfaceElevationAt(x, y, upTo = Number.POSITIVE_INFINITY, levelOrId = null) {
    return surfaceAt(x, y, upTo, levelOrId).e;
}
/**
 * Whether a stain's elevation matches a surface elevation (within half-unit tolerance)
 * or falls within a 3D region's `{ bottom, top }` elevation range.
 * Blood at a different elevation is "not underfoot": a token on a roof does not
 * track blood from the floor beneath it, and vice versa.
 */
export function elevationMatches(stainE, surfaceE) {
    if (surfaceE !== null && typeof surfaceE === 'object') {
        const rawB = surfaceE.bottom;
        const rawT = surfaceE.top;
        const b = (rawB !== null && rawB !== undefined && rawB !== '' && Number.isFinite(Number(rawB))) ? Number(rawB) : -Infinity;
        const t = (rawT !== null && rawT !== undefined && rawT !== '' && Number.isFinite(Number(rawT))) ? Number(rawT) : Infinity;
        const e = Number(stainE) || 0;
        return e >= b - EPSILON && e <= t + EPSILON;
    }
    return Math.abs((Number(stainE) || 0) - (Number(surfaceE) || 0)) < EPSILON;
}
