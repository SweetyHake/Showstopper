// Dev-only hang stress repro: token walks back and forth across a blood trail.
// Full harness (store + spatial index + renderer + puffs + tickers), stain cap
// disabled, hundreds of moves. Any infinite loop will hang Node.
// Run: node scripts/blood/_stress.mjs .
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------ stubs (from _smoke) ------------------------------ */

function fakeCtx2d(log) {
  const grad = { addColorStop: () => {} };
  const s = () => {};
  return {
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: s, beginPath: s, arc: s, fill: s, stroke: s, rect: s, clip: s,
    moveTo: s, lineTo: s, closePath: s, quadraticCurveTo: s, bezierCurveTo: s,
    ellipse: s, drawImage: (...a) => log?.push?.(['di', a[0]]),
    save: s, restore: s, translate: s, rotate: s, scale: s, setTransform: s, clearRect: s,
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: s
  };
}

class FakeCanvas {
  constructor(w = 0, h = 0) { this.width = w; this.height = h; this._log = []; this.style = {}; }
  getContext() { if (!this._ctx) this._ctx = fakeCtx2d(this._log); this._ctx.canvas = this; return this._ctx; }
}

class FakeRect { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } }

class FakeTexture {
  constructor(a, b) { this.base = a; this.frame = b ?? new FakeRect(0, 0, 100, 100); this.width = 100; this.height = 100; }
  static from() { return new FakeTexture(); }
}

class FakeObservable {
  constructor() {
    this.children = [];
    this.alpha = 1; this.visible = true; this.rotation = 0; this.tint = 0xffffff;
    this.x = 0; this.y = 0; this.zIndex = 0; this.sort = 0; this.sortLayer = 0;
    this.anchor = { set() {} };
    this.scale = { set() {} };
    this.position = { set(x, y) { this.x = x; this.y = y; }, x: 0, y: 0 };
    this.eventMode = 'auto'; this.interactiveChildren = true; this.parent = null;
  }
  addChild(...n) { for (const c of n) { c.parent = this; this.children.push(c); } }
  removeFromParent() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  destroy() { this.removeFromParent(); }
  sortChildren() {}
}

globalThis.PIXI = {
  Texture: FakeTexture,
  Rectangle: FakeRect,
  Container: FakeObservable,
  ParticleContainer: class extends FakeObservable {},
  Sprite: class extends FakeObservable { constructor(t) { super(); this.texture = t ?? new FakeTexture(); } },
  Polygon: class { constructor(p) { this.points = p; } contains() { return true; } }
};
globalThis.document = { createElement: () => new FakeCanvas() };

const tickers = [];
globalThis.canvas = {
  ready: true,
  grid: { size: 100 },
  scene: { id: 's1' },
  bounds: { x: -1600, y: -1600, width: 3200, height: 3200 }, // typical GM scene viewport
  primary: new FakeObservable(),
  tokens: { placeables: [] },
  app: { ticker: {
    add: (fn) => tickers.push(fn),
    // addOnce must fire ONCE (like real PIXI), otherwise
    // stale flush callbacks accumulate in tickers on every pump
    addOnce: (fn) => {
      const wrapped = () => { const i = tickers.indexOf(wrapped); if (i >= 0) tickers.splice(i, 1); fn(); };
      tickers.push(wrapped);
    },
    remove: (fn) => { const i = tickers.indexOf(fn); if (i >= 0) tickers.splice(i, 1); }
  } }
};
globalThis.foundry = {
  utils: { getProperty: (o, p) => p.split('.').reduce((o, k) => o?.[k], o) },
  canvas: { groups: { PrimaryCanvasGroup: { SORT_LAYERS: { TILES: 1 } } } }
};

const settingsStore = new Map([
  ['bloodEnabled', true], ['bloodFootprints', true], ['bloodTrail', true], ['bloodParticles', true],
  ['bloodScale', 1], ['bloodViolence', 3]
]);
globalThis.game = {
  user: { isGM: true },
  system: { id: 'dnd5e' },
  i18n: { localize: (k) => k },
  settings: { get: (m, k) => settingsStore.get(k), set: (m, k, v) => settingsStore.set(k, v) },
  modules: { get: () => ({ active: false }) },
  scenes: { get: (id) => ({ id, flags: {}, setFlag: async () => {} }) },
  combat: null,
  socket: { emit() {}, on() {} }
};
globalThis.Hooks = { on() {}, once() {}, off() {} };
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

/* ------------------------------- run ------------------------------- */

const root = pathToFileURL(path.resolve(process.argv[2] ?? '.')).href;
const { BloodStore, STAIN } = await import(`${root}/scripts/blood/stains.mjs`);
const { BloodRenderer } = await import(`${root}/scripts/blood/renderer.mjs`);
const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
const P = await import(`${root}/scripts/blood/particles.mjs`);
P.initBloodParticles();

const store = new BloodStore(game.scenes.get('s1'));
const renderer = new BloodRenderer({ scale: 0.5 });
store.setRenderer(renderer);
const hooks = new BloodEventHooks(() => store);

const pump = () => { for (const fn of [...tickers]) fn({ deltaMS: 16 }); renderer.flush(); };

// 1. Large existing background: 1500 stains across the scene (months of brush/hit buildup)
const t0 = Date.now();
for (let i = 0; i < 1500; i++) {
  store.add([store.createStain({
    t: [0, 1, 2, 3, 4][i % 5], x: (i * 677) % 6000, y: (i * 367) % 4000,
    s: 60 + (i % 5) * 30, r: i * 0.3, a: 0.8, c: '#a51414d8'
  })], { broadcast: false });
}
pump();
console.log(`фон 1500 пятен: ${Date.now() - t0} мс, в стор: ${store.count}`);

// 2. Trail: strip of smears across the entire walking zone (blood trail)
for (let i = 0; i < 30; i++) {
  store.add([store.createStain({ t: STAIN.SMEAR, x: 500 + i * 50, y: 1000, s: 40, r: 0, a: 0.5, c: '#a51414d8' })], { broadcast: false });
}
pump();
console.log(`трейл 30 мазков: стор ${store.count}`);

// 3. Walking back and forth across the trail: 400 moves of 100px each
const doc = { id: 'hero', x: 500, y: 950, width: 1, height: 1 };
let dir = 1;
const t1 = Date.now();
let slowest = 0, slowestAt = 0;
for (let step = 0; step < 400; step++) {
  const bt = Date.now();
  const nx = doc.x + dir * 100;
  if (nx > 2100 || nx < 400) dir = -dir;
  const from = { x: doc.x, y: doc.y };
  const to = { x: doc.x + dir * 100, y: doc.y };
  hooks._trail.footprints({ ...doc, x: from.x }, to);          // preUpdateToken: doc is still at the old position
  hooks._trail.bleedingTrail({ ...doc, actor: { id: 'a1' }, object: { id: 'hero', center: { x: to.x + 50, y: to.y + 50 } }, width: 1, height: 1 }, to);
  doc.x = to.x; doc.y = to.y;
  pump();                                                 // every frame: tickers + flush
  const dt = Date.now() - bt;
  if (dt > slowest) { slowest = dt; slowestAt = step; }
  if (dt > 3000) { console.error(`ХАНГ: шаг ${step} занял ${dt} мс — воспроизведено`); process.exit(1); }
}
console.log(`400 ходок через трейл: ${Date.now() - t1} мс (медленнейший шаг ${slowest} мс на №${slowestAt})`);
console.log(`итог: пятен ${store.count}, частиц ${P.debugStats().active}, чанков ${renderer.chunks.size}`);

// 4. SNOW: dense field (lv=3 drifts + droplets) in the walking zone and 400 passes
// across it — the heaviest footprints path (snowLevelAt + drift trenches +
// underFoot checks + trample on every step). Timed separately: check here
// when investigating "walking on snow lags" reports.
await import(`${root}/scripts/blood/snow-bridge.mjs`);
await import(`${root}/plus/scripts/blood/snow.mjs`);
const SNOW_COLOR = '#eef3f7';
for (let i = 0; i < 600; i++) {
  const isDrift = i % 3 === 0;
  store.add([store.createStain({
    t: isDrift ? STAIN.SPLAT : STAIN.DROPLETS,
    x: 300 + (i * 733) % 2200, y: 1700 + (i * 457) % 700,
    s: isDrift ? 240 + (i % 4) * 60 : 50 + (i % 5) * 15,
    r: i * 0.7, a: 0.65 + (i % 3) * 0.1, c: SNOW_COLOR, m: 2,
    ...(isDrift ? { lv: 3 } : {})
  })], { broadcast: false });
}
pump();
console.log(`снег 600 пятен (200 сугробов lv=3): стор ${store.count}`);
const snowDoc = { id: 'snow-hero', x: 400, y: 1950, width: 1, height: 1 };
let sdir = 1;
const t3 = Date.now();
let slowestSnow = 0, slowestSnowAt = 0, snowFootMs = 0;
for (let step = 0; step < 400; step++) {
  const bt = Date.now();
  if (snowDoc.x > 2200 || snowDoc.x < 350) sdir = -sdir;
  const to = { x: snowDoc.x + sdir * 100, y: snowDoc.y };
  const ft = Date.now();
  hooks._trail.footprints({ ...snowDoc }, to);
  snowFootMs += Date.now() - ft;
  snowDoc.x = to.x;
  pump();
  const dt = Date.now() - bt;
  if (dt > slowestSnow) { slowestSnow = dt; slowestSnowAt = step; }
  if (dt > 3000) { console.error(`ХАНГ: снежный шаг ${step} занял ${dt} мс — воспроизведено`); process.exit(1); }
}
console.log(`400 ходок по снегу: ${Date.now() - t3} мс, из них footprints ${snowFootMs} мс (медленнейший шаг ${slowestSnow} мс на №${slowestSnowAt})`);

// 5. Final 120-frame drain: flush remaining render queues
// (walk footprints are minted without d/f/g — quantized fade is covered in _smoke.mjs, test 7)
const t2 = Date.now();
for (let f = 0; f < 120; f++) pump();
console.log(`120 кадров после: ${Date.now() - t2} мс`);
console.log('STRESS PASS');
