import { MODULE_ID, FALLBACK_IMAGE, localize, isRealImage, resolveCharacterImage } from './constants.mjs';
export class PortraitModuleSettings extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "portrait-module-settings",
        classes: ["showstopper-app", "effect-settings-dialog"],
        tag: "form",
        window: {
            title: "showstopper.Settings.MenuTitle",
            icon: "fas fa-cogs",
            resizable: false
        },
        position: {
            width: 460,
            height: "auto"
        },
        form: {
            handler: PortraitModuleSettings.formHandler,
            closeOnSubmit: true
        }
    };
    static PARTS = {
        form: {
            template: `modules/${MODULE_ID}/templates/module-settings.hbs`
        }
    };
    get title() {
        return localize("showstopper.Settings.MenuTitle");
    }
    async _prepareContext() {
        return {
            enabled: game.settings.get(MODULE_ID, "enabled"),
            portraitSize: game.settings.get(MODULE_ID, "portraitSize"),
            showStats: game.settings.get(MODULE_ID, "showStats"),
            speakingShake: game.settings.get(MODULE_ID, "speakingShake"),
            sizeOptions: {
                xs: localize("showstopper.Settings.PortraitSize.XS"),
                small: localize("showstopper.Settings.PortraitSize.Small"),
                medium: localize("showstopper.Settings.PortraitSize.Medium"),
                large: localize("showstopper.Settings.PortraitSize.Large"),
                xl: localize("showstopper.Settings.PortraitSize.XL")
            }
        };
    }
    static async formHandler(event, form, formData) {
        const data = foundry.utils.expandObject(formData.object);
        const wasEnabled = game.settings.get(MODULE_ID, "enabled");
        await game.settings.set(MODULE_ID, "enabled", data.enabled);
        await game.settings.set(MODULE_ID, "portraitSize", data.portraitSize);
        await game.settings.set(MODULE_ID, "showStats", data.showStats);
        await game.settings.set(MODULE_ID, "speakingShake", data.speakingShake);
        // Enable/disable panel on the fly without reloading the page.
        if (data.enabled !== wasEnabled) {
            game.modules.get(MODULE_ID)?.api?.setEnabled?.(data.enabled);
        }
        const instance = game.modules.get(MODULE_ID)?.api?.instance;
        if (instance) {
            instance.applyPortraitSize();
            instance._applySpeakingShake();
            if (data.showStats) {
                instance._createStatsWidget();
                instance._updateStatsWidget();
                instance.voiceMode?.refresh();
            }
            else {
                // Remove the widget BEFORE the final syncControls: refresh while the widget
                // is alive does NOT migrate buttons to the standalone pill — _ensureHost returns
                // the widget host (and removes the pill). The AV controls node becomes detached
                // along with the widget; the final syncControls detects the loss (node is neither
                // in app.element nor in the DOM) and requests a recovery render of part "controls"
                // from core — renderCameraViews then adopts the fresh node into the standalone pill.
                instance.voiceMode?.refresh();
                document.getElementById("dvp-stats-widget")?.remove();
                instance.voiceMode?.syncControls?.();
            }
        }
    }
}
export class PortraitSettingsApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "portrait-settings-{id}",
        classes: ["showstopper-app", "effect-settings-dialog"],
        tag: "form",
        window: {
            title: "showstopper.Portrait.SettingsTitle",
            icon: "fas fa-user-circle",
            resizable: false
        },
        position: {
            width: 460,
            height: "auto"
        },
        form: {
            handler: PortraitSettingsApp.formHandler,
            closeOnSubmit: true
        }
    };
    static PARTS = {
        form: {
            template: `modules/${MODULE_ID}/templates/portrait-settings.hbs`
        }
    };
    constructor(user, options = {}) {
        const opts = foundry.utils.mergeObject(options, {
            id: `portrait-settings-${user.id}`
        });
        super(opts);
        this.user = user;
        this.actor = user.character;
    }
    get title() {
        const name = this.actor?.name || this.user.name;
        return localize("showstopper.Portrait.SettingsTitleFor", { name });
    }
    async _prepareContext() {
        const flags = this.actor
            ? (this.actor.getFlag(MODULE_ID, "portrait") || this.user.getFlag(MODULE_ID, "portrait") || {})
            : (this.user.getFlag(MODULE_ID, "portrait") || {});
        const discordRelayAvailable = !!(game.modules.get("discord-relay")?.active);
        const hasCharacter = !!this.actor;
        // Determine available display modes
        const modes = [];
        if (hasCharacter)
            modes.push("character");
        if (discordRelayAvailable)
            modes.push("discord");
        modes.push("user");
        // Default mode: character if has one, discord if relay available, else user
        let defaultMode;
        if (hasCharacter)
            defaultMode = "character";
        else if (discordRelayAvailable)
            defaultMode = "discord";
        else
            defaultMode = "user";
        const displayMode = flags.displayMode || defaultMode;
        // Compute the default display name based on selected mode
        let defaultDisplayName;
        if (displayMode === "character" && this.actor) {
            defaultDisplayName = this.actor.name;
        }
        else if (displayMode === "discord" && discordRelayAvailable) {
            const instance = game.modules.get(MODULE_ID)?.api?.instance;
            const discord = instance?.discordUserData?.get(this.user.id);
            defaultDisplayName = discord?.username || this.user.name;
        }
        else {
            defaultDisplayName = this.user.name;
        }
        const defaultPreviewImage = resolveCharacterImage(this.actor)
            ?? (isRealImage(this.user?.avatar) ? this.user.avatar : null)
            ?? FALLBACK_IMAGE;
        return {
            user: this.user,
            actor: this.actor,
            defaultDisplayName,
            customDisplayName: flags.customDisplayName || "",
            idleImage: flags.idleImage || "",
            speakingImage: flags.speakingImage || "",
            idlePreviewSrc: flags.idleImage || defaultPreviewImage,
            speakingPreviewSrc: flags.speakingImage || defaultPreviewImage,
            displayMode,
            modes,
            hasCharacter,
            discordRelayAvailable
        };
    }
    static async formHandler(event, form, formData) {
        try {
            const data = foundry.utils.expandObject(formData.object);
            const flagData = {
                idleImage: data.idleImage || null,
                speakingImage: data.speakingImage || null,
                displayMode: data.displayMode || null,
                customDisplayName: data.customDisplayName || null
            };
            const target = this.actor || this.user;
            await target.setFlag(MODULE_ID, "portrait", flagData);
            const instance = game.modules.get(MODULE_ID)?.api?.instance;
            if (instance) {
                instance.displayModeOverrides.set(this.user.id, flagData.displayMode || "character");
                const userData = instance.userData.get(this.user.id);
                if (userData) {
                    instance._applyDisplayToElement(this.user.id, instance._resolveDisplay(userData));
                }
                instance.renderPortraits?.();
            }
        }
        catch (err) {
            console.error(`${MODULE_ID} | Failed to save portrait settings:`, err);
            ui.notifications.error(localize("showstopper.Notifications.SaveFailed"));
        }
    }
    _onRender() {
        this.element.querySelectorAll(".dvp-file-picker").forEach(btn => {
            btn.addEventListener("click", this._onFilePicker.bind(this));
        });
        this.element.querySelectorAll(".dvp-reset-field").forEach(btn => {
            btn.addEventListener("click", this._onResetField.bind(this));
        });
        this.element.querySelectorAll('.dvp-mode-btn input[type="radio"]').forEach(radio => {
            radio.addEventListener("change", () => {
                this.element.querySelectorAll(".dvp-mode-btn").forEach(btn => btn.classList.remove("active"));
                radio.closest(".dvp-mode-btn")?.classList.add("active");
            });
        });
    }
    async _onFilePicker(event) {
        try {
            const target = event.currentTarget.dataset.target;
            const input = this.element.querySelector(`input[name="${target}"]`);
            const preview = this.element.querySelector(`img[data-target="${target}"]`);
            const fp = new FilePicker({
                type: "image",
                current: input.value,
                callback: (path) => {
                    input.value = path;
                    if (preview)
                        preview.src = path;
                }
            });
            fp.browse();
        }
        catch (err) {
            console.error(`${MODULE_ID} | FilePicker error:`, err);
        }
    }
    _onResetField(event) {
        const target = event.currentTarget.dataset.target;
        const input = this.element.querySelector(`input[name="${target}"]`);
        const preview = this.element.querySelector(`img[data-target="${target}"]`);
        // Reset to the REAL default: character portrait (or prototype token art),
        // then user avatar; placeholder fallback is the last resort
        const defaultImage = resolveCharacterImage(this.actor)
            ?? (isRealImage(this.user?.avatar) ? this.user.avatar : null)
            ?? FALLBACK_IMAGE;
        if (input)
            input.value = "";
        if (preview)
            preview.src = defaultImage;
    }
}
