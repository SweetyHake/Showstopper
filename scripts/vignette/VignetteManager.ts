import { VignetteRenderer } from "./renderer/VignetteRenderer.js";
import { HealthLayer } from "./layers/HealthLayer.js";
import { StatusLayer } from "./layers/StatusLayer.js";
import { PopupLayer } from "./layers/PopupLayer.js";
import { VIGNETTE_CONFIG } from "./config/VignetteConfig.js";

export class VignetteManager {
  declare _renderer; declare _health; declare _status; declare _popup;
  declare _paused; declare _watchedActor; declare _hooks;
  constructor() {
    this._renderer = new VignetteRenderer();
    this._health = new HealthLayer(this._renderer);
    this._status = new StatusLayer(this._renderer);
    this._popup = new PopupLayer(this._renderer);
    this._paused = false;
    this._watchedActor = null;
    this._hooks = [];
  }

  init() {
    this._renderer.init();
    this._health.init();
    this._registerHooks();
    this._refreshWatchedActor();
  }

  _registerHooks() {
    const register = (hookName, fn) => {
      this._hooks.push({ hookName, id: Hooks.on(hookName, fn) });
    };

    register("dnd5e.applyDamage", (actor, amount, options) => {
      this._onDamage(actor, amount, options);
    });

    register("updateActor", (actor, changes) => {
      if (this._paused) return;
      if (!this._isWatched(actor)) return;
      if (foundry.utils.hasProperty(changes, "system.attributes.hp")) {
        this._health.update(actor);
      }
      if (changes.effects !== undefined || changes.statuses !== undefined) {
        this._status.update(actor);
      }
    });

    register("updateActorDelta", (delta, changes) => {
      if (this._paused) return;
      const actor = delta?.syntheticActor;
      if (!actor || !this._isWatched(actor)) return;
      if (foundry.utils.hasProperty(changes, "system.attributes.hp")) {
        this._health.update(actor);
      }
      if (changes.effects !== undefined || changes.statuses !== undefined) {
        this._status.update(actor);
      }
    });

    register("updateActiveEffect", (effect) => {
      if (this._paused) return;
      const actor = effect.parent;
      if (!actor || !this._isWatched(actor)) return;
      this._status.update(actor);
    });

    register("createActiveEffect", (effect) => {
      if (this._paused) return;
      const actor = effect.parent;
      if (!actor || !this._isWatched(actor)) return;
      this._status.update(actor);
    });

    register("deleteActiveEffect", (effect) => {
      if (this._paused) return;
      const actor = effect.parent;
      if (!actor || !this._isWatched(actor)) return;
      this._status.update(actor);
    });

    register("controlToken", () => {
      if (this._paused) return;
      this._refreshWatchedActor();
    });

    register("releaseToken", () => {
      if (this._paused) return;
      this._refreshWatchedActor();
    });

    // Scene transitions clear _watchedActor in canvasTearDown — without canvasReady,
    // the vignette would not reappear until a token was clicked even though
    // _resolveWatchedActor can fall back to game.user.character.
    register("canvasReady", () => {
      if (this._paused) return;
      this._refreshWatchedActor();
    });

    // Foundry v10+ has NO closeCanvas hook (canvas teardown/switch fires
    // canvasTearDown/canvasInit): the old callback was dead code and vignette
    // resets on scene close never ran.
    register("canvasTearDown", () => {
      this._watchedActor = null;
      // Layers are DOM elements and SURVIVE teardown: calling fadeTo("health", 0, 0)
      // directly left ss-health-pulse attached, running an infinite brightness CSS
      // animation on a fullscreen layer throughout the next scene. _applyIntensity(0, 0)
      // hides the layer, clears the pulse class, and resets _lastIntensity so the
      // epsilon guard in HealthLayer.update() won't swallow the first update on the new scene.
      this._health._applyIntensity(0, 0);
      // Symmetric status reset: StatusLayer.update() short-circuits on
      // `topStatus.id === this._activeStatusId` — without clearing the active id,
      // the same status on the next scene would not reappear (the layer is faded out
      // while still believing it is active). reset() also strips the status cssClass.
      this._status.reset();
      this._renderer.fadeTo("popup", 0, 0);
    });
  }

  _refreshWatchedActor() {
    const actor = this._resolveWatchedActor();
    this._watchedActor = actor;
    this._health.update(actor);
    this._status.update(actor);
  }

  _resolveWatchedActor() {
    if (!canvas?.tokens) return null;
    const controlled = canvas.tokens.controlled ?? [];
    if (controlled.length === 1) return controlled[0].actor ?? null;
    if (game.user?.character) return game.user.character;
    return null;
  }

  _isWatched(actor) {
    if (!this._watchedActor || !actor) return false;
    if (this._watchedActor.uuid && actor.uuid) {
      return this._watchedActor.uuid === actor.uuid;
    }
    return actor.id === this._watchedActor.id;
  }

  _onDamage(actor, amount, options) {
    if (this._paused) return;
    if (!this._isWatched(actor)) return;
    if (amount === 0) return;

    const maxHp = actor.system?.attributes?.hp?.max ?? 0;
    const cfg = VIGNETTE_CONFIG.POPUP;

    const isHeal = amount < 0;
    const hex = isHeal ? cfg.healColor : cfg.damageColor;
    const intensity = this._popup.calcIntensity(amount, maxHp);

    this._popup.trigger(hex, { intensity });
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
    this._refreshWatchedActor();
  }

  getState() {
    return {
      paused: this._paused,
      watchedActor: this._watchedActor?.id ?? null,
      health: {
        intensity: this._renderer.getOpacity("health"),
        overridden: this._health.overridden
      },
      status: {
        active: this._status.activeStatusId,
        overridden: this._status.overridden
      },
      popup: {
        active: this._popup.isActive()
      }
    };
  }

  get watchedActor() { return this._watchedActor; }
  getHealth() { return this._health; }
  getStatus() { return this._status; }
  getPopup() { return this._popup; }
  getRenderer() { return this._renderer; }

  destroy() {
    for (const { hookName, id } of this._hooks) {
      Hooks.off(hookName, id);
    }
    this._hooks = [];
    this._health.destroy();
    this._status.destroy();
    this._popup.destroy();
    this._renderer.destroy();
  }
}