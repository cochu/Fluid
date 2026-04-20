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
 *   - colour    (assigned once per pointer-down; persists for the
 *                lifetime of the drag even if COLOR_MODE changes
 *                mid-stroke — each stroke is treated as one painterly
 *                gesture rather than a sequence of independent splats)
 *
 * Concurrency model: each pointerId has an independent state entry in
 * `_pointers`. A `lostpointercapture` listener evicts stale entries
 * when the system steals capture (browser back-gesture, scrollbar
 * drag, modal popping above the canvas) so `activePointerCount` stays
 * accurate.
 */

import { CONFIG } from '../config.js';
import { pickSplatColor } from './Palettes.js';

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
    // Stale-state guard: when the OS or browser steals pointer capture
    // (back-swipe gesture, scrollbar grab, alert popping above the
    // canvas) the next pointermove never arrives but pointerup also
    // doesn't fire. Without this listener `_pointers` would leak the
    // entry and `activePointerCount` would drift over time.
    c.addEventListener('lostpointercapture', this._onUp.bind(this));

    // Prevent default browser scroll / zoom on the canvas
    c.addEventListener('touchstart',   e => e.preventDefault(), { passive: false });
    c.addEventListener('touchmove',    e => e.preventDefault(), { passive: false });
  }

  _onDown(e) {
    e.preventDefault();
    this._canvas.setPointerCapture(e.pointerId);

    const uv = this._toUV(e);
    // Per-pointer hue offset: pickSplatColor is deterministic in the
    // time argument, so two simultaneous taps would otherwise pick the
    // same hue. Adding a slot-based offset (0.137·N — golden-ratio-ish
    // step around the colour wheel) keeps multi-touch visibly distinct.
    const slot = this._pointers.size;
    const tSec = performance.now() * 0.001 + slot * 0.137;
    const color = pickSplatColor(this._config.COLOR_MODE || 'rainbow', tSec);

    this._pointers.set(e.pointerId, {
      uv,
      color,
      moved: false,
      lastT: (typeof e.timeStamp === 'number' ? e.timeStamp : performance.now()),
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

    // Time-normalise the delta so the resulting velocity (in UV/s) does not
    // depend on the pointer event rate (60 Hz mice vs 120/240 Hz touchscreens
    // would otherwise produce dramatically different splat strengths).
    const nowT = (typeof e.timeStamp === 'number' ? e.timeStamp : performance.now());
    const eventDt = Math.max(1, nowT - (state.lastT || nowT)); // ms, clamped
    // Reference rate: 60 Hz ≈ 16.67 ms. Scale so a 16.67 ms gap reproduces
    // the legacy behaviour (delta * force) and faster events get a smaller
    // proportional boost rather than being summed up.
    const rateScale = 16.667 / eventDt;
    state.uv    = uv;
    state.lastT = nowT;
    state.moved = true;

    // Scale by configured force, modulated by the rate normaliser.
    const force = this._config.SPLAT_FORCE * rateScale;
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

  /** Return number of currently active pointers. */
  get activePointerCount() {
    return this._pointers.size;
  }
}
