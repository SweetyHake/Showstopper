/**
 * Snow subsystem extension bridge (`showstopper-plus`).
 *
 * The base module (`showstopper`) provides the blood engine, brush, eraser, and
 * decal rendering, while `showstopper-plus` attaches the full weather/snow engine
 * via `setSnowAdapter(...)` without cross-package relative imports.
 */

import { MODULE_ID } from '../config.mjs';
import { registerAPI } from '../core/runtime.mjs';
import { STAIN } from './stains.mjs';
import {
  surfaceAt, elevationMatches, currentLevelId, levelBaseElevation,
  isLevelVisible, isStainVisibleOnLevel, stainMatchesLevel
} from './elevation.mjs';
import {
  TAU, clamp, settingGet, shadeHex8, wallProfile, WALL_RADIUS_K,
  SNOW_WEATHER_RE, BLIZZARD_WEATHER_RE, sceneWeatherInfo
} from './util.mjs';
import { mixHex } from './colors.mjs';
import { playBurst, spawnStepPuff } from './particles.mjs';
import { mintSeed } from './rng.mjs';

export const SNOW_COLOR = '#e8ecf2e0';
export const SNOW_SHADOW_COLOR = '#9aa4b4d0';

export const SNOW_LEVEL = Object.freeze({
  NONE: 0,
  LIGHT: 1,
  MEDIUM: 2,
  DRIFT: 3,
  DRIFT_HIGH: 4,
  DRIFT_DEEP: 5
});
export const MAX_SNOW_LEVEL = 5;

let _snowAdapter: any = null;
const _snowListeners: Array<(adapter: any) => void> = [];

export function setSnowAdapter(adapter: any) {
  _snowAdapter = adapter ?? null;
  if (_snowAdapter) {
    for (const fn of _snowListeners) {
      try { fn(_snowAdapter); } catch (e) { console.warn(`${MODULE_ID} | snow adapter listener failed`, e); }
    }
  }
}

export function getSnowAdapter() {
  return _snowAdapter;
}

export function hasSnowAdapter(): boolean {
  return _snowAdapter !== null;
}

export function onSnowAdapter(fn: (adapter: any) => void) {
  _snowListeners.push(fn);
  if (_snowAdapter) {
    try { fn(_snowAdapter); } catch (e) { console.warn(`${MODULE_ID} | snow adapter listener failed`, e); }
  }
}

export function snowLevelAt(...args: any[]): number {
  return _snowAdapter?.snowLevelAt ? _snowAdapter.snowLevelAt(...args) : 0;
}

export function snowLevelFromNear(...args: any[]): number {
  return _snowAdapter?.snowLevelFromNear ? _snowAdapter.snowLevelFromNear(...args) : 0;
}

export function meltSnowAt(...args: any[]): number {
  return _snowAdapter?.meltSnowAt ? _snowAdapter.meltSnowAt(...args) : 0;
}

export function blastSnowAt(...args: any[]): number {
  return _snowAdapter?.blastSnowAt ? _snowAdapter.blastSnowAt(...args) : 0;
}

export function freezeSnowAt(...args: any[]): any {
  return _snowAdapter?.freezeSnowAt ? _snowAdapter.freezeSnowAt(...args) : null;
}

export function sweepDoorSnow(...args: any[]): any {
  return _snowAdapter?.sweepDoorSnow
    ? _snowAdapter.sweepDoorSnow(...args)
    : { cleared: 0, piled: 0, type: null };
}

export function burySnowTracksAt(...args: any[]): number {
  return _snowAdapter?.burySnowTracksAt ? _snowAdapter.burySnowTracksAt(...args) : 0;
}

export function absorbBloodIntoSnow(...args: any[]): any {
  return _snowAdapter?.absorbBloodIntoSnow ? _snowAdapter.absorbBloodIntoSnow(...args) : null;
}

export function trampleSnowStains(...args: any[]): void {
  if (_snowAdapter?.trampleSnowStains) _snowAdapter.trampleSnowStains(...args);
}

/** Publish the internal blood subsystem SDK via `registerAPI` for the `showstopper-plus` extension module. */
registerAPI('bloodSdk', {
  MODULE_ID,
  STAIN,
  SNOW_COLOR,
  SNOW_SHADOW_COLOR,
  SNOW_LEVEL,
  MAX_SNOW_LEVEL,
  surfaceAt,
  elevationMatches,
  currentLevelId,
  levelBaseElevation,
  isLevelVisible,
  isStainVisibleOnLevel,
  stainMatchesLevel,
  TAU,
  clamp,
  settingGet,
  shadeHex8,
  wallProfile,
  WALL_RADIUS_K,
  SNOW_WEATHER_RE,
  BLIZZARD_WEATHER_RE,
  sceneWeatherInfo,
  mixHex,
  playBurst,
  spawnStepPuff,
  mintSeed,
  setSnowAdapter,
  getSnowAdapter,
  hasSnowAdapter,
  onSnowAdapter
});
