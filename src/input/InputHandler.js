/**
 * InputHandler.js – Unified pointer / touch input for the fluid simulation.
 *
 * Uses the Pointer Events API which covers both mouse and touch in one
 * consistent interface.  Multi-pointer is fully supported.
 *
 * For each pointer we track:
 *   - current   position (UV [0,1])
 *   - previous  position (UV [0,1])
 *   - delta     (UV/s velocity)
 *   - colour    (assigned once per pointer-down)
 */

import { CONFIG } from '../config.js';

export class InputHandler {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Function} onSplat   Called with (x, y, dx, dy, color) for each active pointer
   * @param {import('../config.js').CONFIG} config
   */
  constructor(canvas, onSplat, config) {
    this._canvas  = canvas;
    this._onSplat = onSplat;
    this._config  = config;

    /** Map from pointerId → pointer state */
    this._pointers = new Map();

    this._bindEvents();
  }

  /* ──────────────────────────────────────────────────────────────────
     Event binding
     ────────────────────────────────────────────────────────────────── */

  _bindEvents() {
    const c = this._canvas;

    c.addEventListener('pointerdown',  this._onDown.bind(this),  { passive: false });
    c.addEventListener('pointermove',  this._onMove.bind(this),  { passive: false });
    c.addEventListener('pointerup',    this._onUp.bind(this),    { passive: false });
    c.addEventListener('pointercancel',this._onUp.bind(this),    { passive: false });

    // Prevent default browser scroll / zoom on the canvas
    c.addEventListener('touchstart',   e => e.preventDefault(), { passive: false });
    c.addEventListener('touchmove',    e => e.preventDefault(), { passive: false });
  }

  _onDown(e) {
    e.preventDefault();
    this._canvas.setPointerCapture(e.pointerId);

    const uv    = this._toUV(e);
    const color = this._randomColor();

    this._pointers.set(e.pointerId, {
      uv,
      color,
      moved: false,
    });
  }

  _onMove(e) {
    e.preventDefault();
    const state = this._pointers.get(e.pointerId);
    if (!state) return;

    const uv = this._toUV(e);

    // Compute delta against the previous pointer position (not a stale one).
    const dx = uv.x - state.uv.x;
    const dy = uv.y - state.uv.y;

    state.uv    = uv;
    state.moved = true;

    // Scale by configured force
    const force = this._config.SPLAT_FORCE;
    this._onSplat(uv.x, uv.y, dx * force, dy * force, state.color);
  }

  _onUp(e) {
    this._pointers.delete(e.pointerId);
  }

  /* ──────────────────────────────────────────────────────────────────
     Helpers
     ────────────────────────────────────────────────────────────────── */

  /** Convert a pointer event to canvas UV coords [0,1]. */
  _toUV(e) {
    const rect = this._canvas.getBoundingClientRect();
    return {
      x:  (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height,   // flip Y (UV origin = bottom-left)
    };
  }

  /** Generate a bright, saturated random colour for a new pointer. */
  _randomColor() {
    const h  = Math.random();
    const s  = 0.9 + Math.random() * 0.1;
    return hsvToRgb(h, s, 1.0);
  }

  /** Return number of currently active pointers. */
  get activePointerCount() {
    return this._pointers.size;
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Colour helper (local copy to avoid circular imports)
   ────────────────────────────────────────────────────────────────────── */

function hsvToRgb(h, s, v) {
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  // Dimmed so they blend nicely in the fluid (CONFIG.DYE_BRIGHTNESS)
  return { r: r * CONFIG.DYE_BRIGHTNESS, g: g * CONFIG.DYE_BRIGHTNESS, b: b * CONFIG.DYE_BRIGHTNESS };
}
