/**
 * FinisherEffect — base class for all finishers.
 *
 * A finisher is a token-destruction animation. Contract:
 *
 *   static id          unique id ('fire-finisher', ...)
 *   static icon        FontAwesome icon class for the menu card
 *   static damageType  optional dnd5e damage type binding ('fire', ...)
 *   static synth       procedural sound flavor key (finisher-audio.mjs)
 *   static sequencer   Sequencer/JB2A garnish: [{ file, delay, scale, ... }]
 *   static splatter    Splatter decal config: { size, color } | null
 *   static playback    { duration, camera, bars }
 *   static aftermath   'ringOnly' — token is NOT deleted: stays on the scene as
 *                      a live "ring-only" marker (subject art hidden via
 *                      `ring.subject.texture`, see `applyRingOnly`);
 *                      'frozen' — token is NOT deleted: stays as a frozen statue
 *                      with an icy tint (`texture.tint`, see `applyFrozenTint`)
 *   static play(ctx)   engine choreography (`ctx` = FinisherRunner)
 *
 * Execution flow: `execute()` → resolve targets → socket broadcast → `runLocal()`
 * on every client. During playback the real token is hidden and replaced by a
 * sliced double (`ctx.capture()`). Target resolution priority: explicit `tokenIds`
 * → targeted tokens → controlled tokens.
 *
 * "Token 1 executes Token 2" interaction: if a token OUTSIDE the target list is
 * controlled when triggered, it acts as the attacker (`options.attackerId`,
 * resolved once in `execute` so every client sees the exact same scene).
 * Choreographies read `ctx.attackerCenter` / `ctx.dirFromAttacker`, and melee
 * finishers open with `ctx.dashStrike()` — lunging the attacker into the victim.
 */
import { BaseEffect } from '../base-effect.mjs';
import { FinisherRunner, Ease } from './finisher-engine.mjs';
import { effectRegistry } from '../registry.mjs';
import { playFinisherSound } from './finisher-audio.mjs';
import { playSequencerEffects, splatterSplash, showstopperBlood } from './finisher-integrations.mjs';
import { isRingToken } from '../../general/token-ring.mjs';
import { getSocket } from '../../core/socket-manager.mjs';
import { SHADER_EFFECTS } from './token-shaders.mjs';
import { MODULE_ID } from '../../config.mjs';
/** Transparent subject art: keeps the dynamic ring while hiding the portrait. */
const RING_ONLY_ART = 'modules/showstopper/assets/ring-blank.png';
/** Icy tint for a persistent frozen statue (cold): matches the final tile tint
 *  of the choreography so the handoff from clone to real token is seamless.
 *  Also read by `token-shaders.mjs` as the frozen shader marker. */
export const FROZEN_TINT = '#bfe6ff';
/**
 * Normalizes `texture.tint` to a lowercase CSS hex string. In Foundry v14
 * `ColorField.initialize` returns a `foundry.utils.Color` instance (subclass of
 * `Number`), NOT a string (`common/data/fields.mjs`, `common/utils/color.mjs`) —
 * calling `.toLowerCase()` directly throws a TypeError. Always read and compare
 * through this normalizer, and always store strings in flags (`Color` objects
 * do not serialize cleanly in flags).
 */
export function textureTintCss(value) {
    const v = value ?? '#ffffff';
    if (typeof v === 'string' && v)
        return v.toLowerCase();
    try {
        const css = Color.from(v).css;
        return css ? css.toLowerCase() : '#ffffff';
    }
    catch {
        return '#ffffff';
    }
}
/** One-time base-class global registrations (invoked from `registerSocketHandler`
 *  of EVERY finisher subclass — only a single hook listener is needed). */
const finisherEffectGlobals = { deleteHookReady: false };
/** Flag storing the original `subject.texture` ('' = was null, i.e. base token art). */
const RING_ONLY_FLAG = 'flags.showstopper.ringOnlyArt';
/** Flag storing the original `texture.tint` prior to freezing. */
const FROZEN_FLAG = 'flags.showstopper.frozenTint';
/** Universal flags for the active shader effect and saved original tint. */
const SHADER_EFFECT_FLAG = 'flags.showstopper.shaderEffect';
const SHADER_TINT_FLAG = 'flags.showstopper.shaderTint';
/**
 * Per-token finisher queue (per client): a second trigger on the same token
 * waits for the first one to finish. Without serialization, overlapping runs
 * would spin up a second runner on an already-hidden token and corrupt hide/restore
 * state (see `_hiddenTokens` registry in `finisher-engine.mjs`).
 */
const _tokenQueues = new Map();
export class FinisherEffect extends BaseEffect {
    static category = 'finishers';
    static enabled = true;
    static damageType = null;
    static synth = 'generic';
    static sequencer = [];
    static splatter = null;
    static playback = { duration: 3000, camera: true, bars: false };
    /** 'fire-finisher' → localization stem 'showstopper.cut-ins.finisher.fire'. */
    static get localizationKey() {
        return this.id.replace(/-finisher$/, '');
    }
    static getSettingsSchema() {
        return [
            ...super.getSettingsSchema(),
            {
                name: 'intensity',
                type: 'range',
                label: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.settings.intensity`),
                hint: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.settings.intensityHint`),
                group: 'unique',
                min: 0.5,
                max: 1.5,
                step: 0.1,
                suffix: '×',
                default: 1
            },
            {
                name: 'camera',
                type: 'checkbox',
                label: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.settings.camera`),
                hint: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.settings.cameraHint`),
                group: 'unique',
                default: true
            },
            {
                name: 'removeToken',
                type: 'checkbox',
                label: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.settings.removeToken`),
                hint: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.settings.removeTokenHint`),
                group: 'unique',
                default: false
            }
        ];
    }
    /** Priority order: explicit tokenIds → user targets → controlled tokens. */
    static resolveTargets(config = {}) {
        if (config.tokenIds?.length) {
            return config.tokenIds.map(id => canvas.tokens.get(id)).filter(Boolean);
        }
        const targeted = [...(game.user.targets ?? [])];
        if (targeted.length)
            return targeted;
        const controlled = [...(canvas.tokens?.controlled ?? [])];
        return controlled;
    }
    static getHint() {
        if (!this.enabled)
            return game.i18n.localize(`${MODULE_ID}.cut-ins.ui.comingSoon`);
        return '';
    }
    /**
     * Hides the token's subject image while leaving its native dynamic ring intact
     * (GM document update — persistent across all clients and reloads): overrides
     * `ring.subject.texture` with a transparent blank texture. The original path
     * is saved in `flags.showstopper.ringOnlyArt` ('' = was null, i.e. token art).
     * To restore: Token Config → Ring tab → clear Subject Texture (or copy the flag
     * back into `ring.subject.texture`). Tokens without a dynamic ring cannot become
     * ring-only markers and exit early.
     * `preview: true` — menu preview leaves the document untouched (`options.preview`).
     */
    static async applyRingOnly(token, { preview = false } = {}) {
        try {
            // Menu preview must never permanently hide a live token's art
            if (preview)
                return;
            if (!game.user.isGM)
                return;
            const doc = token?.document;
            if (!doc || token.destroyed)
                return;
            if (!isRingToken(doc))
                return;
            if (doc.ring?.subject?.texture === RING_ONLY_ART)
                return; // already a ring-only marker
            const updates = { 'ring.subject.texture': RING_ONLY_ART };
            const prev = doc.flags?.showstopper?.ringOnlyArt;
            if (prev === undefined || prev === null) {
                updates[RING_ONLY_FLAG] = doc.ring?.subject?.texture ?? '';
            }
            await doc.update(updates);
        }
        catch (e) {
            console.warn(`${MODULE_ID} | ring-only marker failed`, e);
        }
    }
    /**
     * Freezes a token into a persistent icy statue (GM document update — visible to
     * all clients and preserved across reloads): sets `texture.tint` to icy blue
     * (`#bfe6ff` — matching the final tile tint of the choreography for a seamless
     * handoff in `_dispose`). The original tint is stored in `flags.showstopper.frozenTint`.
     * To unfreeze: restore `texture.tint` from the flag and unset the flag (via toggle
     * macro or manually in Token Config → Appearance). Works on ANY token (dynamic-ring
     * or standard — `texture.tint` tints the subject art in both modes).
     * `preview: true` — menu preview leaves the document untouched (`options.preview`).
     */
    static async applyFrozenTint(token, { preview = false } = {}) {
        try {
            if (preview)
                return;
            if (!game.user.isGM)
                return;
            const doc = token?.document;
            if (!doc || token.destroyed)
                return;
            // Frozen marker is the FLAG, not the tint: comparing `texture.tint` directly
            // on a live client (`Color` instance in v14 `ColorField` / cross-client drift)
            // failed to recognize `#bfe6ff` and re-froze the token on every run
            if (doc.flags?.showstopper?.frozenTint !== undefined)
                return; // already frozen
            // Never save `FROZEN_TINT` itself as the "original" tint: tokens left in an
            // inconsistent state by an older bug (flag cleared while icy tint remained)
            // would otherwise record `#bfe6ff` as original and never thaw back to white
            const cur = textureTintCss(doc.texture?.tint);
            const saved = doc.flags?.showstopper?.shaderTint ?? (cur === FROZEN_TINT ? '#ffffff' : cur);
            const hasRing = Boolean(token?.hasDynamicRing || isRingToken(doc));
            const updates = { [FROZEN_FLAG]: saved };
            if (!hasRing)
                updates['texture.tint'] = FROZEN_TINT;
            else if (cur === FROZEN_TINT && saved !== FROZEN_TINT)
                updates['texture.tint'] = saved;
            await doc.update(updates);
        }
        catch (e) {
            console.warn(`${MODULE_ID} | frozen tint failed`, e);
        }
    }
    /**
     * Applies a persistent GLSL shader from the library (`SHADER_EFFECTS`:
     * `'frozen' | 'petrified' | 'burning' | 'corrupted' | 'gilded' | 'bloodrage' | 'glitch'`).
     * Saves the original `texture.tint` in a flag and applies the effect's base tint
     * so the handoff between the choreography clone and live token is seamless.
     */
    static async applyShaderEffect(token, effectId, { preview = false } = {}) {
        try {
            if (preview)
                return;
            if (!game.user.isGM)
                return;
            const doc = token?.document;
            if (!doc || token.destroyed)
                return;
            const spec = SHADER_EFFECTS[effectId];
            if (!spec)
                return;
            if (effectId === 'frozen')
                return this.applyFrozenTint(token, { preview });
            if (doc.flags?.showstopper?.shaderEffect === effectId)
                return;
            const allShaderTints = new Set(Object.values(SHADER_EFFECTS).map(s => s.tint.toLowerCase()));
            const cur = textureTintCss(doc.texture?.tint);
            const prevSaved = doc.flags?.showstopper?.shaderTint ?? doc.flags?.showstopper?.frozenTint;
            const origTint = prevSaved ?? (allShaderTints.has(cur) ? '#ffffff' : cur);
            const hasRing = Boolean(token?.hasDynamicRing || isRingToken(doc));
            const updates = {
                [SHADER_EFFECT_FLAG]: effectId,
                [SHADER_TINT_FLAG]: origTint
            };
            if (!hasRing)
                updates['texture.tint'] = spec.tint;
            else if (allShaderTints.has(cur) && origTint !== cur)
                updates['texture.tint'] = origTint;
            await doc.update(updates);
        }
        catch (e) {
            console.warn(`${MODULE_ID} | shader effect '${effectId}' failed`, e);
        }
    }
    /**
     * Clears any persistent shader (`shaderEffect` and `frozenTint`) from a token
     * and restores its original `texture.tint`.
     */
    static async clearShaderEffect(token) {
        try {
            if (!game.user.isGM)
                return;
            const doc = token?.document;
            if (!doc || token.destroyed)
                return;
            const fl = doc.flags?.showstopper ?? {};
            if (fl.shaderEffect === undefined && fl.frozenTint === undefined && fl.shaderTint === undefined)
                return;
            const orig = fl.shaderTint ?? fl.frozenTint ?? '#ffffff';
            const allShaderTints = new Set(Object.values(SHADER_EFFECTS).map(s => s.tint.toLowerCase()));
            const safeOrig = (typeof orig === 'string' && !allShaderTints.has(orig.toLowerCase())) ? orig : '#ffffff';
            await doc.update({
                'texture.tint': safeOrig,
                'flags.showstopper.-=shaderEffect': null,
                'flags.showstopper.-=shaderTint': null,
                'flags.showstopper.-=frozenTint': null
            });
        }
        catch (e) {
            console.warn(`${MODULE_ID} | clearShaderEffect failed`, e);
        }
    }
    /**
     * Toggles a shader effect on a token: if `effectId` is already active, clears it
     * and restores the original tint; otherwise activates `effectId`.
     */
    static async toggleShaderEffect(token, effectId = 'frozen') {
        const doc = token?.document;
        if (!doc)
            return false;
        const fl = doc.flags?.showstopper ?? {};
        const curEffect = fl.shaderEffect ?? (fl.frozenTint !== undefined ? 'frozen' : null);
        if (curEffect === effectId) {
            await this.clearShaderEffect(token);
            return false;
        }
        if (effectId === 'frozen') {
            if (fl.shaderEffect !== undefined)
                await this.clearShaderEffect(token);
            await this.applyFrozenTint(token);
        }
        else {
            await this.applyShaderEffect(token, effectId);
        }
        return true;
    }
    /**
     * Triggers the finisher: resolves targets and broadcasts to all clients.
     * @param {{tokenIds?: string[], options?: object}} config
     */
    static async execute(config = {}) {
        const targets = this.resolveTargets(config);
        if (!targets.length) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.selectToken`));
            return;
        }
        const settings = this.getSettings();
        // Attacker = first controlled token outside `targets`: provides directional
        // vectors (side slashes, knockback, beams). Resolved once before broadcast so
        // every client renders the exact same scene.
        const attacker = [...(canvas.tokens?.controlled ?? [])]
            .find(t => !targets.some(tg => tg.id === t.id)) ?? null;
        const options = {
            intensity: settings.intensity ?? 1,
            camera: settings.camera ?? true,
            removeAfter: settings.removeToken ?? false,
            attackerId: attacker?.id ?? null,
            ...config.options
        };
        // `removeToken` is the only irreversible menu action without confirmation:
        // prompt once on the initiating client before broadcasting; choreographies and
        // API callers can pass `options.confirmed = true` to bypass the dialog
        if (options.removeAfter && !options.confirmed) {
            const confirmed = await foundry.applications.api.DialogV2.confirm({
                window: { title: game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.confirmRemoveTitle`) },
                content: `<p>${game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.confirmRemoveContent`)}</p>`
            });
            if (!confirmed)
                return;
        }
        getSocket().executeForEveryone(`showFinisher:${this.id}`, {
            id: this.id,
            tokenIds: targets.map(t => t.id),
            options,
            // Deterministic choreography RNG seed: minted ONCE on the initiating client
            // and broadcast to everyone so each player's local runner produces identical
            // scatter/jitter trajectories (see `FinisherRunner._rng`)
            seed: (Math.random() * 0x100000000) >>> 0
        });
    }
    /** Preview: runs locally without socket broadcast or token deletion. */
    static async preview(config = {}) {
        const targets = this.resolveTargets(config);
        if (!targets.length) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.selectToken`));
            return;
        }
        // Preview plays the same "Token 1 executes Token 2" interaction as live combat:
        // attacker = first controlled token outside `targets`
        const attacker = [...(canvas.tokens?.controlled ?? [])]
            .find(t => !targets.some(tg => tg.id === t.id)) ?? null;
        return this.runLocal({
            id: this.id,
            tokenIds: [targets[0].id],
            options: {
                intensity: 1,
                camera: true,
                removeAfter: false,
                attackerId: attacker?.id ?? null,
                ...config.options,
                preview: true
            }
        });
    }
    /** Socket handler entry point: runs sequentially per token. */
    static async runLocal(data = {}) {
        const tokens = (data.tokenIds ?? [])
            .map(id => canvas.tokens.get(id))
            .filter(Boolean);
        if (!tokens.length)
            return;
        const settings = this.getSettings();
        const options = {
            intensity: settings.intensity ?? 1,
            camera: settings.camera ?? true,
            removeAfter: false,
            ...data.options
        };
        for (const token of tokens) {
            // Per-token serialization: while a runner is animating a token, any subsequent
            // trigger on that same token queues behind it (socket messages arrive FIFO, so
            // every client executes the exact same chain).
            const prev = _tokenQueues.get(token.id) ?? Promise.resolve();
            const job = prev.catch(() => { }).then(() => this._runFinisher(token, options, data.seed));
            _tokenQueues.set(token.id, job);
            try {
                await job;
            }
            finally {
                if (_tokenQueues.get(token.id) === job)
                    _tokenQueues.delete(token.id);
            }
        }
    }
    /** Executes a single finisher on a single token; exclusivity guaranteed by `runLocal` queue. */
    static async _runFinisher(token, options, seed) {
        const runner = new FinisherRunner({
            effectId: this.id,
            token,
            seed,
            options: {
                ...options,
                // When auto-removing, keep the token hidden across all clients so it doesn't
                // flash visible for a single frame right before deletion; if `delete()` fails,
                // the GM restores visibility and broadcasts recovery over the socket.
                // `aftermath` finishers (`ringOnly`/`frozen`) NEVER delete the token (early
                // return below) — setting `keepHidden` on them would leave the victim permanently
                // invisible because restore is suppressed and delete-failure rescue never runs
                keepHidden: options.removeAfter === true && !options.preview && !this.aftermath
            }
        });
        // The constructor has already attached the ticker, hidden the token, and armed
        // `_enforceHidden`, whereas the watchdog is armed only INSIDE `run()`. Any
        // synchronous throw in between (e.g. third-party `getSettingsSchema`/playback)
        // would leak an immortal ticker and permanently hidden token — guard with try/finally.
        let ran = false;
        try {
            // Audio: custom sound file in settings takes precedence over synthesis.
            // `synthDelay` offsets flavor start on choreographies with `dashStrike` whose
            // t=0-aligned beats would otherwise play ahead of the visuals by the lunge
            // duration — applied ONLY when an attacker is actually present
            const soundPath = this.getSoundPath();
            if (soundPath) {
                this.playSound(this.getSoundVolume());
            }
            else {
                const synthDelay = runner.attackerCenter ? (this.synthDelay ?? 0) : 0;
                if (synthDelay > 0) {
                    runner.after(synthDelay, () => playFinisherSound(this.synth, this.getSoundVolume()));
                }
                else {
                    playFinisherSound(this.synth, this.getSoundVolume());
                }
            }
            playSequencerEffects(this.sequencer, token);
            // Blood: persistent Showstopper blood decals (falls back to Splatter if disabled).
            // Spawned at impact time (delay of first Sequencer garnish), GM-only since scene
            // flags are written by the GM. `dir` = attacker center for directional splatter.
            // Preview NEVER writes decals so third-party defs with `static splatter` don't
            // mint permanent scene blood when previewed from the menu
            if (this.splatter && game.user.isGM && !options.preview) {
                const attacker = options.attackerId ? canvas.tokens.get(options.attackerId) : null;
                const dir = attacker?.center ?? null;
                const size = this.splatter.size ?? 2;
                const strikeAt = Math.max(250, this.sequencer?.[0]?.delay ?? 0);
                runner.after(strikeAt, () => {
                    try {
                        if (token.destroyed)
                            return;
                        if (!showstopperBlood(token, { size, dir })) {
                            splatterSplash(token, this.splatter);
                        }
                    }
                    catch { /* blood decals are optional */ }
                });
            }
            if (this.playback.bars) {
                try {
                    const bars = globalThis.showstopper?.cinematicBars;
                    if (typeof bars?.showLocal === 'function')
                        bars.showLocal(this.playback.duration, 12);
                    else
                        bars?.show?.(this.playback.duration, 12);
                }
                catch { /* noop */ }
            }
            await runner.run(ctx => this.play(ctx));
            ran = true;
        }
        finally {
            if (!ran && !runner._disposed)
                runner._halt();
        }
        // `aftermath` corpses remain on the scene as live markers — do NOT delete the token.
        // `ringOnly`: choreography already hid subject art up front (`applyRingOnly` while
        // hidden by the engine); `frozen`: token already carries `FROZEN_TINT` (`applyFrozenTint`).
        // Normal visibility restoration in `_dispose` reveals the real token already in its
        // marker state. (`this` IS the class here: `this.constructor` would be `Function`)
        if (this.aftermath)
            return;
        // Safeguard for sessions without an active GM client: `keepHidden` above is set on
        // ALL clients, while token deletion is performed by the GM only (block below). If the
        // GM disconnected after broadcast, nobody clears the hidden entry and the victim stays
        // invisible until F5. After 10s, if the hidden entry is still stuck (entry present with
        // zero live runners), force-show locally via the same helper as `finisher:showToken`.
        // Normal deletion removes the entry earlier via `deleteToken`, making this a no-op.
        if (runner._keepHidden && !game.user.isGM) {
            setTimeout(() => {
                try {
                    if (!token.destroyed && FinisherRunner._hiddenEntryStuck(token.id)) {
                        this._forceShowTokens([token.id]);
                    }
                }
                catch { /* noop */ }
            }, 10000);
        }
        // Preview never deletes the token (`preview()` contract: non-destructive),
        // even if a caller passed `removeAfter: true` in `config.options`
        if (options.removeAfter && !options.preview && game.user.isGM && !token.destroyed) {
            try {
                await token.document.delete();
                // Token deleted — hidden tracking entry is no longer needed
                FinisherRunner._dropHiddenEntry(token.id);
            }
            catch (e) {
                console.warn(`${MODULE_ID} | Finisher token removal failed`, e);
                // Deletion failed: restore token visibility locally and across all other clients
                runner._keepHidden = false;
                runner._restoreTokenVisuals();
                try {
                    getSocket().emitRaw('finisher:showToken', { tokenIds: [token.id] });
                }
                catch { /* noop */ }
            }
        }
    }
    /**
     * Default choreography: attacker lunge (when present), flash + shockwave +
     * DIRECTIONAL tile scatter — blasting the body in a cone away from the attacker.
     * Used whenever a subclass or declarative definition omits a custom `play()`.
     */
    static async play(ctx) {
        const cap = ctx.capture();
        const { center, grid } = ctx;
        // "Token 1 executes Token 2" interaction: short wind-up pause when no attacker
        if (ctx.attackerCenter)
            await ctx.dashStrike();
        else
            await ctx.wait(200);
        ctx.flash({ radius: grid * 3, duration: 500, color: 0xffffff });
        ctx.shockwave({ r1: grid * 4, duration: 800, color: 0xffffff, width: 5 });
        ctx.shake({ duration: 450, strength: 12 });
        if (cap) {
            const coneA = Math.atan2(ctx.dirFromAttacker.y, ctx.dirFromAttacker.x);
            cap.eachTile(t => {
                // 70% of tiles scatter in a cone away from the attacker, 30% radially:
                // reads clearly as a directional blow without looking artificially uniform
                const angle = ctx.chance(0.7)
                    ? coneA + ctx.rand(-0.55, 0.55)
                    : Math.atan2(t.hy - center.y, t.hx - center.x) + ctx.rand(-0.5, 0.5);
                const dist = ctx.rand(grid * 0.5, ctx.rand(1.2, 2.6) * grid * (ctx.attackerCenter ? 1.25 : 1));
                // Ring-safe: re-read `t.sprite` every frame — a direct tween on the initially
                // captured sprite gets dropped when dynamic-ring upgrade swaps the body sprite
                // (which previously left the ring clone frozen instead of scattering)
                const spin = ctx.rand(-2.5, 2.5);
                const sc = { k: 0 };
                ctx.tween(sc, { k: 1 }, {
                    duration: ctx.rand(700, 1200),
                    delay: ctx.rand(0, 250),
                    ease: Ease.outCubic,
                    onUpdate: () => {
                        const s = t.sprite;
                        if (!s || s.destroyed)
                            return;
                        const k = sc.k;
                        s.x = t.hx + Math.cos(angle) * dist * k;
                        s.y = t.hy + Math.sin(angle) * dist * k;
                        s.rotation = spin * k;
                        s.alpha = 1 - k;
                    }
                });
            });
        }
        ctx.particles({
            texture: 'soft', blend: 'add', count: 80,
            life: [500, 1100], size: [4, 10], shrink: 0.7,
            tint: [0xffffff, 0xfff2cc],
            spawn: p => {
                p.x = center.x + ctx.rand(-20, 20);
                p.y = center.y + ctx.rand(-20, 20);
                const a = ctx.attackerCenter
                    ? Math.atan2(ctx.dirFromAttacker.y, ctx.dirFromAttacker.x) + ctx.rand(-0.7, 0.7)
                    : ctx.rand(0, Math.PI * 2);
                const v = ctx.rand(60, 240);
                p.vx = Math.cos(a) * v;
                p.vy = Math.sin(a) * v;
                p.drag = 1.5;
            }
        }).burst(60);
        await ctx.wait(1400);
    }
    static registerSocketHandler(socket) {
        // Dispatch via `effectRegistry`: the registry supports hot-REPLACING effects
        // by id (`registerFinisher` with an existing id), whereas `socket.register` is
        // first-wins; routing through the registry ensures broadcast playback uses the
        // latest choreography instead of diverging from local menu previews
        socket.register(`showFinisher:${this.id}`, d => (effectRegistry.get(d.id) ?? this).runLocal(d));
        // Emergency token visibility recovery if post-finisher GM deletion fails
        // (registered by every subclass, first-wins — shared handler)
        socket.register('finisher:showToken', d => this._forceShowTokens(d?.tokenIds));
        // `removeAfter` deletion replicates to ALL clients, whereas `_dropHiddenEntry`
        // was called only on the GM — leaving disposed runner refs (with token/actor graphs)
        // in `_hiddenTokens` on player clients for the rest of the session. Clean up on `deleteToken`.
        if (!finisherEffectGlobals.deleteHookReady) {
            finisherEffectGlobals.deleteHookReady = true;
            Hooks.on('deleteToken', doc => {
                const id = doc?.id ?? doc?._id;
                if (id) {
                    try {
                        FinisherRunner._dropHiddenEntry(id);
                    }
                    catch { /* noop */ }
                }
            });
        }
    }
    /** Force-restores visibility on all visual parts of the given tokens (see engine `_hideTokenVisuals`). */
    static _forceShowTokens(tokenIds = []) {
        for (const id of tokenIds) {
            const token = canvas.tokens.get(id);
            if (!token || token.destroyed)
                continue;
            // Direct recovery: clear the entire hidden entry so per-frame enforcement
            // from any live runners stands down and doesn't fight emergency unhide
            FinisherRunner._clearHiddenEntry(id);
            // The PlaceableObject itself is the MASTER switch (`_hideTokenVisuals` hides
            // it too): without restoring `token.visible`, core `_refreshVisibility` recomputes
            // `mesh.visible = false` and leaves the token stuck invisible until F5
            for (const part of [token, token.mesh, token.ring, token.border, token.bars, token.tooltip]) {
                if (!part)
                    continue;
                try {
                    part.renderable = true;
                    part.visible = true;
                }
                catch { /* noop */ }
            }
            try {
                const items = globalThis.showstopper?.dynamicItems?.manager?._displays?.get?.(id);
                if (items) {
                    for (const d of items.values()) {
                        for (const s of [d?._sprite, d?._glowSprite]) {
                            if (!s)
                                continue;
                            s.renderable = true;
                            s.visible = true;
                        }
                    }
                }
            }
            catch { /* noop */ }
        }
    }
    /** Shared finisher CSS styles (injected once by `effectRegistry`). */
    static getStyles() {
        return `
.ss-finisher-screenflash {
  position: fixed;
  inset: 0;
  z-index: 9998;
  pointer-events: none;
  opacity: 0;
}
`;
    }
    static getPreloadAssets() {
        const assets = super.getPreloadAssets();
        return assets;
    }
}
