/**
 * FinisherEngine — finisher playback engine.
 *
 * One FinisherRunner is created for each finisher invocation on every client.
 * The engine gives choreographers (`play(ctx)` methods of specific finishers)
 * a unified set of primitives living on a single ticker and dying together:
 *
 *   ctx.capture()      — slice the token into a sprite grid (the token is hidden)
 *   ctx.particles()    — recipe-driven particle system
 *   ctx.shockwave()    — expanding ring
 *   ctx.flash()/glow() — radial flash / soft glow
 *   ctx.beam()         — vertical pillar of light
 *   ctx.slash()        — swept strike trail
 *   ctx.bolts()        — lightning chains
 *   ctx.screenFlash()  — fullscreen flash (DOM)
 *   ctx.shake()        — camera shake (via pivot, compatible with animatePan)
 *   ctx.zoomCamera()   — brief camera zoom-in and return
 *   ctx.dashStrike()   — attacker lunge toward the victim with a strike
 *                        ("token 1 finishes token 2" interaction; requires attackerId)
 *   ctx.tween()/wait()/after() — tween engine on the shared clock
 *
 * Pixi calls follow the style of the rest of the module (lineStyle/moveTo/lineTo,
 * beginFill/drawCircle) and target PIXI v7: blendMode uses numeric values from
 * PIXI.BLEND_MODES (string values appeared in v8), sub-textures use
 * new PIXI.Texture(baseTexture, frame). Lifecycle is managed via CanvasEffect
 * from core/effect-manager: canvasTearDown stops active finishers.
 */

import { CanvasEffect } from '../../core/effect-manager.mjs';
import { buildCloneBody, upgradeCloneBody, tokenTextureScale, ringScaleCorrection, isRingToken } from '../../general/token-ring.mjs';
import { MODULE_ID } from '../../config.mjs';
import { Rng } from '../../blood/rng.mjs';

// v7: blendMode is numeric; string 'add' is kept as a fallback for v8,
// where the BLEND_MODES enum no longer exists.
const ADD_BLEND = (typeof PIXI !== 'undefined' && PIXI.BLEND_MODES)
  ? PIXI.BLEND_MODES.ADD
  : 'add';
const NORMAL_BLEND = (typeof PIXI !== 'undefined' && PIXI.BLEND_MODES)
  ? PIXI.BLEND_MODES.NORMAL
  : 'normal';

/* ---------------------------------- timings ---------------------------------- */

const _pow = Math.pow;

export const Ease = {
  linear: p => p,
  inQuad: p => p * p,
  outQuad: p => 1 - (1 - p) * (1 - p),
  inOutQuad: p => (p < 0.5 ? 2 * p * p : 1 - _pow(-2 * p + 2, 2) / 2),
  inCubic: p => p * p * p,
  outCubic: p => 1 - _pow(1 - p, 3),
  inOutCubic: p => (p < 0.5 ? 4 * p * p * p : 1 - _pow(-2 * p + 2, 3) / 2),
  inQuart: p => _pow(p, 4),
  outQuart: p => 1 - _pow(1 - p, 4),
  outQuint: p => 1 - _pow(1 - p, 5),
  inExpo: p => (p === 0 ? 0 : _pow(2, 10 * p - 10)),
  outExpo: p => (p === 1 ? 1 : 1 - _pow(2, -10 * p)),
  inOutSine: p => -(Math.cos(Math.PI * p) - 1) / 2,
  outBack: p => 1 + 2.2 * _pow(p - 1, 3) + 1.2 * _pow(p - 1, 2),
  outElastic: p => {
    if (p === 0 || p === 1) return p;
    return _pow(2, -9 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
  },
  outBounce: p => {
    const n = 7.5625, d = 2.75;
    if (p < 1 / d) return n * p * p;
    if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
    if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
    return n * (p -= 2.625 / d) * p + 0.984375;
  }
};

export function lerpColor(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/* ------------------------------ particle textures ------------------------------ */

const _texCache = new Map();

function _canvasTex(key, size, draw) {
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = PIXI.Texture.from(c);
  _texCache.set(key, tex);
  return tex;
}

/** Built-in particle shapes (white — color is applied via tint). */
export const ParticleTextures = {
  /** hard dot */
  dot: () => _canvasTex('dot', 32, (g, s) => {
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); g.fill();
  }),
  /** soft radial gradient (embers, glow, mist) */
  soft: () => _canvasTex('soft', 64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  }),
  /**wispy cloud (smoke) */
  smoke: () => _canvasTex('smoke', 96, (g, s) => {
    for (let i = 0; i < 5; i++) {
      const x = s / 2 + (Math.random() - 0.5) * s * 0.4;
      const y = s / 2 + (Math.random() - 0.5) * s * 0.4;
      const r = s * (0.2 + Math.random() * 0.18);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
    }
  }),
  /** elongated streak (sparks, droplets) — oriented vertically */
  streak: () => _canvasTex('streak', 64, (g, s) => {
    const grd = g.createLinearGradient(0, 0, 0, s);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(s / 2 - s * 0.06, 0, s * 0.12, s);
  }),
  /** polygon shard */
  shard: () => _canvasTex('shard', 40, (g, s) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(s / 2, 2);
    g.lineTo(s - 4, s - 5);
    g.lineTo(s / 2, s - 12);
    g.lineTo(4, s - 5);
    g.closePath(); g.fill();
  }),
  /** four-ray spark */
  spark: () => _canvasTex('spark', 48, (g, s) => {
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(s / 2, 3); g.lineTo(s / 2, s - 3);
    g.moveTo(3, s / 2); g.lineTo(s - 3, s / 2);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(s / 2, s / 2, 5, 0, Math.PI * 2); g.fill();
  }),
  /** square pixel (glitch) */
  pixel: () => _canvasTex('pixel', 16, (g, s) => {
    g.fillStyle = '#fff'; g.fillRect(2, 2, s - 4, s - 4);
  }),
  /** soft glowing ring (photon halo, accretion halo) */
  ring: () => _canvasTex('ring', 128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, s * 0.24, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grd.addColorStop(0.72, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.86, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  })
};

function _resolveTexture(tex) {
  if (!tex || typeof tex === 'string') return ParticleTextures[tex || 'soft']();
  return tex;
}

/** Sub-texture from a frame rectangle (PIXI v7: baseTexture + frame). */
function _tileTexture(base, frame) {
  const baseTexture = base?.baseTexture ?? base;
  return new PIXI.Texture(baseTexture, frame);
}

/** Light pillar texture (horizontal gradient), cached. */
let _beamTex = null;
function _beamTexture() {
  if (_beamTex) return _beamTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const g2 = c.getContext('2d');
  const grd = g2.createLinearGradient(0, 0, 64, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.5, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = grd; g2.fillRect(0, 0, 64, 16);
  _beamTex = PIXI.Texture.from(c);
  return _beamTex;
}

/* --------------------------------- particles --------------------------------- */

class ParticleSystem {
  declare runner; declare recipe; declare texture; declare blend; declare max; declare container; declare pool; declare live; declare running; declare emitUntil; declare _acc;
  constructor(runner, recipe) {
    this.runner = runner;
    this.recipe = recipe;
    this.texture = _resolveTexture(recipe.texture);
    this.blend = recipe.blend === 'normal' ? NORMAL_BLEND : ADD_BLEND;
    this.max = Math.max(2, Math.round((recipe.count ?? 120) * (runner.options.intensity ?? 1)));
    this.container = new PIXI.Container();
    runner.layer.addChild(this.container);

    this.pool = [];
    this.live = [];
    for (let i = 0; i < this.max; i++) {
      const s = new PIXI.Sprite(this.texture);
      s.anchor.set(0.5);
      s.visible = false;
      s.blendMode = this.blend;
      this.container.addChild(s);
      this.pool.push(s);
    }

    this.running = true;
    this.emitUntil = Number.isFinite(recipe.duration) ? runner.clock + recipe.duration : Infinity;
    this._acc = 0;
    runner._addSystem(this);
  }

  /** One-shot burst of n particles (spawn callback can be overridden per call). */
  burst(n = 10, spawn = null) {
    if (!this.running) return;
    const count = Math.max(1, Math.round(n * (this.runner.options.intensity ?? 1)));
    for (let i = 0; i < count; i++) this._spawn(spawn ?? this.recipe.spawn);
  }

  /** Stop emission; live particles finish fading out on their own. */
  stop() { this.running = false; this.emitUntil = 0; }

  _spawn(spawn) {
    const s = this.pool.pop();
    if (!s) return;
    const rec = this.recipe;
    // ALL spawn randomness runs through the runner's seeded stream (_rng): every client
    // gets identical particle lifetimes/sizes/angles/tints (Math.random remains only
    // in camera shake and smoke texture baking, which do not affect client sync)
    const rng = this.runner._rng;
    const p = {
      sprite: s,
      x: 0, y: 0, vx: 0, vy: 0,
      t: 0,
      life: rng.range(rec.life?.[0] ?? 600, rec.life?.[1] ?? 1200),
      size: rng.range(rec.size?.[0] ?? 4, rec.size?.[1] ?? 8),
      shrink: rec.shrink ?? 0,
      alpha: rng.range(rec.alpha?.[0] ?? 0.9, rec.alpha?.[1] ?? rec.alpha?.[0] ?? 0.9),
      fadeIn: rec.fadeIn ?? 0.1,
      fadeOut: rec.fadeOut ?? 0.5,
      rot: rec.rot ? rng.range(rec.rot[0], rec.rot[1])
        // smoke without explicit rot — identical blob copies in the same orientation
        // twinned visibly during slow drift: randomize a full turn
        : (rec.texture === 'smoke' ? rng.angle() : 0),
      spin: rng.range(rec.spin?.[0] ?? 0, rec.spin?.[1] ?? 0),
      gravity: rec.gravity ?? 0,
      drag: rec.drag ?? 0,
      phase: rng.angle(),
      tintFrom: null, tintTo: null
    };
    const tint = rec.tint;
    if (Array.isArray(tint)) s.tint = rec.tint[rng.int(tint.length)] ?? 0xffffff;
    else if (tint && typeof tint === 'object') {
      p.tintFrom = tint.from; p.tintTo = tint.to; s.tint = tint.from;
    } else if (typeof tint === 'number') s.tint = tint;

    s.rotation = p.rot;
    s.width = s.height = p.size;
    if (typeof spawn === 'function') {
      try { spawn(p, this.runner); } catch (e) { console.error('showstopper | particle spawn failed', e); }
    }
    // Position and visibility are set AFTER the spawn callback: previously visible=true
    // stood before positioning, so a recycled sprite rendered for one frame at the spot
    // where it DIED (droplet flashes at old positions on every pool cycle).
    // alpha=0 also clears any one-frame tail from the PREVIOUS life (up to 5%).
    s.position.set(p.x, p.y);
    s.alpha = 0;
    s.visible = true;
    this.live.push(p);
  }

  _update(dms) {
    // continuous rate-based emission
    if (this.running && this.runner.clock < this.emitUntil && this.recipe.rate) {
      this._acc += (this.recipe.rate * (this.runner.options.intensity ?? 1)) * dms / 1000;
      while (this._acc >= 1) {
        this._acc -= 1;
        this._spawn(this.recipe.spawn);
      }
    }

    const dt = dms / 1000;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dms;
      const k = p.t / p.life;
      if (k >= 1 || !p.sprite) {
        p.sprite.visible = false;
        if (p.sprite) this.pool.push(p.sprite);
        this.live.splice(i, 1);
        continue;
      }
      if (p.drag) {
        const f = Math.max(0, 1 - p.drag * dt);
        p.vx *= f; p.vy *= f;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (this.recipe.update) {
        try { this.recipe.update(p, dms, this.runner); } catch { /* custom physics must not crash the ticker */ }
      }
      const s = p.sprite;
      s.position.set(p.x, p.y);
      s.rotation = p.rot;
      const sz = Math.max(0.5, p.size * (1 - p.shrink * k));
      s.width = s.height = sz;
      // alpha curve: quick fadeIn, long fadeOut
      let a = p.alpha;
      if (k < p.fadeIn) a *= k / p.fadeIn;
      else if (k > 1 - p.fadeOut) a *= Math.max(0, (1 - k) / p.fadeOut);
      s.alpha = a;
      if (p.tintTo !== null && p.tintFrom !== null) s.tint = lerpColor(p.tintFrom, p.tintTo, k);
    }
  }

  _destroy() {
    this.running = false;
    this.container.destroy({ children: true });
  }

  get activeCount() { return this.live.length; }
}

/* ------------------------------- token capture ------------------------------- */

/**
 * SUBJECT bounds of a dynamic-ring token / art bounds of a standard token —
 * the rectangle sliced into capture tiles:
 *  - ring token: document footprint * textureScale (in core, the subject does
 *    not grow with grid-mode mesh enlargement and does NOT grow with ring scale
 *    correction — ring.subject.scale inflates/shrinks only the ring BAND);
 *  - standard token: actually rendered mesh — mesh.width/height (local sprite
 *    properties without camera transforms; getBounds() cannot be used here);
 *    fallback — bounds * |texture.scaleX/Y| (summon art often has bounds larger
 *    than the visible artwork due to transparent margins).
 */
export function _computeSubjectRect(token, baseGrid) {
  const center = token?.center ?? {
    x: (token?.x ?? 0) + baseGrid / 2,
    y: (token?.y ?? 0) + baseGrid / 2
  };
  if (isRingToken(token?.document)) {
    const ts = tokenTextureScale(token.document);
    const w = Math.max(1, Number(token.document.width) || 1) * baseGrid * ts;
    const h = Math.max(1, Number(token.document.height) || 1) * baseGrid * ts;
    return new PIXI.Rectangle(center.x - w / 2, center.y - h / 2, w, h);
  }
  let w = 0, h = 0;
  const mesh = token?.mesh;
  if (mesh) {
    w = Math.abs(Number(mesh.width) || 0);
    h = Math.abs(Number(mesh.height) || 0);
  }
  if (!w || !h) {
    const b = token?.bounds ?? { width: baseGrid, height: baseGrid };
    const tex = token?.document?.texture ?? {};
    w = b.width * Math.abs(Number(tex.scaleX) || 1);
    h = b.height * Math.abs(Number(tex.scaleY) || 1);
  }
  return new PIXI.Rectangle(center.x - w / 2, center.y - h / 2, w, h);
}

/**
 * VISIBLE body bounds — what effects scale against (scaleK/grid, zoom,
 * Sequencer garnishes). For a dynamic-ring token this is the subject EXPANDED
 * by the ring band when ring.subject.scale < 1: core samples ring UVs
 * * correction — the band is drawn across quad * 1/correction and EXTENDS past
 * the quad (core adds mesh.padding to fit it), making the ring the visible body
 * boundary. When correction >= 1, the ring sits INSIDE the quad and the subject
 * remains the boundary. Without this adjustment, animations on tokens with a
 * "shrunk" subject only multiplied by textureScale and looked half as large as
 * the visible body at correction = 0.5.
 */
export function _computeVisualBounds(token, baseGrid) {
  const rect = _computeSubjectRect(token, baseGrid);
  if (!isRingToken(token?.document)) return rect;
  const corr = ringScaleCorrection(token.document);
  if (corr >= 1) return rect;
  const w = rect.width / corr, h = rect.height / corr;
  return new PIXI.Rectangle(rect.x - (w - rect.width) / 2,
    rect.y - (h - rect.height) / 2, w, h);
}

/**
 * Sprite grid reproducing a token's visuals. The token is hidden for the duration
 * of the finisher while the grid lives in the runner's layer. Each tile knows its
 * "home" position and normalized texture coordinates (u/v) — handy for building
 * waves and diagonals. ghost() provides a full-size silhouette for flashes.
 */
class TokenCapture {
  declare runner; declare valid; declare token; declare tiles; declare container; declare cols; declare rows; declare rect; declare _mirroredBase; declare ringTile; declare center;
  constructor(runner, { cols = null, rows = null } = {}) {
    const token = runner.token;
    const mesh = token?.mesh;
    this.runner = runner;
    this.valid = false;
    this.token = token;
    this.tiles = [];

    // scene visibility: a token invisible to this client (vision/fog) is not
    // "killed" via a clone — surrounding effects still play, without revealing the body
    if (token.isVisible === false) return;
    if (!mesh?.texture) return;
    const base = mesh.texture;
    // Tiles are sliced across the ART bounds (subjectRect): for a ring token this is
    // the subject without ring-band expansion. The visible body boundary (for effect
    // scaling) is runner.visualRect; mesh.getBounds() cannot be used here (screen axes).
    const rect = runner.subjectRect;
    if (!rect) return;

    this._build(base, rect, cols, rows);

    this.container = new PIXI.Container();
    this.container.alpha = (token.document?.alpha ?? 1) * (mesh.alpha ?? 1);
    // Dynamic token ring — built with the same code as the drag preview
    // (shared module scripts/general/token-ring.mjs). The subject INSIDE the
    // ring body is disabled: the character body is drawn by the tiles (scattered
    // or dissolved by choreography). Otherwise a second copy of the character sits
    // beneath the tiles and "snaps back" once they scatter, leaving an untouched
    // duplicate token body throughout the animation.
    let ringTile = null;
    try {
      const ringBody = buildCloneBody(token.document, runner.baseGrid);
      if (ringBody) {
        ringBody.position.set(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (ringBody._subjectSprite) {
          ringBody._subjectSprite.renderable = false;
          ringBody._subjectSprite.visible = false;
        }
        this.container.addChild(ringBody);
        // size compatibility with tiles (see _makeRingTileSized)
        this._makeRingTileSized(ringBody);
        ringTile = {
          sprite: ringBody,
          hx: rect.x + rect.width / 2, hy: rect.y + rect.height / 2,
          col: 0, row: 0, u: 0.5, v: 0.5
        };
        // upgrade vector placeholder to the REAL world spritesheet art
        // (same as drag preview): frames load asynchronously, then we swap the body
        (async () => {
          try {
            const upgraded = await upgradeCloneBody(token.document, runner.baseGrid);
            if (!upgraded || runner._stopped) return;
            const parent = ringBody.parent;
            if (!parent || ringBody.destroyed || this.container?.destroyed) return;
            const idx = Math.max(0, parent.children.indexOf(ringBody));
            // The clone body lives in SCENE coordinates (the placeholder sits at
            // rect center rather than parent (0,0) like in drag preview where the
            // parent itself is positioned). Without copying position, the upgraded
            // body landed at scene (0,0) and the ring "disappeared".
            upgraded.position.set(ringBody.position.x, ringBody.position.y);
            const targetAlpha = ringBody.alpha;
            // swap crossfade: both bodies coexist for 150ms — placeholder fades out
            // while real art fades in (alpha sum ~ constant, zero flicker during
            // quiet phases); placeholder is destroyed in .then() once complete
            upgraded.alpha = 0;
            upgraded.rotation = ringBody.rotation;
            if (upgraded._subjectSprite) {
              upgraded._subjectSprite.renderable = false;
              upgraded._subjectSprite.visible = false;
            }
            // transfer scale RELATIVE to each body's "full" state: natural dimensions
            // of the placeholder and real art differ, so raw copyFrom would distort ring size
            this._makeRingTileSized(upgraded);
            const rel = ringBody.__ringUnits
              ? { x: ringBody.scale.x / ringBody.__ringUnits.full.sx, y: ringBody.scale.y / ringBody.__ringUnits.full.sy }
              : { x: 1, y: 1 };
            upgraded.scale.x = upgraded.__ringUnits.full.sx * rel.x;
            upgraded.scale.y = upgraded.__ringUnits.full.sy * rel.y;
            upgraded.tint = ringBody.tint;
            parent.addChildAt(upgraded, idx);
            if (ringTile) ringTile.sprite = upgraded;
            if (targetAlpha > 0) {
              let baseAlpha = targetAlpha;
              let lastUpAlpha = 0;
              this.runner.tween({ k: 0 }, { k: 1 }, {
                duration: 150, ease: Ease.outQuad,
                onUpdate: k => {
                  if (!upgraded.destroyed) {
                    if (Math.abs(upgraded.alpha - lastUpAlpha) > 1e-4) baseAlpha = upgraded.alpha;
                    lastUpAlpha = baseAlpha * k;
                    upgraded.alpha = lastUpAlpha;
                  }
                  if (!ringBody.destroyed) {
                    if (!upgraded.destroyed) {
                      ringBody.position.set(upgraded.position.x, upgraded.position.y);
                      ringBody.rotation = upgraded.rotation;
                    }
                    ringBody.alpha = baseAlpha * (1 - k);
                  }
                }
              }).then(() => {
                if (!upgraded.destroyed && Math.abs(upgraded.alpha - lastUpAlpha) <= 1e-4) {
                  upgraded.alpha = baseAlpha;
                }
                parent.removeChild(ringBody);
                try { ringBody.destroy({ children: true }); } catch { /* empty */ }
              });
            } else {
              parent.removeChild(ringBody);
              try { ringBody.destroy({ children: true }); } catch { /* empty */ }
            }
          } catch { /* keep vector placeholder */ }
        })();
      }
    } catch { /* ring is optional */ }
    for (const t of this.tiles) this.container.addChild(t.sprite);
    // The ring acts as a pseudo-tile: it participates in the finisher alongside
    // the body (flies, rotates, fades, shrinks TOGETHER with tiles — size writes
    // are translated by _makeRingTileSized), while sitting UNDER the body in the
    // container. this.ringTile is exposed for fine-tuning individual choreographies.
    if (ringTile) { ringTile.isRing = true; this.tiles.push(ringTile); this.ringTile = ringTile; }
    runner.layer.addChild(this.container);

    // the token itself is hidden by the runner (_hideTokenVisuals) independently of capture
    this.valid = true;
  }

  _build(base, rect, cols, rows) {
    const grid = this.runner.grid || 100;
    const c = cols ?? Math.min(16, Math.max(6, Math.round(rect.width / (grid * 0.16))));
    const r = rows ?? Math.min(16, Math.max(6, Math.round(rect.height / (grid * 0.16))));
    this.cols = c; this.rows = r;
    // token mirroring: PRE-MIRROR THE SOURCE once — reordering frames
    // (below, legacy fallback) flips only THEIR ORDER while pixels inside each
    // cell remain unflipped, reassembling a scrambled mosaic (a sword crossing
    // cell boundaries broke into offset pieces)
    const flipU = (this.token.document?.texture?.scaleX ?? 1) < 0;
    const flipV = (this.token.document?.texture?.scaleY ?? 1) < 0;
    let srcBase = base;
    let fx0 = base.frame?.x ?? 0;
    let fy0 = base.frame?.y ?? 0;
    let srcW = base.frame?.width ?? base.width;
    let srcH = base.frame?.height ?? base.height;
    if (flipU || flipV) {
      try {
        const src = base.baseTexture?.resource?.source;
        const iw = src?.width ?? src?.naturalWidth ?? 0;
        const ih = src?.height ?? src?.naturalHeight ?? 0;
        // do not mirror pre-generated bases (procedural textures) — they are
        // already aligned; mirror only full-frame image sources
        if (src && iw > 0 && ih > 0 && iw === srcW && ih === srcH) {
          const cv = document.createElement('canvas');
          cv.width = iw; cv.height = ih;
          const g = cv.getContext('2d');
          g.translate(flipU ? iw : 0, flipV ? ih : 0);
          g.scale(flipU ? -1 : 1, flipV ? -1 : 1);
          g.drawImage(src, 0, 0);
          const bt = new PIXI.BaseTexture(cv);
          srcBase = new PIXI.Texture(bt);
          this._mirroredBase = bt; // destroyed in capture.destroy() (runner dispose)
          fx0 = 0; fy0 = 0;
          srcW = iw; srcH = ih;
        }
      } catch { srcBase = base; /* no pixel access — legacy fallback */ }
    }
    const tw = rect.width / c, th = rect.height / r;

    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const u0 = col / c, v0 = row / r;
        // successful pre-mirroring: normal frame order from the mirrored source;
        // legacy fallback (no pixel access): reorder frames as before
        const mirrored = srcBase !== base;
        const fu = flipU && !mirrored ? 1 - u0 - 1 / c : u0;
        const fv = flipV && !mirrored ? 1 - v0 - 1 / r : v0;
        const rx = fx0 + Math.floor(fu * srcW);
        const ry = fy0 + Math.floor(fv * srcH);
        const rw = Math.max(1, Math.min(fx0 + srcW - rx, Math.ceil(srcW / c)));
        const rh = Math.max(1, Math.min(fy0 + srcH - ry, Math.ceil(srcH / r)));
        const frame = new PIXI.Rectangle(rx, ry, rw, rh);
        let tex;
        try { tex = _tileTexture(srcBase, frame); } catch { tex = srcBase; }
        const sprite = new PIXI.Sprite(tex);
        sprite.anchor.set(0.5);
        const hx = rect.x + (col + 0.5) * tw;
        const hy = rect.y + (row + 0.5) * th;
        sprite.position.set(hx, hy);
        const padX = c > 1 ? 1.2 : 0;
        const padY = r > 1 ? 1.2 : 0;
        sprite.width = tw + padX;
        sprite.height = th + padY;
        this.tiles.push({ sprite, hx, hy, col, row, u: u0 + 1 / (2 * c), v: v0 + 1 / (2 * r) });
      }
    }
    this.rect = rect;
    this.center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  eachTile(fn) { this.tiles.forEach(fn); }

  /** Release the pre-mirrored base texture (called by runner _dispose
      AFTER layer.destroy — child tile sprites are already destroyed by then). */
  destroy() {
    try { this._mirroredBase?.destroy(true); } catch { /* already destroyed */ }
    this._mirroredBase = null;
  }

  /**
   * Tile-compatible size properties for the ring body. Choreographies write
   * width/height on tiles in ABSOLUTE pixels of a single grid cell (baseW/baseH) —
   * writing that directly to a full-size ring collapsed it into a speck on the
   * very first slam. Own properties override PIXI accessors and translate writes
   * into proportions of the ring's "full" size: width = tileW means "full size",
   * 0.4 * tileH means "slam to 40%". Reads are symmetric with writes (unit = one
   * grid cell), so read-then-write patterns in choreographies work without
   * distortion. Direct scale.set() calls remain valid as well, multiplying each
   * body's natural size by the same factor.
   */
  _makeRingTileSized(body) {
    try {
      const full = { sx: body.scale.x || 1, sy: body.scale.y || 1 };
      const tileW = Math.max(1e-6, this.rect.width / this.cols);
      const tileH = Math.max(1e-6, this.rect.height / this.rows);
      body.__ringUnits = { tileW, tileH, full };
      Object.defineProperty(body, 'width', {
        configurable: true,
        get: () => tileW * (body.scale.x / full.sx),
        set: v => { body.scale.x = full.sx * (v / tileW); }
      });
      Object.defineProperty(body, 'height', {
        configurable: true,
        get: () => tileH * (body.scale.y / full.sy),
        set: v => { body.scale.y = full.sy * (v / tileH); }
      });
      // PIXI.Container has no own .tint — color lives on child Sprites/Graphics.
      // Proxy .tint reads/writes with per-channel multiplication against each
      // child's base tint so tweenTileTint and direct t.sprite.tint writes tint
      // the ring alongside body tiles.
      let curTint = 0xFFFFFF;
      for (const ch of body.children ?? []) {
        if (ch && ch.__baseTint === undefined) {
          ch.__baseTint = Number.isFinite(ch.tint) ? ch.tint : 0xFFFFFF;
        }
      }
      Object.defineProperty(body, 'tint', {
        configurable: true,
        get: () => curTint,
        set: v => {
          const c = Number.isFinite(v) ? (v & 0xFFFFFF) : 0xFFFFFF;
          curTint = c;
          const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
          for (const ch of body.children ?? []) {
            if (!ch || ch.destroyed) continue;
            const base = Number.isFinite(ch.__baseTint) ? ch.__baseTint : 0xFFFFFF;
            const br = Math.round(((base >> 16) & 255) * r / 255);
            const bg = Math.round(((base >> 8) & 255) * g / 255);
            const bb = Math.round((base & 255) * b / 255);
            ch.tint = (br << 16) | (bg << 8) | bb;
          }
        }
      });
    } catch { /* ring remains a plain container */ }
  }

  /** Tiles sorted by distance from a point (nearest first). */
  sortedByDistance(x, y) {
    return [...this.tiles].sort((a, b) =>
      Math.hypot(a.hx - x, a.hy - y) - Math.hypot(b.hx - x, b.hy - y));
  }

  /**
   * Full-size copy of the token (for a "silhouette flash"). tint sets color,
   * 0xffffff produces a white silhouette; blend 'add' makes it additive/glowing.
   */
  ghost({ tint = 0xffffff, alpha = 0.9, blend = 'add' } = {}) {
    const mesh = this.token?.mesh;
    if (!mesh?.texture || !this.rect) return null;
    const s = new PIXI.Sprite(mesh.texture);
    s.anchor.set(0.5);
    s.position.set(this.center.x, this.center.y);
    s.width = this.rect.width;
    s.height = this.rect.height;
    // mirrored art: capture tiles are flipped via flipU/flipV, whereas a sprite
    // without signed scale would face the wrong way relative to the mosaic body
    const td = this.token?.document?.texture ?? {};
    if ((td.scaleX ?? 1) < 0) s.scale.x = -Math.abs(s.scale.x);
    if ((td.scaleY ?? 1) < 0) s.scale.y = -Math.abs(s.scale.y);
    s.tint = tint;
    s.alpha = alpha;
    s.blendMode = blend === 'add' ? ADD_BLEND : NORMAL_BLEND;
    this.runner.layer.addChild(s);
    this.runner._addTransient(s);
    return s;
  }

  /** Average alpha across tiles — useful to check whether everything has dissolved. */
  get averageAlpha() {
    if (!this.tiles.length) return 0;
    let sum = 0;
    for (const t of this.tiles) sum += t.sprite.alpha;
    return sum / this.tiles.length;
  }
}

/* --------------------------------- runner --------------------------------- */

let _runnerSeq = 0;

/**
 * Hidden-token registry: token.id -> { parts, owners }. Only the FIRST owner
 * records the initial visibility state; overlapping runners (double-click,
 * preview on top of combat) merely attach. Otherwise the second runner would
 * record the ALREADY hidden state as the original, inverting the restore chain:
 * the token would reappear mid-animation and end up permanently hidden.
 * Visuals are restored once the LAST owner exits.
 */
const _hiddenTokens = new Map();

// Shared camera across concurrent runners: "cinema" depth saves the initial
// camera on 0->1 and restores on 1->0 (the last runner out restores the scene).
// See zoomCamera/_returnCamera.
let _cameraDepth = 0;
let _cameraSaved = null;
// One-time warnings for non-numeric `from` values in tweens (key: Class.prop).
const _tweenWarned = new Set();
// Reusable scratch array for _enforceHidden (runs every frame — zero allocations).
const _enforceScratch = [];

export class FinisherRunner {
  declare id; declare effectId; declare token; declare options; declare seed; declare _rng; declare _gmRng; declare baseGrid; declare visualRect; declare subjectRect; declare radius; declare scaleK; declare grid; declare fpSize; declare bounds; declare center; declare attacker; declare attackerCenter; declare dirFromAttacker; declare clock; declare _stopped; declare _disposed; declare _tweens; declare _timers; declare _systems; declare _transients; declare _tickerFns; declare _cleanups; declare _domNodes; declare _shake; declare _cameraSaved; declare _keepHidden; declare _hiddenTokensById; declare layer; declare uiLayer; declare fx; declare _tickFn; declare _cameraClaims; declare _captures;
  /** @param {{ effectId: string, token: object, options: object, seed?: number }} init */
  constructor({ effectId, token, options = {}, seed = null }: any) {
    this.id = `finisher-${effectId}-${++_runnerSeq}`;
    this.effectId = effectId;
    this.token = token;
    this.options = options;
    // CHOREOGRAPHY SEED: execute() mints it once and broadcasts it in the socket
    // payload so every client plays identical particle scatter/jitter/lifetimes
    // (ctx.rand/pick/chance and internal engine randomness all run through _rng).
    // Without an explicit seed (preview / direct API call), generate a local random seed.
    this.seed = Number.isFinite(seed) ? (seed >>> 0) : ((Math.random() * 0x100000000) >>> 0);
    this._rng = new Rng(this.seed);
    // Separate stream for GM-gated decal minting (ctx.gmRand):
    // the GM consumes EXTRA rolls from it (players skip those blocks), keeping
    // the shared _rng stream aligned across all clients.
    this._gmRng = new Rng((this.seed ^ 0x9e3779b9) >>> 0);
    const baseGrid = canvas.grid?.size ?? 100;
    this.baseGrid = baseGrid;
    this.visualRect = _computeVisualBounds(token, baseGrid);
    // ART bounds (subject without ring-band expansion) — capture tiles are sliced
    // from this rectangle: in core, correction < 1 inflates only the ring BAND while
    // the subject does not grow, so its mosaic must not stretch to the ring boundary
    this.subjectRect = _computeSubjectRect(token, baseGrid);
    const vmax = Math.max(this.visualRect.width, this.visualRect.height);
    this.radius = vmax / 2;
    // GARNISH scale (grid-based primitive and choreography dimensions — flashes,
    // shockwaves, slash lines, decals) derives from the GRID footprint: art zoom
    // (texture.scale) is DIVIDED OUT. In v14 art zoom is already baked into
    // visualRect: mesh.width includes textureScale (core PrimarySpriteMesh.resize
    // folds scale * scaleX into _width), and ring subjects multiply explicitly.
    // Without dividing it out, a token with scale 2 gets peripheral effects twice
    // as large as its grid space. BODY metrics (radius, capture, ghost) remain art-sized.
    const _ts = Math.max(0.01, tokenTextureScale(token.document) || 1);
    const fmax = vmax / _ts;
    // scale factor: all grid-based choreography dimensions (primitive defaults
    // and library geometry) scale proportionally with token size
    this.scaleK = Math.min(2.5, Math.max(0.8, fmax / baseGrid));
    this.grid = baseGrid * this.scaleK;
    // PURE footprint (grid cells) — dimensional base for GARNISH sizes in
    // choreographies (cut line, blood/frost decals): excludes art zoom and
    // ring band. cap.rect/subjectRect (art bounds) cannot be used here because
    // at texture.scale 2 they are twice the footprint size.
    this.fpSize = Math.max(
      Math.abs(Number(token.document?.width) || 1),
      Math.abs(Number(token.document?.height) || 1)
    ) * baseGrid;
    this.bounds = token.bounds ?? { x: 0, y: 0, width: this.grid, height: this.grid };
    this.center = token.center ?? {
      x: this.bounds.x + this.bounds.width / 2,
      y: this.bounds.y + this.bounds.height / 2
    };
    // attacker context for directional effects (resolved during execute() so it
    // matches across all clients; falls back to a seeded random direction)
    this.attacker = (options.attackerId ? canvas.tokens?.get?.(options.attackerId) : null) || null;
    if (this.attacker === token) this.attacker = null;
    this.attackerCenter = this.attacker?.center ?? null;
    if (this.attackerCenter) {
      const adx = this.center.x - this.attackerCenter.x;
      const ady = this.center.y - this.attackerCenter.y;
      const alen = Math.hypot(adx, ady) || 1;
      this.dirFromAttacker = { x: adx / alen, y: ady / alen };
    } else {
      const aa = this._rng.angle();
      this.dirFromAttacker = { x: Math.cos(aa), y: Math.sin(aa) };
    }

    this.clock = 0;
    this._stopped = false;
    this._disposed = false;
    this._tweens = new Set();
    this._timers = new Set();
    this._systems = new Set();
    this._transients = new Set();
    this._tickerFns = new Set();
    this._cleanups = [];
    this._domNodes = [];
    this._shake = null;
    this._cameraSaved = null;
    this._keepHidden = options.keepHidden === true;
    // tokens hidden by THIS runner (victim + attacker if lunging):
    // _hiddenTokens is the shared registry, while this per-runner map drives
    // per-frame enforcement and restoration in _dispose
    this._hiddenTokensById = new Map();

    this._hideTokenVisuals(token);

    this.layer = new PIXI.Container();
    this.layer.sortableChildren = true;
    this.layer.zIndex = 100000;
    // Render into canvas.primary — the group subject to the scene's LIGHTING
    // PIPELINE (just like real tokens). Putting the layer in canvas.stage sat
    // ABOVE lighting: explosions glowed in darkness and ignored scene lighting.
    // Intra-group sorting matches the drag preview (panel.mjs):
    // elevation -> sortLayer -> sort -> zIndex, so the layer never sinks under tokens.
    const elev = Number(token.document?.elevation);
    this.layer.elevation = Number.isFinite(elev) ? elev : 0;
    this.layer.sortLayer = foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS?.TOKENS ?? 700;
    this.layer.sort = Number.MAX_SAFE_INTEGER;
    const litGroup = canvas.primary ?? canvas.stage;
    try {
      litGroup.addChild(this.layer);
      litGroup.sortChildren?.();
    } catch {
      canvas.stage.addChild(this.layer);
    }

    // Unlit UI layer in scene coordinates (canvas.interface): fatality captions
    // neither dim to gray in dark scenes nor get occluded by aboveLighting
    // Sequencer videos, while still zooming and panning with the camera.
    this.uiLayer = new PIXI.Container();
    this.uiLayer.sortableChildren = true;
    this.uiLayer.zIndex = 100001;
    const uiGroup = (canvas as any)?.interface ?? canvas.stage ?? this.layer;
    try {
      uiGroup.addChild(this.uiLayer);
      uiGroup.sortChildren?.();
    } catch {
      this.layer.addChild(this.uiLayer);
    }

    this.fx = new CanvasEffect(this.id, {
      tokenId: token.id,
      onStop: () => this._halt()
    });
    this.fx.addDisposer(() => this._dispose());

    this._tickFn = (ticker) => this._tick(ticker);
    canvas.app.ticker.add(this._tickFn);
  }

  get stopped() { return this._stopped; }

  /* ------------------------------- utilities ------------------------------- */

  rand(a, b) { return this._rng.range(a, b); }
  pick(arr) { return this._rng.pick(arr); }
  chance(p) { return this._rng.chance(p); }
  /** RNG FOR GM-GATED BLOCKS (minting blood/frost decals): players skip those
   *  blocks, so using _rng on the GM would desynchronize the shared stream across
   *  clients. Uses an independent seeded stream — see constructor. */
  gmRand(a, b) { return this._gmRng.range(a, b); }

  /* ------------------------------- timings ------------------------------- */

  /** Delay bound to the runner's clock; resolves immediately when stopped. */
  wait(ms) {
    return new Promise<void>(resolve => {
      if (this._stopped) { resolve(); return; }
      this._timers.add({ due: this.clock + ms, resolve, done: false });
    });
  }

  after(ms, fn) { this.wait(ms).then(() => { if (!this._stopped) fn(); }); }

  /**
   * Tween numeric properties of an object (x/y/alpha/rotation/width...).
   * `tint` is interpolated as an RGB color. Returns a Promise that resolves on stop.
   */
  tween(target, props, {
    duration = 600, delay = 0, ease = Ease.outCubic, onUpdate = null, from = null
  } = {}) {
    return new Promise<void>(resolve => {
      if (this._stopped || !target) { resolve(); return; }
      // Build property tuples ONCE: calling Object.entries per frame allocated an
      // array + tuples every tick per tween — the main source of GC jitter during
      // peak tween counts (~265 active tweens between smite acts).
      const entries = Object.entries(props).map(([k, to]) => {
        const start = from?.[k] ?? (k === 'tint' ? target.tint : target[k]);
        if (!Number.isFinite(start)) {
          // A silent non-numeric `from` (missing property on target) would skip
          // writing the property for the entire tween; for `tint`, lerpColor(undefined)
          // also collapses color to black. Warn once per Class.prop.
          const wk = `${target?.constructor?.name ?? 'obj'}.${k}`;
          if (!_tweenWarned.has(wk)) {
            _tweenWarned.add(wk);
            console.warn(`showstopper | finisher tween: non-finite from for '${k}' — prop skipped`, target);
          }
        }
        return [k, { from: start, to }];
      });
      this._tweens.add({
        target, entries, duration, ease, onUpdate,
        start: this.clock + delay,
        resolve, fired: false
      });
    });
  }

  /**
   * Ring-safe tile tint tween. Targets the LIVE t.sprite re-read every frame:
   * asynchronous ring upgrade swaps the placeholder body (t.sprite is reassigned),
   * so a direct `ctx.tween(t.sprite, { tint })` would keep writing to the dead
   * object and leave the ring out of body color phases. `from` is refreshed if
   * the sprite changes, preserving the tile's initial tint semantics.
   */
  tweenTileTint(t, toColor, { duration = 400, delay = 0, ease = Ease.inQuad, from = null } = {}) {
    const st = { spr: t.sprite, from: from ?? t.sprite?.tint };
    return this.tween(st, {}, {
      duration, delay, ease,
      onUpdate: (k) => {
        if (t.sprite !== st.spr) { st.spr = t.sprite; st.from = from ?? t.sprite?.tint; }
        if (!Number.isFinite(st.from)) st.from = 0xFFFFFF;
        if (st.spr && !st.spr.destroyed) st.spr.tint = lerpColor(st.from, toColor, k);
      }
    });
  }

  /* ------------------------------ primitives ------------------------------ */

  /** Capture the token into a tile grid (the token stays hidden until the finisher ends). */
  capture(opts = {}) {
    if (this._stopped) return null;
    const cap = new TokenCapture(this, opts);
    if (cap.valid) (this._captures ??= []).push(cap);
    return cap.valid ? cap : null;
  }

  /** Recipe-driven particle system (see ParticleSystem). */
  particles(recipe) {
    if (this._stopped) return null;
    return new ParticleSystem(this, recipe);
  }

  /** Expanding shockwave ring. */
  shockwave({ x = this.center.x, y = this.center.y, r0 = this.grid * 0.2, r1 = this.grid * 3,
    duration = 700, color = 0xffffff, width = 4, alpha = 0.9, ease = Ease.outCubic, blend = 'add' }: any = {}) {
    if (this._stopped) return null;
    const g = new PIXI.Graphics();
    g.blendMode = blend === 'normal' ? NORMAL_BLEND : ADD_BLEND;
    this.layer.addChild(g);
    this._addTransient(g);
    const state = { r: r0, a: alpha, w: width };
    this.tween(state, { r: r1, a: 0 }, {
      duration, ease,
      onUpdate: () => {
        g.clear();
        // multi-pass stroke: soft halo beneath the main ring — a single stroke
        // read as a hairline vector circle (slash/bolts draw triple passes while
        // shockwave previously drew only one)
        g.lineStyle(state.w * 2.8, color, state.a * 0.28);
        g.drawCircle(x, y, state.r);
        g.lineStyle(state.w, color, state.a);
        g.drawCircle(x, y, state.r);
        if (blend !== 'normal') {
          g.lineStyle(Math.max(1, state.w * 0.36), 0xffffff, state.a * 0.72);
          g.drawCircle(x, y, state.r);
        }
      }
    }).then(() => this._removeTransient(g));
    return g;
  }

  /** Radial flash (additive). */
  flash({ x = this.center.x, y = this.center.y, radius = this.grid * 2.5, duration = 450,
    color = 0xffffff, peak = 0.95 } = {}) {
    if (this._stopped) return null;
    const s = new PIXI.Sprite(ParticleTextures.soft());
    s.anchor.set(0.5);
    s.blendMode = ADD_BLEND;
    s.tint = color;
    s.position.set(x, y);
    s.alpha = 0;
    this.layer.addChild(s);
    this._addTransient(s);
    const st = { r: radius * 0.4, a: 0 };
    this.tween(st, { r: radius, a: peak }, {
      duration: Math.max(40, duration * 0.25), ease: Ease.outQuad,
      onUpdate: () => { s.width = s.height = st.r * 2; s.alpha = st.a; }
    }).then(() => this.tween(st, { a: 0, r: radius * 1.25 }, {
      duration: Math.max(60, duration * 0.75), ease: Ease.outCubic,
      onUpdate: () => { s.width = s.height = st.r * 2; s.alpha = st.a; }
    })).then(() => this._removeTransient(s));
    return s;
  }

  /** Sustained soft glow (aura, fire). Fades out automatically, or smoothly via .stop(). */
  glow({ x = this.center.x, y = this.center.y, radius = this.grid * 2, duration = 1500,
    color = 0xffffff, alpha = 0.5, fadeIn = 250, fadeOut = 600, pulse = 0 } = {}) {
    if (this._stopped) return null;
    const s = new PIXI.Sprite(ParticleTextures.soft());
    s.anchor.set(0.5);
    s.blendMode = ADD_BLEND;
    s.tint = color;
    s.position.set(x, y);
    s.width = s.height = radius * 2;
    s.alpha = 0;
    this.layer.addChild(s);
    this._addTransient(s);
    const st = { a: 0 };
    let alive = true;
    const stop = () => {
      if (!alive) return;
      alive = false;
      // smooth fade-out rather than abruptly freezing at current alpha
      this.tween(st, { a: 0 }, {
        duration: fadeOut, ease: Ease.outCubic,
        onUpdate: () => { s.alpha = st.a; }
      }).then(() => this._removeTransient(s));
    };
    (async () => {
      await this.tween(st, { a: alpha }, { duration: fadeIn, ease: Ease.outQuad,
        onUpdate: () => { s.alpha = st.a; } });
      if (!alive || this._stopped) return;
      s.alpha = st.a;
      if (pulse > 0) {
        const t0 = this.clock;
        while (alive && !this._stopped && this.clock - t0 < duration) {
          s.alpha = st.a * (1 + Math.sin(this.clock / 90) * pulse);
          await this.wait(50);
        }
      } else {
        await this.wait(Math.max(0, duration - fadeIn - fadeOut));
      }
      if (!alive || this._stopped) return;
      await this.tween(st, { a: 0 }, { duration: fadeOut, ease: Ease.outCubic,
        onUpdate: () => { s.alpha = st.a; } });
      this._removeTransient(s);
    })();
    return { sprite: s, stop };
  }

  /** Vertical pillar of light descending onto a point. */
  beam({ x = this.center.x, y = this.center.y, width = null, height = null, duration = 1400,
    color = 0xffffff, alpha = 0.85, fadeIn = 200, fadeOut = 500 } = {}) {
    if (this._stopped) return null;
    const w = width ?? this.grid * 1.6;
    const h = height ?? this.grid * 10;
    const s = new PIXI.Sprite(_beamTexture());
    s.anchor.set(0.5, 1);
    s.blendMode = ADD_BLEND;
    s.tint = color;
    s.position.set(x, y);
    s.width = w;
    s.height = h;
    s.alpha = 0;
    this.layer.addChild(s);
    this._addTransient(s);
    const st = { a: 0, w };
    (async () => {
      await this.tween(st, { a: alpha, w: w * 1.15 }, { duration: fadeIn, ease: Ease.outQuad,
        onUpdate: () => { s.alpha = st.a; s.width = st.w; } });
      await this.wait(Math.max(0, duration - fadeIn - fadeOut));
      await this.tween(st, { a: 0, w: w * 0.6 }, { duration: fadeOut, ease: Ease.inOutQuad,
        onUpdate: () => { s.alpha = st.a; s.width = st.w; } });
      this._removeTransient(s);
    })();
    return s;
  }

  /** Swept strike trail (crescent blade with tapered tips and a fading tail). */
  slash({ from, to, duration = 260, color = 0xffffff, width = 8, curvature = 0.25, blend = 'add' }: any = {}) {
    if (this._stopped) return null;
    const g = new PIXI.Graphics();
    g.blendMode = blend === 'normal' ? NORMAL_BLEND : ADD_BLEND;
    g.zIndex = 20;
    this.layer.addChild(g);
    this._addTransient(g);
    // quadratic Bezier sample points + normals for the crescent contour
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (from.x + to.x) / 2 - dy / len * curvature * len;
    const cy = (from.y + to.y) / 2 + dx / len * curvature * len;
    const pts = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const it = 1 - t;
      const x = it * it * from.x + 2 * it * t * cx + t * t * to.x;
      const y = it * it * from.y + 2 * it * t * cy + t * t * to.y;
      const tx = 2 * it * (cx - from.x) + 2 * t * (to.x - cx);
      const ty = 2 * it * (cy - from.y) + 2 * t * (to.y - cy);
      const tl = Math.hypot(tx, ty) || 1;
      pts.push({ x, y, nx: -ty / tl, ny: tx / tl });
    }
    const totalMs = Math.max(120, duration + 180);
    const state = { p: 0 };
    this.tween(state, { p: 1 }, {
      duration: totalMs, ease: Ease.linear,
      onUpdate: () => {
        if (g.destroyed) return;
        g.clear();
        const head = Ease.outCubic(Math.min(1, state.p / 0.56));
        const tail = state.p < 0.26 ? 0 : Ease.inQuad((state.p - 0.26) / 0.74);
        const i0 = Math.max(0, Math.min(N - 1, Math.floor(tail * N)));
        const i1 = Math.max(i0 + 1, Math.min(N, Math.ceil(head * N)));
        const span = Math.max(1, i1 - i0);
        const fade = state.p > 0.68 ? Math.max(0, 1 - (state.p - 0.68) / 0.32) : 1;
        if (fade <= 0.01) return;
        const drawBlade = (halfW, col, alpha) => {
          const poly = [];
          for (let i = i0; i <= i1; i++) {
            const u = (i - i0) / span;
            // Taper to 0 at tip and tail + bell-shaped width profile along the arc
            const profile = Math.pow(Math.sin(u * Math.PI), 0.75) * halfW;
            poly.push(pts[i].x + pts[i].nx * profile, pts[i].y + pts[i].ny * profile);
          }
          for (let i = i1 - 1; i > i0; i--) {
            const u = (i - i0) / span;
            const profile = Math.pow(Math.sin(u * Math.PI), 0.75) * halfW;
            poly.push(pts[i].x - pts[i].nx * profile, pts[i].y - pts[i].ny * profile);
          }
          g.lineStyle(0);
          g.beginFill(col, alpha * fade);
          g.drawPolygon(poly);
          g.endFill();
        };
        drawBlade(width * 1.45, color, 0.34);
        drawBlade(width * 0.72, color, 0.82);
        drawBlade(Math.max(1.2, width * 0.28), 0xffffff, 0.96);
      }
    }).then(() => this._removeTransient(g));
    return g;
  }

  /**
   * Lightning chain: `count` strikes spaced by `interval` between `from` and `to`.
   * Redrawn every tick for live flickering rather than a static bolt.
   */
  bolts({ from, to, count = 3, interval = 170, life = 150,
    color = 0xd8ecff, glowColor = 0x6f8fff, width = 2.5, jag = 0.3, blend = 'add' }: any = {}) {
    if (this._stopped) return null;
    const g = new PIXI.Graphics();
    g.blendMode = blend === 'normal' ? NORMAL_BLEND : ADD_BLEND;
    g.zIndex = 20;
    this.layer.addChild(g);
    this._addTransient(g);
    const strikes = [];
    // bolt lifetime is measured in REAL ms (dms from the ticker): fixed +16/frame
    // at 144 Hz burned through `life` 2-2.4x too fast (necrotic veins,
    // fallback bolts without JB2A)
    const redraw = (dms = 16) => {
      if (this._stopped || g.destroyed) return;
      g.clear();
      for (const s of strikes) {
        s.t += Math.min(dms, 50);
        if (s.t > life) continue;
        const k = 1 - s.t / life;
        const pts = [];
        const N = 12;
        for (let j = 0; j <= N; j++) {
          const t = j / N;
          const wob = Math.sin(t * Math.PI) * jag * this.grid;
          pts.push({
            x: from.x + (to.x - from.x) * t + Math.sin(s.seed + j * 2.7) * wob,
            y: from.y + (to.y - from.y) * t + Math.cos(s.seed * 1.3 + j * 1.9) * wob
          });
        }
        const draw = (w, col, a) => {
          g.lineStyle(w, col, a * k);
          g.moveTo(pts[0].x, pts[0].y);
          for (let j = 1; j < pts.length; j++) g.lineTo(pts[j].x, pts[j].y);
        };
        draw(width * 5, glowColor, 0.16);
        draw(width * 2, glowColor, 0.5);
        draw(width * 0.9, color, 0.9);
        draw(width * 0.35, 0xffffff, 0.95);
      }
    };
    // keep redraw on the ticker strictly until the bolts finish: unregister it
    // BEFORE destroying the Graphics — SmoothGraphics.destroy() (PIXI.Graphics in
    // Foundry v14) nulls geometry, so calling g.clear() afterward crashes the ticker
    const wrapped = this._addTickerFn(redraw);
    (async () => {
      for (let i = 0; i < count; i++) {
        if (this._stopped) break;
        strikes.push({ t: 0, seed: this._rng.next() * 1000 });
        await this.wait(interval);
      }
      await this.wait(life + 120);
      this._removeTickerFn(wrapped);
      this._removeTransient(g);
    })();
    return g;
  }

  /**
   * "Fatality" caption above the token (CLEAVED / INCINERATED / ...). Without an
   * explicit `text`, looks up `finisher.<id>.caption` in i18n; skips rendering if
   * no key exists. Disabled unless `enabled === true` is passed explicitly.
   */
  caption({ text = null, color = '#ffffff', size = null, dy = null, duration = 1550, delay = 0, enabled = false }: any = {}) {
    if (this._stopped || enabled !== true) return null;
    let str = text;
    if (!str) {
      const key = `${MODULE_ID}.cut-ins.finisher.${this.effectId.replace(/-finisher$/, '')}.caption`;
      str = game.i18n?.localize?.(key) ?? '';
      if (!str || str === key) return null;
    }
    const fontSize = Math.max(26, Math.round(size ?? this.grid * 0.44));
    const wrap = new PIXI.Container();
    wrap.x = this.center.x;
    wrap.y = dy != null ? this.center.y + dy : this.center.y - this.radius * 1.32;
    wrap.alpha = 0;
    wrap.scale.set(0.72);
    wrap.zIndex = 100001;

    // soft dark backdrop behind the text — guarantees legibility over both
    // blinding white explosions and dark dungeon floor textures
    const back = new PIXI.Sprite(ParticleTextures.soft());
    back.anchor.set(0.5);
    back.tint = 0x06040a;
    back.alpha = 0.52;

    const t = new PIXI.Text(String(str).toUpperCase(), {
      fontFamily: '"Modesto Condensed", "Palatino Linotype", "Book Antiqua", Georgia, serif',
      fontSize,
      fontWeight: '700',
      fill: color,
      stroke: '#0a070d',
      strokeThickness: Math.max(4, Math.round(fontSize * 0.14)),
      dropShadow: true,
      dropShadowColor: color,
      dropShadowBlur: Math.max(6, Math.round(fontSize * 0.26)),
      dropShadowDistance: 0,
      dropShadowAlpha: 0.55,
      letterSpacing: Math.max(2, Math.round(fontSize * 0.08)),
      padding: Math.max(8, Math.round(fontSize * 0.3)),
      align: 'center'
    });
    t.anchor.set(0.5);
    back.width = Math.max(fontSize * 4.5, (t.width || fontSize * 4) * 1.28);
    back.height = Math.max(fontSize * 1.5, (t.height || fontSize) * 1.35);

    wrap.addChild(back);
    wrap.addChild(t);
    (this.uiLayer ?? this.layer).addChild(wrap);
    this._addTransient(wrap);

    // `duration` is the TOTAL caption display time (entry + hold + fade-out),
    // ensuring choreographies awaiting `ctx.wait(delay + duration)` never clip the fade
    const totalDur = Math.max(520, duration);
    const entryMs = Math.min(280, Math.round(totalDur * 0.22));
    const exitMs = Math.min(420, Math.round(totalDur * 0.3));
    const holdMs = Math.max(0, totalDur - entryMs - exitMs);
    (async () => {
      await this.wait(delay);
      if (this._stopped || wrap.destroyed) return;
      const st = { s: 0.72, a: 0 };
      const y0 = wrap.y;
      await this.tween(st, { s: 1, a: 1 }, {
        duration: entryMs, ease: Ease.outBack,
        onUpdate: () => { if (!wrap.destroyed) { wrap.scale.set(st.s); wrap.alpha = st.a; } }
      });
      if (this._stopped || wrap.destroyed) return;
      if (holdMs > 0) {
        await this.tween({ k: 0 }, { k: 1 }, {
          duration: holdMs, ease: Ease.linear,
          onUpdate: k => { if (!wrap.destroyed) wrap.y = y0 - 8 * k; }
        });
      }
      if (this._stopped || wrap.destroyed) return;
      const y1 = wrap.y;
      await this.tween({ k: 0 }, { k: 1 }, {
        duration: exitMs, ease: Ease.inCubic,
        onUpdate: k => {
          if (!wrap.destroyed) {
            wrap.alpha = 1 - k;
            wrap.scale.set(1 + 0.06 * k);
            wrap.y = y1 - 16 * k;
          }
        }
      });
      this._removeTransient(wrap);
    })();
    return wrap;
  }

  /** Fullscreen flash (DOM overlay above the canvas, below UI chrome). */
  screenFlash({ color = '#ffffff', duration = 320, peak = 0.55 } = {}) {
    if (this._stopped) return null;
    const div = document.createElement('div');
    div.className = 'ss-finisher-screenflash';
    div.style.background = color;
    const attackMs = Math.min(45, Math.max(16, Math.round(duration * 0.14)));
    const fadeMs = Math.max(120, duration - attackMs);
    div.style.transition = `opacity ${attackMs}ms ease-out`;
    div.style.opacity = '0';
    document.body.appendChild(div);
    this._domNodes.push(div);
    requestAnimationFrame(() => {
      if (!this._stopped) div.style.opacity = String(peak);
    });
    this.after(attackMs + 20, () => {
      div.style.transition = `opacity ${fadeMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      div.style.opacity = '0';
    });
    this.after(attackMs + fadeMs + 90, () => this._removeDom(div));
    return div;
  }

  /** Camera shake via stage pivot (does not conflict with concurrent animatePan). */
  shake({ duration = 500, strength = 14 } = {}) {
    if (this._stopped) return;
    // clear any PREVIOUS shake offset before replacing the slot: the new shake
    // starts with its own lastX/lastY = 0, so an uncompensated remainder from the
    // old shake would stay baked into pivot until the next pan
    if (this._shake) this._applyShakeOffset(0, 0);
    const sh = { t: 0, duration, strength, lastX: 0, lastY: 0, until: this.clock + duration };
    this._shake = sh;
    this.after(duration + 60, () => {
      // A superseded shake's cleanup must not cancel the active one: the slot may
      // have been overwritten by a newer shake (dashStrike <-> first choreography
      // shake overlap, thunder waves, singularity rumble <-> blast). The stale
      // timer would otherwise kill a live shake mid-flight and leave a stuck pivot offset.
      if (this._shake !== sh) return;
      this._applyShakeOffset(0, 0);
      this._shake = null;
    });
  }

  _applyShakeOffset(x, y) {
    const stage = canvas?.stage;
    const sh = this._shake;
    if (!stage?.pivot || !sh) return;
    stage.pivot.x += x - sh.lastX;
    stage.pivot.y += y - sh.lastY;
    sh.lastX = x; sh.lastY = y;
  }

  /** Zoom camera onto the token and return. Respects options.camera === false. */
  async zoomCamera({ scale = 1.7, ms = 600, holdMs = 0, returnMs = 800 } = {}) {
    if (this.options.camera === false || this._stopped) return;
    const stage = canvas?.stage;
    if (!stage) return;
    // Camera is a shared resource across concurrent runners (multiple tokens
    // animating at once): save the origin only on depth 0->1. A per-runner slot
    // during overlap would capture the ALREADY zoomed camera of the second zoom
    // and return the scene "into the first zoom".
    // Only record saved state when NONE exists: during another runner's return
    // window (depth already 0 while pan is still moving and `saved` is alive),
    // a new claimant must inherit the PRE-zoom origin — snapshotting the mid-pan
    // pivot would park its own return halfway through the pull-back.
    if (!_cameraSaved) _cameraSaved = { x: stage.pivot.x, y: stage.pivot.y, s: stage.scale.x };
    _cameraDepth++;
    // count claims PER RUNNER: a boolean latch broke blackhole's double zoom
    // (the FIRST zoom's tail found the flag cleared by the second and silently
    // skipped its decrement — leaving depth stuck at 1 for the rest of the session)
    this._cameraClaims = (this._cameraClaims ?? 0) + 1;
    const target = Math.max(_cameraSaved.s, scale);
    // Choreographies often call zoomCamera() without await — animatePan rejections
    // must be swallowed on entry as well (matching the tail and _dispose).
    await canvas.animatePan({ x: this.center.x, y: this.center.y, scale: target, duration: ms }).catch(() => {});
    if (holdMs) await this.wait(holdMs);
    // Climax shake must not be wiped out by the return pan: animatePan writes
    // pivot every frame AFTER our ticker and erases shake deltas. Wait out any
    // active shake (up to a cap) before pulling back.
    if (this._shake) {
      const remain = Math.min(800, Math.max(0, this._shake.until - this.clock));
      if (remain > 0) await this.wait(remain);
    }
    // A forced stop may have already released the claim (_dispose returned the
    // camera along the halted path and zeroed the counter) — without checking,
    // the tail would decrement depth TWICE: pulling the camera away mid-climax
    // of a concurrent runner and causing a third claimant to snapshot the moving camera.
    if (this._cameraClaims > 0) {
      this._cameraClaims--;
      // swallow animatePan rejection here too (as in _dispose): choreographies
      // may invoke zoomCamera() without await, so an unguarded tail caused unhandled rejections
      await this._returnCamera(returnMs).catch(() => {});
    }
  }

  async _returnCamera(ms = 800) {
    _cameraDepth = Math.max(0, _cameraDepth - 1);
    if (_cameraDepth > 0) return; // another zoom is still active — its return will restore the scene
    const saved = _cameraSaved;
    // `_stopped` is NOT a reason to skip camera return here: besides canvasTearDown,
    // it is set by the watchdog (>25s hung choreography) and stopForToken from a
    // parallel mesh-reset — in those cases the scene is still alive and the zoom
    // would stay stuck forever. Skip return only when the canvas itself is gone.
    // Clear `saved` AFTER the pan finishes: while the return pan is in flight
    // (depth already 0), any new claimant reuses `saved` as the true origin
    // instead of snapshotting an intermediate pan position.
    try {
      if (!saved || !canvas?.stage) return;
      await canvas.animatePan({ x: saved.x, y: saved.y, scale: saved.s, duration: ms });
    } finally {
      if (_cameraDepth === 0 && _cameraSaved === saved) _cameraSaved = null;
    }
  }

  /**
   * Universal "finisher lunge" — the attack beat for choreographies.
   * The attacker moves via the EXACT SAME CODE as a normal attack animation —
   * mesh-animator (showstopper.meshAnim.animate: real mesh, per-token queue,
   * ticking on canvas.ticker): wind-up backward -> lunge to the victim's edge ->
   * impact (flash + shake at the contact point) -> return home. No ghost sprite
   * or hiding: the actual token stays visible and moves just like during an attack.
   *
   * Movement is LOCAL (meshAnim.animate with `local: true`): the finisher is
   * already broadcast to all clients (showFinisher:<id> -> runLocal on each), so
   * every client animates its own mesh — the animator's raw broadcast would stack
   * the same displacement N times.
   *
   * Resolves at the moment of IMPACT (plus a brief hit-stop) so the choreography's
   * kill beat starts right after `await`. The return home runs without `await`
   * (the kill beat is already playing while the animator eases back); dispose
   * cleanup guarantees `reset(0)` so an interrupted lunge never leaves the token
   * displaced. Returns `false` when there is no attacker (no selected token outside
   * targets) so the choreography can play a fallback pause.
   *
   * @param {{ms?: number, duration?: number, color?: number, strength?: number}} opts
   * @returns {Promise<boolean>} whether the lunge was played
   */
  async dashStrike({ ms = null, duration = null, color = 0xffffff, strength = 8 }: any = {}) {
    const atk = this.attacker;
    if (!atk || this._stopped || !this.attackerCenter) return false;
    const mesh = globalThis.showstopper?.meshAnim;
    const d = this.dirFromAttacker;
    // strike standoff distance (`stand`) — measured from the victim's VISIBLE body boundary (`this.radius`)
    const rect = _computeSubjectRect(atk, this.baseGrid);
    const ar = Math.max(rect.width, rect.height) / 2;
    const from = { x: this.attackerCenter.x, y: this.attackerCenter.y };
    const stand = this.radius + ar * 0.25; // strike standoff distance from the victim's center
    const to = { x: this.center.x - d.x * stand, y: this.center.y - d.y * stand };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const dashMs = ms ?? duration ?? Math.max(200, Math.min(400, 120 + dist * 0.08));

    // Kinematic lunge wake in the finisher layer: visually bridges the attacker's
    // wind-up and thrust to the victim even across long distances
    const wake = new PIXI.Sprite(ParticleTextures.streak());
    wake.anchor.set(0.5);
    wake.blendMode = ADD_BLEND;
    wake.tint = color;
    wake.rotation = Math.atan2(d.y, d.x) + Math.PI / 2;
    wake.width = this.grid * 0.18;
    wake.height = this.grid * 0.55;
    wake.position.set(from.x, from.y);
    wake.alpha = 0;
    this.layer.addChild(wake);
    this._addTransient(wake);
    this.tween({ k: 0 }, { k: 1 }, {
      duration: 120 + dashMs, ease: Ease.inQuad,
      onUpdate: k => {
        if (wake.destroyed) return;
        const wPhase = k < 0.25 ? -(k / 0.25) * 0.12 : (k - 0.25) / 0.75;
        wake.x = from.x + (to.x - from.x) * Math.max(0, wPhase);
        wake.y = from.y + (to.y - from.y) * Math.max(0, wPhase);
        wake.height = this.grid * (0.45 + Math.max(0, wPhase) * 1.1);
        wake.alpha = Math.sin(k * Math.PI) * 0.55;
      }
    }).then(() => this._removeTransient(wake));

    if (!mesh) {
      // mesh-animator unavailable (submodule not loaded) — wait out wind-up + lunge
      // timing and still play the contact flash/shake below
      await this.wait(120 + dashMs);
      if (this._stopped) return true;
    } else {
      // an interrupted lunge must not leave the token offset: dispose runs an
      // instant reset (a no-op on the normal path where the token is already home)
      this._addCleanup(() => { try { mesh.reset(atk, 0, { local: true }).catch(() => {}); } catch { /* empty */ } });

      const local = { local: true };

      // wind-up away from the victim — matching the wind-up in HIT_VARIANTS of normal attacks.
      // IMPORTANT: mesh-animator `props` are a delta ADDED over the animation duration
      // (not an absolute target from home): wind-up shifts by -0.18 grid, so the lunge
      // COMPENSATES for it to reach a net displacement of exactly (to - from)
      await mesh.animate(atk, { x: -d.x * this.grid * 0.18, y: -d.y * this.grid * 0.18 },
        { duration: 120, easing: "easeOut", ...local });
      if (this._stopped) return true;

      // accelerating lunge to the edge of the victim's visible body
      await mesh.animate(atk, { x: to.x - from.x + d.x * this.grid * 0.18, y: to.y - from.y + d.y * this.grid * 0.18 },
        { duration: dashMs, easing: "easeIn", ...local });
      if (this._stopped) return true;
    }

    // impact: contact point at the victim's edge; choreography kill beat follows right after
    const strike = { x: to.x + d.x * stand * 0.45, y: to.y + d.y * stand * 0.45 };
    this.flash({ x: strike.x, y: strike.y, radius: this.grid * 0.9, duration: 200, color, peak: 0.7 });
    this.shake({ duration: 180, strength });
    // brief hit-jolt on the victim: snaps strictly back home at the end of 140ms
    const caps = this._captures ?? [];
    if (caps.length) {
      const joltAmp = this.grid * 0.04;
      await this.tween({ k: 0 }, { k: 1 }, {
        duration: 140, ease: Ease.outQuad,
        onUpdate: k => {
          const s = Math.sin(k * Math.PI) * joltAmp;
          for (const c of caps) {
            for (const t of c.tiles) {
              if (!t.sprite || t.sprite.destroyed) continue;
              t.sprite.x = t.hx + d.x * s;
              t.sprite.y = t.hy + d.y * s;
            }
          }
        }
      });
      for (const c of caps) {
        for (const t of c.tiles) {
          if (!t.sprite || t.sprite.destroyed) continue;
          t.sprite.x = t.hx;
          t.sprite.y = t.hy;
        }
      }
    } else {
      await this.wait(140);
    }
    if (this._stopped) return true;

    // return home — SAME AS NORMAL ATTACKS (attack.mjs: mesh.reset(token, 400)):
    // reset smoothly eases the mesh's ACCUMULATED offset back to zero. Calling
    // animate({x:0,y:0}) here would be a no-op because animator props are a delta
    // OVER the animation duration, leaving the token stranded beside the victim.
    // Unawaited: the kill beat is already playing while the animator queue finishes
    mesh?.reset(atk, 260, { local: true }).catch(() => {});
    return true;
  }

  /* --------------------------------- loop --------------------------------- */

  /**
   * Run choreography: `await fn(this)`; fade out any remaining static token rings;
   * wait for lingering particles to burn out (up to 2.5s); and complete the CanvasEffect.
   */
  async run(fn) {
    const watchdog = setTimeout(() => {
      console.warn(`showstopper | Finisher ${this.effectId} watchdog: forced stop`);
      this.fx.stop();
    }, 25000);
    try {
      await fn(this);
    } catch (e) {
      console.error(`showstopper | Finisher ${this.effectId} choreography failed`, e);
    }
    // If the ring stood as a static "arena" throughout the finisher, fade it out
    // gently at the end (on forced stop / canvas teardown, disposers destroy it anyway).
    // `ringTile.hold` — do NOT fade the ring: after the finisher the token remains
    // as a live "ring-only" marker, so the clone swaps seamlessly to the real token
    // in _dispose (visibility restore + clone destruction in one synchronous pass).
    // FADE THE ENTIRE CLONE CONTAINER, not just ringTile.sprite: once upgraded, a
    // ring's body is a CONTAINER (upgradeCloneBody), so fading the old sprite missed
    // it (already swapped/destroyed) and 183-223k pixels popped to zero in 1 frame
    // on singularity/smite.
    // `cap.hold` — choreography keeps the body VISIBLE right up until _dispose
    // (piercing: fallen corpse swaps seamlessly to the rotated real token), so the
    // generic container fade skips it.
    for (const cap of this._captures ?? []) {
      if (!cap.container || cap.container.destroyed) continue;
      if (cap.hold || cap.ringTile?.hold) {
        // IN PREVIEW MODE (menu dry-run) the real token was NOT mutated (not made
        // ringOnly/frozen/rotated), so an instant swap in _dispose would cause a
        // 1-frame jump back to the live portrait. Smoothly crossfade the intact
        // silhouette over the fading clone across 360ms for a seamless handoff.
        if (this.options?.preview && !this._stopped) {
          let ringReform = null;
          const fadeFull = !!cap.hold;
          if (fadeFull) {
            try {
              ringReform = buildCloneBody(this.token.document, this.baseGrid);
              if (ringReform) {
                ringReform.position.set(this.center.x, this.center.y);
                if (ringReform._subjectSprite) {
                  ringReform._subjectSprite.renderable = false;
                  ringReform._subjectSprite.visible = false;
                }
                ringReform.alpha = 0;
                this.layer.addChild(ringReform);
                this._addTransient(ringReform);
              }
            } catch { ringReform = null; }
          }
          const reform = cap.ghost({ tint: 0xffffff, alpha: 0, blend: 'normal' });
          const startA = cap.container.alpha;
          await this.tween({ k: 0 }, { k: 1 }, {
            duration: 360, ease: Ease.inOutQuad,
            onUpdate: k => {
              if (ringReform && !ringReform.destroyed) ringReform.alpha = k;
              if (reform && !reform.destroyed) reform.alpha = k;
              if (fadeFull && !cap.container.destroyed) cap.container.alpha = startA * (1 - k);
            }
          });
          if (ringReform) this._removeTransient(ringReform);
          if (reform) this._removeTransient(reform);
        }
        continue;
      }
      const st = { a: cap.container.alpha };
      await this.tween(st, { a: 0 }, {
        duration: 450, ease: Ease.outQuad,
        onUpdate: () => { if (!cap.container.destroyed) cap.container.alpha = st.a; }
      });
    }
    const t0 = this.clock;
    while (!this._stopped && this.clock - t0 < 2500) {
      const busy = [...this._systems].some(s => s.activeCount > 0)
        || [...this._transients].some(t => t.parent);
      if (!busy) break;
      await this.wait(150);
    }
    clearTimeout(watchdog);
    if (!this._stopped) this.fx.complete();
  }

  /* ----------------------- internal registry (shared) ----------------------- */

  _addSystem(sys) { this._systems.add(sys); }
  _addTransient(node) { this._transients.add(node); }
  _removeTransient(node) {
    this._transients.delete(node);
    if (node?.destroyed) return;
    try { node.destroy(); } catch { try { node.removeFromParent(); } catch { /* empty */ } }
  }
  _addTickerFn(fn) {
    // Forward `dms`: bolts() runs on REAL ticker milliseconds — without passing
    // the argument, the wrapper called fn() and its default `16` burned through
    // `life` ~2.4x too fast at 144 Hz
    const wrapped = (dms) => { if (!this._stopped) fn(dms); };
    this._tickerFns.add(wrapped);
    return wrapped;
  }
  _removeTickerFn(wrapped) { this._tickerFns.delete(wrapped); }
  _addCleanup(fn) { this._cleanups.push(fn); }

  /* ----------------------- token hiding ----------------------- */

  /**
   * Hide visual parts of the token during the finisher: the placeable itself,
   * mesh (body), border, bars, tooltip, and orbiting dynamic item sprites.
   *
   * THE MASTER SWITCH is the PLACEABLE's `renderable`: in v14 `Token._refreshVisibility`
   * reads it (`mesh.visible = this.visible && this.renderable`), and the placeable
   * subtree (`border/bars/effects/voidMesh/detectionFilterMesh`) stops rendering —
   * including paths that bypass mesh flags (detection renders the mesh directly
   * via `mesh.render()`). NOTE: `token.ring` in v14 is not a display object (the
   * mesh renders the ring via ring UVs), but we mute it as well in case another
   * version represents it as a mesh.
   *
   * Hide ownership is tracked in the shared registry (`_hiddenTokens`): the first
   * runner records the original state, overlapping runners merely attach, and
   * visuals are restored once the LAST owner exits. Core can reset `mesh.visible`
   * when recalculating visibility, so `renderable` is muted alongside it.
   */
  _hideTokenVisuals(token = this.token) {
    const id = token?.id;
    if (!id) return;
    if (this._hiddenTokensById.has(id)) return; // already hidden by this runner
    let entry = _hiddenTokens.get(id);
    // Recover original visibility from a stale entry: if pruning dead owners
    // empties the entry, its `parts` list is the ONLY record of the PRE-hidden
    // state (the token is currently hidden by a previous runner). Re-recording
    // from scratch would snapshot the hidden state as the "original", causing
    // the last runner to "restore" the token permanently hidden.
    let orphanParts = null;
    if (entry) {
      // prune disposed owners (e.g. token deleted with keepHidden — restore was
      // never called, leaving a stale claim in the registry)
      for (const r of entry.owners) {
        if (r._disposed) entry.owners.delete(r);
      }
      if (!entry.owners.size) {
        orphanParts = entry.parts;
        _hiddenTokens.delete(id);
        entry = null;
      }
    }
    if (!entry) {
      const parts = orphanParts ?? [];
      const record = (obj) => {
        if (!obj) return;
        parts.push({ obj, visible: obj.visible, renderable: obj.renderable });
        try {
          obj.visible = false;
          obj.renderable = false;
        } catch { /* stub object with read-only properties */ }
      };
      if (!orphanParts) {
        record(token);
        record(token?.mesh);
        record(token?.ring);
        record(token?.border);
        record(token?.bars);
        record(token?.tooltip);
        try {
          const items = (globalThis as any).showstopper?.dynamicItems?.manager?._displays?.get?.(id);
          if (items) {
            for (const d of items.values()) {
              record(d?._sprite);
              record(d?._glowSprite);
            }
          }
        } catch { /* dynamic items not initialized */ }
      }
      entry = { parts, owners: new Set() };
      _hiddenTokens.set(id, entry);
    }
    entry.owners.add(this);
    this._hiddenTokensById.set(id, token);
    console.info(`showstopper | finisher ${this.effectId}: hide token ${id} (${entry.parts.length} parts)`);
  }

  /**
   * Restore visual parts of the token once the last owner leaves the registry
   * (see `_hideTokenVisuals`). Skipped while `keepHidden` is set: the token is
   * awaiting deletion; if deletion fails, the failure path clears `_keepHidden`
   * and invokes restoration explicitly — so the registry claim stays intact
   * until then. `force` bypasses `keepHidden` (restoring an attacker after a
   * lunge, since the attacker is never deleted).
   */
  _restoreTokenVisuals(token = this.token, { force = false } = {}) {
    if (this._keepHidden && !force) return;
    const id = token?.id;
    this._hiddenTokensById.delete(id);
    const entry = id ? _hiddenTokens.get(id) : null;
    if (!entry || !entry.owners.delete(this)) return;
    if (entry.owners.size > 0) return; // another runner is still animating this token
    _hiddenTokens.delete(id);
    for (const p of entry.parts) {
      try {
        if ('renderable' in p.obj) p.obj.renderable = p.renderable;
        if ('visible' in p.obj) p.obj.visible = p.visible;
      } catch { /* empty */ }
    }
    console.info(`showstopper | finisher ${this.effectId}: restore token ${id}`);
  }

  /**
   * Per-frame hidden enforcement: while the runner is active, core (visibility
   * refreshes, document updates, mesh recreation) and third-party modules may
   * flip `visible`/`renderable` back on — every tick we re-mute the LIVE objects
   * (`token.mesh`, etc., rather than stale references from before mesh recreation).
   * Applies to ALL tokens owned by this runner: victim and attacker. If the
   * registry entry was cleared by an emergency reveal (`_clearHiddenEntry`),
   * yield immediately and stop hiding.
   */
  _enforceHidden() {
    if (!this._hiddenTokensById.size) return;
    // reuse scratch array: runs EVERY frame, so per-token array literals were
    // steady GC churn
    const parts = _enforceScratch;
    for (const [id, t] of this._hiddenTokensById) {
      if (!id || !_hiddenTokens.has(id)) continue;
      parts.length = 0;
      parts.push(t, t?.mesh, t?.ring, t?.border, t?.bars, t?.tooltip);
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        if (!part) continue;
        try {
          if (part.visible !== false) part.visible = false;
          if (part.renderable !== false) part.renderable = false;
        } catch { /* empty */ }
      }
      try {
        const items = (globalThis as any).showstopper?.dynamicItems?.manager?._displays?.get?.(id);
        if (items) {
          for (const d of items.values()) {
            parts.length = 0;
            parts.push(d?._sprite, d?._glowSprite);
            for (let si = 0; si < parts.length; si++) {
              const s = parts[si];
              if (!s) continue;
              try {
                if (s.visible !== false) s.visible = false;
                if (s.renderable !== false) s.renderable = false;
              } catch { /* empty */ }
            }
          }
        }
      } catch { /* dynamic items not initialized */ }
    }
  }

  /**
   * Drop a hidden-token entry WITHOUT restoring visuals: used when a token has
   * been deleted (`keepHidden`) or forcibly revealed. Disposed owners are pruned;
   * live owners whose animation is still running retain the entry.
   */
  static _dropHiddenEntry(id) {
    const entry = _hiddenTokens.get(id);
    if (!entry) return;
    for (const r of entry.owners) {
      if (r._disposed) entry.owners.delete(r);
    }
    if (!entry.owners.size) _hiddenTokens.delete(id);
  }

  /**
   * Unconditionally clear an entry during an emergency reveal (`finisher:showToken`):
   * removes live owners too — restoration is unnecessary since visibility was just
   * forced on directly, and per-frame enforcement must stand down.
   */
  static _clearHiddenEntry(id) {
    const entry = _hiddenTokens.get(id);
    if (!entry) return;
    entry.owners.clear();
    _hiddenTokens.delete(id);
  }

  /**
   * Whether a hidden-token entry is orphaned: the entry still exists, but NO
   * LIVE owners remain (all runners were disposed without restoration ever firing).
   * Happens to a `keepHidden` victim when the GM client disconnects before deleting
   * the token — see the safety timeout in `FinisherEffect._runFinisher`.
   */
  static _hiddenEntryStuck(id) {
    const entry = _hiddenTokens.get(id);
    if (!entry) return false;
    for (const r of entry.owners) if (!r._disposed) return false; // live runner still owns it — leave alone
    return true;
  }

  _removeDom(div) {
    const i = this._domNodes.indexOf(div);
    if (i >= 0) this._domNodes.splice(i, 1);
    div.remove();
  }

  _tick(ticker) {
    if (this._stopped) return;
    const dms = Math.min(100, ticker?.deltaMS ?? canvas.app.ticker.deltaMS);
    this.clock += dms;

    // keep hidden tokens muted throughout the animation despite external refreshes
    this._enforceHidden();

    // timers (iterate Set directly: deleting the current/visited element is safe,
    // and resolve defers continuations to microtasks — cloning to an array every
    // frame was pure GC churn)
    for (const timer of this._timers) {
      if (!timer.done && this.clock >= timer.due) {
        timer.done = true;
        this._timers.delete(timer);
        timer.resolve();
      }
    }

    // tweens (tweens added inside `onUpdate` are visited later in this pass, where
    // `local < 0` defers them to the next tick)
    for (const tw of this._tweens) {
      if (tw.fired) continue;
      const local = this.clock - tw.start;
      if (local < 0) continue;
      const k = tw.duration <= 0 ? 1 : Math.min(1, local / tw.duration);
      const e = tw.ease(k);
      try {
        for (const [key, seg] of tw.entries) {
          if (key === 'tint') {
            // non-numeric from/to collapses lerpColor to black — skip writing,
            // matching how the numeric branch skips NaN (see warning in tween())
            if (Number.isFinite(seg.from) && Number.isFinite(seg.to)) {
              tw.target.tint = lerpColor(seg.from, seg.to, e);
            }
          } else {
            const v = seg.from + (seg.to - seg.from) * e;
            // NaN guard: a non-numeric from/to (missing property on target) must
            // not poison a sprite coordinate with NaN — PIXI stops rendering such
            // sprites and the token "vanishes". Simply skip applying that property.
            if (Number.isFinite(v)) tw.target[key] = v;
          }
        }
        if (tw.onUpdate) tw.onUpdate(k);
      } catch (err) {
        // Tween target was destroyed mid-flight (e.g. ring placeholder swapped
        // for real art during async upgrade in TokenCapture — writing x/y on a
        // destroyed object throws). Drop the dead tween and resolve its promise
        // so it does not throw EVERY frame and stall the rest of `_tick`.
        console.debug(`showstopper | finisher tween dropped (target destroyed): ${err?.message ?? err}`);
        tw.fired = true;
        this._tweens.delete(tw);
        tw.resolve();
        continue;
      }
      if (k >= 1) {
        tw.fired = true;
        this._tweens.delete(tw);
        tw.resolve();
      }
    }

    // particles; an error in one system must not crash the ticker — same guard
    // as `_tickerFns` below (an uncaught throw would bubble into rAF and kill rendering)
    for (const sys of this._systems) {
      try { sys._update(dms); } catch (e) { console.error('showstopper | finisher particle system failed', e); }
    }

    // camera shake
    const sh = this._shake;
    if (sh) {
      sh.t += dms;
      const decay = Math.max(0, 1 - sh.t / sh.duration);
      this._applyShakeOffset(
        (Math.random() - 0.5) * 2 * sh.strength * decay,
        (Math.random() - 0.5) * 2 * sh.strength * decay
      );
    }

    // custom ticker callbacks (bolts, etc.); one failure must not bring down
    // Foundry's entire ticker
    for (const fn of this._tickerFns) {
      try { fn(dms); } catch (e) { console.error('showstopper | finisher ticker fn failed', e); }
    }
  }

  /** Soft stop: resolve pending timers/tweens, restore camera/tokens, and detach ticker. */
  _halt() {
    if (this._stopped) return;
    this._stopped = true;
    for (const t of this._timers) { t.done = true; t.resolve(); }
    this._timers.clear();
    for (const tw of this._tweens) { tw.fired = true; tw.resolve(); }
    this._tweens.clear();
    this._dispose();
  }

  _dispose() {
    this._stopped = true;
    this._disposed = true;
    try { canvas?.app?.ticker?.remove(this._tickFn); } catch { /* empty */ }
    // restore all tokens hidden by this runner: victim respects keepHidden,
    // while any other token (attacker after lunge) is force-restored
    for (const [id, tk] of [...this._hiddenTokensById]) {
      this._restoreTokenVisuals(tk, { force: id !== this.token?.id });
    }
    for (const fn of this._cleanups) {
      try { fn(); } catch (e) { console.error('showstopper | finisher cleanup failed', e); }
    }
    this._cleanups = [];
    for (const div of [...this._domNodes]) div.remove();
    this._domNodes = [];
    for (const sys of [...this._systems]) {
      try { sys._destroy(); } catch { /* empty */ }
    }
    this._systems.clear();
    for (const node of [...this._transients]) {
      try { node.destroy(); } catch { try { node.removeFromParent(); } catch { /* empty */ } }
    }
    this._transients.clear();
    try {
      this.uiLayer?.removeFromParent();
      this.uiLayer?.destroy({ children: true });
    } catch { /* empty */ }
    try {
      this.layer.removeFromParent();
      this.layer.destroy({ children: true });
    } catch { /* scene may already be torn down */ }
    // pre-mirrored capture sources (texture.scaleX/Y < 0): destroy base textures
    // after child tile sprites have been destroyed
    for (const cap of this._captures ?? []) {
      try { cap.destroy?.(); } catch { /* empty */ }
    }
    // return camera if stopped mid-zoom: release claims through the shared
    // refcount so the last runner out restores the scene
    while (this._cameraClaims > 0) {
      this._cameraClaims--;
      // _returnCamera is async: try/catch only catches synchronous throws, so
      // animatePan rejections must be caught explicitly to avoid unhandled rejections
      try { this._returnCamera(350).catch(() => {}); } catch { /* empty */ }
    }
    // clear any residual shake offset
    if (this._shake) {
      this._applyShakeOffset(0, 0);
      this._shake = null;
    }
  }
}
