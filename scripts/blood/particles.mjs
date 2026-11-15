/**
 * Cosmetic blood particle layer: spray bursts on impact.
 *
 * Animation is purely local eye-candy: the GM broadcasts burst parameters
 * (origin, direction, color, scale, seed), and each client plays the spray
 * locally; authoritative stains arrive on a separate channel (`blood:apply` /
 * scene flag) and reveal according to their own stagger delays (`d`/`f`/`g` fields),
 * visually coinciding with droplet landing. Particles never persist anything.
 *
 * Architecture targeting 30,000 live particles on midrange hardware (60 FPS):
 *  - SINGLE global particle pool per client instead of a burst object per hit:
 *    a burst simply mints slots out of the shared pool.
 *  - State stored in flat Float32Arrays (SoA) — zero object allocations and zero
 *    GC pressure in the hot loop; compact active list with swap-remove instead of
 *    `filter()` every frame.
 *  - Rendered via `PIXI.ParticleContainer`: Uint16 indices cap a batch at
 *    16,384 quads, so two containers are used. Sprites are POOLED — created once
 *    upon first slot spawn and retained until teardown (no per-particle create/destroy).
 *  - SINGLE texture: all atlas droplet variants baked in WHITE onto a single
 *    canvas → one `baseTexture` (single batch per container). Color is applied via
 *    sprite `tint` and color alpha via `alpha`: zero runtime Canvas2D bakes per color.
 *  - Viewport culling: particles outside the viewport (`canvas.bounds` + 300px margin)
 *    integrate every 4th frame with step `4 × dt` — large scenes with far-flung sprays
 *    cost almost nothing.
 *  - Adaptive budget: exponential moving average of ticker `deltaMS`; below ~45 FPS,
 *    new spawns scale by 0.7 (down to a 0.15 floor) and smoothly recover toward 1.
 *    Gracefully degrades on low-end machines.
 *
 * Determinism: burst shape/trajectory is minted via `Rng(seed)` from the payload —
 * all clients spawn identical particles. Flight is local (cosmetic); the adaptive
 * budget may trim particle count on slower clients, an intentional trade-off over
 * bit-exact animation lockstep.
 */
import { MODULE_ID } from '../config.mjs';
import { emitAll, registerSocketHandler } from '../core/socket-manager.mjs';
import { Rng } from './rng.mjs';
import { BloodAtlas } from './textures.mjs';
import { isLevelVisible, levelBaseElevation } from './elevation.mjs';
const MAX_PARTICLES = 30_000;
// Uint16 index limit: max quads per single batch. Container 0 fills EXACTLY up to
// `maxSize` with zero headroom: if `MAX_PARTICLES` grows, real PIXI SILENTLY truncates
// rendering at `maxSize` (without throwing), so recompute the split right here.
// Smoke tests only catch falsy `batchSize` — `maxSize` overflow is silent.
const CONTAINER_SIZE = 16_384;
const CONTAINERS = Math.ceil(MAX_PARTICLES / CONTAINER_SIZE);
const CULL_MARGIN = 300; // px outside viewport where a particle still counts as on-screen
const CULL_STRIDE = 4; // off-screen integration runs every Nth frame with step N×dt
const FADE_TAIL = 0.35; // fraction of lifetime over which the droplet fades out
const ROT_GATE_SP2 = 25; // |v|² < 5 px/s — skip rotation update (droplet is nearly stationary)
/* ------------------------- particle state (SoA) ------------------------- */
const vx = new Float32Array(MAX_PARTICLES);
const vy = new Float32Array(MAX_PARTICLES);
const px = new Float32Array(MAX_PARTICLES);
const py = new Float32Array(MAX_PARTICLES);
const grav = new Float32Array(MAX_PARTICLES);
const ageA = new Float32Array(MAX_PARTICLES);
const lifeA = new Float32Array(MAX_PARTICLES);
const sizeA = new Float32Array(MAX_PARTICLES);
const alphaA = new Float32Array(MAX_PARTICLES); // record color alpha
const rotA = new Float32Array(MAX_PARTICLES);
const elevA = new Float32Array(MAX_PARTICLES);
const alive = new Uint8Array(MAX_PARTICLES);
// Compact active slot list: iterate live slots without scanning the full pool + swap-remove
const activeList = new Int32Array(MAX_PARTICLES);
const posOf = new Int32Array(MAX_PARTICLES);
let activeCount = 0;
// Free slot stack
const freeList = new Int32Array(MAX_PARTICLES);
let freeTop = MAX_PARTICLES;
for (let i = 0; i < MAX_PARTICLES; i++)
    freeList[i] = MAX_PARTICLES - 1 - i;
// Sprites are created lazily once per slot and live until teardown
const sprites = new Array(MAX_PARTICLES).fill(null);
let qualityMul = 1; // adaptive spawn budget multiplier
let emaDms = 16; // exponential moving average of deltaMS
let frame = 0;
/* --------------------------------- texture -------------------------------- */
let baseTex = null;
let frames = null; // droplet variants as sub-frames of a SINGLE baseTexture
let frameW = 100;
/** Bake white granular droplets onto one canvas — color is applied via tint. */
function _ensureTexture() {
    if (frames)
        return true;
    try {
        const n = BloodAtlas.kindCount('droplet');
        const plates = [];
        for (let i = 0; i < n; i++)
            plates.push(BloodAtlas.tinted('droplet', i, '#ffffffff'));
        const w = plates[0].width;
        const h = plates[0].height;
        const cv = document.createElement('canvas');
        cv.width = w * n;
        cv.height = h;
        const ctx = cv.getContext('2d');
        for (let i = 0; i < n; i++)
            ctx.drawImage(plates[i], i * w, 0);
        baseTex = PIXI.Texture.from(cv);
        frameW = w;
        frames = [];
        for (let i = 0; i < n; i++)
            frames.push(new PIXI.Texture(baseTex, new PIXI.Rectangle(i * w, 0, w, h)));
        return true;
    }
    catch (e) {
        console.warn(`${MODULE_ID} | particle atlas unavailable, bursts disabled:`, e?.message ?? e);
        return false;
    }
}
/* ------------------------------ containers/sprites ------------------------------ */
let containers = null;
function _ensureContainers() {
    if (containers)
        return;
    containers = [];
    // `vertices: true` IS REQUIRED: pooled sprites are reused with new `scale.set()`
    // on each spawn. With `vertices: false`, vertices (scale) go into a STATIC PIXI
    // buffer that only re-uploads on `addChild` — after ~CONTAINER_SIZE spawns into
    // a container, new sizes stop reaching the GPU and droplets render at frozen sizes.
    const props = { vertices: true, position: true, rotation: true, uvs: true, tint: true };
    for (let c = 0; c < CONTAINERS; c++) {
        const pc = new PIXI.ParticleContainer(CONTAINER_SIZE, props);
        // WARNING: in PIXI v7, the 3rd argument is `batchSize` (number!) and 4th is `autoResize`.
        // A falsy `batchSize` hard-freezes the PIXI renderer: `i += batchSize` → `i += 0`
        // (and `Math.floor(index / 0)` → `Infinity` in `onChildrenChange`), hanging on the
        // very first frame with live particles. Omit the 3rd argument altogether.
        try {
            const layers = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS;
            pc.sortLayer = layers.TILES + 2; // above blood chunks (TILES+1), below tokens
        }
        catch {
            pc.zIndex = 1e6;
        }
        pc.elevation = levelBaseElevation();
        canvas.primary.addChild(pc);
        containers.push(pc);
    }
}
const _cMaxElev = new Float64Array(CONTAINERS);
const _cHasAlive = new Uint8Array(CONTAINERS);
function _bumpContainerElev(slot, elev) {
    const pc = containers?.[(slot / CONTAINER_SIZE) | 0];
    if (!pc)
        return;
    if (activeCount <= 1 || elev > pc.elevation)
        pc.elevation = elev;
}
function _spriteFor(slot) {
    let s = sprites[slot];
    if (!s) {
        _ensureContainers();
        s = new PIXI.Sprite(frames[0]);
        s.anchor.set(0.5);
        containers[(slot / CONTAINER_SIZE) | 0].addChild(s);
        sprites[slot] = s;
    }
    return s;
}
function _allocSlot() {
    if (freeTop === 0)
        return -1; // pool full — silently drop excess droplets
    return freeList[--freeTop];
}
function _kill(slot) {
    alive[slot] = 0;
    const pos = posOf[slot];
    const last = activeList[--activeCount];
    activeList[pos] = last;
    posOf[last] = pos;
    freeList[freeTop++] = slot;
    const s = sprites[slot];
    // `alpha = 0` IS REQUIRED: PIXI v7 ParticleContainer ignores child `visible`
    // (only container visibility is checked; all children are batched) — only `alpha`
    // reaches the GPU. Without zeroing alpha, a dead droplet lingers as a ghost until
    // its slot is reused.
    if (s) {
        s.visible = false;
        s.alpha = 0;
    }
}
/* --------------------------------- API --------------------------------- */
/** Subscribe to the socket channel (`ready`). */
export function initBloodParticles() {
    registerSocketHandler('blood:burst', (data) => {
        try {
            // Strict GM-only gate: `game.socket` does not attribute the sender, so any op
            // missing `from` (or sent by a non-GM) is rejected — otherwise any client
            // could spam bursts for everyone simply by omitting the field
            if (!data?.from || !game.users.get(data.from)?.isGM)
                return;
            spawnBurstLocal(data);
        }
        catch (e) {
            console.warn(`${MODULE_ID} | blood burst failed:`, e?.message ?? e);
        }
    });
}
function _enabled() {
    try {
        return game.settings.get(MODULE_ID, 'bloodParticles') ?? true;
    }
    catch {
        return true;
    }
}
/** GM: play a burst across all clients — socket broadcast + local call. */
export function playBurst(payload) {
    if (!_enabled())
        return;
    // Place `from` AFTER spread so callers cannot spoof sender identity via payload
    emitAll('blood:burst', { ...payload, from: game.user.id });
}
/** Trigger a burst locally (also invoked by the socket handler). */
export function spawnBurstLocal(payload = {}) {
    if (!_enabled() || !canvas?.ready)
        return;
    if (payload.sceneId && canvas.scene?.id && payload.sceneId !== canvas.scene.id)
        return;
    if (payload.level && !isLevelVisible(payload.level))
        return;
    _spawnBurst(payload);
    _ensureTicker();
}
/**
 * Local step puff (triggered when a footprint stain activates): mini-spray of
 * surface material kicked up underfoot — droplets (blood) or snow dust (snow).
 * Does NOT use sockets: footprint records are already synced across all clients,
 * and each client derives the puff deterministically from the record (`Rng(seed)`).
 * Shares the same pool and adaptive budget as impact bursts.
 */
export function spawnStepPuff({ x, y, color = '#a51414d8', material = 0, seed = 1, size = 40, dir = null, elevation = null, level = null } = {}) {
    if (!_enabled() || !canvas?.ready)
        return;
    if (level && !isLevelVisible(level))
        return;
    if (!_ensureTexture())
        return;
    const puffElev = Number.isFinite(Number(elevation)) ? Number(elevation) : levelBaseElevation(level);
    const rng = new Rng((seed | 0) || 1);
    const mat = material | 0;
    const sizeC = Math.max(14, size);
    const col = _rgb(color);
    let rgb = col.rgb;
    let alpha = col.a;
    if (mat === 2) {
        rgb = 0xeef2f8;
        alpha = Math.min(1, alpha * 0.9);
    } // snow dust is bright pale
    const n = Math.round((13 + rng.int(7)) * qualityMul);
    for (let i = 0; i < n; i++) {
        const slot = _allocSlot();
        if (slot < 0)
            break;
        // Blood puffs spray along the step direction (`dir` = footprint rotation)
        const a = mat === 0 && dir != null
            ? dir + rng.range(-0.9, 0.9)
            : rng.angle();
        let vx0, vy0, g, life, sz, al;
        if (mat === 2) { // snow dust: upward loft and gentle settling
            vx0 = Math.cos(a) * sizeC * rng.range(0.35, 1.25);
            vy0 = Math.sin(a) * sizeC * rng.range(0.2, 0.7) - sizeC * rng.range(0.7, 1.6);
            g = sizeC * 2.2;
            life = 0.45 + rng.next() * 0.45;
            sz = Math.max(2.5, sizeC * rng.range(0.07, 0.18));
            al = alpha * 0.85;
        }
        else { // blood: fine splash droplets
            const v = sizeC * rng.range(1.4, 3.6);
            vx0 = Math.cos(a) * v;
            vy0 = Math.sin(a) * v - sizeC * rng.range(0.4, 1.1);
            g = sizeC * 9;
            life = 0.22 + rng.next() * 0.3;
            sz = Math.max(2.5, sizeC * rng.range(0.06, 0.16));
            al = alpha;
        }
        vx[slot] = vx0;
        vy[slot] = vy0;
        grav[slot] = g;
        px[slot] = x + rng.range(-0.06, 0.06) * sizeC;
        py[slot] = y + rng.range(-0.06, 0.06) * sizeC;
        sizeA[slot] = sz;
        ageA[slot] = 0;
        lifeA[slot] = life;
        rotA[slot] = a;
        alphaA[slot] = al;
        elevA[slot] = puffElev;
        alive[slot] = 1;
        activeList[posOf[slot] = activeCount++] = slot;
        const s = _spriteFor(slot);
        _bumpContainerElev(slot, puffElev);
        s.texture = frames[rng.int(frames.length)];
        s.tint = rgb;
        s.scale.set(sz / frameW);
        s.x = px[slot];
        s.y = py[slot];
        s.rotation = a;
        s.alpha = al;
        s.visible = true;
    }
    _ensureTicker();
}
/** Extinguish all active particles and tear down the render layer (`canvasTearDown`). */
export function stopAllBursts() {
    for (let k = 0; k < activeCount; k++) {
        const s = sprites[activeList[k]];
        // `alpha = 0` — same invariant as `_kill`: PIXI v7 ParticleContainer
        // ignores child `visible`
        if (s) {
            s.visible = false;
            s.alpha = 0;
        }
    }
    activeCount = 0;
    alive.fill(0);
    freeTop = MAX_PARTICLES;
    for (let i = 0; i < MAX_PARTICLES; i++)
        freeList[i] = MAX_PARTICLES - 1 - i;
    if (containers) {
        for (const c of containers) {
            try {
                c.destroy({ children: true, texture: false, baseTexture: false });
            }
            catch { /* layer already destroyed by teardown */ }
        }
        containers = null;
    }
    sprites.fill(null);
    _stopTicker();
}
/** Pool counters for smoke tests and profiling. */
export function debugStats() {
    return {
        active: activeCount,
        capacity: MAX_PARTICLES,
        free: freeTop,
        quality: qualityMul,
        frames: frame,
        containers: containers?.map(c => c.children.length) ?? []
    };
}
/* --------------------------------- spawn --------------------------------- */
function _rgb(hex) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?/i.exec(String(hex).trim());
    if (!m)
        return { rgb: 0xa51414, a: 0.85 };
    return { rgb: parseInt(m[1], 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
function _spawnBurst({ x, y, dir = null, color = '#a51414d8', size = 100, count = 60, seed = 1, elevation = null, level = null }) {
    if (!_ensureTexture())
        return;
    const burstElev = Number.isFinite(Number(elevation)) ? Number(elevation) : levelBaseElevation(level);
    const rng = new Rng((seed | 0) || 1);
    // Finite input guard: NaN/strings propagate through `Math.min/max` clamps
    // (NaN wins in both directions) and previously spawned particles at NaN coords
    const fx = (v, f) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
    // Two-sided clamp: a spoofed `size=1e9` produced giant quads (the pool capped count,
    // but the frame blew up); 2000 px is a sane upper bound for a splash
    const sizeC = Math.min(2000, Math.max(20, fx(size, 100)));
    const x0 = fx(x, 0), y0 = fx(y, 0);
    const col = _rgb(color);
    const n0 = Math.max(10, Math.min(160, Math.round(count * (0.55 + rng.next() * 0.7))));
    const n = Math.round(n0 * qualityMul);
    for (let i = 0; i < n; i++) {
        const slot = _allocSlot();
        if (slot < 0)
            break;
        const a = dir == null ? rng.angle() : dir + rng.range(-0.75, 0.75);
        const v = sizeC * rng.range(2.2, 6.5);
        vx[slot] = Math.cos(a) * v;
        vy[slot] = Math.sin(a) * v - sizeC * rng.range(0.4, 1.5); // slight upward loft
        grav[slot] = sizeC * 9;
        px[slot] = x0 + rng.range(-0.1, 0.1) * sizeC;
        py[slot] = y0 + rng.range(-0.1, 0.1) * sizeC;
        sizeA[slot] = Math.max(3, sizeC * (0.04 + rng.next() * rng.next() * 0.13));
        ageA[slot] = 0;
        lifeA[slot] = 0.3 + rng.next() * 0.55;
        rotA[slot] = a;
        alphaA[slot] = col.a;
        elevA[slot] = burstElev;
        alive[slot] = 1;
        activeList[posOf[slot] = activeCount++] = slot;
        const s = _spriteFor(slot);
        _bumpContainerElev(slot, burstElev);
        s.texture = frames[rng.int(frames.length)];
        s.tint = col.rgb;
        s.scale.set(sizeA[slot] / frameW);
        s.x = px[slot];
        s.y = py[slot];
        s.rotation = a;
        s.alpha = col.a;
        s.visible = true;
    }
}
/* --------------------------------- tick --------------------------------- */
/** World-space viewport rectangle (v12+ `canvas.bounds`) or null. */
function _viewRect() {
    try {
        const b = canvas.bounds;
        if (b && Number.isFinite(b.x) && Number.isFinite(b.width))
            return b;
    }
    catch { /* no canvas.bounds — viewport culling disabled */ }
    return null;
}
function _tick(dms) {
    frame++;
    emaDms += (dms - emaDms) * 0.05;
    if ((frame & 63) === 0) {
        if (emaDms > 22)
            qualityMul = Math.max(0.15, qualityMul * 0.7);
        else if (emaDms < 15 && qualityMul < 1)
            qualityMul = Math.min(1, qualityMul * 1.15);
    }
    const dt = Math.min(0.1, dms / 1000);
    const drag = Math.max(0, 1 - 1.8 * dt);
    const drag4 = drag * drag * drag * drag;
    const rect = _viewRect();
    const rX = rect ? rect.x - CULL_MARGIN : 0;
    const rY = rect ? rect.y - CULL_MARGIN : 0;
    const rR = rect ? rect.x + rect.width + CULL_MARGIN : 0;
    const rB = rect ? rect.y + rect.height + CULL_MARGIN : 0;
    _cMaxElev.fill(-Infinity);
    _cHasAlive.fill(0);
    let k = 0;
    while (k < activeCount) {
        const slot = activeList[k];
        // Active slot without a sprite (spawn threw between `activeList` push and
        // `_spriteFor`): kill immediately — a TypeError inside the hot loop every
        // frame stalls both rendering and sibling ticker listeners. Do not increment `k`:
        // the tail slot was swapped into `k` (same contract as natural expiry)
        if (!sprites[slot]) {
            _kill(slot);
            continue;
        }
        let ddt = dt;
        let dd = drag;
        if (rect) {
            if (px[slot] < rX || px[slot] > rR || py[slot] < rY || py[slot] > rB) {
                // Off-screen — integrate once every `CULL_STRIDE` frames with step `N × dt`
                if (((frame + slot) & (CULL_STRIDE - 1)) !== 0) {
                    const ci = (slot / CONTAINER_SIZE) | 0;
                    _cHasAlive[ci] = 1;
                    if (elevA[slot] > _cMaxElev[ci])
                        _cMaxElev[ci] = elevA[slot];
                    k++;
                    continue;
                }
                ddt = dt * CULL_STRIDE;
                dd = drag4;
            }
        }
        ageA[slot] += ddt;
        if (ageA[slot] >= lifeA[slot]) {
            _kill(slot);
            continue;
        } // tail slot swapped into k — do not increment k
        const ci = (slot / CONTAINER_SIZE) | 0;
        _cHasAlive[ci] = 1;
        if (elevA[slot] > _cMaxElev[ci])
            _cMaxElev[ci] = elevA[slot];
        // Ballistics: gravity and drag scale with stain size
        vy[slot] += grav[slot] * ddt;
        vx[slot] *= dd;
        vy[slot] *= dd;
        px[slot] += vx[slot] * ddt;
        py[slot] += vy[slot] * ddt;
        const s = sprites[slot];
        const sp2 = vx[slot] * vx[slot] + vy[slot] * vy[slot];
        if (sp2 > ROT_GATE_SP2) {
            rotA[slot] = Math.atan2(vy[slot], vx[slot]);
            s.rotation = rotA[slot];
        }
        // Dissolve over the final third of lifetime
        const rest = (lifeA[slot] - ageA[slot]) / lifeA[slot];
        s.alpha = rest > FADE_TAIL ? alphaA[slot] : alphaA[slot] * (rest / FADE_TAIL);
        s.x = px[slot];
        s.y = py[slot];
        k++;
    }
    if (containers) {
        const baseElev = levelBaseElevation();
        for (let c = 0; c < CONTAINERS; c++) {
            if (containers[c])
                containers[c].elevation = _cHasAlive[c] ? _cMaxElev[c] : baseElev;
        }
    }
    if (!activeCount)
        _stopTicker();
}
/* --------------------------------- ticker --------------------------------- */
let tickerFn = null;
function _ensureTicker() {
    if (tickerFn || !canvas?.app?.ticker)
        return;
    tickerFn = (tk) => _tick(tk?.deltaMS ?? 16);
    canvas.app.ticker.add(tickerFn);
}
function _stopTicker() {
    if (!tickerFn)
        return;
    try {
        canvas.app?.ticker?.remove(tickerFn);
    }
    catch { /* noop */ }
    tickerFn = null;
}
