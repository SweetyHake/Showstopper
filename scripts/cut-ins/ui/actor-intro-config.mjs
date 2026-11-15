import { MODULE_ID } from '../../config.mjs';
import { effectRegistry } from '../registry.mjs';
import { getActorDisplayName, getActorDisplayPortrait, getActorIntroTitle, getActorIntroDescription } from '../utils/actor-intro-data.mjs';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export class ActorIntroConfigDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "actor-intro-config-{id}",
        classes: ["showstopper-app", "effect-settings-dialog", "actor-intro-config"],
        position: { width: 520, height: "auto" },
        window: {
            icon: "fa-solid fa-clapperboard",
            resizable: false
        },
        actions: {
            save: this.#onSave,
            reset: this.#onReset,
            browsePortrait: this.#onBrowsePortrait,
            previewIntro: this.#onPreviewIntro
        }
    };
    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/actor-intro-config.hbs` }
    };
    #actor = null;
    constructor(actor, options = {}) {
        const id = `actor-intro-config-${actor.id}`;
        super({ ...options, id });
        this.#actor = actor;
    }
    get actor() {
        return this.#actor;
    }
    get title() {
        return game.i18n.format(`${MODULE_ID}.cut-ins.ui.config.titleFor`, { name: this.#actor.name });
    }
    async _prepareContext() {
        const flags = this.#actor.flags[MODULE_ID] || {};
        const mockActor = {
            ...this.#actor,
            getFlag: () => null,
            system: this.#actor.system,
            isOwner: this.#actor.isOwner
        };
        const [defaultTitle, defaultDesc] = await Promise.all([
            getActorIntroTitle(mockActor),
            getActorIntroDescription(mockActor)
        ]);
        const defaultName = getActorDisplayName({ ...mockActor, name: this.#actor.name });
        const defaultPortrait = getActorDisplayPortrait({
            ...this.#actor,
            getFlag: (scope, key) => scope === 'dnd5e' ? this.#actor.getFlag(scope, key) : null
        });
        const portraitSrc = flags.introPortrait || defaultPortrait;
        const currentEffectId = flags.introEffectId || '';
        const introEffects = effectRegistry.getByCategory('introductions')
            .filter(cls => cls.isAvailable)
            .map(cls => ({
            id: cls.id,
            name: cls.getName(),
            selected: cls.id === currentEffectId
        }));
        return {
            introEffectId: currentEffectId,
            introEffects,
            displayName: flags.introDisplayName || '',
            portrait: flags.introPortrait || '',
            portraitPreviewSrc: portraitSrc,
            title: flags.introTitle || '',
            description: flags.introDescription || '',
            portraitOffsetX: flags.introPortraitOffsetX ?? 0,
            portraitOffsetY: flags.introPortraitOffsetY ?? 0,
            portraitScale: flags.introPortraitScale ?? 1,
            defaults: {
                displayName: defaultName,
                portrait: defaultPortrait,
                title: defaultTitle || game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.noTitleFound`),
                description: defaultDesc ? (defaultDesc.substring(0, 100) + (defaultDesc.length > 100 ? '...' : '')) : game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.noDescriptionFound`)
            },
            labels: {
                sectionStyle: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.sectionStyle`),
                sectionText: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.sectionText`),
                introEffect: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.introEffect`),
                introEffectAuto: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.introEffectAuto`),
                preview: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.preview`),
                browse: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.browse`),
                displayName: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.displayName`),
                portrait: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.portrait`),
                portraitOffsetX: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.portraitOffsetX`),
                portraitOffsetY: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.portraitOffsetY`),
                portraitScale: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.portraitScale`),
                title: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.title`),
                description: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.labels.description`),
                save: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.save`),
                reset: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.effectSettings.reset`),
                defaultHint: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.defaultHint`)
            }
        };
    }
    static async #onPreviewIntro(event, target) {
        const actor = this.#actor;
        if (!actor)
            return;
        const select = this.element?.querySelector('[name="introEffectId"]');
        const chosenId = select?.value || 'hero-intro';
        const EffectClass = effectRegistry.get(chosenId)
            || effectRegistry.getByCategory('introductions').find(c => c.isAvailable);
        if (!EffectClass)
            return;
        await EffectClass.execute({ actor, localOnly: true });
    }
    static async #onSave(event, target) {
        const form = this.element.querySelector('form');
        const formData = new foundry.applications.ux.FormDataExtended(form);
        const data = formData.object;
        const updates = {};
        updates[`flags.${MODULE_ID}.introEffectId`] = data.introEffectId?.trim() || null;
        updates[`flags.${MODULE_ID}.introDisplayName`] = data.displayName?.trim() || null;
        updates[`flags.${MODULE_ID}.introPortrait`] = data.portrait?.trim() || null;
        updates[`flags.${MODULE_ID}.introTitle`] = data.title?.trim() || null;
        updates[`flags.${MODULE_ID}.introDescription`] = data.description?.trim() || null;
        updates[`flags.${MODULE_ID}.introPortraitOffsetX`] = data.portraitOffsetX != null ? Number(data.portraitOffsetX) : null;
        updates[`flags.${MODULE_ID}.introPortraitOffsetY`] = data.portraitOffsetY != null ? Number(data.portraitOffsetY) : null;
        updates[`flags.${MODULE_ID}.introPortraitScale`] = data.portraitScale != null ? Number(data.portraitScale) : null;
        await this.#actor.update(updates);
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.saved`));
        this.close();
    }
    static async #onReset(event, target) {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.resetConfirmTitle`) },
            content: `<p>${game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.resetConfirmContent`)}</p>`
        });
        if (!confirmed)
            return;
        await this.#actor.unsetFlag(MODULE_ID, 'introEffectId');
        await this.#actor.unsetFlag(MODULE_ID, 'introDisplayName');
        await this.#actor.unsetFlag(MODULE_ID, 'introPortrait');
        await this.#actor.unsetFlag(MODULE_ID, 'introTitle');
        await this.#actor.unsetFlag(MODULE_ID, 'introDescription');
        await this.#actor.unsetFlag(MODULE_ID, 'introPortraitOffsetX');
        await this.#actor.unsetFlag(MODULE_ID, 'introPortraitOffsetY');
        await this.#actor.unsetFlag(MODULE_ID, 'introPortraitScale');
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.resetDone`));
        this.render();
    }
    static #onBrowsePortrait(event, target) {
        const currentPath = this.element.querySelector('[name="portrait"]')?.value || this.#actor.img;
        const fp = new FilePicker({
            type: "image",
            current: currentPath,
            callback: (path) => {
                const input = this.element.querySelector('[name="portrait"]');
                if (input) {
                    input.value = path;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        });
        fp.browse();
    }
    _onRender(context, options) {
        super._onRender(context, options);
        const previewImg = this.element.querySelector('.portrait-preview-img');
        const portraitInput = this.element.querySelector('[name="portrait"]');
        const offsetXInput = this.element.querySelector('[name="portraitOffsetX"]');
        const offsetYInput = this.element.querySelector('[name="portraitOffsetY"]');
        const scaleInput = this.element.querySelector('[name="portraitScale"]');
        const updatePortraitSrc = () => {
            if (!previewImg)
                return;
            const src = portraitInput?.value || portraitInput?.placeholder;
            if (src)
                previewImg.src = src;
        };
        const updateTransform = () => {
            if (!previewImg)
                return;
            const ox = parseFloat(offsetXInput?.value ?? 0);
            const oy = parseFloat(offsetYInput?.value ?? 0);
            const sc = parseFloat(scaleInput?.value ?? 1);
            previewImg.style.translate = (ox !== 0 || oy !== 0) ? `${ox}% ${oy}%` : '';
            previewImg.style.scale = sc !== 1 ? `${sc}` : '';
        };
        const refreshRangeDisplay = (input) => {
            const span = input?.parentElement?.querySelector('.range-value');
            if (span) {
                const val = parseFloat(input.value);
                const suffix = input.name === 'portraitScale' ? 'x' : '%';
                span.textContent = val + suffix;
            }
        };
        [offsetXInput, offsetYInput, scaleInput].forEach(input => {
            if (!input)
                return;
            input.addEventListener('input', () => {
                refreshRangeDisplay(input);
                updateTransform();
            });
        });
        if (portraitInput) {
            portraitInput.addEventListener('input', updatePortraitSrc);
        }
        updatePortraitSrc();
        updateTransform();
    }
    static show(actor) {
        const existingId = `actor-intro-config-${actor.id}`;
        const existing = foundry.applications.instances.get(existingId);
        if (existing) {
            existing.bringToTop();
            return existing;
        }
        const dialog = new ActorIntroConfigDialog(actor);
        dialog.render(true);
        return dialog;
    }
}
