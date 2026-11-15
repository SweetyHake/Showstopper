// Dev-only FRAME-BY-FRAME finisher renderer outside Foundry: same stubs as
// _smoke.mjs, but with REAL rasterization (@napi-rs/canvas), a virtual
// camera (animatePan/shake actually move the pivot), and a deterministic
// 60fps ticker. Every frame is written to PNG + metrics (ink, centroid,
// teleports, alpha-pops, NaN) — objective verification of CHOREOGRAPHY,
// not just absence of exceptions.
//
//   node scripts/cut-ins/finishers/_framecheck.mjs . [filter1,filter2]
//
// Looks for the canvas package at $TEMP/ss-framecheck/node_modules/@napi-rs/canvas
// (npm install @napi-rs/canvas). Refuses to start without it.
// Output: $TEMP/ss-framecheck/out/<id>/ {frame_*.png, sheet.png, metrics.json,
// seqlog.json} — seqlog records garnish def spawns/rejections (the Sequencer
// simulator steps the fx layer frame-by-frame; FC_VARIANT=mirror|tiny|huge|concurrent
// covers blind spots: mirrored token, clamp bounds, concurrent runners).
//
// NOT COVERED: live Sequencer/JB2A media (fx=false → procedural branches
// or simulated cyan boxes), DOM overlays (screenFlash), audio, scene blood/decals.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

/* ------------------------------ canvas package ------------------------------ */

const require = createRequire(import.meta.url);
const canvasPkgPath = path.join(os.tmpdir(), 'ss-framecheck', 'node_modules', '@napi-rs', 'canvas');
let napiCanvas;
try {
  napiCanvas = require(canvasPkgPath);
} catch {
  console.error(`no @napi-rs/canvas at ${canvasPkgPath} — npm install it there first`);
  process.exit(2);
}
const { createCanvas } = napiCanvas;

/* ------------------------------ PIXI stubs ------------------------------ */
/* Preserves _smoke semantics (destroy() nulls out transform, writing x/y
   throws), while every node implements draw(ctx) for real rasterization. */

const BLEND_BY_NUM = { 0: 'source-over', 1: 'lighter', 2: 'multiply', 3: 'screen' };

class RTexture {
  constructor(a, b) {
    // a can be: {source}, a BaseTexture stub ({source, resource: {source}}), or
    // {resource: {source}} (as in new PIXI.Texture(baseTexture, frame)) —
    // unwrap down to the pixel source (canvas)
    const s = (a && typeof a === 'object') ? (a.source ?? a.resource?.source ?? a) : a;
    if (a && typeof a === 'object' && ('source' in a || 'resource' in a)) {
      this.source = s;
      this.frame = b ?? { x: 0, y: 0, width: s.width, height: s.height };
    } else {
      this.source = s ?? null;
      this.frame = b ?? { x: 0, y: 0, width: 100, height: 100 };
    }
    this.width = this.frame.width;
    this.height = this.frame.height;
    this.valid = true;
    // Engine access to the pixel source: baseTexture.resource.source
    // (TokenCapture pre-mirrors it when texture.scaleX/Y < 0)
    this.baseTexture = { resource: { source: this.source } };
  }
  static from(src) {
    if (src instanceof RTexture) return src;
    return new RTexture({ source: src });
  }
}

let _nodeSeq = 0;
const _nodeName = new WeakMap();

class RNode {
  constructor() {
    this.children = [];
    this.alpha = 1; this.visible = true; this.renderable = true; this.rotation = 0;
    this._x = 0; this._y = 0; this.zIndex = 0;
    this.transform = { position: { x: 0, y: 0 } };
    // position is LINKED to x/y (as in PIXI): capture places tiles via
    // position.set — desynchronization left everything at world origin until
    // the first position tween. IMPORTANT: x/y getters/setters delegate TO THE
    // NODE (`this` inside accessors is the position object, not the node) —
    // otherwise reading position.x after position.set(...) returned undefined,
    // giving NaN to choreographies that snapshot coordinates (halves in slashing)
    const node = this;
    this.position = {
      set: (x, y) => { node.x = x; node.y = y; },
      get x() { return node._x; }, set x(v) { node._x = v; },
      get y() { return node._y; }, set y(v) { node._y = v; }
    };
    this.scale = { set: (x, y = x) => { this.scale.x = x; this.scale.y = y; }, x: 1, y: 1 };
    this.anchor = { set: (x, y = x) => { this.anchor.x = x; this.anchor.y = y; }, x: 0, y: 0 };
    this.pivot = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
    this.parent = null;
    this.tint = 0xffffff;
    this.blendMode = 0;
    this.sortableChildren = false;
    if (!_nodeName.has(this)) _nodeName.set(this, `n${++_nodeSeq}`);
  }
  get name() { return _nodeName.get(this); }
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
  addChild(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } return nodes[0]; }
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
    this.destroyed = true;
  }
  sortChildren() {}
  getBounds() { return { x: this.x - 50, y: this.y - 50, width: 100, height: 100 }; }
  /* --- rasterization --- */
  draw(g, parentAlpha) {
    if (!this.visible || !this.renderable || this.alpha <= 0.003) return;
    const a = parentAlpha * this.alpha;
    if (a <= 0.003) return;
    g.save();
    g.globalAlpha = a;
    g.globalCompositeOperation = BLEND_BY_NUM[this.blendMode] ?? 'source-over';
    g.translate(this.x, this.y);
    if (this.rotation) g.rotate(this.rotation);
    if (this.scale.x !== 1 || this.scale.y !== 1) g.scale(this.scale.x, this.scale.y);
    // PIXI transform order: position → rotate → scale → -pivot (piercing sets
    // pivot+position to the same point — without this, rendering drifted by pivot)
    if (this.pivot?.x || this.pivot?.y) g.translate(-this.pivot.x, -this.pivot.y);
    this.drawSelf(g, a);
    for (const c of this.children) c.draw(g, a);
    g.restore();
  }
  drawSelf() {}
}

class RSprite extends RNode {
  constructor(tex) { super(); this.texture = tex ?? new RTexture(); }
  get width() { return (this.texture?.width ?? 0) * Math.abs(this.scale.x); }
  set width(v) { const s = Math.sign(this.scale.x) || 1; this.scale.x = ((this.texture?.width ?? 1) ? v / this.texture.width : 1) * s; }
  get height() { return (this.texture?.height ?? 0) * Math.abs(this.scale.y); }
  set height(v) { const s = Math.sign(this.scale.y) || 1; this.scale.y = ((this.texture?.height ?? 1) ? v / this.texture.height : 1) * s; }
  drawSelf(g) {
    const tex = this.texture;
    const src = tex?.source;
    if (!src) return;
    const f = tex.frame ?? { x: 0, y: 0, width: src.width, height: src.height };
    const w = f.width, h = f.height;
    if (!(w > 0) || !(h > 0)) return;
    g.translate(-this.anchor.x * w, -this.anchor.y * h);
    if (this.tint === 0xffffff || this.tint === undefined || this.tint === null) {
      g.drawImage(src, f.x, f.y, w, h, 0, 0, w, h);
      return;
    }
    // tint: multiply + restore alpha (offscreen buffer only grows — avoids
    // reallocating createCanvas for every differently sized tile/ghost)
    const cw = Math.max(1, Math.ceil(w)), ch = Math.max(1, Math.ceil(h));
    if (!RSprite._tint || RSprite._tint.width < cw || RSprite._tint.height < ch) {
      const nw = Math.max(cw, RSprite._tint?.width ?? 256);
      const nh = Math.max(ch, RSprite._tint?.height ?? 256);
      RSprite._tint = createCanvas(nw, nh);
      RSprite._tg = RSprite._tint.getContext('2d');
    }
    const tg = RSprite._tg;
    tg.clearRect(0, 0, cw, ch);
    tg.drawImage(src, f.x, f.y, w, h, 0, 0, w, h);
    tg.globalCompositeOperation = 'multiply';
    tg.fillStyle = `#${(this.tint & 0xffffff).toString(16).padStart(6, '0')}`;
    tg.fillRect(0, 0, cw, ch);
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(src, f.x, f.y, w, h, 0, 0, w, h);
    tg.globalCompositeOperation = 'source-over';
    g.drawImage(RSprite._tint, 0, 0, w, h, 0, 0, w, h);
  }
}

class RText extends RSprite {
  constructor(text, style = {}) {
    super(new RTexture({ source: createCanvas(8, 8) }));
    this.text = String(text ?? '');
    this.style = style;
  }
  drawSelf(g) {
    const s = this.style ?? {};
    const size = s.fontSize ?? 48;
    g.font = `${s.fontWeight ?? 'bold'} ${size}px ${s.fontFamily ?? 'Arial'}`;
    g.fillStyle = s.fill ?? '#ffffff';
    g.textAlign = this.anchor?.x === 0.5 ? 'center' : 'left';
    g.textBaseline = 'middle';
    g.fillText(this.text, 0, 0);
  }
}

class RGraphics extends RNode {
  constructor() { super(); this._ops = []; this._fill = null; this._line = null; }
  clear() { this._ops = []; this._fill = null; this._line = null; }
  lineStyle(w, c, a) { this._line = { w, c, a: a ?? 1 }; }
  beginFill(c, a) { this._fill = { c, a: a ?? 1 }; }
  endFill() { this._ops.push({ op: 'end' }); }
  moveTo(x, y) { this._ops.push({ op: 'm', x, y }); }
  lineTo(x, y) { this._ops.push({ op: 'l', x, y }); }
  closePath() { this._ops.push({ op: 'close' }); }
  drawCircle(x, y, r) { this._ops.push({ op: 'circ', x, y, r }); }
  drawEllipse(x, y, rw, rh) { this._ops.push({ op: 'ell', x, y, rw, rh }); }
  drawPolygon(...pts) { this._ops.push({ op: 'poly', pts: pts.flat() }); }
  drawSelf(g) {
    // Replay: m/l/poly/circ/ell into path, end → fill+stroke with current styles
    const flush = () => {
      if (this._fill) { g.globalAlpha *= 1; g.fillStyle = cssColor(this._fill.c, this._fill.a); g.fill(); }
      if (this._line) { g.strokeStyle = cssColor(this._line.c, this._line.a); g.lineWidth = this._line.w; g.stroke(); }
      g.beginPath();
    };
    g.beginPath();
    for (const o of this._ops) {
      if (o.op === 'end') flush();
      else if (o.op === 'm') g.moveTo(o.x, o.y);
      else if (o.op === 'l') g.lineTo(o.x, o.y);
      else if (o.op === 'close') g.closePath();
      else if (o.op === 'circ') g.arc(o.x, o.y, Math.max(0.01, o.r), 0, Math.PI * 2);
      else if (o.op === 'ell') g.ellipse(o.x, o.y, Math.max(0.01, o.rw), Math.max(0.01, o.rh), 0, 0, Math.PI * 2);
      else if (o.op === 'poly') { const p = o.pts; if (p.length >= 4) { g.moveTo(p[0], p[1]); for (let i = 2; i + 1 < p.length; i += 2) g.lineTo(p[i], p[i + 1]); g.closePath(); } }
    }
    flush();
  }
}
function cssColor(c, a) {
  const v = Number.isFinite(c) ? (c & 0xffffff) : 0xffffff;
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

globalThis.PIXI = {
  Texture: RTexture,
  TextureSource: class {},
  BaseTexture: class { constructor(src) { this.resource = { source: src }; this.source = src; this.width = src?.width ?? 0; this.height = src?.height ?? 0; } destroy() {} },
  Rectangle: class { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } },
  Container: RNode,
  Sprite: RSprite,
  Graphics: RGraphics,
  Text: RText,
  BLEND_MODES: { NORMAL: 0, ADD: 1, MULTIPLY: 2, SCREEN: 3 }
};

/* -------- Sequencer SIMULATOR (frame-by-frame fx layer, media-free) --------
   Real finisher defs (delay/duration/at/offset/stretch/scale/tint) spawn
   virtual garnish sprites in each frame:
   - lifetime = delay → delay+duration (or 1500ms default), with
     fadeIn/fadeOut alpha ramps;
   - geometry: at/offset (grid cells × canvas.grid.size), stretch sets beam
     length and angle (matching real Sequencer), scaleToObject = N × token;
   - REJECTION RULE matching real Sequencer: stretch + scale combined →
     def is REJECTED (not spawned) and logged in window.__seqLog;
   - garnish objects are tagged with tint 0x00e5ff (visible as cyan entries
     in dumps) and live in a dedicated primary.seqLayer container.
   Lets agents verify garnish timings and def geometry frame-by-frame —
   catching the class of bugs where stretch+scale lived. */
globalThis.__seqLog = [];
{
  const seqSprites = []; // {sprite, born, def}
  let seqContainer = null;
  const seqLayerOf = () => {
    if (!seqContainer) {
      seqContainer = new PIXI.Container();
      // DO NOT assign name: RNode.name is getter-only; assigning it crashed
      // the first spawn of every run and orphaned the entire seq layer
      canvas.primary.addChild(seqContainer);
    }
    return seqContainer;
  };
  const CELL = () => canvas.grid?.size ?? 100;
  class SeqEffect {
    constructor() { this.props = {}; }
    file(f) { this.props.file = f; return this; }
    atLocation(t, o) { this.props.target = t; this.props.offset = o; return this; }
    stretchTo(o) { this.props.stretch = o; return this; }
    scale(v) { this.props.scaleAbs = v; return this; }
    scaleToObject(v) { this.props.scale = v; return this; }
    scaleIn(a) { this.props.scaleIn = a; return this; }
    tint(v) { this.props.tint = v; return this; }
    opacity(v) { this.props.opacity = v; return this; }
    anchor(v) { this.props.anchor = v; return this; }
    rotate(v) { this.props.rotate = v; return this; }
    randomRotation() { return this; }
    mirrorX() { return this; }
    playbackRate() { return this; }
    delay(v) { this.props.delay = v; return this; }
    duration(v) { this.props.duration = v; return this; }
    fadeIn(v) { this.props.fadeIn = v; return this; }
    fadeOut(v) { this.props.fadeOut = v; return this; }
    belowTokens() { return this; }
    missed() { return this; }
    play() {
      const p = this.props;
      const file = Array.isArray(p.file) ? p.file[0] : p.file;
      // Real Sequencer rule: stretch + scale are mutually exclusive → reject
      const hasStretch = !!p.stretch;
      if (hasStretch && (p.scale || p.scaleAbs)) {
        globalThis.__seqLog.push({ file, rejected: 'stretch+scale' });
        return { promise: Promise.resolve() };
      }
      const target = p.target;
      const cx = Number.isFinite(p.target?.x) && p.offset === undefined && !p.stretch
        ? p.target.x
        : (target?.center?.x ?? target?.x ?? 0);
      const cy = Number.isFinite(p.target?.y) && p.offset === undefined && !p.stretch
        ? p.target.y
        : (target?.center?.y ?? target?.y ?? 0);
      let x = cx, y = cy;
      // atLocation(token, {offset, gridUnits}) — offset wrapped in options:
      // unwrap and multiply cells × canvas.grid.size (matching real Sequencer)
      const off = p.offset?.offset ?? p.offset;
      if (off && Number.isFinite(off.x)) x += (off.x ?? 0) * CELL();
      if (off && Number.isFinite(off.y)) y += (off.y ?? 0) * CELL();
      let w = 64, h = 64, rot = 0;
      const tokenSize = target?.document?.width ? target.document.width * CELL() : 100;
      if (hasStretch && Number.isFinite(p.stretch.x) && Number.isFinite(p.stretch.y)) {
        const dx = p.stretch.x - cx, dy = p.stretch.y - cy;
        const len = Math.max(1, Math.hypot(dx, dy));
        w = len; h = tokenSize * 0.25;
        rot = Math.atan2(dy, dx);
      } else if (p.scale) {
        w = h = tokenSize * p.scale;
      } else if (p.scaleAbs) {
        w = h = 100 * p.scaleAbs;
      }
      const sprite = new PIXI.Sprite(new RTexture({ source: (() => {
        const c = createCanvas(32, 32);
        const g = c.getContext('2d');
        g.fillStyle = 'rgba(0, 229, 255, 0.22)';
        g.fillRect(0, 0, 32, 32);
        g.strokeStyle = 'rgba(0, 229, 255, 0.75)';
        g.lineWidth = 2;
        g.strokeRect(1, 1, 30, 30);
        g.fillStyle = 'rgba(255, 255, 255, 0.55)';
        g.fillRect(0, 0, 32, 3);
        return c;
      })() }));
      sprite.anchor.set(0.5);
      sprite.position.set(x, y);
      sprite.rotation = rot + (p.rotate ?? 0) * Math.PI / 180;
      sprite.width = w; sprite.height = h;
      sprite.tint = 0x00e5ff;
      sprite.alpha = 0;
      sprite.visible = false;
      seqLayerOf().addChild(sprite);
      seqSprites.push({
        sprite, born: frameCounterNow,
        delay: p.delay ?? 0,
        life: p.duration ?? 1500,
        fadeIn: p.fadeIn || 120, fadeOut: p.fadeOut || 220,
        opacity: p.opacity ?? 1,
        file
      });
      globalThis.__seqLog.push({ file, spawned: true, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
      return { promise: Promise.resolve() };
    }
  }
  class SeqClass {
    constructor() {}
    effect() { return new SeqEffect(); }
    canvasPan() { return { shake: () => ({ play: () => {} }) , play: () => {} }; }
    play() { return Promise.resolve(); }
  }
  globalThis.Sequencer = {
    Database: { entryExists: (p) => typeof p === 'string' && p.startsWith('jb2a.') },
    EffectManager: { getEffects: () => seqSprites.map(s => ({ data: { file: s.file } })) }
  };
  globalThis.Sequence = SeqClass;
  // Per-frame garnish aging: invoked from the _framecheck frame loop
  globalThis.__seqTick = (frameNow) => {
    frameCounterNow = frameNow;
    for (let i = seqSprites.length - 1; i >= 0; i--) {
      const s = seqSprites[i];
      const local = frameNow - s.born;
      const on = local * (1000 / 60) >= s.delay && local * (1000 / 60) <= s.delay + s.life;
      if (!on) { s.sprite.visible = false; if (local * (1000 / 60) > s.delay + s.life) seqSprites.splice(i, 1); continue; }
      const t = (local * (1000 / 60) - s.delay) / s.life;
      let a = s.opacity;
      if (s.fadeIn > 0) a *= Math.min(1, (t * s.life) / s.fadeIn);
      if (s.fadeOut > 0) a *= Math.min(1, ((1 - t) * s.life) / s.fadeOut);
      s.sprite.alpha = Math.max(0.01, Math.min(1, a));
      s.sprite.visible = true;
    }
  };
  globalThis.__seqReset = () => { seqSprites.length = 0; seqContainer = null; };
}
let frameCounterNow = 0;

/* document: canvas → REAL @napi-rs canvas (procedural engine textures are
   actually rendered), div → no-op stub (screenFlash DOM is not rendered) */
function stub() {}
globalThis.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return createCanvas(1, 1);
    return { style: {}, classList: { add: stub, remove: stub }, remove: stub, appendChild: stub, textContent: '' };
  },
  body: { appendChild: stub, removeChild: stub },
  getElementById: () => null
};
globalThis.requestAnimationFrame = (fn) => setImmediate(fn);

/* ------------------------------ scene ------------------------------ */

const VIEW_W = 1280, VIEW_H = 720;
const tickers = [];
const frameView = createCanvas(VIEW_W, VIEW_H);
const viewG = frameView.getContext('2d');

function drawFigure(canvasEl, hue, label) {
  const g = canvasEl.getContext('2d');
  const W = canvasEl.width, H = canvasEl.height;
  g.clearRect(0, 0, W, H);
  // Asymmetric figure: teardrop torso + head + sword marker so flips and
  // rotations are clearly visible frame-by-frame
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.32;
  g.fillStyle = `hsl(${hue},70%,55%)`;
  g.beginPath();
  g.moveTo(cx, cy - r * 1.35);
  g.quadraticCurveTo(cx + r * 1.15, cy - r * 0.5, cx + r * 0.8, cy + r);
  g.lineTo(cx - r * 0.8, cy + r);
  g.quadraticCurveTo(cx - r * 1.15, cy - r * 0.5, cx, cy - r * 1.35);
  g.closePath();
  g.fill();
  g.fillStyle = `hsl(${(hue + 40) % 360},60%,75%)`;
  g.beginPath(); g.arc(cx, cy - r * 1.55, r * 0.52, 0, Math.PI * 2); g.fill();
  g.fillStyle = `hsl(${(hue + 200) % 360},80%,60%)`;
  g.fillRect(cx + r * 0.85, cy - r * 1.7, r * 0.28, r * 2.6);
  if (label) {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = 'bold 22px Arial';
    g.fillText(label, 8, H - 10);
  }
}

const tokenCanvas = createCanvas(200, 200);
drawFigure(tokenCanvas, 210, 'V');
const attackerCanvas = createCanvas(200, 200);
drawFigure(attackerCanvas, 30, 'A');

function makeToken(id, artCanvas, x, y, opts = {}) {
  const tex = new RTexture({ source: artCanvas });
  const mesh = new RSprite(tex);
  const size = opts.size ?? 200;
  const mirrorX = opts.mirrorX ?? false;
  const t = {
    id,
    destroyed: false,
    visible: true,
    mesh,
    document: {
      alpha: 1, hidden: false, elevation: 0,
      texture: { scaleX: mirrorX ? -1 : 1, scaleY: 1 },
      width: Math.max(1, Math.round(size / 100)),
      height: Math.max(1, Math.round(size / 100)),
      ring: undefined,
      delete: async () => { t.destroyed = true; }
    },
    bounds: { x, y, width: size, height: size },
    center: { x: x + size / 2, y: y + size / 2 },
    isVisible: true
  };
  mesh.anchor.set(mirrorX ? 0.5 : 0, mirrorX ? 0.5 : 0);
  if (mirrorX) {
    // Mirrored token: centered mesh with negative scale — tests capture
    // flipU/flipV and sign preservation in ghost()/dashStrike
    mesh.x = x + size / 2; mesh.y = y + size / 2;
    mesh.scale.x = -1; mesh.scale.y = 1;
    mesh.width = size; mesh.height = size;
  } else {
    mesh.x = x; mesh.y = y;
    mesh.width = size; mesh.height = size;
  }
  t._home = { x: mesh.x, y: mesh.y };
  return t;
}

const token = makeToken('tok1', tokenCanvas, 500, 400);
const attackerTok = makeToken('tok2', attackerCanvas, 1000, 400);
const tokensById = { [token.id]: token, [attackerTok.id]: attackerTok };

const primary = new RNode();   // engine attaches the finisher layer here
const stage = new RNode();
const cam = {
  pivot: { x: VIEW_W / 2, y: VIEW_H / 2 }, scale: 1,
  _tween: null
};
stage.pivot = {
  get x() { return cam.pivot.x; }, set x(v) { cam.pivot.x = v; },
  get y() { return cam.pivot.y; }, set y(v) { cam.pivot.y = v; },
  set(x, y) { cam.pivot.x = x; cam.pivot.y = y; }
};
stage.scale = {
  get x() { return cam.scale; }, set x(v) { cam.scale = v; },
  get y() { return cam.scale; }, set y(v) { cam.scale = v; },
  set(x, y) { cam.scale = (x + y) / 2; }
};
const camWaiters = [];

globalThis.canvas = {
  grid: { size: 100 },
  tokens: { get: (id) => tokensById[id] ?? null },
  primary,
  stage,
  bounds: { x: 0, y: 0, width: 2000, height: 1400 },
  dimensions: [VIEW_W, VIEW_H],
  screenDimensions: [VIEW_W, VIEW_H],
  animatePan: async ({ x, y, scale, duration = 500 } = {}) => {
    await new Promise(resolve => {
      camWaiters.push(resolve);
      cam._tween = {
        from: { x: cam.pivot.x, y: cam.pivot.y, s: cam.scale },
        to: { x, y, s: scale ?? cam.scale },
        t: 0, dur: Math.max(1, duration)
      };
    });
  },
  app: {
    ticker: {
      add: (fn) => tickers.push(fn),
      remove: (fn) => { const i = tickers.indexOf(fn); if (i >= 0) tickers.splice(i, 1); },
      deltaMS: 16.6667
    }
  }
};

function tickCamera(dms) {
  const tw = cam._tween;
  if (!tw) return;
  tw.t += dms;
  const k = Math.min(1, tw.t / tw.dur);
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // inOutCubic
  cam.pivot.x = tw.from.x + (tw.to.x - tw.from.x) * e;
  cam.pivot.y = tw.from.y + (tw.to.y - tw.from.y) * e;
  cam.scale = tw.from.s + (tw.to.s - tw.from.s) * e;
  if (k >= 1) {
    cam._tween = null;
    const w = camWaiters.splice(0);
    for (const r of w) r();
  }
}

/* WebAudio stubs (same as _smoke) */
const param = () => ({ value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} });
class FakeAudioParamNode { constructor() { this.gain = param(); this.frequency = param(); this.Q = param(); this.buffer = null; this.curve = null; this.type = ''; this.loop = false; } connect() {} start() {} stop() {} }
globalThis.AudioContext = class FakeAudioContext {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.state = 'running'; this.destination = {}; }
  resume() {}
  createGain() { return new FakeAudioParamNode(); }
  createOscillator() { return new FakeAudioParamNode(); }
  createBufferSource() { return new FakeAudioParamNode(); }
  createBiquadFilter() { return new FakeAudioParamNode(); }
  createConvolver() { return new FakeAudioParamNode(); }
  createWaveShaper() { return new FakeAudioParamNode(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len), length: len }; }
};

/* game/Hooks (same as _smoke) */
const strings = new Map([
  ['showstopper.cut-ins.ui.selectToken', 'Select a token'],
  ['showstopper.cut-ins.ui.comingSoon', 'soon']
]);
for (const key of ['slashing', 'piercing', 'fire', 'cold', 'thunder',
  'force', 'soul', 'glitch', 'singularity', 'smite', 'blackhole']) {
  strings.set(`showstopper.cut-ins.finisher.${key}.caption`, 'FINISHED');
}
globalThis.game = {
  user: { isGM: true, targets: new Set([token]) },
  i18n: { localize: (k) => strings.get(k) ?? k, format: (k) => strings.get(k) ?? k },
  settings: { get: () => ({}), set: async () => {} },
  // jb2a/sequencer marked ACTIVE: enables the fx=true finisher branch —
  // the Sequencer simulator above steps garnish defs frame-by-frame
  modules: { get: (id) => ({ active: id === 'jb2a_patreon' || id === 'sequencer' }) }
};
globalThis.Hooks = { on: stub, once: stub, off: stub };
globalThis.foundry = {
  utils: { randomID: () => Math.random().toString(16).slice(2), deepClone: (o) => JSON.parse(JSON.stringify(o)) },
  applications: { instances: new Map(), api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (c) => c } }
};
globalThis.ui = { notifications: { warn: stub, info: stub, error: stub } };
globalThis.window = globalThis.window ?? globalThis;

/* ------------------------------ frame rendering ------------------------------ */

function renderFrame(frameIndex) {
  const g = viewG;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  // Scene background + grid
  g.fillStyle = '#141217';
  g.fillRect(0, 0, VIEW_W, VIEW_H);
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= 2000; x += 100) { g.moveTo(x, 0); g.lineTo(x, 1400); }
  for (let y = 0; y <= 1400; y += 100) { g.moveTo(0, y); g.lineTo(2000, y); }
  g.stroke();

  // Camera: world → screen
  g.translate(VIEW_W / 2, VIEW_H / 2);
  g.scale(cam.scale, cam.scale);
  g.translate(-cam.pivot.x, -cam.pivot.y);

  // Tokens (the victim is hidden during the finisher — rendered state reflects that)
  for (const t of Object.values(tokensById)) {
    if (t.destroyed) continue;
    const m = t.mesh;
    if (!(m.visible && m.renderable && t.visible)) continue;
    m.alpha = t.document?.alpha ?? 1;
    m.draw(g, 1);
  }
  // Finisher layer
  for (const c of primary.children) c.draw(g, 1);

  // HUD line
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.font = '12px monospace';
  g.fillText(`f${String(frameIndex).padStart(3, '0')}  t=${(frameIndex / 60).toFixed(2)}s  cam=${cam.scale.toFixed(2)}x@${cam.pivot.x.toFixed(0)},${cam.pivot.y.toFixed(0)}`, 8, VIEW_H - 8);
}

/* ------------------------------ pixel diff ------------------------------ */
/* Downscaled copy of the frame: mean |dRGB| and fraction of changed pixels —
   objective detector for freezes (diff ≈ 0 with an active ticker) and pops. */
const diffCanvas = createCanvas(320, 180);
const diffG = diffCanvas.getContext('2d', { willReadFrequently: true });
let prevPixels = null;
function rasterDiff() {
  diffG.drawImage(frameView, 0, 0, 320, 180);
  const data = diffG.getImageData(0, 0, 320, 180).data;
  if (!prevPixels) { prevPixels = data; return { mean: -1, frac: -1 }; }
  let sum = 0, changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - prevPixels[i]) + Math.abs(data[i + 1] - prevPixels[i + 1]) + Math.abs(data[i + 2] - prevPixels[i + 2]);
    sum += d / 3;
    if (d > 12) changed++;
  }
  const px = data.length / 4;
  prevPixels = data;
  return { mean: +(sum / px).toFixed(2), frac: +(changed / px).toFixed(4) };
}

/* ------------------------------ metrics ------------------------------ */

function collectNodes(root) {
  const out = [];
  (function walk(n) {
    if (!n || n.destroyed || !n.visible || !n.renderable) return;
    if (n.alpha <= 0.004) return;
    out.push(n);
    for (const c of n.children) walk(c);
  })(root);
  return out;
}

function nodeMetrics(n) {
  const w = Number(n.width) || 0, h = Number(n.height) || 0;
  return {
    id: n.name,
    t: n.constructor.name,
    z: n.parent ? n.parent.children.indexOf(n) : 0,
    x: Number(n.x), y: Number(n.y),
    w, h, a: Number(n.alpha),
    tint: Number(n.tint) || 0xffffff,
    rot: Number(n.rotation) || 0
  };
}

/* ------------------------------ run ------------------------------ */

const root = pathToFileURL(path.resolve(process.argv[2] ?? '.')).href;
const outDir = path.join(os.tmpdir(), 'ss-framecheck', 'out');
fs.mkdirSync(outDir, { recursive: true });

const modIndex = await import(`${root}/scripts/cut-ins/index.mjs`);
const { effectRegistry } = await import(`${root}/scripts/cut-ins/registry.mjs`);
try {
  const plusFin = await import(`${root}/plus/scripts/cut-ins/finishers/index.mjs`);
  plusFin.registerPlusFinishers?.();
} catch { /* plus optional */ }

// meshAnim stub for dashStrike: smoothly tweens the attacker mesh across ticker frames
const meshTweens = [];
function tickMeshAnim(dms) {
  for (let i = meshTweens.length - 1; i >= 0; i--) {
    const mt = meshTweens[i];
    mt.t += dms;
    const k = Math.min(1, mt.t / mt.dur);
    const e = mt.easing === 'easeIn' ? k * k : 1 - (1 - k) * (1 - k);
    mt.mesh.x = mt.fromX + mt.dx * e;
    mt.mesh.y = mt.fromY + mt.dy * e;
    if (k >= 1) {
      meshTweens.splice(i, 1);
      mt.resolve();
    }
  }
}
globalThis.showstopper = globalThis.showstopper ?? {};
globalThis.showstopper.meshAnim = {
  animate: (tok, props, { duration = 200, easing = 'easeOut' } = {}) => new Promise(resolve => {
    const m = tok?.mesh;
    if (!m || duration <= 0) {
      if (m) { m.x += props.x ?? 0; m.y += props.y ?? 0; }
      resolve();
      return;
    }
    meshTweens.push({
      tok, mesh: m,
      fromX: m.x, fromY: m.y,
      dx: props.x ?? 0, dy: props.y ?? 0,
      t: 0, dur: duration, easing, resolve
    });
  }),
  reset: (tok, duration = 200) => new Promise(resolve => {
    const m = tok?.mesh;
    const home = tok?._home;
    for (let i = meshTweens.length - 1; i >= 0; i--) {
      if (meshTweens[i].tok === tok) { const [old] = meshTweens.splice(i, 1); old.resolve(); }
    }
    if (!m || !home || duration <= 0) {
      if (m && home) { m.x = home.x; m.y = home.y; }
      resolve();
      return;
    }
    meshTweens.push({
      tok, mesh: m,
      fromX: m.x, fromY: m.y,
      dx: home.x - m.x, dy: home.y - m.y,
      t: 0, dur: duration, easing: 'easeOut', resolve
    });
  })
};

let classes = effectRegistry.getByCategory('finishers');
const filter = process.argv[3];
if (filter) {
  const want = new Set(filter.split(',').map(s => s.trim().toLowerCase()));
  classes = classes.filter(c => want.has(c.id.replace('-finisher', '')) || want.has(c.id));
}
console.log('framecheck finishers:', classes.map(c => c.id.replace('-finisher', '')).join(', '));

const FRAME_MS = 1000 / 60;
const MAX_FRAMES = 60 * 14;
const VARIANT = process.env.FC_VARIANT ?? '';

async function runOne(cls, victim = token, tag = '', skipReset = false, onFrame = null) {
  const id = cls.id.replace('-finisher', '') + tag;
  const dir = path.join(outDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Reset state; in concurrent mode the destructive reset runs ONCE before
  // both launches — running it a second time wiped the first runner's ticker
  // (freezing its clock until watchdog) and orphaned its layer
  if (!skipReset) {
  for (const t of [token, attackerTok, victim]) {
    if (!t) continue;
    t.destroyed = false; t.visible = true;
    t.mesh.visible = true; t.mesh.renderable = true;
    t.mesh.x = t._home.x; t.mesh.y = t._home.y;
    const sx = (t.document?.texture?.scaleX ?? 1) < 0 ? -1 : 1;
    t.mesh.scale.set(sx, 1);
    t.mesh.width = t.bounds.width;
    t.mesh.height = t.bounds.height;
  }
  meshTweens.length = 0;
  tickers.length = 0;
  primary.children.length = 0;
  globalThis.__seqReset?.(); // seq layer is recreated on the first spawn
  globalThis.__seqLog.length = 0;
  cam.pivot.x = VIEW_W / 2; cam.pivot.y = VIEW_H / 2; cam.scale = 1;
  cam._tween = null; camWaiters.length = 0;
  prevPixels = null;
  }

  let settled = false;
  const extraJobs = [];
  const job = cls.runLocal({
    id: cls.id, tokenIds: [victim.id],
    options: { intensity: 1, camera: true, removeAfter: false, attackerId: attackerTok.id, preview: true }
  }).then(() => { settled = true; });

  const frames = [];          // per-frame metrics
  const anomalies = [];
  const dumpLines = [];
  const prev = new Map();     // id → previous frame metrics
  const born = new Map();     // id → spawn frame
  const deadFrames = new Map();
  let saved = 0;
  let doneAt = -1;
  let calmStreak = 0;         // consecutive frames with tiny pixel diff

  for (let f = 0; f < MAX_FRAMES; f++) {
    if (onFrame) {
      const ej = onFrame(f);
      if (ej?.then) { settled = false; extraJobs.push(ej); Promise.all([job, ...extraJobs]).then(() => { settled = true; }); }
    }
    // Runner ticker (+ catch exceptions so the frame loop keeps advancing)
    for (const fn of [...tickers]) {
      try { fn({ deltaMS: FRAME_MS }); }
      catch (e) { anomalies.push({ f, kind: 'ticker-throw', msg: String(e?.message ?? e) }); }
    }
    tickMeshAnim(FRAME_MS);
    tickCamera(FRAME_MS);
    globalThis.__seqTick?.(f);
    // Choreography continuation microtasks between frames
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    renderFrame(f);
    if (f % 2 === 0) {
      fs.writeFileSync(path.join(dir, `frame_${String(f).padStart(3, '0')}.png`), frameView.toBuffer('image/png'));
      saved++;
    }

    // Metrics
    const nodes = collectNodes(primary).map(nodeMetrics);
    let ink = 0, sx = 0, sy = 0, maxDP = 0, maxDA = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of nodes) {
      if (![m.x, m.y, m.w, m.h, m.a].every(Number.isFinite)) {
        anomalies.push({ f, kind: 'non-finite', id: m.id, vals: [m.x, m.y, m.w, m.h, m.a] });
        continue;
      }
      const area = Math.min(m.w * m.h, 400 * 400);
      ink += area * m.a;
      sx += m.x * area * m.a; sy += m.y * area * m.a;
      minX = Math.min(minX, m.x - m.w / 2); maxX = Math.max(maxX, m.x + m.w / 2);
      minY = Math.min(minY, m.y - m.h / 2); maxY = Math.max(maxY, m.y + m.h / 2);
      const p = prev.get(m.id);
      if (!born.has(m.id)) born.set(m.id, f);
      const age = f - born.get(m.id);
      if (p && age > 3) {
        const dPos = Math.hypot(m.x - p.x, m.y - p.y);
        const dRot = Math.abs(m.rot - p.rot) * Math.max(m.w, m.h, 80);
        const d = Math.max(dPos, dRot);
        maxDP = Math.max(maxDP, d);
        maxDA = Math.max(maxDA, Math.abs(m.a - p.a));
        // 90: the tail of an accelerating dashStrike lunge reached ~85px/frame
        // by design, not a snap; anything higher is suspicious
        if (dPos > 90 && (f - (deadFrames.get(m.id) ?? -99)) > 3) {
          anomalies.push({ f, kind: 'teleport', id: m.id, t: m.t, d: +d.toFixed(1), from: [p.x, p.y], to: [m.x, m.y], w: Math.round(m.w), h: Math.round(m.h), a: +m.a.toFixed(2) });
          deadFrames.set(m.id, f);
        }
        if (Math.abs(m.a - p.a) > 0.35 && m.w * m.h > 800) {
          anomalies.push({ f, kind: 'alpha-pop', id: m.id, t: m.t, from: +p.a.toFixed(2), to: +m.a.toFixed(2), w: Math.round(m.w), h: Math.round(m.h) });
        }
      }
      prev.set(m.id, m);
    }
    for (const k of [...prev.keys()]) if (!nodes.find(n => n.id === k)) prev.delete(k);

    // Pixel diff + freeze detection: driven by OBJECT motion (raster diff is
    // blind to sub-pixel tremor shifts), with raster as a secondary signal
    const rd = rasterDiff();
    if (!settled) {
      if (ink > 1500 && maxDP < 0.35 && maxDA < 0.01) {
        calmStreak++;
        if (calmStreak === 24) anomalies.push({ f, kind: 'freeze', frames: 24, ink: Math.round(ink), objDP: maxDP });
      } else calmStreak = 0;
      if (rd.mean > 30 && f > 5 && frames.length && frames[frames.length - 1].diff < 2.5 && ink > 3000) {
        anomalies.push({ f, kind: 'raster-pop', diff: rd.mean, prev: frames[frames.length - 1].diff });
      }
    }
    frames.push({
      f, cam: { s: +cam.scale.toFixed(3), x: +cam.pivot.x.toFixed(0), y: +cam.pivot.y.toFixed(0) },
      ink: Math.round(ink), n: nodes.length,
      diff: rd.mean, dfrac: rd.frac, mdp: +maxDP.toFixed(1), mda: +maxDA.toFixed(3),
      cx: ink > 0 ? Math.round(sx / ink) : null,
      cy: ink > 0 ? Math.round(sy / ink) : null,
      bbox: Number.isFinite(minX) ? [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)] : null
    });

    // Per-frame dump: every 4 frames log top-20 objects + 10×7 heatmap
    // (a "text snapshot" of the frame for staging audits)
    if (f % 4 === 0) {
      const GX = 10, GY = 7;
      const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
      for (const m of nodes) {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.w) || !Number.isFinite(m.h)) {
          // Non-finite node coordinates indicate a layout defect; skip heatmap binning
          anomalies.push({ f, kind: 'non-finite-node', id: m.id, t: m.t });
          continue;
        }
        const area = Math.min(m.w * m.h, 160000) * m.a;
        const gx = Math.min(GX - 1, Math.max(0, Math.floor(m.x / 200)));
        const gy = Math.min(GY - 1, Math.max(0, Math.floor(m.y / 200)));
        grid[gy][gx] += area;
      }
      const maxCell = Math.max(1, ...grid.flat());
      const gridStr = grid.map(row => row.map(v => v > 0 ? String(Math.max(1, Math.round(v / maxCell * 9))) : '.').join('')).join('|');
      const top = nodes
        .map(m => ({ m, c: Math.min(m.w * m.h, 160000) * m.a }))
        .sort((a, b) => b.c - a.c).slice(0, 20);
      dumpLines.push(
        `f${String(f).padStart(3, '0')} t=${(f / 60).toFixed(2)}s cam=${cam.scale.toFixed(2)}x ink=${Math.round(ink)} n=${nodes.length} diff=${rd.mean}` +
        (top.length ? '\n  obj ' + top.map(({ m }) =>
          `${m.id}(${m.t[1]}${m.w > 150 ? 'B' : m.w > 60 ? 'M' : 's'})z${m.z} x${Math.round(m.x)},y${Math.round(m.y)} ${Math.round(m.w)}x${Math.round(m.h)} a${m.a.toFixed(2)} t${(m.tint ?? 0xffffff).toString(16).padStart(6, '0')}`).join(' | ') : '') +
        `\n  map ${gridStr}`
      );
    }

    if (settled && !tickers.length && doneAt < 0) doneAt = f;
    if (doneAt >= 0 && f > doneAt + 50) break;
    if (doneAt < 0 && !tickers.length && !cam._tween && settled === false && f > 60 && !primary.children.length && !tickers.length) {
      // Nothing started — bail out
      break;
    }
  }

  await job.catch(() => {});
  // Drain trailing async continuations
  for (let i = 0; i < 60; i++) {
    for (const fn of [...tickers]) { try { fn({ deltaMS: FRAME_MS }); } catch { /* already logged */ } }
    tickCamera(FRAME_MS);
    await new Promise(r => setImmediate(r));
  }

  const aliveAtEnd = collectNodes(primary).filter(n => n.children.length || n.constructor !== RNode);
  fs.writeFileSync(path.join(dir, 'dump.txt'),
    '# legend: world 2000x1400 -> map grid 10x7 (cell 200px), victim bins x2-3/y2-3 (world 500-700/400-600), attacker x5-6/y2 (1000-1200); digits 1-9 = ink share in cell, . = empty; obj: id(type sizeclass B/M/s)z<zorder> x,y WxH a lpha thex\n' + dumpLines.join('\n'));
  // seq layer: garnish def spawn/rejection log + cyan frame line count
  fs.writeFileSync(path.join(dir, 'seqlog.json'), JSON.stringify({
    log: globalThis.__seqLog,
    cyanFrameLines: dumpLines.filter(l => l.includes('t00e5ff')).length
  }, null, 1));
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({
    id, frames: frames.length, doneAt, aliveAtEnd: aliveAtEnd.length, saved,
    aliveTypes: aliveAtEnd.map(n => `${n.name}:${n.constructor.name}:a${(n.alpha).toFixed(2)}`),
    anomalies: anomalies.slice(0, 400), series: frames
  }, null, 1));

  // Contact sheet: up to 56 thumbnails sampled every K frames
  const files = fs.readdirSync(dir).filter(x => x.startsWith('frame_')).sort();
  const K = Math.max(1, Math.ceil(files.length / 56));
  const picks = files.filter((_, i) => i % K === 0).slice(0, 56);
  const TW = 320, TH = 180, COLS = 8;
  const rows = Math.ceil(picks.length / COLS);
  const sheet = createCanvas(TW * COLS, TH * rows);
  const sg = sheet.getContext('2d');
  sg.fillStyle = '#000';
  sg.fillRect(0, 0, sheet.width, sheet.height);
  const { loadImage } = napiCanvas;
  for (let i = 0; i < picks.length; i++) {
    const img = await loadImage(fs.readFileSync(path.join(dir, picks[i])));
    const cx = (i % COLS) * TW, cy = Math.floor(i / COLS) * TH;
    sg.drawImage(img, 0, 0, img.width, img.height, cx, cy, TW, TH);
    sg.strokeStyle = '#333'; sg.strokeRect(cx + 0.5, cy + 0.5, TW - 1, TH - 1);
    sg.fillStyle = '#0ee'; sg.font = 'bold 13px monospace';
    sg.fillText(picks[i].replace('frame_', '').replace('.png', '') + ` ${(parseInt(picks[i].slice(6)) / 60).toFixed(1)}s`, cx + 5, cy + 15);
  }
  fs.writeFileSync(path.join(dir, 'sheet.png'), sheet.toBuffer('image/png'));

  const anomCount = anomalies.filter(a => a.kind !== 'non-finite' || true).length;
  console.log(`${(id + '').padEnd(14)} frames=${String(frames.length).padStart(3)} done@${String(doneAt).padStart(3)} saved=${String(saved).padStart(3)} anomalies=${anomalies.length} aliveEnd=${aliveAtEnd}${anomalies.length ? '  [' + [...new Set(anomalies.map(a => a.kind))].join(',') + ']' : ''}`);
  return { id, anomalies: anomalies.length, dir };
}

const results = [];
const variant = VARIANT;
if (variant === 'mirror') {
  // Mirrored token: capture flipU/flipV + sign preservation in ghost()/dashStrike
  const mirrorTok = makeToken('tokMirror', tokenCanvas, 1200, 600, { mirrorX: true });
  tokensById[mirrorTok.id] = mirrorTok;
  for (const fid of ['slashing', 'soul', 'smite']) {
    const cls = classes.find(c => c.id === fid + '-finisher');
    if (cls) results.push(await runOne(cls, mirrorTok, '-mirror'));
  }
} else if (variant === 'tiny' || variant === 'huge') {
  const size = variant === 'tiny' ? 80 : 250; // scaleK 0.8 / 2.5 — clamp bounds
  const edgeTok = makeToken('tokEdge', tokenCanvas, 1200, 600, { size });
  tokensById[edgeTok.id] = edgeTok;
  for (const fid of ['slashing']) {
    const cls = classes.find(c => c.id === fid + '-finisher');
    if (cls) results.push(await runOne(cls, edgeTok, '-' + variant));
  }
} else if (variant === 'concurrent') {
  // Two runners concurrently in one ticker loop: camera refcount, shared shake
  const vic2 = makeToken('tokV2', attackerCanvas, 800, 500);
  tokensById[vic2.id] = vic2;
  const c1 = classes.find(c => c.id === 'slashing-finisher');
  const c2 = classes.find(c => c.id === 'fire-finisher');
  const r1 = await runOne(c1, token, '-conc', false, (f) => {
    if (f === 24) {
      return c2.runLocal({
        id: c2.id, tokenIds: [vic2.id],
        options: { intensity: 1, camera: true, removeAfter: false, attackerId: attackerTok.id, preview: true }
      });
    }
    return null;
  });
  results.push(r1);
} else {
  for (const cls of classes) results.push(await runOne(cls));
}
const bad = results.filter(r => r.anomalies > 0);
console.log(`\n${results.length} rendered → ${outDir}`);
if (bad.length) console.log('anomaly finishers:', bad.map(b => `${b.id}:${b.anomalies}`).join(' '));
process.exit(0);
