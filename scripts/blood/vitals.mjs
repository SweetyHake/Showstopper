/**
 * Token "vitality": reading HP/wounds via system paths, bleeding thresholds,
 * wound depth, and death state. Single SYSTEM_HP_PATHS table serves as both the
 * default source for settings in entry.mjs (a second divergent copy in entry
 * once silently broke demonlord) and the read fallback here. Consumers: events
 * (generation), trail (footprints/trails), bloodied (overlay).
 */
import { MODULE_ID } from '../config.mjs';
import { settingGet } from './util.mjs';
/** Bleeding status effect: name or status ID (en/ru taxonomy). */
export const BLEED_RE = /bleed|кровотеч/i;
/** Prone / knocked-down status effect. */
export const PRONE_RE = /prone|ничком|опрокинут|сбит/i;
/** Crawling / dragging states (prone, unconscious, paralyzed, incapacitated, dead). */
export const DRAG_STATUS_RE = /prone|unconscious|paralyzed|incapacitated|dead|defeated|ничком|бессознат|парализ|недееспособ|мертв|мёртв/i;
/**
 * HP paths per game system — SINGLE exported table: entry.mjs registers
 * defaults for bloodHpPath/bloodHpMaxPath/bloodUseWounds/bloodCreatureTypePath
 * directly from it. useWounds: hp is a WOUND COUNTER that increases with damage
 * (swade wounds; demonlord characteristics.health.value — "damage score" per
 * the system's README) rather than remaining health. creatureType '' means the
 * system has no creature type path. deathFails is the death-save failure counter
 * path ('' = no such mechanic): the pool beneath a dying token grows with each failure.
 */
export const SYSTEM_HP_PATHS = {
    dnd5e: { currentHp: 'attributes.hp.value', maxHp: 'attributes.hp.max', creatureType: 'details.type.value', useWounds: false, deathFails: 'attributes.death.failure' },
    sw5e: { currentHp: 'attributes.hp.value', maxHp: 'attributes.hp.max', creatureType: 'details.type.value', useWounds: false, deathFails: 'attributes.death.failure' },
    pf1e: { currentHp: 'attributes.hp.value', maxHp: 'attributes.hp.max', creatureType: 'details.type.value', useWounds: false, deathFails: '' },
    pf2e: { currentHp: 'attributes.hp.value', maxHp: 'attributes.hp.max', creatureType: 'traits.value', useWounds: false, deathFails: 'attributes.dying.value' },
    swade: { currentHp: 'wounds.value', maxHp: 'wounds.max', creatureType: '', useWounds: true, deathFails: '' },
    demonlord: { currentHp: 'characteristics.health.value', maxHp: 'characteristics.health.max', creatureType: '', useWounds: true, deathFails: '' },
    wfrp4e: { currentHp: 'status.wounds.value', maxHp: 'status.wounds.max', creatureType: 'details.species.value', useWounds: false, deathFails: '' },
    ds4: { currentHp: 'combatValues.hitPoints.value', maxHp: 'combatValues.hitPoints.max', creatureType: 'baseInfo.creatureType', useWounds: false, deathFails: '' }
};
/** Death-save failure counter path for the current system ('' = none). */
export function deathFailsPath() {
    return SYSTEM_HP_PATHS[game.system?.id]?.deathFails ?? '';
}
export function hpPaths() {
    const sys = SYSTEM_HP_PATHS[game.system?.id] ?? {};
    return {
        cur: settingGet('bloodHpPath', sys.currentHp ?? 'attributes.hp.value'),
        max: settingGet('bloodHpMaxPath', sys.maxHp ?? 'attributes.hp.max'),
        wounds: settingGet('bloodUseWounds', sys.useWounds ?? false)
    };
}
export function prop(obj, path) {
    try {
        return foundry.utils.getProperty(obj, path);
    }
    catch {
        return undefined;
    }
}
export function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
export function getHp(actor) { return num(prop(actor?.system, hpPaths().cur)); }
export function getHpMax(actor) { return num(prop(actor?.system, hpPaths().max)); }
export function bloodEnabled() { return settingGet('bloodEnabled', true); }
/**
 * Bleeding status effect on a token: an active effect whose name or status ID
 * matches "bleed/bleeding" (English or Russian; dnd5e modules, pf2e Persistent Bleed
 * Damage, custom conditions). In v14, `statuses` is a Set of strings directly on
 * the effect document.
 */
export function hasBleedStatus(token) {
    const actor = token?.actor ?? token?.document?.actor;
    const effects = actor?.effects;
    if (!effects)
        return false;
    try {
        for (const e of effects) {
            if (!e || e.disabled)
                continue;
            if (BLEED_RE.test(e.name ?? ''))
                return true;
            const statuses = e.statuses;
            if (statuses?.size) {
                for (const s of statuses)
                    if (typeof s === 'string' && BLEED_RE.test(s))
                        return true;
            }
        }
    }
    catch { /* noop */ }
    return false;
}
export function statusBleedOn() { return settingGet('bloodBleedStatus', true); }
/** Token is "bleeding": has a bleed status effect OR HP crossed the threshold. */
export function isBleeding(token) {
    if (statusBleedOn() && hasBleedStatus(token))
        return true;
    return isWounded(token);
}
/** Threshold bleeding: for HP systems `hp` is remaining health (bleeding when
 *  HP share is AT OR BELOW threshold); for wounds systems `hp` is a wound
 *  counter (bleeding when wound share is AT OR ABOVE threshold). */
export function isWounded(token) {
    const actor = token?.actor ?? token?.document?.actor;
    if (!actor)
        return false;
    const hp = getHp(actor), max = getHpMax(actor);
    if (hp === undefined || !max)
        return false;
    const { wounds } = hpPaths();
    const threshold = settingGet('bloodThreshold', 50);
    const pct = (100 * hp) / max;
    return wounds ? pct >= threshold : pct <= threshold;
}
export function resolveToken(actor) {
    try {
        const active = actor.getActiveTokens?.() ?? [];
        if (active[0])
            return active[0];
    }
    catch { /* noop */ }
    return canvas.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
}
/** Wound depth 0..1: 0 = just at threshold, 1 = near death. A bleed status
 *  effect enforces a 0.6 floor so status-bleeding tokens drip noticeably even at full HP. */
export function woundDepth(token) {
    const actor = token?.actor ?? token?.document?.actor;
    if (!actor)
        return 0;
    let depth = 0;
    const hp = getHp(actor), max = getHpMax(actor);
    if (hp !== undefined && max) {
        const { wounds } = hpPaths();
        const threshold = settingGet('bloodThreshold', 50);
        const pct = (100 * hp) / max;
        const badShare = wounds ? pct : 100 - pct; // damage/wound percentage
        depth = Math.max(0, Math.min(1, (badShare - threshold) / Math.max(1, 100 - threshold)));
    }
    if (statusBleedOn() && hasBleedStatus(token))
        depth = Math.max(depth, 0.6);
    return depth;
}
/** Per-token blood disable toggle (ghosts/constructs): flag set in token config. */
export function bloodDisabled(token) {
    const doc = token?.document ?? token;
    if (typeof doc?.getFlag !== 'function')
        return false;
    try {
        return doc.getFlag(MODULE_ID, 'bloodDisabled') === true;
    }
    catch {
        return false;
    }
}
/**
 * Fraction of damage/wounds in 0..1 (HP systems = damage share, wounds = wound share)
 * or null if HP cannot be read. Publicly used by the token bloodied-overlay engine.
 */
export function hpShare(token) {
    const actor = token?.actor ?? token?.document?.actor;
    if (!actor)
        return null;
    const hp = getHp(actor), max = getHpMax(actor);
    if (hp === undefined || !max)
        return null;
    const { wounds } = hpPaths();
    const pct = (100 * hp) / max;
    const bad = wounds ? pct : 100 - pct;
    return Math.max(0, Math.min(1, bad / 100));
}
/** Dead? (HP: hp ≤ 0; wounds: wound counter reached max). Actorless tokens return false. */
export function isDeadDoc(doc) {
    const actor = doc?.actor ?? doc?.document?.actor;
    if (!actor)
        return false;
    const hp = getHp(actor), max = getHpMax(actor);
    if (hp === undefined || !max)
        return false;
    return hpPaths().wounds ? hp >= max : hp <= 0;
}
/** Check whether a status effect matches a regex (`actor.statuses` Set and `actor.effects`). */
function _hasStatusMatching(tokenOrDoc, re) {
    const actor = tokenOrDoc?.actor ?? tokenOrDoc?.document?.actor;
    if (!actor)
        return false;
    try {
        if (actor.statuses?.size) {
            for (const s of actor.statuses)
                if (typeof s === 'string' && re.test(s))
                    return true;
        }
        const effects = actor.effects;
        if (effects) {
            for (const e of effects) {
                if (!e || e.disabled)
                    continue;
                if (re.test(e.name ?? ''))
                    return true;
                if (e.statuses?.size) {
                    for (const s of e.statuses)
                        if (typeof s === 'string' && re.test(s))
                            return true;
                }
            }
        }
    }
    catch { /* noop */ }
    return false;
}
/** Token is knocked prone. */
export function hasProneStatus(tokenOrDoc) {
    return _hasStatusMatching(tokenOrDoc, PRONE_RE);
}
/** Token is crawling (prone) or being dragged (corpse / unconscious / paralyzed). */
export function isCrawlingOrDragged(tokenOrDoc) {
    const doc = tokenOrDoc?.document ?? tokenOrDoc;
    if (isDeadDoc(doc))
        return true;
    return _hasStatusMatching(tokenOrDoc, DRAG_STATUS_RE);
}
