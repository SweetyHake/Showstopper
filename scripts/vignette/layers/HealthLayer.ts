import { VIGNETTE_CONFIG } from "../config/VignetteConfig.js";

export class HealthLayer {
  declare _renderer; declare _override; declare _lastIntensity; declare _cfg; declare _animCfg;
  constructor(renderer) {
    this._renderer = renderer;
    this._override = null;
    this._lastIntensity = 0;
    this._cfg = VIGNETTE_CONFIG.HEALTH;
    this._animCfg = VIGNETTE_CONFIG.ANIMATION;
  }

  get overridden() { return this._override !== null; }

  init() {
    this._renderer.setGradient("health", this._cfg.color, this._cfg.size);
  }

  setOverride(ratio, options: any = {}) {
    this._override = Math.max(0, Math.min(1, ratio));
    const intensity = this._calcIntensity(this._override);
    this._applyIntensity(intensity, options.fadeIn ?? this._animCfg.healthTransition);
  }

  clearOverride() {
    this._override = null;
  }

  update(actor) {
    if (this._override !== null) return;
    if (!actor) {
      this._applyIntensity(0, this._animCfg.healthTransition);
      return;
    }

    const hp = actor.system?.attributes?.hp;
    if (!hp) {
      this._applyIntensity(0, this._animCfg.healthTransition);
      return;
    }

    if (hp.value <= 0) {
      this._applyIntensity(0, this._animCfg.healthTransition);
      return;
    }

    const ratio = hp.max > 0 ? hp.value / hp.max : 0;
    const intensity = this._calcIntensity(ratio);

    if (Math.abs(intensity - this._lastIntensity) < 0.001) return;

    this._applyIntensity(intensity, this._animCfg.healthTransition);
  }

  _calcIntensity(hpRatio) {
    const { threshold, exponent } = this._cfg;
    const maxOpacity = this._renderer.getLayerOpacity("health");
    if (hpRatio >= threshold) return 0;
    const normalized = (threshold - hpRatio) / threshold;
    return Math.pow(normalized, exponent) * maxOpacity;
  }

  _applyIntensity(intensity, duration) {
    this._lastIntensity = intensity;
    this._renderer.fadeTo("health", intensity, duration);
    const el = this._renderer._layers?.health?.el;
    if (el) {
      el.classList.toggle("ss-health-pulse", intensity > 0.01);
    }
  }

  destroy() {
    this._override = null;
    this._lastIntensity = 0;
  }
}