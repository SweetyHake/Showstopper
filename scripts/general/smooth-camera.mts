/* ─── Configuration & State ─── */

const MODULE_ID = "showstopper";
const SK = "smoothCamera";

const DEFAULTS = {
  enabled: true,
  panSpeed: 5,
  zoomSpeed: 4
};

const TYPES = {
  enabled: Boolean,
  panSpeed: Number,
  zoomSpeed: Number
};

let _panTickerCb = null;
let _zoomTickerCb = null;
let _targetPos = null;
let _dragOrigin = null;
let _patched = false;
let _origWheel = null;
let _origDrag = null;
let _origPan = null;
let _origAnimatePan = null;
let _ptrUpHandler = null;
// Promise resolver for our custom animatePan: interrupting an animation (user drag,
// teardown) must resolve the promise so callers awaiting it never hang forever.
let _animatePanResolve = null;

function get(key) {
  try { return game.settings.get(MODULE_ID, `${SK}.${key}`); }
  catch { return DEFAULTS[key]; }
}

// Speeds are read from settings EVERY FRAME ON PURPOSE (60 Map lookups/s is negligible).
// An "animation-lifetime" cache was tried and removed: killPan/_submit did not invalidate it,
// so after changing panSpeed, drags kept crawling at the stale value until an external
// killAll occurred (mouse wheel / scene change / animatePan).

/* ─── Lifecycle & Coordinate Helpers ─── */

function killPan() {
  if (_panTickerCb) {
    canvas.app?.ticker.remove(_panTickerCb);
    _panTickerCb = null;
  }
  _targetPos = null;
  _dragOrigin = undefined;
  // Target scale must be cleared alongside pan: previously only killZoom cleared it,
  // so an external canvas.pan interrupting a zoomed animatePan left it dangling —
  // causing the next scale-less animatePan to inherit a stale zoom target.
  window.__sstTargetScale = undefined;
  if (_animatePanResolve) {
    const resolve = _animatePanResolve;
    _animatePanResolve = null;
    resolve();
  }
}

function killZoom() {
  if (_zoomTickerCb) {
    canvas.app?.ticker.remove(_zoomTickerCb);
    _zoomTickerCb = null;
  }
  window.__sstTargetScale = undefined;
}

function killAll() {
  killPan();
  killZoom();
  foundry.canvas?.animation?.CanvasAnimation?.terminateAnimation?.("canvas.animatePan");
}

function getMouseWorldPosition(event) {
  const viewPos = canvas.scene?._viewPosition ?? { x: 0, y: 0, scale: 1 };
  const dims = canvas.screenDimensions;
  const viewLeft = viewPos.x - dims[0] / 2 / viewPos.scale;
  const viewTop  = viewPos.y - dims[1] / 2 / viewPos.scale;
  const canvasEl = canvas.app?.view;
  const pivot    = canvas.stage?.pivot;
  const scale    = canvas.stage?.scale.x ?? 1;
  if (!canvasEl || !pivot) return null;
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (event.x - rect.x) / scale + viewLeft,
    y: (event.y - rect.y) / scale + viewTop
  };
}

/* ─── Canvas Input & Pan Patching ─── */

function patchPan() {
  const origPan = _origPan;
  const panWrapper = function (opts) {
    const internal = opts?.__sstInternal;
    if (opts && "__sstInternal" in opts) delete opts.__sstInternal;
    // External pans during an ACTIVE right-click drag must not wipe out the accumulated
    // drag target: the drag lag (v / panSpeed, hundreds of px during fast motion) would be
    // discarded on every call, turning a per-frame external panner into a ~8% mouse-speed crawl.
    // Offset the target by the pivot delta applied by the external call so the drag continues smoothly.
    if (!internal && _dragOrigin && _targetPos && canvas.stage) {
      const px = canvas.stage.pivot.x, py = canvas.stage.pivot.y;
      const res = origPan.call(this, opts);
      _targetPos.x += canvas.stage.pivot.x - px;
      _targetPos.y += canvas.stage.pivot.y - py;
      return res;
    }
    if (!internal) killPan();
    return origPan.call(this, opts);
  };
  panWrapper.__sstOrig = origPan;
  canvas.pan = panWrapper;
}

function onDragRightMove(event) {
  if (!canvas.app || !canvas.stage || !get("enabled")) {
    if (_origDrag) return _origDrag.call(canvas, event);
    return;
  }

  // Not every event dispatched by MouseManager carries movementX: without this guard,
  // origin becomes NaN, target becomes NaN, and the ticker's NaN guard kills the pan on
  // the very first frame (camera never moves at all). Fallback: zero step.
  _dragOrigin ?? (_dragOrigin = {
    x: event.globalX - (Number.isFinite(event.movementX) ? event.movementX : 0),
    y: event.globalY - (Number.isFinite(event.movementY) ? event.movementY : 0)
  });

  const cur = { x: event.globalX, y: event.globalY };

  if (cur.x === _dragOrigin.x && cur.y === _dragOrigin.y) return;

  killZoom();
  foundry.canvas?.animation?.CanvasAnimation?.terminateAnimation?.("canvas.animatePan");

  if (_targetPos) {
    _targetPos.x -= (cur.x - _dragOrigin.x) / canvas.stage.scale._x;
    _targetPos.y -= (cur.y - _dragOrigin.y) / canvas.stage.scale._y;
  } else {
    _targetPos = {
      x: canvas.stage.pivot._x - (cur.x - _dragOrigin.x) / canvas.stage.scale._x,
      y: canvas.stage.pivot._y - (cur.y - _dragOrigin.y) / canvas.stage.scale._y
    };
  }

  _dragOrigin = cur;

  if (_panTickerCb) return;

  _panTickerCb = () => {
    const delta = (canvas.app.ticker.deltaMS || 16.666) / 1000;
    if (!_targetPos || !canvas.stage) return;

    const cx = canvas.stage.pivot.x;
    const cy = canvas.stage.pivot.y;
    const dx = _targetPos.x - cx;
    const dy = _targetPos.y - cy;
    // A NaN pivot/target would never converge and would pan into NaN forever
    // (causing the scene to stop rendering).
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { killPan(); return; }
    const factor = 1 - Math.exp(-get("panSpeed") * delta);

    canvas.pan({
      x: cx + dx * factor,
      y: cy + dy * factor,
      __sstInternal: true
    });

    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) killPan();
  };

  canvas.app.ticker.add(_panTickerCb);
}

function onMouseWheel(event) {
  if (!canvas.app || !get("enabled")) {
    if (_origWheel) return _origWheel.call(canvas, event);
    return;
  }

  const mouseWorld = getMouseWorldPosition({ x: event.clientX, y: event.clientY });
  if (!mouseWorld) return;

  const dz = event.delta < 0 ? 1.05 : 0.95;
  const raw = (window.__sstTargetScale ?? canvas.stage?.scale.x ?? 1) * dz;

  killZoom();
  foundry.canvas?.animation?.CanvasAnimation?.terminateAnimation?.("canvas.animatePan");
  killPan();

  window.__sstTargetScale = canvas._constrainView({ scale: raw }).scale;

  _zoomTickerCb = () => {
    const delta = (canvas.app.ticker.deltaMS || 16.666) / 1000;
    if (!canvas.stage) return;

    const cur = canvas.stage.scale.x;
    const target = window.__sstTargetScale ?? cur;
    const ds = target - cur;
    const factor = 1 - Math.exp(-get("zoomSpeed") * delta);
    const next = cur + ds * factor;

    const dx = (mouseWorld.x - canvas.stage.pivot.x) * (1 - cur / next);
    const dy = (mouseWorld.y - canvas.stage.pivot.y) * (1 - cur / next);

    canvas.pan({
      x: canvas.stage.pivot.x + dx,
      y: canvas.stage.pivot.y + dy,
      scale: next,
      __sstInternal: true
    });

    if (Math.abs(ds) < canvas.stage.scale.x * 0.01) killZoom();
  };

  canvas.app.ticker.add(_zoomTickerCb);
}

function patchCanvas() {
  if (_patched) return;
  _patched = true;

  // Grid changes (and other redraws) re-initialize the SAME Canvas instance:
  // canvasInit fires with our live wrappers still occupying the original slots.
  // Capturing them as "originals" would stack wrappers, so an internal pan (whose
  // __sstInternal flag was already stripped by the outer wrapper) would reach the inner
  // wrapper as "external" — calling killPan every frame, turning drags into a crawl, and
  // (since killPan clears target scale) instantly killing zoom as well. Unwrap via __sstOrig.
  const unwrap = (fn) => fn?.__sstOrig ?? fn;
  _origWheel = unwrap(canvas._onMouseWheel);
  _origDrag = unwrap(canvas._onDragRightMove);
  _origPan = unwrap(canvas.pan).bind(canvas);
  _origAnimatePan = unwrap(canvas.animatePan).bind(canvas);

  (onMouseWheel as any).__sstOrig = _origWheel;
  (onDragRightMove as any).__sstOrig = _origDrag;
  canvas._onMouseWheel = onMouseWheel;
  canvas._onDragRightMove = onDragRightMove;

  patchPan();

  if (_ptrUpHandler) window.removeEventListener("pointerup", _ptrUpHandler);
  _ptrUpHandler = () => { _dragOrigin = undefined; };
  window.addEventListener("pointerup", _ptrUpHandler);

  const animatePanWrapper = function (target, options = {}) {
    if (!get("enabled")) return _origAnimatePan(target, options);

    // Choreographies with explicit timing (__sstTimed) require exact duration
    // (e.g. camera arriving right at an attack wind-up in 550 ms instead of a 1.5 s
    // exponential tail).
    if (target?.__sstTimed) {
      const cleanTarget = { ...target };
      delete cleanTarget.__sstTimed;
      killAll();
      return _origAnimatePan(cleanTarget, options);
    }

    // Non-finite target coordinates: our exponential ticker would never converge, whereas
    // core's animation has a finite duration — delegate such calls to core.
    if (target && (!Number.isFinite(target.x) || !Number.isFinite(target.y))) {
      return _origAnimatePan(target, options);
    }

    killAll();

    _targetPos = {
      x: target.x ?? canvas.stage.pivot.x,
      y: target.y ?? canvas.stage.pivot.y
    };

    if (target.scale !== undefined) {
      window.__sstTargetScale = canvas._constrainView({ scale: target.scale }).scale;
    }

    return new Promise<void>(resolve => {
      _animatePanResolve = resolve;
      _panTickerCb = () => {
        const delta = (canvas.app.ticker.deltaMS || 16.666) / 1000;
        if (!_targetPos || !canvas.stage) return;

        const cx = canvas.stage.pivot.x;
        const cy = canvas.stage.pivot.y;
        const dx = _targetPos.x - cx;
        const dy = _targetPos.y - cy;
        // A NaN pivot/target would never converge and would pan into NaN forever
        // (causing the scene to stop rendering).
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) { killPan(); return; }
        const factor = 1 - Math.exp(-get("panSpeed") * delta);

        const panOpts: any = {
          x: cx + dx * factor,
          y: cy + dy * factor,
          __sstInternal: true
        };

        if (window.__sstTargetScale !== undefined) {
          const curS = canvas.stage.scale.x;
          const ds = window.__sstTargetScale - curS;
          panOpts.scale = curS + ds * factor;
          if (Math.abs(ds) < 0.001) window.__sstTargetScale = undefined;
        }

        canvas.pan(panOpts);

        // Pure zoom-in-place (target == current pivot) converges in position on the
        // VERY FIRST frame — without also checking scale convergence, animatePan would
        // resolve immediately and freeze the camera mid-zoom.
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5
          && (window.__sstTargetScale === undefined
            || Math.abs(window.__sstTargetScale - canvas.stage.scale.x) < 0.001)) {
          killPan();
          resolve();
        }
      };

      canvas.app.ticker.add(_panTickerCb);
    });
  };
  animatePanWrapper.__sstOrig = _origAnimatePan;
  canvas.animatePan = animatePanWrapper;
}

function unpatch() {
  if (!_patched) return;
  killAll();
  if (_origWheel) canvas._onMouseWheel = _origWheel;
  if (_origDrag) canvas._onDragRightMove = _origDrag;
  if (_origPan) canvas.pan = _origPan;
  if (_origAnimatePan) canvas.animatePan = _origAnimatePan;
  if (_ptrUpHandler) { window.removeEventListener("pointerup", _ptrUpHandler); _ptrUpHandler = null; }
  _origWheel = null;
  _origDrag = null;
  _origPan = null;
  _origAnimatePan = null;
  _patched = false;
}

/* ─── Settings Dialog (ApplicationV2) ─── */

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

class SmoothCameraConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "sst-smooth-camera-cfg",
    classes: ["showstopper-app", "effect-settings-dialog"],
    tag: "form",
    form: {
      handler: SmoothCameraConfig._submit,
      closeOnSubmit: true
    },
    window: {
      title: "showstopper.SmoothCamera.Title",
      icon: "fas fa-video"
    },
    position: { width: 420 }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/smooth-camera-config.hbs` }
  };

  async _prepareContext() {
    return {
      enabled: get("enabled"),
      panSpeed: get("panSpeed"),
      zoomSpeed: get("zoomSpeed")
    };
  }

  static async _submit(event, form, formData) {
    const d = formData.object;
    for (const k of Object.keys(TYPES)) {
      if (TYPES[k] === Boolean && !(k in d)) d[k] = false;
    }
    for (const [k, v] of Object.entries(d)) {
      if (k in DEFAULTS) await game.settings.set(MODULE_ID, `${SK}.${k}`, v);
    }
    if (get("enabled")) {
      if (!_patched) patchCanvas();
    } else {
      unpatch();
    }
  }

  _onRender() {
    this.element.querySelectorAll(".sst-field-pair").forEach(group => {
      const range = group.querySelector('input[type="range"]');
      const num = group.querySelector('input[type="number"]');
      if (!range || !num) return;
      range.addEventListener("input", () => { num.value = range.value; });
      num.addEventListener("input", () => {
        const c = Math.max(+range.min, Math.min(+range.max, +num.value));
        range.value = c;
      });
      num.addEventListener("change", () => {
        num.value = Math.max(+range.min, Math.min(+range.max, +num.value));
        range.value = num.value;
      });
    });
  }
}

/* ─── Foundry Hooks ─── */

Hooks.once("init", () => {
  for (const [key, val] of Object.entries(DEFAULTS)) {
    game.settings.register(MODULE_ID, `${SK}.${key}`, {
      scope: "client",
      config: false,
      type: TYPES[key],
      default: val,
      name: `showstopper.SmoothCamera.${key[0].toUpperCase() + key.slice(1)}.Name`,
      hint: `showstopper.SmoothCamera.${key[0].toUpperCase() + key.slice(1)}.Hint`
    });
  }
  game.settings.registerMenu(MODULE_ID, `${SK}.menu`, {
    name: "showstopper.SmoothCamera.Title",
    label: "showstopper.SmoothCamera.Label",
    icon: "fas fa-video",
    type: SmoothCameraConfig,
    restricted: false
  });
});

Hooks.on("canvasInit", (canvas) => {
  // Patches are own properties of the Canvas INSTANCE, and Foundry recreates Canvas on
  // every scene change: previously, the _patched guard silently skipped re-patching the
  // new instance, killing smooth camera until F5 (and saved bound originals would still
  // point to the dead old instance). Reset patch state without touching the dead instance,
  // then patch the fresh one.
  if (_patched) {
    killAll();
    _patched = false;
    _origWheel = null;
    _origDrag = null;
    _origPan = null;
    _origAnimatePan = null;
    if (_ptrUpHandler) {
      window.removeEventListener("pointerup", _ptrUpHandler);
      _ptrUpHandler = null;
    }
  }
  if (get("enabled")) patchCanvas();
  else unpatch();
});

Hooks.once("canvasReady", () => {
  if (get("enabled") && !_patched) patchCanvas();
});

Hooks.on("canvasTearDown", () => {
  killAll();
});

export { SmoothCameraConfig, killPan, killZoom };