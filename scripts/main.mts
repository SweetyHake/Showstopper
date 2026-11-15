import { MODULE_ID, DANGER_LEVELS, INTRO_CONFIG, TBC_CONFIG } from './config.mjs';
import { registerAPI, publishAPI } from './core/runtime.mjs';
import { getSocket } from './core/socket-manager.mjs';
import { initCache } from './cache.mjs';
import { CinemaMenuDialog } from './cut-ins/ui/cinema-menu.mjs';
import { ActorIntroConfigDialog } from './cut-ins/ui/actor-intro-config.mjs';
import { getDangerLevel, getActorCR, getActorTitle } from './utils.mjs';
import { getActorIntroData, getActorDisplayName, getActorDisplayPortrait, getActorIntroTitle, getActorIntroDescription } from './cut-ins/utils/actor-intro-data.mjs';
import { introQueue } from './cut-ins/intro-queue.mjs';
import {
  BaseEffect,
  defineEffect,
  allEffects,
  getEffectById,
  injectAllStyles,
  effectRegistry,
  registerEffect,
  unregisterEffect,
  registerIntro,
  registerOpening,
  registerEnding,
  registerCategory,
  unregisterCategory,
  playEffect,
  previewEffect,
  playActorIntro
} from './cut-ins/index.mjs';
import { registerFinisher } from './cut-ins/finishers/index.mjs';
import { FINISHER_SOUND_FLAVORS, stopAllFinisherSounds } from './cut-ins/finishers/finisher-audio.mjs';
import { registerEffectSettingsStorage } from './cut-ins/utils/effect-settings.mjs';
import './animations/token-movement.mjs';
import { RollStats } from './stat-tracker.mjs';

const HEADER_BUTTON_ICON = 'fa-solid fa-clapperboard';

function registerCoreAPIs() {
  registerAPI('CinemaMenu', () => CinemaMenuDialog.show());
  registerAPI('ActorIntroConfig', (actor) => ActorIntroConfigDialog.show(actor));
  registerAPI('effects', allEffects);
  registerAPI('effectRegistry', effectRegistry);
  registerAPI('socket', getSocket());
  registerAPI('BaseEffect', BaseEffect);
  registerAPI('defineEffect', defineEffect);
  registerAPI('registerEffect', registerEffect);
  registerAPI('unregisterEffect', unregisterEffect);
  registerAPI('registerIntro', registerIntro);
  registerAPI('registerOpening', registerOpening);
  registerAPI('registerEnding', registerEnding);
  registerAPI('registerFinisher', registerFinisher);
  registerAPI('registerCategory', registerCategory);
  registerAPI('unregisterCategory', unregisterCategory);
  registerAPI('play', playEffect);
  registerAPI('preview', previewEffect);
  registerAPI('playActorIntro', playActorIntro);
  registerAPI('getEffectById', getEffectById);
  registerAPI('introQueue', introQueue);
  registerAPI('DANGER_LEVELS', DANGER_LEVELS);
  registerAPI('INTRO_CONFIG', INTRO_CONFIG);
  registerAPI('TBC_CONFIG', TBC_CONFIG);
  registerAPI('getDangerLevel', getDangerLevel);
  registerAPI('getActorCR', getActorCR);
  registerAPI('getActorTitle', getActorTitle);
  registerAPI('getActorIntroData', getActorIntroData);
  registerAPI('getActorDisplayName', getActorDisplayName);
  registerAPI('getActorDisplayPortrait', getActorDisplayPortrait);
  registerAPI('getActorIntroTitle', getActorIntroTitle);
  registerAPI('getActorIntroDescription', getActorIntroDescription);
  registerAPI('finisherSounds', { flavors: FINISHER_SOUND_FLAVORS, stopAll: stopAllFinisherSounds });
  registerAPI('playIntroduction', (opts?: any) => playActorIntro(null, opts));
  registerAPI('playEnding', (opts?: any) => {
    const ending = effectRegistry.get('tbc-ending')
      || effectRegistry.getByCategory('endings').find(e => e.isAvailable);
    return ending ? ending.execute(opts) : null;
  });
}

initCache();
registerCoreAPIs();

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing cinema module`);

  registerEffectSettingsStorage();
  RollStats.registerSettings();
  RollStats.registerLogSetting();

  publishAPI();

  Hooks.callAll('showstopper.init', globalThis.showstopper);
});

Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user.isGM) return;
  if (!effectRegistry.hasEffects()) return;

  const tokenControls = controls.tokens;
  if (!tokenControls?.tools) return;

  const titleKey = `${MODULE_ID}.cut-ins.ui.menuTitle`;
  const titleText = game.i18n.localize(titleKey);

  tokenControls.tools["cinematic-menu"] = {
    name: "cinematic-menu",
    title: titleText !== titleKey ? titleText : "Cinematic Effects",
    icon: "fa-solid fa-film",
    visible: true,
    button: true,
    onChange: () => CinemaMenuDialog.toggle()
  };

});

function registerActorHooks() {
  const hasIntroEffects = () => effectRegistry.getByCategory('introductions').length > 0;

  Hooks.on('getActorSheetHeaderButtons', (app, buttons) => {
    if (!hasIntroEffects()) return;
    const actor = app?.actor || app?.document;
    if (!actor?.isOwner) return;
    if (buttons.some(btn => btn.class === 'showstopper-intro-config')) return;
    buttons.unshift({
      class: 'showstopper-intro-config',
      icon: HEADER_BUTTON_ICON,
      label: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.buttonTooltip`),
      onclick: () => ActorIntroConfigDialog.show(actor)
    });
  });
  const addActorSheetV2Control = (app, controls) => {
    const actor = app.document;
    if (!actor || !(actor instanceof Actor)) return;
    if (hasIntroEffects() && actor.isOwner && !controls.some(ctrl => ctrl.action === 'showstopperIntroConfig')) {
      controls.push({
        label: game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.buttonTooltip`),
        icon: HEADER_BUTTON_ICON,
        action: 'showstopperIntroConfig',
        onClick: () => ActorIntroConfigDialog.show(actor),
        order: 0
      });
    }
    if (game.system?.id === 'dnd5e'
      && actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)
      && !controls.some(ctrl => ctrl.action === 'showstopperStats')) {
      controls.push({
        label: 'showstopper.Stats.Title',
        icon: 'fa-solid fa-chart-column',
        action: 'showstopperStats',
        onClick: () => RollStats.showStats(actor.uuid)
      });
    }
  };
  Hooks.on('getHeaderControlsActorSheetV2', addActorSheetV2Control);
  Hooks.on('getActorContextOptions', (app, options) => {
    const menuLabel = game.i18n.localize(`${MODULE_ID}.cut-ins.ui.config.contextMenu`);
    if (options.some(opt => opt.label === menuLabel || opt.name === menuLabel)) return;
    options.push({
      label: menuLabel,
      icon: `<i class="${HEADER_BUTTON_ICON}"></i>`,
      visible: li => {
        if (!hasIntroEffects()) return false;
        const element = li instanceof HTMLElement ? li : li[0];
        const actorId = element?.dataset?.documentId || element?.dataset?.entryId;
        return game.actors.get(actorId)?.isOwner;
      },
      onClick: (event, li) => {
        const element = li instanceof HTMLElement ? li : li[0];
        const actorId = element?.dataset?.documentId || element?.dataset?.entryId;
        const actor = game.actors.get(actorId);
        if (actor) ActorIntroConfigDialog.show(actor);
      }
    });
  });
}

export {
  CinemaMenuDialog,
  ActorIntroConfigDialog,
  allEffects,
  getEffectById,
  introQueue,
  DANGER_LEVELS,
  INTRO_CONFIG,
  TBC_CONFIG,
  getDangerLevel,
  getActorCR,
  getActorTitle,
  getActorIntroData,
  getActorDisplayName,
  getActorDisplayPortrait,
  getActorIntroTitle,
  getActorIntroDescription
};

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | Module ready`);
  injectAllStyles();
  registerActorHooks();

  if (game.system.id === 'dnd5e') {
    RollStats.init();
    registerAPI('Stats', RollStats);
  }

  publishAPI();
  Hooks.callAll('showstopper.ready', globalThis.showstopper);
});
