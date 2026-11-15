import { MODULE_ID } from '../../config.mjs';
import { resolveLocalizableText } from '../base-effect.mjs';
import { effectRegistry } from '../index.mjs';
import { EffectSettingsDialog } from './effect-settings-dialog.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CinemaMenuDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cinema-menu-dialog",
    classes: ["showstopper-app"],
    // 520px: all four tab labels ("Introductions" .. "Finishers") fit in full —
    // at 420px long localized labels pushed the last tab out of the window
    position: { width: 520, height: 520 },
    window: { 
      title: "showstopper.cut-ins.ui.menuTitle",
      icon: "fa-solid fa-film",
      resizable: false
    },
    actions: {
      // `this` === the class inside a static initializer; writing CinemaMenuDialog.#x
      // makes tsc emit a `var _a` pattern that breaks on static fields
      switchTab: this.#onSwitchTab,
      playEffect: this.#onPlayEffect,
      previewEffect: this.#onPreviewEffect,
      openSettings: this.#onOpenSettings,
      clearSearch: this.#onClearSearch
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/cinema-menu.hbs` }
  };

  // Last active tab persists across window close/reopen (in-memory, no setting)
  static #lastTab: string | null = null;

  #currentTab = CinemaMenuDialog.#lastTab ?? 'introductions';
  #searchQuery = '';
  #effectMeta = new Map();

  async _prepareContext() {
    const effects = {};
    this.#effectMeta.clear();
    for (const [category, effectClasses] of Object.entries(effectRegistry.getAll()) as any[]) {
      effects[category] = effectClasses.map(EffectClass => {
        const item = {
          id: EffectClass.id,
          icon: EffectClass.icon,
          enabled: EffectClass.enabled,
          isAvailable: EffectClass.isAvailable,
          hasSettings: EffectClass.hasSettings,
          name: EffectClass.getName(),
          description: EffectClass.getDescription(),
          hint: EffectClass.getHint()
        };
        this.#effectMeta.set(item.id, { name: item.name, description: item.description });
        return item;
      });
    }

    const categoryDefs = effectRegistry.getCategories().filter(cat => {
      if (!cat.hideWhenEmpty) return true;
      return (effects[cat.id]?.length ?? 0) > 0;
    });

    if (categoryDefs.length > 0 && !categoryDefs.some(c => c.id === this.#currentTab)) {
      this.#currentTab = categoryDefs[0].id;
      CinemaMenuDialog.#lastTab = this.#currentTab;
    } else if (CinemaMenuDialog.#lastTab === null && (effects[this.#currentTab]?.length ?? 0) === 0) {
      const firstPopulated = categoryDefs.find(c => (effects[c.id]?.length ?? 0) > 0);
      if (firstPopulated) this.#currentTab = firstPopulated.id;
    }

    const tabs = categoryDefs.map(cat => {
      const i18nFallbackKey = `${MODULE_ID}.cut-ins.ui.tabs.${cat.id}`;
      const label = cat.label != null
        ? resolveLocalizableText(cat.label, cat.id)
        : (game.i18n.has(i18nFallbackKey) ? game.i18n.localize(i18nFallbackKey) : cat.id);
      return {
        id: cat.id,
        icon: cat.icon || 'fa-solid fa-film',
        label,
        active: this.#currentTab === cat.id,
        _def: cat
      };
    });

    const defaultEmptyText = game.i18n.localize(`${MODULE_ID}.cut-ins.ui.noEffects`);

    // Tab sections: category effect cards + empty-state metadata.
    // The template loops over sections, so any registered category gets a tab automatically.
    const sections = tabs.map(tab => {
      const cards = effects[tab.id] ?? [];
      const def = tab._def;
      const needsTarget = typeof def.needsTarget === 'function'
        ? Boolean(def.needsTarget())
        : Boolean(def.needsTarget);
      const targetHint = needsTarget
        ? resolveLocalizableText(def.targetHint, '')
        : '';
      const emptyText = def.emptyText != null
        ? resolveLocalizableText(def.emptyText, defaultEmptyText)
        : defaultEmptyText;
      return {
        id: tab.id,
        icon: tab.icon,
        label: tab.label,
        active: tab.active,
        cards,
        hasCards: cards.length > 0,
        emptyText,
        needsTarget,
        targetHint
      };
    });

    return {
      currentTab: this.#currentTab,
      tabs,
      sections,
      effects,
      searchPlaceholder: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.searchPlaceholder`),
      searchNoResults: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.searchNoResults`),
      clearSearchLabel: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.clearSearch`),
      emptyText: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.noEffects`),
      playLabel: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.play`),
      settingsLabel: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.settings`),
      previewLabel: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.preview`)
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);

    // Restore input value without attaching per-render listeners: typing is
    // routed by the document-level listener (see Hooks.once('ready') below).
    const input = this.element.querySelector('#ss-menu-search-input');
    if (input) input.value = this.#searchQuery;

    // Arrow-key tab navigation (ARIA tabs pattern)
    const tabBar = this.element.querySelector('.tab-bar');
    if (tabBar && !tabBar.dataset.arrowsBound) {
      tabBar.dataset.arrowsBound = '1';
      tabBar.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const btns = [...tabBar.querySelectorAll('.tab-btn')];
        const idx = btns.findIndex(b => b.dataset.tab === this.#currentTab);
        const step = e.key === 'ArrowRight' ? 1 : btns.length - 1;
        btns[(idx + step) % btns.length]?.click();
      });
    }

    this.#updateTabVisibility();
    this.#applySearch(this.#searchQuery);
  }

  /**
   * Public entry point for the document-level search listener. Attached once
   * at module ready, so search works regardless of the render lifecycle.
   * @param {string} query
   */
  _ssApplySearch(query) {
    this.#applySearch(query);
  }

  /** Public search clear helper (Escape inside field, clear X button). */
  _ssClearSearch() {
    const input = this.element?.querySelector('#ss-menu-search-input');
    if (input) input.value = '';
    this.#applySearch('');
    input?.focus();
  }

  // Normalize Russian yo/ye on both sides so queries match regardless of diacritics
  static #normSearch(s) {
    return (s ?? '').toLowerCase().replaceAll('ё', 'е');
  }

  #applySearch(query) {
    this.#searchQuery = query;
    const element = this.element;
    if (!element) return;

    const q = CinemaMenuDialog.#normSearch(query.trim());
    const counts = new Map();

    // Filter ALL tabs: when the active tab has no hits, we can show hints for
    // tabs that do have matches; hiding cards on inactive tabs is harmless
    // (the tab list itself is display:none) and survives tab switches
    element.querySelectorAll('.effect-list').forEach(list => {
      let visible = 0;
      list.querySelectorAll('.effect-card').forEach(card => {
        const id = card.dataset.effectId || card.querySelector('[data-effect-id]')?.dataset.effectId;
        const meta = this.#effectMeta.get(id);
        const hit = !q || (meta && (
          CinemaMenuDialog.#normSearch(meta.name).includes(q)
          || CinemaMenuDialog.#normSearch(meta.description).includes(q)
          || CinemaMenuDialog.#normSearch(id).includes(q)
        ));
        card.classList.toggle('hidden', !hit);
        if (hit) visible++;
      });
      counts.set(list.dataset.tab, visible);
    });

    const visible = counts.get(this.#currentTab) ?? 0;

    const empty = element.querySelector('.search-empty');
    if (empty) {
      const showHints = q && visible === 0;
      empty.classList.toggle('hidden', !showHints);
      const tabsBox = empty.querySelector('.search-empty-tabs');
      if (tabsBox) {
        tabsBox.innerHTML = '';
        if (showHints) {
          element.querySelectorAll('.tab-btn').forEach(btn => {
            const count = counts.get(btn.dataset.tab) ?? 0;
            if (!count) return;
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.action = 'switchTab';
            b.dataset.tab = btn.dataset.tab;
            const label = document.createElement('span');
            label.textContent = btn.querySelector('span')?.textContent ?? btn.dataset.tab;
            const num = document.createElement('span');
            num.className = 'count';
            num.textContent = String(count);
            b.append(label, num);
            tabsBox.append(b);
          });
        }
      }
    }

    const clearBtn = element.querySelector('.ss-menu-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !q);

    if (q && CONFIG?.debug?.showstopper) {
      console.debug(`${MODULE_ID} | Menu search "${q}" ->`, Object.fromEntries(counts));
    }
  }

  #updateTabVisibility() {
    const element = this.element;
    if (!element) return;

    element.querySelectorAll('.effect-list').forEach(list => {
      list.classList.toggle('active', list.dataset.tab === this.#currentTab);
    });

    element.querySelectorAll('.tab-btn').forEach(tab => {
      const active = tab.dataset.tab === this.#currentTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
  }

  static #onClearSearch() {
    this._ssClearSearch();
  }

  static #onOpenSettings(event, target) {
    const effectId = target.dataset.effectId;
    const effect = effectRegistry.get(effectId);

    if (!effect) {
      console.warn(`${MODULE_ID} | Effect not found: ${effectId}`);
      return;
    }

    EffectSettingsDialog.show(effect);
  }

  /**
   * Shared double-click guard: disables the button with a spinner until the promise settles.
   * Without this, double-clicking Play triggered the effect twice (queueing a
   * second finisher run across all clients).
   */
  static async #runWithButton(btn, fn) {
    if (!btn || btn.disabled) return false;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
      await fn();
      return true;
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  static #onSwitchTab(event, target) {
    const tabId = target.dataset.tab;
    if (tabId && tabId !== (this as unknown as CinemaMenuDialog).#currentTab) {
      (this as unknown as CinemaMenuDialog).#currentTab = tabId;
      CinemaMenuDialog.#lastTab = tabId;
      (this as unknown as CinemaMenuDialog).#updateTabVisibility();
      (this as unknown as CinemaMenuDialog).#applySearch((this as unknown as CinemaMenuDialog).#searchQuery);
      // Scroll the newly selected tab back to the top
      const area = this.element.querySelector('.content-area');
      if (area) area.scrollTop = 0;
    }
  }

  static async #onPreviewEffect(event, target) {
    const effectId = target.dataset.effectId;
    const effect = effectRegistry.get(effectId);
    if (!effect) {
      console.warn(`${MODULE_ID} | Effect not found: ${effectId}`);
      return;
    }
    if (!effect.isAvailable) {
      if (!effect.enabled) {
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.comingSoon`));
      } else {
        ui.notifications.warn(effect.getHint());
      }
      return;
    }
    await (this.constructor as unknown as typeof CinemaMenuDialog).#runWithButton(target, () =>
      effect.preview ? effect.preview() : effect.execute()
    );
  }

  static async #onPlayEffect(event, target) {
    const effectId = target.dataset.effectId;
    const effect = effectRegistry.get(effectId);
    if (!effect) {
      console.warn(`${MODULE_ID} | Effect not found: ${effectId}`);
      return;
    }

    if (!effect.isAvailable) {
      if (!effect.enabled) {
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.cut-ins.ui.comingSoon`));
      } else {
        ui.notifications.warn(effect.getHint());
      }
      return;
    }

    await (this.constructor as unknown as typeof CinemaMenuDialog).#runWithButton(target, () => effect.execute());
  }

  // V2 windows are NOT registered in ui.windows (ApplicationV1 only) —
  // the ApplicationV2 registry is foundry.applications.instances
  static #existing() {
    return foundry.applications.instances.get("cinema-menu-dialog") ?? null;
  }

  static show() {
    const existing = CinemaMenuDialog.#existing();
    if (existing) {
      existing.bringToTop();
      return existing;
    }
    const dialog = new CinemaMenuDialog();
    dialog.render(true);
    return dialog;
  }

  /** Toolbar button: close if open, open if closed. */
  static toggle() {
    const existing = CinemaMenuDialog.#existing();
    if (existing) return existing.close();
    return CinemaMenuDialog.show();
  }
}

// Document-level listener: attached once, survives any render path.
// Routes typing in the menu search field to the open menu instance.
// Do NOT duplicate with per-render listeners — otherwise search runs twice.
Hooks.once('ready', () => {
  const app = () => foundry.applications.instances?.get('cinema-menu-dialog');
  const fromSearchField = (e) => e.target?.id === 'ss-menu-search-input';

  document.addEventListener('input', (e) => {
    if (!fromSearchField(e)) return;
    const inst = app();
    if (inst?.element) inst._ssApplySearch((e.target as any).value);
  });

  // Pressing Esc in a non-empty search field clears search FIRST and only closes
  // the window on a second Esc (capture phase intercepts before core's keybinding);
  // Enter blurs the search input
  document.addEventListener('keydown', (e) => {
    if (!fromSearchField(e)) return;
    if (e.key === 'Escape' && (e.target as any).value.trim()) {
      e.stopPropagation();
      e.preventDefault();
      app()?._ssClearSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as any).blur();
    }
  }, true);
});