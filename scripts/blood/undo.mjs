/**
 * Undo blood operations via native CTRL+Z.
 *
 * Stains live in scene flags rather than documents, so Foundry's native undo
 * history cannot see them. Two-part bridge:
 *
 *  1. BRUSH STACK (here): brush strokes and eraser/clear ops are pushed on
 *     commit (brush.mjs). PlaceablesLayer#undoHistory is patched: when the
 *     active layer has NO native history to undo (core would show "nothing to
 *     undo"), the top op on this stack is popped instead. If native undo did
 *     revert something, this stack is left untouched — native and blood undos
 *     share the same shortcut strictly in sequence.
 *
 *  2. TRAILS (events.mjs / trail.mjs, NOT here): movement footprints/smears
 *     are tied to native token movement and removed on updateToken with
 *     options.isUndo via per-token correlation.
 *
 * Everything is GM-side and session-memory only (changing scenes clears the
 * stack: stain IDs are per-scene, so cross-scene undo would delete unrelated stains).
 */
let _wire = null; // () => ({ store, renderer })
const _stack = [];
const MAX_OPS = 30;
/** Wire the undo stack to the active scene's store (called from entry.mjs). */
export function wireBloodUndo(wire) {
    _wire = wire;
}
/** Clear undo stack on scene change / teardown. */
export function resetBloodUndo() {
    _stack.length = 0;
}
/**
 * Record a brush operation.
 * @param {'add'|'remove'|'batch'} kind add — stroke (undo = remove stains), remove —
 *   eraser/clear (undo = restore stains), batch — combined snow sculpt
 *   ({ added, removed, replacedPrev }).
 * @param {any} records full stain records (with i/seed/w/e/tid) or a batch object.
 */
export function pushBloodOp(kind, records) {
    if (!game.user?.isGM || !records)
        return;
    if (kind === 'batch') {
        const added = Array.isArray(records.added) ? records.added : [];
        const removed = Array.isArray(records.removed) ? records.removed : [];
        const replacedPrev = Array.isArray(records.replacedPrev) ? records.replacedPrev : [];
        if (!added.length && !removed.length && !replacedPrev.length)
            return;
        _stack.push({ kind: 'batch', added, removed, replacedPrev });
    }
    else {
        if (!records.length)
            return;
        _stack.push({ kind, records });
    }
    if (_stack.length > MAX_OPS)
        _stack.shift();
}
/** Undo the top brush operation (visuals + socket + persist go through the store). */
export function undoLastBloodOp() {
    const op = _stack.pop();
    if (!op)
        return;
    const store = _wire?.()?.store;
    if (!store) {
        _stack.push(op); // store unavailable — keep op on stack for next attempt
        return;
    }
    if (op.kind === 'batch') {
        const removeIds = op.added?.length ? op.added.map(r => r.i) : [];
        const replacePrev = op.replacedPrev?.length ? op.replacedPrev : [];
        const restoreRecs = op.removed?.length ? op.removed : [];
        if (typeof store.applyBatch === 'function') {
            store.applyBatch({
                remove: removeIds.length ? removeIds : null,
                replace: replacePrev.length ? replacePrev : null,
                add: restoreRecs.length ? restoreRecs : null
            });
        }
        else {
            if (removeIds.length)
                store.remove(removeIds);
            if (replacePrev.length) {
                store.remove(replacePrev.map(r => r.i));
                store.add(replacePrev);
            }
            if (restoreRecs.length)
                store.add(restoreRecs);
        }
        return;
    }
    if (op.kind === 'add')
        store.remove(op.records.map(r => r.i));
    else
        store.add(op.records);
}
/**
 * Patch PlaceablesLayer#undoHistory (once on the prototype): when native
 * history on the active layer is empty, undo the top brush op instead of
 * showing the "nothing to undo" toast. Player pause-branch is irrelevant — stack is GM-only.
 *
 * libWrapper-FIRST: Baileywiki Mass Edit wraps the same method — raw
 * monkey-patching breaks its wrapper and triggers libWrapper warnings
 * ("Detected non-libWrapper wrapping"). Register via libWrapper when present
 * ('MIXED': our branch decides whether to invoke the downstream chain); fall
 * back to direct patching only in worlds without libWrapper.
 */
let _patched = false;
export function patchNativeUndo() {
    try {
        if (_patched)
            return;
        const proto = foundry.canvas?.layers?.PlaceablesLayer?.prototype;
        if (!proto?.undoHistory)
            return;
        const handler = function (wrapped, ...args) {
            if (!this.history?.length && game.user.isGM) {
                undoLastBloodOp();
                return [];
            }
            return wrapped.apply(this, args);
        };
        const lw = globalThis.libWrapper;
        if (lw?.register) {
            lw.register('showstopper', 'PlaceablesLayer.prototype.undoHistory', handler, 'MIXED');
        }
        else {
            if (proto.__ssBloodUndo)
                return;
            proto.__ssBloodUndo = true;
            const orig = proto.undoHistory;
            proto.undoHistory = async function (...args) {
                return handler.call(this, orig, ...args);
            };
        }
        _patched = true;
    }
    catch { /* without the patch, brush strokes simply aren't undoable */ }
}
