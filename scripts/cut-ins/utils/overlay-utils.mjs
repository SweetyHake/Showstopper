import { MODULE_ID } from '../../config.mjs';
import { BaseEffect } from '../base-effect.mjs';
import { introQueue } from '../intro-queue.mjs';
import { stopAllSynthSounds } from './sound-synth.mjs';
const activeOverlays = new Set();
/**
 * Force-close all active intro overlays on scene teardown.
 * Otherwise overlays linger in the DOM, keydown listeners leak,
 * and introQueue stays permanently blocked.
 */
Hooks.on('canvasTearDown', () => {
    for (const close of [...activeOverlays]) {
        try {
            close(false);
        }
        catch (e) {
            console.error(`${MODULE_ID} | intro overlay teardown close failed`, e);
        }
    }
    activeOverlays.clear();
});
export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/**
 * Creates a fullscreen intro DOM overlay with a unified lifecycle:
 *  - unique id (randomID instead of Date.now)
 *  - click-to-close (after clickDelay) and Escape-to-close
 *  - optional auto-close after autoCloseDelay (0 = disabled)
 *  - listener cleanup, DOM removal, and single-shot onClose invocation
 *  - global registry tracking (canvasTearDown closes everything)
 *
 * @param {object} opts
 * @param {string} opts.html               Root overlay HTML markup
 * @param {number} [opts.clickDelay=1500]  Delay before clicks are accepted (ms)
 * @param {number} [opts.autoCloseDelay=0] Auto-close delay in ms
 * @param {string} [opts.closeClass='']    Closing animation CSS class
 * @param {number} [opts.fadeMs=600]       Closing animation duration in ms
 * @param {Function} [opts.onClose]        Close callback (e.g. introQueue.complete + resolve)
 * @returns {{ overlay: HTMLElement, close: (animate?: boolean) => void }}
 */
export function createIntroOverlay({ html, clickDelay = 1500, autoCloseDelay = 0, closeClass = '', fadeMs = 600, onClose = null }) {
    const container = document.createElement('div');
    container.innerHTML = html;
    const overlay = container.firstElementChild;
    if (!overlay) {
        throw new Error('createIntroOverlay: html must produce a root element');
    }
    overlay.id = `intro-${foundry.utils.randomID()}`;
    document.body.appendChild(overlay);
    let closed = false;
    let closing = false;
    let canClick = false;
    let clickTimer = null;
    let autoCloseTimer = null;
    let fadeTimer = null;
    const finish = () => {
        if (closed)
            return;
        closed = true;
        closing = true;
        clearTimeout(clickTimer);
        clearTimeout(autoCloseTimer);
        clearTimeout(fadeTimer);
        document.removeEventListener('keydown', escHandler);
        overlay.remove();
        activeOverlays.delete(close);
        // Overlay is closing — stop any playing intro sound so it doesn't keep playing
        // orphaned (previously the handle was lost via fire-and-forget BaseEffect.playSound)
        try {
            BaseEffect.stopIntroSound();
        }
        catch (e) { /* noop */ }
        try {
            stopAllSynthSounds();
        }
        catch (e) { /* noop */ }
        if (typeof onClose === 'function') {
            try {
                onClose();
            }
            catch (e) {
                console.error(`${MODULE_ID} | intro onClose failed`, e);
            }
        }
    };
    const close = (animate = true) => {
        if (closed)
            return;
        if (!animate || !closeClass) {
            finish();
            return;
        }
        if (closing)
            return;
        closing = true;
        clearTimeout(autoCloseTimer);
        overlay.classList.add(closeClass);
        fadeTimer = setTimeout(finish, fadeMs);
    };
    const clickHandler = (e) => {
        if (!canClick) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        close();
    };
    const escHandler = (e) => {
        if (e.key === 'Escape')
            close();
    };
    overlay.addEventListener('click', clickHandler);
    document.addEventListener('keydown', escHandler);
    clickTimer = setTimeout(() => {
        canClick = true;
    }, clickDelay);
    if (autoCloseDelay > 0) {
        autoCloseTimer = setTimeout(() => close(), autoCloseDelay);
    }
    activeOverlays.add(close);
    introQueue.setCurrentCleanup(() => close(false));
    return { overlay, close };
}
