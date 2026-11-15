/**
 * Live token drag preview when placing actors onto a scene — TWO drag paths:
 *
 *  1. Native HTML5 drag interception (Actor Directory / Compendium / Fameosity)
 *     in the `document` capture phase: we render the preview, core handles placement;
 *  2. Custom mouse drag of a portrait onto the canvas from the Portrait Panel (GM):
 *     cursor ghost, full-size live PIXI preview, and drop via a synthetic `DragEvent`
 *     dispatched to core (reusing the entire native token placement pipeline as-is).
 *
 * Runs as a standalone module (independent of whether the Portrait Panel is enabled).
 * Previews are built via the SHARED `./token-ring.mjs` module (instant vector base
 * `buildRingBase` -> async upgrade to real spritesheet artwork `buildRingFromFrames`) —
 * producing the exact same body structure as finisher clones.
 * Wildcard variants (`prototypeToken.randomImg`) rolled for the preview are pinned and
 * injected into `getTokenDocument` on drop so that "what is previewed == what gets placed".
 */

import { MODULE_ID, FALLBACK_IMAGE, localize, isRealImage } from '../player-portraits/constants.mjs';
import { registerAPI } from '../core/runtime.mjs';
import {
  buildPlainBody,
  buildRingBase,
  buildRingFromFrames,
  systemTokenScale,
  ringFitSSA,
  resolveRingSheetUrl,
  loadRingFrames
} from './token-ring.mjs';

/** Resolve the real token image with actor art fallbacks (`mystery-man` stubs
 *  do not count as real artwork — matching Foundry core token creation). */
function resolveTokenImage(tokenData, actor = null) {
  const a = actor
    ?? tokenData.actor
    ?? (tokenData.parent?.documentName === "Actor" ? tokenData.parent : null)
    ?? (tokenData.actorId ? game.actors.get(tokenData.actorId) : null);

  const protoSrc = tokenData.texture?.src ?? null;
  if (isRealImage(protoSrc)) return protoSrc;
  if (isRealImage(a?.img)) return a.img;
  if (isRealImage(a?.prototypeToken?.texture?.src)) return a.prototypeToken.texture.src;
  return protoSrc ?? a?.img ?? null;
}

export class DragPreviewManager {
  declare panel; declare draggedActor; declare dragGhost; declare _pendingWildcard; declare _pendingWildcardName; declare _pendingHeroBox; declare _pendingHeroBoxName; declare _wildcardExpireTimer; declare _dropPreviewCtx; declare _dropPreviewStarting; declare _dropPreviewPromise; declare _dragCanvasRect; declare _lastSnapped; declare _lastDragCoords; declare _activeDragController; declare _nativeDragAC; declare _nativeDragUUID; declare _nativeDragActor; declare _suppressNativeDragImage; declare _dragImagePatched; declare _origCreateDragImage; declare _wildcardPatched; declare _origGetTokenDocument; declare _heroBoxPatched; declare _heroBoxSvc; declare _origApplyRandomTokenImage; declare _dragImageEl;
  constructor(panel = null) {
    this.panel = panel;
    this.draggedActor = null;
    this.dragGhost = null;
    this._pendingWildcard = new Map();
    this._pendingWildcardName = new Map();
    this._pendingHeroBox = new Map();
    this._pendingHeroBoxName = new Map();
    this._wildcardExpireTimer = null;
    this._dropPreviewCtx = null;
    this._dropPreviewStarting = false;
    this._dropPreviewPromise = null;
    this._dragCanvasRect = null;
    this._lastSnapped = null;
    this._lastDragCoords = null;
    this._activeDragController = null;
    this._nativeDragAC = null;
    this._nativeDragUUID = null;
    this._nativeDragActor = null;
    this._suppressNativeDragImage = false;
    this._dragImagePatched = false;
    this._origCreateDragImage = null;
    this._wildcardPatched = false;
    this._origGetTokenDocument = null;
    this._heroBoxPatched = false;
    this._heroBoxSvc = null;
    this._origApplyRandomTokenImage = null;
    this._dragImageEl = null;
  }

  init() {
    if (this._nativeDragAC) return;
    // Native HTML5 actor drags: render our preview over the canvas.
    // `dragstart` MUST listen in the capture phase: `DragDrop._handleDragStart` calls
    // `stopPropagation`, preventing the event from bubbling up to `document`.
    this._nativeDragAC = new AbortController();
    const dragSig = this._nativeDragAC.signal;
    document.addEventListener("dragstart", (e) => this._onNativeDragStart(e), { capture: true, signal: dragSig });
    document.addEventListener("dragover", (e) => this._onNativeDragOver(e), { capture: true, signal: dragSig });
    document.addEventListener("drop", () => this._onNativeDragEnd(), { capture: true, signal: dragSig });
    // IMPORTANT: do NOT clear `_pendingWildcard` here. `_onDropActorData` is asynchronous
    // (loads/imports the actor from a compendium pack), and `dragend` fires BEFORE the
    // drop reaches `getTokenDocument` — clearing here broke variant injection (`forced: null`).
    // Entries are overwritten by each new preview, and infinite loops cannot occur because
    // the preview invokes the unpatched original method (rolling fresh every drag).
    document.addEventListener("dragend", () => this._onNativeDragEnd(), { capture: true, signal: dragSig });
    this._patchDragImageFactory();
    this._installWildcardSync();
    this._ensureHeroBoxSync();
  }

  /**
   * Abort only an active custom mouse drag from the Portrait Panel
   * (e.g. when disabling the panel), leaving native HTML5 drag previews intact.
   */
  cancelPortraitDrag() {
    if (this._activeDragController) {
      this._activeDragController.abort();
      this._activeDragController = null;
    }
    document.body.classList.remove("dvp-dragging");
    if (this.draggedActor) {
      this.draggedActor = null;
      this._lastDragCoords = null;
      this._removeDragGhost();
      this._removeDropPreview();
    } else {
      this._removeDragGhost();
    }
  }

  destroy() {
    this.cancelPortraitDrag();
    this._removeDropPreview();

    this._nativeDragAC?.abort();
    this._nativeDragAC = null;
    this._nativeDragActor = null;
    // Clear the UUID as well: an in-flight `fromUuid` continuation (compendium drag)
    // checks against `_nativeDragUUID` and would otherwise repopulate `_nativeDragActor`
    // on a destroyed manager.
    this._nativeDragUUID = null;
    this._suppressNativeDragImage = false;
    this._unpatchDragImageFactory();
    this._uninstallWildcardSync();
    this._uninstallHeroBoxSync();
    if (this._wildcardExpireTimer) {
      clearTimeout(this._wildcardExpireTimer);
      this._wildcardExpireTimer = null;
    }
    this._pendingWildcard.clear();
    this._pendingWildcardName.clear();
    this._pendingHeroBox.clear();
    this._pendingHeroBoxName.clear();
    this._dragImageEl?.remove();
    this._dragImageEl = null;
  }

  /** Preview PIXI display objects died with the previous canvas — reset references. */
  onCanvasReady() {
    this._dropPreviewCtx = null;
    this._dropPreviewStarting = false;
    this._dropPreviewPromise = null;
    this._dragCanvasRect = null;
    this._lastSnapped = null;
  }

  /* ── Path 1: Custom portrait mouse drag (GM) ────────────────────────── */

  onPortraitMouseDown(event, data) {
    if (event.button !== 0 || !data.character) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let isDragging = false;
    const dragAc = new AbortController();
    const { signal } = dragAc;
    // Track the active drag controller so `panel.destroy()` can abort document
    // listeners and remove the cursor ghost even mid-drag.
    this._activeDragController?.abort();
    this._activeDragController = dragAc;

    const onMouseMove = (e) => {
      const deltaX = Math.abs(e.clientX - startX);
      const deltaY = Math.abs(e.clientY - startY);

      if (!isDragging && (deltaX > 5 || deltaY > 5)) {
        isDragging = true;
        this.draggedActor = data.character;
        this._createDragGhost(e, data);
        document.body.classList.add("dvp-dragging");
      }

      if (isDragging && this.dragGhost) {
        this.dragGhost.style.left = `${e.clientX}px`;
        this.dragGhost.style.top = `${e.clientY}px`;
        this._lastDragCoords = {
          clientX: e.clientX,
          clientY: e.clientY,
          shiftKey: e.shiftKey === true,
          altKey: e.altKey === true
        };
        this._updateDropFeedback(e);
      }
    };

    // SHIFT/ALT toggling during a custom mouse drag. In a native HTML5 drag, pressing
    // a modifier key automatically re-fires `dragover` so the preview snaps/unsnaps
    // immediately. Custom drags rely on `mousemove`, which a key press does not fire —
    // listen to `keydown`/`keyup` directly and reposition using the last cursor coords.
    const onModKey = (e) => {
      if ((e.key !== "Shift" && e.key !== "Alt") || !isDragging || !this.dragGhost) return;
      if (!this._lastDragCoords) return;
      const isDown = e.type === "keydown";
      const shiftKey = e.key === "Shift" ? isDown : (e.shiftKey === true);
      const altKey = e.key === "Alt" ? isDown : (e.altKey === true);
      this._lastDragCoords = {
        clientX: this._lastDragCoords.clientX,
        clientY: this._lastDragCoords.clientY,
        shiftKey,
        altKey
      };
      this._updateDropFeedback(this._lastDragCoords);
    };
    document.addEventListener("keydown", onModKey, { signal });
    document.addEventListener("keyup", onModKey, { signal });

    const onMouseUp = async (e) => {
      if (this._activeDragController === dragAc) this._activeDragController = null;
      dragAc.abort();

      if (isDragging) {
        document.body.classList.remove("dvp-dragging");
        this._removeDragGhost();
        this._lastDragCoords = null;

        if (this.draggedActor) {
          await this._dropActorOnCanvas(e, this.draggedActor);
        }
        this.draggedActor = null;
      }
      this._removeDropPreview();
    };

    document.addEventListener("mousemove", onMouseMove, { signal });
    document.addEventListener("mouseup", onMouseUp, { signal });
  }

  _createDragGhost(event, data) {
    this.dragGhost = document.createElement("div");
    this.dragGhost.classList.add("dvp-drag-ghost");
    // Keep the cursor centered over the ghost instead of anchored at its bottom-right corner.
    this.dragGhost.style.transform = "translate(-50%, -50%)";
    this.dragGhost.style.pointerEvents = "none";

    const img = document.createElement("img");
    // `data.idleImage` does not exist (see `_collectUsers` in the panel) — previously
    // the ghost rendered a broken `"/undefined"` image. Use the portrait's `defaultImage`.
    img.src = data.defaultImage;
    img.addEventListener("error", () => {
      if (!img.dataset.fallbackApplied) {
        img.dataset.fallbackApplied = "true";
        img.src = FALLBACK_IMAGE;
      }
    }, { once: true });

    // Scale the ghost image to match the token's grid footprint (accounting for system size scale, e.g. 0.8 for Small in dnd5e).
    try {
      const gridSize = canvas.grid?.size || 100;
      const sysScale = systemTokenScale(data.character?.prototypeToken, data.character);
      const w = (data.character?.prototypeToken?.width ?? 1) * gridSize * sysScale;
      const h = (data.character?.prototypeToken?.height ?? 1) * gridSize * sysScale;
      const px = Math.max(48, Math.min(Math.max(w, h), 220));
      img.style.height = `${px}px`;
      img.style.width = "auto";
    } catch (e) { /* no grid available — keep natural image dimensions */ }

    this.dragGhost.appendChild(img);
    this.dragGhost.style.left = `${event.clientX}px`;
    this.dragGhost.style.top = `${event.clientY}px`;

    document.body.appendChild(this.dragGhost);
  }

  _removeDragGhost() {
    this.dragGhost?.remove();
    this.dragGhost = null;
    // The canvas bounding rect is cached for the duration of a drag: without caching,
    // every `mousemove`/`dragover` called `getBoundingClientRect` IMMEDIATELY after
    // writing the ghost's `left`/`top` — forcing a synchronous layout reflow per event.
    this._dragCanvasRect = null;
  }

  /* ── Live PIXI Token Preview During Drag ────────────────────────────── */
  // Full-size token (or dynamic ring + subject) — footprint * texture scale,
  // snapped to the grid. Holding SHIFT switches to unsnapped free placement.

  /**
   * Build the live canvas drag preview. Ring and body are constructed via the SHARED
   * `./token-ring.mjs` module (matching real tokens and finisher clones).
   * Built from `getTokenDocument` on the actor document ITSELF (compendium or world):
   * a compendium document retains its `pack` reference so wildcard image sets resolve
   * properly, and artwork is accurate because the source pack is identified in `_onNativeDragStart`.
   */
  async _ensureDropPreview(character) {
    if (this._dropPreviewCtx || !canvas.ready || !character) return;
    let tokenData;
    try {
      // Resolve via the compendium/world document ITSELF: compendium actors carry `pack`,
      // allowing `getTokenImages` to locate wildcard sets (whereas a pack-less world stub
      // threw an error and prevented the preview from building at all).
      //
      // IMPORTANT: invoke the ORIGINAL `getTokenDocument`, bypassing our patch.
      // Calling the patched method would consume `_pendingWildcard` and lock the preview
      // onto a single variant forever. Calling the original re-rolls on EVERY drag —
      // preserving randomization while pinning the rolled variant below for the drop.
      const orig = this._origGetTokenDocument;
      tokenData = orig ? await orig.call(character) : await character.getTokenDocument();
      // For compendium documents, `tokenData.actor` is `null` (not in `game.actors`):
      // attach the source actor so system size scaling (dnd5e Small = 0.8) and ring
      // flags/effects (Multiple Rings) resolve accurately.
      if (tokenData && typeof tokenData === "object") (tokenData as any)._ssActor = character;
      // Hero in a Box (`cs-hero-box`) integration: for actors in `random` mode,
      // portrait/token/ring/scale/name are normally rolled only in `preCreateToken`.
      // Roll them upfront for the preview via Hero in a Box's original service and
      // store the snapshot in `_pendingHeroBox` so the drop places the exact same variant.
      this._rollHeroBoxForPreview(character, tokenData);
      if (character?.prototypeToken?.randomImg && tokenData.texture?.src) {
        this._pendingWildcard.set(character.uuid, tokenData.texture.src);
        this._pendingWildcardName.set(character.name, tokenData.texture.src);
        this._scheduleWildcardExpiry();
      }
    } catch (e) {
      return;
    }

    // If the drag ended or switched to a different actor while awaiting `getTokenDocument()`,
    // bail out so we never leave an orphaned container in `canvas.primary`.
    const activeActor = this.draggedActor ?? this._nativeDragActor;
    if (!canvas.ready || activeActor !== character || this._dropPreviewCtx) return;

    const gridSize = canvas.grid.size;
    const w = (Number(tokenData.width) > 0 ? Number(tokenData.width) : 1) * gridSize;
    const h = (Number(tokenData.height) > 0 ? Number(tokenData.height) : 1) * gridSize;

    const container = new PIXI.Container();
    container.eventMode = "none";
    // Keep hidden until first positioned so it never flashes at `(0, 0)`.
    container.visible = false;

    // Follow world dynamic-ring behavior: disabled ONLY when `enabled === false` is explicit.
    const ringCfg = tokenData.ring ?? {};
    const ringEnabled = ringCfg.enabled !== false && !!CONFIG.Token?.ring?.spritesheet;

    // Core "grid" fit-mode adjustment via shared `ringFitSSA()` (`TokenRing` constants).
    const ringSSA = ringFitSSA();

    let body;
    if (ringEnabled) {
      body = buildRingBase(tokenData, w, h, ringSSA);
    } else {
      body = buildPlainBody(w, h, tokenData);
    }
    container.addChild(body);

    // Mount into `canvas.primary` — the group subject to the scene lighting pipeline
    // (just like real tokens via `PrimaryCanvasGroup.addToken`). Mounting in `canvas.controls`
    // placed the preview ABOVE lighting, making it look brighter than the placed token.
    // `autoRender = true` on the group keeps it updated every frame.
    //
    // Draw order inside `primary` is governed by `PrimaryCanvasGroup._compareObjects`:
    // `elevation -> sortLayer -> sort -> zIndex`. Token meshes carry `sortLayer = SORT_LAYERS.TOKENS` (700),
    // whereas a bare `PIXI.Container` defaults all sort fields to 0, burying it under every token.
    //
    // Copy `elevation` from the token document (matching the dropped token) so higher-elevation
    // objects legitimately occlude the preview while lower ones do not; maximize `sort`/`zIndex`
    // so the preview stays above same-elevation scene objects.
    const elevation = Number(tokenData.elevation);
    container.elevation = Number.isFinite(elevation) ? elevation : 0;
    container.sortLayer = foundry.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS?.TOKENS ?? 700;
    container.sort = Number.MAX_SAFE_INTEGER;
    container.zIndex = Number.MAX_SAFE_INTEGER;
    const litGroup = canvas.primary ?? canvas.controls;
    try {
      litGroup.addChild(container);
    } catch (e) {
      container.destroy({ children: true });
      return;
    }

    const ctx = { tokenData, w, h, container, sprite: body._mainSprite ?? null, body, subjectTexture: null };
    this._dropPreviewCtx = ctx;

    // Position immediately at the latest cursor coordinates (in case the pointer is
    // already stationary over the canvas while `await getTokenDocument()` resolved).
    if (this._lastDragCoords) {
      this._syncPreviewWithLastCoords();
    }

    if (!ringEnabled) {
      // Standard non-ring token: load its texture and apply fit/scale/mirror/tint/anchor.
      const src = resolveTokenImage(tokenData, character);
      if (src) {
        let tex = null;
        try {
          const loader = foundry.canvas?.loadTexture ?? foundry.utils?.loadTexture;
          tex = loader ? await loader(src) : PIXI.Texture.from(src);
        } catch (e) { /* leave fallback outline only */ }
        if (this._dropPreviewCtx === ctx && !ctx.container.destroyed && tex) {
          ctx.body?._applySubjectTexture?.(tex);
        }
      }
      return;
    }

    // Ring subject: `ring.subject.texture` -> token image. If the subject texture is
    // broken or missing, fall back to the token image so the subject never stays blank.
    // Store the texture on `ctx` so it can be re-applied when upgrading the vector placeholder.
    const subjectSrc = ringCfg.subject?.texture || null;
    const tokenImg = resolveTokenImage(tokenData, character);
    const loaderFn = foundry.canvas?.loadTexture ?? foundry.utils?.loadTexture;
    const tryLoad = async (src) => {
      if (!src) return null;
      try {
        return loaderFn ? await loaderFn(src) : PIXI.Texture.from(src);
      } catch (e) {
        return null;
      }
    };
    let tex = await tryLoad(subjectSrc);
    if (!tex && subjectSrc !== tokenImg) {
      tex = await tryLoad(tokenImg);
    }
    if (this._dropPreviewCtx === ctx && !ctx.container.destroyed) {
      ctx.subjectTexture = tex;
      ctx.body?._applySubjectTexture?.(tex);
    }

    // Upgrade to real ring artwork from the world/token spritesheet (`coreSteel`/`coreBronze`/...
    // including Multiple Rings packs registered via `CONFIG.Token.ring.addConfig`) using the
    // shared `buildRingFromFrames` builder (identical to finisher clones).
    const sheetUrl = resolveRingSheetUrl(tokenData);
    if (sheetUrl) {
      const sizeCells = Math.min(Number(tokenData.width) || 1, Number(tokenData.height) || 1);
      const frames = await loadRingFrames(sheetUrl, sizeCells);
      if (this._dropPreviewCtx !== ctx || ctx.container.destroyed) return;
      if (frames) {
        const upgraded = buildRingFromFrames(tokenData, w, h, frames, ringSSA);
        if (upgraded) {
          const idx = container.children.indexOf(body);
          container.addChildAt(upgraded, Math.max(0, idx));
          const oldBody = ctx.body;
          ctx.body = upgraded;
          oldBody.destroy({ children: true });
          // Transfer the already-loaded subject texture onto the upgraded ring body.
          if (ctx.subjectTexture) upgraded._applySubjectTexture(ctx.subjectTexture);
        }
      }
    }
  }

  _positionDropPreview(e, canvasRect) {
    const ctx = this._dropPreviewCtx;
    if (!ctx || ctx.container.destroyed) return;

    let x, y;
    if (canvas.canvasCoordinatesFromClient) {
      const pos = canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY });
      x = pos.x;
      y = pos.y;
    } else {
      const transform = canvas.stage.transform.worldTransform;
      x = (e.clientX - canvasRect.left - transform.tx) / canvas.stage.scale.x;
      y = (e.clientY - canvasRect.top - transform.ty) / canvas.stage.scale.y;
    }

    let sx = x - ctx.w / 2;
    let sy = y - ctx.h / 2;

    // Hold SHIFT for unsnapped free placement. Otherwise use the EXACT same native
    // calculation as sidebar drops (`Token._getDropActorPosition`): token center under
    // cursor + grid snap, ensuring pixel-perfect alignment between preview and drop on any grid.
    const freePlace = e.shiftKey === true;
    const TokenCls = CONFIG.Token?.objectClass;
    if (!freePlace && TokenCls?._getDropActorPosition) {
      const pos = TokenCls._getDropActorPosition(ctx.tokenData, { x, y }, { snap: true });
      sx = pos.x;
      sy = pos.y;
    } else if (!freePlace && typeof ctx.tokenData.getSnappedPosition === "function") {
      const snapped = ctx.tokenData.getSnappedPosition({ x: sx, y: sy });
      sx = snapped.x;
      sy = snapped.y;
    }

    const baseAlpha = Number.isFinite(Number(ctx.tokenData?.alpha)) ? Number(ctx.tokenData.alpha) : 1;
    ctx.container.alpha = e.altKey === true ? baseAlpha * 0.5 : baseAlpha;
    ctx.container.position.set(sx + ctx.w / 2, sy + ctx.h / 2);
    ctx.container.visible = true;
    this._lastSnapped = { x: sx, y: sy, snapped: !freePlace };
  }

  _syncPreviewWithLastCoords() {
    const e = this._lastDragCoords;
    if (!e || !canvas.ready) return;
    const canvasEl = canvas.app?.canvas ?? canvas.app?.view;
    if (!canvasEl) return;
    const r = (this._dragCanvasRect ??= canvasEl.getBoundingClientRect());
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) {
      if (this.dragGhost) this.dragGhost.style.opacity = "0";
      this._positionDropPreview(e, r);
    } else {
      if (this.dragGhost) this.dragGhost.style.opacity = "";
      const ctx = this._dropPreviewCtx;
      if (ctx?.container) ctx.container.visible = false;
      this._lastSnapped = null;
    }
  }

  _updateDropFeedback(e, actor = this.draggedActor) {
    if (!canvas.ready || !actor) return;

    if (!this._dropPreviewCtx && !this._dropPreviewStarting) {
      this._dropPreviewStarting = true;
      // Store the promise for our `getTokenDocument` patch: a fast drop awaits this
      // promise before reading `_pendingWildcard` (see `_installWildcardSync`).
      const p = this._ensureDropPreview(actor)
        .finally(() => {
          this._dropPreviewStarting = false;
          if (this._dropPreviewPromise === p) this._dropPreviewPromise = null;
        });
      this._dropPreviewPromise = p;
    }

    const canvasEl = canvas.app.canvas ?? canvas.app.view;
    // Window size does not change mid-drag — read the bounding rect ONCE
    // (cache is invalidated in `_removeDragGhost` and `_removeDropPreview`).
    const r = (this._dragCanvasRect ??= canvasEl.getBoundingClientRect());
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom;

    if (inside) {
      // Over the canvas — show full-size PIXI preview and hide the mini cursor ghost.
      if (this.dragGhost) this.dragGhost.style.opacity = "0";
      this._positionDropPreview(e, r);
    } else {
      if (this.dragGhost) this.dragGhost.style.opacity = "";
      const ctx = this._dropPreviewCtx;
      if (ctx?.container) ctx.container.visible = false;
      this._lastSnapped = null;
    }
  }

  /* ── Path 2: Native HTML5 drags (Actor Directory / Compendium -> Canvas) ─ */
  // During `dragover`, `dataTransfer` contents are browser-protected (readable only on `drop`),
  // so we resolve the actor on `dragstart` from the directory DOM element and hold it until
  // `dragend`. We render the preview; token creation remains 100% native.

  _onNativeDragStart(e) {
    // A draggable actor entry carries only `data-entry-id`; the pack name is NOT set on it.
    // Resolve the actual pack from a directory ANCESTOR: compendium folders carry
    // `data-uuid="Compendium.<pack>.Folder.<id>"`, while directory lists carry
    // `data-pack` / `data-collection`. Parse the pack name from `uuid` or read it from an ancestor.
    let li = null;
    const liSel = "[data-document-id],[data-entry-id],[data-actor-id],[data-uuid]";
    const sample = e.target?.closest?.(liSel);
    if (sample) li = sample;
    else {
      // Sometimes the closest match is a folder rather than a document entry: query `[data-entry-id]` directly.
      li = e.target?.closest?.("[data-entry-id],[data-document-id],[data-actor-id]") ?? null;
    }
    const id = li?.dataset?.documentId || li?.dataset?.entryId || li?.dataset?.actorId;
    const uuid = li?.dataset?.uuid || null;

    // If the element carries an explicit UUID for a non-Actor document (e.g. `Item.xxx`
    // or `Compendium.<pkg>.<pack>.Item.<id>`), bail out immediately without touching
    // the native drag's `setDragImage`.
    if (uuid) {
      if (uuid.startsWith("Actor.")) {
        // World actor: `Actor.<id>` — handled below
      } else if (uuid.startsWith("Compendium.")) {
        const parts = uuid.split(".");
        // `Compendium.<pkg>.<pack>.<DocType>.<id>` or `Compendium.<pkg>.<pack>.<id>`
        const packKey = parts.length >= 3 ? `${parts[1]}.${parts[2]}` : null;
        const explicitType = parts.length >= 5 ? parts[3] : null;
        if (explicitType && explicitType !== "Actor") return;
        const pack = packKey ? game.packs?.get?.(packKey) : null;
        if (pack && pack.documentName !== "Actor") return;
      } else {
        return;
      }
    }

    // Walk ancestors (compendium folders / lists / application wrappers) to find the pack collection ID.
    const packOf = (el) => {
      let n = el;
      while (n) {
        const ds = n.dataset ?? {};
        if (ds.collection) return ds.collection;
        if (ds.pack) return ds.pack;
        if (ds.uuid && ds.uuid.startsWith("Compendium.")) {
          const m = /^Compendium\.([^.]+)\.([^.]+)\./.exec(ds.uuid);
          if (m) return `${m[1]}.${m[2]}`;
        }
        // A Compendium application element has `id="compendium-<pack>"`
        // (`collection.replaceAll(".", "_")`). Works even outside folders because
        // the pack name is encoded directly in the application's DOM `id`.
        if (typeof n.id === "string" && n.id.startsWith("compendium-")) {
          const m = /^compendium-([^.]+)__([^.]+)$/.exec(n.id);
          if (m) return `${m[1]}.${m[2]}`;
        }
        n = n.parentElement;
      }
      return null;
    };
    const packCollection = packOf(sample ?? li ?? e.target) || null;
    // If an ancestor points to a non-Actor compendium pack (Items, Spells, Journals,
    // RollTables, etc.), do not intercept the drag.
    if (packCollection) {
      const explicitPack = game.packs?.get?.(packCollection);
      if (explicitPack && explicitPack.documentName !== "Actor") return;
    }

    const suppressGhost = () => {
      this._suppressNativeDragImage = true;
      setTimeout(() => { this._suppressNativeDragImage = false; }, 0);
    };

    // 1. World actor: dragged from the Actor Directory (or Fameosity, which tags its
    // nav items with `data-actor-id` specifically for our preview).
    let actor = (!packCollection && id) ? (game.actors.get(id) ?? null) : null;
    if (actor) {
      this._nativeDragUUID = null;
      if (!actor.isOwner) {
        this._nativeDragActor = null;
        return;
      }
      this._nativeDragActor = actor;
      suppressGhost();
      // Set an invisible `setDragImage` directly: some drag sources (Fameosity) do not
      // go through `DragDrop.createDragImage` and instead set their own portrait via
      // `setDragImage` later in the target phase. Our capture listener runs earlier,
      // ensuring no browser DOM snapshot appears under the cursor (Showstopper-aware
      // sources skip their own `setDragImage`).
      if (e.dataTransfer) {
        try { e.dataTransfer.setDragImage(this._ensureDragImageEl(), 0, 0); } catch (err) { /* ignore */ }
      }
      return;
    }

    // 2. Compendium actor. Prefer an EXPLICIT `pack` (the exact pack being dragged from),
    // falling back to an ID scan only when absent. Scanning by ID alone matched the FIRST
    // pack containing that ID, so creatures present in both `dnd5e` and `ag-fifthpendium`
    // previewed `dnd5e` artwork instead of the dragged pack's artwork.
    //
    // Compendium Browser / Library search results (Foundry v14) carry a full compendium UUID
    // (`"Compendium.<package>.<pack>.<id>"`) — accept both UUID forms.
    let cuuid = (uuid && /^(Actor|Compendium)\./.test(uuid)) ? uuid : null;
    if (!cuuid && id) {
      let pack = packCollection ? game.packs.get(packCollection) : null;
      if (!pack && !packCollection) {
        // Do not scan Actor packs when dragging from a non-Actor sidebar tab (Items/Journal/RollTables/Macros).
        const nonActorTab = e.target?.closest?.("#items, #journal, #tables, #macros, #cards, #playlists");
        if (!nonActorTab) {
          pack = game.packs.find(p => p.documentName === "Actor" && p.index.has(id));
        }
      }
      if (pack && pack.documentName === "Actor" && pack.index.has(id)) {
        cuuid = pack.getUuid(id);
      }
    }
    if (!cuuid) {
      this._nativeDragActor = null;
      this._nativeDragUUID = null;
      this._suppressNativeDragImage = false;
      return;
    }

    // Load the actor from the pack asynchronously (without importing — native `_onDropActorData`
    // imports on drop). Once loaded, if the cursor is already over the canvas, show the
    // preview immediately at `_lastDragCoords`.
    this._nativeDragUUID = cuuid;
    this._nativeDragActor = null;
    try {
      foundry.utils.fromUuid(cuuid).then(doc => {
        if (doc?.documentName === "Actor" && this._nativeDragUUID === cuuid && doc.isOwner) {
          this._nativeDragActor = doc;
          if (this._lastDragCoords) {
            this._updateDropFeedback(this._lastDragCoords, doc);
          }
        }
      }).catch(() => {});
    } catch (err) {
      console.warn(`${MODULE_ID} | compendium actor load failed for ${cuuid}:`, err);
    }

    // Compendium directories do not call `setDragImage` themselves, causing the browser
    // to attach a raw DOM element snapshot to the cursor. Set an invisible drag image
    // ourselves: our capture listener runs before core handlers and nothing overwrites it.
    suppressGhost();
    if (e.dataTransfer) {
      try { e.dataTransfer.setDragImage(this._ensureDragImageEl(), 0, 0); } catch (err) { /* ignore */ }
    }
  }

  /**
   * Patch static `DragDrop.createDragImage`: while `_suppressNativeDragImage` is set,
   * return an offscreen 1x1 invisible element so core's `setDragImage` becomes a no-op.
   * Works across ALL core drags that go through this factory.
   */
  _patchDragImageFactory() {
    if (this._dragImagePatched) return;
    const impl = foundry.applications?.ux?.DragDrop?.implementation;
    if (typeof impl?.createDragImage !== "function") return;
    this._dragImagePatched = true;
    this._origCreateDragImage = impl.createDragImage;
    impl.createDragImage = (...args) => {
      if (this._suppressNativeDragImage) return this._ensureDragImageEl();
      return this._origCreateDragImage.apply(impl, args);
    };
  }

  _unpatchDragImageFactory() {
    if (!this._dragImagePatched) return;
    const impl = foundry.applications?.ux?.DragDrop?.implementation;
    if (impl && this._origCreateDragImage) impl.createDragImage = this._origCreateDragImage;
    this._dragImagePatched = false;
    this._origCreateDragImage = null;
  }

  /**
   * Synchronize wildcard token artwork between preview and drop placement.
   *
   * For actors with `prototypeToken.randomImg = true`, core's `getTokenDocument`
   * randomly rolls a variant on EVERY call. Without synchronization, the preview rolled
   * variant A while `_onDropActorData` called `getTokenDocument` again and rolled variant B.
   * To guarantee "what is previewed == what gets placed", the preview pins the rolled
   * path in `_pendingWildcard` and our `getTokenDocument` patch injects it on token creation
   * without re-rolling. Keyed by `uuid`, with an actor-name fallback because importing a
   * compendium actor assigns a new world `uuid`.
   */
  _installWildcardSync() {
    if (this._wildcardPatched) return;
    const ActorCls = CONFIG.Actor?.documentClass;
    if (typeof ActorCls?.prototype?.getTokenDocument !== "function") return;
    this._wildcardPatched = true;
    this._origGetTokenDocument = ActorCls.prototype.getTokenDocument;
    const self = this;
    ActorCls.prototype.getTokenDocument = async function (data: any = {}, options = {}) {
      const isHeroBoxRandom = this?.flags?.["cs-hero-box"]?.tokenCriteria?.mode === "random";
      if (this instanceof ActorCls && ((this.prototypeToken?.randomImg && !data.texture?.src) || isHeroBoxRandom)) {
        // Fast drop: the drop handler can reach `getTokenDocument` BEFORE the async preview
        // finishes recording its rolled variant. Await the preview promise (with a timeout
        // so a stalled preview can never block token placement).
        if (self._dropPreviewPromise) {
          await Promise.race([
            self._dropPreviewPromise.catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 1500))
          ]);
        }
        if (this.prototypeToken?.randomImg && !data.texture?.src) {
          const forced = self._consumeWildcard(this);
          if (forced) data = { ...data, texture: { ...(data.texture ?? {}), src: forced } };
        }
      }
      return self._origGetTokenDocument.call(this, data, options);
    };
  }

  _uninstallWildcardSync() {
    if (!this._wildcardPatched) return;
    const ActorCls = CONFIG.Actor?.documentClass;
    if (ActorCls && this._origGetTokenDocument) {
      ActorCls.prototype.getTokenDocument = this._origGetTokenDocument;
    }
    this._wildcardPatched = false;
    this._origGetTokenDocument = null;
  }

  /**
   * Synchronize randomized tokens from Hero in a Box (`cs-hero-box`).
   *
   * In `cs-hero-box`, actors with `mode === "random"` store a `d20-highlight.svg` stub
   * and roll their actual artwork, scale, dynamic ring, and name inside
   * `actor.applyRandomTokenImage(token)` during `preCreateToken`.
   * Our preview invokes the original method ahead of time, and this wrapper injects
   * the recorded snapshot during `preCreateToken` so preview and placed token match.
   */
  _ensureHeroBoxSync() {
    if (this._heroBoxPatched && this._origApplyRandomTokenImage) {
      return this._origApplyRandomTokenImage;
    }
    const svc = game.modules?.get?.("cs-hero-box")?.api?.services?.actor;
    if (typeof svc?.applyRandomTokenImage !== "function") return null;
    this._heroBoxPatched = true;
    this._heroBoxSvc = svc;
    this._origApplyRandomTokenImage = svc.applyRandomTokenImage;
    const self = this;
    svc.applyRandomTokenImage = function (token) {
      const forced = self._consumeHeroBox(token);
      if (forced) {
        token.updateSource({
          name: forced.name,
          displayName: forced.displayName,
          texture: forced.texture
        });
        if (forced.ring) {
          token.updateSource({ ring: forced.ring });
        }
        if (!token.actorLink && forced.delta) {
          token.updateSource({ delta: forced.delta });
        }
        return true;
      }
      return self._origApplyRandomTokenImage.call(this, token);
    };
    return this._origApplyRandomTokenImage;
  }

  _uninstallHeroBoxSync() {
    if (!this._heroBoxPatched) return;
    if (this._heroBoxSvc && this._origApplyRandomTokenImage) {
      this._heroBoxSvc.applyRandomTokenImage = this._origApplyRandomTokenImage;
    }
    this._heroBoxPatched = false;
    this._heroBoxSvc = null;
    this._origApplyRandomTokenImage = null;
  }

  _rollHeroBoxForPreview(character, tokenData) {
    try {
      if (game.modules?.get?.("cs-hero-box")?.active !== true) return;
      const criteria = character?.flags?.["cs-hero-box"]?.tokenCriteria;
      if (!criteria || criteria.mode !== "random") return;
      const origFn = this._ensureHeroBoxSync();
      const svc = this._heroBoxSvc ?? game.modules?.get?.("cs-hero-box")?.api?.services?.actor;
      if (!origFn || !svc) return;

      // For a compendium actor, `game.actors.get(tokenData.actorId)` returns `undefined` —
      // temporarily stub `game.actors.get` to expose `character` for the duration of the call.
      const needStub = character.id && !game.actors?.has?.(character.id);
      const origGet = needStub ? game.actors?.get : null;
      let applied = false;
      try {
        if (needStub && origGet) {
          game.actors.get = function (id, ...rest) {
            if (id === character.id) return character;
            return origGet.call(this, id, ...rest);
          };
        }
        applied = origFn.call(svc, tokenData) === true;
      } finally {
        if (needStub && origGet) {
          game.actors.get = origGet;
        }
      }
      if (!applied) return;

      const snapshot = {
        name: tokenData.name,
        displayName: tokenData.displayName,
        texture: {
          src: tokenData.texture?.src,
          scaleX: tokenData.texture?.scaleX ?? 1,
          scaleY: tokenData.texture?.scaleY ?? 1
        },
        ring: tokenData.ring?.enabled
          ? {
              enabled: true,
              effects: tokenData.ring?.effects ?? 1,
              subject: {
                texture: tokenData.ring?.subject?.texture ?? tokenData.texture?.src,
                scale: tokenData.ring?.subject?.scale ?? tokenData.texture?.scaleX ?? 1
              }
            }
          : null,
        delta: !tokenData.actorLink && tokenData.delta
          ? {
              name: tokenData.delta.name ?? tokenData.name,
              img: tokenData.delta.img
            }
          : null
      };
      if (character.uuid) this._pendingHeroBox.set(character.uuid, snapshot);
      if (character.id) this._pendingHeroBox.set(character.id, snapshot);
      if (character.name) this._pendingHeroBoxName.set(character.name, snapshot);
      this._scheduleWildcardExpiry();
    } catch (e) {
      /* third-party module errors must never break the drag preview */
    }
  }

  _consumeHeroBox(token) {
    const actorDoc = token?.actor ?? (token?.actorId ? game.actors?.get?.(token.actorId) : null);
    const uuid = actorDoc?.uuid;
    if (uuid && this._pendingHeroBox.has(uuid)) {
      const v = this._pendingHeroBox.get(uuid);
      this._pendingHeroBox.delete(uuid);
      if (actorDoc?.id) this._pendingHeroBox.delete(actorDoc.id);
      if (actorDoc?.name) this._pendingHeroBoxName.delete(actorDoc.name);
      return v;
    }
    const id = token?.actorId ?? actorDoc?.id;
    if (id && this._pendingHeroBox.has(id)) {
      const v = this._pendingHeroBox.get(id);
      this._pendingHeroBox.delete(id);
      if (uuid) this._pendingHeroBox.delete(uuid);
      if (actorDoc?.name) this._pendingHeroBoxName.delete(actorDoc.name);
      return v;
    }
    const name = actorDoc?.name ?? token?.name;
    if (name && this._pendingHeroBoxName.has(name)) {
      const v = this._pendingHeroBoxName.get(name);
      this._pendingHeroBoxName.delete(name);
      return v;
    }
    return null;
  }

  _scheduleWildcardExpiry() {
    if (this._wildcardExpireTimer) clearTimeout(this._wildcardExpireTimer);
    this._wildcardExpireTimer = setTimeout(() => {
      this._wildcardExpireTimer = null;
      if (!this.draggedActor && !this._nativeDragActor && !this._nativeDragUUID) {
        this._pendingWildcard.clear();
        this._pendingWildcardName.clear();
        this._pendingHeroBox.clear();
        this._pendingHeroBoxName.clear();
      }
    }, 5000);
  }

  _consumeWildcard(actor) {
    const byUuid = this._pendingWildcard.get(actor.uuid);
    if (byUuid) {
      this._pendingWildcard.delete(actor.uuid);
      if (actor.name) this._pendingWildcardName.delete(actor.name);
      return byUuid;
    }
    const byName = this._pendingWildcardName.get(actor.name);
    if (byName) {
      this._pendingWildcardName.delete(actor.name);
      return byName;
    }
    return null;
  }

  /** Offscreen 1x1 invisible element passed to `setDragImage` (mounted on `document.body`). */
  _ensureDragImageEl() {
    if (!this._dragImageEl || !this._dragImageEl.isConnected) {
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;top:-1000px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(el);
      this._dragImageEl = el;
    }
    return this._dragImageEl;
  }

  _onNativeDragOver(e) {
    if (!this._nativeDragActor && !this._nativeDragUUID) return;
    this._lastDragCoords = {
      clientX: e.clientX,
      clientY: e.clientY,
      shiftKey: e.shiftKey === true,
      altKey: e.altKey === true
    };
    if (!this._nativeDragActor) return;
    this._updateDropFeedback(e, this._nativeDragActor);
  }

  _onNativeDragEnd() {
    this._nativeDragActor = null;
    this._nativeDragUUID = null;
    this._lastDragCoords = null;
    this._removeDropPreview();
  }

  _removeDropPreview() {
    const ctx = this._dropPreviewCtx;
    this._dropPreviewCtx = null;
    this._dropPreviewStarting = false;
    this._dragCanvasRect = null;
    this._lastSnapped = null;
    try {
      ctx?.container?.destroy({ children: true });
    } catch (e) { /* already destroyed with canvas */ }
    // Recolored ring textures live in the module-level LRU cache of `./token-ring.mjs`
    // (`RECOLOR_CACHE_MAX`) — there is no separate per-panel cache to clear.
  }

  async _dropActorOnCanvas(event, actor) {
    try {
      if (!canvas.ready || !event || !actor?.uuid) return;

      const canvasEl = canvas.app.canvas ?? canvas.app.view;
      const canvasRect = canvasEl.getBoundingClientRect();

      if (
        event.clientX < canvasRect.left ||
        event.clientX > canvasRect.right ||
        event.clientY < canvasRect.top ||
        event.clientY > canvasRect.bottom
      ) return;

      // 1-to-1 parity with native drops: dispatch a synthetic `DragEvent` carrying a real
      // `DataTransfer` onto the canvas element where core bound `Canvas.#onDrop`.
      // Core handles everything from there: `getDragEventData` reads the payload from
      // `dataTransfer`, coordinates come from `clientX/Y`, and `dropCanvasData` +
      // `TokenLayer._onDropActorData` execute (`TOKEN_CREATE`, compendium import,
      // `altKey` hidden placement, `shiftKey` unsnapped placement, sort) — identical to sidebar drags.
      const dt = new DataTransfer();
      dt.setData("text/plain", JSON.stringify({ type: "Actor", uuid: actor.uuid }));
      canvasEl.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        altKey: event.altKey === true,
        shiftKey: event.shiftKey === true,
        dataTransfer: dt
      }));
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to create token:`, err);
      ui.notifications.error(localize("showstopper.Notifications.TokenCreateFailed"));
    }
  }
}

export const dragPreview = new DragPreviewManager();

Hooks.once("ready", () => {
  dragPreview.init();
  registerAPI("dragPreview", dragPreview);
});

Hooks.on("canvasReady", () => {
  dragPreview.onCanvasReady();
});

Hooks.on("canvasTearDown", () => {
  dragPreview.onCanvasReady();
});
