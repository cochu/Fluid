/**
 * AccelerometerInput.js — Tilt-to-stir, off by default.
 *
 * Two outputs, blended at the consumer side:
 *
 *   1. **Body force.** A continuous, uniform force vector (UV/s²) computed
 *      from the *delta* between the smoothed acceleration and a baseline
 *      captured when the user first enables tilt. The baseline is the device
 *      orientation at activation — *not* "phone flat" — so the user holds
 *      the phone however they like, and any subsequent tilt drifts the
 *      whole grid in that direction. Consumed by `fluid.applyBodyForce`,
 *      so the entire field reacts uniformly (no central splat).
 *
 *   2. **Shake stir splat.** Sudden jerks (high delta-of-smoothed
 *      magnitude) emit a single splat at a random position to let the
 *      user "shake the dye loose". Throttled.
 *
 * Permission model: `start()` must be called from a user gesture so the
 * iOS `requestPermission()` chain succeeds.
 */

import { pickSplatColor } from './Palettes.js';

const TICK_MIN_MS         = 33;     // body-force update rate cap (~30 Hz; cheap)
const SHAKE_MIN_MS        = 110;    // shake stir splat throttle
const SMOOTHING           = 0.18;   // EMA factor for the gravity-included accel
const SHAKE_THRESHOLD     = 1.8;    // m/s² magnitude on the *delta* to trigger a stir
const CALIBRATION_MS_DEF  = 450;    // baseline averaging window
const TILT_DEADZONE       = 0.25;   // m/s² delta below this — treat as still
const MAX_TILT            = 5.0;    // m/s² delta above this — saturate (gentle ceiling)

export class AccelerometerInput {
  /**
   * @param {(x:number,y:number,dx:number,dy:number,color:object)=>void} onSplat
   *   Used by the shake-stir code path only.
   * @param {import('../config.js').CONFIG} config
   */
  constructor(onSplat, config) {
    this._onSplat = onSplat;
    this._config  = config;

    this._enabled    = false;
    this._gx = 0; this._gy = 0;          // smoothed acceleration (incl. gravity)
    this._haveSample = false;            // first sample seeds the EMA without lerp
    this._lastShake  = 0;
    this._lastTick   = 0;

    // Calibration state
    this._calStart   = 0;                // performance.now() at start() time
    this._calSumX    = 0;
    this._calSumY    = 0;
    this._calCount   = 0;
    this._baselineX  = 0;
    this._baselineY  = 0;
    this._calibrated = false;

    // Public continuous body-force (UV/s²). Read by main.js each frame.
    this.bodyForceX = 0;
    this.bodyForceY = 0;

    this._onMotion = this._onMotion.bind(this);
  }

  static isSupported() {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  }

  /**
   * Request permission (iOS) and start listening. Begins a short
   * calibration window (TILT_CALIBRATION_MS) during which no force is
   * applied — the device's resting acceleration vector is captured as
   * the new "zero" so subsequent tilt is measured as a delta from
   * however the user is currently holding the device.
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
    this._enabled    = true;
    this._haveSample = false;
    this._calibrated = false;
    this._calStart   = performance.now();
    this._calSumX = this._calSumY = 0;
    this._calCount = 0;
    this.bodyForceX = this.bodyForceY = 0;
    this._config.TILT_REACTIVE = true;
    return true;
  }

  stop() {
    if (this._enabled) {
      window.removeEventListener('devicemotion', this._onMotion);
    }
    this._enabled = false;
    this._gx = this._gy = 0;
    this._calibrated = false;
    this.bodyForceX = this.bodyForceY = 0;
    this._config.TILT_REACTIVE = false;
  }

  /** Re-arm calibration in place (button on the UI could expose this later). */
  recalibrate() {
    if (!this._enabled) return;
    this._calibrated = false;
    this._calStart   = performance.now();
    this._calSumX = this._calSumY = 0;
    this._calCount = 0;
    this.bodyForceX = this.bodyForceY = 0;
  }

  get enabled()    { return this._enabled; }
  get calibrated() { return this._calibrated; }

  /* ── Internals ─────────────────────────────────────────────────── */

  _onMotion(e) {
    const ag = e.accelerationIncludingGravity || e.acceleration;
    if (!ag || ag.x == null || ag.y == null) return;

    // Seed EMA with the first sample so the smoothed value doesn't
    // ramp up from 0 over the first ~6 samples (which would otherwise
    // pollute the calibration mean).
    if (!this._haveSample) {
      this._gx = ag.x;
      this._gy = ag.y;
      this._haveSample = true;
    } else {
      const prevX = this._gx, prevY = this._gy;
      this._gx = lerp(this._gx, ag.x, SMOOTHING);
      this._gy = lerp(this._gy, ag.y, SMOOTHING);
      // Shake = un-damped delta magnitude. Only count after calibration —
      // the calibration phase otherwise produces a spurious shake on the
      // very first sample whose magnitude is dominated by gravity itself.
      if (this._calibrated) {
        const dx = this._gx - prevX;
        const dy = this._gy - prevY;
        const shakeMag = Math.hypot(dx, dy) / SMOOTHING;
        if (shakeMag > SHAKE_THRESHOLD) this._maybeShake(dx, dy, shakeMag);
      }
    }

    // Calibration accumulator
    if (!this._calibrated) {
      this._calSumX += this._gx;
      this._calSumY += this._gy;
      this._calCount++;
      const win = this._config.TILT_CALIBRATION_MS || CALIBRATION_MS_DEF;
      if (performance.now() - this._calStart >= win && this._calCount >= 4) {
        this._baselineX = this._calSumX / this._calCount;
        this._baselineY = this._calSumY / this._calCount;
        this._calibrated = true;
      }
    }
  }

  /**
   * Update the body-force vector exposed via `bodyForceX/Y`. Throttled to
   * ~30 Hz to keep the JS-side cost negligible — the *application* of the
   * force happens in main.js once per render frame, so the body force only
   * needs to be fresh at frame rate, not at sensor rate.
   *
   * @param {number} now performance.now()
   */
  tick(now) {
    if (!this._enabled || !this._calibrated) return;
    if (now - this._lastTick < TICK_MIN_MS) return;
    this._lastTick = now;

    // Delta from baseline (device-frame, m/s²).
    const dx = this._gx - this._baselineX;
    const dy = this._gy - this._baselineY;

    const mag = Math.hypot(dx, dy);
    if (mag < TILT_DEADZONE) {
      this.bodyForceX = this.bodyForceY = 0;
      return;
    }

    // Soft saturation past MAX_TILT — keeps a violent flip from launching
    // the field. Linear clamp on the magnitude, normalised direction.
    const sat = Math.min(1, mag / MAX_TILT);
    let ux  = dx / mag;
    let uy  = dy / mag;

    // Remap device-frame axes to screen-frame using the current orientation
    // angle. Without this, landscape/upside-down holds steer the fluid
    // sideways or backwards relative to what the eye expects.
    const ang = (typeof screen !== 'undefined' && screen.orientation
                  && typeof screen.orientation.angle === 'number')
                ? (screen.orientation.angle * Math.PI / 180)
                : 0;
    if (ang !== 0) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const rx =  c * ux + s * uy;
      const ry = -s * ux + c * uy;
      ux = rx; uy = ry;
    }

    const gain = (this._config.TILT_BODY_FORCE_GAIN || 0.05);
    // Direction (portrait, screen UV.y=1 = top):
    //   • Tip phone right (+ag.x) → liquid pours right → fx > 0 → +ux.
    //   • Tip top forward, away from user (+ag.y delta from upright
    //     baseline) → liquid pours toward the top edge of the screen
    //     → fy > 0 → +uy.
    this.bodyForceX = ux * sat * MAX_TILT * gain;
    this.bodyForceY = uy * sat * MAX_TILT * gain;
  }

  _maybeShake(dx, dy, mag) {
    const now = performance.now();
    if (now - this._lastShake < SHAKE_MIN_MS) return;
    this._lastShake = now;

    const x = 0.3 + Math.random() * 0.4;
    const y = 0.3 + Math.random() * 0.4;
    const k = Math.min(2.0, mag / SHAKE_THRESHOLD);
    const f = this._config.SPLAT_FORCE * 0.7 * k;
    const ang = Math.atan2(-dy, dx) + (Math.random() - 0.5) * 0.4;
    const fx = Math.cos(ang) * f;
    const fy = Math.sin(ang) * f;

    const color = pickSplatColor(this._config.COLOR_MODE || 'rainbow', now * 0.001);
    this._onSplat(x, y, fx, fy, color);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
