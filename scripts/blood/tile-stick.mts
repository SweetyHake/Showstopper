/**
 * Blood sticking to tiles (extracted verbatim from events.mjs): blood that
 * lands on a tile carries `tid` — the surface tile document ID — and follows
 * its movement/rotation; deleting a tile moves its blood into a stash, and
 * native CTRL+Z undo of tile deletion (keepId) restores it along with the tile.
 */

import { bloodEnabled } from './vitals.mjs';
import { elevOf, wallProfile, WALL_RADIUS_K } from './util.mjs';

export class TileSticker {
  declare getStore; declare getRenderer; declare _timer; declare _oldPos; declare _moves; declare _stash;
  /** @param {() => import('./stains.mjs').BloodStore} getStore
   *  @param {() => import('./renderer.mjs').BloodRenderer} [getRenderer] */
  constructor(getStore, getRenderer = null) {
    this.getStore = getStore;
    this.getRenderer = getRenderer;
    this._timer = null;       // debounce timer for tile-bound blood updates
    this._oldPos = new Map(); // tileId → {x, y, e, r} initial pose BEFORE ANY edits in the window
    this._moves = new Map();  // tileId → {dx, dy, de, dr, cx, cy} deltas over the window (from initial)
    this._stash = new Map();  // tileId → stain records removed with a deleted tile (restored on CTRL+Z)
  }

  register() {
    const sameScene = (doc) => !doc.parent || doc.parent.id === canvas.scene?.id;
    Hooks.on('preUpdateTile', (doc, changes) => {
      if (!game.user.isGM || !bloodEnabled()) return;
      if (!sameScene(doc)) return;
      if (changes.x === undefined && changes.y === undefined
        && changes.elevation === undefined && changes.rotation === undefined) return;
      // initial position/rotation BEFORE ALL edits in the window: deltas accumulate from it,
      // otherwise a second move within the same debounce window overwrote the first —
      // leaving blood permanently offset by half the actual displacement
      if (!this._oldPos.has(doc.id)) {
        this._oldPos.set(doc.id, {
          x: doc.x, y: doc.y, e: elevOf(doc),
          r: Number(doc.shape?.rotation ?? doc.rotation) || 0
        });
      }
    });
    Hooks.on('updateTile', (doc, changes) => {
      if (!sameScene(doc)) return;
      // overlay layer is a child of the mesh: re-attaching/rebaking is only needed
      // when the mesh is recreated or changes frame (texture, dimensions, alpha).
      // Pure x/y/elevation/rotation are inherited from the mesh AUTOMATICALLY — nudging
      // here caused blood to detach for 400 ms and permanently on rotation
      const ch = changes ?? {};
      if (('texture' in ch) || ('width' in ch) || ('height' in ch) || ('alpha' in ch)) {
        try { this.getRenderer?.()?.touchOverlay?.(doc.id); } catch { /* noop */ }
      }
      if (!game.user.isGM || !bloodEnabled()) return;
      const old = this._oldPos.get(doc.id);
      if (!old) return; // position/angle/elevation unchanged (or foreign scene)
      const center = doc.shape?.center ?? doc.object?.center ?? doc;
      this._moves.set(doc.id, {
        dx: doc.x - old.x,
        dy: doc.y - old.y,
        de: elevOf(doc) - old.e,
        dr: (Number(doc.shape?.rotation ?? doc.rotation) || 0) - old.r, // degrees
        cx: center.x || 0,
        cy: center.y || 0
      });
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.flush(), 400);
    });
    Hooks.on('createTile', (doc) => {
      if (!game.user.isGM || !bloodEnabled()) return;
      if (!sameScene(doc)) return;
      // tile returned (native CTRL+Z delete-undo recreates it with the SAME id —
      // PlaceablesLayer._onUndoDelete, keepId: true): put stashed stains back
      const stashed = this._stash.get(doc.id);
      if (!stashed) return;
      this._stash.delete(doc.id);
      this.getStore()?.add(stashed);
    });
    Hooks.on('deleteTile', (doc) => {
      if (!game.user.isGM || !bloodEnabled()) return;
      if (!sameScene(doc)) return;
      this._oldPos.delete(doc.id);
      // immediately, without debounce: blood disappears WITH the tile (does not
      // fall down to the floor) and goes into the stash — native CTRL+Z delete-undo
      // restores the tile with the SAME id (keepId), and createTile pulls stains from stash
      this.dropTileBlood(doc.id);
    });
  }

  dispose() {
    clearTimeout(this._timer);
    this._timer = null;
    this._oldPos.clear();
    this._moves.clear();
    this._stash.clear();
  }

  /** Remove and stash blood attached to a tile (on tile deletion). */
  dropTileBlood(tileId) {
    const store = this.getStore();
    if (!store) return;
    const dying = store.stains.filter(st => st.tid === tileId);
    if (!dying.length) return;
    this._stash.set(tileId, dying);
    store.remove(dying.map(st => st.i));
  }

  flush() {
    const store = this.getStore();
    const moves = this._moves;
    this._moves = new Map();
    // initial poses for this window have been consumed: subsequent edits accumulate deltas afresh
    for (const id of moves.keys()) this._oldPos.delete(id);
    if (!moves.size) return;
    // blood was disabled inside the 400 ms timer window (teardown nulled the store):
    // accumulated deltas above are already cleared, and an O(N) pass over null must not run
    if (!store) return;

    // single O(N) pass: stains moving along with their tiles
    // (blood on deleted tiles was already removed immediately in deleteTile into the stash)
    const byTile = new Map();
    for (const st of store.stains) {
      if (st.tid === undefined) continue;
      if (!moves.has(st.tid)) continue;
      let arr = byTile.get(st.tid);
      if (!arr) { arr = []; byTile.set(st.tid, arr); }
      arr.push(st);
    }

    const r1 = (v) => Math.round(v * 10) / 10;
    const ids = [];
    const reborn = [];
    const mk = (st, patch) => {
      // strip d/f/g (stain is already on screen); recompute canonical w:
      // stain shifted relative to walls, so the old profile may be stale
      const { d, f, g, w, tid, ...rest } = st;
      const rec = { ...rest, ...patch };
      if (!rec.tid) delete rec.tid;
      const nw = wallProfile({ x: rec.x, y: rec.y }, rec.s * WALL_RADIUS_K, rec.lvl ?? null) ?? undefined;
      if (nw) rec.w = nw;
      ids.push(st.i);
      reborn.push(rec);
    };

    for (const [tileId, arr] of byTile) {
      const mv = moves.get(tileId);
      if (!mv.dx && !mv.dy && !mv.de && !mv.dr) continue;
      // tile rotation: stains rotate with the artwork around the NEW
      // center (rotation does not shift the center; translation is in dx/dy)
      const rad = (mv.dr || 0) * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      for (const st of arr) {
        let patch;
        if (mv.dr) {
          const px = st.x - mv.cx, py = st.y - mv.cy;
          patch = {
            x: r1(mv.cx + mv.dx + cos * px - sin * py),
            y: r1(mv.cy + mv.dy + sin * px + cos * py),
            e: r1((Number(st.e) || 0) + mv.de),
            r: Math.round(((Number(st.r) || 0) + rad) * 1000) / 1000,
            tid: tileId
          };
        } else {
          patch = {
            x: r1(st.x + mv.dx),
            y: r1(st.y + mv.dy),
            e: r1((Number(st.e) || 0) + mv.de),
            tid: tileId
          };
        }
        mk(st, patch);
      }
    }
    if (!ids.length) return;
    store.remove(ids); // followed by add: same ids, all clients apply both ops
    if (reborn.length) store.add(reborn);
  }
}
