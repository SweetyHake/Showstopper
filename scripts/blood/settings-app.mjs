/**
 * Blood system settings window — standalone menu matching the style of other
 * module settings (HandlebarsApplicationMixin + form handler, like portraits).
 *
 * Markup uses standard Foundry classes (.form-group / .form-fields / .hint,
 * standard-form), with no custom styling aside from guaranteed content scrolling.
 * Values are read directly from FormData (checkbox = presence in FormData) and
 * saved via game.settings.set, firing registered onChange handlers (renderer
 * rebuild) so changes apply on the fly without a reload.
 *
 * GM-only (all fields are world-scoped). Opened via the button in the module
 * settings tab (bloodOpener stub) and the gear icon in the brush HUD.
 * The footer provides a test splat on the selected token and a scene-wide stain
 * clear button (with confirmation).
 */
import { MODULE_ID } from '../config.mjs';
import { parseColor } from './colors.mjs';
import { hasSnowAdapter } from './snow-bridge.mjs';
const L = (k) => game.i18n.localize(`showstopper.blood.settings.${k}`);
/** Form field key ('color') → registered setting key ('bloodColor'). */
const settingKey = (key) => `blood${key[0].toUpperCase()}${key.slice(1)}`;
const RENDER_SCALE_CHOICES = () => ({
    '0.25': L('renderScaleLow'),
    '0.5': L('renderScaleBalanced'),
    '0.75': L('renderScaleHigh'),
    '1': L('renderScaleUltra')
});
const SNOW_RATE_CHOICES = () => ({
    slow: L('snowRateSlow'),
    normal: L('snowRateNormal'),
    fast: L('snowRateFast')
});
const TONE_CHOICES = () => ({
    default: L('toneDefault'),
    grimdark: L('toneGrimdark'),
    family: L('toneFamily')
});
/** Window layout: sections → fields. Localization keys match setting keys. */
export const BLOOD_SETTING_SECTIONS = [
    {
        titleKey: 'sectionGeneral',
        icon: 'fas fa-droplet',
        fields: [
            { key: 'enabled', type: 'checkbox' },
            { key: 'color', type: 'color' },
            { key: 'violence', type: 'range', min: 1, max: 10, step: 1 },
            { key: 'threshold', type: 'range', min: 0, max: 100, step: 5 },
            { key: 'scale', type: 'range', min: 0.3, max: 3, step: 0.1 },
            { key: 'trail', type: 'checkbox' },
            { key: 'bleedStatus', type: 'checkbox' },
            { key: 'bleedInterval', type: 'range', min: 3, max: 30, step: 1 },
            { key: 'stationary', type: 'checkbox' },
            { key: 'deathPool', type: 'checkbox' },
            { key: 'footprints', type: 'checkbox' },
            { key: 'onlyInCombat', type: 'checkbox' },
            { key: 'wallsBlock', type: 'checkbox' }
        ]
    },
    {
        // time/environment/tone: previously mixed into General —
        // gameplay toggles sat next to cosmetics and performance
        titleKey: 'sectionSimulation',
        icon: 'fas fa-cloud-showers-heavy',
        fields: [
            { key: 'aging', type: 'checkbox' },
            { key: 'dryHours', type: 'range', min: 1, max: 168, step: 1 },
            { key: 'rainWash', type: 'checkbox' },
            { key: 'tone', type: 'select', choices: TONE_CHOICES },
            { key: 'damageProfiles', type: 'checkbox' },
            { key: 'backSplash', type: 'checkbox' },
            { key: 'castOff', type: 'checkbox' },
            { key: 'wallDrips', type: 'checkbox' }
        ]
    },
    {
        titleKey: 'sectionView',
        icon: 'fas fa-eye',
        fields: [
            { key: 'bloodied', type: 'checkbox' },
            { key: 'corpseImprints', type: 'checkbox' },
            { key: 'particles', type: 'checkbox' },
            { key: 'stepPuffs', type: 'checkbox' },
            { key: 'renderScale', type: 'select', choices: RENDER_SCALE_CHOICES }
        ]
    },
    {
        titleKey: 'sectionSnow',
        icon: 'fas fa-snowflake',
        fields: [
            { key: 'snowAccumulation', type: 'checkbox' },
            { key: 'snowRate', type: 'select', choices: SNOW_RATE_CHOICES },
            { key: 'snowThaw', type: 'checkbox' }
        ]
    },
    {
        titleKey: 'sectionColors',
        icon: 'fas fa-palette',
        fields: [
            { key: 'useBloodsheet', type: 'checkbox' },
            { key: 'creatureTypePath', type: 'text' },
            { key: 'creatureTypeCustomPath', type: 'text' }
        ]
    },
    {
        titleKey: 'sectionPaths',
        icon: 'fas fa-code',
        fields: [
            { key: 'hpPath', type: 'text' },
            { key: 'hpMaxPath', type: 'text' },
            { key: 'useWounds', type: 'checkbox' }
        ]
    }
];
/** Save handler: read values directly from FormData and write only changed settings. */
async function submitSettings(event, form) {
    const raw = new FormData(form);
    const activeSections = BLOOD_SETTING_SECTIONS.filter(s => s.titleKey !== 'sectionSnow' || hasSnowAdapter());
    for (const section of activeSections) {
        for (const f of section.fields) {
            const key = settingKey(f.key);
            let value;
            switch (f.type) {
                case 'checkbox':
                    value = raw.has(f.key); // checked checkbox is present in FormData
                    break;
                case 'range':
                    value = Number(raw.get(f.key));
                    break;
                default:
                    value = String(raw.get(f.key) ?? '');
            }
            if (f.type === 'color' && !parseColor(value))
                continue; // skip malformed color
            const current = game.settings.get(MODULE_ID, key);
            if (JSON.stringify(value) !== JSON.stringify(current)) {
                await game.settings.set(MODULE_ID, key, value);
            }
        }
    }
}
export class BloodSettingsApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'blood-settings',
        tag: 'form',
        classes: ['showstopper-app', 'effect-settings-dialog', 'ss-blood-settings'],
        window: {
            icon: 'fa-solid fa-droplet',
            resizable: false
        },
        position: {
            width: 540,
            height: 'auto'
        },
        form: {
            handler: submitSettings,
            closeOnSubmit: true
        }
    };
    static PARTS = {
        form: {
            template: `modules/${MODULE_ID}/templates/blood-settings.hbs`
        }
    };
    get title() {
        return L('menuTitle');
    }
    /** Open singleton settings window. GM only. */
    static show() {
        if (!game.user.isGM) {
            ui.notifications.warn(L('gmOnly'));
            return null;
        }
        // v14: ApplicationV2 registers in foundry.applications.instances
        // (ui.windows holds V1 Applications only); bring to front via bringToFront()
        const existing = foundry.applications?.instances?.get?.('blood-settings');
        if (existing?.bringToFront) {
            existing.bringToFront();
            return existing;
        }
        return new BloodSettingsApp().render(true);
    }
    async _prepareContext() {
        const activeSections = BLOOD_SETTING_SECTIONS.filter(s => s.titleKey !== 'sectionSnow' || hasSnowAdapter());
        const sections = activeSections.map(section => ({
            title: L(section.titleKey),
            icon: section.icon,
            fields: section.fields.map(f => {
                const value = game.settings.get(MODULE_ID, settingKey(f.key));
                const def = { ...f, label: L(f.key), hint: L(`${f.key}Hint`), value };
                if (f.type === 'color') {
                    const parsed = parseColor(value) ?? parseColor('#a51414d8');
                    def.rgb = `#${[parsed.r, parsed.g, parsed.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
                }
                if (f.type === 'select' && typeof f.choices === 'function')
                    def.choices = f.choices();
                return def;
            })
        }));
        return {
            sections,
            saveLabel: L('save'),
            testLabel: L('testButton'),
            testHint: L('testButtonHint'),
            clearLabel: L('clearAll')
        };
    }
    _onRender(context, options) {
        super._onRender?.(context, options);
        const root = this.element;
        // live slider value readouts
        root.querySelectorAll('input[type="range"]').forEach(inp => {
            const span = root.querySelector(`[data-preview="${inp.name}"]`);
            const update = () => { if (span)
                span.textContent = inp.value; };
            inp.addEventListener('input', update);
            update();
        });
        // test splat: applies the CURRENT form (saves) and fires a splat on the
        // selected token — closes the tuning loop without real combat
        root.querySelector('[data-act="test"]')?.addEventListener('click', async () => {
            try {
                await submitSettings(new Event('test'), root);
            }
            catch { /* noop */ }
            const sel = canvas.tokens?.controlled?.[0];
            if (!sel) {
                ui.notifications.warn(L('testNoToken'));
                return;
            }
            globalThis.showstopper?.blood?.splat?.(sel, { impact: 0.7 });
        });
        // clear scene of all stains (blood/mud/snow) — with confirmation
        root.querySelector('[data-act="clear"]')?.addEventListener('click', async () => {
            const count = globalThis.showstopper?.blood?.stats?.().stains ?? 0;
            const yes = await foundry.applications.api.DialogV2.confirm({
                window: { title: L('clearTitle') },
                content: `<p>${L('clearConfirm').replace('{count}', String(count))}</p>`
            });
            if (!yes)
                return;
            globalThis.showstopper?.blood?.clear?.();
        });
        // color swatch ↔ hex8 (alpha preserved from text input)
        const swatch = root.querySelector('[data-swatch="color"]');
        const hex = root.querySelector('[name="color"]');
        if (swatch && hex) {
            const toHex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            swatch.addEventListener('input', () => {
                const parsed = parseColor(hex.value) ?? { a: 0.85 };
                hex.value = swatch.value + toHex2(parsed.a * 255);
            });
            hex.addEventListener('change', () => {
                const parsed = parseColor(hex.value);
                if (parsed)
                    swatch.value = `#${toHex2(parsed.r)}${toHex2(parsed.g)}${toHex2(parsed.b)}`;
            });
        }
    }
}
