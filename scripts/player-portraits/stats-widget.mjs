/**
 * Portrait panel stats widget (bottom-left corner inside #ui-left):
 * ping · FPS · breaktime · settings gear · native AV controls host
 * (span.dvp-voice-controls — see voice-mode.mjs).
 *
 * Intervals: FPS/AFK/native states — 2s, ping — 5s. Intervals ALWAYS run
 * (AFK indicators and voice-state sync don't depend on the widget), while
 * the widget DOM exists only when the showStats setting is enabled.
 */
import { MODULE_ID, PING_UPDATE_INTERVAL, FPS_UPDATE_INTERVAL, localize } from './constants.mjs';
import { PortraitModuleSettings } from './apps.mjs';
export class StatsWidget {
    /** @param {import('./panel.mjs').DiscordVoicePortraits} panel */
    constructor(panel) {
        this.panel = panel;
        this._statsInterval = null;
        this._pingInterval = null;
        this._pinging = false;
    }
    /** Start intervals and create the widget if the setting is enabled. */
    start() {
        if (game.settings.get(MODULE_ID, "showStats")) {
            this.create();
        }
        this._statsInterval = setInterval(() => {
            if (game.settings.get(MODULE_ID, "showStats")) {
                this.update();
            }
            this.panel._updateAllAFK();
            // Native mute states arrive without hooks — resync on a timer.
            this.panel.voiceMode?.syncNativeStates();
        }, FPS_UPDATE_INTERVAL);
        this._pingInterval = setInterval(() => this._measurePing(), PING_UPDATE_INTERVAL);
        this._measurePing();
    }
    /** Stop intervals and remove the widget DOM. */
    stop() {
        if (this._statsInterval) {
            clearInterval(this._statsInterval);
            this._statsInterval = null;
        }
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        document.getElementById("dvp-stats-widget")?.remove();
    }
    /** Build the widget DOM (idempotent: removes any existing element first). */
    create() {
        document.getElementById("dvp-stats-widget")?.remove();
        const breaktimeHtml = this.panel._isBreaktimeActive()
            ? '<span class="dvp-stat-sep">·</span><span class="dvp-stat-item dvp-stat-breaktime-item" style="pointer-events:auto;cursor:pointer"><i class="fas fa-mug-hot"></i><span class="dvp-stat-breaktime-value">--</span></span>'
            : '';
        const widget = document.createElement("div");
        widget.id = "dvp-stats-widget";
        widget.classList.add("dvp-stats-widget");
        widget.innerHTML = `
      <span class="dvp-stat-item dvp-stat-ping-item">
        <i class="fas fa-signal"></i>
        <span class="dvp-stat-ping-value">--</span>
      </span>
      <span class="dvp-stat-sep">·</span>
      <span class="dvp-stat-item dvp-stat-fps-item">
        <i class="fas fa-desktop"></i>
        <span class="dvp-stat-fps-value">--</span>
      </span>
      ${breaktimeHtml}
      <span class="dvp-stat-sep">·</span>
      <span class="dvp-stat-item dvp-stat-gear-item" style="pointer-events:auto;cursor:pointer"
            data-tooltip="showstopper.Settings.MenuButton.Hint" data-tooltip-direction="UP">
        <i class="fas fa-cog"></i>
      </span>
      <span class="dvp-stat-sep dvp-voice-controls-sep">·</span>
      <span class="dvp-stat-item dvp-voice-controls"></span>
    `;
        // Lives inside the native left UI zone (like portraits): inherits --ui-scale
        // and coordinates; positioned absolute at bottom-left via CSS.
        const uiLeft = document.getElementById("ui-left");
        (uiLeft ?? document.body).appendChild(widget);
        // Shortcut: opens the same panel settings dialog as the module settings menu.
        widget.querySelector(".dvp-stat-gear-item")?.addEventListener("click", () => {
            new PortraitModuleSettings().render(true);
        });
        if (this.panel._isBreaktimeActive()) {
            widget.querySelector(".dvp-stat-breaktime-item")?.addEventListener("click", () => {
                try {
                    const paused = game.settings.get("breaktime", "paused");
                    if (game.user.isGM) {
                        if (paused)
                            game.BreakTime?.endBreak?.();
                        else
                            game.BreakTime?.startBreak?.();
                    }
                    else if (paused) {
                        game.BreakTime?.showApp?.();
                    }
                }
                catch (e) { }
            });
        }
        this.update();
    }
    /** Update ping/FPS/breaktime display values (no-op if widget is absent). */
    update() {
        const widget = document.getElementById("dvp-stats-widget");
        if (!widget)
            return;
        const ping = game.time?.averageLatency;
        const fps = this._getFPS();
        const pingEl = widget.querySelector(".dvp-stat-ping-value");
        const fpsEl = widget.querySelector(".dvp-stat-fps-value");
        const pingItem = widget.querySelector(".dvp-stat-ping-item");
        const fpsItem = widget.querySelector(".dvp-stat-fps-item");
        if (pingEl && ping !== null) {
            pingEl.textContent = `${ping} ${localize("showstopper.Portrait.MsShort")}`;
            const pingColor = ping < 100 ? "#43b581" : ping < 200 ? "#faa61a" : "#f04747";
            pingItem.style.color = pingColor;
        }
        if (fpsEl && fps !== null) {
            fpsEl.textContent = `${fps}`;
            const fpsColor = fps >= 50 ? "#43b581" : fps >= 30 ? "#faa61a" : "#f04747";
            fpsItem.style.color = fpsColor;
        }
        const btItem = widget.querySelector(".dvp-stat-breaktime-item");
        if (btItem) {
            try {
                const paused = game.settings.get("breaktime", "paused");
                const val = btItem.querySelector(".dvp-stat-breaktime-value");
                if (val) {
                    val.textContent = paused
                        ? localize("showstopper.Portrait.BreakLabel")
                        : localize("showstopper.Portrait.ActiveLabel");
                    btItem.style.color = paused ? "#f0a0a0" : "#43b581";
                }
            }
            catch (e) { }
        }
    }
    /* ── Ping & FPS ──────────────────────────────────────────────────────── */
    /** Ping probe: game.time.sync warms up averageLatency read by update(). */
    _measurePing() {
        if (this._pinging || !game.time?.sync)
            return;
        this._pinging = true;
        game.time.sync().finally(() => { this._pinging = false; });
    }
    _getFPS() {
        try {
            const values = canvas.fps?.values;
            if (values?.length) {
                const sum = values.reduce((a, b) => a + b, 0);
                return Math.round(sum / values.length);
            }
            return null;
        }
        catch (e) { }
        return null;
    }
}
