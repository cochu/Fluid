/**
 * UI.js – Overlay controls + UX scaffolding for the fluid simulation.
 *
 * Owns:
 *   - All button / slider DOM wiring
 *   - Universal tooltip system (desktop hover + mobile long-press)
 *   - Pause toggle (button + spacebar)
 *   - PNG snapshot export
 *   - Version tag
 *   - Slider rescaling to perceptually linear curves
 *
 * The class never reaches into rendering or the simulation; it only mutates
 * the shared CONFIG object and forwards intent through the callbacks bag.
 */

/* ──────────────────────────────────────────────────────────────────────
   Slider curves
   --------------------------------------------------------------------
   All sliders run on a UI domain of [0..100] for consistent feel; we
   apply a per-control mapping to the underlying engineering range.
   ────────────────────────────────────────────────────────────────────── */

/** Geometric (log) interpolation – good for "feels linear" force/persistence. */
function logLerp(t, lo, hi) {
  return lo * Math.pow(hi / lo, Math.max(0, Math.min(1, t)));
}

/**
 * Force slider 0..100 → SPLAT_FORCE.
 *   - 0   → 200  (gentle prod, won't break the simulation)
 *   - 50  → 1500 (default, lively but controlled)
 *   - 100 → 8000 (firehose; previous default was 3000)
 * Geometric interpolation = each tick on the slider feels like a
 * comparable change in perceived strength.
 */
function forceFromSlider(t) {
  return Math.round(logLerp(t / 100, 200, 8000));
}

/**
 * Viscosity slider 0..100 → ν.
 *   - 0    → 0      (inviscid; viscosity solver fully disabled)
 *   - 50   → 0.0063 (gentle, lazy flow)
 *   - 100  → 0.05   (clearly viscous, sirupy)
 * Cubic curve gives fine control near 0 while still reaching a visibly
 * thick fluid at the top. Capped at 0.05 because higher ν drives the
 * implicit Jacobi α past convergence range for our iteration budget,
 * which re-introduces grid-aligned residue.
 */
function viscosityFromSlider(t) {
  if (t <= 0) return 0;
  const u = t / 100;
  return 0.05 * u * u * u;
}

/**
 * Persistence (formerly "dissipation") slider 0..100 → dissipation factor.
 *   - 0   → 0.92  (everything fades fast — clean canvas)
 *   - 50  → 0.985
 *   - 100 → 0.999 (very long trails, near-permanent dye)
 * The user-facing label is now "Persistence" so higher = more lingering,
 * matching the visible behaviour rather than the math.
 */
function persistenceFromSlider(t) {
  const u = t / 100;
  return 0.92 + (0.999 - 0.92) * (u * u * (3 - 2 * u));   // smoothstep
}

/* ──────────────────────────────────────────────────────────────────────
   UI class
   ────────────────────────────────────────────────────────────────────── */

export class UI {
  /**
   * @param {import('../config.js').CONFIG} config
   * @param {Object} cb  callbacks bag (all optional)
   */
  constructor(config, cb) {
    this._config    = config;
    this._cb        = cb;
    this._fpsEl     = document.getElementById('fps-counter');
    this._versionEl = document.getElementById('version-tag');
    this._tooltipEl = document.getElementById('tooltip');

    this._initVersionTag();
    this._initTooltips();
    this._initSliders();
    this._initButtons();
    this._initKeyboard();
    this._syncStates();
  }

  /* ──────────────────────────────────────────────────────────────────
     Version tag
     ────────────────────────────────────────────────────────────────── */

  _initVersionTag() {
    if (!this._versionEl) return;
    // BUILD_VERSION may be injected by a build step; fall back to a
    // human-readable timestamp so the user always knows what they're
    // running. We also expose the value so the snapshot exporter can
    // burn it into the file metadata if desired.
    const v = (typeof window !== 'undefined' && window.__FLUID_BUILD__)
      ? String(window.__FLUID_BUILD__)
      : 'dev';
    const text = `Fluid · ${v}`;
    this._versionEl.textContent = text;
    this._versionEl.title       = `Build identifier: ${v}\nClick to copy`;
    this._versionEl.addEventListener('click', () => {
      try { navigator.clipboard.writeText(text); } catch (_) { /* noop */ }
      this._flashTip(this._versionEl, 'Copied');
    });
    this.version = v;
  }

  /* ──────────────────────────────────────────────────────────────────
     Tooltip system
     --------------------------------------------------------------------
     One singleton DOM node moved around as needed. Triggered by:
       - mouseenter / focus on desktop (instant)
       - long-press (~500 ms) on touch devices
     Hidden by mouseleave / blur / pointerup / scroll.
     Sources tooltip text from `data-tip` (preferred) or `title`.
     ────────────────────────────────────────────────────────────────── */

  _initTooltips() {
    if (!this._tooltipEl) return;
    const tip = this._tooltipEl;

    let pressTimer = null;
    let currentEl  = null;

    const text = (el) => el?.dataset?.tip || el?.getAttribute?.('title') || '';

    const show = (el) => {
      const txt = text(el);
      if (!txt) return;
      // Hide any native tooltip — we render our own.
      if (el.hasAttribute('title')) el.dataset._title = el.getAttribute('title');
      el.removeAttribute('title');
      tip.textContent = txt;
      const r = el.getBoundingClientRect();
      tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
      tip.style.top  = `${Math.round(r.top)}px`;
      tip.classList.add('visible');
      tip.setAttribute('aria-hidden', 'false');
      currentEl = el;
    };
    const hide = () => {
      tip.classList.remove('visible');
      tip.setAttribute('aria-hidden', 'true');
      if (currentEl && currentEl.dataset._title) {
        currentEl.setAttribute('title', currentEl.dataset._title);
        delete currentEl.dataset._title;
      }
      currentEl = null;
    };

    // Targets: any element with data-tip or title inside the panel
    const isTarget = (el) => el && (el.dataset?.tip || el.hasAttribute?.('title'));

    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest?.('[data-tip], [title]');
      if (isTarget(el)) show(el);
    }, true);

    document.addEventListener('mouseout', (e) => {
      if (e.target === currentEl) hide();
    }, true);

    document.addEventListener('focusout', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);

    // Long-press for touch
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      const el = e.target.closest?.('[data-tip], [title]');
      if (!isTarget(el)) return;
      pressTimer = window.setTimeout(() => {
        // Don't suppress the click; show the tip in parallel.
        show(el);
        // Auto-dismiss after a moment so it doesn't linger.
        window.setTimeout(hide, 1800);
        // Light haptic if supported.
        if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {}
      }, 480);
    }, true);

    const cancelPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    document.addEventListener('pointerup',     cancelPress, true);
    document.addEventListener('pointercancel', cancelPress, true);
    document.addEventListener('pointermove',   cancelPress, true);
  }

  /** Briefly show a tooltip with custom text near `el`, then auto-hide. */
  _flashTip(el, msg) {
    const tip = this._tooltipEl;
    if (!tip || !el) return;
    tip.textContent = msg;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
    tip.style.top  = `${Math.round(r.top)}px`;
    tip.classList.add('visible');
    tip.setAttribute('aria-hidden', 'false');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => {
      tip.classList.remove('visible');
      tip.setAttribute('aria-hidden', 'true');
    }, 1100);
  }

  /* ──────────────────────────────────────────────────────────────────
     Sliders
     ────────────────────────────────────────────────────────────────── */

  _initSliders() {
    const cfg = this._config;

    // Force – log curve, range 200..8000.
    this._bind('slider-force', 'input', (e) => {
      const v = forceFromSlider(Number(e.target.value));
      cfg.SPLAT_FORCE = v;
      this._cb.onForceChange?.(v);
    });

    // Persistence – smoothstep curve.
    this._bind('slider-dissipation', 'input', (e) => {
      const v = persistenceFromSlider(Number(e.target.value));
      cfg.DENSITY_DISSIPATION  = v;
      cfg.VELOCITY_DISSIPATION = v;
      this._cb.onDissipationChange?.(v);
    });

    // Viscosity – cubic curve, range 0..2.
    this._bind('slider-viscosity', 'input', (e) => {
      cfg.VISCOSITY = viscosityFromSlider(Number(e.target.value));
    });

    // Apply the slider defaults to CONFIG immediately so config / UI agree.
    cfg.SPLAT_FORCE          = forceFromSlider(50);
    const persist            = persistenceFromSlider(65);
    cfg.DENSITY_DISSIPATION  = persist;
    cfg.VELOCITY_DISSIPATION = persist;
    cfg.VISCOSITY            = viscosityFromSlider(0);
  }

  /* ──────────────────────────────────────────────────────────────────
     Buttons
     ────────────────────────────────────────────────────────────────── */

  _initButtons() {
    const cfg = this._config;

    this._bind('btn-reset', 'click', () => this._cb.onReset?.());

    this._bind('btn-particles', 'click', () => {
      cfg.PARTICLES = !cfg.PARTICLES;
      this._toggle('btn-particles', cfg.PARTICLES);
      this._cb.onToggleParticles?.(cfg.PARTICLES);
    });

    this._bind('btn-bloom', 'click', () => {
      cfg.BLOOM = !cfg.BLOOM;
      this._toggle('btn-bloom', cfg.BLOOM);
      this._cb.onToggleBloom?.(cfg.BLOOM);
    });

    this._bind('btn-colorful', 'click', () => {
      cfg.COLORFUL = !cfg.COLORFUL;
      this._toggle('btn-colorful', cfg.COLORFUL);
      this._cb.onToggleColorful?.(cfg.COLORFUL);
    });

    this._bind('btn-perf', 'click', () => {
      const perfMode = cfg.SIM_RESOLUTION === 64;
      if (perfMode) {
        cfg.SIM_RESOLUTION       = 128;
        cfg.DYE_RESOLUTION       = 512;
        cfg.PRESSURE_ITERATIONS  = 25;
        cfg.BLOOM_ITERATIONS     = 8;
        document.getElementById('btn-perf')?.classList.remove('perf-mode');
      } else {
        cfg.SIM_RESOLUTION       = 64;
        cfg.DYE_RESOLUTION       = 256;
        cfg.PRESSURE_ITERATIONS  = 10;
        cfg.BLOOM_ITERATIONS     = 4;
        document.getElementById('btn-perf')?.classList.add('perf-mode');
      }
      this._cb.onTogglePerfMode?.(!perfMode);
    });

    this._bind('btn-hq-advect', 'click', () => {
      cfg.HIGH_QUALITY_ADVECTION = !cfg.HIGH_QUALITY_ADVECTION;
      this._toggle('btn-hq-advect', cfg.HIGH_QUALITY_ADVECTION);
    });

    this._bind('btn-pause', 'click', () => this._setPaused(!cfg.PAUSED));

    this._bind('btn-snapshot', 'click', () => this._cb.onSnapshot?.());

    this._bindAudioButton();
    this._bindSpawnButton();
  }

  /* ──────────────────────────────────────────────────────────────────
     Audio reactivity (asynchronous — needs mic permission)
     ────────────────────────────────────────────────────────────────── */

  _bindAudioButton() {
    const btn = document.getElementById('btn-audio');
    if (!btn) return;
    let busy = false;
    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      btn.classList.remove('audio-denied');
      const want = !this._config.AUDIO_REACTIVE;
      try {
        const actual = await this._cb.onToggleAudio?.(want);
        const on     = actual === undefined ? want : !!actual;
        this._config.AUDIO_REACTIVE = on;
        this._toggle('btn-audio', on);
      } catch (err) {
        this._config.AUDIO_REACTIVE = false;
        this._toggle('btn-audio', false);
        btn.classList.add('audio-denied');
        btn.dataset.tip = `Audio unavailable: ${err?.message || 'permission denied'}`;
        console.warn('[Fluid] Audio reactivity unavailable:', err);
      } finally {
        busy = false;
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     Drop-particles button (drag-and-drop onto the canvas)
     ────────────────────────────────────────────────────────────────── */

  _bindSpawnButton() {
    const btn    = document.getElementById('btn-spawn');
    const canvas = document.getElementById('canvas');
    if (!btn || !canvas) return;

    let activePointerId = null;
    let dragMoved       = false;

    const start = (e) => {
      e.preventDefault();
      activePointerId = e.pointerId;
      dragMoved       = false;
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
      btn.classList.add('active');
    };
    const move = (e) => {
      if (e.pointerId !== activePointerId) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x =     (e.clientX - rect.left) / rect.width;
      const y = 1 - (e.clientY - rect.top)  / rect.height;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        dragMoved = true;
        btn.classList.remove('onboard');     // first successful drag = hint solved
        this._cb.onParticleDrop?.(x, y);
      }
    };
    const end = (e) => {
      if (e.pointerId !== activePointerId) return;
      activePointerId = null;
      try { btn.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      btn.classList.remove('active');
      // Tap (no drag) = small confetti burst at canvas centre, so the user
      // gets immediate feedback that this button does something — and the
      // tooltip reveals "drag onto canvas" for the next try.
      if (!dragMoved) {
        this._cb.onParticleDrop?.(0.5, 0.5);
        this._flashTip(btn, 'Tip: drag onto the canvas');
      }
    };
    btn.addEventListener('pointerdown',   start, { passive: false });
    btn.addEventListener('pointermove',   move,  { passive: false });
    btn.addEventListener('pointerup',     end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('dragstart',     (e) => e.preventDefault());
  }

  /* ──────────────────────────────────────────────────────────────────
     Pause (button + spacebar)
     ────────────────────────────────────────────────────────────────── */

  _initKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Don't hijack typing in inputs, nor Space/Enter on focused
      // buttons (pause shortcut would otherwise eat button activation
      // for keyboard users).
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (tag === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this._setPaused(!this._config.PAUSED);
      } else if (e.key === 's' || e.key === 'S') {
        this._cb.onSnapshot?.();
      }
    });
  }

  _setPaused(paused) {
    this._config.PAUSED = !!paused;
    this._toggle('btn-pause', this._config.PAUSED);
    let overlay = document.getElementById('paused-overlay');
    if (this._config.PAUSED) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'paused-overlay';
        overlay.textContent = 'Paused';
        document.getElementById('ui-overlay')?.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
    }
    this._cb.onPauseChange?.(this._config.PAUSED);
  }

  /* ──────────────────────────────────────────────────────────────────
     Snapshot flash (called by main when a PNG was just saved)
     ────────────────────────────────────────────────────────────────── */

  flashSnapshot() {
    const el = document.getElementById('snapshot-flash');
    if (!el) return;
    el.classList.remove('flash');
    // Force reflow so re-adding the class restarts the animation.
    void el.offsetWidth;
    el.classList.add('flash');
  }

  /* ──────────────────────────────────────────────────────────────────
     FPS display
     ────────────────────────────────────────────────────────────────── */

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
  _syncStates() {
    this._toggle('btn-particles', this._config.PARTICLES);
    this._toggle('btn-bloom',     this._config.BLOOM);
    this._toggle('btn-colorful',  this._config.COLORFUL);
    this._toggle('btn-hq-advect', this._config.HIGH_QUALITY_ADVECTION);
    this._toggle('btn-pause',     this._config.PAUSED);
  }
}
