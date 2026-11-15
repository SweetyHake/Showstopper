import { getEffectSettings, getEffectSetting } from './utils/effect-settings.mjs';
import { preloadAssets } from '../utils/preload.mjs';
import { getSocket } from '../core/socket-manager.mjs';
// Most recent active intro sound: previously the handle was lost (fire-and-forget
// playSound) and the file kept playing TO THE END after closing the overlay;
// starting a new intro stops the previous one.
let _lastIntroSound = null;
// Intro sound launch counter: calling stopIntroSound while awaiting file load
// increments the epoch so a late-resolving play() stops immediately instead of playing orphaned
let _soundEpoch = 0;
/**
 * Resolves a localizable string, i18n key, or lazy getter function.
 * Allows third-party modules to pass either literal text or localization keys
 * before game.i18n is initialized.
 */
export function resolveLocalizableText(value, fallback = '') {
    if (typeof value === 'function') {
        try {
            const res = value();
            return res != null ? String(res) : fallback;
        }
        catch {
            return fallback;
        }
    }
    if (typeof value === 'string') {
        if (!value)
            return fallback;
        try {
            if (globalThis.game?.i18n?.has?.(value)) {
                return game.i18n.localize(value);
            }
        }
        catch { /* outside Foundry environment */ }
        return value;
    }
    return fallback;
}
/**
 * Normalizes execute(localOnlyOrOptions) into a unified options object
 * while preserving backward compatibility with boolean execute(true) calls.
 */
export function normalizeExecOptions(arg = false) {
    if (typeof arg === 'boolean')
        return { localOnly: arg };
    if (arg && typeof arg === 'object')
        return { ...arg, localOnly: Boolean(arg.localOnly) };
    return { localOnly: false };
}
function normalizeStringList(val) {
    if (!val)
        return [];
    if (Array.isArray(val))
        return val.map(String).filter(Boolean);
    if (typeof val === 'string')
        return [val];
    return [];
}
const BUILTIN_LOCALIZATION_KEYS = {
    'jojo-intro': 'jojo',
    'hero-intro': 'hero',
    'villain-intro': 'villain',
    'borderlands-intro': 'borderlands',
    'genshin-intro': 'genshin',
    'arcane-intro': 'arcane',
    'neon-intro': 'neon',
    'yakuza-intro': 'yakuza',
    'typewriter-intro': 'typewriter',
    'noir-intro': 'noir',
    'western-intro': 'western',
    'star-wars-opening': 'starWars',
    'champions-opening': 'champions',
    'tbc-ending': 'tbc',
    'directed-by-ending': 'directedBy',
    'michael-bay-ending': 'michaelBay',
    'battle-stats-ending': 'battleStats',
    'heroes-ending': 'heroes'
};
export class BaseEffect {
    static id = 'base-effect';
    static icon = 'fa-solid fa-star';
    static category = 'introductions';
    static order = 0;
    static enabled = false;
    static requiredSystem = null;
    static requiredModules = null;
    static nameLabel = null;
    static descriptionLabel = null;
    static hintLabel = null;
    static get isAvailable() {
        if (!this.enabled)
            return false;
        const systems = normalizeStringList(this.requiredSystem);
        if (systems.length > 0 && !systems.includes(game?.system?.id)) {
            return false;
        }
        const modules = normalizeStringList(this.requiredModules);
        if (modules.length > 0) {
            for (const modId of modules) {
                if (!game?.modules?.get?.(modId)?.active)
                    return false;
            }
        }
        return true;
    }
    static get localizationKey() {
        if (BUILTIN_LOCALIZATION_KEYS[this.id]) {
            return BUILTIN_LOCALIZATION_KEYS[this.id];
        }
        return String(this.id || '').replace(/-(intro|opening|ending|finisher)$/i, '') || this.id;
    }
    static get localizationPrefix() {
        const categoryMap = { introductions: 'introduction', openings: 'opening', endings: 'ending', finishers: 'finisher' };
        const cat = categoryMap[this.category] || this.category;
        return `showstopper.cut-ins.${cat}.${this.localizationKey}`;
    }
    static getName() {
        if (this.nameLabel != null) {
            return resolveLocalizableText(this.nameLabel, this.id);
        }
        const key = `${this.localizationPrefix}.name`;
        if (game?.i18n?.has?.(key)) {
            return game.i18n.localize(key);
        }
        return game?.i18n ? game.i18n.localize(key) : this.id;
    }
    static getDescription() {
        if (this.descriptionLabel != null) {
            return resolveLocalizableText(this.descriptionLabel, '');
        }
        const key = `${this.localizationPrefix}.description`;
        if (game?.i18n?.has?.(key)) {
            return game.i18n.localize(key);
        }
        return '';
    }
    static getHint() {
        if (!this.enabled) {
            return resolveLocalizableText('showstopper.cut-ins.ui.comingSoon', 'Coming soon');
        }
        const systems = normalizeStringList(this.requiredSystem);
        if (systems.length > 0 && !systems.includes(game?.system?.id)) {
            const sysKey = `${this.localizationPrefix}.requiresSystem`;
            if (game?.i18n?.has?.(sysKey))
                return game.i18n.localize(sysKey);
            return `Requires system: ${systems.join(', ')}`;
        }
        const modules = normalizeStringList(this.requiredModules);
        if (modules.length > 0) {
            const missing = modules.filter(m => !game?.modules?.get?.(m)?.active);
            if (missing.length > 0) {
                return `Requires module: ${missing.join(', ')}`;
            }
        }
        if (this.hintLabel != null) {
            return resolveLocalizableText(this.hintLabel, '');
        }
        return '';
    }
    static getSettingsSchema() {
        return [
            {
                name: 'soundPath',
                type: 'sound',
                label: resolveLocalizableText('showstopper.cut-ins.ui.effectSettings.fields.soundPath', 'Sound'),
                hint: resolveLocalizableText('showstopper.cut-ins.ui.effectSettings.fields.soundPathHint', ''),
                group: 'common',
                default: null
            },
            {
                name: 'soundVolume',
                type: 'range',
                label: resolveLocalizableText('showstopper.cut-ins.ui.effectSettings.fields.soundVolume', 'Volume'),
                group: 'common',
                min: 0,
                max: 1,
                step: 0.1,
                suffix: '',
                default: 0.8
            }
        ];
    }
    static getDefaultSettings() {
        const defaults = {};
        for (const field of this.getSettingsSchema()) {
            defaults[field.name] = field.default;
        }
        return defaults;
    }
    static getSettings() {
        return getEffectSettings(this.id);
    }
    static getSetting(key, defaultValue = null) {
        const defaults = this.getDefaultSettings();
        return getEffectSetting(this.id, key, defaultValue ?? defaults[key]);
    }
    static getSoundPath() {
        return this.getSetting('soundPath') || this.defaultSoundPath || null;
    }
    static getSoundVolume() {
        return this.getSetting('soundVolume', 0.8);
    }
    static _defaultSoundOverride = null;
    static setDefaultSoundOverride(path) {
        this._defaultSoundOverride = path || null;
    }
    static get defaultSoundPath() {
        return Object.prototype.hasOwnProperty.call(this, '_defaultSoundOverride')
            ? this._defaultSoundOverride
            : null;
    }
    static get hasSettings() {
        try {
            return this.getSettingsSchema().length > 0;
        }
        catch {
            return true;
        }
    }
    static toEffectData() {
        return {
            id: this.id,
            icon: this.icon,
            order: this.order ?? 0,
            enabled: this.enabled,
            isAvailable: this.isAvailable,
            hasSettings: this.hasSettings,
            handler: this.isAvailable ? (opts) => this.execute(opts) : null
        };
    }
    static async execute(localOnlyOrOptions = false) {
        console.warn(`Effect ${this.id} has no execute implementation`);
    }
    static async preview(options = null) {
        if (options && typeof options === 'object' && Object.keys(options).length > 0) {
            return this.execute({ ...options, localOnly: true });
        }
        return this.execute(true);
    }
    /**
     * Returns a list of asset URLs that should be preloaded by clients
     * before the effect is played. Subclasses may override to add images,
     * videos, or extra sounds.
     * @returns {{sounds?: string[], images?: string[], videos?: string[]}}
     */
    static getPreloadAssets() {
        const sounds = [];
        const images = [];
        const soundPath = this.getSoundPath();
        if (soundPath)
            sounds.push(soundPath);
        if (this.category === 'introductions') {
            const token = canvas?.tokens?.controlled?.[0];
            const actor = token?.actor;
            if (actor) {
                const portrait = token.document?.texture?.src || actor.img;
                if (portrait)
                    images.push(portrait);
            }
        }
        return { sounds, images, videos: [] };
    }
    /**
     * Preload effect assets on every connected client (including this one).
     */
    static async preload() {
        const assets = this.getPreloadAssets() || {};
        const hasAny = (assets.sounds?.length ?? 0) +
            (assets.images?.length ?? 0) +
            (assets.videos?.length ?? 0) > 0;
        if (!hasAny) {
            ui.notifications.info(game.i18n.format('showstopper.cut-ins.ui.preload.nothing', { name: this.getName() }));
            return;
        }
        const socket = getSocket();
        if (socket) {
            try {
                socket.executeForOthers('showstopperPreloadAssets', assets);
            }
            catch (e) {
                console.warn(`showstopper | Preload broadcast failed for ${this.id}`, e);
            }
        }
        await preloadAssets(assets);
        ui.notifications.info(game.i18n.format('showstopper.cut-ins.ui.preload.done', { name: this.getName() }));
    }
    static async playSound(volume = null) {
        const soundPath = this.getSoundPath();
        if (!soundPath)
            return null;
        const finalVolume = volume ?? this.getSoundVolume();
        try {
            const interfaceVolume = game.settings.get("core", "globalInterfaceVolume") ?? 0.5;
            const epoch = ++_soundEpoch;
            const sound = await foundry.audio.AudioHelper.play({
                src: soundPath,
                volume: finalVolume * interfaceVolume,
                autoplay: true,
                loop: false
            }, false);
            if (epoch !== _soundEpoch) {
                try {
                    sound.stop();
                }
                catch { /* already stopped */ }
                return null;
            }
            if (_lastIntroSound && _lastIntroSound !== sound) {
                try {
                    _lastIntroSound.stop();
                }
                catch { /* already stopped */ }
            }
            _lastIntroSound = sound;
            return sound;
        }
        catch (error) {
            console.warn(`showstopper | Failed to play sound for ${this.id}:`, error);
            return null;
        }
    }
    /** Stops the active intro sound on overlay close, skip, or scene change. */
    static stopIntroSound() {
        _soundEpoch++;
        if (_lastIntroSound) {
            try {
                _lastIntroSound.stop();
            }
            catch { /* already stopped */ }
            _lastIntroSound = null;
        }
    }
    static getStyles() {
        return '';
    }
}
