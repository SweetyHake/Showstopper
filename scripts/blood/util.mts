/**
 * Shared helpers for the blood system (consolidated from copies scattered across
 * events/brush/snow/renderer: TAU ×5, clamp ×3, custom settings getter ×4).
 * Single source of truth. Stateless functions ONLY — classes and engines live
 * in their own modules.
 */

import { MODULE_ID } from '../config.mjs';
import { parseColor, toHex8 } from './colors.mjs';
import { tokenBloodColor } from './token-color.mjs';
import { resolveLevel } from './elevation.mjs';

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = (v) => Math.round(v * 10) / 10;

/** Read a setting with a silent fallback (pre-ready world / unregistered keys). */
export function settingGet(key, fallback) {
  try { return game.settings.get(MODULE_ID, key) ?? fallback; } catch { return fallback; }
}

/** Token/tile document elevation (missing = floor 0). */
export const elevOf = (doc) => (Number.isFinite(doc?.elevation) ? doc.elevation : 0);

/** Token size in scene pixels (larger side × grid size). */
export function tsizeOf(doc, grid = canvas.grid?.size ?? 100) {
  return Math.max(Math.abs(doc?.width ?? 1), Math.abs(doc?.height ?? 1)) * grid;
}

/** Current worldTime (stain age is measured from it). */
export function worldTime() {
  try { return Number(game.time?.worldTime) || 0; } catch { return 0; }
}

/** Darken/lighten hex8 while preserving alpha — footprints render darker than the stain. */
export function shadeHex8(hex, k) {
  const p = parseColor(hex);
  if (!p) return hex;
  const t = k < 0 ? 0 : 255;
  const q = Math.abs(k);
  return toHex8({
    r: p.r + (t - p.r) * q,
    g: p.g + (t - p.g) * q,
    b: p.b + (t - p.b) * q,
    a: p.a
  });
}

/** Token blood color in hex8 — unified record format for all generators. */
export function hexOf(token) {
  const color = tokenBloodColor(token);
  return `#${[color.r, color.g, color.b].map(v => v.toString(16).padStart(2, '0')).join('')}`
    + Math.round((color.a ?? 0.85) * 255).toString(16).padStart(2, '0');
}

/** Canonical wall profile radius multiplier relative to stain size (generation = revalidation). */
export const WALL_RADIUS_K = 1.3;

/** Wall profile: 16 sectors encoded as hex digits ('f' = unblocked). */
export function wallProfile(center, radius, levelOrId: any = null) {
  if (!settingGet('bloodWallsBlock', true)) return undefined;
  try {
    const backend = CONFIG.Canvas.polygonBackends?.move;
    if (!backend?.create) return undefined;
    const lvl = resolveLevel(levelOrId);
    const polyOpts: any = { type: 'move', density: 12 };
    if (lvl) polyOpts.level = lvl;
    const poly = backend.create({ x: center.x, y: center.y }, polyOpts);
    const pts = poly?.points;
    if (!pts?.length) return undefined;
    const polygon = new PIXI.Polygon(pts);
    const chars = [];
    for (let s = 0; s < 16; s++) {
      const a = ((s + 0.5) / 16) * TAU;
      let allowed = 1;
      for (let f = 0.95; f >= 0.15; f -= 0.1) {
        const px = center.x + Math.cos(a) * radius * f;
        const py = center.y + Math.sin(a) * radius * f;
        if (!polygon.contains(px, py)) { allowed = f + 0.05; break; }
      }
      chars.push(Math.max(0, Math.min(15, Math.round(allowed * 15))).toString(16));
    }
    return chars.join('');
  } catch {
    return undefined;
  }
}

/**
 * Cast a ray from (x0,y0) at angle `ang` up to `maxD`: nearest intersection with a
 * scene wall (all walls including doors — blood hitting a closed door looks right).
 * Returns {x, y} or null. Classic line-segment intersection.
 */
export function wallRayHit(x0, y0, ang, maxD, levelOrId: any = null) {
  try {
    const walls = canvas.walls?.placeables;
    if (!walls?.length) return null;
    const lvl = resolveLevel(levelOrId);
    const x1 = x0 + Math.cos(ang) * maxD, y1 = y0 + Math.sin(ang) * maxD;
    const dx = x1 - x0, dy = y1 - y0;
    let best = null, bestT = maxD;
    for (const w of walls) {
      if (lvl && typeof w.document?.includedInLevel === 'function' && !w.document.includedInLevel(lvl)) continue;
      const c = w?.document?.c;
      if (!Array.isArray(c) || c.length < 4) continue;
      if (w.document?.disabled) continue;
      const ex = c[2] - c[0], ey = c[3] - c[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue; // parallel
      const t = ((c[0] - x0) * ey - (c[1] - y0) * ex) / den;   // along ray, 0..1
      const u = ((c[0] - x0) * dy - (c[1] - y0) * dx) / den;   // along wall segment
      if (t <= 0.02 || u < 0 || u > 1) continue;
      const dist = t * maxD;
      if (dist < bestT) { bestT = dist; best = { x: x0 + dx * t, y: y0 + dy * t }; }
    }
    return best;
  } catch { return null; }
}

export const SNOW_WEATHER_RE = /snow|blizzard|flurr|sleet|winter|ice.?storm|permafrost|снег|метель|вьюг|буран|пург|мороз/i;
export const BLIZZARD_WEATHER_RE = /blizzard|heavy.?snow|winter.?storm|whiteout|ice.?storm|permafrost|метель|вьюг|буран|пург/i;
export const RAIN_WEATHER_RE = /rain|storm|thunder|downpour|shower|drizzle|monsoon|typhoon|hurricane|дожд|ливень|гроз/i;
export const WARM_WEATHER_RE = /heat.?wave|sunshower|thaw|scorch|оттепел|жар|зной/i;

function _matchCalendariaWeatherObj(cw) {
  if (!cw || typeof cw !== 'object') return null;
  const cId = String(cw.id ?? cw.preset?.id ?? '').trim();
  const fxPreset = String(cw.fxPreset ?? cw.preset?.fxPreset ?? '').trim();
  const hudEffect = String(cw.hudEffect ?? cw.preset?.hudEffect ?? '').trim();
  const label = String(cw.label ?? cw.preset?.label ?? '').trim();
  const icon = String(cw.icon ?? cw.preset?.icon ?? '').trim();
  const precipType = String(cw.precipitation?.type ?? '').trim().toLowerCase();
  const precipInt = Number(cw.precipitation?.intensity) || 0;
  const windSpeed = Number(cw.wind?.speed) || 0;
  const temp = Number(cw.temperature);

  const snow = precipType === 'snow' || precipType === 'sleet'
    || SNOW_WEATHER_RE.test(cId) || SNOW_WEATHER_RE.test(fxPreset)
    || SNOW_WEATHER_RE.test(hudEffect) || SNOW_WEATHER_RE.test(label)
    || SNOW_WEATHER_RE.test(icon) || /fa-snowflake|fa-icicles|fa-cloud-meatball/i.test(icon)
    || ((precipType === 'hail' || precipInt > 0) && Number.isFinite(temp) && temp <= 0);
  const blizzard = BLIZZARD_WEATHER_RE.test(cId) || BLIZZARD_WEATHER_RE.test(fxPreset)
    || BLIZZARD_WEATHER_RE.test(label)
    || hudEffect === 'snow-heavy'
    || (snow && (precipInt >= 0.75 || windSpeed >= 4));
  const rain = !snow && (
    precipType === 'rain' || precipType === 'drizzle'
    || RAIN_WEATHER_RE.test(cId) || RAIN_WEATHER_RE.test(fxPreset)
    || RAIN_WEATHER_RE.test(hudEffect) || RAIN_WEATHER_RE.test(label)
  );
  const warm = !snow && (
    rain
    || WARM_WEATHER_RE.test(cId) || WARM_WEATHER_RE.test(fxPreset)
    || WARM_WEATHER_RE.test(hudEffect) || WARM_WEATHER_RE.test(label)
    || (Number.isFinite(temp) && temp >= 6)
  );
  return { id: cId || fxPreset || hudEffect || label || null, snow, blizzard, rain, warm };
}

/**
 * Unified scene weather resolver: reads Foundry's native `scene.weather`,
 * all FXMaster stores and live particle layer (`particleEffects`, `effects`,
 * regions, and `canvas.particleeffects`), plus active weather from Calendaria.
 * Snow takes priority: if AT LEAST ONE source on the map currently indicates snow
 * (e.g. FXMaster snow particles are active on the scene even while the calendar
 * says "clear"), the scene is treated as snowy — snow accumulates and does NOT thaw.
 */
export function sceneWeatherInfo(scene = globalThis.canvas?.scene) {
  const isActiveCanvasScene = Boolean(scene && scene === globalThis.canvas?.scene);
  const rawScene = String(
    scene?.weather
    || (isActiveCanvasScene ? (globalThis.canvas?.weather?.weatherEffectId ?? globalThis.canvas?.environment?.weather ?? '') : '')
    || ''
  ).trim();
  const cfgWeather = rawScene ? globalThis.CONFIG?.weatherEffects?.[rawScene] : null;
  const sceneTag = `${rawScene} ${cfgWeather?.id ?? ''} ${cfgWeather?.label ?? ''}`.trim();

  let snow = SNOW_WEATHER_RE.test(sceneTag);
  let blizzard = BLIZZARD_WEATHER_RE.test(sceneTag);
  let rain = !snow && RAIN_WEATHER_RE.test(sceneTag);
  let warm = !snow && (rain || WARM_WEATHER_RE.test(sceneTag));
  let id = rawScene || null;
  let source = rawScene ? 'scene' : null;

  const inspectFxTag = (tag, fallbackId) => {
    if (!tag) return;
    if (SNOW_WEATHER_RE.test(tag)) {
      snow = true;
      rain = false;
      warm = false;
      if (BLIZZARD_WEATHER_RE.test(tag)) blizzard = true;
      if (!id || source !== 'scene') { id = fallbackId || id || 'snow'; source = 'fxmaster'; }
    } else if (!snow && RAIN_WEATHER_RE.test(tag)) {
      rain = true;
      warm = true;
      if (!id) { id = fallbackId || 'rain'; source = 'fxmaster'; }
    }
  };

  // FXMaster: check modern 'particleEffects' flag (FXMaster v13/v14),
  // legacy 'effects' flag, FXMaster regions, and the live canvas.particleeffects layer
  try {
    for (const flagKey of ['particleEffects', 'effects']) {
      const fxObj = scene?.getFlag?.('fxmaster', flagKey) ?? scene?.flags?.fxmaster?.[flagKey];
      if (!fxObj || typeof fxObj !== 'object') continue;
      for (const [k, eff] of Object.entries(fxObj) as any[]) {
        if (eff && typeof eff === 'object' && eff.enabled === false) continue;
        const tag = `${k} ${eff?.type ?? ''} ${eff?.name ?? ''} ${eff?.label ?? ''}`;
        inspectFxTag(tag, eff?.type || k);
      }
    }
    // FXMaster regions (fxmaster.particleEffectsRegion)
    for (const reg of scene?.regions ?? []) {
      for (const b of reg?.behaviors ?? []) {
        if (!b || b.disabled || b.type !== 'fxmaster.particleEffectsRegion') continue;
        const sys = b.system ?? {};
        if (sys.snowstorm_enabled) inspectFxTag('snowstorm blizzard', 'snowstorm');
        else if (sys.snow_enabled) inspectFxTag('snow', 'snow');
        else if (sys.rainstorm_enabled || sys.rain_enabled) inspectFxTag('rain', 'rain');
        const bFx = b.flags?.fxmaster?.particleEffects;
        if (bFx && typeof bFx === 'object') {
          for (const [k, eff] of Object.entries(bFx) as any[]) {
            if (eff && typeof eff === 'object' && eff.enabled === false) continue;
            inspectFxTag(`${k} ${eff?.type ?? ''}`, eff?.type || k);
          }
        }
      }
    }
    // Active FXMaster API presets
    const listActive = globalThis.FXMASTER?.api?.presets?.listActive;
    if (typeof listActive === 'function') {
      const activePresets = (scene?.uuid ? listActive({ scene: scene.uuid }) : null) ?? listActive() ?? [];
      if (Array.isArray(activePresets)) {
        for (const p of activePresets) {
          const pTag = typeof p === 'string' ? p : `${p?.id ?? ''} ${p?.name ?? ''} ${p?.type ?? ''}`;
          inspectFxTag(pTag, typeof p === 'string' ? p : (p?.id || p?.name));
        }
      }
    }
    // Live particle layer on the active canvas (canvas.particleeffects)
    if (isActiveCanvasScene) {
      const pe = globalThis.canvas?.particleeffects;
      const iterMapOrObj = (col, cb) => {
        if (!col) return;
        if (typeof col.entries === 'function') {
          for (const [k, v] of col.entries()) cb(k, v);
        } else if (typeof col === 'object') {
          for (const [k, v] of Object.entries(col)) cb(k, v);
        }
      };
      iterMapOrObj(pe?.particleEffects, (k, v) => {
        if (v?.enabled === false || v?.active === false) return;
        inspectFxTag(`${k} ${v?.type ?? ''} ${v?.effectType ?? ''} ${v?.constructor?.name ?? ''}`, v?.type || String(k));
      });
      iterMapOrObj(pe?.regionEffects, (k, v) => {
        if (v?.enabled === false || v?.active === false) return;
        inspectFxTag(`${k} ${v?.type ?? ''} ${v?.effectType ?? ''} ${v?.constructor?.name ?? ''}`, v?.type || String(k));
      });
      iterMapOrObj(pe?.stackEntries, (k, v) => {
        if (v?.enabled === false || v?.active === false) return;
        inspectFxTag(`${k} ${v?.effectType ?? ''} ${v?.effectId ?? ''} ${v?.uid ?? ''} ${v?.label ?? ''}`, v?.effectType || String(k));
      });
      iterMapOrObj(pe?._particleBackgroundTrailStores, (k, v) => {
        if (!v?.enabled) return;
        inspectFxTag(`${k} ${v?.type ?? ''}`, v?.type || String(k));
      });
    }
  } catch { /* noop */ }

  try {
    const noZone = scene?.getFlag?.('calendaria', 'climateZoneOverride') === 'none';
    const fxOff = scene?.getFlag?.('calendaria', 'weatherFxOverride') === 'off';
    if (!noZone && !fxOff) {
      const wm = globalThis.CALENDARIA?.managers?.WeatherManager;
      const candidates = [];
      const pushCand = (w) => {
        if (!w || typeof w !== 'object') return;
        if (!candidates.includes(w)) candidates.push(w);
        // if intraday weather periods are enabled, also inspect the active period
        const periodId = wm?.getCurrentPeriod?.() ?? w.activePeriod;
        const pw = periodId && w.periods?.[periodId];
        if (pw && typeof pw === 'object' && !candidates.includes(pw)) candidates.push(pw);
      };

      if (wm?.getCurrentWeather) {
        try { pushCand(wm.getCurrentWeather(null, scene)); } catch { /* noop */ }
        try { pushCand(wm.getCurrentWeather()); } catch { /* noop */ }
        try { pushCand(wm.getCurrentWeather('_default')); } catch { /* noop */ }
      }
      if (globalThis.CALENDARIA?.api?.getCurrentWeather) {
        try { pushCand(globalThis.CALENDARIA.api.getCurrentWeather()); } catch { /* noop */ }
      }
      if (!candidates.length && globalThis.game?.modules?.get?.('calendaria')?.active) {
        const raw = globalThis.game?.settings?.get?.('calendaria', 'currentWeather');
        if (raw && typeof raw === 'object') {
          if ('id' in raw || 'precipitation' in raw || 'label' in raw) pushCand(raw);
          else {
            if (raw._default) pushCand(raw._default);
            for (const v of Object.values(raw)) pushCand(v);
          }
        }
      }

      for (const cw of candidates) {
        const m = _matchCalendariaWeatherObj(cw);
        if (!m) continue;
        if (m.snow) snow = true;
        if (m.blizzard) { snow = true; blizzard = true; }
        if (m.rain && !snow) rain = true;
        if (m.warm && !snow) warm = true;
        if (snow) { rain = false; warm = false; }
        if (!id && m.id) {
          id = m.id;
          source = 'calendaria';
        }
        // first valid weather object for the current zone takes precedence
        if (m.id) break;
      }
    }
  } catch { /* third-party weather module errors must not break the scene */ }

  return { id, snow, blizzard, rain, warm, source };
}

