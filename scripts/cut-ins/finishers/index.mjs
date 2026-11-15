/**
 * Finishers — the fourth tab of the Showstopper menu.
 *
 * Extension points for third-party modules:
 *
 *   showstopper.finishers.register(ClassOrDef)
 *     — either a class extending FinisherEffect (full control),
 *       OR a declarative definition object:
 *       {
 *         id: 'my-finisher',            // required; works without '-finisher' suffix too
 *         icon: 'fa-solid fa-skull',
 *         damageType: 'radiant',         // optional: bind to a damage type
 *         synth: 'fire',                 // procedural sound flavor from finisher-audio
 *         sequencer: [{ file, delay }],  // JB2A garnish via Sequencer
 *         playback: { duration: 3000, camera: true },
 *         aftermath: 'ringOnly',         // optional: leave a "ring-only" marker instead of deleting
 *         synthDelay: 660,               // optional: synth sound delay for dashStrike (ms)
 *         async play(ctx) { ... }        // engine choreography; if omitted, uses
 *                                        // FinisherEffect's default burst
 *       }
 *   showstopper.finishers.unregister(id)
 *   showstopper.finishers.play(id, targets, options)
 *   showstopper.finishers.playForDamage('fire', targets, options)
 *   showstopper.finishers.get(id) / getAll() / getByDamageType()
 */
import { effectRegistry } from '../registry.mjs';
import { resolveLocalizableText } from '../base-effect.mjs';
import { FinisherEffect } from './finisher-effect.mjs';
import { FinisherRunner, Ease, lerpColor, ParticleTextures } from './finisher-engine.mjs';
import { FINISHER_SOUND_FLAVORS } from './finisher-audio.mjs';
import { registerTokenShaders, SHADER_EFFECTS, SHADER_EFFECT_IDS, resolveTokenShaderEffect, syncToken as syncShaderToken, syncAllTokenShaders, prewarmTokenShaders } from './token-shaders.mjs';
import { MODULE_ID } from '../../config.mjs';
export const finisherEffects = [];
// Persistent token and dynamic ring shaders (Frozen, Petrified, Burning, etc.) — hooks registered once
registerTokenShaders();
/** Wraps a declarative finisher definition in a FinisherEffect subclass. */
export function defineFinisher(def) {
    if (!def?.id)
        throw new Error(`${MODULE_ID} | defineFinisher: 'id' is required`);
    class DefinedFinisher extends FinisherEffect {
    }
    DefinedFinisher.id = def.id;
    DefinedFinisher.icon = def.icon ?? 'fa-solid fa-skull';
    DefinedFinisher.order = typeof def.order === 'number' ? def.order : 0;
    DefinedFinisher.damageType = def.damageType ?? null;
    DefinedFinisher.synth = def.synth ?? 'generic';
    DefinedFinisher.sequencer = def.sequencer ?? [];
    DefinedFinisher.splatter = def.splatter ?? null;
    DefinedFinisher.playback = { ...FinisherEffect.playback, ...(def.playback ?? {}) };
    DefinedFinisher.enabled = def.enabled ?? true;
    if (def.name != null || def.nameLabel != null)
        DefinedFinisher.nameLabel = def.name ?? def.nameLabel;
    if (def.description != null || def.descriptionLabel != null)
        DefinedFinisher.descriptionLabel = def.description ?? def.descriptionLabel;
    if (def.hint != null || def.hintLabel != null)
        DefinedFinisher.hintLabel = def.hint ?? def.hintLabel;
    if (def.requiredSystem != null)
        DefinedFinisher.requiredSystem = def.requiredSystem;
    if (def.requiredModules != null)
        DefinedFinisher.requiredModules = def.requiredModules;
    // aftermath/synthDelay are static fields without defaults on the base class:
    // without copying them over, 'ringOnly' in def would be silently lost (deleting
    // the token as usual) and synth delays on dashStrike choreographies would be ignored
    if (def.aftermath)
        DefinedFinisher.aftermath = def.aftermath;
    if (typeof def.synthDelay === 'number')
        DefinedFinisher.synthDelay = def.synthDelay;
    if (typeof def.play === 'function')
        DefinedFinisher.play = def.play;
    if (typeof def.getSettingsSchema === 'function') {
        DefinedFinisher.getSettingsSchema = def.getSettingsSchema;
    }
    else if (Array.isArray(def.settings)) {
        const customFields = def.settings;
        DefinedFinisher.getSettingsSchema = function () {
            const base = FinisherEffect.getSettingsSchema.call(this);
            const mapped = customFields.map((f) => ({
                ...f,
                group: f.group || 'unique',
                label: resolveLocalizableText(f.label, f.name),
                hint: f.hint != null ? resolveLocalizableText(f.hint, '') : undefined
            }));
            return [...base, ...mapped];
        };
    }
    return DefinedFinisher;
}
effectRegistry._setFinisherFactory(defineFinisher);
function refreshOpenMenu() {
    try {
        foundry.applications.instances?.get('cinema-menu-dialog')?.render();
    }
    catch { /* menu may be closed */ }
}
/**
 * Registers a finisher: either a FinisherEffect class or a declarative object.
 * @param {Function|object} target
 * @returns {Function} registered class
 */
export function registerFinisher(target) {
    const EffectClass = (typeof target === 'function')
        ? target
        : defineFinisher(target);
    effectRegistry.register(EffectClass);
    refreshOpenMenu();
    return EffectClass;
}
export function unregisterFinisher(id) {
    const ok = effectRegistry.unregister(id);
    if (ok)
        refreshOpenMenu();
    return ok;
}
/** All registered finishers. */
export function getAllFinishers() {
    return effectRegistry.getByCategory('finishers');
}
/** Finisher by id (null if not found or not a finisher). */
export function getFinisher(id) {
    const cls = effectRegistry.get(id);
    return (cls?.prototype instanceof FinisherEffect || cls === FinisherEffect) ? cls : null;
}
/** All finishers bound to a damage type (disabled ones are excluded —
 *  including in playForDamage, so auto-triggers never play disabled effects). */
export function getFinishersByDamageType(damageType) {
    return getAllFinishers().filter(f => f.damageType === damageType && f.enabled !== false);
}
/** Public API object (published via registerAPI in main.mjs). */
export function buildFinishersAPI() {
    return {
        // Base classes & helpers for third-party finishers (subclassing without ESM imports)
        FinisherEffect,
        FinisherRunner,
        Ease,
        lerpColor,
        ParticleTextures,
        register: registerFinisher,
        unregister: unregisterFinisher,
        define: defineFinisher,
        get: getFinisher,
        getAll: getAllFinishers,
        getByDamageType: getFinishersByDamageType,
        /** Play a finisher by id. */
        play(id, targets = null, options = {}) {
            // Finisher classes only: the registry is shared across all categories, so an id
            // collision with an effect from another category would invoke the wrong execute()
            const cls = getFinisher(id);
            if (!cls) {
                console.warn(`${MODULE_ID} | finishers.play: '${id}' is not a registered finisher`);
                return Promise.resolve();
            }
            const tokenIds = targets?.map(t => t?.id ?? t).filter(Boolean);
            return cls.execute({ tokenIds, options });
        },
        /** Play by damage type (picks the first matching finisher). */
        playForDamage(damageType, targets = null, options = {}) {
            const cls = getFinishersByDamageType(damageType)[0];
            if (!cls) {
                console.warn(`${MODULE_ID} | finishers.playForDamage: no finisher for '${damageType}'`);
                return Promise.resolve();
            }
            const tokenIds = targets?.map(t => t?.id ?? t).filter(Boolean);
            return cls.execute({ tokenIds, options });
        },
        /** List of available procedural sound flavors. */
        get soundFlavors() { return FINISHER_SOUND_FLAVORS; },
        /** Public API for token shader states (Frozen, Petrified, Burning, etc.). */
        shaders: {
            effects: SHADER_EFFECTS,
            ids: SHADER_EFFECT_IDS,
            resolve: resolveTokenShaderEffect,
            sync: syncShaderToken,
            syncAll: syncAllTokenShaders,
            prewarm: prewarmTokenShaders,
            apply: (token, effectId, opts) => FinisherEffect.applyShaderEffect(token, effectId, opts),
            clear: (token) => FinisherEffect.clearShaderEffect(token),
            toggle: (token, effectId) => FinisherEffect.toggleShaderEffect(token, effectId)
        }
    };
}
