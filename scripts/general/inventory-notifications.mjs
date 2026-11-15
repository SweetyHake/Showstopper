/* -------------------------------------------------- */
/*  Item Rarity Colors & Inventory Notifications       */
/* -------------------------------------------------- */
const MODULE_ID = 'showstopper';
const SETTING_ENABLED = 'inventoryNotificationsEnabled';
const SK = 'inventoryNotifications';
const BACKGROUND_GRADIENT_STYLE_ID = 'sst-inventory-gradient-style';
const LS = (key) => `${MODULE_ID}.InventoryNotifications.${key}`;
// Localization helper with fallback to default Russian strings (before lang keys are loaded).
const locFB = (key, fallback) => {
    try {
        if (game.i18n.has(key))
            return game.i18n.localize(key);
    }
    catch { }
    return fallback;
};
const DEFAULT_RARITY_COLORS = {
    common: "#EBEBEB",
    uncommon: "#1EC219",
    rare: "#4A90E4",
    veryRare: "#9810E0",
    legendary: "#FF8000",
    artifact: "#E40707"
};
// Fallback rarity labels (primary source: showstopper.InventoryNotifications.rarity.*)
const RARITY_LABELS = {
    common: "Обычный",
    uncommon: "Необычный",
    rare: "Редкий",
    veryRare: "Очень редкий",
    legendary: "Легендарный",
    artifact: "Артефакт"
};
const rarityLabel = (key) => locFB(LS(`rarity.${key}`), RARITY_LABELS[key] ?? key);
const RARITY_KEYS = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function getSetting(key) {
    try {
        return game.settings.get(MODULE_ID, `${SK}.${key}`);
    }
    catch {
        return null;
    }
}
function getRarityColor(rarityKey) {
    const saved = getSetting(`color.${rarityKey}`);
    if (saved && typeof saved === "string" && saved.trim())
        return saved;
    return DEFAULT_RARITY_COLORS[rarityKey] ?? null;
}
function getRarityColorsMap() {
    const map = {};
    for (const k of RARITY_KEYS)
        map[k] = getRarityColor(k);
    return map;
}
let _cachedRarityColors = null;
function _getRarityColorsCached() {
    if (!_cachedRarityColors) {
        _cachedRarityColors = getRarityColorsMap();
    }
    return _cachedRarityColors;
}
function isColorizeEnabled() {
    try {
        return game.settings.get(MODULE_ID, `${SK}.colorizeEnabled`);
    }
    catch {
        return true;
    }
}
function isColorizeTooltipEnabled() {
    try {
        return game.settings.get(MODULE_ID, `${SK}.colorizeTooltipEnabled`);
    }
    catch {
        return true;
    }
}
function isNotificationsEnabled() {
    try {
        return game.settings.get(MODULE_ID, SETTING_ENABLED);
    }
    catch {
        return true;
    }
}
function isBackgroundGradientEnabled() {
    try {
        return game.settings.get(MODULE_ID, `${SK}.backgroundGradientEnabled`);
    }
    catch {
        return true;
    }
}
function _getGradientCSS() {
    return `
.item-image.gold-icon,
img.document-image {
  background: linear-gradient(180deg,
    #383838 0%, #383838 10%,
    #373737 10%, #373737 20%,
    #363636 20%, #363636 30%,
    #343434 30%, #343434 40%,
    #333333 40%, #333333 50%,
    #323232 50%, #323232 60%,
    #313131 60%, #313131 70%,
    #303030 70%, #303030 80%,
    #2F2F2F 80%, #2F2F2F 90%,
    #2D2D2D 90%, #2D2D2D 100%
  );
}`;
}
function _applyBackgroundGradient() {
    const existing = document.getElementById(BACKGROUND_GRADIENT_STYLE_ID);
    if (existing)
        return;
    const style = document.createElement('style');
    style.id = BACKGROUND_GRADIENT_STYLE_ID;
    style.textContent = _getGradientCSS();
    document.head.appendChild(style);
}
function _removeBackgroundGradient() {
    const el = document.getElementById(BACKGROUND_GRADIENT_STYLE_ID);
    if (el)
        el.remove();
}
function _updateBackgroundGradient() {
    if (isBackgroundGradientEnabled()) {
        _applyBackgroundGradient();
    }
    else {
        _removeBackgroundGradient();
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// InventoryNotifications
// ─────────────────────────────────────────────────────────────────────────────
class InventoryNotifications {
    static MODULE_ID = MODULE_ID;
    static SETTING_ENABLED = SETTING_ENABLED;
    static INVENTORY_ITEM_TYPES = new Set([
        'weapon',
        'equipment',
        'consumable',
        'tool',
        'loot',
        'container',
        'backpack',
        'gear',
        'treasure',
        'material',
        'resource'
    ]);
    static EXCLUDED_TYPES = new Set([
        'spell',
        'feat',
        'feature',
        'class',
        'subclass',
        'background',
        'race'
    ]);
    static NOTIFICATION_DURATION = 4000;
    static MAX_NOTIFICATIONS = 10;
    static previousInventory = new Map();
    static CONTAINER_ID = 'inventory-notifications-container';
    static initialized = false;
    static registerSettings() {
        // ── Master toggle (visible in settings list, like damage numbers) ───────
        game.settings.register(MODULE_ID, SETTING_ENABLED, {
            name: LS('SettingName'),
            hint: LS('SettingHint'),
            scope: 'client',
            config: false,
            type: Boolean,
            default: true
        });
        // ── Hidden settings (managed via the config menu) ───────────────────────
        game.settings.register(MODULE_ID, `${SK}.colorizeEnabled`, {
            scope: 'client', config: false, type: Boolean, default: true
        });
        game.settings.register(MODULE_ID, `${SK}.colorizeTooltipEnabled`, {
            scope: 'client', config: false, type: Boolean, default: true
        });
        game.settings.register(MODULE_ID, `${SK}.backgroundGradientEnabled`, {
            scope: 'client', config: false, type: Boolean, default: true
        });
        for (const key of RARITY_KEYS) {
            game.settings.register(MODULE_ID, `${SK}.color.${key}`, {
                scope: 'client', config: false, type: String, default: DEFAULT_RARITY_COLORS[key]
            });
        }
        // ── Advanced settings menu ──────────────────────────────────────────────
        game.settings.registerMenu(MODULE_ID, `${SK}.menu`, {
            name: LS('MenuName'),
            label: LS('MenuLabel'),
            hint: LS('MenuHint'),
            icon: 'fas fa-box-open',
            type: InventoryNotificationsConfig,
            restricted: false
        });
    }
    static isEnabled() {
        return isNotificationsEnabled();
    }
    static init() {
        if (this.initialized)
            return;
        this.createContainer();
        _updateBackgroundGradient();
        const character = this.getAssignedCharacter();
        if (character) {
            this.saveInventoryState(character);
        }
        this.initialized = true;
    }
    static createContainer() {
        const existing = document.getElementById(this.CONTAINER_ID);
        if (existing) {
            existing.remove();
        }
        const container = document.createElement('div');
        container.id = this.CONTAINER_ID;
        (document.getElementById('interface') ?? document.body).appendChild(container);
    }
    static isInventoryItem(item) {
        if (!item)
            return false;
        const itemType = item.type?.toLowerCase();
        if (this.EXCLUDED_TYPES.has(itemType)) {
            return false;
        }
        return true;
    }
    static getAssignedCharacter() {
        const user = game.user;
        if (!user)
            return null;
        return user.character ?? null;
    }
    static getItemQuantity(item) {
        if (item.system?.quantity !== undefined)
            return item.system.quantity;
        if (item.data?.system?.quantity !== undefined)
            return item.data.system.quantity;
        if (item.data?.data?.quantity !== undefined)
            return item.data.data.quantity;
        return 1;
    }
    static getItemRarity(item) {
        let rarity = item.system?.rarity ??
            item.data?.system?.rarity ??
            item.data?.data?.rarity ??
            null;
        if (rarity && typeof rarity === 'string') {
            return rarity.toLowerCase();
        }
        return null;
    }
    static stripBrackets(name) {
        if (!name)
            return name;
        return name.replace(/\s*\[[^\]]*\]/g, '').trim();
    }
    static getNotificationBorderColor(rarity) {
        if (!rarity)
            return null;
        const rarityLower = String(rarity).toLowerCase();
        // Normalize "very rare" → veryRare
        let key = null;
        if (rarityLower === 'veryrare' || rarityLower === 'very rare')
            key = 'veryRare';
        else if (RARITY_KEYS.includes(rarityLower))
            key = rarityLower;
        if (!key)
            return null;
        return getRarityColor(key);
    }
    static saveInventoryState(actor) {
        if (!actor)
            return;
        const inventory = new Map();
        for (const item of actor.items) {
            if (this.isInventoryItem(item)) {
                inventory.set(item.id, {
                    id: item.id,
                    name: item.name,
                    img: item.img,
                    quantity: this.getItemQuantity(item),
                    rarity: this.getItemRarity(item)
                });
            }
        }
        this.previousInventory.set(actor.id, inventory);
    }
    static handleItemCreate(item, options, userId) {
        if (!this.isEnabled())
            return;
        const character = this.getAssignedCharacter();
        if (!character)
            return;
        const parent = item.parent;
        if (!parent || parent.id !== character.id)
            return;
        if (!this.isInventoryItem(item))
            return;
        setTimeout(() => {
            const freshItem = character.items.get(item.id);
            const source = freshItem ?? item;
            const quantity = this.getItemQuantity(source);
            const rarity = this.getItemRarity(source);
            this.showNotification({
                type: 'gained',
                name: source.name,
                img: source.img,
                quantity: quantity,
                rarity: rarity
            });
            this.saveInventoryState(character);
        }, 500);
    }
    static handleItemDelete(item, options, userId) {
        if (!this.isEnabled())
            return;
        const character = this.getAssignedCharacter();
        if (!character)
            return;
        const parent = item.parent;
        if (!parent || parent.id !== character.id)
            return;
        if (!this.isInventoryItem(item))
            return;
        const quantity = this.getItemQuantity(item);
        const rarity = this.getItemRarity(item);
        this.showNotification({
            type: 'lost',
            name: item.name,
            img: item.img,
            quantity: quantity,
            rarity: rarity
        });
        this.saveInventoryState(character);
    }
    static handleItemUpdate(item, changes, options, userId) {
        if (!this.isEnabled())
            return;
        const character = this.getAssignedCharacter();
        if (!character)
            return;
        const parent = item.parent;
        if (!parent || parent.id !== character.id)
            return;
        if (!this.isInventoryItem(item))
            return;
        let newQuantity = null;
        if (changes.system?.quantity !== undefined) {
            newQuantity = changes.system.quantity;
        }
        else if (changes.data?.system?.quantity !== undefined) {
            newQuantity = changes.data.system.quantity;
        }
        else if (changes.data?.data?.quantity !== undefined) {
            newQuantity = changes.data.data.quantity;
        }
        if (newQuantity === null)
            return;
        const prevInventory = this.previousInventory.get(character.id);
        if (!prevInventory) {
            this.saveInventoryState(character);
            return;
        }
        const prevItem = prevInventory.get(item.id);
        const oldQuantity = prevItem?.quantity ?? 0;
        if (newQuantity === oldQuantity)
            return;
        const diff = newQuantity - oldQuantity;
        const rarity = this.getItemRarity(item);
        this.showNotification({
            type: diff > 0 ? 'gained' : 'lost',
            name: item.name,
            img: item.img,
            quantity: Math.abs(diff),
            rarity: rarity
        });
        this.saveInventoryState(character);
    }
    static enforceNotificationLimit() {
        const container = document.getElementById(this.CONTAINER_ID);
        if (!container)
            return;
        const notifications = container.querySelectorAll('.inventory-notification:not(.fade-out)');
        // A loop with an unconditional break previously ran at most once — evict EXACTLY one
        // notification per call (preserving original behavior).
        if (notifications.length >= this.MAX_NOTIFICATIONS) {
            const oldest = container.querySelector('.inventory-notification:not(.fade-out)');
            if (oldest) {
                oldest.classList.add('fade-out');
                setTimeout(() => {
                    if (oldest.parentNode) {
                        oldest.remove();
                    }
                }, 300);
            }
        }
    }
    static showNotification({ type, name, img, quantity, rarity }) {
        if (!this.isEnabled())
            return;
        const displayName = this.stripBrackets(name);
        let container = document.getElementById(this.CONTAINER_ID);
        if (!container) {
            this.createContainer();
            container = document.getElementById(this.CONTAINER_ID);
        }
        // ── Stack: find existing notification for same item ──
        const existing = Array.from(container.querySelectorAll('.inventory-notification:not(.fade-out)')).find((el) => el.dataset.itemName === displayName && el.dataset.action === type);
        if (existing) {
            const qtyEl = existing.querySelector('.item-quantity');
            if (qtyEl) {
                const currentQty = parseInt(qtyEl.textContent.replace(/^[+-]/, '')) || 0;
                const prefix = type === 'gained' ? '+' : '-';
                qtyEl.textContent = `${prefix}${currentQty + quantity}`;
            }
            if (existing._fadeTimer)
                clearTimeout(existing._fadeTimer);
            existing.classList.remove('fade-out');
            existing._fadeTimer = setTimeout(() => {
                existing.classList.add('fade-out');
                setTimeout(() => { if (existing.parentNode)
                    existing.remove(); }, 300);
            }, this.NOTIFICATION_DURATION);
            return;
        }
        this.enforceNotificationLimit();
        const notification = document.createElement('div');
        notification.classList.add('inventory-notification');
        notification.dataset.itemName = displayName;
        notification.dataset.action = type;
        const rarityColor = this.getNotificationBorderColor(rarity);
        if (rarityColor) {
            notification.style.borderColor = rarityColor;
            notification.style.setProperty('--rarity-color', rarityColor);
        }
        const actionText = type === 'gained'
            ? locFB(LS('action.gained'), 'Получено')
            : locFB(LS('action.lost'), 'Утеряно');
        const quantityPrefix = type === 'gained' ? '+' : '-';
        const itemImg = img || 'icons/svg/item-bag.svg';
        // Item name and icon path come from synced documents — escape EVERYTHING
        // interpolated into innerHTML (including src/alt/style attributes), otherwise
        // an `<img src=x onerror=...>` payload in an item name executes on every client.
        const esc = foundry.utils.escapeHTML;
        notification.innerHTML = `
      <img class="item-icon" src="${esc(itemImg)}" alt="${esc(displayName)}"${rarityColor ? ` style="border-color: ${esc(rarityColor)};"` : ''}>
      <div class="item-info">
        <span class="item-action">${esc(actionText)}</span>
        <span class="item-name">${esc(displayName)}</span>
      </div>
      <span class="item-quantity">${esc(quantityPrefix)}${esc(String(quantity))}</span>
    `;
        container.appendChild(notification);
        notification._fadeTimer = setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }, this.NOTIFICATION_DURATION);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Config Application
// ─────────────────────────────────────────────────────────────────────────────
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;
class InventoryNotificationsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "sst-inventory-notifications-cfg",
        classes: ["showstopper-app", "effect-settings-dialog"],
        tag: "form",
        form: { handler: InventoryNotificationsConfig._submit, closeOnSubmit: true },
        window: { title: "showstopper.InventoryNotifications.ConfigTitle", icon: "fas fa-box-open" },
        position: { width: 520 }
    };
    static PARTS = {
        form: { template: `modules/${MODULE_ID}/templates/inventory-notifications-config.hbs` }
    };
    async _prepareContext() {
        const rarities = RARITY_KEYS.map(key => ({
            key,
            label: rarityLabel(key),
            color: getRarityColor(key),
            default: DEFAULT_RARITY_COLORS[key]
        }));
        return {
            notificationsEnabled: isNotificationsEnabled(),
            colorizeEnabled: isColorizeEnabled(),
            colorizeTooltipEnabled: isColorizeTooltipEnabled(),
            backgroundGradientEnabled: isBackgroundGradientEnabled(),
            rarities
        };
    }
    static async _submit(event, form, formData) {
        const d = formData.object;
        // Master feature toggles
        await game.settings.set(MODULE_ID, SETTING_ENABLED, !!d.notificationsEnabled);
        await game.settings.set(MODULE_ID, `${SK}.colorizeEnabled`, !!d.colorizeEnabled);
        await game.settings.set(MODULE_ID, `${SK}.colorizeTooltipEnabled`, !!d.colorizeTooltipEnabled);
        await game.settings.set(MODULE_ID, `${SK}.backgroundGradientEnabled`, !!d.backgroundGradientEnabled);
        // Rarity colors
        for (const key of RARITY_KEYS) {
            const field = `color.${key}`;
            if (field in d) {
                const raw = String(d[field] ?? "").trim();
                const value = /^#?[0-9a-fA-F]{6}$/.test(raw)
                    ? (raw.startsWith("#") ? raw : `#${raw}`)
                    : DEFAULT_RARITY_COLORS[key];
                await game.settings.set(MODULE_ID, `${SK}.${field}`, value);
            }
        }
    }
    _onRender() {
        // Sync color picker <-> text input
        this.element.querySelectorAll(".sst-color-pair").forEach(group => {
            const picker = group.querySelector('input[type="color"]');
            const text = group.querySelector('input[type="text"]');
            const resetBtn = group.querySelector('[data-action="reset-color"]');
            if (!picker || !text)
                return;
            picker.addEventListener("input", () => { text.value = picker.value; });
            text.addEventListener("input", () => {
                const v = text.value.trim();
                if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
                    picker.value = v.startsWith("#") ? v : `#${v}`;
                }
            });
            if (resetBtn) {
                resetBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    const def = resetBtn.dataset.default;
                    if (def) {
                        picker.value = def;
                        text.value = def;
                    }
                });
            }
        });
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────
Hooks.once('init', () => {
    if (game.system.id !== 'dnd5e')
        return;
    InventoryNotifications.registerSettings();
});
Hooks.once('ready', () => {
    if (game.system.id !== 'dnd5e')
        return;
    InventoryNotifications.init();
    Hooks.on("updateSetting", (setting) => {
        if (setting.key.startsWith(`${MODULE_ID}.${SK}.color.`)) {
            _cachedRarityColors = null;
        }
        if (setting.key === `${MODULE_ID}.${SK}.backgroundGradientEnabled`) {
            _updateBackgroundGradient();
        }
    });
    Hooks.on('createItem', (item, options, userId) => {
        InventoryNotifications.handleItemCreate(item, options, userId);
    });
    Hooks.on('deleteItem', (item, options, userId) => {
        InventoryNotifications.handleItemDelete(item, options, userId);
    });
    Hooks.on('updateItem', (item, changes, options, userId) => {
        InventoryNotifications.handleItemUpdate(item, changes, options, userId);
    });
    Hooks.on('updateUser', (user, changes) => {
        if (user.id === game.user.id && changes.character !== undefined) {
            const character = InventoryNotifications.getAssignedCharacter();
            if (character) {
                InventoryNotifications.saveInventoryState(character);
            }
        }
    });
});
/* -------------------------------------------------- */
/*  Colorize Item Names by Rarity                      */
/* -------------------------------------------------- */
function rarityKeyFromValue(rarity) {
    if (!rarity || typeof rarity !== "string")
        return null;
    const normalized = rarity.toLowerCase().replace(/\s+/g, "");
    if (normalized === "veryrare")
        return "veryRare";
    if (RARITY_KEYS.includes(normalized))
        return normalized;
    // Support PascalCase/camelCase values (rare)
    if (RARITY_KEYS.includes(rarity))
        return rarity;
    return null;
}
function colorizeItems(el, actor) {
    if (!el || !actor)
        return;
    if (!isColorizeEnabled())
        return;
    const colors = _getRarityColorsCached();
    const itemEls = el.querySelectorAll("[data-item-id]");
    for (const itemEl of itemEls) {
        const itemId = itemEl.dataset.itemId;
        if (!itemId)
            continue;
        const item = actor.items.get(itemId);
        if (!item)
            continue;
        const rarity = item.system?.rarity;
        const key = rarityKeyFromValue(rarity);
        if (!key)
            continue;
        const color = _themeColor(colors[key], key);
        if (!color)
            continue;
        const nameEl = itemEl.querySelector(".name-stacked .title")
            || itemEl.querySelector(".item-name .name")
            || itemEl.querySelector(".item-name h4, .item-name h3")
            || itemEl.querySelector(".item-name");
        if (nameEl) {
            if (nameEl.dataset.sstColor === color)
                continue;
            nameEl.style.color = color;
            nameEl.dataset.sstColor = color;
        }
    }
}
function colorizeItemSheet(el, item) {
    if (!el || !item)
        return;
    if (!isColorizeEnabled())
        return;
    const rarity = item.system?.rarity;
    const key = rarityKeyFromValue(rarity);
    if (!key)
        return;
    const color = _themeColor(_getRarityColorsCached()[key], key);
    if (!color)
        return;
    const nameInput = el.querySelector(".document-name");
    if (nameInput) {
        if (nameInput.dataset.sstColor === color)
            return;
        nameInput.style.color = color;
        nameInput.dataset.sstColor = color;
    }
}
function _themeColor(color, rarityKey) {
    if (rarityKey === "common" && color === DEFAULT_RARITY_COLORS.common) {
        return "var(--color-text-primary)";
    }
    return color;
}
// AppV2 in Foundry v12+ — colorize actor inventory lists and item sheets
Hooks.on("renderApplicationV2", (app, el) => {
    if (game.system.id !== 'dnd5e')
        return;
    if (el instanceof jQuery)
        el = el[0];
    const doc = app.document ?? app.actor ?? app.object;
    if (doc?.documentName === "Actor")
        colorizeItems(el, doc);
    if (doc?.documentName === "Item")
        colorizeItemSheet(el, doc);
});
/* ──────────────────────────────────────────────── */
/*  Tooltip colorization                             */
/*  The UUID comes from .loading[data-uuid] inside   */
/*  #tooltip, placed there by _applyItemTooltips.    */
/*  A MutationObserver captures the UUID insertion   */
/*  and then colors .name-stacked .title once the    */
/*  tooltip content finishes loading.                */
/* ──────────────────────────────────────────────── */
let _tipUuid = null;
let _tooltipObserver = null;
function _disconnectTooltipObserver() {
    if (_tooltipObserver) {
        _tooltipObserver.disconnect();
        _tooltipObserver = null;
    }
}
function _applyTooltipColor(tooltip) {
    const names = tooltip.querySelectorAll(".name-stacked .title, .effects-element .conditions-list .condition .name-stacked .title");
    if (!names.length || !isColorizeTooltipEnabled() || !_tipUuid)
        return;
    fromUuid(_tipUuid).then(doc => {
        if (!doc?.system?.rarity)
            return;
        const key = rarityKeyFromValue(doc.system.rarity);
        if (!key)
            return;
        const color = _themeColor(_getRarityColorsCached()[key], key);
        if (!color)
            return;
        for (const el of names)
            el.style.color = color;
    });
    _tipUuid = null;
}
Hooks.once("ready", () => {
    if (game.system.id !== 'dnd5e')
        return;
    const tip = document.getElementById("tooltip");
    if (tip) {
        _disconnectTooltipObserver();
        _tooltipObserver = new MutationObserver(() => {
            const loading = tip.querySelector(".loading[data-uuid]");
            if (loading) {
                _tipUuid = loading.dataset.uuid;
                return;
            }
            if (_tipUuid && tip.querySelector(".name-stacked .title"))
                _applyTooltipColor(tip);
        });
        _tooltipObserver.observe(tip, { childList: true, subtree: true });
    }
});
export {};
