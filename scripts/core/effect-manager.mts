/**
 * Unified lifecycle/cancellation layer for canvas effects.
 *
 * `CanvasEffect` gives an effect a deterministic lifecycle:
 *  - automatic disposal of tickers/listeners via disposers
 *  - a `done()` promise that resolves on both natural completion and cancellation
 *  - registration in the shared `canvasEffects` manager, which stops every
 *    effect on `canvasTearDown` (so nothing leaks across scene changes)
 *
 * Usage:
 *   const effect = new CanvasEffect('my-effect', {
 *     tokenId,                       // optional: allows stopForToken()
 *     onStop: () => { ... }          // runs only on cancellation
 *   });
 *   effect.addDisposer(() => canvas.app.ticker.remove(tick));
 *   canvas.app.ticker.add(tick);
 *   await effect.done();             // resolves when complete() or stop() runs
 *   effect.complete();               // natural finish (runs disposers)
 */

class CanvasEffectManager {
  #effects = new Set<any>();
  #byToken = new Map<any, any>();

  constructor() {
    // Hooks.on (not once): scene changes happen repeatedly during a session,
    // and every teardown must stop active effects.
    Hooks.on('canvasTearDown', () => this.stopAll());
  }

  register(effect) {
    this.#effects.add(effect);
    if (effect.tokenId) {
      if (!this.#byToken.has(effect.tokenId)) this.#byToken.set(effect.tokenId, new Set());
      this.#byToken.get(effect.tokenId).add(effect);
    }
  }

  unregister(effect) {
    this.#effects.delete(effect);
    if (effect.tokenId) {
      const set = this.#byToken.get(effect.tokenId);
      if (set) {
        set.delete(effect);
        if (set.size === 0) this.#byToken.delete(effect.tokenId);
      }
    }
  }

  stopAll() {
    for (const effect of [...this.#effects]) effect.stop();
  }

  stopForToken(tokenId) {
    const set = this.#byToken.get(tokenId);
    if (!set) return;
    for (const effect of [...set]) effect.stop();
  }

  get size() {
    return this.#effects.size;
  }
}

export const canvasEffects = new CanvasEffectManager();

let _seq = 0;

export class CanvasEffect {
  #id;
  #tokenId;
  #onStop;
  #disposers = new Set<any>();
  #resolveDone = null;
  #donePromise = null;
  #finished = false;
  #stopped = false;

  constructor(id, { tokenId = null, onStop = null } = {}) {
    this.#id = id || `canvas-effect-${++_seq}`;
    this.#tokenId = tokenId ?? null;
    this.#onStop = onStop ?? null;
    canvasEffects.register(this);
  }

  get id() {
    return this.#id;
  }

  get tokenId() {
    return this.#tokenId;
  }

  get stopped() {
    return this.#stopped;
  }

  /**
   * Register a cleanup callback. Runs exactly once, either on
   * natural completion (`complete()`) or cancellation (`stop()`).
   * Returns a function that removes the disposer.
   */
  addDisposer(fn) {
    this.#disposers.add(fn);
    return () => this.#disposers.delete(fn);
  }

  /**
   * Promise that resolves when the effect finishes (naturally or cancelled).
   */
  done() {
    // Single promise per instance: calling done() a second time previously created
    // a NEW promise and overwrote the resolver, hanging the first await forever.
    this.#donePromise ??= new Promise<void>(resolve => {
      this.#resolveDone = resolve;
      if (this.#finished) resolve();
    });
    return this.#donePromise;
  }

  /**
   * Awaitable timeout that short-circuits when the effect is stopped.
   */
  wait(ms) {
    return new Promise<void>(resolve => {
      if (this.#finished || this.#stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        removeDisposer();
        resolve();
      }, ms);
      const removeDisposer = this.addDisposer(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #cleanup() {
    if (this.#finished) return;
    this.#finished = true;
    for (const d of this.#disposers) {
      try {
        d();
      } catch (e) {
        console.error('showstopper | CanvasEffect disposer failed', e);
      }
    }
    this.#disposers.clear();
    if (this.#resolveDone) this.#resolveDone();
    canvasEffects.unregister(this);
  }

  /**
   * Mark the effect as naturally finished.
   */
  complete() {
    if (this.#finished || this.#stopped) return;
    this.#cleanup();
  }

  /**
   * Cancel the effect: runs disposers and the onStop callback,
   * then resolves `done()`.
   */
  stop() {
    if (this.#stopped || this.#finished) return;
    this.#stopped = true;
    try {
      this.#onStop?.();
    } catch (e) {
      console.error('showstopper | CanvasEffect onStop failed', e);
    }
    this.#cleanup();
  }
}
