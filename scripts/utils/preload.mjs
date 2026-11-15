import { MODULE_ID } from '../config.mjs';
import { registerSocketHandler } from '../core/socket-manager.mjs';
const CONCURRENCY = 4;
/**
 * Preload arbitrary asset URLs on the local client.
 * Shows a Foundry-style progress notification with a percentage bar.
 * @param {{sounds?: string[], images?: string[], videos?: string[]}} assets
 * @returns {Promise<void>}
 */
export async function preloadAssets({ sounds = [], images = [], videos = [] } = {}) {
    const tasks = [];
    for (const src of sounds)
        if (src)
            tasks.push({ kind: 'sound', src });
    for (const src of images)
        if (src)
            tasks.push({ kind: 'image', src });
    for (const src of videos)
        if (src)
            tasks.push({ kind: 'video', src });
    if (!tasks.length)
        return;
    const total = tasks.length;
    const progressLabel = () => game.i18n.format(`${MODULE_ID}.cut-ins.ui.preload.inProgress`, { done, total });
    let done = 0;
    const progress = ui.notifications?.info?.(progressLabel(), { progress: true }) ?? null;
    const tick = (src) => {
        done++;
        if (!progress)
            return;
        const name = String(src ?? '').split('/').pop() || '';
        progress.update({
            pct: done / total,
            message: name ? `${progressLabel()} — ${name}` : progressLabel()
        });
    };
    try {
        await runPool(tasks, CONCURRENCY, async ({ kind, src }) => {
            try {
                await _preloadOne(kind, src);
            }
            catch (e) {
                console.warn(`${MODULE_ID} | Preload failed`, kind, src, e);
            }
            tick(src);
        });
    }
    finally {
        if (progress) {
            progress.update({ pct: 1, message: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.preload.doneBar`) });
        }
    }
}
/**
 * Run tasks through a small worker pool so progress updates smoothly.
 */
async function runPool(items, limit, fn) {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}
async function _preloadOne(kind, src) {
    if (kind === 'sound')
        return _preloadSound(src);
    if (kind === 'video')
        return _preloadVideo(src);
    return _preloadImage(src);
}
async function _preloadSound(src) {
    try {
        if (foundry.audio?.AudioHelper?.preloadSound) {
            await foundry.audio.AudioHelper.preloadSound(src);
            return;
        }
    }
    catch (e) {
        console.warn(`${MODULE_ID} | Failed to preload sound`, src, e);
    }
    // Fallback: fetch into HTTP cache.
    try {
        await fetch(src, { method: 'GET' });
    }
    catch (_) { }
}
function _preloadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        const done = () => resolve();
        img.onload = done;
        img.onerror = () => {
            console.warn(`${MODULE_ID} | Failed to preload image`, src);
            resolve();
        };
        img.src = src;
    });
}
function _preloadVideo(src) {
    return new Promise((resolve) => {
        const v = document.createElement('video');
        v.preload = 'auto';
        v.muted = true;
        v.playsInline = true;
        let settled = false;
        const done = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(guard);
            // Abort any stalled download: otherwise the closure retains the element
            // and the notification progress bar stays stuck at an intermediate percentage
            try {
                v.pause();
                v.removeAttribute('src');
                v.load?.();
            }
            catch (e) { /* noop */ }
            resolve();
        };
        // Safety timeout: if neither canplaythrough/loadeddata nor error fires
        // (stalled network stream), settle anyway so the pool worker never hangs
        const guard = setTimeout(done, 20000);
        v.oncanplaythrough = done;
        v.onloadeddata = done;
        v.onerror = () => {
            console.warn(`${MODULE_ID} | Failed to preload video`, src);
            done();
        };
        v.src = src;
        // keep it off-DOM but still load
        v.load?.();
    });
}
registerSocketHandler('showstopperPreloadAssets', (assets) => preloadAssets(assets));
