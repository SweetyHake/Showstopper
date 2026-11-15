import { VIGNETTE_CONFIG } from "../config/VignetteConfig.js";

export class StatusLayer {
  declare _renderer; declare _override; declare _activeStatusId; declare _cfg;
  declare _animCfg; declare _statusCfg; declare _transitioning;
  declare _pendingStatusDef; declare _gen; declare _sortedStatuses;
  constructor(renderer) {
    this._renderer = renderer;
    this._override = null;
    this._activeStatusId = null;
    this._cfg = VIGNETTE_CONFIG.STATUS_VIGNETTES;
    this._animCfg = VIGNETTE_CONFIG.ANIMATION;
    this._statusCfg = VIGNETTE_CONFIG.STATUS;
    this._transitioning = false;
    this._pendingStatusDef = null;
    this._gen = 0;
    this._sortedStatuses = [...this._cfg].sort((a, b) => a.priority - b.priority);
  }

  get overridden() { return this._override !== null; }
  get activeStatusId() { return this._activeStatusId; }

  setOverride(statusId, options: any = {}) {
    const statusDef = this._cfg.find(s => s.id === statusId);
    if (!statusDef) return;
    this._override = statusId;
    this._applyStatus(statusDef, options.fadeIn ?? this._animCfg.statusFadeIn);
  }

  clearOverride() {
    this._override = null;
  }

  async update(actor) {
    if (this._override !== null) return;
    if (!actor) {
      this._clearStatus();
      return;
    }

    const activeEffects = actor.statuses ?? new Set();
    const topStatus = this._sortedStatuses
      .find(s => activeEffects.has(s.id));

    if (!topStatus) {
      if (this._activeStatusId !== null) this._clearStatus();
      return;
    }

    if (topStatus.id === this._activeStatusId) return;

    this._pendingStatusDef = topStatus;
    if (this._transitioning) return;

    await this._processQueue();
  }

  async _processQueue() {
    this._transitioning = true;
    try {
      while (this._pendingStatusDef) {
        const def = this._pendingStatusDef;
        this._pendingStatusDef = null;
        await this._transitionTo(def);
      }
    } finally {
      this._transitioning = false;
    }
  }

  async _transitionTo(statusDef) {
    // Transition generation guard: calling reset() mid-fadeOut parks the coroutine
    // on the renderer's fallback timer — without checking _gen it would wake up and
    // call _applyStatus, resurrecting the OLD scene's status on the new scene.
    const gen = this._gen;
    if (this._activeStatusId !== null) {
      await this._renderer.fadeTo("status", 0, this._animCfg.statusFadeOut);
      if (gen !== this._gen) return;
    }

    this._applyStatus(statusDef, this._animCfg.statusFadeIn);
  }

  _applyStatus(statusDef, fadeIn) {
    this._activeStatusId = statusDef.id;
    this._renderer.setGradient("status", statusDef.color, statusDef.size ?? this._statusCfg.defaultSize);
    this._renderer.setClass("status", statusDef.cssClass);
    this._renderer.fadeTo("status", this._renderer.getLayerOpacity("status"), fadeIn);
  }

  _clearStatus() {
    this._activeStatusId = null;
    this._renderer.setClass("status", null);
    this._renderer.fadeTo("status", 0, this._animCfg.statusFadeOut);
  }

  /**
   * Immediate layer reset (canvasTearDown): the layer DOM element SURVIVES scene
   * changes, and update() short-circuits on `topStatus.id === this._activeStatusId`
   * — without clearing _activeStatusId, the same status on the new scene would not
   * reappear (the layer is faded out while still believing it is active). Also strips
   * the status cssClass and discards any queued transition from the old scene.
   */
  reset() {
    // Increment generation to invalidate parked _transitionTo coroutines (see above).
    this._gen++;
    this._activeStatusId = null;
    this._pendingStatusDef = null;
    this._renderer.setClass("status", null);
    this._renderer.fadeTo("status", 0, 0);
    // An active API override survives scene changes along with the layer —
    // re-apply its visuals (otherwise update() always returns early on
    // _override !== null, leaving the layer dark until manual clearStatusOverride()).
    if (this._override !== null) {
      const def = this._cfg.find(s => s.id === this._override);
      if (def) this._applyStatus(def, this._animCfg.statusFadeIn);
    }
  }

  destroy() {
    this._override = null;
    this._activeStatusId = null;
    this._pendingStatusDef = null;
    this._transitioning = false;
  }
}