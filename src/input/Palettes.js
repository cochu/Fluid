/**
 * Palettes.js — Color-mode palettes for splats and particle tinting.
 *
 * A "color mode" picks an RGB triple for each new splat. All splat
 * colors returned by `pickSplatColor` are pre-multiplied by
 * `CONFIG.DYE_BRIGHTNESS` so they layer correctly with the rest of the
 * dye field (peak ≈ 0.15).
 *
 * Modes:
 *   - 'rainbow' : independent random hue per splat (legacy behavior)
 *   - 'cycle'   : slow time-based hue rotation; consecutive splats are
 *                 close in hue, full spectrum sweep ~30 s
 *   - 'ocean'   : cyan / teal / deep-blue range
 *   - 'sunset'  : red / orange / magenta range
 *   - 'magma'   : yellow → red → deep purple
 *   - 'forest'  : greens with a hint of teal
 *   - 'mono'    : pale cyan, near-white (no tint variation)
 *
 * `paletteAccent` returns a *non-brightness-scaled* representative RGB
 * for the active mode — used by ParticleSystem to bias the droplet
 * tint toward whatever palette is in play.
 */

import { CONFIG } from '../config.js';

export const COLOR_MODES = ['rainbow', 'cycle', 'ocean', 'sunset', 'magma', 'forest', 'mono'];

export const COLOR_MODE_LABELS = {
  rainbow: 'Palette: Random hue',
  cycle:   'Palette: Slow rainbow',
  ocean:   'Palette: Ocean',
  sunset:  'Palette: Sunset',
  magma:   'Palette: Magma',
  forest:  'Palette: Forest',
  mono:    'Palette: Aqua mono',
};

/** Standard HSV → linear RGB. */
function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return { r: v, g: t, b: p };
    case 1: return { r: q, g: v, b: p };
    case 2: return { r: p, g: v, b: t };
    case 3: return { r: p, g: q, b: v };
    case 4: return { r: t, g: p, b: v };
    case 5: return { r: v, g: p, b: q };
  }
  return { r: v, g: v, b: v };
}

/** Pick a hue (in [0,1)) for a new splat in the given mode. */
function pickHue(mode, tSec) {
  const r = Math.random();
  switch (mode) {
    case 'rainbow': return r;
    case 'cycle':   return ((tSec / 30) + (r - 0.5) * 0.04) % 1;     // ±~14° jitter around the moving hue
    case 'ocean':   return 0.50 + (r - 0.5) * 0.20;                  // 0.40..0.60 (teal..blue)
    case 'sunset':  return r < 0.5 ? r * 0.20 : 0.90 + (r - 0.5) * 0.20; // 0..0.10 ∪ 0.90..1.00
    case 'magma':   return r < 0.7 ? r * 0.18 / 0.7 : 0.78 + (r - 0.7) * 0.20 / 0.3; // 0..0.18 ∪ 0.78..0.98
    case 'forest':  return 0.30 + (r - 0.5) * 0.16;                  // 0.22..0.38
    case 'mono':    return 0.50;
    default:        return r;
  }
}

function modeBaseSat(mode) {
  if (mode === 'mono')  return 0.18;
  if (mode === 'magma') return 0.96;
  return 0.90;
}

/**
 * Pick a splat color (already brightness-scaled by CONFIG.DYE_BRIGHTNESS).
 * @param {string} mode  one of COLOR_MODES
 * @param {number} tSec  performance.now()/1000 — used by 'cycle' mode
 */
export function pickSplatColor(mode, tSec) {
  const h = pickHue(mode, tSec);
  const s = Math.max(0, Math.min(1, modeBaseSat(mode) + (Math.random() - 0.5) * 0.08));
  const v = mode === 'mono' ? 1.0 : 0.94 + Math.random() * 0.06;
  const rgb = hsv(h, s, v);
  const k = CONFIG.DYE_BRIGHTNESS;
  return { r: rgb.r * k, g: rgb.g * k, b: rgb.b * k };
}

/**
 * Representative palette color (NOT brightness-scaled). Used by
 * ParticleSystem to tint the droplets toward the active palette.
 * Returns a stable mid-tone per mode; 'cycle'/'rainbow' rotate slowly.
 */
export function paletteAccent(mode, tSec) {
  switch (mode) {
    case 'rainbow': return hsv((tSec * 0.05) % 1,    0.70, 1.0);
    case 'cycle':   return hsv((tSec / 30)    % 1,   0.80, 1.0);
    case 'ocean':   return hsv(0.52,                 0.70, 1.0);
    case 'sunset':  return hsv(0.04,                 0.85, 1.0);
    case 'magma':   return hsv(0.08,                 0.95, 1.0);
    case 'forest':  return hsv(0.33,                 0.70, 1.0);
    case 'mono':    return hsv(0.50,                 0.05, 1.0);   // near white
    default:        return hsv(0.50,                 0.50, 1.0);
  }
}

/** How strongly the particle shader should bend toward the palette accent. */
export function paletteTintStrength(mode) {
  return mode === 'mono' ? 0.0 : 0.55;
}

/** Cycle to the next mode in COLOR_MODES order. */
export function nextMode(current) {
  const i = COLOR_MODES.indexOf(current);
  return COLOR_MODES[(i + 1) % COLOR_MODES.length];
}
