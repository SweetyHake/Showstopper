/**
 * Portrait context menu: core items (ui.players) + third-party items (via the
 * getUserContextOptions hook, dispatched manually — the vanilla list receives
 * them during its own render) + module-specific items.
 *
 * The item list is built LAZILY right before each open: ContextMenu (v14)
 * exposes a public menuItems array read in render(), so a capture-phase listener
 * on the container updates the array IN PLACE before core's own bubble listener
 * fires. Items registered by third-party modules AFTER the first panel render
 * appear in the menu without recreating it (previously the list was snapshotted
 * once at menu creation).
 */
import { MODULE_ID } from './constants.mjs';
import { PortraitSettingsApp } from './apps.mjs';
/** avclient-livekit breakout-room options hidden from the portrait menu:
 *  all six context menu items plus two join/leave notification keys
 *  (the latter don't appear in the menu, included for completeness so any UI
 *  using these keys as option names will also be filtered out). */
const BREAKOUT_KEYS = [
    "LIVEKITAVCLIENT.startAVBreakout",
    "LIVEKITAVCLIENT.joinAVBreakout",
    "LIVEKITAVCLIENT.joiningAVBreakout",
    "LIVEKITAVCLIENT.pullToAVBreakout",
    "LIVEKITAVCLIENT.leaveAVBreakout",
    "LIVEKITAVCLIENT.leavingAVBreakout",
    "LIVEKITAVCLIENT.removeFromAVBreakout",
    "LIVEKITAVCLIENT.endAllAVBreakouts"
];
/** Localized names of breakout options: option names in the avclient-livekit
 *  bundle are localize() calls on these same keys, so matching against localize()
 *  works across any language and translation state. */
function breakoutOptionNames() {
    return new Set(BREAKOUT_KEYS.map(key => game.i18n?.localize?.(key)).filter(Boolean));
}
let _breakoutHookWrapped = false;
/**
 * Wraps avclient-livekit's getUserContextOptions hook handler once (identified
 * by referencing _liveKitClient in the function source; the handler itself is
 * an unnamed arrow function): invokes the original with a sacrificial array and
 * forwards only non-breakout items into the real array. This hides the items
 * AT THE HOOK SOURCE so neither the portrait menu nor the vanilla players list
 * sees them. No-ops until the handler is found (module not yet registered);
 * retried on subsequent menu builds, with _buildOptions filtering as a fallback.
 */
function suppressBreakoutAtHookSource() {
    if (_breakoutHookWrapped || game.modules.get("avclient-livekit")?.active !== true)
        return;
    const entries = Hooks.events?.getUserContextOptions;
    if (!Array.isArray(entries))
        return;
    const idx = entries.findIndex(entry => typeof entry?.fn === "function"
        && String(entry.fn).includes("_liveKitClient"));
    if (idx === -1)
        return;
    const original = entries[idx].fn;
    entries[idx].fn = (app, options) => {
        const sacrificial = [];
        original(app, sacrificial);
        const breakout = breakoutOptionNames();
        for (const item of sacrificial) {
            if (!breakout.has(item?.name))
                options.push(item);
        }
    };
    _breakoutHookWrapped = true;
}
export class PortraitContextMenu {
    /** @param {import('./panel.mjs').DiscordVoicePortraits} panel */
    constructor(panel) {
        this.panel = panel;
        this._contextMenu = null;
        this._boundRefresh = (event) => this._refreshOnOpen(event);
    }
    /** Create the menu once; rebound when the container is recreated. */
    ensure() {
        if (this._contextMenu)
            return;
        this._contextMenu = new foundry.applications.ux.ContextMenu(this.panel.container, ".dvp-portrait-wrapper", this._buildOptions(), { jQuery: false, fixed: true } // fixed — parity with vanilla Players menu
        );
        // Capture phase on the same container: fires BEFORE ContextMenu's bubble
        // listener so we can refresh menuItems prior to opening.
        this.panel.container.addEventListener("contextmenu", this._boundRefresh, { capture: true });
    }
    /**
     * Rebuilds menuItems IN PLACE (via splice — ContextMenu holds a reference to
     * the same array). Only runs when clicking a portrait: empty container space
     * doesn't open a menu, so there's no reason to fire the hook.
     */
    _refreshOnOpen(event) {
        if (!this._contextMenu)
            return;
        if (!event.target.closest?.(".dvp-portrait-wrapper"))
            return;
        const fresh = this._buildOptions();
        const items = this._contextMenu.menuItems;
        if (items !== undefined && Array.isArray(items)) {
            items.splice(0, items.length, ...fresh);
        }
        else { // guard against storage shape changes in future core versions
            this._contextMenu.menuItems = fresh;
        }
    }
    destroy() {
        if (!this._contextMenu)
            return;
        try {
            this.panel.container?.removeEventListener("contextmenu", this._boundRefresh, { capture: true });
        }
        catch (e) { /* container already detached from DOM */ }
        try {
            const menu = this._contextMenu;
            this._contextMenu = null;
            const menuEl = menu.element instanceof HTMLElement
                ? menu.element
                : (menu.element?.[0] instanceof HTMLElement ? menu.element[0] : null);
            if (menuEl && document.body.contains(menuEl)) {
                menu.close();
            }
            else {
                menuEl?.remove();
            }
        }
        catch (e) {
        }
    }
    /* ── Option list assembly ────────────────────────────────────────────── */
    _buildOptions() {
        const panel = this.panel;
        const extractEl = (target) => target instanceof HTMLElement ? target : target[0];
        // 0. Suppress breakout options at the hook source (see suppressBreakoutAtHookSource):
        //    run before dispatching the hook below so even the very first build gets
        //    the wrapped handler.
        suppressBreakoutAtHookSource();
        // 1. Core Players items: same options as the vanilla list
        //    (User Config, View Avatar, Pull to Scene, Kick/Ban/UnBan, WebRTC).
        const coreItems = ui.players?._getContextMenuOptions?.() ?? [];
        // 2. Third-party modules append items via the getUserContextOptions hook —
        //    that's how the vanilla list builds its menu (_onFirstRender ->
        //    _createContextMenu({hookName:"getUserContextOptions"})). Dispatch it
        //    ourselves, otherwise the panel would lose ALL external right-click actions.
        const hookItems = [];
        try {
            Hooks.callAll("getUserContextOptions", ui.players ?? null, hookItems);
        }
        catch (e) {
            console.warn(`${MODULE_ID} | getUserContextOptions dispatch failed:`, e);
        }
        // 3. Fallback filter for breakout options: primary suppression lives in the
        //    hook itself (suppressBreakoutAtHookSource); this filter catches cases
        //    where the wrapper isn't installed yet (handler not found, e.g. first menu
        //    open before avclient-livekit registers).
        const originalItems = [...coreItems, ...hookItems].filter(Boolean)
            .filter(item => !breakoutOptionNames().has(item.name));
        const whisperItem = {
            name: "showstopper.ContextMenu.Whisper",
            icon: "fa-solid fa-comment-dots",
            condition: (target) => {
                const el = extractEl(target);
                return el.dataset.foundryUserId !== game.user.id;
            },
            callback: async (target) => {
                const el = extractEl(target);
                const user = game.users.get(el.dataset.foundryUserId);
                if (!user)
                    return;
                const text = `/w [${user.name}] `;
                ui.sidebar?.changeTab?.("chat", "primary");
                await new Promise(resolve => setTimeout(resolve, 50));
                const proseMirrorEl = document.querySelector("prose-mirror#chat-message");
                if (!proseMirrorEl)
                    return;
                const editorView = proseMirrorEl._pmEditor ?? proseMirrorEl.pmEditor ?? proseMirrorEl.editor;
                if (editorView?.state && editorView?.dispatch) {
                    const { state, dispatch } = editorView;
                    const tr = state.tr.insertText(text, 0, state.doc.content.size);
                    dispatch(tr);
                    editorView.focus();
                    return;
                }
                const contentEl = proseMirrorEl.querySelector(".editor-content.ProseMirror");
                if (!contentEl)
                    return;
                contentEl.focus();
                document.execCommand("selectAll");
                document.execCommand("insertText", false, text);
            }
        };
        const options = [
            {
                name: "showstopper.ContextMenu.OpenSheet",
                icon: "fa-solid fa-book-open",
                condition: (target) => {
                    const el = extractEl(target);
                    const userId = el.dataset.foundryUserId;
                    const user = game.users.get(userId);
                    if (!user?.character)
                        return false;
                    return game.user.isGM || userId === game.user.id;
                },
                callback: (target) => {
                    const el = extractEl(target);
                    const user = game.users.get(el.dataset.foundryUserId);
                    user?.character?.sheet?.render(true);
                }
            },
            {
                name: "showstopper.ContextMenu.EditToken",
                icon: "fa-solid fa-user-circle",
                condition: (target) => {
                    const el = extractEl(target);
                    const userId = el.dataset.foundryUserId;
                    const user = game.users.get(userId);
                    if (!game.user.isGM && userId !== game.user.id)
                        return false;
                    if (!user?.character)
                        return false;
                    return !!panel._getTokenForActor(user.character.id);
                },
                callback: (target) => {
                    const el = extractEl(target);
                    const user = game.users.get(el.dataset.foundryUserId);
                    panel._getTokenForActor(user?.character?.id)?.sheet?.render(true);
                }
            },
            {
                name: "showstopper.ContextMenu.Target",
                icon: "fa-solid fa-bullseye",
                condition: (target) => {
                    if (!game.user.isGM)
                        return false;
                    const el = extractEl(target);
                    const user = game.users.get(el.dataset.foundryUserId);
                    if (!user?.character)
                        return false;
                    return !!panel._getTokenForActor(user.character.id);
                },
                callback: (target) => {
                    const el = extractEl(target);
                    const user = game.users.get(el.dataset.foundryUserId);
                    const token = panel._getTokenForActor(user?.character?.id);
                    token?.setTarget(!token.isTargeted, { user: game.user, releaseOthers: false });
                }
            }
        ];
        if (panel._isItemPilesActive()) {
            options.push({
                name: "showstopper.ContextMenu.Trade",
                icon: "fa-solid fa-handshake",
                condition: (target) => {
                    const el = extractEl(target);
                    const userId = el.dataset.foundryUserId;
                    const user = game.users.get(userId);
                    return !!(user?.character && game.user.character && userId !== game.user.id);
                },
                callback: (target) => {
                    const el = extractEl(target);
                    const user = game.users.get(el.dataset.foundryUserId);
                    if (user?.character && game.user.character) {
                        game.itempiles?.API?.requestTrade?.(user.character);
                    }
                }
            });
        }
        options.push({
            name: "showstopper.ContextMenu.PortraitSettings",
            icon: "fa-solid fa-image",
            condition: (target) => {
                const el = extractEl(target);
                const userId = el.dataset.foundryUserId;
                return game.user.isGM || userId === game.user.id;
            },
            callback: (target) => {
                const el = extractEl(target);
                const user = game.users.get(el.dataset.foundryUserId);
                if (user)
                    new PortraitSettingsApp(user).render(true);
            }
        });
        return [whisperItem, ...originalItems, ...options];
    }
}
