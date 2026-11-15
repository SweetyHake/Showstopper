export class VignetteAPI {
  declare _manager;
  constructor(manager) {
    this._manager = manager;
  }

  async flash(hex, options: any = {}) {
    if (!this._isValidHex(hex)) {
      console.warn("Showstopper | vignette.flash: недопустимый hex цвет:", hex);
      return;
    }
    return this._manager.getPopup().trigger(hex, options);
  }

  async show(hex, options: any = {}) {
    if (!this._isValidHex(hex)) {
      console.warn("Showstopper | vignette.show: недопустимый hex цвет:", hex);
      return;
    }

    const layer = options.layer ?? "popup";
    const intensity = options.intensity ?? 0.7;
    const size = options.size ?? 0.35;
    const fadeIn = options.fadeIn ?? 500;
    const id = options.id ?? null;

    const renderer = this._manager.getRenderer();
    renderer.setGradient(layer, hex, size);
    renderer.setClass(layer, null);

    if (id) renderer.setLayerMeta(layer, "apiId", id);

    return renderer.fadeTo(layer, intensity, fadeIn);
  }

  async hide(options: any = {}) {
    const layer = options.layer ?? "popup";
    const fadeOut = options.fadeOut ?? 500;
    return this._manager.getRenderer().fadeTo(layer, 0, fadeOut);
  }

  setStatusOverride(statusId, options: any = {}) {
    this._manager.getStatus().setOverride(statusId, options);
  }

  clearStatusOverride() {
    this._manager.getStatus().clearOverride();
    this._manager.getStatus().update(this._manager.watchedActor);
  }

  setHealthOverride(ratio, options: any = {}) {
    this._manager.getHealth().setOverride(ratio, options);
  }

  clearHealthOverride() {
    this._manager.getHealth().clearOverride();
    this._manager.getHealth().update(this._manager.watchedActor);
  }

  pause() {
    this._manager.pause();
  }

  resume() {
    this._manager.resume();
  }

  getState() {
    return this._manager.getState();
  }

  _isValidHex(hex) {
    return typeof hex === "string" && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(hex);
  }
}