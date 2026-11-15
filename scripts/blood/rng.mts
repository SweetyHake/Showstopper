/**
 * Deterministic PRNG — the foundation for identical blood across all clients.
 *
 * Any stain generation (droplet shapes, scatter, rotations) must go through
 * Rng with a seed stored in the stain record: the seed arrives over the socket
 * and in scene flags, so all clients render pixel-identical blood.
 * Math.random() is allowed ONLY when minting a new seed on the GM side.
 */

/** xmur3 string hash → uint32 (stable seeds for the atlas, etc.). */
export function hashStr(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: 32-bit integer arithmetic — identical across all JS engines. */
export class Rng {
  declare s;
  constructor(seed = 0) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /**
   * Re-seed WITHOUT allocation (renderer._drawStain calls this for every stain
   * of every bake — `new Rng` was a noticeable GC hotspot).
   * Returns `this` so it can be chained as an expression.
   */
  reset(seed = 0) {
    this.s = (seed >>> 0) || 0x9e3779b9;
    return this;
  }

  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) { return a + this.next() * (b - a); }

  /** Integer in 0..n-1. */
  int(n) { return Math.floor(this.next() * n); }

  pick(arr) { return arr[this.int(arr.length)]; }

  angle() { return this.next() * Math.PI * 2; }

  chance(p) { return this.next() < p; }

  sign() { return this.next() < 0.5 ? -1 : 1; }
}

/** Mint a new seed (the only place using Math.random). */
export function mintSeed() {
  return (Math.random() * 0x7fffffff) | 0;
}
