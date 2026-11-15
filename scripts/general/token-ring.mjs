/**
 * Shared token ring module — the single place responsible for building Foundry's
 * native dynamic ring (Foundry v12+ `TokenRing`). Used by three features:
 *
 *  - `scripts/custom/transform.mjs` (polymorph / summon): transfers ring configuration
 *    from an actor's prototype token into a token document update;
 *  - live drag previews (`scripts/player-portraits/panel.mjs`) and finishers
 *    (`scripts/cut-ins/finishers`): construct matching token bodies/rings —
 *    starting from an instant vector placeholder `buildRingBase()` and upgrading
 *    asynchronously to real spritesheet artwork (`buildRingFromFrames`).
 *
 * Proportions match Foundry core: `R = min(w, h) / 2`, rim thickness `0.127 * R`,
 * ring artwork scaled by
 *   `k = textureScale * ssa / scaleCorrection`,
 * where `ssa` is the "grid" fit-mode factor (`1 / (0.1269848 + 0.6666666)`,
 * `TokenRing` constants) and `scaleCorrection = ring.subject.scale`.
 * The ring subject does NOT receive `ssa` (matching core behavior).
 */
/* -------------------- Ring Geometry & Scale Helpers -------------------- */
/** Document fields used to copy ring settings from an actor prototype token (`transform.mjs`). */
export function ringUpdateFields(protoToken) {
    return { 'ring.subject.texture': protoToken?.ring?.subject?.texture ?? null };
}
/** Parse `'#rrggbb'` / `'#rgb'` / number / Foundry `Color` into `0xRRGGBB`, or return `fallback`. */
export function toHexColor(value, fallback) {
    if (value == null)
        return fallback;
    // Foundry `Color` extends `Number`: `typeof === "object"`, yet `Number(value)`
    // yields `0xRRGGBB`. Without this branch, recoloring silently failed.
    if (typeof value === "object") {
        try {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFF)
                return n;
        }
        catch (e) { /* fall through to string parsing */ }
    }
    if (typeof value === "number")
        return value;
    if (typeof value === "string") {
        const s = value.trim().replace(/^#/, "");
        if (/^[0-9a-f]{6}$/i.test(s))
            return parseInt(s, 16);
        if (/^[0-9a-f]{3}$/i.test(s)) {
            const [r, g, b] = s.split("").map(ch => parseInt(ch + ch, 16));
            return (r << 16) | (g << 8) | b;
        }
    }
    return fallback;
}
/** Attempt to resolve a token's actor (including compendium actors via `_ssActor`). */
function resolveTokenActor(tokenData, actor = null) {
    return actor
        ?? tokenData?._ssActor
        ?? tokenData?.actor
        ?? tokenData?.baseActor
        ?? (tokenData?.parent?.documentName === "Actor" ? tokenData.parent : null)
        ?? (tokenData?.actorId ? globalThis.game?.actors?.get?.(tokenData.actorId) : null)
        ?? null;
}
/**
 * System-specific token mesh scale multiplier (dnd5e `Token5e._refreshMeshSizeAndScale`):
 * when `dnd5e.tokenSizeSync` is enabled and `flags.dnd5e.lockScale` is unset, "Small" (`sm`)
 * creatures receive `dynamicTokenScale = 0.8` (grid footprint remains 1x1, while the mesh
 * itself — ring + subject or plain sprite — is multiplied by 0.8).
 */
export function systemTokenScale(tokenData, actor = null) {
    try {
        const sizes = globalThis.CONFIG?.DND5E?.actorSizes;
        if (!sizes)
            return 1;
        const sync = globalThis.dnd5e?.settings?.tokenSizeSync
            ?? globalThis.game?.settings?.get?.("dnd5e", "tokenSizeSync")
            ?? true;
        if (!sync)
            return 1;
        const a = resolveTokenActor(tokenData, actor);
        const lockScale = tokenData?.flags?.dnd5e?.lockScale
            ?? tokenData?._source?.flags?.dnd5e?.lockScale
            ?? a?.prototypeToken?.flags?.dnd5e?.lockScale;
        if (lockScale)
            return 1;
        if (a?.system && a.system.isCreature === false)
            return 1;
        const size = tokenData?.delta?.system?.traits?.size
            ?? a?.system?.traits?.size
            ?? a?._source?.system?.traits?.size;
        if (!size)
            return 1;
        const scale = Number(sizes[size]?.dynamicTokenScale);
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    }
    catch (e) {
        return 1;
    }
}
/** Mean `|texture.scaleX/scaleY|` of the token multiplied by system size scale (`mesh.resize` + `Token5e`). */
export function tokenTextureScale(tokenData, actor = null) {
    const tx = Math.abs(tokenData?.texture?.scaleX ?? 1);
    const ty = Math.abs(tokenData?.texture?.scaleY ?? 1);
    const base = ((tx + ty) / 2) || 1;
    return base * systemTokenScale(tokenData, actor);
}
/** Ring subject scale correction (`ring.subject.scale`), clamped identically to core. */
export function ringScaleCorrection(tokenData) {
    return Math.min(4, Math.max(0.5, Number(tokenData?.ring?.subject?.scale) || 1));
}
/** Core fit-mode SSA factor: in `"grid"` mode the mesh is multiplied by `1 / (0.1269848 + 0.6666666)`. */
export function ringFitSSA() {
    try {
        if (game.settings.get("core", "dynamicTokenRingFitMode") === "grid") {
            return 1 / (0.1269848 + 0.6666666);
        }
    }
    catch (e) { /* setting unavailable — default to subject mode */ }
    return 1;
}
/**
 * Whether a token should display a dynamic ring. Follows drag-preview semantics
 * (`panel.mjs`): dynamic rings are shown BY DEFAULT — world-level dynamic ring mode
 * renders rings even without an explicit `ring.enabled = true`, disabling them ONLY
 * when `enabled === false` is explicitly set.
 */
export function isRingToken(tokenData) {
    return tokenData?.ring?.enabled !== false && !!globalThis.CONFIG?.Token?.ring?.spritesheet;
}
/**
 * Compute ring subject dimensions matching a real token mesh (`PrimarySpriteMesh.resize`):
 * the fit ratio is computed from the NATURAL texture dimensions first and only then multiplied
 * by `texture.scaleX/scaleY` (and the system size factor, e.g. 0.8 for Small in dnd5e).
 * Fitting an already-scaled texture would cancel out the scale and make the subject ignore token scale.
 */
export function fitSubjectDims(tokenData, tex, w, h, actor = null) {
    const sys = systemTokenScale(tokenData, actor);
    const sx = Math.abs(tokenData?.texture?.scaleX ?? 1) * sys;
    const sy = Math.abs(tokenData?.texture?.scaleY ?? 1) * sys;
    const fit = tokenData?.texture?.fit;
    const texW = tex?.width || w;
    const texH = tex?.height || h;
    if (fit === "fill")
        return { width: w * sx, height: h * sy };
    let kr;
    if (fit === "cover")
        kr = Math.max(w / texW, h / texH);
    else if (fit === "width")
        kr = w / texW;
    else if (fit === "height")
        kr = h / texH;
    else
        kr = Math.min(w / texW, h / texH); // "contain" (token default) and all other modes
    return { width: texW * sx * kr, height: texH * sy * kr };
}
/* -------------------- Vector & Plain Body Builders -------------------- */
/** Plain (non-ring) token body: container + centered-anchor sprite. */
export function buildPlainBody(w, h, tokenData = null) {
    const body = new PIXI.Container();
    const sprite = new PIXI.Sprite();
    sprite.anchor.set(0.5);
    sprite.alpha = 1;
    if (tokenData && !tokenData.lockRotation && Number(tokenData.rotation)) {
        sprite.angle = Number(tokenData.rotation) || 0;
    }
    body.addChild(sprite);
    body._mainSprite = sprite;
    body._innerW = w;
    body._innerH = h;
    if (tokenData) {
        const sys = systemTokenScale(tokenData);
        sprite.width = w * sys;
        sprite.height = h * sys;
        _applySubjectFactory(body, sprite, tokenData, w, h);
    }
    return body;
}
function _applySubjectFactory(body, sprite, tokenData, w, h) {
    const ax = Number(tokenData?.texture?.anchorX);
    const ay = Number(tokenData?.texture?.anchorY);
    sprite.anchor.set(Number.isFinite(ax) ? ax : 0.5, Number.isFinite(ay) ? ay : 0.5);
    const tint = toHexColor(tokenData?.texture?.tint, null);
    if (tint !== null)
        sprite.tint = tint;
    body._subjectSprite = sprite;
    body._applySubjectTexture = (tex) => {
        if (tex)
            sprite.texture = tex;
        const dims = fitSubjectDims(tokenData, tex, w, h);
        sprite.width = dims.width;
        sprite.height = dims.height;
        if (Number(tokenData?.texture?.scaleX) < 0)
            sprite.scale.x = -Math.abs(sprite.scale.x);
        if (Number(tokenData?.texture?.scaleY) < 0)
            sprite.scale.y = -Math.abs(sprite.scale.y);
    };
}
/**
 * Instant (vector) ring base — placeholder shown until real spritesheet graphics
 * finish loading (see `buildRingFromFrames` / `upgradeCloneBody`).
 * Children are centered at `(0, 0)`; the caller positions the returned container.
 */
export function buildRingBase(tokenData, w, h, ssa = 1) {
    const ring = tokenData?.ring ?? {};
    const R = Math.min(w, h) / 2;
    const thickness = 0.127 * R;
    // Ringed token mesh * texture.scale (* SSA in grid mode), with scaleCorrection
    // dividing the ring artwork: k = texture.scale * SSA / scaleCorrection.
    const k = tokenTextureScale(tokenData) * ssa / ringScaleCorrection(tokenData);
    const sys = systemTokenScale(tokenData);
    const body = new PIXI.Container();
    // 1. Background disc.
    const bg = new PIXI.Graphics();
    bg.beginFill(toHexColor(ring.colors?.background, 0x10131a), 1);
    bg.drawCircle(0, 0, R);
    bg.endFill();
    bg.scale.set(k);
    body.addChild(bg);
    // 2. Ring rim: filled disc with a cutout hole (`beginHole`).
    const band = new PIXI.Graphics();
    band.beginFill(toHexColor(ring.colors?.ring, 0x8a9099), 1);
    band.drawCircle(0, 0, R);
    band.endFill();
    band.beginHole();
    band.drawCircle(0, 0, R - thickness);
    band.endHole();
    band.scale.set(k);
    body.addChild(band);
    // 3. Subject ON TOP of the ring, unmasked, at normal opacity.
    const sprite = new PIXI.Sprite();
    sprite.anchor.set(0.5);
    sprite.alpha = 1;
    sprite.width = w * sys;
    sprite.height = h * sys;
    body.addChild(sprite);
    _applySubjectFactory(body, sprite, tokenData, w, h);
    return body;
}
/* -------------------- Real Spritesheet Graphics -------------------- */
/**
 * Effective Multiple Rings ID for a token. Precedence matches the module's own
 * `getEffectiveRingId`: ActiveEffect -> token flag -> prototype token flag ->
 * `null` (world style).
 */
export function multipleRingsEffectiveId(tokenData) {
    try {
        if (game.modules.get("multiple-rings")?.active !== true)
            return null;
        const FLAG = "flags.multiple-rings.ringAppearance";
        const actor = resolveTokenActor(tokenData);
        // 1. ActiveEffect override.
        const fx = actor?.appliedEffects ?? actor?.effects;
        let ae;
        let hasAE = false;
        for (const effect of fx ?? []) {
            if (effect.disabled || effect.suppressed)
                continue;
            for (const change of effect.changes ?? []) {
                if (change.key === FLAG) {
                    ae = String(change.value ?? "");
                    hasAE = true;
                }
            }
        }
        if (hasAE)
            return ae || null; // "" = explicit fallback to world default
        // 2. Token flag. 3. Prototype token flag.
        const own = foundry.utils.getProperty(tokenData, FLAG);
        if (own)
            return own;
        const proto = actor?.prototypeToken;
        return proto ? (foundry.utils.getProperty(proto, FLAG) || null) : null;
    }
    catch (e) {
        return null;
    }
}
/**
 * Resolve the ring spritesheet URL: Multiple Rings (token/AE flag) -> other module
 * flags -> world setting -> default steel (`CONFIG.Token.ring.spritesheet`).
 */
export function resolveRingSheetUrl(tokenData) {
    try {
        // 1) Multiple Rings: effective per-token ring (flag / ActiveEffect).
        const mrId = multipleRingsEffectiveId(tokenData);
        if (mrId && mrId !== "mringsCombinedRings") {
            const cfg = CONFIG.Token?.ring?.getConfig?.(mrId);
            if (cfg?.spritesheet)
                return cfg.spritesheet;
        }
        // 2) Other modules: per-token flag carrying a `spritesheet` path.
        for (const v of Object.values(tokenData?.flags ?? {})) {
            if (v && typeof v === "object" && typeof v.spritesheet === "string") {
                return v.spritesheet;
            }
        }
        // 3) World style. When Multiple Rings is active, `CONFIG.Token.ring.spritesheet`
        // points to its COMBINED atlas, while the actual pack chosen for the world lives
        // in the `core.dynamicTokenRing` setting.
        try {
            const worldId = game.settings.get("core", "dynamicTokenRing");
            if (worldId && worldId !== "mringsCombinedRings") {
                const cfg = CONFIG.Token?.ring?.getConfig?.(worldId);
                if (cfg?.spritesheet)
                    return cfg.spritesheet;
            }
        }
        catch (e) { /* setting absent — fall back */ }
        const mrActive = game.modules.get("multiple-rings")?.active === true;
        if (!mrActive && typeof globalThis.CONFIG?.Token?.ring?.spritesheet === "string") {
            return CONFIG.Token.ring.spritesheet;
        }
        return null;
    }
    catch (e) {
        return null;
    }
}
/**
 * Validate a frame/sheet default ring color identically to core: `ringColor = Color.from(raw)`;
 * if valid -> `littleEndian`. Returns `0xRRGGBB` or `null`.
 */
export function frameDefaultColor(raw) {
    if (raw == null)
        return null;
    try {
        const color = Color.from(raw);
        return color.valid ? color.littleEndian : null;
    }
    catch (e) {
        return toHexColor(raw, null);
    }
}
/**
 * Final resolved ring color — exact match to core's `resolveColor`: `value ?? 0xFFFFFF`;
 * if the result is WHITE and a non-null frame default exists, return the frame default.
 */
export function resolveRingColor(value, defaultRingColor) {
    const v = toHexColor(value, null);
    if (v === null || v === 0xFFFFFF) {
        if (defaultRingColor != null && Number.isFinite(defaultRingColor))
            return defaultRingColor;
        return 0xFFFFFF;
    }
    return v;
}
const _recolorCache = new Map();
// Soft cap for the recolor cache (full spritesheet frames per color): the oldest entry
// is evicted WITHOUT `destroy()` because a live sprite may still reference the texture.
// Textures are NOT created via `PIXI.Texture.from`, which registers them permanently in
// the global `TextureCache` (leaking ~8 MB per combination), but directly via
// `new Texture(new BaseTexture)` — once evicted, JS memory is reclaimed by GC and the
// GPU texture is collected by PIXI's native texture GC (~60-70 s idle).
const RECOLOR_CACHE_MAX = 32;
// Fallback IDs for baseTextures lacking `src` and `textureCacheIds` (canvas resources,
// `ImageBitmap`): a unique ID is bound per `baseTexture` via WeakMap so two distinct
// anonymous sheets never collide on the same recolor cache key.
const _anonSheetIds = new WeakMap();
let _anonSheetSeq = 0;
function sheetIdOf(tex) {
    const bt = tex.baseTexture;
    const direct = bt?.resource?.source?.src ?? bt?.textureCacheIds?.[0];
    if (direct)
        return direct;
    if (!bt)
        return "anon"; // never reaches the cache: `if (!src) return tex` guards below
    let id = _anonSheetIds.get(bt);
    if (!id) {
        id = `anon#${++_anonSheetSeq}`;
        _anonSheetIds.set(bt, id);
    }
    return id;
}
/**
 * CPU recoloring of a ring frame. `bandRange = [startRadius, endRadius]`
 * (in fractions of half-frame width, from the sheet's `colorBand`) — recolors ONLY
 * that radial band with luminance normalization (matching `mask.r` in core's shader);
 * `bandRange = null` recolors the entire frame (mask layer). PIXI filters are avoided
 * deliberately: tinting works without an extra filter render pass.
 */
export function recolorFrameTexture(tex, colorHex, bandRange = null) {
    const f = tex.frame;
    // The cache key MUST distinguish sheet SOURCES: different ring packs share identical
    // frame rectangles (often 1024x1024@(0,0)) — without `sheetId`, a second pack would
    // receive the recolored frame of the first pack.
    const key = `${sheetIdOf(tex)}|${f.x},${f.y},${f.width},${f.height}|${colorHex}|${bandRange ? bandRange.join("-") : "full"}`;
    const hit = _recolorCache.get(key);
    if (hit) {
        // LRU refresh: `Map` preserves insertion order — refreshing a hit marks it MRU so
        // hot entries are never evicted when > 32 combinations are active.
        _recolorCache.delete(key);
        _recolorCache.set(key, hit);
        return hit;
    }
    const cw = Math.max(1, Math.round(f.width));
    const ch = Math.max(1, Math.round(f.height));
    const cv = document.createElement("canvas");
    cv.width = cw;
    cv.height = ch;
    const cx = cv.getContext("2d");
    const src = tex.baseTexture?.resource?.source;
    if (!src)
        return tex;
    try {
        cx.drawImage(src, f.x, f.y, f.width, f.height, 0, 0, cw, ch);
    }
    catch (e) {
        return tex;
    }
    const img = cx.getImageData(0, 0, cw, ch);
    const d = img.data;
    const r = ((colorHex >> 16) & 255) / 255;
    const g = ((colorHex >> 8) & 255) / 255;
    const b = (colorHex & 255) / 255;
    const half = Math.min(cw, ch) / 2;
    const cxs = cw / 2;
    const cys = ch / 2;
    const inBand = (x, y) => {
        if (!bandRange)
            return true;
        const dx = x - cxs, dy = y - cys;
        const dist = Math.sqrt(dx * dx + dy * dy) / half;
        return dist >= bandRange[0] && dist <= bandRange[1];
    };
    // Luminance normalization: in core's shader, band intensity comes from `mask.r` (~1)
    // rather than the shaded luminance of the artwork — without normalization, the band looks too dark.
    let maxLum = 0;
    if (bandRange) {
        for (let y = 0, i = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++, i += 4) {
                if (d[i + 3] === 0 || !inBand(x, y))
                    continue;
                const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                if (lum > maxLum)
                    maxLum = lum;
            }
        }
    }
    const norm = bandRange && maxLum > 0 ? 255 / maxLum : 1;
    for (let y = 0, i = 0; y < ch; y++) {
        const dy = y - cys;
        for (let x = 0; x < cw; x++, i += 4) {
            if (d[i + 3] === 0)
                continue;
            if (bandRange && !inBand(x, y))
                continue;
            const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * norm;
            d[i] = Math.min(255, Math.round(lum * r));
            d[i + 1] = Math.min(255, Math.round(lum * g));
            d[i + 2] = Math.min(255, Math.round(lum * b));
        }
    }
    cx.putImageData(img, 0, 0);
    // Do NOT use `PIXI.Texture.from(cv)`: it pins the texture in the global `TextureCache`
    // under the canvas's `_pixiId`, where it can only be freed via `destroy()` — which we
    // cannot call on eviction (a live sprite may still hold it), causing an unbounded leak.
    // Direct construction bypasses the global cache.
    const out = new PIXI.Texture(new PIXI.BaseTexture(cv));
    if (_recolorCache.size >= RECOLOR_CACHE_MAX) {
        const oldest = _recolorCache.keys().next().value;
        _recolorCache.delete(oldest);
    }
    _recolorCache.set(key, out);
    return out;
}
// Memoized spritesheet JSON config: previously every drag preview and every finisher
// ring upgrade re-fetched and re-parsed the same sheet JSON (Foundry does not cache
// this fetch). Promises are cached, including failures (`null`).
const _sheetJsonCache = new Map();
function _sheetJson(url) {
    let p = _sheetJsonCache.get(url);
    if (!p) {
        p = fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
        _sheetJsonCache.set(url, p);
    }
    return p;
}
/**
 * Load ring spritesheet frames: `{ bkg, ring, mask, top, bandStart, bandEnd, defaultRingColor }`.
 * World style uses the official `TokenRing.getRingDataBySize` API; custom packs parse the
 * spritesheet directly and pick the frame with the closest `gridTarget`.
 */
export async function loadRingFrames(sheetUrl, sizeCells = 1) {
    const loader = foundry.canvas?.loadTexture ?? foundry.utils?.loadTexture;
    // Pre-parsed system frames are valid ONLY for the active world ring style —
    // and frame selection uses the official API: closest `gridTarget` to the token's
    // cell size (`TokenRing.getRingDataBySize`) rather than an arbitrary first frame.
    const worldSheet = CONFIG.Token?.ring?.spritesheet ?? null;
    if (!sheetUrl || sheetUrl === worldSheet) {
        try {
            const ringClass = CONFIG.Token?.ring?.ringClass;
            const data = ringClass?.getRingDataBySize?.(sizeCells);
            const ring = data?.ringName ? PIXI.Assets.cache.get(data.ringName) : null;
            const bkg = data?.bkgName ? PIXI.Assets.cache.get(data.bkgName) : null;
            const mask = data?.maskName ? PIXI.Assets.cache.get(data.maskName) : null;
            if (ring || bkg) {
                const cb = data?.colorBand ?? {};
                // Top overlay layer (two-layer token): `config.overlays` of the sheet — frame
                // located either in the same atlas image or in an external `image` file.
                let top = null;
                try {
                    const ringKey = data?.ringName;
                    if (sheetUrl && ringKey) {
                        const json = await _sheetJson(sheetUrl);
                        if (json) {
                            const ov = json?.config?.overlays?.[ringKey];
                            if (ov?.frame) {
                                let base = null;
                                if (ov.image) {
                                    const url = new URL(ov.image, new URL(sheetUrl, location.origin)).href;
                                    const tex = loader ? await loader(url) : await PIXI.Assets.load(url);
                                    base = tex?.baseTexture ?? null;
                                }
                                else {
                                    const sheet = await PIXI.Assets.load(sheetUrl);
                                    base = sheet?.baseTexture
                                        ?? PIXI.Assets.cache.get(ringKey)?.baseTexture ?? null;
                                }
                                if (base) {
                                    top = new PIXI.Texture(base, new PIXI.Rectangle(Number(ov.frame.x) || 0, Number(ov.frame.y) || 0, Number(ov.frame.w) || 1, Number(ov.frame.h) || 1));
                                }
                            }
                        }
                    }
                }
                catch (e) {
                    top = null;
                }
                return {
                    bkg, ring, mask, top,
                    bandStart: Number(cb.startRadius) || 0.666,
                    bandEnd: Number(cb.endRadius) || 0.7225,
                    defaultRingColor: frameDefaultColor(data?.defaultRingColorLittleEndian)
                };
            }
        }
        catch (e) { /* fall back below */ }
    }
    // Fallback: load the spritesheet directly (including per-token Multiple Rings packs)
    // and select frames by `gridTarget` from the sheet's frame config.
    try {
        // Every ring spritesheet uses identical frame names (`token-ring-*`): parsing an
        // additional pack overwrites the world sheet's and previously loaded packs' frames
        // in `TextureCache` / `Assets.cache` — causing PIXI "already had an entry" warnings
        // and making the world path above read foreign artwork by bare frame name.
        // `cachePrefix` isolates global caches (unique per file so packs never collide in
        // the prefixed namespace either), while `sheet.textures` retains bare keys so the
        // lookup code below stays unchanged.
        // Call `PIXI.Assets.load` directly instead of `loadTexture`: Foundry's loader does
        // not forward `data.cachePrefix`; ring sheets are finite in number, whereas TTL
        // eviction applies only to the `loadTexture` path.
        const slug = sheetUrl.split("?")[0].split("/").slice(-2).join("-")
            .replace(/[^a-z0-9._-]/gi, "") || "sheet";
        let res = null;
        try {
            res = await PIXI.Assets.load({ src: sheetUrl, data: { cachePrefix: `ss-ring-${slug}:` } });
        }
        catch (err) {
            res = null;
        }
        if (!res && loader) {
            try {
                res = await loader(sheetUrl);
            }
            catch (err) {
                res = null;
            }
        }
        let frames = res?.textures ?? null;
        let sheetData = res?.data ?? null;
        if (!frames)
            return null;
        const keys = Object.keys(frames);
        if (!keys.length)
            return null;
        const frameCfg = sheetData?.frames ?? {};
        const targetOf = (k) => Number(frameCfg[k]?.gridTarget ?? 1);
        const closest = (arr) => arr.reduce((best, k) => Math.abs(targetOf(k) - sizeCells) < Math.abs(targetOf(best) - sizeCells) ? k : best);
        const ringKeys = keys.filter(k => !/-bkg|-msk/i.test(k));
        const bkgKeys = keys.filter(k => /-bkg/i.test(k));
        const maskKeys = keys.filter(k => /-msk/i.test(k));
        const ringKey = ringKeys.length ? closest(ringKeys) : null;
        // `bkg` frames do not carry `gridTarget` — pair directly with the chosen `ringKey`
        // (`med-ring` -> `med-ring-bkg`), otherwise tie-breaking picked the gargantuan frame.
        const bkgKey = (ringKey && bkgKeys.includes(`${ringKey}-bkg`))
            ? `${ringKey}-bkg`
            : (bkgKeys.length ? closest(bkgKeys) : null);
        const maskKey = maskKeys.length ? closest(maskKeys) : null;
        const cb = frameCfg[ringKey]?.colorBand
            ?? sheetData?.config?.defaultColorBand
            ?? {};
        // Top overlay layer (two-layer token): rendered ON TOP of the subject.
        let top = null;
        const ov = sheetData?.config?.overlays?.[ringKey];
        if (ov?.frame && ringKey && frames[ringKey]) {
            try {
                let base = frames[ringKey].baseTexture;
                if (ov.image) {
                    const url = new URL(ov.image, new URL(sheetUrl, location.origin)).href;
                    const tex = loader ? await loader(url) : await PIXI.Assets.load(url);
                    base = tex?.baseTexture ?? null;
                }
                if (base) {
                    top = new PIXI.Texture(base, new PIXI.Rectangle(Number(ov.frame.x) || 0, Number(ov.frame.y) || 0, Number(ov.frame.w) || 1, Number(ov.frame.h) || 1));
                }
            }
            catch (e) {
                top = null;
            }
        }
        return {
            bkg: bkgKey ? frames[bkgKey] : null,
            ring: ringKey ? frames[ringKey] : null,
            // Mask frame: in core, ring color is blended across the mask region (the color band).
            mask: maskKey ? frames[maskKey] : null,
            top,
            bandStart: Number(cb.startRadius) || 0.666,
            bandEnd: Number(cb.endRadius) || 0.7225,
            defaultRingColor: frameDefaultColor(frameCfg[ringKey]?.ringColor)
                ?? frameDefaultColor(sheetData?.config?.defaultRingColor)
        };
    }
    catch (e) {
        console.warn(`showstopper | ring frames load failed for ${sheetUrl}:`, e);
        return null;
    }
}
/**
 * Construct a ring body from real spritesheet graphics (`bkg` + `ring` artwork),
 * recoloring the radial color band to `ring.colors.ring` and applying scale correction.
 * Children are centered at `(0, 0)`. Returns `null` if no frames are available.
 */
export function buildRingFromFrames(tokenData, w, h, framesInfo, ssa = 1) {
    const ring = tokenData?.ring ?? {};
    const R = Math.min(w, h) / 2;
    const thickness = 0.127 * R;
    if (!framesInfo?.ring && !framesInfo?.bkg)
        return null;
    // Ringed token mesh * texture.scale (* SSA in grid mode), with scaleCorrection
    // dividing the ring artwork (`vScaleCorrection` distance field):
    // k = texture.scale * SSA / scaleCorrection. Subject does not receive SSA.
    const k = tokenTextureScale(tokenData) * ssa / ringScaleCorrection(tokenData);
    const D = R * 2 * k;
    const body = new PIXI.Container();
    // Final resolved ring color — shared by ring artwork, mask, and top overlay.
    const ringCol = resolveRingColor(ring.colors?.ring, framesInfo.defaultRingColor ?? null);
    if (framesInfo.bkg) {
        // Ring background: tinted ONLY when `colors.background` is set (native artwork otherwise).
        const bkgCol = toHexColor(ring.colors?.background, null);
        const bkg = new PIXI.Sprite(framesInfo.bkg);
        bkg.anchor.set(0.5);
        bkg.width = D;
        bkg.height = D;
        if (bkgCol !== null)
            bkg.tint = bkgCol;
        body.addChild(bkg);
    }
    if (framesInfo.ring) {
        // CPU-recolor ONLY the radial color band (sheet `colorBand`, matching core's shader);
        // empty `colors.ring` falls back to the frame default color, or white.
        const ringTex = recolorFrameTexture(framesInfo.ring, ringCol, [framesInfo.bandStart, framesInfo.bandEnd]);
        const art = new PIXI.Sprite(ringTex);
        art.anchor.set(0.5);
        art.width = D;
        art.height = D;
        body.addChild(art);
        // Mask layer: in core, ring color is blended across the mask region (the color band).
        if (framesInfo.mask) {
            const maskTex = recolorFrameTexture(framesInfo.mask, ringCol);
            const maskSpr = new PIXI.Sprite(maskTex);
            maskSpr.anchor.set(0.5);
            maskSpr.width = D;
            maskSpr.height = D;
            body.addChild(maskSpr);
        }
    }
    else {
        // No ring artwork — draw a vector rim over the background.
        const g = new PIXI.Graphics();
        g.beginFill(ringCol, 1);
        g.drawCircle(0, 0, R);
        g.endFill();
        g.beginHole();
        g.drawCircle(0, 0, R - thickness);
        g.endHole();
        g.scale.set(k);
        body.addChild(g);
    }
    // Subject ON TOP of the ring (upper layer), at normal opacity.
    const sys = systemTokenScale(tokenData);
    const sprite = new PIXI.Sprite();
    sprite.anchor.set(0.5);
    sprite.alpha = 1;
    sprite.width = w * sys;
    sprite.height = h * sys;
    body.addChild(sprite);
    _applySubjectFactory(body, sprite, tokenData, w, h);
    // Two-layer token: overlay artwork from `config.overlays` rendered ON TOP of the subject.
    if (framesInfo.top) {
        const topSpr = new PIXI.Sprite(framesInfo.top);
        topSpr.anchor.set(0.5);
        topSpr.width = D;
        topSpr.height = D;
        topSpr.tint = ringCol;
        body.addChild(topSpr);
    }
    return body;
}
/* -------------------- Finisher Clone Helpers -------------------- */
/**
 * Build a finisher clone body: for a ringed token, returns an instant vector ring;
 * for a standard token, returns `null` (the body is rendered via mesh-texture tiles).
 * Dimensions equal document footprint * grid cell size.
 */
export function buildCloneBody(tokenData, baseGrid) {
    try {
        if (!isRingToken(tokenData))
            return null;
        const w = (Number(tokenData?.width) > 0 ? Number(tokenData.width) : 1) * baseGrid;
        const h = (Number(tokenData?.height) > 0 ? Number(tokenData.height) : 1) * baseGrid;
        return buildRingBase(tokenData, w, h, ringFitSSA());
    }
    catch (e) {
        return null;
    }
}
/**
 * Asynchronously upgrade a finisher clone: load world/module spritesheet frames and
 * assemble a body from REAL ring artwork. Returns the new body container or `null`.
 * The caller is responsible for verifying the previous body is still alive before swapping.
 */
export async function upgradeCloneBody(tokenData, baseGrid) {
    try {
        const sheetUrl = resolveRingSheetUrl(tokenData);
        if (!sheetUrl)
            return null;
        const w = (Number(tokenData?.width) > 0 ? Number(tokenData.width) : 1) * baseGrid;
        const h = (Number(tokenData?.height) > 0 ? Number(tokenData.height) : 1) * baseGrid;
        const sizeCells = Math.min(Number(tokenData?.width) || 1, Number(tokenData?.height) || 1);
        const frames = await loadRingFrames(sheetUrl, sizeCells);
        if (!frames)
            return null;
        return buildRingFromFrames(tokenData, w, h, frames, ringFitSSA());
    }
    catch (e) {
        return null;
    }
}
