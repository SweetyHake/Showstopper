import { MODULE_ID } from '../config.mjs';
const _api = new Map();
// Single stable API target object: references held by external consumers
// (`globalThis.showstopper`) never go stale when new namespaces register —
// the object is mutated in place and available immediately on module import.
const _apiTarget = {};
globalThis.showstopper = _apiTarget;
/**
 * Register a public API surface under a namespace.
 * Namespace becomes a property of both `game.modules.get('showstopper').api`
 * and `globalThis.showstopper` (they are kept in sync by publishAPI).
 */
export function registerAPI(namespace, value) {
    if (!namespace || typeof namespace !== 'string') {
        console.error(`${MODULE_ID} | registerAPI: namespace must be a non-empty string`);
        return;
    }
    _api.set(namespace, value);
    publishAPI();
}
export function unregisterAPI(namespace) {
    if (_api.delete(namespace))
        publishAPI();
}
export function getAPITarget() {
    return _apiTarget;
}
export function publishAPI() {
    for (const key of Object.keys(_apiTarget)) {
        if (!_api.has(key))
            delete _apiTarget[key];
    }
    for (const [ns, value] of _api)
        _apiTarget[ns] = value;
    globalThis.showstopper = _apiTarget;
    if (!globalThis.game?.modules)
        return;
    const module = game.modules.get(MODULE_ID);
    if (module)
        module.api = _apiTarget;
}
Hooks.once('init', () => publishAPI());
Hooks.once('ready', () => publishAPI());
