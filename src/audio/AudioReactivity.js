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

    /** Smoothed running baseline of the bass-band energy (0..1). */
    this._baseline   = 0.05;
    /** Smoothed instantaneous bass energy (0..1). */
    this._smoothed   = 0;
    /** Timestamp (ms) of the last beat we emitted. Used for refractory. */
    this._lastBeatMs = 0;

    /** Resolved when audio is fully running, rejected on failure. */
    this._readyP = null;
  }

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
      this._analyser.fftSize               = 1024;          // 512 bins
      this._analyser.smoothingTimeConstant = 0.6;           // light internal EMA
      this._analyser.minDecibels           = -90;
      this._analyser.maxDecibels           = -10;

      this._source.connect(this._analyser);
      // NOTE: we do NOT connect to ctx.destination – we never want feedback.

      this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
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
    this._freqData   = null;
    this._smoothed   = 0;
    this._baseline   = 0.05;
    this._lastBeatMs = 0;
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

    // ── 2. Smooth instantaneous + slow adaptive baseline ───────────
    //
    // `_smoothed`  – fast EMA, follows transients (attack ≈ a few frames)
    // `_baseline`  – slow EMA, follows ambient room noise so a shouted
    //                conversation doesn't trigger but a kick-drum does.
    this._smoothed = this._smoothed * 0.55 + energy * 0.45;
    this._baseline = this._baseline * 0.985 + this._smoothed * 0.015;

    // ── 3. Beat detection ──────────────────────────────────────────
    const sens     = cfg.AUDIO_SENSITIVITY;          // multiplier over baseline
    const floor    = cfg.AUDIO_NOISE_FLOOR;          // ignore total silence
    const refract  = cfg.AUDIO_REFRACTORY_MS;        // min gap between rings
    const isBeat   = this._smoothed > floor
                   && this._smoothed > this._baseline * sens
                   && (nowMs - this._lastBeatMs) > refract;

    if (!isBeat) return;
    this._lastBeatMs = nowMs;

    // ── 4. Emit a radial burst from canvas center ──────────────────
    //
    // Magnitude scales super-linearly with the headroom over baseline so
    // a stronger kick produces a visibly larger ring. The user-facing
    // SPLAT_FORCE slider still acts as a global gain.
    const headroom = Math.min(3.0, this._smoothed / Math.max(0.01, this._baseline));
    const mag      = cfg.SPLAT_FORCE * cfg.AUDIO_GAIN * headroom;

    const n = cfg.AUDIO_SPLAT_COUNT | 0;
    // Random phase offset so successive rings don't perfectly overlap
    // (avoids a stationary aliasing pattern on sustained bass).
    const phase = Math.random() * Math.PI * 2;

    // Pick a single colour per ring so the wave reads as one event,
    // and cycle the hue from the audio energy itself.
    const hue = (nowMs * 0.0002 + this._smoothed * 4) % 1;
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
