import { MODULE_ID } from './player-portraits/constants.mjs';
import { DiscordVoicePortraits } from './player-portraits/panel.mjs';
import { PortraitModuleSettings } from './player-portraits/apps.mjs';
import { registerAPI } from './core/runtime.mjs';

let discordVoicePortraits = null;

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "showstopper.Settings.Enabled.Name",
    hint: "showstopper.Settings.Enabled.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "portraitSize", {
    name: "showstopper.Settings.PortraitSize.Name",
    hint: "showstopper.Settings.PortraitSize.Hint",
    scope: "client",
    config: false,
    type: String,
    default: "large",
    choices: {
      xs: "showstopper.Settings.PortraitSize.XS",
      small: "showstopper.Settings.PortraitSize.Small",
      medium: "showstopper.Settings.PortraitSize.Medium",
      large: "showstopper.Settings.PortraitSize.Large",
      xl: "showstopper.Settings.PortraitSize.XL"
    }
  });

  game.settings.register(MODULE_ID, "showStats", {
    name: "showstopper.Settings.ShowStats.Name",
    hint: "showstopper.Settings.ShowStats.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "speakingShake", {
    name: "showstopper.Settings.SpeakingShake.Name",
    hint: "showstopper.Settings.SpeakingShake.Hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.registerMenu(MODULE_ID, "settingsMenu", {
    name: "showstopper.Settings.MenuButton.Name",
    label: "showstopper.Settings.MenuButton.Label",
    hint: "showstopper.Settings.MenuButton.Hint",
    icon: "fas fa-cogs",
    type: PortraitModuleSettings,
    restricted: false
  });

  // Early class on body: gates the static CSS that hides the camera dock.
  // Applied at init/setup — BEFORE the first UI render, otherwise the default
  // dock flashes on page load. Voice-mode integration is always active
  // (no separate toggle setting anymore).
  const isVoiceModeActive = () => {
    try {
      const mode = game.settings.get("core", "rtcWorldSettings")?.mode;
      return Number.isFinite(mode) && mode !== 0;
    } catch (e) {
      return false;
    }
  };

  const applyEarlyClasses = () => {
    let enabled = false;
    try {
      enabled = game.settings.get(MODULE_ID, "enabled");
    } catch (e) { /* setting not registered yet */ }
    // Hide the active players list while the portrait panel is enabled.
    document.body.classList.toggle("dvp-active", enabled);
    document.body.classList.toggle("dvp-voice-hud", enabled && isVoiceModeActive());
  };

  applyEarlyClasses();
  Hooks.once("setup", applyEarlyClasses);
});

Hooks.once("ready", () => {
  // Panel toggle: creates/destroys on the fly without reloading the page.
  // init() adds body.dvp-active and sets up DOM/hooks; destroy() tears
  // everything back down (including dvp-voice-hud and native AV buttons).
  const setPortraitsEnabled = (enabled) => {
    if (enabled) {
      if (!discordVoicePortraits) {
        discordVoicePortraits = new DiscordVoicePortraits();
        discordVoicePortraits.init();
      }
    } else {
      discordVoicePortraits?.destroy();
      discordVoicePortraits = null;
    }
    registerAPI("instance", discordVoicePortraits);
  };

  registerAPI("setEnabled", setPortraitsEnabled);
  registerAPI("instance", null);
  registerAPI("renderPortraits", () => discordVoicePortraits?.renderPortraits());
  registerAPI("destroy", () => setPortraitsEnabled(false));

  setPortraitsEnabled(game.settings.get(MODULE_ID, "enabled"));
});
