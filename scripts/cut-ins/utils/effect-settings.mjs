import { MODULE_ID } from '../../config.mjs';
const SETTINGS_KEY = 'effectSettings';
// The world setting is read and written as a single object: serialize read-modify-write
// so two rapid saves don't overwrite each other (last-write-wins at the whole-setting
// level rather than per-effect).
let _chain = Promise.resolve();
function _serialized(fn) {
    const next = _chain.then(fn);
    _chain = next.catch(() => { });
    return next;
}
function _ensureGM(action) {
    if (game.user?.isGM)
        return true;
    console.warn(`${MODULE_ID} | setEffectSettings (${action}): world settings can only be changed by the GM`);
    return false;
}
export function getEffectSettings(effectId) {
    try {
        const allSettings = game.settings.get(MODULE_ID, SETTINGS_KEY) || {};
        return allSettings[effectId] || {};
    }
    catch {
        return {};
    }
}
/** @returns {boolean} false if called by a non-GM (dialog displays an error). */
export async function setEffectSettings(effectId, settings) {
    if (!_ensureGM('set'))
        return false;
    await _serialized(async () => {
        const allSettings = game.settings.get(MODULE_ID, SETTINGS_KEY) || {};
        allSettings[effectId] = { ...allSettings[effectId], ...settings };
        await game.settings.set(MODULE_ID, SETTINGS_KEY, allSettings);
    });
    return true;
}
/** @returns {boolean} false if called by a non-GM (dialog displays an error). */
export async function resetEffectSettings(effectId) {
    if (!_ensureGM('reset'))
        return false;
    await _serialized(async () => {
        const allSettings = game.settings.get(MODULE_ID, SETTINGS_KEY) || {};
        delete allSettings[effectId];
        await game.settings.set(MODULE_ID, SETTINGS_KEY, allSettings);
    });
    return true;
}
export function getEffectSetting(effectId, key, defaultValue) {
    const settings = getEffectSettings(effectId);
    return settings[key] ?? defaultValue;
}
export function registerEffectSettingsStorage() {
    game.settings.register(MODULE_ID, SETTINGS_KEY, {
        name: 'Effect Settings',
        scope: 'world',
        config: false,
        type: Object,
        default: {}
    });
}
