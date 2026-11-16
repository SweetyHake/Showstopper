/**
 * Blood color parsing and derived color utilities.
 *
 * Storage format is '#rrggbbaa' (matching Splatter's `flags.splatter.bloodColor`
 * flag and `bloodColor` setting).
 */
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX4 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
// Parse memoization: parseColor is called for EVERY stain on EVERY chunk bake
// (regex + object) — at 5-10k stains during a full bake, that creates tens of thousands
// of short-lived objects and GC sawtoothing. Unique colors per scene are just a handful.
const _memo = new Map();
const MEMO_MAX = 128;
/**
 * '#a51414d8' | '#a51414' | '#f00' | '0xa51414' → { r, g, b, a } or null.
 */
export function parseColor(input) {
    if (typeof input !== 'string' || !input)
        return null;
    const hit = _memo.get(input);
    if (hit !== undefined)
        return hit;
    let out = null;
    let s = input.trim();
    if (s.startsWith('0x') || s.startsWith('0X'))
        s = `#${s.slice(2)}`;
    let m;
    if ((m = HEX8.exec(s))) {
        out = { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: parseInt(m[4], 16) / 255 };
    }
    else if ((m = HEX6.exec(s))) {
        out = { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
    }
    else if ((m = HEX4.exec(s))) {
        out = {
            r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16),
            a: parseInt(m[4] + m[4], 16) / 255
        };
    }
    else if ((m = HEX3.exec(s))) {
        out = {
            r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16),
            a: 1
        };
    }
    // Malformed strings are NOT cached (unique garbage strings could be unbounded).
    // Overflow uses FIFO eviction of the oldest entry, NOT full clear(): drying
    // produces derived colors, and a full wipe would evict the base palette.
    if (out) {
        if (_memo.size >= MEMO_MAX)
            _memo.delete(_memo.keys().next().value);
        _memo.set(input, out);
    }
    return out;
}
const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const h2 = (v) => HEX_BYTE[Math.max(0, Math.min(255, Math.round(v)))];
export function toHex8(c) {
    return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}${h2((c.a ?? 1) * 255)}`;
}
/** Lighten (k > 0) / darken (k < 0); leaves alpha untouched. */
export function shadeHex(color, k) {
    const c = typeof color === 'string' ? parseColor(color) : color;
    if (!c)
        return '#ffffff';
    const t = k < 0 ? 0 : 255;
    const p = Math.abs(k);
    return `#${h2(c.r + (t - c.r) * p)}${h2(c.g + (t - c.g) * p)}${h2(c.b + (t - c.b) * p)}`;
}
/**
 * Blend two colors (hex strings or {r,g,b}) by ratio t (0 = a, 1 = b).
 * Alpha interpolates from a toward b: `a * (1 - t) + b.a * t` (blood color tinted by damage).
 */
export function mixHex(ca, cb, t) {
    const a = typeof ca === 'string' ? parseColor(ca) : ca;
    const b = typeof cb === 'string' ? parseColor(cb) : cb;
    if (!a)
        return typeof cb === 'string' ? cb : toHex8(cb);
    if (!b)
        return typeof ca === 'string' ? ca : toHex8(ca);
    const q = Math.max(0, Math.min(1, t));
    return toHex8({
        r: a.r + (b.r - a.r) * q,
        g: a.g + (b.g - a.g) * q,
        b: a.b + (b.b - a.b) * q,
        a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * q
    });
}
