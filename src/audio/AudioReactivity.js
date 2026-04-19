/**
 * AudioReactivity.js – Microphone-driven splat generator.
 *
 * High-level idea
 * ---------------
 * The simulation already turns any radially-symmetric burst of velocity
 * splats into a clean expanding ring — that is exactly the visual the
 * user describes ("a big round wave like a speaker in the middle"). So
 * rather than invent a new shader path we:
 *
 *   1. Capture the microphone with `getUserMedia({ audio })`.
 *   2. Run the signal through an `AnalyserNode` (FFT bins).
 *   3. Each animation frame, integrate the energy in the bass band
 *      (~20–200 Hz). Smooth it and maintain an adaptive baseline so the
 *      detector self-calibrates to ambient room noise.
 *   4. When the instantaneous bass clearly exceeds the baseline *and* a
 *      refractory window has elapsed, emit N radial velocity+dye splats
 *      from the canvas center pointing outward. The existing pressure
 *      solve takes care of producing the speaker-like wave.
 *
 * The module is fully self-contained: the simulation, particle system
 * and UI don't need to know audio exists. It is wired into `main.js`
 * exactly the same way the pointer input is wired — by being given the
 * same `splat()` callback.
 *
 * Permissions are intentionally requested lazily (only when the user
 * toggles the feature on), and the module degrades gracefully when:
 *   - the Web Audio API is missing,
 *   - the user denies the permission,
 *   - the page is not served over a secure context.
 */

export class AudioReactivity {
  /**
   * @param {(x:number,y:number,dx:number,dy:number,c:{r:number,g:number,b:number})=>void} splatFn
   *        Callback used to inject a splat into the simulation. Same
   *        signature as `FluidSimulation.splat`.
   * @param {import('../config.js').CONFIG} config Shared live config object
   */
  constructor(splatFn, config) {
    this._splat   = splatFn;
    this._config  = config;

    this._ctx       = null;   // AudioContext
    this._analyser  = null;   // AnalyserNode
    this._stream    = null;   // MediaStream
    this._source    = null;   // MediaStreamAudioSourceNode
    this._freqData  = null;   // Uint8Array – FFT magnitude buffer

    /** Slow EMA of raw bass energy — our adaptive noise floor. */
    this._baseline   = 0;
    /** Slow EMA of (energy - baseline)² — running variance for adaptive σ. */
    this._variance   = 1e-4;
    /** Fast EMA of raw bass energy — used for the trigger test and VU meter. */
    this._smoothed   = 0;
    /** Slow envelope follower (peak-decay) — used to render the VU meter. */
    this._envelope   = 0;
    /** Threshold value last evaluated, exposed via `threshold` for the UI. */
    this._lastThreshold = 0;
    /** Monotonic count of beats emitted (UI uses this to detect new beats). */
    this._beatCount  = 0;
    /** Timestamp (ms) of the last beat we emitted. Used for refractory. */
    this._lastBeatMs = 0;
    /** Timestamp (ms) at which capture started — used for a brief calibration window. */
    this._startMs    = 0;

    /** Resolved when audio is fully running, rejected on failure. */
    this._readyP = null;
  }

  /**
   * Current smoothed bass level (0..1). Cheap and safe to call every frame
   * even when audio is off — returns 0 in that case. Drives the VU meter.
   */
  get level()     { return this._smoothed; }
  /** Slow envelope follower (0..1) — for a "peak hold" indicator. */
  get envelope()  { return this._envelope; }
  /** Current adaptive trigger level (0..1). For VU meter / debugging. */
  get threshold() { return this._lastThreshold; }
  /** Monotonically-increasing count of detected beats since start. */
  get beatCount() { return this._beatCount; }

  /** Whether audio capture is currently active. */
  get isActive() {
    return this._ctx !== null && this._ctx.state === 'running';
  }

  /**
   * Request the microphone and start the analyser. Safe to call multiple
   * times — subsequent calls are no-ops while already active.
   *
   * @returns {Promise<void>} resolves once the analyser is wired up.
   */
  async start() {
    if (this.isActive) return;
    if (this._readyP) return this._readyP;

    this._readyP = (async () => {
      if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia not supported');
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API not supported');

      // Disable any automatic processing — we WANT raw bass.
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        },
        video: false,
      });

      this._ctx       = new AC();
      // Some browsers start the context suspended (autoplay policy).
      if (this._ctx.state === 'suspended') {
        try { await this._ctx.resume(); } catch (_) { /* best-effort */ }
      }

      this._source   = this._ctx.createMediaStreamSource(this._stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize               = 1024;          // 1024 samples → 512 frequency bins
      this._analyser.smoothingTimeConstant = 0.6;           // light internal EMA
      this._analyser.minDecibels           = -90;
      this._analyser.maxDecibels           = -10;

      this._source.connect(this._analyser);
      // NOTE: we do NOT connect to ctx.destination – we never want feedback.

      this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
      this._startMs   = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    })();

    try {
      await this._readyP;
    } catch (err) {
      this._readyP = null;
      this.stop();
      throw err;
    }
  }

  /** Stop capture, release the mic, free the audio graph. */
  stop() {
    this._readyP = null;
    if (this._stream) {
      for (const t of this._stream.getTracks()) {
        try { t.stop(); } catch (_) { /* noop */ }
      }
      this._stream = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch (_) { /* noop */ }
      this._source = null;
    }
    if (this._analyser) {
      try { this._analyser.disconnect(); } catch (_) { /* noop */ }
      this._analyser = null;
    }
    if (this._ctx) {
      try { this._ctx.close(); } catch (_) { /* noop */ }
      this._ctx = null;
    }
    this._freqData      = null;
    this._smoothed      = 0;
    this._envelope      = 0;
    this._baseline      = 0;
    this._variance      = 1e-4;
    this._lastThreshold = 0;
    this._lastBeatMs    = 0;
    this._beatCount     = 0;
    this._startMs       = 0;
  }

  /**
   * Drive one frame of analysis and emit a radial speaker-wave when a
   * bass beat is detected. Should be called from the main animation
   * loop; cheap when audio is inactive.
   *
   * @param {number} nowMs `performance.now()` of the current frame
   */
  tick(nowMs) {
    if (!this.isActive || !this._analyser || !this._freqData) return;
    if (!this._config.AUDIO_REACTIVE) return;

    const cfg = this._config;
    this._analyser.getByteFrequencyData(this._freqData);

    // ── 1. Average energy across the bass band ─────────────────────
    const sr        = this._ctx.sampleRate;
    const binHz     = sr / this._analyser.fftSize;
    const lo        = Math.max(1, Math.floor(cfg.AUDIO_BASS_LOW_HZ  / binHz));
    const hi        = Math.min(this._freqData.length - 1,
                               Math.ceil (cfg.AUDIO_BASS_HIGH_HZ / binHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this._freqData[i];
    const energy = (sum / Math.max(1, hi - lo + 1)) / 255; // 0..1

    // ── 2. Smoothed signal + slow envelope follower (for VU meter) ─
    //
    // `_smoothed` is the trigger / display signal: a fast EMA so transients
    // are visible. `_envelope` is a peak-decay follower used purely for the
    // UI peak-hold indicator.
    this._smoothed = this._smoothed * 0.55 + energy * 0.45;
    this._envelope = Math.max(this._envelope * 0.92, this._smoothed);

    // ── 3. Adaptive baseline (μ) and variance (σ²) of RAW energy ──
    //
    // CRITICAL: we feed the slow estimators with the *raw* `energy` — not
    // `_smoothed` — and we FREEZE them during the refractory window after a
    // beat. The previous implementation fed the baseline with `_smoothed`,
    // which contains the burst itself; after a few beats the baseline
    // chased the bursts up to ~1.5× its starting value and the ratio test
    // never fired again ("5 strong pulses then nothing"). Decoupling and
    // freezing the estimator means the baseline tracks ambient room noise
    // only, exactly like every published adaptive beat detector.
    const sinceBeat   = nowMs - this._lastBeatMs;
    const inRefract   = sinceBeat < cfg.AUDIO_REFRACTORY_MS;
    const calibrating = (nowMs - this._startMs) < (cfg.AUDIO_CALIBRATION_MS || 0);

    if (!inRefract) {
      // Slow EMA over ~3 s @ 60 fps. Asymmetric: rises slower than it
      // falls, so a sudden quiet section recalibrates quickly without the
      // baseline being inflated by the next loud passage.
      const rise = 0.005;
      const fall = 0.05;
      const k = energy > this._baseline ? rise : fall;
      this._baseline = this._baseline + k * (energy - this._baseline);

      // Welford-style variance EMA (same time constant as baseline rise).
      const dev = energy - this._baseline;
      this._variance = this._variance * (1 - rise) + dev * dev * rise;
    }

    // ── 4. Adaptive trigger level: μ + k·σ, clamped by ratio + floor ──
    //
    // `μ + k·σ` is the standard adaptive rule and behaves correctly
    // whether the room is quiet (small σ → low threshold, sensitive) or
    // noisy (large σ → high threshold, robust). We additionally enforce
    // the historical ratio (`baseline * sens`) and absolute noise floor.
    const sigma     = Math.sqrt(this._variance);
    const sigmaK    = cfg.AUDIO_SIGMA_K !== undefined ? cfg.AUDIO_SIGMA_K : 2.5;
    const ratio     = cfg.AUDIO_SENSITIVITY;
    const floor     = cfg.AUDIO_NOISE_FLOOR;
    const refract   = cfg.AUDIO_REFRACTORY_MS;
    const threshold = Math.max(
      floor,
      this._baseline * ratio,
      this._baseline + sigmaK * sigma
    );
    this._lastThreshold = threshold;

    const isBeat   = !calibrating
                   && this._smoothed > threshold
                   && sinceBeat > refract;

    if (!isBeat) return;
    this._lastBeatMs = nowMs;
    this._beatCount++;

    // After a beat, drain the smoothed signal toward the baseline. Without
    // this, a sustained loud note would keep `_smoothed` high above the
    // threshold and we'd retrigger on every frame after the refractory
    // window expires, smearing the visual into a continuous blob. Draining
    // forces the next trigger to require a fresh transient.
    this._smoothed = this._baseline;

    // ── 5. Emit a radial burst from canvas center ──────────────────
    //
    // Magnitude scales super-linearly with the headroom over the trigger
    // level so a stronger kick produces a visibly larger ring. The
    // user-facing SPLAT_FORCE slider still acts as a global gain.
    const headroom = Math.min(3.0, energy / Math.max(0.01, threshold));
    const mag      = cfg.SPLAT_FORCE * cfg.AUDIO_GAIN * headroom;

    const n = cfg.AUDIO_SPLAT_COUNT | 0;
    // Random phase offset so successive rings don't perfectly overlap
    // (avoids a stationary aliasing pattern on sustained bass).
    const phase = Math.random() * Math.PI * 2;

    // Pick a single colour per ring so the wave reads as one event,
    // and cycle the hue from the audio energy itself.
    const hue = (nowMs * 0.0002 + energy * 4) % 1;
    const color = hsvToRgb(hue, 0.9, cfg.DYE_BRIGHTNESS * (1 + headroom));

    for (let i = 0; i < n; i++) {
      const a  = phase + (i / n) * Math.PI * 2;
      const dx = Math.cos(a) * mag;
      const dy = Math.sin(a) * mag;
      // Splats originate from a tiny ring around the centre rather than
      // a single point – this gives the solver an actual circular
      // pressure source instead of a spike that would advect into a
      // cross. The radius is small so the resulting wave still looks
      // centered on the screen.
      const r  = 0.02;
      const x  = 0.5 + Math.cos(a) * r;
      const y  = 0.5 + Math.sin(a) * r;
      this._splat(x, y, dx, dy, color);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Local HSV→RGB helper (kept inline to avoid a new util module).
   h, s, v are all in [0, 1]; output components are in linear-ish [0, +∞)
   matching the rest of the project's "dye" colour conventions.
   ────────────────────────────────────────────────────────────────────── */
function hsvToRgb(h, s, v) {
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
    default:return { r: v, g: p, b: q };
  }
}
