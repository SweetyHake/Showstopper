export const MODULE_ID = 'showstopper';

export const DANGER_LEVELS = Object.freeze([
  { maxCR: 0, key: "harmless", color: "#6a6a6a", glow: "rgba(106,106,106,0.5)", pulse: false },
  { maxCR: 1, key: "minor", color: "#7a9f35", glow: "rgba(122,159,53,0.5)", pulse: false },
  { maxCR: 3, key: "caution", color: "#e67e22", glow: "rgba(230,126,34,0.5)", pulse: false },
  { maxCR: 5, key: "dangerous", color: "#e74c3c", glow: "rgba(231,76,60,0.6)", pulse: false },
  { maxCR: 10, key: "lethal", color: "#c0392b", glow: "rgba(192,57,43,0.7)", pulse: true, pulseSpeed: "3s" },
  { maxCR: 15, key: "deadly", color: "#9b59b6", glow: "rgba(155,89,182,0.7)", pulse: true, pulseSpeed: "2.5s" },
  { maxCR: 20, key: "extreme", color: "#8e44ad", glow: "rgba(142,68,173,0.8)", pulse: true, pulseSpeed: "2s" },
  { maxCR: Infinity, key: "doom", color: "#ff6b6b", glow: "rgba(255,107,107,0.9)", glowSize: "60px", pulse: true, pulseSpeed: "1.5s" }
]);

export const INTRO_CONFIG = {
  showDangerLevel: true,
  useCharacterLevel: true,
  dangerLevelBottom: "clamp(80px,12vh,140px)",
  dangerLevelFontSize: "18px",
  dangerLevelLetterSpacing: "8px",
  closeOnFirstClick: false,
  soundVolume: 0.8,
  animationDurations: {
    appear: 1400,
    close: 1000
  }
};

export const TBC_CONFIG = {
  soundPath: "",
  imagePath: "",
  delayMs: 3800,
  effectDuration: 10000,
  slideDuration: 6000,
  fadeTime: 1000
};