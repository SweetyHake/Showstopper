import { registerAPI } from "../core/runtime.mjs";
import { registerRawHandler, emitRaw } from "../core/socket-manager.mjs";
import { CanvasEffect, canvasEffects } from "../core/effect-manager.mjs";
/* ─── Easing & Offset State ─── */
const MESH_EASING = {
    linear: (t) => t,
    easeIn: (t) => t * t,
    easeOut: (t) => t * (2 - t),
    easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    easeOutCubic: (t) => { t--; return t * t * t + 1; },
    easeInCubic: (t) => t * t * t,
    easeOutQuart: (t) => { t--; return 1 - t * t * t * t; },
    easeInQuart: (t) => t * t * t * t,
    easeOutExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    easeInBack: (t) => { const s = 1.70158; return t * t * ((s + 1) * t - s); },
    easeOutBack: (t) => { const s = 1.70158; t--; return t * t * ((s + 1) * t + s) + 1; }
};
let _seq = 0;
// Cumulative mesh position offset and deformation per token (all channels are deltas from 0)
const activeOffsets = new Map(); // tokenId → { x, y, scaleX, scaleY, angle }
// Last mesh position and base scale written by us. Core (Token#_refreshPosition)
// overwrites mesh.position with the true token position on actor updates (e.g. HP change)
// and on every movement frame, wiping out visual offsets. Any discrepancy between
// mesh.position and this map signals that offset tracking is stale and must be re-anchored
// rather than subtracting the old delta.
const lastWritten = new Map(); // tokenId → { x, y, baseScaleX, baseScaleY }
// Animations on the same token run strictly sequentially so tickers never overlap
// on a single mesh and shared offset state.
const tokenQueues = new Map(); // tokenId → Promise
function getOffset(tokenId) {
    if (!activeOffsets.has(tokenId)) {
        activeOffsets.set(tokenId, { x: 0, y: 0, scaleX: 0, scaleY: 0, angle: 0 });
    }
    return activeOffsets.get(tokenId);
}
function isZeroOffset(offset) {
    return !offset
        || (offset.x === 0 && offset.y === 0 && offset.scaleX === 0 && offset.scaleY === 0 && offset.angle === 0);
}
function getWritten(token, tokenId, mesh, offset) {
    let written = lastWritten.get(tokenId);
    const curBaseX = token?._ssBaseScaleX ?? (mesh?.scale?.x ?? 1) / Math.max(0.15, 1 + (offset?.scaleX || 0));
    const curBaseY = token?._ssBaseScaleY ?? (mesh?.scale?.y ?? 1) / Math.max(0.15, 1 + (offset?.scaleY || 0));
    if (!written) {
        written = {
            x: mesh?.position?.x ?? 0,
            y: mesh?.position?.y ?? 0,
            baseScaleX: curBaseX,
            baseScaleY: curBaseY
        };
        lastWritten.set(tokenId, written);
    }
    else if ((offset?.scaleX || 0) === 0 && (offset?.scaleY || 0) === 0) {
        written.baseScaleX = token?._ssBaseScaleX ?? mesh?.scale?.x ?? written.baseScaleX;
        written.baseScaleY = token?._ssBaseScaleY ?? mesh?.scale?.y ?? written.baseScaleY;
    }
    return written;
}
/* ─── Deformation & Hit Flash ─── */
function applyDeformToMesh(token, mesh, written, offset) {
    const sx = 1 + (offset.scaleX || 0);
    const sy = 1 + (offset.scaleY || 0);
    const ang = offset.angle || 0;
    const js = token._ssJumpState;
    const ps = token._ssPerspState;
    if (js) {
        const perspScale = Number(token._ssPerspScale) || 1;
        if (js.baseScaleX != null && js.baseScaleY != null) {
            mesh.scale.set(js.baseScaleX * (js.scaleX ?? 1) * perspScale * Math.max(0.15, sx), js.baseScaleY * (js.scaleY ?? 1) * perspScale * Math.max(0.15, sy));
        }
        const baseAngle = token.document?.lockRotation ? 0 : (token.document?.rotation ?? 0);
        mesh.angle = baseAngle + (js.tiltAngle || 0) + ang;
    }
    else if (ps) {
        const pScale = Number(ps.scale) || 1;
        const bx = ps.baseScaleX ?? token._ssBaseScaleX ?? written.baseScaleX ?? 1;
        const by = ps.baseScaleY ?? token._ssBaseScaleY ?? written.baseScaleY ?? 1;
        mesh.scale.set(bx * pScale * Math.max(0.15, sx), by * pScale * Math.max(0.15, sy));
        const baseAngle = token.document?.lockRotation ? 0 : (token.document?.rotation ?? 0);
        mesh.angle = baseAngle + ang;
    }
    else {
        const bx = token._ssBaseScaleX ?? written.baseScaleX ?? mesh.scale.x;
        const by = token._ssBaseScaleY ?? written.baseScaleY ?? mesh.scale.y;
        mesh.scale.set(bx * Math.max(0.15, sx), by * Math.max(0.15, sy));
        const baseAngle = token.document?.lockRotation ? 0 : (token.document?.rotation ?? 0);
        mesh.angle = baseAngle + ang;
    }
}
function parseHexRgb(color) {
    if (typeof color === "number" && Number.isFinite(color)) {
        return [
            ((color >> 16) & 0xff) / 255,
            ((color >> 8) & 0xff) / 255,
            (color & 0xff) / 255
        ];
    }
    if (typeof color === "string") {
        const clean = color.trim().replace(/^#/, "");
        if (clean.length === 3) {
            return [
                parseInt(clean[0] + clean[0], 16) / 255,
                parseInt(clean[1] + clean[1], 16) / 255,
                parseInt(clean[2] + clean[2], 16) / 255
            ];
        }
        if (clean.length >= 6) {
            const n = parseInt(clean.slice(0, 6), 16);
            if (Number.isFinite(n)) {
                return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
            }
        }
    }
    return [1, 1, 1];
}
function flashMeshLocal({ tokenId, color = "#ffffff", duration = 90, intensity = 0.72 } = {}) {
    if (!canvas?.ready)
        return;
    const token = canvas.tokens?.get(tokenId);
    const mesh = token?.mesh;
    if (!token || !mesh || mesh.destroyed)
        return;
    let effIntensity = Math.max(0, Math.min(1, Number(intensity) || 0.72));
    try {
        if (canvas?.photosensitiveMode || game?.settings?.get?.("core", "photosensitiveMode")) {
            effIntensity = Math.min(0.25, effIntensity * 0.35);
        }
    }
    catch { /* ignore */ }
    if (effIntensity <= 0.01)
        return;
    const dur = Math.max(30, Number(duration) || 90);
    const [r, g, b] = parseHexRgb(color);
    // Native Foundry v14 token ring: softly flash the rim in the impact color
    if (token.ring?.enabled && typeof token.ring.flashColor === "function") {
        try {
            const cObj = foundry?.utils?.Color?.from ? foundry.utils.Color.from(color) : color;
            token.ring.flashColor(cObj, { duration: Math.round(dur * 1.6) });
        }
        catch { /* ignore */ }
    }
    const filter = new PIXI.ColorMatrixFilter();
    const applyStrength = (k) => {
        const boost = 1 + k * 1.15;
        const tintMix = k * 0.38;
        const keep = boost * (1 - tintMix * 0.35);
        filter.matrix = [
            keep, 0, 0, 0, r * tintMix,
            0, keep, 0, 0, g * tintMix,
            0, 0, keep, 0, b * tintMix,
            0, 0, 0, 1, 0
        ];
    };
    applyStrength(effIntensity);
    const prev = mesh.filters;
    mesh.filters = prev?.length ? [...prev, filter] : [filter];
    const startTime = performance.now();
    const effect = new CanvasEffect(`mesh-flash-${tokenId}-${++_seq}`, { tokenId });
    let cleaned = false;
    const cleanup = () => {
        if (cleaned)
            return;
        cleaned = true;
        if (mesh && !mesh.destroyed) {
            const next = mesh.filters?.filter((f) => f !== filter);
            mesh.filters = next?.length ? next : null;
        }
        filter.destroy?.();
    };
    const tick = () => {
        if (effect.stopped || mesh.destroyed || token.mesh !== mesh) {
            effect.complete();
            return;
        }
        const t = Math.min(1, (performance.now() - startTime) / dur);
        if (t >= 1) {
            effect.complete();
            return;
        }
        const decay = (1 - t) * (1 - t);
        applyStrength(effIntensity * decay);
    };
    effect.addDisposer(() => {
        canvas.app?.ticker?.remove(tick);
        cleanup();
    });
    canvas.app.ticker.add(tick);
}
/* ─── Per-Token Animation Queue & Tweening ─── */
/**
 * Enqueue a task on a token's animation queue so the next task starts only after
 * the previous one finishes (or is cancelled).
 */
function enqueueTokenTask(tokenId, fn) {
    const prev = tokenQueues.get(tokenId) ?? Promise.resolve();
    const task = prev.catch(() => { }).then(fn);
    tokenQueues.set(tokenId, task);
    // Swallow rejections on the fire-and-forget chain (raw socket handlers are not
    // awaited): a synchronous throw inside a task won't trigger an unhandled rejection,
    // while callers that explicitly await the returned promise still receive the error.
    task.catch(() => { }).finally(() => {
        if (tokenQueues.get(tokenId) === task)
            tokenQueues.delete(tokenId);
    });
    return task;
}
function enqueueMeshAnimation(data) {
    return enqueueTokenTask(data.tokenId, () => animateMeshLocal(data));
}
// Resets also go through the token queue: stopForToken inside resetMeshPosition resolves
// the active animation's done() — without queueing, the next queued task would start in
// a microtask CONCURRENTLY with the reset tween, causing two tickers to write to the same
// mesh and shared offset maps (activeOffsets/lastWritten) simultaneously.
function enqueueMeshReset(data) {
    return enqueueTokenTask(data.tokenId, () => resetMeshPosition(data.tokenId, data.duration ?? 0));
}
function animateMeshLocal(data) {
    const token = canvas.tokens.get(data.tokenId);
    // Token missing (deleted mid-animation) — clean up its maps, otherwise stale
    // {x, y} entries would linger until scene change (cleanup otherwise runs only on canvasTearDown)
    if (!token?.mesh) {
        activeOffsets.delete(data.tokenId);
        lastWritten.delete(data.tokenId);
        return Promise.resolve();
    }
    const { mesh } = token;
    const { props, options } = data;
    const tokenId = data.tokenId;
    const durationMs = options.duration || 500;
    const ease = MESH_EASING[options.easing] || MESH_EASING.linear;
    const offset = getOffset(tokenId);
    token._ssMeshAnimOffset = offset;
    const written = getWritten(token, tokenId, mesh, offset);
    // Normalize supported deltas: x, y, scale (uniform), scaleX, scaleY, angle
    const normProps = {};
    if (props?.x)
        normProps.x = Number(props.x) || 0;
    if (props?.y)
        normProps.y = Number(props.y) || 0;
    const uniScale = Number(props?.scale) || 0;
    const sxDelta = (Number(props?.scaleX) || 0) + uniScale;
    const syDelta = (Number(props?.scaleY) || 0) + uniScale;
    if (sxDelta)
        normProps.scaleX = sxDelta;
    if (syDelta)
        normProps.scaleY = syDelta;
    if (props?.angle)
        normProps.angle = Number(props.angle) || 0;
    const hasPosProps = Boolean(normProps.x || normProps.y);
    const hasDeformProps = Boolean(normProps.scaleX || normProps.scaleY || normProps.angle);
    // done() resolves on both natural completion (complete()) and cancellation
    // (stop(): stopForToken / canvasTearDown) — awaiting callers never hang.
    const effect = new CanvasEffect(`mesh-anim-${tokenId}-${++_seq}`, { tokenId });
    const startTime = performance.now();
    const startCenter = token.center ?? { x: mesh.position.x - offset.x, y: mesh.position.y - offset.y };
    const baseCenterX = startCenter.x;
    const baseCenterY = startCenter.y;
    const propKeys = Object.keys(normProps);
    if (propKeys.length === 0) {
        effect.complete();
        return effect.done();
    }
    const applied = Object.fromEntries(propKeys.map((k) => [k, 0]));
    const tick = () => {
        if (effect.stopped)
            return;
        // Mesh destroyed (token deleted) or recreated by core (texture change)
        // mid-animation: nowhere to write position, and throwing inside a ticker callback
        // would repeat every frame and permanently jam the token queue (done() would never
        // resolve). Drop the animation: zero out tracked offsets — the new mesh starts clean —
        // and complete the effect.
        if (mesh.destroyed || token.mesh !== mesh) {
            offset.x = 0;
            offset.y = 0;
            offset.scaleX = 0;
            offset.scaleY = 0;
            offset.angle = 0;
            lastWritten.delete(tokenId);
            effect.complete();
            return;
        }
        if (!token._ssJumpState && !token._ssPerspState && (mesh.position.x !== written.x || mesh.position.y !== written.y)) {
            const curCenter = token.center;
            const movedOnMap = Boolean(token._animation) || !curCenter
                || Math.abs(curCenter.x - baseCenterX) > 0.5
                || Math.abs(curCenter.y - baseCenterY) > 0.5;
            if (movedOnMap) {
                offset.x = 0;
                offset.y = 0;
                offset.scaleX = 0;
                offset.scaleY = 0;
                offset.angle = 0;
                applyDeformToMesh(token, mesh, written, offset);
                written.x = mesh.position.x;
                written.y = mesh.position.y;
                effect.complete();
                return;
            }
            mesh.position.x = curCenter.x + offset.x;
            mesh.position.y = curCenter.y + offset.y;
        }
        const elapsed = performance.now() - startTime;
        const tNorm = Math.min(elapsed / durationMs, 1);
        const eased = ease(tNorm);
        for (const k of propKeys) {
            const targetDelta = (normProps[k] ?? 0) * eased;
            const diff = targetDelta - applied[k];
            if (k === "x" || k === "y") {
                mesh.position[k] += diff;
            }
            offset[k] += diff;
            applied[k] = targetDelta;
        }
        if (hasDeformProps || offset.scaleX !== 0 || offset.scaleY !== 0 || offset.angle !== 0) {
            applyDeformToMesh(token, mesh, written, offset);
        }
        if (hasPosProps || (!token._ssJumpState && !token._ssPerspState)) {
            written.x = mesh.position.x;
            written.y = mesh.position.y;
        }
        if (tNorm >= 1) {
            // Snap tiny floating-point residuals near zero
            if (Math.abs(offset.scaleX) < 1e-5)
                offset.scaleX = 0;
            if (Math.abs(offset.scaleY) < 1e-5)
                offset.scaleY = 0;
            if (Math.abs(offset.angle) < 1e-4)
                offset.angle = 0;
            if (hasDeformProps)
                applyDeformToMesh(token, mesh, written, offset);
            effect.complete();
        }
    };
    effect.addDisposer(() => canvas.app.ticker.remove(tick));
    canvas.app.ticker.add(tick);
    return effect.done();
}
/**
 * Smoothly return a token's mesh position and deformation to zero over `duration` ms.
 * `duration = 0` resets immediately. Returns a completion promise — the token queue
 * awaits it so subsequent tasks never start on top of a running reset tween.
 */
function resetMeshPosition(tokenId, duration = 0) {
    const token = canvas.tokens.get(tokenId);
    if (!token?.mesh) {
        activeOffsets.delete(tokenId);
        lastWritten.delete(tokenId);
        return Promise.resolve();
    }
    // Cancel all active animations on this token (their done() promises resolve immediately)
    canvasEffects.stopForToken(tokenId);
    const { mesh } = token;
    const offset = activeOffsets.get(tokenId);
    if (isZeroOffset(offset))
        return Promise.resolve();
    token._ssMeshAnimOffset = offset;
    const written = getWritten(token, tokenId, mesh, offset);
    if (!token._ssJumpState && !token._ssPerspState && (mesh.position.x !== written.x || mesh.position.y !== written.y)) {
        const curCenter = token.center;
        const movedOnMap = Boolean(token._animation) || !curCenter;
        if (movedOnMap) {
            offset.x = 0;
            offset.y = 0;
            offset.scaleX = 0;
            offset.scaleY = 0;
            offset.angle = 0;
            applyDeformToMesh(token, mesh, written, offset);
            written.x = mesh.position.x;
            written.y = mesh.position.y;
            return Promise.resolve();
        }
        mesh.position.x = curCenter.x + offset.x;
        mesh.position.y = curCenter.y + offset.y;
    }
    if (duration <= 0) {
        mesh.position.x -= offset.x;
        mesh.position.y -= offset.y;
        offset.x = 0;
        offset.y = 0;
        offset.scaleX = 0;
        offset.scaleY = 0;
        offset.angle = 0;
        applyDeformToMesh(token, mesh, written, offset);
        written.x = mesh.position.x;
        written.y = mesh.position.y;
        return Promise.resolve();
    }
    const startX = offset.x;
    const startY = offset.y;
    const startSX = offset.scaleX;
    const startSY = offset.scaleY;
    const startAng = offset.angle;
    const startCenter = token.center ?? { x: mesh.position.x - offset.x, y: mesh.position.y - offset.y };
    const baseCenterX = startCenter.x;
    const baseCenterY = startCenter.y;
    const startTime = performance.now();
    const ease = MESH_EASING.easeOutCubic;
    const effect = new CanvasEffect(`mesh-reset-${tokenId}-${++_seq}`, { tokenId });
    const tick = () => {
        if (effect.stopped)
            return;
        if (mesh.destroyed || token.mesh !== mesh) {
            offset.x = 0;
            offset.y = 0;
            offset.scaleX = 0;
            offset.scaleY = 0;
            offset.angle = 0;
            lastWritten.delete(tokenId);
            effect.complete();
            return;
        }
        if (!token._ssJumpState && !token._ssPerspState && (mesh.position.x !== written.x || mesh.position.y !== written.y)) {
            const curCenter = token.center;
            const movedOnMap = Boolean(token._animation) || !curCenter
                || Math.abs(curCenter.x - baseCenterX) > 0.5
                || Math.abs(curCenter.y - baseCenterY) > 0.5;
            if (movedOnMap) {
                offset.x = 0;
                offset.y = 0;
                offset.scaleX = 0;
                offset.scaleY = 0;
                offset.angle = 0;
                applyDeformToMesh(token, mesh, written, offset);
                written.x = mesh.position.x;
                written.y = mesh.position.y;
                effect.complete();
                return;
            }
            mesh.position.x = curCenter.x + offset.x;
            mesh.position.y = curCenter.y + offset.y;
        }
        const tNorm = Math.min((performance.now() - startTime) / duration, 1);
        const eased = ease(tNorm);
        const rem = 1 - eased;
        const targetX = startX * rem;
        const targetY = startY * rem;
        const diffX = targetX - offset.x;
        const diffY = targetY - offset.y;
        mesh.position.x += diffX;
        mesh.position.y += diffY;
        offset.x = targetX;
        offset.y = targetY;
        offset.scaleX = startSX * rem;
        offset.scaleY = startSY * rem;
        offset.angle = startAng * rem;
        applyDeformToMesh(token, mesh, written, offset);
        written.x = mesh.position.x;
        written.y = mesh.position.y;
        if (tNorm >= 1) {
            mesh.position.x -= offset.x;
            mesh.position.y -= offset.y;
            offset.x = 0;
            offset.y = 0;
            offset.scaleX = 0;
            offset.scaleY = 0;
            offset.angle = 0;
            applyDeformToMesh(token, mesh, written, offset);
            written.x = mesh.position.x;
            written.y = mesh.position.y;
            effect.complete();
        }
    };
    effect.addDisposer(() => canvas.app.ticker.remove(tick));
    canvas.app.ticker.add(tick);
    return effect.done();
}
/* ─── Socket Handlers & Public API ─── */
Hooks.on('canvasTearDown', () => {
    canvasEffects.stopAll();
    activeOffsets.clear();
    lastWritten.clear();
    tokenQueues.clear();
});
// Animations are broadcast to other clients over the raw socket channel (which does not
// echo back to the sender). Locally the animation runs directly, and its promise resolves
// upon actual completion — allowing `await` to serialize choreography phases.
registerRawHandler("meshAnim", (data) => enqueueMeshAnimation(data));
registerRawHandler("meshReset", (data) => enqueueMeshReset(data));
registerRawHandler("meshFlash", (data) => flashMeshLocal(data));
Hooks.once("init", () => {
    registerAPI("meshAnim", {
        async animate(token, props, options = {}) {
            const tokenId = token?.id ?? token?.document?.id;
            if (!tokenId)
                return;
            const payload = { tokenId, props, options };
            if (!options.local)
                emitRaw("meshAnim", payload);
            return enqueueMeshAnimation(payload);
        },
        flash(token, options = {}) {
            const tokenId = token?.id ?? token?.document?.id;
            if (!tokenId)
                return;
            const payload = {
                tokenId,
                color: options.color ?? "#ffffff",
                duration: options.duration ?? 90,
                intensity: options.intensity ?? 0.72
            };
            if (!options.local)
                emitRaw("meshFlash", payload);
            flashMeshLocal(payload);
        },
        /** Reset token position and mesh deformation (`duration = 0` immediately, `> 0` smoothly).
         *  Queued per token: subsequent `animate` calls wait for the reset to complete.
         *  `local: true` skips raw broadcast (for systems that already run synchronously across clients). */
        async reset(token, duration = 0, options = {}) {
            const tokenId = token?.id ?? token?.document?.id;
            if (!tokenId)
                return;
            if (!options.local)
                emitRaw("meshReset", { tokenId, duration });
            return enqueueMeshReset({ tokenId, duration });
        }
    });
});
