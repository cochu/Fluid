/**
 * UI.js – Minimal overlay controls for the fluid simulation.
 *
 * Manages button/slider DOM state and emits change events to the app.
 */

export class UI {
  /**
   * @param {import('../config.js').CONFIG} config  Shared live config object
   * @param {Object} callbacks
   * @param {Function} callbacks.onReset
   * @param {Function} callbacks.onToggleParticles
   * @param {Function} callbacks.onToggleBloom
   * @param {Function} callbacks.onToggleColorful
   * @param {Function} callbacks.onTogglePerfMode
   * @param {Function} callbacks.onForceChange      (value: number)
   * @param {Function} callbacks.onParticleCountChange (value: number)
   * @param {Function} callbacks.onDissipationChange  (value: number)
   */
  constructor(config, callbacks) {
    this._config    = config;
    this._callbacks = callbacks;
    this._fpsEl     = document.getElementById('fps-counter');

    this._bindAll();
    this._syncButtonStates();
  }

  /* ──────────────────────────────────────────────────────────────────
     Wiring
     ────────────────────────────────────────────────────────────────── */

  _bindAll() {
    this._bind('btn-reset',     'click',  () => this._callbacks.onReset());

    this._bind('btn-particles', 'click', () => {
      this._config.PARTICLES = !this._config.PARTICLES;
      this._toggle('btn-particles', this._config.PARTICLES);
      this._callbacks.onToggleParticles(this._config.PARTICLES);
    });

    this._bind('btn-bloom', 'click', () => {
      this._config.BLOOM = !this._config.BLOOM;
      this._toggle('btn-bloom', this._config.BLOOM);
      this._callbacks.onToggleBloom(this._config.BLOOM);
    });

    this._bind('btn-colorful', 'click', () => {
      this._config.COLORFUL = !this._config.COLORFUL;
      this._toggle('btn-colorful', this._config.COLORFUL);
      this._callbacks.onToggleColorful(this._config.COLORFUL);
    });

    this._bind('btn-perf', 'click', () => {
      const perfMode = this._config.SIM_RESOLUTION === 64;
      if (perfMode) {
        // Restore normal quality
        this._config.SIM_RESOLUTION = 128;
        this._config.DYE_RESOLUTION = 512;
        this._config.PRESSURE_ITERATIONS = 25;
        this._config.BLOOM_ITERATIONS = 8;
        document.getElementById('btn-perf').classList.remove('perf-mode');
      } else {
        // Reduce quality for performance
        this._config.SIM_RESOLUTION = 64;
        this._config.DYE_RESOLUTION = 256;
        this._config.PRESSURE_ITERATIONS = 10;
        this._config.BLOOM_ITERATIONS = 4;
        document.getElementById('btn-perf').classList.add('perf-mode');
      }
      this._callbacks.onTogglePerfMode(!perfMode);
    });

    this._bind('slider-force', 'input', e => {
      const v = Number(e.target.value);
      this._config.SPLAT_FORCE = v;
      this._callbacks.onForceChange(v);
    });

    this._bind('slider-particles', 'input', e => {
      const v = Number(e.target.value);
      this._callbacks.onParticleCountChange(v);
    });

    this._bind('slider-dissipation', 'input', e => {
      // Map slider 0-100 → dissipation 0.95-1.0
      const v = 0.95 + (Number(e.target.value) / 100) * 0.05;
      this._config.DENSITY_DISSIPATION  = v;
      this._config.VELOCITY_DISSIPATION = v - 0.005;
      this._callbacks.onDissipationChange(v);
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     FPS display
     ────────────────────────────────────────────────────────────────── */

  /** Update the FPS counter element. */
  updateFPS(fps) {
    if (this._fpsEl) this._fpsEl.textContent = `${fps | 0} FPS`;
  }

  /* ──────────────────────────────────────────────────────────────────
     Helpers
     ────────────────────────────────────────────────────────────────── */

  _bind(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  }

  _toggle(id, active) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', active);
  }

  _syncButtonStates() {
    this._toggle('btn-particles', this._config.PARTICLES);
    this._toggle('btn-bloom',     this._config.BLOOM);
    this._toggle('btn-colorful',  this._config.COLORFUL);
  }
}
