/**
 * GM freehand stain brush / eraser. NO DOM overlay: input is intercepted
 * in the document CAPTURE phase, scoped strictly to canvas-view targets so
 * native camera controls remain untouched:
 *
 *  - LMB `pointerdown` on the canvas is consumed (`preventDefault` +
 *    `stopPropagation` + pointer capture on the canvas element) so PIXI/Foundry
 *    never start token marquee selection; `pointermove` is swallowed ONLY during
 *    an active stroke (avoiding hover flicker); RMB/MMB/wheel/edge-scroll pass
 *    through so `canvas._onDragRightMove` pans natively; stationary RMB click
 *    exits, Esc exits, and touch input passes through for gestures.
 *  - LMB paints via distance-spaced stamping (interval `0.2 × size`,
 *    aligned along the stroke with reduced jitter so overlapping stamps read
 *    as a CONTINUOUS stroke); stamps are BATCHED per `pointermove`:
 *    params are read once per event, up to `8 × density` stamps are collected
 *    and submitted to the renderer in a SINGLE `addStains` call; the HUD (full DOM)
 *    refreshes at most once per animation frame (refreshing per stamp caused layout thrash).
 *  - Eraser: 150 ms throttle; candidates come from `store.queryCircle` + pending
 *    stroke defs + deferred (`d`) renderer stains; pending defs erase immediately,
 *    while store stains vanish visually right away and commit to store/socket in ONE
 *    batch on `pointerup`.
 *  - Strokes preview directly into the renderer and commit to the store on
 *    `pointerup` (single socket op + single debounced flag write).
 *  - Q/E adjusts brush elevation (`KeyE` up / `KeyQ` down, step 1, `Shift` = 0.1),
 *    mirroring native token ascend/descend: window capture-phase listener runs before
 *    `KeyboardManager`'s bubble listener so `stopPropagation` suppresses native
 *    elevation changes on selected tokens; an "H N" badge flashes beneath the cursor ring.
 *    Window blur (`Alt+Tab`) finishes and commits any active stroke; an `ev.buttons`
 *    guard catches missed `pointerup` events.
 */

import { MODULE_ID } from '../config.mjs';
import { STAIN } from './stains.mjs';
import { surfaceAt, BRUSH_ELEV_MIN, BRUSH_ELEV_MAX, elevationMatches, currentLevelId, isStainVisibleOnLevel, levelBaseElevation, stainMatchesLevel } from './elevation.mjs';
import { createBrushHUD, SUBSTANCES } from './hud.mjs';
import { pushBloodOp } from './undo.mjs';
import { snowLevelAt, SNOW_LEVEL, SNOW_SHADOW_COLOR, burySnowTracksAt, hasSnowAdapter } from './snow-bridge.mjs';
import { parseColor } from './colors.mjs';
import { wallProfile, WALL_RADIUS_K, worldTime } from './util.mjs';

const ERASE_THROTTLE_MS = 150;
const RING_CLASS = 'ss-blood-brush-ring';
const ELEV_TAG_MS = 900;      // how long the "H N" badge stays visible
const TAU = Math.PI * 2;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const _cset = (key, value) => {
  try { game.settings.set(MODULE_ID, key, value); } catch { /* noop */ }
};
const _cget = (key, fallback) => {
  try { return game.settings.get(MODULE_ID, key) ?? fallback; } catch { return fallback; }
};

export class BloodBrush {
  declare getStore; declare getRenderer; declare active; declare mode; declare _hud; declare _ring; declare _elevTag; declare _elevTagTimer; declare _stroke; declare _eraseIds; declare _eraseRecs; declare _eraseAt; declare _dragged; declare _uiPress; declare _bound; declare _prevCursor; declare _prevDrawingsInteractive; declare _touchWarned; declare _hudSyncPending;
  /** @param {() => import('./stains.mjs').BloodStore} getStore
   *  @param {() => import('./renderer.mjs').BloodRenderer} getRenderer */
  constructor(getStore, getRenderer) {
    this.getStore = getStore;
    this.getRenderer = getRenderer;
    this.active = false;
    this.mode = null;          // 'paint' | 'erase'
    this._hud = null;
    this._ring = null;
    this._elevTag = null;
    this._elevTagTimer = null;
    this._stroke = null;       // {pointerId, lx, ly, travel, defs[], lastE, moved}
    this._eraseIds = new Set();   // visually erased IDs — committed to store in one batch
    this._eraseRecs = new Map();  // id → record: undo stash so CTRL+Z restores erased stains
    this._eraseAt = 0;
    this._dragged = false;     // whether RMB dragged (stationary RMB click = exit)
    this._uiPress = false;     // pointer press started outside the canvas (HUD/UI)
    this._bound = null;        // installed event listeners
    this._prevCursor = '';
    this._prevDrawingsInteractive = undefined;
  }

  get store() { return this.getStore?.() ?? null; }
  get renderer() { return this.getRenderer?.() ?? null; }

  toggle(mode = 'paint') {
    if (this.active) this.exit();
    else this.enter(mode);
  }

  /** Enter brush mode (control palette tool click / API). */
  enter(mode = 'paint') {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.hud.gmOnly`));
      return;
    }
    if (this.active) {
      this._setMode(mode);
      return;
    }
    this.active = true;
    this._setMode(mode, true);
    this._installListeners();
    this._buildRing();
    this._hud = createBrushHUD({
      getParams: () => this._params(),
      setParams: (patch) => this._setParams(patch),
      getMode: () => this.mode,
      setMode: (m) => this._setMode(m),
      getCount: () => this.store?.count ?? 0,
      onClear: () => this._confirmClear(),
      onClearMaterial: () => this._confirmClearMaterial(),
      onClose: () => this.exit()
    });
    this._applyCursor(true);
    // Brush lives in the drawings control group — activation must specify `control`,
    // otherwise `activate` looks up the tool in the currently active group (v14 `#preActivate`)
    this._activateNativeTool('blood-brush', 'drawings');
    this._setCanvasHoverPassthrough(true);
    this._syncCount();
  }

  /** Exit brush mode. `restoreTool=false` leaves the control palette alone (used when
   *  leaving via native tool switching — `onChange(active=false)`). */
  exit({ restoreTool = true } = {}) {
    if (!this.active) return;
    this._endStroke();
    this._flushEraseRemovals();
    this.active = false;
    this.mode = null;
    this._uiPress = false;
    this._removeListeners();
    this._destroyRing();
    try { this._hud?.destroy(); } catch { /* noop */ }
    this._hud = null;
    this._setCanvasHoverPassthrough(false);
    this._applyCursor(false);
    if (restoreTool) this._activateNativeTool('select');
  }

  /* ------------------------------- modes/parameters ------------------------------- */

  _setMode(mode, silent = false) {
    this.mode = mode === 'erase' ? 'erase' : 'paint';
    this._updateRingMode();
    if (!silent) this._hud?.refresh();
  }

  /** Current brush parameters read from client settings. */
  _params() {
    const material = (hasSnowAdapter() && Math.round(Number(_cget('bloodBrushMaterial', 0))) === 2) ? 2 : 0;
    return {
      color: String(_cget('bloodBrushColor', '#a51414d8')),
      size: clamp(Number(_cget('bloodBrushSize', 120)) || 120, 10, 800),
      density: clamp(Math.round(Number(_cget('bloodBrushDensity', 2)) || 1), 1, 5),
      alpha: clamp(Number(_cget('bloodBrushAlpha', 0.85)) || 0.85, 0.05, 1),
      type: 'splat',
      material,
      elev: clamp(Number(_cget('bloodBrushElevation', '0')) || 0, BRUSH_ELEV_MIN, BRUSH_ELEV_MAX),
      eraseMatOnly: Boolean(_cget('bloodBrushEraseMat', false)),
      noWash: Boolean(_cget('bloodBrushNoWash', false)),
      snowDepth: clamp(Math.round(Number(_cget('bloodBrushSnowDepth', 0)) || 0), 0, SNOW_LEVEL.DRIFT_DEEP),
      snowSkirt: Boolean(_cget('bloodBrushSnowSkirt', true))
    };
  }

  _setParams(patch) {
    if (!patch || typeof patch !== 'object') return;
    const p = this._params();
    if (patch.color != null && /^#[0-9a-f]{6,8}$/i.test(String(patch.color))) {
      _cset('bloodBrushColor', String(patch.color));
    }
    if (patch.size != null) _cset('bloodBrushSize', clamp(Math.round(Number(patch.size) || p.size), 10, 800));
    if (patch.density != null) _cset('bloodBrushDensity', clamp(Math.round(Number(patch.density) || p.density), 1, 5));
    if (patch.alpha != null) {
      const rawAlpha = Number(patch.alpha);
      if (Number.isFinite(rawAlpha)) {
        _cset('bloodBrushAlpha', clamp(Math.round(rawAlpha * 100) / 100, 0.05, 1));
      }
    }
    const nextMat = patch.material != null
      ? ((hasSnowAdapter() && Math.round(Number(patch.material)) === 2) ? 2 : 0)
      : p.material;
    if (patch.material != null) _cset('bloodBrushMaterial', nextMat);
    if (patch.type != null || String(_cget('bloodBrushType', 'splat')) !== 'splat') {
      _cset('bloodBrushType', 'splat');
    }
    if (patch.eraseMatOnly != null) _cset('bloodBrushEraseMat', Boolean(patch.eraseMatOnly));
    if (patch.noWash != null) _cset('bloodBrushNoWash', Boolean(patch.noWash));
    if (patch.snowDepth != null) {
      const rawDepth = Number(patch.snowDepth);
      _cset('bloodBrushSnowDepth', clamp(Number.isFinite(rawDepth) ? Math.round(rawDepth) : 0, 0, SNOW_LEVEL.DRIFT_DEEP));
    }
    if (patch.snowSkirt != null) _cset('bloodBrushSnowSkirt', Boolean(patch.snowSkirt));
    if (patch.elev != null) {
      _cset('bloodBrushElevation', String(clamp(Math.round(Number(patch.elev) * 10) / 10, BRUSH_ELEV_MIN, BRUSH_ELEV_MAX)));
      this._flashElevTag(this._params().elev);
    }
    this._updateRingSize();
    this._updateRingMode();
    this._hud?.refresh();
  }

  /** Clear ALL stains on the scene (HUD button, with confirmation dialog). */
  async _confirmClear() {
    const store = this.store;
    if (!store?.count) return;
    const L = (key) => game.i18n.localize(`${MODULE_ID}.blood.hud.${key}`);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: L('clearTitle') },
      content: `<p>${L('clearConfirm').replace('{count}', String(store.count))}</p>`
    });
    if (!confirmed || !store?.count) return;
    // Push everything onto the undo stack before clearing so CTRL+Z restores it all
    pushBloodOp('remove', [...store.stains]);
    store.clear();
    this._hud?.refresh();
  }

  /** Clear ONLY the active substance on the scene (HUD button, with confirmation dialog). */
  async _confirmClearMaterial() {
    const store = this.store;
    if (!store?.count) return;
    const p = this._params();
    const mat = Number(p.material) || 0;
    const matches = store.stains.filter(st => (Number(st.m) || 0) === mat);
    if (!matches.length) return;
    const L = (key) => game.i18n.localize(`${MODULE_ID}.blood.hud.${key}`);
    const subDef = SUBSTANCES.find(s => s.id === mat);
    const matName = subDef ? L(`substance.${subDef.key}`) : String(mat);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: L('clearMaterialTitle') },
      content: `<p>${L('clearMaterialConfirm')
        .replace('{material}', matName)
        .replace('{count}', String(matches.length))}</p>`
    });
    if (!confirmed) return;
    this.clearMaterialSilent(mat);
  }

  /** Clear only stains of the given substance (0 = blood, 2 = snow) without a dialog, with CTRL+Z support. */
  clearMaterialSilent(material = this._params().material) {
    const store = this.store;
    if (!store?.count) return 0;
    const mat = Math.round(Number(material)) === 2 ? 2 : 0;
    const matches = store.stains.filter(st => (Number(st.m) || 0) === mat);
    if (!matches.length) return 0;
    pushBloodOp('remove', matches);
    store.remove(matches.map(st => st.i));
    this._hud?.refresh();
    return matches.length;
  }

  /** Clear all scene stains without a dialog (API path, e.g. settings window):
   *  uses the same undo stack since the settings dialog copy also promises CTRL+Z. */
  clearAllSilent() {
    const store = this.store;
    if (!store?.count) return;
    pushBloodOp('remove', [...store.stains]);
    store.clear();
    this._hud?.refresh();
  }

  /* ------------------------------- listeners ------------------------------- */

  _installListeners() {
    this._bound = {
      pointerdown: (e) => this._onPointerDown(e),
      pointermove: (e) => this._onPointerMove(e),
      pointerup: (e) => this._onPointerUp(e),
      pointercancel: (e) => this._onPointerCancel(e),
      contextmenu: (e) => this._onContext(e),
      keydown: (e) => this._onKeyDown(e),
      wheel: (e) => this._onWheel(e),
      blur: () => this._endStroke()
    };
    // Capture phase on window: runs before document/PIXI/KeyboardManager so active
    // held-LMB strokes cannot silently drop on secondary DOM/window transitions
    window.addEventListener('pointerdown', this._bound.pointerdown, { capture: true });
    window.addEventListener('pointermove', this._bound.pointermove, { capture: true });
    window.addEventListener('pointerup', this._bound.pointerup, { capture: true });
    window.addEventListener('pointercancel', this._bound.pointercancel, { capture: true });
    document.addEventListener('wheel', this._bound.wheel, { capture: true, passive: false });
    canvas?.app?.view?.addEventListener('contextmenu', this._bound.contextmenu);
    window.addEventListener('keydown', this._bound.keydown, { capture: true });
    window.addEventListener('blur', this._bound.blur);
  }

  _removeListeners() {
    if (!this._bound) return;
    window.removeEventListener('pointerdown', this._bound.pointerdown, { capture: true });
    window.removeEventListener('pointermove', this._bound.pointermove, { capture: true });
    window.removeEventListener('pointerup', this._bound.pointerup, { capture: true });
    window.removeEventListener('pointercancel', this._bound.pointercancel, { capture: true });
    document.removeEventListener('wheel', this._bound.wheel, { capture: true });
    canvas?.app?.view?.removeEventListener('contextmenu', this._bound.contextmenu);
    window.removeEventListener('keydown', this._bound.keydown, { capture: true });
    window.removeEventListener('blur', this._bound.blur);
    this._bound = null;
  }

  /** Shift + mouse wheel over the canvas resizes the brush on the fly. */
  _onWheel(e) {
    if (!this.active || !e.shiftKey || !this._isCanvasTarget(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : -1;
    const cur = this._params().size;
    const step = cur < 60 ? 10 : cur < 240 ? 20 : 40;
    this._setParams({ size: cur + dir * step });
    this._flashSizeTag(this._params().size);
  }

  /** Whether the event target is the scene canvas (we only paint on the board). */
  _isCanvasTarget(e) {
    const view = canvas?.app?.view;
    const t = e.target;
    if (!view || !t) return false;
    return t === view || (typeof t.closest === 'function' && !!t.closest('#board'));
  }

  /** Screen event coordinates → scene coordinates (accounting for camera pan/zoom).
   *  Core uses `autoDensity`: the canvas bounding rect is ALREADY in logical CSS pixels
   *  expected by `stage.toLocal` — multiplying by `view.width / rect.width` is wrong
   *  (with `pixelRatioResolutionScaling` enabled it skewed stamps by DPR). */
  _toScene(e) {
    const view = canvas.app.view;
    const rect = view.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    try {
      return canvas.stage.toLocal({ x: px, y: py });
    } catch {
      return { x: px, y: py };
    }
  }

  _startStroke(e) {
    try { canvas?.currentMouseManager?.cancel?.(); } catch { /* noop */ }
    try {
      if (canvas?.controls?.select?.active) {
        canvas.controls.select.active = false;
        canvas.controls.select.clear?.();
      }
    } catch { /* noop */ }
    const p = this._toScene(e);
    try { canvas?.app?.view?.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
    this._dragged = true;
    const params = this._params();
    const altLower = Boolean(e.altKey && this.mode === 'paint' && params.material === 2);
    this._stroke = {
      pointerId: e.pointerId ?? null,
      lx: p.x,
      ly: p.y,
      travel: 0,
      defs: [],
      lastE: null,
      moved: false,
      stepIndex: 0,
      altLower
    };
    if (this.mode === 'erase') {
      this._erase(p.x, p.y, { force: true, shiftKey: e.shiftKey });
    } else if (this.mode === 'paint') {
      this._stamp(p.x, p.y, null);
    }
  }

  _onPointerDown(e) {
    if (!this.active) return;
    if (e.button === 2) {
      this._dragged = false; // stationary RMB click = exit (handled in `_onContext`)
      return; // RMB passes through for native camera panning
    }
    if (e.pointerType === 'touch') {
      // Never ignore touch silently: users read that as "the brush is broken" —
      // show a one-time explanation notice
      if (this._isCanvasTarget(e) && !this._touchWarned) {
        this._touchWarned = true;
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.blood.hud.touchOnly`));
      }
      return;
    }
    if (e.button !== 0) return;
    if (!this._isCanvasTarget(e)) {
      this._uiPress = true;
      return;
    }
    this._uiPress = false;
    if (this._stroke) this._endStroke();
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
    e.preventDefault();
    e.stopPropagation();
    this._startStroke(e);
  }

  _onPointerMove(e) {
    if (!this.active) return;
    this._moveRing(e);
    // RMB-drag pans the camera natively — mark as DRAGGED so `contextmenu` on
    // release does not mistake it for a stationary click and exit brush mode
    if (e.buttons & 2) this._dragged = true;
    if (!this._stroke) {
      if (!(e.buttons & 1)) {
        this._uiPress = false;
        return;
      }
      // Seamless continuation when LMB stays held over canvas without a UI drag (e.g.
      // after a transient blur/pointercancel or window-focus activation click)
      if (!this._uiPress && e.pointerType !== 'touch' && this._isCanvasTarget(e)) {
        this._startStroke(e);
      }
      return;
    }
    if (this._stroke.pointerId != null && e.pointerId != null && e.pointerId !== this._stroke.pointerId) return;
    // Missed `pointerup` guard: if LMB is no longer held, end the stroke
    if (!(e.buttons & 1)) {
      this._uiPress = false;
      this._endStroke();
      return;
    }
    this._dragged = true;
    const p = this._toScene(e);
    const dx = p.x - this._stroke.lx;
    const dy = p.y - this._stroke.ly;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    this._stroke.moved = true;
    const params = this._params();
    if (this.mode === 'erase') {
      this._erase(p.x, p.y, { shiftKey: e.shiftKey });
      this._stroke.lx = p.x;
      this._stroke.ly = p.y;
      return;
    }
    const dir = Math.atan2(dy, dx);
    const spacing = params.material === 2
      ? Math.max(12, params.size * 0.26)
      : clamp(params.size * 0.18, 8, 56);
    // Interpolation: place stamps along the segment every `spacing` px (plus leftover
    // `travel` from the previous event) for a gap-free stroke; cap at `8 × density`
    // stamps per event and carry over remaining travel
    let budget = this._stroke.travel + dist;
    const batch = 8 * params.density;
    let stamped = 0;
    while (budget >= spacing && stamped < batch) {
      // 0..1 clamp IS REQUIRED: after hitting the batch cap, `travel` can remain ≥
      // `spacing`, which on the next event would push `t` negative and fling stamps
      // far BEHIND the cursor across the screen
      const t = Math.min(1, Math.max(0, (dist - budget + spacing) / Math.max(dist, 1e-6)));
      this._stamp(this._stroke.lx + dx * t, this._stroke.ly + dy * t, dir);
      budget -= spacing;
      stamped++;
    }
    if (stamped >= batch && budget > spacing) budget = spacing;
    this._stroke.travel = budget;
    this._stroke.lx = p.x;
    this._stroke.ly = p.y;
    this._syncCount();
  }

  _onPointerUp(e) {
    if (!this.active || e.button !== 0) return;
    if (this._stroke && this._stroke.pointerId != null && e.pointerId != null && e.pointerId !== this._stroke.pointerId) return;
    this._uiPress = false;
    if (!this._stroke) return;
    e.preventDefault();
    e.stopPropagation();
    this._endStroke();
  }

  _onPointerCancel(e) {
    if (!this.active) return;
    if (this._stroke && this._stroke.pointerId != null && e?.pointerId != null && e.pointerId !== this._stroke.pointerId) return;
    this._uiPress = false;
    this._endStroke();
  }

  _onContext(e) {
    if (!this.active) return;
    e.preventDefault();
    if (!this._dragged) this.exit(); // stationary RMB click exits brush mode
  }

  _onKeyDown(e) {
    if (!this.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.exit();
      return;
    }
    const inInput = !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (inInput) return;
    if (e.code === 'KeyE' || e.code === 'KeyQ') {
      // Capture runs before KeyboardManager: suppress native elevation change on selected tokens
      e.stopPropagation();
      e.preventDefault();
      this._adjustElevation(e.code === 'KeyE' ? 1 : -1, e.shiftKey);
      return;
    }
    // Resize brush without reaching for the HUD: `[` smaller, `]` larger
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      e.stopPropagation();
      e.preventDefault();
      const cur = this._params().size;
      const step = cur < 60 ? 10 : cur < 240 ? 20 : 40;
      this._setParams({ size: cur + (e.code === 'BracketRight' ? step : -step) });
      this._flashSizeTag(this._params().size);
      return;
    }
    // Quick snow depth selection via keys `0` (Auto +1) and `1..5` (levels I..V)
    if (
      !e.ctrlKey && !e.metaKey && !e.altKey &&
      this.mode === 'paint' &&
      this._params().material === 2 &&
      /^Digit[0-5]$/.test(e.code)
    ) {
      e.stopPropagation();
      e.preventDefault();
      const depth = Number(e.code.slice(5));
      this._setParams({ snowDepth: depth });
      const badgeKey = `${MODULE_ID}.blood.hud.snowDepth.${depth === 0 ? 'auto' : `lv${depth}`}`;
      this._flashBadgeTag(game.i18n?.localize?.(badgeKey) || (depth === 0 ? '+1' : String(depth)));
    }
  }

  _endStroke() {
    if (!this._stroke) return;
    if (this._stroke.pointerId != null) {
      try { canvas?.app?.view?.releasePointerCapture?.(this._stroke.pointerId); } catch { /* noop */ }
    }
    this._commitPending();
    this._stroke = null;
    this._syncCount();
  }

  /* ------------------------------- Q/E elevation ------------------------------- */

  _adjustElevation(delta, fine = false) {
    const step = fine ? 0.1 : 1;
    const p = this._params();
    const cur = p.elev;
    const v = clamp(Math.round((cur + delta * step) * 10) / 10, BRUSH_ELEV_MIN, BRUSH_ELEV_MAX);
    if (v === cur) return;
    _cset('bloodBrushElevation', String(v));
    this._flashElevTag(v);
    this._hud?.refresh();
  }

  _flashElevTag(v) {
    this._flashBadgeTag(`H ${v}`);
  }

  /** Size badge under the cursor ring (`[` / `]` keys): reuses the "H N" badge slot. */
  _flashSizeTag(v) {
    this._flashBadgeTag(`S ${v}`);
  }

  /** Shared transient badge beneath the cursor ring (elevation, brush size, snow depth). */
  _flashBadgeTag(text) {
    if (!this._elevTag) return;
    this._elevTag.textContent = text;
    this._elevTag.classList.add('show');
    clearTimeout(this._elevTagTimer);
    this._elevTagTimer = setTimeout(() => {
      this._elevTag?.classList.remove('show');
      this._elevTagTimer = null;
    }, ELEV_TAG_MS);
  }

  /* ------------------------------- cursor ring ------------------------------- */

  _buildRing() {
    this._ring = document.createElement('div');
    this._ring.className = RING_CLASS;
    this._elevTag = document.createElement('div');
    this._elevTag.className = 'ss-blood-brush-elev';
    this._ring.appendChild(this._elevTag);
    document.body.appendChild(this._ring);
    this._updateRingSize();
    this._updateRingMode();
  }

  _destroyRing() {
    clearTimeout(this._elevTagTimer);
    this._elevTagTimer = null;
    this._elevTag = null;
    this._ring?.remove();
    this._ring = null;
  }

  _moveRing(e) {
    if (!this._ring) return;
    const size = this._ring.offsetWidth || 1;
    this._ring.style.left = `${e.clientX - size / 2}px`;
    this._ring.style.top = `${e.clientY - size / 2}px`;
  }

  _updateRingSize() {
    if (!this._ring) return;
    try {
      // Ring size in SCREEN pixels: multiply by scene zoom only (see `_toScene`)
      const zoom = canvas.stage?.scale?.x ?? 1;
      const px = Math.max(6, this._params().size * zoom);
      this._ring.style.width = `${px}px`;
      this._ring.style.height = `${px}px`;
    } catch { /* noop */ }
  }

  _updateRingMode() {
    if (!this._ring) return;
    const p = this._params();
    const isSnowPaint = this.mode === 'paint' && p.material === 2;
    this._ring.classList.toggle(`${RING_CLASS}--erase`, this.mode === 'erase');
    this._ring.classList.toggle(`${RING_CLASS}--snow`, isSnowPaint);
    if (this.mode === 'paint' && !isSnowPaint) {
      const c = parseColor(p.color);
      this._ring.style.borderColor = c ? `rgba(${c.r}, ${c.g}, ${c.b}, 0.85)` : '';
    } else {
      this._ring.style.borderColor = '';
    }
  }

  _applyCursor(on) {
    const view = canvas?.app?.view;
    if (!view) return;
    try { view.classList?.toggle?.('ss-blood-brush-active', Boolean(on)); } catch { /* noop */ }
    if (!view.style) return;
    if (on) {
      this._prevCursor = view.style.cursor || '';
      view.style.cursor = 'none'; // custom ring replaces the OS cursor
    } else {
      view.style.cursor = this._prevCursor || '';
      this._prevCursor = '';
    }
  }

  /** Suppress DrawingsLayer child interactivity while the brush is active so hovering over
   *  drawings does not raise `canvas.activeLayer.hover` and block roof hover-fade. */
  _setCanvasHoverPassthrough(on) {
    const drawings = canvas?.drawings;
    if (!drawings) return;
    if (on) {
      if (drawings.hover) drawings.hover = null;
      if (this._prevDrawingsInteractive === undefined) {
        this._prevDrawingsInteractive = drawings.interactiveChildren;
      }
      drawings.interactiveChildren = false;
    } else if (this._prevDrawingsInteractive !== undefined) {
      drawings.interactiveChildren = Boolean(drawings.active ? this._prevDrawingsInteractive : false);
      this._prevDrawingsInteractive = undefined;
    }
  }

  /** Control palette: call public `activate` (mutating `activeTool` in control data
   *  does NOT update internal palette state). Omitting `control` targets the active
   *  group — so restoring `'select'` on exit lands in the drawings group from which
   *  the brush was activated. */
  _activateNativeTool(tool, control?) {
    try { ui.controls?.activate?.({ control, tool }); } catch { /* noop */ }
  }

  _syncCount() {
    // Full DOM refresh at most once per frame — per-stamp-batch refresh causes layout thrash
    if (this._hudSyncPending) return;
    this._hudSyncPending = true;
    requestAnimationFrame(() => {
      this._hudSyncPending = false;
      if (this.active) this._hud?.refresh();
    });
  }

  /* ------------------------------- painting ------------------------------- */

  /**
   * Single brush stamp at `(x, y)`: emits up to `density` stain records of the
   * selected type. Lands on the highest surface NO HIGHER than `elev`; a surface
   * elevation jump (> 0.51) assigns a fall delay `d` so blood "drops down".
   */
  _stamp(x, y, dir) {
    const store = this.store;
    const renderer = this.renderer;
    if (!store || !renderer || !this._stroke) return;
    const p = this._params();

    const curLvl = currentLevelId();
    const brushCeiling = levelBaseElevation() + p.elev;
    const surf = surfaceAt(x, y, brushCeiling, curLvl);
    const activeLvl = surf.lvl ?? curLvl;
    if (p.material === 2 && this._stroke.altLower) {
      this._sculptLowerSnow(x, y, surf.e, p.size, activeLvl);
      return;
    }
    // Fall delay: mid-stroke surface elevation jump gives blood a landing delay (snow sculpts immediately)
    let d = 0;
    if (p.material !== 2 && this._stroke.lastE != null && Math.abs(surf.e - this._stroke.lastE) > 0.51) {
      d = clamp(Math.abs(surf.e - this._stroke.lastE) * 12, 60, 250);
    }
    this._stroke.lastE = surf.e;

    const wp = wallProfile({ x, y }, p.size * WALL_RADIUS_K, activeLvl);
    const nowT = p.material === 0 ? Math.round(worldTime()) : 0;
    const jitterRot = () => Math.random() - 0.5;
    const stampStartIdx = this._stroke.defs.length;
    const mk = (over) => {
      const rec = store.createStain({
        x: x + (Math.random() - 0.5) * p.size * 0.18,
        y: y + (Math.random() - 0.5) * p.size * 0.18,
        s: p.size * (0.85 + Math.random() * 0.3),
        r: dir != null ? dir + jitterRot() * 0.15 : Math.random() * TAU,
        a: clamp(p.alpha * (0.9 + Math.random() * 0.1), 0.05, 1),
        c: p.material === 2 ? '#e8ecf2e0' : p.color,
        ...(p.material ? { m: p.material } : {}),
        ...(nowT ? { T: nowT } : {}),
        ...(p.noWash ? { nw: 1 } : {}),
        ...(wp ? { w: wp } : {}),
        e: surf.e,
        ...(surf.tid ? { tid: surf.tid } : {}),
        ...(activeLvl ? { lvl: activeLvl } : {}),
        ...(d ? { d: Math.round(d) } : {}),
        ...over
      });
      this._stroke.defs.push(rec);
      return rec;
    };

    if (p.material !== 2) {
      this._stampBlood(x, y, p, dir, mk, jitterRot);
      renderer.addStains(this._stroke.defs.slice(stampStartIdx));
      return;
    }

    // Freshly painted snow gradually buries older trampled paths and footprints
    burySnowTracksAt(store, x, y, p.size * 0.78, surf.e, 1.15, { level: activeLvl });
    // Unified snow brush (`material === 2`):
    //  - in `snowDepth=0` ("Auto +1") mode: one LMB hold paints exactly one target tier
    //    (1st stroke -> lv=1 Dusting, 2nd -> lv=2 Cover, 3rd -> lv=3 Drift, 4th -> lv=4 Deep Drift, 5th -> lv=5 Barchan);
    //  - in `snowDepth=1..5` mode: paints the chosen tier directly (with optional smooth `snowSkirt` falloff).
    const grid = canvas?.grid?.size ?? 100;
    let snowLv: number = SNOW_LEVEL.LIGHT;
    if (this._stroke.snowTargetLv == null) {
          const rCheck = Math.max(grid * 0.5, p.size * 0.48);
          const rCheck2 = rCheck * rCheck;
          let storeMaxLv = 0;
          const nearStains = store.queryCircle(x, y, rCheck);
          for (let i = 0; i < nearStains.length; i++) {
            const st = nearStains[i];
            if (
              st.m === 2 &&
              st.t !== STAIN.FOOTPRINT &&
              st.c !== SNOW_SHADOW_COLOR &&
              !(st.t === STAIN.SMEAR && !(st.lv >= SNOW_LEVEL.DRIFT)) &&
              stainMatchesLevel(st, activeLvl) &&
              elevationMatches(st.e, surf.e) &&
              (Number(st.a) || 0) >= 0.2
            ) {
              const ddx = st.x - x, ddy = st.y - y;
              if (ddx * ddx + ddy * ddy > rCheck2) continue;
              const stLv = st.lv ?? SNOW_LEVEL.LIGHT;
              if (stLv > storeMaxLv) storeMaxLv = stLv;
            }
          }
      this._stroke.snowBaseUnderLv = storeMaxLv;
      this._stroke.snowTargetLv = p.snowDepth >= SNOW_LEVEL.LIGHT
        ? clamp(p.snowDepth, SNOW_LEVEL.LIGHT, SNOW_LEVEL.DRIFT_DEEP)
        : Math.min(SNOW_LEVEL.DRIFT_DEEP, storeMaxLv + 1);
    }
    snowLv = this._stroke.snowTargetLv;
        // Smooth falloff skirt (`snowSkirt`): when sculpting high drifts (`lv >= 3`) directly onto bare ground
        // or light dusting, automatically lay down a soft outer skirt of frost (`lv=1`) and snow cover (`lv=2`)
        // underneath the main drift dome.
        if (p.snowSkirt && p.snowDepth >= SNOW_LEVEL.DRIFT && snowLv >= SNOW_LEVEL.DRIFT) {
          const lastSX = this._stroke.snowLastSkirtX;
          const lastSY = this._stroke.snowLastSkirtY;
          const skirtStep = Math.max(24, p.size * 0.36);
          if (lastSX == null || Math.hypot(x - lastSX, y - lastSY) >= skirtStep) {
            const rLocal = Math.max(40, p.size * 0.44);
            const rLocal2 = rLocal * rLocal;
            let localMaxLv = 0;
            const nearLocal = store.queryCircle(x, y, rLocal);
            for (let i = 0; i < nearLocal.length; i++) {
              const st = nearLocal[i];
              if (
                st.m === 2 &&
                (st.t === STAIN.SPLAT || st.t === STAIN.DROPLETS) &&
                st.c !== SNOW_SHADOW_COLOR &&
                stainMatchesLevel(st, activeLvl) &&
                elevationMatches(st.e, surf.e)
              ) {
                const ddx = st.x - x, ddy = st.y - y;
                if (ddx * ddx + ddy * ddy > rLocal2) continue;
                const stLv = st.lv ?? SNOW_LEVEL.LIGHT;
                if (stLv > localMaxLv) localMaxLv = stLv;
              }
            }
            if (localMaxLv < SNOW_LEVEL.MEDIUM) {
              this._stroke.snowLastSkirtX = x;
              this._stroke.snowLastSkirtY = y;
              const baseAng = Math.random() * TAU;
              if (localMaxLv < SNOW_LEVEL.LIGHT) {
                const frostCount = p.size >= 260 ? 5 : 3;
                const frostUnitS = Math.min(185, Math.max(64, p.size * 0.56));
                const frostRingR = p.size * 0.42;
                for (let k = 0; k < frostCount; k++) {
                  const ka = baseAng + (k * TAU) / frostCount + (Math.random() - 0.5) * 0.35;
                  const kr = frostRingR * (0.88 + Math.random() * 0.22);
                  mk({
                    t: STAIN.DROPLETS,
                    x: x + Math.cos(ka) * kr,
                    y: y + Math.sin(ka) * kr,
                    s: frostUnitS * (0.9 + Math.random() * 0.2),
                    r: ka + Math.PI * 0.5 + (Math.random() - 0.5) * 0.5,
                    a: clamp(p.alpha * 0.76, 0.25, 0.9),
                    lv: SNOW_LEVEL.LIGHT
                  });
                }
              }
              const skirtCount = p.size >= 260 ? 4 : 3;
              const skirtUnitS = Math.min(200, Math.max(72, p.size * 0.64));
              const skirtRingR = p.size * 0.24;
              for (let k = 0; k < skirtCount; k++) {
                const ka = baseAng + 0.52 + (k * TAU) / skirtCount + (Math.random() - 0.5) * 0.3;
                const kr = skirtRingR * (0.85 + Math.random() * 0.26);
                mk({
                  t: STAIN.SPLAT,
                  x: x + Math.cos(ka) * kr,
                  y: y + Math.sin(ka) * kr,
                  s: skirtUnitS * (0.9 + Math.random() * 0.18),
                  r: Math.random() * TAU,
                  a: clamp(p.alpha * 0.9, 0.35, 0.96),
                  lv: SNOW_LEVEL.MEDIUM
                });
              }
            }
          }
        }

        if (snowLv === SNOW_LEVEL.LIGHT) {
          // Level I (Dusting): airy lacy frost veil (`STAIN.DROPLETS`) without opaque flat discs
          const unitS = Math.min(p.size, 165);
          const areaRatio = Math.max(1, (p.size * p.size) / (unitS * unitS));
          const clusterCount = p.size > unitS * 1.15
            ? Math.min(12, Math.max(3, Math.ceil(areaRatio * 1.45)))
            : 1;
          const maxOff = Math.max(0, (p.size - unitS * 0.68) * 0.5);
          const rot0 = Math.random() * TAU;
          const extraWisps = clusterCount === 1
            ? Math.min(2, Math.floor(p.density * 0.5))
            : (p.density >= 4 ? 1 : 0);
          for (let cIdx = 0; cIdx < clusterCount; cIdx++) {
            let cx = x;
            let cy = y;
            let ang = rot0;
            if (cIdx > 0) {
              const rNorm = Math.sqrt((cIdx + 0.32) / clusterCount);
              ang = rot0 + cIdx * 2.399963229728653 + (Math.random() - 0.5) * 0.34;
              const rr = maxOff * rNorm * (0.86 + Math.random() * 0.24);
              cx = x + Math.cos(ang) * rr;
              cy = y + Math.sin(ang) * rr;
            }
            mk({
              t: STAIN.DROPLETS,
              x: cx + (Math.random() - 0.5) * unitS * 0.12,
              y: cy + (Math.random() - 0.5) * unitS * 0.12,
              s: unitS * (0.9 + Math.random() * 0.22),
              r: dir != null ? dir + (Math.random() - 0.5) * 0.7 : Math.random() * TAU,
              a: clamp(p.alpha * (0.84 + Math.random() * 0.14), 0.22, 0.96),
              lv: SNOW_LEVEL.LIGHT
            });
            for (let i = 0; i < extraWisps; i++) {
              const wa = dir != null
                ? dir + (i % 2 === 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 1.1
                : Math.random() * TAU;
              const wr = unitS * (0.16 + Math.random() * 0.16);
              mk({
                t: STAIN.DROPLETS,
                x: cx + Math.cos(wa) * wr,
                y: cy + Math.sin(wa) * wr,
                s: unitS * (0.72 + Math.random() * 0.2),
                r: wa + (Math.random() - 0.5) * 0.5,
                a: clamp(p.alpha * (0.72 + Math.random() * 0.16), 0.2, 0.92),
                lv: SNOW_LEVEL.LIGHT
              });
            }
          }
        } else {
          // Levels II..V (Snow Cover and 3D Drifts): wide streamlined domes (`unitS` up to 320px; the world-space
          // `snowWorldPattern` keeps crystalline grain 1:1 at any scale without blur!) merge their solid white cores
          // (`0.73 * R`) into a cohesive sheet or massive barchan without a "cauliflower" look.
          const unitS = snowLv === SNOW_LEVEL.MEDIUM
            ? Math.min(p.size, 225)
            : Math.min(p.size, 320);
          const areaRatio = Math.max(1, (p.size * p.size) / (unitS * unitS));
          const clusterCount = p.size > unitS * 1.12
            ? Math.min(10, Math.max(3, Math.ceil(areaRatio * 1.75)))
            : 1;
          const maxOff = Math.max(0, (p.size - unitS * 0.78) * 0.5);
          const rot0 = Math.random() * TAU;
          const shouldersPerDome = clusterCount === 1
            ? Math.min(2, Math.floor((p.density - 1) * 0.6))
            : (p.density >= 4 && clusterCount <= 5 ? 1 : 0);
          for (let cIdx = 0; cIdx < clusterCount; cIdx++) {
            let cx = x;
            let cy = y;
            let rNorm = 0;
            let ang = rot0;
            if (cIdx > 0) {
              rNorm = Math.sqrt((cIdx + 0.24) / clusterCount);
              ang = rot0 + cIdx * 2.399963229728653 + (Math.random() - 0.5) * 0.24;
              const rr = maxOff * rNorm * (0.9 + Math.random() * 0.16);
              cx = x + Math.cos(ang) * rr;
              cy = y + Math.sin(ang) * rr;
            }
            mk({
              t: STAIN.SPLAT,
              x: cx + (Math.random() - 0.5) * unitS * 0.06,
              y: cy + (Math.random() - 0.5) * unitS * 0.06,
              s: unitS * (0.94 + Math.random() * 0.12),
              r: dir != null ? dir + (Math.random() - 0.5) * 0.55 : Math.random() * TAU,
              lv: snowLv
            });
            for (let i = 0; i < shouldersPerDome; i++) {
              const a = rNorm > 0.68
                ? ang + Math.PI + (Math.random() - 0.5) * 1.6
                : (dir != null
                  ? dir + (i % 2 === 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.8
                  : Math.random() * TAU);
              const r = unitS * (0.12 + Math.random() * 0.10);
              mk({
                t: STAIN.SPLAT,
                x: cx + Math.cos(a) * r,
                y: cy + Math.sin(a) * r,
                s: unitS * (0.80 + Math.random() * 0.14),
                r: a + (Math.random() - 0.5) * 0.45,
                lv: snowLv
              });
            }
          }
        }
      if (snowLv > SNOW_LEVEL.LIGHT) {
        const promotedSet = (this._stroke.snowPromotedIds ??= new Set());
        const replacePrevMap = (this._stroke.replacePrevMap ??= new Map());
        const rPromote = (p.snowDepth >= SNOW_LEVEL.DRIFT && p.snowSkirt)
          ? Math.max(grid * 0.52, p.size * 0.54)
          : Math.max(grid * 0.75, p.size * 0.8);
        const rPromote2 = rPromote * rPromote;
        const existingSnow = store.queryCircle(x, y, rPromote).filter(st => {
          if (promotedSet.has(st.i)) return false;
          if (st.m !== 2 || (st.t !== STAIN.SPLAT && st.t !== STAIN.DROPLETS) || st.c === SNOW_SHADOW_COLOR) return false;
          if (!stainMatchesLevel(st, activeLvl) || !elevationMatches(st.e, surf.e)) return false;
          const ddx = st.x - x, ddy = st.y - y;
          if (ddx * ddx + ddy * ddy > rPromote2) return false;
          return (st.lv ?? 1) < snowLv;
        });
        if (existingSnow.length) {
          const promoted = existingSnow.map(st => {
            promotedSet.add(st.i);
            if (!replacePrevMap.has(st.i)) replacePrevMap.set(st.i, st);
            const { d: _d, f: _f, g: _g, ...rest } = st;
            return { ...rest, t: STAIN.SPLAT, lv: snowLv };
          });
          if (typeof store.applyBatch === 'function') {
            store.applyBatch({ replace: promoted });
          } else {
            store.remove(existingSnow.map(st => st.i));
            store.add(promoted);
          }
        }
      }

    // Live preview directly into the renderer (records already carry IDs — commit will add the exact same defs)
    renderer.addStains(this._stroke.defs.slice(stampStartIdx));
  }

  /**
   * Unified adaptive blood brush (`material === 0`):
   *  - Stationary click (`dir == null`): fine droplets at small size, splat at
   *    medium, pool + splat rim at large size & density >= 3, plus radial satellites.
   *  - Dragged stroke (`dir != null`): continuous directional smears + wet splats
   *    (or droplet trails at small size) with forward splash & trailing edge drops.
   */
  _stampBlood(x, y, p, dir, mk, jitterRot) {
    if (dir == null) {
      if (p.size < 48) {
        mk({ t: STAIN.DROPLETS, s: p.size * (0.88 + Math.random() * 0.24) });
      } else if (p.size >= 200 && p.density >= 3) {
        mk({ t: STAIN.POOL, s: p.size * (0.94 + Math.random() * 0.18) });
        mk({ t: STAIN.SPLAT, s: p.size * (0.82 + Math.random() * 0.18) });
      } else {
        mk({ t: STAIN.SPLAT, s: p.size * (0.9 + Math.random() * 0.24) });
      }
      for (let i = 1; i < p.density; i++) {
        const ang = Math.random() * TAU;
        const off = p.size * (0.26 + Math.random() * 0.34);
        const type = i % 3 === 0 ? STAIN.SPLASH : i % 2 === 1 ? STAIN.DROPLETS : STAIN.SPLAT;
        const scale = type === STAIN.SPLASH
          ? 0.4 + Math.random() * 0.22
          : type === STAIN.DROPLETS
            ? 0.35 + Math.random() * 0.2
            : 0.32 + Math.random() * 0.2;
        mk({
          t: type,
          x: x + Math.cos(ang) * off,
          y: y + Math.sin(ang) * off,
          r: ang,
          s: p.size * scale
        });
      }
      return;
    }

    const stepIdx = (this._stroke.stepIndex = (this._stroke.stepIndex ?? 0) + 1);
    if (p.size < 42) {
      mk({
        t: STAIN.DROPLETS,
        r: dir + jitterRot() * 0.35,
        s: p.size * (0.78 + Math.random() * 0.24)
      });
    } else if (stepIdx % 3 !== 0) {
      mk({
        t: STAIN.SMEAR,
        r: dir + jitterRot() * 0.14,
        s: p.size * (0.96 + Math.random() * 0.2)
      });
    } else {
      mk({
        t: STAIN.SPLAT,
        r: dir + jitterRot() * 0.25,
        s: p.size * (0.84 + Math.random() * 0.2)
      });
    }
    for (let i = 1; i < p.density; i++) {
      if (i % 2 === 0) {
        const coneAng = dir + (Math.random() - 0.5) * 0.85;
        const off = p.size * (0.26 + Math.random() * 0.34);
        mk({
          t: STAIN.SPLASH,
          x: x + Math.cos(coneAng) * off,
          y: y + Math.sin(coneAng) * off,
          r: coneAng,
          s: p.size * (0.38 + Math.random() * 0.2)
        });
      } else {
        const sideAng = dir + Math.PI + (Math.random() - 0.5) * 1.3;
        const off = p.size * (0.22 + Math.random() * 0.32);
        mk({
          t: STAIN.DROPLETS,
          x: x + Math.cos(sideAng) * off,
          y: y + Math.sin(sideAng) * off,
          r: sideAng,
          s: p.size * (0.3 + Math.random() * 0.18)
        });
      }
    }
  }

  /**
   * Lower snow depth by 1 tier (`Alt + LMB` in snow brush mode):
   * lv 5 → 4 → 3 → 2 → 1 → full removal, at most one step per stain per stroke.
   */
  _sculptLowerSnow(x, y, surfE, brushSize, levelId: string | null = currentLevelId()) {
    const store = this.store;
    if (!store || !this._stroke) return;
    const demotedSet = (this._stroke.snowDemotedIds ??= new Set());
    const replacePrevMap = (this._stroke.replacePrevMap ??= new Map());
    const removedMap = (this._stroke.removedMap ??= new Map());
    const r = Math.max(24, brushSize * 0.54);
    const r2 = r * r;
    const near = store.queryCircle(x, y, r);
    if (!near.length) return;

    const lowered = [];
    const killedIds = [];
    let minRemainingLv = 0;

    for (let i = 0; i < near.length; i++) {
      const st = near[i];
      if (!st || st.m !== 2 || !stainMatchesLevel(st, levelId) || !elevationMatches(st.e, surfE)) continue;
      if (st.t !== STAIN.SPLAT && st.t !== STAIN.DROPLETS) continue;
      if (st.c === SNOW_SHADOW_COLOR) continue;
      const dx = st.x - x, dy = st.y - y;
      if (dx * dx + dy * dy > r2) continue;
      if (demotedSet.has(st.i)) {
        const cur = st.lv ?? SNOW_LEVEL.LIGHT;
        if (cur > minRemainingLv) minRemainingLv = cur;
        continue;
      }
      demotedSet.add(st.i);
      const curLv = st.lv ?? SNOW_LEVEL.LIGHT;
      if (curLv >= SNOW_LEVEL.MEDIUM) {
        if (!replacePrevMap.has(st.i)) replacePrevMap.set(st.i, st);
        const nextLv = curLv - 1;
        if (nextLv > minRemainingLv) minRemainingLv = nextLv;
        const { d: _d, f: _f, g: _g, ...rest } = st;
        lowered.push({
          ...rest,
          t: nextLv === SNOW_LEVEL.LIGHT ? STAIN.DROPLETS : STAIN.SPLAT,
          lv: nextLv
        });
      } else {
        if (!removedMap.has(st.i)) removedMap.set(st.i, st);
        killedIds.push(st.i);
      }
    }

    // Clean up orphaned furrows/footprints if the drift was lowered below trench threshold or cleared to bare ground
    if (lowered.length || killedIds.length) {
      const rTrack2 = (r * 0.88) * (r * 0.88);
      for (let i = 0; i < near.length; i++) {
        const st = near[i];
        if (!st || st.m !== 2 || demotedSet.has(st.i) || !stainMatchesLevel(st, levelId) || !elevationMatches(st.e, surfE)) continue;
        const dx = st.x - x, dy = st.y - y;
        if (dx * dx + dy * dy > rTrack2) continue;
        const isOrphanTrench = st.t === STAIN.SMEAR && !(st.lv >= SNOW_LEVEL.DRIFT) && minRemainingLv < SNOW_LEVEL.DRIFT;
        const isOrphanPrint = st.t === STAIN.FOOTPRINT && minRemainingLv < SNOW_LEVEL.LIGHT;
        if (isOrphanTrench || isOrphanPrint) {
          demotedSet.add(st.i);
          if (!removedMap.has(st.i)) removedMap.set(st.i, st);
          killedIds.push(st.i);
        }
      }
    }

    if (!lowered.length && !killedIds.length) return;
    if (typeof store.applyBatch === 'function') {
      store.applyBatch({
        replace: lowered.length ? lowered : null,
        remove: killedIds.length ? killedIds : null
      });
    } else {
      if (killedIds.length) store.remove(killedIds);
      if (lowered.length) {
        store.remove(lowered.map(st => st.i));
        store.add(lowered);
      }
    }
    this._syncCount();
  }

  /* ------------------------------- eraser ------------------------------- */

  /** Erase at `(x, y)`: visually immediate, committed to store/socket in one batch on
   *  pointer release (`_flushEraseRemovals`). Throttled to 150 ms (bypassed on click via `force=true`). */
  _erase(x, y, { force = false, shiftKey = false } = {}) {
    const now = Date.now();
    if (!force && now - this._eraseAt < ERASE_THROTTLE_MS) return;
    this._eraseAt = now;
    const store = this.store;
    const renderer = this.renderer;
    if (!store || !renderer) return;
    const p = this._params();
    const filterMat = p.eraseMatOnly || shiftKey;
    const targetMat = Number(p.material) || 0;
    const matchMat = (st) => isStainVisibleOnLevel(st) && (!filterMat || (Number(st.m) || 0) === targetMat);
    const r = p.size * 0.55;
    const r2 = r * r;
    const kill = [];

    // Pending stains of the active stroke — minted, but not yet in the store
    if (this._stroke) {
      this._stroke.defs = this._stroke.defs.filter(st => {
        if (!matchMat(st)) return true;
        const dx = st.x - x, dy = st.y - y;
        if (dx * dx + dy * dy <= r2) {
          renderer.removeStains([st.i]);
          this._eraseRecs.set(st.i, st);
          return false;
        }
        return true;
      });
    }
    // Deferred (`d`) stains in the renderer — the eraser must catch them too (these
    // are store records still waiting out their `d` delay in the renderer)
    for (const st of renderer.deferredStains) {
      if (!matchMat(st)) continue;
      const dx = st.x - x, dy = st.y - y;
      if (dx * dx + dy * dy <= r2) kill.push(st);
    }
    // Live store — via spatial index (O(1)), not linear scan
    for (const st of store.queryCircle(x, y, r)) {
      if (matchMat(st)) kill.push(st);
    }

    if (!kill.length) return;
    for (const st of kill) {
      this._eraseIds.add(st.i);
      this._eraseRecs.set(st.i, st); // stash record for undo (CTRL+Z)
    }
    renderer.removeStains([...this._eraseIds]); // visually immediate
    this._syncCount();
  }

  _flushEraseRemovals() {
    if (!this._eraseIds.size) return;
    const ids = [...this._eraseIds];
    // Push erased records onto the undo stack BEFORE removing from the store
    pushBloodOp('remove', [...this._eraseRecs.values()].filter(st => this._eraseIds.has(st.i)));
    this._eraseIds.clear();
    this._eraseRecs.clear();
    this.store?.remove(ids); // single socket op + single flag write
  }

  /* ------------------------------- stroke commit ------------------------------- */

  _commitPending() {
    this._flushEraseRemovals();
    try { this.renderer?.flushOverlays?.(); } catch { /* noop */ }
    const stroke = this._stroke;
    if (!stroke) return;
    const defs = stroke.defs;
    const fresh = [];
    if (defs?.length) {
      stroke.defs = [];
      // Chunked commit: ≤400 records per op. Sending a long stroke in a single op
      // hit `applyRemote`'s 500-item cap — players missed the stroke tail until flush (~3s)
      for (let i = 0; i < defs.length; i += 400) {
        const part = this.store?.add(defs.slice(i, i + 400));
        if (part?.length) fresh.push(...part);
      }
    }
    const replacedPrev = stroke.replacePrevMap?.size ? [...stroke.replacePrevMap.values()] : [];
    const removed = stroke.removedMap?.size ? [...stroke.removedMap.values()] : [];
    if (replacedPrev.length || removed.length) {
      pushBloodOp('batch', { added: fresh, removed, replacedPrev });
    } else if (fresh.length) {
      pushBloodOp('add', fresh);
    }
  }
}
