/**
 * Floating "Trail Brush" HUD panel (GM) — Showstopper design system canon
 * (cs-hero-box / fameosity), compact icon-only layout:
 *  - Clean drag header `.ss-blood-hud__header`: subtle grip + brush badge on the
 *    left + quiet Settings and Close icon buttons (double-click header to
 *    collapse/expand).
 *  - Icon-only mode toolbar `.ss-blood-hud__modes` (`Blood | Eraser` in Free,
 *    `Blood | Snow | Eraser` when the `showstopper-plus` snow adapter is active).
 *  - Contextual snow depth strip (`+` auto / `1..5`) shown only in Snow mode.
 *  - Icon-labeled flat sliders (`Size`, `Density`, `Opacity %`) paired with manual
 *    numeric `<input type="number">` fields; unused parameters mute in-place on
 *    Erase so panel height never shifts.
 *  - Single compact bottom utility bar: color palette + No-wash (or icon-only
 *    Snow Apron / Erase-active-substance toggle) on the left; icon-prefixed
 *    manual Height + Clear icon buttons on the right.
 */
import { MODULE_ID } from '../config.mjs';
import { parseColor } from './colors.mjs';
import { BRUSH_ELEV_MIN, BRUSH_ELEV_MAX } from './elevation.mjs';
import { BloodSettingsApp } from './settings-app.mjs';
import { hasSnowAdapter, onSnowAdapter } from './snow-bridge.mjs';
const L = (key) => game.i18n.localize(`${MODULE_ID}.blood.hud.${key}`);
/** Unified brush descriptor exported for legacy/external callers. */
export const TYPES = [
    {
        id: 'splat',
        icon: 'fa-solid fa-droplet'
    }
];
/** Snow (`material === 2`) uses the unified snow brush ('splat'). */
export const SNOW_ALLOWED_TYPES = new Set(['splat']);
/** Substances: default color + quick palette swatches per substance. */
export const SUBSTANCES = [
    {
        id: 0,
        key: 'blood',
        color: '#a51414d8',
        icon: 'fa-solid fa-droplet',
        presets: ['#a51414d8', '#630b0bd8', '#d41c1cd8', '#2f0909e0']
    },
    {
        id: 2,
        key: 'snow',
        color: '#e8ecf2e0',
        icon: 'fa-regular fa-snowflake',
        presets: ['#e8ecf2e0', '#dce8f6e0', '#c5d6eae0', '#ffffffe8']
    }
];
const BLOOD_SWATCHES = ['#a51414d8', '#630b0bd8', '#2f0909e0'];
const SNOW_DEPTH_ITEMS = [
    { depth: 0, key: 'auto', icon: 'fa-solid fa-plus' },
    { depth: 1, key: 'lv1', label: '1' },
    { depth: 2, key: 'lv2', label: '2' },
    { depth: 3, key: 'lv3', label: '3' },
    { depth: 4, key: 'lv4', label: '4' },
    { depth: 5, key: 'lv5', label: '5' }
];
const _ALL_PRESET_COLORS = new Set(SUBSTANCES.flatMap(s => [s.color.toLowerCase(), ...s.presets.map(p => p.toLowerCase())]));
/** Session-scoped HUD position and collapsed state (persist across closing/reopening the brush). */
let _lastHudPos = null;
let _hudCollapsed = false;
const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls)
        node.className = cls;
    if (text != null)
        node.textContent = text;
    return node;
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const toRgbHex = (hex8) => {
    const p = parseColor(hex8) ?? parseColor('#a51414d8');
    return `#${[p.r, p.g, p.b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
};
/**
 * Build the compact "Trail Brush" HUD panel (Showstopper Canon).
 * @param {object} ctx brush context:
 *   getParams() → {color,size,density,alpha,type,material,elev,eraseMatOnly,noWash,snowDepth,snowSkirt}
 *   setParams(patch) / getMode() → 'paint'|'erase' / setMode(mode)
 *   getCount() → scene stain count / onClear() / onClearMaterial() / onClose()
 * @returns {{element: HTMLElement, refresh: () => void, destroy: () => void}}
 */
export function createBrushHUD(ctx) {
    let destroyed = false;
    const root = el('div', 'ss-blood-hud');
    root.setAttribute('role', 'region');
    root.style.display = 'none'; // hidden until initial refresh to avoid FOUC
    /* ============ 1. Header following .showstopper-app .window-header canon ============ */
    const header = el('div', 'ss-blood-hud__header');
    const title = el('span', 'ss-blood-hud__title');
    title.innerHTML = '<i class="fa-solid fa-grip-vertical ss-blood-hud__grip" aria-hidden="true"></i><i class="fa-solid fa-paintbrush" aria-hidden="true"></i>';
    const headerActions = el('div', 'ss-blood-hud__header-actions');
    const gearBtn = el('button', 'ss-blood-hud__ctrl-btn');
    gearBtn.type = 'button';
    gearBtn.innerHTML = '<i class="fa-solid fa-gear" aria-hidden="true"></i>';
    gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        BloodSettingsApp.show();
    });
    const closeBtn = el('button', 'ss-blood-hud__ctrl-btn');
    closeBtn.type = 'button';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.onClose?.();
    });
    headerActions.append(gearBtn, closeBtn);
    header.append(title, headerActions);
    header.addEventListener('dblclick', (e) => {
        if (e.target?.closest('button'))
            return;
        _hudCollapsed = !_hudCollapsed;
        refresh();
    });
    root.appendChild(header);
    /* ============ 2. Panel body (.ss-blood-hud__body) ============ */
    const body = el('div', 'ss-blood-hud__body');
    /* --- 2a. Icon-only mode toolbar: Blood | (Snow) | Eraser --- */
    const modesRow = el('div', 'ss-blood-hud__modes');
    modesRow.setAttribute('role', 'toolbar');
    const bloodModeBtn = el('button', 'ss-blood-hud__mode-btn');
    bloodModeBtn.type = 'button';
    bloodModeBtn.dataset.substance = '0';
    bloodModeBtn.setAttribute('aria-pressed', 'false');
    bloodModeBtn.innerHTML = '<i class="fa-solid fa-droplet" aria-hidden="true"></i>';
    bloodModeBtn.addEventListener('click', () => {
        const cur = ctx.getParams();
        const curHex = String(cur.color || '').toLowerCase();
        const isPreset = _ALL_PRESET_COLORS.has(curHex);
        ctx.setMode('paint');
        ctx.setParams((isPreset || cur.material !== 0) ? { material: 0, color: '#a51414d8' } : { material: 0 });
    });
    const snowModeBtn = el('button', 'ss-blood-hud__mode-btn');
    snowModeBtn.type = 'button';
    snowModeBtn.dataset.substance = '2';
    snowModeBtn.setAttribute('aria-pressed', 'false');
    snowModeBtn.innerHTML = '<i class="fa-regular fa-snowflake" aria-hidden="true"></i>';
    snowModeBtn.addEventListener('click', () => {
        ctx.setMode('paint');
        ctx.setParams({ material: 2, color: '#e8ecf2e0' });
    });
    const eraseModeBtn = el('button', 'ss-blood-hud__mode-btn ss-blood-hud__mode-btn--erase');
    eraseModeBtn.type = 'button';
    eraseModeBtn.setAttribute('aria-pressed', 'false');
    eraseModeBtn.innerHTML = '<i class="fa-solid fa-eraser" aria-hidden="true"></i>';
    eraseModeBtn.addEventListener('click', () => {
        ctx.setMode(ctx.getMode() === 'erase' ? 'paint' : 'erase');
    });
    modesRow.append(bloodModeBtn, snowModeBtn, eraseModeBtn);
    body.appendChild(modesRow);
    /* --- 2b. Contextual Snow depth strip (Plus only, when Snow active) --- */
    const snowTools = el('div', 'ss-blood-hud__snow-bar');
    snowTools.setAttribute('role', 'toolbar');
    const snowDepthBtns = [];
    for (const item of SNOW_DEPTH_ITEMS) {
        const btn = el('button', 'ss-blood-hud__snow-btn');
        btn.type = 'button';
        if (item.icon)
            btn.innerHTML = `<i class="${item.icon}" aria-hidden="true"></i>`;
        else
            btn.textContent = item.label ?? '';
        btn.dataset.snowDepth = String(item.depth);
        btn.dataset.snowKey = item.key;
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => {
            ctx.setMode('paint');
            ctx.setParams({ snowDepth: item.depth });
        });
        snowTools.appendChild(btn);
        snowDepthBtns.push(btn);
    }
    body.appendChild(snowTools);
    /* --- 2c. Icon-labeled flat sliders with manual numeric inputs (Size, Density, Opacity %) --- */
    const slidersWrap = el('div', 'ss-blood-hud__sliders');
    const mkParamRow = (idSuffix, labelKey, iconCls, opts) => {
        const { min, max, step, numStep, unit, toUI, fromUI, onCommit } = opts;
        const row = el('div', 'ss-blood-hud__param-row');
        const lbl = el('label', 'ss-blood-hud__param-label');
        const inputId = `ss-brush-${idSuffix}`;
        lbl.setAttribute('for', inputId);
        lbl.innerHTML = `<i class="${iconCls}" aria-hidden="true"></i>`;
        const range = document.createElement('input');
        range.type = 'range';
        range.id = inputId;
        range.className = 'ss-blood-hud__range';
        range.min = String(min);
        range.max = String(max);
        range.step = String(step);
        const numWrap = el('div', 'ss-blood-hud__num-wrap');
        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'ss-blood-hud__num';
        num.min = String(min);
        num.max = String(max);
        num.step = String(numStep);
        num.setAttribute('aria-label', L(labelKey));
        numWrap.appendChild(num);
        if (unit) {
            const unitEl = el('span', 'ss-blood-hud__num-unit', unit);
            unitEl.setAttribute('aria-hidden', 'true');
            numWrap.appendChild(unitEl);
        }
        const ctl = { row, lbl, labelKey, range, num, unit, toUI, lastUi: min };
        range.addEventListener('input', () => {
            const uiVal = clamp(Math.round(Number(range.value)), min, max);
            ctl.lastUi = uiVal;
            num.value = String(uiVal);
            range.setAttribute('aria-valuetext', unit ? `${uiVal}${unit}` : String(uiVal));
            onCommit(fromUI(uiVal));
        });
        num.addEventListener('change', () => {
            const parsed = Number(num.value);
            if (!Number.isFinite(parsed)) {
                num.value = String(ctl.lastUi);
                return;
            }
            const uiVal = clamp(Math.round(parsed), min, max);
            ctl.lastUi = uiVal;
            num.value = String(uiVal);
            range.value = String(uiVal);
            range.setAttribute('aria-valuetext', unit ? `${uiVal}${unit}` : String(uiVal));
            onCommit(fromUI(uiVal));
        });
        num.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                num.blur();
            }
        });
        row.append(lbl, range, numWrap);
        slidersWrap.appendChild(row);
        return ctl;
    };
    const sizeCtl = mkParamRow('size', 'sizeShort', 'fa-solid fa-expand', {
        min: 10, max: 800, step: 5, numStep: 1, unit: '',
        toUI: (v) => clamp(Math.round(v), 10, 800),
        fromUI: (u) => u,
        onCommit: (v) => ctx.setParams({ size: v })
    });
    const densityCtl = mkParamRow('density', 'density', 'fa-solid fa-braille', {
        min: 1, max: 5, step: 1, numStep: 1, unit: '',
        toUI: (v) => clamp(Math.round(v), 1, 5),
        fromUI: (u) => u,
        onCommit: (v) => ctx.setParams({ density: v })
    });
    const alphaCtl = mkParamRow('alpha', 'alphaShort', 'fa-solid fa-circle-half-stroke', {
        min: 5, max: 100, step: 5, numStep: 1, unit: '%',
        toUI: (v) => clamp(Math.round(v * 100), 5, 100),
        fromUI: (u) => clamp(Math.round(u), 5, 100) / 100,
        onCommit: (v) => ctx.setParams({ alpha: v })
    });
    body.appendChild(slidersWrap);
    /* --- 2d. Single compact bottom utility bar --- */
    const bar = el('div', 'ss-blood-hud__bar');
    const barLeft = el('div', 'ss-blood-hud__bar-left');
    // Blood paint controls: color picker + 3 blood presets + No-wash toggle
    const bloodPalette = el('div', 'ss-blood-hud__palette');
    const colorPick = document.createElement('input');
    colorPick.type = 'color';
    colorPick.className = 'ss-blood-hud__color-pick';
    colorPick.addEventListener('input', () => {
        const prev = parseColor(ctx.getParams().color) ?? { a: 0.85 };
        const hex8 = colorPick.value + Math.round(clamp(prev.a, 0, 1) * 255).toString(16).padStart(2, '0');
        ctx.setParams({ color: hex8 });
    });
    bloodPalette.appendChild(colorPick);
    const swatchBtns = [];
    for (const hex8 of BLOOD_SWATCHES) {
        const sw = el('button', 'ss-blood-hud__swatch');
        sw.type = 'button';
        sw.dataset.color = hex8;
        const rgbHex = toRgbHex(hex8);
        sw.style.background = rgbHex;
        sw.setAttribute('aria-label', rgbHex);
        sw.dataset.tooltip = rgbHex;
        sw.setAttribute('aria-pressed', 'false');
        sw.addEventListener('click', () => {
            ctx.setParams({ color: hex8 });
        });
        bloodPalette.appendChild(sw);
        swatchBtns.push(sw);
    }
    const noWashBtn = el('button', 'ss-blood-hud__icon-btn');
    noWashBtn.type = 'button';
    noWashBtn.setAttribute('aria-pressed', 'false');
    noWashBtn.innerHTML = '<i class="fa-solid fa-umbrella" aria-hidden="true"></i>';
    noWashBtn.addEventListener('click', () => {
        ctx.setParams({ noWash: !ctx.getParams().noWash });
    });
    bloodPalette.appendChild(noWashBtn);
    // Snow paint control: icon-only soft apron toggle (Plus only)
    const snowSkirtBtn = el('button', 'ss-blood-hud__icon-btn');
    snowSkirtBtn.type = 'button';
    snowSkirtBtn.setAttribute('aria-pressed', 'false');
    snowSkirtBtn.innerHTML = '<i class="fa-solid fa-water" aria-hidden="true"></i>';
    snowSkirtBtn.addEventListener('click', () => {
        ctx.setParams({ snowSkirt: !ctx.getParams().snowSkirt });
    });
    // Erase mode control: icon-only erase active substance toggle (Plus only)
    const eraseMatBtn = el('button', 'ss-blood-hud__icon-btn');
    eraseMatBtn.type = 'button';
    eraseMatBtn.setAttribute('aria-pressed', 'false');
    eraseMatBtn.innerHTML = '<i class="fa-solid fa-filter" aria-hidden="true"></i>';
    eraseMatBtn.addEventListener('click', () => {
        ctx.setParams({ eraseMatOnly: !ctx.getParams().eraseMatOnly });
    });
    barLeft.append(bloodPalette, snowSkirtBtn, eraseMatBtn);
    // Persistent right utility group: manual elevation + clear buttons
    const barRight = el('div', 'ss-blood-hud__bar-right');
    const elevInputWrap = el('div', 'ss-blood-hud__elev-wrap');
    const elevPrefix = document.createElement('i');
    elevPrefix.className = 'fa-solid fa-arrows-up-down ss-blood-hud__elev-prefix';
    elevPrefix.setAttribute('aria-hidden', 'true');
    const elevInput = document.createElement('input');
    elevInput.type = 'number';
    elevInput.className = 'ss-blood-hud__elev';
    elevInput.min = String(BRUSH_ELEV_MIN);
    elevInput.max = String(BRUSH_ELEV_MAX);
    elevInput.step = '0.1';
    elevInput.addEventListener('change', () => {
        const parsed = Number(elevInput.value);
        if (!Number.isFinite(parsed)) {
            elevInput.value = String(ctx.getParams().elev);
            return;
        }
        const v = clamp(Math.round(parsed * 10) / 10, BRUSH_ELEV_MIN, BRUSH_ELEV_MAX);
        elevInput.value = String(v);
        ctx.setParams({ elev: v });
    });
    elevInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            elevInput.blur();
        }
    });
    elevInputWrap.append(elevPrefix, elevInput);
    const clearMatBtn = el('button', 'ss-blood-hud__icon-btn');
    clearMatBtn.type = 'button';
    clearMatBtn.innerHTML = '<i class="fa-solid fa-broom" aria-hidden="true"></i>';
    clearMatBtn.addEventListener('click', () => ctx.onClearMaterial?.());
    const clearBtn = el('button', 'ss-blood-hud__icon-btn ss-blood-hud__icon-btn--danger');
    clearBtn.type = 'button';
    clearBtn.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
    clearBtn.addEventListener('click', () => ctx.onClear?.());
    barRight.append(elevInputWrap, clearMatBtn, clearBtn);
    bar.append(barLeft, barRight);
    body.appendChild(bar);
    root.appendChild(body);
    /* ============ 3. Dragging by header ============ */
    let dragging = null;
    header.addEventListener('pointerdown', (e) => {
        if (e.button !== 0)
            return;
        if (e.target?.closest('button, input, select, textarea'))
            return;
        const rect = root.getBoundingClientRect();
        dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        header.classList.add('is-dragging');
        header.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
        if (!dragging)
            return;
        const maxLeft = Math.max(4, window.innerWidth - root.offsetWidth - 4);
        const maxTop = Math.max(4, window.innerHeight - root.offsetHeight - 4);
        _lastHudPos = {
            left: clamp(e.clientX - dragging.dx, 4, maxLeft),
            top: clamp(e.clientY - dragging.dy, 4, maxTop)
        };
        root.style.left = `${_lastHudPos.left}px`;
        root.style.top = `${_lastHudPos.top}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
    });
    const endDrag = () => {
        dragging = null;
        header.classList.remove('is-dragging');
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    header.addEventListener('lostpointercapture', endDrag);
    if (_lastHudPos) {
        root.style.left = `${_lastHudPos.left}px`;
        root.style.top = `${_lastHudPos.top}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
    }
    /* ============ 4. State synchronization (refresh) ============ */
    const refresh = () => {
        const p = ctx.getParams();
        const mode = ctx.getMode();
        const isErase = mode === 'erase';
        const snowAvail = hasSnowAdapter();
        const isSnow = snowAvail && p.material === 2;
        const subDef = SUBSTANCES.find(s => s.id === (isSnow ? 2 : 0)) ?? SUBSTANCES[0];
        const subName = L(`substance.${subDef.key}`);
        const rgbHex = toRgbHex(p.color);
        root.classList.toggle('ss-blood-hud--erasing', isErase);
        root.classList.toggle('ss-blood-hud--collapsed', _hudCollapsed);
        // Header localized labels & tooltips (icon-only drag badge)
        const titleStr = L('title');
        const settingsTip = game.i18n.localize(`${MODULE_ID}.blood.settings.menuTitle`);
        const closeTip = L('closeTip');
        root.setAttribute('aria-label', titleStr);
        title.dataset.tooltip = titleStr;
        gearBtn.setAttribute('aria-label', settingsTip);
        gearBtn.dataset.tooltip = settingsTip;
        closeBtn.setAttribute('aria-label', closeTip);
        closeBtn.dataset.tooltip = closeTip;
        body.style.display = _hudCollapsed ? 'none' : '';
        // Mode toolbar: Blood | (Snow) | Eraser
        modesRow.setAttribute('aria-label', titleStr);
        const bloodLabel = L('substance.blood');
        bloodModeBtn.setAttribute('aria-label', bloodLabel);
        bloodModeBtn.dataset.tooltip = bloodLabel;
        bloodModeBtn.setAttribute('aria-pressed', String(!isErase && !isSnow));
        snowModeBtn.style.display = snowAvail ? '' : 'none';
        const snowLabel = L('substance.snow');
        snowModeBtn.setAttribute('aria-label', snowLabel);
        snowModeBtn.dataset.tooltip = snowLabel;
        snowModeBtn.setAttribute('aria-pressed', String(!isErase && isSnow));
        const eraseLabel = L('erase');
        eraseModeBtn.setAttribute('aria-label', eraseLabel);
        eraseModeBtn.dataset.tooltip = eraseLabel;
        eraseModeBtn.setAttribute('aria-pressed', String(isErase));
        // Contextual snow depth strip (Plus only)
        snowTools.style.display = (snowAvail && !isErase && isSnow) ? '' : 'none';
        snowTools.setAttribute('aria-label', snowLabel);
        const curDepth = clamp(Math.round(Number(p.snowDepth) || 0), 0, 5);
        for (const btn of snowDepthBtns) {
            const d = Number(btn.dataset.snowDepth);
            const key = btn.dataset.snowKey;
            btn.setAttribute('aria-label', L(`snowDepth.${key}`));
            btn.dataset.tooltip = L(`snowDepthTip.${key}`);
            btn.setAttribute('aria-pressed', String(d === curDepth));
        }
        // Sliders + manual number inputs: mute Density & Opacity in-place on Erase
        densityCtl.row.classList.toggle('is-muted', isErase);
        alphaCtl.row.classList.toggle('is-muted', isErase);
        densityCtl.range.disabled = isErase;
        densityCtl.num.disabled = isErase;
        alphaCtl.range.disabled = isErase;
        alphaCtl.num.disabled = isErase;
        for (const [ctl, rawVal] of [[sizeCtl, p.size], [densityCtl, p.density], [alphaCtl, p.alpha]]) {
            const lblText = L(ctl.labelKey);
            ctl.lbl.setAttribute('aria-label', lblText);
            ctl.lbl.dataset.tooltip = lblText;
            ctl.range.setAttribute('aria-label', lblText);
            ctl.num.setAttribute('aria-label', lblText);
            const uiVal = ctl.toUI(rawVal);
            ctl.lastUi = uiVal;
            if (document.activeElement !== ctl.range) {
                ctl.range.value = String(uiVal);
                ctl.range.setAttribute('aria-valuetext', ctl.unit ? `${uiVal}${ctl.unit}` : String(uiVal));
            }
            if (document.activeElement !== ctl.num) {
                ctl.num.value = String(uiVal);
            }
        }
        // Bottom bar left controls
        const showBloodPalette = !isSnow && !(isErase && snowAvail);
        bloodPalette.style.display = showBloodPalette ? '' : 'none';
        bloodPalette.classList.toggle('is-muted', isErase && !snowAvail);
        const colorTip = L('color');
        colorPick.value = rgbHex;
        colorPick.setAttribute('aria-label', colorTip);
        colorPick.dataset.tooltip = colorTip;
        const curRgbLower = rgbHex.toLowerCase();
        for (const sw of swatchBtns) {
            const presetRgb = toRgbHex(sw.dataset.color).toLowerCase();
            sw.setAttribute('aria-pressed', String(!isErase && presetRgb === curRgbLower));
        }
        const noWashTip = L('noWash');
        noWashBtn.setAttribute('aria-label', noWashTip);
        noWashBtn.dataset.tooltip = noWashTip;
        noWashBtn.setAttribute('aria-pressed', String(Boolean(p.noWash)));
        snowSkirtBtn.style.display = (snowAvail && isSnow && !isErase) ? '' : 'none';
        const skirtApplicable = curDepth >= 3;
        snowSkirtBtn.setAttribute('aria-label', L('snowSkirt'));
        snowSkirtBtn.dataset.tooltip = L('snowSkirtTip');
        snowSkirtBtn.setAttribute('aria-pressed', String(Boolean(p.snowSkirt) && skirtApplicable));
        snowSkirtBtn.classList.toggle('is-muted', !skirtApplicable);
        eraseMatBtn.style.display = (isErase && snowAvail) ? '' : 'none';
        const eraseMatLabel = L('eraseOnlyMat').replace('{material}', subName);
        eraseMatBtn.setAttribute('aria-label', eraseMatLabel);
        eraseMatBtn.dataset.tooltip = `${eraseMatLabel} — ${L('eraseMatOnly')}`;
        eraseMatBtn.setAttribute('aria-pressed', String(Boolean(p.eraseMatOnly)));
        // Bottom bar right controls
        elevInputWrap.dataset.tooltip = L('elevManualTip');
        elevInputWrap.classList.toggle('active', p.elev !== 0);
        elevInput.setAttribute('aria-label', L('elevation'));
        if (document.activeElement !== elevInput) {
            elevInput.value = String(p.elev);
        }
        clearMatBtn.style.display = snowAvail ? '' : 'none';
        const clearMatTip = L('clearMaterialFmt').replace('{material}', subName);
        clearMatBtn.setAttribute('aria-label', clearMatTip);
        clearMatBtn.dataset.tooltip = clearMatTip;
        const clearAllTip = L('clearAll');
        clearBtn.setAttribute('aria-label', clearAllTip);
        clearBtn.dataset.tooltip = clearAllTip;
        root.style.display = '';
    };
    refresh();
    document.body.appendChild(root);
    onSnowAdapter(() => {
        if (!destroyed && root.isConnected)
            refresh();
    });
    return {
        element: root,
        refresh,
        destroy() {
            destroyed = true;
            dragging = null;
            root.remove();
        }
    };
}
