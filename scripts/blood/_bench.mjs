// Dev-only particle hot-loop benchmark (outside Foundry, PIXI stubs).
// Measures per-tick CPU cost at full pool capacity (30,000 live particles) —
// the JS loop itself is the bottleneck; PIXI rendering is not measured.
// Run: node scripts/blood/_bench.mjs .
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------ stubs ------------------------------ */

class FakeObservable {
  constructor() {
    this.children = [];
    this.visible = true;
    this.x = 0; this.y = 0; this.rotation = 0; this.alpha = 1; this.tint = 0xffffff;
    this.anchor = { set() {} };
    this.scale = { set() {} };
  }
  addChild(...n) { this.children.push(...n); }
  destroy() {}
}

class FakeTexture {
  constructor(base, frame) { this.base = base; this.frame = frame; }
  static from() { return new FakeTexture(); }
}

// Full set of 2D context methods — tinted() and the atlas exercise all of them
function fakeCtx2d() {
  const grad = { addColorStop: () => {} };
  const s = () => {};
  return {
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: s, beginPath: s, arc: s, fill: s, stroke: s, rect: s, clip: s,
    moveTo: s, lineTo: s, closePath: s, quadraticCurveTo: s, bezierCurveTo: s,
    ellipse: s, drawImage: s,
    save: s, restore: s, translate: s, rotate: s, scale: s, setTransform: s, clearRect: s,
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: s
  };
}

globalThis.PIXI = {
  Texture: FakeTexture,
  Rectangle: class { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } },
  Container: FakeObservable,
  ParticleContainer: FakeObservable,
  Sprite: class extends FakeObservable {
    constructor(tex) { super(); this.texture = tex; }
  }
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx2d() }) };

const tickers = [];
globalThis.canvas = {
  ready: true,
  scene: { id: 's' },
  bounds: { x: -10000, y: -10000, width: 20000, height: 20000 }, // everything on-screen — worst case
  primary: new FakeObservable(),
  app: { ticker: { add: (fn) => tickers.push(fn), remove: (fn) => { const i = tickers.indexOf(fn); if (i >= 0) tickers.splice(i, 1); } } }
};
globalThis.game = { settings: { get: () => true }, socket: { emit() {} } };
globalThis.Hooks = { on() {}, once() {} };

/* ------------------------------- run ------------------------------- */

const root = pathToFileURL(path.resolve(process.argv[2] ?? '.')).href;
const P = await import(`${root}/scripts/blood/particles.mjs`);
P.initBloodParticles();

// Fill the pool to capacity (spawn uses a random count multiplier, so overshoot)
for (let i = 0; i < 300; i++) P.spawnBurstLocal({ x: i * 10, y: 0, seed: i + 1, count: 160, size: 100 });
const st = P.debugStats();
console.log(`активных частиц: ${st.active} / ${st.capacity}`);

// Warm-up (sprite allocation, JIT) — 10 frames @16ms; particles remain alive (lifetime >= 0.3 s)
for (let i = 0; i < 10; i++) for (const fn of [...tickers]) fn({ deltaMS: 16 });

// Frozen measurement: deltaMS=0 so nothing ages or dies and the pool stays
// full; measures pure loop cost (math + sprite property writes)
const N = 300;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) for (const fn of [...tickers]) fn({ deltaMS: 0 });
const t1 = process.hrtime.bigint();
const perFrame = Number(t1 - t0) / 1e6 / N;
console.log(`тик: ${perFrame.toFixed(3)} мс/кадр при ${st.active} живых частицах (${N} кадров)`);
console.log(`бюджет кадра 16.6 мс → ${(100 * perFrame / 16.6).toFixed(1)}% (рендер PIXI сверх этого)`);
console.log(`скорость: ~${Math.round(st.active / (perFrame / 1000) / 1000)}k обновлений частиц/сек`);
