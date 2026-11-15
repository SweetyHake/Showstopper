import { getSocket, registerSocketHandler } from "../core/socket-manager.mjs";
import { registerAPI } from "../core/runtime.mjs";
/* ─── State & Styles ─── */
let cinematicTimeout = null;
let cinematicHideAt = 0;
const barsStyle = `
  .sweety-cinematic-bars {
    position: fixed;
    left: 0;
    width: 100%;
    height: 0;
    background: linear-gradient(to bottom, #000000, #0a0a0a);
    z-index: 50;
    pointer-events: none;
    transition: height 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }
  .sweety-cinematic-bars.top { top: 0; box-shadow: 0 2px 10px rgba(0,0,0,0.8); }
  .sweety-cinematic-bars.bottom { bottom: 0; box-shadow: 0 -2px 10px rgba(0,0,0,0.8); }
  .sweety-cinematic-bars.active { height: var(--bar-height, 12%); }
`;
function injectStyles() {
    if (document.getElementById("sweety-cinematic-styles"))
        return;
    const style = document.createElement("style");
    style.id = "sweety-cinematic-styles";
    style.textContent = barsStyle;
    document.head.appendChild(style);
}
/* ─── DOM Lifecycle ─── */
function ensureBars() {
    injectStyles();
    let container = document.getElementById("sweety-cinematic-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "sweety-cinematic-container";
        for (const pos of ["top", "bottom"]) {
            const bar = document.createElement("div");
            bar.className = `sweety-cinematic-bars ${pos}`;
            bar.id = `sweety-bar-${pos}`;
            container.appendChild(bar);
        }
        document.body.appendChild(container);
    }
    return {
        top: document.getElementById("sweety-bar-top"),
        bottom: document.getElementById("sweety-bar-bottom")
    };
}
function hideBarsLocal() {
    if (cinematicTimeout) {
        clearTimeout(cinematicTimeout);
        cinematicTimeout = null;
    }
    cinematicHideAt = 0;
    const top = document.getElementById("sweety-bar-top");
    const bottom = document.getElementById("sweety-bar-bottom");
    top?.classList.remove("active");
    bottom?.classList.remove("active");
}
function showBarsLocal({ duration = 2000, barHeight = 12, fadeOutDuration = 400 } = {}) {
    const bars = ensureBars();
    bars.top.style.setProperty("--bar-height", `${barHeight}%`);
    bars.bottom.style.setProperty("--bar-height", `${barHeight}%`);
    bars.top.classList.add("active");
    bars.bottom.classList.add("active");
    const delay = Math.max(0, Number(duration || 0) - Number(fadeOutDuration || 0));
    const nextHideAt = performance.now() + delay;
    // Do not shorten an already-running letterbox display started by a longer concurrent attack.
    if (cinematicTimeout && nextHideAt <= cinematicHideAt)
        return;
    if (cinematicTimeout) {
        clearTimeout(cinematicTimeout);
        cinematicTimeout = null;
    }
    cinematicHideAt = nextHideAt;
    cinematicTimeout = setTimeout(() => {
        bars.top.classList.remove("active");
        bars.bottom.classList.remove("active");
        cinematicTimeout = null;
        cinematicHideAt = 0;
    }, delay);
}
/* ─── Socket Handlers & Public API ─── */
registerSocketHandler("showCinematicBars", showBarsLocal);
registerSocketHandler("hideCinematicBars", hideBarsLocal);
Hooks.on("canvasTearDown", hideBarsLocal);
Hooks.once("init", () => {
    registerAPI("cinematicBars", {
        showLocal(duration = 2000, barHeight = 12) {
            showBarsLocal({ duration, barHeight });
        },
        hideLocal() {
            hideBarsLocal();
        },
        async show(duration = 2000, barHeight = 12) {
            const payload = { duration, barHeight };
            const socket = getSocket();
            if (!socket) {
                showBarsLocal(payload);
                return;
            }
            return socket.executeForEveryone("showCinematicBars", payload);
        },
        async hide() {
            const socket = getSocket();
            if (!socket) {
                hideBarsLocal();
                return;
            }
            return socket.executeForEveryone("hideCinematicBars", {});
        }
    });
});
