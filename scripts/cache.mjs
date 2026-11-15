export const groupLevelCache = {
    _value: null,
    get() {
        if (this._value !== null)
            return this._value;
        this._value = this._compute();
        return this._value;
    },
    _compute() {
        const onScene = this._getAvgOnScene();
        if (onScene !== null)
            return onScene;
        const group = game.actors?.find(a => a.type === 'group');
        if (group)
            return group.system?.level ?? 0;
        return this._getAvgAcrossWorld();
    },
    _getCharacterLevel(actor) {
        if (actor?.type !== 'character')
            return null;
        const classes = Object.values(actor.classes ?? {});
        if (classes.length) {
            return classes.reduce((total, cls) => total + (cls.system?.levels ?? 0), 0);
        }
        return actor.system?.details?.level ?? null;
    },
    _hasPlayerOwner(actor) {
        return game.users.some(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
    },
    _getAvgOnScene() {
        if (!canvas?.scene?.tokens)
            return null;
        const levels = [];
        for (const tokenDoc of canvas.scene.tokens) {
            if (tokenDoc.hidden)
                continue;
            const actor = game.actors.get(tokenDoc.actorId);
            if (!actor || actor.type !== 'character')
                continue;
            if (!this._hasPlayerOwner(actor))
                continue;
            const level = this._getCharacterLevel(actor);
            if (level !== null)
                levels.push(level);
        }
        if (levels.length === 0)
            return null;
        return Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
    },
    _getAvgAcrossWorld() {
        if (!game?.actors || typeof game.actors[Symbol.iterator] !== 'function')
            return 0;
        const levels = [];
        for (const actor of game.actors) {
            if (actor.type !== 'character')
                continue;
            if (!this._hasPlayerOwner(actor))
                continue;
            const level = this._getCharacterLevel(actor);
            if (level !== null)
                levels.push(level);
        }
        if (levels.length === 0)
            return 0;
        return Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
    },
    invalidate() {
        this._value = null;
    }
};
let _hookIds = [];
export function initCache() {
    // [name, id] pairs: Hooks.off requires the hook name as the first argument —
    // calling Hooks.off(<number>) did not unregister anything.
    _hookIds = [
        ['createActor', Hooks.on('createActor', () => groupLevelCache.invalidate())],
        ['updateActor', Hooks.on('updateActor', () => groupLevelCache.invalidate())],
        ['deleteActor', Hooks.on('deleteActor', () => groupLevelCache.invalidate())],
        ['createToken', Hooks.on('createToken', () => groupLevelCache.invalidate())],
        ['deleteToken', Hooks.on('deleteToken', () => groupLevelCache.invalidate())],
        ['canvasReady', Hooks.on('canvasReady', () => groupLevelCache.invalidate())]
    ];
}
export function destroyCache() {
    for (const [name, id] of _hookIds)
        Hooks.off(name, id);
    _hookIds = [];
}
