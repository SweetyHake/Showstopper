import { MODULE_ID } from '../config.mjs';
import { getSocket } from '../core/socket-manager.mjs';
import { getActorCR, getDangerLevel, getActorTitle } from '../utils.mjs';
import { BaseEffect, normalizeExecOptions, resolveLocalizableText } from './base-effect.mjs';
import { introQueue } from './intro-queue.mjs';
import { getActorIntroData, buildPortraitInlineStyle, resolveIntroTarget } from './utils/actor-intro-data.mjs';
import { createIntroOverlay, escapeHtml } from './utils/overlay-utils.mjs';
import * as soundSynth from './utils/sound-synth.mjs';

export interface DeclarativeSettingField {
  name: string;
  type: 'text' | 'textarea' | 'number' | 'range' | 'checkbox' | 'select' | 'color' | 'sound' | 'image' | 'video';
  label: string | (() => string);
  hint?: string | (() => string);
  group?: 'common' | 'unique';
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  suffix?: string;
  options?: Array<{ value: string; label: string | (() => string) }>;
  choices?: Record<string, string | (() => string)>;
}

/**
 * Creates a full effect class (BaseEffect subclass) from a declarative definition object.
 * Supports both a managed lifecycle (`prepare` + `render` with automatic socket
 * synchronization, `introQueue` queuing, and safe DOM/audio cleanup) and manual
 * `execute(localOnlyOrOptions, sdk)`.
 */
export function defineEffect(def: Record<string, any>) {
  if (!def || typeof def !== 'object') {
    throw new Error(`${MODULE_ID} | defineEffect: definition object is required`);
  }
  if (!def.id || typeof def.id !== 'string') {
    throw new Error(`${MODULE_ID} | defineEffect: non-empty string 'id' is required`);
  }

  const category = def.category || 'introductions';
  const socketChannel = `cutin:play:${def.id}`;
  const renderFn = def.render ?? def.playLocal ?? null;
  const includeSoundSettings = def.includeSoundSettings !== false;

  class DefinedCutInEffect extends BaseEffect {
    static id = def.id;
    static icon = def.icon || 'fa-solid fa-star';
    static category = category;
    static order = typeof def.order === 'number' ? def.order : 0;
    static enabled = def.enabled ?? true;
    static requiredSystem = def.requiredSystem ?? null;
    static requiredModules = def.requiredModules ?? null;
    static nameLabel = def.name ?? def.nameLabel ?? null;
    static descriptionLabel = def.description ?? def.descriptionLabel ?? null;
    static hintLabel = def.hint ?? def.hintLabel ?? null;

    static get isAvailable() {
      if (!super.isAvailable) return false;
      if (typeof def.isAvailable === 'function') {
        try {
          return Boolean(def.isAvailable(this));
        } catch {
          return false;
        }
      }
      if (typeof def.isAvailable === 'boolean') return def.isAvailable;
      return true;
    }

    static get localizationKey() {
      if (def.localizationKey) return String(def.localizationKey);
      return super.localizationKey;
    }

    static get localizationPrefix() {
      if (def.localizationPrefix) return String(def.localizationPrefix);
      return super.localizationPrefix;
    }

    static get defaultSoundPath() {
      if (typeof def.defaultSoundPath === 'function') return def.defaultSoundPath();
      return def.defaultSoundPath ?? null;
    }

    static getSettingsSchema() {
      const common = includeSoundSettings ? super.getSettingsSchema() : [];
      const rawFields: DeclarativeSettingField[] = typeof def.getSettingsSchema === 'function'
        ? def.getSettingsSchema.call(this)
        : (typeof def.settings === 'function' ? def.settings(this) : (Array.isArray(def.settings) ? def.settings : []));

      const extra = rawFields.map((field) => ({
        ...field,
        group: field.group || 'unique',
        label: resolveLocalizableText(field.label, field.name),
        hint: field.hint != null ? resolveLocalizableText(field.hint, '') : undefined
      }));

      // Do not duplicate common fields if the author overrode getSettingsSchema manually and already included them
      if (typeof def.getSettingsSchema === 'function') {
        return extra;
      }
      return [...common, ...extra];
    }

    static getStyles() {
      if (typeof def.getStyles === 'function') return def.getStyles.call(this) || '';
      if (typeof def.styles === 'function') return def.styles(this) || '';
      if (typeof def.styles === 'string') return def.styles;
      return '';
    }

    static getPreloadAssets() {
      const base = super.getPreloadAssets();
      const extraRaw = typeof def.getPreloadAssets === 'function'
        ? def.getPreloadAssets.call(this, base)
        : (typeof def.preloadAssets === 'function' ? def.preloadAssets(this, base) : def.preloadAssets);
      if (!extraRaw || typeof extraRaw !== 'object') return base;
      return {
        sounds: [...new Set([...(base.sounds || []), ...(extraRaw.sounds || [])])],
        images: [...new Set([...(base.images || []), ...(extraRaw.images || [])])],
        videos: [...new Set([...(base.videos || []), ...(extraRaw.videos || [])])]
      };
    }

    static registerSocketHandler(socket) {
      if (typeof renderFn === 'function' && typeof def.execute !== 'function') {
        socket.register(socketChannel, (payload) => {
          this._dispatchClient(payload);
        });
      }
      if (typeof def.registerSocketHandler === 'function') {
        def.registerSocketHandler.call(this, socket);
      }
    }

    static _buildSDKHelpers() {
      return {
        effect: this,
        escapeHtml,
        createIntroOverlay,
        getActorIntroData,
        buildPortraitInlineStyle,
        resolveIntroTarget,
        introQueue,
        synth: soundSynth,
        socket: getSocket()
      };
    }

    static async execute(localOnlyOrOptions: any = false) {
      if (!this.isAvailable) {
        const hint = this.getHint();
        if (hint) globalThis.ui?.notifications?.warn?.(hint);
        return null;
      }

      if (typeof def.execute === 'function') {
        return def.execute.call(this, localOnlyOrOptions, this._buildSDKHelpers());
      }

      if (typeof renderFn !== 'function') {
        console.warn(`${MODULE_ID} | Effect '${this.id}' defines neither render() nor execute()`);
        return null;
      }

      const opts = normalizeExecOptions(localOnlyOrOptions);
      const requiresToken = def.requiresToken ?? (this.category === 'introductions');
      const hasExplicitTarget = Boolean(opts.actor || opts.token || opts.actorId || opts.tokenId);

      let actor = null;
      let token = null;
      let tokenDoc = null;
      let introData = null;

      if (requiresToken || hasExplicitTarget) {
        const resolved = resolveIntroTarget({ ...opts, silent: !requiresToken || Boolean(opts.silent) });
        actor = resolved.actor;
        token = resolved.token;
        tokenDoc = resolved.tokenDoc;
        if (requiresToken && !actor) return null;
        if (actor) {
          introData = await getActorIntroData(actor, tokenDoc);
        }
      }

      const settings = {
        ...this.getDefaultSettings(),
        ...this.getSettings(),
        ...(opts.settings && typeof opts.settings === 'object' ? opts.settings : {})
      };

      const soundPath = opts.soundPath !== undefined
        ? opts.soundPath
        : (settings.soundPath || this.defaultSoundPath || null);
      const soundVolume = opts.soundVolume !== undefined
        ? Number(opts.soundVolume)
        : Number(settings.soundVolume ?? 0.8);

      const cr = actor ? getActorCR(actor) : null;
      const dangerLevel = cr != null ? getDangerLevel(cr) : null;
      const fallbackTitle = actor ? (introData?.title || await getActorTitle(actor) || '') : '';

      const payload: Record<string, any> = {
        effectId: this.id,
        settings,
        soundPath,
        soundVolume,
        ...(actor ? {
          actorId: actor.id ?? null,
          tokenId: token?.id ?? tokenDoc?.id ?? null,
          sceneId: globalThis.canvas?.scene?.id ?? null,
          displayName: introData?.displayName ?? actor.name ?? '',
          name: introData?.displayName ?? actor.name ?? '',
          portrait: introData?.portrait ?? actor.img ?? '',
          image: introData?.portrait ?? actor.img ?? '',
          title: fallbackTitle,
          description: introData?.description ?? '',
          portraitConfig: introData?.portraitConfig ?? { offsetX: 0, offsetY: 0, scale: 1 },
          portraitStyle: buildPortraitInlineStyle(introData?.portraitConfig),
          cr,
          dangerLevel
        } : {}),
        ...(opts.payload && typeof opts.payload === 'object' ? opts.payload : {})
      };

      if (typeof def.prepare === 'function') {
        const prepResult = await def.prepare.call(this, {
          effect: this,
          actor,
          token,
          tokenDoc,
          introData,
          settings,
          soundPath,
          soundVolume,
          localOnly: opts.localOnly,
          options: opts,
          payload,
          sdk: this._buildSDKHelpers()
        });
        if (prepResult === false || prepResult === null) {
          return null;
        }
        if (prepResult && typeof prepResult === 'object') {
          Object.assign(payload, prepResult);
        }
      }

      const canBroadcast = !opts.localOnly && Boolean(globalThis.game?.socket);
      if (canBroadcast) {
        getSocket().executeForEveryone(socketChannel, payload);
      } else {
        await this._dispatchClient(payload);
      }

      return payload;
    }

    static async _dispatchClient(payload: Record<string, any>) {
      const queued = def.queued ?? (this.category === 'introductions');
      if (!queued) {
        await this._runRender(payload, false);
        return;
      }

      return new Promise<void>((resolve) => {
        let cancelFn: (() => void) | null = null;
        introQueue.add(
          async () => {
            try {
              await this._runRender(payload, true, (fn) => {
                cancelFn = fn;
                introQueue.setCurrentCleanup(fn);
              });
            } finally {
              introQueue.complete();
              resolve();
            }
          },
          () => cancelFn?.()
        );
      });
    }

    static async _runRender(
      payload: Record<string, any>,
      inQueue: boolean,
      registerAbort?: (fn: () => void) => void
    ) {
      let cancelled = false;
      const cleanups = new Set<() => void>();
      const timers = new Set<any>();

      const runCleanups = () => {
        if (cancelled) return;
        cancelled = true;
        for (const t of timers) clearTimeout(t);
        timers.clear();
        for (const fn of [...cleanups]) {
          try { fn(); } catch (e) { console.error(`${MODULE_ID} | Effect '${this.id}' cleanup error:`, e); }
        }
        cleanups.clear();
        try { BaseEffect.stopIntroSound(); } catch { /* ignore */ }
        try { soundSynth.stopAllSynthSounds(); } catch { /* ignore */ }
      };

      registerAbort?.(runCleanups);

      let tearDownHookId: number | null = null;
      if (globalThis.Hooks?.once) {
        tearDownHookId = Hooks.once('canvasTearDown', () => runCleanups());
      }

      const actor = payload.actorId ? (globalThis.game?.actors?.get?.(payload.actorId) ?? null) : null;
      const token = payload.tokenId ? (globalThis.canvas?.tokens?.get?.(payload.tokenId) ?? null) : null;

      const ctx = {
        effect: this,
        payload,
        settings: payload.settings || {},
        soundPath: payload.soundPath ?? null,
        soundVolume: payload.soundVolume ?? 0.8,
        actor,
        token,
        inQueue,
        escapeHtml,
        synth: soundSynth,
        isCancelled: () => cancelled,
        onCleanup(fn: () => void) {
          if (typeof fn !== 'function') return;
          if (cancelled) {
            try { fn(); } catch { /* ignore */ }
            return;
          }
          cleanups.add(fn);
        },
        wait(ms: number): Promise<boolean> {
          if (cancelled || !(ms > 0)) return Promise.resolve(!cancelled);
          return new Promise<boolean>((resolve) => {
            let settled = false;
            const settle = (ok: boolean) => {
              if (settled) return;
              settled = true;
              timers.delete(tid);
              cleanups.delete(abortWait);
              resolve(ok);
            };
            const abortWait = () => settle(false);
            const tid = setTimeout(() => settle(!cancelled), ms);
            timers.add(tid);
            cleanups.add(abortWait);
          });
        },
        async playSound(volumeOverride: number | null = null) {
          const src = payload.soundPath;
          if (!src) return null;
          const vol = volumeOverride ?? payload.soundVolume ?? 0.8;
          try {
            const interfaceVolume = globalThis.game?.settings?.get?.('core', 'globalInterfaceVolume') ?? 0.5;
            const snd = await foundry.audio.AudioHelper.play({
              src,
              volume: vol * interfaceVolume,
              autoplay: true,
              loop: false
            }, false);
            if (cancelled) {
              try { snd?.stop?.(); } catch { /* ignore */ }
              return null;
            }
            if (snd) cleanups.add(() => { try { snd.stop(); } catch { /* ignore */ } });
            return snd;
          } catch (e) {
            console.warn(`${MODULE_ID} | Failed to play sound for '${DefinedCutInEffect.id}':`, e);
            return null;
          }
        },
        stopSound() {
          try { BaseEffect.stopIntroSound(); } catch { /* ignore */ }
          try { soundSynth.stopAllSynthSounds(); } catch { /* ignore */ }
        },
        createOverlay(opts: {
          html: string;
          clickDelay?: number;
          autoCloseDelay?: number;
          closeClass?: string;
          fadeMs?: number;
          onClose?: () => void;
        }) {
          let resolveDone!: () => void;
          const done = new Promise<void>((r) => { resolveDone = r; });
          const handle = createIntroOverlay({
            ...opts,
            onClose: () => {
              try { opts.onClose?.(); } finally { resolveDone(); }
            }
          });
          cleanups.add(() => handle.close(false));
          return { ...handle, done };
        }
      };

      try {
        await renderFn.call(this, payload, ctx);
      } finally {
        if (tearDownHookId != null && globalThis.Hooks?.off) {
          try { Hooks.off('canvasTearDown', tearDownHookId); } catch { /* ignore */ }
        }
        runCleanups();
      }
    }
  }

  // Copy any additional custom properties/methods onto the generated class
  for (const [k, v] of Object.entries(def)) {
    if (k in DefinedCutInEffect || ['id', 'icon', 'category', 'order', 'enabled', 'name', 'description', 'hint', 'settings', 'styles', 'preloadAssets', 'prepare', 'render', 'playLocal', 'execute', 'registerSocketHandler', 'isAvailable', 'defaultSoundPath', 'localizationKey', 'localizationPrefix', 'requiredSystem', 'requiredModules', 'includeSoundSettings', 'requiresToken', 'queued'].includes(k)) {
      continue;
    }
    (DefinedCutInEffect as any)[k] = v;
  }

  return DefinedCutInEffect;
}
