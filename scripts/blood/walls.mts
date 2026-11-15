/**
 * Wall profile revalidation (extracted verbatim from events.mjs): when a wall
 * moves or a door opens, profiles baked into nearby stains become stale and are
 * recomputed from their centers. Updating a stain = remove + add with the same id.
 */

import { bloodEnabled } from './vitals.mjs';
import { settingGet, wallProfile, WALL_RADIUS_K } from './util.mjs';

const WALL_REVALIDATE_BATCH = 50; // stains per tick during chunked wall revalidation

export class WallProfiles {
  declare getStore; declare _timer; declare _segs;
  /** @param {() => import('./stains.mjs').BloodStore} getStore */
  constructor(getStore) {
    this.getStore = getStore;
    this._timer = null;  // debounce timer for wall profile revalidation
    this._segs = null;   // wall segments accumulated over the debounce window
  }

  register() {
    const refresh = (wall) => {
      if (!game.user.isGM || !bloodEnabled() || !settingGet('bloodWallsBlock', true)) return;
      // walls can be edited in ANY loaded scene — revalidate only the active canvas scene.
      // NOTE: WallDocument has NO .scene getter (only TokenDocument has one) —
      // its owning scene lives on .parent
      if (wall.parent && wall.parent.id !== canvas.scene?.id) return;
      const c = wall?.c;
      if (!Array.isArray(c) || c.length < 4) return;
      const store = this.getStore();
      if (!store) return;
      // debounce window ACCUMULATES segments: multi-select/drag fires updateWall
      // per wall — we must revalidate ALL modified walls, not just the last one
      (this._segs ??= new Set()).add(c);
      clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        const segs = this._segs ?? new Set();
        this._segs = null;
        this._revalidateBatched([...segs]);
      }, 400);
    };
    Hooks.on('createWall', refresh);
    Hooks.on('updateWall', refresh);
    Hooks.on('deleteWall', refresh);
  }

  dispose() {
    clearTimeout(this._timer);
    this._timer = null;
    this._segs = null;
  }

  /**
   * Chunked wall revalidation: a single synchronous flush on a bloody scene used
   * to recompute HUNDREDS of move polygons at once (each a full sweep-polygon
   * pass taking ms on wall-heavy maps), causing a multi-hundred-ms freeze when
   * dragging one wall in a splattered room. Candidates are collected across all
   * segments in the window (deduplicated by id for stains near multiple walls),
   * then recomputed in batches of WALL_REVALIDATE_BATCH per setTimeout tick.
   */
  _revalidateBatched(segs) {
    const store = this.getStore();
    if (!store || !segs.length) return;
    const seen = new Set();
    const queue = [];
    for (const c of segs) {
      const cx = (c[0] + c[2]) / 2, cy = (c[1] + c[3]) / 2;
      const halfLen = Math.hypot(c[2] - c[0], c[3] - c[1]) / 2;
      for (const st of store.queryCircle(cx, cy, halfLen + 512)) {
        if (!st.w || seen.has(st.i)) continue;
        seen.add(st.i);
        queue.push(st);
      }
    }
    let at = 0;
    const step = () => {
      const ids = [];
      const reborn = [];
      for (let n = 0; n < WALL_REVALIDATE_BATCH && at < queue.length; n++, at++) {
        const st = queue[at];
        // canonical recomputation radius: WALL_RADIUS_K * s. Profiles baked at
        // generation time with a different radius migrate once to the canonical
        // value — subsequent recomputations remain stable with zero churn
        const nw = wallProfile({ x: st.x, y: st.y }, st.s * WALL_RADIUS_K, st.lvl ?? null) ?? undefined;
        if ((nw ?? '') === (st.w ?? '')) continue;
        // strip d/f/g: stain is ALREADY on screen, so re-adding must not replay
        // its appear animation (store.add feeds the live render stream)
        const { w, d, f, g, ...rest } = st;
        ids.push(st.i);
        reborn.push(nw ? { ...rest, w: nw } : rest);
      }
      if (ids.length) {
        store.remove(ids); // followed by add: same ids, all clients apply both ops
        store.add(reborn);
      }
      if (at < queue.length) this._timer = setTimeout(step, 0);
    };
    step();
  }
}
