// Blood system smoke test outside Foundry: PIXI/canvas/game stubs.
// Verifies determinism (two renderers produce identical draw calls),
// store behavior (add/cap/diff sync), colors, and RNG.
// Run: node scripts/blood/_smoke.mjs .
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------ stubs ------------------------------ */

// 2D context that logs every drawImage call (for determinism checks)
function fakeCtx2d(log) {
  const grad = { addColorStop: () => {} };
  const s = () => {};
  return {
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: s, beginPath: s, arc: s, fill: s, stroke: s, rect: s, clip: s,
    moveTo: s, lineTo: s, closePath: s, quadraticCurveTo: s, bezierCurveTo: s,
    ellipse: s, drawImage: (...a) => log.push(['di', a.map(v => (typeof v === 'number' ? Math.round(v * 100) / 100 : (v?._tag ?? 'c')))]),
    save: s, restore: s, translate: s, rotate: s, scale: s, setTransform: s, clearRect: s,
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: s
  };
}

const drawLogs = new Map(); // canvas → []

class FakeCanvas {
  constructor(w = 0, h = 0) {
    this.width = w; this.height = h;
    this._log = [];
    drawLogs.set(this, this._log);
    this.style = {};
  }
  getContext() {
    if (!this._ctx) this._ctx = fakeCtx2d(this._log);
    this._ctx.canvas = this;
    return this._ctx;
  }
}

class FakeRect { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } }

class FakeTexture {
  constructor(a, b) {
    this.source = { update: () => { this._updated = (this._updated ?? 0) + 1; } };
    this.frame = new FakeRect(0, 0, 100, 100);
    this.width = 100; this.height = 100;
  }
  static from() { return new FakeTexture(); }
}

class FakeObservable {
  constructor() {
    this.children = [];
    this.alpha = 1; this.visible = true; this.rotation = 0;
    this.x = 0; this.y = 0; this.zIndex = 0;
    this.name = '';
    this.position = { set: (x, y) => { this.position.x = x; this.position.y = y; }, x: 0, y: 0 };
    this.anchor = { set: (x, y) => { this.anchor.x = x; this.anchor.y = y ?? x; }, x: 0, y: 0 };
    this.scale = { set: (x, y) => { this.scale.x = x; this.scale.y = y ?? x; }, x: 1, y: 1 };
    this.tint = 0xffffff;
    this.blendMode = 0;
    this.eventMode = 'auto';
    this.interactiveChildren = true;
    this.parent = null;
    this.width = 100; this.height = 100;
  }
  addChild(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  removeFromParent() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  destroy() { this.removeFromParent(); }
  sortChildren() {}
}

class FakeSprite extends FakeObservable {
  constructor(tex) { super(); this.texture = tex ?? new FakeTexture(); }
}

class FakeParticleContainer extends FakeObservable {
  constructor(maxSize, properties, batchSize) {
    super();
    this.maxSize = maxSize;
    this.batchSize = batchSize ?? 16384;
    // Regression: a falsy batchSize in real PIXI hangs rendering
    // (`for (i = 0; i < n; i += batchSize)` → i += 0). Catch it in smoke.
    if (!this.batchSize) throw new Error('ParticleContainer: falsy batchSize hangs real PIXI');
  }
}

globalThis.PIXI = {
  Texture: FakeTexture,
  Rectangle: FakeRect,
  Container: FakeObservable,
  ParticleContainer: FakeParticleContainer,
  Sprite: FakeSprite,
  Polygon: class { constructor(pts) { this.points = pts; } contains() { return true; } },
  // Stub surface for bloodied.mjs (Splatter TokenBlood port):
  // Filter/Program/SimplePlane mask + SRC_IN, Graphics clip, Color
  Filter: class { constructor(v, f, u) { this.uniforms = u ?? {}; this.padding = 0; } destroy() {} },
  Program: { from: () => ({}) },
  SimplePlane: class extends FakeObservable {
    constructor(tex) { super(); this.texture = tex; this.shader = null; }
  },
  MeshMaterial: class { constructor(tex, opts = {}) { this.texture = tex; Object.assign(this, opts); } },
  BLEND_MODES: { SRC_IN: 3, ERASE: 24 },
  Graphics: class extends FakeObservable {
    clear() { return this; }
    beginFill() { return this; }
    drawRect() { return this; }
    endFill() { return this; }
  },
  Color: {
    shared: {
      setValue(v) { this._v = v; return this; },
      toRgbArray(arr) { if (arr) { arr[0] = 0.65; arr[1] = 0.08; arr[2] = 0.08; } return arr; }
    }
  }
};

globalThis.document = {
  createElement: (tag) => new FakeCanvas(),
  body: { appendChild: () => {}, removeChild: () => {} }
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ------------------------------ canvas/game ------------------------------ */

const tickers = [];
globalThis.canvas = {
  ready: true,
  grid: { size: 100 },
  scene: { id: 'scene1' },
  primary: new FakeObservable(),
  tiles: { placeables: [] },  // surface tiles (populated in elevation tests)
  tokens: { placeables: [], controlled: [] },
  stage: Object.assign(new FakeObservable(), {
    pivot: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    toLocal: (p) => ({ x: p.x, y: p.y })
  }),
  app: {
    view: new FakeCanvas(800, 600),
    ticker: {
      // addOnce must fire ONCE and remove itself — a persistent listener in
      // the stub masked render flush starvation (fade stopped repainting in
      // real Foundry while tests missed it)
      addOnce: (fn) => {
        const wrapped = () => {
          const i = tickers.indexOf(wrapped);
          if (i >= 0) tickers.splice(i, 1);
          fn();
        };
        tickers.push(wrapped);
      },
      add: (fn) => tickers.push(fn),
      remove: (fn) => { const i = tickers.indexOf(fn); if (i >= 0) tickers.splice(i, 1); },
      deltaMS: 16
    }
  }
};
globalThis.foundry = {
  utils: { getProperty: (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj) },
  canvas: { groups: { PrimaryCanvasGroup: { SORT_LAYERS: { TILES: 1 } } } },
  // Stubs for importing settings-app.mjs (the ApplicationV2 class is defined at
  // module load — without these, import fails before any test runs)
  applications: { api: { HandlebarsApplicationMixin: (C) => C, ApplicationV2: class {} } }
};

const settingsStore = new Map([
  ['bloodEnabled', true],
  ['bloodFootprints', true],
  ['bloodRenderScale', '0.5'],
  ['bloodColor', '#a51414d8'],
  ['bloodUseBloodsheet', true],
  ['bloodBleedStatus', true],
  ['bloodBleedInterval', 6],
  ['bloodStationary', true],
  ['bloodTrail', true],
  ['bloodSnowAccumulation', true],
  ['bloodSnowRate', 'normal'],
  ['bloodHpPath', 'attributes.hp.value'],
  ['bloodHpMaxPath', 'attributes.hp.max'],
  ['bloodUseWounds', false],
  ['bloodCreatureTypePath', 'details.type.value'],
  ['bloodCreatureTypeCustomPath', '']
]);

const strings = new Map();
strings.set('showstopper.blood.settings.save', 'Сохранить');

// Realistic scene flags: setFlag writes nested dot-paths (blood.b0, ...)
const scene1Flags = { showstopper: {} };
const _setFlagPath = (k, v) => {
  const parts = k.split('.');
  let obj = scene1Flags.showstopper;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (v === null || v === undefined) delete obj[last];
  else obj[last] = v;
};

globalThis.game = {
  user: { isGM: true },
  system: { id: 'dnd5e' },
  time: { worldTime: 0 },
  i18n: { localize: (k) => strings.get(k) ?? k },
  settings: {
    get: (m, k) => settingsStore.get(k),
    set: (m, k, v) => settingsStore.set(k, v)
  },
  modules: { get: () => ({ active: false }) },
  scenes: { get: (id) => (id === 'scene1' ? { id, flags: scene1Flags, setFlag: async (m, k, v) => _setFlagPath(k, v) } : null) },
  combat: null
};
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {} };
globalThis.emitLog = [];
globalThis.emitAll = null; // unused placeholder (socket-manager is stubbed via game.socket below)
// stains.mjs imports socket-manager: stub game.socket
globalThis.game.socket = { emit: (ch, data) => emitLog.push(data) };
globalThis.window = globalThis.window ?? globalThis;
globalThis.ui = { notifications: { warn: () => {}, info: () => {} }, controls: null };

/* ------------------------------ run ------------------------------ */

const rootDir = path.resolve(process.argv[2] ?? '.');
const root = pathToFileURL(rootDir).href;
const hasPlus = process.env.SS_SKIP_PLUS !== '1' && existsSync(path.join(rootDir, 'plus/scripts/blood/snow.mjs'));
let failures = 0;
const check = (ok, name) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

const { Rng, hashStr } = await import(`${root}/scripts/blood/rng.mjs`);
const { parseColor, toHex8 } = await import(`${root}/scripts/blood/colors.mjs`);
const { BloodAtlas } = await import(`${root}/scripts/blood/textures.mjs`);
const { BloodStore, STAIN } = await import(`${root}/scripts/blood/stains.mjs`);
const { BloodRenderer } = await import(`${root}/scripts/blood/renderer.mjs`);

// 1. RNG determinism
{
  const a = [], b = [];
  const r1 = new Rng(12345), r2 = new Rng(12345);
  for (let i = 0; i < 100; i++) { a.push(r1.next()); b.push(r2.next()); }
  check(JSON.stringify(a) === JSON.stringify(b), 'rng: одинаковые последовательности');
  check(hashStr('splat-0') === hashStr('splat-0') && hashStr('a') !== hashStr('b'), 'rng: hash стабильен');
}

// 2. Colors
{
  const c = parseColor('#a51414d8');
  check(c && c.r === 0xa5 && c.g === 0x14 && c.b === 0x14 && Math.abs(c.a - 0xd8 / 255) < 1e-9, 'colors: hex8 разбор');
  check(toHex8(c) === '#a51414d8', 'colors: toHex8');
  check(parseColor('0xa51414').r === 0xa5, 'colors: 0x-префикс');
}

// 2b. Materials (m): serialized only for snow (m=2), omitted for blood (m=0), separate atlas tiles
{
  const store = new BloodStore(game.scenes.get('scene1'));
  const withM = store.createStain({ x: 1, y: 1, s: 10, m: 2 });
  check(withM.m === 2, 'stain: материал m=2 (снег) сохранён');
  const noM = store.createStain({ x: 1, y: 1, s: 10 });
  check(!('m' in noM), 'stain: у крови m не пишется');
  // Any material other than 2 (snow) normalizes to blood (m field omitted)
  check(!('m' in store.createStain({ x: 1, y: 1, s: 10, m: 1 })), 'stain: m=1 нормализуется в кровь');
  check(!('m' in store.createStain({ x: 1, y: 1, s: 10, m: 3 })), 'stain: m=3 нормализуется в кровь');
  check(!('m' in store.createStain({ x: 1, y: 1, s: 10, m: 7 })), 'stain: m=7 нормализуется в кровь');
  check(!('m' in store.createStain({ x: 1, y: 1, s: 10, m: 0.5 })), 'stain: дробный m не пишется');
  const t1 = BloodAtlas.tinted('splat', 0, '#a51414d8', 0);
  const t1again = BloodAtlas.tinted('splat', 0, '#a51414d8', 0);
  const t3 = BloodAtlas.tinted('splat', 0, '#a51414d8', 2);
  check(t1 === t1again && t1 !== t3, 'atlas: материал даёт отдельные кэш-плашки (кровь vs снег)');

  // Sanitizer fields: strict #rgb[a] color format, finite coordinates,
  // clamped d/f, finite T (age) >= 0, nw = no-wash flag
  check(store.createStain({ x: 1, y: 1, s: 10, c: '#' + 'x'.repeat(500) }).c === '#a51414d8', 'stain: мусорный цвет → дефолт');
  check(store.createStain({ x: 1, y: 1, s: 10, c: '#a51414d8' + '0'.repeat(100) }).c.length === 9, 'stain: длинный цвет обрезан до 9');
  const inf = store.createStain({ x: Infinity, y: NaN, s: 10 });
  check(Number.isFinite(inf.x) && Number.isFinite(inf.y), 'stain: Infinity/NaN координаты → 0');
  check(store.createStain({ x: 1, y: 1, s: 10, d: 1e15 }).d === 60000, 'stain: d клампится в 60000');
  check(!('T' in store.createStain({ x: 1, y: 1, s: 10, T: -5 })), 'stain: отрицательный T не пишется');
  check(store.createStain({ x: 1, y: 1, s: 10, T: 12345.6 }).T === 12346, 'stain: T округляется и пишется');
  check(store.createStain({ x: 1, y: 1, s: 10, nw: 1 }).nw === 1, 'stain: nw пишется');
  // Default seed is deterministic from id (a remote op without seed yields the
  // SAME shape on every client instead of per-client random variants)
  const sA = store.createStain({ i: 42, x: 1, y: 1, s: 10 });
  const sB = store.createStain({ i: 42, x: 1, y: 1, s: 10 });
  check(sA.seed === sB.seed, 'stain: seed без явного — детерминирован от id');
}

// 3. Atlas: error-free generation and layout
{
  const { mask, detail } = BloodAtlas.ensure();
  check(mask instanceof FakeCanvas && detail instanceof FakeCanvas, 'atlas: построен');
  check(BloodAtlas.kindCount('splat') === 12 && BloodAtlas.kindCount('droplet') === 6, 'atlas: количество вариантов');
  // New kinds (APPEND-ONLY): existing indices did not shift
  check(BloodAtlas.kindCount('drip') === 3 && BloodAtlas.kindCount('handprint') === 2, 'atlas: drip/handprint добавлены в конец');
  check(BloodAtlas.indexOf('drip', 0) > BloodAtlas.indexOf('footprint', 3), 'atlas: порядок видов APPEND-ONLY');
  const t1 = BloodAtlas.tinted('splat', 3, '#a51414d8');
  const t2 = BloodAtlas.tinted('splat', 3, '#a51414d8');
  check(t1 === t2, 'atlas: кэш тонировки');
  const t3 = BloodAtlas.tinted('pool', 0, '#44ff00ff');
  check(t3 !== t1, 'atlas: разные ключи — разные плашки');

  // MASK SELECTION for snow (SNOW_KINDS): the determinism log below records
  // untagged sources as 'c' and missed the "snow drawn with blood mask"
  // regression — tag the mask canvases and count tile bodies by first drawImage source
  BloodAtlas.tinted('splat', 6, '#123456ff', 2); // builds snow atlas (untagged yet)
  const masks = BloodAtlas.maskCanvases();
  check(masks.blood instanceof FakeCanvas && masks.snow instanceof FakeCanvas, 'atlas: обе маски построены');
  masks.blood._tag = 'blood-mask';
  masks.snow._tag = 'snow-mask';
  const bodiesFrom = (tag) => [...drawLogs.values()]
    .filter(l => l.some(e => e[0] === 'di' && e[1][0] === tag)).length;
  const snowBefore = bodiesFrom('snow-mask');
  BloodAtlas.tinted('splat', 7, '#123456ff', 2);
  check(bodiesFrom('snow-mask') > snowBefore, 'atlas: снег тонтируется по СНЕЖНОЙ маске');
  const fpBase = bodiesFrom('snow-mask');
  BloodAtlas.tinted('footprint', 3, '#123456ff', 2);
  check(bodiesFrom('snow-mask') === fpBase, 'atlas: снежный ОТПЕЧАТОК — по общей маске');
  const bloodBefore = bodiesFrom('blood-mask');
  BloodAtlas.tinted('splat', 8, '#123456ff', 0);
  check(bodiesFrom('blood-mask') > bloodBefore, 'atlas: кровь — по КРОВЯНОЙ маске');
}

// 4. Render determinism: two renderers, identical stain sets → identical draw logs
{
  const makeStains = (store) => {
    const list = [];
    for (let i = 0; i < 40; i++) {
      list.push(store.createStain({
        t: [STAIN.SPLAT, STAIN.SPLASH, STAIN.SMEAR, STAIN.POOL, STAIN.DROPLETS][i % 5],
        x: (i * 137.5) % 3000, y: (i * 91.25) % 2000,
        s: 80 + (i % 7) * 40, r: i * 0.3, a: 0.85,
        c: i % 3 === 0 ? '#a51414d8' : '#b527d5d5',
        seed: 1000 + i * 7919,
        ...(i % 4 === 0 ? { w: 'f' + 'a'.repeat(15) } : {})
      }));
    }
    return list;
  };
  const store1 = new BloodStore(game.scenes.get('scene1'));
  const store2 = new BloodStore(game.scenes.get('scene1'));
  const r1 = new BloodRenderer({ scale: 0.5 });
  r1.rebuildFrom(makeStains(store1));
  r1.flush();
  // COLD second client: atlas and tint cache rebuilt from scratch
  BloodAtlas.reset();
  const r2 = new BloodRenderer({ scale: 0.5 });
  r2.rebuildFrom(makeStains(store2));
  r2.flush();
  const log1 = r1.chunks.get('0|0,0')?.canvas._log ?? [];
  const log2 = r2.chunks.get('0|0,0')?.canvas._log ?? [];
  check(log1.length > 10, `renderer: чанк 0,0 заполнен (${log1.length} draw)`);
  check(JSON.stringify(log1) === JSON.stringify(log2), 'renderer: ДЕТЕРМИНИРОВАННЫЙ вывод двух рендереров');
  check(r1.stats.stains === 40, 'renderer: счётчик пятен');
}

// 5. Store: add, socket ops, cap, reconcile
{
  const scene = game.scenes.get('scene1');
  const store = new BloodStore(scene);
  const renderer = new BloodRenderer({ scale: 0.5 });
  store.setRenderer(renderer);

  const s1 = store.add([store.createStain({ x: 10, y: 10, s: 100 })]);
  check(s1.length === 1 && store.count === 1, 'store: добавление');
  check(emitLog.at(-1)?.add?.length === 1 && emitLog.at(-1)?.ns === 'blood:apply', 'store: сокет-оп эмитится');

  // Remote apply idempotence
  store.applyRemote({ add: s1, remove: [] });
  check(store.count === 1, 'store: applyRemote идемпотентен');

  // Uncapped: everything added stays
  const batch = [];
  for (let i = 0; i < 10; i++) batch.push(store.createStain({ x: i * 10, y: 0, s: 50 }));
  store.add(batch);
  check(store.count === 11, `store: без лимита добавляется всё (${store.count})`);

  // reconcile: remote state is a different stain set
  const survived = store.stains.map(s => ({ ...s }));
  const remote = { v: 1, nextId: 999, stains: [survived[0] ?? null, { i: 900, t: 0, x: 1, y: 1, s: 10, r: 0, a: 1, c: '#ff0000ff', seed: 5 }].filter(Boolean) };
  store.reconcile(remote);
  check(store.count === 2 && store.stains.some(s => s.i === 900), 'store: reconcile приводит к удалённому множеству');
  check(store.nextId === 999, 'store: nextId из флага');

  // clear
  store.clear();
  check(store.count === 0 && renderer.stains.length === 0, 'store: полная очистка');
}

// 6. Persistence v2: flag buckets, legacy v1 migration
{
  const scene = game.scenes.get('scene1');
  const store = new BloodStore(scene);
  store.add([store.createStain({ x: 1, y: 2, s: 3 })], { broadcast: false });
  await store.flush();
  await new Promise(r => setTimeout(r, 5));
  const B = scene1Flags.showstopper.blood;
  check(B && B.v === 2 && B.b0 && B.b0.stains.length === 1,
    'store: flush пишет бакет флага (v2, blood.b0)');

  // Legacy v1 migration: array is read, moved into buckets, and removed
  scene1Flags.showstopper.blood = {
    v: 1, nextId: 7,
    stains: [{ i: 5, t: 0, x: 9, y: 9, s: 10, r: 0, a: 0.8, c: '#ff0000ff', seed: 3 }]
  };
  const store2 = new BloodStore(scene);
  store2.load();
  check(store2.count === 1 && store2.stains[0].i === 5 && store2.nextId === 7, 'store: легаси v1 загружается');
  await store2.flush();
  await new Promise(r => setTimeout(r, 5));
  const B2 = scene1Flags.showstopper.blood;
  check(B2.v === 2 && B2.b0.stains.length === 1 && !('stains' in B2),
    'store: миграция v1→v2 — бакет записан, легаси-массив удалён');
  const store3 = new BloodStore(scene);
  store3.load();
  check(store3.count === 1 && store3.stains[0].i === 5 && store3.nextId === 7, 'store: перезагрузка из v2-бакетов');
}

// 7. Deferred appearance (d) and fade-in (f)
{
  const store = new BloodStore(game.scenes.get('scene1'));
  const renderer = new BloodRenderer({ scale: 0.5 });
  store.setRenderer(renderer);
  store.add([store.createStain({ x: 50, y: 50, s: 100, d: 40, f: 600 })], { broadcast: false });
  check(renderer.stains.length === 0, 'defer: пятно с d скрыто до срока');
  await new Promise(r => setTimeout(r, 80));
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
  renderer.flush();
  check(renderer.stains.length === 1, 'defer: пятно активировалось по сроку');
  check(renderer._fading.size === 1, 'fade: fade-in идёт');

  // A mid-fade frame MUST be repainted by the ticker (flush scheduled via addOnce),
  // rather than drawn once at low alpha with a sudden jump at the end
  await new Promise(r => setTimeout(r, 40));
  const logMid = () => renderer.chunks.get('0|0,0')?.canvas._log.length ?? 0;
  const before = logMid();
  for (const fn of [...tickers]) fn({ deltaMS: 16 }); // tick: touch + schedule flush
  for (const fn of [...tickers]) fn({ deltaMS: 16 }); // queue: execute flush
  check(logMid() > before, 'fade: mid-fade перекрашивается без ручного flush');

  await new Promise(r => setTimeout(r, 700));
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
  renderer.flush();
  check(renderer._fading.size === 0, 'fade: затухание завершено');

  // rebuild — existing blood appears immediately: NEITHER d NOR f is replayed
  const store2 = new BloodStore(game.scenes.get('scene1'));
  const r2 = new BloodRenderer({ scale: 0.5 });
  store2.setRenderer(r2);
  r2.rebuildFrom([store2.createStain({ x: 5, y: 5, s: 50, d: 999, f: 100 })]);
  check(r2.stains.length === 1, 'rebuild: старая кровь с d рисуется сразу');
  check(r2._fading.size === 0, 'rebuild: старая кровь НЕ переигрывает fade-in');
}

// 8. Particles: spawn determinism, physics, pool, full lifecycle
{
  const P = await import(`${root}/scripts/blood/particles.mjs`);
  P.initBloodParticles();
  // Only particle containers (maxSize is set by the ParticleContainer stub) —
  // canvas.primary also holds stain-renderer chunk sprites from tests above
  const spritesFlat = () => canvas.primary.children
    .filter(c => c.maxSize != null)
    .flatMap(c => c.children);
  const snap = () => spritesFlat()
    .filter(s => s.visible)
    .map(s => [Math.round(s.x), Math.round(s.y), Math.round(s.rotation * 100)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Determinism: same seed → same scatter, different seed → different scatter
  P.spawnBurstLocal({ x: 500, y: 500, seed: 777, size: 100, count: 60 });
  const snapA = snap();
  P.stopAllBursts();
  P.spawnBurstLocal({ x: 500, y: 500, seed: 777, size: 100, count: 60 });
  const snapA2 = snap();
  check(snapA.length > 10 && JSON.stringify(snapA) === JSON.stringify(snapA2), 'particles: спавн детерминирован по seed');
  P.stopAllBursts();
  P.spawnBurstLocal({ x: 500, y: 500, seed: 778, size: 100, count: 60 });
  check(JSON.stringify(snapA) !== JSON.stringify(snap()), 'particles: другой seed — другой разлёт');

  // Physics: ticker advances sprites, active == visible invariant holds
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
  const st2 = P.debugStats();
  const vis = spritesFlat().filter(s => s.visible).length;
  check(vis === st2.active && st2.active > 0, `particles: инвариант активных/видимых (${st2.active} vs ${vis})`);

  // Pool saturation: never overflows, slots are reclaimed once all particles expire
  P.stopAllBursts();
  for (let i = 0; i < 260; i++) P.spawnBurstLocal({ x: i, y: i, seed: i + 1, count: 160, size: 100 });
  const full = P.debugStats();
  check(full.active <= full.capacity, `particles: пул не переполнился (${full.active}/${full.capacity})`);
  check(full.active === full.capacity, `particles: пул заполнен до ёмкости (${full.active})`);
  for (let i = 0; i < 130; i++) for (const fn of [...tickers]) fn({ deltaMS: 16 });
  check(P.debugStats().active === 0, 'particles: все частицы умерли, пул освобождён');
  P.spawnBurstLocal({ x: 0, y: 0, seed: 42, count: 50 });
  check(P.debugStats().active > 0, 'particles: спавн после полного цикла работает');
  P.stopAllBursts();
  check(spritesFlat().every(s => !s.visible), 'particles: stopAllBursts гасит слой');
}

// 9. Footprint atlas + token footprint interactions
{
  check(BloodAtlas.kindCount('footprint') === 4, 'atlas: footprint — 4 варианта');
  const fp = BloodAtlas.tinted('footprint', 1, '#a51414d8', 0);
  check(fp && BloodAtlas.tinted('footprint', 1, '#a51414d8', 0) === fp
    && BloodAtlas.tinted('footprint', 1, '#a51414d8', 2) !== fp, 'atlas: footprint тонтируется по материалам');

  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
  const store = new BloodStore(game.scenes.get('scene1'));
  const hooks = new BloodEventHooks(() => store);

  // Walking through a blood pool: footprint on every step, alternating left/right
  store.add([store.createStain({ x: 650, y: 500, s: 300, a: 0.9, c: '#a51414d8' })], { broadcast: false });
  hooks._trail.footprints({ id: 't1', x: 500, y: 500, width: 1, height: 1 }, { x: 700, y: 500 });
  const prints1 = store.stains.filter(s => s.t === STAIN.FOOTPRINT);
  check(prints1.length === 4, `footprints: 4 шага через пятно (${prints1.length})`);
  check(prints1.every(p => !('m' in p) && Math.abs(p.r) <= 0.21),
    'footprints: кровавые (без m), носок вдоль движения');
  check(prints1.every(p => p.a >= 0.55) && prints1[0].c !== '#a51414d8',
    'footprints: свежие плотные и темнее пятна (читаемы на крови)');
  const vSide = (s) => { const v = new Rng(s).int(4); return (v === 0 || v === 2); };
  check(vSide(prints1[0].seed) !== vSide(prints1[1].seed), 'footprints: лево/право чередуются');
  check((hooks._trail._soles.get('t1')?.steps ?? 0) > 0, 'footprints: подошвы набрали крови');

  // Clean ground: fading footprints until the soles wear clean
  const before = store.count;
  hooks._trail.footprints({ id: 't1', x: 900, y: 500, width: 1, height: 1 }, { x: 1000, y: 500 });
  const fresh2 = store.stains.slice(before).filter(s => s.t === STAIN.FOOTPRINT);
  check(fresh2.length === 2 && fresh2[0].a > fresh2[1].a && fresh2.every(p => p.a < 0.7),
    `footprints: по чистой земле — затухающие следы с подошв (${fresh2.length})`);
  check(fresh2[0].c === '#a51414d8', 'footprints: на чистой земле — чистый цвет крови');
  hooks._trail.footprints({ id: 't1', x: 1100, y: 500, width: 1, height: 1 }, { x: 1200, y: 500 });
  hooks._trail.footprints({ id: 't1', x: 1300, y: 500, width: 1, height: 1 }, { x: 1400, y: 500 });
  hooks._trail.footprints({ id: 't1', x: 1500, y: 500, width: 1, height: 1 }, { x: 1600, y: 500 });
  hooks._trail.footprints({ id: 't1', x: 1900, y: 500, width: 1, height: 1 }, { x: 2000, y: 500 });
  check(!hooks._trail._soles.has('t1'), 'footprints: подошвы вытопчаны');
  const before2 = store.count;
  hooks._trail.footprints({ id: 't1', x: 1700, y: 500, width: 1, height: 1 }, { x: 1800, y: 500 });
  check(store.count === before2, 'footprints: с чистых подошв следов нет');

  // Spatial index stays consistent across all mutations
  const st2 = new BloodStore(game.scenes.get('scene1'));
  const a1 = st2.add([st2.createStain({ x: 0, y: 0, s: 100 })], { broadcast: false });
  st2.add([st2.createStain({ x: 600, y: 600, s: 50 })], { broadcast: false });
  check(st2.queryCircle(10, 10, 60).length === 1, 'index: находит пятно в круге');
  check(st2.queryCircle(10000, 10000, 60).length === 0, 'index: пусто вдали от пятен');
  st2.remove([a1[0].i], { broadcast: false });
  check(st2.queryCircle(10, 10, 60).length === 0, 'index: удалённое не находит');
  st2.add([st2.createStain({ x: 0, y: 0, s: 100 })], { broadcast: false });
  check(st2.queryCircle(10, 10, 60).length === 1, 'index: добавленное в индексе');
  st2.reconcile({ v: 1, nextId: 50, stains: [{ i: 77, t: 0, x: 300, y: 300, s: 80, r: 0, a: 0.9, c: '#ff0000ff', seed: 3 }] });
  check(st2.queryCircle(300, 300, 40).length === 1 && st2.queryCircle(10, 10, 60).length === 0,
    'index: reconcile перестраивает индекс');
  st2.clear({ broadcast: false });
  check(st2.queryCircle(300, 300, 40).length === 0, 'index: clear чистит индекс');
}

// 10. Dust puff: fresh footprint spawns particles, rebuild does not, hit splat does not
{
  const P2 = await import(`${root}/scripts/blood/particles.mjs`);
  P2.stopAllBursts();
  const store = new BloodStore(game.scenes.get('scene1'));
  const r1 = new BloodRenderer({ scale: 0.5 });
  r1.addStains([store.createStain({
    t: STAIN.FOOTPRINT, x: 100, y: 100, s: 40, r: 0.3, a: 0.6, c: '#a51414d8', seed: 99, m: 2
  })]);
  check(P2.debugStats().active > 0, `particles: свежий след поднимает пафф (${P2.debugStats().active})`);
  P2.stopAllBursts();
  // Bloody footprint: main print + wet satellite spatters
  r1.addStains([store.createStain({
    t: STAIN.FOOTPRINT, x: 150, y: 150, s: 40, r: 0, a: 0.8, c: '#a51414d8', seed: 105
  })]);
  r1.flush();
  const logLen = r1.chunks.get('0|0,0')?.canvas._log.length ?? 0;
  check(logLen >= 3, `opt: кровавый след со спутниками-брызгами (draw-операций: ${logLen})`);
  P2.stopAllBursts();
  r1.addStains([store.createStain({ t: STAIN.SPLAT, x: 100, y: 100, s: 40, a: 0.6, seed: 100 })]);
  check(P2.debugStats().active === 0, 'particles: пятно удара паффа не даёт');
  const r2 = new BloodRenderer({ scale: 0.5 });
  r2.rebuildFrom([store.createStain({
    t: STAIN.FOOTPRINT, x: 200, y: 200, s: 40, r: 0, a: 0.6, c: '#5c4326cc', seed: 101, m: 2
  })]);
  check(P2.debugStats().active === 0, 'particles: rebuild (старые следы) молчит');
}

// 11. Optimizations: O(1) dedup, chunk member index, flush budget
{
  const store = new BloodStore(game.scenes.get('scene1'));
  const r = new BloodRenderer({ scale: 0.5 });
  store.setRenderer(r);

  // Store and renderer dedup without O(N) scans
  const st = store.createStain({ x: 500, y: 500, s: 100 });
  store.add([st], { broadcast: false });
  store.add([st], { broadcast: false });
  store.applyRemote({ add: [st] });
  check(store.count === 1 && r.stains.length === 1, 'opt: дедуп стора и рендера');
  check((r._members.get('0|0,0')?.size ?? 0) === 1 && r._ids.has(st.i), 'opt: пятно в индексе членов чанка');
  r.removeStains([st.i]);
  check((r._members.get('0|0,0')?.size ?? 0) === 0 && !r._ids.has(st.i), 'opt: удаление чистит индекс');

  // Budget: 12 distant chunks — flush processes a batch, remainder drains over subsequent frames
  for (let i = 0; i < 12; i++) {
    r.addStains([store.createStain({ x: i * 1024 + 512, y: 512, s: 50, seed: 1000 + i })], { defer: false });
  }
  check(r._dirty.size === 12, `opt: 12 чанков грязных (${r._dirty.size})`);
  r.flush();
  check(r._dirty.size === 12 - 8, `opt: бюджет флеша 8/кадр (осталось ${r._dirty.size})`);
  r.flush();
  r.flush();
  check(r._dirty.size === 0 && r.chunks.size === 12, 'opt: остаток добирается за следующие кадры');
}

// 12. Incremental bake: tail append matches a cold full redraw
{
  const store = new BloodStore(game.scenes.get('scene1'));
  const list = [];
  for (let i = 0; i < 15; i++) {
    list.push(store.createStain({
      t: [0, 1, 2, 3, 4][i % 5], x: 300 + (i % 3) * 400, y: 300, s: 60 + (i % 4) * 20,
      r: i * 0.4, a: 0.8, c: '#a51414d8', seed: 5000 + i * 131
    }));
  }
  // Renderer A: three batches with flushes in between — exercises fast tail append;
  // Renderer B: all at once via cold full bake. Pixel output
  // (per-chunk draw operation sequence) must match.
  const ra = new BloodRenderer({ scale: 0.5 });
  for (let b = 0; b < 3; b++) {
    ra.addStains(list.slice(b * 5, b * 5 + 5), { defer: false });
    ra.flush();
  }
  const rb = new BloodRenderer({ scale: 0.5 });
  rb.addStains(list, { defer: false });
  rb.flush();
  const keys = [...ra.chunks.keys()];
  let same = keys.length > 0 && keys.length === rb.chunks.size;
  for (const key of keys) {
    const la = ra.chunks.get(key)?.canvas._log ?? [];
    const lb = rb.chunks.get(key)?.canvas._log ?? [];
    if (JSON.stringify(la) !== JSON.stringify(lb)) { same = false; break; }
  }
  check(same, `opt: дорисовка хвоста = холодному бейку (${keys.length} чанков)`);
  check([...ra.chunks.values()].every(c => c.maxId > 0), 'opt: maxId чанка ведётся');
  check(ra._fullRedraw.size === 0, 'opt: fullRedraw погашен полным бейком');
}

// 13. Elevations: e field, elevation containers, surfaceElevationAt, footprint filter
{
  const { surfaceElevationAt } = await import(`${root}/scripts/blood/elevation.mjs`);
  const store = new BloodStore(game.scenes.get('scene1'));
  const r = new BloodRenderer({ scale: 0.5 });
  store.setRenderer(r);

  // e is sanitized: non-zero is stored, zero is omitted (backward compatibility)
  const s0 = store.createStain({ x: 100, y: 100, s: 50 });
  const s10 = store.createStain({ x: 100, y: 100, s: 50, e: 10 });
  const s99 = store.createStain({ x: 100, y: 100, s: 50, e: 99999 });
  check(!('e' in s0) && s10.e === 10 && s99.e === 1000, 'elevation: e в записи (ноль опущен, клэмп)');

  store.add([s0, s10], { broadcast: false });
  r.flush();
  check(!!r._elevContainers.get(0) && !!r._elevContainers.get(10),
    'elevation: контейнеры высот 0 и 10 созданы');
  check(!!r.chunks.get('0|0,0') && !!r.chunks.get('10|0,0'),
    'elevation: чанки на своих высотах (ключ e|cx,cy)');
  check(r.chunks.get('0|0,0').sprite.parent === r._elevContainers.get(0)
    && r.chunks.get('10|0,0').sprite.parent === r._elevContainers.get(10),
    'elevation: спрайты в СВОИХ контейнерах');
  r.removeStains([s10.i]);
  r.flush();
  check(!r._elevContainers.has(10) && !!r._elevContainers.get(0),
    'elevation: опустевший слой снесён, занятый жив');

  // surfaceElevationAt: tile at 10 catches blood from elevation 20, not from 5; outside tile → floor
  const roofTile = {
    document: { elevation: 10 },
    bounds: { contains: (x, y) => x > 1300 && x < 1700 && y > 300 && y < 700 }
  };
  canvas.tiles.placeables = [roofTile];
  try {
    check(surfaceElevationAt(1500, 500, 20) === 10, 'elevation: рисуешь с 20 — ловит тайл на 10');
    check(surfaceElevationAt(1500, 500, 5) === 0, 'elevation: тайл выше потолка не ловит — пол');
    check(surfaceElevationAt(100, 100, 20) === 0, 'elevation: мимо тайла — пол');

    // Footprints respect surfaces: floor blood does not stain a roof token and vice versa
    const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
    const st2 = new BloodStore(game.scenes.get('scene1'));
    st2.add([
      st2.createStain({ x: 500, y: 500, s: 300, a: 0.9 }),            // blood on floor
      st2.createStain({ x: 1500, y: 500, s: 300, a: 0.9, e: 10 })     // blood on roof
    ], { broadcast: false });
    const hooks = new BloodEventHooks(() => st2);

    hooks._trail.footprints({ id: 'f1', x: 400, y: 500, width: 1, height: 1, elevation: 0 }, { x: 620, y: 500 });
    const floorPrints = st2.stains.filter(s => s.t === STAIN.FOOTPRINT && !('e' in s));
    check(floorPrints.length === 4, `elevation: следы по крови пола (${floorPrints.length})`);

    hooks._trail.footprints({ id: 'f2', x: 1400, y: 500, width: 1, height: 1, elevation: 0 }, { x: 1620, y: 500 });
    check(!st2.stains.some(s => s.t === STAIN.FOOTPRINT && (Number(s.e) || 0) !== 0 && s.x > 1300),
      'elevation: токен на полу НЕ пачкается о кровь на крыше');

    hooks._trail.footprints({ id: 'f3', x: 1400, y: 500, width: 1, height: 1, elevation: 10 }, { x: 1620, y: 500 });
    const roofPrints = st2.stains.filter(s => s.t === STAIN.FOOTPRINT && s.e === 10);
    check(roofPrints.length >= 3 && roofPrints.every(p => p.e === 10),
      `elevation: токен на крыше печатает ПО крыше (e=10, ${roofPrints.length} шт.)`);
  } finally {
    canvas.tiles.placeables = [];
  }
}

// 14. Tile attachment: tid, blood follows moved tile, deleted with tile + CTRL+Z restore
{
  const { surfaceAt } = await import(`${root}/scripts/blood/elevation.mjs`);
  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
  const store = new BloodStore(game.scenes.get('scene1'));
  const hooks = new BloodEventHooks(() => store);

  // tid is sanitized: string is stored, missing or non-string is omitted
  const withTid = store.createStain({ x: 10, y: 10, s: 50, e: 10, tid: 'tileAbc' });
  check(withTid.tid === 'tileAbc', 'tile: tid пишется');
  check(!('tid' in store.createStain({ x: 10, y: 10, s: 50 })), 'tile: без тайла tid нет');
  check(!store.createStain({ x: 10, y: 10, s: 50, tid: 42 }).tid, 'tile: не-строка отброшена');

  const roof = { document: { elevation: 10, id: 'tileRoof' }, bounds: { contains: (x, y) => x > 0 && x < 100 && y > 0 && y < 100 } };
  const low = { document: { elevation: 4, id: 'tileLow' }, bounds: { contains: (x, y) => x > 0 && x < 100 && y > 0 && y < 100 } };
  canvas.tiles.placeables = [roof, low];
  try {
    const surf = surfaceAt(50, 50, 20);
    check(surf.e === 10 && surf.tid === 'tileRoof', 'tile: surfaceAt отдаёт {e, tid} верхней поверхности');

    const mv = store.createStain({ x: 50, y: 50, s: 60, e: 10, tid: 'tileRoof' });
    const other = store.createStain({ x: 50, y: 50, s: 60, e: 10, tid: 'tileOther' });
    const floor = store.createStain({ x: 50, y: 50, s: 60 });
    store.add([mv, other, floor], { broadcast: false });

    // Tile dragged: its blood moves with it (same ids), other tiles and floor stay put
    hooks._tiles._moves.set('tileRoof', { dx: 30, dy: -20, de: 0 });
    hooks._tiles.flush();
    const moved = store.stains.find(s => s.i === mv.i);
    check(moved && moved.x === 80 && moved.y === 30 && moved.e === 10 && moved.tid === 'tileRoof',
      `tile: кровь следует за перемещённым тайлом (${moved && moved.x},${moved && moved.y})`);
    check(store.stains.find(s => s.i === other.i).x === 50
      && store.stains.find(s => s.i === floor.i).x === 50,
      'tile: чужие пятна и пол не сдвигаются');

    // Tile deleted: its blood is removed WITH it (does not fall through) and goes
    // into the stash; createTile with the same id (native CTRL+Z, keepId) restores stains
    hooks._tiles.dropTileBlood('tileRoof');
    check(!store.stains.some(s => s.i === mv.i) && store.stains.some(s => s.i === other.i),
      'tile: удаление тайла снимает только его кровь');
    const stashed = hooks._tiles._stash.get('tileRoof');
    check(stashed?.length === 1 && stashed[0].i === mv.i && stashed[0].tid === 'tileRoof',
      'tile: снятое лежит в стэше с tid');
    store.add(hooks._tiles._stash.get('tileRoof')); // createTile hook body
    hooks._tiles._stash.delete('tileRoof');
    const back = store.stains.find(s => s.i === mv.i);
    check(back && back.x === 80 && back.y === 30 && back.tid === 'tileRoof',
      'tile: CTRL+Z тайла возвращает пятна на место');

    // Render routing + BAKE: tid stain lives in the tile OVERLAY (not in
    // chunks); fake mesh exercises full cycle — attach, GPU texture upload,
    // and tail append with re-upload
    const r = new BloodRenderer({ scale: 0.5 });
    store.setRenderer(r);
    const mesh = Object.assign(new FakeObservable(), {
      anchor: { x: 0.5, y: 0.5 }, width: 400, height: 400,
      texture: Object.assign(new FakeTexture(), { frame: new FakeRect(0, 0, 100, 100) })
    });
    const roofDoc = { id: 'tileRoof', x: 200, y: 200, elevation: 10, width: 400, height: 400, alpha: 1, texture: { alphaThreshold: 0 } };
    const roofTile = { document: roofDoc, mesh, center: { x: 200, y: 200 }, bounds: { contains: () => true } };
    canvas.tiles.placeables = [roofTile];
    const tidStain = store.createStain({ x: 60, y: 60, s: 40, e: 10, tid: 'tileRoof' });
    store.add([tidStain], { broadcast: false });
    const rec = r._overlays.get('tileRoof');
    check(r._members.size === 0 && rec?.stains.size === 1,
      'tile: tid-пятно в оверлее тайла, не в чанках');
    r.flush();
    check(rec.sprite && rec.sprite.parent === mesh && rec.sprite.alpha === 1,
      'tile: оверлей выпечен, прикреплён к мешу, альфа тайла наследована');
    check(rec.maxId === tidStain.i && rec.needFull === false && rec.w === 400,
      'tile: геометрия выпечки из меша, maxId ведётся');
    // Fast path: tail append MUST re-upload the texture to the GPU
    // (regression: tail drew into canvas without updating the texture —
    // blood stayed invisible until a full rebake)
    const t2 = store.createStain({ x: 90, y: 90, s: 30, e: 10, tid: 'tileRoof' });
    store.add([t2], { broadcast: false });
    r.flush();
    check(rec.maxId === t2.i && !rec.needFull && (rec.tex._updated ?? 0) >= 1,
      `tile: быстрый путь — хвост дорисован и текстура перезалита (${rec.tex._updated ?? 0})`);
    // P0 regression: a smear (no satellites) left globalAlpha < 1, causing the
    // destination-in mask to dim ALL tile blood on every flush
    const t3 = store.createStain({ t: STAIN.SMEAR, x: 80, y: 80, s: 30, a: 0.4, e: 10, tid: 'tileRoof' });
    store.remove([t2.i], { broadcast: false });
    store.add([t3], { broadcast: false });
    r.flush();
    check(rec.ctx.globalAlpha === 1,
      `tile: после выпечки globalAlpha = 1 (утечка альфы в маску) (${rec.ctx.globalAlpha})`);
    check(rec.needFull === false, 'tile: быстрый путь после мазка — без полной перепечки');
    store.remove([tidStain.i, t2.i, t3.i], { broadcast: false });
    r.flush();
    check(!r._overlays.has('tileRoof'), 'tile: пустой оверлей снесён');
  } finally {
    canvas.tiles.placeables = [];
  }
}

// 14b. Native CTRL+Z for trails: movement records an op, undo matching original coords removes stains
{
  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
  const st3 = new BloodStore(game.scenes.get('scene1'));
  const hooks3 = new BloodEventHooks(() => st3);
  const pool = st3.createStain({ x: 500, y: 500, s: 120, a: 0.8 });
  st3.add([pool], { broadcast: false });

  // Step through stain: footprints minted, op records origin (doc.x/y before move)
  const doc = { id: 'w1', x: 400, y: 500, width: 1, height: 1, elevation: 0 };
  hooks3._trail.footprints(doc, { x: 620, y: 500 });
  const minted = st3.stains.filter(s => s.t === STAIN.FOOTPRINT);
  check(minted.length > 0 && hooks3._trail._trailOps.get('w1')?.length === 1,
    `trail: ход запомнил оп (${minted.length} отпечатков)`);
  const op = hooks3._trail._trailOps.get('w1')[0];
  check(op.x === 400 && op.y === 500 && op.ids.length === minted.length,
    'trail: оп несёт исходную позицию и id отпечатков');

  // Undo of a DIFFERENT move (unrelated coordinates): nothing is removed
  hooks3._trail._onUpdateTokenUndo({ id: 'w1', scene: null }, { x: 0, y: 0 }, { isUndo: true });
  check(st3.stains.some(s => s.i === minted[0].i), 'trail: чужой откат мимо опа — пятна целы');
  // Not an undo (regular move): ignored as well
  hooks3._trail._onUpdateTokenUndo({ id: 'w1', scene: null }, { x: 400, y: 500 }, {});
  check(st3.stains.some(s => s.i === minted[0].i), 'trail: без isUndo хук молчит');
  // Native CTRL+Z of that move: changes carry the ORIGINAL coordinates
  hooks3._trail._onUpdateTokenUndo({ id: 'w1', scene: null }, { x: 400, y: 500 }, { isUndo: true });
  check(!st3.stains.some(s => op.ids.includes(s.i)), 'trail: CTRL+Z движения снял его отпечатки');
  check(!hooks3._trail._trailOps.has('w1'), 'trail: оп израсходован');
  // Moving across clean ground creates no op: stack is empty, undo is a no-op
  hooks3._trail.footprints({ id: 'w1', x: 2000, y: 2000, width: 1, height: 1, elevation: 0 }, { x: 2400, y: 2000 });
  hooks3._trail._onUpdateTokenUndo({ id: 'w1', scene: null }, { x: 2000, y: 2000 }, { isUndo: true });
  check(st3.count === 1 + minted.length - op.ids.length, 'trail: ход по чистому месту не ломает откат');
}

// 14c. Brush undo stack (undo.mjs): push/undo against the store
{
  const undoMod = await import(`${root}/scripts/blood/undo.mjs`);
  const st4 = new BloodStore(game.scenes.get('scene1'));
  undoMod.wireBloodUndo(() => ({ store: st4 }));
  const a = st4.createStain({ x: 10, y: 10, s: 50 });
  const b = st4.createStain({ x: 30, y: 10, s: 50 });
  st4.add([a, b], { broadcast: false });
  // Brush stroke: undo removes added stains
  undoMod.pushBloodOp('add', [a, b]);
  undoMod.undoLastBloodOp();
  check(st4.count === 0, 'brush-undo: CTRL+Z снял мазок');
  // Eraser stroke: undo restores the exact same records
  undoMod.pushBloodOp('remove', [a, b]);
  undoMod.undoLastBloodOp();
  check(st4.count === 2 && st4.stains.some(s => s.i === a.i) && st4.stains.some(s => s.i === b.i),
    'brush-undo: CTRL+Z вернул стёртое (те же id)');
  // Scene change resets the undo stack
  undoMod.pushBloodOp('add', [a]);
  undoMod.resetBloodUndo();
  undoMod.undoLastBloodOp();
  check(st4.count === 2, 'brush-undo: reset (смена сцены) опустошает стэк');
}
{
  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);

  // _maxS: giant stain raises cell-scan reach; removal + rebuild reset it
  const st1 = new BloodStore(game.scenes.get('scene1'));
  const big = st1.createStain({ x: 100, y: 100, s: 8192 });
  st1.add([big], { broadcast: false });
  check(st1._maxS === 8192, 'perf: _maxS вырос до гиганта');
  st1.remove([big.i], { broadcast: false });
  st1.reconcile({ v: 1, nextId: 50, stains: [{ i: 49, t: 0, x: 300, y: 300, s: 80, r: 0, a: 0.9, c: '#ff0000ff', seed: 3 }] });
  check(st1._maxS === 80, 'perf: _maxS пересчитан перестройкой — храповика нет');

  // Empty store: _footprints exits BEFORE stepping (avoids 24× surfaceAt + queryCircle)
  const st2 = new BloodStore(game.scenes.get('scene1'));
  const hooks2 = new BloodEventHooks(() => st2);
  hooks2._trail.footprints({ id: 'e1', x: 0, y: 0, width: 1, height: 1 }, { x: 500, y: 0 });
  check(!hooks2._trail._footSide.has('e1') && st2.count === 0, 'perf: чистая земля — ранний выход без шагов');

  // Atlas tiles: RGB key deduplicates colors that differ only in alpha (alpha is applied via globalAlpha)
  check(BloodAtlas.tinted('splat', 2, '#a51414d8', 0) === BloodAtlas.tinted('splat', 2, '#a51414ff', 0),
    'perf: плашка одна на rgb — альфа цвета не плодит кэш');

  // Overlay: canvas is sized to the stain bbox rather than the full mesh (blood in the corner of a huge tile)
  const r3 = new BloodRenderer({ scale: 0.5 });
  const st3 = new BloodStore(game.scenes.get('scene1'));
  st3.setRenderer(r3);
  const mesh3 = Object.assign(new FakeObservable(), {
    anchor: { x: 0.5, y: 0.5 }, width: 4000, height: 4000,
    texture: Object.assign(new FakeTexture(), { frame: new FakeRect(0, 0, 100, 100) })
  });
  const bigTileDoc = { id: 'tileBig', x: 2000, y: 2000, elevation: 0, width: 4000, height: 4000, alpha: 1, texture: { alphaThreshold: 0 } };
  canvas.tiles.placeables = [{ document: bigTileDoc, mesh: mesh3, center: { x: 2000, y: 2000 }, bounds: { contains: () => true } }];
  try {
    st3.add([st3.createStain({ x: 2050, y: 2050, s: 60, e: 0, tid: 'tileBig' })], { broadcast: false });
    r3.flush();
    const rec3 = r3._overlays.get('tileBig');
    check(rec3 && rec3.lw < 4000 && rec3.lh < 4000,
      `perf: оверлей печёт bbox пятен, а не весь меш (${rec3?.lw}×${rec3?.lh} из 4000)`);
    // Tail OUTSIDE bbox forces a full rebake with an expanded bbox without dropping stains
    const far = st3.createStain({ x: 2600, y: 2600, s: 60, e: 0, tid: 'tileBig' });
    st3.add([far], { broadcast: false });
    r3.flush();
    check(rec3.maxId === far.i && rec3.needFull === false && rec3.lw > 500,
      `perf: хвост за bbox расширил канвас полной перепечкой (${rec3.lw})`);
  } finally {
    canvas.tiles.placeables = [];
  }
}

// 16. Gates and mechanics: hidden/flying/corpses, skipping footprints on bleeders,
// puff freshness, wound depth, stationary drip, per-token toggle
{
  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
  const P3 = await import(`${root}/scripts/blood/particles.mjs`);
  P3.stopAllBursts();

  const mkDoc = (id, over = {}) => ({
    id, x: 400, y: 500, width: 1, height: 1, elevation: 0, hidden: false,
    scene: { id: 'scene1' },
    actor: { system: { attributes: { hp: { value: 5, max: 100 } } } },
    ...over
  });
  const mkPlaceable = (doc) => ({ id: doc.id, document: doc, center: { x: doc.x + 50, y: doc.y + 50 }, actor: doc.actor });
  const store = new BloodStore(game.scenes.get('scene1'));
  const hooks = new BloodEventHooks(() => store);
  store.add([store.createStain({ x: 500, y: 500, s: 300, a: 0.9, c: '#a51414d8' })], { broadcast: false });

  // HIDDEN token: neither footprints nor trail (invisible creatures do not give themselves away)
  const before = store.count;
  const hiddenDoc = mkDoc('h1', { hidden: true });
  hiddenDoc.object = mkPlaceable(hiddenDoc);
  hooks._onPreUpdateToken(hiddenDoc, { x: 700, y: 500 });
  check(store.count === before, 'gates: скрытый токен не оставляет ни следа, ни мазков');

  // BLEEDING token: footprints are skipped (visual noise), bleeding trail is written instead
  const woundedDoc = mkDoc('w1');
  woundedDoc.object = mkPlaceable(woundedDoc);
  hooks._onPreUpdateToken(woundedDoc, { x: 700, y: 500 });
  const afterW = store.stains.slice(before);
  check(!afterW.some(s => s.t === STAIN.FOOTPRINT) && afterW.some(s => s.t === STAIN.SMEAR || s.t === STAIN.DROPLETS),
    'gates: кровоточащему — трейл вместо отпечатков');

  // WOUND DEPTH: a deep wound leaves denser/darker stains than a light wound
  const lightDoc = mkDoc('w2', { actor: { system: { attributes: { hp: { value: 45, max: 100 } } } } });
  lightDoc.object = mkPlaceable(lightDoc);
  const c1 = store.count;
  hooks._trail.bleedingTrail(lightDoc, { x: 1000, y: 500 });
  const lightTrail = store.stains.slice(c1);
  const deepBase = store.count;
  hooks._trail._lastTrail.delete('w1');
  hooks._trail.bleedingTrail(woundedDoc, { x: 1400, y: 500 });
  const deepTrail = store.stains.slice(deepBase);
  check(lightTrail.length >= 1 && deepTrail.length > lightTrail.length,
    `gates: глубокая рана гуще лёгкой (${deepTrail.length} vs ${lightTrail.length})`);
  check(deepTrail.every(s => s.a >= lightTrail[0].a - 0.31) && deepTrail[0].a > lightTrail[0].a,
    'gates: глубокая рана темнее/плотнее лёгкой');

  // CORPSE does not "step": dragging it only paints smears
  const deadDoc = mkDoc('d1', { actor: { system: { attributes: { hp: { value: 0, max: 100 } } } } });
  const c2 = store.count;
  hooks._trail.footprints(deadDoc, { x: 900, y: 500 });
  check(store.stains.slice(c2).every(s => s.t !== STAIN.FOOTPRINT), 'gates: труп не оставляет отпечатков');

  // FLYING token does not leave footprints on the surface below
  const flyDoc = mkDoc('f1', { elevation: 20 });
  const c3 = store.count;
  hooks._trail.footprints(flyDoc, { x: 700, y: 500 });
  check(store.stains.slice(c3).every(s => s.t !== STAIN.FOOTPRINT), 'gates: летящий не топчет пол под собой');

  // PUFF — only on FRESH footprints (worn-off soles with a <= 0.5 do not kick up dust)
  const rp = new BloodRenderer({ scale: 0.5 });
  rp.addStains([store.createStain({ t: STAIN.FOOTPRINT, x: 3000, y: 3000, s: 40, a: 0.4, seed: 71 })]);
  check(P3.debugStats().active === 0, 'gates: затухающий износ подошв паффа не даёт');
  rp.addStains([store.createStain({ t: STAIN.FOOTPRINT, x: 3100, y: 3100, s: 40, a: 0.6, seed: 72 })]);
  check(P3.debugStats().active > 0, 'gates: свежий отпечаток поднимает пафф');
  P3.stopAllBursts();

  // STATIONARY drip: deeply wounded STANDING token drips a stain underneath
  const standDoc = mkDoc('s1', { x: 800, y: 800 });
  const standTok = mkPlaceable(standDoc);
  canvas.tokens.placeables = [standTok];
  try {
    const c4 = store.count;
    hooks._stationaryDrip();
    check(store.count === c4, 'stationary: без истории позиции — только фиксация, без капли');
    hooks._lastPos.set('s1', { x: 800, y: 800, at: Date.now() - 30000 });
    hooks._stationaryDrip();
    const drips = store.stains.slice(c4);
    check(drips.length === 1 && (drips[0].t === STAIN.POOL || drips[0].t === STAIN.DROPLETS) && Number(drips[0].f) > 0,
      'stationary: стоячий раненый накапал под себя');
    // MOVING token does not drip: changing position resets the stationary timer
    hooks._lastPos.set('s1', { x: 900, y: 900, at: Date.now() - 30000 }); // position changed (token moved)
    const c5 = store.count;
    hooks._stationaryDrip();
    check(store.count === c5, 'stationary: сменил позу — снова ждать');
    // LIGHTLY wounded token does not drip
    const lightStand = mkDoc('s2', { x: 1200, y: 1200, actor: { system: { attributes: { hp: { value: 45, max: 100 } } } } });
    canvas.tokens.placeables = [mkPlaceable(lightStand)];
    hooks._lastPos.set('s2', { x: 1200, y: 1200, at: Date.now() - 30000 });
    const c6 = store.count;
    hooks._stationaryDrip();
    check(store.count === c6, 'stationary: «на пороге» не капает');
  } finally {
    canvas.tokens.placeables = [];
  }

  // PER-TOKEN toggle: bloodDisabled flag suppresses manual splat
  const noBloodDoc = mkDoc('n1');
  const noBloodTok = mkPlaceable(noBloodDoc);
  noBloodDoc.getFlag = (scope, key) => (key === 'bloodDisabled' ? true : undefined);
  const c7 = store.count;
  hooks.splat(noBloodTok, { impact: 0.5 });
  check(store.count === c7, 'gates: флаг bloodDisabled глушит всплеск');
  const plainTok = mkPlaceable(mkDoc('n2'));
  hooks._hitTimers.clear(); // delayed spawn must not leak into subsequent tests
  setTimeout(() => {
    hooks.splat(plainTok, { impact: 0.5 });
    hooks._hitTimers.clear();
  }, 0);
}

// 16b. Bleeding via STATUS EFFECT: full HP + "bleed" effect → trail and
// periodic drips; bloodBleedStatus toggle disables this source
{
  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
  const store = new BloodStore(game.scenes.get('scene1'));
  const hooks = new BloodEventHooks(() => store);

  const mkBleeder = (id, name = 'Bleeding', statuses = ['bleed']) => {
    const doc = {
      id, x: 400, y: 500, width: 1, height: 1, elevation: 0, hidden: false,
      scene: { id: 'scene1' },
      // FULL HP: threshold bleeding is ruled out, only the status effect applies
      actor: {
        system: { attributes: { hp: { value: 100, max: 100 } } },
        effects: [{ name, disabled: false, statuses: new Set(statuses) }]
      }
    };
    doc.object = { id, document: doc, center: { x: doc.x + 50, y: doc.y + 50 }, actor: doc.actor };
    return doc;
  };

  // Trail at full HP: status marks the token as bleeding
  const b1 = mkBleeder('b1');
  hooks._onPreUpdateToken(b1, { x: 900, y: 500 });
  const trail = store.stains.filter(s => s.t === STAIN.SMEAR || s.t === STAIN.DROPLETS);
  check(trail.length >= 1, 'bleed: статус на полном HP красит трейл');

  // Footprints are SKIPPED for status bleeders (just like threshold bleeders):
  // place blood along the path — footprints would appear otherwise, yet only the trail is written
  store.add([store.createStain({ x: 650, y: 550, s: 300, a: 0.9, c: '#a51414d8' })], { broadcast: false });
  hooks._trail._lastTrail.clear();
  const beforeFp = store.count;
  hooks._onPreUpdateToken(b1, { x: 900, y: 500 });
  const sliceFp = store.stains.slice(beforeFp);
  check(sliceFp.every(s => s.t !== STAIN.FOOTPRINT),
    'bleed: статусному не нужны отпечатки — только трейл');
  check(sliceFp.some(s => s.t === STAIN.SMEAR || s.t === STAIN.DROPLETS),
    'bleed: трейл пишется поверх пятна');

  // Drip: stationary >= 3s → drips; bloodBleedInterval (6s) enforces cooldown
  canvas.tokens.placeables = [b1.object];
  try {
    hooks._lastPos.set('b1', { x: 400, y: 500, at: Date.now() - 5000 });
    const c1 = store.count;
    hooks._stationaryDrip();
    check(store.count === c1 + 1, 'bleed: стоячий статусный закапал (интервал 6с истёк)');
    const c2 = store.count;
    hooks._stationaryDrip(); // immediate second call — cooldown has not elapsed yet
    check(store.count === c2, 'bleed: капля не чаще интервала');
    hooks._lastPos.set('b1', { x: 400, y: 500, at: Date.now() - 10000 });
    hooks._lastDrip.set('b1', Date.now() - 7000);
    hooks._stationaryDrip();
    check(store.count === c2 + 1, 'bleed: следующий интервал — новая капля');
  } finally {
    canvas.tokens.placeables = [];
  }

  // Status toggle: trail stops appearing (HP threshold is not crossed)
  settingsStore.set('bloodBleedStatus', false);
  const b2 = mkBleeder('b2');
  hooks._onPreUpdateToken(b2, { x: 900, y: 500 });
  const c3 = store.count;
  hooks._trail.bleedingTrail(b2, { x: 1400, y: 500 });
  check(store.count === c3, 'bleed: bloodBleedStatus=false глушит статусный источник');
  settingsStore.set('bloodBleedStatus', true);
}

// 17. Snow (`showstopper-plus`): first verify pure Free without the snow adapter,
//     then load `plus/scripts/blood/snow.mjs` and test the full snow engine
{
  const { hasSnowAdapter } = await import(`${root}/scripts/blood/snow-bridge.mjs`);
  const { BloodBrush: FreeBrush } = await import(`${root}/scripts/blood/brush.mjs`);
  check(hasSnowAdapter() === false, 'free-standalone: до загрузки showstopper-plus адаптер снега отсутствует');
  const fb = new FreeBrush(() => null, () => null);
  fb._setParams({ material: 2 });
  check(fb._params().material === 0, 'free-standalone: без showstopper-plus кисть принудительно работает в режиме крови (material=0)');
}

if (hasPlus) {
  const { hasSnowAdapter } = await import(`${root}/scripts/blood/snow-bridge.mjs`);
  const { SnowAccumulator, SNOW_BEHAVIOR_TYPE } = await import(`${root}/plus/scripts/blood/snow.mjs`);
  check(hasSnowAdapter() === true, 'plus-snow: после загрузки plus/scripts/blood/snow.mjs адаптер снега активен');
  const store = new BloodStore(game.scenes.get('scene1'));
  const flags = {};
  const region = (mode, test) => ({
    behaviors: [{ type: SNOW_BEHAVIOR_TYPE, disabled: false, system: { mode } }],
    polygonTree: { testPoint: test }
  });
  const savedScene = canvas.scene;
  canvas.scene = {
    id: 'scene1', weather: 'snow', width: 1000, height: 1000,
    regions: [region('none', () => true)], // entire map covered by a "no snow" region
    getFlag: (m, k) => flags[k],
    setFlag: async (m, k, v) => { flags[k] = v; }
  };
  const snow = new SnowAccumulator(() => store);
  try {
    // First tick only records the baseline timestamp (elapsed 0); no snow falls
    game.time.worldTime = 36000;
    snow._onWorldTime(36000);
    snow._drain();
    check(store.count === 0, 'snow: первый тик ставит базу, без снега');

    // One hour of snowfall: q accumulates (normal: 1000 droplets / 24h → ~41), but the
    // whole map is a "no snow" region: quota is consumed and no stains are added
    snow._onWorldTime(36000 + 3600);
    snow._drain();
    check(store.count === 0 && snow._state.q === 0,
      'snow: регион «без снега» поглощает осадки (квота израсходована)');

    // Clear regions: one hour of snowfall scatters small snow DROPLETS (m=2)
    canvas.scene.regions = [];
    snow._regionsCache = null;
    snow._onWorldTime(36000 + 7200);
    snow._drain();
    const patches = store.stains.filter(s => s.m === 2);
    check(patches.length >= 40 && patches.length <= 44,
      `snow: час снегопада насыпал пачку мелких снежных точек (${patches.length})`);
    check(patches.every(p => p.t === STAIN.DROPLETS && p.c === '#e8ecf2e0' && p.a >= 0.3 && p.m === 2),
      'snow: пятно — снежные капли (DROPLETS) со случайным офсетом в пределах клетки и подборной альфой');

    // Blizzard: rate ×1.8 (1000/24 * 1.8 = 75/h); trampled region produces fainter snow
    canvas.scene.regions = [region('trampled', () => true)];
    snow._regionsCache = null;
    canvas.scene.weather = 'blizzard';
    snow._onWorldTime(36000 + 10800);
    check(snow._state.q >= 74, `snow: метель ускоряет наметание (q=${snow._state.q})`);
    snow._drain();
    const trampled = store.stains.filter(s => s.m === 2 && !patches.includes(s));
    check(trampled.length >= 1 && trampled.every(p => p.a < 0.55),
      'snow: «протоптано» — снег бледнее обычного');

    // Density cap: 1000 droplets (2..8 droplet stamps across each of the 100 grid cells)
    canvas.scene.regions = [];
    snow._regionsCache = null;
    settingsStore.set('bloodSnowRate', 'fast'); // 1000/12 per hour (×1.8 in blizzard)
    snow._onWorldTime(36000 + 10800 + 12 * 3600);
    for (let k = 0; k < 5; k++) snow._drain();
    let total = store.stains.filter(s => s.m === 2).length;
    check(total === 1000, `snow: кап плотности 1000 достигнут ровно (${total})`);
    const allSnowAtCap = store.stains.filter(s => s.m === 2);
    const q1 = allSnowAtCap.some(s => s.x < 500 && s.y < 500);
    const q2 = allSnowAtCap.some(s => s.x >= 500 && s.y < 500);
    const q3 = allSnowAtCap.some(s => s.x < 500 && s.y >= 500);
    const q4 = allSnowAtCap.some(s => s.x >= 500 && s.y >= 500);
    check(q1 && q2 && q3 && q4,
      'snow: капли снега распределены по всей карте (покрыты все 4 квадранта сцены)');
    const maxIdBeforeCapDrain = Math.max(...store.stains.map(s => s.i));
    snow._onWorldTime(36000 + 10800 + 13 * 3600);
    snow._drain();
    total = store.stains.filter(s => s.m === 2).length;
    const maxIdAfterCapDrain = Math.max(...store.stains.map(s => s.i));
    check(total > 1000 && snow._state.q === 0 && maxIdAfterCapDrain > maxIdBeforeCapDrain,
      `snow: полный кап не замораживает снегопад и не удаляет старый снег (total=${total})`);

    // Clearing: a clearing region sweeps snow patches away (leaving footprints intact)
    const foot = store.createStain({ t: STAIN.FOOTPRINT, x: 500, y: 500, s: 40, a: 0.6, m: 2, seed: 777 });
    store.add([foot], { broadcast: false });
    canvas.scene.regions = [region('clearing', (p) => p.x >= 0)];
    snow._regionsCache = null;
    snow._drain();
    const snowLeft = store.stains.filter(s => s.m === 2 && s.t !== STAIN.FOOTPRINT);
    check(snowLeft.length === 0, 'snow: «уборка» смела все снежные пятна региона');
    check(store.stains.some(s => s.t === STAIN.FOOTPRINT),
      'snow: отпечатки уборка не трогает');

    // Initial calendar jump with explicit dt on a fresh scene is NOT lost
    canvas.scene.regions = [];
    snow._regionsCache = null;
    snow._state = null;
    canvas.scene.weather = 'light-snow'; // extended snow weather recognition
    settingsStore.set('bloodSnowRate', 'normal');
    game.time.worldTime = 100000;
    snow._onWorldTime(100000, 3600); // +1 hour on the very first tick
    check(snow._state.q >= 2, `snow: первый тик с dt=3600 начислил снег без потери (q=${snow._state.q})`);
    snow._drain();

    // Calendar thaw and rain (bloodSnowThaw): snow melts 4× faster in rain
    const beforeThaw = store.stains.filter(s => s.m === 2).length;
    check(beforeThaw >= 2, `snow-thaw: перед оттепелью лежит снег (${beforeThaw})`);
    canvas.scene.weather = 'rain';
    snow._onWorldTime(100000 + 4 * 3600, 4 * 3600); // 4 hours of rain
    check((snow._state.thawQ ?? 0) > 0, `snow-thaw: дождь начислил очередь таяния (thawQ=${snow._state.thawQ})`);
    snow._drain();
    const afterRain = store.stains.filter(s => s.m === 2).length;
    check(afterRain === 0, `snow-thaw: ливень растопил весь снег (осталось ${afterRain})`);

    // Wall snowdrifts during a blizzard: patches near walls are larger and denser
    const savedWalls = canvas.walls;
    canvas.walls = { placeables: [{ document: { id: 'w-drift', c: [500, 100, 500, 900], door: 0, ds: 0 } }] };
    canvas.scene.weather = 'blizzard';
    snow._onWorldTime(100000 + 10 * 3600, 6 * 3600);
    snow._drain();
    const blizzardStains = store.stains.filter(s => s.m === 2 && s.t === STAIN.DROPLETS);
    const nearWallDrifts = blizzardStains.filter(s => Math.abs(s.x - 500) <= 95);
    check(nearWallDrifts.length >= 1 && nearWallDrifts.some(s => s.s > 90 && s.a >= 0.6),
      `snow-drift: метель наметает крупные сугробы у стен (у стены: ${nearWallDrifts.length})`);
    canvas.walls = savedWalls;

    // Calendaria integration: scene.weather is empty (''), weather lives in CALENDARIA.managers.WeatherManager
    store.clear({ broadcast: false });
    canvas.scene.weather = '';
    snow._state = null;
    snow._firstSeeded = false;
    let calWeather = {
      id: 'snow',
      label: 'Snow',
      precipitation: { type: 'snow', intensity: 0.5 },
      wind: { speed: 1 },
      hudEffect: 'snow',
      fxPreset: 'snow'
    };
    globalThis.CALENDARIA = {
      managers: { WeatherManager: { getCurrentWeather: () => calWeather } },
      api: { getCurrentWeather: () => calWeather }
    };
    try {
      // 1) Small step in Calendaria (+1 minute = 60 s) on an empty scene seeds initial snow specks
      game.time.worldTime = 200000;
      snow._onWorldTime(200000, 60);
      snow._drain();
      check(store.stains.filter(s => s.m === 2).length >= 1,
        'snow-calendaria: малый шаг (+1 мин) при снеге в Calendaria сразу сеет первые мелкие капли снега');

      // 2) Fast-forward +2 hours in a Calendaria blizzard (intensity 0.9, wind 5)
      calWeather = {
        id: 'blizzard',
        label: 'Blizzard',
        precipitation: { type: 'snow', intensity: 0.9 },
        wind: { speed: 5 },
        hudEffect: 'snow-heavy',
        fxPreset: 'blizzard'
      };
      snow._onWorldTime(200000 + 2 * 3600, 2 * 3600);
      snow._drain();
      check(store.stains.filter(s => s.m === 2).length >= 10 && snow.stats().blizzard === true,
        `snow-calendaria: метель в Calendaria распознана и намела снег (${store.stains.filter(s => s.m === 2).length})`);

      // 3) Async weather transition on +1 day advance: updateWorldTime fires while weather is still clear,
      //    then calendaria.weatherChange switches to snow afterward
      store.clear({ broadcast: false });
      snow._state = null;
      snow._lastKnownWeather = null;
      snow._lastSeedAt = 0;
      calWeather = { id: 'clear', precipitation: { type: null, intensity: 0 }, wind: { speed: 0 } };
      snow._onWorldTime(300000, 86400); // full-day jump while weather is still clear
      check(snow._state.q === 0, 'snow-calendaria: до прихода хука погоды очередь пуста');
      calWeather = { id: 'snow', precipitation: { type: 'snow', intensity: 0.6 }, wind: { speed: 2 } };
      snow._onExternalWeatherChange(); // calendaria.weatherChange hook arrives next
      snow._drain();
      check(store.stains.filter(s => s.m === 2).length > 5,
        `snow-calendaria: асинхронный calendaria.weatherChange начислил снег за скачок суток (${store.stains.filter(s => s.m === 2).length})`);

      // 4) Synchronous period change in Calendaria BEFORE our updateWorldTime handler:
      //    it was snowing, the user advanced time across a period boundary (Calendaria synchronously
      //    switched weather to clear) — the elapsed interval still accumulates snow rather than thawing!
      store.clear({ broadcast: false });
      snow._state = { t: 400000, frac: 0, q: 0, thawFrac: 0, thawQ: 0 };
      calWeather = { id: 'snow', precipitation: { type: 'snow', intensity: 0.6 }, wind: { speed: 2 } };
      snow._onExternalWeatherChange(); // recorded active snowfall
      calWeather = { id: 'clear', precipitation: { type: null, intensity: 0 }, wind: { speed: 0 } }; // Calendaria switched period synchronously
      snow._onWorldTime(400000 + 4 * 3600, 4 * 3600);
      snow._drain();
      check(store.stains.filter(s => s.m === 2).length >= 5,
        `snow-calendaria: переход из снежного периода в ясный начисляет снег за прошедшие часы (${store.stains.filter(s => s.m === 2).length})`);

      // 5) Under normal clear weather in Calendaria, existing snow does NOT vanish on time advance,
      //    and if FXMaster snow particles (particleEffects) are active on the scene, advancing time adds new snow!
      const countBeforeClearAdvance = store.stains.filter(s => s.m === 2).length;
      snow._onWorldTime(400000 + 10 * 3600, 6 * 3600);
      snow._drain();
      check(store.stains.filter(s => s.m === 2).length === countBeforeClearAdvance,
        'snow-calendaria: обычная ясная погода (clear) НЕ удаляет существующий снег на карте');

      canvas.scene.flags = { fxmaster: { particleEffects: { core_snow: { type: 'snow', enabled: true } } } };
      snow._onWorldTime(400000 + 12 * 3600, 2 * 3600);
      snow._drain();
      check(store.stains.filter(s => s.m === 2).length > countBeforeClearAdvance,
        `snow-fxmaster: активные частицы снега FXMaster (particleEffects) насыпают новый снег даже при clear в Calendaria (${store.stains.filter(s => s.m === 2).length})`);
      delete canvas.scene.flags;
    } finally {
      delete globalThis.CALENDARIA;
    }
  } finally {
    snow.dispose();
    canvas.scene = savedScene;
    settingsStore.set('bloodSnowRate', 'normal');
  }
}

// 17b. Snow interactions: doors (all 5 animation types), fire/thunder/cold, prone fall,
//      drift trampling, drag furrow, crimson snow, and 3 snow depth levels
if (hasPlus) {
  const {
    meltSnowAt, blastSnowAt, freezeSnowAt, sweepDoorSnow, SNOW_COLOR, SNOW_LEVEL, snowLevelAt
  } = await import(`${root}/plus/scripts/blood/snow.mjs`);
  const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
  const store = new BloodStore(game.scenes.get('scene1'));
  const hooks = new BloodEventHooks(() => store);

  // 0) 3 snow levels in a cell as droplets accumulate (1: light dusting, 2: medium cover, 3: volumetric drift)
  {
    store.clear({ broadcast: false });
    // Level 1 (light dusting — 3 droplets in cell): leaves boot prints (FOOTPRINT) without a body trench (SMEAR)
    for (let i = 0; i < 3; i++) {
      store.add([store.createStain({
        t: STAIN.DROPLETS, x: 580 + i * 10, y: 500, s: 55, a: 0.85, c: SNOW_COLOR, m: 2, lv: SNOW_LEVEL.LIGHT
      })], { broadcast: false });
    }
    check(snowLevelAt(store, 600, 500, 0) === SNOW_LEVEL.LIGHT,
      'snow-level-1: 3 капли в клетке = уровень 1 (Мелкий снег)');
    hooks._trail.footprints({ id: 'lv1-walker', x: 500, y: 450, width: 1, height: 1, elevation: 0 }, { x: 700, y: 450 });
    check(store.stains.some(s => s.t === STAIN.FOOTPRINT && s.m === 2) && store.stains.filter(s => s.t === STAIN.SMEAR).length === 0,
      'snow-level-1: по пороше (уровень 1) остаются следы ног (FOOTPRINT) без траншеи телом');

    // Level 2 (medium snow — 8 droplets in cell): covers most of the cell, leaves footprints
    for (let i = 0; i < 5; i++) {
      store.add([store.createStain({
        t: STAIN.DROPLETS, x: 575 + i * 12, y: 490 + (i % 2) * 20, s: 58, a: 0.85, c: SNOW_COLOR, m: 2, lv: SNOW_LEVEL.MEDIUM
      })], { broadcast: false });
    }
    check(snowLevelAt(store, 600, 500, 0) === SNOW_LEVEL.MEDIUM,
      'snow-level-2: 8 капель в клетке = уровень 2 (Небольшой снег)');
    hooks._trail.footprints({ id: 'lv2-walker', x: 500, y: 450, width: 1, height: 1, elevation: 0 }, { x: 700, y: 450 });
    check(store.stains.some(s => s.t === STAIN.FOOTPRINT && s.m === 2),
      'snow-level-2: на небольшом снегу (уровень 2) остаются следы ног (FOOTPRINT)');

    // Even with heavy regular snowfall in a cell (16 lv=2 droplets without any lv=3 drift),
    // it remains level 2 (medium snow) and leaves ONLY footprints (no SMEAR trench)
    for (let i = 0; i < 8; i++) {
      store.add([store.createStain({
        t: STAIN.DROPLETS, x: 565 + i * 10, y: 505, s: 58, a: 0.85, c: SNOW_COLOR, m: 2, lv: SNOW_LEVEL.MEDIUM
      })], { broadcast: false });
    }
    check(snowLevelAt(store, 600, 500, 0) === SNOW_LEVEL.MEDIUM,
      'snow-level-2: плотный обычный снегопад (16 капель lv=2) не считается сугробом');
    hooks._trail.footprints({ id: 'lv2-dense-walker', x: 500, y: 450, width: 1, height: 1, elevation: 0 }, { x: 700, y: 450 });
    check(store.stains.filter(s => s.t === STAIN.SMEAR).length === 0 && store.stains.some(s => s.t === STAIN.FOOTPRINT),
      'snow-level-2: по плотному обычному снегу без сугробов остаются только следы ног (FOOTPRINT), а не борозда');

    // Level 3 (waist-deep drift — 14+ lv=3 droplets in cell): volumetric rendering + wide body trench (not footprints!)
    store.clear({ broadcast: false });
    hooks._trail.forget('lv3-walker');
    for (let i = 0; i < 14; i++) {
      store.add([store.createStain({
        t: STAIN.DROPLETS,
        x: 560 + (i % 5) * 20,
        y: 465 + Math.floor(i / 5) * 25,
        s: 62,
        a: 0.88,
        c: SNOW_COLOR,
        m: 2,
        lv: SNOW_LEVEL.DRIFT
      })], { broadcast: false });
    }
    check(snowLevelAt(store, 600, 500, 0) === SNOW_LEVEL.DRIFT,
      'snow-level-3: 14 капель в клетке = уровень 3 (Сугроб)');
    const rDrift = new BloodRenderer({ scale: 0.5 });
    rDrift.addStains([store.stains[0]], { defer: false });
    rDrift.flush();
    const driftDraws = rDrift.chunks.get('0|0,0')?.canvas._log.length ?? 0;
    check(driftDraws === 3, `snow-level-3: сугроб (lv=3) рисуется объёмно в 3 слоя (тень + масса + гребень, draws=${driftDraws})`);

    hooks._trail.footprints({ id: 'lv3-walker', x: 500, y: 450, width: 1, height: 1, elevation: 0 }, { x: 700, y: 450 });
    const bodyTrailStains = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR);
    const trenchOnly = bodyTrailStains.filter(s => s.lv !== SNOW_LEVEL.DRIFT);
    const footStainsInDrift = store.stains.filter(s => s.t === STAIN.FOOTPRINT);
    check(bodyTrailStains.length >= 2 && footStainsInDrift.length === 0 && trenchOnly.length === bodyTrailStains.length && trenchOnly.every(s => s.s >= 135),
      `snow-level-3: в глубоком сугробе остаётся широкий полноценный трейл от тела персонажа без создания новых сугробов вокруг (SMEAR=${bodyTrailStains.length}, s>=${trenchOnly[0]?.s})`);
    // Walking over the same trampled trench again does NOT stack duplicate stamps on top
    const beforeRepeat = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR).length;
    hooks._trail.footprints({ id: 'lv3-walker', x: 500, y: 450, width: 1, height: 1, elevation: 0 }, { x: 700, y: 450 });
    const afterRepeat = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR).length;
    check(afterRepeat === beforeRepeat,
      `snow-no-stack: повторный проход по протоптанному сугробу не наслаивает дубликаты траншеи (${beforeRepeat} -> ${afterRepeat})`);

    // Stepping out of snow onto bare ground does NOT track snowy footprints onto the dry floor
    store.clear({ broadcast: false });
    hooks._trail.forget('snow-exit-walker');
    for (let i = 0; i < 8; i++) {
      store.add([store.createStain({
        t: STAIN.DROPLETS, x: 520 + (i % 4) * 15, y: 485 + Math.floor(i / 4) * 20, s: 55, a: 0.85, c: SNOW_COLOR, m: 2, lv: SNOW_LEVEL.MEDIUM
      })], { broadcast: false });
    }
    hooks._trail.footprints({ id: 'snow-exit-walker', x: 500, y: 450, width: 1, height: 1, elevation: 0 }, { x: 900, y: 450 });
    const printsFarFromSnow = store.stains.filter(s => s.t === STAIN.FOOTPRINT && s.x > 640);
    check(printsFarFromSnow.length === 0,
      `snow-pixel-perfect: снежные следы не появляются там, где снега не было (вне пятна снега: ${printsFarFromSnow.length})`);
    store.clear({ broadcast: false });

    // Smart synchronization of snow trampling with token movement:
    //  - both short steps (2 cells) and long moves (6 cells) apply progressive delay d > 0 along the path;
    //  - teleportation (teleport: true / animate: false / movement.method === 'teleport') skips trampling completely
    store.add([
      store.createStain({ t: STAIN.SPLAT, x: 550, y: 550, s: 150, a: 0.72, c: SNOW_COLOR, m: 2, lv: 3 }),
      store.createStain({ t: STAIN.SPLAT, x: 650, y: 550, s: 150, a: 0.72, c: SNOW_COLOR, m: 2, lv: 3 }),
      store.createStain({ t: STAIN.SPLAT, x: 750, y: 550, s: 150, a: 0.72, c: SNOW_COLOR, m: 2, lv: 3 })
    ], { broadcast: false });
    hooks._trail.footprints(
      { id: 'smart-near', x: 500, y: 500, width: 1, height: 1, elevation: 0, actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
      { x: 700, y: 500 }
    );
    const nearTrenches = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SNOW_COLOR);
    check(nearTrenches.length >= 2 && nearTrenches.every(s => Number(s.d) > 0) && nearTrenches[nearTrenches.length - 1].d > nearTrenches[0].d,
      `snow-smart-move: при обычном шаге (2 клетки) протаптывание идёт прогрессивно вслед за токеном (d=${nearTrenches.map(s => s.d).join('→')} мс)`);
    store.clear({ broadcast: false });

    for (let gx = 550; gx <= 1150; gx += 100) {
      store.add([store.createStain({ t: STAIN.SPLAT, x: gx, y: 550, s: 150, a: 0.72, c: SNOW_COLOR, m: 2, lv: 3 })], { broadcast: false });
    }
    hooks._trail.footprints(
      { id: 'smart-far', x: 500, y: 500, width: 1, height: 1, elevation: 0, actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
      { x: 1150, y: 500 }
    );
    const farTrenches = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SNOW_COLOR);
    check(farTrenches.length >= 4 && farTrenches.every(s => Number(s.d) > 0) && farTrenches[farTrenches.length - 1].d > farTrenches[0].d,
      `snow-smart-move: при далёком перемещении (6.5 клеток) протаптывание также идёт прогрессивно вслед за токеном (штампов: ${farTrenches.length}, d=${farTrenches[0]?.d}..${farTrenches[farTrenches.length - 1]?.d} мс)`);
    store.clear({ broadcast: false });

    const tpDrift = store.createStain({ t: STAIN.SPLAT, x: 650, y: 550, s: 150, a: 0.72, c: SNOW_COLOR, m: 2, lv: 3 });
    store.add([tpDrift], { broadcast: false });
    hooks._trail.footprints(
      { id: 'smart-tp', x: 500, y: 500, width: 1, height: 1, elevation: 0, actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
      { x: 800, y: 500 },
      { teleport: true }
    );
    hooks._trail.footprints(
      { id: 'smart-tp2', x: 500, y: 500, width: 1, height: 1, elevation: 0, actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
      { x: 800, y: 500 },
      { animate: false }
    );
    const tpTrenches = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SNOW_COLOR);
    const tpDriftAfter = store.stains.find(s => s.i === tpDrift.i);
    check(tpTrenches.length === 0 && tpDriftAfter && tpDriftAfter.a === 0.72 && tpDriftAfter.s === 150,
      'snow-teleport: при телепорте токена протаптывание и следы полностью отсутствуют');
    store.clear({ broadcast: false });
  }

  // 1) Melting from fire/radiant/acid + spell template
  store.add([
    store.createStain({ t: STAIN.SPLAT, x: 400, y: 400, s: 120, a: 0.75, c: SNOW_COLOR, m: 2 }),
    store.createStain({ t: STAIN.SPLAT, x: 420, y: 410, s: 90, a: 0.45, c: SNOW_COLOR, m: 2 })
  ], { broadcast: false });
  const melted = meltSnowAt(store, 400, 400, 140, 1.2);
  check(melted === 2 && store.stains.filter(s => s.m === 2).length === 0,
    `snow-melt: огонь в эпицентре растопил сугробы (${melted})`);

  // dnd5e 4.x+ AoE region (Fireball): waits for a damage roll on placement, then melts snow strictly inside the radius
  store.add([
    store.createStain({ t: STAIN.SPLAT, x: 600, y: 600, s: 110, a: 0.7, c: SNOW_COLOR, m: 2 }),
    store.createStain({ t: STAIN.SPLAT, x: 980, y: 980, s: 110, a: 0.7, c: SNOW_COLOR, m: 2 })
  ], { broadcast: false });
  hooks._onCreateRegion({
    shapes: [{ type: 'circle', x: 600, y: 600, radius: 150 }],
    flags: { showstopper: { damageType: 'fire' } }
  });
  check(store.stains.filter(s => s.m === 2).length === 2,
    'snow-melt: до броска урона размещение AoE-региона снег не стирает');
  hooks._onRollDamage([{ options: { type: 'fire' } }]);
  const afterRegion = store.stains.filter(s => s.m === 2);
  check(afterRegion.length === 1 && afterRegion.every(s => s.x > 900),
    `snow-melt: после броска урона огненный AoE-регион растопил снег в радиусе, вне круга не тронул (${afterRegion.length})`);
  // Region without spell flags (trigger zone / manual markup) leaves snow untouched even after a damage roll
  hooks._onCreateRegion({ shapes: [{ type: 'circle', x: 980, y: 980, radius: 150 }] });
  hooks._onRollDamage([{ options: { type: 'fire' } }]);
  check(store.stains.some(s => s.m === 2),
    'snow-melt: регион без заклинательных флагов снег не трогает');
  // Real dnd5e 6.x path: flags.core.MeasuredTemplate + itemUuid (item name resolution) + damage roll
  const prevFromUuid = globalThis.fromUuidSync;
  globalThis.fromUuidSync = (uuid) => (uuid === 'Item.fireball' ? { name: 'Fireball' } : null);
  hooks._onCreateRegion({
    shapes: [{ type: 'circle', x: 980, y: 980, radius: 150 }],
    flags: { core: { MeasuredTemplate: true }, 'midi-qol': { itemUuid: 'Item.fireball' } }
  });
  hooks._onRollDamage([{ options: { type: 'fire' } }], { subject: { item: { uuid: 'Item.fireball', name: 'Fireball' } } });
  check(store.stains.filter(s => s.m === 2).length === 0,
    'snow-melt: регион фаербола dnd5e 6.x (MeasuredTemplate-флаг + itemUuid) растопил снег после броска урона');
  globalThis.fromUuidSync = prevFromUuid;
  // Elongated wall of fire (rect) melts a strip after the damage roll via a chain of circles along the major axis
  store.clear({ broadcast: false });
  store.add([
    store.createStain({ t: STAIN.SPLAT, x: 300, y: 300, s: 100, a: 0.8, c: SNOW_COLOR, m: 2 }),
    store.createStain({ t: STAIN.SPLAT, x: 700, y: 300, s: 100, a: 0.8, c: SNOW_COLOR, m: 2 })
  ], { broadcast: false });
  hooks._onCreateRegion({
    shapes: [{ type: 'rectangle', x: 100, y: 275, width: 1000, height: 50 }],
    flags: { showstopper: { damageType: 'fire' } }
  });
  hooks._onRollDamage([{ options: { type: 'fire' } }]);
  const afterWall = store.stains.filter(s => s.m === 2);
  check(afterWall.length === 2 && afterWall.every(s => s.a < 0.8 && s.s < 100),
    `snow-melt: стена огня (rect) опаляет полосу цепочкой кругов — снег проседает (a=${afterWall.map(s => s.a).join('/')})`);

  // 2) Shockwave (thunder/bludgeoning) and prone fall + cold frost
  store.add([store.createStain({ t: STAIN.SPLAT, x: 800, y: 800, s: 130, a: 0.8, c: SNOW_COLOR, m: 2 })], { broadcast: false });
  const blasted = blastSnowAt(store, 800, 800, 120, 1.0, 0, 0, { proneImprint: true });
  const afterBlast = store.stains.filter(s => s.m === 2);
  check(blasted === 1 && afterBlast.some(s => s.t === STAIN.SMEAR) && afterBlast.some(s => s.t === STAIN.SPLASH),
    'snow-blast: ударная волна/падение оставляет вмятину SMEAR и разбрасывает SPLASH');

  const frost = freezeSnowAt(store, 300, 300, 100, 0);
  check(frost && frost.m === 2 && store.stains.some(s => s.i === frost.i),
    'snow-freeze: урон холодом намораживает инеевое пятно');

  // Falling prone via ActiveEffect
  store.clear({ broadcast: false });
  store.add([store.createStain({ t: STAIN.SPLAT, x: 550, y: 550, s: 130, a: 0.75, c: SNOW_COLOR, m: 2 })], { broadcast: false });
  const proneActor = { id: 'act-prone', uuid: 'Actor.prone', system: { attributes: { hp: { value: 20, max: 40 } } } };
  const proneTok = {
    id: 'tok-prone', center: { x: 550, y: 550 }, actor: proneActor,
    document: { id: 'tok-prone', x: 500, y: 500, width: 1, height: 1, elevation: 0, actor: proneActor, scene: canvas.scene }
  };
  proneActor.getActiveTokens = () => [proneTok];
  hooks._onCreateActiveEffect({ name: 'Prone', statuses: new Set(['prone']), parent: proneActor });
  check(store.stains.some(s => s.m === 2 && s.t === STAIN.SMEAR),
    'snow-prone: получение статуса prone в снегу отпечатывает вмятину и разбрасывает снег');

  // 4) Trampling snowdrifts while walking (dynamic footpaths)
  store.clear({ broadcast: false });
  const drift = store.createStain({ t: STAIN.SPLAT, x: 600, y: 500, s: 180, a: 0.6, c: SNOW_COLOR, m: 2 });
  store.add([drift], { broadcast: false });
  const walkDoc = { id: 'walker', x: 500, y: 450, width: 1, height: 1, elevation: 0, actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } };
  hooks._trail.footprints(walkDoc, { x: 700, y: 450 });
  const driftAfter1 = store.stains.find(s => s.i === drift.i);
  check(driftAfter1 && driftAfter1.a < 0.6 && driftAfter1.s < 180,
    `snow-trample: проход по сугробу уменьшил его альфу (${driftAfter1?.a}) и размер (${driftAfter1?.s})`);
  // Repeated passes trample the drift all the way down to bare ground
  for (let k = 0; k < 5; k++) {
    hooks._trail.footprints({ ...walkDoc, x: 500 }, { x: 700, y: 450 });
  }
  check(!store.stains.some(s => s.i === drift.i),
    'snow-trample: многократный проход вытоптал сугроб до чистой земли');

  // 5) Drag furrow (prone / corpse dragged through snow)
  store.clear({ broadcast: false });
  store.add([store.createStain({ t: STAIN.SPLAT, x: 600, y: 500, s: 220, a: 0.75, c: SNOW_COLOR, m: 2 })], { broadcast: false });
  const dragDoc = {
    id: 'dragged', x: 500, y: 450, width: 1, height: 1, elevation: 0,
    actor: { statuses: new Set(['prone']), system: { attributes: { hp: { value: 30, max: 50 } } } }
  };
  hooks._trail.footprints(dragDoc, { x: 750, y: 450 });
  const furrows = store.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR);
  const footPrintsOnDrag = store.stains.filter(s => s.t === STAIN.FOOTPRINT);
  check(furrows.length >= 1 && footPrintsOnDrag.length === 0,
    `snow-furrow: ползущий/волочимый оставляет широкую борозду SMEAR (${furrows.length}) без отпечатков подошв`);

  // 6) Blood soaking into snow ("Crimson snow")
  store.clear({ broadcast: false });
  const snowPatch = store.createStain({ t: STAIN.SPLAT, x: 600, y: 500, s: 220, a: 0.8, c: SNOW_COLOR, m: 2 });
  store.add([snowPatch], { broadcast: false });
  const bleedActor = { id: 'ba1', system: { attributes: { hp: { value: 10, max: 100 } } } };
  const bleedDoc = {
    id: 'bt1', x: 500, y: 450, width: 1, height: 1, elevation: 0, actor: bleedActor
  };
  bleedDoc.object = { id: 'bt1', center: { x: 550, y: 500 }, document: bleedDoc, actor: bleedActor };
  hooks._trail.bleedingTrail(bleedDoc, { x: 750, y: 450 });
  const tintedSnow = store.stains.find(s => s.i === snowPatch.i);
  const bloodOnSnow = store.stains.filter(s => !s.m);
  check(bloodOnSnow.length >= 1 && tintedSnow && tintedSnow.c !== SNOW_COLOR,
    `blood-on-snow: кровь впиталась в снег и окрасила сугроб (${tintedSnow?.c})`);

  // 8) Door snow sweeping — ALL 5 door animation types (swing, slide, ascend, descend, swirl) + double
  for (const animType of ['swing', 'slide', 'ascend', 'descend', 'swirl']) {
    store.clear({ broadcast: false });
    store.add([
      store.createStain({ t: STAIN.SPLAT, x: 540, y: 520, s: 90, a: 0.75, c: SNOW_COLOR, m: 2 }),
      store.createStain({ t: STAIN.SPLAT, x: 560, y: 490, s: 90, a: 0.75, c: SNOW_COLOR, m: 2 })
    ], { broadcast: false });
    const doorDoc = {
      id: `door-${animType}`,
      c: [500, 500, 600, 500],
      door: 1,
      ds: 1,
      animation: { type: animType, direction: 1, double: animType === 'swing', strength: 1 }
    };
    const res = sweepDoorSnow(store, doorDoc, { ds: animType === 'ascend' ? 0 : 1 }, { prevDs: animType === 'ascend' ? 1 : 0 });
    check(res.cleared >= 1 && res.piled >= 1 && res.type === animType,
      `door-snow [${animType}]: дверь расчистила снег (cleared=${res.cleared}, piled=${res.piled})`);
  }
  // Locking/unlocking a closed door (0 ↔ 2) does not move the leaf or disturb snow
  store.clear({ broadcast: false });
  store.add([store.createStain({ t: STAIN.SPLAT, x: 550, y: 500, s: 90, a: 0.75, c: SNOW_COLOR, m: 2 })], { broadcast: false });
  const lockRes = sweepDoorSnow(store, { id: 'door-lock', c: [500, 500, 600, 500], door: 1, ds: 2 }, { ds: 0 }, { prevDs: 2 });
  check(lockRes.cleared === 0 && store.count === 1,
    'door-snow: снятие замка (2→0) не двигает створку и не сметает снег');

  hooks.dispose();
}

// Fade in a DENSE chunk: two-layer bake — each step draws the active layer, not the whole chunk
{
  const store = new BloodStore(game.scenes.get('scene1'));
  const r = new BloodRenderer({ scale: 0.5 });
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push(store.createStain({ x: 100 + (i % 8) * 40, y: 100 + ((i / 8) | 0) * 40, s: 60, seed: 500 + i, c: '#a51414d8' }));
  }
  r.addStains(many, { defer: false });
  r.flush();
  const chunk = r.chunks.get('0|0,0');
  const staticLen = chunk.canvas._log.length;
  check(staticLen > 60, `fade2: плотный чанк запечён (${staticLen} draw)`);
  r.addStains([store.createStain({ x: 150, y: 150, s: 60, f: 900, seed: 999, c: '#a51414d8' })]);
  await new Promise(res => setTimeout(res, 30));
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
  r.flush();
  check(chunk.base != null, 'fade2: база двухслойной выпечки построена');
  const duringFade = chunk.canvas._log.length - staticLen;
  // Each repaint = base blit + ONE stain with satellites (<= 13); a full bake
  // would draw 61 per step; 3 repaints × 13 = 39 is the tight upper bound
  check(duringFade > 0 && duringFade <= 39,
    `fade2: шаг fade рисует активный слой, а не все 61 пятно (${duringFade})`);
  await new Promise(res => setTimeout(res, 1000));
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
  r.flush();
  check(r._fading.size === 0 && chunk.base === null, 'fade2: fade завершён — база сброшена, финал запечён полным бейком');
}

// 18. Settings window ↔ registered keys: every section field must resolve its
//     matching blood<Field> setting (unprefixed keys once crashed _prepareContext)
//     + token blood color priority
{
  const registered = new Set();
  const savedRegister = game.settings.register;
  game.settings.register = (m, k) => registered.add(k);
  const initHooks = [];
  const savedOnce = Hooks.once;
  Hooks.once = (h, fn) => { if (h === 'init') initHooks.push(fn); };
  try {
    await import(`${root}/scripts/blood/entry.mjs`);
    for (const fn of initHooks) fn(); // init: register settings + snow region behavior
    const { BLOOD_SETTING_SECTIONS } = await import(`${root}/scripts/blood/settings-app.mjs`);
    const missing = [];
    for (const sec of BLOOD_SETTING_SECTIONS) {
      for (const f of sec.fields) {
        const key = `blood${f.key[0].toUpperCase()}${f.key.slice(1)}`;
        if (!registered.has(key)) missing.push(key);
      }
    }
    check(missing.length === 0,
      `settings: все поля окна находят свои настройки (${missing.length ? 'нет: ' + missing.join(', ') : 'ок'})`);
  } finally {
    Hooks.once = savedOnce;
    game.settings.register = savedRegister;
  }

  const TC = await import(`${root}/scripts/blood/token-color.mjs`);
  // Brush/HUD: baseline check that the module IMPORTS and exports its contract
  // (DOM instantiation requires a live document — out of scope for smoke)
  {
    const BR = await import(`${root}/scripts/blood/brush.mjs`);
    const HUD = await import(`${root}/scripts/blood/hud.mjs`);
    const ELV = await import(`${root}/scripts/blood/elevation.mjs`);
    check(typeof BR.BloodBrush === 'function' && typeof HUD.createBrushHUD === 'function',
      'brush: модуль кисти и HUD импортируются, контракт на месте');

    // Held-LMB pointer lifecycle + UI press guard + non-opaque tile overlay mask order
    const hStore = new BloodStore(game.scenes.get('scene1'));
    const hRend = new BloodRenderer({ scale: 0.5 });
    const view = canvas.app.view;
    const savedGetRect = view.getBoundingClientRect;
    const savedSetCap = view.setPointerCapture;
    const savedRelCap = view.releasePointerCapture;
    const savedActiveEl = document.activeElement;
    view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    view.setPointerCapture = () => {};
    view.releasePointerCapture = () => {};
    document.activeElement = document.body;

    const holdBrush = new BR.BloodBrush(() => hStore, () => hRend);
    holdBrush.active = true;
    holdBrush.mode = 'paint';
    settingsStore.set('bloodBrushMaterial', 0);
    settingsStore.set('bloodBrushSize', 120);
    settingsStore.set('bloodBrushDensity', 2);
    settingsStore.set('bloodBrushAlpha', 0.9);
    try {
      const ev = (x, y, extra = {}) => ({
        button: 0,
        pointerId: 7,
        pointerType: 'mouse',
        buttons: 1,
        clientX: x,
        clientY: y,
        shiftKey: false,
        altKey: false,
        target: view,
        preventDefault() {},
        stopPropagation() {},
        ...extra
      });
      holdBrush._onPointerDown(ev(100, 100));
      const startDefs = holdBrush._stroke?.defs?.length ?? 0;
      const firstHasNoDelay = startDefs > 0 && holdBrush._stroke.defs[0].d === undefined;

      holdBrush._onPointerMove(ev(160, 100));
      holdBrush._onPointerMove(ev(220, 100));
      const midDefs = holdBrush._stroke?.defs?.length ?? 0;

      // Secondary pointer (e.g. palm touch / pen / stray HID) must NOT kill held LMB stroke
      holdBrush._onPointerMove(ev(230, 100, { pointerId: 99, buttons: 0 }));
      holdBrush._onPointerCancel(ev(230, 100, { pointerId: 99, buttons: 0 }));
      const survivedStray = holdBrush._stroke?.pointerId === 7;

      // Transient blur / endStroke while LMB remains held over canvas resumes seamlessly on next move
      holdBrush._endStroke();
      const committedBeforeResume = hStore.count;
      holdBrush._onPointerMove(ev(280, 100));
      holdBrush._onPointerMove(ev(340, 100));
      const resumedDefs = holdBrush._stroke?.defs?.length ?? 0;
      holdBrush._onPointerUp(ev(340, 100, { buttons: 0 }));

      // Press initiated on UI control must NOT hijack subsequent pointermove onto canvas
      holdBrush._onPointerDown(ev(50, 50, { target: { closest: () => null } }));
      holdBrush._onPointerMove(ev(380, 100));
      const uiDidNotPaint = holdBrush._stroke === null;
      holdBrush._onPointerUp(ev(380, 100, { buttons: 0 }));

      check(
        firstHasNoDelay && midDefs > startDefs && survivedStray &&
        committedBeforeResume === midDefs && resumedDefs > 0 && uiDidNotPaint,
        `brush-hold: зажатая ЛКМ непрерывно рисует без задержки d (${startDefs}→${midDefs}), игнорирует чужой pointerId, авто-возобновляется после срыва (+${resumedDefs}) и не цепляет перетаскивание с HUD`
      );

      // Hover passthrough during active & resumed brush strokes + cursor class + drawings hover suppression
      const viewClasses = new Set();
      const savedClassList = view.classList;
      const savedDrawings = canvas.drawings;
      const savedMouseMgr = canvas.currentMouseManager;
      let cancelCount = 0;
      view.classList = {
        toggle: (cls, force) => {
          const next = force !== undefined ? Boolean(force) : !viewClasses.has(cls);
          if (next) viewClasses.add(cls);
          else viewClasses.delete(cls);
          return next;
        },
        contains: (cls) => viewClasses.has(cls)
      };
      canvas.drawings = { active: true, interactiveChildren: true, hover: { id: 'drw1' } };
      canvas.currentMouseManager = { cancel: () => { cancelCount++; } };
      try {
        holdBrush._applyCursor(true);
        holdBrush._setCanvasHoverPassthrough(true);
        const classAdded = view.classList.contains('ss-blood-brush-active');
        const drawingsSuppressed = canvas.drawings.interactiveChildren === false && canvas.drawings.hover === null;

        const docSeen = { down: 0, moveActive: 0, moveResume: 0 };
        const dispatch = (handler, e, kind) => {
          let stopped = false;
          const wrapped = { ...e, preventDefault() {}, stopPropagation() { stopped = true; } };
          handler.call(holdBrush, wrapped);
          if (!stopped) docSeen[kind]++;
          return stopped;
        };

        const downStopped = dispatch(holdBrush._onPointerDown, ev(120, 120), 'down');
        const moveActiveStopped = dispatch(holdBrush._onPointerMove, ev(190, 120), 'moveActive');
        // Force seamless-continuation path while mouse button stays held
        holdBrush._endStroke();
        const moveResumeStopped = dispatch(holdBrush._onPointerMove, ev(260, 120), 'moveResume');
        holdBrush._onPointerUp(ev(260, 120, { buttons: 0 }));

        holdBrush._setCanvasHoverPassthrough(false);
        holdBrush._applyCursor(false);
        const classRemoved = !view.classList.contains('ss-blood-brush-active');
        const drawingsRestored = canvas.drawings.interactiveChildren === true;

        check(
          downStopped && docSeen.down === 0 &&
          !moveActiveStopped && docSeen.moveActive === 1 &&
          !moveResumeStopped && docSeen.moveResume === 1 &&
          cancelCount >= 2 &&
          classAdded && classRemoved &&
          drawingsSuppressed && drawingsRestored,
          `brush-hover-passthrough: pointerdown на #board перехватывается, но pointermove при активном мазке (doc=${docSeen.moveActive}) и авто-возобновлении (doc=${docSeen.moveResume}) свободно доходят до PIXI, drawings.hover подавляется и класс курсора переключается`
        );
      } finally {
        view.classList = savedClassList;
        canvas.drawings = savedDrawings;
        canvas.currentMouseManager = savedMouseMgr;
      }
    } finally {
      holdBrush.active = false;
      holdBrush.mode = null;
      view.getBoundingClientRect = savedGetRect;
      view.setPointerCapture = savedSetCap;
      view.releasePointerCapture = savedRelCap;
      document.activeElement = savedActiveEl;
      hRend.destroy();
    }

    // Non-opaque tile overlay + surfaceAt visibility guard
    const savedTiles = canvas.tiles.placeables;
    const oStore = new BloodStore(game.scenes.get('scene1'));
    const oRend = new BloodRenderer({ scale: 0.5 });
    const hiddenTile = {
      visible: false,
      document: { id: 'hiddenTile', hidden: false, x: 200, y: 200, width: 300, height: 300, elevation: 10 },
      mesh: { visible: false, containsCanvasPoint: () => true }
    };
    const alphaData = new Uint8Array(10000).fill(255);
    alphaData[0] = 0; // non-opaque -> _allOpaque(mesh) === false
    const alphaTile = {
      visible: true,
      document: { id: 'alphaTile', hidden: false, x: 400, y: 400, width: 900, height: 900, elevation: 0, rotation: 0 },
      mesh: Object.assign(new FakeObservable(), {
        width: 900, height: 900,
        scale: { x: 1, y: 1 },
        anchor: { x: 0.5, y: 0.5 },
        texture: { uuid: 'tex-non-opaque', width: 200, height: 200, orig: { width: 200, height: 200 }, frame: { x: 0, y: 0 }, baseTexture: { resource: { source: { _tag: 'alphaSrc' } } } },
        _textureAlphaData: { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100, data: alphaData }
      })
    };
    canvas.tiles.placeables = [hiddenTile, alphaTile];
    const maskCalls = [];
    const origMask = oRend._maskOverlay.bind(oRend);
    oRend._maskOverlay = (rec, mesh, clip) => {
      maskCalls.push({ k: rec.k, lx0: rec.lx0, ly0: rec.ly0, lw: rec.lw, lh: rec.lh });
      return origMask(rec, mesh, clip);
    };
    try {
      canvas.tiles.placeables = [hiddenTile];
      const hiddenSurf = ELV.surfaceAt(250, 250, 20);
      canvas.tiles.placeables = [hiddenTile, alphaTile];
      oRend.addStains([oStore.createStain({ t: STAIN.SPLAT, x: 220, y: 220, s: 80, a: 0.9, c: '#a51414d8', tid: 'alphaTile' })], { defer: false });
      oRend.flush();
      oRend.addStains([oStore.createStain({ t: STAIN.SMEAR, x: 640, y: 640, s: 80, a: 0.9, c: '#a51414d8', tid: 'alphaTile' })], { defer: false });
      oRend.flush();
      check(
        hiddenSurf.tid === null &&
        maskCalls.length === 2 &&
        maskCalls[0].k > 0 &&
        maskCalls[1].k > 0 &&
        maskCalls[1].lw > maskCalls[0].lw,
        `overlay-mask: скрытый тайл игнорируется surfaceAt, а _maskOverlay получает актуальные rec.k/lx0/lw на первом (${maskCalls[0]?.lw}px, k=${maskCalls[0]?.k}) и расширенном (${maskCalls[1]?.lw}px, k=${maskCalls[1]?.k}) ребейках`
      );
    } finally {
      canvas.tiles.placeables = savedTiles;
      oRend.destroy();
    }

    // Roof hover-fade / occlusion synchronization on tile overlay sprites (rec.sprite)
    const savedProtoUpdate = PIXI.Sprite.prototype.updateTransform;
    const savedProtoRender = PIXI.Sprite.prototype._render;
    let overlayRenderCalls = 0;
    PIXI.Sprite.prototype.updateTransform = function () {
      this.worldAlpha = this.alpha * (this.parent?.worldAlpha ?? 1);
    };
    PIXI.Sprite.prototype._render = function () {
      overlayRenderCalls++;
    };
    const fRend = new BloodRenderer({ scale: 0.5 });
    const fStore = new BloodStore(game.scenes.get('scene1'));
    try {
      const roofMesh = Object.assign(new FakeObservable(), {
        width: 400, height: 400,
        worldAlpha: 1,
        unoccludedAlpha: 1,
        occludedAlpha: 0,
        _hoverFadeState: { occlusion: 0 },
        _occlusionState: { fade: 0 },
        scale: { x: 1, y: 1 },
        anchor: { x: 0.5, y: 0.5 },
        texture: { uuid: 'tex-roof-opaque', width: 200, height: 200, orig: { width: 200, height: 200 }, frame: { x: 0, y: 0 }, baseTexture: { resource: { source: { _tag: 'roofSrc' } } } },
        _textureAlphaData: { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100, data: new Uint8Array(10000).fill(255) }
      });
      const roofTile = {
        visible: true,
        document: { id: 'roofFadeTile', hidden: false, x: 200, y: 200, width: 400, height: 400, elevation: 10, alpha: 1, occlusion: { alpha: 0 } },
        mesh: roofMesh
      };
      canvas.tiles.placeables = [roofTile];
      fRend.addStains([fStore.createStain({ t: STAIN.SPLAT, x: 200, y: 200, s: 80, a: 0.9, c: '#a51414d8', e: 10, tid: 'roofFadeTile' })], { defer: false });
      fRend.flush();
      const rec = fRend._overlays.get('roofFadeTile');
      const spr = rec?.sprite;

      spr.updateTransform();
      spr._render();
      const alphaAt0 = spr.alpha;

      roofMesh._hoverFadeState.occlusion = 0.5;
      spr.updateTransform();
      spr._render();
      const alphaAtHalf = spr.alpha;

      roofMesh._hoverFadeState.occlusion = 1;
      spr.updateTransform();
      spr._render();
      const alphaAtFull = spr.alpha;
      const callsAfterFull = overlayRenderCalls;

      // Fade back in from full occlusion: updateTransform MUST lift worldAlpha above 0 again
      roofMesh._hoverFadeState.occlusion = 0.25;
      spr.updateTransform();
      const worldAlphaBack = spr.worldAlpha;
      spr._render();

      check(
        Math.abs(alphaAt0 - 1) < 1e-6 &&
        Math.abs(alphaAtHalf - 0.5) < 1e-6 &&
        alphaAtFull === 0 &&
        callsAfterFull === 2 &&
        Math.abs(worldAlphaBack - 0.75) < 1e-6 &&
        overlayRenderCalls === 3,
        `overlay-hover-fade: альфа оверлея синхронизирована со скрытием крыши (${alphaAt0} -> ${alphaAtHalf} -> ${alphaAtFull}, обратный возврат=${worldAlphaBack}, вызовов _render=${overlayRenderCalls})`
      );
    } finally {
      canvas.tiles.placeables = savedTiles;
      if (savedProtoUpdate === undefined) delete PIXI.Sprite.prototype.updateTransform;
      else PIXI.Sprite.prototype.updateTransform = savedProtoUpdate;
      if (savedProtoRender === undefined) delete PIXI.Sprite.prototype._render;
      else PIXI.Sprite.prototype._render = savedProtoRender;
      fRend.destroy();
    }
  }
  if (hasPlus) {
    const BR = await import(`${root}/scripts/blood/brush.mjs`);
    const { SNOW_LEVEL, snowLevelAt } = await import(`${root}/plus/scripts/blood/snow.mjs`);

    // Unified snow brush: any subtype automatically coerces to 'splat', and each
    // new LMB press over existing snow raises the depth level by +1 (1 -> 2 -> 3 -> 4 -> 5)
    const bStore = new BloodStore(game.scenes.get('scene1'));
    const bRend = new BloodRenderer({ scale: 0.5 });
    const brush = new BR.BloodBrush(() => bStore, () => bRend);
    brush._setParams({ material: 2, type: 'pool', size: 120, density: 2, alpha: 0.85, color: '#e8ecf2e0' });
    check(brush._params().type === 'splat',
      'brush-snow: при выборе снега тип кисти автоматически устанавливается в единую кисть снега (splat)');
    brush._setParams({ type: 'droplet' });
    check(brush._params().type === 'splat',
      'brush-snow: для снега действует единая кисть без разделения на подтипы');

    // Stepwise snow buildup across LMB presses with the unified brush: 1st stroke -> lv=1, 2nd -> lv=2, 3rd -> lv=3
    brush._stroke = { lx: 300, ly: 300, travel: 0, defs: [], lastE: null, moved: false };
    brush._stamp(300, 300, null);
    brush._stamp(300, 300, null);
    bStore.add(brush._stroke.defs, { broadcast: false });
    const lvStroke1 = snowLevelAt(bStore, 300, 300, 0);
    brush._stroke = { lx: 300, ly: 300, travel: 0, defs: [], lastE: null, moved: false };
    brush._stamp(300, 300, null);
    bStore.add(brush._stroke.defs, { broadcast: false });
    const lvStroke2 = snowLevelAt(bStore, 300, 300, 0);
    brush._stroke = { lx: 300, ly: 300, travel: 0, defs: [], lastE: null, moved: false };
    brush._stamp(300, 300, null);
    bStore.add(brush._stroke.defs, { broadcast: false });
    const lvStroke3 = snowLevelAt(bStore, 300, 300, 0);
    check(
      lvStroke1 === SNOW_LEVEL.LIGHT &&
      lvStroke2 === SNOW_LEVEL.MEDIUM &&
      lvStroke3 === SNOW_LEVEL.DRIFT,
      `brush-snow: единая кисть снега по зажатиям ЛКМ последовательно создаёт уровни lv=${lvStroke1} (LIGHT) → lv=${lvStroke2} (MEDIUM) → lv=${lvStroke3} (DRIFT)`
    );

    // 2b) Unified Blood Brush: normalizes legacy subtypes, adaptive stationary splat + directional drag smears,
    //     permanent flag (noWash), and spot/selective eraser
    bStore.clear({ broadcast: false });
    brush._setParams({ material: 0, type: 'footprint' });
    check(brush._params().type === 'splat',
      'brush-blood: устаревший тип footprint нормализуется в единую кисть (splat)');
    brush._setParams({ type: 'handprint' });
    check(brush._params().type === 'splat',
      'brush-blood: устаревший тип handprint нормализуется в единую кисть (splat)');

    brush._setParams({ material: 0, size: 100, density: 3, alpha: 0.85, color: '#a51414d8', noWash: true });
    brush._stroke = { lx: 200, ly: 200, travel: 0, defs: [], lastE: null, moved: false, stepIndex: 0 };
    brush._stamp(200, 200, null);
    bStore.add(brush._stroke.defs, { broadcast: false });
    check(
      brush._stroke.defs.length === 3 &&
      brush._stroke.defs[0].t === STAIN.SPLAT &&
      brush._stroke.defs[0].nw === 1 &&
      typeof brush._stroke.defs[0].T === 'number' &&
      !brush._stroke.defs.some(d => d.t === STAIN.FOOTPRINT || d.t === STAIN.HANDPRINT),
      'brush-blood: одиночный клик (size=100, density=3) создаёт SPLAT + сателлиты с nw=1 и меткой времени T без следов рук/ног'
    );

    brush._setParams({ noWash: false });
    brush._stroke = { lx: 300, ly: 300, travel: 0, defs: [], lastE: null, moved: true, stepIndex: 0 };
    brush._stamp(300, 300, Math.PI / 4);
    brush._stamp(340, 340, Math.PI / 4);
    brush._stamp(380, 380, Math.PI / 4);
    bStore.add(brush._stroke.defs, { broadcast: false });
    check(
      brush._stroke.defs.some(d => d.t === STAIN.SMEAR) &&
      brush._stroke.defs.some(d => d.t === STAIN.SPLAT) &&
      brush._stroke.defs.some(d => d.t === STAIN.DROPLETS || d.t === STAIN.SPLASH) &&
      !brush._stroke.defs.some(d => d.t === STAIN.FOOTPRINT || d.t === STAIN.HANDPRINT),
      'brush-blood: мазок (drag) комбинирует SMEAR + SPLAT + сателлиты вдоль направления без отпечатков ладоней и шагов'
    );

    // Material-selective eraser (eraseMatOnly / Shift) and single click (force: true):
    // both snow (m=2) and blood (m=0) overlap at (750, 750) — erase ONLY blood
    const snowStain = bStore.createStain({ t: STAIN.POOL, x: 750, y: 750, s: 120, r: 0, a: 0.65, c: '#e8ecf2e0', m: 2, e: 15 });
    const bloodOverSnow = bStore.createStain({ t: STAIN.SPLAT, x: 750, y: 750, s: 90, r: 0, a: 0.85, c: '#a51414d8', e: 15 });
    bStore.add([snowStain, bloodOverSnow], { broadcast: false });
    brush._setParams({ material: 0, size: 120, elev: 0, eraseMatOnly: true });
    brush._erase(750, 750, { force: true });
    brush._flushEraseRemovals();
    const remainAt750 = bStore.queryCircle(750, 750, 50);
    check(
      remainAt750.length === 1 && remainAt750[0].m === 2,
      'brush-trail: селективный ластик (eraseMatOnly + одиночный клик force=true) стёр кровь, не задев снег под ней'
    );
    brush._setParams({ eraseMatOnly: false });

    // Selective material clear (clearMaterialSilent): removes only snow (m=2), keeping blood (m=0)
    const countBeforeClearMat = bStore.count;
    const removedSnowCount = brush.clearMaterialSilent(2);
    check(
      removedSnowCount === 1 && bStore.count === countBeforeClearMat - 1 && !bStore.stains.some(s => s.m === 2),
      'brush-trail: clearMaterialSilent(2) очищает со сцены только выбранное вещество, не трогая остальные'
    );

    // 3) Scalability stress test (10k+ stains, giant s=4000 stain, applyBatch, and Dirty-Rect partial bake)
    const pStore = new BloodStore(game.scenes.get('scene1'));
    const pRend = new BloodRenderer({ scale: 0.5 });
    pStore.setRenderer(pRend);
    const bulk = [];
    for (let k = 0; k < 5000; k++) {
      bulk.push(pStore.createStain({
        t: STAIN.DROPLETS,
        x: (k % 100) * 80,
        y: Math.floor(k / 100) * 80,
        s: 80,
        a: 0.85,
        c: '#e8ecf2e0',
        m: 2,
        lv: 3
      }));
    }
    const giant = pStore.createStain({ t: STAIN.POOL, x: 5000, y: 5000, s: 4000, a: 0.9, c: '#a51414d8', m: 0 });
    bulk.push(giant);
    pStore.add(bulk, { broadcast: false, persist: false });
    pRend.flush();
    // Finish baking initial chunks
    while (pRend._dirty.size) pRend.flush();
    check(pStore.snowCount(false) === 5000, 'perf: живой O(1) счётчик snowCount точен на 5000 снежных пятнах');
    const hitGiant = pStore.queryCircle(5900, 5000, 50);
    check(hitGiant.some(s => s.i === giant.i), 'perf: крупное пятно (s=4000 > FAST_MAX_S) находится на краю через мульти-ячеечный индекс');

    // Progressive trampling (d > 0) via applyBatch MUST NOT dirty chunks on frame 0
    const s0 = bulk[0];
    pStore.applyBatch({
      replace: [{ ...s0, a: 0.5, s: 65, lv: 2, d: 200 }],
      add: [pStore.createStain({ t: STAIN.SMEAR, x: s0.x, y: s0.y, s: 120, a: 0.78, c: '#9aa4b4d0', m: 2, d: 200 })]
    }, { broadcast: false, persist: false });
    check(pRend._dirty.size === 0, 'perf: отложенное протаптывание (d > 0) через applyBatch не вызывает холостой ре-бейк чанков на 0-м кадре');

    // Walking through drifts (lv=3, adding a SMEAR trench without mutating the drift) reuses chunk.snowBase
    // and performs 0 _drawStain calls on the drifts themselves!
    let driftDrawCalls = 0;
    const origDraw = pRend._drawStain.bind(pRend);
    pRend._drawStain = (ctx, st) => { driftDrawCalls++; return origDraw(ctx, st); };
    pStore.add([pStore.createStain({ t: STAIN.SMEAR, x: bulk[2].x, y: bulk[2].y, s: 120, a: 0.78, c: '#9aa4b4d0', m: 2 })], { broadcast: false, persist: false });
    pRend.flush();
    pStore.add([pStore.createStain({ t: STAIN.SMEAR, x: bulk[3].x, y: bulk[3].y, s: 120, a: 0.78, c: '#9aa4b4d0', m: 2 })], { broadcast: false, persist: false });
    pRend.flush();
    check(driftDrawCalls === 0,
      `perf: кэш chunk.snowBase позволяет протаптывать сугробы за 0 вызовов _drawStain (вызовов: ${driftDrawCalls})`);

    // Immediate local indentation mutating a stain (lv=1/2) in an already baked dense chunk uses Dirty-Rect
    let drawCalls = 0;
    pRend._drawStain = (ctx, st) => { drawCalls++; return origDraw(ctx, st); };
    const chunk0Key = '0|0,0';
    const chunk0Total = pRend._membersSorted(chunk0Key).length;
    pStore.applyBatch({
      replace: [{ ...bulk[1], a: 0.5, s: 65, lv: 2 }],
      add: [pStore.createStain({ t: STAIN.FOOTPRINT, x: bulk[1].x, y: bulk[1].y, s: 46, a: 0.75, c: '#9aa4b4d0', m: 2 })]
    }, { broadcast: false, persist: false });
    pRend.flush();
    pRend._drawStain = origDraw;
    check(drawCalls > 0 && drawCalls < chunk0Total * 0.5,
      `perf: Dirty-Rect частичный бейк перерисовал только локальную окрестность шага (${drawCalls} вызовов вместо ${chunk0Total * 2})`);

    // refreshAging check: hourly time advance rebakes ONLY the blood-containing chunk (giant),
    // leaving pure snow chunks (5000 snow stains) completely untouched!
    pRend.refreshAging();
    const dirtyFromAging = pRend._dirty.size;
    check(dirtyFromAging > 0 && dirtyFromAging < pRend.chunks.size && !pRend._dirty.has('0|0,0'),
      `perf: refreshAging при перемотке времени пачкает только чанки с кровью (${dirtyFromAging} вместо ${pRend.chunks.size}), не трогая снежные чанки`);

    // Guard against synchronous GM socket self-echo (applyRemote ignores ops where ops.from === game.user.id)
    const prevUserId = game.user.id;
    game.user.id = 'gm-1';
    const countBeforeSelfEcho = pStore.count;
    pStore.applyRemote({
      from: 'gm-1',
      sceneId: pStore.sceneId,
      remove: [bulk[10].i],
      add: [pStore.createStain({ t: STAIN.SPLAT, x: 10, y: 10, s: 50 })]
    });
    game.user.id = prevUserId;
    check(pStore.count === countBeforeSelfEcho && pStore.stains.some(s => s.i === bulk[10].i),
      'perf: applyRemote игнорирует собственное эхо сокета отправителя (from === game.user.id)');
    pRend.destroy();

    // 4) Regression for inter-chunk seam (Bug #1) and transient snow pop (Bug #2):
    //    the upper chunk (0|0,0: snow + blood) and lower chunk (0|0,1: snow only) must use
    //    an identical trench compositing pipeline (destination-out 0.18 + source-over 0.88),
    //    and adding a non-trench stain into a trenched chunk must not erase existing snow!
    const sStore = new BloodStore(game.scenes.get('scene1'));
    const sRend = new BloodRenderer({ scale: 0.5 });
    sStore.setRenderer(sRend);
    sStore.add([
      // Chunk 0|0,0: snowdrift + blood droplet
      sStore.createStain({ t: STAIN.SPLAT, x: 500, y: 800, s: 300, a: 0.9, c: '#e8ecf2e0', m: 2, lv: 3 }),
      sStore.createStain({ t: STAIN.DROPLETS, x: 850, y: 800, s: 45, a: 0.85, c: '#a51414d8', m: 0 }),
      // Chunk 0|0,1: snowdrift only (no blood)
      sStore.createStain({ t: STAIN.SPLAT, x: 500, y: 1200, s: 300, a: 0.9, c: '#e8ecf2e0', m: 2, lv: 3 }),
    ], { broadcast: false, persist: false });
    sRend.flush();
    // Carve a snow trench across the boundary between both chunks
    const cTop = sRend.chunks.get('0|0,0');
    const cBot = sRend.chunks.get('0|0,1');
    const opsTop = [];
    const opsBot = [];
    const origDrawImgTop = cTop.ctx.drawImage.bind(cTop.ctx);
    const origDrawImgBot = cBot.ctx.drawImage.bind(cBot.ctx);
    cTop.ctx.drawImage = function (...args) {
      opsTop.push(`${this.globalCompositeOperation}:${Number(this.globalAlpha).toFixed(2)}`);
      return origDrawImgTop(...args);
    };
    cBot.ctx.drawImage = function (...args) {
      opsBot.push(`${this.globalCompositeOperation}:${Number(this.globalAlpha).toFixed(2)}`);
      return origDrawImgBot(...args);
    };
    const trenchTop = sStore.createStain({ t: STAIN.SMEAR, x: 500, y: 940, s: 150, a: 0.78, c: '#9aa4b4d0', m: 2, lv: 2 });
    const trenchBot = sStore.createStain({ t: STAIN.SMEAR, x: 500, y: 1100, s: 150, a: 0.78, c: '#9aa4b4d0', m: 2, lv: 2 });
    sStore.add([trenchTop, trenchBot], { broadcast: false, persist: false });
    sRend.flush();
    check(opsTop.join(',') === opsBot.join(',') && opsTop.includes('source-over:0.88'),
      `snow-seam: верхний чанк (с кровью) и нижний чанк (чистый снег) используют идентичный композитинг (${opsTop.join(' → ')})`);
    check(sRend._stainSpanRadius(trenchTop) >= 150 * 1.22 + 16,
      'snow-pop: радиус охвата снежной траншеи покрывает её широкие 1.38× валики');

    // Adding a droplet far from the trench inside a trenched chunk MUST NOT skip blitting snowBase
    opsBot.length = 0;
    sStore.add([
      sStore.createStain({ t: STAIN.DROPLETS, x: 200, y: 1800, s: 40, a: 0.85, c: '#e8ecf2e0', m: 2, lv: 1 })
    ], { broadcast: false, persist: false });
    sRend.flush();
    check(opsBot.length >= 1 && opsBot[0] === 'source-over:1.00',
      'snow-pop: добавление обычного пятна в чанк с траншеей сохраняет snowBase в drect');
    sRend.destroy();

    // 8. Verify 4 snow features:
    //  (1) Snowfall amount scales with elapsed time (30 min -> light dusting, multiple days -> entire map blanketed immediately)
    //  (2) Multiple snowdrift height tiers (lv=3, lv=4, lv=5) with progressive 3/4/5-layer rendering
    //  (3) Gradual burial of old trampled paths under fresh snow (from both brush strokes and snowfall)
    //  (4) Melting snow with fire spells in Foundry VTT v14 + dnd5e 6.0.0 (Region, MeasuredTemplate, dnd5e.preCalculateDamage with Set, dnd5e.postUseActivity)
    const {
      SnowAccumulator: SnowAcc2, SNOW_LEVEL: SL2, SNOW_COLOR: SC2, SNOW_SHADOW_COLOR: SSC2,
      snowLevelAt: sLvAt2, meltSnowAt: melt2, burySnowTracksAt: bury2
    } = await import(`${root}/plus/scripts/blood/snow.mjs`);
    const { BloodBrush: Brush2 } = await import(`${root}/scripts/blood/brush.mjs`);
    const { BloodEventHooks: Hooks2 } = await import(`${root}/scripts/blood/events.mjs`);

    // (1) Snowfall scaling with elapsed time (30 min vs multiple days)
    {
      const savedSc = canvas.scene;
      const tScene = game.scenes.get('scene1');
      tScene.weather = 'snow';
      tScene.width = 1000;
      tScene.height = 1000;
      canvas.scene = tScene;
      const tStore = new BloodStore(tScene);
      const tSnow = new SnowAcc2(() => tStore);
      try {
        tSnow._state = { t: 1000, frac: 0, q: 0, thawFrac: 0, thawQ: 0 };
        tSnow._onWorldTime(1000 + 1800, 1800); // +30 minutes
        tSnow._drain();
        const snow30m = tStore.stains.filter(s => s.m === 2);
        const count30m = snow30m.length;
        const maxLv30m = snow30m.reduce((m, s) => Math.max(m, s.lv || 1), 0);
        const q30_1 = snow30m.some(p => p.x < 500 && p.y < 500);
        const q30_2 = snow30m.some(p => p.x >= 500 && p.y < 500);
        const q30_3 = snow30m.some(p => p.x < 500 && p.y >= 500);
        const q30_4 = snow30m.some(p => p.x >= 500 && p.y >= 500);
        check(count30m >= 1 && count30m <= 45 && maxLv30m === SL2.LIGHT && q30_1 && q30_2 && q30_3 && q30_4,
          `snow-time-scale: перемотка на 30 минут равномерно сеет мелкую порошу по всем 4 квадрантам (пятен=${count30m}, maxLv=${maxLv30m})`);

        // Time-advance additivity: 6 × 30 min === 3 × 1 hour (identical flake count, cell coverage, and level distribution)
        tStore.clear({ broadcast: false, persist: false });
        tSnow._state = { t: 10000, frac: 0, q: 0, thawFrac: 0, thawQ: 0 };
        for (let step = 1; step <= 6; step++) {
          tSnow._onWorldTime(10000 + step * 1800, 1800);
          tSnow._drain();
        }
        const snow30x6 = tStore.stains.filter(s => s.m === 2);
        const cells30x6 = new Set(snow30x6.map(s => `${Math.min(9, Math.floor(s.x / 100))},${Math.min(9, Math.floor(s.y / 100))}`)).size;
        const lv2Count30x6 = snow30x6.filter(s => s.lv === SL2.MEDIUM).length;

        tStore.clear({ broadcast: false, persist: false });
        tSnow._state = { t: 20000, frac: 0, q: 0, thawFrac: 0, thawQ: 0 };
        for (let step = 1; step <= 3; step++) {
          tSnow._onWorldTime(20000 + step * 3600, 3600);
          tSnow._drain();
        }
        const snow1hx3 = tStore.stains.filter(s => s.m === 2);
        const cells1hx3 = new Set(snow1hx3.map(s => `${Math.min(9, Math.floor(s.x / 100))},${Math.min(9, Math.floor(s.y / 100))}`)).size;
        const lv2Count1hx3 = snow1hx3.filter(s => s.lv === SL2.MEDIUM).length;
        check(
          snow30x6.length === snow1hx3.length &&
          cells30x6 === cells1hx3 &&
          lv2Count30x6 === lv2Count1hx3,
          `snow-time-linear: 6×30 мин и 3×1 ч дают идентичный результат (пятен=${snow30x6.length}/${snow1hx3.length}, клеток=${cells30x6}/${cells1hx3}, lv2=${lv2Count30x6}/${lv2Count1hx3})`
        );

        // Short live step (+2 min) enables smooth fade-in (f=380) and staggered delay (d>0)
        tStore.clear({ broadcast: false, persist: false });
        tSnow._lastSeedAt = 0;
        tSnow._state = { t: 2000, frac: 0, q: 0, thawFrac: 0, thawQ: 0 };
        tSnow._onWorldTime(2000 + 120, 120); // +2 minutes
        tSnow._drain();
        const snow2m = tStore.stains.filter(s => s.m === 2);
        check(snow2m.length >= 2 && snow2m.every(s => s.f === 380) && snow2m.some(s => (s.d || 0) > 0),
          `snow-smooth-fade: малый тик времени плавно проявляет снежинки с f=380 и каскадной задержкой d (пятен=${snow2m.length})`);

        tStore.clear({ broadcast: false, persist: false });
        tSnow._state = { t: 5000, frac: 0, q: 0, thawFrac: 0, thawQ: 0 };
        tSnow._onWorldTime(5000 + 3 * 86400, 3 * 86400); // +3 days
        tSnow._drain(); // A SINGLE _drain pass immediately covers the map in snow
        const snow3d = tStore.stains.filter(s => s.m === 2);
        const count3d = snow3d.length;
        const hasHighDrifts = snow3d.some(s => (s.lv || 1) >= SL2.DRIFT_HIGH);
        const coveredCells3d = new Set(snow3d.map(s => `${Math.min(9, Math.floor(s.x / 100))},${Math.min(9, Math.floor(s.y / 100))}`));
        check(count3d >= 180 && tSnow._state.q === 0 && hasHighDrifts && coveredCells3d.size === 100,
          `snow-time-scale: перемотка на 3 дня покрывает 100% клеток карты (${coveredCells3d.size}/100) и формирует высокие сугробы (пятен=${count3d}, q=${tSnow._state.q}, highDrifts=${hasHighDrifts})`);

        // Power-of-Two-Choices: when cleared/melted cells exist, new snow preferentially fills them
        tStore.clear({ broadcast: false, persist: false });
        const prefill = [];
        for (let r = 0; r < 10; r++) {
          for (let c = 0; c < 5; c++) { // left half of the map is already densely covered (12 droplets per cell)
            for (let k = 0; k < 12; k++) {
              prefill.push(tStore.createStain({ t: STAIN.DROPLETS, x: c * 100 + 50, y: r * 100 + 50, s: 80, a: 0.8, c: SC2, m: 2, lv: SL2.DRIFT }));
            }
          }
        }
        tStore.add(prefill, { broadcast: false, persist: false });
        tSnow._cellDeck = [];
        tSnow._state = { t: 9000, frac: 0, q: 40, thawFrac: 0, thawQ: 0, lastElapsed: 1800 };
        tSnow._drain();
        const freshSnow = tStore.stains.slice(prefill.length);
        const rightHalfDrops = freshSnow.filter(s => s.x >= 500).length;
        check(freshSnow.length === 40 && rightHalfDrops >= 26,
          `snow-power-of-two: свежий снег приоритетно заполняет расчищенную половину карты (${rightHalfDrops}/${freshSnow.length} в пустой половине)`);
      } finally {
        tSnow.dispose();
        canvas.scene = savedSc;
      }
    }

    // (2) Multiple snowdrift height levels (lv=3 low, lv=4 high, lv=5 deep)
    {
      const dStore = new BloodStore(game.scenes.get('scene1'));
      const dRend = new BloodRenderer({ scale: 0.5 });
      const st2 = dStore.createStain({ t: STAIN.DROPLETS, x: 100, y: 200, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.MEDIUM });
      const st3 = dStore.createStain({ t: STAIN.DROPLETS, x: 200, y: 200, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT });
      const st4 = dStore.createStain({ t: STAIN.DROPLETS, x: 500, y: 200, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT_HIGH });
      const st5 = dStore.createStain({ t: STAIN.DROPLETS, x: 800, y: 200, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT_DEEP });

      dRend.addStains([st2], { defer: false });
      dRend.flush();
      const draws2 = dRend.chunks.get('0|0,0')?.canvas._log.length ?? 0;

      dRend.rebuildFrom([st3]);
      dRend.flush();
      const draws3 = dRend.chunks.get('0|0,0')?.canvas._log.length ?? 0;

      dRend.rebuildFrom([st4]);
      dRend.flush();
      const draws4 = dRend.chunks.get('0|0,0')?.canvas._log.length ?? 0;

      dRend.rebuildFrom([st5]);
      dRend.flush();
      const draws5 = dRend.chunks.get('0|0,0')?.canvas._log.length ?? 0;

      check(draws2 === 2 && draws3 === 3 && draws4 === 4 && draws5 === 5 && dRend._stainSpanRadius(st5) > dRend._stainSpanRadius(st4) && dRend._stainSpanRadius(st4) > dRend._stainSpanRadius(st3) && dRend._stainSpanRadius(st3) > dRend._stainSpanRadius(st2),
        `snow-drift-levels: уровни высоты снега lv=2/3/4/5 визуально выше и объёмнее друг друга (слоёв рендера: ${draws2}/${draws3}/${draws4}/${draws5})`);

      const tintedLog = [];
      const origTinted = BloodAtlas.tinted.bind(BloodAtlas);
      BloodAtlas.tinted = (k, v, c, m) => {
        tintedLog.push({ k, v, c, m });
        return origTinted(k, v, c, m);
      };
      try {
        // All layers of a single STAIN.DROPLETS drift must use the same atlas variant
        // so shadow droplets never detach from white caps and leave dark spots
        tintedLog.length = 0;
        dRend.rebuildFrom([st5]);
        dRend.flush();
        const uniqueVariants5 = new Set(tintedLog.map(x => x.v));
        check(uniqueVariants5.size === 1 && tintedLog.length === 5,
          `snow-drift-aligned-droplets: все 5 слоёв сугроба STAIN.DROPLETS (lv=5) используют один вариант атласа без отрыва теневых капель (uniqueVariants=${uniqueVariants5.size})`);

        // Multi-tier elevation-pass rendering:
        //  1) Within a single tier (e.g. two overlapping lv=3 drifts), ALL ao (#3e4856) passes draw first,
        //     then ALL bank (#7c8a9c), then ALL plateau (#d8e0ec) — inner slopes never slice into a neighbor's white plateau!
        //  2) When incrementally adding light dusting (lv=1) next to a drift (lv=3), the local dirtyRect
        //     rebakes dusting UNDER the drift (Tier 0 -> Tier 1), preserving the exact same tier order as rebuildFrom!
        const st3b = dStore.createStain({ t: STAIN.DROPLETS, x: 240, y: 200, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT });
        tintedLog.length = 0;
        dRend.rebuildFrom([st3, st3b]);
        dRend.flush();
        const pairColors = tintedLog.map(x => x.c).join('|');
        const expectedPairColors = '#3e4856|#3e4856|#7c8a9c|#7c8a9c|#d8e0ec|#d8e0ec';

        const stFlat = dStore.createStain({ t: STAIN.DROPLETS, x: 150, y: 200, s: 110, a: 0.55, c: SC2, m: 2, lv: SL2.LIGHT });
        dRend.clear();
        dRend.addStains([st3, st4], { defer: false });
        dRend.flush();
        dRend.addStains([st5], { defer: false });
        dRend.flush();
        tintedLog.length = 0;
        dRend.addStains([stFlat], { defer: false });
        dRend.flush();
        const incDirtySeq = tintedLog.map(x => `${x.v}:${x.c}`).join('|');

        tintedLog.length = 0;
        dRend.rebuildFrom([st3, st4, st5, stFlat]);
        dRend.flush();
        const fullSeq = tintedLog.map(x => `${x.v}:${x.c}`).join('|');
        check(
          pairColors === expectedPairColors &&
          fullSeq.startsWith(incDirtySeq) &&
          tintedLog.length === 13,
          `snow-drift-seamless-incremental: глобальные проходы яруса (${pairColors}) и локальный dirtyRect при допечке пороши под сугроб дают 100% бесшовный топографический порядок (${tintedLog.length} слоёв)`
        );

        // Walking through a drift leaves a dense organic trench (wall #7c8ea8, bed #b4c2d4) without isolated dark dents
        const deepWalkStore = new BloodStore(game.scenes.get('scene1'));
        const deepHooks = new Hooks2(() => deepWalkStore);
        for (let k = 0; k < 14; k++) {
          deepWalkStore.add([deepWalkStore.createStain({
            t: STAIN.DROPLETS, x: 500 + (k % 4) * 35, y: 450 + Math.floor(k / 4) * 20, s: 100, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT_DEEP, e: 0
          })], { broadcast: false, persist: false });
        }
        deepHooks._trail.footprints({ id: 'lv5-walker', x: 450, y: 450, width: 1, height: 1, elevation: 0 }, { x: 650, y: 450 });
        const deepTrenches = deepWalkStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR);
        tintedLog.length = 0;
        const wallTestCv = new FakeCanvas(256, 256);
        const wallTestCtx = wallTestCv.getContext('2d');
        dRend._drawSnowCarvePass(wallTestCtx, deepTrenches[0], 'wall');
        const deepWallCol = tintedLog[0]?.c;
        dRend._drawSnowCarvePass(wallTestCtx, deepTrenches[0], 'bed');
        const deepBedCol = tintedLog[1]?.c;
        check(deepTrenches.length >= 6 && deepWallCol === '#7c8ea8' && deepBedCol === '#b4c2d4',
          `snow-deep-trench: проход по сугробу оставляет плотную органичную траншею без отдельных вмятин (stamps=${deepTrenches.length}, wall=${deepWallCol}, bed=${deepBedCol})`);
      } finally {
        BloodAtlas.tinted = origTinted;
      }

      // 3D trench and footprint relief on a tile overlay (roof/bridge with tid)
      const savedTiles = canvas.tiles.placeables;
      canvas.tiles.placeables = [{
        document: { id: 'snowBridge', x: 200, y: 200, width: 400, height: 400, elevation: 10, rotation: 0, alpha: 1 },
        mesh: Object.assign(new FakeObservable(), {
          width: 400, height: 400,
          scale: { x: 1, y: 1 },
          anchor: { x: 0.5, y: 0.5 },
          texture: { uuid: 'tex-bridge', width: 400, height: 400, orig: { width: 400, height: 400 }, frame: { x: 0, y: 0 }, baseTexture: { resource: { source: { _tag: 'bridgeSrc' } } } },
          _textureAlphaData: { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100, data: new Uint8Array(10000).fill(255) }
        })
      }];
      try {
        const ovDrift = dStore.createStain({ t: STAIN.SPLAT, x: 200, y: 200, s: 130, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT, e: 10, tid: 'snowBridge' });
        const ovTrench = dStore.createStain({ t: STAIN.SMEAR, x: 200, y: 200, s: 120, a: 0.78, c: SSC2, m: 2, lv: 2, e: 10, tid: 'snowBridge' });
        dRend.rebuildFrom([ovDrift, ovTrench]);
        dRend.flush();
        const ovCarveDraws = dRend._scratchOverlayCarve?._log?.length ?? 0;
        check(ovCarveDraws >= 4 && dRend._overlays.get('snowBridge')?.sprite != null,
          `snow-tile-carve: 3D-траншея на тайле (tid) выпекается через послойный рельеф rim→wall→bed с маской снега (draws=${ovCarveDraws})`);
      } finally {
        canvas.tiles.placeables = savedTiles;
      }

      // Ice glaze and raised 3D rim along the outer edge of a fire-melted crater (meltSnowAt)
      const { meltSnowAt: melt2 } = await import(`${root}/plus/scripts/blood/snow.mjs`);
      const mStore = new BloodStore(game.scenes.get('scene1'));
      const rimStain = mStore.createStain({ t: STAIN.SPLAT, x: 690, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT_HIGH, e: 0 });
      mStore.add([rimStain], { broadcast: false, persist: false });
      melt2(mStore, 500, 500, 160, 0.8, { spawnSteam: false, surface: 0 });
      const meltedRim = mStore.stains[0];
      check(meltedRim && meltedRim.lv === SL2.DRIFT && meltedRim.c !== SC2 && meltedRim.x > 690,
        `snow-melt-rim: внешняя кромка оплавленного сугроба сохраняет 3D-валик (lv=${meltedRim?.lv}), получает ледяной глянец (${meltedRim?.c}) и отступает от эпицентра (x=${meltedRim?.x})`);

      // Building up snow height with the unified brush (1 -> 2 -> 3 -> 4 -> 5): a single LMB press (_stroke) paints exactly one level;
      // raising to the next level requires releasing LMB and clicking again over existing snow
      const bStore = new BloodStore(game.scenes.get('scene1'));
      const bBrush = new Brush2(() => bStore, () => dRend);
      settingsStore.set('bloodBrushMaterial', 2);
      settingsStore.set('bloodBrushType', 'splat');
      settingsStore.set('bloodBrushDensity', 3);
      settingsStore.set('bloodBrushSize', 110);
      const clickLevels = [];
      for (let click = 0; click < 5; click++) {
        bBrush._stroke = { lx: 400, ly: 400, travel: 0, defs: [], lastE: 0, moved: false };
        bBrush._stamp(400, 400, 0);
        bBrush._stamp(400, 400, 0); // holding LMB in place does not raise the level within the same stroke
        bStore.add(bBrush._stroke.defs, { broadcast: false, persist: false });
        clickLevels.push(bBrush._stroke.defs[bBrush._stroke.defs.length - 1].lv);
      }
      check(
        clickLevels.join(',') === '1,2,3,4,5',
        `snow-drift-levels: зажатия ЛКМ единой кистью последовательно проходят уровни lv=${clickLevels.join(' → ')}`
      );

      // A continuous brush stroke with 30px spacing maintains a single level across the entire stroke,
      // and each subsequent pass on top raises the level by +1 (1 -> 2 -> 3 -> 4 -> 5)
      bStore.clear({ broadcast: false, persist: false });
      const strokeLevels = [];
      for (let pass = 0; pass < 5; pass++) {
        bBrush._stroke = { lx: 200, ly: 200, travel: 0, defs: [], lastE: 0, moved: true };
        bBrush._stamp(200, 200, 0);
        bBrush._stamp(230, 200, 0);
        bBrush._stamp(260, 200, 0);
        bStore.add(bBrush._stroke.defs, { broadcast: false, persist: false });
        const expectedLv = pass + 1;
        if (bBrush._stroke.defs.every(d => d.lv === expectedLv)) strokeLevels.push(expectedLv);
      }
      check(
        strokeLevels.join(',') === '1,2,3,4,5',
        `snow-brush-stroke-levels: 5 последовательных мазков проходят уровни ${strokeLevels.join(' → ')}`
      );

      // Increasing snow brush size (size=260 and size=560) expands coverage area via an ensemble of wide domes,
      // without stretching individual stamp scale past the fast spatial index limit (s <= 230 <= FAST_MAX_S=256)
      bStore.clear({ broadcast: false, persist: false });
      settingsStore.set('bloodBrushSize', 260);
      bBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false };
      bBrush._stamp(500, 500, 0);
      const bigBrushDefs = bBrush._stroke.defs;
      const maxStainS = Math.max(...bigBrushDefs.map(d => d.s));
      const maxSpreadR = Math.max(...bigBrushDefs.map(d => Math.hypot(d.x - 500, d.y - 500)));
      check(bigBrushDefs.length >= 3 && maxStainS <= 230 && maxSpreadR >= 45,
        `snow-brush-area-scale: при size=260 кисть заполняет круг широкими куполами без кучной мелочи и без растяжения текстуры (count=${bigBrushDefs.length}, maxS=${Math.round(maxStainS)}, spreadR=${Math.round(maxSpreadR)})`);

      // Giant drift (size=560, direct level V Dune + Smooth skirt): lays down a soft outer skirt lv=1..2 and a monolithic core lv=5
      bStore.clear({ broadcast: false, persist: false });
      settingsStore.set('bloodBrushSize', 560);
      settingsStore.set('bloodBrushSnowDepth', 5);
      settingsStore.set('bloodBrushSnowSkirt', true);
      bBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false };
      bBrush._stamp(500, 500, 0);
      const giantDefs = bBrush._stroke.defs;
      const giantMaxS = Math.max(...giantDefs.map(d => d.s));
      const giantSpreadR = Math.max(...giantDefs.map(d => Math.hypot(d.x - 500, d.y - 500)));
      const hasApron1 = giantDefs.some(d => d.lv === SL2.LIGHT);
      const hasApron2 = giantDefs.some(d => d.lv === SL2.MEDIUM);
      const hasCore5 = giantDefs.some(d => d.lv === SL2.DRIFT_DEEP);
      check(
        giantDefs.length >= 12 && giantMaxS <= 360 && giantSpreadR >= 180 && hasApron1 && hasApron2 && hasCore5,
        `snow-brush-giant-drift: гигантская кисть (size=560, lv=5 + откос) строит монолитный бархан с юбкой lv=1..2 и ядром lv=5 (count=${giantDefs.length}, maxS=${Math.round(giantMaxS)}, spreadR=${Math.round(giantSpreadR)})`
      );
      settingsStore.set('bloodBrushSnowDepth', 0);
      settingsStore.set('bloodBrushSnowSkirt', true);

      // Alt + LMB (altLower): smoothly shaves snow by exactly -1 level per stroke (3 → 2 → 1 → removed) and supports CTRL+Z
      const { wireBloodUndo: wireUndoSnow, undoLastBloodOp: undoSnowOp } = await import('./undo.mjs');
      wireUndoSnow(() => ({ store: bStore, renderer: dRend }));
      bStore.clear({ broadcast: false, persist: false });
      settingsStore.set('bloodBrushSize', 160);
      settingsStore.set('bloodBrushSnowDepth', 3);
      settingsStore.set('bloodBrushSnowSkirt', false);
      bBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false };
      bBrush._stamp(500, 500, 0);
      bBrush._commitPending();
      const afterPaintLv = Math.max(0, ...bStore.stains.map(s => s.lv || 0));
      const demoteSteps = [];
      for (let step = 0; step < 3; step++) {
        bBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false, altLower: true };
        bBrush._stamp(500, 500, 0);
        bBrush._stamp(500, 500, 0); // repeating inside the same stroke does not shave a second time
        bBrush._commitPending();
        demoteSteps.push(bStore.stains.length ? Math.max(...bStore.stains.map(s => s.lv || 0)) : 0);
      }
      undoSnowOp(); // undo the last shave step (0 → 1)
      const afterUndoLv = bStore.stains.length ? Math.max(...bStore.stains.map(s => s.lv || 0)) : 0;
      check(
        afterPaintLv === 3 && demoteSteps.join(',') === '2,1,0' && afterUndoLv === 1,
        `snow-brush-alt-lower-undo: Alt+ЛКМ срезает уровни по одному (3 → ${demoteSteps.join(' → ')}), а CTRL+Z возвращает уровень (${afterUndoLv})`
      );
      settingsStore.set('bloodBrushSnowDepth', 0);
      settingsStore.set('bloodBrushSnowSkirt', true);

      // World-space seamless snow grain pattern (BloodAtlas.snowWorldPattern): unstretched 512x512 tile
      const patProbe = BloodAtlas.snowWorldPattern({
        createPattern: (tile, rep) => ({ tile, rep, setTransform: () => {} })
      });
      check(
        patProbe && patProbe.rep === 'repeat' && patProbe.tile?.width === 512 && patProbe.tile?.height === 512,
        `snow-world-pattern: мировой тайл кристаллического зерна снега 512x512 инициализируется для бесшовного 1:1 наложения`
      );

      // On the first two unified snow brush levels (lv=1..2), walking leaves boot prints (FOOTPRINT) without carving a trench (SMEAR)
      bStore.clear({ broadcast: false, persist: false });
      settingsStore.set('bloodBrushSize', 260);
      bBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false };
      bBrush._stamp(500, 500, 0);
      bStore.add(bBrush._stroke.defs, { broadcast: false, persist: false });
      bBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false };
      bBrush._stamp(500, 500, 0);
      bStore.add(bBrush._stroke.defs, { broadcast: false, persist: false });
      const dropletMaxLv = Math.max(...bStore.stains.map(d => d.lv || 1));
      const dropletHooks = new Hooks2(() => bStore);
      dropletHooks._trail.footprints({ id: 'droplet-walker', x: 380, y: 450, width: 1, height: 1, elevation: 0 }, { x: 620, y: 450 });
      const dropletPrints = bStore.stains.filter(s => s.m === 2 && s.t === STAIN.FOOTPRINT);
      const dropletTrenches = bStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR);
      check(dropletMaxLv === SL2.MEDIUM && dropletPrints.length >= 2 && dropletTrenches.length === 0,
        `snow-brush-droplet-footprints: на уровнях lv=1..2 единой кисти снега остаются следы ног (${dropletPrints.length}) без траншеи (${dropletTrenches.length})`);
      settingsStore.set('bloodBrushSize', 110);

      // Snow SPLAT (m=2) does not draw tiny liquid-blood satellite droplets (nDrops=0)
      const splatSt3 = dStore.createStain({ t: STAIN.SPLAT, x: 300, y: 300, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT });
      dRend.rebuildFrom([splatSt3]);
      dRend.flush();
      const splatDraws3 = dRend.chunks.get('0|0,0')?.canvas._log.length ?? 0;
      check(splatDraws3 === 3, `snow-splat-no-beads: снежный SPLAT (lv=3) рисует ровно 3 слоя купола без мелких жидких брызг (${splatDraws3})`);

      // Exiting a drift (lv=3) into medium snow (lv=2): blends for 1 boundary step, then places footprints (FOOTPRINT)
      const transStore = new BloodStore(game.scenes.get('scene1'));
      const transHooks = new Hooks2(() => transStore);
      transStore.add([
        transStore.createStain({ t: STAIN.SPLAT, x: 100, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT, e: 0 }),
        transStore.createStain({ t: STAIN.SPLAT, x: 220, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.MEDIUM, e: 0 }),
        transStore.createStain({ t: STAIN.SPLAT, x: 320, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.MEDIUM, e: 0 }),
        transStore.createStain({ t: STAIN.SPLAT, x: 420, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.MEDIUM, e: 0 })
      ], { broadcast: false, persist: false });
      transHooks._trail.footprints({ id: 'trans-walker', x: 80, y: 500, width: 1, height: 1, elevation: 0 }, { x: 440, y: 500 });
      const transPrints = transStore.stains.filter(s => s.m === 2 && s.t === STAIN.FOOTPRINT && s.x >= 260);
      const transLateTrenches = transStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.x >= 290);
      check(transPrints.length >= 2 && transLateTrenches.length === 0,
        `snow-level-transition: при выходе из сугроба (lv=3) в средний снег (lv=2) траншея сменяется следами ботинок (prints=${transPrints.length}, lateTrenches=${transLateTrenches.length})`);
      dRend.destroy();
    }

    // (3) Gradually burying old trodden paths under fresh snow (via brush and snowfall)
    {
      const rStore = new BloodStore(game.scenes.get('scene1'));
      const rRend = new BloodRenderer({ scale: 0.5 });
      rStore.setRenderer(rRend);
      const trench = rStore.createStain({ t: STAIN.SMEAR, x: 500, y: 500, s: 140, a: 0.78, c: SSC2, m: 2, e: 0 });
      const print = rStore.createStain({ t: STAIN.FOOTPRINT, x: 520, y: 500, s: 45, a: 0.78, c: SSC2, m: 2, e: 0 });
      rStore.add([trench, print], { broadcast: false, persist: false });

      // 1st snowfall/brush pass: the path fades and narrows, but remains visible
      bury2(rStore, 500, 500, 120, 0, 0.85);
      const trenchMid = rStore.stains.find(s => s.i === trench.i);
      check(trenchMid && trenchMid.a < 0.78 && trenchMid.s < 140,
        `snow-bury-tracks: первый слой нового снега частично засыпает протоптанную дорогу (a: 0.78 -> ${trenchMid?.a}, s: 140 -> ${trenchMid?.s})`);

      // Painting over the old path with the brush gradually buries it completely
      const rBrush = new Brush2(() => rStore, () => rRend);
      settingsStore.set('bloodBrushMaterial', 2);
      settingsStore.set('bloodBrushType', 'splat');
      settingsStore.set('bloodBrushSize', 120);
      rBrush._stroke = { lx: 500, ly: 500, travel: 0, defs: [], lastE: 0, moved: false };
      rBrush._stamp(500, 500, 0);
      rBrush._stamp(500, 500, 0);
      const remainingTracks = rStore.stains.filter(s => s.i === trench.i || s.i === print.i);
      check(remainingTracks.length === 0,
        `snow-bury-tracks: новый снег полностью засыпал и стёр старую протоптанную дорогу (осталось следов: ${remainingTracks.length})`);

      // Snow on a roof (e=20) MUST NOT bury footprints on the floor (e=0) underneath that roof
      rStore.clear({ broadcast: false, persist: false });
      const floorPrint = rStore.createStain({ t: STAIN.FOOTPRINT, x: 150, y: 150, s: 45, a: 0.78, c: SSC2, m: 2, e: 0 });
      const roofPrint = rStore.createStain({ t: STAIN.FOOTPRINT, x: 150, y: 150, s: 45, a: 0.78, c: SSC2, m: 2, e: 20, tid: 'roofBury' });
      rStore.add([floorPrint, roofPrint], { broadcast: false, persist: false });
      const savedScBury = canvas.scene;
      canvas.scene = { id: 'scene1', weather: 'snow', width: 200, height: 200, getFlag: () => null, setFlag: async () => {} };
      canvas.tiles.placeables = [{
        document: { id: 'roofBury', x: 0, y: 0, width: 300, height: 300, elevation: 20, alpha: 1, texture: { alphaThreshold: 0 } },
        mesh: { containsCanvasPoint: () => true, _textureAlphaData: { data: [255] } },
        bounds: { contains: () => true }
      }];
      const roofSnow = new SnowAcc2(() => rStore);
      try {
        roofSnow._state = { t: 1000, frac: 0, q: 20, thawFrac: 0, thawQ: 0, lastElapsed: 3600 };
        roofSnow._drain();
        const floorAfter = rStore.stains.find(s => s.i === floorPrint.i);
        const roofAfter = rStore.stains.find(s => s.i === roofPrint.i);
        check(floorAfter && floorAfter.a === 0.78 && floorAfter.s === 45 && (!roofAfter || roofAfter.a < 0.78),
          'snow-bury-tracks: снег на крыше (e=20) засыпает следы на крыше, не трогая следы на полу (e=0) под ней');
      } finally {
        roofSnow.dispose();
        canvas.tiles.placeables = [];
        canvas.scene = savedScBury;
      }
      rRend.destroy();
    }

    // (4) Melting snow with fire spells in Foundry VTT v14 + dnd5e 6.0.0
    {
      const fStore = new BloodStore(game.scenes.get('scene1'));
      const fHooks = new Hooks2(() => fStore);

      // 4a. Large AoE Fireball in dnd5e 6.0.0 (flags.dnd5e.activity with DamageData.types = Set(['fire']), WITHOUT flags.core.MeasuredTemplate):
      //     clears snow at the epicenter, near the circle rim (dist=160 for radius=200), and trodden trenches!
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 140, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT_DEEP }),
        fStore.createStain({ t: STAIN.SPLAT, x: 660, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT }),
        fStore.createStain({ t: STAIN.SMEAR, x: 580, y: 500, s: 140, a: 0.78, c: SSC2, m: 2 }),
        fStore.createStain({ t: STAIN.SPLAT, x: 950, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT })
      ], { broadcast: false, persist: false });

      const prevUuid = globalThis.fromUuidSync;
      globalThis.fromUuidSync = (uuid) => {
        if (uuid === 'Actor.wiz.Item.fb.Activity.cast') {
          return {
            name: 'Cast',
            damage: { parts: [{ types: new Set(['fire']) }] },
            item: { name: 'Огненный шар', system: {} }
          };
        }
        return null;
      };
      fHooks._onCreateRegion({
        shapes: [{ type: 'circle', x: 500, y: 500, radius: 200 }],
        flags: { dnd5e: { activity: 'Actor.wiz.Item.fb.Activity.cast', spellLevel: 3 } }
      });
      globalThis.fromUuidSync = prevUuid;
      const beforeRollFb = fStore.stains.filter(s => s.m === 2).length;
      fHooks._onRollDamage([{ options: { type: 'fire' } }], { subject: { uuid: 'Actor.wiz.Item.fb.Activity.cast' } });
      const remAfterFb = fStore.stains.filter(s => s.m === 2);
      check(beforeRollFb === 4 && remAfterFb.length === 1 && remAfterFb[0].x === 950,
        `snow-fire-v14: AoE-регион dnd5e 6.0.0 ждёт броска урона (до броска=${beforeRollFb}) и после броска удаляет снег и траншеи в радиусе 200px (осталось вне круга: ${remAfterFb.length})`);

      // 4b. MeasuredTemplateDocument (createMeasuredTemplate) for a cone of fire ("Burning Hands")
      //     + verifying trigger on 'damage' ChatMessage creation (as rolled by a player)
      fStore.clear({ broadcast: false, persist: false });
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 600, y: 500, s: 110, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT })
      ], { broadcast: false, persist: false });
      fHooks._onCreateMeasuredTemplate({
        t: 'cone',
        x: 500,
        y: 500,
        distance: 15, // 15 ft = 300 px
        direction: 0,
        angle: 53.13,
        name: 'Огненные ладони',
        flags: { dnd5e: { spellLevel: 1, item: 'Actor.wiz.Item.bh' } }
      });
      const beforeConeRoll = fStore.stains.filter(s => s.m === 2).length;
      // Spell usage card (type: 'use') MUST NOT clear snow
      fHooks._onCreateChatMessage({ type: 'use', system: { item: { uuid: 'Actor.wiz.Item.bh', name: 'Огненные ладони' } } });
      const afterUseCard = fStore.stains.filter(s => s.m === 2).length;
      // Damage roll message (type: 'damage') melts snow
      fHooks._onCreateChatMessage({
        type: 'damage',
        rolls: [{ options: { type: 'fire' } }],
        system: { item: { uuid: 'Actor.wiz.Item.bh', name: 'Огненные ладони' } }
      });
      check(beforeConeRoll === 1 && afterUseCard === 1 && fStore.stains.filter(s => s.m === 2).length === 0,
        'snow-fire-v14: шаблон MeasuredTemplate (конус «Огненные ладони») не стирает снег на карточке use, а растапливает после сообщения броска урона (type="damage")');

      // 4c. Targeted fire damage in dnd5e 6.0.0 (`types: new Set(['fire'])`) melts snow under the target even when absorbed by temporary HP
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 550, y: 550, s: 110, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT })
      ], { broadcast: false, persist: false });
      const fireTargetActor = { id: 'act-ft', uuid: 'Actor.ft', system: { attributes: { hp: { value: 30, max: 30, temp: 15 } } } };
      const fireTargetTok = {
        id: 'tok-ft', center: { x: 550, y: 550 }, actor: fireTargetActor,
        document: { id: 'tok-ft', x: 500, y: 500, width: 1, height: 1, elevation: 0, actor: fireTargetActor, scene: canvas.scene }
      };
      fireTargetActor.getActiveTokens = () => [fireTargetTok];
      fHooks._interactSnowOnDamage(fireTargetTok, 'fire', 0.8);
      check(fStore.stains.filter(s => s.m === 2).length === 0,
        'snow-fire-v14: направленное огненное заклинание растопило снег под целью');

      // 4d. midi-qol 3D Fireball sphere regression (`elevation: { bottom: -20, top: 20 }`):
      //     previously `Number(region.elevation?.bottom)` yielded `-20` and `elevationMatches(0, -20)` returned `false`,
      //     preventing ground snow (e=0) from melting at all! Also verifies firing strictly on `midi-qol.DamageRollComplete`.
      fStore.clear({ broadcast: false, persist: false });
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 150, a: 0.9, c: SC2, m: 2, lv: SL2.DRIFT_DEEP, e: 0 }),
        fStore.createStain({ t: STAIN.SPLAT, x: 720, y: 500, s: 160, a: 0.9, c: SC2, m: 2, lv: SL2.DRIFT_HIGH, e: 0 }), // edge: dist=220 <= 200 + 160*0.18
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT, e: 10 }),     // balcony within [-20..20]
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT, e: 35 })      // roof above sphere (>20)
      ], { broadcast: false, persist: false });
      fHooks._onCreateRegion({
        id: 'reg-midi-fb-ground',
        uuid: 'Scene.scene1.Region.reg-midi-fb-ground',
        name: 'Огненный шар',
        elevation: { bottom: -20, top: 20, topInclusive: true },
        shapes: [{ type: 'circle', x: 500, y: 500, radius: 200 }],
        flags: {
          dnd5e: { spellLevel: 3 },
          'midi-qol': { activityTemplate: true }
        }
      });
      const countBeforeMidiRoll = fStore.stains.filter(s => s.m === 2).length;
      fHooks._onMidiDamageRollComplete({
        templateUuids: ['Scene.scene1.Region.reg-midi-fb-ground'],
        damageDetail: [{ value: 28, type: 'fire' }]
      });
      const remMidiFb = fStore.stains.filter(s => s.m === 2);
      check(countBeforeMidiRoll === 4 && remMidiFb.length === 1 && remMidiFb[0].e === 35,
        `snow-fire-midi-3d: Огненный шар с 3D-высотой midi-qol {bottom:-20, top:20} ждёт броска (до=${countBeforeMidiRoll}) и после DamageRollComplete растопил снег на земле (e=0), краевой сугроб и балкон (e=10), не тронув крышу (e=35, осталось=${remMidiFb.length})`);

      // 4e. Fireball cast by a flying caster at 30 ft elevation (`midi-qol` sets `{ bottom: 10, top: 50 }`):
      //     template is placed on the ground (surfE=0), and after updateChatMessage with `flags['midi-qol'].damageDetail`, ground snow (e=0) melts!
      fStore.clear({ broadcast: false, persist: false });
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 140, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT_DEEP, e: 0 })
      ], { broadcast: false, persist: false });
      fHooks._onCreateRegion({
        id: 'reg-midi-fb-flying',
        uuid: 'Scene.scene1.Region.reg-midi-fb-flying',
        name: 'Fireball',
        elevation: { bottom: 10, top: 50 },
        shapes: [{ type: 'circle', x: 500, y: 500, radius: 200 }],
        flags: { 'midi-qol': { activityTemplate: true } }
      });
      const beforeFlyingCardUpdate = fStore.stains.filter(s => s.m === 2).length;
      fHooks._onUpdateChatMessage(
        { flags: { 'midi-qol': { templateUuids: ['Scene.scene1.Region.reg-midi-fb-flying'] } }, system: {} },
        { flags: { 'midi-qol': { type: 3, damageDetail: [{ value: 24, type: 'fire' }] } } }
      );
      check(beforeFlyingCardUpdate === 1 && fStore.stains.filter(s => s.m === 2).length === 0,
        'snow-fire-flying-caster: Огненный шар от летающего кастера ({bottom:10, top:50}) растапливает снег на земле (e=0) после обновления карточки броском урона');

      // 4f. Default Foundry v14 RegionDocument with `{ bottom: null, top: null }` + cancellation check (deleting region before damage roll)
      fStore.clear({ broadcast: false, persist: false });
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT, e: 0 }),
        fStore.createStain({ t: STAIN.SPLAT, x: 500, y: 500, s: 120, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT, e: 15 })
      ], { broadcast: false, persist: false });
      const cancelledReg = {
        id: 'reg-cancelled',
        name: 'Огненный шар',
        elevation: { bottom: null, top: null },
        shapes: [{ type: 'circle', x: 500, y: 500, radius: 200 }],
        flags: { dnd5e: { spellLevel: 3 } }
      };
      fHooks._onCreateRegion(cancelledReg);
      fHooks._onDeleteAoETemplate(cancelledReg); // cancelled/deleted template before damage roll
      fHooks._onRollDamage([{ options: { type: 'fire' } }]);
      const afterCancelledRoll = fStore.stains.filter(s => s.m === 2).length;

      fHooks._onCreateRegion({
        id: 'reg-unbounded-null',
        name: 'Огненный шар',
        elevation: { bottom: null, top: null },
        shapes: [{ type: 'circle', x: 500, y: 500, radius: 200 }],
        flags: { dnd5e: { spellLevel: 3 } }
      });
      fHooks._onRollDamage([{ options: { type: 'fire' } }]);
      check(afterCancelledRoll === 2 && fStore.stains.filter(s => s.m === 2).length === 0,
        'snow-fire-unbounded: удалённый до броска шаблон снег не трогает, а активный с {bottom:null, top:null} после броска растапливает снег на всех высотах (e=0 и e=15)');

      // 4g. Resilience against `fromUuidSync` throwing on embedded compendium Activity UUIDs +
      //     support for Foundry v14 `LineShapeData` (`length` + `width`) and `EmanationShapeData` (`base: { type: 'token', ... }`)
      fStore.clear({ broadcast: false, persist: false });
      fStore.add([
        fStore.createStain({ t: STAIN.SPLAT, x: 650, y: 500, s: 100, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT }), // along line ray (500,500)->(900,500)
        fStore.createStain({ t: STAIN.SPLAT, x: 200, y: 200, s: 100, a: 0.85, c: SC2, m: 2, lv: SL2.DRIFT })  // at emanation center (200,200)
      ], { broadcast: false, persist: false });
      const prevUuid2 = globalThis.fromUuidSync;
      globalThis.fromUuidSync = (uuid, opts) => {
        if (uuid.includes('.Activity.') && (!opts || opts.strict !== false)) {
          throw new Error('Compendium embedded UUID not supported in strict fromUuidSync');
        }
        if (uuid === 'Compendium.dnd5e.spells24.Item.agn') {
          return { name: "Aganazzar's Scorcher", system: { damage: { base: { types: new Set(['fire']) } } } };
        }
        return null;
      };
      fHooks._onCreateRegion({
        id: 'reg-v14-line-emanation',
        elevation: { bottom: null, top: null },
        shapes: [
          { type: 'line', x: 500, y: 500, length: 400, width: 100, rotation: 0 },
          { type: 'emanation', radius: 150, base: { type: 'token', x: 200, y: 200, width: 1, height: 1, anchorX: 0.5, anchorY: 0.5 } }
        ],
        flags: { dnd5e: { activity: 'Compendium.dnd5e.spells24.Item.agn.Activity.cast' } }
      });
      globalThis.fromUuidSync = prevUuid2;
      fHooks._onRollDamage([{ options: { type: 'fire' } }], { subject: { uuid: 'Compendium.dnd5e.spells24.Item.agn.Activity.cast' } });
      check(fStore.stains.filter(s => s.m === 2).length === 0,
        'snow-fire-v14-shapes: LineShapeData (length/width), EmanationShapeData (base) и fallback Compendium Activity UUID полностью растопили снег после броска урона');
    }

    // (5) Token movementActions: teleport and jump on snow
    {
      const mStore = new BloodStore(game.scenes.get('scene1'));
      const mHooks = new Hooks2(() => mStore);

      // 5a. Teleport: snow dents appear ONLY where the token stood (550,550) and where it landed (950,550),
      //     leaving the midpoint (750,550) completely untouched
      for (let gx = 550; gx <= 950; gx += 100) {
        mStore.add([
          mStore.createStain({ t: STAIN.SPLAT, x: gx, y: 550, s: 150, a: 0.82, c: SC2, m: 2, lv: SL2.DRIFT })
        ], { broadcast: false, persist: false });
      }
      mHooks._trail.footprints(
        { id: 'tp-snow', x: 500, y: 500, width: 1, height: 1, elevation: 0, movementAction: 'teleport', actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
        { x: 900, y: 500 }
      );
      const tpDents = mStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SC2);
      const hasStartDent = tpDents.some(s => Math.abs(s.x - 550) <= 5);
      const hasEndDent = tpDents.some(s => Math.abs(s.x - 950) <= 5);
      const hasMidDent = tpDents.some(s => s.x > 600 && s.x < 900);
      check(tpDents.length === 2 && hasStartDent && hasEndDent && !hasMidDent,
        `snow-movement-teleport: при телепорте вмятины созданы только в точке старта (550) и финиша (950), середина не тронута (dents=${tpDents.map(s => s.x).join(',')})`);

      // 5b. Jump (movementAction === 'jump'): dents at takeoff origin (550) + push-off slightly forward (>550),
      //     plus landing center (950) + approach skid (<950), with an untouched air gap in the middle (660..840)
      mStore.clear({ broadcast: false, persist: false });
      for (let gx = 550; gx <= 950; gx += 100) {
        mStore.add([
          mStore.createStain({ t: STAIN.SPLAT, x: gx, y: 550, s: 150, a: 0.82, c: SC2, m: 2, lv: SL2.DRIFT })
        ], { broadcast: false, persist: false });
      }
      mHooks._trail.footprints(
        { id: 'jump-snow', x: 500, y: 500, width: 1, height: 1, elevation: 0, movementAction: 'jump', actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
        { x: 900, y: 500 }
      );
      const jumpDents = mStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SC2);
      const hasTakeoffOrigin = jumpDents.some(s => Math.abs(s.x - 550) <= 5);
      const hasTakeoffPush = jumpDents.some(s => s.x > 565 && s.x <= 610);
      const hasLandingSkid = jumpDents.some(s => s.x >= 890 && s.x < 935);
      const hasLandingCenter = jumpDents.some(s => Math.abs(s.x - 950) <= 5);
      const hasAirGap = !jumpDents.some(s => s.x > 620 && s.x < 880);
      check(jumpDents.length === 4 && hasTakeoffOrigin && hasTakeoffPush && hasLandingSkid && hasLandingCenter && hasAirGap,
        `snow-movement-jump: при прыжке созданы вмятины отталкивания (550 + вперёд) и приземления (со стороны прилёта + 950) с разрывом в воздухе (${jumpDents.map(s => s.x).join(',')})`);

      // 5c. Real Foundry VTT v14 drag/keyboard payload (`options.method = 'dragging'`,
      //     `options._movement[id].method = 'dragging'`, `options._movement[id].passed.waypoints = [{action: 'blink'}]`):
      //     `method: 'dragging'` MUST NOT shadow `wp.action` or `doc.movementAction`!
      mStore.clear({ broadcast: false, persist: false });
      for (let gx = 550; gx <= 950; gx += 100) {
        mStore.add([
          mStore.createStain({ t: STAIN.SPLAT, x: gx, y: 550, s: 150, a: 0.82, c: SC2, m: 2, lv: SL2.DRIFT })
        ], { broadcast: false, persist: false });
      }
      const v14BlinkDoc = {
        id: 'tp-v14-drag', x: 500, y: 500, width: 1, height: 1, elevation: 0,
        movementAction: 'blink',
        scene: canvas.scene,
        actor: { system: { attributes: { hp: { value: 50, max: 50 } } } }
      };
      mHooks._onPreUpdateToken(
        v14BlinkDoc,
        { x: 900, y: 500, _movementHistory: [{ x: 500, y: 500, action: 'walk' }, { x: 900, y: 500, action: 'blink', teleport: true }] },
        {
          method: 'dragging',
          movement: { 'tp-v14-drag': { method: 'dragging', waypoints: [{ x: 500, y: 500, action: 'walk' }, { x: 900, y: 500, action: 'blink' }] } },
          _movement: { 'tp-v14-drag': { method: 'dragging', passed: { waypoints: [{ x: 500, y: 500, action: 'walk' }, { x: 900, y: 500, action: 'blink', teleport: true }] } } }
        }
      );
      const v14BlinkDents = mStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SC2);
      check(v14BlinkDents.length === 2 && !v14BlinkDents.some(s => s.x > 600 && s.x < 900),
        `snow-movement-v14-drag-blink: реальный payload Foundry v14 с method='dragging' корректно распознаёт blink/teleport (${v14BlinkDents.map(s => s.x).join(',')})`);

      // 5d. Real Foundry VTT v14 keyboard/drag jump payload (`method: 'keyboard'`, `doc.movementAction = 'jump'`)
      mStore.clear({ broadcast: false, persist: false });
      for (let gx = 550; gx <= 950; gx += 100) {
        mStore.add([
          mStore.createStain({ t: STAIN.SPLAT, x: gx, y: 550, s: 150, a: 0.82, c: SC2, m: 2, lv: SL2.DRIFT })
        ], { broadcast: false, persist: false });
      }
      const v14JumpDoc = {
        id: 'jump-v14-kbd', x: 500, y: 500, width: 1, height: 1, elevation: 0,
        movementAction: 'jump',
        scene: canvas.scene,
        actor: { system: { attributes: { hp: { value: 50, max: 50 } } } }
      };
      mHooks._onPreUpdateToken(
        v14JumpDoc,
        { x: 900, y: 500 },
        {
          method: 'keyboard',
          movement: { 'jump-v14-kbd': { method: 'keyboard', waypoints: [{ x: 900, y: 500, action: 'jump' }] } },
          _movement: { 'jump-v14-kbd': { method: 'keyboard', passed: { waypoints: [{ x: 900, y: 500, action: 'jump' }] } } }
        }
      );
      const v14JumpDents = mStore.stains.filter(s => s.m === 2 && s.t === STAIN.SMEAR && s.c !== SC2);
      check(v14JumpDents.length === 4 && !v14JumpDents.some(s => s.x > 620 && s.x < 880),
        `snow-movement-v14-kbd-jump: реальный payload Foundry v14 с method='keyboard' корректно распознаёт jump (${v14JumpDents.map(s => s.x).join(',')})`);

      // 5e. 2.5D token movement animation (token-movement.mjs): jump, fly, walk, parabolic arc, Squash & Stretch,
      //     non-linear horizontal pacing (crouch and landing holds), ground shadow, and RenderFlags
      const JA = await import(`${root}/scripts/animations/token-movement.mjs`);
      const fCrouch = JA.computeJumpFrame(0.08, { dx: 300, dy: 0, gridSize: 100, tokenSize: 100 });
      const fApex = JA.computeJumpFrame(0.48, { dx: 300, dy: 0, gridSize: 100, tokenSize: 100 });
      const fLand = JA.computeJumpFrame(0.89, { dx: 300, dy: 0, gridSize: 100, tokenSize: 100 });
      const fRebound = JA.computeJumpFrame(0.95, { dx: 300, dy: 0, gridSize: 100, tokenSize: 100 });
      check(
        fCrouch.scaleX > 1.10 && fCrouch.scaleY < 0.90 && fCrouch.flightProgress < 0.025 &&
        fApex.offsetY < -85 && fApex.scaleX > 1.20 && fApex.shadowScale < 0.68 &&
        fLand.scaleX > 1.10 && fLand.scaleY < 0.90 && fLand.flightProgress === 1 &&
        fRebound.scaleY > 1.01 && fRebound.flightProgress === 1,
        `jump-anim: C2-гладкие фазы приседа на месте (${fCrouch.scaleX.toFixed(2)}×${fCrouch.scaleY.toFixed(2)}, prog=${fCrouch.flightProgress.toFixed(3)}), зенита (offsetY=${Math.round(fApex.offsetY)}, scale=${fApex.scaleX.toFixed(2)}), амортизации посадки (${fLand.scaleX.toFixed(2)}×${fLand.scaleY.toFixed(2)}) и отскока (${fRebound.scaleY.toFixed(2)}) корректны`
      );

      class FakeTokenClass {
        constructor() {
          this.document = { id: 'jt1', x: 100, y: 200, width: 1, height: 1, elevation: 0, rotation: 0, lockRotation: false, movementAction: 'jump' };
          this.w = 100;
          this.h = 100;
          this.visible = true;
          this.mesh = {
            destroyed: false,
            position: { x: 150, y: 250, set(nx, ny) { this.x = nx; this.y = ny; } },
            scale: { x: 0.8, y: 0.8, set(sx, sy) { this.x = sx; this.y = sy; } },
            angle: 0
          };
          this.renderFlags = { set() {} };
        }
        get center() { return { x: this.document.x + 50, y: this.document.y + 50 }; }
        _getAnimationDuration(from, to) { return 1000; }
        _prepareAnimation(from, changes, context, options) { return []; }
        _refreshPosition() { this.mesh.position.set(this.center.x, this.center.y); }
        _refreshMeshSizeAndScale() { this.mesh.scale.set(0.8, 0.8); }
        _refreshRotation() { this.mesh.angle = this.document.rotation; }
        _onDelete() {}
      }
      JA.installJumpAnimationPatch(FakeTokenClass);
      const fakeTok = new FakeTokenClass();
      const jumpDur = fakeTok._getAnimationDuration({ x: 100, y: 200 }, { x: 400, y: 200 }, { action: 'jump' });
      const walkDur = fakeTok._getAnimationDuration({ x: 100, y: 200 }, { x: 400, y: 200 }, { action: 'walk' });
      const walkKb3Dur = fakeTok._getAnimationDuration({ x: 100, y: 200 }, { x: 400, y: 200 }, { action: 'walk', method: 'keyboard' });
      check(jumpDur >= 430 && jumpDur < 800 && walkDur !== jumpDur && walkDur === walkKb3Dur && walkDur === 930,
        `jump-anim: длительность прыжка (${jumpDur} мс) считается отдельно от обычной ходьбы (${walkDur} мс, мышь === WASD)`);

      const animCtx = { duration: jumpDur, time: 0, preAnimate: [], onAnimate: [], postAnimate: [] };
      fakeTok._prepareAnimation({ x: 100, y: 200, width: 1, height: 1 }, { x: 400, y: 200 }, animCtx, { action: 'jump' });
      for (const fn of animCtx.preAnimate) fn(animCtx);
      animCtx.time = jumpDur * 0.5;
      fakeTok.document.x = 250;
      for (const fn of animCtx.onAnimate) fn(animCtx);
      // Verify that standard _refreshPosition and _refreshMeshSizeAndScale DO NOT reset the mid-air arc and scale
      fakeTok._refreshPosition();
      fakeTok._refreshMeshSizeAndScale();
      const midY = fakeTok.mesh.position.y;
      const midScaleX = fakeTok.mesh.scale.x;
      const hasShadowMid = Boolean(fakeTok._ssJumpShadow && !fakeTok._ssJumpShadow.destroyed);
      animCtx.time = jumpDur;
      fakeTok.document.x = 400;
      for (const fn of animCtx.postAnimate) fn(animCtx);
      check(
        midY < 250 - 70 && midScaleX > 0.8 * 1.15 && hasShadowMid &&
        fakeTok.mesh.position.x === 450 && fakeTok.mesh.position.y === 250 &&
        Math.abs(fakeTok.mesh.scale.x - 0.8) < 1e-6 && !fakeTok._ssJumpState &&
        fakeTok._ssJumpShadow && !fakeTok._ssJumpShadow.visible,
        `jump-anim: в зените меш поднят по дуге (y=${Math.round(midY)} < 250, scale=${midScaleX.toFixed(2)}) с тенью, а по завершении чисто возвращён в (450, 250, scale=0.8) со скрытой пулированной тенью`
      );

      // 5f. 2.5D token flight animation (movementAction === 'fly' / 'hover' when elevation > 0):
      //     - at 0 ft elevation (elevation === 0), flight DOES NOT activate (token walks on the ground);
      //     - at elevation > 0, soaring flight activates with wing bobbing, bank tilt, and ground shadow, leaving no snow tracks.
      mStore.clear({ broadcast: false, persist: false });
      for (let gx = 550; gx <= 950; gx += 100) {
        mStore.add([
          mStore.createStain({ t: STAIN.SPLAT, x: gx, y: 550, s: 150, a: 0.82, c: SC2, m: 2, lv: SL2.DRIFT })
        ], { broadcast: false, persist: false });
      }
      mHooks._onPreUpdateToken(
        { id: 'fly-snow', x: 500, y: 500, width: 1, height: 1, elevation: 10, movementAction: 'fly', scene: canvas.scene, actor: { system: { attributes: { hp: { value: 50, max: 50 } } } } },
        { x: 900, y: 500 },
        { method: 'dragging', _movement: { 'fly-snow': { method: 'dragging', passed: { waypoints: [{ x: 900, y: 500, action: 'fly' }] } } } }
      );
      const flySnowDents = mStore.stains.filter(s => s.m === 2 && s.c !== SC2);
      check(flySnowDents.length === 0,
        `snow-movement-fly: летящий токен выше земли (elevation=10, movementAction='fly') не оставляет следов на снегу (${flySnowDents.length})`);

      const fFlyMid = JA.computeFlyFrame(0.5, { dx: 300, dy: 0, gridSize: 100, tokenSize: 100, startHover: 1, endHover: 1 });
      const fHover = JA.computeIdleHoverFrame(1.0, Math.PI * 0.5, { gridSize: 100, tokenSize: 100 });
      const fHoverPhase2 = JA.computeIdleHoverFrame(1.0, Math.PI * 1.35, { gridSize: 100, tokenSize: 100 });
      check(
        fFlyMid.offsetY < -28 && fFlyMid.offsetY > -50 && fFlyMid.scaleX > 1.09 && fFlyMid.tiltAngle > 3.5 && fFlyMid.shadowScale < 0.78 &&
        fHover.offsetY < -24 && fHover.scaleX > 1.09 && fHover.shadowAlpha > 0.20 &&
        fHover. steadyLiftY === -29 && fHoverPhase2.steadyLiftY === fHover.steadyLiftY && fHoverPhase2.offsetY !== fHover.offsetY,
        `fly-anim: кадр крейсерского полёта (offsetY=${Math.round(fFlyMid.offsetY)}, scale=${fFlyMid.scaleX.toFixed(2)}, tilt=${fFlyMid.tiltAngle.toFixed(1)}°) и парения на месте (offsetY=${Math.round(fHover.offsetY)}, steadyTooltipY=${fHover.steadyLiftY}) корректны`
      );

      // At 0 ft elevation (elevation === 0), flight MUST NOT trigger even when movementAction === 'fly'
      fakeTok.document.x = 100;
      fakeTok.document.y = 200;
      fakeTok.document.elevation = 0;
      fakeTok.document.movementAction = 'fly';
      const groundFlyDur = fakeTok._getAnimationDuration({ x: 100, y: 200, elevation: 0 }, { x: 400, y: 200 }, { action: 'fly' });
      const groundFlySeg = JA.isFlyAnimationSegment(fakeTok, { x: 100, y: 200, elevation: 0 }, { x: 400, y: 200 }, { action: 'fly' });
      check(groundFlyDur === walkDur && !groundFlySeg && !JA.isTokenInFlyMode(fakeTok),
        `fly-anim: на высоте 0 футов (elevation=0) анимация полёта отключена (dur=${groundFlyDur}, seg=${groundFlySeg})`);

      // At elevation > 0 ft (elevation = 10), flight operates normally
      fakeTok.document.elevation = 10;
      const flyDur = fakeTok._getAnimationDuration({ x: 100, y: 200, elevation: 10 }, { x: 400, y: 200 }, { action: 'fly' });
      const flyCtx = { duration: flyDur, time: 0, preAnimate: [], onAnimate: [], postAnimate: [] };
      fakeTok._prepareAnimation({ x: 100, y: 200, width: 1, height: 1, elevation: 10 }, { x: 400, y: 200 }, flyCtx, { action: 'fly' });
      for (const fn of flyCtx.preAnimate) fn(flyCtx);
      flyCtx.time = flyDur * 0.5;
      fakeTok.document.x = 250;
      for (const fn of flyCtx.onAnimate) fn(flyCtx);
      fakeTok._refreshPosition();
      fakeTok._refreshMeshSizeAndScale();
      fakeTok._refreshRotation();
      const flyMidY = fakeTok.mesh.position.y;
      const flyMidScale = fakeTok.mesh.scale.x;
      const flyMidAngle = fakeTok.mesh.angle;
      flyCtx.time = flyDur;
      fakeTok.document.x = 400;
      for (const fn of flyCtx.postAnimate) fn(flyCtx);
      const hoverAfterFlyY = fakeTok.mesh.position.y;
      fakeTok.document.elevation = 0;
      JA.clearJumpStateForToken(fakeTok);
      check(
        flyDur >= 420 && flyDur <= 1000 &&
        flyMidY < 250 - 28 && flyMidScale > 0.8 * 1.08 && flyMidAngle > 3 &&
        hoverAfterFlyY < 250 - 20 &&
        fakeTok.mesh.position.x === 450 && fakeTok.mesh.position.y === 250,
        `fly-anim: при elevation=10 меш парит над землёй (y=${Math.round(flyMidY)} < 250, scale=${flyMidScale.toFixed(2)}, angle=${flyMidAngle.toFixed(1)}°), после прилёта остаётся в парении (y=${Math.round(hoverAfterFlyY)}) и чисто сбрасывается в (450, 250)`
      );

      // Verify absence of "walking/bobbing" artifacts in flight and smart WASD deceleration on key release:
      // 1) Vertical flight (dx=0, dy=200) has zero lateral X jerk (`offsetX === 0`),
      //    and `scaleX === scaleY` (no anti-phase squash-and-stretch).
      const fVertFly = JA.computeFlyFrame(0.35, { dx: 0, dy: 200, gridSize: 100, tokenSize: 100, startHover: 1, endHover: 1 });
      // 2) Continuous WASD cruise (`startSpeed=1, endSpeed=1`) maintains constant speed (`paceOffsetX === 0`),
      //    steady altitude (`offsetY === -24` throughout the step), and bank tilt does not reset to 0 at cell boundaries (`u=1`).
      const fWasdCruiseMid = JA.computeFlyFrame(0.5, { dx: 100, dy: 0, gridSize: 100, tokenSize: 100, startHover: 1, endHover: 1, startSpeed: 1, endSpeed: 1 });
      const fWasdCruiseEnd = JA.computeFlyFrame(1.0, { dx: 100, dy: 0, gridSize: 100, tokenSize: 100, startHover: 1, endHover: 1, startSpeed: 1, endSpeed: 1 });
      // 3) WASD chain simulation: 'right' key held -> step 1 accelerates and preserves speed/tilt across the seam ->
      //    key released during step 2 -> smooth deceleration engages and bank tilt returns to 0°.
      globalThis.game = globalThis.game || {};
      globalThis.game.keyboard = { moveKeys: new Set(['right']) };
      fakeTok.document.x = 100;
      fakeTok.document.y = 200;
      fakeTok.document.elevation = 10;
      fakeTok.document._source = { elevation: 10, movementAction: 'fly' };
      fakeTok._ssHoverBlend = 1;
      const kbDur = fakeTok._getAnimationDuration({ x: 100, y: 200, elevation: 10 }, { x: 200, y: 200 }, { action: 'fly', method: 'keyboard' });
      const kbCtx1 = { duration: kbDur, time: 0, preAnimate: [], onAnimate: [], postAnimate: [], chain: [{}] };
      fakeTok._prepareAnimation({ x: 100, y: 200, width: 1, height: 1, elevation: 10 }, { x: 200, y: 200 }, kbCtx1, { action: 'fly', method: 'keyboard' });
      kbCtx1.time = kbDur * 0.9;
      fakeTok.document.x = 190;
      for (const fn of kbCtx1.onAnimate) fn(kbCtx1);
      for (const fn of kbCtx1.postAnimate) fn(kbCtx1);
      const speedAfterHeldStep = fakeTok._ssFlyCruiseSpeed;
      const tiltAfterHeldStep = fakeTok._ssFlyTilt;
      // Step 2: halfway through the step (u = 0.4), the user releases the WASD key
      const kbCtx2 = { duration: kbDur, time: 0, preAnimate: [], onAnimate: [], postAnimate: [], chain: [] };
      fakeTok._prepareAnimation({ x: 200, y: 200, width: 1, height: 1, elevation: 10 }, { x: 300, y: 200 }, kbCtx2, { action: 'fly', method: 'keyboard' });
      kbCtx2.time = kbDur * 0.3;
      fakeTok.document.x = 230;
      for (const fn of kbCtx2.onAnimate) fn(kbCtx2);
      // Release key at u = 0.45
      globalThis.game.keyboard.moveKeys.clear();
      kbCtx2.time = kbDur * 0.45;
      fakeTok.document.x = 245;
      for (const fn of kbCtx2.onAnimate) fn(kbCtx2);
      const tiltAtRelease = fakeTok._ssJumpState.tiltAngle;
      kbCtx2.time = kbDur * 0.85;
      fakeTok.document.x = 285;
      for (const fn of kbCtx2.onAnimate) fn(kbCtx2);
      const tiltDuringDecel = fakeTok._ssJumpState.tiltAngle;
      const paceDuringDecel = fakeTok._ssJumpState.paceOffsetX;
      kbCtx2.time = kbDur;
      fakeTok.document.x = 300;
      for (const fn of kbCtx2.postAnimate) fn(kbCtx2);
      const speedAfterRelease = fakeTok._ssFlyCruiseSpeed;
      JA.clearJumpStateForToken(fakeTok);
      check(
        fVertFly.offsetX === 0 && fVertFly.scaleX === fVertFly.scaleY &&
        Math.abs(fWasdCruiseMid.paceOffsetX) < 1e-4 && fWasdCruiseMid.offsetY === -24 && fWasdCruiseEnd.tiltAngle > 3 &&
        kbDur >= 280 && kbDur <= 360 &&
        speedAfterHeldStep === 1 && tiltAfterHeldStep > 3 &&
        tiltDuringDecel < tiltAtRelease && tiltDuringDecel > 0 && paceDuringDecel > 0 &&
        speedAfterRelease === 0,
        `fly-wasd-smart-decel: чистый полёт без шагания (vertOffsetX=${fVertFly.offsetX}, cruisePace=${fWasdCruiseMid.paceOffsetX}), при зажатом WASD скорость сохраняется (speed=${speedAfterHeldStep}, tilt=${tiltAfterHeldStep.toFixed(1)}°), а при отпускании срабатывает плавное замедление (tilt ${tiltAtRelease.toFixed(1)}° -> ${tiltDuringDecel.toFixed(1)}° -> 0°, pace=+${paceDuringDecel.toFixed(1)}px)`
      );

      // Verify walk animation (`walk`):
      //  - lively bounce on each step (`offsetY < -7`), springy Squash & Stretch (`scaleY > scaleX` at step apex),
      //    foot-to-foot body sway (`tiltAngle` flips sign as `stepParity: 1 -> -1` alternates);
      //  - teleport (`action: 'blink'` or `teleport: true`) does not trigger walk animation.
      const fWalkStep1 = JA.computeWalkFrame(0.5, { dx: 100, dy: 0, gridSize: 100, tokenSize: 100, stepParity: 1 });
      const fWalkStep2 = JA.computeWalkFrame(0.5, { dx: 100, dy: 0, gridSize: 100, tokenSize: 100, stepParity: -1 });
      const walkSegOk = JA.isWalkAnimationSegment(fakeTok, { x: 100, y: 200, elevation: 0 }, { x: 300, y: 200 }, { action: 'walk' });
      const blinkWalkSeg = JA.isWalkAnimationSegment(fakeTok, { x: 100, y: 200, elevation: 0 }, { x: 300, y: 200 }, { action: 'blink', teleport: true });
      fakeTok.document.x = 100;
      fakeTok.document.y = 200;
      fakeTok.document.elevation = 0;
      fakeTok.document.movementAction = 'walk';
      fakeTok.document._source = { elevation: 0, movementAction: 'walk' };
      const walkCtx = { duration: 400, time: 0, preAnimate: [], onAnimate: [], postAnimate: [] };
      fakeTok._prepareAnimation({ x: 100, y: 200, width: 1, height: 1, elevation: 0 }, { x: 200, y: 200 }, walkCtx, { action: 'walk' });
      walkCtx.time = 200;
      fakeTok.document.x = 150;
      for (const fn of walkCtx.onAnimate) fn(walkCtx);
      const walkMidY = fakeTok.mesh.position.y;
      const walkMidAngle = fakeTok.mesh.angle;
      walkCtx.time = 400;
      fakeTok.document.x = 200;
      for (const fn of walkCtx.postAnimate) fn(walkCtx);
      const walkEndY = fakeTok.mesh.position.y;
      const walkEndAngle = fakeTok.mesh.angle;
      check(
        walkSegOk && !blinkWalkSeg &&
        fWalkStep1.offsetY < -7 && fWalkStep1.scaleY > fWalkStep1.scaleX &&
        fWalkStep1.tiltAngle > 2 && fWalkStep2.tiltAngle < -0.5 &&
        walkMidY < 250 - 7 && Math.abs(walkMidAngle) > 2 &&
        walkEndY === 250 && walkEndAngle === 0,
        `walk-anim: живая походка (liftY=${fWalkStep1.offsetY.toFixed(1)}px, sway=${fWalkStep1.tiltAngle.toFixed(1)}° / ${fWalkStep2.tiltAngle.toFixed(1)}°), меш подпрыгивает на шаге (y=${Math.round(walkMidY)} < 250) и возвращается в (y=${walkEndY}, angle=${walkEndAngle}°)`
      );

      // Verify character-sheet-relative movement speed scaling (`actor.system.attributes.movement`):
      //  - a 50 ft / 60 ft creature traverses distance faster than the 30 ft baseline, while a 15 ft creature is slower.
      const slowTok = { document: { movementAction: 'walk' }, actor: { system: { attributes: { movement: { walk: 15, units: 'ft' } } } } };
      const normTok = { document: { movementAction: 'walk' }, actor: { system: { attributes: { movement: { walk: 30, units: 'ft' } } } } };
      const fastTok = { document: { movementAction: 'walk' }, actor: { system: { attributes: { movement: { walk: 60, units: 'ft' } } } } };
      const durSlow = JA.computeWalkDurationMs(300, 100, undefined, { token: slowTok });
      const durNorm = JA.computeWalkDurationMs(300, 100, undefined, { token: normTok });
      const durNormKb = JA.computeWalkDurationMs(300, 100, undefined, { token: normTok, keyboard: true });
      const durFast = JA.computeWalkDurationMs(300, 100, undefined, { token: fastTok });
      const flyDrag1 = JA.computeFlyDurationMs(100, 100, undefined, { token: normTok, keyboard: false });
      const flyKb1 = JA.computeFlyDurationMs(100, 100, undefined, { token: normTok, keyboard: true });
      const animSpeedSlow = JA.computeTokenAnimationSpeed(slowTok, { action: 'walk' });
      const animSpeedFast = JA.computeTokenAnimationSpeed(fastTok, { action: 'walk' });

      // Calibrate distance-invariant speed across 1, 3, 6, and 12 cells:
      //  - duration is strictly proportional to distance (`dur / dist === const`);
      //  - mid-drag instantaneous speed over a long move (e.g. 10 cells) DOES NOT spike to 1.77x (unlike a global S-curve),
      //    staying at a steady cruise rate (`~1.02..1.05x`) identical to a short move;
      //  - walk step cadence is exactly 1 step per grid cell at any distance (no `Math.min(8, ...)` cap).
      const wDur1 = JA.computeWalkDurationMs(100, 100, undefined, { token: normTok });
      const wDur3 = JA.computeWalkDurationMs(300, 100, undefined, { token: normTok });
      const wDur6 = JA.computeWalkDurationMs(600, 100, undefined, { token: normTok });
      const wDur12 = JA.computeWalkDurationMs(1200, 100, undefined, { token: normTok });
      const fDur1 = JA.computeFlyDurationMs(100, 100, undefined, { token: normTok });
      const fDur6 = JA.computeFlyDurationMs(600, 100, undefined, { token: normTok });
      const fDur12 = JA.computeFlyDurationMs(1200, 100, undefined, { token: normTok });
      // Check instantaneous cruise speed at the midpoint of 10-cell and 2-cell walks (px/ms):
      const w10Dur = JA.computeWalkDurationMs(1000, 100, undefined, { token: normTok });
      const w2Dur = JA.computeWalkDurationMs(200, 100, undefined, { token: normTok });
      const w10A = JA.computeWalkFrame(0.49, { dx: 1000, dy: 0, gridSize: 100, tokenSize: 100 });
      const w10B = JA.computeWalkFrame(0.51, { dx: 1000, dy: 0, gridSize: 100, tokenSize: 100 });
      const w2A = JA.computeWalkFrame(0.49, { dx: 200, dy: 0, gridSize: 100, tokenSize: 100 });
      const w2B = JA.computeWalkFrame(0.51, { dx: 200, dy: 0, gridSize: 100, tokenSize: 100 });
      const vMidWalk10 = ((w10B.flightProgress - w10A.flightProgress) * 1000) / (0.02 * w10Dur);
      const vMidWalk2 = ((w2B.flightProgress - w2A.flightProgress) * 200) / (0.02 * w2Dur);
      const vAvgWalk = 100 / wDur1;
      // Check first WASD step responsiveness (`startSpeed = 0, endSpeed = 1`):
      // by `u = 0.05` the token is already moving noticeably (`flightProgress > 0.02`) rather than stalling in a zero derivative
      const wasdFirstStepEarly = JA.computeWalkFrame(0.05, { dx: 100, dy: 0, gridSize: 100, tokenSize: 100, startSpeed: 0, endSpeed: 1 });
      globalThis.game.keyboard.moveKeys = new Set(['right', 'up']);
      const dirVec = JA.getActiveMoveDirectionVector();
      globalThis.game.keyboard.moveKeys.clear();
      check(
        durNorm === durNormKb && flyDrag1 === flyKb1 &&
        durFast < durNorm && durNorm < durSlow &&
        animSpeedFast > animSpeedSlow * 1.8 &&
        wDur3 === wDur1 * 3 && wDur6 === wDur1 * 6 && wDur12 === wDur1 * 12 &&
        fDur6 === fDur1 * 6 && fDur12 === fDur1 * 12 &&
        Math.abs(vMidWalk10 - vAvgWalk) / vAvgWalk < 0.04 &&
        Math.abs(vMidWalk2 - vMidWalk10) / vAvgWalk < 0.08 &&
        wasdFirstStepEarly.flightProgress > 0.02 &&
        dirVec.dx === 1 && dirVec.dy === -1,
        `token-speed-sheet: скорость стабильна на любой дистанции (1кл=${wDur1}мс, 6кл=${wDur6}мс, 12кл=${wDur12}мс, vMid10=${vMidWalk10.toFixed(3)}px/мс ≈ vAvg=${vAvgWalk.toFixed(3)}px/мс), перетаскивание === WASD и масштабируется от листа (60ft=${durFast}мс < 30ft=${durNorm}мс < 15ft=${durSlow}мс)`
      );

      // Vertical takeoff in place on elevation increase (0 -> 5 ft, dx=0, dy=0)
      // and no spurious landing/takeoff during redraws (`token.visible = false` in `PlaceableObject#draw`)
      // or when climbing further while already airborne (`5 -> 10` ft):
      fakeTok.document.x = 100;
      fakeTok.document.y = 200;
      fakeTok.document.elevation = 0;
      fakeTok.document.movementAction = 'fly';
      fakeTok.document._source = { elevation: 0, movementAction: 'fly' };
      JA.syncTokenFlyHover(fakeTok);
      fakeTok.document.elevation = 5;
      fakeTok.document._source = { elevation: 5, movementAction: 'fly' };
      const takeoffSeg = JA.isFlyAnimationSegment(fakeTok, { x: 100, y: 200, elevation: 0 }, { elevation: 5 }, { action: 'fly' });
      const takeoffDur = fakeTok._getAnimationDuration({ x: 100, y: 200, elevation: 0 }, { x: 100, y: 200, elevation: 5 }, { action: 'fly' });
      JA.syncTokenFlyHover(fakeTok, { elevation: 5 });
      const targetAtTakeoff = fakeTok._ssHoverTarget;
      const blendStartTakeoff = fakeTok._ssHoverBlend;
      // Set hover blend at 5 ft to 1.0 and emulate PlaceableObject#draw() setting `this.visible = false` before drawToken
      fakeTok._ssHoverBlend = 1;
      fakeTok.visible = false;
      JA.syncTokenFlyHover(fakeTok);
      fakeTok.visible = true;
      const blendAfterDraw = fakeTok._ssHoverBlend;
      const targetAfterDraw = fakeTok._ssHoverTarget;
      // Climbing from 5 ft to 10 ft: neither landing nor re-takeoff triggers (blend stays 1, target stays 1)
      fakeTok.document.elevation = 10;
      fakeTok.document._source = { elevation: 10, movementAction: 'fly' };
      JA.syncTokenFlyHover(fakeTok, { elevation: 10 });
      const blendAt10ft = fakeTok._ssHoverBlend;
      const targetAt10ft = fakeTok._ssHoverTarget;
      JA.clearJumpStateForToken(fakeTok, { destroyShadow: true });
      check(
        takeoffSeg && takeoffDur === 0 &&
        targetAtTakeoff === 1 && blendStartTakeoff === 0 &&
        blendAfterDraw === 1 && targetAfterDraw === 1 &&
        blendAt10ft === 1 && targetAt10ft === 1 && !fakeTok._ssJumpShadow,
        `fly-takeoff: взлёт 0->5 фт плавный (target=${targetAtTakeoff}, startBlend=${blendStartTakeoff}), перерисовка drawToken с visible=false не сбрасывает полёт (blend=${blendAfterDraw}), а при подъёме 5->10 фт приземление/взлёт не проигрываются (blend=${blendAt10ft}, target=${targetAt10ft})`
      );

      // Smart relative elevation perspective for scene and tokens (`computeElevationPerspective` + `syncElevationPerspective`):
      //  1) Ground-level view (`observer = 0 ft`) looking up at a flying token at `60 ft`:
      //     token appears larger (`worldScale > 1.25`, `perspectiveScale > 1.25`), hovers much higher (`perspectiveOffsetY < -35px`),
      //     exhibits 3D parallax relative to camera center, and casts a smaller, softer ground shadow (`shadowScaleMult < 0.70`, `shadowAlphaMult < 0.65`).
      //  2) High-altitude view (`observer = 60 ft`) looking down at the scene and ground tokens (`0 ft`):
      //     scene camera zooms out (`cameraZoom < 0.80`), shrinking map and ground tokens in sync (`perspectiveScale < 0.80`),
      //     scene background and lower objects receive Depth-of-Field blur (`dofBlurPx > 3.0`),
      //     while the 60 ft token itself stays sharp (`dofBlurPx === 0`) at normal screen scale (`perspectiveScale === 1.0`).
      const p10ftFromGround = JA.computeElevationPerspective(10, 0, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1 });
      const pGroundFrom10ft = JA.computeElevationPerspective(0, 10, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 0 });
      const pGroundFrom20ft = JA.computeElevationPerspective(0, 20, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 0 });
      const pHighZoomOut = JA.computeElevationPerspective(60, 0, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1, cameraScale: 0.6 });
      const pHighZoomMid = JA.computeElevationPerspective(60, 0, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1, cameraScale: 1.0 });
      const pHighZoomNear = JA.computeElevationPerspective(60, 0, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1, cameraScale: 1.28 });
      const pHighZoomIn = JA.computeElevationPerspective(60, 0, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1, cameraScale: 1.6 });
      const pHighFromGround = JA.computeElevationPerspective(60, 0, {
        gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1,
        tokenCenter: { x: 600, y: 200 }, cameraCenter: { x: 300, y: 200 }
      });
      const pHighParallaxNorthCam = JA.computeElevationPerspective(60, 0, {
        gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1,
        tokenCenter: { x: 300, y: 500 }, cameraCenter: { x: 300, y: 200 }
      });
      const pGroundFromHigh = JA.computeElevationPerspective(0, 60, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 0 });
      const pHighSelf = JA.computeElevationPerspective(60, 60, { gridSize: 100, gridDistance: 5, tokenSize: 100, hoverBlend: 1 });
      const highTok = new FakeTokenClass();
      highTok.document.id = 'high-60';
      highTok.document.elevation = 60;
      highTok.document._source = { elevation: 60, movementAction: 'fly' };
      highTok.document.movementAction = 'fly';
      highTok._ssHoverBlend = 1;
      const groundTok = new FakeTokenClass();
      groundTok.document.id = 'ground-0';
      groundTok.document.elevation = 0;
      groundTok.document._source = { elevation: 0, movementAction: 'walk' };
      groundTok.document.movementAction = 'walk';
      const prevPlaceables = canvas.tokens?.placeables;
      const prevControlled = canvas.tokens?.controlled;
      canvas.tokens.placeables = [highTok, groundTok];
      canvas.tokens.controlled = [groundTok];
      JA.syncTokenFlyHover(highTok);
      JA.syncElevationPerspective({ immediate: true });
      const highScaleFromGround = highTok.mesh.scale.x;
      const highYFromGround = highTok.mesh.position.y;
      const groundScaleNormal = groundTok.mesh.scale.x;
      // Switch viewpoint to the token at 60 ft elevation
      canvas.tokens.controlled = [highTok];
      JA.syncElevationPerspective({ immediate: true });
      const highScaleWhenSelected = highTok.mesh.scale.x;
      const groundScaleFrom60ft = groundTok.mesh.scale.x;
      // Restore viewpoint back to ground level
      canvas.tokens.controlled = [];
      JA.syncElevationPerspective({ immediate: true });
      const groundScaleRestored = groundTok.mesh.scale.x;
      JA.clearJumpStateForToken(highTok, { destroyShadow: true });

      // Verify smooth per-frame `_ssVisualElevation` interpolation for a `'walk'`-mode token (`25 -> 60 ft`)
      // and synchronization with `observerElevation` without stalling at an intermediate elevation
      const walkHighTok = new FakeTokenClass();
      walkHighTok.document.id = 'walk-high';
      walkHighTok.document.elevation = 25;
      walkHighTok.document._source = { elevation: 25, movementAction: 'walk' };
      walkHighTok.document.movementAction = 'walk';
      walkHighTok.controlled = true;
      const tickFns = [];
      const prevTicker = canvas.app?.ticker;
      if (!canvas.app) canvas.app = {};
      canvas.app.ticker = {
        add(fn) { if (!tickFns.includes(fn)) tickFns.push(fn); },
        remove(fn) { const i = tickFns.indexOf(fn); if (i >= 0) tickFns.splice(i, 1); }
      };
      canvas.tokens.placeables = [walkHighTok, groundTok];
      canvas.tokens.controlled = [walkHighTok];
      JA.syncTokenFlyHover(walkHighTok);
      JA.syncElevationPerspective({ immediate: true });
      walkHighTok.document.elevation = 60;
      walkHighTok.document._source = { elevation: 60, movementAction: 'walk' };
      JA.syncTokenFlyHover(walkHighTok, { elevation: 60 });
      JA.syncElevationPerspective();
      const visStart = walkHighTok._ssVisualElevation;
      for (let i = 0; i < 3; i++) {
        for (const fn of [...tickFns]) fn();
      }
      const visMid = walkHighTok._ssVisualElevation;
      const obsMid = JA.getObserverElevation();
      for (let i = 0; i < 65; i++) {
        for (const fn of [...tickFns]) fn();
      }
      const visEnd = walkHighTok._ssVisualElevation;
      const obsEnd = JA.getObserverElevation();
      const tickerStoppedCleanly = tickFns.length === 0;
      canvas.app.ticker = prevTicker;
      JA.clearJumpStateForToken(walkHighTok, { destroyShadow: true });
      JA.clearJumpStateForToken(highTok, { destroyShadow: true });
      JA.clearJumpStateForToken(groundTok, { destroyShadow: true });
      canvas.tokens.placeables = prevPlaceables;
      canvas.tokens.controlled = prevControlled;
      check(
        p10ftFromGround.worldScale > 1.01 && p10ftFromGround.worldScale < 1.04 &&
        pGroundFrom10ft.dofBlurPx === 0 && pGroundFrom20ft.dofBlurPx > 0.15 && pGroundFrom20ft.dofBlurPx < 0.45 &&
        pHighZoomOut.worldScale < pHighZoomMid.worldScale && pHighZoomMid.worldScale < pHighZoomNear.worldScale &&
        pHighZoomOut.dofBlurPx < 0.45 && pHighZoomNear.dofBlurPx > 1.8 &&
        pHighZoomOut.cameraOcclusionAlpha === 1 && pHighZoomNear.cameraOcclusionAlpha > 0.2 && pHighZoomNear.cameraOcclusionAlpha < 0.9 && pHighZoomIn.cameraOcclusionAlpha === 0 &&
        pHighFromGround.worldScale > 1.25 && pHighFromGround.perspectiveScale > 1.25 && pHighFromGround.perspectiveOffsetY < -35 &&
        pHighFromGround.parallaxOffsetX > 20 && pHighParallaxNorthCam.parallaxOffsetY > 5 &&
        pHighFromGround.shadowScaleMult < 0.70 && pHighFromGround.shadowAlphaMult < 0.66 &&
        pGroundFromHigh.cameraZoom < 0.80 && pGroundFromHigh.perspectiveScale < 0.80 && pGroundFromHigh.dofBlurPx > 1.5 && pGroundFromHigh.dofBlurPx < 2.5 &&
        Math.abs(pHighSelf.perspectiveScale - 1) < 1e-6 && pHighSelf.dofBlurPx === 0 && pHighSelf.shadowOffsetY > 20 &&
        highScaleFromGround > 0.8 * 1.35 && highYFromGround < 250 - 60 &&
        Math.abs(groundScaleNormal - 0.8) < 1e-6 &&
        highScaleWhenSelected < highScaleFromGround && Math.abs(highScaleWhenSelected - 0.8 * 1.10) < 0.02 &&
        groundScaleFrom60ft < 0.8 * 0.80 &&
        Math.abs(groundScaleRestored - 0.8) < 1e-6 &&
        visStart === 25 && visMid > 25 && visMid < 60 && Math.abs(visMid - obsMid) < 1e-6 &&
        visEnd === 60 && obsEnd === 60 && tickerStoppedCleanly,
        `elevation-perspective: гладкий C²-старт на 10..20 фт (scale10=${p10ftFromGround.worldScale.toFixed(3)}, blur20=${pGroundFrom20ft.dofBlurPx.toFixed(2)}px), 3D-объём при зуме к 60 фт (ws=${pHighZoomOut.worldScale.toFixed(2)}->${pHighZoomMid.worldScale.toFixed(2)}->${pHighZoomNear.worldScale.toFixed(2)}, bokeh=${pHighZoomNear.dofBlurPx.toFixed(2)}px, alpha=${pHighZoomOut.cameraOcclusionAlpha}->${pHighZoomNear.cameraOcclusionAlpha.toFixed(2)}->${pHighZoomIn.cameraOcclusionAlpha}), 360°-параллакс (dx=+${pHighFromGround.parallaxOffsetX.toFixed(1)}, dy=+${pHighParallaxNorthCam.parallaxOffsetY.toFixed(1)}) и взгляд с 60 фт (camZoom=${pGroundFromHigh.cameraZoom.toFixed(2)}, dofBlur=${pGroundFromHigh.dofBlurPx.toFixed(2)}px)`
      );

      // Verify suppression of per-frame private `#animationData.elevation` interpolation in Foundry v14
      // and suppression of spurious `ActiveEffect("falling")` in dnd5e 6.0.0 (`TokenDocument5e.prototype._isFalling`) when `movementAction === 'fly'`
      const privAnimData = { x: 100, y: 200, elevation: 0 };
      class FakeTokenV14ElevClass extends FakeTokenClass {
        _prepareAnimation(from, changes) {
          return [{ attribute: 'elevation', parent: privAnimData, from: from.elevation ?? 0, to: changes.elevation ?? 10 }];
        }
      }
      class FakeTokenDoc5e {
        constructor() {
          this.elevation = 10;
          this.movementAction = 'fly';
          this.actor = { statuses: new Set(), system: { attributes: { movement: { speeds: { fly: 0 } } } } };
        }
        _isFalling() {
          const canFly = this.actor?.system?.attributes?.movement?.speeds?.fly
            && !this.actor.statuses.has('prone') && !this.actor.statuses.has('incapacitated');
          return !canFly && this.elevation > 0;
        }
      }
      globalThis.CONFIG = globalThis.CONFIG || {};
      globalThis.CONFIG.Token = { ...(globalThis.CONFIG.Token || {}), documentClass: FakeTokenDoc5e };
      JA.installJumpAnimationPatch(FakeTokenV14ElevClass);
      const tokV14 = new FakeTokenV14ElevClass();
      const elevAttrs = tokV14._prepareAnimation({ x: 100, y: 200, elevation: 0 }, { elevation: 10 }, {}, { action: 'walk' });
      const doc5e = new FakeTokenDoc5e();
      const fallingWhenFlying = doc5e._isFalling();
      doc5e.movementAction = 'walk';
      const fallingWhenWalking = doc5e._isFalling();
      check(
        privAnimData.elevation === 10 && elevAttrs[0].from === 10 && elevAttrs[0].to === 10 &&
        fallingWhenFlying === false && fallingWhenWalking === true,
        `fly-v14-dnd5e-no-freeze: #animationData.elevation мгновенно ставится в a.to (${privAnimData.elevation}, delta=0), а dnd5e _isFalling при movementAction='fly' не спамит ActiveEffect falling (fly=${fallingWhenFlying}, walk=${fallingWhenWalking})`
      );

      // 5f-fall. Falling animation (`Falling` / `statusId: "falling"` / `plummet()`):
      //  - `isTokenFalling` detects `actor.statuses.has('falling')`, `document.hasStatusEffect('falling')`, and `movementAction === 'fall'`,
      //    and forces `isTokenInFlyMode(token) === false`;
      //  - `computeFallingLoopFrame` produces turbulent mid-air sway (`tiltAngle`, `offsetX`, `scaleY > scaleX`),
      //    keeping a stationary `steadyLiftY` so the clickable `falling.svg` status icon stays steady;
      //  - `computeFallPlungeFrame` accelerates along a gravity parabola during the dive (`u < 0.56`, `scaleY > 1.15 > scaleX`),
      //    squashes the token on ground impact (`u ~ 0.64`, `scaleX > 1.22`, `scaleY < 0.80`), and settles to `1.0x, 0px, 0°` at `u = 1`;
      //  - `syncTokenFlyHover` starts the continuous falling loop when the `falling` status appears and triggers `_ssFallPlunge` on `plummet()` (`60 -> 0 ft`).
      const fallLoop0 = JA.computeFallingLoopFrame(1, 0, { gridSize: 100, tokenSize: 100, elevation: 60 });
      const fallLoopMid = JA.computeFallingLoopFrame(1, 0.5, { gridSize: 100, tokenSize: 100, elevation: 60 });
      const plungeStart = JA.computeFallPlungeFrame(0, { fromElevation: 60, toElevation: 0, gridSize: 100, tokenSize: 100 });
      const plungeAir = JA.computeFallPlungeFrame(0.45, { fromElevation: 60, toElevation: 0, gridSize: 100, tokenSize: 100 });
      const plungePreImp = JA.computeFallPlungeFrame(0.5599, { fromElevation: 60, toElevation: 0, gridSize: 100, tokenSize: 100 });
      const plungePostImp = JA.computeFallPlungeFrame(0.5601, { fromElevation: 60, toElevation: 0, gridSize: 100, tokenSize: 100 });
      const plungeImpact = JA.computeFallPlungeFrame(0.64, { fromElevation: 60, toElevation: 0, gridSize: 100, tokenSize: 100 });
      const plungeEnd = JA.computeFallPlungeFrame(1.0, { fromElevation: 60, toElevation: 0, gridSize: 100, tokenSize: 100 });
      const impactSeamContinuous = Math.abs(plungePreImp.tiltAngle - plungePostImp.tiltAngle) < 0.2 &&
        Math.abs(plungePreImp.scaleX - plungePostImp.scaleX) < 0.01 &&
        Math.abs(plungePreImp.scaleY - plungePostImp.scaleY) < 0.01;
      const fallTok = new FakeTokenClass();
      fallTok.document.id = 'fall-tok';
      fallTok.document.elevation = 60;
      fallTok.document._source = { elevation: 60, movementAction: 'fly' };
      fallTok.document.movementAction = 'fly';
      fallTok.actor = { statuses: new Set(['falling']) };
      // Live drag-preview clone under the cursor while dragging a falling token
      const dragPreviewClone = {
        isPreview: true,
        destroyed: false,
        w: 100,
        h: 100,
        document: { x: 400, y: 250, width: 1, height: 1, rotation: 0, lockRotation: false },
        get center() { return { x: this.document.x + 50, y: this.document.y + 50 }; },
        mesh: {
          destroyed: false,
          position: { x: 450, y: 300, set(nx, ny) { this.x = nx; this.y = ny; } },
          scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
          angle: 0
        }
      };
      fallTok._preview = dragPreviewClone;
      const detectedFalling = JA.isTokenFalling(fallTok);
      const flySuppressedWhenFalling = JA.isTokenInFlyMode(fallTok) === false;
      const fallTickFns = [];
      const prevFallTicker = canvas.app?.ticker;
      if (!canvas.app) canvas.app = {};
      canvas.app.ticker = {
        add(fn) { if (!fallTickFns.includes(fn)) fallTickFns.push(fn); },
        remove(fn) { const i = fallTickFns.indexOf(fn); if (i >= 0) fallTickFns.splice(i, 1); }
      };
      const syncedFallingLoop = JA.syncTokenFlyHover(fallTok);
      for (let i = 0; i < 6; i++) {
        for (const fn of [...fallTickFns]) fn();
      }
      const inFallingLoopScaleY = fallTok._ssJumpState?.scaleY ?? 1;
      const dragPreviewSynced = Math.abs(dragPreviewClone.mesh.angle - fallTok.mesh.angle) < 1e-4 &&
        dragPreviewClone.mesh.position.y < 300 - 15;
      // Verify that neither WASD (1 cell) nor mouse dragging (8 cells) disturbs `_ssHoverPhase` or enables `_ssActiveMoveAnim`
      const phaseBeforeWasd = fallTok._ssHoverPhase;
      const wasdCtx = { duration: 310, time: 0, onAnimate: [], postAnimate: [] };
      JA.attachJumpAnimationToContext(fallTok, { x: 100, y: 200, elevation: 60 }, { x: 200 }, wasdCtx, { method: 'keyboard', action: 'walk' });
      for (const t of [80, 160, 250, 310]) {
        wasdCtx.time = t;
        for (const fn of wasdCtx.onAnimate) fn(wasdCtx);
      }
      for (const fn of wasdCtx.postAnimate) fn();
      const wasdDidNotDisturbPhase = Math.abs(fallTok._ssHoverPhase - phaseBeforeWasd) < 1e-6 && !fallTok._ssActiveMoveAnim;
      const dragCtx = { duration: 2480, time: 0, onAnimate: [], postAnimate: [] };
      JA.attachJumpAnimationToContext(fallTok, { x: 200, y: 200, elevation: 60 }, { x: 1000 }, dragCtx, { method: 'dragging', action: 'walk' });
      for (const t of [400, 1200, 2000, 2480]) {
        dragCtx.time = t;
        for (const fn of dragCtx.onAnimate) fn(dragCtx);
      }
      for (const fn of dragCtx.postAnimate) fn();
      const dragDidNotDisturbPhase = Math.abs(fallTok._ssHoverPhase - phaseBeforeWasd) < 1e-6 && !fallTok._ssActiveMoveAnim;
      fallTok._preview = null;

      // Verify step-down elevation adjustments via Q (`60 -> 55` ft and `55 -> 10` ft with supporting floor at `0` ft):
      // while empty air remains underneath (still falling), the landing plunge `_ssFallPlunge` MUST NOT start!
      fallTok.document.parent = {};
      fallTok.document._findSupportingSurface = ({ position }) => ({ elevation: 0, level: null, region: null });
      fallTok.document.elevation = 55;
      fallTok.document._source = { elevation: 55, movementAction: 'walk' };
      fallTok.document.movementAction = 'walk';
      JA.syncTokenFlyHover(fallTok, { elevation: 55 }, {});
      const qStepInAirNoPlunge = !fallTok._ssFallPlunge && JA.isTokenFalling(fallTok);
      for (let i = 0; i < 8; i++) {
        for (const fn of [...fallTickFns]) fn();
      }
      // Simulate clicking the falling icon (`TokenDocument5e#plummet()`: dropping elevation `55 -> 0` with `{ animate: false, dnd5e: { fall: { distance: 55 } } }`)
      fallTok.document.elevation = 0;
      fallTok.document._source = { elevation: 0, movementAction: 'fall' };
      fallTok.actor.statuses.delete('falling');
      JA.syncTokenFlyHover(fallTok, { elevation: 0 }, { action: 'fall', dnd5e: { fall: { distance: 55 } } });
      const plungeStarted = Boolean(fallTok._ssFallPlunge) && fallTok._ssVisualElevation === 55;
      // Verify that pressing WASD mid-plunge (`_ssFallPlunge`) DOES NOT reset `_ssFallPlunge` to null
      const midPlungeWasdCtx = { duration: 310, time: 0, onAnimate: [], postAnimate: [] };
      JA.attachJumpAnimationToContext(fallTok, { x: 200, y: 200, elevation: 0 }, { x: 300 }, midPlungeWasdCtx, { method: 'keyboard', action: 'walk' });
      const plungeSurvivedWasdAndDrag = Boolean(fallTok._ssFallPlunge) && !fallTok._ssActiveMoveAnim;
      for (const fn of midPlungeWasdCtx.postAnimate) fn();
      // Verify that a subsequent `deleteActiveEffect` hook (`syncTokenFlyHover(fallTok)`) does not abort an active `_ssFallPlunge`
      JA.syncTokenFlyHover(fallTok);
      const plungeSurvivedStatusDelete = Boolean(fallTok._ssFallPlunge);
      for (let i = 0; i < 280; i++) {
        for (const fn of [...fallTickFns]) fn();
      }
      const plungeCompletedCleanly = !fallTok._ssFallPlunge && !fallTok._ssJumpState && fallTok._ssLastElevation === 0 && fallTickFns.length === 0;

      // Verify automatic flight activation when actor sheet fly speed > 1 ft (even with `movementAction === 'walk'`)
      const sheetFlyTok = new FakeTokenClass();
      sheetFlyTok.document.elevation = 15;
      sheetFlyTok.document._source = { elevation: 15, movementAction: 'walk' };
      sheetFlyTok.document.movementAction = 'walk';
      sheetFlyTok.actor = { statuses: new Set(), system: { attributes: { movement: { speeds: { walk: 30, fly: 30 }, units: 'ft' } } } };
      const sheetFlyActive = JA.hasActorSheetFlySpeed(sheetFlyTok)
        && JA.isTokenInFlyMode(sheetFlyTok)
        && JA.isFlyAnimationSegment(sheetFlyTok, { x: 100, y: 100, elevation: 15 }, { x: 200 }, { method: 'keyboard', action: 'walk' });
      sheetFlyTok.actor.system.attributes.movement.speeds.fly = 1; // <= 1 ft DOES NOT enable flight
      const sheetFlyThresholdRespected = !JA.hasActorSheetFlySpeed(sheetFlyTok) && !JA.isTokenInFlyMode(sheetFlyTok);

      canvas.app.ticker = prevFallTicker;
      JA.clearJumpStateForToken(fallTok, { destroyShadow: true });
      check(
        detectedFalling && flySuppressedWhenFalling &&
        sheetFlyActive && sheetFlyThresholdRespected &&
        qStepInAirNoPlunge &&
        fallLoop0.steadyLiftY === fallLoopMid.steadyLiftY &&
        Math.abs(fallLoopMid.tiltAngle) > 8 && Math.abs(fallLoopMid.tiltAngle) < 12.5 && fallLoopMid.scaleY > fallLoopMid.scaleX &&
        impactSeamContinuous &&
        plungeStart.visualElevation === 60 && plungeAir.visualElevation < 40 && plungeAir.visualElevation > 0 &&
        plungeAir.scaleY > 1.15 && plungeAir.scaleX < 0.90 &&
        plungeImpact.visualElevation === 0 && plungeImpact.scaleX > 1.22 && plungeImpact.scaleY < 0.80 && plungeImpact.offsetY > 5 &&
        plungeEnd.scaleX === 1 && plungeEnd.scaleY === 1 && plungeEnd.offsetY === 0 && plungeEnd.tiltAngle === 0 &&
        syncedFallingLoop && inFallingLoopScaleY > 1.03 && inFallingLoopScaleY < 1.09 &&
        dragPreviewSynced && wasdDidNotDisturbPhase && dragDidNotDisturbPhase && plungeSurvivedWasdAndDrag &&
        plungeStarted && plungeSurvivedStatusDelete && plungeCompletedCleanly,
        `falling-anim: статус Falling ослаблен и изолирован от WASD/drag/Q-в-воздухе (tilt=${fallLoopMid.tiltAngle.toFixed(1)}°, scaleY=${fallLoopMid.scaleY.toFixed(2)}, sheetFly>1ft=ok), а приземление ведёт пике (stretch=${plungeAir.scaleY.toFixed(2)}x) и удар (squash=${plungeImpact.scaleX.toFixed(2)}x/${plungeImpact.scaleY.toFixed(2)}x)`
      );

      // 5f-floor. Floor detection system: pixel-perfect tiles (no walking on transparent air pixels) + standing on other tokens
      const prevTiles = canvas.tiles;
      const prevFloorPlaceables = canvas.tokens.placeables;
      // 300x300 tile at 20 ft elevation: opaque bridge plank runs ONLY along y ∈ [125..175]; the rest of the PNG bounds is transparent air (alpha = 0)
      const bridgeTile = {
        destroyed: false,
        document: { id: 'bridge-tile-20', x: 0, y: 0, width: 300, height: 300, elevation: 20, alpha: 1, hidden: false, _source: { elevation: 20 } },
        mesh: {
          destroyed: false,
          _texture: { valid: true, width: 300, height: 300 },
          canvasBounds: { minX: 0, minY: 0, maxX: 300, maxY: 300, contains(px, py) { return px >= 0 && px <= 300 && py >= 0 && py <= 300; } },
          containsCanvasPoint(pt, thr = 0.25) {
            const alpha = (pt.x >= 0 && pt.x <= 300 && pt.y >= 125 && pt.y <= 175) ? 1.0 : 0.0;
            return alpha >= thr;
          }
        }
      };
      // Large 2x2 mount token (200x200) at 0 ft elevation (top surface `topElevation = 10` ft) at (400, 100)
      const mountTok = new FakeTokenClass();
      mountTok.document.id = 'mount-2x2';
      mountTok.document.x = 400;
      mountTok.document.y = 100;
      mountTok.document.width = 2;
      mountTok.document.height = 2;
      mountTok.document.elevation = 0;
      mountTok.document._source = { x: 400, y: 100, width: 2, height: 2, elevation: 0, movementAction: 'walk' };

      const walkerOnBridge = new FakeTokenClass();
      walkerOnBridge.document.id = 'walker-bridge';
      walkerOnBridge.document.x = 100;
      walkerOnBridge.document.y = 100; // center (150, 150) — right on the opaque bridge plank!
      walkerOnBridge.document.width = 1;
      walkerOnBridge.document.height = 1;
      walkerOnBridge.document.elevation = 20;
      walkerOnBridge.document.movementAction = 'walk';
      walkerOnBridge.document._source = { x: 100, y: 100, width: 1, height: 1, elevation: 20, movementAction: 'walk' };
      walkerOnBridge.actor = { statuses: new Set(), system: { attributes: { movement: { speeds: { walk: 30, fly: 30 }, units: 'ft' } } } };

      canvas.tiles = { placeables: [bridgeTile] };
      canvas.tokens.placeables = [mountTok, walkerOnBridge];
      JA.invalidateSupportingSurfaces();

      const surfOnOpaquePlank = JA.resolveSupportingSurface(walkerOnBridge);
      const groundedOnBridge = surfOnOpaquePlank?.elevation === 20
        && surfOnOpaquePlank?.sourceType === 'tile'
        && JA.isTokenInFlyMode(walkerOnBridge) === false
        && JA.isFlyAnimationSegment(walkerOnBridge, { x: 50, y: 100, elevation: 20 }, { x: 150, y: 100, elevation: 20 }, { method: 'keyboard', action: 'walk' }) === false
        && JA.isWalkAnimationSegment(walkerOnBridge, { x: 50, y: 100, elevation: 20 }, { x: 150, y: 100, elevation: 20 }, { method: 'keyboard', action: 'walk' }) === true;

      // Step into the transparent area of the SAME tile (x=100, y=10 -> center 150, 60, inside the 300x300 bounds, but alpha=0!):
      // floor drops out to 0 ft (no walking on thin air!), and a fly-capable creature transitions into flight
      const surfInTransparentAir = JA.resolveSupportingSurface(walkerOnBridge, { x: 100, y: 10, elevation: 20 });
      const noWalkingOnTransparentTile = surfInTransparentAir?.elevation === 0 && surfInTransparentAir?.sourceType === 'scene';
      const fliesWhenSteppingOffPlank = JA.isFlyAnimationSegment(
        walkerOnBridge,
        { x: 100, y: 100, elevation: 20 },
        { x: 100, y: 10, elevation: 20 },
        { method: 'keyboard', action: 'walk' }
      ) === true;

      // Standing atop the 2x2 mount token (x=450, y=150 -> center 500, 200 inside mount 400..600 x 100..300) at 10 ft elevation
      walkerOnBridge.document.x = 450;
      walkerOnBridge.document.y = 150;
      walkerOnBridge.document.elevation = 10;
      walkerOnBridge.document._source = { x: 450, y: 150, width: 1, height: 1, elevation: 10, movementAction: 'walk' };
      JA.invalidateSupportingSurfaces();
      const surfOnMount = JA.resolveSupportingSurface(walkerOnBridge);
      const supportedOnMountToken = surfOnMount?.elevation === 10
        && surfOnMount?.sourceType === 'token'
        && JA.isTokenInFlyMode(walkerOnBridge) === false;

      // Verify a walking token stepping off another token into empty air: the `falling` effect arrives mid-`walk` step,
      // and the falling animation MUST engage immediately without being cleared in `postAnimate` (no second step needed!)
      const stepOffFns = [];
      canvas.app.ticker = {
        add(fn) { if (!stepOffFns.includes(fn)) stepOffFns.push(fn); },
        remove(fn) { const i = stepOffFns.indexOf(fn); if (i >= 0) stepOffFns.splice(i, 1); }
      };
      walkerOnBridge.actor.system.attributes.movement.speeds.fly = 0;
      const stepOffCtx = { duration: 310, time: 0, onAnimate: [], postAnimate: [] };
      JA.attachJumpAnimationToContext(
        walkerOnBridge,
        { x: 450, y: 150, elevation: 10 },
        { x: 650, y: 150, elevation: 10 },
        stepOffCtx,
        { method: 'keyboard', action: 'walk' }
      );
      stepOffCtx.time = 40;
      for (const fn of stepOffCtx.onAnimate) fn(stepOffCtx);
      // Mid-step (40 ms), dnd5e creates ActiveEffect 'falling' -> triggers syncTokenFlyHover
      walkerOnBridge.document.x = 650;
      walkerOnBridge.document._source = { x: 650, y: 150, width: 1, height: 1, elevation: 10, movementAction: 'walk' };
      walkerOnBridge.actor.statuses.add('falling');
      JA.syncTokenFlyHover(walkerOnBridge);
      for (const t of [120, 220, 310]) {
        stepOffCtx.time = t;
        for (const fn of [...stepOffFns]) fn();
        for (const fn of stepOffCtx.onAnimate) fn(stepOffCtx);
      }
      for (const fn of stepOffCtx.postAnimate) fn();
      const fallingImmediateAfterStepOff = Boolean(walkerOnBridge._ssJumpState)
        && (walkerOnBridge._ssHoverBlend ?? 0) > 0.3
        && stepOffFns.length > 0;
      JA.clearJumpStateForToken(walkerOnBridge, { destroyShadow: true });
      canvas.app.ticker = prevFallTicker;

      canvas.tiles = prevTiles;
      canvas.tokens.placeables = prevFloorPlaceables;
      JA.invalidateSupportingSurfaces();
      check(
        groundedOnBridge && noWalkingOnTransparentTile && fliesWhenSteppingOffPlank && supportedOnMountToken && fallingImmediateAfterStepOff,
        `floor-detect: pixel-perfect тайл держит на непрозрачной балке (${surfOnOpaquePlank?.elevation}ft), сбрасывает на прозрачных пикселях PNG (${surfInTransparentAir?.elevation}ft), держит на токене 2x2 (${surfOnMount?.elevation}ft) и сразу включает падение при сходе`
      );

      // 5f-hitbox. Synchronizing interactive hitbox (`token.hitArea`), border (`border`), bars (`bars`),
      //            nameplate (`nameplate`), `_getDragOrigin`, and selection marquee (`_overlapsSelection`) with elevation perspective and flight:
      class FakePoly {
        constructor(pts) { this.points = [...pts]; }
        clearCache() {}
        contains(px, py) {
          const xs = [this.points[0], this.points[2], this.points[4], this.points[6]];
          const ys = [this.points[1], this.points[3], this.points[5], this.points[7]];
          return px >= Math.min(...xs) && px <= Math.max(...xs) && py >= Math.min(...ys) && py <= Math.max(...ys);
        }
      }
      class FakeRect {
        constructor(x, y, width, height) { this.x = x; this.y = y; this.width = width; this.height = height; }
      }
      class FakeHitboxTokenClass extends FakeTokenClass {
        constructor() {
          super();
          this.position = { x: 100, y: 200 };
          this.shape = new FakePoly([0, 0, 100, 0, 100, 100, 0, 100]);
          this.hitArea = this.shape;
          const makeBoxSub = () => ({
            destroyed: false, x: 0, y: 0, alpha: 1, visible: true,
            position: { x: 0, y: 0, set(nx, ny) { this.x = nx; this.y = ny; } },
            scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } }
          });
          this.border = makeBoxSub();
          this.bars = makeBoxSub();
          this.effects = makeBoxSub();
          this.nameplate = makeBoxSub();
          this.tooltip = makeBoxSub();
        }
        _refreshShape() {
          this.shape = new FakePoly([0, 0, 100, 0, 100, 100, 0, 100]);
          this.hitArea = this.shape;
        }
        _getDragOrigin() {
          return { x: this.document.x + 50, y: this.document.y + 50 };
        }
        _overlapsSelection(rect) {
          const lx = rect.x - this.position.x;
          const ly = rect.y - this.position.y;
          return lx < 100 && lx + rect.width > 0 && ly < 100 && ly + rect.height > 0;
        }
      }
      JA.installJumpAnimationPatch(FakeHitboxTokenClass);
      const hbTok = new FakeHitboxTokenClass();
      hbTok.document.x = 100;
      hbTok.document.y = 200;
      hbTok.document.elevation = 60;
      hbTok.document.movementAction = 'fly';
      hbTok.document._source = { x: 100, y: 200, width: 1, height: 1, elevation: 60, movementAction: 'fly' };
      hbTok._ssHoverBlend = 1;
      JA.syncTokenFlyHover(hbTok);
      hbTok._refreshShape();
      const vBounds = JA.getTokenVisualBounds(hbTok);
      const meshCenterLocalX = hbTok.mesh.position.x - hbTok.document.x;
      const meshCenterLocalY = hbTok.mesh.position.y - hbTok.document.y;
      const hitAtVisualCenter = hbTok.hitArea.contains(meshCenterLocalX, meshCenterLocalY);
      const hitAtOldBottomGround = hbTok.hitArea.contains(50, 96);
      const logicalShapeIntact = hbTok.shape.points[0] === 0 && hbTok.shape.points[4] === 100 && hbTok.shape.points[5] === 100;
      const borderScaledAndShifted = Math.abs(hbTok.border.scale.x - vBounds.scale) < 1e-4 &&
        Math.abs((hbTok.document.x + hbTok.border.x) - vBounds.x) < 0.1 &&
        Math.abs((hbTok.document.y + hbTok.border.y) - vBounds.y) < 0.1;
      const barsSynced = Math.abs(hbTok.bars.x - hbTok.border.x) < 1e-4 && Math.abs(hbTok.bars.y - hbTok.border.y) < 1e-4;
      const dragOrig = hbTok._getDragOrigin();
      const dragOriginMatchesVisual = Math.abs(dragOrig.x - vBounds.centerX) < 0.5 && Math.abs(dragOrig.y - vBounds.centerY) < 0.5;
      const boxSelectHitsVisual = hbTok._overlapsSelection(new FakeRect(vBounds.centerX - 10, vBounds.centerY - 10, 20, 20));
      const boxSelectMissesEmptyGround = !hbTok._overlapsSelection(new FakeRect(140, 292, 20, 12));
      hbTok.document.elevation = 0;
      hbTok.document._source.elevation = 0;
      JA.clearJumpStateForToken(hbTok, { destroyShadow: true });
      const hitRestoredOnClear = hbTok.hitArea === hbTok.shape && hbTok.border.x === 0 && hbTok.border.y === 0 && hbTok.border.scale.x === 1;
      check(
        hitAtVisualCenter && !hitAtOldBottomGround && logicalShapeIntact &&
        borderScaledAndShifted && barsSynced && dragOriginMatchesVisual &&
        boxSelectHitsVisual && boxSelectMissesEmptyGround && hitRestoredOnClear,
        `visual-hitbox-sync: хитбокс и UI следуют за токеном на 60ft (scale=${vBounds.scale.toFixed(2)}, dy=${Math.round(vBounds.centerY - 250)}px, hitVisual=${hitAtVisualCenter}, hitOldGround=${hitAtOldBottomGround}, dragOriginY=${Math.round(dragOrig.y)}) и чисто сбрасываются`
      );

      // 5f-fall-sync. Synchronizing `falling` status onset with `movementAnimationPromise` completion
      //               and delaying `plummet()` landing (`playLandingVfx` + `move`) until ground impact (`FALL_IMPACT_T`):
      let parentUpdates = 0;
      let landingVfxCalls = 0;
      let fallingApplied = false;
      class FakeParentTokenDoc {
        _onUpdate(changed, options, userId) {
          parentUpdates++;
          if (Number(options?.dnd5e?.fall?.distance) > 0 && this.object) {
            this.object._ssFallPlunge = { durationMs: 80 };
          }
        }
        async _onUpdateMovement() {}
        async move(waypoints, options) {
          this._onUpdate({ elevation: 0 }, options, 'u1');
          return true;
        }
      }
      class FakeDndTokenDoc extends FakeParentTokenDoc {
        constructor(obj) {
          super();
          this.parent = { id: 'scene-1' };
          this.object = obj;
          this.movementAction = 'walk';
          this._source = { x: 0, y: 0, elevation: 10, movementAction: 'walk' };
          this.actor = { statuses: new Set(), system: { attributes: { movement: { speeds: { walk: 30, fly: 0 } } } } };
        }
        _isFalling() { return true; }
        async _onUpdateMovement() {
          fallingApplied = true;
          this.actor.statuses.add('falling');
        }
        _onUpdate(changed, options, userId) {
          super._onUpdate(changed, options, userId);
          if (options?.dnd5e?.fall?.distance) landingVfxCalls++;
        }
      }
      const prevDndGlobal = globalThis.dnd5e;
      const syncTickerFns = [];
      canvas.app.ticker = {
        add(fn) { syncTickerFns.push(fn); },
        remove() {}
      };
      globalThis.dnd5e = { documents: { TokenDocument5e: FakeDndTokenDoc } };
      try {
        JA.installJumpAnimationPatch(FakeHitboxTokenClass);
        let resolveWalkAnim;
        const fakeTokObj = { destroyed: false, movementAnimationPromise: Promise.resolve() };
        const fakeDndDoc = new FakeDndTokenDoc(fakeTokObj);
        // Emulate Foundry v14 order: `#onUpdateMovement` starts BEFORE `super._onUpdate`, which assigns the new `movementAnimationPromise`
        const moveHookProm = fakeDndDoc._onUpdateMovement({ origin: { elevation: 10 }, destination: { elevation: 10 } }, { animate: true }, {});
        fakeTokObj.movementAnimationPromise = new Promise((r) => { resolveWalkAnim = r; });
        await new Promise((r) => setTimeout(r, 15));
        const notPrematureMidWalk = fallingApplied === false;
        resolveWalkAnim();
        await moveHookProm;
        const appliedRightAfterWalk = fallingApplied === true && fakeDndDoc.actor.statuses.has('falling');

        // Emulate `plummet()`: `move(wp, { animate: false, dnd5e: { fall: { distance: 20 } } })` (80ms * 0.56 = 45ms)
        const tPlummet0 = performance.now();
        const plummetMoveProm = fakeDndDoc.move({ action: 'fall', elevation: 0 }, { animate: false, dnd5e: { fall: { distance: 20 } } });
        const parentRanImmediately = parentUpdates === 1 && landingVfxCalls === 0;
        await plummetMoveProm;
        const plummetElapsed = performance.now() - tPlummet0;
        await new Promise((r) => setTimeout(r, 10));
        const landingSyncedToImpact = landingVfxCalls === 1 && parentUpdates === 1 && plummetElapsed >= 35;
        check(
          notPrematureMidWalk && appliedRightAfterWalk && parentRanImmediately && landingSyncedToImpact,
          `fall-timing-sync: статус falling ждёт конца шага (midWalk=${!notPrematureMidWalk}, afterWalk=${appliedRightAfterWalk}), а приземление plummet синхронизировано с ударом (${Math.round(plummetElapsed)}мс, vfx=${landingVfxCalls}, parent=${parentUpdates})`
        );
      } finally {
        globalThis.dnd5e = prevDndGlobal;
        canvas.app.ticker = prevFallTicker;
      }

      // 5f-air-jump. Jump animation when gaining elevation into unsupported mid-air:
      //              - vertical climb in place (`0 -> 10 ft` into empty air) starts `_ssAirJump` with crouch, stretch, and apex hang;
      //              - horizontal step climbing into empty air (`(100,100,0) -> (200,100,10)` in `walk` mode) automatically enables `isJumpAnimationSegment`;
      //              - climbing onto solid support (`Animated Armor` / tile at `10 ft`) or normal flight (`fly`) DOES NOT trigger air jump;
      //              - at the apex (`AIR_JUMP_APEX_T`) and at the end (`u = 1`), the handoff into `computeFallingLoopFrame(1, 0)` is completely seamless!
      const ajCrouch = JA.computeAirJumpFrame(0.08, { fromElevation: 0, toElevation: 15, gridSize: 100, tokenSize: 100 });
      const ajStretch = JA.computeAirJumpFrame(0.30, { fromElevation: 0, toElevation: 15, gridSize: 100, tokenSize: 100 });
      const ajApexNoFall = JA.computeAirJumpFrame(JA.AIR_JUMP_APEX_T, { fromElevation: 0, toElevation: 15, gridSize: 100, tokenSize: 100, endInFalling: false });
      const ajApexFall = JA.computeAirJumpFrame(JA.AIR_JUMP_APEX_T, { fromElevation: 0, toElevation: 15, gridSize: 100, tokenSize: 100, endInFalling: true });
      const ajEndFall = JA.computeAirJumpFrame(1.0, { fromElevation: 0, toElevation: 15, gridSize: 100, tokenSize: 100, endInFalling: true });
      const fallLoopStart = JA.computeFallingLoopFrame(1, 0, { gridSize: 100, tokenSize: 100, elevation: 15 });
      const ajMathOk = ajCrouch.scaleX > 1.10 && ajCrouch.scaleY < 0.88 && ajCrouch.offsetY > 2 &&
        ajStretch.scaleX < 0.94 && ajStretch.scaleY > 1.12 && ajStretch.offsetY < -15 &&
        ajApexFall.visualElevation === 15 && ajApexFall.offsetY < -35 &&
        Math.abs(ajApexNoFall.offsetY - ajApexFall.offsetY) < 1e-6 &&
        Math.abs(ajEndFall.offsetY - fallLoopStart.offsetY) < 1e-4 &&
        Math.abs(ajEndFall.scaleX - fallLoopStart.scaleX) < 1e-4 &&
        Math.abs(ajEndFall.scaleY - fallLoopStart.scaleY) < 1e-4;

      const ajFns = [];
      canvas.app.ticker = {
        add(fn) { if (!ajFns.includes(fn)) ajFns.push(fn); },
        remove(fn) { const idx = ajFns.indexOf(fn); if (idx >= 0) ajFns.splice(idx, 1); }
      };
      try {
        canvas.tiles = { placeables: [bridgeTile] }; // opaque plank at y=150, elevation=20
        canvas.tokens.placeables = [mountTok]; // 2x2 token at 400..600 x 100..300, top cap elevation=10
        JA.invalidateSupportingSurfaces();

        const jumper = new FakeTokenClass();
        jumper.document.id = 'air-jumper';
        jumper.document.x = 100;
        jumper.document.y = 10; // transparent air (supported only at 0 ft)
        jumper.document.elevation = 0;
        jumper.document.movementAction = 'walk';
        jumper.document._source = { x: 100, y: 10, width: 1, height: 1, elevation: 0, movementAction: 'walk' };
        jumper.actor = { statuses: new Set(), system: { attributes: { movement: { speeds: { walk: 30, fly: 0 } } } } };
        JA.syncTokenFlyHover(jumper);

        // 1) Vertical climb 0 -> 10 ft into empty air -> starts `_ssAirJump`
        jumper.document.elevation = 10;
        jumper.document._source.elevation = 10;
        JA.syncTokenFlyHover(jumper, { elevation: 10 });
        const startedAirJumpInAir = Boolean(jumper._ssAirJump && jumper._ssAirJump.toElevation === 10);
        JA.clearJumpStateForToken(jumper, { destroyShadow: true });

        // 2) Climb 0 -> 10 ft directly onto the 2x2 mount (x=450, y=150 -> supported at 10 ft!) -> NOT airborne, `_ssAirJump` DOES NOT start
        jumper.document.x = 450;
        jumper.document.y = 150;
        jumper.document.elevation = 0;
        jumper.document._source = { x: 450, y: 150, width: 1, height: 1, elevation: 0, movementAction: 'walk' };
        JA.invalidateSupportingSurfaces();
        JA.syncTokenFlyHover(jumper);
        jumper.document.elevation = 10;
        jumper.document._source.elevation = 10;
        JA.syncTokenFlyHover(jumper, { elevation: 10 });
        const noAirJumpOnSolidMount = !jumper._ssAirJump;
        JA.clearJumpStateForToken(jumper, { destroyShadow: true });

        // 3) Horizontal move with elevation gain: into air -> jump (`true`), onto platform -> walk (`false`), with fly speed -> fly (`false`)
        jumper.document.x = 100;
        jumper.document.y = 10;
        jumper.document.elevation = 10;
        jumper.document._source = { x: 100, y: 10, width: 1, height: 1, elevation: 10, movementAction: 'walk' };
        const horizAirJumpSeg = JA.isJumpAnimationSegment(
          jumper,
          { x: 100, y: 10, elevation: 0 },
          { x: 200, y: 10, elevation: 10 },
          { action: 'walk' }
        );
        const horizOntoMountJumpSeg = JA.isJumpAnimationSegment(
          jumper,
          { x: 300, y: 150, elevation: 0 },
          { x: 450, y: 150, elevation: 10 },
          { action: 'walk' }
        );
        jumper.actor.system.attributes.movement.speeds.fly = 30;
        const horizFlyNotJumpSeg = !JA.isJumpAnimationSegment(
          jumper,
          { x: 100, y: 10, elevation: 0 },
          { x: 200, y: 10, elevation: 10 },
          { action: 'walk' }
        );

        // 4) If the token is ALREADY in `Falling` (on the ground `0 -> 10 ft` or in mid-air `10 -> 15 ft`),
        //    raising elevation NEVER plays `_ssAirJump` or `isJumpAnimationSegment` — it stays in continuous `Falling`!
        jumper.actor.system.attributes.movement.speeds.fly = 0;
        jumper.actor.statuses.add('falling');
        jumper.document.x = 100;
        jumper.document.y = 10;
        jumper.document.elevation = 0;
        jumper.document._source = { x: 100, y: 10, width: 1, height: 1, elevation: 0, movementAction: 'walk' };
        JA.syncTokenFlyHover(jumper);
        jumper.document.elevation = 10;
        jumper.document._source.elevation = 10;
        JA.syncTokenFlyHover(jumper, { elevation: 10 });
        const noAirJumpWhenAlreadyFallingFromGround = !jumper._ssAirJump && Boolean(jumper._ssJumpState);
        jumper.document.elevation = 15;
        jumper.document._source.elevation = 15;
        JA.syncTokenFlyHover(jumper, { elevation: 15 });
        const noAirJumpWhenAlreadyFallingInAir = !jumper._ssAirJump &&
          !JA.isJumpAnimationSegment(
            jumper,
            { x: 100, y: 10, elevation: 0 },
            { x: 200, y: 10, elevation: 10 },
            { action: 'walk' }
          ) &&
          JA.isFallAnimationSegment(
            jumper,
            { x: 100, y: 10, elevation: 0 },
            { x: 200, y: 10, elevation: 10 },
            { action: 'walk' }
          );
        JA.clearJumpStateForToken(jumper, { destroyShadow: true });

        check(
          ajMathOk && startedAirJumpInAir && noAirJumpOnSolidMount && horizAirJumpSeg && !horizOntoMountJumpSeg &&
          horizFlyNotJumpSeg && noAirJumpWhenAlreadyFallingFromGround && noAirJumpWhenAlreadyFallingInAir,
          `air-jump-on-elev-up: прыжок при повышении высоты в воздух (crouch=${ajCrouch.scaleX.toFixed(2)}×${ajCrouch.scaleY.toFixed(2)}, stretch=${ajStretch.scaleY.toFixed(2)}, vertAir=${startedAirJumpInAir}, onMount=${!noAirJumpOnSolidMount}, horizAir=${horizAirJumpSeg}, noJumpIfFalling=${noAirJumpWhenAlreadyFallingFromGround && noAirJumpWhenAlreadyFallingInAir})`
        );
      } finally {
        canvas.tiles = prevTiles;
        canvas.tokens.placeables = prevFloorPlaceables;
        canvas.app.ticker = prevFallTicker;
        JA.invalidateSupportingSurfaces();
      }

      // 5f-levels. Multi-level Foundry VTT v14 scenes (`Scene#levels`, negative Dungeon `-20..0`, upper floors `20..40`, `40..50`,
      //            overhead canopy occlusion tiles, `changeLevel` stairs/ladders, dynamic `shadow.elevation`, and level-relative perspective):
      const prevCanvasLevel = canvas.level;
      const prevSceneRef = canvas.scene;
      const lvlFns = [];
      canvas.app.ticker = {
        add(fn) { if (!lvlFns.includes(fn)) lvlFns.push(fn); },
        remove(fn) { const idx = lvlFns.indexOf(fn); if (idx >= 0) lvlFns.splice(idx, 1); }
      };
      try {
        const lvlDungeon = { id: 'dungeon', elevation: { bottom: -20, top: 0, base: -20 } };
        const lvlFirst = { id: 'first', elevation: { bottom: 0, top: 20, base: 0 } };
        const lvlSecond = { id: 'second', elevation: { bottom: 20, top: 40, base: 20 } };
        const lvlThird = { id: 'third', elevation: { bottom: 40, top: 50, base: 40 } };
        const lvlMap = new Map([
          ['dungeon', lvlDungeon],
          ['first', lvlFirst],
          ['second', lvlSecond],
          ['third', lvlThird]
        ]);
        lvlMap.contents = [lvlDungeon, lvlFirst, lvlSecond, lvlThird];
        const mockMultiScene = {
          id: 'multi-keep',
          grid: { distance: 5, size: 100 },
          levels: lvlMap,
          getSurfaces({ type } = {}) {
            return type === 'move' ? [{ elevation: 0 }, { elevation: 20 }, { elevation: 40 }] : [];
          }
        };
        const mockOrigFindSurface = function ({ position } = {}) {
          const pos = position ?? this._source ?? this;
          const px = Number(pos.x) || 0;
          const elev = Number(pos.elevation) || 0;
          const lvl = pos.level;
          // At x >= 500 upper floors have a courtyard/balcony opening; `first` forgot to list `'third'` in `region.levels`
          if (lvl === 'third' && px < 500 && elev >= 40) return { elevation: 40, level: lvlThird, region: { id: 'reg-3' } };
          if (lvl === 'second' && px < 500 && elev >= 20) return { elevation: 20, level: lvlSecond, region: { id: 'reg-2' } };
          if ((lvl === 'first' || lvl === 'second') && elev >= 0) return { elevation: 0, level: lvlFirst, region: { id: 'reg-1' } };
          if (lvl === 'dungeon') {
            // Ceiling at 0 (`top`), floor at -20 (`bottom`)
            if (elev >= 0) return { elevation: 0, level: lvlDungeon, region: null };
            if (elev >= -20) return { elevation: -20, level: lvlDungeon, region: { id: 'reg-0' } };
          }
          return null;
        };

        const canopyFadeTile = {
          destroyed: false,
          document: {
            id: 'tree-canopy-40',
            x: 0,
            y: 0,
            width: 400,
            height: 400,
            elevation: 40,
            alpha: 1,
            hidden: false,
            occlusion: { mode: 1, modes: new Set([1]) },
            levels: new Set(['first', 'second', 'third']),
            includedInLevel(l) { return this.levels.has(l); }
          },
          mesh: {
            destroyed: false,
            _texture: { valid: true },
            canvasBounds: { x: 0, y: 0, width: 400, height: 400 },
            containsCanvasPoint() { return true; }
          }
        };
        const propBridgeTile = {
          destroyed: false,
          document: {
            id: 'plank-15',
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            elevation: 15,
            alpha: 1,
            hidden: false,
            occlusion: { mode: 0, modes: new Set() },
            levels: new Set(['first']),
            includedInLevel(l) { return this.levels.has(l); }
          },
          mesh: {
            destroyed: false,
            _texture: { valid: true },
            canvasBounds: { x: 0, y: 0, width: 200, height: 200 },
            containsCanvasPoint(pt) { return pt.x >= 0 && pt.x <= 200 && pt.y >= 0 && pt.y <= 200; }
          }
        };

        canvas.scene = mockMultiScene;
        canvas.tiles = { placeables: [canopyFadeTile, propBridgeTile] };
        canvas.tokens.placeables = [];
        canvas.tokens.controlled = [];
        JA.invalidateSupportingSurfaces();

        const makeLvlTok = (id, x, y, elev, levelId, flyFt = 0) => {
          const t = new FakeTokenClass();
          t.document.id = id;
          t.document.parent = mockMultiScene;
          t.document.x = x;
          t.document.y = y;
          t.document.elevation = elev;
          t.document.level = levelId;
          t.document.movementAction = 'walk';
          t.document.regions = new Set();
          t.document._source = { x, y, width: 1, height: 1, elevation: elev, level: levelId, movementAction: 'walk' };
          t.document._findSupportingSurface = mockOrigFindSurface;
          t.actor = { statuses: new Set(), system: { attributes: { movement: { speeds: { walk: 30, fly: flyFt }, units: 'ft' } } } };
          return t;
        };

        // 1) Overhead `FADE` tree canopy at 40 ft is NOT a floor, while normal `occlusion.mode = 0` plank tile at 15 ft IS a floor
        const courtyardTok = makeLvlTok('keep-yard', 250, 250, 40, 'first', 0);
        const surfUnderCanopy = JA.resolveSupportingSurface(courtyardTok, { x: 250, y: 250, elevation: 40, level: 'first' }, mockOrigFindSurface);
        const surfOnPlank = JA.resolveSupportingSurface(courtyardTok, { x: 100, y: 100, elevation: 15, level: 'first' }, mockOrigFindSurface);
        // Stepping off Third Floor roof (`x = 600`) falls back across lower levels to First Floor (`0 ft`, NOT `null` and NOT dungeon `-20`)
        const surfBalconyDrop = JA.resolveSupportingSurface(courtyardTok, { x: 600, y: 250, elevation: 40, level: 'third' }, mockOrigFindSurface);
        const canopyAndFallbackOk = surfUnderCanopy?.sourceType === 'scene' && surfUnderCanopy?.elevation === 0 &&
          surfOnPlank?.sourceType === 'tile' && surfOnPlank?.elevation === 15 && surfOnPlank?.level?.id === 'first' &&
          surfBalconyDrop?.elevation === 0 && surfBalconyDrop?.level?.id === 'first';

        // 2) Negative level (`Dungeon`, base = `-20`): flyer grounded at `-20`, flies at `-10`, non-flyer `-20 -> -10` air-jumps with `shadow.elevation === -20`
        canvas.level = lvlDungeon;
        JA.invalidateSupportingSurfaces();
        const dungeonBat = makeLvlTok('dung-bat', 100, 100, -20, 'dungeon', 30);
        const batGroundedAtMinus20 = JA.isTokenInFlyMode(dungeonBat) === false;
        const batFliesToMinus10 = JA.isFlyAnimationSegment(
          dungeonBat,
          { x: 100, y: 100, elevation: -20, level: 'dungeon' },
          { x: 200, y: 100, elevation: -10, level: 'dungeon' },
          { action: 'walk' }
        );
        dungeonBat.document.elevation = -10;
        dungeonBat.document._source.elevation = -10;
        JA.syncTokenFlyHover(dungeonBat, { elevation: -10 });
        const batHoveringAtMinus10 = JA.isTokenInFlyMode(dungeonBat) === true &&
          dungeonBat._ssJumpShadow?.elevation === -20;
        JA.clearJumpStateForToken(dungeonBat, { destroyShadow: true });

        const dungeonWalker = makeLvlTok('dung-walk', 100, 100, -20, 'dungeon', 0);
        JA.syncTokenFlyHover(dungeonWalker);
        dungeonWalker.document.elevation = -10;
        dungeonWalker.document._source.elevation = -10;
        JA.syncTokenFlyHover(dungeonWalker, { elevation: -10 });
        const dungeonAirJumpOk = Boolean(dungeonWalker._ssAirJump && dungeonWalker._ssAirJump.toElevation === -10) &&
          dungeonWalker._ssJumpShadow?.elevation === -20;
        JA.clearJumpStateForToken(dungeonWalker, { destroyShadow: true });

        // 3) Upper levels (`Third Floor 40`, `Second Floor 20`): observer defaults to `40`, grounded token doesn't fade on zoom-in,
        //    flyer at `70` casts shadow on `40`, and `changeLevel` stairs / `climb` / level changes don't trigger false air-jumps
        canvas.level = lvlThird;
        canvas.tokens.controlled = [];
        JA.invalidateSupportingSurfaces();
        JA.syncElevationPerspective({ immediate: true });
        const obsDefaultThird = JA.getTargetObserverElevation() === 40;

        const roofGuard = makeLvlTok('roof-guard', 100, 100, 40, 'third', 0);
        canvas.tokens.placeables = [roofGuard];
        JA.syncTokenFlyHover(roofGuard);
        const perspGroundedZoomIn = JA.computeElevationPerspective(40, 40, {
          gridSize: 100,
          gridDistance: 5,
          tokenSize: 100,
          baseElevation: 40,
          surfaceElevation: 40,
          isGroundedOnSurface: true,
          cameraScale: 2.5
        });
        const roofGroundedNeutral = perspGroundedZoomIn.worldScale === 1 &&
          perspGroundedZoomIn.cameraZoom === 1 &&
          perspGroundedZoomIn.cameraOcclusionAlpha === 1 &&
          !roofGuard._ssJumpShadow?.visible;

        const roofDragon = makeLvlTok('roof-dragon', 200, 100, 70, 'third', 60);
        JA.syncTokenFlyHover(roofDragon);
        const dragonShadowOnRoof40 = roofDragon._ssJumpShadow?.elevation === 40;
        JA.clearJumpStateForToken(roofDragon, { destroyShadow: true });

        canvas.level = lvlSecond;
        JA.invalidateSupportingSurfaces();
        const stairWalker = makeLvlTok('stair-walker', 600, 250, 20, 'second', 0);
        // Simulate standing over a stairwell opening (`x = 600`, where `surfElev === 0`) inside a `changeLevel` region
        stairWalker.document.regions.add({ behaviors: [{ type: 'changeLevel', disabled: false }] });
        JA.syncTokenFlyHover(stairWalker);
        stairWalker.document.elevation = 30;
        stairWalker.document._source.elevation = 30;
        JA.syncTokenFlyHover(stairWalker, { elevation: 30 });
        const noAirJumpInChangeLevel = !stairWalker._ssAirJump &&
          !JA.isJumpAnimationSegment(
            stairWalker,
            { x: 600, y: 250, elevation: 20, level: 'second' },
            { x: 600, y: 350, elevation: 30, level: 'second' },
            { action: 'walk' }
          );
        stairWalker.document.regions.clear();
        const noAirJumpOnCrossLevel = !JA.isJumpAnimationSegment(
          stairWalker,
          { x: 100, y: 100, elevation: 20, level: 'second' },
          { x: 200, y: 100, elevation: 40, level: 'third' },
          { action: 'walk' }
        ) && !JA.isJumpAnimationSegment(
          stairWalker,
          { x: 600, y: 250, elevation: 20, level: 'second' },
          { x: 600, y: 350, elevation: 30, level: 'second' },
          { action: 'climb' }
        );
        JA.clearJumpStateForToken(stairWalker, { destroyShadow: true });
        JA.clearJumpStateForToken(roofGuard, { destroyShadow: true });

        check(
          canopyAndFallbackOk && batGroundedAtMinus20 && batFliesToMinus10 && batHoveringAtMinus10 &&
          dungeonAirJumpOk && obsDefaultThird && roofGroundedNeutral && dragonShadowOnRoof40 &&
          noAirJumpInChangeLevel && noAirJumpOnCrossLevel,
          `multi-level-v14: крыши/кроны отсечены (canopy=${surfUnderCanopy?.elevation}, plank=${surfOnPlank?.elevation}, drop=${surfBalconyDrop?.elevation}), подземелье -20..-10 (fly=${batHoveringAtMinus10}, jump=${dungeonAirJumpOk}), 3-й этаж +40 (obs=${obsDefaultThird ? 40 : -1}, occAlpha=${perspGroundedZoomIn.cameraOcclusionAlpha}, shadowElev=${dragonShadowOnRoof40 ? 40 : -1}) и защита лестниц changeLevel=${noAirJumpInChangeLevel}`
        );
      } finally {
        canvas.level = prevCanvasLevel;
        canvas.scene = prevSceneRef;
        canvas.tiles = prevTiles;
        canvas.tokens.placeables = prevFloorPlaceables;
        canvas.tokens.controlled = [];
        canvas.app.ticker = prevFallTicker;
        JA.invalidateSupportingSurfaces();
        JA.syncElevationPerspective({ immediate: true });
      }

      // 5g. Interop between flight/jump animation (`jump-animation.mjs`) and dynamic item display (`dynamic-items/manager.mjs`):
      //     item follows flight lift (`offsetY`), bank tilt (`tiltAngle`), and perspective scale (`scaleX/scaleY`),
      //     light source during stationary Idle Hover keeps a steady world position (0 ClockwiseSweepPolygon recomputations),
      //     and stationary hovering does not spam spurious trails.
      await import(`${root}/scripts/core/socket-manager.mjs`);
      const { tokenItemDisplay } = await import(`${root}/plus/scripts/animations/dynamic-items/manager.mjs`);
      const { ItemDisplay } = await import(`${root}/plus/scripts/animations/dynamic-items/item-display.mjs`);
      const flyItemTok = {
        id: 'fly-item-tok',
        x: 100,
        y: 200,
        w: 100,
        h: 100,
        visible: true,
        document: { id: 'fly-item-tok', x: 100, y: 200, width: 1, height: 1, elevation: 10, rotation: 0, lockRotation: false, movementAction: 'fly' },
        get center() { return { x: this.x + 50, y: this.y + 50 }; },
        mesh: {
          destroyed: false,
          position: { x: 150, y: 250, set(nx, ny) { this.x = nx; this.y = ny; } },
          scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
          angle: 0
        }
      };
      const itemCfg = {
        enabled: true,
        anchorSide: 'center',
        offsetX: 0.4,
        offsetY: 0,
        scale: 1,
        rotation: -15,
        flipX: false,
        flipY: false,
        autoMirror: true,
        rotateWithToken: true,
        autoSize: true,
        trailEnabled: true,
        trailType: 'afterimage',
        trailSpeedThreshold: 10
      };
      const disp = new ItemDisplay(null, { src: 'sword.webp', naturalWidth: 64, naturalHeight: 64 }, itemCfg, 'item-1');
      disp._appearProgress = 1;
      disp._sprite = {
        destroyed: false,
        visible: true,
        alpha: 1,
        tint: 0xffffff,
        texture: { valid: true, width: 64, height: 64, baseTexture: { valid: true, width: 64, height: 64 } },
        position: { x: 0, y: 0, set(nx, ny) { this.x = nx; this.y = ny; } },
        scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
        rotation: 0,
        zIndex: 1
      };
      const wpGround = tokenItemDisplay._getCurrentWorldPosition(flyItemTok, disp);
      // Apply flight frame to token: upward lift (offsetY = -36), scale 1.15, bank tilt +8°
      flyItemTok._ssActiveMoveAnim = true;
      flyItemTok._ssJumpState = {
        u: 0.5,
        flightProgress: 0.5,
        arcFactor: 0.5,
        paceOffsetX: 12,
        paceOffsetY: 0,
        offsetX: 12,
        offsetY: -36,
        scaleX: 1.15,
        scaleY: 1.15,
        tiltAngle: 8,
        shadowScale: 0.72,
        shadowAlpha: 0.28,
        baseScaleX: 1,
        baseScaleY: 1
      };
      JA.applyJumpStateToToken(flyItemTok);
      const wpAir = tokenItemDisplay._getCurrentWorldPosition(flyItemTok, disp);
      tokenItemDisplay.renderer.updateDisplayPosition(flyItemTok, disp, wpAir);
      const airScaleX = disp._sprite.scale.x;
      const airRotDeg = disp._sprite.rotation * 180 / Math.PI;
      // During stationary Idle Hover (`_ssActiveMoveAnim = false`), light world position `_getLightWorldPosition`
      // ignores sinusoidal `offsetY/scaleX/tiltAngle` bobbing, and trail spawning (`_updateTrailSpawn`) is suppressed:
      flyItemTok._ssActiveMoveAnim = false;
      flyItemTok._ssJumpState = {
        ...JA.computeIdleHoverFrame(1.0, 0.5, { gridSize: 100, tokenSize: 100 }),
        baseScaleX: 1,
        baseScaleY: 1
      };
      const lightPosPhase1 = tokenItemDisplay._getLightWorldPosition(flyItemTok, disp);
      flyItemTok._ssJumpState = {
        ...JA.computeIdleHoverFrame(1.0, 2.1, { gridSize: 100, tokenSize: 100 }),
        baseScaleX: 1,
        baseScaleY: 1
      };
      const lightPosPhase2 = tokenItemDisplay._getLightWorldPosition(flyItemTok, disp);
      let trailSpawnedOnHover = 0;
      const origSpawn = tokenItemDisplay.trail.spawn;
      tokenItemDisplay.trail.spawn = () => { trailSpawnedOnHover++; };
      tokenItemDisplay._updateTrailSpawn(disp, flyItemTok, tokenItemDisplay._getCurrentWorldPosition(flyItemTok, disp), 0.016);
      tokenItemDisplay._updateTrailSpawn(disp, flyItemTok, { x: wpAir.x + 80, y: wpAir.y - 40 }, 0.016);
      tokenItemDisplay.trail.spawn = origSpawn;
      check(
        wpGround.x === 190 && wpGround.y === 250 &&
        wpAir.y < 250 - 25 && wpAir.x > 190 &&
        Math.abs(airScaleX - (50 / 64) * 1.15 * (flyItemTok._ssPerspScale || 1)) < 1e-4 &&
        Math.abs(airRotDeg - (-15 + 8)) < 1e-4 &&
        lightPosPhase1.x === lightPosPhase2.x && lightPosPhase1.y === lightPosPhase2.y &&
        trailSpawnedOnHover === 0,
        `fly-dynamic-item: предмет следует за высотой полёта (y=${Math.round(wpAir.y)} vs 250), масштабом (scaleX=${airScaleX.toFixed(3)}) и креном (rot=${airRotDeg.toFixed(1)}°), а в парении свет стационарен и шлейф не спамится`
      );

      // 5h. Flexible Token Movement Settings (`walk`, `jump`, `fly`, `fall`, `vertical`, `verticalBlur`, `verticalCameraZoom`)
      const tmKeys = ['walk', 'jump', 'fly', 'fall', 'vertical', 'verticalBlur', 'verticalCameraZoom'];
      const setTm = (k, v) => settingsStore.set(`tokenMovement.${k}`, v);
      for (const k of tmKeys) setTm(k, true);
      const prevStageScale = { x: canvas.stage.scale.x, y: canvas.stage.scale.y };
      const prevStagePan = canvas.pan;
      const prevBg = canvas.primary.background;
      const prevTokensPlaceables = canvas.tokens.placeables;
      const prevTokensControlled = canvas.tokens.controlled;
      const prevPixiBlur = globalThis.PIXI.BlurFilter;
      globalThis.PIXI.BlurFilter = class FakeBlurFilter {
        constructor() { this.blur = 0; this.quality = 2; this.resolution = 1; this.enabled = true; }
        destroy() {}
      };
      try {
        const gTok = {
          id: 'cfg-ground',
          x: 100,
          y: 100,
          w: 100,
          h: 100,
          visible: true,
          document: { id: 'cfg-ground', x: 100, y: 100, width: 1, height: 1, elevation: 0, movementAction: 'walk' },
          get center() { return { x: this.x + 50, y: this.y + 50 }; },
          mesh: {
            destroyed: false,
            position: { x: 150, y: 150, set(nx, ny) { this.x = nx; this.y = ny; } },
            scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
            angle: 0,
            filters: []
          }
        };
        const highWalkTok = {
          id: 'cfg-high-walk',
          x: 400,
          y: 100,
          w: 100,
          h: 100,
          visible: true,
          document: { id: 'cfg-high-walk', x: 400, y: 100, width: 1, height: 1, elevation: 30, movementAction: 'walk' },
          get center() { return { x: this.x + 50, y: this.y + 50 }; },
          mesh: {
            destroyed: false,
            position: { x: 450, y: 150, set(nx, ny) { this.x = nx; this.y = ny; } },
            scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
            angle: 0,
            filters: []
          }
        };
        const fTok = {
          id: 'cfg-fly',
          x: 200,
          y: 200,
          w: 100,
          h: 100,
          visible: true,
          controlled: true,
          actor: { system: { attributes: { movement: { fly: 30 } } } },
          document: { id: 'cfg-fly', x: 200, y: 200, width: 1, height: 1, elevation: 60, movementAction: 'fly' },
          get center() { return { x: this.x + 50, y: this.y + 50 }; },
          mesh: {
            destroyed: false,
            position: { x: 250, y: 250, set(nx, ny) { this.x = nx; this.y = ny; } },
            scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
            angle: 0,
            filters: []
          }
        };
        const fallTok = {
          id: 'cfg-fall',
          x: 300,
          y: 300,
          w: 100,
          h: 100,
          visible: true,
          actor: { statuses: new Set(['falling']) },
          document: { id: 'cfg-fall', x: 300, y: 300, width: 1, height: 1, elevation: 30, movementAction: 'walk' },
          get center() { return { x: this.x + 50, y: this.y + 50 }; },
          mesh: {
            destroyed: false,
            position: { x: 350, y: 350, set(nx, ny) { this.x = nx; this.y = ny; } },
            scale: { x: 1, y: 1, set(sx, sy) { this.x = sx; this.y = sy; } },
            angle: 0,
            filters: []
          }
        };

        // 1) walk=false disables grounded walk without blocking jump
        setTm('walk', false);
        const walkOffOk = !JA.isWalkAnimationSegment(gTok, { x: 100, y: 100 }, { x: 200, y: 100 }, { action: 'walk' }) &&
          !JA.attachJumpAnimationToContext(gTok, { x: 100, y: 100 }, { x: 200, y: 100 }, { to: {} }, { action: 'walk' }) &&
          JA.isJumpAnimationSegment(gTok, { x: 100, y: 100 }, { x: 200, y: 100 }, { action: 'jump' });
        setTm('walk', true);

        // 2) jump=false disables jump & air-jump and does NOT convert a jump action into a grounded walk
        setTm('jump', false);
        gTok._ssLastElevation = 0;
        const fakeTicker = { add: () => {}, remove: () => {} };
        const savedTick = canvas.app.ticker;
        canvas.app.ticker = fakeTicker;
        gTok.document.elevation = 20;
        const airJumpBlocked = !JA.syncTokenFlyHover(gTok, { elevation: 20 }, { animate: true });
        gTok.document.elevation = 0;
        canvas.app.ticker = savedTick;
        const jumpOffOk = !JA.isJumpAnimationSegment(gTok, { x: 100, y: 100 }, { x: 200, y: 100 }, { action: 'jump' }) &&
          !JA.isWalkAnimationSegment(gTok, { x: 100, y: 100 }, { x: 200, y: 100 }, { action: 'jump' }) &&
          airJumpBlocked && !gTok._ssAirJump;
        setTm('jump', true);

        // 3) fly=false disables fly/hover visuals AND does NOT trigger false air-jump or walk on an airborne flying token
        setTm('fly', false);
        const flyOffOk = !JA.isTokenInFlyMode(fTok) &&
          !JA.isFlyAnimationSegment(fTok, { x: 200, y: 200, elevation: 60 }, { x: 300, y: 200, elevation: 60 }, { action: 'fly' }) &&
          !JA.isJumpAnimationSegment(fTok, { x: 200, y: 200, elevation: 0 }, { x: 300, y: 200, elevation: 20 }, { action: 'fly' }) &&
          !JA.isWalkAnimationSegment(fTok, { x: 200, y: 200, elevation: 60 }, { x: 300, y: 200, elevation: 60 }, { action: 'fly' });
        setTm('fly', true);

        // 4) fall=false disables falling segment & falling loop
        setTm('fall', false);
        const fallOffOk = !JA.isFallAnimationSegment(fallTok, { x: 300, y: 300, elevation: 30 }, { x: 400, y: 300, elevation: 0 }, { fall: true }) &&
          !JA.syncTokenFlyHover(fallTok, { elevation: 20 }, {});
        setTm('fall', true);

        // 5) Vertical display toggles: vertical, verticalBlur, verticalCameraZoom
        const bgMock = { destroyed: false, visible: true, elevation: 0, filters: [], _ssDofBlurPx: 0 };
        canvas.primary.background = bgMock;
        canvas.stage.scale.x = 1;
        canvas.stage.scale.y = 1;
        canvas.pan = ({ scale }) => {
          if (Number.isFinite(scale)) {
            canvas.stage.scale.x = scale;
            canvas.stage.scale.y = scale;
          }
        };
        canvas.tokens.placeables = [gTok, highWalkTok, fTok];
        canvas.tokens.controlled = [fTok];

        JA.refreshTokenMovementSettings();
        const zoomOnDefault = canvas.stage.scale.x < 0.95;
        const blurOnDefault = (bgMock._ssDofBlurPx || 0) > 0.1 && Boolean(bgMock._ssDofBlurFilter);
        const perspOnDefault = Boolean(highWalkTok._ssPerspState) && (highWalkTok._ssPerspScale || 1) > 1.05;
        const gBlurOnDefault = (gTok.mesh._ssDofBlurPx || 0) > 0.1;

        // Disable only verticalBlur -> blur clears to 0 (filter removed from obj.filters), camera zoom stays zoomed out, elevated perspective stays active
        setTm('verticalBlur', false);
        JA.refreshTokenMovementSettings();
        const blurClearedOnly = (bgMock._ssDofBlurPx || 0) === 0 && (gTok.mesh._ssDofBlurPx || 0) === 0 &&
          (!bgMock.filters || bgMock.filters.length === 0) && (bgMock._ssDofBlurFilter?.blur || 0) === 0 &&
          (!gTok.mesh.filters || gTok.mesh.filters.length === 0) &&
          canvas.stage.scale.x < 0.95 && Boolean(highWalkTok._ssPerspState);

        // Disable verticalCameraZoom -> stage scale restores back to 1.0 immediately, elevated perspective stays active
        setTm('verticalCameraZoom', false);
        JA.refreshTokenMovementSettings();
        const zoomClearedOnly = Math.abs(canvas.stage.scale.x - 1) < 1e-4 && Boolean(highWalkTok._ssPerspState);

        // Re-enable blur+zoom, then disable master vertical -> clears perspective, blur, AND camera zoom
        setTm('verticalBlur', true);
        setTm('verticalCameraZoom', true);
        JA.refreshTokenMovementSettings();
        const reEnabledOk = canvas.stage.scale.x < 0.95 && (gTok.mesh._ssDofBlurPx || 0) > 0.1 && Boolean(highWalkTok._ssPerspState);

        setTm('vertical', false);
        JA.refreshTokenMovementSettings();
        const masterVertOffOk = Math.abs(canvas.stage.scale.x - 1) < 1e-4 &&
          (bgMock._ssDofBlurPx || 0) === 0 && (gTok.mesh._ssDofBlurPx || 0) === 0 &&
          !highWalkTok._ssPerspState;

        JA.clearJumpStateForToken(gTok, { destroyShadow: true });
        JA.clearJumpStateForToken(highWalkTok, { destroyShadow: true });
        JA.clearJumpStateForToken(fTok, { destroyShadow: true });
        JA.clearJumpStateForToken(fallTok, { destroyShadow: true });

        check(
          walkOffOk && jumpOffOk && flyOffOk && fallOffOk &&
          zoomOnDefault && blurOnDefault && perspOnDefault && gBlurOnDefault &&
          blurClearedOnly && zoomClearedOnly && reEnabledOk && masterVertOffOk,
          `token-movement-settings: walkOff=${walkOffOk}, jumpOff=${jumpOffOk}, flyOff=${flyOffOk}, fallOff=${fallOffOk}, def=(${zoomOnDefault},${blurOnDefault},${perspOnDefault},${gBlurOnDefault}), vertBlurOff=${blurClearedOnly}, camZoomOff=${zoomClearedOnly}, reEnable=${reEnabledOk}, vertMasterOff=${masterVertOffOk}`
        );
      } finally {
        globalThis.PIXI.BlurFilter = prevPixiBlur;
        for (const k of tmKeys) settingsStore.delete(`tokenMovement.${k}`);
        canvas.stage.scale.x = prevStageScale.x;
        canvas.stage.scale.y = prevStageScale.y;
        canvas.pan = prevStagePan;
        canvas.primary.background = prevBg;
        canvas.tokens.placeables = prevTokensPlaceables;
        canvas.tokens.controlled = prevTokensControlled;
        JA.clearAllJumpAnimations();
        JA.refreshTokenMovementSettings();
      }
    }
  }
  const asHex = (p) => `#${[p.r, p.g, p.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  check(asHex(TC.tokenBloodColor({ document: { flags: { showstopper: { bloodColor: '#00ff00d0' } } } })) === '#00ff00',
    'tokenColor: наш флаг приоритетен');
  check(asHex(TC.tokenBloodColor({ document: { flags: { splatter: { bloodColor: '#ff0000d0' } } } })) === '#ff0000',
    'tokenColor: легаси-флаг Splatter читается как источник');
  check(asHex(TC.tokenBloodColor({ document: {}, actor: { system: { details: { type: { value: 'undead' } } } } })) === '#3d0b0f',
    'tokenColor: встроенная палитра по типу существа');
  check(asHex(TC.tokenBloodColor({ document: {} })) === '#a51414',
    'tokenColor: мировой дефолт');

  // --- Footprint styles (boot / paw / claw / hoof / slither / none) ---
  check(
    BloodAtlas.kindCount('pawprint') === 4 &&
    BloodAtlas.kindCount('clawprint') === 4 &&
    BloodAtlas.kindCount('hoofprint') === 4,
    'footprint-atlas: pawprint, clawprint, hoofprint имеют по 4 варианта в атласе'
  );
  check(
    TC.resolveTokenFootprintStyle({ document: { name: 'Зимний волк' }, actor: { system: { details: { type: { value: 'beast' } } } } }) === 'paw' &&
    TC.resolveTokenFootprintStyle({ document: { name: 'Adult Red Dragon' }, actor: { system: { details: { type: { value: 'dragon' } } } } }) === 'claw' &&
    TC.resolveTokenFootprintStyle({ document: { name: 'Боевой конь' }, actor: { system: { details: { type: { value: 'beast' } } } } }) === 'hoof' &&
    TC.resolveTokenFootprintStyle({ document: { name: 'Студенистый куб' }, actor: { system: { details: { type: { value: 'ooze' } } } } }) === 'slither' &&
    TC.resolveTokenFootprintStyle({ document: { name: 'Призрак' }, actor: { system: { details: { type: { value: 'undead' } } } } }) === 'none' &&
    TC.resolveTokenFootprintStyle({ document: { name: 'Стражник' }, actor: { system: { details: { type: { value: 'humanoid' } } } } }) === 'boot' &&
    TC.resolveTokenFootprintStyle({ document: { name: 'Стражник', flags: { showstopper: { footprintStyle: 'paw' } } }, actor: { system: { details: { type: { value: 'humanoid' } } } } }) === 'paw',
    'footprint-auto: автоопределение лап/когтей/копыт/волока/призраков + приоритет ручного флага footprintStyle'
  );
  {
    const { TrailEngine } = await import(`${root}/scripts/blood/trail.mjs`);
    const runWalk = (style, id) => {
      const st = new BloodStore(game.scenes.get('scene1'));
      st.add([st.createStain({ x: 650, y: 500, s: 300, a: 0.9, c: '#a51414d8' })], { broadcast: false });
      const tr = new TrailEngine(() => st);
      tr.footprints({
        id, x: 500, y: 500, width: 1, height: 1,
        flags: { showstopper: { footprintStyle: style } }
      }, { x: 750, y: 500 });
      return st.stains.slice(1);
    };
    const pawStains = runWalk('paw', 'wolf-1');
    const clawStains = runWalk('claw', 'drake-1');
    const hoofStains = runWalk('hoof', 'horse-1');
    const slitherStains = runWalk('slither', 'ooze-1');
    const noneStains = runWalk('none', 'ghost-1');
    check(
      pawStains.some(s => s.t === STAIN.FOOTPRINT && s.fp === 1) &&
      clawStains.some(s => s.t === STAIN.FOOTPRINT && s.fp === 2) &&
      hoofStains.some(s => s.t === STAIN.FOOTPRINT && s.fp === 3) &&
      slitherStains.length > 0 && slitherStains.every(s => s.t === STAIN.SMEAR) &&
      noneStains.length === 0,
      'footprint-trail: TrailEngine.footprints эмитит fp=1 (paw), fp=2 (claw), fp=3 (hoof), SMEAR (slither) и 0 пятен (none)'
    );
  }
  {
    const BL = await import(`${root}/scripts/blood/bloodied.mjs`);
    check(
      BL.computeWoundSeverity(0) === 0 &&
      BL.computeWoundSeverity(-0.5) === 0 &&
      BL.computeWoundSeverity(1) === 1 &&
      BL.computeWoundSeverity(1.5) === 1 &&
      BL.computeWoundSeverity(0.25) < BL.computeWoundSeverity(0.5) &&
      BL.computeWoundSeverity(0.5) < BL.computeWoundSeverity(0.85),
      'bloodied: computeWoundSeverity монотонна и зажата в 0..1'
    );
    const coatA = BL.acquireWoundCoatTexture('tok-seed-alpha');
    const coatA2 = BL.acquireWoundCoatTexture('tok-seed-alpha');
    const coatB = BL.acquireWoundCoatTexture('tok-seed-beta');
    check(
      Boolean(coatA) && coatA === coatA2 && coatA !== coatB,
      'bloodied: acquireWoundCoatTexture строит процедурную карту и кэширует по seed'
    );
  }
  // --- Multi-level (Foundry v14 native Levels) ---
  {
    const ELEV = await import(`${root}/scripts/blood/elevation.mjs`);
    const PART = await import(`${root}/scripts/blood/particles.mjs`);
    const ZONES = await import(`${root}/scripts/blood/zones.mjs`);
    const { BloodEventHooks } = await import(`${root}/scripts/blood/events.mjs`);
    const scene = canvas.scene ?? game.scenes.get('scene1');
    const prevLevels = scene.levels;
    const prevCanvasLevel = canvas.level;
    const prevPrimaryBg = canvas.primary.background;
    const prevRegions = scene.regions;
    const prevTiles = canvas.tiles.placeables;
    try {
      const lvlB = { id: 'lvlB', elevation: { bottom: -20, top: 0 }, background: { src: 'b.webp' }, visibility: { levels: new Set() } };
      const lvl1 = { id: 'lvl1', elevation: { bottom: 0, top: 20 }, background: { src: 'f1.webp' }, visibility: { levels: new Set() } };
      const lvl2 = { id: 'lvl2', elevation: { bottom: 20, top: 40 }, background: { src: 'f2.webp' }, visibility: { levels: new Set(['lvl1']) } };
      scene.levels = new Map([['lvlB', lvlB], ['lvl1', lvl1], ['lvl2', lvl2]]);
      canvas.level = lvl2;

      // Hole in floor 2 at (400..500, 400..500): background alpha drops blood through to visible lvl1
      canvas.primary.background = {
        _textureAlphaData: new Uint8Array(4),
        containsCanvasPoint: (pt) => !(pt.x >= 400 && pt.x <= 500 && pt.y >= 400 && pt.y <= 500)
      };

      const sUpper = ELEV.surfaceAt(100, 100, Infinity, 'lvl2');
      const sBasement = ELEV.surfaceAt(100, 100, Infinity, 'lvlB');
      const sHole = ELEV.surfaceAt(450, 450, Infinity, 'lvl2');
      check(
        sUpper.e === 20 && sUpper.lvl === 'lvl2' &&
        sBasement.e === -20 && sBasement.lvl === 'lvlB' &&
        sHole.e === 0 && sHole.lvl === 'lvl1',
        `multi-level-blood: surfaceAt уважает этажи и дыры (f2=${sUpper.e}/${sUpper.lvl}, b=${sBasement.e}/${sBasement.lvl}, hole=${sHole.e}/${sHole.lvl})`
      );

      // Renderer visibility & per-level containers
      const stLvl = new BloodStore(scene);
      const rLvl = new BloodRenderer({ scale: 0.5 });
      stLvl.setRenderer(rLvl);
      const stOnL2 = stLvl.createStain({ x: 120, y: 120, s: 80, e: 20, lvl: 'lvl2' });
      const stOnL1 = stLvl.createStain({ x: 120, y: 120, s: 80, e: 0, lvl: 'lvl1' });
      const stOnLB = stLvl.createStain({ x: 120, y: 120, s: 80, e: -20, lvl: 'lvlB' });
      stLvl.add([stOnL2, stOnL1, stOnLB], { broadcast: false });
      rLvl.flush();
      const c2 = rLvl._elevContainers.get('20|lvl2');
      const c1 = rLvl._elevContainers.get('0|lvl1');
      const cB = rLvl._elevContainers.get('-20|lvlB');
      check(
        Boolean(c2) && c2.elevation === 20 &&
        Boolean(c1) && c1.elevation === 0 &&
        !cB &&
        rLvl.stains.length === 2,
        `multi-level-blood: рендер рисует видимые lvl2/lvl1 и скрывает lvlB (visible=${rLvl.stains.length})`
      );
      rLvl.destroy();

      // Trail on floor 2, isolation from foreign level at same elevation, and cross-level move skip
      const hooks = new BloodEventHooks(() => stLvl);
      stLvl.clear({ broadcast: false });
      const puddleL2 = stLvl.createStain({ x: 250, y: 200, s: 250, a: 0.9, e: 20, lvl: 'lvl2' });
      const puddleOther = stLvl.createStain({ x: 250, y: 600, s: 250, a: 0.9, e: 20, lvl: 'lvlOther' });
      stLvl.add([puddleL2, puddleOther], { broadcast: false });
      hooks._trail.footprints({ id: 'ml-t1', x: 100, y: 200, width: 1, height: 1, elevation: 20, level: 'lvl2' }, { x: 400, y: 200 });
      const printsL2 = stLvl.stains.filter(s => s.t === STAIN.FOOTPRINT && s.lvl === 'lvl2' && s.e === 20);
      hooks._trail.footprints({ id: 'ml-t2', x: 100, y: 600, width: 1, height: 1, elevation: 20, level: 'lvl2' }, { x: 400, y: 600 });
      const printsForeign = stLvl.stains.filter(s => s.t === STAIN.FOOTPRINT && s.y > 500);
      hooks._trail.footprints({ id: 'ml-t3', x: 100, y: 200, width: 1, height: 1, elevation: 20, level: 'lvl2' }, { x: 400, y: 200, level: 'lvl1' });
      const printsBeforeCross = stLvl.stains.filter(s => s.t === STAIN.FOOTPRINT).length;
      check(
        printsL2.length >= 2 && printsForeign.length === 0 && printsBeforeCross === printsL2.length,
        `multi-level-blood: следы на 2 этаже, изоляция чужих уровней и пропуск межэтажного перехода (L2=${printsL2.length}, foreign=${printsForeign.length})`
      );

      // Particles: skip invisible lvlB, raise container elevation for lvl2
      PART.stopAllBursts();
      PART.spawnBurstLocal({ x: 200, y: 200, count: 10, seed: 7, level: 'lvlB', elevation: -20 });
      const afterInvisible = PART.debugStats().active;
      PART.spawnBurstLocal({ x: 200, y: 200, count: 10, seed: 8, level: 'lvl2', elevation: 20 });
      const afterL2 = PART.debugStats().active;
      check(
        afterInvisible === 0 && afterL2 === 10,
        `multi-level-blood: частицы пропускают невидимый уровень lvlB и спавнятся на lvl2 (${afterInvisible} -> ${afterL2})`
      );
      PART.stopAllBursts();

      // Zones: includedInLevel isolates bloodZone 'none' on lvl1 from lvl2
      scene.regions = [
        {
          behaviors: [{ disabled: false, type: ZONES.BLOOD_ZONE_TYPE, system: { mode: 'none' } }],
          polygonTree: { testPoint: () => true },
          includedInLevel: (id) => id === 'lvl1'
        }
      ];
      const z1 = ZONES.bloodZoneModeAt(150, 150, 'lvl1');
      const z2 = ZONES.bloodZoneModeAt(150, 150, 'lvl2');
      check(
        z1 === 'none' && z2 === null,
        `multi-level-blood: bloodZoneModeAt изолирует уровни (lvl1=${z1}, lvl2=${z2})`
      );
    } finally {
      scene.levels = prevLevels;
      canvas.level = prevCanvasLevel;
      canvas.primary.background = prevPrimaryBg;
      scene.regions = prevRegions;
      canvas.tiles.placeables = prevTiles;
    }
  }
}

setTimeout(() => {
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}, 50);
