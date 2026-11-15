/**
 * Corpse imprint (opt-in): on token death, the GM client bakes a DARK SILHOUETTE
 * of its art (Canvas2D drawImage of the mesh texture + `source-in` fill of dried
 * blood) and places it as a decal TILE underneath the token. The imprint stays on
 * the scene after the body is removed ("this creature died here"); native CTRL+Z
 * for tile deletion works out of the box (tiles are layer documents with their own history).
 *
 * Gates: `bloodCorpseImprints` setting (OFF by default — never silently mint
 * tiles in user scenes), NPCs only (player bodies are left untouched — same policy
 * as auto-finishers), non-hidden tokens, actor-backed tokens only.
 * The tile carries `flags.showstopper.corpseImprint` so blood "Clear All" also
 * removes imprints (see `entry.clearBloodAll`).
 *
 * Paired with the finisher capture technique: frame from texture (not bounds),
 * mirror via negative `scale.x/y`, no canvas destroy needed (the PNG goes into the tile).
 */

import { MODULE_ID } from '../config.mjs';

const IMPRINT_PX = 320;          // long-side pixel cap (PNG ~tens of KB)
const SILHOUETTE = '#2e0c08';    // dried dark blood

/** Whether this token already has an imprint (repeated deaths do not duplicate). */
function _hasImprint(token) {
  try {
    const sceneTiles = canvas.scene?.tiles;
    if (sceneTiles) {
      for (const d of sceneTiles) if (d?.getFlag?.(MODULE_ID, 'corpseImprint') === token.id) return true;
      return false;
    }
    return canvas.tiles?.placeables?.some(t => t.document?.getFlag?.(MODULE_ID, 'corpseImprint') === token.id) ?? false;
  } catch { return false; }
}

/**
 * Bake a data URI of the token art silhouette (or null if no texture / on failure).
 * Called only on the GM client when the setting is enabled.
 */
function _bakeSilhouette(token) {
  try {
    const mesh = token?.mesh;
    const tex = mesh?.texture;
    const src = tex?.baseTexture?.resource?.source;
    if (!src || !(tex.width > 0) || !(tex.height > 0)) return null;
    const frame = tex.frame ?? { x: 0, y: 0, width: tex.width, height: tex.height };
    const k = Math.min(1, IMPRINT_PX / Math.max(frame.width, frame.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(frame.width * k));
    cv.height = Math.max(1, Math.round(frame.height * k));
    const ctx = cv.getContext('2d');
    const mirror = {
      x: (Number(mesh.scale?.x) || 1) < 0 ? -1 : 1,
      y: (Number(mesh.scale?.y) || 1) < 0 ? -1 : 1
    };
    ctx.save();
    ctx.scale(mirror.x * k, mirror.y * k);
    ctx.drawImage(src, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
    ctx.restore();
    // Silhouette: art alpha → dried-blood gradient fill (leave grain to blood
    // splatters — the imprint should read as a SHADOW, not a sprite copy)
    ctx.globalCompositeOperation = 'source-in';
    const g = ctx.createLinearGradient(0, 0, 0, cv.height);
    g.addColorStop(0, SILHOUETTE);
    g.addColorStop(1, '#200705');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = 'source-over';
    return cv.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Spawn a corpse imprint under a slain token (call from the death path).
 * Fire-and-forget: imprint failure must never crash the damage pipeline.
 * @returns {Promise<TileDocument|null>}
 */
export function maybeCorpseImprint(token) {
  try {
    if (!(game.settings.get(MODULE_ID, 'bloodCorpseImprints') ?? false)) return null;
    if (!game.user.isGM || !token?.document || !canvas?.scene) return null;
    const doc = token.document;
    if (doc.hidden) return null;
    const actor = doc.actor;
    if (!actor) return null;
    // Leave player bodies untouched (same policy as auto-finishers)
    if (actor.hasPlayerOwner) return null;
    if (_hasImprint(token)) return null;

    const grid = canvas.grid?.size ?? 100;
    const w = Math.abs(doc.width ?? 1) * grid;
    const h = Math.abs(doc.height ?? 1) * grid;
    const cx = (Number(doc.x) || 0) + w / 2;
    const cy = (Number(doc.y) || 0) + h / 2;
    const img = _bakeSilhouette(token);
    if (!img) return null;
    return canvas.scene.createEmbeddedDocuments('Tile', [{
      name: 'corpse-imprint',
      x: Math.round(cx - w / 2),
      y: Math.round(cy - h / 2),
      elevation: doc.elevation ?? 0,
      ...(doc.level ? { levels: [doc.level] } : {}),
      width: Math.round(w),
      height: Math.round(h),
      rotation: 0,
      img,
      flags: { [MODULE_ID]: { corpseImprint: token.id } }
    }]).catch(e => {
      // Native tile layer history gets its own undo for free; imprint failure
      // must never crash the damage pipeline
      console.warn(`${MODULE_ID} | corpse imprint failed`, e);
      return null;
    });
  } catch (e) {
    console.warn(`${MODULE_ID} | corpse imprint failed`, e);
    return null;
  }
}

/** Remove all corpse imprints from the scene (alongside blood "Clear All"). GM-side. */
export async function clearCorpseImprints() {
  if (!game.user.isGM || !canvas?.scene) return 0;
  const rawTiles = canvas.scene.tiles
    ? [...canvas.scene.tiles]
    : (canvas.tiles?.placeables ?? []).map(t => t.document);
  const tiles = rawTiles.filter(d => d?.getFlag?.(MODULE_ID, 'corpseImprint') != null);
  if (!tiles.length) return 0;
  await canvas.scene.deleteEmbeddedDocuments('Tile', tiles.map(d => d.id));
  return tiles.length;
}
