/**
 * AccelerometerInput.js — Tilt-to-stir, off by default.
 *
 * Listens for `devicemotion`. The smoothed acceleration vector
 * (gravity + user motion) is converted into a continuous, gentle force
 * splat applied at the canvas centre, so tilting the device makes the
 * fluid drift in the tilt direction. A second, sharper component
 * derived from the *delta* of acceleration produces small "stir"
 * splats whenever the user shakes or jerks the device.
 *
 * Permission model:
 *   - On iOS 13+ (and any browser that exposes
 *     `DeviceMotionEvent.requestPermission`) we MUST request permission
 *     from a user gesture. The UI calls `start()` from a click handler,
 *     so the gesture chain is preserved.
 *   - On other browsers the API is available without a prompt.
 *
 * Output: drives the same `(x, y, dx, dy, color)` splat callback used
 * by InputHandler, so it joins the simulation through the standard
 * pipeline (and benefits from CONFIG.SPLAT_FORCE / palette).
 */

import { pickSplatColor } from './Palettes.js';

const TICK_MIN_MS    = 70;     // ≤ ~14 Hz tilt splats — keeps GPU cost negligible
const SHAKE_MIN_MS   = 110;    // shake splats are sharper, throttle separately
const SMOOTHING      = 0.18;   // EMA factor for the gravity vector
const SHAKE_THRESHOLD = 1.8;   // m/s² magnitude on the *delta* to trigger a stir splat
const TILT_DEADZONE   = 1.0;   // m/s² below this — treat device as flat, no stir

export class AccelerometerInput {
  /**
   * @param {(x:number,y:number,dx:number,dy:number,color:object)=>void} onSplat
   * @param {import('../config.js').CONFIG} config
   */
  constructor(onSplat, config) {
    this._onSplat = onSplat;
    this._config  = config;

    this._enabled = false;
    this._gx = 0; this._gy = 0;        // smoothed acceleration (incl. gravity)
    this._lastTilt  = 0;
    this._lastShake = 0;

    this._onMotion = this._onMotion.bind(this);
  }

  /** Whether the runtime exposes `devicemotion` at all. */
  static isSupported() {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  }

  /**
   * Request permission (iOS) and start listening.
   * @returns {Promise<boolean>} true once enabled.
   * @throws if the user denies permission, or no support.
   */
  async start() {
    if (!AccelerometerInput.isSupported()) {
      throw new Error('Device motion not supported');
    }
    const Req = window.DeviceMotionEvent && window.DeviceMotionEvent.requestPermission;
    if (typeof Req === 'function') {
      let r;
      try { r = await Req.call(window.DeviceMotionEvent); }
      catch (e) { throw new Error('Motion permission failed: ' + (e?.message || e)); }
      if (r !== 'granted') throw new Error('Motion permission denied');
    }
    window.addEventListener('devicemotion', this._onMotion, { passive: true });
    this._enabled = true;
    this._config.TILT_REACTIVE = true;
    return true;
  }

  stop() {
    if (this._enabled) {
      window.removeEventListener('devicemotion', this._onMotion);
    }
    this._enabled = false;
    this._gx = 0; this._gy = 0;
    this._config.TILT_REACTIVE = false;
  }

  get enabled() { return this._enabled; }

  /* ── Internals ─────────────────────────────────────────────────── */

  _onMotion(e) {
    const ag = e.accelerationIncludingGravity || e.acceleration;
    if (!ag || ag.x == null || ag.y == null) return;
    // Track delta-of-smoothed for shake detection BEFORE updating the EMA.
    const prevX = this._gx, prevY = this._gy;
    this._gx = lerp(this._gx, ag.x, SMOOTHING);
    this._gy = lerp(this._gy, ag.y, SMOOTHING);
    const dx = this._gx - prevX;
    const dy = this._gy - prevY;
    const shakeMag = Math.hypot(dx, dy) / SMOOTHING; // un-damp to get raw delta
    if (shakeMag > SHAKE_THRESHOLD) this._maybeShake(dx, dy, shakeMag);
  }

  /**
   * Continuous tilt-driven drift splat, called from the main loop so
   * we don't depend on the (variable, sometimes 60+ Hz) devicemotion rate.
   * Cheap no-op when disabled.
   */
  tick(now) {
    if (!this._enabled) return;
    if (now - this._lastTilt < TICK_MIN_MS) return;
    const mag = Math.hypot(this._gx, this._gy);
    if (mag < TILT_DEADZONE) return;
    this._lastTilt = now;

    // Map device axes → canvas UV. Device X tilts right (+X) → fluid
    // should drift right (+UV.x). Device Y tilts toward the user (+Y)
    // → fluid drifts down screen (−UV.y in our flipped UV).
    // Force = SPLAT_FORCE * tilt_unit * 0.55 (gentle continuous drift).
    const unitX =  this._gx / mag;
    const unitY = -this._gy / mag;
    const f     = this._config.SPLAT_FORCE * Math.min(1, mag / 9.81) * 0.55;

    const color = pickSplatColor(this._config.COLOR_MODE || 'rainbow', now * 0.001);
    this._onSplat(0.5, 0.5, unitX * f, unitY * f, color);
  }

  _maybeShake(dx, dy, mag) {
    const now = performance.now();
    if (now - this._lastShake < SHAKE_MIN_MS) return;
    this._lastShake = now;

    // Random position so repeated shakes don't drill the same spot.
    const x = 0.3 + Math.random() * 0.4;
    const y = 0.3 + Math.random() * 0.4;
    const k = Math.min(2.0, mag / SHAKE_THRESHOLD);
    const f = this._config.SPLAT_FORCE * 0.9 * k;
    const ang = Math.atan2(-dy, dx) + (Math.random() - 0.5) * 0.4;
    const fx = Math.cos(ang) * f;
    const fy = Math.sin(ang) * f;

    const color = pickSplatColor(this._config.COLOR_MODE || 'rainbow', now * 0.001);
    this._onSplat(x, y, fx, fy, color);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
