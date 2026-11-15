const MODULE_ID = "showstopper";
const SK = "vignette";
// ─────────────────────────────────────────────────────────────────────────────
// Register vignette opacity settings
// ─────────────────────────────────────────────────────────────────────────────
export function registerVignetteSettings() {
    const hiddenNum = (key, def) => game.settings.register(MODULE_ID, `${SK}.${key}`, {
        scope: "client", config: false, type: Number, default: def
    });
    hiddenNum("opacity_health", 1.0);
    hiddenNum("opacity_status", 1.0);
    hiddenNum("opacity_popup", 1.0);
    game.settings.registerMenu(MODULE_ID, `${SK}.menu`, {
        // Raw i18n keys: core localizes name/label/hint on render
        // (game.i18n is unavailable here because registration runs before dictionaries load).
        name: `${MODULE_ID}.Vignette.MenuName`,
        label: `${MODULE_ID}.Vignette.MenuLabel`,
        hint: `${MODULE_ID}.Vignette.MenuHint`,
        icon: "fas fa-eye",
        type: VignetteConfig,
        restricted: false
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Config Application
// ─────────────────────────────────────────────────────────────────────────────
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;
class VignetteConfig extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "sst-vignette-cfg",
        classes: ["showstopper-app", "effect-settings-dialog"],
        tag: "form",
        form: { handler: VignetteConfig._submit, closeOnSubmit: true },
        // Raw i18n key: core localizes window.title automatically via ApplicationV2's
        // title getter. Calling localize HERE is invalid because static fields are
        // evaluated at module IMPORT time, before game.i18n exists.
        window: { title: `${MODULE_ID}.Vignette.ConfigTitle`, icon: "fas fa-eye" },
        position: { width: 440 }
    };
    static PARTS = {
        form: { template: `modules/${MODULE_ID}/templates/vignette-config.hbs` }
    };
    async _prepareContext() {
        return {
            opacity_health: getVignetteOpacity("health"),
            opacity_status: getVignetteOpacity("status"),
            opacity_popup: getVignetteOpacity("popup")
        };
    }
    static async _submit(event, form, formData) {
        const d = formData.object;
        for (const key of ["opacity_health", "opacity_status", "opacity_popup"]) {
            if (key in d)
                await game.settings.set(MODULE_ID, `${SK}.${key}`, Number(d[key]));
        }
        applyVignetteOpacities();
    }
    _onRender() {
        this.element.querySelectorAll(".sst-field-pair").forEach(group => {
            const range = group.querySelector('input[type="range"]');
            const num = group.querySelector('input[type="number"]');
            if (!range || !num)
                return;
            range.addEventListener("input", () => { num.value = range.value; });
            num.addEventListener("input", () => {
                const c = Math.max(+range.min, Math.min(+range.max, +num.value));
                range.value = c;
            });
            num.addEventListener("change", () => {
                num.value = Math.max(+range.min, Math.min(+range.max, +num.value));
                range.value = num.value;
            });
        });
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Getter
// ─────────────────────────────────────────────────────────────────────────────
export function getVignetteOpacity(key) {
    try {
        const v = game.settings.get(MODULE_ID, `${SK}.opacity_${key}`);
        return v !== null && v !== undefined ? v : 1.0;
    }
    catch {
        return 1.0;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Apply opacities to vignette layers
// Stores runtime opacities in VignetteRenderer and refreshes active layers.
// ─────────────────────────────────────────────────────────────────────────────
export function applyVignetteOpacities() {
    const mgr = window.showstopper?.vignette?._manager;
    if (!mgr)
        return;
    const renderer = mgr.getRenderer();
    renderer.setLayerOpacity("health", getVignetteOpacity("health"));
    renderer.setLayerOpacity("status", getVignetteOpacity("status"));
    renderer.setLayerOpacity("popup", getVignetteOpacity("popup"));
    const actor = mgr.watchedActor;
    try {
        mgr.getHealth()?.update(actor);
    }
    catch (e) {
        console.warn("Showstopper | health update in applyVignetteOpacities failed", e);
    }
    try {
        const statusLayer = mgr.getStatus();
        if (statusLayer?.activeStatusId) {
            renderer.fadeTo("status", renderer.getLayerOpacity("status"), 150);
        }
    }
    catch (e) {
        console.warn("Showstopper | status fade in applyVignetteOpacities failed", e);
    }
}
