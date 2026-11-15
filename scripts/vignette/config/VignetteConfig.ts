export const VIGNETTE_CONFIG = {
  STATUS_VIGNETTES: [
    {
      id: "petrified",
      color: "#5C3D1E",
      priority: 1,
      cssClass: "ss-status-petrified"
    },
    {
      id: "frightened",
      color: "#2D0A4E",
      priority: 2,
      cssClass: "ss-status-frightened"
    },
    {
      id: "poisoned",
      color: "#1A4D1A",
      priority: 3,
      cssClass: "ss-status-poisoned"
    },
    {
      id: "charmed",
      color: "#FF69B4",
      priority: 5,
      cssClass: "ss-status-charmed"
    },
    {
      id: "bleeding",
      color: "#8B0000",
      priority: 4,
      cssClass: "ss-status-bleeding"
    },
    {
      id: "dnd-heat",
      color: "#CC5500",
      priority: 6,
      cssClass: "ss-status-heat"
    },
    {
      id: "dnd-cold",
      color: "#7BAFC4",
      priority: 7,
      cssClass: "ss-status-cold"
    },
    {
      id: "paralyzed",
      color: "#6A2DB8",
      priority: 8,
      cssClass: "ss-status-paralyzed"
    },
    {
      id: "stunned",
      color: "#5A3E8C",
      priority: 9,
      cssClass: "ss-status-stunned"
    },
    {
      id: "ethereal",
      color: "#4FD4C4",
      priority: 10,
      cssClass: "ss-status-ethereal"
    },
    {
      id: "burning",
      color: "#D84315",
      priority: 11,
      cssClass: "ss-status-burning"
    }
  ],

  HEALTH: {
    threshold: 0.5,
    exponent: 2.5,
    maxOpacity: 1.0,
    color: "#8B0000",
    size: 0.6
  },

  ANIMATION: {
    statusFadeIn: 500,
    statusFadeOut: 500,
    healthTransition: 300,
    popupFadeIn: 200,
    popupFadeOut: 1000,
    popupDuration: 1500
  },

  POPUP: {
    defaultSize: 0.5,
    damageColor: "#FF0000",
    healColor: "#00AA44",
    minOpacity: 0.35,
    maxOpacity: 0.85
  },

  STATUS: {
    defaultIntensity: 0.6,
    defaultSize: 0.5
  },

  ZINDEX: {
    root: 10,
    health: 1,
    status: 2,
    popup: 3
  }
};