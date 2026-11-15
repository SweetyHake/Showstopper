import { VIGNETTE_CONFIG } from "../config/VignetteConfig.js";
export class PopupLayer {
    constructor(renderer) {
        this._renderer = renderer;
        this._animCfg = VIGNETTE_CONFIG.ANIMATION;
        this._popupCfg = VIGNETTE_CONFIG.POPUP;
        this._activeTimer = null;
        // Resolver for an in-flight hold promise: destroy/hide during hold previously
        // cleared the timer WITHOUT resolving its promise — hanging the trigger coroutine
        // (and any caller awaiting flash()) forever and leaking its closure until reload.
        this._activeResolve = null;
        this._isActive = false;
        // Trigger generation token: an interrupted trigger coroutine resuming after awaits
        // would otherwise reach `this._isActive = false` AFTER a newer trigger already set
        // it to true, leaving isActive() === false throughout the new popup's lifetime.
        this._triggerGen = 0;
    }
    isActive() {
        return this._isActive;
    }
    /** Cancel the hold timer AND resolve its promise so trigger() finishes cleanly. */
    _cancelHold() {
        if (this._activeTimer) {
            clearTimeout(this._activeTimer);
            this._activeTimer = null;
        }
        if (this._activeResolve) {
            const resolve = this._activeResolve;
            this._activeResolve = null;
            resolve();
        }
    }
    calcIntensity(amount, maxHp) {
        const minOpacity = this._popupCfg.minOpacity;
        const maxOpacity = this._renderer.getLayerOpacity("popup");
        if (!maxHp || maxHp <= 0)
            return minOpacity;
        const ratio = Math.min(Math.abs(amount) / maxHp, 1.0);
        return minOpacity + (maxOpacity - minOpacity) * ratio;
    }
    async trigger(hex, options = {}) {
        const gen = ++this._triggerGen;
        const intensity = options.intensity ?? this._popupCfg.minOpacity;
        const size = options.size ?? this._popupCfg.defaultSize;
        const fadeIn = options.fadeIn ?? this._animCfg.popupFadeIn;
        const fadeOut = options.fadeOut ?? this._animCfg.popupFadeOut;
        const duration = options.duration ?? this._animCfg.popupDuration;
        if (this._activeTimer) {
            this._cancelHold();
            await this._renderer.fadeTo("popup", 0, 50);
            if (gen !== this._triggerGen)
                return;
        }
        this._isActive = true;
        this._renderer.setGradient("popup", hex, size);
        this._renderer.setClass("popup", null);
        await this._renderer.fadeTo("popup", intensity, fadeIn);
        if (gen !== this._triggerGen)
            return;
        const holdTime = Math.max(0, duration - fadeIn - fadeOut);
        await new Promise(resolve => {
            this._activeResolve = resolve;
            this._activeTimer = setTimeout(() => {
                this._activeTimer = null;
                this._activeResolve = null;
                resolve();
            }, holdTime);
        });
        // A newer trigger may have started while we waited: bail out so we don't
        // clobber its gradient/timers or clear _isActive on the newer popup.
        if (gen !== this._triggerGen)
            return;
        await this._renderer.fadeTo("popup", 0, fadeOut);
        if (gen !== this._triggerGen)
            return;
        this._isActive = false;
        this._activeTimer = null;
    }
    destroy() {
        this._cancelHold();
        this._isActive = false;
    }
    async hide(options = {}) {
        const gen = this._triggerGen;
        this._cancelHold();
        const fadeOut = options.fadeOut ?? this._animCfg.popupFadeOut;
        await this._renderer.fadeTo("popup", 0, fadeOut);
        // A newer trigger may have started during our fade-out (already setting
        // _isActive = true) — do not clear a newer popup's active flag.
        if (gen !== this._triggerGen)
            return;
        this._isActive = false;
    }
}
