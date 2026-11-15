// Finisher smoke test outside Foundry: PIXI/canvas/game stubs with
// frame-by-frame ticker stepping. Catches choreography runtime errors.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------ stubs ------------------------------ */

function fakeCtx2d() {
  const stub = () => {};
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '',
    fillRect: stub, beginPath: stub, arc: stub, fill: stub, stroke: stub,
    moveTo: stub, lineTo: stub, closePath: stub,
    save: stub, restore: stub, clip: stub, translate: stub, scale: stub,
    drawImage: stub,
    createRadialGradient: () => ({ addColorStop: stub }),
    createLinearGradient: () => ({ addColorStop: stub })
  };
}

class FakeRect { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } }

class FakeTexture {
  constructor(a, b) {
    if (a && typeof a === 'object' && 'source' in a) { this.source = a.source; this.frame = a.frame; }
    else { this.source = a ?? {}; this.frame = b ?? new FakeRect(0, 0, 100, 100); }
    this.width = this.frame?.width ?? 100;
    this.height = this.frame?.height ?? 100;
    this.valid = true;
  }
  static from() { return new FakeTexture(); }
}

class FakeObservable {
  constructor() {
    this.children = [];
    this.alpha = 1; this.visible = true; this.renderable = true; this.rotation = 0;
    this._x = 0; this._y = 0; this.zIndex = 0;
    // Like PIXI DisplayObject: destroy() nulls out transform so writing x/y
    // throws — the smoke test must catch this class of bug (a tween on a
    // destroyed target previously hung silently and crashed the runner ticker every frame)
    this.transform = { position: { x: 0, y: 0 } };
    this.position = {
      set: (x, y) => { this.position.x = x; this.position.y = y; },
      x: 0, y: 0
    };
    this.scale = { set: (x, y) => { this.scale.x = x; this.scale.y = y; }, x: 1, y: 1 };
    this.anchor = { set: (x, y) => { this.anchor.x = x; this.anchor.y = y; }, x: 0, y: 0 };
    this.pivot = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
    this.parent = null;
    this.width = 100; this.height = 100;
    this.tint = 0xffffff;
    this.blendMode = 'normal';
    this.sortableChildren = false;
  }
  get x() { return this._x; }
  set x(v) {
    if (this.transform === null) throw new TypeError("Cannot read properties of null (reading 'position')");
    this._x = v;
  }
  get y() { return this._y; }
  set y(v) {
    if (this.transform === null) throw new TypeError("Cannot read properties of null (reading 'position')");
    this._y = v;
  }
  addChild(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  addChildAt(node, index) {
    node.parent = this;
    this.children.splice(Math.max(0, Math.min(this.children.length, index)), 0, node);
  }
  removeFromParent() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  destroy() {
    this.removeFromParent();
    for (const c of [...this.children]) c.destroy?.();
    this.children = [];
    this.transform = null;
    // Like PIXI: the engine checks .destroyed in several branches (bolts,
    // ring tile, choreography tiles) — without this flag the stub exercised live paths
    this.destroyed = true;
  }
  sortChildren() {}
  getBounds() { return new FakeRect(-50, -50, 100, 100); }
}

class FakeSprite extends FakeObservable {
  constructor(tex) { super(); this.texture = tex ?? new FakeTexture(); }
}
class FakeGraphics extends FakeObservable {
  constructor() { super(); this._ops = 0; }
  clear() { this._ops = 0; }
  lineStyle() { this._ops++; }
  beginFill() { this._ops++; }
  endFill() {}
  moveTo() {}
  lineTo() {}
  drawCircle() {}
  drawEllipse() { this._ops++; }
  drawPolygon() { this._ops++; }
}

globalThis.PIXI = {
  Texture: FakeTexture,
  TextureSource: class FakeTextureSource {},
  Rectangle: FakeRect,
  Container: FakeObservable,
  Sprite: FakeSprite,
  Graphics: FakeGraphics,
  // Ice/multi-effect frozen-overlay filter: uniforms + destroy suffice
  Filter: class FakeFilter {
    constructor(vertexSrc, fragSrc, uniforms) {
      this.fragSrc = fragSrc;
      this.uniforms = uniforms ?? {};
    }
    destroy() { this.destroyed = true; }
  },
  // "Fatality" captions: anchored text sprite
  Text: class FakeText extends FakeSprite {
    constructor(text, style) { super(); this.text = String(text ?? ''); this.style = style ?? {}; }
  }
};

// Procedural pixel textures in the engine call document.createElement('canvas')
const fakeDocument = {
  createElement: (tag) => {
    if (tag !== 'canvas') return { style: {}, classList: { add: stub, remove: stub }, remove: stub, appendChild: stub };
    return { width: 0, height: 0, getContext: () => fakeCtx2d() };
  },
  body: { appendChild: stub, removeChild: stub }
};
function stub() {}
globalThis.document = fakeDocument;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ------------------------------ canvas ------------------------------ */

const tickers = [];
const tokenMeshTexture = new FakeTexture();

function makeToken(id) {
  const mesh = new FakeSprite(tokenMeshTexture);
  mesh.texture.source = {}; // not a TextureSource → exercises PIXI v7 sub-texture path
  const t = {
    id,
    destroyed: false,
    visible: true,
    mesh,
    document: { alpha: 1, hidden: false, texture: { scaleX: 1, scaleY: 1 }, delete: async () => { t.destroyed = true; } },
    bounds: new FakeRect(500, 500, 200, 200),
    center: { x: 600, y: 600 }
  };
  return t;
}
const token = makeToken('tok1');
const attackerTok = makeToken('tok2');
attackerTok.bounds = new FakeRect(900, 500, 200, 200);
attackerTok.center = { x: 1000, y: 600 };

const tokensById = { [token.id]: token, [attackerTok.id]: attackerTok };

globalThis.canvas = {
  grid: { size: 100 },
  tokens: { get: (id) => tokensById[id] ?? null },
  primary: null,
  stage: Object.assign(new FakeObservable(), {
    pivot: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } },
    scale: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } }
  }),
  animatePan: async () => {},
  app: {
    ticker: {
      add: (fn) => tickers.push(fn),
      remove: (fn) => { const i = tickers.indexOf(fn); if (i >= 0) tickers.splice(i, 1); },
      deltaMS: 16
    }
  }
};

// WebAudio stub: no-op methods so synthesis does not throw outside a browser
const param = () => ({
  value: 0,
  setValueAtTime: () => {}, linearRampToValueAtTime: () => {},
  exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {}
});
class FakeAudioParamNode {
  constructor() { this.gain = param(); this.frequency = param(); this.Q = param(); this.buffer = null; this.curve = null; this.type = ''; this.loop = false; }
  connect() {} start() {} stop() {}
}
globalThis.AudioContext = class FakeAudioContext {
  constructor() {
    this.currentTime = 0; this.sampleRate = 44100; this.state = 'running';
    this.destination = {};
  }
  resume() {}
  createGain() { return new FakeAudioParamNode(); }
  createOscillator() { return new FakeAudioParamNode(); }
  createBufferSource() { return new FakeAudioParamNode(); }
  createBiquadFilter() { return new FakeAudioParamNode(); }
  createConvolver() { return new FakeAudioParamNode(); }
  createWaveShaper() { return new FakeAudioParamNode(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len), length: len }; }
};

/* ------------------------------ game/Hooks ------------------------------ */

const strings = new Map([
  ['showstopper.cut-ins.ui.selectToken', 'Select a token'],
  ['showstopper.cut-ins.ui.comingSoon', 'soon']
]);
// "Fatality" caption localization keys: smoke also exercises the caption() path
for (const key of ['slashing', 'piercing', 'fire', 'cold', 'thunder',
  'force', 'soul', 'glitch', 'singularity',
  'smite', 'blackhole']) {
  strings.set(`showstopper.cut-ins.finisher.${key}.caption`, 'FINISHED');
}
globalThis.game = {
  user: { isGM: true, targets: new Set([token]) },
  i18n: { localize: (k) => strings.get(k) ?? k, format: (k) => strings.get(k) ?? k },
  settings: {
    get: () => ({}),
    set: async () => {}
  },
  modules: { get: () => ({ active: false }) }
};
const hookListeners = new Map();
globalThis.Hooks = {
  on: (name, fn) => {
    if (!hookListeners.has(name)) hookListeners.set(name, []);
    hookListeners.get(name).push(fn);
  },
  once: stub,
  off: stub,
  callAll: (name, ...args) => {
    for (const fn of hookListeners.get(name) ?? []) fn(...args);
  }
};
globalThis.foundry = {
  utils: { randomID: () => Math.random().toString(16).slice(2), deepClone: (o) => JSON.parse(JSON.stringify(o)) },
  applications: {
    instances: new Map(),
    api: {
      ApplicationV2: class FakeAppV2 {},
      HandlebarsApplicationMixin: (cls) => cls
    }
  }
};
globalThis.ui = {
  notifications: { warn: stub, info: stub, error: stub },
  controls: {
    rendered: true,
    renderCalls: 0,
    render() { this.renderCalls++; }
  }
};
globalThis.window = globalThis.window ?? globalThis;

/* ------------------------------ run ------------------------------ */

const rootDir = path.resolve(process.argv[2] ?? '.');
const root = pathToFileURL(rootDir).href;
const hasPlus = process.env.SS_SKIP_PLUS !== '1' && existsSync(path.join(rootDir, 'plus/scripts/plus-bundle.mjs'));
// Full load path matching main.mjs: cut-ins/index registers all categories
const mod = await import(`${root}/scripts/cut-ins/index.mjs`);
const { effectRegistry } = await import(`${root}/scripts/cut-ins/registry.mjs`);
await import(`${root}/scripts/main.mjs`);

// 1) Verify standalone base module (Free): 4 built-in categories, 0 concrete effects,
//    and toolbar button hidden until at least one effect is registered.
{
  const builtinCats = effectRegistry.getCategories().map(c => c.id);
  const freeIntros = effectRegistry.getByCategory('introductions').length;
  const freeOpenings = effectRegistry.getByCategory('openings').length;
  const freeEndings = effectRegistry.getByCategory('endings').length;
  const freeFinishers = effectRegistry.getByCategory('finishers').length;
  console.log(`free standalone: categories=[${builtinCats.join(',')}] intros=${freeIntros} openings=${freeOpenings} endings=${freeEndings} finishers=${freeFinishers}`);
  if (builtinCats.join(',') !== 'introductions,openings,endings,finishers') {
    console.error('FAIL: unexpected built-in categories:', builtinCats);
    process.exit(1);
  }
  if (freeIntros !== 0 || freeOpenings !== 0 || freeEndings !== 0 || freeFinishers !== 0 || effectRegistry.hasEffects()) {
    console.error('FAIL: Free standalone module must ship 0 bundled effects');
    process.exit(1);
  }

  // Toolbar visibility gate: hidden when 0 effects, shown once >=1 effect is registered, hidden again on last unregister
  const collectControls = () => {
    const controls = { tokens: { tools: {} } };
    globalThis.Hooks.callAll('getSceneControlButtons', controls);
    return controls.tokens.tools;
  };
  if ('cinematic-menu' in collectControls()) {
    console.error('FAIL: cinematic-menu button should NOT be shown when 0 effects are registered');
    process.exit(1);
  }
  globalThis.ui.controls.renderCalls = 0;
  mod.registerOpening({ id: 'smoke-toolbar-probe', name: 'Toolbar Probe', async render() {} });
  await Promise.resolve();
  if (!('cinematic-menu' in collectControls()) || globalThis.ui.controls.renderCalls < 1) {
    console.error('FAIL: cinematic-menu button did not appear / refresh controls after registering first effect');
    process.exit(1);
  }
  mod.unregisterEffect('smoke-toolbar-probe');
  await Promise.resolve();
  if ('cinematic-menu' in collectControls() || effectRegistry.hasEffects()) {
    console.error('FAIL: cinematic-menu button did not hide after unregistering last effect');
    process.exit(1);
  }
  console.log('OK   toolbar-visibility      hidden when empty, shown on registration, hidden when emptied');
}

// 2) Load showstopper-plus extension on top of base showstopper (when present locally),
//    or register a synthetic test finisher in standalone CI mode so engine regressions run.
let syntheticFinisherRegistered = false;
if (hasPlus) {
  const plusMod = await import(`${root}/plus/scripts/plus-bundle.mjs`);
  plusMod.registerPlusContent();
  const allIntros = effectRegistry.getByCategory('introductions').length;
  const allOpenings = effectRegistry.getByCategory('openings').length;
  const allEndings = effectRegistry.getByCategory('endings').length;
  const allFinishers = effectRegistry.getByCategory('finishers').length;
  console.log(`with showstopper-plus: intros=${allIntros} openings=${allOpenings} endings=${allEndings} finishers=${allFinishers}`);
  if (allIntros !== 11 || allOpenings !== 2 || allEndings !== 5 || allFinishers !== 11) {
    console.error('FAIL: unexpected Plus effect counts');
    process.exit(1);
  }
} else {
  mod.registerFinisher({
    id: 'ci-synthetic-finisher',
    name: 'CI Synthetic Finisher',
    damageType: 'force',
    async play(ctx) {
      if (ctx.attacker) await ctx.dashStrike({ ms: 20 });
      const cap = ctx.capture();
      const r = ctx.rand(0.2, 0.8);
      ctx.pick([1, 2, 3]);
      ctx.chance(0.5);
      for (const t of cap.tiles) {
        if (!t.isRing) ctx.tween(t.sprite, { alpha: 0 }, { ms: 20 + r * 10 });
      }
      await ctx.wait(40);
    }
  });
  syntheticFinisherRegistered = true;
}

const expectedFinishers = hasPlus ? 11 : 1;
const classes = effectRegistry.getByCategory('finishers');
console.log('finishers:', classes.length);
if (classes.length < expectedFinishers) { console.error(`FAIL: expected ${expectedFinishers}`); process.exit(1); }

let failures = 0;

// Background frame pump: the ticker must spin concurrently with choreography,
// just like rAF in a browser (runner timers/tweens live on the ticker)
const pump = setInterval(() => {
  for (const fn of [...tickers]) fn({ deltaMS: 16 });
}, 2);

for (const cls of classes) {
  // Reset token
  token.destroyed = false;
  token.visible = true;
  tickers.length = 0;

  const t0 = Date.now();
  try {
    await cls.runLocal({ id: cls.id, tokenIds: [token.id], options: { intensity: 1, camera: false, removeAfter: false, preview: true } });
    // Let trailing async continuations settle
    for (let i = 0; i < 30 && tickers.length; i++) {
      await new Promise(r => setTimeout(r, 2));
    }
    const ms = Date.now() - t0;
    // Token must be fully restored: both mesh (visible+renderable) and token object
    const meshOk = token.mesh.visible === true && token.mesh.renderable === true;
    const okVisible = (meshOk && token.visible === true) || token.destroyed;
    console.log(`OK   ${cls.id.padEnd(24)} ${String(ms).padStart(5)}ms  tickerLeft=${tickers.length} visible=${token.visible} mesh=${token.mesh.visible}/${token.mesh.renderable}`);
    if (!okVisible) { console.error(`     token left hidden!`); failures++; }
    if (tickers.length) { console.error(`     ticker not removed!`); failures++; }
  } catch (e) {
    failures++;
    console.error(`FAIL ${cls.id}:`, e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
  }
}

/* REGRESSION for overlapping runs: two concurrent runLocal calls on the same token.
   Previously the second runner recorded the ALREADY-hidden token as its initial state,
   inverting the restore chain and leaving the token hidden at the end.
   Now runLocal serializes per token, so the token is visible after both runs finish. */
{
  const cls = classes[0];
  token.destroyed = false;
  token.visible = true;
  token.mesh.visible = true;
  token.mesh.renderable = true;
  tickers.length = 0;
  try {
    await Promise.all([
      cls.runLocal({ id: cls.id, tokenIds: [token.id], options: { intensity: 1, camera: false, removeAfter: false, preview: true } }),
      cls.runLocal({ id: cls.id, tokenIds: [token.id], options: { intensity: 1, camera: false, removeAfter: false, preview: true } })
    ]);
    for (let i = 0; i < 30 && tickers.length; i++) {
      await new Promise(r => setTimeout(r, 2));
    }
    const meshOk = token.mesh.visible === true && token.mesh.renderable === true;
    if (!meshOk || token.visible !== true) {
      failures++;
      console.error(`FAIL concurrent-overlap: token left hidden (visible=${token.visible} mesh=${token.mesh.visible}/${token.mesh.renderable})`);
    } else {
      console.log('OK   concurrent-overlap      token restored after two overlapping runs');
    }
    if (tickers.length) { console.error('     ticker not removed!'); failures++; }
  } catch (e) {
    failures++;
    console.error('FAIL concurrent-overlap:', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
  }
}

/* REGRESSION for enforced hiding: an external system (core visibility refresh,
   document update) flips visible back on mid-animation — the runner must
   re-hide it on the next frame and restore visibility once finished. */
{
  const cls = classes[0];
  token.destroyed = false;
  token.visible = true;
  token.mesh.visible = true;
  token.mesh.renderable = true;
  tickers.length = 0;
  try {
    const job = cls.runLocal({ id: cls.id, tokenIds: [token.id], options: { intensity: 1, camera: false, removeAfter: false, preview: true } });
    let hidden = false;
    for (let i = 0; i < 500 && !hidden; i++) {
      await new Promise(r => setTimeout(r, 2));
      hidden = token.mesh.visible === false && token.mesh.renderable === false;
    }
    if (!hidden) throw new Error('runner did not hide the token');
    // An external system re-shows the token mid-animation
    token.mesh.visible = true;
    token.mesh.renderable = true;
    await new Promise(r => setTimeout(r, 10)); // 1–2 ticker frames
    const enforced = token.mesh.visible === false && token.mesh.renderable === false;
    await job;
    for (let i = 0; i < 30 && tickers.length; i++) await new Promise(r => setTimeout(r, 2));
    const restored = token.mesh.visible === true && token.mesh.renderable === true && token.visible === true;
    if (!enforced) { failures++; console.error('FAIL enforce-hidden: external re-show was not re-hidden mid-run'); }
    else if (!restored) { failures++; console.error('FAIL enforce-hidden: token left hidden after animation'); }
    else console.log('OK   enforce-hidden           external re-show re-hidden mid-run, restored after');
    if (tickers.length) { console.error('     ticker not removed!'); failures++; }
  } catch (e) {
    failures++;
    console.error('FAIL enforce-hidden:', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
  }
}

/* REGRESSION for "token 1 finishes token 2" interaction: with attackerId, choreography
   plays a dashStrike lunge (attacker mesh via mesh-animator; smoke stub lacks
   showstopper.meshAnim so it hits the beat fallback) — the attacker is NOT hidden during
   the dash and MUST remain on the map (visible + mesh.visible/renderable)
   at the end of the finisher alongside the victim. */
{
  const cls = classes[0]; // slashing — opens with dashStrike when an attacker is provided
  token.destroyed = false;
  token.visible = true;
  token.mesh.visible = true;
  token.mesh.renderable = true;
  attackerTok.destroyed = false;
  attackerTok.visible = true;
  attackerTok.mesh.visible = true;
  attackerTok.mesh.renderable = true;
  tickers.length = 0;
  try {
    await cls.runLocal({
      id: cls.id, tokenIds: [token.id],
      options: { intensity: 1, camera: false, removeAfter: false, attackerId: attackerTok.id, preview: true }
    });
    for (let i = 0; i < 30 && tickers.length; i++) {
      await new Promise(r => setTimeout(r, 2));
    }
    const victimOk = token.visible === true && token.mesh.visible === true && token.mesh.renderable === true;
    const atkOk = attackerTok.visible === true && attackerTok.mesh.visible === true && attackerTok.mesh.renderable === true;
    if (!victimOk || !atkOk) {
      failures++;
      console.error(`FAIL attacker-dash: victim(v=${token.visible} m=${token.mesh.visible}/${token.mesh.renderable}) attacker(v=${attackerTok.visible} m=${attackerTok.mesh.visible}/${attackerTok.mesh.renderable})`);
    } else {
      console.log('OK   attacker-dash            victim and attacker both restored');
    }
    if (tickers.length) { console.error('     ticker not removed!'); failures++; }
  } catch (e) {
    failures++;
    console.error('FAIL attacker-dash:', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
  }
}

/* REGRESSION for CHOREOGRAPHY SEED: execute() mints a seed and broadcasts it in
   the showFinisher payload — the runner seeds _rng (blood/rng Rng), so two runs
   with the SAME seed produce an identical sequence of ctx.rand/chance/pick calls
   (giving all players pixel-identical scatter). Different seeds diverge. */
{
  const { FinisherRunner } = await import(`${root}/scripts/cut-ins/finishers/finisher-engine.mjs`);
  const seqs = [];
  let cur = null;
  const orig = {
    rand: FinisherRunner.prototype.rand,
    chance: FinisherRunner.prototype.chance,
    pick: FinisherRunner.prototype.pick
  };
  try {
    FinisherRunner.prototype.rand = function (a, b) { const v = orig.rand.call(this, a, b); cur.push(v); return v; };
    FinisherRunner.prototype.chance = function (p2) { const v = orig.chance.call(this, p2); cur.push(v); return v; };
    FinisherRunner.prototype.pick = function (a) { const v = orig.pick.call(this, a); cur.push(v); return v; };
    const cls0 = classes.find(c => c.id === 'slashing-finisher') ?? classes[0];
    for (const seed of [4242, 4242, 99]) {
      cur = []; seqs.push(cur);
      token.destroyed = false; token.visible = true;
      token.mesh.visible = true; token.mesh.renderable = true;
      await cls0.runLocal({
        id: cls0.id, tokenIds: [token.id], seed,
        options: { intensity: 1, camera: false, removeAfter: false, preview: true }
      });
      for (let i = 0; i < 30 && tickers.length; i++) await new Promise(r => setTimeout(r, 2));
    }
  } finally {
    Object.assign(FinisherRunner.prototype, orig);
  }
  token.destroyed = false; token.visible = true;
  token.mesh.visible = true; token.mesh.renderable = true;
  const same = JSON.stringify(seqs[0]) === JSON.stringify(seqs[1]);
  const diff = JSON.stringify(seqs[0]) !== JSON.stringify(seqs[2]);
  if (!seqs[0].length || !same || !diff) {
    failures++;
    console.error(`FAIL seed-determinism: draws=${seqs.map(s => s.length).join('/')} same=${same} diff=${diff}`);
  } else {
    console.log(`OK   seed-determinism       ${seqs[0].length} draws: same seed identical, other seed differs`);
  }
}

if (syntheticFinisherRegistered) {
  mod.unregisterFinisher('ci-synthetic-finisher');
}

/* REGRESSION for SHADER OVERLAYS (frozenTint + 7 SHADER_EFFECTS modes):
   syncToken builds/switches/removes PIXI.Filter with the matching uMode, and
   resolveTokenShaderEffect detects flags and active status effects. */
{
  const { SHADER_EFFECTS, SHADER_EFFECT_IDS, resolveTokenShaderEffect, syncToken } = await import(`${root}/scripts/cut-ins/finishers/token-shaders.mjs`);
  try {
    if (SHADER_EFFECT_IDS.length !== 7) throw new Error(`expected 7 shader effects, got ${SHADER_EFFECT_IDS.length}`);
    for (const removed of ['spectral', 'magma', 'prismatic', 'poisoned', 'shocked']) {
      if (removed in SHADER_EFFECTS) throw new Error(`${removed} should be removed`);
    }
    const flags = {};
    token.document.flags = { showstopper: flags };
    token.document.getFlag = (ns, k) => (ns === 'showstopper' ? flags[k] : undefined);

    // 1. frozenTint backward compatibility
    flags.frozenTint = '#ffffff';
    if (resolveTokenShaderEffect(token) !== 'frozen') throw new Error('frozenTint did not resolve to frozen');
    syncToken(token);
    const child0 = token.mesh.children.find(c => c.name === 'showstopperShader');
    if (!child0) throw new Error('frozen overlay container not attached');

    // 2. All 7 modes via shaderEffect
    delete flags.frozenTint;
    for (const id of SHADER_EFFECT_IDS) {
      flags.shaderEffect = id;
      if (resolveTokenShaderEffect(token) !== id) throw new Error(`shaderEffect=${id} not resolved`);
      syncToken(token);
      const cont = token.mesh.children.find(c => c.name === 'showstopperShader');
      const spr = cont?.children?.[0];
      const uMode = spr?.filters?.[0]?.uniforms?.uMode;
      if (uMode !== SHADER_EFFECTS[id].mode) throw new Error(`mode mismatch for ${id}: ${uMode}`);
    }

    // 3. Auto-detect strictly by status ID on an ActiveEffect (a spell name like "Fire Shield" must not match)
    delete flags.shaderEffect;
    token.actor = {
      effects: [
        { disabled: false, statuses: new Set(), name: 'Огненный щит (Fire Shield)' },
        { disabled: false, statuses: new Set(['fire']), name: 'Горение' }
      ]
    };
    if (resolveTokenShaderEffect(token) !== null) {
      throw new Error('effect matched by name or non-strict status ID');
    }
    token.actor = { effects: [{ disabled: false, statuses: new Set(['petrified']), name: ' Произвольное имя ' }] };
    if (resolveTokenShaderEffect(token) !== 'petrified') throw new Error('status petrified did not auto-resolve');
    syncToken(token);

    // 4. Detaching the overlay
    token.actor = null;
    syncToken(token);
    if (token.mesh.children.some(c => c.name === 'showstopperShader')) {
      throw new Error('overlay was not detached after clearing flags/statuses');
    }

    // 5. Native integration with TokenRing / ring.effects (analogous to Spectral Pulse 0x10)
    const {
      RING_SHADER_MODE_SHIFT,
      RING_SHADER_STATE_MASK,
      patchRingShaderClass,
      installRingShaderIntegration
    } = await import(`${root}/scripts/cut-ins/finishers/token-shaders.mjs`);
    class StubRingShader {
      static _batchFragmentShader = `
        const uint STATE_COLOR_OVER_SUBJECT = 0x20U;
        vec4 colorizeTokenRing(in vec4 tokenRing, in float dist) { return tokenRing; }
        vec4 processTokenColor(in vec4 finalColor) {
          if ( !hasState(STATE_INVISIBLE) ) return finalColor;
          return finalColor;
        }
        vec4 _main() {
          vec2 scaledDistVec = vec2(0.0);
          float rectangularMask = 1.0;
          vec4 processedColor = processTokenColor(vec4(1.0));
          vec4 blendedResult = processedColor * rectangularMask;
          vec4 result;
          result = blendedResult * vColor.a;
          return result;
        }
      `;
    }
    class StubTokenRing {
      constructor(t) { this.token = t; this.effects = 0x01 | 0x10 | 0x40; }
      configureVisuals() { this.effects = 0x01 | 0x10 | 0x40; }
    }
    globalThis.foundry.canvas = {
      placeables: { tokens: { TokenRing: StubTokenRing } },
      rendering: { shaders: { TokenRingSamplerShader: StubRingShader } }
    };
    installRingShaderIntegration();
    if (!patchRingShaderClass(StubRingShader)) throw new Error('patchRingShaderClass returned false');
    for (const marker of ['STATE_COLOR_OVER_SUBJECT', 'rectangularMask', 'colorizeTokenRing', 'STATE_INVISIBLE', 'ssApplyTokenShader(blendedResult, processedColor.a, scaledDistVec, rectangularMask)']) {
      if (!StubRingShader._batchFragmentShader.includes(marker)) {
        throw new Error(`patched shader missing marker ${marker}`);
      }
    }
    token.hasDynamicRing = true;
    token.ring = new StubTokenRing(token);
    for (const id of SHADER_EFFECT_IDS) {
      flags.shaderEffect = id;
      syncToken(token);
      if (token.mesh.children.some(c => c.name === 'showstopperShader')) {
        throw new Error(`ring token should not attach child sprite for ${id}`);
      }
      // Lower bits (0x01 ENABLED | 0x10 INVISIBILITY Spectral Pulse | 0x40 TOP_LAYER) must be preserved
      if ((token.ring.effects & 0x51) !== 0x51) {
        throw new Error(`ring.effects lower bits clobbered for ${id}: 0x${token.ring.effects.toString(16)}`);
      }
      const modeBits = (token.ring.effects >> RING_SHADER_MODE_SHIFT) & 0xF;
      if (modeBits !== SHADER_EFFECTS[id].mode + 1) {
        throw new Error(`ring.effects mode bits mismatch for ${id}: got ${modeBits}`);
      }
    }
    delete flags.shaderEffect;
    syncToken(token);
    if ((token.ring.effects & RING_SHADER_STATE_MASK) !== 0 || (token.ring.effects & 0x51) !== 0x51) {
      throw new Error(`ring.effects not cleanly cleared: 0x${token.ring.effects.toString(16)}`);
    }
    token.hasDynamicRing = false;
    token.ring = null;

    console.log(`OK   shader-overlays        ${SHADER_EFFECT_IDS.length} modes + native TokenRing (ring.effects)`);
  } catch (e) {
    failures++;
    console.error('FAIL shader-overlays:', e.message);
  }
}

// 7) Public Extension API: declarative intros/openings/endings/finishers + custom categories + playActorIntro
{
  try {
    const api = mod.buildCutInsAPI();
    const events = [];

    // Custom category tab sorted between openings (20) and endings (30)
    api.registerCategory({
      id: 'transitions',
      label: 'Transitions',
      icon: 'fa-solid fa-hourglass-half',
      order: 25,
      hideWhenEmpty: true
    });
    const cats = api.getCategories().map(c => c.id);
    const openIdx = cats.indexOf('openings');
    const transIdx = cats.indexOf('transitions');
    const endIdx = cats.indexOf('endings');
    if (!(openIdx >= 0 && openIdx < transIdx && transIdx < endIdx)) {
      throw new Error(`custom category order wrong: ${cats.join(', ')}`);
    }

    // Declarative intro effect with settings, prepare, render, and playActorIntro
    api.registerIntro({
      id: 'ext-test-intro',
      name: 'Extension Intro',
      description: 'Test declarative intro',
      order: -10,
      settings: [
        { name: 'accent', type: 'color', label: 'Accent', default: '#123456' }
      ],
      async prepare({ actor, settings }) {
        return { tag: `${actor.name}:${settings.accent}` };
      },
      async render(payload, ctx) {
        const ok = await ctx.wait(5);
        events.push(`intro:${payload.tag}:ok=${ok}`);
      }
    });

    const introsOrder = api.getByCategory('introductions').map(e => e.id);
    if (introsOrder[0] !== 'ext-test-intro') {
      throw new Error(`order=-10 intro did not sort first: ${introsOrder[0]}`);
    }

    const fakeActor = {
      id: 'actor-ext-1',
      name: 'Lord Soth',
      img: 'soth.webp',
      type: 'npc',
      system: { details: { biography: { value: '<em>Death Knight</em> Dark champion.' }, cr: 17 } },
      getFlag: (scope, key) => (scope === 'showstopper' && key === 'introEffectId' ? 'ext-test-intro' : null)
    };

    await api.playActorIntro(fakeActor, { localOnly: true });
    if (!events.includes('intro:Lord Soth:#123456:ok=true')) {
      throw new Error(`playActorIntro did not run ext-test-intro: ${JSON.stringify(events)}`);
    }

    // Declarative opening: abort when prepare() === null, and run normally otherwise
    api.registerOpening({
      id: 'ext-test-opening',
      name: 'Act Card',
      async prepare({ options }) {
        if (options.cancel) return null;
        return { act: options.act ?? 'ACT I' };
      },
      async render(payload) {
        events.push(`opening:${payload.act}`);
      }
    });
    const cancelledRes = await api.play('ext-test-opening', { cancel: true, localOnly: true });
    if (cancelledRes !== null || events.some(e => e.startsWith('opening:'))) {
      throw new Error('cancelled prepare() should abort render()');
    }
    await api.play('ext-test-opening', { act: 'ACT IV', localOnly: true });
    if (!events.includes('opening:ACT IV')) {
      throw new Error(`opening did not receive prepared payload: ${JSON.stringify(events)}`);
    }

    // Declarative finisher via generic register()
    const finCls = api.register({
      id: 'ext-test-finisher',
      category: 'finishers',
      name: 'Radiant Burst',
      damageType: 'radiant',
      settings: [{ name: 'beamCount', type: 'number', label: 'Beams', default: 7 }]
    });
    if (finCls.getName() !== 'Radiant Burst' || finCls.getDefaultSettings().beamCount !== 7) {
      throw new Error('declarative finisher metadata/settings mismatch');
    }

    // Clean up registry
    if (!api.unregister('ext-test-intro') || !api.unregister('ext-test-opening') || !api.unregister('ext-test-finisher')) {
      throw new Error('unregister returned false');
    }
    if (!api.unregisterCategory('transitions') || api.unregisterCategory('introductions')) {
      throw new Error('category unregister guard failed (builtin must be protected)');
    }

    console.log('OK   extension-api          declarative intros/openings/finishers + custom categories + playActorIntro');
  } catch (e) {
    failures++;
    console.error('FAIL extension-api:', e.message);
  }
}

clearInterval(pump);
setTimeout(() => {
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}, 100);
