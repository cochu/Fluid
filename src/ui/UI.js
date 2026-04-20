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
 *   - 0   → 5    (essentially no force — particles drift only)
 *   - 10  → ~50
 *   - 20  → ~185
 *   - 50  → ~1129 (default; clearly lively but never feels like a firehose)
 *   - 100 → 4500
 * Quadratic curve `u²` collapses the floor much further than the previous
 * `60 + 5440·u^1.8` mapping (which still felt punchy at slider 0–10) while
 * keeping the upper half intuitive. Max lowered from 5500 → 4500 since the
 * old top still felt borderline violent on small splats.
 */
function forceFromSlider(t) {
  const u = Math.max(0, Math.min(1, t / 100));
  return Math.round(5 + (4500 - 5) * u * u);
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

/**
 * Obstacle brush slider 0..100 → OBSTACLE_PAINT_RADIUS (UV fraction of
 * the shorter screen side).
 *   - 0   → 0.005  (single-pixel pen)
 *   - 35  → ~0.017 (current visual default — see config.js comment)
 *   - 100 → 0.10   (broad swath, ~1/10 of canvas)
 * Quadratic so fine sizes near 0 are easy to dial in while still
 * reaching a fat brush at the top.
 */
function brushFromSlider(t) {
  const u = Math.max(0, Math.min(1, t / 100));
  return 0.005 + 0.095 * u * u;
}

/**
 * Audio per-band sensitivity slider 0..100 → AUDIO_*_SENSITIVITY.
 *   - 0   → 0.5  (very picky — only loud beats trigger)
 *   - 55  → ~1.6 (current default — middle of the dial)
 *   - 100 → 4.0  (extremely sensitive — fires on near-baseline noise)
 * Logarithmic curve `0.5 · 8^(t/100)` because audio sensitivity is
 * multiplicative against the rolling baseline; a linear mapping would
 * cluster every useful value into the lower third of the slider.
 * Centring the defaults near t=55 was Marcus's UX call.
 */
function audioSensitivityFromSlider(t) {
  const u = Math.max(0, Math.min(1, t / 100));
  return 0.5 * Math.pow(8, u);
}

import { COLOR_MODE_LABELS, nextMode } from '../input/Palettes.js';
import { PRESETS, nextPresetId, applyPreset, getPreset } from '../presets.js';

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

  /** Briefly show a tooltip with custom text near `el`, then auto-hide.
   *  Optional `durationMs` overrides the default dwell time (1100 ms). */
  _flashTip(el, msg, durationMs = 1100) {
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
    }, durationMs);
  }

  /* ──────────────────────────────────────────────────────────────────
     Sliders
     ────────────────────────────────────────────────────────────────── */

  _initSliders() {
    const cfg = this._config;

    // Force – quadratic curve, range 5..4500.
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

    // Palette cycler — replaces the old binary "auto hue cycle" toggle.
    // Each click advances COLOR_MODE through rainbow → cycle → ocean →
    // sunset → magma → forest → mono → rainbow … and flashes the new
    // palette name so the user sees what they picked.
    this._bind('btn-colorful', 'click', () => {
      cfg.COLOR_MODE = nextMode(cfg.COLOR_MODE || 'rainbow');
      cfg.COLORFUL   = cfg.COLOR_MODE !== 'mono';
      this._toggle('btn-colorful', cfg.COLOR_MODE !== 'mono');
      const btn = document.getElementById('btn-colorful');
      if (btn) {
        btn.dataset.tip = COLOR_MODE_LABELS[cfg.COLOR_MODE] || cfg.COLOR_MODE;
        this._flashTip(btn, COLOR_MODE_LABELS[cfg.COLOR_MODE] || cfg.COLOR_MODE);
      }
      this._cb.onColorModeChange?.(cfg.COLOR_MODE);
    });

    this._bind('btn-perf', 'click', () => {
      const newPerfMode = !cfg.PERF_MODE;
      cfg.PERF_MODE = newPerfMode;
      if (newPerfMode) {
        cfg.SIM_RESOLUTION       = 64;
        cfg.DYE_RESOLUTION       = 256;
        cfg.PRESSURE_ITERATIONS  = 10;
        cfg.BLOOM_ITERATIONS     = 4;
        document.getElementById('btn-perf')?.classList.add('perf-mode');
      } else {
        cfg.SIM_RESOLUTION       = 128;
        cfg.DYE_RESOLUTION       = 512;
        cfg.PRESSURE_ITERATIONS  = 25;
        cfg.BLOOM_ITERATIONS     = 8;
        document.getElementById('btn-perf')?.classList.remove('perf-mode');
      }
      this._cb.onTogglePerfMode?.(newPerfMode);
    });

    // Tri-state cycle: standard → MacCormack → BFECC → standard.
    // The button glyph + tooltip update with each state so the user
    // can see at a glance which scheme is active without opening
    // devtools. We also keep HIGH_QUALITY_ADVECTION in lock-step for
    // the legacy persistence/snapshot path.
    this._bind('btn-hq-advect', 'click', () => {
      const order = ['standard', 'maccormack', 'bfecc'];
      const i = Math.max(0, order.indexOf(cfg.DYE_ADVECTION || 'maccormack'));
      const next = order[(i + 1) % order.length];
      cfg.DYE_ADVECTION = next;
      cfg.HIGH_QUALITY_ADVECTION = (next !== 'standard');
      this._refreshAdvectionButton();
      const btn = document.getElementById('btn-hq-advect');
      if (btn) this._flashTip(btn, this._advectionLabel(next));
    });

    this._bind('btn-pause', 'click', () => this._setPaused(!cfg.PAUSED));

    this._bind('btn-snapshot', 'click', () => this._cb.onSnapshot?.());

    this._bindAudioButton();
    this._bindMidiButton();
    this._bindTiltButton();
    this._bindSpawnButton();
    this._bindObstacleButtons();
    this._bindSourceButton();
    this._bindSinkButton();
    this._bindPresetButton();
    this._bindShareButton();
    this._bindResetLongPress();
    this._bindWallpaperButton();
  }

  /* ──────────────────────────────────────────────────────────────────
     Obstacle paint mode + clear
     ────────────────────────────────────────────────────────────────── */

  _bindObstacleButtons() {
    const cfg = this._config;

    // Helper that updates the brush-slider group visibility — it appears
    // only while obstacle mode is on (progressive disclosure per Marcus).
    const brushGroup = document.getElementById('slider-group-brush');
    const refreshBrushVisibility = () => {
      if (!brushGroup) return;
      brushGroup.hidden = !cfg.OBSTACLE_MODE;
    };

    this._bind('btn-obstacles', 'click', () => {
      const want = !cfg.OBSTACLE_MODE;
      // Mutually exclusive with source / sink placement modes.
      if (want) {
        cfg.SOURCE_MODE = false;
        cfg.SINK_MODE   = false;
      }
      cfg.OBSTACLE_MODE = want;
      // Toggling obstacle mode off also exits the eraser sub-mode so
      // the next time the user enters obstacle mode they start in the
      // expected default (paint, not erase).
      if (!want) cfg.OBSTACLE_ERASE = false;
      this._toggle('btn-obstacles', want);
      this._toggle('btn-source',    cfg.SOURCE_MODE);
      this._toggle('btn-sink',      cfg.SINK_MODE);
      this._toggle('btn-erase',     cfg.OBSTACLE_ERASE);
      refreshBrushVisibility();
      const btn = document.getElementById('btn-obstacles');
      if (btn) this._flashTip(btn, want ? 'Drag to paint walls' : 'Obstacle mode off');
    });

    this._bind('btn-erase', 'click', () => {
      const want = !cfg.OBSTACLE_ERASE;
      cfg.OBSTACLE_ERASE = want;
      // Erasing only makes sense inside obstacle mode — auto-enable it
      // on first toggle so the user doesn't have to two-tap.
      if (want && !cfg.OBSTACLE_MODE) {
        cfg.OBSTACLE_MODE = true;
        cfg.SOURCE_MODE   = false;
        cfg.SINK_MODE     = false;
        this._toggle('btn-obstacles', true);
        this._toggle('btn-source',    false);
        this._toggle('btn-sink',      false);
        refreshBrushVisibility();
      }
      this._toggle('btn-erase', want);
      const btn = document.getElementById('btn-erase');
      if (btn) this._flashTip(btn, want ? 'Drag to erase walls' : 'Eraser off');
    });

    this._bind('btn-clear-obstacles', 'click', () => {
      this._cb.onClearObstacles?.();
      const btn = document.getElementById('btn-clear-obstacles');
      if (btn) this._flashTip(btn, 'Obstacles cleared');
      // A full clear nukes the undo stack too — those strokes can never
      // be replayed onto a meaningful state. The callback owner clears
      // the stack; we just refresh button visuals here.
      this.setUndoEnabled(false);
    });

    this._bind('btn-undo', 'click', () => {
      this._cb.onObstacleUndo?.();
    });

    // Brush slider — quadratic curve mapped to OBSTACLE_PAINT_RADIUS.
    const brushSlider = document.getElementById('slider-brush');
    if (brushSlider) {
      // Apply the slider's initial DOM value once so a persisted
      // restore (which sets el.value before this binding runs) takes
      // effect on first render too.
      cfg.OBSTACLE_PAINT_RADIUS = brushFromSlider(Number(brushSlider.value));
      brushSlider.addEventListener('input', (e) => {
        cfg.OBSTACLE_PAINT_RADIUS = brushFromSlider(Number(e.target.value));
      });
    }

    refreshBrushVisibility();
  }

  /**
   * Enable / disable the ↶ Undo button. main.js calls this whenever
   * the undo stack capacity or the active-pointer-count flips, so the
   * button visual matches reality without UI snooping into the stack.
   */
  setUndoEnabled(on) {
    const btn = document.getElementById('btn-undo');
    if (!btn) return;
    btn.disabled = !on;
    btn.classList.toggle('is-disabled', !on);
  }

  /* ──────────────────────────────────────────────────────────────────
     Source-placement mode + SVG overlay
     ────────────────────────────────────────────────────────────────── */

  _bindSourceButton() {
    this._bind('btn-source', 'click', () => {
      const want = !this._config.SOURCE_MODE;
      // Mutex with the other canvas-editing modes.
      if (want) {
        this._config.OBSTACLE_MODE = false;
        this._config.SINK_MODE     = false;
      }
      this._config.SOURCE_MODE = want;
      this._toggle('btn-source', want);
      this._toggle('btn-obstacles', this._config.OBSTACLE_MODE);
      this._toggle('btn-sink',      this._config.SINK_MODE);
      const btn = document.getElementById('btn-source');
      if (btn) this._flashTip(btn, want ? 'Drag on canvas to place a source' : 'Source mode off');
      this._renderSources();
    });
    this._svgOverlay = document.getElementById('sources-overlay');
    this._renderSources();
    window.addEventListener('resize', () => this._renderSources());
  }

  _bindSinkButton() {
    this._bind('btn-sink', 'click', () => {
      const want = !this._config.SINK_MODE;
      // Mutex with source / obstacle modes.
      if (want) {
        this._config.OBSTACLE_MODE = false;
        this._config.SOURCE_MODE   = false;
      }
      this._config.SINK_MODE = want;
      this._toggle('btn-sink',      want);
      this._toggle('btn-source',    this._config.SOURCE_MODE);
      this._toggle('btn-obstacles', this._config.OBSTACLE_MODE);
      const btn = document.getElementById('btn-sink');
      if (btn) this._flashTip(btn, want ? 'Tap on canvas to place a sink' : 'Sink mode off');
      this._renderSources();
    });
  }

  /** Re-paint the SVG markers + arrows from CONFIG.SOURCES. */
  refreshSources() { this._renderSources(); }

  _renderSources() {
    const svg = this._svgOverlay;
    if (!svg) return;
    const list = this._config.SOURCES || [];
    const canvas = document.getElementById('canvas');
    const w = canvas?.clientWidth  || window.innerWidth;
    const h = canvas?.clientHeight || window.innerHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width',  w);
    svg.setAttribute('height', h);
    svg.style.display = list.length ? 'block' : 'none';

    let html = '';
    if (list.length) {
      html += `<defs><marker id="src-arrow" viewBox="0 0 10 10" refX="9" refY="5" `
           +  `markerWidth="6" markerHeight="6" orient="auto-start-reverse">`
           +  `<path d="M0,0 L10,5 L0,10 Z" fill="rgba(255,255,255,0.85)"/></marker></defs>`;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const px = s.x * w;
        const py = (1 - s.y) * h;
        if (s.kind === 'sink') {
          // Sinks are non-directional — render a darker hollow ring
          // with a minus sign so the affordance reads as "drain", and
          // visually distinct from the bright source dots/arrows.
          html += `<g class="src" data-i="${i}">`
               +  `<circle cx="${px}" cy="${py}" r="11" `
               +  `fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.85)" `
               +  `stroke-width="2" stroke-dasharray="3 2"/>`
               +  `<line x1="${px - 5}" y1="${py}" x2="${px + 5}" y2="${py}" `
               +  `stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round"/>`
               +  `<circle cx="${px}" cy="${py}" r="16" fill="transparent" class="src-hit"/>`
               +  `</g>`;
          continue;
        }
        const len = Math.hypot(s.dx, s.dy);
        const k   = len > 0 ? Math.min(80, 60 + len * 30) : 0;
        const ex  = px + (len ? (s.dx / len) * k : 0);
        const ey  = py + (len ? -(s.dy / len) * k : 0);
        html += `<g class="src" data-i="${i}">`
             +  `<line x1="${px}" y1="${py}" x2="${ex}" y2="${ey}" `
             +  `stroke="rgba(255,255,255,0.65)" stroke-width="2" marker-end="url(#src-arrow)"/>`
             +  `<circle cx="${px}" cy="${py}" r="9" fill="rgba(255,255,255,0.18)" `
             +  `stroke="rgba(255,255,255,0.85)" stroke-width="2"/>`
             +  `<circle cx="${px}" cy="${py}" r="14" fill="transparent" class="src-hit"/>`
             +  `</g>`;
      }
    }
    svg.innerHTML = html;
    // Click handler on the larger transparent hit circle removes the source.
    svg.querySelectorAll('g.src').forEach((g) => {
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = +g.dataset.i;
        if (Number.isFinite(i)) {
          this._config.SOURCES.splice(i, 1);
          this._renderSources();
          // Source removal is a CONFIG mutation that the panel-level
          // delegated listener can't see (the click landed on the SVG
          // overlay, not the panel). Tell the persistence layer
          // explicitly so the change survives a reload.
          this._cb.onConfigMutated?.('source-removed');
        }
      });
    });
  }


  /* ──────────────────────────────────────────────────────────────────
     Named scene presets (✨)
     ────────────────────────────────────────────────────────────────── */

  _bindPresetButton() {
    const btn = document.getElementById('btn-preset');
    if (!btn) return;
    // Track current preset id only on the button (no new CONFIG field —
    // presets are merge functions, not first-class state). Boot starts
    // unset; the first click activates the preset AFTER `default` so the
    // user feels a visible change. We pre-load the dataset attribute so
    // the tooltip already advertises the next destination.
    btn.dataset.preset = btn.dataset.preset || 'default';
    btn.dataset.tip    = `Preset: ${getPreset(btn.dataset.preset).label} (tap to cycle)`;
    btn.addEventListener('click', () => {
      const nextId = nextPresetId(btn.dataset.preset);
      btn.dataset.preset = nextId;
      const p = getPreset(nextId);
      const sliderIds = applyPreset(nextId, this._config);
      // Fire synthetic input events so existing slider handlers re-derive
      // engineering CONFIG values (force / persistence / viscosity).
      for (const id of sliderIds) {
        document.getElementById(id)?.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // Reflect the toggle states for buttons the preset just changed.
      this._syncStates();
      // Update the cycler tooltip to advertise the *next* destination,
      // and flash the *current* preset name. Marcus: 2.5 s dwell since
      // presets are less obvious than the palette cycler.
      btn.dataset.tip = `Preset: ${p.label} (tap to cycle)`;
      this._flashTip(btn, p.label, 2500);
      this._cb.onConfigMutated?.('preset');
      this._cb.onPresetChange?.(nextId);
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     Share-link button (🔗) — copies the current settings as a URL
     ────────────────────────────────────────────────────────────────── */

  _bindShareButton() {
    const btn = document.getElementById('btn-share');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const url = this._cb.onShare?.();
      if (!url) {
        this._flashTip(btn, 'Share unavailable');
        return;
      }
      let copied = false;
      try {
        await navigator.clipboard?.writeText(url);
        copied = true;
      } catch (_) {
        // Some browsers / contexts block clipboard. Fall back to a prompt
        // so the user can copy manually.
        try { window.prompt('Share this link:', url); copied = true; }
        catch (_) { /* noop */ }
      }
      this._flashTip(btn, copied ? 'Copied! Share this link' : 'Copy failed');
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     Long-press on Reset (↺) — also clears the persisted snapshot.
     The standard click still resets the simulation; only a sustained
     ≥700 ms press also wipes localStorage so a stuck-config can be
     escaped without dev-tools. The tooltip advertises the gesture.
     ────────────────────────────────────────────────────────────────── */

  _bindResetLongPress() {
    const btn = document.getElementById('btn-reset');
    if (!btn) return;
    // Update tooltip to advertise the long-press (first paint).
    btn.dataset.tip = 'Reset (long-press: also clear saved settings)';
    let timer    = 0;
    let firedLP  = false;
    const start = () => {
      firedLP = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        firedLP = true;
        this._cb.onClearPersisted?.();
        this._flashTip(btn, 'Saved settings cleared');
        // Light haptic on touch.
        if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {}
      }, 700);
    };
    const cancel = () => { clearTimeout(timer); };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup',   cancel);
    btn.addEventListener('pointerleave',cancel);
    btn.addEventListener('pointercancel',cancel);
    // The synchronous click handler runs after pointerup; suppress the
    // reset action when the long-press already fired so a clear-and-reset
    // becomes just a clear (otherwise the user gets both — surprising).
    btn.addEventListener('click', (e) => {
      if (firedLP) { e.stopImmediatePropagation(); firedLP = false; }
    }, true);
  }

  /* ──────────────────────────────────────────────────────────────────
     Wallpaper / screensaver mode (🌙)
     --------------------------------------------------------------
     Toggling the button flips CONFIG.WALLPAPER_MODE and adds/removes
     `body.wallpaper-on`. While the mode is on, an idle-tracker adds
     `body.wallpaper-revealed` on any pointermove or keydown and
     removes it after WALLPAPER_FADE_TIMEOUT_MS — the CSS handles
     the actual opacity transition. The animate loop in main.js
     handles the auto-splat cadence by reading CONFIG.WALLPAPER_MODE
     directly (so pause / hidden tab gate it for free).
     ────────────────────────────────────────────────────────────────── */

  _bindWallpaperButton() {
    const btn  = document.getElementById('btn-wallpaper');
    const body = document.body;
    if (!btn || !body) return;
    let revealTimer = 0;
    const reveal = () => {
      if (!this._config.WALLPAPER_MODE) return;
      body.classList.add('wallpaper-revealed');
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => {
        body.classList.remove('wallpaper-revealed');
      }, this._config.WALLPAPER_FADE_TIMEOUT_MS || 5000);
    };
    // Pointermove + keydown only (per Marcus): touchstart fires during
    // a panning scroll and would flash the UI on every drag of the fluid.
    window.addEventListener('pointermove', reveal, { passive: true });
    window.addEventListener('keydown',     reveal, { passive: true });

    btn.addEventListener('click', () => {
      const want = !this._config.WALLPAPER_MODE;
      this._config.WALLPAPER_MODE = want;
      btn.classList.toggle('active', want);
      body.classList.toggle('wallpaper-on', want);
      if (want) {
        // Show the chrome briefly so the user sees the new active
        // state, then let the idle timer fade it out.
        reveal();
      } else {
        clearTimeout(revealTimer);
        body.classList.remove('wallpaper-revealed');
      }
      this._cb.onWallpaperChange?.(want);
    });

    // If persistence restored WALLPAPER_MODE = true at boot, reflect
    // it now (the UI constructor already fires _syncStates which will
    // toggle the .active class, but the body class needs us).
    if (this._config.WALLPAPER_MODE) {
      btn.classList.add('active');
      body.classList.add('wallpaper-on');
      reveal();
    }
  }


  /* ──────────────────────────────────────────────────────────────────
     Tilt / accelerometer (asynchronous — needs motion permission on iOS)
     ────────────────────────────────────────────────────────────────── */

  _bindTiltButton() {
    const btn = document.getElementById('btn-tilt');
    if (!btn) return;

    // Capability gate: hide on devices without a coarse pointer (i.e.
    // mouse-only desktops). Phones, tablets, and convertibles in tablet
    // mode remain visible. DeviceMotionEvent technically exists in
    // every modern browser but events never fire on hardware without an
    // accelerometer, so the button would just look broken. Edge case
    // (Chromebook with touchscreen but no accelerometer) is documented:
    // they'll get a graceful permission-denied / no-motion path.
    const isCoarse = (typeof window.matchMedia === 'function')
                       && window.matchMedia('(pointer: coarse)').matches;
    if (!isCoarse) {
      btn.hidden = true;
      // Bail before binding any listeners; the button will never appear
      // on this device.
      return;
    }

    const TUTORIAL_KEY = 'fluid:tilt-tutorial-seen';
    // iOS Safari is the only platform that exposes
    // DeviceMotionEvent.requestPermission; everywhere else, motion fires
    // freely once the user grants the page sensor access (or implicitly
    // on Android Chrome).
    const needsIOSPermission = (typeof DeviceMotionEvent !== 'undefined')
                                && (typeof DeviceMotionEvent.requestPermission === 'function');
    let busy = false;

    /** Run the actual toggle. Caller is responsible for being inside a
     *  fresh user gesture if iOS permission needs to be requested. */
    const performToggle = async (want) => {
      if (busy) return;
      busy = true;
      btn.classList.remove('audio-denied');
      try {
        const actual = await this._cb.onToggleTilt?.(want);
        const on     = actual === undefined ? want : !!actual;
        this._config.TILT_REACTIVE = on;
        this._toggle('btn-tilt', on);
      } catch (err) {
        this._config.TILT_REACTIVE = false;
        this._toggle('btn-tilt', false);
        btn.classList.add('audio-denied');
        btn.dataset.tip = `Tilt unavailable: ${err?.message || 'permission denied'}`;
        console.warn('[Fluid] Tilt reactivity unavailable:', err);
      } finally {
        busy = false;
      }
    };

    btn.addEventListener('click', (_e) => {
      // Already on → just turn it off; no permission needed.
      if (this._config.TILT_REACTIVE) {
        performToggle(false);
        return;
      }
      // Show the tutorial modal once on iOS, before the first
      // requestPermission call. The modal's Allow button is itself a
      // fresh user gesture, so requestPermission inside its click
      // handler is still allowed by the iOS gesture rules (gotcha #5).
      let seen = false;
      try { seen = !!localStorage.getItem(TUTORIAL_KEY); } catch (_) { /* private mode */ }
      if (needsIOSPermission && !seen) {
        this._showTiltTutorial(performToggle);
        return;
      }
      // Non-iOS or already-seen → straight through.
      performToggle(true);
    });
  }

  /**
   * Show the iOS tilt onboarding modal. The Allow button click is the
   * fresh user gesture that calls `performToggle(true)` — its inner
   * `requestPermission()` call therefore satisfies the iOS gesture
   * requirement without any awaits before it (gotcha #5).
   *
   * @param {(want:boolean)=>Promise<void>} performToggle
   * @private
   */
  _showTiltTutorial(performToggle) {
    const modal = document.getElementById('tilt-tutorial');
    const allow = document.getElementById('tilt-tutorial-allow');
    const deny  = document.getElementById('tilt-tutorial-deny');
    if (!modal || !allow || !deny) {
      // Fallback: if the markup is missing for any reason, just go
      // straight to the permission flow rather than silently failing.
      performToggle(true);
      return;
    }
    const TUTORIAL_KEY = 'fluid:tilt-tutorial-seen';
    const persistSeen = () => {
      try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch (_) { /* private mode */ }
    };
    const close = () => {
      modal.classList.remove('visible');
      // Wait for the fade-out before re-hiding so the transition runs.
      setTimeout(() => { modal.hidden = true; }, 200);
      // Detach handlers so a future open doesn't accumulate listeners.
      allow.removeEventListener('click', onAllow);
      deny .removeEventListener('click', onDeny);
    };
    const onAllow = () => {
      persistSeen();
      close();
      // CRITICAL: this is the fresh gesture; performToggle(true) eventually
      // calls AccelerometerInput.start() → DeviceMotionEvent.requestPermission().
      performToggle(true);
    };
    const onDeny = () => {
      persistSeen();          // Don't nag again on next session either.
      close();
    };
    allow.addEventListener('click', onAllow);
    deny .addEventListener('click', onDeny);
    modal.hidden = false;
    // Force layout flush so the .visible class triggers the transition.
    void modal.offsetWidth;
    modal.classList.add('visible');
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
        this._refreshAudioPanelVisibility();
        if (on) this._populateAudioDevices();
      } catch (err) {
        this._config.AUDIO_REACTIVE = false;
        this._toggle('btn-audio', false);
        btn.classList.add('audio-denied');
        btn.dataset.tip = `Audio unavailable: ${err?.message || 'permission denied'}`;
        console.warn('[Fluid] Audio reactivity unavailable:', err);
        this._refreshAudioPanelVisibility();
      } finally {
        busy = false;
      }
    });

    // Bind the three sensitivity sliders. They drive AUDIO_*_SENSITIVITY
    // through a log curve (0..100 → 0.5..4.0); apply the slider's initial
    // DOM value once so a persisted restore — which sets el.value before
    // this binding runs — also takes effect at boot.
    const bindAudioSlider = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      this._config[key] = audioSensitivityFromSlider(Number(el.value));
      el.addEventListener('input', (e) => {
        this._config[key] = audioSensitivityFromSlider(Number(e.target.value));
        this._cb.onConfigMutated?.();
      });
    };
    bindAudioSlider('slider-audio-bass',  'AUDIO_SENSITIVITY');
    bindAudioSlider('slider-audio-mids',  'AUDIO_MIDS_SENSITIVITY');
    bindAudioSlider('slider-audio-highs', 'AUDIO_HIGHS_SENSITIVITY');

    // Device picker — change handler. enumerateDevices may need
    // permission to expose labels, so we (re)populate after the audio
    // graph is started in the click handler above.
    const sel = document.getElementById('audio-device');
    if (sel) {
      sel.addEventListener('change', (e) => {
        const id = e.target.value || '';
        this._config.AUDIO_DEVICE_ID = id;
        this._cb.onAudioDeviceChange?.(id);
      });
    }

    // Listen once for hot-plug events; harmless when audio is inactive.
    if ('mediaDevices' in navigator && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (this._config.AUDIO_REACTIVE) this._populateAudioDevices();
      });
    }

    // Reflect persisted state at boot.
    this._refreshAudioPanelVisibility();

    // If the user has previously granted mic permission on this origin
    // (sticky), pre-populate the device picker so their saved choice is
    // visible the moment they re-enable audio. enumerateDevices() with
    // a granted permission returns labels; with a prompt/denied state
    // it returns empty labels, in which case the picker stays as just
    // the "Default microphone" placeholder until the next start().
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'microphone' })
        .then((perm) => { if (perm.state === 'granted') this._populateAudioDevices(); })
        .catch(() => { /* Safari and some Firefox versions don't expose
                          'microphone' permission name — silently skip. */ });
    }
  }

  /** Show / hide the audio sub-panel based on the current audio state. */
  _refreshAudioPanelVisibility() {
    const panel = document.getElementById('audio-panel');
    if (panel) panel.hidden = !this._config.AUDIO_REACTIVE;
  }

  /**
   * Populate the audio device picker from `enumerateDevices()`. Device
   * labels are only exposed once the user has granted mic permission, so
   * this is normally called *after* a successful audio-start. We also
   * call it at boot when the Permissions API reports a sticky 'granted'
   * state, so a returning user sees their previously-chosen device in
   * the picker before re-enabling audio.
   * @private
   */
  async _populateAudioDevices() {
    const sel = document.getElementById('audio-device');
    if (!sel || !('mediaDevices' in navigator) || !navigator.mediaDevices.enumerateDevices) return;
    let devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      console.warn('[Fluid] enumerateDevices failed:', err);
      return;
    }
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const current = this._config.AUDIO_DEVICE_ID || '';
    // Rebuild the option list. Always keep "Default microphone" first.
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default microphone';
    sel.appendChild(def);
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      // `label` may be empty if permission has not been granted; fall
      // back to a stable identifier so the user still sees something.
      opt.textContent = d.label || `Microphone ${d.deviceId.slice(0, 8)}`;
      sel.appendChild(opt);
    }
    // Restore selection if the persisted device is still present.
    const stillPresent = !current || inputs.some((d) => d.deviceId === current);
    sel.value = stillPresent ? current : '';
  }

  /* ──────────────────────────────────────────────────────────────────
     MIDI input (asynchronous — needs Web MIDI permission)
     ────────────────────────────────────────────────────────────────── */

  _bindMidiButton() {
    const btn = document.getElementById('btn-midi');
    if (!btn) return;
    let busy = false;
    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      // Reuse the audio-denied red-tint style so we don't ship a
      // duplicate CSS rule for an identical visual state.
      btn.classList.remove('audio-denied');
      const want = !this._config.MIDI_REACTIVE;
      try {
        const actual = await this._cb.onToggleMidi?.(want);
        const on     = actual === undefined ? want : !!actual;
        this._config.MIDI_REACTIVE = on;
        this._toggle('btn-midi', on);
      } catch (err) {
        this._config.MIDI_REACTIVE = false;
        this._toggle('btn-midi', false);
        btn.classList.add('audio-denied');
        btn.dataset.tip = `MIDI unavailable: ${err?.message || 'permission denied'}`;
        console.warn('[Fluid] MIDI input unavailable:', err);
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
  /** Tri-state advection button: glyph + tooltip + active class. */
  _advectionLabel(scheme) {
    if (scheme === 'bfecc')      return 'Dye advection: BFECC (sharpest)';
    if (scheme === 'maccormack') return 'Dye advection: MacCormack (high quality)';
    return 'Dye advection: standard (most diffuse)';
  }
  _refreshAdvectionButton() {
    const btn = document.getElementById('btn-hq-advect');
    if (!btn) return;
    const scheme = this._config.DYE_ADVECTION
                || (this._config.HIGH_QUALITY_ADVECTION ? 'maccormack' : 'standard');
    // Glyph: ≈ for the diffuse standard scheme, ⋍ for MacCormack,
    // ⩳ for the sharper BFECC. All three render in fallback fonts.
    btn.textContent = scheme === 'standard' ? '≈' : (scheme === 'bfecc' ? '⩳' : '⋍');
    btn.classList.toggle('active', scheme !== 'standard');
    btn.dataset.tip = this._advectionLabel(scheme);
    btn.setAttribute('aria-label', this._advectionLabel(scheme));
  }
  _syncStates() {
    this._toggle('btn-particles', this._config.PARTICLES);
    this._toggle('btn-bloom',     this._config.BLOOM);
    const mode = this._config.COLOR_MODE || 'rainbow';
    this._toggle('btn-colorful',  mode !== 'mono');
    const cBtn = document.getElementById('btn-colorful');
    if (cBtn) cBtn.dataset.tip = COLOR_MODE_LABELS[mode] || mode;
    this._refreshAdvectionButton();
    this._toggle('btn-pause',     this._config.PAUSED);
    this._toggle('btn-tilt',      this._config.TILT_REACTIVE);
    this._toggle('btn-midi',      this._config.MIDI_REACTIVE);
    this._toggle('btn-obstacles', this._config.OBSTACLE_MODE);
    this._toggle('btn-source',    this._config.SOURCE_MODE);
    this._toggle('btn-sink',      this._config.SINK_MODE);
    this._toggle('btn-erase',     this._config.OBSTACLE_ERASE);
    this._toggle('btn-wallpaper', this._config.WALLPAPER_MODE);
    // Brush slider group visibility is tied to obstacle mode.
    const brushGroup = document.getElementById('slider-group-brush');
    if (brushGroup) brushGroup.hidden = !this._config.OBSTACLE_MODE;
    // Reflect the user-explicit perf-mode flag (the button's visual state
    // mirrors CONFIG.PERF_MODE, not the live SIM_RESOLUTION which adaptive
    // downscale can mutate transiently).
    const perfBtn = document.getElementById('btn-perf');
    if (perfBtn) perfBtn.classList.toggle('perf-mode', !!this._config.PERF_MODE);
  }
}
