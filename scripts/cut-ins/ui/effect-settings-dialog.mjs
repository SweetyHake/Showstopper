import { MODULE_ID } from '../../config.mjs';
import { resolveLocalizableText } from '../base-effect.mjs';
import { getEffectSettings, setEffectSettings, resetEffectSettings } from '../utils/effect-settings.mjs';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export class EffectSettingsDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "effect-settings-{id}",
        // showstopper-app: branded window chrome (centered title, 8px scrollbars,
        // focus ring, dark/light themes via --ss-* tokens)
        classes: ["showstopper-app", "effect-settings-dialog"],
        position: { width: 480, height: "auto" },
        window: {
            icon: "fa-solid fa-sliders",
            resizable: false
        },
        actions: {
            save: this.#onSave,
            reset: this.#onReset,
            browseSound: this.#onBrowseSound,
            browseImage: this.#onBrowseImage,
            browseVideo: this.#onBrowseVideo,
            previewSound: this.#onPreviewSound
        }
    };
    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/effect-settings.hbs` }
    };
    #effect = null;
    #previewSound = null;
    #previewBtn = null;
    constructor(effect, options = {}) {
        const id = `effect-settings-${effect.id}`;
        super({ ...options, id });
        this.#effect = effect;
    }
    get effect() {
        return this.#effect;
    }
    get title() {
        return game.i18n.format(`${MODULE_ID}.cut-ins.ui.effectSettings.titleFor`, {
            name: this.#effect.getName()
        });
    }
    /**
     * Normalizes any user color input to #rrggbb: native input[type=color] rejects
     * hex8 (#rrggbbaa), 0xRRGGBB (reverting to black), and shorthand #rgb.
     * Alpha is stripped — limitation of the native color input.
     */
    static #normalizeHex(value) {
        if (typeof value !== 'string')
            return '#000000';
        let v = value.trim();
        if (/^0[xX]/.test(v))
            v = '#' + v.slice(2);
        if (v && !v.startsWith('#'))
            v = '#' + v;
        if (/^#[0-9a-fA-F]{3}$/.test(v)) {
            v = '#' + [...v.slice(1)].map(c => c + c).join('');
        }
        if (/^#[0-9a-fA-F]{8}$/.test(v))
            v = v.slice(0, 7);
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#000000';
    }
    async _prepareContext() {
        const settings = getEffectSettings(this.#effect.id);
        const schema = this.#effect.getSettingsSchema();
        const defaults = this.#effect.getDefaultSettings();
        const fields = schema.map(field => {
            let value = settings[field.name] ?? defaults[field.name] ?? field.default;
            if (field.type === 'color')
                value = this.constructor.#normalizeHex(value);
            // Schemas may declare select options as choices: {value: label}, whereas
            // the template expects options: [{value, label}] (otherwise the dropdown is empty)
            let options = field.options;
            if (!options && field.choices) {
                options = Object.entries(field.choices)
                    .map(([v, l]) => ({ value: v, label: resolveLocalizableText(l, String(l)) }));
            }
            else if (Array.isArray(options)) {
                options = options.map(opt => ({
                    ...opt,
                    label: resolveLocalizableText(opt.label, String(opt.value))
                }));
            }
            const defaultSoundPlaceholder = field.name === 'soundPath'
                ? (this.#effect.defaultSoundPath ?? '')
                : null;
            return {
                ...field,
                label: resolveLocalizableText(field.label, field.name),
                hint: field.hint != null ? resolveLocalizableText(field.hint, '') : '',
                rows: field.rows ?? 3,
                value,
                options: options ?? [],
                placeholder: defaultSoundPlaceholder || defaults[field.name] || field.default || ''
            };
        });
        const commonFields = fields.filter(f => f.group === 'common' || !f.group);
        const uniqueFields = fields.filter(f => f.group === 'unique');
        const L = (key) => game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.${key}`);
        return {
            effectId: this.#effect.id,
            effectName: this.#effect.getName(),
            effectIcon: this.#effect.icon,
            commonFields,
            uniqueFields,
            hasUniqueFields: uniqueFields.length > 0,
            labels: {
                common: L('commonSettings'),
                unique: L('uniqueSettings'),
                // Flat core keys "Save"/"Reset" don't exist — localize() returned the raw key,
                // leaving the buttons untranslated
                save: L('save'),
                reset: L('reset'),
                browse: L('browse'),
                previewSound: L('previewSound'),
                defaultHint: L('defaultHint')
            }
        };
    }
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        // Range sliders: live readout in .field-value next to the slider (native title
        // tooltip isn't visible while dragging) — matches the blood settings dialog pattern
        html.querySelectorAll('.range-field').forEach(field => {
            const range = field.querySelector('input[type="range"]');
            if (!range)
                return;
            const output = field.querySelector('.field-value');
            const format = (val) => {
                if (range.name === 'soundVolume')
                    return `${Math.round(val * 100)}%`;
                if (range.step && parseFloat(range.step) < 1)
                    return `${val}`;
                return `${Math.round(val)}`;
            };
            const update = () => {
                const val = parseFloat(range.value);
                if (Number.isNaN(val))
                    return;
                range.title = format(val);
                if (output)
                    output.textContent = format(val);
            };
            update();
            range.addEventListener('input', update);
        });
        // Color field: two-way sync between the color swatch picker and hex text input
        // (previously the hex input was readonly and unlinked)
        html.querySelectorAll('.color-field').forEach(field => {
            const color = field.querySelector('input[type="color"]');
            const hex = field.querySelector('.color-hex');
            if (!color || !hex)
                return;
            color.addEventListener('input', () => { hex.value = color.value; });
            hex.addEventListener('change', () => {
                color.value = this.constructor.#normalizeHex(hex.value);
                hex.value = color.value;
            });
        });
        const volumeRange = html.querySelector('input[name="soundVolume"]');
        if (volumeRange) {
            volumeRange.addEventListener('input', () => {
                if (this.#previewSound) {
                    try {
                        const interfaceVolume = game.settings.get("core", "globalInterfaceVolume") ?? 0.5;
                        this.#previewSound.volume = parseFloat(volumeRange.value) * interfaceVolume;
                    }
                    catch (e) { }
                }
            });
        }
    }
    static async #onSave(event, target) {
        // World setting — GM only; previously non-GMs got a false "saved" notification
        if (!game.user.isGM) {
            ui.notifications.error(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.gmOnly`));
            return;
        }
        const form = this.element.querySelector('form');
        // Global FormDataExtended is deprecated in v14 (removed in v15):
        // canonical path is foundry.applications.ux.*
        const formData = new foundry.applications.ux.FormDataExtended(form);
        const data = formData.object;
        const settings = {};
        const schema = this.#effect.getSettingsSchema();
        for (const field of schema) {
            let value = data[field.name];
            if (field.type === 'number' || field.type === 'range') {
                // FormDataExtended returns null for an empty number input: treat as "keep
                // previous value" rather than 0 (Number(null) === 0 used to clamp to min)
                if (value === '' || value === undefined || value === null)
                    continue;
                const n = Number(value);
                // Ignore non-numeric input; clamp out-of-range values to schema min/max
                if (!Number.isFinite(n))
                    continue;
                value = (field.min !== undefined || field.max !== undefined)
                    ? Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n))
                    : n;
            }
            else if (field.type === 'checkbox') {
                value = !!value;
            }
            else if (field.type === 'color') {
                value = value ? this.constructor.#normalizeHex(value) : (value === undefined ? null : '');
            }
            else if (field.type === 'text' || field.type === 'textarea' || field.type === 'sound' || field.type === 'image' || field.type === 'video') {
                // Empty string = EXPLICIT clear: store '' (not null), otherwise a saved
                // value could never be cleared; consumers using `settings.x || default`
                // fall back cleanly to their default
                value = typeof value === 'string' ? value.trim() : null;
            }
            if (value !== null && value !== undefined) {
                settings[field.name] = value;
            }
        }
        let ok = false;
        try {
            ok = await setEffectSettings(this.#effect.id, settings);
        }
        catch (e) {
            console.error(`${MODULE_ID} | Failed to save effect settings`, e);
        }
        if (!ok) {
            ui.notifications.error(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.saveFailed`));
            return;
        }
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.saved`));
        this.close();
    }
    static async #onReset(event, target) {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.resetConfirmTitle`) },
            content: `<p>${game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.resetConfirmContent`)}</p>`
        });
        if (!confirmed)
            return;
        let ok = false;
        try {
            ok = await resetEffectSettings(this.#effect.id);
        }
        catch (e) {
            console.error(`${MODULE_ID} | Failed to reset effect settings`, e);
        }
        if (!ok) {
            ui.notifications.error(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.saveFailed`));
            return;
        }
        // Re-rendering doesn't go through close() — stop any active sound preview
        this.#stopPreview();
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.resetDone`));
        this.render();
    }
    static #onBrowseSound(event, target) {
        const fieldName = target.dataset.field;
        const input = this.element.querySelector(`[name="${fieldName}"]`);
        const fp = new FilePicker({
            type: "audio",
            current: input?.value || "",
            callback: (path) => {
                if (input)
                    input.value = path;
            }
        });
        fp.browse();
    }
    static #onBrowseImage(event, target) {
        const fieldName = target.dataset.field;
        const input = this.element.querySelector(`[name="${fieldName}"]`);
        const fp = new FilePicker({
            type: "image",
            current: input?.value || "",
            callback: (path) => {
                if (input)
                    input.value = path;
            }
        });
        fp.browse();
    }
    static #onBrowseVideo(event, target) {
        const fieldName = target.dataset.field;
        const input = this.element.querySelector(`[name="${fieldName}"]`);
        const fp = new FilePicker({
            type: "imagevideo",
            current: input?.value || "",
            callback: (path) => {
                if (input)
                    input.value = path;
            }
        });
        fp.browse();
    }
    /** Restores the sound preview button icon to "play". */
    #resetPreviewBtn() {
        if (this.#previewBtn)
            this.#previewBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        this.#previewBtn = null;
    }
    /** Stops the playing preview sound and resets the button icon (on close or re-render). */
    #stopPreview() {
        if (this.#previewSound) {
            this.#previewSound.stop();
            this.#previewSound = null;
        }
        this.#resetPreviewBtn();
    }
    static async #onPreviewSound(event, target) {
        const fieldName = target.dataset.field;
        const input = this.element.querySelector(`[name="${fieldName}"]`);
        const soundPath = input?.value || (fieldName === 'soundPath' ? this.#effect.defaultSoundPath : '');
        // Reset the stop icon on the REMEMBERED button: there may be two sound fields
        // (common + unique), and clicking stop on the other used to leave the first showing "stop"
        if (this.#previewSound) {
            this.#stopPreview();
            return;
        }
        if (!soundPath) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.noSoundSelected`));
            return;
        }
        try {
            const volumeRange = this.element.querySelector('input[name="soundVolume"]');
            const volume = volumeRange ? parseFloat(volumeRange.value) : 0.8;
            const interfaceVolume = game.settings.get("core", "globalInterfaceVolume") ?? 0.5;
            this.#previewSound = await foundry.audio.AudioHelper.play({
                src: soundPath,
                volume: volume * interfaceVolume,
                autoplay: true,
                loop: false
            }, false);
            this.#previewBtn = target;
            target.innerHTML = '<i class="fa-solid fa-stop"></i>';
            this.#previewSound.on('end', () => {
                this.#previewSound = null;
                this.#resetPreviewBtn();
            });
        }
        catch (e) {
            ui.notifications.error(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.soundError`));
        }
    }
    async close(options = {}) {
        this.#stopPreview();
        return super.close(options);
    }
    static show(effect) {
        const existingId = `effect-settings-${effect.id}`;
        // ui.windows in v14 is ApplicationV1 only — V2 registry is instances
        const existing = foundry.applications.instances.get(existingId);
        if (existing) {
            existing.bringToTop();
            return existing;
        }
        const dialog = new EffectSettingsDialog(effect);
        dialog.render(true);
        return dialog;
    }
}
