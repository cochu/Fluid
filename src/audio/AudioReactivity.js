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

    /** Per-band envelope follower state. Each band uses an *asymmetric*
     *  EMA: a fast attack coefficient when energy rises, a slow release
     *  coefficient otherwise. Coefficients are EMA "retention" values:
     *  closer to 1 = slower. The slow adaptive baseline (`base`) tracks
     *  ambient room level over a much longer window. */
    this._bands = {
      bass:  { lo: 'AUDIO_BASS_LOW_HZ',  hi: 'AUDIO_BASS_HIGH_HZ',  env: 0, base: 0.05, lastMs: 0, atk: 0.10, rel: 0.78, baseSmooth: 0.994 },
      mids:  { lo: 'AUDIO_MIDS_LOW_HZ',  hi: 'AUDIO_MIDS_HIGH_HZ',  env: 0, base: 0.05, lastMs: 0, atk: 0.05, rel: 0.70, baseSmooth: 0.988 },
      highs: { lo: 'AUDIO_HIGHS_LOW_HZ', hi: 'AUDIO_HIGHS_HIGH_HZ', env: 0, base: 0.04, lastMs: 0, atk: 0.00, rel: 0.55, baseSmooth: 0.975 },
    };

    /** Set to true while `stop()` is in progress so an in-flight `start()`
     *  doesn't go on to install a fresh audio graph after we asked to
     *  shut down. Checked after every await inside the start IIFE. */
    this._aborted = false;

    /** Resolved when audio is fully running, rejected on failure. */
    this._readyP = null;

    /** The deviceId the most recent successful start() actually bound to.
     *  Empty string means "browser default device". Read by the UI to
     *  reconcile the device-picker selection after a fallback. */
    this._activeDeviceId = '';
  }

  /** Whether audio capture is currently active. */
  get isActive() {
    return this._ctx !== null && this._ctx.state === 'running';
  }

  /**
   * Request the microphone and start the analyser. Safe to call multiple
   * times — subsequent calls are no-ops while already active.
   *
   * @param {object} [opts]
   * @param {string} [opts.deviceId] Preferred MediaDeviceInfo.deviceId; '' or
   *        omitted = browser default. Falls back to default if the requested
   *        device is no longer available.
   * @returns {Promise<void>} resolves once the analyser is wired up.
   */
  async start(opts = {}) {
    if (this.isActive) return;
    if (this._readyP) return this._readyP;

    this._aborted = false;
    const checkAbort = () => { if (this._aborted) throw new Error('audio start aborted'); };
    const requestedDeviceId = (opts && typeof opts.deviceId === 'string') ? opts.deviceId : '';

    this._readyP = (async () => {
      if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia not supported');
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API not supported');

      // Disable any automatic processing — we WANT raw bass.
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      };
      if (requestedDeviceId) {
        // `exact` rejects if the device is gone, which we catch below
        // and retry with the default device — better UX than a silent
        // fall-through to whatever device the OS picks.
        audioConstraints.deviceId = { exact: requestedDeviceId };
      }
      let stream;
      let didFallback = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch (err) {
        if (requestedDeviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
          // Persisted device is unplugged / revoked — retry with default.
          console.warn('[Fluid] Audio device unavailable, falling back to default:', requestedDeviceId);
          delete audioConstraints.deviceId;
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
          didFallback = true;
        } else {
          throw err;
        }
      }
      if (this._aborted) {
        // stop() ran while we were waiting for the mic — release the
        // freshly-granted track instead of installing it.
        for (const t of stream.getTracks()) { try { t.stop(); } catch (_) {} }
        checkAbort();
      }
      this._stream = stream;
      // Record the deviceId we actually got (post-fallback if applicable)
      // so callers can sync their persisted state if the requested one
      // was missing. Empty string means "browser default".
      if (didFallback) {
        this._activeDeviceId = '';
      } else {
        const settings = stream.getAudioTracks()[0]?.getSettings?.();
        this._activeDeviceId = settings?.deviceId || requestedDeviceId || '';
      }

      const ctx = new AC();
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_) { /* best-effort */ }
      }
      if (this._aborted) {
        try { ctx.close(); } catch (_) {}
        checkAbort();
      }
      this._ctx = ctx;

      this._source   = this._ctx.createMediaStreamSource(this._stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize               = 2048;          // 2048 → ~23 Hz bins; bass band gets 8 bins
      // We do all smoothing in the per-band asymmetric EMA, so disable
      // the analyser's internal IIR (it would add a frame of lag and
      // soften transient detection on snares / hi-hats).
      this._analyser.smoothingTimeConstant = 0.0;
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

  /**
   * The deviceId actually in use for the active capture (post-fallback if
   * the requested one was missing). Empty string when running on the
   * browser default device or when audio is inactive.
   */
  get activeDeviceId() {
    return this._activeDeviceId || '';
  }

  /**
   * Switch to a different microphone. If audio is currently active this
   * tears down the current graph and starts a fresh one bound to the new
   * device. If inactive, the id is just remembered for the next start().
   * Pass '' for the browser default device.
   *
   * @param {string} deviceId
   * @returns {Promise<void>} resolves once the new graph is wired (or
   *          rejects with the underlying getUserMedia error).
   */
  async setDeviceId(deviceId) {
    const id = typeof deviceId === 'string' ? deviceId : '';
    if (!this.isActive && !this._readyP) {
      this._activeDeviceId = id;
      return;
    }
    // Wait for any in-flight start to settle so we don't double-stop.
    if (this._readyP) {
      try { await this._readyP; } catch (_) { /* fall through to restart */ }
    }
    // No-op when the requested device is already the live one — saves
    // a stop/start round-trip that would briefly mute the analyser.
    if (this.isActive && id === this._activeDeviceId) return;
    this.stop();
    await this.start({ deviceId: id });
  }

  /** Stop capture, release the mic, free the audio graph. */
  stop() {
    this._aborted = true;
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
    for (const b of Object.values(this._bands)) {
      b.env = 0; b.base = 0.05; b.lastMs = 0;
    }
  }

  /**
   * Compute and update one band's envelope. Returns the smoothed
   * instantaneous energy (0..1) and writes it back into `band`.
   * @private
   */
  _updateBand(band, binHz) {
    const cfg  = this._config;
    const lo   = Math.max(1, Math.floor(cfg[band.lo] / binHz));
    const hi   = Math.min(this._freqData.length - 1, Math.ceil(cfg[band.hi] / binHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this._freqData[i];
    const energy = (sum / Math.max(1, hi - lo + 1)) / 255;
    // Asymmetric EMA: react fast on rising energy (attack), decay slowly
    // on falling energy (release). This gives a clean transient peak
    // without the smear that a single symmetric coefficient produces.
    const k = energy > band.env ? band.atk : band.rel;
    band.env  = band.env  * k + energy   * (1 - k);
    band.base = band.base * band.baseSmooth + band.env * (1 - band.baseSmooth);
    return band.env;
  }

  /**
   * Drive one frame of analysis and emit splats per audio band when
   * beats are detected. Should be called from the main animation loop;
   * cheap when audio is inactive.
   *
   * @param {number} nowMs `performance.now()` of the current frame
   */
  tick(nowMs) {
    if (!this.isActive || !this._analyser || !this._freqData) return;
    const cfg = this._config;
    if (!cfg.AUDIO_REACTIVE) return;

    this._analyser.getByteFrequencyData(this._freqData);
    const binHz = this._ctx.sampleRate / this._analyser.fftSize;

    const bass  = this._updateBand(this._bands.bass,  binHz);
    const mids  = this._updateBand(this._bands.mids,  binHz);
    const highs = this._updateBand(this._bands.highs, binHz);

    // ── Bass: 8 soft splats arranged on a circle around the centre,
    //    each pushing inward. Eight sources approximate radial symmetry
    //    well enough for the pressure projection to give a clean ring;
    //    four would alias into a diamond / × interference pattern. ──
    if (bass > cfg.AUDIO_NOISE_FLOOR
        && bass > this._bands.bass.base * cfg.AUDIO_SENSITIVITY
        && (nowMs - this._bands.bass.lastMs) > cfg.AUDIO_REFRACTORY_MS) {
      this._bands.bass.lastMs = nowMs;
      const headroom = Math.min(2.5, bass / Math.max(0.01, this._bands.bass.base));
      const mag      = cfg.SPLAT_FORCE * cfg.AUDIO_GAIN * headroom;
      const hue   = (nowMs * 0.0001) % 1;
      const color = hsvToRgb(hue, 0.55, cfg.DYE_BRIGHTNESS * 0.9);
      const N = Math.max(6, cfg.AUDIO_SPLAT_COUNT | 0);
      const r = 0.30;
      for (let i = 0; i < N; i++) {
        const a  = (i / N) * Math.PI * 2;
        const x  = 0.5 + Math.cos(a) * r;
        const y  = 0.5 + Math.sin(a) * r;
        const dx = -Math.cos(a) * mag * 0.45;
        const dy = -Math.sin(a) * mag * 0.45;
        this._splat(x, y, dx, dy, color);
      }
    }

    // ── Mids: a counter-rotating vortex pair at random positions.
    //    Snares and vocals carve swirls instead of pulses. ──
    if (mids > cfg.AUDIO_MIDS_NOISE_FLOOR
        && mids > this._bands.mids.base * cfg.AUDIO_MIDS_SENSITIVITY
        && (nowMs - this._bands.mids.lastMs) > cfg.AUDIO_MIDS_REFRACTORY_MS) {
      this._bands.mids.lastMs = nowMs;
      const headroom = Math.min(2.0, mids / Math.max(0.01, this._bands.mids.base));
      const mag      = cfg.SPLAT_FORCE * cfg.AUDIO_MIDS_GAIN * headroom;
      const cx = 0.25 + Math.random() * 0.5;
      const cy = 0.25 + Math.random() * 0.5;
      const sep = 0.05;
      const ang = Math.random() * Math.PI * 2;
      const ox = Math.cos(ang) * sep, oy = Math.sin(ang) * sep;
      // Two splats with opposite tangential pushes form a vortex pair.
      const tx = -Math.sin(ang) * mag, ty = Math.cos(ang) * mag;
      const hue = (nowMs * 0.00025 + 0.4) % 1;
      const color = hsvToRgb(hue, 0.75, cfg.DYE_BRIGHTNESS);
      this._splat(cx + ox, cy + oy,  tx,  ty, color);
      this._splat(cx - ox, cy - oy, -tx, -ty, color);
    }

    // ── Highs: tiny dye-only sparkles. Zero velocity = no kick to the
    //    flow, just bright pinpricks that catch the eye on hi-hats. ──
    if (highs > cfg.AUDIO_HIGHS_NOISE_FLOOR
        && highs > this._bands.highs.base * cfg.AUDIO_HIGHS_SENSITIVITY
        && (nowMs - this._bands.highs.lastMs) > cfg.AUDIO_HIGHS_REFRACTORY_MS) {
      this._bands.highs.lastMs = nowMs;
      const n = 3;
      const hue = (nowMs * 0.0007) % 1;
      const color = hsvToRgb(hue, 0.25, cfg.DYE_BRIGHTNESS * (1 + cfg.AUDIO_HIGHS_GAIN));
      for (let i = 0; i < n; i++) {
        const x = Math.random();
        const y = Math.random();
        // dx=dy=0: pure dye, no momentum.
        this._splat(x, y, 0, 0, color);
      }
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
