import { DANGER_LEVELS, INTRO_CONFIG, MODULE_ID } from './config.mjs';
import { groupLevelCache } from './cache.mjs';
import { getActorIntroTitle, getLocalizedCreatureType, stripBracketTranslation } from './cut-ins/utils/actor-intro-data.mjs';

export function getDangerLevel(cr) {
  if (cr === null || cr === undefined) return null;
  
  // dnd5e stores fractional CRs as formula strings ("1/2", "1/4", "1/8"):
  // parseFloat("1/4") returned 1, misclassifying every fractional CR as "minor"
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(String(cr).trim());
  const numericCR = frac ? (Number(frac[1]) / Number(frac[2])) : (parseFloat(cr) || 0);
  const groupLevel = groupLevelCache.get();
  
  let adjustedCR = numericCR;
  if (adjustedCR >= 1 && groupLevel > 0) {
    const reduction = Math.floor(groupLevel / 3);
    adjustedCR = Math.max(numericCR - reduction, 1);
  }
  
  const level = DANGER_LEVELS.find(l => adjustedCR <= l.maxCR) 
    ?? DANGER_LEVELS[DANGER_LEVELS.length - 1];
  
  const locKey = `${MODULE_ID}.cut-ins.ui.dangerLevels.${level.key}`;
  const text = game.i18n.localize(locKey);
  
  return {
    text: text !== locKey ? text : level.key,
    key: level.key,
    color: level.color,
    glow: level.glow,
    glowSize: level.glowSize ?? "30px",
    pulse: level.pulse,
    pulseSpeed: level.pulseSpeed ?? "3s"
  };
}

export function getActorCR(actor) {
  if (!actor) return null;
  
  if (actor.type === 'npc') {
    return actor.system.details?.cr ?? null;
  }
  
  if (actor.type === 'character' && INTRO_CONFIG.useCharacterLevel) {
    const classes = Object.values(actor.classes ?? {});
    if (classes.length) {
      return classes.reduce((total, cls: any) => total + (cls.system?.levels ?? 0), 0);
    }
    return actor.system.details?.level ?? null;
  }
  
  return null;
}

export async function getActorTitle(actor) {
  if (!actor) return game.i18n.localize("DND5E.Unknown");
  const introTitle = await getActorIntroTitle(actor);
  if (introTitle) return introTitle;
  
  const details = actor.system.details ?? {};
  
  if (actor.type === 'npc') {
    const localizedType = getLocalizedCreatureType(actor);
    if (localizedType) return localizedType;
    return stripBracketTranslation(details.source) || game.i18n.localize("TYPES.Actor.npc");
  }
  
  if (actor.type === 'character') {
    const classes = Object.values(actor.classes ?? {});
    if (classes.length > 0) {
      const primaryClass: any = classes[0];
      const level = primaryClass.system?.levels ?? '';
      return `${stripBracketTranslation(primaryClass.name)} ${level}`.trim();
    }
    return stripBracketTranslation(details.race) || game.i18n.localize("TYPES.Actor.character");
  }
  
  return game.i18n.localize("DND5E.Unknown");
}