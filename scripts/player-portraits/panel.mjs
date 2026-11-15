import { MODULE_ID, PORTRAIT_SIZES, MIN_PORTRAIT_PX, FALLBACK_IMAGE, localize, isRealImage, resolveCharacterImage } from './constants.mjs';
import { VoiceModeController } from './voice-mode.mjs';
import { dragPreview } from '../general/drag-preview.mjs';
import { StatsWidget } from './stats-widget.mjs';
import { PortraitContextMenu } from './context-menu.mjs';
import { getHp, getHpMax, hpPaths } from '../blood/vitals.mjs';
/** LiveKit connection quality -> localization keys for the portrait dot tooltip. */
const QUALITY_LABEL_KEYS = {
    excellent: "showstopper.Portrait.Quality.Excellent",
    good: "showstopper.Portrait.Quality.Good",
    poor: "showstopper.Portrait.Quality.Poor",
    lost: "showstopper.Portrait.Quality.Lost",
    unknown: "showstopper.Portrait.Quality.Unknown",
};
export class DiscordVoicePortraits {
    constructor() {
        this.container = null;
        this.portraits = new Map();
        this.userData = new Map();
        this.mutedUsers = new Set();
        this.deafenedUsers = new Set();
        this.speakingUsers = new Set();
        // States from Foundry's native voice mode (game.webrtc) —
        // populated by VoiceModeController; act alongside Discord Relay.
        this.nativeSpeaking = new Set();
        this.nativeMuted = new Set();
        this.nativeDeafened = new Set();
        // Connection quality from LiveKit (userId -> 'excellent'|'good'|'poor'|'lost'|'unknown'):
        // populated by VoiceModeController, gated by displayConnectionQuality setting.
        this.nativeQuality = new Map();
        this.voiceMode = null;
        this.drag = null;
        this.stats = null;
        this.menu = null;
        this.discordToFoundryMap = new Map();
        this.displayModeOverrides = new Map();
        this.discordUserData = new Map();
        this._hookRegistrations = [];
        this._portraitAbortControllers = new Map();
        this._discordRelayAvailable = false;
        this._discordVoiceEnabled = true;
        this._boundOnSpeakingStart = this._onSpeakingStart.bind(this);
        this._boundOnSpeakingStop = this._onSpeakingStop.bind(this);
        this._boundOnUserUpdated = this._onUserUpdated.bind(this);
        this._boundOnUpdateUser = this._onUpdateUser.bind(this);
        this._boundOnUpdateActor = this._onUpdateActor.bind(this);
        this._boundOnUserConnected = this._onUserConnected.bind(this);
        this._boundOnCanvasReady = this._onCanvasReady.bind(this);
        this._boundOnCombatChange = this._onCombatChange.bind(this);
        this._boundOnRenderPlayers = this._onRenderPlayers.bind(this);
    }
    init() {
        // Gate that hides the vanilla players list (styled in discord.css).
        document.body.classList.add("dvp-active");
        this._discordRelayAvailable = this._checkDiscordRelay();
        this.createContainer();
        this._registerHooks();
        if (this._discordRelayAvailable) {
            console.log(`${MODULE_ID} | Discord relay available, loading initial state`);
            this._loadInitialDiscordState();
        }
        this.renderPortraits();
        this.applyPortraitSize();
        this._applySpeakingShake();
        this.voiceMode = new VoiceModeController(this);
        this.voiceMode.init();
        // Drag preview is a standalone singleton (general/drag-preview.mjs).
        this.drag = dragPreview;
        this.drag.init();
        // Stats widget (ping/FPS/breaktime) + AFK/voice-state intervals.
        this.stats = new StatsWidget(this);
        this.stats.start();
        this._boundOnResize = foundry.utils.debounce(() => this.applyPortraitSize(), 200);
        window.addEventListener("resize", this._boundOnResize);
        // Hotbar width changes (pages/controls) — recompute available zone width.
        this._hotbarResizeObserver = new ResizeObserver(() => this.applyPanelLayout());
        const hotbar = document.getElementById("hotbar");
        if (hotbar)
            this._hotbarResizeObserver.observe(hotbar);
    }
    _checkDiscordRelay() {
        return game.modules.get("discord-relay")?.active === true;
    }
    _isItemPilesActive() {
        return game.modules.get("item-piles")?.active === true;
    }
    _isBreaktimeActive() {
        return game.modules.get("breaktime")?.active === true;
    }
    _getBreaktimeAway(userId) {
        if (!this._isBreaktimeActive())
            return false;
        try {
            return game.settings.get("breaktime", "away")?.includes(userId) === true;
        }
        catch (e) {
            return false;
        }
    }
    _onRenderPlayers() {
        for (const [userId, el] of this.portraits) {
            this._updateBreaktimeDisplay(el, userId);
        }
        const widget = document.getElementById("dvp-stats-widget");
        if (widget)
            this._updateStatsWidget();
    }
    _isCombatActive() {
        return game.combat?.started === true;
    }
    createContainer() {
        document.getElementById("discord-voice-portraits")?.remove();
        this.container = document.createElement("div");
        this.container.id = "discord-voice-portraits";
        this.container.classList.add("discord-voice-portraits-container");
        // Lives inside the native left UI zone: #ui-left provides position,
        // padding, z-index, and global scale (--ui-scale).
        const uiLeft = document.getElementById("ui-left");
        if (uiLeft)
            uiLeft.appendChild(this.container);
        else
            document.body.appendChild(this.container);
    }
    _registerHooks() {
        const register = (hookName, fn) => {
            const id = Hooks.on(hookName, fn);
            this._hookRegistrations.push({ hookName, id });
        };
        if (this._discordRelayAvailable) {
            register("discord-relay.userStartedSpeaking", this._boundOnSpeakingStart);
            register("discord-relay.userStoppedSpeaking", this._boundOnSpeakingStop);
            register("discord-relay.userUpdated", this._boundOnUserUpdated);
            // Relay has no settingChanged hook; profile setting changes fire
            // renderLists — reload names/avatars on that hook.
            register("discord-relay.renderLists", () => {
                this._loadDiscordProfiles();
                for (const [foundryUserId, data] of this.userData) {
                    const mode = this._getDisplayMode(foundryUserId);
                    if (mode === "discord") {
                        const resolved = this._resolveDisplay(data);
                        this._applyDisplayToElement(foundryUserId, resolved);
                    }
                }
            });
            register("discord-relay.onToggle", (state) => {
                if (state === "off") {
                    this._discordVoiceEnabled = false;
                    this.speakingUsers.clear();
                    this.mutedUsers.clear();
                    this.deafenedUsers.clear();
                    // Discord states are cleared, but native (voice-mode) states may
                    // remain — refresh using the combined state.
                    for (const foundryUserId of this.portraits.keys()) {
                        this._refreshVoiceDisplay(foundryUserId);
                    }
                }
                else if (state === "on") {
                    this._discordVoiceEnabled = true;
                }
            });
        }
        register("updateUser", this._boundOnUpdateUser);
        register("updateActor", this._boundOnUpdateActor);
        register("userConnected", this._boundOnUserConnected);
        register("canvasReady", this._boundOnCanvasReady);
        register("combatStart", this._boundOnCombatChange);
        register("combatEnd", this._boundOnCombatChange);
        register("deleteCombat", this._boundOnCombatChange);
        register("combatTurnChange", this._boundOnCombatChange);
        register("renderPlayers", this._boundOnRenderPlayers);
    }
    _unregisterHooks() {
        for (const { hookName, id } of this._hookRegistrations) {
            Hooks.off(hookName, id);
        }
        this._hookRegistrations.length = 0;
    }
    _findFoundryUserIdByDiscordId(discordUserId) {
        const cached = this.discordToFoundryMap.get(discordUserId);
        if (cached)
            return cached;
        try {
            // discord-relay has no api namespace — the discord->foundry mapping lives
            // in the foundryDiscordIdsMap setting: { foundryUserId: [discordId, ...] }.
            // Same resolution algorithm used inside relay (VoiceActivityRelay).
            const idsMap = game.settings.get("discord-relay", "foundryDiscordIdsMap") || {};
            const foundryUserId = Object.keys(idsMap).find(fId => idsMap[fId]?.includes(discordUserId));
            if (foundryUserId) {
                this.discordToFoundryMap.set(discordUserId, foundryUserId);
                return foundryUserId;
            }
        }
        catch (e) { }
        return null;
    }
    _loadInitialDiscordState() {
        console.log(`${MODULE_ID} | _loadInitialDiscordState called`);
        try {
            this._loadDiscordProfiles();
            // Initial Discord profile cache: assemble relayUsers from relay settings
            // (api.getUsers does not exist). foundryDiscordIdsMap + discordUserProfiles.
            const idsMap = game.settings.get("discord-relay", "foundryDiscordIdsMap") || {};
            const profiles = game.settings.get("discord-relay", "discordUserProfiles") || {};
            for (const [foundryUserId, discordIds] of Object.entries(idsMap)) {
                const discordId = Array.isArray(discordIds) ? discordIds[0] : null;
                const profile = discordId ? profiles[discordId] : null;
                if (profile) {
                    this._cacheDiscordUserData(foundryUserId, {
                        user_id: discordId,
                        nick: profile.nick,
                        username: profile.username
                    });
                }
            }
            // Bridge is published on globalThis.DiscordBridge (api.discordBridge does not exist).
            const discordBridge = globalThis.DiscordBridge
                ?? game.modules.get("discord-relay")?.api?.discordBridge;
            if (!discordBridge)
                return;
            const mutedList = discordBridge.mutedList?.() || [];
            for (const user of mutedList) {
                const discordUserId = user.userId;
                const foundryUserId = this._findFoundryUserIdByDiscordId(discordUserId);
                if (foundryUserId) {
                    this.mutedUsers.add(foundryUserId);
                }
            }
            const deafenedList = discordBridge.deafenedList?.() || [];
            for (const user of deafenedList) {
                const discordUserId = user.userId;
                const foundryUserId = this._findFoundryUserIdByDiscordId(discordUserId);
                if (foundryUserId) {
                    this.deafenedUsers.add(foundryUserId);
                }
            }
            for (const [foundryUserId] of this.portraits) {
                this._applyStateClasses(foundryUserId);
            }
        }
        catch (e) {
            console.warn(`${MODULE_ID} | Failed to load initial Discord state:`, e);
        }
    }
    _onSpeakingStart(data) {
        if (!this._discordVoiceEnabled)
            return;
        const foundryUserId = data.foundryUserId;
        if (!foundryUserId)
            return;
        // Relay payload is flat: user_id/nick/username live at the top level
        // (data.discordUser does not exist).
        if (data.user_id ?? data.discordUser?.user_id) {
            this.discordToFoundryMap.set(data.user_id ?? data.discordUser.user_id, foundryUserId);
            this._cacheDiscordUserData(foundryUserId, {
                user_id: data.user_id,
                nick: data.nick,
                username: data.username
            });
        }
        this.speakingUsers.add(foundryUserId);
        // Refresh using the combined state: native RTC may still hold speaking
        // or muted state, which must not be overwritten by a Discord event.
        this._refreshVoiceDisplay(foundryUserId);
    }
    _onSpeakingStop(data) {
        if (!this._discordVoiceEnabled)
            return;
        const foundryUserId = data.foundryUserId;
        if (!foundryUserId)
            return;
        // Flat payload — see _onSpeakingStart.
        if (data.user_id ?? data.discordUser?.user_id) {
            this.discordToFoundryMap.set(data.user_id ?? data.discordUser.user_id, foundryUserId);
            this._cacheDiscordUserData(foundryUserId, {
                user_id: data.user_id,
                nick: data.nick,
                username: data.username
            });
        }
        this.speakingUsers.delete(foundryUserId);
        this._refreshVoiceDisplay(foundryUserId);
    }
    _onUserUpdated(data) {
        if (!this._discordVoiceEnabled)
            return;
        const foundryUserId = data.foundryUserId;
        if (!foundryUserId)
            return;
        // Flat payload — see _onSpeakingStart.
        if (data.user_id ?? data.discordUser?.user_id) {
            this.discordToFoundryMap.set(data.user_id ?? data.discordUser.user_id, foundryUserId);
            this._cacheDiscordUserData(foundryUserId, {
                user_id: data.user_id,
                nick: data.nick,
                username: data.username
            });
        }
        const isMuted = data.mute ?? false;
        const isDeafened = data.deaf ?? false;
        isMuted ? this.mutedUsers.add(foundryUserId) : this.mutedUsers.delete(foundryUserId);
        isDeafened ? this.deafenedUsers.add(foundryUserId) : this.deafenedUsers.delete(foundryUserId);
        this._refreshVoiceDisplay(foundryUserId);
    }
    _onUpdateUser(user, changes) {
        if ("character" in changes || "img" in changes || "name" in changes || "active" in changes) {
            const hadCharacter = !!this.userData.get(user.id)?.character;
            const hasCharacter = !!user.character;
            if (hadCharacter !== hasCharacter) {
                this._rebuildPortrait(user.id);
                return;
            }
        }
        this.renderPortraits();
    }
    _rebuildPortrait(userId) {
        const ac = this._portraitAbortControllers.get(userId);
        if (ac) {
            ac.abort();
            this._portraitAbortControllers.delete(userId);
        }
        const el = this.portraits.get(userId);
        if (el)
            el.remove();
        this.portraits.delete(userId);
        this.userData.delete(userId);
        this.renderPortraits();
    }
    _onUpdateActor(actor) {
        const user = game.users.find(u => u.character?.id === actor.id);
        if (user) {
            this._updateHealthBar(user.id);
            this.renderPortraits();
        }
    }
    _onUserConnected() {
        this.renderPortraits();
    }
    _onCanvasReady() {
        // Drop-preview PIXI objects were destroyed with the previous canvas — reset.
        this.drag?.onCanvasReady();
        this.renderPortraits();
    }
    _onCombatChange() {
        this.renderPortraits();
    }
    getPortraitSize() {
        const sizeKey = game.settings.get(MODULE_ID, "portraitSize") || "medium";
        return PORTRAIT_SIZES[sizeKey] || PORTRAIT_SIZES.medium;
    }
    applyPortraitSize() {
        // A delayed debounced resize may fire after destroy() and re-apply
        // --dvp-portrait-size on <html> right after destroy removed it.
        if (!this.container)
            return;
        // Configured size is the BASE: window autoscaling (1920x1080 = 1x,
        // clamped to 0.65–1.35) scales portraits on resize, and native #ui-left
        // applies global UI scale on top (transform: scale(--ui-scale)).
        const base = parseInt(this.getPortraitSize()) || 108;
        const k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
        const px = Math.round(base * Math.clamp(k, 0.65, 1.35));
        this._portraitPx = px;
        document.documentElement.style.setProperty("--dvp-portrait-size", `${px}px`);
        this.applyPanelLayout();
    }
    /**
     * Automatic portrait layout without manual settings: uses as many columns
     * as current players need (single row while it fits); panel width = min of
     * content width, #ui-left right edge, and hotbar left edge.
     * `overrideSize` is the size shrunk by vertical fit (_fitBelowSceneControls):
     * triggers a second pass without re-attempting shrink to avoid looping.
     */
    applyPanelLayout(overrideSize) {
        const container = this.container;
        const uiLeft = document.getElementById("ui-left");
        if (!container || !uiLeft || !uiLeft.contains(container))
            return;
        const sizePx = overrideSize ?? this._portraitPx ?? (parseInt(this.getPortraitSize()) || 108);
        // Every pass starts from the BASE size: a vertically shrunk size must not
        // persist across calls from renderPortraits or the hotbar observer.
        document.documentElement.style.setProperty("--dvp-portrait-size", `${sizePx}px`);
        const gap = Math.max(6, Math.min(12, window.innerWidth * 0.0075));
        const users = Math.max(1, this.portraits.size);
        const contentW = users * sizePx + (users - 1) * gap;
        // Available width is in screen pixels (rects already include --ui-scale);
        // convert back to internal #ui-left units.
        const scale = parseFloat(getComputedStyle(uiLeft).getPropertyValue("--ui-scale")) || 1;
        const cRect = container.getBoundingClientRect();
        const lRect = uiLeft.getBoundingClientRect();
        const hotbar = document.getElementById("hotbar");
        const hRect = hotbar?.getBoundingClientRect();
        // Width is RELATIVE TO THE HOTBAR: container extends up to its left edge
        // (minus 8px), no further, regardless of portrait count — empty grid cells
        // on the right stay empty (auto-fill packs left).
        // When hotbar is hidden, fall back to min(contentW, #ui-left right edge).
        let width = Math.max(sizePx, Math.min(contentW, (lRect.right - 16 - cRect.left) / scale));
        if (hRect && hRect.width > 0) {
            width = Math.max(sizePx, (hRect.left - cRect.left - 8) / scale);
        }
        container.style.width = `${Math.floor(width)}px`;
        // Vertical fit: panel must stay below the scene controls toolbar.
        this._fitBelowSceneControls(uiLeft, scale, sizePx, gap, width, overrideSize !== undefined);
    }
    /**
     * The panel grows upward from the bottom of #ui-left, and when vertical space
     * is tight (short window, many rows) it used to overlap #scene-controls.
     * Here portrait size is shrunk so the panel top clears the toolbar; row height
     * = portrait + name, with name height derived from ACTUAL rendered panel height
     * rather than formulas. If even MIN_PORTRAIT_PX doesn't fit, fall back to
     * max-height with scrolling instead of overlapping. Base size is read fresh
     * from _portraitPx (setting * window factor) on every call so shrinking never
     * accumulates across calls.
     */
    _fitBelowSceneControls(uiLeft, scale, sizePx, gap, width, isRetry) {
        const container = this.container;
        const controls = document.getElementById("scene-controls") ?? uiLeft.querySelector("nav");
        if (!controls)
            return;
        const OFFSET_Y = 40; // := --dvp-offset-y (discord.css): panel bottom offset within the zone
        const TOP_GAP = 10; // gap between scene controls toolbar and panel top
        const lRect = uiLeft.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const sRect = controls.getBoundingClientRect();
        // Height budget in screen pixels: panel bottom is fixed, top is bounded
        // by the bottom of the scene controls toolbar.
        const availH = (lRect.bottom - OFFSET_Y * scale) - (sRect.bottom + TOP_GAP * scale);
        if (availH <= 0)
            return; // toolbar exceeds zone height — no usable space, leave untouched
        if (cRect.height <= availH) {
            // Fits below toolbar — clear fallback max-height and scroll mode.
            container.style.maxHeight = "";
            container.classList.remove("dvp-scroll");
            return;
        }
        if (isRetry || sizePx <= MIN_PORTRAIT_PX) {
            // Second pass didn't fit / nothing left to shrink — scroll instead of overlapping.
            // Toggled via class (not permanent CSS overflow) because overflow would clip
            // ink-overflow: speaking glow and hover scale along panel edges would always clip.
            container.style.maxHeight = `${Math.max(60, Math.floor(availH / scale))}px`;
            container.classList.add("dvp-scroll");
            return;
        }
        // Analytical fit: rows * (size + nameH) + (rows - 1) * gap <= availH.
        const users = Math.max(1, this.portraits.size);
        const cols = Math.max(1, Math.floor((width + gap) / (sizePx + gap)));
        const rows = Math.max(1, Math.ceil(users / cols));
        const inner = cRect.height / scale; // internal (pre --ui-scale) units
        const nameH = Math.max(0, inner - rows * sizePx - (rows - 1) * gap);
        const fit = Math.floor((availH / scale - (rows - 1) * gap) / rows - nameH);
        const next = Math.min(sizePx - 1, Math.max(MIN_PORTRAIT_PX, fit));
        document.documentElement.style.setProperty("--dvp-portrait-size", `${next}px`);
        this.applyPanelLayout(next);
    }
    _applySpeakingShake() {
        const shake = game.settings.get(MODULE_ID, "speakingShake");
        document.documentElement.classList.toggle("dvp-no-shake", !shake);
    }
    _getPortraitFlags(user) {
        if (user.character) {
            return user.character.getFlag(MODULE_ID, "portrait") || user.getFlag(MODULE_ID, "portrait") || {};
        }
        return user.getFlag(MODULE_ID, "portrait") || {};
    }
    _getTokenForActor(actorId) {
        return canvas.tokens?.placeables.find(t => t.actor?.id === actorId) ?? null;
    }
    /**
     * DAMAGE percentage (0..100) resolved via the ACTIVE system's HP paths —
     * shared table with the blood subsystem (scripts/blood/vitals.mjs:
     * SYSTEM_HP_PATHS + user overrides bloodHpPath/bloodHpMaxPath). Wounds-based
     * systems (swade/demonlord) are inverted: wound count grows with damage.
     * Returns null if the system/actor has no HP (bar is hidden).
     */
    _getDamagePercent(actor) {
        if (!actor)
            return null;
        const hp = getHp(actor);
        const max = getHpMax(actor);
        if (hp === undefined || !max)
            return null;
        const share = Math.clamp(hp / max, 0, 1);
        return Math.round((hpPaths().wounds ? share : 1 - share) * 100);
    }
    _getInitiative(actor) {
        if (!actor || !game.combat)
            return null;
        const combatant = game.combat.combatants.find(c => c.actorId === actor.id);
        return combatant?.initiative ?? null;
    }
    _cacheDiscordUserData(foundryUserId, discordUser) {
        if (!discordUser)
            return;
        const existing = this.discordUserData.get(foundryUserId) || {};
        this.discordUserData.set(foundryUserId, {
            ...existing,
            username: discordUser.nick || discordUser.username || discordUser.global_name || existing.username || null
        });
        const mode = this._getDisplayMode(foundryUserId);
        if (mode === "discord") {
            const data = this.userData.get(foundryUserId);
            if (data) {
                const resolved = this._resolveDisplay(data);
                this._applyDisplayToElement(foundryUserId, resolved);
            }
        }
    }
    _loadDiscordProfiles() {
        try {
            this._discordProfiles = game.settings.get("discord-relay", "discordUserProfiles") || {};
            const idsMap = game.settings.get("discord-relay", "foundryDiscordIdsMap") || {};
            for (const [key, values] of Object.entries(idsMap)) {
                if (!/^\d+$/.test(key) && Array.isArray(values) && values.length > 0) {
                    const foundryUserId = key;
                    const discordId = values[0];
                    const profile = this._discordProfiles[discordId];
                    if (profile) {
                        this.discordUserData.set(foundryUserId, {
                            username: profile.nick || profile.username
                        });
                    }
                }
            }
        }
        catch (e) {
            console.warn(`${MODULE_ID} | Failed to load Discord profiles:`, e);
        }
    }
    _getDiscordAvatar(foundryUserId) {
        if (!this._discordProfiles)
            return null;
        const idsMap = game.settings.get("discord-relay", "foundryDiscordIdsMap") || {};
        const values = idsMap[foundryUserId];
        if (!Array.isArray(values) || values.length === 0)
            return null;
        const discordId = values[0];
        const profile = this._discordProfiles[discordId];
        return profile?.avatarUrl || null;
    }
    _getDisplayMode(userId) {
        if (this.displayModeOverrides.has(userId)) {
            return this.displayModeOverrides.get(userId);
        }
        const user = game.users.get(userId);
        const flags = this._getPortraitFlags(user);
        if (flags.displayMode)
            return flags.displayMode;
        return "character";
    }
    _resolveDisplay(data) {
        const mode = this._getDisplayMode(data.foundryUserId);
        // Always read flags fresh from the user document to avoid stale cache
        const liveFlags = this._getPortraitFlags(data.user);
        const customName = liveFlags.customDisplayName || null;
        if (mode === "discord" && this._discordRelayAvailable) {
            const discord = this.discordUserData.get(data.foundryUserId);
            const discordName = discord?.username || data.userName;
            // No Discord avatar — show the real character portrait;
            // fallback placeholder only when no real art exists at all
            const discordAvatar = this._getDiscordAvatar(data.foundryUserId) ?? data.charImage ?? FALLBACK_IMAGE;
            return {
                displayName: customName || discordName,
                displayImage: discordAvatar,
                idleImage: liveFlags.idleImage || discordAvatar,
                speakingImage: liveFlags.speakingImage || discordAvatar
            };
        }
        if (mode === "user" || !data.character) {
            // Half of user avatars are mystery-man: if the user has a character
            // with real art, show that instead
            const userImage = data.userAvatar ?? data.charImage ?? FALLBACK_IMAGE;
            return {
                displayName: customName || data.userName,
                displayImage: userImage,
                idleImage: liveFlags.idleImage || userImage,
                speakingImage: liveFlags.speakingImage || userImage
            };
        }
        // mode === "character": actor.img may be a placeholder stub — fall back to
        // prototype token art (already resolved in charImage), then real user avatar
        const characterImage = data.charImage ?? data.userAvatar ?? FALLBACK_IMAGE;
        return {
            displayName: customName || data.character.name || data.userName,
            displayImage: characterImage,
            idleImage: liveFlags.idleImage || characterImage,
            speakingImage: liveFlags.speakingImage || characterImage
        };
    }
    _applyDisplayToElement(userId, resolved) {
        const el = this.portraits.get(userId);
        if (!el)
            return;
        const nameEl = el.querySelector(".dvp-portrait-name");
        if (nameEl)
            nameEl.textContent = resolved.displayName;
        const img = el.querySelector(".dvp-portrait-image");
        if (img) {
            img.dataset.idleImage = resolved.idleImage;
            img.dataset.speakingImage = resolved.speakingImage;
            img.dataset.fallbackApplied = "";
            const isSpeaking = this._isSpeakingEffective(userId);
            const newSrc = isSpeaking ? resolved.speakingImage : resolved.idleImage;
            // Pre-warm the cache for the alternate image (idle/speaking) so switching
            // speaking state doesn't wait on the network — external URLs can take seconds.
            if (resolved.speakingImage && resolved.speakingImage !== resolved.idleImage) {
                new Image().src = isSpeaking ? resolved.idleImage : resolved.speakingImage;
            }
            // img.src returns an absolute URL and always !== a relative dataset path —
            // compare against getAttribute("src") to avoid redundant reassignments.
            if (img.getAttribute("src") !== newSrc)
                img.src = newSrc;
        }
    }
    _collectUsers() {
        const users = [];
        for (const user of game.users) {
            if (!user.active)
                continue;
            const character = user.character;
            const flags = this._getPortraitFlags(user);
            // REAL portraits: core mystery-man is not treated as real art —
            // prefer prototype token art, then user avatar, and placeholder last
            const charImage = resolveCharacterImage(character);
            const userAvatar = isRealImage(user.avatar) ? user.avatar : null;
            const defaultImage = charImage ?? userAvatar ?? FALLBACK_IMAGE;
            users.push({
                foundryUserId: user.id,
                user,
                userName: user.name,
                userAvatar,
                character,
                charImage,
                defaultImage,
                flags,
                userColor: user.color || "#444444",
                isGM: user.isGM
            });
        }
        // Sort name — ONE _resolveDisplay call per user:
        // it reads flags and settings, whereas the comparator runs O(n log n) times.
        // Initiative uses the same pre-lookup: one combatants find per user
        // instead of a find on every comparison.
        const sortNames = new Map(users.map(u => [u.foundryUserId, this._resolveDisplay(u).displayName]));
        const initiatives = this._isCombatActive()
            ? new Map(users.map(u => [u.foundryUserId, this._getInitiative(u.character) ?? -Infinity]))
            : null;
        users.sort((a, b) => {
            if (a.isGM !== b.isGM)
                return a.isGM ? -1 : 1;
            if (initiatives) {
                const initA = initiatives.get(a.foundryUserId);
                const initB = initiatives.get(b.foundryUserId);
                if (initA !== initB)
                    return initB - initA;
            }
            return sortNames.get(a.foundryUserId).localeCompare(sortNames.get(b.foundryUserId));
        });
        return users;
    }
    renderPortraits = foundry.utils.debounce(() => this._renderPortraitsImpl(), 150);
    _renderPortraitsImpl() {
        if (!this.container)
            return;
        const users = this._collectUsers();
        const newIds = new Set(users.map(u => u.foundryUserId));
        const existingIds = new Set(this.portraits.keys());
        for (const id of existingIds) {
            if (!newIds.has(id))
                this._removePortrait(id);
        }
        for (const data of users) {
            const prevData = this.userData.get(data.foundryUserId);
            const characterChanged = prevData !== undefined &&
                (prevData.character?.id ?? null) !== (data.character?.id ?? null);
            if (this.portraits.has(data.foundryUserId) && !characterChanged) {
                this._updateExistingPortrait(data);
            }
            else {
                if (characterChanged) {
                    const ac = this._portraitAbortControllers.get(data.foundryUserId);
                    if (ac) {
                        ac.abort();
                        this._portraitAbortControllers.delete(data.foundryUserId);
                    }
                    const el = this.portraits.get(data.foundryUserId);
                    if (el)
                        el.remove();
                    this.portraits.delete(data.foundryUserId);
                }
                this._addPortrait(data);
            }
        }
        this._reorderPortraits(users);
        this._ensureContextMenu();
        // Player count changed — adapt panel width to content.
        this.applyPanelLayout();
    }
    _addPortrait(data) {
        const ac = new AbortController();
        this._portraitAbortControllers.set(data.foundryUserId, ac);
        const el = this._createPortraitElement(data, ac.signal);
        this.container.appendChild(el);
        this.portraits.set(data.foundryUserId, el);
        this.userData.set(data.foundryUserId, data);
        const resolved = this._resolveDisplay(data);
        this._applyDisplayToElement(data.foundryUserId, resolved);
        this._applyStateClasses(data.foundryUserId);
        this._updateQualityDot(data.foundryUserId);
        this._updateHealthBar(data.foundryUserId);
        this._updateAFKDisplay(el, data.foundryUserId);
        this._updateBreaktimeDisplay(el, data.foundryUserId);
    }
    _removePortrait(id) {
        const ac = this._portraitAbortControllers.get(id);
        if (ac) {
            ac.abort();
            this._portraitAbortControllers.delete(id);
        }
        const el = this.portraits.get(id);
        if (el)
            el.remove();
        this.portraits.delete(id);
        this.userData.delete(id);
    }
    _updateExistingPortrait(data) {
        const el = this.portraits.get(data.foundryUserId);
        if (!el)
            return;
        this.userData.set(data.foundryUserId, data);
        const resolved = this._resolveDisplay(data);
        this._applyDisplayToElement(data.foundryUserId, resolved);
        const oldColor = el.style.getPropertyValue("--user-color");
        if (oldColor !== data.userColor) {
            el.style.setProperty("--user-color", data.userColor);
        }
        if (data.character) {
            el.dataset.characterId = data.character.id;
        }
        else {
            delete el.dataset.characterId;
        }
        this._applyStateClasses(data.foundryUserId);
        this._updateHealthBar(data.foundryUserId);
        this._updateAFKDisplay(el, data.foundryUserId);
        this._updateBreaktimeDisplay(el, data.foundryUserId);
    }
    _reorderPortraits(users) {
        // Re-inserting restarts CSS animations (speaking pulse/shake) and spawns
        // unnecessary DOM mutations — only move elements that DIVERGE from target
        // order (appendChild is a no-op only for the very last child)
        const container = this.container;
        let ref = container?.firstChild ?? null;
        for (const data of users) {
            const el = this.portraits.get(data.foundryUserId);
            if (!el)
                continue;
            if (el === ref) {
                ref = el.nextSibling;
                continue;
            }
            container.insertBefore(el, ref);
            // el moved into ref's position; the next target reference remains ref
        }
    }
    // Effective voice states: native Foundry RTC layered with Discord Relay.
    _isSpeakingEffective(userId) {
        return this.speakingUsers.has(userId) || this.nativeSpeaking.has(userId);
    }
    _isMutedEffective(userId) {
        return this.mutedUsers.has(userId) || this.nativeMuted.has(userId);
    }
    _isDeafenedEffective(userId) {
        return this.deafenedUsers.has(userId) || this.nativeDeafened.has(userId);
    }
    /** Refresh portrait appearance using the combined (Discord + native RTC) state. */
    _refreshVoiceDisplay(userId) {
        const portrait = this.portraits.get(userId);
        if (!portrait)
            return;
        this._applyStateClasses(userId);
        this._updateQualityDot(userId);
        this._updatePortraitImage(userId, this._isSpeakingEffective(userId));
    }
    _applyStateClasses(userId) {
        const portrait = this.portraits.get(userId);
        if (!portrait)
            return;
        portrait.classList.toggle("dvp-speaking", this._isSpeakingEffective(userId));
        portrait.classList.toggle("dvp-muted", this._isMutedEffective(userId));
        portrait.classList.toggle("dvp-deafened", this._isDeafenedEffective(userId));
    }
    /**
     * Connection quality dot (data-quality -> color in voice-hud.css). An empty
     * value hides the dot: LiveKit isn't connected, displayConnectionQuality is
     * disabled, or the user is outside voice mode.
     */
    _updateQualityDot(userId) {
        const dot = this.portraits.get(userId)?.querySelector(".dvp-quality-dot");
        if (!dot)
            return;
        const quality = this.nativeQuality.get(userId) ?? "";
        if (dot.dataset.quality === quality)
            return;
        dot.dataset.quality = quality;
        if (quality) {
            const label = localize(QUALITY_LABEL_KEYS[quality] ?? "");
            dot.dataset.tooltip = label;
            dot.setAttribute("aria-label", label);
        }
        else {
            dot.removeAttribute("data-tooltip");
            dot.removeAttribute("aria-label");
        }
    }
    _ensureContextMenu() {
        if (!this.menu)
            this.menu = new PortraitContextMenu(this);
        this.menu.ensure();
    }
    _destroyContextMenu() {
        this.menu?.destroy();
    }
    _updateHealthBar(userId) {
        const portrait = this.portraits.get(userId);
        if (!portrait)
            return;
        const data = this.userData.get(userId);
        if (!data)
            return;
        const healthBar = portrait.querySelector(".dvp-health-bar");
        if (!healthBar)
            return;
        if (this._isCombatActive() && data.character) {
            const percent = this._getDamagePercent(data.character);
            // null = system without readable HP (see _getDamagePercent) — hide bar.
            if (percent === null) {
                healthBar.classList.remove("visible");
                return;
            }
            healthBar.style.setProperty("--damage-percent", `${percent}%`);
            healthBar.classList.add("visible");
        }
        else {
            healthBar.classList.remove("visible");
        }
    }
    _createPortraitElement(data, signal) {
        const wrapper = document.createElement("div");
        wrapper.classList.add("dvp-portrait-wrapper");
        wrapper.dataset.foundryUserId = data.foundryUserId;
        wrapper.dataset.userId = data.foundryUserId;
        if (data.character)
            wrapper.dataset.characterId = data.character.id;
        wrapper.style.setProperty("--user-color", data.userColor);
        wrapper.setAttribute("role", "button");
        wrapper.setAttribute("tabindex", "0");
        const portraitInner = document.createElement("div");
        portraitInner.classList.add("dvp-portrait-inner");
        const imageContainer = document.createElement("div");
        imageContainer.classList.add("dvp-portrait-container");
        const healthBar = document.createElement("div");
        healthBar.classList.add("dvp-health-bar");
        const img = document.createElement("img");
        img.classList.add("dvp-portrait-image");
        img.decoding = "async";
        img.fetchPriority = "high";
        // defaultImage is guaranteed present in data (_collectUsers);
        // data.idleImage/speakingImage don't exist — src/dataset used to become
        // "undefined". speakingImage is set by _applyDisplayToElement right after
        // element construction (only called from _addPortrait).
        img.src = data.defaultImage;
        img.alt = data.character?.name || data.userName;
        img.dataset.idleImage = data.defaultImage;
        img.addEventListener("error", () => {
            if (!img.dataset.fallbackApplied) {
                img.dataset.fallbackApplied = "true";
                img.src = FALLBACK_IMAGE;
            }
        }, { signal });
        const mutedIndicator = document.createElement("div");
        mutedIndicator.classList.add("dvp-muted-indicator");
        mutedIndicator.innerHTML = '<i class="fas fa-microphone-slash"></i>';
        const deafenedIndicator = document.createElement("div");
        deafenedIndicator.classList.add("dvp-deafened-indicator");
        deafenedIndicator.innerHTML = '<i class="fas fa-headphones-slash"></i>';
        // LiveKit connection quality: color/visibility driven by data-quality (_updateQualityDot).
        const qualityDot = document.createElement("div");
        qualityDot.classList.add("dvp-quality-dot");
        // Live camera video (when the user is sharing video). MUST be muted:
        // audio plays on the native hidden dock video element — a second source
        // would double audio and ignore the volume slider.
        const video = document.createElement("video");
        video.classList.add("dvp-portrait-video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        imageContainer.append(healthBar, img, video, mutedIndicator, deafenedIndicator, qualityDot);
        // Volume slider (equivalent to native div.volume-bar): adjusts the user's
        // stream volume (client.users.<id>.volume). Like native — only on other
        // users' portraits; always visible when voice mode is active (voice-hud.css).
        if (data.foundryUserId !== game.user.id) {
            const volumeBar = document.createElement("div");
            volumeBar.classList.add("dvp-volume-bar");
            // Same scale as native v14 (volume NumberField): 0..1 step 0.05;
            // AudioHelper.inputToVolume/volumeToInput maps volume^(+-1/1.5).
            volumeBar.innerHTML = `
        <i class="fa-solid fa-volume-low fa-fw" inert></i>
        <input type="range" class="dvp-volume-slider" min="0" max="1" step="0.05"
               aria-label="${game.i18n.localize("WEBRTC.Volume")}">
        <i class="fa-solid fa-volume-high fa-fw" inert></i>`;
            const slider = volumeBar.querySelector("input");
            const currentVolume = game.webrtc?.settings?.getUser?.(data.foundryUserId)?.volume;
            slider.value = foundry.audio.AudioHelper.volumeToInput(Number.isFinite(currentVolume) ? Math.clamp(currentVolume, 0, 1) : 1);
            // Slider interaction must not trigger portrait actions: click = pan to token,
            // dblclick = character sheet, mousedown (GM) = token drag.
            for (const type of ["pointerdown", "mousedown", "click", "dblclick"]) {
                volumeBar.addEventListener(type, (e) => e.stopPropagation(), { signal });
            }
            // Same as core (CameraViews._onVolumeChange): apply immediately to video.volume
            // and persist to client settings where core reads it for future streams.
            // Math.clamp guards against out-of-range values: video.volume throws
            // IndexSizeError outside [0, 1].
            slider.addEventListener("input", () => {
                const volume = Math.clamp(foundry.audio.AudioHelper.inputToVolume(Number(slider.value)), 0, 1);
                const video = ui.webrtc?.getUserVideoElement?.(data.foundryUserId);
                if (video)
                    video.volume = volume;
                game.webrtc?.settings?.set("client", `users.${data.foundryUserId}.volume`, volume);
            }, { signal });
            imageContainer.appendChild(volumeBar);
        }
        portraitInner.appendChild(imageContainer);
        const nameLabel = document.createElement("div");
        nameLabel.classList.add("dvp-portrait-name");
        nameLabel.textContent = data.character?.name || data.userName;
        wrapper.append(portraitInner, nameLabel);
        wrapper.addEventListener("click", () => this._panToToken(data), { signal });
        wrapper.addEventListener("dblclick", () => this._openCharacterSheet(data), { signal });
        wrapper.addEventListener("keydown", (e) => {
            // When focus is inside the volume slider, arrow keys/Space control the
            // slider rather than the portrait (pan/sheet).
            if (e.target.closest(".dvp-volume-bar"))
                return;
            if (e.key === "Enter")
                this._panToToken(data);
            else if (e.key === " ") {
                e.preventDefault();
                this._openCharacterSheet(data);
            }
        }, { signal });
        if (game.user.isGM && data.character) {
            wrapper.addEventListener("mousedown", (e) => this.drag?.onPortraitMouseDown(e, data), { signal });
        }
        return wrapper;
    }
    _updatePortraitImage(foundryUserId, isSpeaking) {
        const portrait = this.portraits.get(foundryUserId);
        if (!portrait)
            return;
        const img = portrait.querySelector(".dvp-portrait-image");
        if (!img)
            return;
        const newSrc = isSpeaking ? img.dataset.speakingImage : img.dataset.idleImage;
        // img.src returns an absolute URL and always !== a relative dataset path —
        // compare against getAttribute("src") to avoid redundant reassignments.
        if (img.getAttribute("src") !== newSrc)
            img.src = newSrc;
    }
    _openCharacterSheet(data) {
        if (!data.character)
            return;
        if (!game.user.isGM && data.foundryUserId !== game.user.id)
            return;
        data.character.sheet?.render(true);
    }
    _panToToken(data) {
        if (!game.user.isGM && data.foundryUserId !== game.user.id)
            return;
        if (!data.character)
            return;
        const token = this._getTokenForActor(data.character.id);
        if (!token)
            return;
        canvas.animatePan({
            x: token.center.x,
            y: token.center.y,
            scale: canvas.stage.scale.x,
            duration: 500
        });
        token.control({ releaseOthers: true });
    }
    /** Compat helper (apps.mjs: module settings window): create stats widget. */
    _createStatsWidget() {
        this.stats?.create();
        // Migrate native AV controls into the fresh host next to ping (if voice
        // mode is active and they were living in the standalone pill).
        this.voiceMode?.syncControls();
    }
    /** Compat helper (apps.mjs): update stats widget values. */
    _updateStatsWidget() {
        this.stats?.update();
    }
    _updateAllAFK() {
        for (const [userId, el] of this.portraits) {
            this._updateAFKDisplay(el, userId);
        }
    }
    _isUserAFK(userId) {
        try {
            const user = game.users.get(userId);
            if (!user || !user.active)
                return false;
            return user.idle === true;
        }
        catch (e) { }
        return false;
    }
    _updateAFKDisplay(el, userId) {
        const isAfk = this._isUserAFK(userId);
        let afkEl = el.querySelector(".dvp-afk-indicator");
        if (isAfk) {
            if (!afkEl) {
                afkEl = document.createElement("div");
                afkEl.classList.add("dvp-afk-indicator");
                afkEl.innerHTML = `<span class="dvp-afk-text">${localize("showstopper.Portrait.AfkLabel")}</span>`;
                const container = el.querySelector(".dvp-portrait-container");
                if (container)
                    container.appendChild(afkEl);
            }
            el.classList.add("dvp-afk");
        }
        else {
            if (afkEl)
                afkEl.remove();
            el.classList.remove("dvp-afk");
        }
    }
    _updateBreaktimeDisplay(el, userId) {
        const isAway = this._getBreaktimeAway(userId);
        let awayEl = el.querySelector(".dvp-breaktime-indicator");
        if (isAway) {
            if (!awayEl) {
                awayEl = document.createElement("div");
                awayEl.classList.add("dvp-breaktime-indicator");
                awayEl.innerHTML = '<i class="fas fa-mug-hot"></i>';
                const container = el.querySelector(".dvp-portrait-container");
                if (container)
                    container.appendChild(awayEl);
            }
            el.classList.add("dvp-breaktime-away");
        }
        else {
            if (awayEl)
                awayEl.remove();
            el.classList.remove("dvp-breaktime-away");
        }
    }
    destroy() {
        this._unregisterHooks();
        // Destroy voiceMode FIRST: while the stats widget is still alive, the native
        // AV controls node (data-application-part="controls") hosted inside it can
        // still find its host and return cleanly to the dock; after widget removal,
        // _releaseControls would miss the host and leave the dock without mic/camera buttons
        this.voiceMode?.destroy();
        this.voiceMode = null;
        // Stats widget: intervals + DOM (hosts AV controls inside).
        this.stats?.stop();
        this.stats = null;
        // Drag preview lives independently in general/drag-preview.mjs: when disabling
        // the panel, only cancel an active portrait mouse drag so native sidebar/compendium
        // drag previews keep working.
        this.drag?.cancelPortraitDrag();
        this.drag = null;
        // Restore the native players list.
        document.body.classList.remove("dvp-active");
        for (const ac of this._portraitAbortControllers.values()) {
            ac.abort();
        }
        this._portraitAbortControllers.clear();
        this._destroyContextMenu();
        this.menu = null;
        this.container?.remove();
        this.container = null;
        this._hotbarResizeObserver?.disconnect();
        this._hotbarResizeObserver = null;
        this.portraits.clear();
        this.userData.clear();
        this.mutedUsers.clear();
        this.deafenedUsers.clear();
        this.speakingUsers.clear();
        this.nativeSpeaking.clear();
        this.nativeMuted.clear();
        this.nativeDeafened.clear();
        this.nativeQuality.clear();
        this.discordToFoundryMap.clear();
        this.displayModeOverrides.clear();
        this.discordUserData?.clear();
        // Root-level style artifacts outside the panel element lifecycle
        document.documentElement.style.removeProperty("--dvp-portrait-size");
        document.documentElement.classList.remove("dvp-no-shake");
        window.removeEventListener("resize", this._boundOnResize);
    }
}
