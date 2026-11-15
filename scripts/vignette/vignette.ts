import { VignetteManager } from "./VignetteManager.js";
import { VignetteAPI } from "./api/VignetteAPI.js";
import { registerVignetteSettings, applyVignetteOpacities } from "./VignetteSettings.js";
import { registerAPI, unregisterAPI } from "../core/runtime.mjs";

let _manager = null;
let _api = null;

Hooks.once("init", () => {
  registerVignetteSettings();
});

Hooks.once("ready", () => {
    _manager = new VignetteManager();
    _manager.init();

    _api = new VignetteAPI(_manager);

    registerAPI("vignette", _api);

    console.log("Showstopper | Vignette инициализирован");

    // Apply saved opacities after initialization
    setTimeout(() => { try { applyVignetteOpacities(); } catch (e) { console.warn("Showstopper | vignette: applyVignetteOpacities failed", e); } }, 0);
});

export function destroyVignette() {
  if (_manager) {
    _manager.destroy();
    _manager = null;
    _api = null;
    unregisterAPI("vignette");
  }
}
