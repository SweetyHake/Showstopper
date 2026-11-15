const MODULE_ID = 'showstopper';
const FLUSH_DELAY = 5000;
// Retry ceiling for a single pending write: an entry is removed ONLY after a
// successful setFlag, so a single failure (typically an unlinked token destroyed
// by a finisher within the debounce window) would otherwise spin in a 5-second
// retry loop until reload, retaining the deleted document and all its items.
const PENDING_MAX_TRIES = 5;
const LOG_SAVE_DELAY = 5000;

/**
 * Serialized async repository for RollStats persistence.
 *
 * All writes to settings and actor/item flags are funneled through a
 * single promise chain (`enqueue`), so concurrent flush operations never
 * interleave. Pending flag writes are coalesced (per actor/item) and
 * flushed on a debounce timer or on demand (`flushAll`).
 */
export class StatsRepository {
  #chain = Promise.resolve();
  #logTimer = null;
  #latestLog = [];
  #flushTimer = null;
  #flushPromise = null;

  #pendingActorData = new Map(); // actor.uuid -> { actor, session, lifetime }
  #pendingItems = new Map();     // item.uuid -> { item, usage }
  #pendingWeapons = new Map();   // `${actor.uuid}:${baseItem}` -> { actor, baseItem, usage }

  enqueue(fn) {
    const next = this.#chain.then(fn);
    this.#chain = next.catch(() => {});
    return next;
  }

  // ── settings ─────────────────────────────────────

  async getSettings() {
    try {
      return game.settings.get(MODULE_ID, 'stats') ?? {};
    } catch {
      return {};
    }
  }

  async getLog() {
    try {
      const saved = game.settings.get(MODULE_ID, 'statsLog');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  saveSettings(store) {
    return this.enqueue(async () => {
      if (!game.user?.isGM) return;
      try {
        await game.settings.set(MODULE_ID, 'stats', store);
      } catch (e) {
        console.error(`${MODULE_ID} | Stats save failed:`, e);
      }
    });
  }

  setLog(entries, force = false) {
    this.#latestLog = entries;
    if (force) {
      if (this.#logTimer) {
        clearTimeout(this.#logTimer);
        this.#logTimer = null;
      }
      this.#writeLog();
      return;
    }
    if (this.#logTimer) return;
    this.#logTimer = setTimeout(() => {
      this.#logTimer = null;
      this.#writeLog();
    }, LOG_SAVE_DELAY);
  }

  #writeLog() {
    this.enqueue(async () => {
      if (!game.user?.isGM) return;
      try {
        await game.settings.set(MODULE_ID, 'statsLog', this.#latestLog);
      } catch (e) {
        // ignore
      }
    });
  }

  // ── pending actor data ───────────────────────────

  pendingActorIds() {
    return [...this.#pendingActorData.keys()];
  }

  getPendingActorData(actorId) {
    return this.#pendingActorData.get(actorId) ?? null;
  }

  queueActorData(actor, session, lifetime) {
    // Keyed by uuid: "Actor.*" for linked actors, "Scene.*.Token.*" for unlinked
    // tokens (where actor.id is shared across every token of the base actor).
    this.#pendingActorData.set(actor.uuid, { actor, session, lifetime, rev: 0 });
    this.#scheduleFlush();
  }

  /**
   * Mark a pending actor entry as mutated (session/lifetime objects are mutated
   * in place by reference). Any entry mutated while a network flush is in flight
   * is NOT deleted on completion and will be rewritten in full on the next flush,
   * preventing lost deltas.
   */
  touchActorData(actorId) {
    const e = this.#pendingActorData.get(actorId);
    if (e) e.rev = (e.rev ?? 0) + 1;
  }

  async #flushActorData() {
    // Snapshot references + revisions WITHOUT removing entries from pending:
    // while the network write is in flight, incoming events continue coalescing
    // into the same object by reference and bumping rev. Only unchanged entries
    // are deleted on success; mutated ones are rewritten in full on the next flush.
    const snapshot = [];
    for (const [id, e] of this.#pendingActorData) {
      snapshot.push({ id, e, rev: e.rev ?? 0 });
    }
    if (!snapshot.length) return;
    await this.enqueue(async () => {
      for (const { id, e, rev } of snapshot) {
        try {
          await e.actor.setFlag(MODULE_ID, 'statTracker', { session: e.session, lifetime: e.lifetime });
          const cur = this.#pendingActorData.get(id);
          if (cur === e && (cur.rev ?? 0) === rev) this.#pendingActorData.delete(id);
        } catch (err) {
          // continue rather than return: only ONE entry is hopeless — remaining
          // batch entries must still flush now instead of waiting for the next debounce
          if (this.#dropIfHopeless(this.#pendingActorData, id, e, err)) continue;
          console.error('showstopper | setFlag error', err);
        }
      }
    });
  }

  // ── pending item usage ───────────────────────────

  getPendingItem(uuid) {
    return this.#pendingItems.get(uuid) ?? null;
  }

  queueItemUsage(item, usage) {
    this.#pendingItems.set(item.uuid, { item, usage, rev: 0 });
    this.#scheduleFlush();
  }

  /** See touchActorData — equivalent revision bump for pending item entries. */
  touchItem(uuid) {
    const e = this.#pendingItems.get(uuid);
    if (e) e.rev = (e.rev ?? 0) + 1;
  }

  async #flushItems() {
    // Revision guard: see #flushActorData.
    const snapshot = [];
    for (const [uuid, e] of this.#pendingItems) {
      snapshot.push({ uuid, e, rev: e.rev ?? 0 });
    }
    if (!snapshot.length) return;
    await this.enqueue(async () => {
      for (const { uuid, e, rev } of snapshot) {
        try {
          await e.item.setFlag(MODULE_ID, 'statTracker.usage', e.usage);
          const cur = this.#pendingItems.get(uuid);
          if (cur === e && (cur.rev ?? 0) === rev) this.#pendingItems.delete(uuid);
        } catch (err) {
          // continue rather than return: see #flushActorData
          if (this.#dropIfHopeless(this.#pendingItems, uuid, e, err)) continue;
          console.error('showstopper | setFlag error', err);
        }
      }
    });
  }

  // ── pending actor weapon types ───────────────────

  getPendingWeapon(key) {
    return this.#pendingWeapons.get(key) ?? null;
  }

  pendingWeaponsForActor(actorUuid) {
    const prefix = `${actorUuid}:`;
    const out = [];
    for (const [key, e] of this.#pendingWeapons) {
      if (key.startsWith(prefix) && e?.usage) {
        out.push({ baseItem: e.baseItem, usage: e.usage });
      }
    }
    return out;
  }

  /**
   * Weapon entries store DELTAS (merged into the persisted flag via +=), so
   * instead of a full overwrite like actor/items, the revision guard subtracts
   * the written portion on partial concurrent mutation; if setFlag fails, the
   * full delta stays pending for the next flush without data loss.
   */
  queueActorWeapon(actor, baseItem, usage) {
    this.#pendingWeapons.set(`${actor.uuid}:${baseItem}`, { actor, baseItem, usage, rev: 0 });
    this.#scheduleFlush();
  }

  /** See touchActorData — equivalent revision bump for pending weapon-type entries. */
  touchWeapon(key) {
    const e = this.#pendingWeapons.get(key);
    if (e) e.rev = (e.rev ?? 0) + 1;
  }

  async #flushWeapons() {
    // Revision guard: see #flushActorData. Unlike actor/items, weapon writes merge
    // a delta, so if mutated in flight we subtract the written portion from the
    // pending delta and leave the remainder for the next flush.
    const snapshot = [];
    for (const [key, e] of this.#pendingWeapons) {
      snapshot.push({
        key, e, rev: e.rev ?? 0,
        written: {
          total: e.usage.total || 0,
          crits: e.usage.crits || 0,
          fumbles: e.usage.fumbles || 0,
          damage: e.usage.damage || 0
        }
      });
    }
    if (!snapshot.length) return;

    await this.enqueue(async () => {
      for (const { key, e, rev, written } of snapshot) {
        try {
          // Deep clone: getFlag returns a live REFERENCE to the document's flag
          // object — mutating it before setFlag would survive a failed write
          // and double-count `written` on the next retry.
          const existing = foundry.utils.deepClone(e.actor.getFlag(MODULE_ID, 'statTracker.weapons')) || {};
          const cur = existing[e.baseItem] ?? (existing[e.baseItem] = { total: 0, crits: 0, fumbles: 0, damage: 0 });
          cur.total = Math.max(0, (cur.total || 0) + written.total);
          cur.crits = Math.max(0, (cur.crits || 0) + written.crits);
          cur.fumbles = Math.max(0, (cur.fumbles || 0) + written.fumbles);
          cur.damage = Math.max(0, (cur.damage || 0) + written.damage);
          await e.actor.setFlag(MODULE_ID, 'statTracker.weapons', existing);
          const curE = this.#pendingWeapons.get(key);
          if (curE === e) {
            if ((curE.rev ?? 0) === rev) {
              this.#pendingWeapons.delete(key);
            } else {
              curE.usage.total -= written.total;
              curE.usage.crits -= written.crits;
              curE.usage.fumbles -= written.fumbles;
              curE.usage.damage -= written.damage;
            }
          }
        } catch (err) {
          // continue rather than return: see #flushActorData
          if (this.#dropIfHopeless(this.#pendingWeapons, key, e, err)) continue;
          console.error('showstopper | setFlag error', err);
        }
      }
    });
  }

  /**
   * Drop a hopeless pending entry when its target document was destroyed or
   * consecutive setFlag failures reached PENDING_MAX_TRIES; otherwise it would
   * retry forever and retain deleted actor/item documents. Returns true if dropped.
   */
  #dropIfHopeless(map, key, entry, err) {
    entry.tries = (entry.tries ?? 0) + 1;
    const dead = entry.actor?.destroyed || entry.item?.destroyed;
    if (!dead && entry.tries < PENDING_MAX_TRIES) return false;
    if (map.get(key) === entry) map.delete(key);
    console.warn('showstopper | stat-tracker pending write dropped',
      dead ? '(document deleted)' : '(repeated setFlag failures)', err?.message ?? err);
    return true;
  }

  // ── flush ────────────────────────────────────────

  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flushAll();
    }, FLUSH_DELAY);
  }

  /** Schedule a debounced flush for callers which have updated pending data. */
  scheduleFlush() {
    this.#scheduleFlush();
  }

  /**
   * Immediately discard ALL accumulated pending entries (called by resetStats
   * after unset echoes settle): any event arriving between flush and unset
   * rehydrates a pending entry from the OLD flag, which the next debounced
   * flush would otherwise write back and resurrect cleared stats. Leave #chain
   * intact so already-enqueued operations remain serialized.
   */
  clearPending() {
    this.#pendingActorData.clear();
    this.#pendingItems.clear();
    this.#pendingWeapons.clear();
  }

  /**
   * Flush all pending writes, in order, and wait for completion.
   */
  async flushAll() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#flushPromise) return this.#flushPromise;

    this.#flushPromise = (async () => {
      await this.#flushItems();
      await this.#flushWeapons();
      await this.#flushActorData();
    })().finally(() => {
      this.#flushPromise = null;
      if (this.#pendingItems.size || this.#pendingWeapons.size || this.#pendingActorData.size) {
        this.#scheduleFlush();
      }
    });

    return this.#flushPromise;
  }
}
