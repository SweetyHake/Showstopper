import { MODULE_ID, INTRO_CONFIG, DANGER_LEVELS, TBC_CONFIG } from '../config.mjs';
import { CanvasEffect, canvasEffects } from '../core/effect-manager.mjs';
import { registerAPI, unregisterAPI, publishAPI } from '../core/runtime.mjs';
import { getSocket, registerSocketHandler, unregisterSocketHandler, registerRawHandler, emitAll, emitRaw, emitGM } from '../core/socket-manager.mjs';
import { getDangerLevel, getActorCR, getActorTitle } from '../utils.mjs';
import { resizeImageTo1024, isAnimatedImage } from '../utils/image-utils.mjs';
import { ringUpdateFields, tokenTextureScale, isRingToken } from '../general/token-ring.mjs';
import { STAIN } from '../blood/stains.mjs';
import { BaseEffect, normalizeExecOptions, resolveLocalizableText } from './base-effect.mjs';
import { defineEffect } from './define-effect.mjs';
import { finisherEffects, defineFinisher, registerFinisher, unregisterFinisher, buildFinishersAPI } from './finishers/index.mjs';
import { FinisherEffect } from './finishers/finisher-effect.mjs';
import { FinisherRunner, Ease, lerpColor, ParticleTextures } from './finishers/finisher-engine.mjs';
import { jb2aReady, playSequencerEffects, hasSequencer, hasJB2A, sequencerShake, showstopperBlood, splatterSplash } from './finishers/finisher-integrations.mjs';
import { playFinisherSound, FINISHER_SOUND_FLAVORS, stopAllFinisherSounds } from './finishers/finisher-audio.mjs';
import { introQueue } from './intro-queue.mjs';
import { effectRegistry } from './registry.mjs';
import { getActorIntroData, buildPortraitInlineStyle, resolveIntroTarget, getActorPreferredIntroId, getLocalizedCreatureType, stripBracketTranslation } from './utils/actor-intro-data.mjs';
import { getEffectSettings, getEffectSetting, setEffectSettings, resetEffectSettings } from './utils/effect-settings.mjs';
import { createIntroOverlay, escapeHtml } from './utils/overlay-utils.mjs';
import * as soundSynth from './utils/sound-synth.mjs';

export const introductionEffects: any[] = [];
export const openingEffects: any[] = [];
export const endingEffects: any[] = [];

effectRegistry._setDeclarativeFactory(defineEffect);

export const allEffects = new Proxy({}, {
  get(_, category: string) { return effectRegistry.getByCategory(category); },
  ownKeys() { return effectRegistry.categories; },
  getOwnPropertyDescriptor(_, key: string) {
    const effects = effectRegistry.getByCategory(key);
    return effects.length ? { configurable: true, enumerable: true, value: effects, writable: false } : undefined;
  }
});

export function getAllEffectsData() {
  const data: Record<string, any[]> = {};
  for (const [category, effects] of Object.entries(allEffects) as any[]) {
    data[category] = effects.map(effect => effect.toEffectData());
  }
  return data;
}

export function getEffectById(id: string) {
  return effectRegistry.get(id);
}

export function injectAllStyles() {
  effectRegistry.injectAllStyles();
}

/**
 * Universal effect registration (accepts a class OR a declarative definition object).
 * When `defaultCategory` is provided, it is applied to declarative objects lacking `category`.
 */
export function registerEffect(target: any, defaultCategory?: string) {
  if (!target) throw new Error(`${MODULE_ID} | registerEffect: target is required`);
  if (typeof target === 'object' && defaultCategory && !target.category) {
    return effectRegistry.register({ ...target, category: defaultCategory });
  }
  if (typeof target === 'function' && defaultCategory && !target.category) {
    target.category = defaultCategory;
  }
  return effectRegistry.register(target);
}

export function unregisterEffect(id: string) {
  return effectRegistry.unregister(id);
}

export function registerIntro(target: any) {
  return registerEffect(target, 'introductions');
}

export function registerOpening(target: any) {
  return registerEffect(target, 'openings');
}

export function registerEnding(target: any) {
  return registerEffect(target, 'endings');
}

export function registerCategory(def: any) {
  return effectRegistry.registerCategory(def);
}

export function unregisterCategory(id: string) {
  return effectRegistry.unregisterCategory(id);
}

/**
 * Programmatically plays any registered effect by its `id`.
 * For introductions, supports `{ actor, token, actorId, tokenId, localOnly, settings, payload }`.
 * For finishers, supports `{ targets, tokenIds, options, localOnly }`.
 */
export async function playEffect(id: string, options: any = {}) {
  const EffectClass = effectRegistry.get(id);
  if (!EffectClass) {
    console.warn(`${MODULE_ID} | playEffect: effect '${id}' is not registered`);
    return null;
  }
  if (EffectClass.category === 'finishers' && options && typeof options === 'object') {
    const targets = options.targets ?? (options.token ? [options.token] : null);
    const tokenIds = options.tokenIds ?? targets?.map((t: any) => t?.id ?? t).filter(Boolean);
    return EffectClass.execute({
      tokenIds,
      options: options.options ?? options,
      localOnly: Boolean(options.localOnly)
    });
  }
  if (typeof options === 'boolean') {
    return EffectClass.execute(options);
  }
  if (options && typeof options === 'object' && Object.keys(options).length > 0) {
    return EffectClass.execute(options);
  }
  return EffectClass.execute(false);
}

/**
 * Locally previews any registered effect by `id` (without socket broadcast).
 */
export async function previewEffect(id: string, options: any = {}) {
  const opts = typeof options === 'object' && options ? { ...options, localOnly: true } : { localOnly: true };
  return playEffect(id, opts);
}

/**
 * Plays the preferred introduction stored on the Actor sheet
 * (`flags.showstopper.introEffectId`), falling back to `fallbackId` (defaults to
 * `'hero-intro'` or the first available introduction in the registry).
 */
export async function playActorIntro(actorOrToken: any = null, options: any = {}) {
  const baseOpts = typeof options === 'object' && options ? { ...options } : {};
  if (actorOrToken) {
    if (actorOrToken.actor || actorOrToken.document?.actor) {
      baseOpts.token = actorOrToken;
    } else if (typeof actorOrToken === 'string') {
      if (globalThis.canvas?.tokens?.get?.(actorOrToken)) baseOpts.tokenId = actorOrToken;
      else baseOpts.actorId = actorOrToken;
    } else {
      baseOpts.actor = actorOrToken;
    }
  }

  const resolved = resolveIntroTarget(baseOpts);
  if (!resolved.actor) return null;

  const preferredId = baseOpts.effectId || getActorPreferredIntroId(resolved.actor);
  let targetEffect = preferredId ? effectRegistry.get(preferredId) : null;
  if (!targetEffect || !targetEffect.isAvailable) {
    const fallbackId = baseOpts.fallbackId || 'hero-intro';
    targetEffect = effectRegistry.get(fallbackId);
  }
  if (!targetEffect || !targetEffect.isAvailable) {
    targetEffect = effectRegistry.getByCategory('introductions').find(e => e.isAvailable) ?? null;
  }
  if (!targetEffect) {
    console.warn(`${MODULE_ID} | playActorIntro: no available introduction effects registered`);
    return null;
  }

  return targetEffect.execute({
    ...baseOpts,
    actor: resolved.actor,
    token: resolved.token
  });
}

function _groundStainDefsProxy(defs: any[], upTo?: number) {
  const fn = (globalThis as any).showstopper?.blood?.groundStainDefs;
  return typeof fn === 'function' ? fn(defs, upTo) : defs;
}

/** Public `showstopper.cutIns` namespace for third-party modules and macros. */
export function buildCutInsAPI() {
  return {
    registry: effectRegistry,
    register: registerEffect,
    unregister: unregisterEffect,
    define: defineEffect,
    defineFinisher,
    registerIntro,
    registerOpening,
    registerEnding,
    registerFinisher,
    unregisterFinisher,
    registerCategory,
    unregisterCategory,
    getCategories: () => effectRegistry.getCategories(),
    getCategory: (id: string) => effectRegistry.getCategory(id),
    has: (id: string) => effectRegistry.has(id),
    get: getEffectById,
    getAll: () => effectRegistry.getAll(),
    getByCategory: (cat: string) => effectRegistry.getByCategory(cat),
    play: playEffect,
    preview: previewEffect,
    playActorIntro,
    settings: {
      getAll: getEffectSettings,
      get: getEffectSetting,
      set: setEffectSettings,
      reset: resetEffectSettings
    },
    queue: introQueue
  };
}

/** Public set of base classes and utilities in `showstopper.sdk` (avoids relative ESM imports). */
export function buildSDKAPI() {
  return {
    MODULE_ID,
    INTRO_CONFIG,
    DANGER_LEVELS,
    TBC_CONFIG,
    registerAPI,
    unregisterAPI,
    publishAPI,
    BaseEffect,
    FinisherEffect,
    FinisherRunner,
    Ease,
    lerpColor,
    ParticleTextures,
    jb2aReady,
    playSequencerEffects,
    hasSequencer,
    hasJB2A,
    sequencerShake,
    showstopperBlood,
    splatterSplash,
    playFinisherSound,
    FINISHER_SOUND_FLAVORS,
    stopAllFinisherSounds,
    STAIN,
    groundStainDefs: _groundStainDefsProxy,
    CanvasEffect,
    canvasEffects,
    defineEffect,
    defineFinisher,
    effectRegistry,
    registerEffect,
    unregisterEffect,
    registerIntro,
    registerOpening,
    registerEnding,
    registerFinisher,
    unregisterFinisher,
    registerCategory,
    unregisterCategory,
    normalizeExecOptions,
    resolveLocalizableText,
    createIntroOverlay,
    escapeHtml,
    getDangerLevel,
    getActorCR,
    getActorTitle,
    ringUpdateFields,
    tokenTextureScale,
    isRingToken,
    getActorIntroData,
    buildPortraitInlineStyle,
    resolveIntroTarget,
    getActorPreferredIntroId,
    getLocalizedCreatureType,
    stripBracketTranslation,
    resizeImageTo1024,
    isAnimatedImage,
    introQueue,
    soundSynth,
    socket: getSocket(),
    registerSocketHandler,
    unregisterSocketHandler,
    registerRawHandler,
    emitAll,
    emitRaw,
    emitGM
  };
}

const _sdkSingleton = buildSDKAPI();
registerAPI('sdk', _sdkSingleton);
registerAPI('cutIns', buildCutInsAPI());
registerAPI('finishers', buildFinishersAPI());

export {
  BaseEffect,
  defineEffect,
  finisherEffects,
  registerFinisher,
  unregisterFinisher,
  effectRegistry
};
