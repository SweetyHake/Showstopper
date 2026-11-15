export const MODULE_ID = "showstopper";

export const PORTRAIT_SIZES = {
  xs:     "64px",
  small:  "96px",
  medium: "108px",
  large:  "128px",
  xl:     "156px"
};

/** Lower bound for vertical panel shrinking: portraits never shrink smaller than this. */
export const MIN_PORTRAIT_PX = 48;

export const FALLBACK_IMAGE = "icons/svg/mystery-man.svg";

/* Core placeholders: dnd5e actors start with mystery-man in img and/or
   prototypeToken.texture.src — these must not be treated as a "real" portrait. */
export const IMAGE_STUBS = new Set(["", "icons/svg/mystery-man.svg", "icons/mystery-man.svg"]);

/** Returns true if src is a real image (non-empty and not a placeholder stub). */
export function isRealImage(src) {
  return typeof src === "string" && src.trim() !== "" && !IMAGE_STUBS.has(src.trim());
}

/**
 * Resolves a character's real portrait: actor.img -> prototype token art.
 * Newly created dnd5e actors have mystery-man in both fields, so each fallback
 * step is checked against placeholder stubs; returns null if no real art exists.
 */
export function resolveCharacterImage(character) {
  if (!character) return null;
  if (isRealImage(character.img)) return character.img;
  if (isRealImage(character.prototypeToken?.texture?.src)) return character.prototypeToken.texture.src;
  return null;
}

export const PING_UPDATE_INTERVAL = 5000;
export const FPS_UPDATE_INTERVAL = 2000;

export function localize(key, data = {}) {
  let str = game.i18n.localize(key);
  for (const [k, v] of Object.entries(data)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}
