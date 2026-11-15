/**
 * Showstopper effect and category registry. Lives in its own module (not index.mjs)
 * so effect categories — notably finishers — can import the registry without
 * creating a circular `index -> category -> index` dependency.
 */
import { MODULE_ID } from '../config.mjs';
import { registerSocketHandler, unregisterSocketHandler } from '../core/socket-manager.mjs';
const DEFAULT_CATEGORIES = [
    {
        id: 'introductions',
        icon: 'fa-solid fa-user-ninja',
        label: () => game.i18n.localize(`${MODULE_ID}.cut-ins.ui.tabs.introductions`),
        order: 10,
        builtin: true
    },
    {
        id: 'openings',
        icon: 'fa-solid fa-play',
        label: () => game.i18n.localize(`${MODULE_ID}.cut-ins.ui.tabs.openings`),
        order: 20,
        builtin: true
    },
    {
        id: 'endings',
        icon: 'fa-solid fa-flag-checkered',
        label: () => game.i18n.localize(`${MODULE_ID}.cut-ins.ui.tabs.endings`),
        order: 30,
        builtin: true
    },
    {
        id: 'finishers',
        icon: 'fa-solid fa-skull',
        label: () => game.i18n.localize(`${MODULE_ID}.cut-ins.ui.tabs.finishers`),
        order: 40,
        needsTarget: () => (globalThis.canvas?.tokens?.controlled?.length ?? 0) === 0
            && (globalThis.game?.user?.targets?.size ?? 0) === 0,
        targetHint: () => game.i18n.localize(`${MODULE_ID}.cut-ins.finisher.common.noTarget`),
        builtin: true
    }
];
function safeRefreshCinemaMenu() {
    try {
        globalThis.foundry?.applications?.instances?.get?.('cinema-menu-dialog')?.render();
    }
    catch { /* menu closed or test environment */ }
}
function safeCloseCinemaMenu() {
    try {
        globalThis.foundry?.applications?.instances?.get?.('cinema-menu-dialog')?.close?.();
    }
    catch { /* menu closed or test environment */ }
}
let _controlsRefreshQueued = false;
function safeRefreshSceneControls() {
    if (_controlsRefreshQueued)
        return;
    _controlsRefreshQueued = true;
    queueMicrotask(() => {
        _controlsRefreshQueued = false;
        try {
            const controls = globalThis.ui?.controls;
            if (controls?.rendered) {
                controls.render({ reset: true });
            }
        }
        catch { /* headless or pre-ready */ }
    });
}
function safeCallHook(hookName, ...args) {
    try {
        globalThis.Hooks?.callAll?.(hookName, ...args);
    }
    catch (e) {
        console.error(`${MODULE_ID} | Hook '${hookName}' listener failed:`, e);
    }
}
class EffectRegistry {
    #effects = new Map();
    #categories = new Map();
    #categoryDefs = new Map();
    #stylesInjected = false;
    // effect id -> Set of socket handler names registered by its register() call
    #socketNames = new Map();
    // handler name -> registration refcount: shared handler names (e.g. finisher:showToken
    // registered by all finisher classes) are unregistered only when the last owner leaves
    #socketNameRefs = new Map();
    // Declarative definition factories (wired without circular imports)
    #declarativeFactory = null;
    #finisherFactory = null;
    constructor() {
        for (const cat of DEFAULT_CATEGORIES) {
            this.#categoryDefs.set(cat.id, { ...cat });
        }
    }
    /** Internal binder for the declarative effect factory (defineEffect). */
    _setDeclarativeFactory(fn) {
        this.#declarativeFactory = fn;
    }
    /** Internal binder for the declarative finisher factory (defineFinisher). */
    _setFinisherFactory(fn) {
        this.#finisherFactory = fn;
    }
    /**
     * Registers or updates a category tab in the Cinema Menu.
     */
    registerCategory(def) {
        if (!def || typeof def.id !== 'string' || !def.id.trim()) {
            throw new Error(`EffectRegistry: Category must have a non-empty 'id'`);
        }
        const id = def.id.trim();
        const prev = this.#categoryDefs.get(id);
        const merged = {
            id,
            icon: def.icon ?? prev?.icon ?? 'fa-solid fa-film',
            label: def.label ?? prev?.label ?? id,
            order: typeof def.order === 'number' ? def.order : (prev?.order ?? 100),
            hideWhenEmpty: def.hideWhenEmpty ?? prev?.hideWhenEmpty ?? false,
            needsTarget: def.needsTarget ?? prev?.needsTarget ?? false,
            targetHint: def.targetHint ?? prev?.targetHint ?? '',
            emptyText: def.emptyText ?? prev?.emptyText,
            builtin: prev?.builtin ?? false
        };
        this.#categoryDefs.set(id, merged);
        safeRefreshCinemaMenu();
        safeCallHook('showstopper.categoryRegistered', merged);
        return merged;
    }
    /**
     * Removes a custom category tab (the 4 built-in categories are protected).
     */
    unregisterCategory(id) {
        const existing = this.#categoryDefs.get(id);
        if (!existing || existing.builtin)
            return false;
        this.#categoryDefs.delete(id);
        safeRefreshCinemaMenu();
        safeCallHook('showstopper.categoryUnregistered', id);
        return true;
    }
    getCategory(id) {
        return this.#categoryDefs.get(id) ?? null;
    }
    /**
     * Returns the sorted list of all category tabs (including categories implicitly
     * created by registering an effect with a new `category` id).
     */
    getCategories() {
        const allIds = new Set([
            ...this.#categoryDefs.keys(),
            ...this.#categories.keys()
        ]);
        const list = [];
        for (const id of allIds) {
            const def = this.#categoryDefs.get(id) ?? {
                id,
                icon: 'fa-solid fa-film',
                label: id,
                order: 100
            };
            list.push(def);
        }
        list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        return list;
    }
    /**
     * Registers an effect: accepts either a class (BaseEffect / FinisherEffect subclass /
     * static contract) OR a declarative configuration object.
     */
    register(target) {
        let EffectClass = target;
        if (target && typeof target === 'object' && typeof target !== 'function') {
            const isFinisherDef = target.category === 'finishers'
                && typeof target.execute !== 'function'
                && typeof target.render !== 'function'
                && this.#finisherFactory;
            if (isFinisherDef) {
                EffectClass = this.#finisherFactory(target);
            }
            else if (this.#declarativeFactory) {
                EffectClass = this.#declarativeFactory(target);
            }
            else {
                throw new Error(`EffectRegistry: Declarative effect factory is not initialized yet`);
            }
        }
        if (!EffectClass?.id)
            throw new Error(`EffectRegistry: Effect must have static 'id' property`);
        if (!EffectClass.category)
            throw new Error(`EffectRegistry: Effect '${EffectClass.id}' must have static 'category' property`);
        if (typeof EffectClass.execute !== 'function')
            throw new Error(`EffectRegistry: Effect '${EffectClass.id}' must have static execute()`);
        const prevClass = this.#effects.get(EffectClass.id);
        const isReplacement = Boolean(prevClass);
        if (isReplacement) {
            console.warn(`EffectRegistry | Effect '${EffectClass.id}' is already registered, replacing`);
            // If the category changed on replacement, remove from the old category set
            if (prevClass.category !== EffectClass.category && this.#categories.has(prevClass.category)) {
                const oldSet = this.#categories.get(prevClass.category);
                oldSet.delete(EffectClass.id);
                if (oldSet.size === 0)
                    this.#categories.delete(prevClass.category);
            }
        }
        // Ensure optional interface methods have fallbacks
        if (typeof EffectClass.getName !== 'function')
            EffectClass.getName = function () { return this.id; };
        if (typeof EffectClass.getDescription !== 'function')
            EffectClass.getDescription = function () { return ''; };
        if (typeof EffectClass.getHint !== 'function')
            EffectClass.getHint = function () { return ''; };
        if (typeof EffectClass.getSettingsSchema !== 'function')
            EffectClass.getSettingsSchema = function () { return []; };
        if (typeof EffectClass.getDefaultSettings !== 'function') {
            EffectClass.getDefaultSettings = function () {
                const d = {};
                for (const f of this.getSettingsSchema())
                    d[f.name] = f.default;
                return d;
            };
        }
        if (typeof EffectClass.getStyles !== 'function')
            EffectClass.getStyles = function () { return ''; };
        if (typeof EffectClass.registerSocketHandler !== 'function')
            EffectClass.registerSocketHandler = function () { };
        if (typeof EffectClass.preload !== 'function')
            EffectClass.preload = async function () { };
        if (typeof EffectClass.preview !== 'function')
            EffectClass.preview = function (opts) { return opts ? this.execute({ ...opts, localOnly: true }) : this.execute(true); };
        if (typeof EffectClass.toEffectData !== 'function') {
            EffectClass.toEffectData = function () {
                return { id: this.id, icon: this.icon, order: this.order ?? 0, enabled: this.enabled, isAvailable: this.isAvailable ?? this.enabled, hasSettings: this.hasSettings, handler: (opts) => this.execute(opts) };
            };
        }
        if (EffectClass.hasSettings === undefined) {
            Object.defineProperty(EffectClass, 'hasSettings', { get() { return true; }, configurable: true });
        }
        if (EffectClass.isAvailable === undefined) {
            Object.defineProperty(EffectClass, 'isAvailable', { get() { return this.enabled; }, configurable: true });
        }
        if (EffectClass.enabled === undefined)
            EffectClass.enabled = true;
        if (EffectClass.order === undefined)
            EffectClass.order = 0;
        if (!EffectClass.icon)
            EffectClass.icon = 'fa-solid fa-star';
        const wasEmpty = this.#effects.size === 0;
        this.#effects.set(EffectClass.id, EffectClass);
        if (!this.#categories.has(EffectClass.category)) {
            this.#categories.set(EffectClass.category, new Set());
        }
        this.#categories.get(EffectClass.category).add(EffectClass.id);
        // Route effect socket handlers through the unified socket manager.
        this.#releaseSocketNames(EffectClass.id);
        const socketNames = new Set();
        EffectClass.registerSocketHandler({
            register: (name, fn) => {
                registerSocketHandler(name, fn);
                socketNames.add(name);
            }
        });
        for (const name of socketNames) {
            this.#socketNameRefs.set(name, (this.#socketNameRefs.get(name) ?? 0) + 1);
        }
        this.#socketNames.set(EffectClass.id, socketNames);
        if (this.#stylesInjected && typeof EffectClass.getStyles === 'function') {
            if (isReplacement)
                this.injectAllStyles();
            else
                this._injectEffectStyle(EffectClass);
        }
        console.log(`showstopper | Effect registered: ${EffectClass.id} [${EffectClass.category}]`);
        safeRefreshCinemaMenu();
        if (wasEmpty && this.#effects.size > 0)
            safeRefreshSceneControls();
        safeCallHook('showstopper.effectRegistered', EffectClass);
        return EffectClass;
    }
    unregister(id) {
        const EffectClass = this.#effects.get(id);
        if (!EffectClass)
            return false;
        this.#effects.delete(id);
        if (this.#categories.has(EffectClass.category)) {
            const set = this.#categories.get(EffectClass.category);
            set.delete(id);
            if (set.size === 0) {
                this.#categories.delete(EffectClass.category);
            }
        }
        this.#releaseSocketNames(id);
        if (this.#stylesInjected)
            this.injectAllStyles();
        console.log(`showstopper | Effect unregistered: ${id}`);
        if (this.#effects.size === 0) {
            safeCloseCinemaMenu();
            safeRefreshSceneControls();
        }
        else {
            safeRefreshCinemaMenu();
        }
        safeCallHook('showstopper.effectUnregistered', id, EffectClass);
        return true;
    }
    #releaseSocketNames(id) {
        const names = this.#socketNames.get(id);
        if (!names)
            return;
        this.#socketNames.delete(id);
        for (const name of names) {
            const refs = (this.#socketNameRefs.get(name) ?? 1) - 1;
            if (refs <= 0) {
                this.#socketNameRefs.delete(name);
                unregisterSocketHandler(name);
            }
            else {
                this.#socketNameRefs.set(name, refs);
            }
        }
    }
    get size() {
        return this.#effects.size;
    }
    hasEffects() {
        return this.#effects.size > 0;
    }
    has(id) {
        return this.#effects.has(id);
    }
    get(id) {
        return this.#effects.get(id) ?? null;
    }
    getEffectById(id) {
        return this.get(id);
    }
    #sortEffects(list) {
        return list
            .map((cls, idx) => ({ cls, idx, order: typeof cls?.order === 'number' ? cls.order : 0 }))
            .sort((a, b) => (a.order - b.order) || (a.idx - b.idx))
            .map(item => item.cls);
    }
    getAll() {
        const result = {};
        for (const [category, ids] of this.#categories) {
            result[category] = this.#sortEffects([...ids].map(id => this.#effects.get(id)).filter(Boolean));
        }
        return result;
    }
    getByCategory(category) {
        const ids = this.#categories.get(category);
        if (!ids)
            return [];
        return this.#sortEffects([...ids].map(id => this.#effects.get(id)).filter(Boolean));
    }
    get categories() {
        return [...this.#categories.keys()];
    }
    injectAllStyles() {
        this.#stylesInjected = true;
        if (typeof document === 'undefined')
            return;
        const styleId = 'showstopper-effect-styles';
        let styleEl = document.getElementById(styleId);
        if (styleEl)
            styleEl.remove();
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        const styles = [];
        for (const [, EffectClass] of this.#effects) {
            if (typeof EffectClass.getStyles === 'function') {
                const css = EffectClass.getStyles();
                if (css?.trim())
                    styles.push(`/* ${EffectClass.id} */\n${css}`);
            }
        }
        styleEl.textContent = styles.join('\n\n');
        document.head.appendChild(styleEl);
        console.log(`showstopper | Injected ${styles.length} effect styles`);
    }
    _injectEffectStyle(EffectClass) {
        if (typeof document === 'undefined')
            return;
        const styleEl = document.getElementById('showstopper-effect-styles');
        if (!styleEl)
            return;
        if (typeof EffectClass.getStyles !== 'function')
            return;
        const css = EffectClass.getStyles();
        if (!css?.trim())
            return;
        styleEl.textContent += `\n\n/* ${EffectClass.id} */\n${css}`;
    }
}
export const effectRegistry = new EffectRegistry();
