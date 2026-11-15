const MODULE_ID = 'showstopper';
const SETTING_KEY = 'stats';
const SAVE_DELAY = 2000;
const MAX_LOG = 100;
import { StatsRepository } from './persistence.mjs';
import { StatsApp } from './stats-app.mjs';
import { registerRawHandler, emitRaw } from '../core/socket-manager.mjs';
const SOCKET_NS_TRACK = 'stats.track';
const PORTRAIT_STUBS = new Set([
    '',
    'icons/svg/mystery-man.svg',
    'icons/mystery-man.svg',
    'systems/dnd5e/icons/svg/actors/character.svg',
    'systems/dnd5e/icons/svg/actors/npc.svg',
    'systems/dnd5e/icons/svg/actors/vehicle.svg',
    'systems/dnd5e/icons/svg/actors/group.svg'
]);
class StatsMenuLauncher extends foundry.applications.api.ApplicationV2 {
    async render(_options, _options2) {
        return RollStats.showStats();
    }
}
class RollStats {
    static _store = null;
    static _saveTimer = null;
    static _dirty = false;
    static _rollLog = [];
    // Data revision: incremented on every stats mutation (roll, rotation, reset).
    // The UI (StatsApp) caches the aggregated list and recomputes it only when
    // the revision changes, avoiding a world scan and deep _sum on every checkbox toggle.
    static _dataRev = 0;
    // Subscribers notified on data revision changes (auto-refreshes open StatsApp).
    static _dataRevSubs = new Set();
    static _repository = new StatsRepository();
    // Instance dedup: prevents counting the same Roll instance twice if a hook
    // fires repeatedly. Cross-path dedup (activity -> message) uses roll signatures.
    static _seenRolls = new WeakSet();
    static _seenSpellUses = new Set();
    static _suppressDownActors = new Map();
    static _TRACK_CATS = new Set(['attack', 'spellCast', 'damage', 'healing', 'undoDamage', 'undoHealing', 'concentration', 'save', 'abilityCheck', 'skill', 'tool', 'deathSave']);
    static _MAX_SPELL_KEYS = 150;
    // Events queued locally while no GM is connected (see _emitTrack).
    static _emitQueue = [];
    static _EMIT_QUEUE_MAX = 200;
    // ── init / persist ──────────────────────────────
    static registerSettings() {
        game.settings.register(MODULE_ID, SETTING_KEY, {
            scope: 'world', config: false, type: Object, default: {}
        });
        game.settings.register(MODULE_ID, 'statsEnabled', {
            name: 'showstopper.Stats.StatsEnabled.Name',
            hint: 'showstopper.Stats.StatsEnabled.Hint',
            scope: 'world', config: false, type: Boolean, default: true
        });
        if (game.system?.id === 'dnd5e') {
            game.settings.registerMenu(MODULE_ID, 'statsMenu', {
                name: 'showstopper.Stats.Title',
                label: 'showstopper.Stats.OpenButton',
                hint: 'showstopper.Stats.MenuHint',
                icon: 'fa-solid fa-chart-column',
                type: StatsMenuLauncher,
                restricted: false
            });
        }
    }
    static _midiActive() {
        return game.modules?.get('midi-qol')?.active === true;
    }
    static async init() {
        await this._load();
        this._registerHooks();
        registerRawHandler(SOCKET_NS_TRACK, (payload) => this._onSocketTrack(payload));
        console.log(`${MODULE_ID} | RollStats ready`);
    }
    static async _load() {
        this._store = await this._repository.getSettings();
        if (!this._store.currentDate) {
            this._store.currentDate = this._today();
        }
        else if (this._store.currentDate !== this._today()) {
            await this._rotateSession(this._today());
        }
        // Persist currentDate: legacy settings stored {sessions} without it,
        // preventing automatic session rotation from ever triggering.
        await this._saveNow();
        this._rollLog = await this._repository.getLog();
    }
    static _saveLog(force) {
        if (!game.user?.isGM)
            return;
        this._repository.setLog(this._rollLog.slice(-MAX_LOG), force);
    }
    static registerLogSetting() {
        game.settings.register(MODULE_ID, 'statsLog', {
            scope: 'world', config: false, type: Object, default: []
        });
    }
    static async newSession() {
        if (!game.user?.isGM)
            return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: 'showstopper.Stats.ConfirmNewSessionTitle', icon: 'fa-solid fa-circle-plus' },
            content: `<p class="ss-dialog-text">${game.i18n.localize('showstopper.Stats.ConfirmNewSessionContent')}</p>`
        });
        if (!confirmed)
            return;
        await this._rotateSession(this._today());
    }
    static async resetStats() {
        if (!game.user.isGM)
            return;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: 'showstopper.Stats.ConfirmResetTitle', icon: 'fa-solid fa-triangle-exclamation' },
            content: `<p class="ss-dialog-text">${game.i18n.localize('showstopper.Stats.ConfirmResetContent')}</p>`
        });
        if (!confirmed)
            return;
        await this._flushFlags();
        const unsets = [];
        // unsetFlag is async: await every unset before writing fresh values so an
        // event arriving between flush and unset cannot resurrect cleared stats.
        for (const actor of this._allStatActors()) {
            unsets.push(actor.unsetFlag('showstopper', 'statTracker').catch(e => console.error('showstopper | unsetFlag error', e)));
            for (const item of actor.items) {
                unsets.push(item.unsetFlag('showstopper', 'statTracker').catch(e => console.error('showstopper | unsetFlag error', e)));
            }
        }
        await Promise.all(unsets);
        // Events arriving between flush and unset echoes rehydrated pending entries
        // from the OLD flag — clear them so the next flush won't resurrect reset stats.
        this._repository.clearPending();
        this._store.sessionStart = Date.now();
        this._store.currentDate = this._today();
        this._rollLog = [];
        this._bumpDataRev();
        this._saveLog(true);
        await this._saveNow();
    }
    /** Current data revision — cache invalidation key for UI views. */
    static get dataRev() { return this._dataRev; }
    /**
     * Subscribe to data revision bumps (used for throttled re-renders of an open
     * StatsApp). Returns an unsubscribe callback.
     */
    static onDataRevChange(cb) {
        this._dataRevSubs.add(cb);
        return () => this._dataRevSubs.delete(cb);
    }
    static _bumpDataRev() {
        this._dataRev++;
        for (const cb of this._dataRevSubs) {
            try {
                cb(this._dataRev);
            }
            catch (e) {
                console.error(`${MODULE_ID} | dataRev subscriber failed:`, e);
            }
        }
    }
    /**
     * Return all actors carrying stats: linked actors in game.actors plus synthetic
     * actors of unlinked tokens across all scenes. For inactive scenes, token.actor
     * may be null (lazily instantiated) — such tokens are skipped and their stats
     * simply wait until that scene becomes active.
     */
    static _allStatActors() {
        const actors = [...(game.actors ?? [])];
        for (const scene of game.scenes ?? []) {
            for (const token of scene.tokens ?? []) {
                const actor = token.actor;
                if (actor?.isToken)
                    actors.push(actor);
            }
        }
        return actors;
    }
    static _scheduleSave() {
        this._dirty = true;
        if (this._saveTimer)
            return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            if (this._dirty)
                this._saveNow();
        }, SAVE_DELAY);
    }
    static async _saveNow() {
        this._dirty = false;
        await this._repository.saveSettings(this._store);
    }
    static _today() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    /**
     * Shared session rotation: merge session -> lifetime across all actors, then
     * clear session data and the roll log. GM-only; flushes pending flags before merging.
     */
    static async _rotateSession(today) {
        if (!game.user?.isGM)
            return;
        const pendingEntries = this._repository.pendingActorIds()
            .map(id => this._repository.getPendingActorData(id))
            .filter(Boolean);
        await this._flushFlags();
        for (const entry of pendingEntries) {
            entry.lifetime = this._pruneStats(this._sum(entry.lifetime, entry.session));
            entry.session = this._freshActorData();
            this._repository.queueActorData(entry.actor, entry.session, entry.lifetime);
        }
        for (const actor of game.actors) {
            // Do not skip an actor whose event rehydrated a pending entry DURING flush:
            // rotate that pending entry directly (it still holds the pre-rotation flag)
            // so the session does not cross the boundary unrotated. For entries already
            // rotated by the first loop above, this is an idempotent no-op (session is zeroed).
            const pending = this._repository.getPendingActorData(actor.uuid);
            const flag = pending
                ? { session: pending.session, lifetime: pending.lifetime }
                : actor.getFlag('showstopper', 'statTracker');
            if (!flag?.session)
                continue;
            const merged = this._sum(this._migrate(flag.lifetime), this._migrate(flag.session));
            this._repository.queueActorData(actor, this._freshActorData(), this._pruneStats(merged));
        }
        // Unlinked tokens store session/lifetime on token.actorData and are not in game.actors.
        for (const actor of this._allStatActors()) {
            if (!actor.isToken)
                continue;
            const pending = this._repository.getPendingActorData(actor.uuid);
            const flag = pending
                ? { session: pending.session, lifetime: pending.lifetime }
                : actor.getFlag('showstopper', 'statTracker');
            if (!flag?.session)
                continue;
            const merged = this._sum(this._migrate(flag.lifetime), this._migrate(flag.session));
            this._repository.queueActorData(actor, this._freshActorData(), this._pruneStats(merged));
        }
        await this._flushFlags();
        this._store.currentDate = today;
        this._store.sessionStart = Date.now();
        this._rollLog = [];
        this._bumpDataRev();
        this._saveLog(true);
        await this._saveNow();
    }
    // ── data model ──────────────────────────────────
    static _freshActorData() {
        return {
            attacks: { total: 0, crits: 0, fumbles: 0, nat20: 0, nat1: 0, adv: 0, dis: 0 },
            damage: { dealt: 0, summonDealt: 0, taken: 0, downs: 0, byType: {} },
            healing: { total: 0, received: 0, given: 0, summonGiven: 0 },
            spells: { total: 0, byName: {}, byLevel: {} },
            saveSummary: { total: 0, successes: 0, failures: 0 },
            checks: { abilityCheck: { total: 0, best: 0 }, skill: {}, tool: {}, save: {} },
            deathSaves: { total: 0, successes: 0, failures: 0, critSuccess: 0, critFail: 0 },
            concentration: { total: 0, successes: 0, failures: 0 },
            kills: 0,
            nat20: 0, nat1: 0,
            advantageCount: 0, disadvantageCount: 0,
            dcSum: 0, dcCount: 0,
            summonerId: null
        };
    }
    /**
     * Normalize persisted flag data to the current schema by merging a zeroed
     * skeleton with saved values so missing fields are backfilled.
     */
    static _migrate(data) {
        return this._pruneStats(this._sum(this._freshActorData(), data && typeof data === 'object' ? data : {}));
    }
    /**
     * Cap campaign-accumulated maps (primarily spells.byName) so they cannot grow
     * unbounded: keep only the most-used entries when over the limit.
     */
    static _pruneStats(stats) {
        const byName = stats?.spells?.byName;
        if (byName && typeof byName === 'object') {
            const keys = Object.keys(byName);
            if (keys.length > this._MAX_SPELL_KEYS) {
                const weight = k => (byName[k]?.count || 0) + (byName[k]?.damage || 0) / 10;
                keys.sort((a, b) => weight(b) - weight(a));
                for (const k of keys.slice(this._MAX_SPELL_KEYS))
                    delete byName[k];
            }
        }
        return stats;
    }
    /**
     * Resolve a stats key to an Actor document. Keys are UUIDs ("Actor.*" or
     * "Scene.*.Token.*" for unlinked tokens); bare IDs are also accepted for
     * legacy log entries.
     */
    static _resolveStatActor(key) {
        if (!key)
            return null;
        const byId = game.actors?.get(key);
        if (byId)
            return byId;
        try {
            const doc = fromUuidSync(key);
            if (!doc)
                return null;
            if (doc instanceof Actor)
                return doc;
            return doc.actor ?? null;
        }
        catch (e) {
            return null;
        }
    }
    /**
     * Resolve an Actor from a chat message speaker. Prefer resolving via the
     * token first: for unlinked tokens, speaker.actor points to the base actor
     * whose stats must stay separate from the token's synthetic actor.
     */
    static _resolveSpeakerActor(speaker) {
        if (speaker?.token && speaker?.scene) {
            const viaToken = this._resolveStatActor(`Scene.${speaker.scene}.Token.${speaker.token}`);
            if (viaToken)
                return viaToken;
        }
        return speaker?.actor ? this._resolveStatActor(speaker.actor) : null;
    }
    static _ensureActorData(actor) {
        const key = actor?.uuid;
        if (!key)
            return null;
        let entry = this._repository.getPendingActorData(key);
        if (!entry) {
            const flag = foundry.utils.deepClone(actor.getFlag('showstopper', 'statTracker')) || {};
            if (!flag.session || typeof flag.session !== 'object') {
                flag.session = this._freshActorData();
                flag.lifetime = this._freshActorData();
            }
            else {
                flag.session = this._migrate(flag.session);
                flag.lifetime = (flag.lifetime && typeof flag.lifetime === 'object') ? this._migrate(flag.lifetime) : this._freshActorData();
            }
            entry = { actor, session: flag.session, lifetime: flag.lifetime };
            this._repository.queueActorData(actor, flag.session, flag.lifetime);
        }
        this._scheduleFlagFlush();
        return entry;
    }
    static _getActorData(charId) {
        const pending = this._repository.getPendingActorData(charId);
        if (pending)
            return pending;
        const actor = this._resolveStatActor(charId);
        if (!actor)
            return null;
        if (actor.uuid && actor.uuid !== charId) {
            const byActorUuid = this._repository.getPendingActorData(actor.uuid);
            if (byActorUuid)
                return byActorUuid;
        }
        const flag = actor.getFlag('showstopper', 'statTracker');
        if (!flag?.session)
            return null;
        return { actor, session: flag.session, lifetime: flag.lifetime || this._freshActorData() };
    }
    static _getD20(rolls) {
        const out = { result: 0, hasNat20: false, hasNat1: false, advantage: false, disadvantage: false };
        if (!rolls?.length)
            return out;
        const roll = rolls[0];
        const actives = [];
        for (const d of roll?.dice || []) {
            if (d.faces !== 20)
                continue;
            for (const r of d.results || []) {
                if (r.active !== false && !r.dropped && !r.discarded && !r.rerolled)
                    actives.push(r.result);
            }
        }
        out.result = actives.length ? Math.max(...actives) : (roll?.total ?? 0);
        out.hasNat20 = actives.includes(20);
        out.hasNat1 = actives.includes(1);
        out.advantage = roll?.hasAdvantage ?? false;
        out.disadvantage = roll?.hasDisadvantage ?? false;
        return out;
    }
    /**
     * Shared d20 roll counters: stats.nat20/nat1/advantageCount/disadvantageCount
     * aggregate ALL d20 roll categories (used by chat export). Category-specific
     * slices (e.g. attacks.nat20) are incremented alongside them.
     */
    static _applyD20Meta(stats, data) {
        if (data.nat20)
            stats.nat20 = (stats.nat20 || 0) + 1;
        if (data.nat1)
            stats.nat1 = (stats.nat1 || 0) + 1;
        if (data.advantage)
            stats.advantageCount = (stats.advantageCount || 0) + 1;
        if (data.disadvantage)
            stats.disadvantageCount = (stats.disadvantageCount || 0) + 1;
    }
    static _apply(stats, cat, data) {
        if (cat === 'attack') {
            stats.attacks.total++;
            if (data.crit)
                stats.attacks.crits++;
            if (data.fumble)
                stats.attacks.fumbles++;
            this._applyD20Meta(stats, data);
            if (data.nat20)
                stats.attacks.nat20 = (stats.attacks.nat20 || 0) + 1;
            if (data.nat1)
                stats.attacks.nat1 = (stats.attacks.nat1 || 0) + 1;
            if (data.advantage)
                stats.attacks.adv = (stats.attacks.adv || 0) + 1;
            if (data.disadvantage)
                stats.attacks.dis = (stats.attacks.dis || 0) + 1;
            this._log({ ...data, cat: 'attack', entry: stats });
        }
        else if (cat === 'spellCast') {
            stats.spells.total++;
            if (!stats.spells.byName[data.name])
                stats.spells.byName[data.name] = { count: 0, damage: 0 };
            stats.spells.byName[data.name].count++;
            const lvl = String(data.spellLevel || 0);
            if (!stats.spells.byLevel[lvl])
                stats.spells.byLevel[lvl] = 0;
            stats.spells.byLevel[lvl]++;
        }
        else if (cat === 'damage') {
            if (data.summonerId)
                stats.summonerId = data.summonerId;
            if (data.taken) {
                stats.damage.taken = (stats.damage.taken || 0) + data.amount;
                if (data.down)
                    stats.damage.downs = (stats.damage.downs || 0) + 1;
            }
            else {
                stats.damage.dealt = (stats.damage.dealt || 0) + data.amount;
                if (data.summonAmount > 0) {
                    stats.damage.summonDealt = (stats.damage.summonDealt || 0) + data.summonAmount;
                }
                if (data.kills)
                    stats.kills = (stats.kills || 0) + data.kills;
                if (data.source && data.isSpell) {
                    stats.spells.byName[data.source] ??= { count: 0, damage: 0 };
                    stats.spells.byName[data.source].damage = (stats.spells.byName[data.source].damage || 0) + data.amount;
                    const lvl = String(data.spellLevel || 0);
                    stats.spells.byLevel[lvl] ??= 0;
                }
                if (data.damageTypes) {
                    for (const [type, amt] of Object.entries(data.damageTypes)) {
                        stats.damage.byType[type] = Math.round(((stats.damage.byType[type] || 0) + Number(amt)) * 10) / 10;
                    }
                }
            }
        }
        else if (cat === 'healing') {
            if (data.summonerId)
                stats.summonerId = data.summonerId;
            // total tracks actual HP restored (received). given tracks healer
            // attribution separately so self-heals do not double-count total.
            if (data.received) {
                stats.healing.received = (stats.healing.received || 0) + data.amount;
                stats.healing.total = (stats.healing.total || 0) + data.amount;
            }
            if (data.given)
                stats.healing.given = (stats.healing.given || 0) + data.amount;
            if (data.summonAmount > 0) {
                stats.healing.summonGiven = (stats.healing.summonGiven || 0) + data.summonAmount;
            }
        }
        else if (cat === 'undoDamage') {
            if (data.taken) {
                stats.damage.taken = Math.max(0, (stats.damage.taken || 0) - data.amount);
                if (data.down)
                    stats.damage.downs = Math.max(0, (stats.damage.downs || 0) - 1);
            }
            else {
                stats.damage.dealt = Math.max(0, (stats.damage.dealt || 0) - data.amount);
                if (data.summonAmount > 0) {
                    stats.damage.summonDealt = Math.max(0, (stats.damage.summonDealt || 0) - data.summonAmount);
                }
                if (data.kills)
                    stats.kills = Math.max(0, (stats.kills || 0) - data.kills);
                if (data.source && data.isSpell && stats.spells?.byName?.[data.source]) {
                    stats.spells.byName[data.source].damage = Math.max(0, (stats.spells.byName[data.source].damage || 0) - data.amount);
                }
                if (data.damageTypes && stats.damage?.byType) {
                    for (const [type, amt] of Object.entries(data.damageTypes)) {
                        const next = Math.round(Math.max(0, (stats.damage.byType[type] || 0) - Number(amt)) * 10) / 10;
                        if (next > 0)
                            stats.damage.byType[type] = next;
                        else
                            delete stats.damage.byType[type];
                    }
                }
            }
        }
        else if (cat === 'undoHealing') {
            if (data.received) {
                stats.healing.received = Math.max(0, (stats.healing.received || 0) - data.amount);
                stats.healing.total = Math.max(0, (stats.healing.total || 0) - data.amount);
            }
            if (data.given)
                stats.healing.given = Math.max(0, (stats.healing.given || 0) - data.amount);
            if (data.summonAmount > 0) {
                stats.healing.summonGiven = Math.max(0, (stats.healing.summonGiven || 0) - data.summonAmount);
            }
        }
        else if (cat === 'concentration') {
            stats.concentration.total++;
            if (data.success)
                stats.concentration.successes++;
            else
                stats.concentration.failures++;
            this._applyD20Meta(stats, data);
            this._log({ ...data, cat: 'concentration', entry: stats });
        }
        else if (cat === 'save') {
            stats.saveSummary.total++;
            if (data.success === true)
                stats.saveSummary.successes++;
            else if (data.success === false)
                stats.saveSummary.failures++;
            const abl = data.ability || 'unknown';
            if (!stats.checks)
                stats.checks = {};
            if (!stats.checks.save)
                stats.checks.save = {};
            if (!stats.checks.save[abl])
                stats.checks.save[abl] = { total: 0, successes: 0, best: 0 };
            stats.checks.save[abl].total++;
            if (data.success === true)
                stats.checks.save[abl].successes++;
            if ((data.total || 0) > stats.checks.save[abl].best)
                stats.checks.save[abl].best = data.total || 0;
            this._applyD20Meta(stats, data);
            if (data.dc) {
                stats.dcSum = (stats.dcSum || 0) + data.dc;
                stats.dcCount = (stats.dcCount || 0) + 1;
            }
            this._log({ ...data, cat: 'save', entry: stats });
        }
        else if (cat === 'abilityCheck') {
            if (!stats.checks)
                stats.checks = {};
            if (!stats.checks.abilityCheck)
                stats.checks.abilityCheck = { total: 0, best: 0 };
            stats.checks.abilityCheck.total++;
            if ((data.total || 0) > stats.checks.abilityCheck.best)
                stats.checks.abilityCheck.best = data.total || 0;
            this._applyD20Meta(stats, data);
            this._log({ ...data, cat: 'abilityCheck', entry: stats });
        }
        else if (cat === 'skill') {
            const sk = data.skill || 'unknown';
            if (!stats.checks)
                stats.checks = {};
            if (!stats.checks.skill)
                stats.checks.skill = {};
            if (!stats.checks.skill[sk])
                stats.checks.skill[sk] = { total: 0, best: 0 };
            stats.checks.skill[sk].total++;
            if ((data.total || 0) > stats.checks.skill[sk].best)
                stats.checks.skill[sk].best = data.total || 0;
            this._applyD20Meta(stats, data);
            this._log({ ...data, cat: 'skill', entry: stats });
        }
        else if (cat === 'tool') {
            const tl = data.tool || 'unknown';
            if (!stats.checks)
                stats.checks = {};
            if (!stats.checks.tool)
                stats.checks.tool = {};
            if (!stats.checks.tool[tl])
                stats.checks.tool[tl] = { total: 0, best: 0 };
            stats.checks.tool[tl].total++;
            if ((data.total || 0) > stats.checks.tool[tl].best)
                stats.checks.tool[tl].best = data.total || 0;
            this._applyD20Meta(stats, data);
            this._log({ ...data, cat: 'tool', entry: stats });
        }
        else if (cat === 'deathSave') {
            stats.deathSaves.total++;
            if (data.success)
                stats.deathSaves.successes++;
            else
                stats.deathSaves.failures++;
            if (data.nat20) {
                stats.deathSaves.critSuccess = (stats.deathSaves.critSuccess || 0) + 1;
            }
            if (data.nat1) {
                stats.deathSaves.critFail = (stats.deathSaves.critFail || 0) + 1;
            }
            this._applyD20Meta(stats, data);
            this._log({ ...data, cat: 'deathSave', entry: stats });
        }
    }
    static _log(entry) {
        this._rollLog.push({
            time: Date.now(),
            actorId: entry._actorId,
            cat: entry.cat,
            name: entry.weaponName || entry.ability || entry.skill || entry.tool || entry.name || '',
            result: entry.dieResult ?? entry.result ?? 0,
            total: Number.isFinite(entry.total) ? entry.total : null,
            nat20: !!entry.nat20,
            nat1: !!entry.nat1,
            crit: !!entry.crit,
            fumble: !!entry.fumble,
            success: entry.success,
            isSpell: !!entry.isSpell
        });
        if (this._rollLog.length > MAX_LOG) {
            this._rollLog.splice(0, this._rollLog.length - MAX_LOG);
        }
        this._saveLog();
    }
    /**
     * Unlinked tokens are also tracked: the GM aggregates them and stores their
     * data on token.actorData. Non-GM clients never reach this method — they
     * forward events over the socket instead.
     */
    static _shouldTrack(actor) {
        if (!actor?.id)
            return false;
        if (actor.hasPlayerOwner)
            return true;
        if (game.user.isGM)
            return true;
        return false;
    }
    /**
     * The GM is the sole aggregator and writer of flags and roll logs; non-GM
     * clients only forward events. When multiple GMs are online, only the
     * designated activeGM aggregates locally — secondary GMs forward too so two
     * writers never double-count events or clobber each other's flags.
     */
    static _isAggregator() {
        if (!game.user?.isGM)
            return false;
        const activeGM = game.users?.activeGM;
        return !activeGM || activeGM.id === game.user.id;
    }
    static _track(actorRef, category, data) {
        if (!game.settings.get(MODULE_ID, 'statsEnabled'))
            return;
        const actor = actorRef?.actor || actorRef;
        if (!actor?.uuid)
            return;
        if (this._isAggregator()) {
            if (this._shouldTrack(actor))
                this._trackLocal(actor, category, data);
            return;
        }
        this._emitTrack(actor.uuid, category, data);
    }
    static _hasActiveGM() {
        return [...(game.users ?? [])].some(u => u.isGM && u.active);
    }
    static _emitTrack(actorId, category, data) {
        // Sockets deliver only to currently connected clients: while no GM is
        // online, buffer events locally and flush them once a GM connects.
        if (!this._hasActiveGM()) {
            this._emitQueue.push({ actorId, cat: category, data });
            if (this._emitQueue.length > this._EMIT_QUEUE_MAX) {
                this._emitQueue.splice(0, this._emitQueue.length - this._EMIT_QUEUE_MAX);
            }
            return;
        }
        try {
            const payload = { ...data };
            delete payload._actorId;
            emitRaw(SOCKET_NS_TRACK, { actorId, cat: category, data: payload });
        }
        catch (e) {
            console.error(`${MODULE_ID} | Socket emit failed:`, e);
        }
    }
    static _flushEmitQueue() {
        if (!this._emitQueue.length || !this._hasActiveGM())
            return;
        const events = this._emitQueue.splice(0, this._emitQueue.length);
        for (const { actorId, cat, data } of events) {
            try {
                emitRaw(SOCKET_NS_TRACK, { actorId, cat, data });
            }
            catch (e) {
                console.error(`${MODULE_ID} | Socket emit failed:`, e);
            }
        }
    }
    static _trackLocal(actor, category, data) {
        const entry = this._ensureActorData(actor);
        if (!entry)
            return;
        const data2 = { ...data, _actorId: actor.uuid };
        this._apply(entry.session, category, data2);
        if ((category === 'attack' || category === 'damage' || category === 'undoDamage') && (data.weaponItemUuid || data.weaponBaseItem)) {
            let weaponItem = null;
            if (data.weaponItemUuid) {
                try {
                    weaponItem = fromUuidSync(data.weaponItemUuid);
                }
                catch {
                    weaponItem = null;
                }
            }
            const weaponPayload = {
                cat: category,
                crit: data.crit,
                fumble: data.fumble,
                count: data.count ?? 1,
                amount: data.amount ?? 0
            };
            if (weaponItem)
                this._updateWeaponFlag(weaponItem, weaponPayload);
            if (data.weaponBaseItem)
                this._updateActorWeaponType(actor, data.weaponBaseItem, weaponPayload);
        }
        // Data mutated — invalidate StatsApp's aggregation cache
        this._bumpDataRev();
        // Mutated by reference — bump the pending entry revision so an in-flight
        // network flush does not delete it before the new state is persisted.
        this._repository.touchActorData(actor.uuid);
        this._scheduleFlagFlush();
        this._scheduleSave();
    }
    /**
     * Apply a tracking event received over the socket from a non-GM client.
     * The GM is the sole authoritative aggregator writing flags and roll logs,
     * ensuring NPC damage and player rolls are recorded. When multiple GMs are
     * online, only the designated activeGM applies events to prevent duplicates.
     */
    static _onSocketTrack({ actorId, cat, data } = {}) {
        if (!game.user?.isGM || typeof actorId !== 'string' || !this._TRACK_CATS.has(cat))
            return;
        const activeGM = game.users?.activeGM;
        if (activeGM && activeGM.id !== game.user.id)
            return;
        const actor = this._resolveStatActor(actorId);
        if (!actor)
            return;
        try {
            this._track(actor, cat, this._sanitizeTrackData(data));
        }
        catch (e) {
            console.error(`${MODULE_ID} | Socket track handler failed:`, e);
        }
    }
    /**
     * Socket payloads arrive from arbitrary clients and are validated nowhere
     * else: without numeric coercion, a string `amount` turns numeric accumulators
     * into string concatenation and permanently corrupts stored stats.
     */
    static _sanitizeTrackData(data) {
        if (!data || typeof data !== 'object')
            return {};
        const d = { ...data };
        const num = (v, min, max) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
        };
        for (const k of ['amount', 'summonAmount', 'count', 'kills', 'dc', 'dieResult']) {
            if (d[k] !== undefined)
                d[k] = num(d[k], 0, 1e9);
        }
        if (d.spellLevel !== undefined)
            d.spellLevel = num(d.spellLevel, 0, 12);
        // total can legitimately be negative due to roll modifiers.
        if (d.total !== undefined)
            d.total = num(d.total, -1e9, 1e9);
        for (const k of ['crit', 'fumble', 'nat20', 'nat1', 'advantage', 'disadvantage', 'taken', 'down', 'received', 'given', 'isSpell']) {
            if (d[k] !== undefined)
                d[k] = d[k] === true;
        }
        // success is tri-state (true / false / undefined when no DC is set).
        if (d.success !== undefined && typeof d.success !== 'boolean')
            d.success = undefined;
        for (const k of ['name', 'source', 'sourceType', 'weaponName', 'ability', 'skill', 'tool', 'weaponBaseItem']) {
            if (d[k] !== undefined && typeof d[k] !== 'string')
                d[k] = String(d[k] ?? '');
            if (typeof d[k] === 'string' && d[k].length > 100)
                d[k] = d[k].slice(0, 100);
        }
        for (const k of ['summonerId', 'weaponItemUuid']) {
            if (d[k] !== undefined && typeof d[k] !== 'string')
                d[k] = String(d[k] ?? '');
            if (typeof d[k] === 'string' && d[k].length > 200)
                d[k] = d[k].slice(0, 200);
        }
        if (d.damageTypes && typeof d.damageTypes === 'object') {
            const dt = {};
            for (const [type, v] of Object.entries(d.damageTypes)) {
                const n = num(v, 0, 1e9);
                if (n > 0 && typeof type === 'string' && type.length <= 32)
                    dt[type] = n;
            }
            d.damageTypes = dt;
        }
        return d;
    }
    static _updateWeaponFlag(item, data) {
        if (!item)
            return;
        const key = item.uuid;
        let entry = this._repository.getPendingItem(key);
        if (!entry) {
            const saved = foundry.utils.deepClone(item.getFlag('showstopper', 'statTracker.usage'));
            entry = { item, usage: saved || { total: 0, crits: 0, fumbles: 0, damage: 0 } };
            this._repository.queueItemUsage(item, entry.usage);
        }
        if (data.cat === 'attack') {
            entry.usage.total = (entry.usage.total || 0) + (data.count ?? 1);
            if (data.crit)
                entry.usage.crits = (entry.usage.crits || 0) + 1;
            if (data.fumble)
                entry.usage.fumbles = (entry.usage.fumbles || 0) + 1;
        }
        else if (data.cat === 'damage') {
            entry.usage.damage = (entry.usage.damage || 0) + data.amount;
        }
        else if (data.cat === 'undoDamage') {
            entry.usage.damage = Math.max(0, (entry.usage.damage || 0) - data.amount);
        }
        this._repository.touchItem(item.uuid);
        this._scheduleFlagFlush();
    }
    static _updateActorWeaponType(actor, baseItem, data) {
        if (!actor || !baseItem)
            return;
        const key = `${actor.uuid}:${baseItem}`;
        let entry = this._repository.getPendingWeapon(key);
        if (!entry) {
            entry = { actor, baseItem, usage: { total: 0, crits: 0, fumbles: 0, damage: 0 } };
            this._repository.queueActorWeapon(actor, baseItem, entry.usage);
        }
        if (data.cat === 'attack') {
            entry.usage.total += (data.count ?? 1);
            if (data.crit)
                entry.usage.crits++;
            if (data.fumble)
                entry.usage.fumbles++;
        }
        else if (data.cat === 'damage') {
            entry.usage.damage = (entry.usage.damage || 0) + data.amount;
        }
        else if (data.cat === 'undoDamage') {
            entry.usage.damage = (entry.usage.damage || 0) - data.amount;
        }
        this._repository.touchWeapon(key);
        this._scheduleFlagFlush();
    }
    static _getWeaponEntries(actor) {
        if (!actor)
            return [];
        const weaponEntries = [];
        for (const item of actor.items ?? []) {
            if (item.type !== 'weapon')
                continue;
            const pending = this._repository.getPendingItem(item.uuid);
            const usage = pending?.usage ?? item.getFlag(MODULE_ID, 'statTracker.usage');
            if (!usage || (!usage.total && !usage.damage))
                continue;
            weaponEntries.push({ name: item.name, ...usage });
        }
        const actorWeapons = foundry.utils.deepClone(actor.getFlag(MODULE_ID, 'statTracker.weapons')) || {};
        for (const { baseItem, usage } of this._repository.pendingWeaponsForActor(actor.uuid)) {
            const cur = actorWeapons[baseItem] ?? (actorWeapons[baseItem] = { total: 0, crits: 0, fumbles: 0, damage: 0 });
            cur.total = Math.max(0, (cur.total || 0) + (usage.total || 0));
            cur.crits = Math.max(0, (cur.crits || 0) + (usage.crits || 0));
            cur.fumbles = Math.max(0, (cur.fumbles || 0) + (usage.fumbles || 0));
            cur.damage = Math.max(0, (cur.damage || 0) + (usage.damage || 0));
        }
        for (const [base, v] of Object.entries(actorWeapons)) {
            if (!v?.total && !v?.damage)
                continue;
            const hasItem = (actor.items ?? []).some(it => it.type === 'weapon' && it.system?.type?.baseItem === base);
            if (!hasItem) {
                let baseName = null;
                try {
                    baseName = CONFIG?.DND5E?.weaponIds?.[base] ? fromUuidSync(CONFIG.DND5E.weaponIds[base])?.name : null;
                }
                catch {
                    baseName = null;
                }
                weaponEntries.push({ name: baseName ? `[${baseName}]` : `[${base.charAt(0).toUpperCase() + base.slice(1)}]`, ...v });
            }
        }
        return weaponEntries;
    }
    static _scheduleFlagFlush() {
        this._repository.scheduleFlush();
    }
    static async _flushFlags() {
        await this._repository.flushAll();
    }
    // ── summons resolution ──────────────────────────
    static _extractActorUuidFromOrigin(originUuid) {
        if (!originUuid || typeof originUuid !== 'string')
            return null;
        const m = originUuid.match(/^(Scene\.[^.]+\.Token\.[^.]+(?:\.Actor\.[^.]+)?|Actor\.[^.]+)/);
        return m ? m[1] : null;
    }
    static _resolveDocAndActorFromOrigin(originUuid) {
        if (!originUuid || typeof originUuid !== 'string')
            return { doc: null, actor: null, item: null };
        let doc = null;
        try {
            doc = fromUuidSync(originUuid);
        }
        catch {
            doc = null;
        }
        if (doc) {
            if (doc instanceof Actor)
                return { doc, actor: doc, item: null };
            const actor = doc.actor ?? (doc.parent instanceof Actor ? doc.parent : null);
            const item = doc.item ?? (doc.documentName === 'Item' || doc?.type === 'spell' ? doc : null);
            if (actor)
                return { doc, actor, item };
        }
        // PseudoDocument Activity UUIDs (`...Actor.<id>.Item.<itemId>.Activity.<actId>`) may not
        // resolve directly in all contexts — strip trailing `.Activity.*` to resolve the Item.
        const itemMatch = originUuid.match(/^((?:Scene\.[^.]+\.Token\.[^.]+(?:\.Actor\.[^.]+)?|Actor\.[^.]+)\.Item\.[^.]+)/);
        if (itemMatch) {
            let itemDoc = null;
            try {
                itemDoc = fromUuidSync(itemMatch[1]);
            }
            catch {
                itemDoc = null;
            }
            if (itemDoc) {
                const actor = itemDoc.actor ?? (itemDoc.parent instanceof Actor ? itemDoc.parent : null);
                if (actor)
                    return { doc: itemDoc, actor, item: itemDoc };
            }
        }
        const actorUuid = this._extractActorUuidFromOrigin(originUuid);
        const actor = actorUuid ? this._resolveStatActor(actorUuid) : null;
        return { doc, actor, item: null };
    }
    /**
     * Resolve a summoned creature's summoner Actor and originating summon spell/item.
     * Supports native dnd5e SummonActivity (`flags.dnd5e.summon`), CAT (`flags.cat.summon`),
     * Chris's Premades (`flags['chris-premades']`), Foundry Summons, Automated Evocations,
     * and Warpgate on both Actor and TokenDocument flags. Walks summon chains up to depth 5.
     */
    static _getSummonInfo(actor) {
        const resolved = actor?.actor || actor;
        if (!resolved?.uuid)
            return null;
        const getFlagScope = (a, scope) => a?.flags?.[scope]
            ?? a?.token?.flags?.[scope]
            ?? a?.token?.actorData?.flags?.[scope]
            ?? null;
        const stepParent = (cur) => {
            // 1. Native dnd5e SummonActivity: flags.dnd5e.summon.{origin, level}
            const dndSummon = getFlagScope(cur, 'dnd5e')?.summon;
            if (dndSummon && typeof dndSummon === 'object' && dndSummon.origin) {
                const { actor: parentActor, item } = this._resolveDocAndActorFromOrigin(dndSummon.origin);
                if (parentActor) {
                    return {
                        summoner: parentActor,
                        item,
                        level: dndSummon.level ?? (item?.type === 'spell' ? (item.system?.level ?? 0) : 0)
                    };
                }
            }
            // 2. Coven's Automation Toolkit (CAT): flags.cat.summon.{owner, parent, sourceDocument}
            const catSummon = getFlagScope(cur, 'cat')?.summon;
            if (catSummon && typeof catSummon === 'object') {
                const ownerRef = catSummon.owner || catSummon.parent;
                const srcInfo = catSummon.sourceDocument
                    ? this._resolveDocAndActorFromOrigin(catSummon.sourceDocument)
                    : { actor: null, item: null };
                const parentActor = (ownerRef ? this._resolveStatActor(ownerRef) : null) ?? srcInfo.actor;
                if (parentActor) {
                    const item = srcInfo.item;
                    return {
                        summoner: parentActor,
                        item,
                        level: item?.type === 'spell' ? (item.system?.level ?? 0) : 0
                    };
                }
            }
            // 3. Chris's Premades (CPR)
            const cpr = getFlagScope(cur, 'chris-premades');
            const cprUuid = cpr?.summonerUuid ?? cpr?.summons?.summonerUuid;
            if (cprUuid) {
                const parentActor = this._resolveStatActor(cprUuid);
                if (parentActor)
                    return { summoner: parentActor, item: null, level: 0 };
            }
            // 4. Foundry Summons / Automated Evocations / Warpgate
            const fsRef = getFlagScope(cur, 'foundry-summons')?.summoner;
            const fsUuid = typeof fsRef === 'string' ? fsRef : (fsRef?.uuid ?? fsRef?.actorId ?? null);
            if (fsUuid) {
                const parentActor = this._resolveStatActor(fsUuid);
                if (parentActor)
                    return { summoner: parentActor, item: null, level: 0 };
            }
            const aeRef = getFlagScope(cur, 'automated-evocations')?.summoner;
            const aeUuid = typeof aeRef === 'string' ? aeRef : (aeRef?.uuid ?? aeRef?.actorId ?? null);
            if (aeUuid) {
                const parentActor = this._resolveStatActor(aeUuid);
                if (parentActor)
                    return { summoner: parentActor, item: null, level: 0 };
            }
            const wgRef = getFlagScope(cur, 'warpgate')?.control?.actor;
            if (wgRef) {
                const parentActor = this._resolveStatActor(wgRef);
                if (parentActor)
                    return { summoner: parentActor, item: null, level: 0 };
            }
            return null;
        };
        const visited = new Set([resolved.uuid]);
        let current = resolved;
        let rootSummoner = null;
        let summonItem = null;
        let spellLevel = 0;
        for (let depth = 0; depth < 5; depth++) {
            const next = stepParent(current);
            if (!next?.summoner?.uuid || visited.has(next.summoner.uuid))
                break;
            visited.add(next.summoner.uuid);
            rootSummoner = next.summoner;
            if (next.item) {
                summonItem = next.item;
                spellLevel = next.level ?? (next.item.type === 'spell' ? (next.item.system?.level ?? 0) : 0);
            }
            else if (!summonItem && next.level) {
                spellLevel = next.level;
            }
            current = next.summoner;
        }
        if (!rootSummoner || rootSummoner.uuid === resolved.uuid)
            return null;
        const isSpell = summonItem?.type === 'spell';
        return {
            summoner: rootSummoner,
            summonItem,
            spellName: isSpell ? (summonItem.name || null) : null,
            isSpell,
            spellLevel: isSpell ? (spellLevel || summonItem.system?.level || 0) : 0
        };
    }
    static _isSummonActor(actorOrId) {
        const actor = (actorOrId && typeof actorOrId === 'object') ? actorOrId : this._resolveStatActor(actorOrId);
        if (!actor)
            return false;
        return Boolean(this._getSummonInfo(actor));
    }
    // ── dnd5e 5.x/6.x roll hooks ────────────────────
    /**
     * Rolls already recorded via dnd5e V2 hooks (activity path).
     * The message path (preCreateChatMessage) skips them within a short TTL window
     * to prevent double-counting without blocking identical roll results later in the session.
     */
    static _trackedRollSig = new Map();
    static _TRACKED_SIG_LIMIT = 5000;
    static _TRACKED_SIG_TTL = 10000;
    static _rollSig(roll, actorId = '', itemUuid = '', extra = '') {
        const results = roll?.results || roll?.dice?.flatMap(d => d.results || []) || [];
        return `${actorId}|${itemUuid}|${roll?.formula}|${roll?.total}|${results.map(r => r.result).join(',')}|${extra}`;
    }
    static _rememberRollSig(sig) {
        this._trackedRollSig.set(sig, Date.now());
        const limit = this._TRACKED_SIG_LIMIT;
        if (this._trackedRollSig.size > limit) {
            let toDelete = this._trackedRollSig.size - Math.floor(limit / 2);
            for (const key of this._trackedRollSig.keys()) {
                if (toDelete-- <= 0)
                    break;
                this._trackedRollSig.delete(key);
            }
        }
    }
    static _hasRecentRollSig(sig) {
        const ts = this._trackedRollSig.get(sig);
        if (!ts)
            return false;
        if ((Date.now() - ts) > this._TRACKED_SIG_TTL) {
            this._trackedRollSig.delete(sig);
            return false;
        }
        return true;
    }
    static _markRolls(rolls, actorId = '', itemUuid = '') {
        for (const roll of rolls) {
            this._rememberRollSig(this._rollSig(roll, actorId, itemUuid));
        }
    }
    static _isRollsTracked(rolls, actorId = '', itemUuid = '') {
        return rolls.length > 0 && rolls.every(r => this._hasRecentRollSig(this._rollSig(r, actorId, itemUuid)));
    }
    static _onAttackRoll(rolls, data) {
        // dnd5e V2 hooks expose an Activity as data.subject.
        // Standalone sheet helper rolls arrive with subject: null and are picked up by the message path.
        const subject = data?.subject;
        const actor = subject?.actor ?? subject?.item?.actor ?? null;
        if (!actor || !rolls?.length)
            return;
        const item = subject?.item ?? null;
        const isSpell = item?.type === 'spell';
        const spellLevel = isSpell ? (item.system?.level ?? 0) : 0;
        const weaponName = item?.name;
        const isWeapon = item?.type === 'weapon';
        const weaponItemUuid = isWeapon ? item.uuid : undefined;
        const weaponBaseItem = isWeapon ? (item.system?.type?.baseItem || undefined) : undefined;
        const fresh = rolls.filter(r => !this._seenRolls.has(r));
        for (const roll of fresh) {
            this._seenRolls.add(roll);
            const d20Info = this._getD20([roll]);
            this._track(actor, 'attack', {
                crit: !!roll.isCritical, fumble: !!roll.isFumble,
                nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
                advantage: d20Info.advantage, disadvantage: d20Info.disadvantage,
                isSpell, spellLevel, weaponName,
                dieResult: d20Info.result,
                total: roll.total ?? 0,
                weaponItemUuid,
                weaponBaseItem
            });
        }
        // Record plain signatures so the message path skips rolls already counted
        // here (where message.rolls arrives as new Roll instances with the same data).
        if (fresh.length)
            this._markRolls(fresh, actor.uuid, item?.uuid);
    }
    /**
     * Fallback handler for attacks without a subject (sheet buttons and inline roll
     * links where standalone V2 roll hooks fire with subject: null).
     * Supports both dnd5e 6.0 (`message.type === 'attack'`, `getAssociatedItem()`)
     * and legacy `flags.dnd5e.roll.type === 'attack'`.
     */
    static _onPreCreateChatMessage(message, options, userId) {
        if (!game.settings.get(MODULE_ID, 'statsEnabled'))
            return;
        // preCreateChatMessage fires on ALL clients. Only the authoring client records
        // the roll; everyone else receives the aggregated result via the GM.
        const authorId = message?.author?.id ?? userId;
        if (authorId && authorId !== game.user.id)
            return;
        const isAttack = message?.type === 'attack' || message?.flags?.dnd5e?.roll?.type === 'attack';
        if (!isAttack)
            return;
        const rolls = message.rolls || [];
        if (!rolls.length)
            return;
        const actor = this._resolveSpeakerActor(message.speaker) ?? message.getAssociatedActor?.() ?? null;
        if (!actor?.id)
            return;
        let item = null;
        try {
            item = message.getAssociatedItem?.() ?? null;
        }
        catch {
            item = null;
        }
        const itemUuid = item?.uuid ?? message.system?.item?.uuid ?? message.flags?.dnd5e?.item?.uuid;
        if (!item && itemUuid) {
            try {
                item = fromUuidSync(itemUuid);
            }
            catch {
                item = null;
            }
        }
        if (this._isRollsTracked(rolls, actor.uuid, itemUuid))
            return;
        const isWeapon = item?.type === 'weapon';
        const weaponItemUuid = isWeapon ? item.uuid : undefined;
        const weaponBaseItem = isWeapon ? (item.system?.type?.baseItem || undefined) : undefined;
        for (const roll of rolls) {
            if (this._seenRolls.has(roll))
                continue;
            const plainSig = this._rollSig(roll, actor.uuid, itemUuid);
            if (this._hasRecentRollSig(plainSig))
                continue;
            this._seenRolls.add(roll);
            const d20Info = this._getD20([roll]);
            this._track(actor, 'attack', {
                crit: !!roll.isCritical, fumble: !!roll.isFumble,
                nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
                advantage: d20Info.advantage, disadvantage: d20Info.disadvantage,
                isSpell: item?.type === 'spell',
                spellLevel: item?.type === 'spell' ? (message.system?.level ?? item.system?.level ?? 0) : 0,
                weaponName: item?.name,
                dieResult: d20Info.result,
                total: roll.total ?? 0,
                weaponItemUuid,
                weaponBaseItem
            });
        }
    }
    static _isD20Roll(roll) {
        if (!roll)
            return false;
        if (CONFIG?.Dice?.D20Roll && roll instanceof CONFIG.Dice.D20Roll)
            return true;
        if (roll?.constructor?.name === 'D20Roll' || roll?.validD20Roll === true)
            return true;
        if (!roll?.options?.type && !roll?.options?.types?.length && roll?.dice?.length === 1 && roll.dice[0]?.faces === 20) {
            if (roll.options?.criticalSuccess !== undefined || roll.options?.target !== undefined || roll.options?.advantageMode !== undefined) {
                return true;
            }
        }
        return false;
    }
    static _extractDamageTypes(rolls) {
        const types = {};
        const healingTypes = CONFIG?.DND5E?.healingTypes ?? game.dnd5e?.config?.healingTypes ?? { healing: true, temphp: true };
        for (const roll of rolls || []) {
            if (this._isD20Roll(roll))
                continue;
            const rawTypes = roll?.options?.types?.length ? roll.options.types : (roll?.options?.type ? [roll.options.type] : null);
            const amount = roll?.total || 0;
            if (amount <= 0)
                continue;
            if (!rawTypes) {
                types.unknown = (types.unknown || 0) + amount;
                continue;
            }
            const dmgOnly = rawTypes.filter(type => type && !healingTypes[type] && type !== 'midi-none' && type !== 'none');
            if (!dmgOnly.length)
                continue;
            const per = amount / dmgOnly.length;
            for (const type of dmgOnly) {
                if (per > 0)
                    types[type] = (types[type] || 0) + per;
            }
        }
        return types;
    }
    /**
     * Resolve the attacker, item, spell level, and rolled damage types from
     * dnd5e 6.0 ChatMessage models (`system.item`, `getAssociatedItem`, `getOriginatingMessage`)
     * as well as midi-qol options (`options.midi`) and legacy dnd5e flags.
     */
    static _resolveMessageSource(origin, options) {
        let originMsg = origin ?? null;
        if (!originMsg && options?.midi?.itemCardUuid) {
            try {
                originMsg = fromUuidSync(options.midi.itemCardUuid);
            }
            catch {
                originMsg = null;
            }
        }
        if (!originMsg && !options?.midi?.sourceActorUuid && !options?.item)
            return null;
        let usageMsg = null;
        try {
            usageMsg = originMsg?.getOriginatingMessage?.() ?? null;
        }
        catch {
            usageMsg = null;
        }
        if (usageMsg === originMsg)
            usageMsg = null;
        let actor = null;
        if (options?.midi?.sourceActorUuid) {
            actor = this._resolveStatActor(options.midi.sourceActorUuid);
        }
        if (!actor && originMsg) {
            actor = this._resolveSpeakerActor(originMsg.speaker) ?? originMsg.getAssociatedActor?.() ?? null;
        }
        if (!actor && usageMsg) {
            actor = this._resolveSpeakerActor(usageMsg.speaker) ?? usageMsg.getAssociatedActor?.() ?? null;
        }
        let item = options?.item ?? null;
        const tryItem = (msg) => {
            if (!msg)
                return null;
            try {
                const assoc = msg.getAssociatedItem?.();
                if (assoc)
                    return assoc;
            }
            catch { /* ignore */ }
            const uuid = msg.system?.item?.uuid ?? msg.flags?.dnd5e?.item?.uuid;
            if (uuid) {
                try {
                    return fromUuidSync(uuid);
                }
                catch { /* ignore */ }
            }
            return null;
        };
        if (!item)
            item = tryItem(originMsg) ?? tryItem(usageMsg);
        let activity = null;
        try {
            activity = originMsg?.getAssociatedActivity?.() ?? usageMsg?.getAssociatedActivity?.() ?? null;
        }
        catch {
            activity = null;
        }
        const spellLevel = usageMsg?.system?.level
            ?? originMsg?.system?.level
            ?? usageMsg?.flags?.dnd5e?.use?.spellLevel
            ?? originMsg?.flags?.dnd5e?.use?.spellLevel
            ?? originMsg?.flags?.['midi-qol']?.spellLevel
            ?? usageMsg?.flags?.['midi-qol']?.spellLevel
            ?? (item?.type === 'spell' ? (item.system?.level ?? 0) : 0);
        const rolls = [...(originMsg?.rolls || [])];
        const hasDmgInOrigin = rolls.some(r => !this._isD20Roll(r));
        if (!hasDmgInOrigin && typeof originMsg?.getAssociatedRolls === 'function') {
            try {
                rolls.push(...(originMsg.getAssociatedRolls('damage') || []), ...(originMsg.getAssociatedRolls('healing') || []));
            }
            catch { /* ignore */ }
        }
        if (!rolls.length && usageMsg) {
            rolls.push(...(usageMsg.rolls || []));
            if (typeof usageMsg.getAssociatedRolls === 'function') {
                try {
                    rolls.push(...(usageMsg.getAssociatedRolls('damage') || []), ...(usageMsg.getAssociatedRolls('healing') || []));
                }
                catch { /* ignore */ }
            }
        }
        const healingTypes = CONFIG?.DND5E?.healingTypes ?? game.dnd5e?.config?.healingTypes ?? { healing: true, temphp: true };
        const hasHealRoll = rolls.some(r => {
            const rt = r?.options?.types?.length ? r.options.types : (r?.options?.type ? [r.options.type] : []);
            return rt.some(t => Boolean(healingTypes[t]));
        });
        const isHeal = activity?.type === 'heal' || hasHealRoll;
        return {
            actor,
            item,
            activity,
            spellLevel,
            types: this._extractDamageTypes(rolls),
            isHeal,
            originMsg,
            usageMsg
        };
    }
    /** Proportionally scale rolled damage-type breakdown to match the final applied amount. */
    static _scaleDamageTypes(rolledTypes, applied) {
        const entries = Object.entries(rolledTypes || {}).filter(([, v]) => v > 0);
        const rolled = entries.reduce((s, [, v]) => s + v, 0);
        if (!entries.length || rolled <= 0 || !(applied > 0))
            return { unknown: Math.max(0, applied || 0) };
        const k = applied / rolled;
        const out = {};
        for (const [type, v] of entries)
            out[type] = Math.round(v * k * 10) / 10;
        return out;
    }
    /**
     * Detect midi-qol Undo (`#reverse` / `#all-reverse`), which invokes `dnd5e.preApplyDamage`
     * with `amount = newHP - oldHP` and restores `oldHP`/`oldTempHP` from `flags['midi-qol'].undoDamage`.
     */
    static _detectMidiUndo(targetActor, curHP, curTemp, nextHP, nextTemp, options, source) {
        if (!this._midiActive() || !options?.midi)
            return null;
        if (curHP === nextHP && curTemp === nextTemp)
            return null;
        const itemCardUuid = options.midi.itemCardUuid ?? null;
        const candidates = [];
        const seenMsg = new Set();
        const pushMsg = (m) => {
            if (m && !seenMsg.has(m)) {
                seenMsg.add(m);
                candidates.push(m);
            }
        };
        pushMsg(source?.originMsg);
        pushMsg(source?.usageMsg);
        const allMessages = Array.isArray(game.messages?.contents)
            ? game.messages.contents
            : [...(game.messages ?? [])];
        for (let i = allMessages.length - 1; i >= Math.max(0, allMessages.length - 30); i--) {
            pushMsg(allMessages[i]);
        }
        for (const msg of candidates) {
            const rawUndo = msg?.flags?.['midi-qol']?.undoDamage ?? foundry.utils.getProperty(msg, 'flags.midi-qol.undoDamage');
            if (!rawUndo)
                continue;
            const list = Array.isArray(rawUndo) ? rawUndo : (typeof rawUndo === 'object' ? Object.values(rawUndo) : []);
            for (const entry of list) {
                if (!entry?.actorUuid)
                    continue;
                const matchesActor = entry.actorUuid === targetActor.uuid
                    || this._resolveStatActor(entry.actorUuid) === targetActor;
                if (!matchesActor)
                    continue;
                const entryCardUuid = entry.calcDamageOptions?.midi?.itemCardUuid ?? msg?.flags?.['midi-qol']?.itemCardUuid ?? null;
                if (itemCardUuid && entryCardUuid && itemCardUuid !== entryCardUuid)
                    continue;
                const oldHP = Number(entry.oldHP ?? 0);
                const newHP = Number(entry.newHP ?? 0);
                const oldTemp = Number(entry.oldTempHP ?? 0);
                const newTemp = Number(entry.newTempHP ?? 0);
                if (curHP === newHP && nextHP === oldHP && curTemp === newTemp && nextTemp === oldTemp) {
                    return { oldHP, newHP, oldTemp, newTemp };
                }
            }
        }
        return null;
    }
    /**
     * Unified damage & healing tracker via `dnd5e.preApplyDamage` (works for both
     * core dnd5e 6.0 and all 5 midi-qol application paths, including manual apply and undo).
     * Records strictly effective HP + TempHP lost for damage (preventing overkill on corpses
     * and missed attacks) and strictly actual HP restored for healing (preventing overheal
     * and pure tempHP inflation), while attributing summon damage/kills to the summoner.
     */
    static _onPreApplyDamage(targetActor, amount, updates, options) {
        if (!targetActor?.uuid)
            return;
        const hp = targetActor.system?.attributes?.hp;
        const curHP = Number(hp?.value ?? 0);
        const curTemp = Number(hp?.temp ?? 0);
        const hasFlatHP = updates && Object.prototype.hasOwnProperty.call(updates, 'system.attributes.hp.value');
        const hasFlatTemp = updates && Object.prototype.hasOwnProperty.call(updates, 'system.attributes.hp.temp');
        const nestedHP = updates ? foundry.utils.getProperty(updates, 'system.attributes.hp.value') : undefined;
        const nestedTemp = updates ? foundry.utils.getProperty(updates, 'system.attributes.hp.temp') : undefined;
        let nextHP;
        let nextTemp;
        if (hasFlatHP || nestedHP !== undefined || hasFlatTemp || nestedTemp !== undefined) {
            nextHP = Number(hasFlatHP ? updates['system.attributes.hp.value'] : (nestedHP ?? curHP));
            nextTemp = Number(hasFlatTemp ? updates['system.attributes.hp.temp'] : (nestedTemp ?? curTemp));
        }
        else if (Number.isFinite(amount) && amount !== 0) {
            if (amount > 0) {
                const dTemp = Math.min(curTemp, amount);
                const dHP = Math.min(curHP, Math.max(0, amount - dTemp));
                nextTemp = curTemp - dTemp;
                nextHP = curHP - dHP;
            }
            else {
                const maxHP = Number(hp?.effectiveMax ?? hp?.max ?? curHP);
                nextTemp = curTemp;
                nextHP = Math.min(maxHP, curHP + Math.abs(amount));
            }
        }
        else {
            return;
        }
        if (!Number.isFinite(nextHP))
            nextHP = curHP;
        if (!Number.isFinite(nextTemp))
            nextTemp = curTemp;
        const source = this._resolveMessageSource(options?.originatingMessage ?? options?.origin ?? null, options);
        const attacker = source?.actor ?? null;
        const item = source?.item ?? null;
        // Handle midi-qol Undo (`#reverse` / `#all-reverse`) so reverting damage/healing
        // rolls back recorded stats instead of logging fake healing or fake damage/downs.
        const undo = this._detectMidiUndo(targetActor, curHP, curTemp, nextHP, nextTemp, options, source);
        if (undo) {
            if (curHP > 0 && nextHP <= 0) {
                this._suppressDownActors.set(targetActor.uuid, Date.now() + 2000);
            }
            const undoneDamage = Math.max(0, undo.oldHP - undo.newHP) + Math.max(0, undo.oldTemp - undo.newTemp);
            const undoneHeal = Math.max(0, undo.newHP - undo.oldHP);
            if (undoneDamage > 0) {
                const wasDown = undo.oldHP > 0 && undo.newHP <= 0;
                this._track(targetActor, 'undoDamage', { amount: undoneDamage, taken: true, down: wasDown });
                if (attacker) {
                    const summonInfo = this._getSummonInfo(attacker);
                    const killed = (wasDown && attacker.uuid !== targetActor.uuid) ? 1 : 0;
                    const scaledTypes = this._scaleDamageTypes(source?.types, undoneDamage);
                    const isWeapon = item?.type === 'weapon';
                    this._track(attacker, 'undoDamage', {
                        amount: undoneDamage,
                        kills: killed,
                        source: item?.name,
                        sourceType: item?.type,
                        isSpell: item?.type === 'spell',
                        spellLevel: item?.type === 'spell' ? (source?.spellLevel ?? item.system?.level ?? 0) : 0,
                        damageTypes: scaledTypes,
                        weaponItemUuid: isWeapon ? item.uuid : undefined,
                        weaponBaseItem: isWeapon ? (item.system?.type?.baseItem || undefined) : undefined
                    });
                    if (summonInfo?.summoner && summonInfo.summoner.uuid !== attacker.uuid) {
                        const summonerKilled = (wasDown && summonInfo.summoner.uuid !== targetActor.uuid) ? 1 : 0;
                        this._track(summonInfo.summoner, 'undoDamage', {
                            amount: undoneDamage,
                            summonAmount: undoneDamage,
                            kills: summonerKilled,
                            source: summonInfo.spellName || undefined,
                            isSpell: Boolean(summonInfo.isSpell && summonInfo.spellName),
                            damageTypes: scaledTypes
                        });
                    }
                }
            }
            else if (undoneHeal > 0) {
                this._track(targetActor, 'undoHealing', { amount: undoneHeal, received: true });
                if (attacker) {
                    const summonInfo = this._getSummonInfo(attacker);
                    this._track(attacker, 'undoHealing', { amount: undoneHeal, given: true });
                    if (summonInfo?.summoner && summonInfo.summoner.uuid !== attacker.uuid) {
                        this._track(summonInfo.summoner, 'undoHealing', { amount: undoneHeal, given: true, summonAmount: undoneHeal });
                    }
                }
            }
            return;
        }
        const hpLost = Math.max(0, curHP - nextHP);
        const tempLost = Math.max(0, curTemp - nextTemp);
        const effectiveDamage = hpLost + tempLost;
        const actualHealed = Math.max(0, nextHP - curHP);
        if (effectiveDamage > 0) {
            this._track(targetActor, 'damage', { amount: effectiveDamage, taken: true });
            if (attacker) {
                const summonInfo = this._getSummonInfo(attacker);
                const killed = (curHP > 0 && nextHP <= 0 && attacker.uuid !== targetActor.uuid) ? 1 : 0;
                const scaledTypes = this._scaleDamageTypes(source?.types, effectiveDamage);
                const isWeapon = item?.type === 'weapon';
                this._track(attacker, 'damage', {
                    amount: effectiveDamage,
                    kills: killed,
                    source: item?.name,
                    sourceType: item?.type,
                    isSpell: item?.type === 'spell',
                    spellLevel: item?.type === 'spell' ? (source?.spellLevel ?? item.system?.level ?? 0) : 0,
                    damageTypes: scaledTypes,
                    summonerId: summonInfo?.summoner?.uuid,
                    weaponItemUuid: isWeapon ? item.uuid : undefined,
                    weaponBaseItem: isWeapon ? (item.system?.type?.baseItem || undefined) : undefined
                });
                if (summonInfo?.summoner && summonInfo.summoner.uuid !== attacker.uuid) {
                    const summonerKilled = (curHP > 0 && nextHP <= 0 && summonInfo.summoner.uuid !== targetActor.uuid) ? 1 : 0;
                    this._track(summonInfo.summoner, 'damage', {
                        amount: effectiveDamage,
                        summonAmount: effectiveDamage,
                        kills: summonerKilled,
                        source: summonInfo.spellName || undefined,
                        sourceType: summonInfo.isSpell ? 'spell' : undefined,
                        isSpell: Boolean(summonInfo.isSpell && summonInfo.spellName),
                        spellLevel: summonInfo.isSpell ? (summonInfo.spellLevel ?? 0) : 0,
                        damageTypes: scaledTypes
                    });
                }
            }
        }
        else if (actualHealed > 0) {
            this._track(targetActor, 'healing', {
                amount: actualHealed,
                received: true
            });
            if (attacker) {
                const hasDamageSource = Boolean(item || Object.keys(source?.types || {}).length);
                const isInvertedDamageCard = Number(options?.multiplier) < 0 && !source?.isHeal && hasDamageSource;
                if (!isInvertedDamageCard) {
                    const summonInfo = this._getSummonInfo(attacker);
                    this._track(attacker, 'healing', {
                        amount: actualHealed,
                        given: true,
                        summonerId: summonInfo?.summoner?.uuid
                    });
                    if (summonInfo?.summoner && summonInfo.summoner.uuid !== attacker.uuid) {
                        this._track(summonInfo.summoner, 'healing', {
                            amount: actualHealed,
                            given: true,
                            summonAmount: actualHealed
                        });
                    }
                }
            }
        }
    }
    static _onAbilityCheck(rolls, data) {
        const actor = data?.subject;
        if (!actor || !rolls?.length)
            return;
        const d20Info = this._getD20(rolls);
        this._track(actor, 'abilityCheck', {
            ability: data?.ability || 'unknown',
            dieResult: d20Info.result,
            total: rolls[0]?.total ?? 0,
            nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
            advantage: d20Info.advantage, disadvantage: d20Info.disadvantage
        });
    }
    /**
     * Actors currently prompting a concentration saving throw (timestamped).
     * Marked in preRoll hooks and consumed in rollSavingThrow; on dnd5e 4.x+,
     * tracking is handled by the dedicated dnd5e.rollConcentrationV2 hook instead.
     */
    static _pendingConcentration = new Map();
    static _hasConcentrationHook() {
        return Number(String(game.system?.version || '0').split('.')[0]) >= 4;
    }
    static _onPreRollSavingThrow(config, dialog, message) {
        const key = config?.subject?.uuid ?? config?.subject?.id;
        if (!key)
            return;
        if (config?.hookNames?.includes('concentration') || config?.isConcentration) {
            this._pendingConcentration.set(key, Date.now());
        }
        else {
            this._pendingConcentration.delete(key);
        }
    }
    static _saveData(rolls, data) {
        const d20Info = this._getD20(rolls);
        const roll = rolls[0];
        const total = roll?.total ?? 0;
        const dc = (roll?.options?.saveDC ?? roll?.options?.target ?? null);
        return {
            ability: data?.ability || 'unknown',
            dieResult: d20Info.result,
            total,
            success: dc != null ? total >= dc : undefined,
            dc,
            nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
            advantage: d20Info.advantage, disadvantage: d20Info.disadvantage
        };
    }
    static _onSavingThrow(rolls, data) {
        const actor = data?.subject;
        if (!actor || !rolls?.length)
            return;
        const concKey = actor.uuid ?? actor.id;
        if (rolls[0]?.options?.isConcentration || data?.isConcentration) {
            this._pendingConcentration.delete(concKey);
            if (this._hasConcentrationHook())
                return;
            this._track(actor, 'concentration', this._saveData(rolls, data));
            return;
        }
        const marked = this._pendingConcentration.get(concKey);
        if (marked) {
            this._pendingConcentration.delete(concKey);
            const isFresh = (Date.now() - marked) < 30000;
            if (!isFresh) {
                if (!data?.ability)
                    return;
                this._track(actor, 'save', this._saveData(rolls, data));
                return;
            }
            if (this._hasConcentrationHook())
                return; // Counted by dnd5e.rollConcentrationV2
            this._track(actor, 'concentration', this._saveData(rolls, data));
            return;
        }
        // Death saving throws carry no ability and are already handled by postRollDeathSave
        if (!data?.ability)
            return;
        this._track(actor, 'save', this._saveData(rolls, data));
    }
    static _onConcentrationRoll(rolls, data) {
        const actor = data?.subject;
        if (!actor || !rolls?.length)
            return;
        this._pendingConcentration.delete(actor.uuid ?? actor.id);
        const d20Info = this._getD20(rolls);
        const roll = rolls[0];
        const total = roll?.total ?? 0;
        const dc = roll?.options?.target ?? 10;
        this._track(actor, 'concentration', {
            ability: data?.ability || actor.system?.attributes?.concentration?.ability || 'unknown',
            dieResult: d20Info.result,
            total,
            success: total >= dc,
            dc,
            nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
            advantage: d20Info.advantage, disadvantage: d20Info.disadvantage
        });
    }
    static _onSkillCheck(rolls, data) {
        const actor = data?.subject;
        if (!actor || !rolls?.length)
            return;
        const d20Info = this._getD20(rolls);
        const key = data?.skill || data?.tool || 'unknown';
        const cat = data?.tool ? 'tool' : 'skill';
        this._track(actor, cat, {
            [cat === 'tool' ? 'tool' : 'skill']: key,
            dieResult: d20Info.result,
            total: rolls[0]?.total ?? 0,
            nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
            advantage: d20Info.advantage, disadvantage: d20Info.disadvantage
        });
    }
    static _onDeathSave(rolls, data) {
        const actor = data?.subject;
        if (!actor || !rolls?.length)
            return;
        const d20Info = this._getD20(rolls);
        const roll = rolls[0];
        const total = roll?.total ?? 0;
        const success = d20Info.hasNat1
            ? false
            : d20Info.hasNat20
                ? true
                : (typeof roll?.isSuccess === 'boolean' ? roll.isSuccess : total >= (roll?.options?.target ?? 10));
        this._track(actor, 'deathSave', {
            dieResult: d20Info.result,
            total,
            success,
            nat20: d20Info.hasNat20, nat1: d20Info.hasNat1,
            advantage: d20Info.advantage, disadvantage: d20Info.disadvantage
        });
    }
    /**
     * Track spell casts via dnd5e 5.x/6.x:
     * dnd5e.postUseActivity(activity, usageConfig, results) when item.type === 'spell' or activity.type === 'cast'.
     */
    static _onPostUseActivity(activity, usageConfig, results) {
        const item = activity?.item;
        const actor = activity?.actor;
        if (!actor?.id || !item?.name)
            return;
        if (item.type !== 'spell' && activity?.type !== 'cast')
            return;
        if (activity?.type === 'cast' && item.type !== 'spell' && activity.cachedSpell?.type === 'spell')
            return;
        const msg = results?.message ?? (Array.isArray(results?.messages) ? results.messages[0] : null);
        const msgId = msg?.id ?? null;
        if (msgId) {
            const dedupKey = `${actor.uuid}:${item.uuid ?? item.name}:${msgId}`;
            if (this._seenSpellUses.has(dedupKey))
                return;
            this._seenSpellUses.add(dedupKey);
            if (this._seenSpellUses.size > 500)
                this._seenSpellUses.clear();
        }
        const spellLevel = msg?.system?.level
            ?? msg?.flags?.dnd5e?.use?.spellLevel
            ?? (item.type === 'spell' ? (item.system?.level ?? 0) : 0);
        this._track(actor, 'spellCast', {
            name: item.name,
            spellLevel
        });
    }
    // ── downs detection ───────────────────────────
    static _onPreUpdateActor(document, changes, options, userId) {
        // preUpdateActor fires on all clients — count only on the client that
        // initiated the update.
        if (userId && userId !== game.user.id)
            return;
        if (document?.uuid) {
            const supUntil = this._suppressDownActors.get(document.uuid);
            if (supUntil) {
                this._suppressDownActors.delete(document.uuid);
                if (Date.now() < supUntil)
                    return;
            }
        }
        const newHp = foundry.utils.getProperty(changes, 'system.attributes.hp.value');
        if (!Number.isFinite(newHp))
            return;
        const oldHp = document.system?.attributes?.hp?.value;
        if (!Number.isFinite(oldHp))
            return;
        if (oldHp > 0 && newHp <= 0) {
            this._track(document, 'damage', { amount: 0, taken: true, down: true });
        }
    }
    // ── hook registration ──────────────────────────
    static _registerHooks() {
        Hooks.on('dnd5e.rollAttackV2', (r, d) => this._onAttackRoll(r, d));
        Hooks.on('preCreateChatMessage', (m, o, u) => this._onPreCreateChatMessage(m, o, u));
        Hooks.on('dnd5e.preApplyDamage', (a, am, u, o) => this._onPreApplyDamage(a, am, u, o));
        Hooks.on('dnd5e.rollAbilityCheck', (r, d) => this._onAbilityCheck(r, d));
        Hooks.on('dnd5e.rollSavingThrow', (r, d) => this._onSavingThrow(r, d));
        Hooks.on('dnd5e.preRollSavingThrowV2', (c, d, m) => this._onPreRollSavingThrow(c, d, m));
        Hooks.on('dnd5e.preRollConcentrationV2', (c, d, m) => this._onPreRollSavingThrow(c, d, m));
        Hooks.on('dnd5e.rollConcentrationV2', (r, d) => this._onConcentrationRoll(r, d));
        Hooks.on('dnd5e.rollSkillV2', (r, d) => this._onSkillCheck(r, d));
        Hooks.on('dnd5e.rollToolCheckV2', (r, d) => this._onSkillCheck(r, d));
        Hooks.on('dnd5e.postRollDeathSave', (r, d) => this._onDeathSave(r, d));
        Hooks.on('dnd5e.postUseActivity', (a, u, res) => this._onPostUseActivity(a, u, res));
        Hooks.on('preUpdateActor', (d, c, o, u) => this._onPreUpdateActor(d, c, o, u));
        Hooks.on('combatEnd', () => {
            this._flushFlags();
        });
        Hooks.on('canvasTearDown', () => {
            this._flushFlags();
        });
        // Periodic date-change check in addition to startup: sessions crossing
        // midnight rotate automatically in the background within the poll interval.
        setInterval(() => {
            if (!this._isAggregator() || !this._store?.currentDate)
                return;
            if (this._store.currentDate !== this._today()) {
                this._rotateSession(this._today()).catch(e => console.error(`${MODULE_ID} | Session rotate failed:`, e));
            }
        }, 5 * 60 * 1000);
        // Drain client-buffered events once a GM comes online
        // (updateUser also fires when a user's active status changes).
        Hooks.on('updateUser', () => this._flushEmitQueue());
        setInterval(() => this._flushEmitQueue(), 30000);
        // Foundry has no global 'close' hook — flush on window close via beforeunload
        // (best effort: in-flight async writes may not all finish before teardown).
        window.addEventListener('beforeunload', () => {
            try {
                this._flushFlags();
            }
            catch (e) { /* ignore */ }
        });
        Hooks.on('chatMessage', (message, text) => {
            const trimmed = text.trim().toLowerCase();
            if (trimmed === '/stats') {
                this.showStats();
                return false;
            }
            if (trimmed === '/stats-reset') {
                if (!game.user?.isGM)
                    return;
                this.resetStats();
                return false;
            }
        });
        Hooks.on('updateActor', (actor, changes) => {
            if (!this._isAggregator() && foundry.utils.hasProperty(changes, 'flags.showstopper.statTracker')) {
                this._bumpDataRev();
            }
        });
        Hooks.on('updateToken', (tokenDoc, changes) => {
            if (!this._isAggregator() && foundry.utils.hasProperty(changes, 'actorData.flags.showstopper.statTracker')) {
                this._bumpDataRev();
            }
        });
        Hooks.on('updateItem', (item, changes) => {
            if (!this._isAggregator() && foundry.utils.hasProperty(changes, 'flags.showstopper.statTracker')) {
                this._bumpDataRev();
            }
        });
        Hooks.on('updateSetting', (setting) => {
            if (this._isAggregator())
                return;
            if (setting?.key === `${MODULE_ID}.${SETTING_KEY}`) {
                this._store = setting.value ?? { currentDate: this._today() };
                this._bumpDataRev();
            }
            else if (setting?.key === `${MODULE_ID}.statsLog`) {
                this._rollLog = Array.isArray(setting.value) ? setting.value : [];
                this._bumpDataRev();
            }
        });
    }
    // ── data aggregation ────────────────────────────
    static _sum(a, b) {
        if (b == null)
            return (a && typeof a === 'object') ? foundry.utils.deepClone(a) : a;
        if (a == null)
            return (b && typeof b === 'object') ? foundry.utils.deepClone(b) : b;
        if (typeof a === 'number' && typeof b === 'object' && !Array.isArray(b))
            return this._sum({ count: a }, b);
        if (typeof a === 'object' && !Array.isArray(a) && typeof b === 'number')
            return this._sum(a, { count: b });
        if (typeof a === 'number' && typeof b === 'number')
            return a + b;
        if (typeof a === 'string' && typeof b === 'string')
            return b || a;
        if (typeof a !== 'object' || typeof b !== 'object')
            return a;
        if (Array.isArray(a) || Array.isArray(b))
            return foundry.utils.deepClone(a);
        const result = {};
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            if (k === 'best') {
                result[k] = Math.max(a[k] || 0, b[k] || 0);
            }
            else {
                result[k] = this._sum(a[k], b[k]);
            }
        }
        return result;
    }
    static _getPeriodData(charId, period) {
        const data = this._getActorData(charId);
        if (!data)
            return null;
        if (period === 'session')
            return data.session;
        if (period === 'all')
            return this._sum(data.lifetime, data.session);
        return null;
    }
    static _getAllCharIds() {
        const ids = new Set(this._repository.pendingActorIds());
        for (const actor of game.actors ?? []) {
            if (actor.getFlag('showstopper', 'statTracker'))
                ids.add(actor.uuid);
        }
        // Unlinked tokens store their flag in token.actorData — inspect it directly
        // without instantiating a synthetic actor, using the canonical synthetic Actor UUID
        // (`Scene.<sId>.Token.<tId>.Actor.<actorId>`) so pending and flushed keys never split.
        for (const scene of game.scenes ?? []) {
            for (const token of scene.tokens ?? []) {
                if (token.actorLink)
                    continue;
                if (token.actorData?.flags?.showstopper?.statTracker) {
                    const tokenUuid = token.uuid || `Scene.${scene.id}.Token.${token.id}`;
                    const synthUuid = token.actor?.uuid || (token.actorId ? `${tokenUuid}.Actor.${token.actorId}` : tokenUuid);
                    if (!ids.has(synthUuid) && !ids.has(tokenUuid)) {
                        ids.add(synthUuid);
                    }
                }
            }
        }
        return [...ids];
    }
    static _getCharName(charId) {
        return this._resolveStatActor(charId)?.name ?? charId;
    }
    static _isCharPC(charId) {
        const actor = this._resolveStatActor(charId);
        if (!actor)
            return false;
        if (actor.type === 'group' || actor.type === 'vehicle')
            return false;
        if (this._isSummonActor(actor))
            return false;
        const stats = this._getActorData(charId);
        if (stats?.session?.summonerId || stats?.lifetime?.summonerId)
            return false;
        return actor.type === 'character' || Boolean(actor.hasPlayerOwner);
    }
    static _getCharPortrait(charId) {
        const actor = this._resolveStatActor(charId);
        if (!actor)
            return 'icons/svg/mystery-man.svg';
        const candidates = [
            actor.token?.texture?.src,
            actor.img,
            actor.prototypeToken?.texture?.src
        ];
        for (const c of candidates) {
            if (c && !PORTRAIT_STUBS.has(c))
                return c;
        }
        return actor.img || 'icons/svg/mystery-man.svg';
    }
    // ── helpers ─────────────────────────────────────
    static _locAbl(abl) {
        if (!abl || typeof abl !== 'string')
            return '\u2014';
        const cfgLabel = CONFIG?.DND5E?.abilities?.[abl]?.label;
        if (cfgLabel)
            return game.i18n.localize(cfgLabel);
        const cap = abl.charAt(0).toUpperCase() + abl.slice(1);
        const key = `DND5E.Ability${cap}`;
        const loc = game.i18n.localize(key);
        return loc !== key ? loc : cap;
    }
    static _locSkill(sk) {
        if (!sk || typeof sk !== 'string')
            return '\u2014';
        const cfgLabel = CONFIG?.DND5E?.skills?.[sk]?.label;
        if (cfgLabel)
            return game.i18n.localize(cfgLabel);
        const cap = sk.charAt(0).toUpperCase() + sk.slice(1);
        const key = `DND5E.Skill${cap}`;
        const loc = game.i18n.localize(key);
        return loc !== key ? loc : cap;
    }
    static _locTool(tool) {
        if (!tool || typeof tool !== 'string')
            return '\u2014';
        try {
            const traitLabel = globalThis.dnd5e?.documents?.Trait?.keyLabel?.(tool, { trait: 'tool' });
            if (traitLabel)
                return traitLabel;
        }
        catch (e) { /* fallback */ }
        const cfgTool = CONFIG?.DND5E?.tools?.[tool];
        const cfgLabel = typeof cfgTool === 'string' ? cfgTool : cfgTool?.label;
        if (cfgLabel)
            return game.i18n.localize(cfgLabel);
        return tool.charAt(0).toUpperCase() + tool.slice(1);
    }
    static _locDamageType(type) {
        if (!type || type === 'unknown')
            return game.i18n.localize('showstopper.Stats.UnknownType');
        const cfg = CONFIG?.DND5E?.damageTypes?.[type] ?? CONFIG?.DND5E?.healingTypes?.[type];
        const label = typeof cfg === 'string' ? cfg : cfg?.label;
        return label ? game.i18n.localize(label) : type;
    }
    static _locSpellLevel(lvl) {
        const key = String(lvl ?? 0);
        const cfgLabel = CONFIG?.DND5E?.spellLevels?.[key];
        if (cfgLabel)
            return game.i18n.localize(cfgLabel);
        if (key === '0') {
            const cantrip = game.i18n.localize('DND5E.SpellCantrip');
            return cantrip !== 'DND5E.SpellCantrip' ? cantrip : 'Cantrip';
        }
        const levelWord = game.i18n.localize('DND5E.SpellLevel');
        return levelWord !== 'DND5E.SpellLevel' ? `${levelWord} ${key}` : key;
    }
    static _avg(sum, total) {
        return total > 0 ? (sum / total).toFixed(1) : '\u2014';
    }
    static _pct(num, total) {
        return total > 0 ? Math.round((num / total) * 100) : 0;
    }
    static _logIcon(cat) {
        const icons = { attack: '[A]', save: '[S]', skill: '[Sk]', abilityCheck: '[Ab]', tool: '[T]', deathSave: '[D]', concentration: '[C]' };
        return icons[cat] || '[-]';
    }
    static _esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    // ── SVG chart renderers ─────────────────────────
    /**
     * idp is a unique per-card SVG gradient ID prefix (card ID stripped of
     * characters unsafe in HTML IDs): multiple cards with charts can be expanded
     * simultaneously, and colliding IDs would paint every bar with the first card's gradient.
     */
    static _renderDamageTypeChart(stats, idp = '') {
        const dmgTypes = Object.entries(stats.damage?.byType || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        if (!dmgTypes.length)
            return '';
        const total = dmgTypes.reduce((s, [, v]) => s + v, 0);
        if (total <= 0)
            return '';
        const hueStep = 360 / Math.max(dmgTypes.length, 1);
        let svg = `<svg class="ss-stats__chart" viewBox="0 0 280 ${dmgTypes.length * 20 + 4}">
      <defs>${dmgTypes.map((_, i) => `<linearGradient id="${idp}g${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="hsl(${i * hueStep}, 65%, 50%)"/><stop offset="100%" stop-color="hsl(${i * hueStep + 20}, 60%, 40%)"/></linearGradient>`).join('')}</defs>`;
        dmgTypes.forEach(([type, val], i) => {
            const pct = Math.round((val / total) * 100);
            const w = Math.max(20, (val / total) * 260);
            const y = i * 20;
            const label = this._locDamageType(type);
            svg += `<rect class="ss-stats__cht-bar" x="0" y="${y}" width="${w}" height="14" rx="3" fill="url(#${idp}g${i})"/>
        <text class="ss-stats__cht-lbl" x="6" y="${y + 11}">${this._esc(label)}</text>
        <text class="ss-stats__cht-val" x="${Math.min(w + 4, 270)}" y="${y + 11}">${val} (${pct}${this._pctLabel()})</text>`;
        });
        svg += '</svg>';
        return svg;
    }
    static _renderSpellLevelChart(stats, idp = '') {
        const byLevel = Object.entries(stats.spells?.byLevel || {}).filter(([, v]) => v > 0).sort((a, b) => Number(a[0]) - Number(b[0]));
        if (!byLevel.length)
            return '';
        const total = byLevel.reduce((s, [, v]) => s + v, 0);
        if (total <= 0)
            return '';
        let svg = `<svg class="ss-stats__chart" viewBox="0 0 280 ${byLevel.length * 20 + 4}">
      <defs>${byLevel.map((_, i) => `<linearGradient id="${idp}sl${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="hsl(${i * 40 + 200}, 60%, 50%)"/><stop offset="100%" stop-color="hsl(${i * 40 + 220}, 55%, 35%)"/></linearGradient>`).join('')}</defs>`;
        byLevel.forEach(([lvl, val], i) => {
            const pct = Math.round((val / total) * 100);
            const w = Math.max(20, (val / total) * 260);
            const y = i * 20;
            const label = this._locSpellLevel(lvl);
            const valueX = Math.min(Math.max(w + 6, 64), 270);
            svg += `<rect class="ss-stats__cht-bar" x="0" y="${y}" width="${w}" height="14" rx="3" fill="url(#${idp}sl${i})"/>
        <text class="ss-stats__cht-lbl" x="6" y="${y + 11}">${this._esc(label)}</text>
        <text class="ss-stats__cht-val" x="${valueX}" y="${y + 11}">${val} (${pct}${this._pctLabel()})</text>`;
        });
        svg += '</svg>';
        return svg;
    }
    static _pctLabel() { return game.i18n.localize('showstopper.Stats.Percent') || '%'; }
    // ── export ──────────────────────────────────────
    static _fmtNum(value) {
        const n = Number(value) || 0;
        const rounded = Math.round(n * 10) / 10;
        return new Intl.NumberFormat(game.i18n?.lang || undefined).format(rounded);
    }
    static _exportToChat(charId, period = 'session') {
        const stats = charId ? this._getPeriodData(charId, period || 'session') : null;
        if (!stats) {
            ui.notifications.warn(game.i18n.localize('showstopper.Stats.NoStatsExport'));
            return;
        }
        const t = (key, fb) => { const v = game.i18n.localize(key); return v !== key ? v : (fb || key); };
        const name = this._esc(this._getCharName(charId));
        const periodLabel = this._esc(t(period === 'all' ? 'showstopper.Stats.AllTime' : 'showstopper.Stats.Session'));
        const rows = [];
        const atk = stats.attacks || {};
        if (atk.total > 0) {
            rows.push([t('DND5E.AttackPl'), `${this._fmtNum(atk.total)} (${t('DND5E.CriticalHit')}: ${this._fmtNum(atk.crits || 0)}, ${t('showstopper.Stats.Fumbles')}: ${this._fmtNum(atk.fumbles || 0)})`]);
        }
        const dmg = stats.damage || {};
        if (dmg.dealt > 0) {
            const summonPart = (dmg.summonDealt || 0) > 0 ? ` (${t('showstopper.Stats.SummonDamage')}: ${this._fmtNum(dmg.summonDealt)})` : '';
            rows.push([t('showstopper.Stats.DamageDealt'), `${this._fmtNum(dmg.dealt)}${summonPart}`]);
        }
        if (dmg.taken > 0) {
            rows.push([t('showstopper.Stats.Taken'), `${this._fmtNum(dmg.taken)}${dmg.downs ? ` (${t('showstopper.Stats.Downs')}: ${this._fmtNum(dmg.downs)})` : ''}`]);
        }
        if (stats.kills > 0)
            rows.push([t('showstopper.Stats.Kills'), this._fmtNum(stats.kills)]);
        const heal = stats.healing || {};
        if ((heal.given || 0) > 0)
            rows.push([t('showstopper.Stats.HealingGiven'), this._fmtNum(heal.given)]);
        if ((heal.received || 0) > 0)
            rows.push([t('showstopper.Stats.HealingReceived'), this._fmtNum(heal.received)]);
        const sp = stats.spells || {};
        if (sp.total > 0)
            rows.push([t('TYPES.Item.spellPl'), this._fmtNum(sp.total)]);
        const ss = stats.saveSummary || {};
        if (ss.total > 0)
            rows.push([t('DND5E.SAVE.Title.other'), `${ss.successes}/${ss.total}`]);
        if (stats.nat20 || stats.nat1)
            rows.push([`${t('showstopper.Stats.Nat20')} / ${t('showstopper.Stats.Nat1')}`, `${stats.nat20 || 0} / ${stats.nat1 || 0}`]);
        if (!rows.length) {
            ui.notifications.warn(game.i18n.localize('showstopper.Stats.NoStatsExport'));
            return;
        }
        const listHtml = rows.map(([k, v]) => `<div class="ss-export-msg__row"><span>${this._esc(k)}</span><strong>${this._esc(v)}</strong></div>`).join('');
        const isPC = this._isCharPC(charId);
        const whisper = isPC ? [] : (ChatMessage.getWhisperRecipients?.('GM')?.map(u => u.id) ?? game.users?.filter(u => u.isGM).map(u => u.id) ?? []);
        ChatMessage.create({
            content: `<div class="ss-export-msg"><div class="ss-export-msg__head"><strong>${name}</strong><span>${periodLabel}</span></div><div class="ss-export-msg__body">${listHtml}</div></div>`,
            whisper
        });
        ui.notifications.info(game.i18n.localize('showstopper.Stats.StatsExported'));
    }
    static _exportSummaryToChat(period = 'session', pcOnly = false) {
        const ids = this._getAllCharIds();
        const entries = ids.map(id => {
            const isPC = this._isCharPC(id);
            if (pcOnly && !isPC)
                return null;
            const data = this._getPeriodData(id, period);
            if (!data)
                return null;
            return {
                id,
                name: this._getCharName(id),
                isPC,
                atk: data.attacks?.total || 0,
                dmg: data.damage?.dealt || 0,
                taken: data.damage?.taken || 0,
                heal: (data.healing?.given || 0) + (data.healing?.received || 0),
                kills: data.kills || 0
            };
        }).filter(e => e && (e.atk > 0 || e.dmg > 0 || e.taken > 0 || e.heal > 0 || e.kills > 0));
        if (!entries.length) {
            ui.notifications.warn(game.i18n.localize('showstopper.Stats.NoStatsExport'));
            return;
        }
        entries.sort((a, b) => b.dmg - a.dmg || b.atk - a.atk);
        const top = entries.slice(0, 12);
        const t = (key, fb) => { const v = game.i18n.localize(key); return v !== key ? v : (fb || key); };
        const periodLabel = this._esc(t(period === 'all' ? 'showstopper.Stats.AllTime' : 'showstopper.Stats.Session'));
        const rowsHtml = top.map(e => `<tr><td>${this._esc(e.name)}</td><td class="num">${this._fmtNum(e.atk)}</td><td class="num">${this._fmtNum(e.dmg)}</td><td class="num">${this._fmtNum(e.taken)}</td></tr>`).join('');
        const hasNpc = top.some(e => !e.isPC);
        const whisper = hasNpc ? (ChatMessage.getWhisperRecipients?.('GM')?.map(u => u.id) ?? game.users?.filter(u => u.isGM).map(u => u.id) ?? []) : [];
        ChatMessage.create({
            content: `<div class="ss-export-msg"><div class="ss-export-msg__head"><strong>${this._esc(t('showstopper.Stats.Title'))}</strong><span>${periodLabel}</span></div><table class="ss-export-msg__table"><thead><tr><th>${this._esc(t('showstopper.Stats.Character'))}</th><th class="num">${this._esc(t('DND5E.AttackPl'))}</th><th class="num">${this._esc(t('showstopper.Stats.DamageDealt'))}</th><th class="num">${this._esc(t('showstopper.Stats.Taken'))}</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
            whisper
        });
        ui.notifications.info(game.i18n.localize('showstopper.Stats.StatsExported'));
    }
    // ── UI ─────────────────────────────────────────
    static async showStats(charId) {
        if (!game.user?.isGM) {
            this._store = game.settings.get(MODULE_ID, SETTING_KEY) ?? { currentDate: this._today() };
            this._rollLog = game.settings.get(MODULE_ID, 'statsLog') ?? [];
        }
        // Singleton: V2 windows do NOT register in ui.windows (which is ApplicationV1-only) —
        // look up ApplicationV2's instances registry so we don't spawn duplicate "showstopper-stats" DOM IDs.
        const existing = foundry.applications.instances.get('showstopper-stats');
        if (existing) {
            if (charId && typeof existing.selectCharacter === 'function') {
                await existing.selectCharacter(charId);
            }
            else {
                await existing.render({ force: true });
            }
            existing.bringToFront?.();
            return existing;
        }
        return new StatsApp(charId).render({ force: true });
    }
}
export { RollStats };
