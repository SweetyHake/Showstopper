/**
 * Showstopper floating combat numbers (clean native implementation).
 *
 * Architecture:
 *   1. Palette & modifiers — Showstopper's own semantic color palette + reading
 *      the system damage-type registry (CONFIG.DND5E), without inspecting internal
 *      resistance fields on the character sheet: multipliers and immunities are read
 *      directly from the damage calculation result (`active.multiplier` / `immune`).
 *   2. Kinematics — Newtonian ballistic arc (`s = v₀t + ½at²`) originating from the
 *      token center with alternating fan spread, smooth power-curve alpha decay, and
 *      spin in the second half of flight; full cleanup on `canvasTearDown`.
 *   3. Network pipeline — unified Showstopper socket layer (`emitAll` /
 *      `registerRawHandler`): batched popup dispatch per token with local visibility
 *      checks (fog of war, hidden tokens) on each client and suppression of duplicate
 *      system scrolling text in dnd5e while preserving dynamic token ring flashes.
 */
import { MODULE_ID } from "../config.mjs";
import { registerAPI } from "../core/runtime.mjs";
import { emitAll, registerRawHandler } from "../core/socket-manager.mjs";
const NS_CALC = "ss:dmg-calc";
const NS_MUTE = "ss:dmg-mute";
const NS_POPUPS = "ss:dmg-popups";
const SETTING_NS = "damageNumbers";
const BYPASS_CAPTURE = "__ssBypassScrollingCapture";
const SIZE_PRESETS = {
    small: 0.5,
    medium: 0.68,
    large: 1.0
};
const PREFERRED_FONTS = ["Modesto Condensed", "Cinzel", "Russo One", "Signika"];
/** Showstopper semantic color palette across damage and effect categories. */
const CATEGORY_COLORS = {
    heal: 0x45c454,
    shield: 0x00b8f5,
    immune: 0xa8a8a8,
    plain: 0x990f1b,
    slashing: 0xc4c8cc,
    piercing: 0xc4c8cc,
    bludgeoning: 0xc4c8cc,
    fire: 0xff6b35,
    cold: 0x7dd3fc,
    lightning: 0xfacc15,
    thunder: 0xc084fc,
    acid: 0x84cc16,
    poison: 0x4ade80,
    necrotic: 0xa855f7,
    radiant: 0xfde047,
    force: 0xf472b6,
    psychic: 0xe879f9
};
const PHYSICAL_CATEGORIES = new Set(["slashing", "piercing", "bludgeoning"]);
const CALC_TTL_MS = 4500;
const MUTE_TTL_MS = 2800;
const BURST_WINDOW_MS = 420;
const POPUP_LIFETIME_SEC = 1.56;
const SPIN_START_RATIO = 0.57;
const CACHE_CAP = 160;
const _calcStore = new Map();
const _preVitals = new Map();
const _muteUntil = new Map();
const _burstSlots = new Map();
const _livePopups = new Set();
// ─────────────────────────────────────────────────────────────────────────────
// Settings & Font Selection
// ─────────────────────────────────────────────────────────────────────────────
function readClientSetting(subkey, fallback) {
    try {
        const val = game.settings.get(MODULE_ID, `${SETTING_NS}.${subkey}`);
        return (val ?? fallback);
    }
    catch {
        return fallback;
    }
}
function isFeatureActive() {
    try {
        if (!game.settings.get("core", "scrollingStatusText"))
            return false;
    }
    catch { /* core setting may not be registered yet */ }
    return Boolean(readClientSetting("enabled", true));
}
function collectRegisteredFonts() {
    const bucket = new Set();
    const ingest = (src) => {
        if (!src)
            return;
        if (Array.isArray(src)) {
            for (const item of src)
                if (typeof item === "string" && item.trim())
                    bucket.add(item.trim());
        }
        else if (typeof src === "object") {
            for (const key of Object.keys(src))
                if (key.trim() && !/^\d+$/.test(key))
                    bucket.add(key.trim());
        }
    };
    ingest(CONFIG?.fontDefinitions);
    const FontCfg = foundry?.applications?.settings?.menus?.FontConfig ?? globalThis.FontConfig;
    ingest(FontCfg?.getAvailableFonts?.());
    for (const sysFont of ["Cinzel", "Georgia", "Verdana", "Arial", "Times New Roman"]) {
        bucket.add(sysFont);
    }
    return [...bucket].sort((a, b) => a.localeCompare(b));
}
function resolveDefaultFont() {
    const defs = CONFIG?.fontDefinitions ?? {};
    for (const candidate of PREFERRED_FONTS) {
        if (defs[candidate])
            return candidate;
    }
    return CONFIG?.defaultFontFamily || "Signika";
}
function activeFontFamily() {
    const configured = readClientSetting("font", "");
    return configured && configured.trim() ? configured.trim() : resolveDefaultFont();
}
function activeSizeFactor() {
    const key = readClientSetting("size", "medium");
    return SIZE_PRESETS[key] ?? 1.0;
}
// ─────────────────────────────────────────────────────────────────────────────
// Color Palette
// ─────────────────────────────────────────────────────────────────────────────
function parseHexColor(raw) {
    if (typeof raw === "number" && Number.isFinite(raw))
        return raw;
    if (raw && typeof raw === "object" && typeof raw.valueOf === "function") {
        const n = Number(raw.valueOf());
        if (Number.isFinite(n))
            return n;
    }
    if (typeof raw === "string") {
        const clean = raw.trim().replace(/^#/, "");
        if (/^[0-9a-f]{6}$/i.test(clean))
            return parseInt(clean, 16);
    }
    try {
        if (typeof Color !== "undefined" && Color?.from) {
            const c = Color.from(raw);
            const n = Number(c);
            if (Number.isFinite(n))
                return n;
        }
    }
    catch { /* ignore unrecognized color format */ }
    return null;
}
function resolvePopupColor(category, modifier) {
    if (modifier === "immune")
        return CATEGORY_COLORS.immune;
    if (typeof category === "number" && Number.isFinite(category))
        return category;
    const key = String(category || "plain").trim().toLowerCase();
    if (key === "heal" || key === "healing")
        return CATEGORY_COLORS.heal;
    if (key === "shield" || key === "temphp")
        return CATEGORY_COLORS.shield;
    if (!PHYSICAL_CATEGORIES.has(key)) {
        const sysEntry = CONFIG?.DND5E?.damageTypes?.[key] ?? CONFIG?.DND5E?.healingTypes?.[key];
        const sysColor = parseHexColor(sysEntry?.color);
        if (sysColor !== null)
            return sysColor;
    }
    return CATEGORY_COLORS[key] ?? CATEGORY_COLORS.plain;
}
// ─────────────────────────────────────────────────────────────────────────────
// Math Curves & Burst Cascade Slots
// ─────────────────────────────────────────────────────────────────────────────
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** Continuous power-curve alpha decay: solid start and smooth fade-out at the end of flight. */
function computePopupAlpha(u) {
    return Math.max(0, 1 - Math.pow(clamp01(u), 2.2));
}
function claimBurstSlot(tokenId) {
    const now = Date.now();
    const prev = _burstSlots.get(tokenId);
    if (!prev || now - prev.lastAt > BURST_WINDOW_MS) {
        _burstSlots.set(tokenId, { nextSlot: 1, lastAt: now });
        if (_burstSlots.size > CACHE_CAP) {
            const oldest = _burstSlots.keys().next().value;
            if (oldest)
                _burstSlots.delete(oldest);
        }
        return 0;
    }
    const slot = prev.nextSlot++;
    prev.lastAt = now;
    return slot;
}
// ─────────────────────────────────────────────────────────────────────────────
// Single Combat Popup Rendering & Animation
// ─────────────────────────────────────────────────────────────────────────────
class FloatingCombatPopup {
    constructor(token, item, slot = 0) {
        this.token = token;
        this.item = item;
        this.root = null;
        this.labelNode = null;
        this.ticker = null;
        this.timerId = null;
        this.disposed = false;
        this.elapsedSec = 0;
        const gridScale = (Number(canvas?.dimensions?.size) || 100) / 100;
        const center = token.center ?? { x: token.x ?? 0, y: token.y ?? 0 };
        this.originX = center.x;
        this.originY = center.y;
        // Alternating left/right fan spread in bursts with natural velocity and acceleration jitter
        const side = slot === 0
            ? (Math.random() < 0.5 ? -1 : 1)
            : (slot % 2 === 1 ? 1 : -1);
        this.vx = side * (6 + Math.random() * 24) * gridScale;
        this.ax = side * (26 + Math.random() * 34) * gridScale;
        this.vy = -(48 + Math.random() * 32) * gridScale;
        this.ay = (38 + Math.random() * 26) * gridScale;
        this.spinVel = side * (1.8 + Math.random() * 2.6);
        this._onTick = () => this._stepFrame();
        _livePopups.add(this);
        const delayMs = slot === 0
            ? Math.round(Math.random() * 90)
            : Math.round(slot * 115 + Math.random() * 85);
        if (delayMs > 0) {
            this.timerId = setTimeout(() => {
                this.timerId = null;
                this._mount();
            }, delayMs);
        }
        else {
            this._mount();
        }
    }
    _mount() {
        if (this.disposed || !canvas?.interface || !this.token || this.token.destroyed) {
            this.dispose();
            return;
        }
        const root = new PIXI.Container();
        root.zIndex = CONFIG?.Canvas?.groups?.interface?.zIndexScrollingText
            ?? CONFIG?.Canvas?.groups?.interface?.zIndex
            ?? 1000;
        root.position.set(this.originX, this.originY);
        const textObj = this._createLabel();
        textObj.anchor.set(0.5, 0.5);
        root.addChild(textObj);
        this.root = root;
        this.labelNode = textObj;
        canvas.interface.addChild(root);
        const ticker = canvas.app?.ticker ?? canvas.ticker ?? PIXI.Ticker.shared;
        this.ticker = ticker;
        ticker.add(this._onTick);
    }
    _createLabel() {
        const mod = this.item.modifier ?? "normal";
        const color = resolvePopupColor(this.item.category, mod);
        const gridPx = Number(canvas?.dimensions?.size) || 100;
        const doc = this.token?.document;
        const texScale = (Math.abs(Number(doc?.texture?.scaleX) || 1) + Math.abs(Number(doc?.texture?.scaleY) || 1)) * 0.5;
        const footprint = Math.min(Number(doc?.width) || 1, Number(doc?.height) || 1);
        const modScale = mod === "vuln" ? 1.8 : 1.0;
        const extScale = Number(this.item.scaleFactor) || 1.0;
        const userSize = Number(this.item.sizeOverride) || activeSizeFactor();
        const baseFont = Math.max(Math.round(gridPx * 0.36), 36);
        const fontSize = Math.round(Math.min(Math.max(baseFont * footprint * texScale * userSize * modScale * extScale, 16), 200));
        let caption;
        if (mod === "immune") {
            const loc = game?.i18n?.localize?.(`${MODULE_ID}.damageNumbers.Immune`);
            caption = loc && loc !== `${MODULE_ID}.damageNumbers.Immune` ? loc : "Immune";
        }
        else if (this.item.caption !== undefined && this.item.caption !== null) {
            caption = String(this.item.caption);
        }
        else {
            caption = String(Math.abs(Math.round(Number(this.item.amount) || 0)));
        }
        const fontWeight = mod === "vuln" ? "bold" : "normal";
        const fontStyle = mod === "resist" ? "italic" : "normal";
        const PreciseText = foundry.canvas.containers.PreciseText;
        const style = PreciseText.getTextStyle({
            fontFamily: this.item.fontOverride || activeFontFamily(),
            fontSize,
            fontWeight,
            fontStyle,
            fill: color,
            strokeThickness: 5
        });
        return new PreciseText(caption, style);
    }
    _stepFrame() {
        if (this.disposed || !this.root || this.root.destroyed) {
            this.dispose();
            return;
        }
        const dtSec = Math.min(Math.max((Number(this.ticker?.deltaMS) || 16.67) / 1000, 0), 0.1);
        this.elapsedSec += dtSec;
        const s = this.elapsedSec;
        const u = clamp01(s / POPUP_LIFETIME_SEC);
        // Uniformly accelerated ballistic trajectory s = v₀·t + ½·a·t²
        const dx = this.vx * s + 0.5 * this.ax * s * s;
        const dy = this.vy * s + 0.5 * this.ay * s * s;
        this.root.position.set(this.originX + dx, this.originY + dy);
        this.root.alpha = computePopupAlpha(u);
        // Keep the number upright during the first half of flight for legibility, then spin along the arc
        if (u >= SPIN_START_RATIO) {
            const spinSec = (u - SPIN_START_RATIO) * POPUP_LIFETIME_SEC;
            this.root.rotation = this.spinVel * spinSec;
        }
        if (u >= 1) {
            this.dispose();
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        _livePopups.delete(this);
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
        if (this.ticker) {
            try {
                this.ticker.remove(this._onTick);
            }
            catch { /* ticker already torn down */ }
            this.ticker = null;
        }
        if (this.root && !this.root.destroyed) {
            try {
                this.root.parent?.removeChild?.(this.root);
            }
            catch { /* noop */ }
            try {
                this.root.destroy({ children: true });
            }
            catch { /* noop */ }
        }
        this.root = null;
        this.labelNode = null;
    }
}
function spawnLocalBatch(token, batch) {
    if (!token || !Array.isArray(batch) || !batch.length)
        return;
    const key = String(token.id || token.document?.id || "tok");
    for (const entry of batch) {
        if (!entry || typeof entry !== "object")
            continue;
        const slot = claimBurstSlot(key);
        new FloatingCombatPopup(token, entry, slot);
    }
}
function broadcastTokenPopups(token, batch) {
    if (!token?.id || !batch.length)
        return;
    const sceneId = canvas?.scene?.id;
    if (!sceneId)
        return;
    emitAll(NS_POPUPS, { sceneId, tokenId: token.id, batch });
}
// ─────────────────────────────────────────────────────────────────────────────
// Actor Keys & Suppression / Damage Breakdown Cache
// ─────────────────────────────────────────────────────────────────────────────
function actorKeysOf(actor) {
    const keys = [];
    if (actor?.uuid && typeof actor.uuid === "string")
        keys.push(actor.uuid);
    if (actor?.isToken) {
        const tokId = actor.token?.id;
        if (typeof tokId === "string" && tokId)
            keys.push(`Token:${tokId}`);
    }
    else if (actor?.id && typeof actor.id === "string" && !keys.includes(actor.id)) {
        keys.push(actor.id);
    }
    return keys;
}
function trimMap(map) {
    while (map.size > CACHE_CAP) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            break;
        map.delete(oldest);
    }
}
function markActorMuted(keys) {
    const until = Date.now() + MUTE_TTL_MS;
    for (const k of keys) {
        if (typeof k === "string" && k)
            _muteUntil.set(k, until);
    }
    trimMap(_muteUntil);
}
function isActorMuted(actor) {
    const now = Date.now();
    for (const k of actorKeysOf(actor)) {
        if (_preVitals.has(k))
            return true;
        const calc = _calcStore.get(k);
        if (calc) {
            if (now - calc.at < CALC_TTL_MS)
                return true;
            _calcStore.delete(k);
        }
        const exp = _muteUntil.get(k);
        if (exp !== undefined) {
            if (now < exp)
                return true;
            _muteUntil.delete(k);
        }
    }
    return false;
}
function consumeBreakdownForActor(actor) {
    const now = Date.now();
    let found = null;
    for (const k of actorKeysOf(actor)) {
        const rec = _calcStore.get(k);
        if (!rec)
            continue;
        _calcStore.delete(k);
        if (!found && now - rec.at < CALC_TTL_MS && rec.list.length > 0) {
            found = rec.list;
        }
    }
    return found;
}
function isHealingCategory(cat) {
    return cat === "healing" || cat === "heal" || Boolean(CONFIG?.DND5E?.healingTypes?.[cat]);
}
function extractCalcEntries(rawDamages) {
    if (!Array.isArray(rawDamages))
        return [];
    const out = [];
    for (const row of rawDamages) {
        if (!row || typeof row !== "object")
            continue;
        const rawType = typeof row.type === "string" ? row.type.trim().toLowerCase() : "plain";
        // Temporary HP and max-HP caps are handled separately via the temp HP delta channel
        if (rawType === "temphp" || rawType === "maximum")
            continue;
        const mul = Number(row.active?.multiplier ?? 1);
        const immune = Boolean(row.active?.immune) || mul === 0;
        const amount = Math.abs(Math.floor(Number(row.value) || 0));
        out.push({
            category: rawType || "plain",
            amount,
            multiplier: Number.isFinite(mul) ? mul : 1,
            immune
        });
    }
    return out;
}
function modifierFromCalc(entry) {
    if (entry.immune || entry.multiplier === 0)
        return "immune";
    if (entry.multiplier > 1)
        return "vuln";
    if (entry.multiplier > 0 && entry.multiplier < 1)
        return "resist";
    return "normal";
}
// ─────────────────────────────────────────────────────────────────────────────
// Socket Handlers
// ─────────────────────────────────────────────────────────────────────────────
registerRawHandler(NS_POPUPS, (msg) => {
    if (!isFeatureActive())
        return;
    if (!msg || canvas?.scene?.id !== msg.sceneId)
        return;
    const token = canvas?.tokens?.get?.(msg.tokenId);
    if (!token || !token.visible || token.document?.hidden)
        return;
    spawnLocalBatch(token, msg.batch);
});
registerRawHandler(NS_CALC, (msg) => {
    if (!isFeatureActive())
        return;
    if (!Array.isArray(msg?.keys) || !Array.isArray(msg?.list) || !msg.list.length)
        return;
    const record = { at: Date.now(), list: msg.list };
    for (const k of msg.keys) {
        if (typeof k === "string" && k)
            _calcStore.set(k, record);
    }
    trimMap(_calcStore);
});
registerRawHandler(NS_MUTE, (msg) => {
    if (!isFeatureActive() || !Array.isArray(msg?.keys))
        return;
    markActorMuted(msg.keys);
});
// ─────────────────────────────────────────────────────────────────────────────
// dnd5e Health Updates & Dynamic Token Ring Flashes
// ─────────────────────────────────────────────────────────────────────────────
function triggerTokenRingFlash(actor, changes) {
    if (!changes || typeof changes !== "object")
        return;
    const ringMode = changes.hp < 0 ? "damage" : changes.hp > 0 ? "healing" : changes.temp ? "temp" : "";
    if (!ringMode)
        return;
    const tokenDocs = actor.isToken ? [actor.token] : (actor.getActiveTokens?.(true, true) ?? []);
    for (const entry of tokenDocs) {
        try {
            const doc = entry?.document ?? entry;
            const obj = entry?.object ?? entry;
            if (!obj?.visible || doc?.isSecret)
                continue;
            if (doc?.hasDynamicRing && typeof doc.flashRing === "function")
                doc.flashRing(ringMode);
        }
        catch { /* safe skip for non-standard token documents */ }
    }
}
function patchSystemDisplayTokenEffect() {
    const ActorDoc = CONFIG?.Actor?.documentClass;
    const proto = ActorDoc?.prototype;
    if (!proto || typeof proto._displayTokenEffect !== "function")
        return;
    if (proto.__ssCombatNumbersPatched)
        return;
    proto.__ssCombatNumbersPatched = true;
    const nativeDisplay = proto._displayTokenEffect;
    proto._displayTokenEffect = function (changes, ...rest) {
        try {
            if (isFeatureActive() && isActorMuted(this)) {
                triggerTokenRingFlash(this, changes);
                return;
            }
        }
        catch { /* fall back to system implementation on error */ }
        return nativeDisplay.call(this, changes, ...rest);
    };
}
function recordPreUpdateHp(actor, hpPatch) {
    if (!isFeatureActive() || !actor || hpPatch === undefined)
        return;
    const curHp = actor.system?.attributes?.hp;
    if (!curHp)
        return;
    const keys = actorKeysOf(actor);
    if (!keys.length)
        return;
    const snap = {
        hp: Number(curHp.value) || 0,
        temp: Number(curHp.temp) || 0
    };
    for (const k of keys)
        _preVitals.set(k, snap);
    trimMap(_preVitals);
    emitAll(NS_MUTE, { keys });
}
function resolveSceneTokensForActor(actor) {
    if (actor?.token?.object)
        return [actor.token.object];
    const list = actor?.getActiveTokens?.(true) ?? [];
    return Array.isArray(list) ? list.filter(Boolean) : [];
}
function buildPopupBatch(hpDelta, tempDelta, breakdown) {
    const batch = [];
    const healedHp = hpDelta > 0 ? hpDelta : 0;
    const gainedTemp = tempDelta > 0 ? tempDelta : 0;
    const lostHp = hpDelta < 0 ? Math.abs(hpDelta) : 0;
    const lostTemp = tempDelta < 0 ? Math.abs(tempDelta) : 0;
    const totalDamage = lostHp + lostTemp;
    if (healedHp > 0) {
        batch.push({ category: "heal", amount: healedHp, modifier: "normal" });
    }
    if (gainedTemp > 0) {
        batch.push({
            category: "shield",
            amount: gainedTemp,
            modifier: "normal",
            caption: `+${Math.round(gainedTemp)}`
        });
    }
    // Regular and/or temporary HP losses are combined into a single hit batch without duplicate popups
    if (totalDamage > 0) {
        let emittedDamage = 0;
        if (breakdown && breakdown.length > 0) {
            const damageRows = breakdown.filter((e) => !isHealingCategory(e.category));
            const sumRaw = damageRows.reduce((acc, e) => acc + (e.immune ? 0 : e.amount), 0);
            for (const row of damageRows) {
                const mod = modifierFromCalc(row);
                if (mod === "immune") {
                    batch.push({ category: row.category, amount: 0, modifier: "immune" });
                    continue;
                }
                if (row.amount <= 0)
                    continue;
                const scaled = sumRaw > 0
                    ? Math.round((row.amount / sumRaw) * totalDamage)
                    : 0;
                if (scaled <= 0)
                    continue;
                const isUntyped = row.category === "plain" || row.category === "none" || row.category === "";
                if (lostHp === 0 && isUntyped) {
                    batch.push({
                        category: "shield",
                        amount: scaled,
                        modifier: mod,
                        caption: `-${scaled}`
                    });
                }
                else {
                    batch.push({ category: row.category, amount: scaled, modifier: mod });
                }
                emittedDamage++;
            }
        }
        if (emittedDamage === 0) {
            if (lostHp === 0) {
                batch.push({
                    category: "shield",
                    amount: totalDamage,
                    modifier: "normal",
                    caption: `-${Math.round(totalDamage)}`
                });
            }
            else {
                batch.push({
                    category: "plain",
                    amount: totalDamage,
                    modifier: "normal"
                });
            }
        }
    }
    return batch;
}
function processPostUpdateHp(actor) {
    if (!isFeatureActive() || !actor)
        return;
    const keys = actorKeysOf(actor);
    if (!keys.length)
        return;
    let before;
    for (const k of keys) {
        const stored = _preVitals.get(k);
        if (stored && !before)
            before = stored;
        _preVitals.delete(k);
    }
    if (!before)
        return;
    markActorMuted(keys);
    const curHp = actor.system?.attributes?.hp;
    if (!curHp)
        return;
    const hpDelta = (Number(curHp.value) || 0) - before.hp;
    const tempDelta = (Number(curHp.temp) || 0) - before.temp;
    if (hpDelta === 0 && tempDelta === 0)
        return;
    const breakdown = consumeBreakdownForActor(actor);
    const tokens = resolveSceneTokensForActor(actor);
    if (!tokens.length)
        return;
    const batch = buildPopupBatch(hpDelta, tempDelta, breakdown);
    if (!batch.length)
        return;
    for (const tok of tokens) {
        broadcastTokenPopups(tok, batch);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Universal scrollingText Interceptor for Other Game Systems
// ─────────────────────────────────────────────────────────────────────────────
function installScrollingTextInterceptor() {
    const proto = foundry?.canvas?.groups?.InterfaceCanvasGroup?.prototype
        ?? canvas?.interface?.constructor?.prototype;
    if (!proto || typeof proto.createScrollingText !== "function")
        return;
    if (proto.__ssCombatNumbersWrapped)
        return;
    proto.__ssCombatNumbersWrapped = true;
    const nativeScrollingText = proto.createScrollingText;
    proto.createScrollingText = function (origin, content, options, ...rest) {
        try {
            if (!isFeatureActive()) {
                return nativeScrollingText.call(this, origin, content, options, ...rest);
            }
            if (options?.[BYPASS_CAPTURE]) {
                const cleanOpts = { ...options };
                delete cleanOpts[BYPASS_CAPTURE];
                return nativeScrollingText.call(this, origin, content, cleanOpts, ...rest);
            }
            const rawText = String(content ?? "").trim();
            const normalized = rawText.replace(/\u2212/g, "-");
            const parsed = Number(normalized);
            // Pass non-numeric status labels ("Prone", "+Bleeding") straight through to Foundry's native renderer
            if (!rawText || !Number.isFinite(parsed)) {
                return nativeScrollingText.call(this, origin, content, options, ...rest);
            }
            const token = canvas?.tokens?.placeables?.find((t) => t?.center && origin && t.center.x === origin.x && t.center.y === origin.y);
            if (!token) {
                return nativeScrollingText.call(this, origin, content, options, ...rest);
            }
            if (!token.visible || !token.renderable || token.document?.hidden)
                return;
            if (game.system?.id === "dnd5e") {
                if (token.actor && isActorMuted(token.actor))
                    return;
                return nativeScrollingText.call(this, origin, content, options, ...rest);
            }
            const absVal = Math.abs(Math.round(parsed));
            const sign = normalized.startsWith("+") ? "+" : normalized.startsWith("-") || parsed < 0 ? "-" : "";
            const fill = parseHexColor(options?.fill) ?? (parsed > 0 ? CATEGORY_COLORS.heal : CATEGORY_COLORS.plain);
            const scaleFactor = Math.max(0.6, Math.min(2.0, (Number(options?.fontSize) || 32) / 32));
            broadcastTokenPopups(token, [{
                    category: parsed > 0 && !options?.fill ? "heal" : fill,
                    amount: absVal,
                    caption: `${sign}${absVal}`,
                    scaleFactor
                }]);
            return;
        }
        catch (err) {
            console.error(`${MODULE_ID} | Ошибка перехвата createScrollingText:`, err);
            return nativeScrollingText.call(this, origin, content, options, ...rest);
        }
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Settings Window (ApplicationV2 + .showstopper-app Design System)
// ─────────────────────────────────────────────────────────────────────────────
const { HandlebarsApplicationMixin, ApplicationV2: BaseAppV2 } = foundry.applications.api;
class DamageNumbersSettingsApp extends HandlebarsApplicationMixin(BaseAppV2) {
    static DEFAULT_OPTIONS = {
        id: "ss-combat-numbers-settings",
        classes: ["showstopper-app", "effect-settings-dialog"],
        tag: "form",
        form: {
            handler: DamageNumbersSettingsApp._onSubmitForm,
            closeOnSubmit: true
        },
        actions: {
            preview: DamageNumbersSettingsApp._onPreviewClick
        },
        window: {
            title: `${MODULE_ID}.damageNumbers.ConfigTitle`,
            icon: "fas fa-dice-d20"
        },
        position: {
            width: 460
        }
    };
    static PARTS = {
        form: {
            template: `modules/${MODULE_ID}/templates/damage-numbers-config.hbs`
        }
    };
    async _prepareContext() {
        const fonts = collectRegisteredFonts();
        const selectedFont = activeFontFamily();
        if (selectedFont && !fonts.includes(selectedFont)) {
            fonts.unshift(selectedFont);
        }
        const selectedSize = readClientSetting("size", "medium");
        return {
            enabled: readClientSetting("enabled", true),
            fonts: fonts.map((f) => ({ value: f, label: f, selected: f === selectedFont })),
            sizes: [
                { value: "small", label: game.i18n.localize(`${MODULE_ID}.damageNumbers.SizeSmall`), selected: selectedSize === "small" },
                { value: "medium", label: game.i18n.localize(`${MODULE_ID}.damageNumbers.SizeMedium`), selected: selectedSize === "medium" },
                { value: "large", label: game.i18n.localize(`${MODULE_ID}.damageNumbers.SizeLarge`), selected: selectedSize === "large" }
            ]
        };
    }
    static async _onSubmitForm(_event, _form, formData) {
        const raw = formData?.object ?? {};
        await game.settings.set(MODULE_ID, `${SETTING_NS}.enabled`, Boolean(raw.enabled));
        if (typeof raw.font === "string" && raw.font.trim()) {
            await game.settings.set(MODULE_ID, `${SETTING_NS}.font`, raw.font.trim());
        }
        if (typeof raw.size === "string" && raw.size in SIZE_PRESETS) {
            await game.settings.set(MODULE_ID, `${SETTING_NS}.size`, raw.size);
        }
    }
    static _onPreviewClick(_event, _target) {
        const controlled = canvas?.tokens?.controlled?.[0];
        const fallback = canvas?.tokens?.placeables?.find((t) => t?.visible && !t.document?.hidden);
        const token = controlled ?? fallback;
        if (!token) {
            ui?.notifications?.info?.(game.i18n.localize(`${MODULE_ID}.damageNumbers.PreviewNoToken`));
            return;
        }
        const rootEl = this?.element;
        const pickedFont = rootEl?.querySelector?.('select[name="font"]')?.value || undefined;
        const pickedSizeKey = rootEl?.querySelector?.('select[name="size"]')?.value;
        const pickedSize = pickedSizeKey && pickedSizeKey in SIZE_PRESETS ? SIZE_PRESETS[pickedSizeKey] : undefined;
        spawnLocalBatch(token, [
            { category: "slashing", amount: 14, modifier: "normal", fontOverride: pickedFont, sizeOverride: pickedSize },
            { category: "fire", amount: 22, modifier: "vuln", fontOverride: pickedFont, sizeOverride: pickedSize },
            { category: "heal", amount: 9, modifier: "normal", fontOverride: pickedFont, sizeOverride: pickedSize }
        ]);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Settings Registration, Lifecycle Hooks & Public API
// ─────────────────────────────────────────────────────────────────────────────
Hooks.once("init", () => {
    game.settings.register(MODULE_ID, `${SETTING_NS}.enabled`, {
        name: `${MODULE_ID}.damageNumbers.SettingName`,
        hint: `${MODULE_ID}.damageNumbers.SettingHint`,
        scope: "client",
        config: false,
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_ID, `${SETTING_NS}.font`, {
        scope: "client",
        config: false,
        type: String,
        default: ""
    });
    game.settings.register(MODULE_ID, `${SETTING_NS}.size`, {
        scope: "client",
        config: false,
        type: String,
        default: "medium"
    });
    game.settings.registerMenu(MODULE_ID, `${SETTING_NS}.menu`, {
        name: `${MODULE_ID}.damageNumbers.MenuName`,
        label: `${MODULE_ID}.damageNumbers.MenuLabel`,
        hint: `${MODULE_ID}.damageNumbers.MenuHint`,
        icon: "fas fa-dice-d20",
        type: DamageNumbersSettingsApp,
        restricted: false
    });
    registerAPI("damageNumbers", {
        spawn(token, entries, { broadcast = true } = {}) {
            const list = Array.isArray(entries) ? entries : [entries];
            if (!token || !list.length)
                return;
            if (broadcast)
                broadcastTokenPopups(token, list);
            else
                spawnLocalBatch(token, list);
        },
        clear() {
            for (const popup of [..._livePopups])
                popup.dispose();
        }
    });
});
Hooks.once("setup", () => {
    patchSystemDisplayTokenEffect();
});
Hooks.once("ready", () => {
    patchSystemDisplayTokenEffect();
    installScrollingTextInterceptor();
});
Hooks.on("canvasTearDown", () => {
    for (const popup of [..._livePopups])
        popup.dispose();
    _burstSlots.clear();
});
Hooks.on("dnd5e.calculateDamage", (actor, damages) => {
    if (!isFeatureActive() || !actor)
        return;
    const list = extractCalcEntries(damages);
    if (!list.length)
        return;
    const keys = actorKeysOf(actor);
    if (!keys.length)
        return;
    const rec = { at: Date.now(), list };
    for (const k of keys)
        _calcStore.set(k, rec);
    trimMap(_calcStore);
    emitAll(NS_CALC, { keys, list });
});
Hooks.on("preUpdateActor", (actor, changes) => {
    recordPreUpdateHp(actor, changes?.system?.attributes?.hp);
});
Hooks.on("preUpdateActorDelta", (delta, changes) => {
    const synthetic = delta?.syntheticActor ?? delta?.parent?.actor;
    recordPreUpdateHp(synthetic, changes?.system?.attributes?.hp);
});
Hooks.on("preUpdateToken", (tokenDoc, changes) => {
    const hpPatch = changes?.delta?.system?.attributes?.hp ?? changes?.actorData?.system?.attributes?.hp;
    if (hpPatch !== undefined)
        recordPreUpdateHp(tokenDoc?.actor, hpPatch);
});
Hooks.on("updateActor", (actor) => {
    processPostUpdateHp(actor);
});
Hooks.on("updateActorDelta", (delta) => {
    const synthetic = delta?.syntheticActor ?? delta?.parent?.actor;
    if (synthetic)
        processPostUpdateHp(synthetic);
});
