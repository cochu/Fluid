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
   * @param {Function} [callbacks.onParticleDrop]     (uvX: number, uvY: number) — called per-frame while user drags the drop button over the canvas
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
      // Map slider 0–100 → dissipation 0.95–0.999.
      // Higher = particles & dye persist longer.
      const v = 0.95 + (Number(e.target.value) / 100) * 0.049;
      this._config.DENSITY_DISSIPATION  = v;
      this._config.VELOCITY_DISSIPATION = v;
      this._callbacks.onDissipationChange(v);
    });

    this._bind('slider-viscosity', 'input', e => {
      // Map slider 0–100 → viscosity 0–0.5 (quadratic for finer control near 0).
      const t = Number(e.target.value) / 100;
      this._config.VISCOSITY = 0.5 * t * t;
    });

    this._bind('btn-hq-advect', 'click', () => {
      this._config.HIGH_QUALITY_ADVECTION = !this._config.HIGH_QUALITY_ADVECTION;
      this._toggle('btn-hq-advect', this._config.HIGH_QUALITY_ADVECTION);
    });

    this._bindSpawnButton();
  }

  /* ──────────────────────────────────────────────────────────────────
     Drop-particles button (drag-and-drop onto the canvas)
     ────────────────────────────────────────────────────────────────── */

  _bindSpawnButton() {
    const btn    = document.getElementById('btn-spawn');
    const canvas = document.getElementById('canvas');
    if (!btn || !canvas) return;

    let activePointerId = null;

    const start = (e) => {
      e.preventDefault();
      activePointerId = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
      btn.classList.add('active');
    };

    const move = (e) => {
      if (e.pointerId !== activePointerId) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x =     (e.clientX - rect.left) / rect.width;
      const y = 1 - (e.clientY - rect.top)  / rect.height;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        this._callbacks.onParticleDrop?.(x, y);
      }
    };

    const end = (e) => {
      if (e.pointerId !== activePointerId) return;
      activePointerId = null;
      try { btn.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      btn.classList.remove('active');
    };

    btn.addEventListener('pointerdown',   start, { passive: false });
    btn.addEventListener('pointermove',   move,  { passive: false });
    btn.addEventListener('pointerup',     end);
    btn.addEventListener('pointercancel', end);
    // Prevent the browser's native HTML5 drag from kicking in on the button.
    btn.addEventListener('dragstart',     e => e.preventDefault());
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
    this._toggle('btn-hq-advect', this._config.HIGH_QUALITY_ADVECTION);
  }
}
