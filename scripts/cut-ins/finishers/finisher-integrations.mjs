/**
 * Optional finisher integrations with third-party modules.
 *
 * Principle: Showstopper's own engine is completely self-contained — every
 * finisher is rendered end-to-end by it. Sequencer + JB2A and Splatter add
 * optional "garnish" (extra impact clips, blood decals) when installed and
 * active; when absent, nothing breaks and nothing is logged beyond debug output.
 *
 * Every external call is wrapped in try/catch since third-party APIs vary across versions.
 */
import { _computeVisualBounds } from './finisher-engine.mjs';
import { tokenTextureScale } from '../../general/token-ring.mjs';
/**
 * Relative garnish scale FROM FOOTPRINT: how many GRID CELLS the token
 * occupies (`doc.width`) + visible-bounds corrections (ring extent when
 * `ring.subject.scale < 1` — see `_computeVisualBounds`). Artwork zoom
 * (`doc` texture scale) is divided out of `visualRect` via `grid *
 * doc.width * textureScale`: `visualRect` includes zoom (in v14 `mesh.width`
 * carries `textureScale`), whereas Sequencer effects should NOT scale with
 * art zoom at all — `considerTokenScale: false`, otherwise at scale 2 slashes,
 * punctures, and blood become twice the body size. Mirrors the runner's `scaleK`
 * formula (same 0.8–2.5 clamp) normalized by `doc.width`. Equals 1 for normal-art
 * tokens (unchanged behavior).
 */
function _visualScaleCorrection(token) {
    try {
        const grid = canvas.grid?.size ?? 100;
        const doc = token?.document;
        const docWidth = Math.max(1, Number(doc?.width) || 1);
        const ts = Math.max(0.01, tokenTextureScale(doc) || 1);
        const rect = _computeVisualBounds(token, grid);
        const scaleK = Math.min(2.5, Math.max(0.8, Math.max(rect.width, rect.height) / (grid * docWidth * ts)));
        return scaleK;
    }
    catch {
        return 1;
    }
}
export function hasSequencer() {
    return typeof Sequencer !== 'undefined' && typeof Sequence !== 'undefined';
}
export function hasJB2A() {
    return game.modules.get('jb2a_patreon')?.active
        || game.modules.get('jb2a')?.active
        || false;
}
/** Sequencer + JB2A both active — "JB2A-first" choreography mode. */
export function jb2aReady() {
    return hasSequencer() && hasJB2A();
}
export function hasSplatter() {
    return game.modules.get('splatter')?.active ?? false;
}
/** Summary status report for menu tooltips and API queries. */
export function integrationReport() {
    return {
        sequencer: hasSequencer(),
        jb2a: hasJB2A(),
        splatter: hasSplatter()
    };
}
/**
 * Plays a declarative list of Sequencer effects (JB2A-first finisher layer:
 * JB2A clips provide primary VFX while our Pixi engine handles token body & fallbacks).
 * Each entry:
 *   { file,                         // string or ARRAY of candidate paths
 *     at?: 'target'|{x,y},        // origin point; defaults to token CENTER
 *     offset?: {x,y},             // offset from token center IN GRID UNITS
 *     stretch?: {x,y},            // stretchTo — beam from→to (`at` = origin)
 *     scale?: n,                  // scaleToObject (relative to token footprint)
 *     scaleAbs?: n,               // absolute scale
 *     scaleIn?: [from, ms],
 *     tint?: '#rrggbb', opacity?: n, anchor?: {x,y},
 *     rotate?: deg, randomRotation?: bool, mirrorX?: bool,
 *     playbackRate?: n,
 *     delay?: ms, duration?: ms,  // duration — for LOOPING clips only
 *     fadeIn?: ms, fadeOut?: ms,
 *     belowTokens?: bool, missed?: bool }
 * Missing database entries are caught via try/catch and silently skipped.
 *
 * IMPORTANT regarding Sequencer.Database: `Sequencer.Database.entryExists` is
 * checked for EVERY `jb2a.*` path (both single strings and array candidates) —
 * NOT just arrays. A single `jb2a.*` string missing from the installed JB2A tier
 * is skipped just like an unknown array candidate; otherwise it would attempt to
 * play a broken path (Invalid Asset). Local file paths (`modules/...`, `systems/...`)
 * and non-JB2A DB prefixes (e.g. `psfx.*`) bypass this check and play as-is.
 */
export function playSequencerEffects(defs, token) {
    if (!hasSequencer() || !Array.isArray(defs) || !defs.length)
        return;
    for (const d of defs) {
        if (!d?.file)
            continue;
        try {
            // `file` can be an array of candidates — pick the first one known to
            // Sequencer's database (similar to `pick()` in macros). IMPORTANT: if the
            // database answered and knows NONE of the candidates, skip the effect
            // entirely rather than playing a broken asset path (Invalid Asset).
            // If `entryExists` is unavailable (older Sequencer), play the first entry as-is.
            // Single STRING paths go through the exact same check so missing `jb2a.*`
            // strings don't slip through unvalidated.
            let file = d.file;
            const candidates = Array.isArray(file) ? file : [file];
            let found = null;
            let checked = false;
            for (const f of candidates) {
                // Validate `jb2a.*` DB paths only: local files and third-party DB prefixes
                // aren't in JB2A's DB by design — skipping them would be a false negative
                if (typeof f !== 'string' || !f.startsWith('jb2a.')) {
                    found ??= f;
                    continue;
                }
                try {
                    const exists = Sequencer.Database?.entryExists?.(f);
                    if (exists === undefined)
                        continue; // API check unavailable — don't count
                    checked = true;
                    if (exists) {
                        found = f;
                        break;
                    }
                }
                catch { /* no DB */ }
            }
            if (checked && !found)
                continue;
            file = found ?? candidates[0];
            // softFail: turn any clip error (missing file, etc.) into a warning rather
            // than an uncaught exception — garnish must never crash a finisher
            const seq = new Sequence({ softFail: true }).effect().file(file);
            // 'target' or omitted = token CENTER: `atLocation(token)` centers automatically.
            // NEVER pass the token itself as `{x,y}`: `PlaceableObject.x/.y` is the
            // TOP-LEFT CORNER of the footprint, shifting effects into the cell corner.
            // Explicit `d.at = {x,y}` is in scene coordinates.
            const at = d.at;
            if (at && typeof at === 'object' && Number.isFinite(at.x) && Number.isFinite(at.y)) {
                if (d.stretch && Number.isFinite(d.stretch.x) && Number.isFinite(d.stretch.y)) {
                    seq.atLocation({ x: at.x, y: at.y }).stretchTo({ x: d.stretch.x, y: d.stretch.y });
                }
                else {
                    seq.atLocation({ x: at.x, y: at.y });
                }
            }
            else if (d.offset) {
                seq.atLocation(token, { offset: d.offset, gridUnits: true });
            }
            else {
                seq.atLocation(token);
            }
            // Scale: `stretch` and `scale` are mutually exclusive — Sequencer rejects
            // combining them ("stretch towards an object while scaling to fit another")
            // and corrupts the beam. For stretched effects scale is dictated by beam
            // distance, so `scale`/`scaleAbs` are intentionally ignored
            const hasStretch = d.stretch && Number.isFinite(d.stretch.x) && Number.isFinite(d.stretch.y)
                && at && typeof at === 'object' && Number.isFinite(at.x) && Number.isFinite(at.y);
            if (!hasStretch) {
                if (d.scaleAbs)
                    seq.scale(d.scaleAbs);
                // Relative scale FROM FOOTPRINT: `considerTokenScale: false` — artwork zoom
                // does NOT participate at all; `_visualScaleCorrection` carries only cell
                // footprint bounds (`doc` cells + ring extent). With `true`, Sequencer
                // multiplied art zoom in, making slashes/punctures/blood 2x body size at scale 2
                else if (d.scale)
                    seq.scaleToObject(d.scale * _visualScaleCorrection(token), { considerTokenScale: false });
            }
            if (d.scaleIn)
                seq.scaleIn(d.scaleIn[0] ?? 0.05, d.scaleIn[1] ?? 800);
            if (d.tint)
                seq.tint(d.tint);
            if (d.opacity !== undefined)
                seq.opacity(d.opacity);
            if (d.anchor)
                seq.anchor(d.anchor);
            if (typeof d.rotate === 'number')
                seq.rotate(d.rotate);
            if (d.randomRotation)
                seq.randomRotation();
            if (d.mirrorX)
                seq.mirrorX(true);
            if (d.playbackRate)
                seq.playbackRate(d.playbackRate);
            if (d.delay)
                seq.delay(d.delay);
            // `duration` is for looping clips only: caps playback lifetime
            if (d.duration)
                seq.duration(d.duration);
            if (d.fadeIn)
                seq.fadeIn(d.fadeIn);
            if (d.fadeOut)
                seq.fadeOut(d.fadeOut);
            // Default tail: one-shot clips without `duration`/`fadeOut` cut out abruptly
            // on their final frame (single-frame >100k px "exit-pop" on large spell VFX) —
            // apply a soft 300ms fade-out at the end
            if (!d.fadeOut && !d.duration)
                seq.fadeOut(300);
            if (d.belowTokens)
                seq.belowTokens();
            if (d.missed)
                seq.missed();
            // `local: true` IS MANDATORY: the finisher has already been broadcast to all
            // clients via `showFinisher:<id>` (`runLocal` runs on every client), and
            // `preview()` is strictly local. Without `local: true`, Sequencer defaults to
            // `push=true` and re-broadcasts every clip over `sequencerSocket` to everyone
            // else — producing N× additive video stacking across N players and broadcasting
            // local menu previews to the whole party.
            seq.play({ preload: false, local: true });
        }
        catch (e) {
            // Sequencer DB might not contain this clip in the user's JB2A tier — non-fatal
            console.debug(`showstopper | Sequencer effect skipped: ${Array.isArray(d.file) ? d.file[0] : d.file}`, e?.message ?? e);
        }
    }
}
/**
 * Blood splatter via Showstopper's own blood system (`scripts/blood/`): persistent
 * scene decals using the token's blood color (respects Splatter/Bloodsheet flags),
 * wall clipping, and scene flag persistence. GM-side: generation and broadcast
 * happen inside the blood API.
 *   size   — nominal size (→ impact 0.45..1), default 2
 *   impact — exact splatter force (0.05..1), overrides `size`
 *   dead   — true adds a death pool decal (`bloodDeathPool`) UNDER the token
 * Returns true if the call succeeded; otherwise the caller can fall back to Splatter.
 */
export function showstopperBlood(token, { size = 2, dir = null, impact = null, dead = true } = {}) {
    const api = globalThis.showstopper?.blood;
    if (!api?.isEnabled?.() || typeof api.splat !== 'function')
        return false;
    try {
        api.splat(token, {
            impact: Number.isFinite(impact) ? impact : Math.min(1, 0.45 + size * 0.2),
            dead,
            dir: (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) ? dir : null
        });
        return true;
    }
    catch (e) {
        console.debug('showstopper | finisher blood splat skipped', e?.message ?? e);
        return false;
    }
}
/**
 * Blood decal via the third-party Splatter module (if active). Returns true when
 * the module is present and the call succeeded. Splatter's API varied across
 * versions, so known call signatures are tried in order.
 */
export function splatterSplash(token, { size = 2, color = null } = {}) {
    if (!hasSplatter())
        return false;
    const api = globalThis.Splatter ?? game.modules.get('splatter')?.api;
    if (!api)
        return false;
    try {
        if (typeof api.spawnSplash === 'function') {
            // v10+: spawnSplash(token, { dsize, size, ... }) or (token, size)
            try {
                api.spawnSplash(token, { dsize: size, size, alpha: 0.7, ...(color ? { color } : {}) });
            }
            catch {
                api.spawnSplash(token, size);
            }
            return true;
        }
        if (typeof api.bloodSplat === 'function') {
            api.bloodSplat(token, { size });
            return true;
        }
    }
    catch (e) {
        console.debug('showstopper | Splatter call failed', e?.message ?? e);
    }
    return false;
}
/** Canvas shake via Sequencer — single helper with graceful fallback when absent. */
export function sequencerShake({ duration = 500, strength = 20 } = {}) {
    if (!hasSequencer())
        return false;
    try {
        new Sequence().canvasPan().shake({ duration, strength }).play({ local: true });
        return true;
    }
    catch {
        return false;
    }
}
